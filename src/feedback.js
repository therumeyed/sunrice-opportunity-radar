// Deterministic feedback rules (Microtrend Discovery brief). Feedback is
// used ONLY as explicit, named exclusion rules -- never as silent material
// for an LLM to infer a hidden "brand preference profile" from. Every
// function here is pure so the suppression logic is fully auditable and
// testable without a database.

// Fixed, editable reason lists per feedback type -- shown as dropdown
// options in the UI rather than a free-text field alone, so feedback stays
// structured enough to aggregate later. `note` is always still accepted
// alongside a reason for anything a fixed list doesn't capture.
const REASONS_BY_TYPE = {
  useful: [],
  already_covered: ['Published on blog', 'Covered in EDM', 'Already in content calendar', 'Covered on social'],
  not_relevant: ['Not on-brand', 'Too niche for our audience', 'Not aligned with current strategy', "Doesn't fit our products"],
  dont_show_again: ['Already tried, did not work', 'Not on-brand', 'Too niche', 'Low commercial value']
};

const FEEDBACK_TYPES = Object.keys(REASONS_BY_TYPE);

// already_covered additionally captures where the existing content lives --
// the brief's own fields for this feedback type -- which the other 3 types
// have no use for.
function requiresContentDetails(feedbackType) {
  return feedbackType === 'already_covered';
}

/**
 * @returns {{valid: boolean, error?: string}}
 */
function validateFeedbackInput(feedbackType, payload = {}) {
  if (!FEEDBACK_TYPES.includes(feedbackType)) {
    return { valid: false, error: `Unknown feedback_type "${feedbackType}" -- must be one of ${FEEDBACK_TYPES.join(', ')}` };
  }
  if (feedbackType === 'already_covered' && payload.contentStatus && !['planned', 'published'].includes(payload.contentStatus)) {
    return { valid: false, error: 'content_status must be "planned" or "published"' };
  }
  const allowedReasons = REASONS_BY_TYPE[feedbackType];
  if (allowedReasons.length > 0 && payload.reason && !allowedReasons.includes(payload.reason) && payload.reason !== 'Other') {
    return { valid: false, error: `reason must be one of ${allowedReasons.join(', ')}, or "Other" with a note` };
  }
  if (payload.reason === 'Other' && !payload.note) {
    return { valid: false, error: '"Other" requires a note explaining why' };
  }
  return { valid: true };
}

// The 3 deterministic exclusion rules (brief): not_relevant hides the
// whole microtrend cluster -- the topic itself isn't relevant, no angle on
// it should resurface. already_covered and dont_show_again both key off
// action_fingerprint (the specific proposed angle: products + channel +
// format + creative angle for this theme), not the underlying microtrend --
// a genuinely different angle on the same real microtrend is never blocked
// by either. useful contributes no exclusion at all; it's a positive
// signal only (see getPositiveFeedbackExamples / summarizeUsefulFeedback).
function deriveExclusions(activeFeedbackRows) {
  const hiddenMicrotrendIds = new Set();
  const suppressedFingerprints = new Set();
  for (const row of activeFeedbackRows) {
    if (row.feedback_type === 'not_relevant' && row.microtrend_id) hiddenMicrotrendIds.add(row.microtrend_id);
    if (row.feedback_type === 'dont_show_again' || row.feedback_type === 'already_covered') {
      if (row.action_fingerprint) {
        suppressedFingerprints.add(row.action_fingerprint);
      } else if (row.microtrend_id) {
        // No LLM-generated action existed when this feedback was given (no
        // API key, a failed call, or a validation rejection) -- there is no
        // finer-grained "action" to suppress than the microtrend's own
        // deterministic recommendation, so fall back to hiding the whole
        // microtrend rather than silently keeping it eligible forever.
        hiddenMicrotrendIds.add(row.microtrend_id);
      }
    }
  }
  return { hiddenMicrotrendIds, suppressedFingerprints };
}

// Filters a list of candidate recommendations against the active exclusion
// set. actionFingerprint is checked only when the candidate has one (an
// unavailable/invalid LLM output means no fingerprint, per continuity.js's
// same "null is never a degenerate match" rule) -- a null fingerprint can
// never be excluded by a stored non-null one.
function applyExclusions(candidates, exclusions) {
  return candidates.filter((c) => {
    if (c.microtrendId && exclusions.hiddenMicrotrendIds.has(c.microtrendId)) return false;
    if (c.actionFingerprint && exclusions.suppressedFingerprints.has(c.actionFingerprint)) return false;
    return true;
  });
}

// Deterministic aggregation only -- counts of what's already in the stored
// "useful" examples (suggested_channel, theme), never an LLM-inferred
// preference. This is the draft a human reviews before anything acts on
// it; nothing here is applied automatically.
function summarizeUsefulFeedback(examples) {
  const channelCounts = new Map();
  const themeCounts = new Map();
  for (const ex of examples) {
    if (ex.suggested_channel) channelCounts.set(ex.suggested_channel, (channelCounts.get(ex.suggested_channel) || 0) + 1);
    if (ex.theme) themeCounts.set(ex.theme, (themeCounts.get(ex.theme) || 0) + 1);
  }
  const sortDesc = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ value: key, count }));
  return {
    sampleSize: examples.length,
    topChannels: sortDesc(channelCounts),
    topThemes: sortDesc(themeCounts)
  };
}

// The brief calls for a human-reviewed gate "after 10-20 examples" -- this
// fires once per 10 NEW useful examples (not once ever), so the review
// prompt recurs as more feedback accumulates, rather than disappearing
// after the first review forever.
const BRAND_PREFERENCE_REVIEW_BATCH_SIZE = 10;
function needsBrandPreferenceReview(usefulCount, lastReviewedCount = 0) {
  return (usefulCount - lastReviewedCount) >= BRAND_PREFERENCE_REVIEW_BATCH_SIZE;
}

module.exports = {
  FEEDBACK_TYPES, REASONS_BY_TYPE, requiresContentDetails, validateFeedbackInput,
  deriveExclusions, applyExclusions, summarizeUsefulFeedback,
  BRAND_PREFERENCE_REVIEW_BATCH_SIZE, needsBrandPreferenceReview
};
