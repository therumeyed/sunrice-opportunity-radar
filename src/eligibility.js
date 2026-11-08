// Stage 4 (IMPLEMENTATION_CHECKLIST.md): pure eligibility-gate logic --
// no DB access here, so it's trivially testable against fixtures.
// reportBuilder.js is the only caller, and is responsible for fetching
// real history and persisting the final verdict (recordRejectedCandidate).
//
// Claude judges semantic suitability and trend fidelity (product_mismatch,
// audience_mismatch, too_generic, too_late); deterministic code here
// enforces evidence integrity (checkInsufficientEvidence) and duplicates
// (isDuplicateWithoutNewEvidence) -- explicit exclusions are already
// enforced elsewhere (src/feedback.js's hiddenMicrotrendIds/
// suppressedFingerprints), not duplicated here.
const REASON_CODES = ['product_mismatch', 'audience_mismatch', 'too_generic', 'already_covered', 'too_late', 'insufficient_evidence'];
const VERDICTS = ['eligible', 'rejected', 'uncertain'];
// Reason codes Claude itself may choose when flagging rejected/uncertain --
// the semantic ones. already_covered and insufficient_evidence are decided
// deterministically downstream (duplicate-without-new-evidence, evidence
// data_status) and never asked of Claude, though Claude volunteering one of
// them is still accepted rather than silently discarded.
const CLAUDE_REASON_CODES = ['product_mismatch', 'audience_mismatch', 'too_generic', 'too_late'];

const UNCERTAIN_FALLBACK = Object.freeze({
  verdict: 'uncertain',
  reasonCode: null,
  explanation: 'AI did not return a usable eligibility verdict for this candidate.'
});

// Pure validator for Claude's own eligibility sub-object. Missing/malformed
// never defaults to 'eligible' -- a fabricated confident verdict is exactly
// what the brief forbids ("uncertain candidates should go to review rather
// than receive a fabricated confident verdict"). It degrades to
// UNCERTAIN_FALLBACK instead, the same treatment as if Claude had
// explicitly said "uncertain" itself.
function validateEligibilityBlock(raw) {
  if (!raw || typeof raw !== 'object') return { ...UNCERTAIN_FALLBACK };
  const { verdict, reasonCode, explanation } = raw;
  if (!VERDICTS.includes(verdict)) return { ...UNCERTAIN_FALLBACK };
  if (verdict === 'eligible') {
    return { verdict: 'eligible', reasonCode: null, explanation: explanation ? String(explanation).slice(0, 300) : null };
  }
  if (!reasonCode || !CLAUDE_REASON_CODES.includes(reasonCode) || !explanation) return { ...UNCERTAIN_FALLBACK };
  return { verdict, reasonCode, explanation: String(explanation).slice(0, 300) };
}

// Deterministic: true when every piece of evidence backing this candidate
// is non-'live' (cached/imported/awaiting_connection, or simply lacking a
// dataStatus at all) -- relying entirely on stale/non-live data to assert
// a live trend is exactly the "evidence unavailable or too old" case the
// brief worries about. A single live item is enough to pass.
function checkInsufficientEvidence(members) {
  if (!members || members.length === 0) return true;
  return !members.some((m) => m.dataStatus === 'live');
}

// "Duplicates an existing recommendation without meaningful new evidence."
// priorEvidenceIds: the flat list of source_item ids already cited by the
// past recommendation sharing this exact action_fingerprint. A single
// genuinely new evidence id is enough to count as meaningful -- a
// deliberately low bar, since requiring a human-judged amount of newness
// would be exactly the kind of invented precision this system avoids
// elsewhere.
function isDuplicateWithoutNewEvidence(todayEvidenceIds, priorEvidenceIds) {
  const prior = new Set(priorEvidenceIds || []);
  const today = todayEvidenceIds || [];
  if (today.length === 0) return true;
  return today.every((id) => prior.has(id));
}

// Builds the comparison context canResurface needs, from the prior
// rejection's stored assessment snapshot vs. today's real assessment.
function buildResurfacingContext(priorSnapshot, todayAssessment, todayEvidenceIds) {
  const snap = priorSnapshot || {};
  const priorEvidenceIds = new Set(snap.evidenceIds || []);
  const hasNewEvidenceIds = (todayEvidenceIds || []).some((id) => !priorEvidenceIds.has(id));

  const priorProducts = new Set(snap.productConnection || []);
  const todayProducts = todayAssessment.productConnection || [];
  const hasNewProductConnection = todayProducts.some((p) => !priorProducts.has(p));

  const classificationImproved = snap.classification === 'macro' && todayAssessment.classification !== 'macro';
  const newlyDistinctFromEvergreen = !snap.isDistinctFromEvergreen && Boolean(todayAssessment.isDistinctFromEvergreen);

  const priorAction = snap.proposedAction || {};
  const todayAction = todayAssessment.proposedAction || {};
  const hasDifferentExecution = hasNewProductConnection
    || (todayAction.creativeAngle || null) !== (priorAction.creativeAngle || null)
    || (todayAction.recommendedAction || null) !== (priorAction.recommendedAction || null);

  return { hasNewEvidenceIds, hasNewProductConnection, classificationImproved, newlyDistinctFromEvergreen, hasDifferentExecution };
}

// Reason-aware resurfacing (decisions doc, "Resurfacing rejected themes"):
// a previously rejected candidate may only be reconsidered when new
// evidence specifically addresses the reason it was rejected for -- never
// merely because a new source type appeared (explicitly called out as
// insufficient on its own, so it's deliberately NOT one of the signals
// checked below) and never because time alone has passed.
function canResurface(reasonCode, ctx) {
  const {
    hasNewEvidenceIds = false, hasNewProductConnection = false, classificationImproved = false,
    newlyDistinctFromEvergreen = false, hasDifferentExecution = false
  } = ctx || {};
  switch (reasonCode) {
    case 'product_mismatch': return hasNewProductConnection;
    case 'audience_mismatch': return hasNewEvidenceIds;
    case 'too_generic': return classificationImproved || newlyDistinctFromEvergreen || hasNewEvidenceIds;
    case 'too_late': return hasNewEvidenceIds;
    case 'already_covered': return hasDifferentExecution;
    case 'insufficient_evidence': return hasNewEvidenceIds;
    default: return false;
  }
}

module.exports = {
  REASON_CODES, VERDICTS, CLAUDE_REASON_CODES, UNCERTAIN_FALLBACK,
  validateEligibilityBlock, checkInsufficientEvidence, isDuplicateWithoutNewEvidence,
  buildResurfacingContext, canResurface
};
