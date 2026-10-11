// Normalization, clustering and macro/micro/seasonal classification for
// microtrend candidates. Deliberately simple, deterministic, inspectable
// rules -- no vector database, no embeddings, per the brief. Every
// function here is pure (no DB, no network) so it's cheap to unit test
// exhaustively; src/microtrendExtraction.js is what actually calls these
// against real evidence.

// Small, hand-maintained synonym map -- kept intentionally short and
// readable rather than exhaustive. Add to this as real collisions are
// found in production, never speculatively.
const SYNONYM_MAP = {
  gi: 'glycemic index',
  recipes: 'recipe',
  recipe: 'recipe',
  tips: 'tip',
  ideas: 'idea'
};

// Removed before token-overlap comparison only -- never applied to the
// text actually stored/displayed (source_wording keeps the original).
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'to', 'of', 'for', 'and', 'with', 'what',
  'how', 'why', 'do', 'does', 'in', 'on', 'at', 'vs', 'versus', 'or'
]);

// Occasions a candidate can be tied to regardless of which theme it came
// from -- deliberately the same occasion vocabulary as topics.js's own
// multicultural/seasonal queries, kept here as plain strings rather than
// importing topics.js, since this module has no reason to depend on the
// brand-specific topic library.
const OCCASION_KEYWORDS = ['christmas', 'australia day', 'lunar new year', 'diwali', 'ramadan', 'easter', 'mothers day', 'fathers day'];

function singularize(token) {
  if (token.length <= 3) return token;
  if (token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (/(s|x|z|ch|sh)es$/.test(token)) return token.slice(0, -2);
  if (token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

function canonicalToken(token) {
  const singular = singularize(token);
  return SYNONYM_MAP[singular] || SYNONYM_MAP[token] || singular;
}

// Lowercase, strip punctuation, singularize and apply the synonym map to
// every token, then rejoin -- stable across "sushi rolls"/"sushi roll",
// "GI"/"gi", "recipe ideas"/"recipe idea". This is the normalized_key
// stored on the microtrends row; source_wording keeps the real original
// text for display/audit.
function normalizeKey(text) {
  const tokens = (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(canonicalToken);
  return tokens.join(' ').trim();
}

// Token set used for overlap comparison only -- stopwords removed, so
// "how to cook rice" and "cook rice" compare as identical content.
function significantTokens(normalizedText) {
  return new Set(normalizedText.split(' ').filter((t) => t && !STOPWORDS.has(t)));
}

// Jaccard-style overlap on significant tokens -- 1.0 for identical sets,
// 0 for no shared tokens. Used only to decide whether two candidates
// ALREADY in the same theme are the same underlying idea; never used to
// cluster across themes or to justify clustering by theme alone.
function tokenOverlap(normalizedA, normalizedB) {
  const a = significantTokens(normalizedA);
  const b = significantTokens(normalizedB);
  if (a.size === 0 && b.size === 0) return normalizedA === normalizedB ? 1 : 0;
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / new Set([...a, ...b]).size;
}

// Groups raw candidate strings (already normalized) that are the same
// underlying idea -- exact normalized_key match first (the common case),
// then a conservative overlap threshold for near-duplicates that
// normalization alone didn't catch. Returns one canonical normalizedKey
// per cluster (the most common raw wording's key) plus the member list.
const CLUSTER_OVERLAP_THRESHOLD = 0.75;
function clusterCandidates(candidates) {
  const clusters = [];
  for (const candidate of candidates) {
    const existing = clusters.find((c) => c.normalizedKey === candidate.normalizedKey
      || tokenOverlap(c.normalizedKey, candidate.normalizedKey) >= CLUSTER_OVERLAP_THRESHOLD);
    if (existing) {
      existing.members.push(candidate);
    } else {
      clusters.push({ normalizedKey: candidate.normalizedKey, members: [candidate] });
    }
  }
  return clusters;
}

// macro: identical (post-normalization) to the theme's own seed query or
// theme label, or on the configured evergreen baseline list. seasonal:
// tied to a known dated occasion, regardless of theme. Otherwise micro --
// the default is specificity, not the other way around; nothing is
// assumed to be a microtrend just because it's a long or unusual phrase
// (an evergreen baseline term stays macro even if it's a full question).
function classifyCandidate({ normalizedKey, themeLabel, seedQueryKeys, evergreenBaselineKeys = [] }) {
  if (OCCASION_KEYWORDS.some((occ) => normalizedKey.includes(normalizeKey(occ)))) return 'seasonal';
  const themeKey = normalizeKey(themeLabel);
  if (normalizedKey === themeKey) return 'macro';
  if (seedQueryKeys.includes(normalizedKey)) return 'macro';
  if (evergreenBaselineKeys.includes(normalizedKey)) return 'macro';
  return 'micro';
}

// Has anything genuinely changed since this macro was last suppressed --
// a new source type never seen on it before, or velocity crossing the
// "building" threshold for the first time. Intentionally does NOT treat
// "another day of the same collection" as change on its own; "distinct
// new subtopic" is handled upstream by that subtopic simply clustering as
// its own separate micro candidate rather than reclassifying this one.
function hasMaterialChange({ historicalSourceTypes, todaySourceTypes, historicalMaxVelocity, todayVelocityPct, BUILDING_VELOCITY_PCT = 20 }) {
  const newSource = (todaySourceTypes || []).some((s) => !historicalSourceTypes.includes(s));
  const newlyAccelerating = (historicalMaxVelocity == null || historicalMaxVelocity <= BUILDING_VELOCITY_PCT)
    && todayVelocityPct != null && todayVelocityPct > BUILDING_VELOCITY_PCT;
  return newSource || newlyAccelerating;
}

module.exports = {
  normalizeKey, tokenOverlap, clusterCandidates, classifyCandidate, hasMaterialChange,
  CLUSTER_OVERLAP_THRESHOLD, OCCASION_KEYWORDS
};
