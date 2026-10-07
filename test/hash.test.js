const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { contentHash } = require('../src/util/hash');

describe('contentHash', () => {
  test('is deterministic for the same inputs', () => {
    assert.equal(contentHash(['a', 'b', 'c']), contentHash(['a', 'b', 'c']));
  });
  test('differs when any part differs', () => {
    assert.notEqual(contentHash(['a', 'b']), contentHash(['a', 'c']));
  });
  test('ignores falsy parts rather than erroring', () => {
    assert.equal(contentHash(['a', null, 'b', undefined]), contentHash(['a', 'b']));
  });
});
