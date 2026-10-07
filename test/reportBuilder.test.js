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
    await db.pool.query('TRUNCATE TABLE recommendation_evidence, recommendations, signals, source_items, provider_runs, reports RESTART IDENTITY CASCADE');
  });

  after(async () => {
    await db.pool.query('TRUNCATE TABLE recommendation_evidence, recommendations, signals, source_items, provider_runs, reports RESTART IDENTITY CASCADE');
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
