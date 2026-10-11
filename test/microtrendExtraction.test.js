const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { extractCandidates, aggregateObservations, evidenceLinksFor } = require('../src/microtrendExtraction');

function searchItem(id, rising = [], top = []) {
  return { id, normalized_metrics: { relatedQueries: { rising, top } } };
}

function pinterestItem(id, title, trendType, rank) {
  return { id, title, raw_metrics: { trendType, rank } };
}

describe('extractCandidates', () => {
  test('returns nothing when there is no real evidence', () => {
    assert.deepEqual(extractCandidates({ theme: 'rice_basics' }), []);
  });

  test('every candidate is traceable to a real source_items id, never invented', () => {
    const items = [searchItem(101, [{ query: 'air fryer rice paper rolls', value: 80 }])];
    const candidates = extractCandidates({ theme: 'rice_basics', searchItems: items });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].members[0].sourceItemId, 101);
  });

  // Classification (macro/micro/seasonal) is Claude's call now
  // (src/candidateAnalyst.js), not this module's -- extraction only
  // extracts and clusters, it never decides what a candidate means.
  test('every candidate carries a stable clusterKey for candidateAnalyst to reference', () => {
    const items = [searchItem(1, [{ query: 'air fryer rice paper rolls', value: 80 }])];
    const candidates = extractCandidates({ theme: 'rice_basics', searchItems: items });
    assert.equal(candidates[0].clusterKey, `rice_basics::${candidates[0].normalizedKey}`);
  });

  test('Pinterest growing terms become candidates with the matched row as their evidence', () => {
    const items = [pinterestItem(55, 'air fryer rice bowls', 'growing', 3)];
    const candidates = extractCandidates({ theme: 'rice_basics', pinterestItems: items });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].members[0].sourceItemId, 55);
    assert.equal(candidates[0].members[0].sourceType, 'apify_pinterest');
  });

  test('the same underlying phrase from Google and Pinterest clusters into one candidate with both as evidence', () => {
    const searchItems = [searchItem(1, [{ query: 'air fryer rice paper rolls', value: 70 }])];
    const pinterestItems = [pinterestItem(2, 'air fryer rice paper roll', 'growing', 5)];
    const candidates = extractCandidates({ theme: 'rice_basics', searchItems, pinterestItems });
    assert.equal(candidates.length, 1);
    const sourceTypes = candidates[0].members.map((m) => m.sourceType);
    assert.ok(sourceTypes.includes('dataforseo_trends'));
    assert.ok(sourceTypes.includes('apify_pinterest'));
  });

  test('distinct unrelated candidates are never collapsed into one', () => {
    const items = [searchItem(1, [{ query: 'air fryer rice paper rolls', value: 70 }, { query: 'jasmine rice storage tips', value: 40 }])];
    const candidates = extractCandidates({ theme: 'rice_basics', searchItems: items });
    assert.equal(candidates.length, 2);
  });

  test('news and real social items are never treated as a candidate source', () => {
    // extractCandidates has no newsItems/socialItems parameter at all --
    // passing theme-matched evidence that isn't search or Pinterest should
    // simply produce no candidates, confirming corroboration-only sources
    // can't smuggle an invented phrase in.
    const candidates = extractCandidates({ theme: 'rice_basics' });
    assert.deepEqual(candidates, []);
  });
});

describe('aggregateObservations', () => {
  test('collapses multiple hits of the same source+metric into one observation using the strongest real value', () => {
    const members = [
      { sourceType: 'dataforseo_trends', metricType: 'rising_value', metricValue: 60, sourceItemId: 1, sourceNativeClassification: 'rising' },
      { sourceType: 'dataforseo_trends', metricType: 'rising_value', metricValue: 90, sourceItemId: 2, sourceNativeClassification: 'rising' }
    ];
    const obs = aggregateObservations(members);
    assert.equal(obs.length, 1);
    assert.equal(obs[0].metricValue, 90);
    assert.equal(obs[0].evidenceCount, 2);
  });

  test('different source types produce separate observations', () => {
    const members = [
      { sourceType: 'dataforseo_trends', metricType: 'rising_value', metricValue: 60, sourceItemId: 1, sourceNativeClassification: 'rising' },
      { sourceType: 'apify_pinterest', metricType: 'pinterest_rank', metricValue: 3, sourceItemId: 2, sourceNativeClassification: 'growing' }
    ];
    const obs = aggregateObservations(members);
    assert.equal(obs.length, 2);
  });

  test('a null metric value never gets fabricated into a number', () => {
    const members = [
      { sourceType: 'apify_pinterest', metricType: 'pinterest_rank', metricValue: null, sourceItemId: 1, sourceNativeClassification: 'growing' }
    ];
    const obs = aggregateObservations(members);
    assert.equal(obs[0].metricValue, null);
  });
});

describe('evidenceLinksFor', () => {
  test('dedupes the same source item + match type appearing twice', () => {
    const members = [
      { sourceItemId: 1, matchType: 'rising_query' },
      { sourceItemId: 1, matchType: 'rising_query' }
    ];
    assert.equal(evidenceLinksFor(members).length, 1);
  });

  test('keeps the same source item under two distinct match types as two links', () => {
    const members = [
      { sourceItemId: 1, matchType: 'rising_query' },
      { sourceItemId: 1, matchType: 'top_query' }
    ];
    assert.equal(evidenceLinksFor(members).length, 2);
  });
});
