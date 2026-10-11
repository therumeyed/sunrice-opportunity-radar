// DB-backed integration test, gated on TEST_DATABASE_URL (never DATABASE_URL)
// so `npm test` can never touch a real database just because one happens to
// be configured in the environment -- same convention as the sibling
// Melbourne Airport dashboard in this account.
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
  let db, buildReport;

  before(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    db = require('../src/db');
    ({ buildReport } = require('../src/reportBuilder'));
    await db.initSchema();
  });

  beforeEach(async () => {
    await db.pool.query(`TRUNCATE TABLE recommendation_feedback, recommendation_evidence, recommendations,
      microtrend_evidence, microtrend_observations, microtrends,
      signals, theme_daily_snapshots, source_items, provider_runs, reports RESTART IDENTITY CASCADE`);
  });

  after(async () => {
    await db.pool.query(`TRUNCATE TABLE recommendation_feedback, recommendation_evidence, recommendations,
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

  test('real evidence produces a recommendation traceable back to its source_items', async () => {
    const report = await db.getOrCreateReport(TODAY);
    const run = await db.recordProviderRun(report.id, {
      providerName: 'Google News RSS', sourceType: 'google_news', status: 'live'
    });
    await db.upsertSourceItem({
      providerRunId: run.id,
      sourceType: 'google_news',
      sourceName: 'Test Publication',
      sourceUrl: 'https://example.com/article',
      externalId: 'https://example.com/article',
      contentHash: 'fixture-hash-1',
      title: 'Rice cake snacks trending for school lunches',
      queryOrTopic: 'lunchbox snacks',
      theme: 'lunchbox_snacks',
      publishedAt: new Date(),
      dataStatus: 'live'
    });

    const result = await buildReport(report.id, TODAY);
    assert.equal(result.recommendationsCreated, 1);

    const bundle = await db.getReportBundle(report);
    assert.equal(bundle.recommendations.length, 1);
    const rec = bundle.recommendations[0];
    assert.equal(rec.theme, 'lunchbox_snacks');
    assert.ok(rec.evidence.length >= 1, 'recommendation must carry at least one linked evidence row');
    assert.equal(rec.evidence[0].source_url, 'https://example.com/article');
    assert.equal(rec.evidence[0].data_status, 'live');
  });

  test('re-running buildReport for the same report replaces, never duplicates, recommendations and signals', async () => {
    const report = await db.getOrCreateReport(TODAY);
    const run = await db.recordProviderRun(report.id, {
      providerName: 'Google News RSS', sourceType: 'google_news', status: 'live'
    });
    await db.upsertSourceItem({
      providerRunId: run.id,
      sourceType: 'google_news',
      sourceName: 'Test Publication',
      sourceUrl: 'https://example.com/rerun-article',
      externalId: 'https://example.com/rerun-article',
      contentHash: 'fixture-hash-rerun',
      title: 'Fried rice recipes trending this weekend',
      queryOrTopic: 'fried rice',
      theme: 'weeknight_dinners',
      publishedAt: new Date(),
      dataStatus: 'live'
    });

    await buildReport(report.id, TODAY);
    const first = await db.getReportBundle(report);
    assert.equal(first.recommendations.length, 1);

    // Simulate a second manual Refresh the same day, e.g. a re-run that finds
    // no new evidence -- this must not leave the earlier run's recommendation
    // sitting alongside a fresh, identical one.
    await buildReport(report.id, TODAY);
    const second = await db.getReportBundle(report);
    assert.equal(second.recommendations.length, 1, 'a same-day re-run must replace, not accumulate, recommendations');
    assert.equal(second.signals.length, first.signals.length, 'a same-day re-run must replace, not accumulate, signals');
  });

  test('momentum_sources names each source that independently flags the theme as rising/growing right now', async () => {
    const report = await db.getOrCreateReport(TODAY);
    const trendsRun = await db.recordProviderRun(report.id, {
      providerName: 'DataForSEO', sourceType: 'dataforseo_trends', status: 'live'
    });
    await db.upsertSourceItem({
      providerRunId: trendsRun.id,
      sourceType: 'dataforseo_trends',
      sourceName: 'DataForSEO',
      contentHash: 'fixture-hash-momentum-trends',
      title: 'cook rice',
      queryOrTopic: 'cook rice',
      theme: 'rice_basics',
      normalizedMetrics: { relatedQueries: { rising: [{ query: 'rice cooker ratio', value: 85 }], top: [] } },
      dataStatus: 'live'
    });
    const pinterestRun = await db.recordProviderRun(report.id, {
      providerName: 'Pinterest Trends (via Apify, AU+NZ)', sourceType: 'apify_pinterest', status: 'live'
    });
    await db.upsertSourceItem({
      providerRunId: pinterestRun.id,
      sourceType: 'apify_pinterest',
      sourceName: 'Pinterest Trends (via Apify, AU+NZ)',
      sourceUrl: 'https://trends.pinterest.com/detail/?terms=cook+rice&country=AU',
      externalId: 'cook rice:AU+NZ:growing:2026-01-01',
      contentHash: 'fixture-hash-momentum-pinterest',
      title: 'cook rice',
      queryOrTopic: 'cook rice',
      theme: 'rice_basics',
      rawMetrics: { trendType: 'growing', rank: 2 },
      dataStatus: 'live'
    });

    await buildReport(report.id, TODAY);
    const bundle = await db.getReportBundle(report);
    const rec = bundle.recommendations.find((r) => r.theme === 'rice_basics');
    assert.ok(rec, 'expected a rice_basics recommendation to be built from this fixture evidence');
    assert.deepEqual(rec.momentum_sources, ['google_trends', 'pinterest']);
  });

  test('momentum_sources is empty when no source currently flags the theme as rising/growing', async () => {
    const report = await db.getOrCreateReport(TODAY);
    const run = await db.recordProviderRun(report.id, {
      providerName: 'Google News RSS', sourceType: 'google_news', status: 'live'
    });
    await db.upsertSourceItem({
      providerRunId: run.id,
      sourceType: 'google_news',
      sourceName: 'Test Publication',
      sourceUrl: 'https://example.com/no-momentum',
      externalId: 'https://example.com/no-momentum',
      contentHash: 'fixture-hash-no-momentum',
      title: 'Lunchbox ideas for term 4',
      queryOrTopic: 'lunchbox snacks',
      theme: 'lunchbox_snacks',
      publishedAt: new Date(),
      dataStatus: 'live'
    });

    await buildReport(report.id, TODAY);
    const bundle = await db.getReportBundle(report);
    const rec = bundle.recommendations.find((r) => r.theme === 'lunchbox_snacks');
    assert.ok(rec, 'expected a lunchbox_snacks recommendation to be built from this fixture evidence');
    assert.ok(!rec.momentum_sources || rec.momentum_sources.length === 0);
  });

  test('every theme with evidence gets a theme_daily_snapshots row, not only the top 3', async () => {
    const report = await db.getOrCreateReport(TODAY);
    // 4 distinct themes so at least one cannot win a top-3 slot.
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
    assert.equal(result.recommendationsCreated, 3, 'only 3 can win a recommendation slot');

    const snapshotsRes = await db.pool.query('SELECT theme, was_recommended FROM theme_daily_snapshots WHERE report_id = $1', [report.id]);
    assert.equal(snapshotsRes.rowCount, 4, 'all 4 themes with evidence must have a snapshot row, not only the 3 that were recommended');
    const notRecommendedCount = snapshotsRes.rows.filter((r) => !r.was_recommended).length;
    assert.equal(notRecommendedCount, 1, 'exactly the one theme that did not win a slot should have was_recommended = false');
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

  test('Pinterest-only evidence is never counted as a matching social post and never forces a TikTok/Instagram channel', async () => {
    const report = await db.getOrCreateReport(TODAY);
    const run = await db.recordProviderRun(report.id, { providerName: 'Pinterest Trends (via Apify, AU+NZ)', sourceType: 'apify_pinterest', status: 'live' });
    await db.upsertSourceItem({
      providerRunId: run.id, sourceType: 'apify_pinterest', sourceName: 'Pinterest Trends (via Apify, AU+NZ)',
      sourceUrl: 'https://trends.pinterest.com/detail/?terms=rice+types&country=AU',
      externalId: 'rice types:AU+NZ:growing:2026-01-01', contentHash: 'fixture-hash-pinterest-only',
      title: 'rice types', queryOrTopic: 'rice types', theme: 'rice_basics',
      rawMetrics: { trendType: 'growing', rank: 1 }, dataStatus: 'live'
    });

    await buildReport(report.id, TODAY);
    const bundle = await db.getReportBundle(report);
    const rec = bundle.recommendations.find((r) => r.theme === 'rice_basics');
    assert.ok(rec, 'expected a rice_basics recommendation from this fixture');
    assert.notEqual(rec.suggested_channel, 'Short-form video (TikTok/Instagram)', 'Pinterest-only evidence must never trigger a TikTok/Instagram channel suggestion');
    assert.ok(!rec.rationale.includes('matching social post'), 'the deterministic fallback must never call a Pinterest trend item a "matching social post"');
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

  test('a genuinely specific rising query wins the slot as a named microtrend, traceable to its own evidence', async () => {
    const report = await db.getOrCreateReport(TODAY);
    const run = await db.recordProviderRun(report.id, { providerName: 'DataForSEO', sourceType: 'dataforseo_trends', status: 'live' });
    await db.upsertSourceItem({
      providerRunId: run.id, sourceType: 'dataforseo_trends', sourceName: 'DataForSEO',
      contentHash: 'fixture-hash-microtrend-1', title: 'sushi rice',
      queryOrTopic: 'sushi rice', theme: 'sushi_asian',
      normalizedMetrics: { relatedQueries: { rising: [{ query: 'air fryer sushi rice bowls', value: 90 }], top: [] } },
      dataStatus: 'live'
    });

    const result = await buildReport(report.id, TODAY);
    assert.equal(result.microtrendRecommendations, 1);

    const bundle = await db.getReportBundle(report);
    const rec = bundle.recommendations.find((r) => r.theme === 'sushi_asian');
    assert.ok(rec);
    assert.equal(rec.recommendation_kind, 'microtrend');
    assert.ok(rec.microtrend_id);
    assert.match(rec.opportunity_name, /air fryer sushi rice bowls/);
    assert.ok(rec.evidence.length >= 1, 'a microtrend recommendation must still carry real linked evidence');

    const microtrendRow = await db.pool.query('SELECT * FROM microtrends WHERE id = $1', [rec.microtrend_id]);
    assert.equal(microtrendRow.rows[0].candidate_type, 'micro');
    const evidenceRow = await db.pool.query('SELECT * FROM microtrend_evidence WHERE microtrend_id = $1', [rec.microtrend_id]);
    assert.ok(evidenceRow.rowCount >= 1, 'the microtrend itself must have real linked evidence, not just the recommendation');
  });

  test('a macro candidate (identical to a seed query) is shown once, then suppressed the next day with no material change', async () => {
    const seedQuery = 'cook rice'; // rice_basics' own seed query -- its own rising query is a macro candidate
    const yesterday = new Date(Date.now() - 86400000);
    const yesterdayStr = melbourneDateString(yesterday);

    const report1 = await db.getOrCreateReport(yesterdayStr);
    const run1 = await db.recordProviderRun(report1.id, { providerName: 'DataForSEO', sourceType: 'dataforseo_trends', status: 'live' });
    const item1 = await db.upsertSourceItem({
      providerRunId: run1.id, sourceType: 'dataforseo_trends', sourceName: 'DataForSEO',
      contentHash: 'fixture-hash-macro-day1', title: seedQuery, queryOrTopic: seedQuery, theme: 'rice_basics',
      normalizedMetrics: { relatedQueries: { rising: [{ query: seedQuery, value: 50 }], top: [] } },
      dataStatus: 'live'
    });
    // collected_at always defaults to the DB's real now() (see the file-level
    // comment) -- backdated directly so getTodayItems(yesterdayStr) actually
    // matches it, simulating this evidence having genuinely arrived yesterday.
    await db.pool.query('UPDATE source_items SET collected_at = $1 WHERE id = $2', [yesterday, item1.id]);

    const result1 = await buildReport(report1.id, yesterdayStr);
    assert.equal(result1.microtrendRecommendations, 1, 'a macro candidate never shown before must be allowed through once');

    const bundle1 = await db.getReportBundle(report1);
    const rec1 = bundle1.recommendations.find((r) => r.theme === 'rice_basics');
    assert.equal(rec1.recommendation_kind, 'microtrend');
    const microtrendId = rec1.microtrend_id;
    const afterDay1 = await db.pool.query('SELECT baseline_shown_at FROM microtrends WHERE id = $1', [microtrendId]);
    assert.ok(afterDay1.rows[0].baseline_shown_at, 'showing a macro for the first time must record baseline_shown_at');

    // Day 2 = today (the file's real TODAY constant), same exact evidence
    // (no new source, no velocity change) -- still inside the 30-day
    // suppression window, so this must NOT win the slot again as a
    // microtrend; the theme-level baseline_opportunity safety net must
    // cover the slot instead.
    const report2 = await db.getOrCreateReport(TODAY);
    const run2 = await db.recordProviderRun(report2.id, { providerName: 'DataForSEO', sourceType: 'dataforseo_trends', status: 'live' });
    await db.upsertSourceItem({
      providerRunId: run2.id, sourceType: 'dataforseo_trends', sourceName: 'DataForSEO',
      contentHash: 'fixture-hash-macro-day2', title: seedQuery, queryOrTopic: seedQuery, theme: 'rice_basics',
      normalizedMetrics: { relatedQueries: { rising: [{ query: seedQuery, value: 50 }], top: [] } },
      dataStatus: 'live'
    });
    const result2 = await buildReport(report2.id, TODAY);
    assert.equal(result2.microtrendRecommendations, 0, 'the same macro with no material change must be suppressed the next day');
    const bundle2 = await db.getReportBundle(report2);
    const rec2 = bundle2.recommendations.find((r) => r.theme === 'rice_basics');
    assert.equal(rec2.recommendation_kind, 'baseline_opportunity', 'a suppressed macro must fall back to the theme-level safety net, never a gap in the slot');
  });

  test('"not_relevant" feedback hides a microtrend from ever winning a slot again', async () => {
    const yesterday = new Date(Date.now() - 86400000);
    const yesterdayStr = melbourneDateString(yesterday);

    const report1 = await db.getOrCreateReport(yesterdayStr);
    const run1 = await db.recordProviderRun(report1.id, { providerName: 'DataForSEO', sourceType: 'dataforseo_trends', status: 'live' });
    const item1 = await db.upsertSourceItem({
      providerRunId: run1.id, sourceType: 'dataforseo_trends', sourceName: 'DataForSEO',
      contentHash: 'fixture-hash-feedback-1', title: 'curry', queryOrTopic: 'curry', theme: 'curry_night',
      normalizedMetrics: { relatedQueries: { rising: [{ query: 'air fryer butter chicken curry', value: 70 }], top: [] } },
      dataStatus: 'live'
    });
    await db.pool.query('UPDATE source_items SET collected_at = $1 WHERE id = $2', [yesterday, item1.id]);

    await buildReport(report1.id, yesterdayStr);
    const bundle1 = await db.getReportBundle(report1);
    const rec1 = bundle1.recommendations.find((r) => r.theme === 'curry_night');
    assert.equal(rec1.recommendation_kind, 'microtrend');
    const microtrendId = rec1.microtrend_id;

    await db.insertFeedback({ recommendationId: rec1.id, microtrendId, feedbackType: 'not_relevant', reason: 'Not on-brand' });

    const report2 = await db.getOrCreateReport(TODAY);
    const run2 = await db.recordProviderRun(report2.id, { providerName: 'DataForSEO', sourceType: 'dataforseo_trends', status: 'live' });
    await db.upsertSourceItem({
      providerRunId: run2.id, sourceType: 'dataforseo_trends', sourceName: 'DataForSEO',
      contentHash: 'fixture-hash-feedback-2', title: 'curry', queryOrTopic: 'curry', theme: 'curry_night',
      normalizedMetrics: { relatedQueries: { rising: [{ query: 'air fryer butter chicken curry', value: 95 }], top: [] } },
      dataStatus: 'live'
    });
    const result2 = await buildReport(report2.id, TODAY);
    assert.equal(result2.microtrendRecommendations, 0, 'a not_relevant microtrend must never win a slot again, even with stronger evidence');
    const bundle2 = await db.getReportBundle(report2);
    const rec2 = bundle2.recommendations.find((r) => r.theme === 'curry_night');
    assert.equal(rec2.recommendation_kind, 'baseline_opportunity');

    // The microtrend's own history/evidence still accumulates even while
    // hidden -- suppression controls recommending it, not tracking it.
    const evidenceRows = await db.pool.query('SELECT * FROM microtrend_evidence WHERE microtrend_id = $1', [microtrendId]);
    assert.ok(evidenceRows.rowCount >= 2, 'a hidden microtrend must keep accumulating real evidence across days');
  });

  test('getMicrotrendsForReport surfaces every candidate observed today, not only the one that won a slot (the Emerging section\'s data source)', async () => {
    const report = await db.getOrCreateReport(TODAY);
    const run = await db.recordProviderRun(report.id, { providerName: 'DataForSEO', sourceType: 'dataforseo_trends', status: 'live' });
    await db.upsertSourceItem({
      providerRunId: run.id, sourceType: 'dataforseo_trends', sourceName: 'DataForSEO',
      contentHash: 'fixture-hash-emerging-1', title: 'low gi', queryOrTopic: 'low gi', theme: 'healthy_eating',
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
      contentHash: 'fixture-hash-rebuild-1', title: 'curry', queryOrTopic: 'curry', theme: 'curry_night',
      normalizedMetrics: { relatedQueries: { rising: [{ query: 'curry meal kit subscription', value: 55 }], top: [] } },
      dataStatus: 'live'
    });
    await buildReport(report.id, TODAY);
    const bundle1 = await db.getReportBundle(report);
    const rec1 = bundle1.recommendations.find((r) => r.theme === 'curry_night');
    assert.equal(rec1.recommendation_kind, 'microtrend');

    await db.insertFeedback({ recommendationId: rec1.id, microtrendId: rec1.microtrend_id, feedbackType: 'not_relevant', reason: 'Not on-brand' });
    const beforeRebuild = await db.pool.query('SELECT * FROM recommendation_feedback WHERE microtrend_id = $1', [rec1.microtrend_id]);
    assert.equal(beforeRebuild.rowCount, 1);

    // Simulate a second manual Refresh the same day -- buildReport deletes
    // and rebuilds this report's recommendations, which used to CASCADE
    // and silently wipe out the feedback row above.
    await buildReport(report.id, TODAY);

    const afterRebuild = await db.pool.query('SELECT * FROM recommendation_feedback WHERE microtrend_id = $1', [rec1.microtrend_id]);
    assert.equal(afterRebuild.rowCount, 1, 'feedback must survive a same-day recommendations rebuild, never cascade-deleted');
    assert.equal(afterRebuild.rows[0].reversed_at, null, 'surviving feedback must still be active');

    // And it must still be doing its job: the now-excluded microtrend must
    // not win a slot again even in the SAME rebuild that just ran.
    const bundle2 = await db.getReportBundle(report);
    const rec2 = bundle2.recommendations.find((r) => r.theme === 'curry_night');
    assert.equal(rec2.recommendation_kind, 'baseline_opportunity', 'the exclusion must still apply within the very rebuild that could have destroyed it');

    // The manager view must still show it (via the microtrend fallback,
    // since recommendation_id is now null after the rebuild) rather than
    // silently dropping it because its original recommendation row is gone.
    const active = await db.listActiveFeedback();
    const row = active.find((f) => f.microtrend_id === rec1.microtrend_id);
    assert.ok(row, 'the hidden/covered manager must still list this feedback after its original recommendation was rebuilt');
    assert.equal(row.theme, 'curry_night', 'theme must fall back to the microtrend\'s own theme once the recommendation link is gone');
  });

  test('theme trends\' appearances14d and a recommendation card\'s own appearances14d must agree -- neither counts today as a prior appearance', async () => {
    const yesterday = new Date(Date.now() - 86400000);
    const yesterdayStr = melbourneDateString(yesterday);

    const report1 = await db.getOrCreateReport(yesterdayStr);
    const run1 = await db.recordProviderRun(report1.id, { providerName: 'Google News RSS', sourceType: 'google_news', status: 'live' });
    const item1 = await db.upsertSourceItem({
      providerRunId: run1.id, sourceType: 'google_news', sourceName: 'Test Publication',
      sourceUrl: 'https://example.com/count-consistency', externalId: 'https://example.com/count-consistency',
      contentHash: 'fixture-hash-count-consistency', title: 'Fried rice trending',
      queryOrTopic: 'fried rice', theme: 'weeknight_dinners', publishedAt: yesterday, dataStatus: 'live'
    });
    await db.pool.query('UPDATE source_items SET collected_at = $1 WHERE id = $2', [yesterday, item1.id]);
    await buildReport(report1.id, yesterdayStr);

    const report2 = await db.getOrCreateReport(TODAY);
    const run2 = await db.recordProviderRun(report2.id, { providerName: 'Google News RSS', sourceType: 'google_news', status: 'live' });
    await db.upsertSourceItem({
      providerRunId: run2.id, sourceType: 'google_news', sourceName: 'Test Publication',
      sourceUrl: 'https://example.com/count-consistency-2', externalId: 'https://example.com/count-consistency-2',
      contentHash: 'fixture-hash-count-consistency-2', title: 'Fried rice still trending',
      queryOrTopic: 'fried rice', theme: 'weeknight_dinners', publishedAt: new Date(), dataStatus: 'live'
    });
    await buildReport(report2.id, TODAY);

    const bundle2 = await db.getReportBundle(report2);
    const rec2 = bundle2.recommendations.find((r) => r.theme === 'weeknight_dinners');
    assert.ok(rec2, 'expected a weeknight_dinners recommendation today');
    assert.equal(rec2.continuity_meta.appearances14d, 1, 'the recommendation card counts exactly the 1 prior (yesterday\'s) appearance, not today\'s own');

    const themeStats = await db.getThemeRecommendationStats(['weeknight_dinners'], TODAY);
    assert.equal(themeStats.weeknight_dinners.count14d, 1, 'the theme card must report the SAME count as the recommendation card for the same theme, same day');
  });

  test('a score that would qualify for Create is downgraded to Investigate when there is no concrete action to show', async () => {
    // No ANTHROPIC_API_KEY in this test environment -- writeRationale
    // always returns null, so there is never a real recommendedAction.
    // A high-scoring microtrend must never be labelled Create with
    // nothing concrete behind it.
    delete process.env.ANTHROPIC_API_KEY;
    const report = await db.getOrCreateReport(TODAY);
    const run = await db.recordProviderRun(report.id, { providerName: 'DataForSEO', sourceType: 'dataforseo_trends', status: 'live' });
    await db.upsertSourceItem({
      providerRunId: run.id, sourceType: 'dataforseo_trends', sourceName: 'DataForSEO',
      contentHash: 'fixture-hash-create-downgrade', title: 'sushi', queryOrTopic: 'sushi', theme: 'sushi_asian',
      normalizedMetrics: { relatedQueries: { rising: [{ query: 'air fryer sushi bake', value: 95 }], top: [] } },
      dataStatus: 'live'
    });
    await buildReport(report.id, TODAY);
    const bundle = await db.getReportBundle(report);
    const rec = bundle.recommendations.find((r) => r.theme === 'sushi_asian');
    assert.ok(rec);
    assert.equal(rec.recommended_action, null, 'no real action was ever generated in this fixture');
    assert.notEqual(rec.action_type, 'Create', 'Create must never be shown without a concrete recommended_action backing it');
  });
});
