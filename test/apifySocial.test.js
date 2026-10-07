const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { isGenuineMatch } = require('../src/providers/apifySocial');

describe('apifySocial isGenuineMatch', () => {
  test('a real curry-night post matches "curry"', () => {
    assert.equal(isGenuineMatch('Easy butter chicken curry recipe for weeknight dinner', 'curry'), true);
  });
  test('an NBA Steph Curry post does not match "curry"', () => {
    assert.equal(isGenuineMatch('Steph Curry drops 40 points for the Warriors tonight', 'curry'), false);
  });
  test('an unrelated post does not match at all', () => {
    assert.equal(isGenuineMatch('Best sourdough starter tips', 'curry'), false);
  });
});
