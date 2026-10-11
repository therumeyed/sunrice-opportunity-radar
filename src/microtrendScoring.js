// Deterministic microtrend-level scoring (Microtrend Discovery brief,
// section on scoring -- this is the formula proposed to and confirmed by
// the user before any of this file was written). This is a SEPARATE
// formula from scoring.js's theme-level scoreOpportunity -- themes and
// microtrends answer different questions ("is this theme worth watching at
// all" vs "which specific microtrend inside it should today's
// recommendation actually be about") and conflating their weights would
// make neither one legible. An LLM may later turn these numbers into
// prose; it never computes or overrides them.
const { agreementScore } = require('./scoring');

const WEIGHTS = {
  freshness: 0.20,
  velocity: 0.25,
  agreement: 0.20,
  relevance: 0.15,
  novelty: 0.10,
  evidenceQuality: 0.10
};

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

// Linear decay to 0 over 10 days from first_seen_at (the TRUE first-seen
// date -- callers must pass the value from microtrends.first_seen_at,
// never an evidence item's own possibly-old published_at). 10 days rather
// than scoring.js's 7: a named microtrend is a narrower, more specific
// claim than a whole theme, so it's given a slightly longer window before
// "fresh discovery" decays to "yesterday's news" -- deliberately short of
// the 30-day macro-suppression window, which answers a different question
// (how long a *known baseline* idea stays suppressed, not how long a
// genuinely new one stays "fresh").
function freshnessScore(daysOld) {
  if (daysOld == null || Number.isNaN(daysOld)) return 0.5;
  return clamp01(1 - daysOld / 10);
}

// Velocity prefers a real numeric trend (today's strongest verified
// dataforseo_trends rising_value vs. the average of its own prior
// observations) over a bare categorical flag, because a number that moved
// is stronger evidence than a label alone. Falls back to the rising/growing
// classification itself only when there's no comparable number yet --
// Pinterest's `rank` is explicitly excluded from this numeric comparison:
// pinterestTrends.js documents rank/count/change fields as having no
// confirmed scale or direction, so treating a rank delta as "velocity"
// would assert something this system hasn't verified.
function velocityScore({ observationHistory = [], todayObservations = [] }) {
  const isRisingOrGrowing = (o) => {
    const c = (o.sourceNativeClassification || '').toLowerCase();
    return c.includes('rising') || c.includes('growing');
  };
  const hasFlagToday = todayObservations.some(isRisingOrGrowing);

  const todayNumeric = todayObservations.find(
    (o) => o.sourceType === 'dataforseo_trends' && o.metricType === 'rising_value' && typeof o.metricValue === 'number'
  );
  if (todayNumeric) {
    const priorNumeric = observationHistory.filter(
      (o) => o.source_type === 'dataforseo_trends' && o.metric_type === 'rising_value' && o.metric_value != null
    );
    if (priorNumeric.length > 0) {
      const priorAvg = priorNumeric.reduce((sum, o) => sum + Number(o.metric_value), 0) / priorNumeric.length;
      if (priorAvg > 0) {
        const pct = ((todayNumeric.metricValue - priorAvg) / priorAvg) * 100;
        return clamp01(pct / 200);
      }
    }
  }

  if (observationHistory.length === 0) return hasFlagToday ? 0.6 : 0.4; // brand new -- no baseline to compare against yet
  return hasFlagToday ? 0.55 : 0.3; // seen before, no comparable number -- fall back to the source's own flag
}

// Rewards a microtrend that is both recently first-seen AND not yet
// repeatedly recommended -- each prior appearance in recommendations knocks
// novelty down, so a microtrend that keeps winning a slot on its own
// genuine strength doesn't also get treated as "new" forever. Directly
// serves the brief's "never present the same idea as if it were new" rule.
function noveltyScore({ daysSinceFirstSeen, priorRecommendationCount = 0 }) {
  const recency = daysSinceFirstSeen == null ? 0.5 : clamp01(1 - daysSinceFirstSeen / 14);
  const repetitionPenalty = clamp01(1 - priorRecommendationCount * 0.2);
  return clamp01(recency * repetitionPenalty);
}

// Rewards real, distinct corroborating evidence over one item repeated --
// a cluster of 5 members all from the same single source_items row (e.g.
// the same query appearing in both rising and top) proves nothing beyond
// what 1 item already proved.
function evidenceQualityScore(uniqueSourceItemCount) {
  if (uniqueSourceItemCount >= 3) return 1;
  if (uniqueSourceItemCount === 2) return 0.7;
  if (uniqueSourceItemCount === 1) return 0.4;
  return 0;
}

/**
 * @param {object} input
 * @param {number|null} input.daysOld - days since true first_seen_at
 * @param {Array} input.observationHistory - prior microtrend_observations rows (snake_case, as returned by db.js)
 * @param {Array} input.todayObservations - today's aggregated observations (camelCase, from microtrendExtraction.aggregateObservations)
 * @param {number} input.distinctSourceCount
 * @param {number} input.relevance - 0-1, theme's own editorial relevance
 * @param {number|null} input.daysSinceFirstSeen
 * @param {number} input.priorRecommendationCount
 * @param {number} input.uniqueSourceItemCount
 */
function scoreMicrotrend({
  daysOld, observationHistory = [], todayObservations = [], distinctSourceCount,
  relevance, daysSinceFirstSeen, priorRecommendationCount = 0, uniqueSourceItemCount
}) {
  const components = {
    freshness: freshnessScore(daysOld),
    velocity: velocityScore({ observationHistory, todayObservations }),
    agreement: agreementScore(distinctSourceCount),
    relevance: clamp01(relevance),
    novelty: noveltyScore({ daysSinceFirstSeen, priorRecommendationCount }),
    evidenceQuality: evidenceQualityScore(uniqueSourceItemCount)
  };
  const score = Object.entries(WEIGHTS).reduce((sum, [key, weight]) => sum + components[key] * weight, 0) * 100;
  return { score: Math.round(score * 10) / 10, components };
}

// Macro candidates (identical to a theme's own seed query or an evergreen
// baseline) are suppressed for 30 days after they're first shown, UNLESS
// something has verifiably changed since (microtrends.hasMaterialChange) --
// otherwise every report would re-"discover" the same evergreen basics
// every single day. Micro and seasonal candidates are never baseline-locked
// this way; their score alone decides whether they rank highly enough to
// be picked, same as any other candidate.
function qualifiesForRecommendation({ candidateType, baselineShownAt, reportDate, materialChangeSinceBaseline }) {
  if (candidateType !== 'macro') return true;
  if (!baselineShownAt) return true;
  const daysSinceBaseline = (new Date(reportDate) - new Date(baselineShownAt)) / 86400000;
  if (daysSinceBaseline < 30) return Boolean(materialChangeSinceBaseline);
  return true;
}

function confidenceForMicrotrend(score, distinctSourceCount) {
  if (score >= 70 && distinctSourceCount >= 2) return 'high';
  if (score >= 45) return 'medium';
  return 'early_signal';
}

function actionTypeForMicrotrend(score) {
  if (score >= 70) return 'Create';
  if (score >= 45) return 'Investigate';
  return 'Watch';
}

// Social evidence (real Reddit/TikTok/Instagram posts) has no verified
// engagement metric -- a play count or like count's real scale/meaning
// isn't confirmed, same caution as Pinterest's rank/count fields -- so a
// social-only candidate can never earn "measurable momentum" the way a
// real DataForSEO rising_value can. This gate is deliberately
// downgrade-only, applied AFTER the score-driven tier above, and only
// when the candidate is social-only (every contributing source_type is a
// real social platform, nothing from search/Pinterest):
//   - Create requires creator diversity (2+ distinct real authors) --
//     without it, and with no cross-source corroboration (which would
//     have made isSocialOnly false in the first place), downgrade to
//     Investigate.
//   - Investigate requires multiple posts or multiple creators -- a
//     single post, however credible, downgrades (further) to Watch.
//   - Watch is always reachable from a single credible post; this gate
//     never touches an already-Watch tier.
function resolveSocialTier(tier, { isSocialOnly, distinctPostCount = 0, distinctCreatorCount = 0 }) {
  if (!isSocialOnly) return tier;
  let resolved = tier;
  if (resolved === 'Create' && distinctCreatorCount < 2) resolved = 'Investigate';
  if (resolved === 'Investigate' && distinctPostCount < 2 && distinctCreatorCount < 2) resolved = 'Watch';
  return resolved;
}

module.exports = {
  WEIGHTS, scoreMicrotrend, qualifiesForRecommendation, confidenceForMicrotrend, actionTypeForMicrotrend,
  resolveSocialTier, freshnessScore, velocityScore, noveltyScore, evidenceQualityScore
};
