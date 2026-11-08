const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { isGenuineMatch, searchReddit } = require('../src/providers/apifySocial');

describe('apifySocial isGenuineMatch', () => {
  test('a real curry-night post matches "curry"', () => {
    assert.equal(isGenuineMatch('Easy butter chicken curry recipe for weeknight dinner', 'curry'), true);
  });
  test('an NBA Steph Curry post does not match "curry"', () => {
    assert.equal(isGenuineMatch('Steph Curry drops 40 points for the Warriors tonight', 'curry'), false);
  });
  test('an unrelated post does not match at all', () => {
    assert.equal(isGenuineMatch('Best sourdough starter tips', 'curry'), false);
  });
});

// Real output shapes, copied from tri_angle/reddit-scraper's own published
// docs -- not guessed. Mocks global.fetch the same way test/apifyClient.test.js
// does; there's no live Apify account to hit from this environment.
describe('apifySocial searchReddit (tri_angle/reddit-scraper)', () => {
  const realFetch = global.fetch;
  const realEnv = { ...process.env };
  afterEach(() => {
    global.fetch = realFetch;
    process.env = { ...realEnv };
  });

  function mockApify(items) {
    process.env.APIFY_TOKEN = 'fixture-token';
    process.env.FEATURE_APIFY_REDDIT = 'true';
    global.fetch = async (url) => {
      if (url.includes('/runs?token=')) return { ok: true, json: async () => ({ data: { id: 'run1' } }) };
      if (url.includes('/actor-runs/run1?token=')) {
        return { ok: true, json: async () => ({ data: { id: 'run1', status: 'SUCCEEDED', defaultDatasetId: 'ds1' } }) };
      }
      if (url.includes('/datasets/ds1/items')) return { ok: true, json: async () => items };
      throw new Error(`unexpected fetch: ${url}`);
    };
  }

  test('a real post matching a topic query is kept, with a reconstructed redd.it URL', async () => {
    mockApify([
      { id: '1v8nkjz', title: 'Easy curry fried rice bowl', authorName: 'Arch_Lancer17', communityName: 'MealPrepSunday', score: 4127, commentCount: 98, createdAt: new Date().toISOString(), flairText: 'Recipe', isNsfw: false }
    ]);
    const result = await searchReddit(['curry'], new Date(Date.now() - 7 * 86400000));
    assert.equal(result.status, 'live');
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].url, 'https://redd.it/1v8nkjz');
    assert.equal(result.items[0].author, 'Arch_Lancer17');
    assert.deepEqual(result.items[0].rawMetrics, { upvotes: 4127, numComments: 98 });
  });

  test('a reasonCode sentinel record (empty/not-found/etc) is dropped, never matched', async () => {
    mockApify([
      { url: 'https://www.reddit.com/r/thisdoesnotexist123', reasonCode: 'not-found', reasonDescription: 'Community does not exist' }
    ]);
    const result = await searchReddit(['curry'], new Date(Date.now() - 7 * 86400000));
    assert.equal(result.status, 'live');
    assert.equal(result.rawItemCount, 0, 'a reasonCode record must never count as a real raw item');
    assert.equal(result.items.length, 0);
  });

  test('a comment-shaped record (carries postId) is dropped even though scrapeMode is posts', async () => {
    mockApify([
      { id: 'p07c4tq', body: 'Totally agree, curry fried rice is great', authorName: 'TheJuiceBoxS', postId: '1v8nkjz', parentCommentId: null, depth: 0, score: 190, createdAt: new Date().toISOString() }
    ]);
    const result = await searchReddit(['curry'], new Date(Date.now() - 7 * 86400000));
    assert.equal(result.items.length, 0, 'a record carrying postId is a comment, never a post');
  });

  test('a deleted post\'s "[deleted]" body is never matched against as real text', async () => {
    mockApify([
      { id: 'abc123', title: 'Untitled', authorName: '[deleted]', communityName: 'budgetfood', score: 1, commentCount: 0, createdAt: new Date().toISOString(), body: '[deleted]' }
    ]);
    const result = await searchReddit(['deleted'], new Date(Date.now() - 7 * 86400000));
    assert.equal(result.items.length, 0, '"[deleted]" is a sentinel string, not real content to match against');
  });

  test('a post older than sinceDate is excluded', async () => {
    mockApify([
      { id: 'old1', title: 'Old curry post', authorName: 'someone', communityName: 'budgetfood', score: 10, commentCount: 1, createdAt: new Date(Date.now() - 30 * 86400000).toISOString() }
    ]);
    const result = await searchReddit(['curry'], new Date(Date.now() - 7 * 86400000));
    assert.equal(result.items.length, 0);
  });
});
