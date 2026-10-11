const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  FEEDBACK_TYPES, validateFeedbackInput, deriveExclusions, applyExclusions,
  summarizeUsefulFeedback, needsBrandPreferenceReview, BRAND_PREFERENCE_REVIEW_BATCH_SIZE
} = require('../src/feedback');

describe('validateFeedbackInput', () => {
  test('rejects an unknown feedback type', () => {
    assert.equal(validateFeedbackInput('love_it', {}).valid, false);
  });

  test('accepts every real feedback type with no extra payload', () => {
    for (const type of FEEDBACK_TYPES) {
      assert.equal(validateFeedbackInput(type, {}).valid, true, type);
    }
  });

  test('rejects an invalid content_status on already_covered', () => {
    const result = validateFeedbackInput('already_covered', { contentStatus: 'draft' });
    assert.equal(result.valid, false);
  });

  test('accepts a valid content_status on already_covered', () => {
    assert.equal(validateFeedbackInput('already_covered', { contentStatus: 'published' }).valid, true);
  });

  test('rejects a reason not on that type\'s fixed list', () => {
    const result = validateFeedbackInput('not_relevant', { reason: 'Published on blog' }); // that's an already_covered reason
    assert.equal(result.valid, false);
  });

  test('accepts a reason from that type\'s own list', () => {
    assert.equal(validateFeedbackInput('not_relevant', { reason: 'Not on-brand' }).valid, true);
  });

  test('"Other" reason requires a note', () => {
    assert.equal(validateFeedbackInput('dont_show_again', { reason: 'Other' }).valid, false);
    assert.equal(validateFeedbackInput('dont_show_again', { reason: 'Other', note: 'Seasonal clash with a current campaign' }).valid, true);
  });
});

describe('deriveExclusions', () => {
  test('not_relevant hides the whole microtrend cluster', () => {
    const { hiddenMicrotrendIds, suppressedFingerprints } = deriveExclusions([
      { feedback_type: 'not_relevant', microtrend_id: 42, action_fingerprint: null }
    ]);
    assert.ok(hiddenMicrotrendIds.has(42));
    assert.equal(suppressedFingerprints.size, 0);
  });

  test('already_covered and dont_show_again both suppress by action_fingerprint, not by microtrend', () => {
    const { hiddenMicrotrendIds, suppressedFingerprints } = deriveExclusions([
      { feedback_type: 'already_covered', microtrend_id: 1, action_fingerprint: 'fp-a' },
      { feedback_type: 'dont_show_again', microtrend_id: 2, action_fingerprint: 'fp-b' }
    ]);
    assert.equal(hiddenMicrotrendIds.size, 0);
    assert.ok(suppressedFingerprints.has('fp-a'));
    assert.ok(suppressedFingerprints.has('fp-b'));
  });

  test('useful feedback produces no exclusion at all', () => {
    const result = deriveExclusions([{ feedback_type: 'useful', microtrend_id: 1, action_fingerprint: 'fp-a' }]);
    assert.equal(result.hiddenMicrotrendIds.size, 0);
    assert.equal(result.suppressedFingerprints.size, 0);
  });

  test('already_covered/dont_show_again with no action_fingerprint (no LLM output existed) falls back to hiding the whole microtrend', () => {
    const { hiddenMicrotrendIds, suppressedFingerprints } = deriveExclusions([
      { feedback_type: 'dont_show_again', microtrend_id: 7, action_fingerprint: null },
      { feedback_type: 'already_covered', microtrend_id: 8, action_fingerprint: null }
    ]);
    assert.ok(hiddenMicrotrendIds.has(7));
    assert.ok(hiddenMicrotrendIds.has(8));
    assert.equal(suppressedFingerprints.size, 0, 'there is no real fingerprint to record');
  });
});

describe('applyExclusions', () => {
  test('a different angle on the same hidden-fingerprint microtrend is not blocked', () => {
    const exclusions = { hiddenMicrotrendIds: new Set(), suppressedFingerprints: new Set(['fp-old']) };
    const candidates = [
      { microtrendId: 1, actionFingerprint: 'fp-old' },
      { microtrendId: 1, actionFingerprint: 'fp-new' }
    ];
    const result = applyExclusions(candidates, exclusions);
    assert.equal(result.length, 1);
    assert.equal(result[0].actionFingerprint, 'fp-new');
  });

  test('not_relevant blocks every angle on that microtrend, old and new alike', () => {
    const exclusions = { hiddenMicrotrendIds: new Set([1]), suppressedFingerprints: new Set() };
    const candidates = [{ microtrendId: 1, actionFingerprint: 'fp-new' }];
    assert.equal(applyExclusions(candidates, exclusions).length, 0);
  });

  test('a candidate with no fingerprint yet is never excluded by a stored non-null one', () => {
    const exclusions = { hiddenMicrotrendIds: new Set(), suppressedFingerprints: new Set(['fp-old']) };
    const candidates = [{ microtrendId: 1, actionFingerprint: null }];
    assert.equal(applyExclusions(candidates, exclusions).length, 1);
  });
});

describe('summarizeUsefulFeedback', () => {
  test('counts channels and themes, most common first, never inventing a preference not actually present', () => {
    const examples = [
      { suggested_channel: 'Recipe/blog content + SEO', theme: 'rice_basics' },
      { suggested_channel: 'Recipe/blog content + SEO', theme: 'sushi_asian' },
      { suggested_channel: 'Short-form video (TikTok/Instagram)', theme: 'rice_basics' }
    ];
    const summary = summarizeUsefulFeedback(examples);
    assert.equal(summary.sampleSize, 3);
    assert.equal(summary.topChannels[0].value, 'Recipe/blog content + SEO');
    assert.equal(summary.topChannels[0].count, 2);
  });

  test('empty input is an honest empty summary, not a fabricated trend', () => {
    const summary = summarizeUsefulFeedback([]);
    assert.equal(summary.sampleSize, 0);
    assert.deepEqual(summary.topChannels, []);
  });
});

describe('needsBrandPreferenceReview', () => {
  test('does not fire before the batch size is reached', () => {
    assert.equal(needsBrandPreferenceReview(BRAND_PREFERENCE_REVIEW_BATCH_SIZE - 1, 0), false);
  });

  test('fires once the batch size is reached', () => {
    assert.equal(needsBrandPreferenceReview(BRAND_PREFERENCE_REVIEW_BATCH_SIZE, 0), true);
  });

  test('fires again after another full batch past the last review, not just once ever', () => {
    assert.equal(needsBrandPreferenceReview(BRAND_PREFERENCE_REVIEW_BATCH_SIZE * 2, BRAND_PREFERENCE_REVIEW_BATCH_SIZE), true);
    assert.equal(needsBrandPreferenceReview(BRAND_PREFERENCE_REVIEW_BATCH_SIZE * 2 - 1, BRAND_PREFERENCE_REVIEW_BATCH_SIZE), false);
  });
});
