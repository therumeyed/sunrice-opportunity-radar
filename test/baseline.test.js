// DB-backed, gated on TEST_DATABASE_URL -- same convention as
// reportBuilder.test.js. Inserts known fixture rows directly (no need to
// run the full report pipeline) and checks computeBaseline() against
// hand-computed expected values, plus confirms the explicitly-unavailable
// metrics never get approximated.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !TEST_DATABASE_URL ? 'set TEST_DATABASE_URL to a scratch database to run this suite' : false;

describe('baseline (DB-backed)', { skip }, () => {
  let db, computeBaseline;

  before(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    db = require('../src/db');
    ({ computeBaseline } = require('../src/baseline'));
    await db.initSchema();
  });

  beforeEach(async () => {
    await db.pool.query(`TRUNCATE TABLE baseline_snapshots, rejected_candidates, fit_contradictions, recommendation_feedback, recommendation_evidence, recommendations,
      microtrend_evidence, microtrend_observations, microtrend_social_signals, microtrends,
      signals, theme_daily_snapshots, source_items, provider_runs, reports RESTART IDENTITY CASCADE`);
  });

  after(async () => {
    await db.pool.query(`TRUNCATE TABLE baseline_snapshots, rejected_candidates, fit_contradictions, recommendation_feedback, recommendation_evidence, recommendations,
      microtrend_evidence, microtrend_observations, microtrend_social_signals, microtrends,
      signals, theme_daily_snapshots, source_items, provider_runs, reports RESTART IDENTITY CASCADE`);
    await db.pool.end();
  });

  test('every metric reports unavailable (never zero) on a completely empty database', async () => {
    const metrics = await computeBaseline();
    assert.equal(metrics.duplicateRecommendationRate.status, 'unavailable');
    assert.equal(metrics.timeToRecommendation.status, 'unavailable');
    assert.equal(metrics.tierAtFirstAppearance.status, 'unavailable');
    assert.equal(metrics.evidenceCompletenessAndFreshness.status, 'unavailable');
    assert.equal(metrics.productMismatchRate.status, 'unavailable');
    assert.equal(metrics.genericRecommendationRate.status, 'unavailable');
    assert.equal(metrics.usefulCandidatesIncorrectlyRejectedRate.status, 'unavailable');
    // Feedback counts ARE measurable even with zero rows -- a real
    // "nothing recorded yet" rather than nothing to measure at all.
    assert.equal(metrics.feedbackCounts.status, 'measured');
    assert.deepEqual(metrics.feedbackCounts.activeByType, { useful: 0, already_covered: 0, not_relevant: 0, dont_show_again: 0 });
  });

  test('computes real numbers from known fixture data', async () => {
    const day1 = '2026-01-01';
    const day2 = '2026-01-06'; // 5 days after first_seen_at, for a known timeToRecommendation

    const report1 = (await db.pool.query(`INSERT INTO reports (report_date, status) VALUES ($1, 'completed') RETURNING *`, [day1])).rows[0];
    const report2 = (await db.pool.query(`INSERT INTO reports (report_date, status) VALUES ($1, 'completed') RETURNING *`, [day2])).rows[0];

    const microtrend = (await db.pool.query(
      `INSERT INTO microtrends (theme, normalized_key, display_name, candidate_type, first_seen_at, last_seen_at)
       VALUES ('rice_basics', 'fixture key', 'Fixture candidate', 'micro', $1, $2) RETURNING *`,
      [day1, day2]
    )).rows[0];

    const sourceItem = (await db.pool.query(
      `INSERT INTO source_items (source_type, source_name, content_hash, published_at, data_status)
       VALUES ('dataforseo_trends', 'DataForSEO', 'fixture-hash-1', $1, 'live') RETURNING *`,
      [day1]
    )).rows[0];

    // Day 1: first-ever recommendation for this microtrend, tier
    // Investigate, action_fingerprint 'fp-a', WITH linked evidence.
    const rec1 = (await db.pool.query(
      `INSERT INTO recommendations (report_id, rank, action_type, title, rationale, confidence, score, score_components, microtrend_id, action_fingerprint)
       VALUES ($1, 1, 'Investigate', 'Fixture title', 'Fixture rationale', 'medium', 50, '{}', $2, 'fp-a') RETURNING *`,
      [report1.id, microtrend.id]
    )).rows[0];
    await db.pool.query(`INSERT INTO recommendation_evidence (recommendation_id, source_item_id) VALUES ($1, $2)`, [rec1.id, sourceItem.id]);

    // Day 2: SAME action_fingerprint (a real repeat), tier now Create, NO evidence linked.
    await db.pool.query(
      `INSERT INTO recommendations (report_id, rank, action_type, title, rationale, confidence, score, score_components, microtrend_id, action_fingerprint)
       VALUES ($1, 1, 'Create', 'Fixture title', 'Fixture rationale', 'high', 80, '{}', $2, 'fp-a')`,
      [report2.id, microtrend.id]
    );

    await db.pool.query(
      `INSERT INTO recommendation_feedback (recommendation_id, feedback_type) VALUES ($1, 'useful')`,
      [rec1.id]
    );
    await db.pool.query(
      `INSERT INTO recommendation_feedback (recommendation_id, feedback_type) VALUES ($1, 'not_relevant')`,
      [rec1.id]
    );
    const reversedRow = (await db.pool.query(
      `INSERT INTO recommendation_feedback (recommendation_id, feedback_type) VALUES ($1, 'dont_show_again') RETURNING *`,
      [rec1.id]
    )).rows[0];
    await db.pool.query(`UPDATE recommendation_feedback SET reversed_at = now() WHERE id = $1`, [reversedRow.id]);

    const metrics = await computeBaseline();

    assert.deepEqual(metrics.feedbackCounts.activeByType, { useful: 1, already_covered: 0, not_relevant: 1, dont_show_again: 0 });
    assert.equal(metrics.feedbackCounts.reversedCount, 1);

    assert.equal(metrics.duplicateRecommendationRate.status, 'measured');
    assert.equal(metrics.duplicateRecommendationRate.total, 2);
    assert.equal(metrics.duplicateRecommendationRate.repeats, 1, 'the day-2 recommendation is a real repeat of the same action_fingerprint');
    assert.equal(metrics.duplicateRecommendationRate.rate, 0.5);

    assert.equal(metrics.timeToRecommendation.status, 'measured');
    assert.equal(metrics.timeToRecommendation.sampleSize, 1);
    assert.equal(metrics.timeToRecommendation.avgDays, 0, 'first_seen_at IS day1, so time-to-FIRST-recommendation is 0 days, not 5');

    assert.equal(metrics.tierAtFirstAppearance.status, 'measured');
    assert.deepEqual(metrics.tierAtFirstAppearance.byTier, { Investigate: 1 });
    assert.equal(metrics.tierAtFirstAppearance.shareIdentifiedWhileEmerging, 1, 'the only microtrend\'s first appearance was Investigate, not Create');

    assert.equal(metrics.evidenceCompletenessAndFreshness.status, 'measured');
    assert.equal(metrics.evidenceCompletenessAndFreshness.totalRecommendations, 2);
    assert.equal(metrics.evidenceCompletenessAndFreshness.recommendationsWithEvidence, 1);
    assert.equal(metrics.evidenceCompletenessAndFreshness.completeness, 0.5);
    assert.equal(metrics.evidenceCompletenessAndFreshness.avgEvidenceAgeDays, 0, 'the one cited evidence item was published the same day it was cited');

    assert.equal(metrics.context.completed_reports, 2);
    assert.equal(metrics.context.total_recommendations, 2);
    assert.equal(metrics.context.total_microtrends, 1);

    // Still unavailable -- nothing in this fixture set builds a review
    // queue or mismatch reason codes, so these must stay honestly absent.
    assert.equal(metrics.productMismatchRate.status, 'unavailable');
    assert.equal(metrics.genericRecommendationRate.status, 'unavailable');
    assert.equal(metrics.usefulCandidatesIncorrectlyRejectedRate.status, 'unavailable');
  });

  test('Stage 4: productMismatchRate/genericRecommendationRate become measured once real rejected_candidates rows exist', async () => {
    const report = (await db.pool.query(`INSERT INTO reports (report_date, status) VALUES ('2026-02-01', 'completed') RETURNING *`)).rows[0];
    await db.recordRejectedCandidate(report.id, {
      theme: 'rice_basics', candidateName: 'Fixture A', verdict: 'rejected', reasonCode: 'product_mismatch', explanation: 'x'
    });
    await db.recordRejectedCandidate(report.id, {
      theme: 'rice_basics', candidateName: 'Fixture B', verdict: 'rejected', reasonCode: 'too_generic', explanation: 'x'
    });
    await db.recordRejectedCandidate(report.id, {
      theme: 'rice_basics', candidateName: 'Fixture C', verdict: 'uncertain', reasonCode: null, explanation: 'x'
    });

    const metrics = await computeBaseline();
    assert.equal(metrics.productMismatchRate.status, 'measured');
    assert.equal(metrics.productMismatchRate.totalRejected, 2, 'an uncertain verdict is never counted as a rejection');
    assert.equal(metrics.productMismatchRate.rate, 0.5);
    assert.equal(metrics.genericRecommendationRate.status, 'measured');
    assert.equal(metrics.genericRecommendationRate.rate, 0.5);
  });

  test('a snapshot is durably stored and never overwritten by a later one', async () => {
    const m1 = await computeBaseline();
    const row1 = await db.recordBaselineSnapshot(m1, 'first');
    const m2 = await computeBaseline();
    const row2 = await db.recordBaselineSnapshot(m2, 'second');
    assert.notEqual(row1.id, row2.id);

    const all = await db.getAllBaselineSnapshots();
    assert.equal(all.length, 2);
    const latest = await db.getLatestBaselineSnapshot();
    assert.equal(latest.id, row2.id);
    assert.equal(latest.notes, 'second');
  });
});
