const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

// data_status is shared across provider_runs and source_items -- see the
// brief's non-negotiable data rule. Never widen this list to include a
// value that isn't one of: real live pull, a stale-but-real previous pull,
// a human-supplied file, "we don't have this yet", or "the pull failed".
const DATA_STATUSES = ['live', 'cached', 'imported', 'awaiting_connection', 'failed'];

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id SERIAL PRIMARY KEY,
      report_date DATE NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed')),
      generated_at TIMESTAMPTZ,
      provider_summary JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS provider_runs (
      id SERIAL PRIMARY KEY,
      report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      provider_name TEXT NOT NULL,
      source_type TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('live','cached','imported','awaiting_connection','failed')),
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ,
      task_id TEXT,
      input_params JSONB,
      cost NUMERIC,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_provider_runs_report ON provider_runs(report_id);

    -- Raw evidence: every item this dashboard ever cites lives here, in full,
    -- never trimmed to just what a recommendation needed. content_hash is
    -- source_type + external_id (or a hash of the item when a source has no
    -- stable id) so re-collecting the same item across days never duplicates it.
    CREATE TABLE IF NOT EXISTS source_items (
      id SERIAL PRIMARY KEY,
      provider_run_id INTEGER REFERENCES provider_runs(id) ON DELETE SET NULL,
      source_type TEXT NOT NULL,
      source_name TEXT NOT NULL,
      source_url TEXT,
      external_id TEXT,
      content_hash TEXT NOT NULL,
      title TEXT,
      excerpt TEXT,
      author TEXT,
      published_at TIMESTAMPTZ,
      collected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      query_or_topic TEXT,
      theme TEXT,
      geography TEXT,
      raw_metrics JSONB,
      normalized_metrics JSONB,
      data_status TEXT NOT NULL CHECK (data_status IN ('live','cached','imported','awaiting_connection','failed')),
      raw_payload JSONB,
      UNIQUE(source_type, content_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_source_items_theme ON source_items(theme);
    CREATE INDEX IF NOT EXISTS idx_source_items_collected ON source_items(collected_at);

    -- One row per topic/platform rollup shown in the Search demand and
    -- Social trends panels. Rebuilt fresh for every report from that day's
    -- source_items rather than mutated in place, matching the "immutable
    -- daily snapshot" rule.
    CREATE TABLE IF NOT EXISTS signals (
      id SERIAL PRIMARY KEY,
      report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      signal_type TEXT NOT NULL CHECK (signal_type IN ('search_topic','social_topic')),
      topic TEXT NOT NULL,
      platform TEXT,
      theme TEXT,
      audience TEXT,
      state TEXT,
      metric_summary JSONB,
      lifecycle TEXT CHECK (lifecycle IN ('new','building','sustained','cooling')),
      momentum TEXT,
      first_detected_at TIMESTAMPTZ,
      data_status TEXT NOT NULL CHECK (data_status IN ('live','cached','imported','awaiting_connection','failed'))
    );
    CREATE INDEX IF NOT EXISTS idx_signals_report ON signals(report_id);

    CREATE TABLE IF NOT EXISTS recommendations (
      id SERIAL PRIMARY KEY,
      report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      rank INTEGER NOT NULL,
      action_type TEXT NOT NULL CHECK (action_type IN ('Create','Investigate','Local','Respond','Watch')),
      theme TEXT,
      title TEXT NOT NULL,
      rationale TEXT NOT NULL,
      audience TEXT,
      state TEXT,
      suggested_channel TEXT,
      freshness TEXT,
      confidence TEXT NOT NULL CHECK (confidence IN ('high','medium','early_signal')),
      score NUMERIC NOT NULL,
      score_components JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_recommendations_report ON recommendations(report_id);

    CREATE TABLE IF NOT EXISTS recommendation_evidence (
      id SERIAL PRIMARY KEY,
      recommendation_id INTEGER NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE,
      source_item_id INTEGER NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_rec_evidence_rec ON recommendation_evidence(recommendation_id);

    CREATE TABLE IF NOT EXISTS topic_definitions (
      id SERIAL PRIMARY KEY,
      theme TEXT NOT NULL,
      query TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true,
      UNIQUE(theme, query)
    );
  `);
}

// On a fresh Render Blueprint deploy, the web service, cron job and Postgres
// instance are all created together -- Postgres provisioning a brand-new
// instance can take a couple of minutes, well past the DB's first
// ECONNREFUSED. 30 attempts x 5s gives ~2.5 minutes of runway before this
// gives up and exits (which Render then reports as a failed deploy rather
// than just letting the container come up a little later).
async function initSchemaWithRetry(maxAttempts = 30, delayMs = 5000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await initSchema();
      return;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      console.warn(`[db] schema init attempt ${attempt}/${maxAttempts} failed (${err.message}), retrying in ${delayMs}ms...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function getOrCreateReport(reportDate) {
  const existing = await pool.query('SELECT * FROM reports WHERE report_date = $1', [reportDate]);
  if (existing.rowCount > 0) return existing.rows[0];
  const inserted = await pool.query(
    `INSERT INTO reports (report_date, status) VALUES ($1, 'pending') RETURNING *`,
    [reportDate]
  );
  return inserted.rows[0];
}

async function completeReport(reportId, providerSummary) {
  const res = await pool.query(
    `UPDATE reports SET status = 'completed', generated_at = now(), provider_summary = $2 WHERE id = $1 RETURNING *`,
    [reportId, JSON.stringify(providerSummary)]
  );
  return res.rows[0];
}

async function failReport(reportId, providerSummary) {
  const res = await pool.query(
    `UPDATE reports SET status = 'failed', generated_at = now(), provider_summary = $2 WHERE id = $1 RETURNING *`,
    [reportId, JSON.stringify(providerSummary)]
  );
  return res.rows[0];
}

async function getReportByDate(reportDate) {
  const res = await pool.query(`SELECT * FROM reports WHERE report_date = $1 AND status = 'completed'`, [reportDate]);
  return res.rows[0] || null;
}

async function getLatestReport() {
  const res = await pool.query(`SELECT * FROM reports WHERE status = 'completed' ORDER BY report_date DESC LIMIT 1`);
  return res.rows[0] || null;
}

// Dates with a completed report, for the History calendar -- only dates that
// actually have a report light up, per the brief's History requirements.
async function listReportDates(fromDate, toDate) {
  const res = await pool.query(
    `SELECT report_date FROM reports WHERE status = 'completed' AND report_date BETWEEN $1 AND $2 ORDER BY report_date ASC`,
    [fromDate, toDate]
  );
  return res.rows.map((r) => r.report_date);
}

async function recordProviderRun(reportId, run) {
  const res = await pool.query(
    `INSERT INTO provider_runs (report_id, provider_name, source_type, status, finished_at, task_id, input_params, cost, error)
     VALUES ($1,$2,$3,$4, CASE WHEN $4 IN ('live','cached','imported') OR $4 = 'failed' THEN now() ELSE NULL END, $5,$6,$7,$8)
     RETURNING *`,
    [
      reportId,
      run.providerName,
      run.sourceType,
      run.status,
      run.taskId || null,
      run.inputParams ? JSON.stringify(run.inputParams) : null,
      typeof run.cost === 'number' ? run.cost : null,
      run.error || null
    ]
  );
  return res.rows[0];
}

// ON CONFLICT DO NOTHING is the dedupe: the same item collected again on a
// later day (still within its content_hash) is silently skipped rather than
// duplicated, and RETURNING id lets the caller know whether it actually got
// a fresh row to attach to this report's signals/recommendations.
async function upsertSourceItem(item) {
  const res = await pool.query(
    `INSERT INTO source_items
       (provider_run_id, source_type, source_name, source_url, external_id, content_hash,
        title, excerpt, author, published_at, query_or_topic, theme, geography,
        raw_metrics, normalized_metrics, data_status, raw_payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (source_type, content_hash) DO NOTHING
     RETURNING *`,
    [
      item.providerRunId || null,
      item.sourceType,
      item.sourceName,
      item.sourceUrl || null,
      item.externalId || null,
      item.contentHash,
      item.title || null,
      item.excerpt || null,
      item.author || null,
      item.publishedAt || null,
      item.queryOrTopic || null,
      item.theme || null,
      item.geography || null,
      item.rawMetrics ? JSON.stringify(item.rawMetrics) : null,
      item.normalizedMetrics ? JSON.stringify(item.normalizedMetrics) : null,
      item.dataStatus,
      item.rawPayload ? JSON.stringify(item.rawPayload) : null
    ]
  );
  if (res.rowCount > 0) return res.rows[0];
  // Already seen -- return the existing row so callers (recommendation
  // evidence linking in particular) still have a source_item_id to point at.
  const existing = await pool.query(
    `SELECT * FROM source_items WHERE source_type = $1 AND content_hash = $2`,
    [item.sourceType, item.contentHash]
  );
  return existing.rows[0];
}

// First-ever collection time for a content_hash -- used to compute
// "freshness" and "first detected" without a separate first-seen column
// that would go stale the moment dedupe skips a re-insert.
async function firstSeenAt(sourceType, contentHash) {
  const res = await pool.query(
    `SELECT MIN(collected_at) AS first_seen FROM source_items WHERE source_type = $1 AND content_hash = $2`,
    [sourceType, contentHash]
  );
  return res.rows[0]?.first_seen || null;
}

async function insertSignal(reportId, signal) {
  const res = await pool.query(
    `INSERT INTO signals (report_id, signal_type, topic, platform, theme, audience, state,
                           metric_summary, lifecycle, momentum, first_detected_at, data_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [
      reportId,
      signal.signalType,
      signal.topic,
      signal.platform || null,
      signal.theme || null,
      signal.audience || null,
      signal.state || null,
      signal.metricSummary ? JSON.stringify(signal.metricSummary) : null,
      signal.lifecycle || null,
      signal.momentum || null,
      signal.firstDetectedAt || null,
      signal.dataStatus
    ]
  );
  return res.rows[0];
}

async function insertRecommendation(reportId, rec) {
  const res = await pool.query(
    `INSERT INTO recommendations (report_id, rank, action_type, theme, title, rationale, audience, state,
                                   suggested_channel, freshness, confidence, score, score_components)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [
      reportId, rec.rank, rec.actionType, rec.theme || null, rec.title, rec.rationale, rec.audience || null,
      rec.state || 'National', rec.suggestedChannel || null, rec.freshness || null,
      rec.confidence, rec.score, JSON.stringify(rec.scoreComponents)
    ]
  );
  return res.rows[0];
}

async function linkEvidence(recommendationId, sourceItemId, note) {
  await pool.query(
    `INSERT INTO recommendation_evidence (recommendation_id, source_item_id, note) VALUES ($1,$2,$3)`,
    [recommendationId, sourceItemId, note || null]
  );
}

async function getReportBundle(report) {
  const [signalsRes, recsRes] = await Promise.all([
    pool.query(`SELECT * FROM signals WHERE report_id = $1 ORDER BY id ASC`, [report.id]),
    pool.query(`SELECT * FROM recommendations WHERE report_id = $1 ORDER BY rank ASC`, [report.id])
  ]);

  const recIds = recsRes.rows.map((r) => r.id);
  let evidenceByRec = new Map();
  if (recIds.length > 0) {
    const evRes = await pool.query(
      `SELECT re.recommendation_id, re.note, si.*
       FROM recommendation_evidence re
       JOIN source_items si ON si.id = re.source_item_id
       WHERE re.recommendation_id = ANY($1)
       ORDER BY si.collected_at DESC`,
      [recIds]
    );
    for (const row of evRes.rows) {
      if (!evidenceByRec.has(row.recommendation_id)) evidenceByRec.set(row.recommendation_id, []);
      evidenceByRec.get(row.recommendation_id).push(row);
    }
  }

  const providerRunsRes = await pool.query(`SELECT * FROM provider_runs WHERE report_id = $1`, [report.id]);

  return {
    report,
    signals: signalsRes.rows,
    recommendations: recsRes.rows.map((r) => ({ ...r, evidence: evidenceByRec.get(r.id) || [] })),
    providerRuns: providerRunsRes.rows
  };
}

module.exports = {
  pool,
  DATA_STATUSES,
  initSchema,
  initSchemaWithRetry,
  getOrCreateReport,
  completeReport,
  failReport,
  getReportByDate,
  getLatestReport,
  listReportDates,
  recordProviderRun,
  upsertSourceItem,
  firstSeenAt,
  insertSignal,
  insertRecommendation,
  linkEvidence,
  getReportBundle
};
