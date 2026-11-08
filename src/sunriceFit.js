// Stage 5 (IMPLEMENTATION_CHECKLIST.md): the "SunRice fit" brand-suitability
// score -- a SEPARATE axis from the existing deterministic opportunity
// score/tier (which measures momentum/evidence strength, not brand fit).
// Eligibility (Stage 4) asks "is there a credible connection at all?";
// this asks "how strong is that connection?" -- a candidate can be
// eligible with a weak fit, or (if Claude and the eligibility gate
// disagree) flag a contradiction worth a human look (see
// detectFitEligibilityContradiction below).
//
// Deliberately anchored, not continuous: Claude picks one of 4 named
// anchors per component rather than an arbitrary 0-100 float, because a
// precise-looking number here would be exactly the kind of invented
// precision this system avoids everywhere else. The anchors are mapped to
// fixed numeric values only so the 4 components can be combined into one
// weighted composite -- the composite itself is still rounded to the
// nearest 5 before display, never shown with false precision.
const VALID_ANCHORS = ['strong', 'moderate', 'weak', 'none'];
const ANCHOR_VALUES = { strong: 100, moderate: 65, weak: 35, none: 0 };

// Decisions doc, "SunRice fit scoring": natural product connection 40%,
// format/preparation suitability 25%, audience/occasion relevance 20%,
// fidelity to the original trend 15%.
const COMPONENT_WEIGHTS = {
  productConnectionFit: 0.40,
  formatSuitability: 0.25,
  audienceOccasionRelevance: 0.20,
  trendFidelity: 0.15
};

const BANDS = { HIGH: 'High', MODERATE: 'Moderate', LOW: 'Low' };

function bandForScore(score) {
  if (score >= 80) return BANDS.HIGH;
  if (score >= 60) return BANDS.MODERATE;
  return BANDS.LOW;
}

// "This is an assessed suitability score, not a statistically calibrated
// probability" -- the brief requires this stated plainly wherever the
// score is shown. One shared string so every display (API, UI, docs)
// says exactly the same thing.
const DISCLAIMER = 'Assessed suitability, not a statistically calibrated probability.';

// Returns null when any component is missing/invalid -- the caller
// (candidateAnalyst.js's validateAssessment) treats a null result as
// "this whole assessment is unusable", same severity as a missing
// brandRelevance was before Stage 5.
function computeSunriceFit(components) {
  if (!components || typeof components !== 'object') return null;
  const { productConnectionFit, formatSuitability, audienceOccasionRelevance, trendFidelity } = components;
  const picked = { productConnectionFit, formatSuitability, audienceOccasionRelevance, trendFidelity };
  for (const key of Object.keys(COMPONENT_WEIGHTS)) {
    if (!VALID_ANCHORS.includes(picked[key])) return null;
  }
  const raw = Object.entries(COMPONENT_WEIGHTS)
    .reduce((sum, [key, weight]) => sum + ANCHOR_VALUES[picked[key]] * weight, 0);
  const score = Math.round(raw / 5) * 5;
  return { score, band: bandForScore(score), components: picked };
}

// Decisions doc: "Flag contradictions between the two stages for review."
// Scoped to the one component that overlaps both stages' primary
// question -- product connection -- since that's the one place a
// disagreement is actually meaningful to compare apples to apples; the
// other 3 fit components have no eligibility-stage counterpart at all.
function detectFitEligibilityContradiction({ eligibilityVerdict, eligibilityReasonCode, fit }) {
  if (!fit) return null;
  const productAnchor = fit.components.productConnectionFit;
  if (eligibilityVerdict === 'eligible' && productAnchor === 'none') {
    return 'Eligibility found a credible connection, but the fit score\'s own product-connection component is "none" -- worth a human look.';
  }
  if (eligibilityVerdict === 'rejected' && eligibilityReasonCode === 'product_mismatch' && productAnchor === 'strong') {
    return 'Eligibility rejected this for product_mismatch, but the fit score\'s own product-connection component is "strong" -- worth a human look.';
  }
  return null;
}

module.exports = {
  VALID_ANCHORS, ANCHOR_VALUES, COMPONENT_WEIGHTS, BANDS, DISCLAIMER,
  bandForScore, computeSunriceFit, detectFitEligibilityContradiction
};
