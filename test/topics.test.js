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
});
