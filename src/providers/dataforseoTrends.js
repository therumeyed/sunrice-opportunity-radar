// TrendsProvider: DataForSEO Google Trends explore. Async task_post ->
// bounded poll of task_get, per the brief's "never keep a web request open
// while waiting" rule -- this runs from ingest.js (a script), never from an
// Express request handler, so a bounded synchronous poll here is fine.
const { fetchWithTimeout } = require('../util/fetchWithTimeout');

const BASE = 'https://api.dataforseo.com/v3';
const AUSTRALIA_LOCATION_CODE = 2036;

function isConfigured() {
  return Boolean(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);
}

function authHeader() {
  const token = Buffer.from(`${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`).toString('base64');
  return `Basic ${token}`;
}

async function submitTask(keyword) {
  const res = await fetchWithTimeout(`${BASE}/keywords_data/google_trends/explore/task_post`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    // Single keyword per request -- item_types requiring one keyword
    // (queries_list, topics_list) can't be mixed with multi-keyword compares.
    body: JSON.stringify([{
      keywords: [keyword],
      location_code: AUSTRALIA_LOCATION_CODE,
      language_code: 'en',
      time_range: 'past_30_days',
      item_types: ['google_trends_graph', 'google_trends_map', 'google_trends_queries_list']
    }])
  });
  const json = await res.json();
  const task = json?.tasks?.[0];
  if (!res.ok || !task || task.status_code >= 40000) {
    // DataForSEO can charge for a task_post that itself reports an error --
    // attach whatever cost it named so the caller's daily ceiling tracking
    // still sees the real spend instead of silently under-counting it.
    const err = new Error(`DataForSEO task_post failed for "${keyword}": [${task?.status_code}] ${task?.status_message || res.statusText}`);
    err.cost = task?.cost || 0;
    throw err;
  }
  return { taskId: task.id, cost: task.cost || 0 };
}

// Confirmed against DataForSEO's own dashboard (their Errors tab): every
// task was hitting 40601 "Task Handed." within ~1s of submission, on every
// single keyword, consistently. That's the engine saying "not picked up
// yet" -- not a real failure. 40602 ("Task In Queue"-style codes in the
// same family) means the same thing. Named explicitly here rather than
// just "anything not in TERMINAL_ERROR_CODES" -- the 5s initial delay is
// not a guarantee the task is ready by then; these codes can (and should)
// keep recurring across multiple poll attempts before the real result
// shows up, right up to the full maxWaitMs budget.
const PENDING_STATUS_CODES = new Set([40601, 40602]);
const TERMINAL_ERROR_CODES = new Set([40001, 40002, 40003, 40004, 40100, 40501]);

async function pollTask(taskId, { pollMs = 4000, initialDelayMs = 5000, maxWaitMs = 120000 } = {}) {
  const deadline = Date.now() + maxWaitMs;
  await new Promise((r) => setTimeout(r, initialDelayMs)); // give the engine a moment to actually start
  while (Date.now() < deadline) {
    const res = await fetchWithTimeout(`${BASE}/keywords_data/google_trends/explore/task_get/${taskId}`, {
      headers: { Authorization: authHeader() }
    });
    const json = await res.json();
    const task = json?.tasks?.[0];
    if (task && task.status_code === 20000 && task.result) return task;
    if (task && TERMINAL_ERROR_CODES.has(task.status_code)) {
      const err = new Error(`DataForSEO task ${taskId} failed: [${task.status_code}] ${task.status_message}`);
      err.cost = task.cost || 0;
      throw err;
    }
    // A known-pending code and an unrecognised one get identical treatment
    // (keep polling) -- but flag the unrecognised case so a genuinely new
    // code doesn't silently blend into "normal," the way 40601 did before
    // we'd actually confirmed what it meant.
    if (task && !PENDING_STATUS_CODES.has(task.status_code)) {
      console.warn(`[dataforseo] task ${taskId}: unrecognised non-terminal status_code ${task.status_code} (${task.status_message}) -- treating as pending, worth checking`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`DataForSEO task ${taskId} did not finish within ${maxWaitMs}ms`);
}

// Defensive parsing -- DataForSEO's exact nesting varies by item_type and we
// have no live account to verify against yet. Anything unrecognised is kept
// in rawPayload rather than dropped, per the "never discard the original
// item" rule; interestByRegion/relatedQueries just come back empty instead
// of throwing so one odd response shape doesn't take down the whole run.
function parseResult(task, keyword) {
  const items = task?.result?.[0]?.items || [];
  const map = items.find((i) => i.type === 'google_trends_map');
  const queriesList = items.find((i) => i.type === 'google_trends_queries_list');
  const graph = items.find((i) => i.type === 'google_trends_graph');

  const interestByRegion = (map?.data || map?.items || [])
    .map((r) => ({ region: r.geo_name || r.region || r.location_name, value: r.value ?? r.values?.[0] }))
    .filter((r) => r.region && typeof r.value === 'number');

  // Trying several plausible nestings -- including values under a `.data`
  // object, per a specific hypothesis worth covering cheaply -- rather than
  // asserting one guess is correct. The diagnostic log below is what
  // actually confirms which one (if any) was right.
  const topRaw = queriesList?.top_queries || queriesList?.top || queriesList?.data?.top || [];
  const risingRaw = queriesList?.rising_queries || queriesList?.rising || queriesList?.data?.rising || [];
  const relatedQueries = {
    top: topRaw.map((q) => ({ query: q.query || q.keyword, value: q.value ?? q.formatted_value })),
    rising: risingRaw.map((q) => ({ query: q.query || q.keyword, value: q.value ?? q.formatted_value }))
  };

  // Confirmed via DataForSEO's own dashboard that rising/top queries exist
  // for these keywords -- if we come back empty, it's our parsing guessing
  // wrong field names, not missing data. Log the actual shape once here
  // instead of guessing again; this costs nothing extra since it only
  // fires on an already-completed, already-paid-for response.
  if (relatedQueries.top.length === 0 && relatedQueries.rising.length === 0) {
    console.warn(`[dataforseo] "${keyword}": queriesList item ${queriesList ? 'found but parsed to 0 top/0 rising' : 'NOT FOUND'} -- item types present: [${items.map((i) => i.type).join(', ')}]${queriesList ? `, queriesList keys: [${Object.keys(queriesList).join(', ')}]` : ''}`);
    if (queriesList) console.warn(`[dataforseo] "${keyword}": queriesList raw (first 1500 chars): ${JSON.stringify(queriesList).slice(0, 1500)}`);
  }

  const interestOverTime = (graph?.data || graph?.items || [])
    .map((p) => ({ date: p.date_from || p.date, value: p.values?.[0] }))
    .filter((p) => p.date && typeof p.value === 'number');

  return { interestByRegion, relatedQueries, interestOverTime };
}

/**
 * @param {string} keyword
 * @returns {Promise<{status: 'live'|'failed'|'awaiting_connection', cost: number, taskId?: string, data?: object, error?: string}>}
 */
async function explore(keyword) {
  if (!isConfigured()) {
    return {
      status: 'awaiting_connection',
      cost: 0,
      error: `DATAFORSEO_LOGIN=${process.env.DATAFORSEO_LOGIN ? 'set' : 'MISSING'}, DATAFORSEO_PASSWORD=${process.env.DATAFORSEO_PASSWORD ? 'set' : 'MISSING'} in this process's environment -- account balance doesn't matter if the process never sees the credentials`
    };
  }
  try {
    const { taskId, cost } = await submitTask(keyword);
    const task = await pollTask(taskId);
    return { status: 'live', cost: (task.cost || 0) + cost, taskId, data: parseResult(task, keyword), rawPayload: task };
  } catch (err) {
    return { status: 'failed', cost: err.cost || 0, error: err.message };
  }
}

module.exports = { explore, isConfigured, AUSTRALIA_LOCATION_CODE };
