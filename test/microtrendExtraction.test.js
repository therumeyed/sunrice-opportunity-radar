const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { extractCandidates, socialCandidatesFor, aggregateObservations, evidenceLinksFor } = require('../src/microtrendExtraction');

function searchItem(id, rising = [], top = []) {
  return { id, normalized_metrics: { relatedQueries: { rising, top } } };
}

function pinterestItem(id, title, trendType, rank) {
  return { id, title, raw_metrics: { trendType, rank } };
}

function socialPost(id, excerpt, author) {
  return { id, excerpt, author };
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

  test('extractCandidates has no newsItems/socialItems parameter -- social posts go through socialCandidatesFor instead, news stays corroboration only', () => {
    const candidates = extractCandidates({ theme: 'rice_basics' });
    assert.deepEqual(candidates, []);
  });
});

describe('socialCandidatesFor', () => {
  test('one real matched post becomes one seed candidate, traceable to its own evidence', () => {
    const candidates = socialCandidatesFor('weeknight_dinners', { reddit: [socialPost(201, 'kimchi fried rice is my go-to lazy dinner', 'u/alice')] });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].members[0].sourceItemId, 201);
    assert.equal(candidates[0].members[0].sourceType, 'apify_reddit');
    assert.equal(candidates[0].members[0].author, 'u/alice');
  });

  test('every real social platform is covered', () => {
    const candidates = socialCandidatesFor('weeknight_dinners', {
      reddit: [socialPost(1, 'reddit post', 'a')],
      tiktok: [socialPost(2, 'tiktok caption', 'b')],
      instagram: [socialPost(3, 'instagram caption', 'c')]
    });
    const sourceTypes = candidates.map((c) => c.members[0].sourceType).sort();
    assert.deepEqual(sourceTypes, ['apify_instagram', 'apify_reddit', 'apify_tiktok']);
  });

  test('posts are never deterministically clustered -- each stays its own candidate for Claude to group semantically', () => {
    const candidates = socialCandidatesFor('weeknight_dinners', {
      reddit: [socialPost(1, 'kimchi fried rice bowl', 'a'), socialPost(2, 'kimchi fried rice bowl', 'b')]
    });
    assert.equal(candidates.length, 2, 'identical wording from two different posts must stay two separate candidates, not merge deterministically');
  });

  test('a post with no real text content is never sent as if it said something', () => {
    const candidates = socialCandidatesFor('weeknight_dinners', { reddit: [socialPost(1, '', null), socialPost(2, null, null)] });
    assert.deepEqual(candidates, []);
  });

  test('Pinterest is never treated as a social post source here', () => {
    const candidates = socialCandidatesFor('rice_basics', { pinterest: [socialPost(1, 'rice bowl trend', null)] });
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

  test('counts distinct real authors for a group of social posts', () => {
    const members = [
      { sourceType: 'apify_reddit', metricType: null, metricValue: null, sourceItemId: 1, author: 'alice' },
      { sourceType: 'apify_reddit', metricType: null, metricValue: null, sourceItemId: 2, author: 'bob' },
      { sourceType: 'apify_reddit', metricType: null, metricValue: null, sourceItemId: 3, author: 'alice' }
    ];
    const obs = aggregateObservations(members);
    assert.equal(obs[0].uniqueCreatorCount, 2, 'alice appearing twice must count once');
  });

  test('uniqueCreatorCount is null (not 0) for a source with no creator concept at all', () => {
    const members = [{ sourceType: 'dataforseo_trends', metricType: 'rising_value', metricValue: 60, sourceItemId: 1, sourceNativeClassification: 'rising' }];
    const obs = aggregateObservations(members);
    assert.equal(obs[0].uniqueCreatorCount, null, 'a search query has no creators to count -- null, never a fabricated 0');
  });

  test('a missing/null author on a real social post is never counted as a distinct creator', () => {
    const members = [
      { sourceType: 'apify_tiktok', metricType: null, metricValue: null, sourceItemId: 1, author: null },
      { sourceType: 'apify_tiktok', metricType: null, metricValue: null, sourceItemId: 2, author: null }
    ];
    const obs = aggregateObservations(members);
    assert.equal(obs[0].uniqueCreatorCount, 0, 'two posts with no known author is a real 0 creators, not 2');
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
