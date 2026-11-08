// Stage 2 (IMPLEMENTATION_CHECKLIST.md): flags a possible repost across
// DIFFERENT social platforms -- never a conclusive finding, and never
// used here to merge candidates or conflate creators. Two independent
// creators describing the same real trend in genuinely similar words is
// a normal, expected thing (especially around a templated caption
// format) and must NOT be flagged just for being topically similar --
// only near-IDENTICAL text (the same caption, copy-pasted or reposted)
// crosses this bar. Detection and storage only in this stage; nothing
// here changes distinctCreatorCount, distinctSourceCount, or any score --
// that wiring is deliberately deferred to whichever later stage actually
// touches scoring, same "store now, activate later" pattern already used
// for microtrend_social_signals.
const { normalizeKey, tokenOverlap } = require('./microtrends');
const { isSocialSourceType } = require('./microtrendExtraction');

// Deliberately much stricter than CLUSTER_OVERLAP_THRESHOLD (0.75, used
// to decide "is this the same idea") -- a repost claim is a much
// stronger claim than "same idea", so it needs near-identical text, not
// just similar text.
const REPOST_OVERLAP_THRESHOLD = 0.9;

// members: [{ sourceItemId, sourceType, text }] -- text is the real post
// excerpt/title (same field socialCandidatesFor already extracts). Only
// compares pairs across DIFFERENT source types (a repost claim is about
// the same content crossing platforms, not about two posts on the same
// platform, which content_hash dedup already handles).
function detectPossibleReposts(members) {
  const social = members.filter((m) => isSocialSourceType(m.sourceType) && m.text && m.text.trim());
  const flags = [];
  for (let i = 0; i < social.length; i++) {
    for (let j = i + 1; j < social.length; j++) {
      const a = social[i];
      const b = social[j];
      if (a.sourceType === b.sourceType) continue;
      const similarity = tokenOverlap(normalizeKey(a.text), normalizeKey(b.text));
      if (similarity >= REPOST_OVERLAP_THRESHOLD) {
        flags.push({
          sourceItemIdA: Math.min(a.sourceItemId, b.sourceItemId),
          sourceItemIdB: Math.max(a.sourceItemId, b.sourceItemId),
          similarity
        });
      }
    }
  }
  return flags;
}

module.exports = { detectPossibleReposts, REPOST_OVERLAP_THRESHOLD };
