// Deterministic recommendation continuity -- action_fingerprint and
// continuity_status are both computed here, never by Claude.
// computeActionFingerprint hashes the specific proposed action (Claude's
// own product/channel/format/creative-angle judgment from
// src/candidateAnalyst.js), but the fingerprint comparison and the
// resulting new/continuing/strengthening/weakening/new_angle/repeat_action
// label are reportBuilder.js's own deterministic call, the system of
// record. Same principle as score/confidence/action_type/ranking -- this
// is one more thing Claude never gets final say over.
const crypto = require('crypto');

function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Fingerprint of WHAT was recommended (not why) -- theme + products +
// channel/format + creative angle, normalized and hashed. Two days
// proposing the same product on the same channel with the same angle
// fingerprint identically regardless of how differently the rationale
// prose was worded that day.
function computeActionFingerprint({ theme, primaryProducts, channel, format, creativeAngle }) {
  const parts = [
    normalize(theme),
    ...[...(primaryProducts || [])].map(normalize).sort(),
    normalize(channel),
    normalize(format),
    normalize(creativeAngle)
  ];
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
}

// `recentRecs`: this theme's recommendations from the last N days (DESC by
// date), already excluding today's own report. `sameDayRec`: this theme's
// recommendation from EARLIER today, if a manual refresh already produced
// one before this run (captured before the same-day delete, see
// reportBuilder.js) -- distinct from recentRecs because it's the same
// calendar day, not a prior day. `newFingerprint` is null whenever the LLM
// strategist didn't run or returned nothing usable -- with no real
// execution detail (products/channel/format/angle) to compare, asserting
// "repeat_action" or "new_angle" would be a specific claim this system
// can't actually back, so a null fingerprint skips straight to the
// score-trend classification below instead of ever being compared.
function determineContinuityStatus({ recentRecs, sameDayRec, newFingerprint, todayScore, reportDate }) {
  if (sameDayRec) {
    if (newFingerprint && sameDayRec.action_fingerprint) {
      return sameDayRec.action_fingerprint === newFingerprint ? 'repeat_action' : 'new_angle';
    }
    return 'continuing'; // same theme, same day, but nothing fingerprint-able to compare
  }
  if (!recentRecs || recentRecs.length === 0) return 'new';

  if (newFingerprint) {
    const daysSince = (row) => Math.round((new Date(reportDate) - new Date(row.report_date)) / 86400000);
    const sameFingerprintWithinWeek = recentRecs.some((r) => r.action_fingerprint && r.action_fingerprint === newFingerprint && daysSince(r) <= 7);
    if (sameFingerprintWithinWeek) return 'repeat_action';

    const mostRecentFingerprinted = recentRecs[0];
    if (mostRecentFingerprinted.action_fingerprint && newFingerprint !== mostRecentFingerprinted.action_fingerprint) return 'new_angle';
  }

  // +/-5 is a deliberate dead zone so a trivial score wobble doesn't flip
  // the label between strengthening/weakening/continuing every day.
  const mostRecent = recentRecs[0];
  const scoreDelta = todayScore - Number(mostRecent.score);
  if (scoreDelta > 5) return 'strengthening';
  if (scoreDelta < -5) return 'weakening';
  return 'continuing';
}

module.exports = { computeActionFingerprint, determineContinuityStatus };
