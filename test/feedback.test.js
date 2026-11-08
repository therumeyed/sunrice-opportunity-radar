const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  FEEDBACK_TYPES, WRITABLE_FEEDBACK_TYPES, validateFeedbackInput, requiresContentDetails, deriveExclusions, applyExclusions,
  summarizeUsefulFeedback, needsBrandPreferenceReview, BRAND_PREFERENCE_REVIEW_BATCH_SIZE, themeReviewFlags
} = require('../src/feedback');
const { REASON_CODES } = require('../src/eligibility');

// Stage 7 (IMPLEMENTATION_CHECKLIST.md): the UI collapses to Relevant/Not
// relevant; the API only ever accepts writing those two going forward.
// FEEDBACK_TYPES (the 3 older values plus these 2) still exists so
// historical rows keep displaying/filtering under their original meaning
// -- see test/reportBuilder.test.js for that read-side coverage.
describe('validateFeedbackInput', () => {
  test('rejects an unknown feedback type', () => {
    assert.equal(validateFeedbackInput('love_it', {}).valid, false);
  });

  test('rejects every pre-Stage-7 type as a new write -- the UI no longer offers them', () => {
    for (const type of ['useful', 'already_covered', 'dont_show_again']) {
      assert.equal(validateFeedbackInput(type, {}).valid, false, type);
    }
  });

  test('accepts "relevant" with no extra payload -- a pure positive signal, no reason required', () => {
    assert.equal(validateFeedbackInput('relevant', {}).valid, true);
  });

  test('rejects "not_relevant" with no reasonCode', () => {
    assert.equal(validateFeedbackInput('not_relevant', {}).valid, false);
  });

  test('rejects "not_relevant" with a reasonCode outside the shared eligibility taxonomy', () => {
    assert.equal(validateFeedbackInput('not_relevant', { reasonCode: 'not_on_brand' }).valid, false);
  });

  test('accepts every real shared reason code on "not_relevant"', () => {
    for (const code of REASON_CODES) {
      assert.equal(validateFeedbackInput('not_relevant', { reasonCode: code }).valid, true, code);
    }
  });

  test('rejects an invalid content_status when the reason is already_covered', () => {
    const result = validateFeedbackInput('not_relevant', { reasonCode: 'already_covered', contentStatus: 'draft' });
    assert.equal(result.valid, false);
  });

  test('accepts a valid content_status when the reason is already_covered', () => {
    assert.equal(validateFeedbackInput('not_relevant', { reasonCode: 'already_covered', contentStatus: 'published' }).valid, true);
  });

  test('content_status is irrelevant, and never checked, for a reason other than already_covered', () => {
    assert.equal(validateFeedbackInput('not_relevant', { reasonCode: 'too_late', contentStatus: 'draft' }).valid, true);
  });
});

describe('WRITABLE_FEEDBACK_TYPES', () => {
  test('is exactly the 2-verdict UI, nothing more', () => {
    assert.deepEqual([...WRITABLE_FEEDBACK_TYPES].sort(), ['not_relevant', 'relevant']);
  });
});

describe('requiresContentDetails', () => {
  test('true for the legacy already_covered type', () => {
    assert.equal(requiresContentDetails('already_covered', null), true);
  });

  test('true for not_relevant with reasonCode already_covered', () => {
    assert.equal(requiresContentDetails('not_relevant', 'already_covered'), true);
  });

  test('false for not_relevant with any other reasonCode', () => {
    assert.equal(requiresContentDetails('not_relevant', 'too_late'), false);
  });

  test('false for relevant', () => {
    assert.equal(requiresContentDetails('relevant', null), false);
  });
});

describe('deriveExclusions', () => {
  test('a pre-Stage-7 not_relevant vote (no reason_code) keeps its original, broader meaning -- the whole microtrend cluster', () => {
    const { hiddenMicrotrendIds, suppressedFingerprints } = deriveExclusions([
      { feedback_type: 'not_relevant', microtrend_id: 42, action_fingerprint: 'fp-old-style', reason_code: null }
    ]);
    assert.ok(hiddenMicrotrendIds.has(42), 'never silently reinterpreted just because the column now exists');
    assert.equal(suppressedFingerprints.size, 0);
  });

  test('Stage 7: a reason-coded not_relevant vote only suppresses the exact recommendation (action_fingerprint), never the whole microtrend', () => {
    const { hiddenMicrotrendIds, suppressedFingerprints } = deriveExclusions([
      { feedback_type: 'not_relevant', microtrend_id: 42, action_fingerprint: 'fp-new-style', reason_code: 'too_late' }
    ]);
    assert.equal(hiddenMicrotrendIds.size, 0, 'a genuinely different angle on the same microtrend must stay eligible');
    assert.ok(suppressedFingerprints.has('fp-new-style'));
  });

  test('Stage 7: this holds for every reason code, including already_covered -- it affects repetition only, never the whole topic', () => {
    const { hiddenMicrotrendIds, suppressedFingerprints } = deriveExclusions([
      { feedback_type: 'not_relevant', microtrend_id: 1, action_fingerprint: 'fp-covered', reason_code: 'already_covered' }
    ]);
    assert.equal(hiddenMicrotrendIds.size, 0);
    assert.ok(suppressedFingerprints.has('fp-covered'));
  });

  test('a reason-coded not_relevant vote with no fingerprint (no LLM output existed) falls back to hiding the whole microtrend -- nothing finer to suppress', () => {
    const { hiddenMicrotrendIds, suppressedFingerprints } = deriveExclusions([
      { feedback_type: 'not_relevant', microtrend_id: 9, action_fingerprint: null, reason_code: 'product_mismatch' }
    ]);
    assert.ok(hiddenMicrotrendIds.has(9));
    assert.equal(suppressedFingerprints.size, 0);
  });

  test('relevant produces no exclusion at all, same as useful', () => {
    const result = deriveExclusions([{ feedback_type: 'relevant', microtrend_id: 1, action_fingerprint: 'fp-a', reason_code: null }]);
    assert.equal(result.hiddenMicrotrendIds.size, 0);
    assert.equal(result.suppressedFingerprints.size, 0);
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

describe('themeReviewFlags', () => {
  const row = (overrides) => ({
    theme: 'curry_night', reasonCode: 'product_mismatch', actionFingerprint: 'fp-1',
    recommendationId: 1, createdAt: new Date(), ...overrides
  });

  test('flags a theme+reason once 3 DISTINCT decisions are reached, never before', () => {
    const rows = [row({ actionFingerprint: 'fp-1' }), row({ actionFingerprint: 'fp-2' })];
    assert.deepEqual(themeReviewFlags(rows), []);
    rows.push(row({ actionFingerprint: 'fp-3' }));
    const flags = themeReviewFlags(rows);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].theme, 'curry_night');
    assert.equal(flags[0].reasonCode, 'product_mismatch');
    assert.equal(flags[0].distinctCount, 3);
  });

  test('counts distinct recommendation decisions, not repeated clicks on the same one', () => {
    const rows = [row({ actionFingerprint: 'fp-1' }), row({ actionFingerprint: 'fp-1' }), row({ actionFingerprint: 'fp-1' })];
    assert.deepEqual(themeReviewFlags(rows), [], 'one real decision clicked 3 times is still just one decision');
  });

  test('different reasons on the same theme never combine toward the same tally', () => {
    const rows = [
      row({ actionFingerprint: 'fp-1', reasonCode: 'product_mismatch' }),
      row({ actionFingerprint: 'fp-2', reasonCode: 'too_late' }),
      row({ actionFingerprint: 'fp-3', reasonCode: 'audience_mismatch' })
    ];
    assert.deepEqual(themeReviewFlags(rows), []);
  });

  test('different themes with the same reason never combine toward the same tally', () => {
    const rows = [
      row({ actionFingerprint: 'fp-1', theme: 'curry_night' }),
      row({ actionFingerprint: 'fp-2', theme: 'sushi_asian' }),
      row({ actionFingerprint: 'fp-3', theme: 'healthy_eating' })
    ];
    assert.deepEqual(themeReviewFlags(rows), []);
  });

  test('a decision older than the 60-day window never counts', () => {
    const old = new Date(Date.now() - 61 * 86400000);
    const rows = [row({ actionFingerprint: 'fp-1', createdAt: old }), row({ actionFingerprint: 'fp-2' }), row({ actionFingerprint: 'fp-3' })];
    assert.deepEqual(themeReviewFlags(rows), []);
  });

  test('a row with no reason_code (pre-Stage-7) is skipped -- nothing to group it by', () => {
    const rows = [row({ actionFingerprint: 'fp-1', reasonCode: null }), row({ actionFingerprint: 'fp-2' }), row({ actionFingerprint: 'fp-3' })];
    assert.deepEqual(themeReviewFlags(rows), [], 'only 2 real reason-coded decisions exist here');
  });

  test('falls back to the recommendation id when no fingerprint exists, rather than silently dropping the decision', () => {
    const rows = [
      row({ actionFingerprint: null, recommendationId: 101 }),
      row({ actionFingerprint: null, recommendationId: 102 }),
      row({ actionFingerprint: null, recommendationId: 103 })
    ];
    assert.equal(themeReviewFlags(rows).length, 1);
  });

  test('a row with neither a fingerprint nor a recommendation id is skipped -- nothing stable to de-duplicate on', () => {
    const rows = [
      row({ actionFingerprint: null, recommendationId: null }),
      row({ actionFingerprint: 'fp-2' }),
      row({ actionFingerprint: 'fp-3' })
    ];
    assert.deepEqual(themeReviewFlags(rows), []);
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
