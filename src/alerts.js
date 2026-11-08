// Stage 3 (IMPLEMENTATION_CHECKLIST.md): pure alert-condition evaluation --
// no DB access here, so it's trivially testable against fixtures. Callers
// (healthMonitor.js) are responsible for fetching real history and for
// turning a returned condition into a stored/resolved alert row.
//
// Every rule in here reads ONLY scheduled runs by construction: the caller
// is required to pre-filter to trigger_type === 'scheduled' before calling
// evaluateSourceConditions, per the brief's "manual retries should not
// inflate failure counts" rule. This module has no way to tell scheduled
// from manual itself -- that's deliberate, so a caller can never
// accidentally pass mixed history and still get a "correct-looking" answer.

// Documented assumption, not a measured fact: the dashboard runs one
// scheduled ingest per day (render.yaml's cron), so "twice the refresh
// interval" is two days. If the schedule ever changes to something other
// than once-daily, this constant (or a future per-source override) is
// what to update -- never silently inferred from run timestamps.
const DEFAULT_REFRESH_INTERVAL_HOURS = 24;

function isAuthOrQuotaError(errorText) {
  if (!errorText) return false;
  return /\b(401|403|429|unauthoriz|forbidden|quota|rate.?limit)\b/i.test(errorText);
}

// runsDesc: scheduled-only runs for ONE source, most-recent-first, each
// { status: 'ok'|'failed', startedAt, finishedAt, newItemCount, error }.
// newItemCount may be null/undefined (counts weren't tracked for that run,
// e.g. a pre-Stage-3 historical row, or a source where "usable record"
// doesn't apply, like AI analysis) -- the zero-usable-records rule is
// skipped entirely rather than treating "unknown" as "zero".
function evaluateSourceConditions(sourceType, runsDesc, opts = {}) {
  const { refreshIntervalHours = DEFAULT_REFRESH_INTERVAL_HOURS, now = new Date() } = opts;
  const conditions = [];
  if (!runsDesc || runsDesc.length === 0) return conditions;

  const latest = runsDesc[0];

  // Authentication or quota errors: alert immediately, from the most
  // recent scheduled run alone -- never waits for a second occurrence.
  if (latest.status === 'failed' && isAuthOrQuotaError(latest.error)) {
    conditions.push({
      alertType: 'auth_or_quota_error',
      detail: `${sourceType}: ${latest.error}`
    });
  }

  // Two consecutive failed scheduled runs.
  const last2 = runsDesc.slice(0, 2);
  if (last2.length === 2 && last2.every((r) => r.status === 'failed')) {
    conditions.push({
      alertType: 'consecutive_failures',
      detail: `${sourceType}: last 2 scheduled runs both failed (most recent: ${latest.error || 'no error detail recorded'}).`
    });
  }

  // No successful scheduled refresh for more than 2x the refresh interval.
  const lastSuccess = runsDesc.find((r) => r.status === 'ok');
  const thresholdMs = refreshIntervalHours * 2 * 60 * 60 * 1000;
  const lastSuccessAt = lastSuccess ? new Date(lastSuccess.finishedAt || lastSuccess.startedAt) : null;
  if (!lastSuccessAt || (now.getTime() - lastSuccessAt.getTime()) > thresholdMs) {
    conditions.push({
      alertType: 'stale_no_success',
      detail: lastSuccessAt
        ? `${sourceType}: no successful scheduled run since ${lastSuccessAt.toISOString()} (threshold ${refreshIntervalHours * 2}h).`
        : `${sourceType}: no successful scheduled run recorded yet.`
    });
  }

  // Three consecutive scheduled runs that succeeded but returned zero
  // usable records -- flagged for investigation, deliberately a different
  // alert type from consecutive_failures (this isn't "the scraper broke",
  // it's "the scraper ran fine and found nothing three times running").
  const last3 = runsDesc.slice(0, 3);
  if (
    last3.length === 3 &&
    last3.every((r) => r.status === 'ok' && typeof r.newItemCount === 'number' && r.newItemCount === 0)
  ) {
    conditions.push({
      alertType: 'zero_usable_records',
      detail: `${sourceType}: last 3 scheduled runs succeeded but returned zero new/usable records.`
    });
  }

  return conditions;
}

module.exports = { evaluateSourceConditions, isAuthOrQuotaError, DEFAULT_REFRESH_INTERVAL_HOURS };
