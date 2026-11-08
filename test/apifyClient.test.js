// Mocks global.fetch directly -- fetchWithTimeout is a thin wrapper around
// it with no seam of its own, and there's no live Apify account to hit in
// this environment. Proves runActor's error now carries real diagnostic
// detail instead of the old, useless "no message" when Apify's own
// statusMessage is empty.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { runActor } = require('../src/apifyClient');

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; process.env.APIFY_TOKEN = 'fixture-token'; });

function jsonResponse(data, ok = true, status = 200) {
  return { ok, status, json: async () => data, text: async () => JSON.stringify(data) };
}

describe('runActor error diagnostics', () => {
  test('falls back to the run log tail when statusMessage is empty', async () => {
    process.env.APIFY_TOKEN = 'fixture-token';
    let call = 0;
    global.fetch = async (url) => {
      call++;
      if (url.includes('/runs?token=')) return jsonResponse({ data: { id: 'run123' } });
      if (url.includes('/actor-runs/run123?token=')) {
        return jsonResponse({ data: { id: 'run123', status: 'FAILED', statusMessage: '', defaultDatasetId: 'ds1' } });
      }
      if (url.includes('/actor-runs/run123/log')) {
        return { ok: true, status: 200, text: async () => 'some boring lines\nUncaught TypeError: cannot read property of undefined\n' };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    await assert.rejects(
      () => runActor('trudax/reddit-scraper-lite', {}),
      (err) => {
        assert.match(err.message, /Uncaught TypeError: cannot read property of undefined/);
        assert.match(err.message, /run run123/);
        return true;
      }
    );
  });

  test('uses statusMessage directly when Apify actually provides one, never fetching the log', async () => {
    process.env.APIFY_TOKEN = 'fixture-token';
    let logFetched = false;
    global.fetch = async (url) => {
      if (url.includes('/runs?token=')) return jsonResponse({ data: { id: 'run456' } });
      if (url.includes('/actor-runs/run456?token=')) {
        return jsonResponse({ data: { id: 'run456', status: 'FAILED', statusMessage: 'Out of memory', defaultDatasetId: 'ds1' } });
      }
      if (url.includes('/actor-runs/run456/log')) { logFetched = true; return jsonResponse({}); }
      throw new Error(`unexpected fetch: ${url}`);
    };
    await assert.rejects(() => runActor('trudax/reddit-scraper-lite', {}), /Out of memory/);
    assert.equal(logFetched, false, 'a real statusMessage must never trigger an extra log fetch');
  });

  test('a log-fetch failure never masks the original FAILED error', async () => {
    process.env.APIFY_TOKEN = 'fixture-token';
    global.fetch = async (url) => {
      if (url.includes('/runs?token=')) return jsonResponse({ data: { id: 'run789' } });
      if (url.includes('/actor-runs/run789?token=')) {
        return jsonResponse({ data: { id: 'run789', status: 'FAILED', statusMessage: '', defaultDatasetId: 'ds1' } });
      }
      if (url.includes('/actor-runs/run789/log')) throw new Error('network blip');
      throw new Error(`unexpected fetch: ${url}`);
    };
    await assert.rejects(
      () => runActor('trudax/reddit-scraper-lite', {}),
      /no message, and no log tail available/
    );
  });
});
