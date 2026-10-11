const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeKey, tokenOverlap, clusterCandidates, classifyCandidate, hasMaterialChange
} = require('../src/microtrends');

describe('normalizeKey', () => {
  test('lowercases and strips punctuation', () => {
    assert.equal(normalizeKey('Sushi Rolls!'), 'sushi roll');
  });

  test('singularizes plurals consistently', () => {
    assert.equal(normalizeKey('sushi rolls'), normalizeKey('sushi roll'));
  });

  test('applies the synonym map (recipe ideas vs recipe idea)', () => {
    assert.equal(normalizeKey('recipe ideas'), normalizeKey('recipe idea'));
  });

  test('GI and glycemic index normalize to the same key', () => {
    assert.equal(normalizeKey('low GI rice'), normalizeKey('low glycemic index rice'));
  });

  test('empty/null input returns empty string, never throws', () => {
    assert.equal(normalizeKey(''), '');
    assert.equal(normalizeKey(null), '');
    assert.equal(normalizeKey(undefined), '');
  });
});

describe('tokenOverlap', () => {
  test('identical normalized text overlaps fully', () => {
    const key = normalizeKey('sushi rice recipe');
    assert.equal(tokenOverlap(key, key), 1);
  });

  test('stopwords are ignored so "how to cook rice" matches "cook rice"', () => {
    const a = normalizeKey('how to cook rice');
    const b = normalizeKey('cook rice');
    assert.equal(tokenOverlap(a, b), 1);
  });

  test('unrelated phrases have zero or low overlap', () => {
    const a = normalizeKey('sushi rice recipe');
    const b = normalizeKey('rice bran oil skincare');
    assert.ok(tokenOverlap(a, b) < 0.5);
  });

  test('two empty strings overlap as identical (both are "nothing")', () => {
    assert.equal(tokenOverlap('', ''), 1);
  });
});

describe('clusterCandidates', () => {
  test('merges exact normalized_key matches into one cluster', () => {
    const candidates = [
      { normalizedKey: normalizeKey('sushi rice recipe'), raw: 'sushi rice recipe' },
      { normalizedKey: normalizeKey('sushi rice recipes'), raw: 'sushi rice recipes' }
    ];
    const clusters = clusterCandidates(candidates);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].members.length, 2);
  });

  test('merges near-duplicates above the overlap threshold', () => {
    const candidates = [
      { normalizedKey: normalizeKey('how to make sushi rice'), raw: 'how to make sushi rice' },
      { normalizedKey: normalizeKey('how to make sushi rice at home'), raw: 'how to make sushi rice at home' }
    ];
    const clusters = clusterCandidates(candidates);
    assert.equal(clusters.length, 1);
  });

  test('does not over-merge genuinely unrelated candidates', () => {
    const candidates = [
      { normalizedKey: normalizeKey('sushi rice recipe'), raw: 'sushi rice recipe' },
      { normalizedKey: normalizeKey('rice bran oil skincare'), raw: 'rice bran oil skincare' },
      { normalizedKey: normalizeKey('jasmine rice storage tips'), raw: 'jasmine rice storage tips' }
    ];
    const clusters = clusterCandidates(candidates);
    assert.equal(clusters.length, 3);
  });

  test('empty candidate list returns empty clusters', () => {
    assert.deepEqual(clusterCandidates([]), []);
  });
});

describe('classifyCandidate', () => {
  test('identical to theme label is macro', () => {
    const themeLabel = 'Rice';
    const normalizedKey = normalizeKey(themeLabel);
    const result = classifyCandidate({ normalizedKey, themeLabel, seedQueryKeys: [] });
    assert.equal(result, 'macro');
  });

  test('matches a seed query key is macro', () => {
    const seedKey = normalizeKey('how to cook rice');
    const result = classifyCandidate({
      normalizedKey: seedKey, themeLabel: 'Rice', seedQueryKeys: [seedKey]
    });
    assert.equal(result, 'macro');
  });

  test('evergreen baseline phrase stays macro even as a full question, not a microtrend just because it is long', () => {
    const baselineKey = normalizeKey('how to cook sushi rice');
    const result = classifyCandidate({
      normalizedKey: baselineKey,
      themeLabel: 'Rice',
      seedQueryKeys: [],
      evergreenBaselineKeys: [baselineKey]
    });
    assert.equal(result, 'macro');
  });

  test('a genuinely specific, non-seed, non-baseline phrase is micro', () => {
    const result = classifyCandidate({
      normalizedKey: normalizeKey('air fryer rice paper rolls'),
      themeLabel: 'Rice',
      seedQueryKeys: [normalizeKey('how to cook rice')],
      evergreenBaselineKeys: [normalizeKey('how to cook sushi rice')]
    });
    assert.equal(result, 'micro');
  });

  test('a known dated occasion is seasonal regardless of theme', () => {
    const result = classifyCandidate({
      normalizedKey: normalizeKey('christmas rice pudding'),
      themeLabel: 'Rice',
      seedQueryKeys: []
    });
    assert.equal(result, 'seasonal');
  });

  test('seasonal classification takes priority even if phrase also matches theme label tokens', () => {
    const result = classifyCandidate({
      normalizedKey: normalizeKey('lunar new year rice dishes'),
      themeLabel: 'rice dishes',
      seedQueryKeys: []
    });
    assert.equal(result, 'seasonal');
  });
});

describe('hasMaterialChange', () => {
  test('a source type never seen before counts as material change', () => {
    const result = hasMaterialChange({
      historicalSourceTypes: ['google'],
      todaySourceTypes: ['google', 'pinterest'],
      historicalMaxVelocity: 10,
      todayVelocityPct: 10
    });
    assert.equal(result, true);
  });

  test('crossing the building velocity threshold for the first time counts as material change', () => {
    const result = hasMaterialChange({
      historicalSourceTypes: ['google'],
      todaySourceTypes: ['google'],
      historicalMaxVelocity: 10,
      todayVelocityPct: 25
    });
    assert.equal(result, true);
  });

  test('another day of the same collection with no new source and no new acceleration is not material change', () => {
    const result = hasMaterialChange({
      historicalSourceTypes: ['google', 'pinterest'],
      todaySourceTypes: ['google'],
      historicalMaxVelocity: 30,
      todayVelocityPct: 15
    });
    assert.equal(result, false);
  });

  test('null historical velocity with no acceleration today is not material change', () => {
    const result = hasMaterialChange({
      historicalSourceTypes: ['google'],
      todaySourceTypes: ['google'],
      historicalMaxVelocity: null,
      todayVelocityPct: null
    });
    assert.equal(result, false);
  });

  test('null historical velocity with today crossing the threshold is material change', () => {
    const result = hasMaterialChange({
      historicalSourceTypes: ['google'],
      todaySourceTypes: ['google'],
      historicalMaxVelocity: null,
      todayVelocityPct: 25
    });
    assert.equal(result, true);
  });
});
