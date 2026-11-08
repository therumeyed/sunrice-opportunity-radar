// Deterministic feedback rules (Microtrend Discovery brief). Feedback is
// used ONLY as explicit, named exclusion rules -- never as silent material
// for an LLM to infer a hidden "brand preference profile" from. Every
// function here is pure so the suppression logic is fully auditable and
// testable without a database.
//
// Stage 7 (IMPLEMENTATION_CHECKLIST.md): the UI collapses to 2 verdicts --
// Relevant / Not relevant -- and "Not relevant" now carries a structured
// reason_code from the SAME taxonomy Claude's own eligibility gate uses
// (src/eligibility.js's REASON_CODES), rather than a free-text reason list.
// This is what "reason-specific integration" means: human feedback and
// Claude's own rejections now speak one shared vocabulary.
const { REASON_CODES } = require('./eligibility');

// All feedback_type values the database has ever stored, including the
// pre-Stage-7 ones -- kept so historical rows (useful/already_covered/
// dont_show_again) keep displaying and filtering correctly under their
// original meaning. WRITABLE_FEEDBACK_TYPES below is the much narrower set
// the API actually accepts going forward.
const FEEDBACK_TYPES = ['useful', 'relevant', 'already_covered', 'not_relevant', 'dont_show_again'];

// Going forward, only these two verdicts are ever written. "Useful" folds
// into "Relevant" at the UI level -- a lighter-weight positive signal that
// deliberately does NOT feed the style/execution examples
// getPositiveFeedbackExamples hands to Claude (that stays scoped to the
// historical 'useful' rows alone, frozen with their original meaning,
// never joined by 'relevant'). "Already covered" and "Don't show again"
// fold into "Not relevant" + a reason_code of 'already_covered' --  the
// same structured reason, not a separate verdict.
const WRITABLE_FEEDBACK_TYPES = ['relevant', 'not_relevant'];

// Legacy free-text reason lists -- kept only so old rows (given before
// Stage 7) keep rendering their original reason text in the Hidden &
// covered manager and Idea Tracker. Never used by the current write path.
const REASONS_BY_TYPE = {
  useful: [],
  relevant: [],
  already_covered: ['Published on blog', 'Covered in EDM', 'Already in content calendar', 'Covered on social'],
  not_relevant: ['Not on-brand', 'Too niche for our audience', 'Not aligned with current strategy', "Doesn't fit our products"],
  dont_show_again: ['Already tried, did not work', 'Not on-brand', 'Too niche', 'Low commercial value']
};

// Human-readable labels for the 6 structured reason codes, shown in the
// "Not relevant" reason dropdown -- same codes src/eligibility.js's
// CLAUDE_REASON_CODES/REASON_CODES use, so a theme's human rejections and
// Claude's own rejections can be compared on equal footing.
const NOT_RELEVANT_REASON_LABELS = {
  product_mismatch: "Doesn't fit our products",
  audience_mismatch: 'Not right for our audience',
  too_generic: 'Too generic -- no fresh angle',
  already_covered: 'Already covered',
  too_late: 'Too late -- the moment has passed',
  insufficient_evidence: "Not convinced this is real"
};

// already_covered additionally captures where the existing content lives --
// the brief's own fields for this feedback type -- which nothing else has
// a use for. Checked against reasonCode too, now that already_covered is
// reachable as a not_relevant reason as well as its own legacy type.
function requiresContentDetails(feedbackType, reasonCode) {
  return feedbackType === 'already_covered' || (feedbackType === 'not_relevant' && reasonCode === 'already_covered');
}

/**
 * @returns {{valid: boolean, error?: string}}
 */
function validateFeedbackInput(feedbackType, payload = {}) {
  if (!WRITABLE_FEEDBACK_TYPES.includes(feedbackType)) {
    return { valid: false, error: `Unknown feedback_type "${feedbackType}" -- must be one of ${WRITABLE_FEEDBACK_TYPES.join(', ')}` };
  }
  if (feedbackType === 'not_relevant') {
    if (!payload.reasonCode || !REASON_CODES.includes(payload.reasonCode)) {
      return { valid: false, error: `reasonCode is required for not_relevant and must be one of ${REASON_CODES.join(', ')}` };
    }
    if (payload.reasonCode === 'already_covered' && payload.contentStatus && !['planned', 'published'].includes(payload.contentStatus)) {
      return { valid: false, error: 'content_status must be "planned" or "published"' };
    }
  }
  return { valid: true };
}

// The exclusion rules (brief section 8, revised Stage 7): not_relevant now
// carries a reason_code and is scoped to the exact recommendation (its
// action_fingerprint) -- "the exact recommendation is removed from the
// active feed; an unchanged duplicate is blocked", never the whole
// microtrend. A too_late vote and an already_covered vote are both scoped
// this way for the same reason: too_late is about THIS proposal's timing
// (a later, genuinely different proposal on the same real trend isn't
// blocked by it), and already_covered is about THIS proposal's repetition
// (a genuinely different angle isn't blocked either) -- fingerprint-level
// suppression is exactly what makes both of those true at once, without
// inventing separate expiry machinery for either.
//
// A not_relevant row given BEFORE Stage 7 (reason_code is null, since the
// column didn't exist yet) keeps its original, broader meaning -- the
// whole topic wasn't relevant -- rather than being silently reinterpreted
// under the new, narrower rule just because the code changed underneath it.
//
// already_covered and dont_show_again (the old standalone types) keep
// their original fingerprint-scoped behaviour unchanged. relevant and
// useful contribute no exclusion at all; relevant is a pure positive
// signal, useful's historical meaning is untouched.
function deriveExclusions(activeFeedbackRows) {
  const hiddenMicrotrendIds = new Set();
  const suppressedFingerprints = new Set();
  for (const row of activeFeedbackRows) {
    if (row.feedback_type === 'not_relevant') {
      if (row.reason_code) {
        if (row.action_fingerprint) suppressedFingerprints.add(row.action_fingerprint);
        else if (row.microtrend_id) hiddenMicrotrendIds.add(row.microtrend_id); // no fingerprint ever existed -- nothing finer to suppress
      } else if (row.microtrend_id) {
        hiddenMicrotrendIds.add(row.microtrend_id); // pre-Stage-7 vote -- original whole-topic meaning preserved
      }
    }
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

// Stage 7 (IMPLEMENTATION_CHECKLIST.md): "3 distinct rejected
// recommendations, same narrow theme, same reason, within 60 days ->
// flags the theme for admin review (never auto-hard-bans)". A soft,
// aggregated signal only -- nothing here suppresses anything; it's read by
// an admin-only endpoint (GET /admin/theme-review-flags) and acting on it
// (src/db.js's theme_exclusions) is always a separate, deliberate, human
// step.
//
// Counts DISTINCT recommendation decisions, never repeated clicks on the
// same one: grouped by action_fingerprint when one exists (the specific
// proposed angle), falling back to the recommendation's own id only when
// no fingerprint was ever generated for it (no API key, a failed call) --
// never by raw row count, so undoing and re-voting on the same
// recommendation, or two feedback rows that are really the same decision,
// can't inflate the tally. Rows with no reason_code (pre-Stage-7 votes, or
// anything with neither a fingerprint nor a recommendation id to key on)
// are skipped -- there is nothing stable to de-duplicate on, and inventing
// a count would be exactly the kind of fabricated precision this system
// avoids elsewhere.
const THEME_REVIEW_WINDOW_DAYS = 60;
const THEME_REVIEW_THRESHOLD = 3;
function themeReviewFlags(notRelevantRows, { windowDays = THEME_REVIEW_WINDOW_DAYS, threshold = THEME_REVIEW_THRESHOLD } = {}) {
  const cutoff = Date.now() - windowDays * 86400000;
  const decisionsByGroup = new Map();
  for (const row of notRelevantRows) {
    if (!row.reasonCode || !row.theme) continue;
    if (new Date(row.createdAt).getTime() < cutoff) continue;
    const decisionKey = row.actionFingerprint || (row.recommendationId ? `rec:${row.recommendationId}` : null);
    if (!decisionKey) continue;
    const groupKey = `${row.theme}::${row.reasonCode}`;
    if (!decisionsByGroup.has(groupKey)) decisionsByGroup.set(groupKey, new Set());
    decisionsByGroup.get(groupKey).add(decisionKey);
  }
  const flags = [];
  for (const [groupKey, decisions] of decisionsByGroup) {
    if (decisions.size >= threshold) {
      const [theme, reasonCode] = groupKey.split('::');
      flags.push({ theme, reasonCode, distinctCount: decisions.size });
    }
  }
  return flags.sort((a, b) => b.distinctCount - a.distinctCount);
}

module.exports = {
  FEEDBACK_TYPES, WRITABLE_FEEDBACK_TYPES, REASONS_BY_TYPE, NOT_RELEVANT_REASON_LABELS,
  requiresContentDetails, validateFeedbackInput,
  deriveExclusions, applyExclusions, summarizeUsefulFeedback,
  BRAND_PREFERENCE_REVIEW_BATCH_SIZE, needsBrandPreferenceReview,
  THEME_REVIEW_WINDOW_DAYS, THEME_REVIEW_THRESHOLD, themeReviewFlags
};
