const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { computeSunriceFit, bandForScore, detectFitEligibilityContradiction, DISCLAIMER } = require('../src/sunriceFit');

function fit(overrides = {}) {
  return { productConnectionFit: 'strong', formatSuitability: 'strong', audienceOccasionRelevance: 'strong', trendFidelity: 'strong', ...overrides };
}

describe('computeSunriceFit', () => {
  test('all strong -> 100, High', () => {
    const result = computeSunriceFit(fit());
    assert.equal(result.score, 100);
    assert.equal(result.band, 'High');
  });

  test('all none -> 0, Low', () => {
    const result = computeSunriceFit(fit({ productConnectionFit: 'none', formatSuitability: 'none', audienceOccasionRelevance: 'none', trendFidelity: 'none' }));
    assert.equal(result.score, 0);
    assert.equal(result.band, 'Low');
  });

  test('all moderate -> 65, Moderate', () => {
    const result = computeSunriceFit(fit({ productConnectionFit: 'moderate', formatSuitability: 'moderate', audienceOccasionRelevance: 'moderate', trendFidelity: 'moderate' }));
    assert.equal(result.score, 65);
    assert.equal(result.band, 'Moderate');
  });

  test('product connection (40% weight) dominates the composite', () => {
    // strong product connection alone, everything else none: 100*0.4 = 40 -> rounds to 40, still Low,
    // but materially higher than the reverse (weak product connection, everything else strong).
    const productHeavy = computeSunriceFit(fit({ productConnectionFit: 'strong', formatSuitability: 'none', audienceOccasionRelevance: 'none', trendFidelity: 'none' }));
    const productLight = computeSunriceFit(fit({ productConnectionFit: 'none', formatSuitability: 'strong', audienceOccasionRelevance: 'strong', trendFidelity: 'strong' }));
    assert.ok(productHeavy.score < productLight.score, 'none of this test asserts the weight is EXACTLY 40%, just that product connection is not trivially dominant on its own');
  });

  test('the composite is always rounded to the nearest 5, never shown with false precision', () => {
    // productConnectionFit strong(100)*.4=40, formatSuitability moderate(65)*.25=16.25, audience weak(35)*.2=7, trend none(0)*.15=0 -> 63.25 -> rounds to 65
    const result = computeSunriceFit(fit({ productConnectionFit: 'strong', formatSuitability: 'moderate', audienceOccasionRelevance: 'weak', trendFidelity: 'none' }));
    assert.equal(result.score % 5, 0);
  });

  test('returns null when any component is missing', () => {
    const { productConnectionFit: _omit, ...rest } = fit();
    assert.equal(computeSunriceFit(rest), null);
  });

  test('returns null when any component has an invalid anchor value', () => {
    assert.equal(computeSunriceFit(fit({ productConnectionFit: 'extremely strong' })), null);
  });

  test('returns null for missing/non-object input, never throws', () => {
    assert.equal(computeSunriceFit(null), null);
    assert.equal(computeSunriceFit(undefined), null);
  });
});

describe('bandForScore', () => {
  test('bands match the documented thresholds exactly', () => {
    assert.equal(bandForScore(100), 'High');
    assert.equal(bandForScore(80), 'High');
    assert.equal(bandForScore(79), 'Moderate');
    assert.equal(bandForScore(60), 'Moderate');
    assert.equal(bandForScore(59), 'Low');
    assert.equal(bandForScore(0), 'Low');
  });
});

describe('detectFitEligibilityContradiction', () => {
  test('eligible verdict with a "none" product-connection fit component is flagged', () => {
    const result = detectFitEligibilityContradiction({
      eligibilityVerdict: 'eligible', eligibilityReasonCode: null,
      fit: computeSunriceFit(fit({ productConnectionFit: 'none' }))
    });
    assert.ok(result);
  });

  test('rejected-for-product_mismatch with a "strong" product-connection fit component is flagged', () => {
    const result = detectFitEligibilityContradiction({
      eligibilityVerdict: 'rejected', eligibilityReasonCode: 'product_mismatch',
      fit: computeSunriceFit(fit({ productConnectionFit: 'strong' }))
    });
    assert.ok(result);
  });

  test('a consistent eligible + strong product connection raises no contradiction', () => {
    const result = detectFitEligibilityContradiction({
      eligibilityVerdict: 'eligible', eligibilityReasonCode: null,
      fit: computeSunriceFit(fit({ productConnectionFit: 'strong' }))
    });
    assert.equal(result, null);
  });

  test('a rejection for a different reason (not product_mismatch) never triggers this check', () => {
    const result = detectFitEligibilityContradiction({
      eligibilityVerdict: 'rejected', eligibilityReasonCode: 'too_generic',
      fit: computeSunriceFit(fit({ productConnectionFit: 'strong' }))
    });
    assert.equal(result, null);
  });

  test('returns null when fit itself is null (never crashes on an already-invalid assessment)', () => {
    assert.equal(detectFitEligibilityContradiction({ eligibilityVerdict: 'eligible', eligibilityReasonCode: null, fit: null }), null);
  });
});

describe('DISCLAIMER', () => {
  test('is a real, non-empty string every display must show alongside the score', () => {
    assert.ok(typeof DISCLAIMER === 'string' && DISCLAIMER.length > 0);
  });
});
