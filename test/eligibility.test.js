const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateEligibilityBlock, checkInsufficientEvidence, isDuplicateWithoutNewEvidence,
  buildResurfacingContext, canResurface
} = require('../src/eligibility');

describe('validateEligibilityBlock', () => {
  test('accepts a well-formed rejected verdict with a valid reason code and explanation', () => {
    const result = validateEligibilityBlock({ verdict: 'rejected', reasonCode: 'product_mismatch', explanation: 'No real SunRice product fits this.' });
    assert.equal(result.verdict, 'rejected');
    assert.equal(result.reasonCode, 'product_mismatch');
  });

  test('accepts eligible with no reason code required', () => {
    const result = validateEligibilityBlock({ verdict: 'eligible' });
    assert.equal(result.verdict, 'eligible');
    assert.equal(result.reasonCode, null);
  });

  test('missing eligibility block degrades to uncertain, never a fabricated eligible verdict', () => {
    assert.equal(validateEligibilityBlock(null).verdict, 'uncertain');
    assert.equal(validateEligibilityBlock(undefined).verdict, 'uncertain');
  });

  test('an unknown verdict string degrades to uncertain', () => {
    assert.equal(validateEligibilityBlock({ verdict: 'maybe' }).verdict, 'uncertain');
  });

  test('a rejected verdict missing a reason code degrades to uncertain rather than being silently accepted', () => {
    const result = validateEligibilityBlock({ verdict: 'rejected', explanation: 'some reason' });
    assert.equal(result.verdict, 'uncertain');
  });

  test('a rejected verdict missing an explanation degrades to uncertain', () => {
    const result = validateEligibilityBlock({ verdict: 'rejected', reasonCode: 'too_generic' });
    assert.equal(result.verdict, 'uncertain');
  });

  test('already_covered and insufficient_evidence are deterministic-only -- Claude citing them is rejected (not a code Claude is allowed to assert)', () => {
    assert.equal(validateEligibilityBlock({ verdict: 'rejected', reasonCode: 'already_covered', explanation: 'x' }).verdict, 'uncertain');
    assert.equal(validateEligibilityBlock({ verdict: 'rejected', reasonCode: 'insufficient_evidence', explanation: 'x' }).verdict, 'uncertain');
  });

  test('an invented reason code degrades to uncertain', () => {
    const result = validateEligibilityBlock({ verdict: 'rejected', reasonCode: 'not_a_real_code', explanation: 'x' });
    assert.equal(result.verdict, 'uncertain');
  });
});

describe('checkInsufficientEvidence', () => {
  test('all-cached evidence is insufficient', () => {
    assert.equal(checkInsufficientEvidence([{ dataStatus: 'cached' }, { dataStatus: 'cached' }]), true);
  });
  test('a single live item among cached ones is sufficient', () => {
    assert.equal(checkInsufficientEvidence([{ dataStatus: 'cached' }, { dataStatus: 'live' }]), false);
  });
  test('no members at all is insufficient', () => {
    assert.equal(checkInsufficientEvidence([]), true);
  });
  test('all members missing dataStatus entirely is insufficient (never assumed live)', () => {
    assert.equal(checkInsufficientEvidence([{}, {}]), true);
  });
});

describe('isDuplicateWithoutNewEvidence', () => {
  test('every cited id already cited before -> duplicate', () => {
    assert.equal(isDuplicateWithoutNewEvidence([101, 102], [101, 102, 103]), true);
  });
  test('at least one genuinely new id -> not a duplicate', () => {
    assert.equal(isDuplicateWithoutNewEvidence([101, 999], [101, 102]), false);
  });
  test('empty today evidence is treated as a duplicate (nothing new to justify it)', () => {
    assert.equal(isDuplicateWithoutNewEvidence([], [101]), true);
  });
});

describe('buildResurfacingContext + canResurface', () => {
  const priorSnapshot = {
    classification: 'macro',
    isDistinctFromEvergreen: false,
    productConnection: ['SunRice Jasmine Fragrant Rice'],
    evidenceIds: [1, 2],
    proposedAction: { recommendedAction: 'Write a blog post', creativeAngle: 'Generic cooking tips' }
  };

  test('a new source type ALONE (same evidence ids, same angle, same product) must never be enough to resurface any reason', () => {
    const today = { classification: 'macro', isDistinctFromEvergreen: false, productConnection: ['SunRice Jasmine Fragrant Rice'], proposedAction: priorSnapshot.proposedAction };
    const ctx = buildResurfacingContext(priorSnapshot, today, [1, 2]); // same evidence ids, just relabelled as coming from a "new source type" conceptually
    for (const reason of ['product_mismatch', 'audience_mismatch', 'too_generic', 'too_late', 'already_covered', 'insufficient_evidence']) {
      assert.equal(canResurface(reason, ctx), false, `${reason} must not resurface on source-type-alone`);
    }
  });

  test('product_mismatch resurfaces only with a genuinely new, different product connection', () => {
    const today = { classification: 'macro', isDistinctFromEvergreen: false, productConnection: ['SunRice Doongara Low GI White Rice'], proposedAction: priorSnapshot.proposedAction };
    const ctx = buildResurfacingContext(priorSnapshot, today, [1, 2]);
    assert.equal(canResurface('product_mismatch', ctx), true);
  });

  test('audience_mismatch resurfaces only with genuinely new evidence ids', () => {
    const today = { classification: 'macro', isDistinctFromEvergreen: false, productConnection: [], proposedAction: priorSnapshot.proposedAction };
    const ctxNoNewEvidence = buildResurfacingContext(priorSnapshot, today, [1, 2]);
    assert.equal(canResurface('audience_mismatch', ctxNoNewEvidence), false);
    const ctxNewEvidence = buildResurfacingContext(priorSnapshot, today, [1, 2, 999]);
    assert.equal(canResurface('audience_mismatch', ctxNewEvidence), true);
  });

  test('too_generic resurfaces when classification improved from macro to micro', () => {
    const today = { classification: 'micro', isDistinctFromEvergreen: false, productConnection: [], proposedAction: priorSnapshot.proposedAction };
    const ctx = buildResurfacingContext(priorSnapshot, today, [1, 2]);
    assert.equal(canResurface('too_generic', ctx), true);
  });

  test('already_covered resurfaces only with a meaningfully different execution', () => {
    const sameExecution = { classification: 'macro', isDistinctFromEvergreen: false, productConnection: ['SunRice Jasmine Fragrant Rice'], proposedAction: priorSnapshot.proposedAction };
    assert.equal(canResurface('already_covered', buildResurfacingContext(priorSnapshot, sameExecution, [1, 2])), false);
    const differentExecution = { classification: 'macro', isDistinctFromEvergreen: false, productConnection: ['SunRice Jasmine Fragrant Rice'], proposedAction: { recommendedAction: 'Film a completely different video', creativeAngle: 'A fresh angle entirely' } };
    assert.equal(canResurface('already_covered', buildResurfacingContext(priorSnapshot, differentExecution, [1, 2])), true);
  });

  test('an unknown reason code never resurfaces', () => {
    assert.equal(canResurface('not_a_real_reason', { hasNewEvidenceIds: true, hasNewProductConnection: true, hasDifferentExecution: true }), false);
  });
});
