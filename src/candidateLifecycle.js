// Stage 6 (IMPLEMENTATION_CHECKLIST.md): candidate-level lifecycle --
// Emerging / Growing / Established / Declining -- a SEPARATE concept from
// src/themeLifecycle.js's theme-level new/validating/building/cooling/
// sustained/peaking. A theme answers "how is this whole topic area
// trending"; this answers "how is this ONE specific idea trending" across
// its own real observation history. Never conflated -- both are shown in
// the UI with their own explanation.
//
// Reuses microtrendScoring.js's existing 3/7-day socialObservationEligibility
// tiers rather than inventing new thresholds (the brief: "use existing
// 3/7-day eligibility tiers where appropriate, document what each
// permits"). Below 3 real observation days: 'insufficient_history', never
// a forced label. 3-6 days ('preliminary'): 'emerging' only -- enough to
// know this is a real, recurring idea, not yet enough to call a
// direction. 7+ days ('eligible'): a real directional read is finally
// permitted -- 'growing'/'declining' only with an actual measured signal,
// 'established' as the honest default when the history is real but
// doesn't point clearly either way.
const { socialObservationEligibility } = require('./microtrendScoring');

// Documented planning assumption, not a measured fact -- the brief:
// "use two calendar days as a configurable planning assumption, clearly
// labelled as such... informs urgency only, never auto-rejects, never
// claims a precise remaining window." Change this one constant to
// recalibrate; nothing else needs touching.
const EXECUTION_LEAD_TIME_DAYS = 2;

// How many of the most recent observation days to compare against
// everything before them -- 3 to match the same "earliest a real pattern
// can be read" boundary socialObservationEligibility already uses.
const TREND_WINDOW = 3;
// A move smaller than this in either direction is noise, not a real
// trend -- same +/-20% convention reused everywhere else in this codebase
// (scoring.js, themeLifecycle.js, microtrends.js's hasMaterialChange).
const TREND_PCT_THRESHOLD = 20;

function averageOf(rows, key) {
  if (rows.length === 0) return null;
  return rows.reduce((sum, r) => sum + Number(r[key] || 0), 0) / rows.length;
}

// Compares the average of the most recent TREND_WINDOW days against the
// average of everything earlier -- a simple, inspectable trend direction,
// never a forecast. Returns null (not a default) when there isn't enough
// history to compare two real windows, or when neither average is
// usable -- callers must never read null as "established", only as
// "no directional signal from this source".
function trendDirectionFromSeries(rowsAsc, key, window = TREND_WINDOW) {
  if (rowsAsc.length < window + 1) return null;
  const recent = rowsAsc.slice(-window);
  const earlier = rowsAsc.slice(0, -window);
  const recentAvg = averageOf(recent, key);
  const earlierAvg = averageOf(earlier, key);
  if (recentAvg == null || earlierAvg == null) return null;
  if (earlierAvg === 0) return recentAvg > 0 ? 'growing' : null;
  const pct = ((recentAvg - earlierAvg) / earlierAvg) * 100;
  if (pct > TREND_PCT_THRESHOLD) return 'growing';
  if (pct < -TREND_PCT_THRESHOLD) return 'declining';
  return 'established';
}

// microtrend_social_signals history, ascending by report_date -- the
// first time this stored-but-unread (Stage 2/3) data actually gets read.
// new_post_count is the day's own genuinely-new post count (never
// cumulative engagement, per the brief's "cumulative popularity must
// never masquerade as velocity" rule) -- exactly the right series for a
// real velocity comparison.
function socialTrendDirection(socialSignalHistoryAsc) {
  return trendDirectionFromSeries(socialSignalHistoryAsc, 'new_post_count');
}

// microtrend_observations history, ascending -- restricted to
// dataforseo_trends' own verified rising_value (same restriction
// hasMomentumCorroboration/materialChangeInputs already apply elsewhere
// in this codebase; Pinterest's rank/count fields have no confirmed scale
// and are excluded).
function searchTrendDirection(observationHistoryAsc) {
  const numericRows = observationHistoryAsc.filter(
    (r) => r.source_type === 'dataforseo_trends' && r.metric_type === 'rising_value' && r.metric_value != null
  );
  return trendDirectionFromSeries(numericRows, 'metric_value');
}

// Distinct real calendar days of successful collection -- the union of
// both histories' report_dates, +1 for today (today's own rows haven't
// been written yet when this runs, same "+1 for today" convention as
// themeLifecycleFor). Never a raw row count: both source tables upsert
// one row per (microtrend, report) already (see db.js), so a same-day
// refresh can't inflate this on its own -- but a microtrend with
// observations on some days and social signals on others must still
// count each real day once, not twice.
function observationDays(observationHistoryAsc, socialSignalHistoryAsc) {
  const days = new Set();
  for (const r of observationHistoryAsc) days.add(new Date(r.report_date).toISOString().slice(0, 10));
  for (const r of socialSignalHistoryAsc) days.add(new Date(r.report_date).toISOString().slice(0, 10));
  return days.size + 1;
}

function candidateLifecycleFor({ days, searchDirection, socialDirection }) {
  const eligibility = socialObservationEligibility(days);
  if (eligibility === 'insufficient_history') return 'insufficient_history';
  if (eligibility === 'preliminary') return 'emerging';

  const directions = [searchDirection, socialDirection].filter(Boolean);
  if (directions.includes('growing') && !directions.includes('declining')) return 'growing';
  if (directions.includes('declining') && !directions.includes('growing')) return 'declining';
  return 'established'; // real history (7+ days), but no clear direction either way
}

// Informational only -- never a gate, never a countdown. Null for
// 'insufficient_history'/'emerging'/'established': nothing time-sensitive
// to say yet, or the pattern is stable.
function urgencyNote(lifecycle) {
  if (lifecycle === 'growing') {
    return `Momentum is still building -- with a typical ~${EXECUTION_LEAD_TIME_DAYS}-day planning/production lead time (a configurable assumption, not a predicted expiry), sooner is better.`;
  }
  if (lifecycle === 'declining') {
    return `Already showing cooling signals -- factor in the typical ~${EXECUTION_LEAD_TIME_DAYS}-day production lead time before committing resources.`;
  }
  return null;
}

module.exports = {
  EXECUTION_LEAD_TIME_DAYS, TREND_WINDOW, TREND_PCT_THRESHOLD,
  observationDays, searchTrendDirection, socialTrendDirection, candidateLifecycleFor, urgencyNote
};
