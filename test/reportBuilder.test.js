// DB-backed integration test, gated on TEST_DATABASE_URL (never DATABASE_URL)
// so `npm test` can never touch a real database just because one happens to
// be configured in the environment -- same convention as the sibling
// Melbourne Airport dashboard in this account.
//
// Claude's candidate analysis is mandatory for any recommendation to exist
// (see src/candidateAnalyst.js, src/reportBuilder.js) -- there is no real
// Anthropic access in this test environment, so most tests here stub
// candidateAnalyst.analyzeCandidates on the shared module object (a plain
// CommonJS monkeypatch, restored in beforeEach -- no mocking library) to
// exercise the AI-succeeds path deterministically. Tests that don't stub
// it exercise the real "no ANTHROPIC_API_KEY" unavailable path for free.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !TEST_DATABASE_URL ? 'set TEST_DATABASE_URL to a scratch database to run this suite' : false;

// source_items.collected_at defaults to the DB's real now() -- reportBuilder
// looks up "today's" evidence by that actual timestamp, so fixtures must use
// today's real date, not a fictional one, or the two would never match (a
// mismatch that would never happen in production, where both always derive
// from the same now()).
function melbourneDateString(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne' }).format(date);
}
const TODAY = melbourneDateString(new Date());

describe('report generation from fixture evidence (DB-backed)', { skip }, () => {
  let db, buildReport, candidateAnalyst, normalizeKey, realAnalyzeCandidates;

  // Builds a stub that assesses every real candidate it's handed, one
  // assessment per clusterKey, citing that candidate's own real evidence
  // IDs -- a reasonable default for tests that aren't specifically about
  // merging or exclusion. Overrides let a test set classification/
  // brandRelevance/channel etc.
  function autoAssessAll(overrides = {}) {
    return async (themeBatches) => ({
      status: 'ok',
      assessments: themeBatches.flatMap((t) => t.candidates.map((c) => ({
        clusterKeys: [c.clusterKey],
        candidateName: overrides.candidateName || c.displayText,
        parentTheme: t.theme,
        classification: overrides.classification || 'micro',
        isDistinctFromEvergreen: true,
        brandRelevance: overrides.brandRelevance ?? 0.7,
        productConnection: overrides.productConnection || [],
        whyItMattersNow: overrides.whyItMattersNow || 'Real evidence points to this right now.',
        proposedAction: {
          recommendedAction: overrides.recommendedAction || 'Do something concrete',
          channel: overrides.channel === undefined ? 'TikTok/Instagram Reels' : overrides.channel,
          format: overrides.format === undefined ? 'Short-form video' : overrides.format,
          creativeAngle: overrides.creativeAngle === undefined ? 'A concrete angle' : overrides.creativeAngle
        },
        evidenceIds: c.members.map((m) => m.sourceItemId)
      })))
    });
  }

  // Merges EVERY candidate currently extracted for one theme into a single
  // assessment/microtrend -- the social-tier tests below rely on this to
  // put several real social posts (or a social post + a search query) into
  // the SAME microtrend, exactly the way Claude's own clusterKeys merging
  // is meant to unify them (see candidateAnalyst.js).
  function mergeAllForTheme(theme, overrides = {}) {
    return async (themeBatches) => {
      const t = themeBatches.find((b) => b.theme === theme);
      if (!t || t.candidates.length === 0) return { status: 'ok', assessments: [] };
      return {
        status: 'ok',
        assessments: [{
          clusterKeys: t.candidates.map((c) => c.clusterKey),
          candidateName: overrides.candidateName || 'Merged candidate',
          parentTheme: theme,
          classification: overrides.classification || 'micro',
          isDistinctFromEvergreen: true,
          brandRelevance: overrides.brandRelevance ?? 0.8,
          productConnection: overrides.productConnection || [],
          whyItMattersNow: overrides.whyItMattersNow || 'Real social evidence points to this right now.',
          proposedAction: {
            recommendedAction: overrides.recommendedAction || 'Do something concrete',
            channel: overrides.channel === undefined ? 'TikTok/Instagram Reels' : overrides.channel,
            format: overrides.format === undefined ? 'Short-form video' : overrides.format,
            creativeAngle: overrides.creativeAngle === undefined ? 'A concrete angle' : overrides.creativeAngle
          },
          evidenceIds: t.candidates.flatMap((c) => c.members.map((m) => m.sourceItemId))
        }]
      };
    };
  }

  // A real matched social post -- one row in source_items, same shape
  // ingest would produce, with `author` set so distinct-creator counting
  // has something real to count.
  async function insertSocialPost(reportId, { theme, sourceType, contentHash, excerpt, author }) {
    const run = await db.recordProviderRun(reportId, { providerName: sourceType, sourceType, status: 'live' });
    return db.upsertSourceItem({
      providerRunId: run.id, sourceType, sourceName: sourceType,
      sourceUrl: `https://example.com/${contentHash}`, externalId: contentHash, contentHash,
      title: excerpt, excerpt, author, theme, dataStatus: 'live'
    });
  }

  before(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    db = require('../src/db');
    ({ buildReport } = require('../src/reportBuilder'));
    candidateAnalyst = require('../src/candidateAnalyst');
    ({ normalizeKey } = require('../src/microtrends'));
    realAnalyzeCandidates = candidateAnalyst.analyzeCandidates;
    await db.initSchema();
  });

  beforeEach(async () => {
    candidateAnalyst.analyzeCandidates = realAnalyzeCandidates; // undo any stub a previous test set
    delete process.env.ANTHROPIC_API_KEY;
    await db.pool.query(`TRUNCATE TABLE idea_status_history, ideas, recommendation_feedback, recommendation_evidence, recommendations,
      microtrend_evidence, microtrend_observations, microtrends,
      signals, theme_daily_snapshots, source_items, provider_runs, reports RESTART IDENTITY CASCADE`);
  });

  after(async () => {
    candidateAnalyst.analyzeCandidates = realAnalyzeCandidates;
    await db.pool.query(`TRUNCATE TABLE idea_status_history, ideas, recommendation_feedback, recommendation_evidence, recommendations,
      microtrend_evidence, microtrend_observations, microtrends,
      signals, theme_daily_snapshots, source_items, provider_runs, reports RESTART IDENTITY CASCADE`);
    await db.pool.end();
  });

  test('a theme with zero collected evidence produces no signal and no recommendation', async () => {
    const report = await db.getOrCreateReport(TODAY);
    const result = await buildReport(report.id, TODAY);
    assert.equal(result.recommendationsCreated, 0);
    const bundle = await db.getReportBundle(report);
    assert.equal(bundle.signals.length, 0);
    assert.equal(bundle.recommendations.length, 0);
  });

  test('no ANTHROPIC_API_KEY: signals and theme history still build, but zero recommendations and aiAnalysisAvailable is false', async () => {
    const report = await db.getOrCreateReport(TODAY);
    const run = await db.recordProviderRun(report.id, { providerName: 'DataForSEO', sourceType: 'dataforseo_trends', status: 'live' });
    await db.upsertSourceItem({
      providerRunId: run.id, sourceType: 'dataforseo_trends', sourceName: 'DataForSEO',
      contentHash: 'fixture-no-key-1', title: 'sushi rice', queryOrTopic: 'sushi rice', theme: 'sushi_asian',
      normalizedMetrics: { relatedQueries: { rising: [{ query: 'air fryer sushi rice bowl', value: 80 }], top: [] } },
      dataStatus: 'live'
    });
    const result = await buildReport(report.id, TODAY);
    assert.equal(result.recommendationsCreated, 0);
    assert.equal(result.aiAnalysisAvailable, false);
    assert.ok(result.aiAnalysisReason);

    // getReportBundle just echoes back whatever report row it's handed --
    // re-fetch it fresh (same as a real HTTP request would, well after
    // buildReport's own setReportAiStatus call) rather than reusing the
    // pre-buildReport object this test fetched earlier.
    const freshReport = (await db.pool.query('SELECT * FROM reports WHERE id = $1', [report.id])).rows[0];
    const bundle = await db.getReportBundle(freshReport);
    assert.equal(bundle.signals.length, 1, 'signals still build even when AI analysis fails');
    assert.equal(bundle.recommendations.length, 0, 'never a deterministic fallback recommendation');
    assert.equal(bundle.report.ai_analysis_available, false);

    const snapshot = await db.pool.query('SELECT * FROM theme_daily_snapshots WHERE report_id = $1', [report.id]);
    assert.equal(snapshot.rowCount, 1, 'theme snapshot history still builds even when AI analysis fails');
  });

  test('a validated Claude assessment produces a real, traceable candidate recommendation', async () => {
    const report = await db.getOrCreateReport(TODAY);
    const run = await db.recordProviderRun(report.id, { providerName: 'DataForSEO', sourceType: 'dataforseo_trends', status: 'live' });
    await db.upsertSourceItem({
      providerRunId: run.id, sourceType: 'dataforseo_trends', sourceName: 'DataForSEO',
      contentHash: 'fixture-candidate-1', title: 'sushi rice', queryOrTopic: 'sushi rice', theme: 'sushi_asian',
      normalizedMetrics: { relatedQueries: { rising: [{ query: 'air fryer sushi rice bowl', value: 80 }], top: [] } },
      dataStatus: 'live'
    });

    candidateAnalyst.analyzeCandidates = autoAssessAll({
      candidateName: 'Air fryer sushi rice bowls', brandRelevance: 0.9,
      productConnection: ['SunRice Sushi Rice'], recommendedAction: 'Film a short air fryer sushi bowl how-to'
    });

    const result = await buildReport(report.id, TODAY);
    assert.equal(result.recommendationsCreated, 1);
    assert.equal(result.aiAnalysisAvailable, true);

    const bundle = await db.getReportBundle(report);
    const rec = bundle.recommendations.find((r) => r.theme === 'sushi_asian');
    assert.ok(rec);
    assert.equal(rec.recommendation_kind, 'candidate');
    assert.equal(rec.opportunity_name, 'Air fryer sushi rice bowls');
    assert.equal(rec.recommended_action, 'Film a short air fryer sushi bowl how-to');
    assert.ok(rec.microtrend_id);
    assert.ok(rec.evidence.length >= 1, 'a candidate recommendation must carry real linked evidence');

    const microtrendRow = await db.pool.query('SELECT * FROM microtrends WHERE id = $1', [rec.microtrend_id]);
    assert.equal(microtrendRow.rows[0].candidate_type, 'micro');
  });

  test('Claude unifying two differently-worded candidates merges them into one microtrend, with the merge audited', async () => {
    const report = await db.getOrCreateReport(TODAY);
    const run = await db.recordProviderRun(report.id, { providerName: 'DataForSEO', sourceType: 'dataforseo_trends', status: 'live' });
    await db.upsertSourceItem({
      providerRunId: run.id, sourceType: 'dataforseo_trends', sourceName: 'DataForSEO',
      contentHash: 'fixture-merge-1', title: 'rice bowls', queryOrTopic: 'rice bowls', theme: 'healthy_eating',
      normalizedMetrics: {
        relatedQueries: {
          rising: [
            { query: 'low gi meal prep bowls', value: 70 },
            { query: 'lunch bowls for better blood sugar', value: 55 } // low token overlap with the above -- deterministic clustering keeps these separate; only Claude's semantic read unifies them
          ],
          top: []
        }
      },
      dataStatus: 'live'
    });

    const keyA = `healthy_eating::${normalizeKey('low gi meal prep bowls')}`;
    const keyB = `healthy_eating::${normalizeKey('lunch bowls for better blood sugar')}`;
    candidateAnalyst.analyzeCandidates = async (themeBatches) => {
      const theme = themeBatches.find((t) => t.theme === 'healthy_eating');
      const allEvidenceIds = theme.candidates.flatMap((c) => c.members.map((m) => m.sourceItemId));
      return {
        status: 'ok',
        assessments: [{
          clusterKeys: [keyA, keyB],
          candidateName: 'Low GI meal prep bowls',
          parentTheme: 'healthy_eating',
          classification: 'micro',
          isDistinctFromEvergreen: true,
          brandRelevance: 0.8,
          productConnection: [],
          whyItMattersNow: 'Two different wordings for the same real idea.',
          proposedAction: { recommendedAction: 'Publish a low GI meal prep bowl guide', channel: null, format: null, creativeAngle: null },
          evidenceIds: allEvidenceIds
        }]
      };
    };

    const result = await buildReport(report.id, TODAY);
    assert.equal(result.recommendationsCreated, 1);

    const microtrends = await db.pool.query('SELECT * FROM microtrends WHERE theme = $1', ['healthy_eating']);
    assert.equal(microtrends.rowCount, 1, 'two differently-worded candidates unified by Claude must collapse into ONE microtrend row');
    assert.equal(microtrends.rows[0].semantic_merges.length, 1, 'the merge Claude proposed (beyond deterministic clustering) must be audited');
    assert.equal(microtrends.rows[0].semantic_merges[0].normalizedKey, normalizeKey('lunch bowls for better blood sugar'));
  });

  test('a macro candidate is shown once, then suppressed the next day with no material change -- no fallback recommendation', async () => {
    const seedQuery = 'cook rice';
    const yesterday = new Date(Date.now() - 86400000);
    const yesterdayStr = melbourneDateString(yesterday);

    const report1 = await db.getOrCreateReport(yesterdayStr);
    const run1 = await db.recordProviderRun(report1.id, { providerName: 'DataForSEO', sourceType: 'dataforseo_trends', status: 'live' });
    const item1 = await db.upsertSourceItem({
      providerRunId: run1.id, sourceType: 'dataforseo_trends', sourceName: 'DataForSEO',
      contentHash: 'fixture-macro-day1', title: seedQuery, queryOrTopic: seedQuery, theme: 'rice_basics',
      normalizedMetrics: { relatedQueries: { rising: [{ query: seedQuery, value: 50 }], top: [] } },
      dataStatus: 'live'
    });
    await db.pool.query('UPDATE source_items SET collected_at = $1 WHERE id = $2', [yesterday, item1.id]);

    candidateAnalyst.analyzeCandidates = autoAssessAll({ classification: 'macro', candidateName: 'Cook rice basics' });
    const result1 = await buildReport(report1.id, yesterdayStr);
    assert.equal(result1.recommendationsCreated, 1, 'a macro candidate never shown before must be allowed through once');

    const bundle1 = await db.getReportBundle(report1);
    const rec1 = bundle1.recommendations.find((r) => r.theme === 'rice_basics');
    const microtrendId = rec1.microtrend_id;
    const afterDay1 = await db.pool.query('SELECT baseline_shown_at FROM microtrends WHERE id = $1', [microtrendId]);
    assert.ok(afterDay1.rows[0].baseline_shown_at, 'showing a macro for the first time must record baseline_shown_at');

    const report2 = await db.getOrCreateReport(TODAY);
    const run2 = await db.recordProviderRun(report2.id, { providerName: 'DataForSEO', sourceType: 'dataforseo_trends', status: 'live' });
    await db.upsertSourceItem({
      providerRunId: run2.id, sourceType: 'dataforseo_trends', sourceName: 'DataForSEO',
      contentHash: 'fixture-macro-day2', title: seedQuery, queryOrTopic: seedQuery, theme: 'rice_basics',
      normalizedMetrics: { relatedQueries: { rising: [{ query: seedQuery, value: 50 }], top: [] } },
      dataStatus: 'live'
    });
    const result2 = await buildReport(report2.id, TODAY);
    assert.equal(result2.recommendationsCreated, 0, 'the same macro with no material change must be suppressed, with NO fallback recommendation taking its place');
  });

  test('"not_relevant" feedback hides a microtrend from ever winning a slot again -- no fallback takes its place', async () => {
    const yesterday = new Date(Date.now() - 86400000);
    const yesterdayStr = melbourneDateString(yesterday);

    const report1 = await db.getOrCreateReport(yesterdayStr);
    const run1 = await db.recordProviderRun(report1.id, { providerName: 'DataForSEO', sourceType: 'dataforseo_trends', status: 'live' });
    const item1 = await db.upsertSourceItem({
      providerRunId: run1.id, sourceType: 'dataforseo_trends', sourceName: 'DataForSEO',
      contentHash: 'fixture-feedback-1', title: 'curry', queryOrTopic: 'curry', theme: 'curry_night',
      normalizedMetrics: { relatedQueries: { rising: [{ query: 'air fryer butter chicken curry', value: 70 }], top: [] } },
      dataStatus: 'live'
    });
    await db.pool.query('UPDATE source_items SET collected_at = $1 WHERE id = $2', [yesterday, item1.id]);

    candidateAnalyst.analyzeCandidates = autoAssessAll({ candidateName: 'Air fryer butter chicken curry' });
    await buildReport(report1.id, yesterdayStr);
    const bundle1 = await db.getReportBundle(report1);
    const rec1 = bundle1.recommendations.find((r) => r.theme === 'curry_night');
    assert.equal(rec1.recommendation_kind, 'candidate');
    const microtrendId = rec1.microtrend_id;

    await db.insertFeedback({ recommendationId: rec1.id, microtrendId, feedbackType: 'not_relevant', reason: 'Not on-brand' });

    const report2 = await db.getOrCreateReport(TODAY);
    const run2 = await db.recordProviderRun(report2.id, { providerName: 'DataForSEO', sourceType: 'dataforseo_trends', status: 'live' });
    await db.upsertSourceItem({
      providerRunId: run2.id, sourceType: 'dataforseo_trends', sourceName: 'DataForSEO',
      contentHash: 'fixture-feedback-2', title: 'curry', queryOrTopic: 'curry', theme: 'curry_night',
      normalizedMetrics: { relatedQueries: { rising: [{ query: 'air fryer butter chicken curry', value: 95 }], top: [] } },
      dataStatus: 'live'
    });
    const result2 = await buildReport(report2.id, TODAY);
    assert.equal(result2.recommendationsCreated, 0, 'a not_relevant microtrend must never win a slot again, even with stronger evidence, and nothing fills the gap');

    const evidenceRows = await db.pool.query('SELECT * FROM microtrend_evidence WHERE microtrend_id = $1', [microtrendId]);
    assert.ok(evidenceRows.rowCount >= 2, 'a hidden microtrend must keep accumulating real evidence across days');
  });

  test('"implemented" workflow_status suppresses the same action_fingerprint, but a genuinely different action on the same microtrend still wins', async () => {
    const yesterday = new Date(Date.now() - 86400000);
    const yesterdayStr = melbourneDateString(yesterday);

    const report1 = await db.getOrCreateReport(yesterdayStr);
    const run1 = await db.recordProviderRun(report1.id, { providerName: 'DataForSEO', sourceType: 'dataforseo_trends', status: 'live' });
    const item1 = await db.upsertSourceItem({
      providerRunId: run1.id, sourceType: 'dataforseo_trends', sourceName: 'DataForSEO',
      contentHash: 'fixture-implemented-1', title: 'fried rice', queryOrTopic: 'fried rice', theme: 'weeknight_dinners',
      normalizedMetrics: { relatedQueries: { rising: [{ query: 'kimchi fried rice bowl', value: 60 }], top: [] } },
      dataStatus: 'live'
    });
    await db.pool.query('UPDATE source_items SET collected_at = $1 WHERE id = $2', [yesterday, item1.id]);

    candidateAnalyst.analyzeCandidates = autoAssessAll({ candidateName: 'Kimchi fried rice bowls', channel: 'TikTok/Instagram Reels', creativeAngle: 'Angle A' });
    await buildReport(report1.id, yesterdayStr);
    const bundle1 = await db.getReportBundle(report1);
    const rec1 = bundle1.recommendations.find((r) => r.theme === 'weeknight_dinners');
    const fingerprint1 = rec1.action_fingerprint;

    await db.updateIdea(fingerprint1, { workflow_status: 'implemented' });

    // Day 2, same exact angle -- must be suppressed.
    const report2 = await db.getOrCreateReport(TODAY);
    const run2 = await db.recordProviderRun(report2.id, { providerName: 'DataForSEO', sourceType: 'dataforseo_trends', status: 'live' });
    await db.upsertSourceItem({
      providerRunId: run2.id, sourceType: 'dataforseo_trends', sourceName: 'DataForSEO',
      contentHash: 'fixture-implemented-2', title: 'fried rice', queryOrTopic: 'fried rice', theme: 'weeknight_dinners',
      normalizedMetrics: { relatedQueries: { rising: [{ query: 'kimchi fried rice bowl', value: 90 }], top: [] } },
      dataStatus: 'live'
    });
    candidateAnalyst.analyzeCandidates = autoAssessAll({ candidateName: 'Kimchi fried rice bowls', channel: 'TikTok/Instagram Reels', creativeAngle: 'Angle A' });
    const result2 = await buildReport(report2.id, TODAY);
    assert.equal(result2.recommendationsCreated, 0, 'an implemented action_fingerprint must not be presented again as if new');

    // Day 3 (reuse report2's date window conceptually via a 3rd report),
    // a genuinely different angle on the SAME microtrend must still win.
    const tomorrowDate = new Date(Date.now() + 86400000);
    const tomorrow = melbourneDateString(tomorrowDate);
    const report3 = await db.getOrCreateReport(tomorrow);
    const run3 = await db.recordProviderRun(report3.id, { providerName: 'DataForSEO', sourceType: 'dataforseo_trends', status: 'live' });
    const item3 = await db.upsertSourceItem({
      providerRunId: run3.id, sourceType: 'dataforseo_trends', sourceName: 'DataForSEO',
      contentHash: 'fixture-implemented-3', title: 'fried rice', queryOrTopic: 'fried rice', theme: 'weeknight_dinners',
      normalizedMetrics: { relatedQueries: { rising: [{ query: 'kimchi fried rice bowl', value: 90 }], top: [] } },
      dataStatus: 'live'
    });
    // collected_at always defaults to the DB's real now() -- forward-dated
    // directly so getTodayItems(tomorrow) actually matches it, simulating
    // this evidence genuinely arriving tomorrow.
    await db.pool.query('UPDATE source_items SET collected_at = $1 WHERE id = $2', [tomorrowDate, item3.id]);
    candidateAnalyst.analyzeCandidates = autoAssessAll({ candidateName: 'Kimchi fried rice bowls', channel: 'Recipe/blog content + SEO', creativeAngle: 'Angle B -- completely different execution' });
    const result3 = await buildReport(report3.id, tomorrow);
    assert.equal(result3.recommendationsCreated, 1, 'a materially different action on the same microtrend must still be eligible to win');
    const bundle3 = await db.getReportBundle(report3);
    const rec3 = bundle3.recommendations.find((r) => r.theme === 'weeknight_dinners');
    assert.notEqual(rec3.action_fingerprint, fingerprint1, 'a different execution must get a different action_fingerprint');
  });

  test('every theme with evidence gets a theme_daily_snapshots row, not only the top 3 -- but only themes with a real extractable candidate can win a slot', async () => {
    const report = await db.getOrCreateReport(TODAY);
    // 4 distinct themes, google_news only -- news is corroboration, never a
    // candidate source, so none of these can produce a microtrend/candidate
    // and none can win a slot even though all 4 have real evidence.
    const themesAndQueries = [
      ['rice_basics', 'cook rice'], ['weeknight_dinners', 'fried rice'],
      ['curry_night', 'curry'], ['healthy_eating', 'low gi']
    ];
    for (const [theme, query] of themesAndQueries) {
      const run = await db.recordProviderRun(report.id, { providerName: 'Google News RSS', sourceType: 'google_news', status: 'live' });
      await db.upsertSourceItem({
        providerRunId: run.id, sourceType: 'google_news', sourceName: 'Test Publication',
        sourceUrl: `https://example.com/${theme}`, externalId: `https://example.com/${theme}`,
        contentHash: `fixture-hash-${theme}`, title: `${query} is trending`,
        queryOrTopic: query, theme, publishedAt: new Date(), dataStatus: 'live'
      });
    }

    const result = await buildReport(report.id, TODAY);
    assert.equal(result.opportunitiesConsidered, 4);
    assert.equal(result.recommendationsCreated, 0, 'news-only evidence produces no extractable candidate, so no slot can be filled -- no fallback');

    const snapshotsRes = await db.pool.query('SELECT theme, was_recommended FROM theme_daily_snapshots WHERE report_id = $1', [report.id]);
    assert.equal(snapshotsRes.rowCount, 4, 'all 4 themes with evidence must have a snapshot row regardless of whether any won a slot');
  });

  test('a same-day refresh upserts the same theme_daily_snapshots row rather than duplicating it', async () => {
    const report = await db.getOrCreateReport(TODAY);
    const run = await db.recordProviderRun(report.id, { providerName: 'Google News RSS', sourceType: 'google_news', status: 'live' });
    await db.upsertSourceItem({
      providerRunId: run.id, sourceType: 'google_news', sourceName: 'Test Publication',
      sourceUrl: 'https://example.com/same-day-snapshot', externalId: 'https://example.com/same-day-snapshot',
      contentHash: 'fixture-hash-same-day-snapshot', title: 'Sushi rice trending',
      queryOrTopic: 'sushi rice', theme: 'sushi_asian', publishedAt: new Date(), dataStatus: 'live'
    });

    await buildReport(report.id, TODAY);
    await buildReport(report.id, TODAY); // simulate a second manual Refresh the same day

    const res = await db.pool.query('SELECT * FROM theme_daily_snapshots WHERE report_id = $1 AND theme = $2', [report.id, 'sushi_asian']);
    assert.equal(res.rowCount, 1, 'a same-day re-run must upsert, never duplicate, a theme snapshot');
  });

  test('first_observed_date reflects when this dashboard first saw the theme, never an old post publication date', async () => {
    const report = await db.getOrCreateReport(TODAY);
    const run = await db.recordProviderRun(report.id, { providerName: 'Google News RSS', sourceType: 'google_news', status: 'live' });
    const oldPublishDate = new Date(Date.now() - 60 * 86400000); // 60 days ago
    await db.upsertSourceItem({
      providerRunId: run.id, sourceType: 'google_news', sourceName: 'Test Publication',
      sourceUrl: 'https://example.com/old-post-new-theme', externalId: 'https://example.com/old-post-new-theme',
      contentHash: 'fixture-hash-old-post', title: 'An old article about curry',
      queryOrTopic: 'curry', theme: 'curry_night', publishedAt: oldPublishDate, dataStatus: 'live'
    });

    await buildReport(report.id, TODAY);
    const res = await db.pool.query('SELECT first_observed_date FROM theme_daily_snapshots WHERE report_id = $1 AND theme = $2', [report.id, 'curry_night']);
    const firstObserved = res.rows[0].first_observed_date.toISOString().slice(0, 10);
    assert.equal(firstObserved, TODAY, 'first_observed_date must be when WE first saw this theme (today, its first-ever snapshot), not the evidence item\'s own old publish date');
  });

  test('Pinterest-only evidence is never counted as a matching social post and never forces a TikTok/Instagram channel when Claude gives no channel', async () => {
    const report = await db.getOrCreateReport(TODAY);
    const run = await db.recordProviderRun(report.id, { providerName: 'Pinterest Trends (via Apify, AU+NZ)', sourceType: 'apify_pinterest', status: 'live' });
    await db.upsertSourceItem({
      providerRunId: run.id, sourceType: 'apify_pinterest', sourceName: 'Pinterest Trends (via Apify, AU+NZ)',
      sourceUrl: 'https://trends.pinterest.com/detail/?terms=air+fryer+rice+bites&country=AU',
      externalId: 'air fryer rice bites:AU+NZ:growing:2026-01-01', contentHash: 'fixture-hash-pinterest-only',
      title: 'air fryer rice bites', queryOrTopic: 'rice types', theme: 'rice_basics',
      rawMetrics: { trendType: 'growing', rank: 1 }, dataStatus: 'live'
    });

    candidateAnalyst.analyzeCandidates = autoAssessAll({ candidateName: 'Air fryer rice bites', channel: null });
    await buildReport(report.id, TODAY);
    const bundle = await db.getReportBundle(report);
    const rec = bundle.recommendations.find((r) => r.theme === 'rice_basics');
    assert.ok(rec, 'expected a rice_basics recommendation from this fixture');
    assert.notEqual(rec.suggested_channel, 'Short-form video (TikTok/Instagram)', 'Pinterest-only evidence must never trigger a TikTok/Instagram channel suggestion via the deterministic fallback');
  });

  test('an imported/cached item is never surfaced with data_status live', async () => {
    const report = await db.getOrCreateReport(TODAY);
    const run = await db.recordProviderRun(report.id, {
      providerName: 'DataForSEO (cached)', sourceType: 'dataforseo_trends', status: 'cached'
    });
    const item = await db.upsertSourceItem({
      providerRunId: run.id,
      sourceType: 'dataforseo_trends',
      sourceName: 'DataForSEO (cached)',
      contentHash: 'fixture-hash-2',
      title: 'low gi (cached)',
      queryOrTopic: 'low gi',
      theme: 'healthy_eating',
      normalizedMetrics: { interestByRegion: [{ region: 'VIC', value: 80 }] },
      dataStatus: 'cached'
    });
    assert.equal(item.data_status, 'cached');

    await buildReport(report.id, TODAY);
    const bundle = await db.getReportBundle(report);
    const signal = bundle.signals.find((s) => s.theme === 'healthy_eating');
    assert.equal(signal.data_status, 'cached');
  });

  test('getMicrotrendsForReport surfaces every real candidate observed today, not only the one that won a slot', async () => {
    const report = await db.getOrCreateReport(TODAY);
    const run = await db.recordProviderRun(report.id, { providerName: 'DataForSEO', sourceType: 'dataforseo_trends', status: 'live' });
    await db.upsertSourceItem({
      providerRunId: run.id, sourceType: 'dataforseo_trends', sourceName: 'DataForSEO',
      contentHash: 'fixture-emerging-1', title: 'low gi', queryOrTopic: 'low gi', theme: 'healthy_eating',
      normalizedMetrics: {
        relatedQueries: {
          rising: [
            { query: 'low gi meal prep bowls', value: 60 },
            { query: 'low gi diabetic snacks', value: 40 }
          ],
          top: []
        }
      },
      dataStatus: 'live'
    });

    candidateAnalyst.analyzeCandidates = autoAssessAll();
    await buildReport(report.id, TODAY);
    const microtrends = await db.getMicrotrendsForReport(report.id);
    const healthyEatingMicrotrends = microtrends.filter((m) => m.theme === 'healthy_eating');
    assert.equal(healthyEatingMicrotrends.length, 2, 'both distinct rising queries should be tracked as separate microtrends, win or not');
    for (const m of healthyEatingMicrotrends) {
      assert.ok(m.last_score != null, 'every tracked microtrend must have a persisted, auditable score');
    }
  });

  test('feedback survives a same-day report rebuild -- a manual Refresh must never silently destroy an exclusion', async () => {
    const report = await db.getOrCreateReport(TODAY);
    const run = await db.recordProviderRun(report.id, { providerName: 'DataForSEO', sourceType: 'dataforseo_trends', status: 'live' });
    await db.upsertSourceItem({
      providerRunId: run.id, sourceType: 'dataforseo_trends', sourceName: 'DataForSEO',
      contentHash: 'fixture-rebuild-1', title: 'curry', queryOrTopic: 'curry', theme: 'curry_night',
      normalizedMetrics: { relatedQueries: { rising: [{ query: 'curry meal kit subscription', value: 55 }], top: [] } },
      dataStatus: 'live'
    });
    candidateAnalyst.analyzeCandidates = autoAssessAll({ candidateName: 'Curry meal kit subscriptions' });
    await buildReport(report.id, TODAY);
    const bundle1 = await db.getReportBundle(report);
    const rec1 = bundle1.recommendations.find((r) => r.theme === 'curry_night');
    assert.equal(rec1.recommendation_kind, 'candidate');

    await db.insertFeedback({ recommendationId: rec1.id, microtrendId: rec1.microtrend_id, feedbackType: 'not_relevant', reason: 'Not on-brand' });
    const beforeRebuild = await db.pool.query('SELECT * FROM recommendation_feedback WHERE microtrend_id = $1', [rec1.microtrend_id]);
    assert.equal(beforeRebuild.rowCount, 1);

    // Simulate a second manual Refresh the same day.
    await buildReport(report.id, TODAY);

    const afterRebuild = await db.pool.query('SELECT * FROM recommendation_feedback WHERE microtrend_id = $1', [rec1.microtrend_id]);
    assert.equal(afterRebuild.rowCount, 1, 'feedback must survive a same-day recommendations rebuild, never cascade-deleted');
    assert.equal(afterRebuild.rows[0].reversed_at, null, 'surviving feedback must still be active');

    const bundle2 = await db.getReportBundle(report);
    const rec2 = bundle2.recommendations.find((r) => r.theme === 'curry_night');
    assert.equal(rec2, undefined, 'the exclusion must still apply within the very rebuild that could have destroyed it -- no fallback fills the gap');

    const active = await db.listActiveFeedback();
    const row = active.find((f) => f.microtrend_id === rec1.microtrend_id);
    assert.ok(row, 'the hidden/covered manager must still list this feedback after its original recommendation was rebuilt');
    assert.equal(row.theme, 'curry_night', 'theme must fall back to the microtrend\'s own theme once the recommendation link is gone');
  });

  test('theme trends\' appearances14d and a recommendation card\'s own appearances14d agree -- neither counts today as a prior appearance', async () => {
    const yesterday = new Date(Date.now() - 86400000);
    const yesterdayStr = melbourneDateString(yesterday);

    const report1 = await db.getOrCreateReport(yesterdayStr);
    const run1 = await db.recordProviderRun(report1.id, { providerName: 'DataForSEO', sourceType: 'dataforseo_trends', status: 'live' });
    const item1 = await db.upsertSourceItem({
      providerRunId: run1.id, sourceType: 'dataforseo_trends', sourceName: 'DataForSEO',
      contentHash: 'fixture-count-consistency-1', title: 'fried rice', queryOrTopic: 'fried rice', theme: 'weeknight_dinners',
      normalizedMetrics: { relatedQueries: { rising: [{ query: 'kimchi fried rice', value: 50 }], top: [] } },
      dataStatus: 'live'
    });
    await db.pool.query('UPDATE source_items SET collected_at = $1 WHERE id = $2', [yesterday, item1.id]);
    candidateAnalyst.analyzeCandidates = autoAssessAll({ candidateName: 'Kimchi fried rice' });
    await buildReport(report1.id, yesterdayStr);

    const report2 = await db.getOrCreateReport(TODAY);
    const run2 = await db.recordProviderRun(report2.id, { providerName: 'DataForSEO', sourceType: 'dataforseo_trends', status: 'live' });
    await db.upsertSourceItem({
      providerRunId: run2.id, sourceType: 'dataforseo_trends', sourceName: 'DataForSEO',
      contentHash: 'fixture-count-consistency-2', title: 'fried rice', queryOrTopic: 'fried rice', theme: 'weeknight_dinners',
      normalizedMetrics: { relatedQueries: { rising: [{ query: 'kimchi fried rice', value: 50 }], top: [] } },
      dataStatus: 'live'
    });
    candidateAnalyst.analyzeCandidates = autoAssessAll({ candidateName: 'Kimchi fried rice' });
    await buildReport(report2.id, TODAY);

    const bundle2 = await db.getReportBundle(report2);
    const rec2 = bundle2.recommendations.find((r) => r.theme === 'weeknight_dinners');
    assert.ok(rec2, 'expected a weeknight_dinners recommendation today');
    assert.equal(rec2.continuity_meta.appearances14d, 1, 'the recommendation card counts exactly the 1 prior (yesterday\'s) appearance, not today\'s own');

    const themeStats = await db.getThemeRecommendationStats(['weeknight_dinners'], TODAY);
    assert.equal(themeStats.weeknight_dinners.count14d, 1, 'the theme card must report the SAME count as the recommendation card for the same theme, same day');
  });

  describe('social-native candidate discovery: tier gating and evidence_basis', () => {
    test('a single credible social post can only ever reach Watch, never Investigate or Create', async () => {
      const report = await db.getOrCreateReport(TODAY);
      await insertSocialPost(report.id, {
        theme: 'lunchbox_snacks', sourceType: 'apify_reddit', contentHash: 'fixture-social-single-1',
        excerpt: 'Air frying leftover rice into crispy bites for the kids\' lunchboxes, they loved it', author: 'redditor_a'
      });
      candidateAnalyst.analyzeCandidates = mergeAllForTheme('lunchbox_snacks', { candidateName: 'Air fryer rice bites', brandRelevance: 0.9 });

      const result = await buildReport(report.id, TODAY);
      assert.equal(result.recommendationsCreated, 1);

      const bundle = await db.getReportBundle(report);
      const rec = bundle.recommendations.find((r) => r.theme === 'lunchbox_snacks');
      assert.ok(rec, 'expected a lunchbox_snacks recommendation');
      assert.equal(rec.action_type, 'Watch', 'a single social post, however credible, must never clear Investigate or Create');
      assert.equal(rec.evidence_basis, 'social', 'must be labelled a social-first signal, not broader search demand');
    });

    test('Investigate survives on 2 real posts even from the same creator', async () => {
      const report = await db.getOrCreateReport(TODAY);
      await insertSocialPost(report.id, {
        theme: 'sushi_asian', sourceType: 'apify_reddit', contentHash: 'fixture-social-multi-1',
        excerpt: 'Made sushi bake in a tray instead of individual rolls, so much easier', author: 'same_creator'
      });
      await insertSocialPost(report.id, {
        theme: 'sushi_asian', sourceType: 'apify_reddit', contentHash: 'fixture-social-multi-2',
        excerpt: 'Sushi bake tray recipe update: added spicy mayo layer this time', author: 'same_creator'
      });
      candidateAnalyst.analyzeCandidates = mergeAllForTheme('sushi_asian', { candidateName: 'Sushi bake (tray-style)', brandRelevance: 0.7 });

      const result = await buildReport(report.id, TODAY);
      assert.equal(result.recommendationsCreated, 1);

      const bundle = await db.getReportBundle(report);
      const rec = bundle.recommendations.find((r) => r.theme === 'sushi_asian');
      assert.ok(rec, 'expected a sushi_asian recommendation');
      assert.equal(rec.action_type, 'Investigate', 'multiple real posts (even one creator) must be enough to reach Investigate');
      assert.equal(rec.evidence_basis, 'social');
    });

    test('Create is downgraded to Investigate without creator diversity, even with strong multi-platform corroboration', async () => {
      const report = await db.getOrCreateReport(TODAY);
      await insertSocialPost(report.id, {
        theme: 'curry_night', sourceType: 'apify_reddit', contentHash: 'fixture-social-create-1',
        excerpt: 'Butter chicken curry meal prep in the air fryer, game changer', author: 'one_creator'
      });
      await insertSocialPost(report.id, {
        theme: 'curry_night', sourceType: 'apify_tiktok', contentHash: 'fixture-social-create-2',
        excerpt: 'Air fryer butter chicken curry meal prep, posting the full recipe', author: 'one_creator'
      });
      await insertSocialPost(report.id, {
        theme: 'curry_night', sourceType: 'apify_instagram', contentHash: 'fixture-social-create-3',
        excerpt: 'Weekly butter chicken curry meal prep in the air fryer, reel version', author: 'one_creator'
      });
      candidateAnalyst.analyzeCandidates = mergeAllForTheme('curry_night', { candidateName: 'Air fryer butter chicken meal prep', brandRelevance: 1 });

      const result = await buildReport(report.id, TODAY);
      assert.equal(result.recommendationsCreated, 1);

      const bundle = await db.getReportBundle(report);
      const rec = bundle.recommendations.find((r) => r.theme === 'curry_night');
      assert.ok(rec, 'expected a curry_night recommendation');
      assert.equal(rec.action_type, 'Investigate', 'without creator diversity, a social-only candidate must never reach Create regardless of post/platform count');
      assert.equal(rec.evidence_basis, 'social');
    });

    test('Create survives with real creator diversity across posts', async () => {
      const report = await db.getOrCreateReport(TODAY);
      await insertSocialPost(report.id, {
        theme: 'weeknight_dinners', sourceType: 'apify_reddit', contentHash: 'fixture-social-diverse-1',
        excerpt: 'Kimchi fried rice in 10 minutes, weeknight staple now', author: 'creator_one'
      });
      await insertSocialPost(report.id, {
        theme: 'weeknight_dinners', sourceType: 'apify_tiktok', contentHash: 'fixture-social-diverse-2',
        excerpt: 'Kimchi fried rice hack for busy weeknights, so quick', author: 'creator_two'
      });
      await insertSocialPost(report.id, {
        theme: 'weeknight_dinners', sourceType: 'apify_instagram', contentHash: 'fixture-social-diverse-3',
        excerpt: 'My go-to kimchi fried rice for weeknight dinners, reel', author: 'creator_three'
      });
      candidateAnalyst.analyzeCandidates = mergeAllForTheme('weeknight_dinners', { candidateName: 'Kimchi fried rice', brandRelevance: 1 });

      const result = await buildReport(report.id, TODAY);
      assert.equal(result.recommendationsCreated, 1);

      const bundle = await db.getReportBundle(report);
      const rec = bundle.recommendations.find((r) => r.theme === 'weeknight_dinners');
      assert.ok(rec, 'expected a weeknight_dinners recommendation');
      assert.equal(rec.action_type, 'Create', 'real creator diversity across posts must be enough to reach Create');
      assert.equal(rec.evidence_basis, 'social');
    });

    test('corroboration from a search signal lifts the social-only gate entirely, even with just 1 post and no known creator', async () => {
      const report = await db.getOrCreateReport(TODAY);
      const run = await db.recordProviderRun(report.id, { providerName: 'DataForSEO', sourceType: 'dataforseo_trends', status: 'live' });
      await db.upsertSourceItem({
        providerRunId: run.id, sourceType: 'dataforseo_trends', sourceName: 'DataForSEO',
        contentHash: 'fixture-social-mixed-1', title: 'low gi', queryOrTopic: 'low gi', theme: 'healthy_eating',
        normalizedMetrics: { relatedQueries: { rising: [{ query: 'low gi meal prep bowls', value: 80 }], top: [] } },
        dataStatus: 'live'
      });
      await insertSocialPost(report.id, {
        theme: 'healthy_eating', sourceType: 'apify_reddit', contentHash: 'fixture-social-mixed-2',
        excerpt: 'Low GI meal prep bowls got me through this week, sharing my method', author: null
      });
      candidateAnalyst.analyzeCandidates = mergeAllForTheme('healthy_eating', { candidateName: 'Low GI meal prep bowls', brandRelevance: 0.9 });

      const result = await buildReport(report.id, TODAY);
      assert.equal(result.recommendationsCreated, 1);

      const bundle = await db.getReportBundle(report);
      const rec = bundle.recommendations.find((r) => r.theme === 'healthy_eating');
      assert.ok(rec, 'expected a healthy_eating recommendation');
      assert.notEqual(rec.action_type, 'Watch', 'a single post with no known creator must not be capped at Watch once corroborated by a real search signal');
      assert.equal(rec.evidence_basis, 'mixed', 'must be labelled mixed, not pure social or pure search, once both are merged into one microtrend');
    });
  });
});
