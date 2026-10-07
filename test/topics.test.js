const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { allQueries, themeForQuery, MULTICULTURAL_THEME } = require('../src/topics');

describe('topics', () => {
  test('every query maps back to a real theme', () => {
    for (const { theme, query } of allQueries()) {
      assert.equal(themeForQuery(query), theme);
    }
  });
  test('multicultural discovery is hard-locked to human review regardless of its queries', () => {
    assert.equal(MULTICULTURAL_THEME.requiresReview, true);
  });
  test('culturally-specific, shifting-date occasions live under multicultural, not seasonal', () => {
    assert.equal(themeForQuery('lunar new year'), 'multicultural');
    assert.equal(themeForQuery('diwali'), 'multicultural');
    assert.equal(themeForQuery('ramadan'), 'multicultural');
  });
  test('an unknown query maps to no theme', () => {
    assert.equal(themeForQuery('something nobody configured'), null);
  });
  test('rice prep/cooking basics has its own theme covering wash/cook/choose', () => {
    assert.equal(themeForQuery('wash rice'), 'rice_basics');
    assert.equal(themeForQuery('cook rice'), 'rice_basics');
    assert.equal(themeForQuery('rice cooker'), 'rice_basics');
    assert.equal(themeForQuery('rice types'), 'rice_basics');
  });
});
