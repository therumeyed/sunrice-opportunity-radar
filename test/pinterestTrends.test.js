const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { searchPinterest } = require('../src/providers/pinterestTrends');

describe('pinterestTrends searchPinterest', () => {
  test('returns awaiting_connection without APIFY_TOKEN -- never blocks report generation', async () => {
    delete process.env.APIFY_TOKEN;
    const result = await searchPinterest(['curry'], new Date());
    assert.equal(result.status, 'awaiting_connection');
    assert.deepEqual(result.items, []);
  });

  test('returns awaiting_connection when explicitly disabled, even with a token set', async () => {
    process.env.APIFY_TOKEN = 'fake-token-for-test';
    process.env.FEATURE_APIFY_PINTEREST = 'false';
    const result = await searchPinterest(['curry'], new Date());
    assert.equal(result.status, 'awaiting_connection');
    delete process.env.APIFY_TOKEN;
    delete process.env.FEATURE_APIFY_PINTEREST;
  });
});
