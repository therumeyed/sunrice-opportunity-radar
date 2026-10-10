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
    -- Additive migration: CREATE TABLE IF NOT EXISTS above is a no-op against
    -- an already-existing production table, so a new column needs its own
    -- statement. Deterministic, computed in reportBuilder.js (never by the
    -- LLM) -- which named trend sources (google_trends, pinterest) show this
    -- recommendation's theme as independently rising/growing right now, by
    -- that source's own definition of rising/growing. Null/empty is normal
    -- and means neither source showed it, not that something failed.
    ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS momentum_sources JSONB;

    -- Recommendation memory/continuity columns -- additive, same reasoning as
    -- momentum_sources above. opportunity_name/continuity_status/
    -- action_fingerprint/continuity_meta are deterministic (computed in
    -- reportBuilder.js, never decided by the LLM); strategy_output is the
    -- LLM's own structured response kept verbatim for audit, same spirit as
    -- source_items.raw_payload -- never discard the original.
    ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS opportunity_name TEXT;
    ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS continuity_status TEXT
      CHECK (continuity_status IN ('new','continuing','strengthening','weakening','new_angle','repeat_action'));
    ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS action_fingerprint TEXT;
    ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS continuity_meta JSONB;
    ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS strategy_output JSONB;

    -- One row per theme per report, for every theme that had real evidence
    -- that day -- not only the top 3 that became recommendations. This is
    -- what lets lifecycle (new/validating/building/cooling/sustained/
    -- peaking) and the Thematic trends section exist at all: signals is
    -- rebuilt fresh every report and keeps no cross-day history, and
    -- recommendations only ever has rows for themes that won a top-3 slot.
    -- Deliberately a new table, not a repurposing of either -- both of those
    -- keep doing exactly what they already did.
    CREATE TABLE IF NOT EXISTS theme_daily_snapshots (
      id SERIAL PRIMARY KEY,
      report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      theme TEXT NOT NULL,
      score NUMERIC NOT NULL,
      score_components JSONB NOT NULL,
      velocity_pct NUMERIC,
      distinct_source_count INTEGER NOT NULL,
      source_types JSONB NOT NULL,
      momentum_sources JSONB,
      social_counts JSONB,
      unique_creator_count INTEGER NOT NULL DEFAULT 0,
      has_search BOOLEAN NOT NULL DEFAULT false,
      leading_queries JSONB,
      first_observed_date DATE NOT NULL,
      lifecycle TEXT CHECK (lifecycle IN ('new','validating','building','cooling','sustained','peaking')),
      was_recommended BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(report_id, theme)
    );
    CREATE INDEX IF NOT EXISTS idx_theme_snapshots_theme ON theme_daily_snapshots(theme);
    CREATE INDEX IF NOT EXISTS idx_theme_snapshots_report ON theme_daily_snapshots(report_id);

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
                                   suggested_channel, freshness, confidence, score, score_components, momentum_sources,
                                   opportunity_name, continuity_status, action_fingerprint, continuity_meta, strategy_output)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
    [
      reportId, rec.rank, rec.actionType, rec.theme || null, rec.title, rec.rationale, rec.audience || null,
      rec.state || 'National', rec.suggestedChannel || null, rec.freshness || null,
      rec.confidence, rec.score, JSON.stringify(rec.scoreComponents),
      rec.momentumSources && rec.momentumSources.length > 0 ? JSON.stringify(rec.momentumSources) : null,
      rec.opportunityName || null,
      rec.continuityStatus || null,
      rec.actionFingerprint || null,
      rec.continuityMeta ? JSON.stringify(rec.continuityMeta) : null,
      rec.strategyOutput ? JSON.stringify(rec.strategyOutput) : null
    ]
  );
  return res.rows[0];
}

// Deterministic (reportBuilder.js only) -- one row per theme per report,
// for every theme with real evidence that day. ON CONFLICT (report_id,
// theme) means a same-day refresh updates this report's row in place
// rather than duplicating it; first_observed_date is looked up once below
// and then deliberately left out of the DO UPDATE SET list, so a same-day
// re-run can never overwrite a theme's true first-seen date with today.
async function upsertThemeSnapshot(reportId, reportDate, snapshot) {
  const firstSeenRes = await pool.query(
    `SELECT MIN(r.report_date) AS first_date
     FROM theme_daily_snapshots s JOIN reports r ON r.id = s.report_id
     WHERE s.theme = $1`,
    [snapshot.theme]
  );
  const firstObservedDate = firstSeenRes.rows[0]?.first_date || reportDate;

  const res = await pool.query(
    `INSERT INTO theme_daily_snapshots
       (report_id, theme, score, score_components, velocity_pct, distinct_source_count,
        source_types, momentum_sources, social_counts, unique_creator_count, has_search,
        leading_queries, first_observed_date, lifecycle, was_recommended)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (report_id, theme) DO UPDATE SET
       score = EXCLUDED.score,
       score_components = EXCLUDED.score_components,
       velocity_pct = EXCLUDED.velocity_pct,
       distinct_source_count = EXCLUDED.distinct_source_count,
       source_types = EXCLUDED.source_types,
       momentum_sources = EXCLUDED.momentum_sources,
       social_counts = EXCLUDED.social_counts,
       unique_creator_count = EXCLUDED.unique_creator_count,
       has_search = EXCLUDED.has_search,
       leading_queries = EXCLUDED.leading_queries,
       lifecycle = EXCLUDED.lifecycle,
       was_recommended = EXCLUDED.was_recommended,
       updated_at = now()
     RETURNING *`,
    [
      reportId, snapshot.theme, snapshot.score, JSON.stringify(snapshot.scoreComponents),
      snapshot.velocityPct ?? null, snapshot.distinctSourceCount,
      JSON.stringify(snapshot.sourceTypes || []),
      snapshot.momentumSources && snapshot.momentumSources.length > 0 ? JSON.stringify(snapshot.momentumSources) : null,
      snapshot.socialCounts ? JSON.stringify(snapshot.socialCounts) : null,
      snapshot.uniqueCreatorCount || 0,
      Boolean(snapshot.hasSearch),
      snapshot.leadingQueries ? JSON.stringify(snapshot.leadingQueries) : null,
      firstObservedDate,
      snapshot.lifecycle || null,
      Boolean(snapshot.wasRecommended)
    ]
  );
  return res.rows[0];
}

// Up to `windowDays` of a theme's own snapshot history, ending at
// `reportDate` (never later) -- so a historical report view shows the
// trend as it stood on that day, not today's latest. `theme = null` means
// every theme active at some point in the window.
async function getThemeTrendHistory(reportDate, windowDays = 30, theme = null) {
  const params = [reportDate, windowDays];
  let themeClause = '';
  if (theme) {
    params.push(theme);
    themeClause = 'AND s.theme = $3';
  }
  const res = await pool.query(
    `SELECT s.*, r.report_date
     FROM theme_daily_snapshots s
     JOIN reports r ON r.id = s.report_id
     WHERE r.report_date <= $1::date
       AND r.report_date > $1::date - ($2 || ' days')::interval
       ${themeClause}
     ORDER BY s.theme ASC, r.report_date ASC`,
    params
  );
  return res.rows;
}

// Strictly BEFORE reportDate -- for computing today's lifecycle, which
// must never see today's own not-yet-saved snapshot (distinct from
// getThemeTrendHistory above, which is "up to and including" for the
// public-facing trend API, where today's row legitimately belongs once
// it exists).
async function getPriorThemeSnapshots(theme, reportDate, windowDays = 30) {
  const res = await pool.query(
    `SELECT s.*, r.report_date
     FROM theme_daily_snapshots s
     JOIN reports r ON r.id = s.report_id
     WHERE s.theme = $1
       AND r.report_date < $2::date
       AND r.report_date >= $2::date - ($3 || ' days')::interval
     ORDER BY r.report_date ASC`,
    [theme, reportDate, windowDays]
  );
  return res.rows;
}

// Recommendation memory -- reuses the real, already-persisted
// `recommendations` history rather than a second table (recommendations
// has never had any day's rows deleted except that same day's own rerun,
// so this is genuine history going back to this report's first run).
// Excludes `beforeReportId` so a same-day refresh doesn't see itself as
// "yesterday's" recommendation -- use getSameDayRecommendations for that.
async function getRecentRecommendations(theme, reportDate, days = 14, excludeReportId = null) {
  const res = await pool.query(
    `SELECT rec.*, r.report_date
     FROM recommendations rec
     JOIN reports r ON r.id = rec.report_id
     WHERE rec.theme = $1
       AND r.report_date < $2::date
       AND r.report_date >= $2::date - ($3 || ' days')::interval
       AND ($4::int IS NULL OR rec.report_id != $4)
     ORDER BY r.report_date DESC`,
    [theme, reportDate, days, excludeReportId]
  );
  return res.rows;
}

// Same-day recommendations already written before this run's delete/rebuild
// -- captured so a manual Refresh fired twice in one day doesn't lose the
// context of what was already proposed earlier that same day.
async function getSameDayRecommendations(reportId) {
  const res = await pool.query(`SELECT * FROM recommendations WHERE report_id = $1`, [reportId]);
  return res.rows;
}

// Postgres advisory lock, scoped to this process's pool connection pattern --
// pg_try_advisory_lock is session-scoped, so this must run on the SAME
// client for acquire and release, hence the dedicated client rather than
// pool.query (which could round-robin to a different connection and
// silently fail to release what another connection acquired). A second
// overlapping ingest run gets `false` back immediately, no queueing.
const INGEST_LOCK_KEY = 847291; // arbitrary fixed bigint, unique to this app's ingest lock
async function tryAcquireIngestLock() {
  const client = await pool.connect();
  const res = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [INGEST_LOCK_KEY]);
  if (!res.rows[0].acquired) {
    client.release();
    return null;
  }
  return client; // caller releases via releaseIngestLock once done
}
async function releaseIngestLock(client) {
  if (!client) return;
  try {
    await client.query('SELECT pg_advisory_unlock($1)', [INGEST_LOCK_KEY]);
  } finally {
    client.release();
  }
}

// Appearance counts + last-recommended date per theme, all ending at
// reportDate (never later, same "historical view stays historical" rule
// as everything else here). Reuses the real recommendations history --
// no second table.
async function getThemeRecommendationStats(themes, reportDate) {
  if (themes.length === 0) return {};
  const res = await pool.query(
    `SELECT rec.theme,
            COUNT(*) FILTER (WHERE r.report_date > $2::date - interval '14 days') AS count_14d,
            COUNT(*) FILTER (WHERE r.report_date > $2::date - interval '30 days') AS count_30d,
            MAX(r.report_date) AS last_recommended_date
     FROM recommendations rec
     JOIN reports r ON r.id = rec.report_id
     WHERE rec.theme = ANY($1) AND r.report_date <= $2::date
     GROUP BY rec.theme`,
    [themes, reportDate]
  );
  return Object.fromEntries(res.rows.map((r) => [r.theme, {
    count14d: Number(r.count_14d),
    count30d: Number(r.count_30d),
    lastRecommendedDate: r.last_recommended_date
  }]));
}

// How many of the most recent snapshot rows are on consecutive calendar
// days, walking backward from the latest -- a real gap (the theme had no
// evidence that day, so no snapshot was ever written) breaks the streak.
function consecutiveActiveDays(rowsAscending) {
  if (rowsAscending.length === 0) return 0;
  let count = 1;
  for (let i = rowsAscending.length - 1; i > 0; i--) {
    const curr = new Date(rowsAscending[i].report_date);
    const prev = new Date(rowsAscending[i - 1].report_date);
    if (Math.round((curr - prev) / 86400000) === 1) count++;
    else break;
  }
  return count;
}

// Shapes the raw per-day snapshot rows into one summary object per theme --
// everything the Thematic trends UI card needs, computed here so
// public/app.js never has to derive it client-side or fetch per-theme.
function buildThemeTrendsSummary(rows, recStatsByTheme) {
  const byTheme = new Map();
  for (const row of rows) {
    if (!byTheme.has(row.theme)) byTheme.set(row.theme, []);
    byTheme.get(row.theme).push(row);
  }
  const summaries = [];
  for (const [theme, themeRows] of byTheme) {
    const latest = themeRows[themeRows.length - 1];
    const previous = themeRows[themeRows.length - 2] || null;
    const stats = recStatsByTheme[theme] || { count14d: 0, count30d: 0, lastRecommendedDate: null };
    summaries.push({
      theme,
      firstObservedDate: latest.first_observed_date,
      observationCount: themeRows.length,
      consecutiveActiveDays: consecutiveActiveDays(themeRows),
      latestScore: Number(latest.score),
      scoreChange: previous ? Math.round((Number(latest.score) - Number(previous.score)) * 10) / 10 : null,
      lifecycle: latest.lifecycle,
      sourceTypes: latest.source_types || [],
      momentumSources: latest.momentum_sources || [],
      uniqueCreatorCount: latest.unique_creator_count,
      wasRecommendedToday: latest.was_recommended,
      appearances14d: stats.count14d,
      appearances30d: stats.count30d,
      lastRecommendedDate: stats.lastRecommendedDate,
      sparkline: themeRows.map((r) => ({ date: r.report_date, score: Number(r.score) }))
    });
  }
  return summaries.sort((a, b) => b.latestScore - a.latestScore);
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

  // Ends at this report's own date, not today -- browsing a historical
  // report must show the trend as it stood that day, never today's latest.
  const themeTrendRows = await getThemeTrendHistory(report.report_date, 30);
  const themes = [...new Set(themeTrendRows.map((r) => r.theme))];
  const recStats = await getThemeRecommendationStats(themes, report.report_date);
  const themeTrends = buildThemeTrendsSummary(themeTrendRows, recStats);

  return {
    report,
    signals: signalsRes.rows,
    recommendations: recsRes.rows.map((r) => ({ ...r, evidence: evidenceByRec.get(r.id) || [] })),
    providerRuns: providerRunsRes.rows,
    themeTrends
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
  getReportBundle,
  upsertThemeSnapshot,
  getThemeTrendHistory,
  getPriorThemeSnapshots,
  getRecentRecommendations,
  getSameDayRecommendations,
  tryAcquireIngestLock,
  releaseIngestLock,
  getThemeRecommendationStats,
  buildThemeTrendsSummary,
  consecutiveActiveDays
};
