// Stage 3 (IMPLEMENTATION_CHECKLIST.md): orchestrates real stored history
// into the 4 alert rules, reconciles source_health_alerts (open new
// incidents, bump existing ones, resolve recovered ones), and fires email
// notifications where configured. Called after every ingest run (so
// alerts open/resolve as soon as new data exists) and again on-demand
// whenever the admin loads the Source health page, so that page always
// reflects the current real state rather than whatever it was after the
// last ingest.
const {
  getSourceRunHistory, getAiAnalysisHistory, upsertOpenAlert, resolveOpenAlert,
  getOpenSourceHealthAlerts, getRecentlyResolvedAlerts
} = require('./db');
const { evaluateSourceConditions } = require('./alerts');
const { getEmailConfig, sendAlertEmail } = require('./emailAlerts');

const SOURCE_TYPES = ['dataforseo_trends', 'google_news', 'apify_reddit', 'apify_tiktok', 'apify_instagram', 'apify_pinterest'];
const ALERT_TYPES = ['consecutive_failures', 'stale_no_success', 'zero_usable_records', 'auth_or_quota_error'];
const HISTORY_WINDOW_DAYS = 30;

function outcomeStatus(row) {
  if (Number(row.success_count) > 0) return 'ok';
  if (Number(row.failed_count) > 0) return 'failed';
  return 'unknown'; // e.g. every run that day was awaiting_connection -- not configured, not broken
}

function toRunRecord(row) {
  return {
    reportDate: row.report_date,
    triggerType: row.trigger_type,
    status: outcomeStatus(row),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    newItemCount: row.new_items != null ? Number(row.new_items) : null,
    duplicateItemCount: row.duplicate_items != null ? Number(row.duplicate_items) : null,
    error: row.last_error
  };
}

function toAiRunRecord(row) {
  return {
    reportDate: row.report_date,
    triggerType: row.trigger_type,
    status: row.ai_analysis_available ? 'ok' : 'failed',
    startedAt: row.report_date,
    finishedAt: row.report_date,
    newItemCount: null,
    error: row.ai_analysis_reason
  };
}

async function reconcileAlerts(sourceType, conditions) {
  const outcomes = [];
  for (const alertType of ALERT_TYPES) {
    const condition = conditions.find((c) => c.alertType === alertType);
    if (condition) {
      const { alert, isNew } = await upsertOpenAlert(sourceType, alertType, condition.detail);
      outcomes.push({ alertType, status: 'open', isNew, alert });
      if (isNew) {
        await sendAlertEmail(`[SunRice Radar] New alert: ${sourceType} -- ${alertType}`, condition.detail).catch(() => {});
      }
    } else {
      const resolved = await resolveOpenAlert(sourceType, alertType);
      if (resolved) {
        outcomes.push({ alertType, status: 'resolved', alert: resolved });
        await sendAlertEmail(
          `[SunRice Radar] Recovered: ${sourceType} -- ${alertType}`,
          `This alert for ${sourceType} (${alertType}) is no longer triggering as of this check.`
        ).catch(() => {});
      }
    }
  }
  return outcomes;
}

// A source whose every recent scheduled run is 'unknown' (every row that
// day was awaiting_connection -- a feature flag left off, no credentials
// configured) has never actually been attempted. Treated as
// "insufficient data", not "broken": raising no conditions here also
// resolves any alert that might have been open for it, since
// reconcileAlerts resolves every alert type not present in `conditions`.
async function evaluateOne(sourceType, allRuns) {
  const scheduledRuns = allRuns.filter((r) => r.triggerType === 'scheduled');
  const hasAnyRealOutcome = scheduledRuns.some((r) => r.status === 'ok' || r.status === 'failed');
  const conditions = hasAnyRealOutcome ? evaluateSourceConditions(sourceType, scheduledRuns) : [];
  const alertOutcomes = await reconcileAlerts(sourceType, conditions);
  return {
    sourceType,
    latestRun: allRuns[0] || null,
    recentRuns: allRuns.slice(0, 14),
    alertOutcomes
  };
}

async function runHealthCheck() {
  const sinceDate = new Date(Date.now() - HISTORY_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  const historyRows = await getSourceRunHistory(sinceDate);
  const aiRows = await getAiAnalysisHistory(sinceDate);

  const bySource = {};
  for (const type of SOURCE_TYPES) bySource[type] = [];
  for (const row of historyRows) {
    if (!bySource[row.source_type]) bySource[row.source_type] = [];
    bySource[row.source_type].push(toRunRecord(row));
  }

  const sources = [];
  for (const sourceType of Object.keys(bySource)) {
    sources.push(await evaluateOne(sourceType, bySource[sourceType]));
  }
  // AI analysis kept as its own, distinctly-categorised entry -- never
  // merged into the scraper sources above, per the brief's "keep scraper
  // health separate from AI analysis health" rule.
  sources.push(await evaluateOne('ai_analysis', aiRows.map(toAiRunRecord)));

  const [openAlerts, recentlyResolved] = await Promise.all([
    getOpenSourceHealthAlerts(),
    getRecentlyResolvedAlerts(20)
  ]);

  return { sources, openAlerts, recentlyResolved, email: getEmailConfig() };
}

module.exports = { runHealthCheck, SOURCE_TYPES, ALERT_TYPES };
