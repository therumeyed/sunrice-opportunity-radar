const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeQueryValue } = require('../src/providers/dataforseoTrends');

describe('dataforseoTrends sanitizeQueryValue', () => {
  test('keeps a plausible relative value', () => {
    assert.equal(sanitizeQueryValue(100, 'q', 'kw'), 100);
    assert.equal(sanitizeQueryValue(58, 'q', 'kw'), 58);
    assert.equal(sanitizeQueryValue('87', 'q', 'kw'), 87);
  });
  test('drops a value that looks like absolute search volume, not a relative score', () => {
    // Real production values seen for this field that DataForSEO's own
    // docs say should never exceed a couple hundred.
    assert.equal(sanitizeQueryValue(489700, 'chinese lunar new year 2027', 'lunar new year'), null);
    assert.equal(sanitizeQueryValue(95000, 'sona masoori rice', 'basmati'), null);
  });
  test('drops a negative or non-numeric value without throwing', () => {
    assert.equal(sanitizeQueryValue(-5, 'q', 'kw'), null);
    assert.equal(sanitizeQueryValue('Breakout', 'q', 'kw'), null);
    assert.equal(sanitizeQueryValue(undefined, 'q', 'kw'), null);
  });
});
