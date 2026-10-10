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
    await db.pool.query('TRUNCATE TABLE recommendation_evidence, recommendations, signals, theme_daily_snapshots, source_items, provider_runs, reports RESTART IDENTITY CASCADE');
  });

  after(async () => {
    await db.pool.query('TRUNCATE TABLE recommendation_evidence, recommendations, signals, theme_daily_snapshots, source_items, provider_runs, reports RESTART IDENTITY CASCADE');
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
});
