// Deterministic theme-level lifecycle -- separate from scoring.js's
// lifecycleFor(daysOld, velocityPct), which stays exactly as-is for the
// existing per-platform social panel. That function answers "is this one
// platform's post count up or down vs its own trailing average today" --
// a single-snapshot comparison with no memory. This one answers "across
// this theme's own accumulated daily history, what stage is it in", which
// only theme_daily_snapshots (added alongside this file) makes possible.
//
// Every threshold below is named and documented so it can be recalibrated
// later from real data without hunting through the logic -- see
// LIFECYCLE_THRESHOLDS. Never let the LLM anywhere near this: it's called
// from reportBuilder.js, before llmStrategist.js ever runs.
const LIFECYCLE_THRESHOLDS = {
  // Fewer than this many total observations (including today) -- too little
  // history for a momentum-based claim, regardless of what today's velocity
  // looks like. Matches the brief's explicit "validating" gate.
  minObservationsForMomentumClaim: 7,
  // Fewer than this many observations -- never eligible for "peaking",
  // even if the momentum-flattening pattern below technically matches.
  // Peaking is a stronger, rarer claim than building/cooling and needs
  // more history to back it before being shown at all.
  minObservationsForPeaking: 14,
  // velocityPct strictly above this -> momentum counts as positive/building.
  // Strictly below its negative -> cooling. Reused from scoring.js's own
  // +/-20 convention rather than inventing a new number.
  buildingVelocityPct: 20,
  coolingVelocityPct: -20,
  // Today's velocity at or below this counts as "materially flattened" for
  // peaking purposes -- noticeably under the building threshold, not just
  // off its all-time best.
  flattenedVelocityPct: 10,
  // How many of the most recent PRIOR (non-today) observations to check for
  // "was this theme genuinely building recently" before calling it peaking.
  recentPriorWindow: 3,
  // Today's score must be at least this fraction of the recent high to
  // count as "remains close to its recent high".
  nearHighRatio: 0.85
};

// `priorSnapshots`: this theme's own past theme_daily_snapshots rows,
// ordered oldest -> newest, NOT including today (today hasn't been saved
// yet when this runs). `todayScore`/`todayVelocityPct` are today's
// already-computed, real deterministic score/velocity -- nothing here
// recomputes or second-guesses them, this function only classifies a
// stage from values reportBuilder.js already has.
function themeLifecycleFor(priorSnapshots, todayScore, todayVelocityPct) {
  const t = LIFECYCLE_THRESHOLDS;
  const observationCount = priorSnapshots.length + 1; // +1 for today

  if (observationCount === 1) return 'new';
  if (observationCount < t.minObservationsForMomentumClaim) return 'validating';

  if (observationCount >= t.minObservationsForPeaking) {
    const recentHigh = Math.max(todayScore, ...priorSnapshots.map((s) => Number(s.score)));
    const nearRecentHigh = recentHigh > 0 && todayScore >= recentHigh * t.nearHighRatio;
    const recentPrior = priorSnapshots.slice(-t.recentPriorWindow);
    const wasBuildingRecently = recentPrior.some((s) => s.velocity_pct != null && Number(s.velocity_pct) > t.buildingVelocityPct);
    const flattenedOrDown = todayVelocityPct == null || todayVelocityPct <= t.flattenedVelocityPct;
    if (nearRecentHigh && wasBuildingRecently && flattenedOrDown) return 'peaking';
  }

  if (todayVelocityPct != null && todayVelocityPct > t.buildingVelocityPct) return 'building';
  if (todayVelocityPct != null && todayVelocityPct < t.coolingVelocityPct) return 'cooling';
  return 'sustained';
}

// For the UI: whether a 'peaking' claim is even eligible yet, independent
// of whether today's pattern actually matches it -- lets the frontend say
// "insufficient history to determine a peak" rather than imply a 3-day-old
// theme was checked for peaking and simply didn't qualify.
function peakingEligible(observationCount) {
  return observationCount >= LIFECYCLE_THRESHOLDS.minObservationsForPeaking;
}

module.exports = { themeLifecycleFor, peakingEligible, LIFECYCLE_THRESHOLDS };
