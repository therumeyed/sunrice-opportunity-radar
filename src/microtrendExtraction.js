// Pulls real microtrend candidates out of today's already-collected evidence
// -- never invents a phrase, a number, or a relationship. Every candidate
// this module returns is backed by one or more real source_items rows
// (sourceItemId), which is exactly what lets microtrend_evidence be built
// straight from its output with no guesswork.
//
// Source rules (brief section 3):
//  - Google rising/top queries: each dataforseo_trends row IS the evidence
//    for every query string in its own relatedQueries.rising/top lists.
//  - Pinterest growing/top_monthly/seasonal terms: each matched row is one
//    term, and is its own evidence.
//  - News and real social posts (reddit/tiktok/instagram) are corroboration
//    for a theme's overall momentum, not a source of new candidate phrases
//    here -- there is no reliable, evidence-backed way to pull a specific
//    emerging phrase out of a post/article body without the LLM inventing
//    one, which the brief explicitly forbids.
const { normalizeKey, clusterCandidates, classifyCandidate } = require('./microtrends');

function rawCandidatesFromSearch(searchItems) {
  const raw = [];
  for (const item of searchItems) {
    const rising = item.normalized_metrics?.relatedQueries?.rising || [];
    const top = item.normalized_metrics?.relatedQueries?.top || [];
    for (const q of rising) {
      if (!q.query) continue;
      raw.push({
        rawText: q.query, normalizedKey: normalizeKey(q.query), sourceType: 'dataforseo_trends',
        matchType: 'rising_query', metricType: 'rising_value', metricValue: typeof q.value === 'number' ? q.value : null,
        sourceItemId: item.id, sourceNativeClassification: 'rising'
      });
    }
    for (const q of top) {
      if (!q.query) continue;
      raw.push({
        rawText: q.query, normalizedKey: normalizeKey(q.query), sourceType: 'dataforseo_trends',
        matchType: 'top_query', metricType: 'top_value', metricValue: typeof q.value === 'number' ? q.value : null,
        sourceItemId: item.id, sourceNativeClassification: 'top'
      });
    }
  }
  return raw;
}

function rawCandidatesFromPinterest(pinterestItems) {
  const raw = [];
  for (const item of pinterestItems) {
    const term = item.title;
    if (!term) continue;
    raw.push({
      rawText: term, normalizedKey: normalizeKey(term), sourceType: 'apify_pinterest',
      matchType: 'pinterest_trend', metricType: 'pinterest_rank',
      metricValue: typeof item.raw_metrics?.rank === 'number' ? item.raw_metrics.rank : null,
      sourceItemId: item.id, sourceNativeClassification: item.raw_metrics?.trendType || null
    });
  }
  return raw;
}

// Most-frequent raw wording in the cluster is the one shown/stored --
// ties broken by first-seen order (Array.sort is stable in Node).
function pickDisplayName(members) {
  const counts = new Map();
  for (const m of members) counts.set(m.rawText, (counts.get(m.rawText) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * @returns {Array<{theme, normalizedKey, displayName, sourceWording, candidateType, members}>}
 */
function extractCandidates({ theme, themeLabel, searchItems = [], pinterestItems = [], seedQueries = [], evergreenBaselines = [] }) {
  const seedQueryKeys = seedQueries.map(normalizeKey);
  const evergreenBaselineKeys = evergreenBaselines.map(normalizeKey);

  const raw = [...rawCandidatesFromSearch(searchItems), ...rawCandidatesFromPinterest(pinterestItems)]
    .filter((c) => c.normalizedKey); // an all-stopword/empty candidate carries no comparable identity
  if (raw.length === 0) return [];

  const clusters = clusterCandidates(raw);

  return clusters.map((cluster) => {
    const displayName = pickDisplayName(cluster.members);
    const candidateType = classifyCandidate({
      normalizedKey: cluster.normalizedKey, themeLabel, seedQueryKeys, evergreenBaselineKeys
    });
    return {
      theme, normalizedKey: cluster.normalizedKey, displayName, sourceWording: displayName,
      candidateType, members: cluster.members
    };
  });
}

// Collapses a cluster's members into one observation row per (sourceType,
// metricType) pair -- matches microtrend_observations' own unique
// constraint, so this is exactly the shape recordMicrotrendObservation
// needs, one call per entry. Max of the real values rather than sum/avg:
// the cluster already proves multiple hits, the strongest single verified
// reading is what's worth recording, not an inflated total.
function aggregateObservations(members) {
  const groups = new Map();
  for (const m of members) {
    const key = `${m.sourceType}:${m.metricType}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  return [...groups.entries()].map(([key, group]) => {
    const [sourceType, metricType] = key.split(':');
    const numericValues = group.map((g) => g.metricValue).filter((v) => typeof v === 'number');
    const classifications = [...new Set(group.map((g) => g.sourceNativeClassification).filter(Boolean))];
    return {
      sourceType,
      metricType,
      metricValue: numericValues.length > 0 ? Math.max(...numericValues) : null,
      evidenceCount: group.length,
      sourceNativeClassification: classifications.join(',') || null,
      sourceItemIds: [...new Set(group.map((g) => g.sourceItemId))]
    };
  });
}

// (sourceItemId, matchType) pairs to link as microtrend_evidence -- deduped,
// since the same source_items row can appear twice in `members` (e.g. a
// query that shows up in both a theme's rising and top lists).
function evidenceLinksFor(members) {
  const seen = new Set();
  const links = [];
  for (const m of members) {
    const key = `${m.sourceItemId}:${m.matchType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ sourceItemId: m.sourceItemId, matchType: m.matchType });
  }
  return links;
}

module.exports = { extractCandidates, aggregateObservations, evidenceLinksFor };
