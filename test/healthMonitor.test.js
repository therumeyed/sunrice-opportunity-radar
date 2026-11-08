// DB-backed, gated on TEST_DATABASE_URL -- same convention as
// baseline.test.js/reportBuilder.test.js. Exercises the real schema
// (reports.trigger_type, provider_runs new/duplicate counts,
// source_health_alerts) and the real reconciliation logic in
// healthMonitor.js, not just the pure evaluateSourceConditions rules
// already covered by alerts.test.js.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !TEST_DATABASE_URL ? 'set TEST_DATABASE_URL to a scratch database to run this suite' : false;

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

describe('Stage 3: health monitoring (DB-backed)', { skip }, () => {
  let db, healthMonitor;

  before(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    db = require('../src/db');
    healthMonitor = require('../src/healthMonitor');
    await db.initSchema();
  });

  const TABLES = `source_health_alerts, baseline_snapshots, recommendation_feedback, recommendation_evidence, recommendations,
    microtrend_evidence, microtrend_observations, microtrend_social_signals, microtrends,
    signals, theme_daily_snapshots, source_items, provider_runs, reports`;

  beforeEach(async () => {
    await db.pool.query(`TRUNCATE TABLE ${TABLES} RESTART IDENTITY CASCADE`);
  });

  after(async () => {
    await db.pool.query(`TRUNCATE TABLE ${TABLES} RESTART IDENTITY CASCADE`);
    await db.pool.end();
  });

  async function insertRun(reportId, { sourceType, status, error, newItemCount = null, duplicateItemCount = null }) {
    const run = await db.recordProviderRun(reportId, { providerName: sourceType, sourceType, status, error });
    if (newItemCount !== null || duplicateItemCount !== null) {
      await db.updateProviderRunCounts(run.id, newItemCount, duplicateItemCount);
    }
    return run;
  }

  test('getOrCreateReport sets trigger_type on insert and updates it on a same-day re-run', async () => {
    const r1 = await db.getOrCreateReport('2026-02-01', 'scheduled');
    assert.equal(r1.trigger_type, 'scheduled');
    const r2 = await db.getOrCreateReport('2026-02-01', 'manual');
    assert.equal(r2.id, r1.id, 'same calendar date -- same report row, not a new one');
    assert.equal(r2.trigger_type, 'manual');
  });

  test('getSourceRunHistory aggregates multiple provider_runs rows into one group per source+date', async () => {
    const report = await db.getOrCreateReport('2026-02-02', 'scheduled');
    await insertRun(report.id, { sourceType: 'dataforseo_trends', status: 'live', newItemCount: 1, duplicateItemCount: 0 });
    await insertRun(report.id, { sourceType: 'dataforseo_trends', status: 'live', newItemCount: 0, duplicateItemCount: 1 });
    await insertRun(report.id, { sourceType: 'dataforseo_trends', status: 'failed', error: 'boom' });

    const rows = await db.getSourceRunHistory('2026-01-01');
    const group = rows.find((r) => r.source_type === 'dataforseo_trends' && new Date(r.report_date).toISOString().slice(0, 10) === '2026-02-02');
    assert.ok(group, 'expected one aggregated group for this source+date');
    assert.equal(Number(group.success_count), 2);
    assert.equal(Number(group.failed_count), 1);
    assert.equal(Number(group.new_items), 1);
    assert.equal(Number(group.duplicate_items), 1);
    assert.equal(group.trigger_type, 'scheduled');
  });

  test('upsertOpenAlert groups repeats into one open row; resolveOpenAlert closes it and is a no-op after', async () => {
    const first = await db.upsertOpenAlert('apify_reddit', 'consecutive_failures', 'detail A');
    assert.equal(first.isNew, true);
    assert.equal(first.alert.occurrence_count, 1);

    const second = await db.upsertOpenAlert('apify_reddit', 'consecutive_failures', 'detail B');
    assert.equal(second.isNew, false, 'a repeat of the same open incident updates, never duplicates');
    assert.equal(second.alert.id, first.alert.id);
    assert.equal(second.alert.occurrence_count, 2);
    assert.equal(second.alert.last_detail, 'detail B');

    const open = await db.getOpenSourceHealthAlerts();
    assert.equal(open.length, 1);

    const resolved = await db.resolveOpenAlert('apify_reddit', 'consecutive_failures');
    assert.ok(resolved);
    assert.equal(resolved.status, 'resolved');

    const resolvedAgain = await db.resolveOpenAlert('apify_reddit', 'consecutive_failures');
    assert.equal(resolvedAgain, null, 'resolving an already-resolved (or never-open) alert is a no-op, not an error');

    assert.equal((await db.getOpenSourceHealthAlerts()).length, 0);
    assert.equal((await db.getRecentlyResolvedAlerts()).length, 1);
  });

  test('runHealthCheck opens a consecutive_failures alert from real scheduled history, never counting a manual retry toward it, and resolves it on real recovery', async () => {
    const day1 = await db.getOrCreateReport(daysAgo(3), 'scheduled');
    await insertRun(day1.id, { sourceType: 'apify_tiktok', status: 'failed', error: 'timeout' });

    const day2 = await db.getOrCreateReport(daysAgo(2), 'manual'); // a manual retry -- must not inflate the streak
    await insertRun(day2.id, { sourceType: 'apify_tiktok', status: 'failed', error: 'timeout' });

    let health = await healthMonitor.runHealthCheck();
    let tiktok = health.sources.find((s) => s.sourceType === 'apify_tiktok');
    assert.ok(
      !tiktok.alertOutcomes.some((a) => a.alertType === 'consecutive_failures' && a.status === 'open'),
      'only 1 SCHEDULED failure exists so far (the manual retry must not count) -- must not alert yet'
    );

    const day3 = await db.getOrCreateReport(daysAgo(1), 'scheduled');
    await insertRun(day3.id, { sourceType: 'apify_tiktok', status: 'failed', error: 'timeout' });

    health = await healthMonitor.runHealthCheck();
    tiktok = health.sources.find((s) => s.sourceType === 'apify_tiktok');
    const opened = tiktok.alertOutcomes.find((a) => a.alertType === 'consecutive_failures');
    assert.ok(opened && opened.status === 'open' && opened.isNew, '2 scheduled failures now exist (day1, day3) -- must alert');

    const openRows = await db.getOpenSourceHealthAlerts();
    assert.ok(openRows.some((a) => a.source_type === 'apify_tiktok' && a.alert_type === 'consecutive_failures'));

    const day4 = await db.getOrCreateReport(daysAgo(0), 'scheduled');
    await insertRun(day4.id, { sourceType: 'apify_tiktok', status: 'live', newItemCount: 4, duplicateItemCount: 0 });

    health = await healthMonitor.runHealthCheck();
    tiktok = health.sources.find((s) => s.sourceType === 'apify_tiktok');
    const resolved = tiktok.alertOutcomes.find((a) => a.alertType === 'consecutive_failures');
    assert.ok(resolved && resolved.status === 'resolved', 'a real scheduled success recovers the alert');

    const stillOpen = await db.getOpenSourceHealthAlerts();
    assert.ok(!stillOpen.some((a) => a.source_type === 'apify_tiktok' && a.alert_type === 'consecutive_failures'));
  });

  test('a source that has never been attempted (every run awaiting_connection) raises no alert at all', async () => {
    const report = await db.getOrCreateReport(daysAgo(1), 'scheduled');
    await insertRun(report.id, { sourceType: 'apify_pinterest', status: 'awaiting_connection' });

    const health = await healthMonitor.runHealthCheck();
    const pinterest = health.sources.find((s) => s.sourceType === 'apify_pinterest');
    assert.deepEqual(pinterest.alertOutcomes, [], 'never-configured is "insufficient data", not "broken"');
  });

  test('AI analysis health is tracked as its own distinct source, never merged with scraper sources', async () => {
    const r1 = await db.getOrCreateReport(daysAgo(2), 'scheduled');
    await db.setReportAiStatus(r1.id, false, 'no ANTHROPIC_API_KEY configured');
    const r2 = await db.getOrCreateReport(daysAgo(1), 'scheduled');
    await db.setReportAiStatus(r2.id, false, 'no ANTHROPIC_API_KEY configured');

    const health = await healthMonitor.runHealthCheck();
    const ai = health.sources.find((s) => s.sourceType === 'ai_analysis');
    assert.ok(ai, 'ai_analysis must appear as its own entry');
    assert.ok(ai.alertOutcomes.some((a) => a.alertType === 'consecutive_failures' && a.status === 'open'));
    // Must not have leaked into (or out of) any real scraper source's entry.
    const tiktok = health.sources.find((s) => s.sourceType === 'apify_tiktok');
    assert.deepEqual(tiktok.alertOutcomes, []);
  });
});
