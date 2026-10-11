// Pulls real microtrend candidates out of today's already-collected evidence
// -- never invents a phrase, a number, or a relationship. Every candidate
// this module returns is backed by one or more real source_items rows
// (sourceItemId), which is exactly what lets microtrend_evidence be built
// straight from its output with no guesswork.
//
// Source rules:
//  - Google rising/top queries: each dataforseo_trends row IS the evidence
//    for every query string in its own relatedQueries.rising/top lists.
//  - Pinterest growing/top_monthly/seasonal terms: each matched row is one
//    term, and is its own evidence.
//  - Real social posts (reddit/tiktok/instagram): each matched post is its
//    own seed candidate (extractSocialCandidates below) -- deliberately NOT
//    deterministically pre-clustered the way search/Pinterest candidates
//    are, because there's no reliable string-matching heuristic for free-
//    form post text. Claude (src/candidateAnalyst.js) identifies the
//    actual dish/behaviour/problem/ingredient-combo/audience/creative-
//    format each post or group of posts is about, citing real evidenceIds
//    -- this module only hands over the raw, real, unprocessed post as a
//    single-member candidate; it never extracts or guesses the phrase
//    itself. News stays corroboration only -- articles don't carry the
//    same first-person "here's what I'm actually doing" signal a post
//    does, and there's no real evidence a specific behaviour is described
//    in article text the way it can be quoted from a social caption.
const { normalizeKey, clusterCandidates } = require('./microtrends');

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

// Real social platforms whose evidence carries actual free-text post
// content worth sending for semantic extraction -- Pinterest's own
// trend-list terms are a different, already-classified kind of signal
// (handled by rawCandidatesFromPinterest above) and never go through this.
const SOCIAL_SOURCE_TYPES = ['apify_reddit', 'apify_tiktok', 'apify_instagram'];

function isSocialSourceType(sourceType) {
  return SOCIAL_SOURCE_TYPES.includes(sourceType);
}

// One real post = one seed candidate, un-clustered -- deduped already by
// upsertSourceItem's own (source_type, content_hash) constraint at ingest
// time, so the same post can't appear twice here. `author` is carried
// through on the member so reportBuilder.js can deterministically count
// distinct creators without asking Claude to do that math.
function socialCandidatesFor(theme, socialItemsByPlatform) {
  const candidates = [];
  for (const platform of SOCIAL_SOURCE_TYPES) {
    for (const item of socialItemsByPlatform[platform.replace('apify_', '')] || []) {
      const text = (item.excerpt || item.title || '').trim();
      if (!text) continue; // nothing to analyze -- never hand Claude an empty post as if it said something
      candidates.push({
        theme,
        normalizedKey: `social-${item.id}`, // not used for matching, just a stable internal identity
        displayName: text.slice(0, 280),
        sourceWording: text.slice(0, 280),
        clusterKey: `${theme}::social::${item.id}`,
        members: [{
          sourceItemId: item.id, sourceType: platform, matchType: 'social_post',
          metricType: null, metricValue: null, sourceNativeClassification: null, author: item.author || null
        }]
      });
    }
  }
  return candidates;
}

// Most-frequent raw wording in the cluster is the one shown/stored --
// ties broken by first-seen order (Array.sort is stable in Node).
function pickDisplayName(members) {
  const counts = new Map();
  for (const m of members) counts.set(m.rawText, (counts.get(m.rawText) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// Classification (macro/micro/seasonal), brand relevance, product fit and
// everything else about what a candidate MEANS is Claude's call
// (src/candidateAnalyst.js), not this module's -- this is deliberately
// pure string extraction and FIRST-PASS clustering only (exact
// normalized-key match, or near-duplicate token overlap). Claude is then
// allowed to additionally unify differently-worded candidates this first
// pass didn't catch (see candidateAnalyst's clusterKeys merging), with
// that judgment call stored and audited on the microtrends row -- this
// module has no opinion on that, it just hands over every real clusterKey.
/**
 * @returns {Array<{theme, normalizedKey, displayName, sourceWording, clusterKey, members}>}
 */
function extractCandidates({ theme, searchItems = [], pinterestItems = [] }) {
  const raw = [...rawCandidatesFromSearch(searchItems), ...rawCandidatesFromPinterest(pinterestItems)]
    .filter((c) => c.normalizedKey); // an all-stopword/empty candidate carries no comparable identity
  if (raw.length === 0) return [];

  const clusters = clusterCandidates(raw);

  return clusters.map((cluster) => {
    const displayName = pickDisplayName(cluster.members);
    return {
      theme, normalizedKey: cluster.normalizedKey, displayName, sourceWording: displayName,
      clusterKey: `${theme}::${cluster.normalizedKey}`, members: cluster.members
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
    // null (not 0) when this group has no creator concept at all (search/
    // Pinterest members never carry an `author` property) -- a real 0
    // would wrongly imply "zero creators were found" for a metric where
    // creators were never a meaningful thing to look for in the first
    // place. Only real, non-null authors count as distinct creators.
    const hasCreatorConcept = group.some((g) => g.author !== undefined);
    const uniqueCreatorCount = hasCreatorConcept ? new Set(group.map((g) => g.author).filter(Boolean)).size : null;
    return {
      sourceType,
      metricType,
      metricValue: numericValues.length > 0 ? Math.max(...numericValues) : null,
      evidenceCount: group.length,
      uniqueCreatorCount,
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

module.exports = { extractCandidates, socialCandidatesFor, isSocialSourceType, SOCIAL_SOURCE_TYPES, aggregateObservations, evidenceLinksFor };
