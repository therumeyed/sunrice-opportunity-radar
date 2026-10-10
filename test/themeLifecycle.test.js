const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { themeLifecycleFor, peakingEligible } = require('../src/themeLifecycle');

function snapshot(score, velocityPct) {
  return { score, velocity_pct: velocityPct };
}

describe('themeLifecycleFor', () => {
  test('first-ever observation is new', () => {
    assert.equal(themeLifecycleFor([], 50, null), 'new');
  });

  test('fewer than 7 observations is validating, never a mature claim', () => {
    const prior = Array.from({ length: 5 }, () => snapshot(50, 30)); // strong momentum, but too little history
    assert.equal(themeLifecycleFor(prior, 55, 30), 'validating');
  });

  test('exactly 7 observations with positive momentum is building', () => {
    const prior = Array.from({ length: 6 }, () => snapshot(40, 10));
    assert.equal(themeLifecycleFor(prior, 50, 25), 'building');
  });

  test('exactly 7 observations with negative momentum is cooling', () => {
    const prior = Array.from({ length: 6 }, () => snapshot(60, -10));
    assert.equal(themeLifecycleFor(prior, 50, -25), 'cooling');
  });

  test('enough history, flat momentum, is sustained', () => {
    const prior = Array.from({ length: 10 }, () => snapshot(50, 5));
    assert.equal(themeLifecycleFor(prior, 50, 5), 'sustained');
  });

  test('fewer than 14 observations can never produce peaking, even with a matching pattern', () => {
    // 13 observations: recent building, then flattening, near its high --
    // the exact shape that WOULD be peaking at 14+.
    const prior = [
      ...Array.from({ length: 9 }, () => snapshot(40, 5)),
      snapshot(70, 30), snapshot(75, 28), snapshot(78, 25)
    ]; // 12 prior + today = 13
    const result = themeLifecycleFor(prior, 80, 5);
    assert.notEqual(result, 'peaking');
  });

  test('peaking requires: 14+ observations, near recent high, prior building, now flattened', () => {
    const prior = [
      ...Array.from({ length: 9 }, () => snapshot(40, 5)),
      snapshot(70, 30), snapshot(75, 28), snapshot(78, 25), snapshot(79, 22)
    ]; // 13 prior + today = 14
    const result = themeLifecycleFor(prior, 79, 5); // flattened, still near the 79 high
    assert.equal(result, 'peaking');
  });

  test('14+ observations but momentum still clearly building is not peaking', () => {
    const prior = Array.from({ length: 13 }, (_, i) => snapshot(40 + i * 3, 25));
    assert.equal(themeLifecycleFor(prior, 79, 25), 'building');
  });

  test('14+ observations, far off its recent high, is not peaking even if momentum flattened', () => {
    const prior = Array.from({ length: 13 }, (_, i) => snapshot(40 + i * 3, 25));
    // today's score (45) is well below the recent high (~79) -- this is
    // cooling/sustained territory, not "remains close to its recent high".
    const result = themeLifecycleFor(prior, 45, 5);
    assert.notEqual(result, 'peaking');
  });
});

describe('peakingEligible', () => {
  test('false under 14 observations, true at and above', () => {
    assert.equal(peakingEligible(13), false);
    assert.equal(peakingEligible(14), true);
    assert.equal(peakingEligible(20), true);
  });
});
