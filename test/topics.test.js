const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { allQueries, themeForQuery, MULTICULTURAL_THEME } = require('../src/topics');

describe('topics', () => {
  test('every query maps back to a real theme', () => {
    for (const { theme, query } of allQueries()) {
      assert.equal(themeForQuery(query), theme);
    }
  });
  test('multicultural discovery has no hard-coded queries', () => {
    assert.deepEqual(MULTICULTURAL_THEME.queries, []);
    assert.equal(MULTICULTURAL_THEME.requiresReview, true);
  });
  test('an unknown query maps to no theme', () => {
    assert.equal(themeForQuery('something nobody configured'), null);
  });
});
