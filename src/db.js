const { Pool } = require('pg');
const { deriveExclusions } = require('./feedback');

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

    -- Whether the mandatory Claude candidate-analysis call succeeded for
    -- this report -- when it didn't (no ANTHROPIC_API_KEY, or failed after
    -- one retry), signals/theme history still built normally but ZERO
    -- recommendations exist for that day; the UI must say so plainly
    -- rather than quietly showing an empty "nothing qualified" state that
    -- looks identical to a day where AI ran fine and genuinely found
    -- nothing. Null means "not yet attempted" (e.g. a report row that
    -- predates this column).
    ALTER TABLE reports ADD COLUMN IF NOT EXISTS ai_analysis_available BOOLEAN;
    ALTER TABLE reports ADD COLUMN IF NOT EXISTS ai_analysis_reason TEXT;

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

    -- The daily recommendation unit, one level narrower than theme --
    -- "Healthy eating" never gets recommended by itself; a specific,
    -- newly-accelerating thing inside it does. theme_daily_snapshots above
    -- is untouched and keeps doing exactly what it did (the roll-up/
    -- tracker); this is a new, separate concept, never conflated with it.
    -- normalized_key is what src/microtrends.js's clustering produces --
    -- stable across spelling/plural variants of the same real idea.
    CREATE TABLE IF NOT EXISTS microtrends (
      id SERIAL PRIMARY KEY,
      theme TEXT NOT NULL,
      normalized_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      source_wording TEXT,
      candidate_type TEXT NOT NULL CHECK (candidate_type IN ('macro','micro','seasonal')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','known','covered','hidden')),
      first_seen_at DATE NOT NULL,
      last_seen_at DATE NOT NULL,
      baseline_shown_at DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(theme, normalized_key)
    );
    CREATE INDEX IF NOT EXISTS idx_microtrends_theme ON microtrends(theme);
    -- Deterministic score as of the most recent report it was observed in --
    -- recomputed and overwritten each time, same "mutable current state"
    -- pattern as status/last_seen_at above. Kept here (not only recomputed
    -- on read) so the Emerging list and the hidden/covered manager can show
    -- a real, already-computed number without re-deriving it from full
    -- observation history on every page load.
    ALTER TABLE microtrends ADD COLUMN IF NOT EXISTS last_score NUMERIC;
    ALTER TABLE microtrends ADD COLUMN IF NOT EXISTS last_score_components JSONB;
    ALTER TABLE microtrends ADD COLUMN IF NOT EXISTS last_scored_report_id INTEGER REFERENCES reports(id);
    -- Claude's own first-pass clustering is deterministic string overlap
    -- only (src/microtrends.js); Claude is then allowed to identify
    -- semantically equivalent candidates that used different wording and
    -- unify them into one microtrend (src/candidateAnalyst.js). This is
    -- the audit trail for that judgment call -- every merged-in clusterKey
    -- that WASN'T already caught by string clustering, with its own
    -- original wording and the date Claude proposed the merge, so the
    -- grouping stays inspectable rather than silently reshaping history.
    ALTER TABLE microtrends ADD COLUMN IF NOT EXISTS semantic_merges JSONB NOT NULL DEFAULT '[]';

    -- Per-report metric readings for a microtrend. UNIQUE on
    -- (report_id, microtrend_id, source_type, metric_type) means a same-day
    -- rerun upserts rather than accumulating duplicate readings -- same
    -- idempotency pattern as theme_daily_snapshots.
    CREATE TABLE IF NOT EXISTS microtrend_observations (
      id SERIAL PRIMARY KEY,
      report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      microtrend_id INTEGER NOT NULL REFERENCES microtrends(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL,
      metric_type TEXT NOT NULL,
      metric_value NUMERIC,
      evidence_count INTEGER NOT NULL DEFAULT 0,
      unique_creator_count INTEGER,
      source_native_classification TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(report_id, microtrend_id, source_type, metric_type)
    );
    CREATE INDEX IF NOT EXISTS idx_microtrend_obs_microtrend ON microtrend_observations(microtrend_id);
    CREATE INDEX IF NOT EXISTS idx_microtrend_obs_report ON microtrend_observations(report_id);

    -- Links a microtrend to the exact real source_items row it was
    -- extracted from -- every candidate must resolve to real evidence,
    -- never an LLM's general knowledge.
    CREATE TABLE IF NOT EXISTS microtrend_evidence (
      id SERIAL PRIMARY KEY,
      microtrend_id INTEGER NOT NULL REFERENCES microtrends(id) ON DELETE CASCADE,
      report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      source_item_id INTEGER NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
      match_type TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(microtrend_id, report_id, source_item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_microtrend_evidence_microtrend ON microtrend_evidence(microtrend_id);

    -- Additive: the daily recommendation unit is now a microtrend, not a
    -- theme directly. microtrend_id is nullable -- the fixed multicultural
    -- disclaimer path (recommendation_kind = 'theme_disclaimer') never had
    -- a microtrend and still doesn't.
    ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS microtrend_id INTEGER REFERENCES microtrends(id);
    ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS recommendation_kind TEXT;
    -- Collapsed from the earlier 3-value set ('microtrend' | 'baseline_opportunity'
    -- | 'theme_disclaimer') to 2 -- macro/micro/seasonal classification is
    -- now Claude's call (stored on microtrends.candidate_type), not a
    -- separate deterministic-only "baseline_opportunity" code path, so
    -- there is no longer a distinct kind for it. Every real recommendation
    -- is now 'candidate' (a Claude-analyzed, evidence-grounded idea);
    -- 'theme_disclaimer' is unchanged, a fixed compliance flag that was
    -- never a trend claim in the first place. Dropped and re-added rather
    -- than left pointing at stale values, since this hasn't shipped real
    -- production data yet.
    ALTER TABLE recommendations DROP CONSTRAINT IF EXISTS recommendations_recommendation_kind_check;
    ALTER TABLE recommendations ADD CONSTRAINT recommendations_recommendation_kind_check
      CHECK (recommendation_kind IN ('candidate', 'theme_disclaimer'));
    -- The LLM's own "recommendedAction" field was validated but never
    -- actually stored or shown anywhere -- a real semantic contradiction:
    -- a "Create" action_type implies a concrete action exists, but nothing
    -- surfaced it. reportBuilder.js now also deterministically downgrades
    -- action_type from Create to Investigate whenever no concrete action
    -- is available (no API key, a failed call, or validation rejection) --
    -- see the "CREATE must have a concrete action" rule.
    ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS recommended_action TEXT;
    -- Which real evidence actually grounds this recommendation -- 'search'
    -- (DataForSEO/Pinterest only), 'social' (real Reddit/TikTok/Instagram
    -- posts only, no search/Pinterest corroboration), or 'mixed' (both).
    -- Computed once in reportBuilder.js from the winning candidate's own
    -- merged evidence and stored as a snapshot of that day's grounding --
    -- never recomputed from evidence that might be relabeled later. A
    -- 'social' recommendation must be shown as a social-first signal, not
    -- implied to be backed by broader search demand it never had.
    ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS evidence_basis TEXT
      CHECK (evidence_basis IN ('search', 'social', 'mixed'));

    -- Explicit team feedback on a recommendation -- a product mutation,
    -- gated server-side by EDITOR_TOKEN (see server.js), never publicly
    -- writable. reversed_at is a soft-delete: "Undo" and the hidden-items
    -- manager both need the original row to still exist for audit, never
    -- a hard DELETE.
    -- recommendation_id is nullable with ON DELETE SET NULL, NOT a plain
    -- CASCADE -- buildReport() deletes and rebuilds a report's
    -- recommendations on every same-day re-run (a manual Refresh fired
    -- twice before midnight), which is a normal, expected, supported
    -- operation. A CASCADE here would silently destroy every feedback
    -- decision ever recorded against that day's recommendations the
    -- moment someone clicks Refresh again. microtrend_id/action_fingerprint
    -- are stored directly on this row specifically so the exclusion rules
    -- (deriveExclusions) never need a live recommendation_id to work --
    -- losing the FK link on a rebuild loses only the "which exact
    -- recommendation row" audit detail, never the suppression itself.
    CREATE TABLE IF NOT EXISTS recommendation_feedback (
      id SERIAL PRIMARY KEY,
      recommendation_id INTEGER REFERENCES recommendations(id) ON DELETE SET NULL,
      microtrend_id INTEGER REFERENCES microtrends(id),
      action_fingerprint TEXT,
      feedback_type TEXT NOT NULL CHECK (feedback_type IN ('useful','already_covered','not_relevant','dont_show_again')),
      reason TEXT,
      existing_content_url TEXT,
      note TEXT,
      content_status TEXT CHECK (content_status IN ('planned','published')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reversed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_microtrend ON recommendation_feedback(microtrend_id);
    CREATE INDEX IF NOT EXISTS idx_feedback_fingerprint ON recommendation_feedback(action_fingerprint);
    -- Additive repair for any instance where the table above already
    -- existed with the old NOT NULL + CASCADE definition (CREATE TABLE IF
    -- NOT EXISTS is a no-op against it) -- drops the old CASCADE
    -- constraint and replaces it with SET NULL, same pattern as every
    -- other post-creation ALTER in this file.
    ALTER TABLE recommendation_feedback ALTER COLUMN recommendation_id DROP NOT NULL;
    ALTER TABLE recommendation_feedback DROP CONSTRAINT IF EXISTS recommendation_feedback_recommendation_id_fkey;
    ALTER TABLE recommendation_feedback ADD CONSTRAINT recommendation_feedback_recommendation_id_fkey
      FOREIGN KEY (recommendation_id) REFERENCES recommendations(id) ON DELETE SET NULL;

    -- Idea Tracker: one row per stable action_fingerprint, not one row per
    -- daily appearance -- appearance history (first/last_recommended_at,
    -- recommendation_count) is computed on read from the real
    -- recommendations rows (see getIdeas) rather than hand-maintained
    -- counters here, so there's nothing to keep in sync and no same-day-
    -- rebuild double-counting risk. This table only holds what genuinely
    -- has no other home: the editable workflow state.
    -- workflow_status and feedback_type are deliberately different
    -- concepts that must never be conflated -- workflow_status lives here
    -- (it's not a trend judgment, it's "where is this in our pipeline");
    -- feedback_type is NOT duplicated onto this table at all, it's read
    -- live from recommendation_feedback (the existing feedback system) by
    -- action_fingerprint, so there is exactly one place that can go stale.
    CREATE TABLE IF NOT EXISTS ideas (
      id SERIAL PRIMARY KEY,
      action_fingerprint TEXT NOT NULL UNIQUE,
      workflow_status TEXT NOT NULL DEFAULT 'new'
        CHECK (workflow_status IN ('new','reviewing','planned','in_production','implemented','ignored')),
      owner TEXT,
      notes TEXT,
      content_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_ideas_workflow_status ON ideas(workflow_status);

    -- Audit trail for workflow_status/owner/notes/content_url edits --
    -- feedback_type changes are already auditable via recommendation_feedback's
    -- own created_at/reversed_at, so this table is scoped to the fields
    -- that are unique to the Idea Tracker.
    CREATE TABLE IF NOT EXISTS idea_status_history (
      id SERIAL PRIMARY KEY,
      idea_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
      field TEXT NOT NULL,
      previous_value TEXT,
      new_value TEXT,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_idea_status_history_idea ON idea_status_history(idea_id);

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

async function setReportAiStatus(reportId, available, reason) {
  const res = await pool.query(
    `UPDATE reports SET ai_analysis_available = $2, ai_analysis_reason = $3 WHERE id = $1 RETURNING *`,
    [reportId, available, reason || null]
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
                                   opportunity_name, continuity_status, action_fingerprint, continuity_meta, strategy_output,
                                   microtrend_id, recommendation_kind, recommended_action, evidence_basis)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING *`,
    [
      reportId, rec.rank, rec.actionType, rec.theme || null, rec.title, rec.rationale, rec.audience || null,
      rec.state || 'National', rec.suggestedChannel || null, rec.freshness || null,
      rec.confidence, rec.score, JSON.stringify(rec.scoreComponents),
      rec.momentumSources && rec.momentumSources.length > 0 ? JSON.stringify(rec.momentumSources) : null,
      rec.opportunityName || null,
      rec.continuityStatus || null,
      rec.actionFingerprint || null,
      rec.continuityMeta ? JSON.stringify(rec.continuityMeta) : null,
      rec.strategyOutput ? JSON.stringify(rec.strategyOutput) : null,
      rec.microtrendId || null,
      rec.recommendationKind || null,
      rec.recommendedAction || null,
      rec.evidenceBasis || null
    ]
  );
  return res.rows[0];
}

// Create-or-touch a microtrend by its (theme, normalized_key) identity --
// the clustering layer (src/microtrends.js) decides that key, this just
// persists it. On conflict, only last_seen_at and candidate_type move
// forward (a candidate can be reclassified as evidence accumulates, e.g.
// macro -> known); first_seen_at, status, display_name and
// baseline_shown_at are left alone here deliberately -- status/baseline
// transitions are explicit decisions made elsewhere (reportBuilder.js),
// never a side effect of simply observing the same candidate again.
// semanticMerges: candidates Claude unified into this microtrend that
// deterministic string clustering missed on its own (src/candidateAnalyst.js)
// -- appended and de-duplicated via jsonb_array_elements rather than
// overwritten, so the audit trail of every wording Claude has ever folded
// into this microtrend accumulates across days instead of only showing
// today's merge.
async function upsertMicrotrend(microtrend) {
  const res = await pool.query(
    `INSERT INTO microtrends (theme, normalized_key, display_name, source_wording, candidate_type, first_seen_at, last_seen_at, semantic_merges)
     VALUES ($1,$2,$3,$4,$5,$6,$6,$7)
     ON CONFLICT (theme, normalized_key) DO UPDATE SET
       last_seen_at = EXCLUDED.last_seen_at,
       candidate_type = EXCLUDED.candidate_type,
       semantic_merges = (
         SELECT COALESCE(jsonb_agg(DISTINCT elem), '[]'::jsonb)
         FROM jsonb_array_elements(COALESCE(microtrends.semantic_merges, '[]'::jsonb) || COALESCE(EXCLUDED.semantic_merges, '[]'::jsonb)) elem
       ),
       updated_at = now()
     RETURNING *`,
    [
      microtrend.theme, microtrend.normalizedKey, microtrend.displayName, microtrend.sourceWording || null,
      microtrend.candidateType, microtrend.observedDate, JSON.stringify(microtrend.semanticMerges || [])
    ]
  );
  return res.rows[0];
}

async function setMicrotrendStatus(microtrendId, status, extra = {}) {
  const res = await pool.query(
    `UPDATE microtrends SET status = $2, baseline_shown_at = COALESCE($3, baseline_shown_at), updated_at = now() WHERE id = $1 RETURNING *`,
    [microtrendId, status, extra.baselineShownAt || null]
  );
  return res.rows[0];
}

async function getMicrotrendsForTheme(theme) {
  const res = await pool.query('SELECT * FROM microtrends WHERE theme = $1', [theme]);
  return res.rows;
}

async function updateMicrotrendScore(microtrendId, reportId, score, components) {
  const res = await pool.query(
    `UPDATE microtrends SET last_score = $2, last_score_components = $3, last_scored_report_id = $4, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [microtrendId, score, JSON.stringify(components), reportId]
  );
  return res.rows[0];
}

// Every microtrend actually observed in this report, regardless of whether
// it won a recommendation slot -- the Emerging section's data source. One
// row per microtrend with its own today's observations nested, newest
// evidence count included so the UI can show "N evidence items" without a
// second round trip.
async function getMicrotrendsForReport(reportId) {
  const res = await pool.query(
    `SELECT m.*,
            COALESCE(obs.observations, '[]'::json) AS today_observations,
            COALESCE(ev.evidence_count, 0) AS today_evidence_count
     FROM microtrends m
     JOIN (SELECT DISTINCT microtrend_id FROM microtrend_observations WHERE report_id = $1) seen ON seen.microtrend_id = m.id
     LEFT JOIN (
       SELECT microtrend_id, json_agg(json_build_object(
         'sourceType', source_type, 'metricType', metric_type, 'metricValue', metric_value,
         'evidenceCount', evidence_count, 'sourceNativeClassification', source_native_classification,
         'uniqueCreatorCount', unique_creator_count
       )) AS observations
       FROM microtrend_observations WHERE report_id = $1 GROUP BY microtrend_id
     ) obs ON obs.microtrend_id = m.id
     LEFT JOIN (
       SELECT microtrend_id, COUNT(*) AS evidence_count FROM microtrend_evidence WHERE report_id = $1 GROUP BY microtrend_id
     ) ev ON ev.microtrend_id = m.id`,
    [reportId]
  );
  return res.rows;
}

// All of a microtrend's own observation history, oldest first -- used for
// the novelty/material-change gate (has this macro's source mix or
// velocity ever looked different from today) and for display.
async function getMicrotrendObservationHistory(microtrendId) {
  const res = await pool.query(
    `SELECT o.*, r.report_date FROM microtrend_observations o
     JOIN reports r ON r.id = o.report_id
     WHERE o.microtrend_id = $1 ORDER BY r.report_date ASC`,
    [microtrendId]
  );
  return res.rows;
}

async function recordMicrotrendObservation(reportId, obs) {
  const res = await pool.query(
    `INSERT INTO microtrend_observations (report_id, microtrend_id, source_type, metric_type, metric_value, evidence_count, unique_creator_count, source_native_classification)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (report_id, microtrend_id, source_type, metric_type) DO UPDATE SET
       metric_value = EXCLUDED.metric_value,
       evidence_count = EXCLUDED.evidence_count,
       unique_creator_count = EXCLUDED.unique_creator_count,
       source_native_classification = EXCLUDED.source_native_classification
     RETURNING *`,
    [reportId, obs.microtrendId, obs.sourceType, obs.metricType, obs.metricValue ?? null, obs.evidenceCount || 0, obs.uniqueCreatorCount ?? null, obs.sourceNativeClassification || null]
  );
  return res.rows[0];
}

async function linkMicrotrendEvidence(microtrendId, reportId, sourceItemId, matchType) {
  await pool.query(
    `INSERT INTO microtrend_evidence (microtrend_id, report_id, source_item_id, match_type)
     VALUES ($1,$2,$3,$4) ON CONFLICT (microtrend_id, report_id, source_item_id) DO NOTHING`,
    [microtrendId, reportId, sourceItemId, matchType]
  );
}

async function getMicrotrendEvidence(microtrendId, reportId) {
  const res = await pool.query(
    `SELECT me.match_type, si.* FROM microtrend_evidence me
     JOIN source_items si ON si.id = me.source_item_id
     WHERE me.microtrend_id = $1 AND me.report_id = $2
     ORDER BY si.collected_at DESC`,
    [microtrendId, reportId]
  );
  return res.rows;
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

// Microtrend-scoped equivalent of getRecentRecommendations -- a theme can
// win a recommendation slot under a DIFFERENT microtrend every few days, so
// continuity (new/continuing/strengthening/...) must be judged against this
// specific microtrend's own history, never the theme's combined history,
// or a genuinely brand-new microtrend under a long-running theme would be
// wrongly called "continuing".
async function getRecentRecommendationsForMicrotrend(microtrendId, reportDate, days = 14, excludeReportId = null) {
  const res = await pool.query(
    `SELECT rec.*, r.report_date
     FROM recommendations rec
     JOIN reports r ON r.id = rec.report_id
     WHERE rec.microtrend_id = $1
       AND r.report_date < $2::date
       AND r.report_date >= $2::date - ($3 || ' days')::interval
       AND ($4::int IS NULL OR rec.report_id != $4)
     ORDER BY r.report_date DESC`,
    [microtrendId, reportDate, days, excludeReportId]
  );
  return res.rows;
}

// How many times this specific microtrend has already won a recommendation
// slot recently -- feeds microtrendScoring's novelty penalty (brief: never
// present the same idea as if it were new just because the surrounding
// theme is still active). Excludes the current report like
// getRecentRecommendations does, for the same reason.
async function countRecentMicrotrendRecommendations(microtrendId, reportDate, days = 30, excludeReportId = null) {
  const res = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM recommendations rec
     JOIN reports r ON r.id = rec.report_id
     WHERE rec.microtrend_id = $1
       AND r.report_date < $2::date
       AND r.report_date >= $2::date - ($3 || ' days')::interval
       AND ($4::int IS NULL OR rec.report_id != $4)`,
    [microtrendId, reportDate, days, excludeReportId]
  );
  return Number(res.rows[0]?.count) || 0;
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

// Appearance counts + last-recommended date per theme, STRICTLY BEFORE
// reportDate -- the same boundary getRecentRecommendations/
// getRecentRecommendationsForMicrotrend use for a recommendation card's
// own "recommended N times in the last 14 days" text. This used to be
// `<=` (inclusive of reportDate itself), which silently counted today's
// own just-created recommendation on the theme card while the priority
// card's own count for the exact same theme, same day, excluded it --
// an off-by-one a reader would notice comparing the two numbers side by
// side. Both now mean the same thing: appearances BEFORE today, not
// counting today as its own appearance.
async function getThemeRecommendationStats(themes, reportDate) {
  if (themes.length === 0) return {};
  const res = await pool.query(
    `SELECT rec.theme,
            COUNT(*) FILTER (WHERE r.report_date > $2::date - interval '14 days') AS count_14d,
            COUNT(*) FILTER (WHERE r.report_date > $2::date - interval '30 days') AS count_30d,
            MAX(r.report_date) AS last_recommended_date
     FROM recommendations rec
     JOIN reports r ON r.id = rec.report_id
     WHERE rec.theme = ANY($1) AND r.report_date < $2::date
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

// Used by the feedback endpoint to pull microtrend_id/action_fingerprint
// straight from the real stored recommendation rather than trust whatever
// the client happens to send -- a client-supplied id/fingerprint could be
// stale or simply wrong, and that's exactly what the exclusion rules key on.
async function getRecommendationById(id) {
  const res = await pool.query('SELECT * FROM recommendations WHERE id = $1', [id]);
  return res.rows[0] || null;
}

// Feedback is a product mutation -- callers (server.js) must have already
// checked EDITOR_TOKEN before reaching this. Validation of feedbackType/
// contentStatus against the DB's own CHECK constraints happens at the SQL
// layer; server.js also validates before calling, so a bad value is
// rejected with a clear 400 rather than a raw constraint-violation error.
async function insertFeedback(feedback) {
  const res = await pool.query(
    `INSERT INTO recommendation_feedback (recommendation_id, microtrend_id, action_fingerprint, feedback_type, reason, existing_content_url, note, content_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      feedback.recommendationId, feedback.microtrendId || null, feedback.actionFingerprint || null,
      feedback.feedbackType, feedback.reason || null, feedback.existingContentUrl || null,
      feedback.note || null, feedback.contentStatus || null
    ]
  );
  return res.rows[0];
}

async function restoreFeedback(feedbackId) {
  const res = await pool.query(
    `UPDATE recommendation_feedback SET reversed_at = now() WHERE id = $1 AND reversed_at IS NULL RETURNING *`,
    [feedbackId]
  );
  return res.rows[0] || null;
}

// Everything currently suppressing something -- the "Manage covered and
// hidden items" view reads this directly; restoring one is just
// restoreFeedback() on its id.
// LEFT JOINs throughout -- recommendation_id can be null after a same-day
// report rebuild (see recommendation_feedback's own ON DELETE SET NULL
// comment above); an INNER join would silently drop that feedback row
// from the hidden/covered manager the moment its original recommendation
// row was rebuilt, even though the feedback itself is still active and
// still suppressing. theme/opportunity_name fall back to the microtrend's
// own theme/display_name when the recommendation link is gone.
async function listActiveFeedback(feedbackTypes = null) {
  const res = await pool.query(
    `SELECT f.*, COALESCE(rec.theme, m.theme) AS theme,
            COALESCE(rec.opportunity_name, m.display_name) AS opportunity_name,
            m.display_name AS microtrend_display_name
     FROM recommendation_feedback f
     LEFT JOIN recommendations rec ON rec.id = f.recommendation_id
     LEFT JOIN microtrends m ON m.id = f.microtrend_id
     WHERE f.reversed_at IS NULL ${feedbackTypes ? 'AND f.feedback_type = ANY($1)' : ''}
     ORDER BY f.created_at DESC`,
    feedbackTypes ? [feedbackTypes] : []
  );
  return res.rows;
}

// The 3 deterministic exclusion rules (brief section 8) as one query,
// called once per report build rather than once per candidate --
// not_relevant excludes the whole microtrend cluster; dont_show_again and
// already_covered both key off action_fingerprint (the specific proposed
// angle), not the underlying trend, so a genuinely different angle on the
// same real trend is never blocked by either.
// Unions two independently-sourced exclusion signals: feedback-derived
// ones (deriveExclusions, from recommendation_feedback) and workflow-
// derived ones -- an idea marked `implemented` suppresses its own
// action_fingerprint the same way dont_show_again/already_covered do,
// since presenting it again as a "new" idea would be wrong; `ignored`
// deliberately does NOT suppress anything (a human chose to skip it once,
// not to permanently hide it).
async function getActiveExclusions() {
  const feedbackRes = await pool.query(
    `SELECT feedback_type, microtrend_id, action_fingerprint FROM recommendation_feedback WHERE reversed_at IS NULL`
  );
  const exclusions = deriveExclusions(feedbackRes.rows);
  const implementedRes = await pool.query(`SELECT action_fingerprint FROM ideas WHERE workflow_status = 'implemented'`);
  for (const row of implementedRes.rows) exclusions.suppressedFingerprints.add(row.action_fingerprint);
  return exclusions;
}

// Ensures a row exists for this action_fingerprint so the Idea Tracker has
// something to show/edit the moment a recommendation using it is created
// -- workflow_status/owner/notes/content_url are never touched here, only
// a human (or a future PATCH) ever changes them.
async function ensureIdeaExists(actionFingerprint) {
  const res = await pool.query(
    `INSERT INTO ideas (action_fingerprint) VALUES ($1) ON CONFLICT (action_fingerprint) DO NOTHING RETURNING *`,
    [actionFingerprint]
  );
  if (res.rows[0]) return res.rows[0];
  const existing = await pool.query('SELECT * FROM ideas WHERE action_fingerprint = $1', [actionFingerprint]);
  return existing.rows[0];
}

async function getIdeaByFingerprint(actionFingerprint) {
  const res = await pool.query('SELECT * FROM ideas WHERE action_fingerprint = $1', [actionFingerprint]);
  return res.rows[0] || null;
}

// For giving feedback FROM the Idea Tracker, which operates per
// action_fingerprint (one row per idea), not per daily recommendation --
// this finds the most recent real recommendation row for that fingerprint
// so the feedback can still carry a real recommendation_id/microtrend_id,
// same shape insertFeedback already expects.
async function getMostRecentRecommendationByFingerprint(actionFingerprint) {
  const res = await pool.query(
    `SELECT rec.* FROM recommendations rec JOIN reports r ON r.id = rec.report_id
     WHERE rec.action_fingerprint = $1 ORDER BY r.report_date DESC LIMIT 1`,
    [actionFingerprint]
  );
  return res.rows[0] || null;
}

// Appearance history (first/last_recommended_at, recommendation_count,
// theme, tier, source_types, opportunity_name) is computed live from the
// real recommendations history, keyed by action_fingerprint -- never a
// hand-maintained counter, so there's nothing that can drift out of sync
// with a same-day report rebuild. feedback_type is read live from
// recommendation_feedback (latest non-reversed row for that fingerprint),
// kept deliberately separate from workflow_status per the brief.
async function getIdeas(filters = {}) {
  const conditions = ['agg.action_fingerprint IS NOT NULL'];
  const params = [];
  function addParam(value) {
    params.push(value);
    return `$${params.length}`;
  }
  if (filters.actionFingerprint) conditions.push(`i.action_fingerprint = ${addParam(filters.actionFingerprint)}`);
  if (filters.theme) conditions.push(`agg.theme = ${addParam(filters.theme)}`);
  if (filters.microtrendId) conditions.push(`agg.microtrend_id = ${addParam(filters.microtrendId)}`);
  if (filters.tier) conditions.push(`agg.tier = ${addParam(filters.tier)}`);
  if (filters.source) conditions.push(`agg.source_types @> ${addParam(JSON.stringify([filters.source]))}::jsonb`);
  if (filters.fromDate) conditions.push(`agg.last_recommended_at >= ${addParam(filters.fromDate)}::date`);
  if (filters.toDate) conditions.push(`agg.first_recommended_at <= ${addParam(filters.toDate)}::date`);
  if (filters.workflowStatus) conditions.push(`i.workflow_status = ${addParam(filters.workflowStatus)}`);
  if (filters.search) {
    const param = addParam(`%${filters.search}%`);
    conditions.push(`(agg.opportunity_name ILIKE ${param} OR agg.recommended_action ILIKE ${param} OR i.notes ILIKE ${param})`);
  }

  // feedback_type filters against the live join below -- 'none' means
  // explicitly no active feedback, not "don't filter".
  let feedbackCondition = '';
  if (filters.feedbackType === 'none') feedbackCondition = 'AND latest_feedback.feedback_type IS NULL';
  else if (filters.feedbackType) feedbackCondition = `AND latest_feedback.feedback_type = ${addParam(filters.feedbackType)}`;

  const res = await pool.query(
    `WITH agg AS (
       SELECT rec.action_fingerprint,
              (array_agg(rec.theme ORDER BY r.report_date DESC))[1] AS theme,
              (array_agg(rec.microtrend_id ORDER BY r.report_date DESC))[1] AS microtrend_id,
              (array_agg(rec.opportunity_name ORDER BY r.report_date DESC))[1] AS opportunity_name,
              (array_agg(rec.recommended_action ORDER BY r.report_date DESC))[1] AS recommended_action,
              (array_agg(rec.suggested_channel ORDER BY r.report_date DESC))[1] AS suggested_channel,
              (array_agg(rec.action_type ORDER BY r.report_date DESC))[1] AS tier,
              (array_agg(rec.evidence_basis ORDER BY r.report_date DESC))[1] AS evidence_basis,
              (array_agg(DISTINCT s.source_type)) AS source_types,
              MIN(r.report_date) AS first_recommended_at,
              MAX(r.report_date) AS last_recommended_at,
              COUNT(DISTINCT r.id) AS recommendation_count
       FROM recommendations rec
       JOIN reports r ON r.id = rec.report_id
       LEFT JOIN recommendation_evidence re ON re.recommendation_id = rec.id
       LEFT JOIN source_items s ON s.id = re.source_item_id
       WHERE rec.action_fingerprint IS NOT NULL
       GROUP BY rec.action_fingerprint
     )
     SELECT i.*, agg.theme, agg.microtrend_id, agg.opportunity_name, agg.recommended_action, agg.suggested_channel,
            agg.tier, agg.evidence_basis, agg.source_types, agg.first_recommended_at, agg.last_recommended_at, agg.recommendation_count,
            latest_feedback.feedback_type
     FROM ideas i
     JOIN agg ON agg.action_fingerprint = i.action_fingerprint
     LEFT JOIN (
       SELECT DISTINCT ON (action_fingerprint) action_fingerprint, feedback_type
       FROM recommendation_feedback
       WHERE reversed_at IS NULL AND action_fingerprint IS NOT NULL
       ORDER BY action_fingerprint, created_at DESC
     ) latest_feedback ON latest_feedback.action_fingerprint = i.action_fingerprint
     WHERE ${conditions.join(' AND ')} ${feedbackCondition}
     ORDER BY agg.last_recommended_at DESC, agg.first_recommended_at DESC`,
    params
  );
  return res.rows;
}

// field: 'workflow_status' | 'owner' | 'notes' | 'content_url'. Logs
// previous -> new into idea_status_history for every field that actually
// changed, so the audit trail only grows when something real happened.
async function updateIdea(actionFingerprint, changes) {
  const idea = await getIdeaByFingerprint(actionFingerprint);
  if (!idea) return null;

  const fields = ['workflow_status', 'owner', 'notes', 'contentUrl'];
  const columnByField = { workflow_status: 'workflow_status', owner: 'owner', notes: 'notes', contentUrl: 'content_url' };
  const sets = [];
  const params = [idea.id];
  const historyEntries = [];

  for (const field of fields) {
    if (!(field in changes)) continue;
    const column = columnByField[field];
    const newValue = changes[field];
    const previousValue = idea[column];
    if (previousValue === newValue) continue;
    params.push(newValue);
    sets.push(`${column} = $${params.length}`);
    historyEntries.push({ field: column, previousValue, newValue });
  }
  if (sets.length === 0) return idea;

  const res = await pool.query(
    `UPDATE ideas SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    params
  );
  for (const entry of historyEntries) {
    await pool.query(
      `INSERT INTO idea_status_history (idea_id, field, previous_value, new_value) VALUES ($1,$2,$3,$4)`,
      [idea.id, entry.field, entry.previousValue, entry.newValue]
    );
  }
  return res.rows[0];
}

async function getIdeaHistory(actionFingerprint) {
  const idea = await getIdeaByFingerprint(actionFingerprint);
  if (!idea) return [];
  const res = await pool.query(
    `SELECT * FROM idea_status_history WHERE idea_id = $1 ORDER BY changed_at DESC`,
    [idea.id]
  );
  return res.rows;
}

// Summary counts for the Idea Tracker's compact header -- New, Planned +
// In production (grouped per the brief), Implemented, Ignored.
async function getIdeaStatusCounts() {
  const res = await pool.query(`SELECT workflow_status, COUNT(*)::int AS count FROM ideas GROUP BY workflow_status`);
  const byStatus = Object.fromEntries(res.rows.map((r) => [r.workflow_status, r.count]));
  return {
    new: byStatus.new || 0,
    reviewing: byStatus.reviewing || 0,
    plannedOrInProduction: (byStatus.planned || 0) + (byStatus.in_production || 0),
    implemented: byStatus.implemented || 0,
    ignored: byStatus.ignored || 0
  };
}

// Up to `limit` of the most recent "useful" examples for this theme, for
// the strategist prompt (brief section 8) -- stored as a positive example
// only, never rewrites evidence or boosts a score.
async function getPositiveFeedbackExamples(theme, limit = 5) {
  const res = await pool.query(
    `SELECT rec.opportunity_name, rec.rationale, rec.suggested_channel
     FROM recommendation_feedback f
     JOIN recommendations rec ON rec.id = f.recommendation_id
     WHERE f.feedback_type = 'useful' AND f.reversed_at IS NULL AND rec.theme = $1
     ORDER BY f.created_at DESC LIMIT $2`,
    [theme, limit]
  );
  return res.rows;
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
  // Every microtrend observed in THIS report, win or not -- the Emerging
  // section's data source (server.js excludes the ones that already won a
  // recommendation slot and the ones hidden by feedback).
  const microtrends = await getMicrotrendsForReport(report.id);

  return {
    report,
    signals: signalsRes.rows,
    recommendations: recsRes.rows.map((r) => ({ ...r, evidence: evidenceByRec.get(r.id) || [] })),
    providerRuns: providerRunsRes.rows,
    themeTrends,
    microtrends
  };
}

module.exports = {
  pool,
  DATA_STATUSES,
  initSchema,
  initSchemaWithRetry,
  getOrCreateReport,
  completeReport,
  setReportAiStatus,
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
  getRecentRecommendationsForMicrotrend,
  countRecentMicrotrendRecommendations,
  getSameDayRecommendations,
  tryAcquireIngestLock,
  releaseIngestLock,
  getThemeRecommendationStats,
  buildThemeTrendsSummary,
  consecutiveActiveDays,
  upsertMicrotrend,
  setMicrotrendStatus,
  getMicrotrendsForTheme,
  updateMicrotrendScore,
  getMicrotrendsForReport,
  getMicrotrendObservationHistory,
  recordMicrotrendObservation,
  linkMicrotrendEvidence,
  getMicrotrendEvidence,
  getRecommendationById,
  insertFeedback,
  restoreFeedback,
  listActiveFeedback,
  getActiveExclusions,
  getPositiveFeedbackExamples,
  ensureIdeaExists,
  getIdeaByFingerprint,
  getMostRecentRecommendationByFingerprint,
  getIdeas,
  updateIdea,
  getIdeaHistory,
  getIdeaStatusCounts
};
