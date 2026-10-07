// Deterministic recommendation scoring (brief section 12). Weights sum to
// 100; every component is a plain 0-1 input so the formula stays auditable
// without needing to read this file to know what a score means. An LLM may
// later write the prose summary from these numbers, but it never touches
// the numbers themselves.
const WEIGHTS = {
  freshness: 0.25,
  velocity: 0.25,
  agreement: 0.20,
  relevance: 0.20,
  seasonalFit: 0.10
};

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

// Linear decay to 0 over a week -- "freshness" means "found recently",
// not "posted recently" (a source's own published_at can be missing).
function freshnessScore(daysOld) {
  if (daysOld == null || Number.isNaN(daysOld)) return 0.5; // unknown -- neutral, not zero
  return clamp01(1 - daysOld / 7);
}

// velocityPct is a relative change (e.g. DataForSEO's rising-query value, or
// a post-count delta) -- capped at 200% so one outlier can't dominate.
function velocityScore(velocityPct) {
  if (velocityPct == null || Number.isNaN(velocityPct)) return 0.3; // no measured change -- low, not zero
  return clamp01(velocityPct / 200);
}

// Cross-source agreement: how many independent source types corroborate
// this opportunity. 1 source is a hunch; 3+ is a pattern.
function agreementScore(distinctSourceCount) {
  if (distinctSourceCount >= 3) return 1;
  if (distinctSourceCount === 2) return 0.65;
  if (distinctSourceCount === 1) return 0.3;
  return 0;
}

function scoreOpportunity({ daysOld, velocityPct, distinctSourceCount, relevance, seasonalFit }) {
  const components = {
    freshness: freshnessScore(daysOld),
    velocity: velocityScore(velocityPct),
    agreement: agreementScore(distinctSourceCount),
    relevance: clamp01(relevance),
    seasonalFit: clamp01(seasonalFit)
  };
  const score = Object.entries(WEIGHTS).reduce((sum, [key, weight]) => sum + components[key] * weight, 0) * 100;
  return { score: Math.round(score * 10) / 10, components };
}

function confidenceFor(score, distinctSourceCount, forceEarlySignal) {
  if (forceEarlySignal) return 'early_signal';
  if (score >= 70 && distinctSourceCount >= 2) return 'high';
  if (score >= 45) return 'medium';
  return 'early_signal';
}

function actionTypeFor(score, forceEarlySignal) {
  if (forceEarlySignal) return 'Investigate';
  if (score >= 70) return 'Create';
  if (score >= 45) return 'Investigate';
  return 'Watch';
}

module.exports = { WEIGHTS, scoreOpportunity, confidenceFor, actionTypeFor, freshnessScore, velocityScore, agreementScore };
