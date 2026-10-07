const { fetchWithTimeout } = require('./util/fetchWithTimeout');

const APIFY_API_BASE = 'https://api.apify.com/v2';

const TERMINAL_STATUSES = ['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED'];

// Apify actor IDs are "author/name" but the REST API path wants "author~name".
function actorPath(actorId) {
  return actorId.replace('/', '~');
}

async function startRun(actorId, input) {
  const token = process.env.APIFY_TOKEN;
  const res = await fetchWithTimeout(`${APIFY_API_BASE}/acts/${actorPath(actorId)}/runs?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  });
  if (!res.ok) throw new Error(`Apify actor ${actorId} failed to start: ${res.status} ${await res.text()}`);
  return (await res.json()).data;
}

// Poll an async run rather than the run-sync-get-dataset-items endpoint,
// which hard-caps at 300s server-side -- some actors routinely run longer.
async function waitForRun(runId, { pollMs = 5000, maxWaitMs = 10 * 60 * 1000 } = {}) {
  const token = process.env.APIFY_TOKEN;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const res = await fetchWithTimeout(`${APIFY_API_BASE}/actor-runs/${runId}?token=${token}`);
    if (!res.ok) throw new Error(`Failed to poll Apify run ${runId}: ${res.status} ${await res.text()}`);
    const run = (await res.json()).data;
    if (TERMINAL_STATUSES.includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`Apify run ${runId} did not finish within ${maxWaitMs}ms`);
}

async function getDatasetItems(datasetId) {
  const token = process.env.APIFY_TOKEN;
  const res = await fetchWithTimeout(`${APIFY_API_BASE}/datasets/${datasetId}/items?token=${token}&format=json&clean=true`);
  if (!res.ok) throw new Error(`Failed to fetch Apify dataset ${datasetId}: ${res.status} ${await res.text()}`);
  return res.json();
}

// Returns { items, runId, datasetId, actorId, inputHash } -- callers store
// the run/dataset ids alongside every derived source_item per the brief's
// "record actor ID, run ID, dataset ID and input hash" requirement.
async function runActor(actorId, input) {
  const run = await startRun(actorId, input);
  const finished = await waitForRun(run.id);
  if (finished.status !== 'SUCCEEDED') {
    throw new Error(`Apify actor ${actorId} run ended ${finished.status}: ${finished.statusMessage || 'no message'}`);
  }
  const items = await getDatasetItems(finished.defaultDatasetId);
  return { items, runId: finished.id, datasetId: finished.defaultDatasetId, actorId };
}

module.exports = { runActor };
