const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { detectPossibleReposts, REPOST_OVERLAP_THRESHOLD } = require('../src/repostDetection');

function member(id, sourceType, text) {
  return { sourceItemId: id, sourceType, text };
}

describe('detectPossibleReposts', () => {
  test('flags near-identical text across two different platforms', () => {
    const members = [
      member(1, 'apify_reddit', 'Air frying leftover rice into crispy bites, kids loved it'),
      member(2, 'apify_tiktok', 'Air frying leftover rice into crispy bites, kids loved it')
    ];
    const flags = detectPossibleReposts(members);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].sourceItemIdA, 1);
    assert.equal(flags[0].sourceItemIdB, 2);
    assert.ok(flags[0].similarity >= REPOST_OVERLAP_THRESHOLD);
  });

  test('never flags two posts on the SAME platform -- content_hash dedup already covers that case', () => {
    const members = [
      member(1, 'apify_reddit', 'Air frying leftover rice into crispy bites'),
      member(2, 'apify_reddit', 'Air frying leftover rice into crispy bites')
    ];
    assert.deepEqual(detectPossibleReposts(members), []);
  });

  test('does NOT flag two independent creators merely describing the same trend in similar words', () => {
    const members = [
      member(1, 'apify_reddit', 'Made a quick fried rice bowl for lunch today, turned out great'),
      member(2, 'apify_tiktok', 'Tried a fried rice bowl recipe for dinner, pretty good honestly')
    ];
    const flags = detectPossibleReposts(members);
    assert.deepEqual(flags, [], 'merely topically similar text must never be flagged as a possible repost');
  });

  test('never merges or conflates -- returns a flag only, never removes/alters either member', () => {
    const members = [
      member(5, 'apify_instagram', 'POV: you just discovered air fryer rice bites'),
      member(3, 'apify_tiktok', 'POV: you just discovered air fryer rice bites')
    ];
    const flags = detectPossibleReposts(members);
    assert.equal(flags.length, 1);
    // Smaller id first, deterministically -- never duplicated in reverse order.
    assert.equal(flags[0].sourceItemIdA, 3);
    assert.equal(flags[0].sourceItemIdB, 5);
  });

  test('a post with no real text is never compared', () => {
    const members = [
      member(1, 'apify_reddit', ''),
      member(2, 'apify_tiktok', 'Air frying leftover rice into crispy bites')
    ];
    assert.deepEqual(detectPossibleReposts(members), []);
  });
});
