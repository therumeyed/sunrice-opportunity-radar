const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { WEIGHTS, scoreOpportunity, confidenceFor, actionTypeFor, freshnessScore, velocityScore, agreementScore } = require('../src/scoring');

describe('scoring weights', () => {
  test('weights sum to 1 (100% of the score)', () => {
    const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `weights summed to ${total}`);
  });
});

describe('freshnessScore', () => {
  test('today is a perfect score', () => {
    assert.equal(freshnessScore(0), 1);
  });
  test('decays linearly to 0 by day 7', () => {
    assert.equal(freshnessScore(7), 0);
    assert.ok(Math.abs(freshnessScore(3.5) - 0.5) < 1e-9);
  });
  test('never goes negative past 7 days', () => {
    assert.equal(freshnessScore(30), 0);
  });
  test('unknown age is neutral, not zero', () => {
    assert.equal(freshnessScore(null), 0.5);
  });
});

describe('velocityScore', () => {
  test('caps at 200% change', () => {
    assert.equal(velocityScore(200), 1);
    assert.equal(velocityScore(1000), 1);
  });
  test('no measured change is low but not zero', () => {
    assert.equal(velocityScore(null), 0.3);
  });
});

describe('agreementScore', () => {
  test('more corroborating sources scores higher', () => {
    assert.equal(agreementScore(0), 0);
    assert.ok(agreementScore(1) < agreementScore(2));
    assert.ok(agreementScore(2) < agreementScore(3));
    assert.equal(agreementScore(5), agreementScore(3)); // caps at "3+"
  });
});

describe('scoreOpportunity', () => {
  test('a strong signal across every dimension scores near 100', () => {
    const { score } = scoreOpportunity({ daysOld: 0, velocityPct: 200, distinctSourceCount: 3, relevance: 1, seasonalFit: 1 });
    assert.ok(score > 95, `expected near-100, got ${score}`);
  });
  test('a weak signal scores low', () => {
    const { score } = scoreOpportunity({ daysOld: 30, velocityPct: -50, distinctSourceCount: 0, relevance: 0, seasonalFit: 0 });
    assert.ok(score < 15, `expected near-0, got ${score}`);
  });
  test('returns the individual components alongside the total', () => {
    const { components } = scoreOpportunity({ daysOld: 0, velocityPct: 100, distinctSourceCount: 2, relevance: 1, seasonalFit: 0.5 });
    assert.ok('freshness' in components && 'velocity' in components && 'agreement' in components);
  });
});

describe('confidenceFor', () => {
  test('forced early_signal overrides a high score (e.g. multicultural discovery)', () => {
    assert.equal(confidenceFor(95, 3, true), 'early_signal');
  });
  test('high score with corroboration is high confidence', () => {
    assert.equal(confidenceFor(75, 2, false), 'high');
  });
  test('high score with only one source is not "high" -- needs corroboration', () => {
    assert.equal(confidenceFor(75, 1, false), 'medium');
  });
  test('low score is early_signal', () => {
    assert.equal(confidenceFor(20, 1, false), 'early_signal');
  });
});

describe('actionTypeFor', () => {
  test('forced early_signal always investigates, never creates', () => {
    assert.equal(actionTypeFor(95, true), 'Investigate');
  });
  test('high score creates, mid investigates, low watches', () => {
    assert.equal(actionTypeFor(80, false), 'Create');
    assert.equal(actionTypeFor(50, false), 'Investigate');
    assert.equal(actionTypeFor(20, false), 'Watch');
  });
});
