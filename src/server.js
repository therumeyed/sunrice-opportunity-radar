require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const {
  pool, initSchemaWithRetry, getReportByDate, getLatestReport, listReportDates, getReportBundle,
  tryAcquireIngestLock, releaseIngestLock, getRecommendationById, insertFeedback, restoreFeedback, listActiveFeedback,
  getActiveExclusions, getIdeas, updateIdea, getIdeaHistory, getIdeaStatusCounts, getMostRecentRecommendationByFingerprint,
  recordBaselineSnapshot, getLatestBaselineSnapshot, getAllBaselineSnapshots, getOpenSourceHealthAlerts,
  getRejectedCandidates, getFitContradictions, getNotRelevantFeedbackForReview,
  getThemeExclusions, excludeTheme, reverseThemeExclusion
} = require('./db');
const { computeBaseline } = require('./baseline');
const { runHealthCheck } = require('./healthMonitor');
const { getEmailConfig } = require('./emailAlerts');
const { DISCLAIMER: SUNRICE_FIT_DISCLAIMER } = require('./sunriceFit');
const { urgencyNote } = require('./candidateLifecycle');
const { ALL_TOPICS } = require('./topics');
const { peakingEligible } = require('./themeLifecycle');
const { isSocialSourceType } = require('./microtrendExtraction');
const {
  FEEDBACK_TYPES, WRITABLE_FEEDBACK_TYPES, REASONS_BY_TYPE, NOT_RELEVANT_REASON_LABELS,
  validateFeedbackInput, themeReviewFlags
} = require('./feedback');
const { REASON_CODES } = require('./eligibility');

const app = express();

// Login wall: the entire dashboard (every static asset and every API
// route) is gated behind ONE shared password, checked via standard HTTP
// Basic Auth -- the browser's own native login prompt, no custom login
// page or session/cookie handling needed. This is a different, broader
// gate than ADMIN_TOKEN/EDITOR_TOKEN below, which only protect specific
// mutation endpoints while every report READ stays public; this gate
// blocks EVERYTHING, read or write, until the right password is given.
// Fails CLOSED: if SITE_PASSWORD isn't set, nobody gets in (never falls
// back to "no password configured means open access") -- the one
// exception is /health, which Render's own infrastructure may poll
// without credentials and which reveals nothing beyond "the process is
// up". Username is ignored; only the password is checked, with a
// constant-time comparison so response timing can't leak how much of a
// guessed password was correct.
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireSitePassword(req, res, next) {
  if (req.path === '/health') return next();
  if (!process.env.SITE_PASSWORD) {
    return res.status(503).send('This dashboard has no SITE_PASSWORD configured yet -- set one in Render to enable access.');
  }
  const header = req.get('Authorization') || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const password = decoded.slice(decoded.indexOf(':') + 1);
    if (timingSafeEqual(password, process.env.SITE_PASSWORD)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="SunRice Opportunity Radar", charset="UTF-8"');
  res.status(401).send('Password required.');
}

app.use(requireSitePassword);
app.use(express.static(path.join(__dirname, '..', 'public')));

const FEATURE_FLAGS = {
  local_visibility: process.env.FEATURE_LOCAL_VISIBILITY === 'true',
  digital_availability: process.env.FEATURE_DIGITAL_AVAILABILITY === 'true',
  competitor_pulse: process.env.FEATURE_COMPETITOR_PULSE === 'true',
  customer_voice: process.env.FEATURE_CUSTOMER_VOICE === 'true'
};

const THEME_LABEL_BY_KEY = Object.fromEntries(ALL_TOPICS.map((t) => [t.theme, t.label]));
const AUDIENCES = ['parents', 'families', 'home cooks', 'health-conscious', 'multicultural audiences', 'general'];
const STATES = ['National', 'VIC', 'NSW', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT'];

// X-Admin-Token, not Authorization: Bearer -- the site-wide login wall
// (requireSitePassword) already owns the Authorization header for the
// whole app's Basic Auth. A browser that's already passed that gate
// auto-attaches its Basic credentials to every request on this origin;
// an explicit `Authorization: Bearer <token>` from the frontend would
// silently REPLACE that Basic header instead of adding to it (HTTP allows
// only one Authorization header per request), locking the admin/editor
// actions out behind the site gate they'd just passed. A dedicated header
// has no such collision.
function requireAdmin(req, res, next) {
  const token = req.get('X-Admin-Token');
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

// Same session-scoped-token UX as ADMIN_TOKEN (browser prompt(),
// X-Editor-Token header, sessionStorage on the frontend) but a separate
// token and a separate env var -- feedback is a distinct, lower-risk write
// than triggering a paid ingest run, and read access to feedback (the
// hidden/covered-items manager) stays public same as every other report
// read in this app; only the mutations below are gated.
function requireEditor(req, res, next) {
  const token = req.get('X-Editor-Token');
  if (!process.env.EDITOR_TOKEN || token !== process.env.EDITOR_TOKEN) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

function serializeFeedback(row) {
  return {
    id: row.id,
    recommendationId: row.recommendation_id,
    microtrendId: row.microtrend_id,
    microtrendDisplayName: row.microtrend_display_name || null,
    theme: row.theme || null,
    opportunityName: row.opportunity_name || null,
    actionFingerprint: row.action_fingerprint,
    feedbackType: row.feedback_type,
    reason: row.reason,
    reasonCode: row.reason_code,
    existingContentUrl: row.existing_content_url,
    note: row.note,
    contentStatus: row.content_status,
    createdAt: row.created_at,
    reversedAt: row.reversed_at
  };
}

function applyFilters(bundle, query) {
  const { theme, audience, state, lifecycle } = query;
  let recommendations = bundle.recommendations;
  let signals = bundle.signals;
  let themeTrends = bundle.themeTrends;
  let microtrends = bundle.microtrends;

  if (theme) {
    recommendations = recommendations.filter((r) => r.theme === theme);
    signals = signals.filter((s) => s.theme === theme);
    themeTrends = themeTrends.filter((t) => t.theme === theme);
    microtrends = microtrends.filter((m) => m.theme === theme);
  }
  if (audience) recommendations = recommendations.filter((r) => r.audience === audience);
  if (state) recommendations = recommendations.filter((r) => r.state === state || r.state === 'National');
  if (lifecycle) signals = signals.filter((s) => s.lifecycle === lifecycle);
  // audience/state deliberately never filter themeTrends/microtrends --
  // neither is truly calculated per audience/state; the theme filter
  // narrows both, nothing else does.

  return { ...bundle, recommendations, signals, themeTrends, microtrends };
}

// isSocialOnly/evidenceBasis are derived here from TODAY's own observation
// mix (never stored on the microtrend row itself, which can span many
// days and source mixes) -- same "every contributing source_type is a real
// social platform" rule as reportBuilder.js's winning-candidate gate, just
// recomputed for display across every tracked microtrend, not only the one
// that won a slot.
function serializeMicrotrend(m) {
  const todayObservations = m.today_observations || [];
  const isSocialOnly = todayObservations.length > 0 && todayObservations.every((o) => isSocialSourceType(o.sourceType));
  const hasSocial = todayObservations.some((o) => isSocialSourceType(o.sourceType));
  return {
    id: m.id,
    theme: m.theme,
    displayName: m.display_name,
    sourceWording: m.source_wording,
    candidateType: m.candidate_type,
    status: m.status,
    firstSeenAt: m.first_seen_at,
    lastSeenAt: m.last_seen_at,
    score: m.last_score != null ? Number(m.last_score) : null,
    scoreComponents: m.last_score_components,
    // Stage 5: stored for every observed candidate regardless of outcome
    // (same "store now" reasoning as score above) -- a Low band is why a
    // candidate sits in Emerging rather than winning a slot.
    sunriceFit: m.sunrice_fit_score != null
      ? { score: m.sunrice_fit_score, band: m.sunrice_fit_band, components: m.sunrice_fit_components, disclaimer: SUNRICE_FIT_DISCLAIMER }
      : null,
    // Stage 6: candidate-level lifecycle, distinct from theme-level
    // lifecycle -- recomputed from the live function rather than a stored
    // column here (unlike recommendations, nothing write-time to snapshot).
    candidateLifecycle: m.candidate_lifecycle,
    urgencyNote: urgencyNote(m.candidate_lifecycle),
    todayObservations,
    todayEvidenceCount: Number(m.today_evidence_count) || 0,
    isSocialOnly,
    evidenceBasis: isSocialOnly ? 'social' : hasSocial ? 'mixed' : 'search'
  };
}

async function serializeBundle(bundle) {
  const exclusions = await getActiveExclusions();
  const winningMicrotrendIds = new Set(bundle.recommendations.filter((r) => r.microtrend_id).map((r) => r.microtrend_id));
  // Stage 3's one public-facing piece (brief: "show dashboard users when
  // an outage materially limits the evidence behind recommendations") --
  // a plain, honest notice, never scraper internals (no source names, no
  // error text, no alert type). AI-analysis outages already get their own
  // explicit message above, so this only looks at real scraper sources.
  const openAlerts = await getOpenSourceHealthAlerts();
  const scraperOutage = openAlerts.some((a) => a.source_type !== 'ai_analysis');
  return {
    report: {
      date: bundle.report.report_date,
      status: bundle.report.status,
      generatedAt: bundle.report.generated_at,
      providerSummary: bundle.report.provider_summary,
      // null = this report predates the mandatory-AI pipeline. false means
      // the Claude candidate analysis failed (no key, or failed after one
      // retry) -- the UI must show "AI analysis unavailable" distinctly
      // from a day where AI ran fine and genuinely found nothing to
      // recommend, which looks identical otherwise (zero recommendations).
      aiAnalysisAvailable: bundle.report.ai_analysis_available,
      aiAnalysisReason: bundle.report.ai_analysis_reason,
      evidenceOutageNotice: scraperOutage
        ? "One or more data sources are currently having trouble collecting new evidence -- today's recommendations may be based on less evidence than usual."
        : null
    },
    recommendations: bundle.recommendations.map((r) => ({
      id: r.id,
      rank: r.rank,
      actionType: r.action_type,
      theme: r.theme,
      title: r.title,
      rationale: r.rationale,
      audience: r.audience,
      state: r.state,
      suggestedChannel: r.suggested_channel,
      freshness: r.freshness,
      confidence: r.confidence,
      score: Number(r.score),
      scoreComponents: r.score_components,
      momentumSources: r.momentum_sources || [],
      opportunityName: r.opportunity_name || r.title,
      continuityStatus: r.continuity_status,
      continuityMeta: r.continuity_meta,
      // Stage 4 (IMPLEMENTATION_CHECKLIST.md): set only when this
      // recommendation is resurfacing a previously rejected candidate --
      // "store and display a short explanation of why."
      resurfacingNote: r.resurfacing_note,
      // Stage 5: write-time snapshot, null for a theme_disclaimer
      // recommendation (no Claude assessment exists for that kind).
      sunriceFit: r.sunrice_fit_score != null
        ? { score: r.sunrice_fit_score, band: r.sunrice_fit_band, components: r.sunrice_fit_components, disclaimer: SUNRICE_FIT_DISCLAIMER }
        : null,
      // Stage 6 (IMPLEMENTATION_CHECKLIST.md): candidate-level lifecycle --
      // a SEPARATE concept from the theme-level lifecycle shown on the
      // Thematic trends card. urgencyNote is informational only, never a
      // gate, and null in the normal (established/emerging/insufficient-
      // history) case.
      candidateLifecycle: r.candidate_lifecycle,
      urgencyNote: r.urgency_note,
      recommendationKind: r.recommendation_kind,
      microtrendId: r.microtrend_id,
      recommendedAction: r.recommended_action,
      // Write-time snapshot of what grounded THIS recommendation (never
      // recomputed later) -- 'social' must never be shown as if it were
      // broader search demand. See reportBuilder.js buildCandidateRecommendation.
      evidenceBasis: r.evidence_basis,
      evidence: r.evidence.map((e) => ({
        id: e.id,
        note: e.note,
        sourceType: e.source_type,
        sourceName: e.source_name,
        sourceUrl: e.source_url,
        title: e.title,
        excerpt: e.excerpt,
        author: e.author,
        publishedAt: e.published_at,
        collectedAt: e.collected_at,
        queryOrTopic: e.query_or_topic,
        geography: e.geography,
        geographyConfidence: e.geography_confidence,
        contentFormat: e.content_format,
        productConnection: e.product_connection || [],
        rawMetrics: e.raw_metrics,
        normalizedMetrics: e.normalized_metrics,
        dataStatus: e.data_status
      }))
    })),
    signals: bundle.signals.map((s) => ({
      id: s.id,
      signalType: s.signal_type,
      topic: s.topic,
      platform: s.platform,
      theme: s.theme,
      audience: s.audience,
      state: s.state,
      metricSummary: s.metric_summary,
      lifecycle: s.lifecycle,
      momentum: s.momentum,
      firstDetectedAt: s.first_detected_at,
      dataStatus: s.data_status
    })),
    providerRuns: bundle.providerRuns.map((p) => ({
      id: p.id,
      providerName: p.provider_name,
      sourceType: p.source_type,
      status: p.status,
      startedAt: p.started_at,
      finishedAt: p.finished_at,
      cost: p.cost,
      error: p.error
    })),
    // National theme momentum -- deliberately not filtered by audience/state,
    // which aren't truly calculated at the theme level; the theme filter
    // narrows it, nothing else does. peakingEligible says whether a
    // "peaking" verdict is even possible yet, independent of whether
    // today's pattern happens to match it -- the UI uses this to say
    // "insufficient history" rather than implying a young theme was
    // checked and simply isn't peaking.
    themeTrends: (bundle.themeTrends || []).map((t) => ({
      ...t,
      label: THEME_LABEL_BY_KEY[t.theme] || t.theme,
      peakingEligible: peakingEligible(t.observationCount)
    })),
    // "What's emerging" (brief: the dashboard's second tier, between
    // "what to act on today" and theme-level momentum) -- every real
    // microtrend observed today that did NOT win a recommendation slot,
    // and isn't hidden by "not relevant" feedback, sorted by its own
    // deterministic score. Never padded, never re-ranked by an LLM.
    microtrendsEmerging: (bundle.microtrends || [])
      .filter((m) => !winningMicrotrendIds.has(m.id) && !exclusions.hiddenMicrotrendIds.has(m.id))
      .sort((a, b) => Number(b.last_score || 0) - Number(a.last_score || 0))
      .map((m) => ({ ...serializeMicrotrend(m), label: THEME_LABEL_BY_KEY[m.theme] || m.theme })),
    featureFlags: FEATURE_FLAGS
  };
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/api/meta', (req, res) => {
  res.json({
    themes: ALL_TOPICS.map((t) => ({ value: t.theme, label: t.label })),
    audiences: AUDIENCES,
    states: STATES,
    featureFlags: FEATURE_FLAGS
  });
});

app.get('/api/reports/latest', async (req, res) => {
  const report = await getLatestReport();
  if (!report) return res.status(404).json({ error: 'no completed reports yet' });
  const bundle = await getReportBundle(report);
  res.json(await serializeBundle(applyFilters(bundle, req.query)));
});

app.get('/api/reports/dates', async (req, res) => {
  const to = req.query.to || new Date().toISOString().slice(0, 10);
  const from = req.query.from || new Date(new Date(to).getTime() - 90 * 86400000).toISOString().slice(0, 10);
  const dates = await listReportDates(from, to);
  res.json({ dates: dates.map((d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d)) });
});

app.get('/api/reports/:date', async (req, res) => {
  const report = await getReportByDate(req.params.date);
  if (!report) return res.status(404).json({ error: `no completed report for ${req.params.date}` });
  const bundle = await getReportBundle(report);
  res.json(await serializeBundle(applyFilters(bundle, req.query)));
});

app.use(express.json());

// Static reason-list metadata (brief: "reason lists") -- public, no token,
// same as /api/meta. The frontend's feedback dropdowns are populated from
// this rather than a hard-coded copy, so adding a reason here is the only
// place that needs editing.
// Stage 7: writableFeedbackTypes/notRelevantReasons are what the current
// UI actually uses (2 verdicts, 6 shared reason codes); feedbackTypes/
// reasonsByType stay for rendering historical rows under their original
// labels (Hidden & covered manager, Idea Tracker) -- never for writing.
app.get('/api/feedback/reasons', (req, res) => {
  res.json({
    feedbackTypes: FEEDBACK_TYPES,
    reasonsByType: REASONS_BY_TYPE,
    writableFeedbackTypes: WRITABLE_FEEDBACK_TYPES,
    notRelevantReasons: REASON_CODES.map((code) => ({ code, label: NOT_RELEVANT_REASON_LABELS[code] }))
  });
});

// The hidden/covered-items manager's data source -- read access is public,
// matching every other report read in this app; only creating/undoing
// feedback is gated behind EDITOR_TOKEN below. ?type=already_covered etc.
// to narrow; omitted returns every active (non-reversed) row.
app.get('/api/feedback/active', async (req, res) => {
  const types = req.query.type ? [req.query.type] : null;
  const rows = await listActiveFeedback(types);
  res.json({ feedback: rows.map(serializeFeedback) });
});

// Writing feedback is a product mutation (the brief's explicit reason for
// gating it behind EDITOR_TOKEN): microtrendId/actionFingerprint are read
// from the recommendation this feedback is actually about, never trusted
// from the client, so a stale or forged value can't corrupt the exclusion
// rules deriveExclusions() depends on.
app.post('/api/recommendations/:id/feedback', requireEditor, async (req, res) => {
  const recommendation = await getRecommendationById(req.params.id);
  if (!recommendation) return res.status(404).json({ error: `no recommendation with id ${req.params.id}` });

  const { feedbackType, reasonCode, note, existingContentUrl, contentStatus } = req.body || {};
  const validation = validateFeedbackInput(feedbackType, { reasonCode, note, contentStatus });
  if (!validation.valid) return res.status(400).json({ error: validation.error });

  const row = await insertFeedback({
    recommendationId: recommendation.id,
    microtrendId: recommendation.microtrend_id,
    actionFingerprint: recommendation.action_fingerprint,
    feedbackType,
    reasonCode,
    note,
    existingContentUrl,
    contentStatus
  });
  res.status(201).json({ feedback: serializeFeedback(row) });
});

// Undo: never a hard delete -- reversed_at is set so the exclusion this
// feedback created stops applying (deriveExclusions only reads rows where
// reversed_at IS NULL) while the original decision stays in the audit trail.
app.post('/api/feedback/:id/undo', requireEditor, async (req, res) => {
  const row = await restoreFeedback(req.params.id);
  if (!row) return res.status(404).json({ error: `no active feedback with id ${req.params.id}` });
  res.json({ feedback: serializeFeedback(row) });
});

const WORKFLOW_STATUSES = ['new', 'reviewing', 'planned', 'in_production', 'implemented', 'ignored'];

function serializeIdea(row) {
  return {
    actionFingerprint: row.action_fingerprint,
    workflowStatus: row.workflow_status,
    owner: row.owner,
    notes: row.notes,
    contentUrl: row.content_url,
    theme: row.theme,
    themeLabel: THEME_LABEL_BY_KEY[row.theme] || row.theme,
    microtrendId: row.microtrend_id,
    opportunityName: row.opportunity_name,
    recommendedAction: row.recommended_action,
    suggestedChannel: row.suggested_channel,
    tier: row.tier,
    sourceTypes: row.source_types || [],
    firstRecommendedAt: row.first_recommended_at,
    lastRecommendedAt: row.last_recommended_at,
    recommendationCount: Number(row.recommendation_count),
    // Read live from recommendation_feedback, never duplicated storage --
    // deliberately a separate field from workflowStatus, never conflated.
    feedbackType: row.feedback_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// One row per stable action_fingerprint, not one row per daily appearance
// -- see src/db.js's getIdeas for how first/last_recommended_at and
// recommendation_count are computed live from the real recommendations
// history rather than a hand-maintained counter. Read access is public,
// same as every other report read; only PATCH/feedback below are gated.
app.get('/api/ideas', async (req, res) => {
  const { theme, microtrendId, workflowStatus, feedbackType, tier, source, fromDate, toDate, search } = req.query;
  const rows = await getIdeas({
    theme, microtrendId: microtrendId ? Number(microtrendId) : undefined, workflowStatus, feedbackType, tier, source, fromDate, toDate, search
  });
  res.json({ ideas: rows.map(serializeIdea) });
});

// Compact summary counts for the Idea Tracker's header -- New,
// Planned + In production (grouped per the brief), Implemented, Ignored.
app.get('/api/ideas/summary', async (req, res) => {
  res.json(await getIdeaStatusCounts());
});

app.get('/api/ideas/:fingerprint/history', async (req, res) => {
  const rows = await getIdeaHistory(req.params.fingerprint);
  res.json({ history: rows.map((r) => ({ field: r.field, previousValue: r.previous_value, newValue: r.new_value, changedAt: r.changed_at })) });
});

// workflow_status/owner/notes/content_url edits -- same EDITOR_TOKEN as
// the feedback controls. workflow_status and feedback_type are
// deliberately different fields with different meanings (see src/db.js);
// this endpoint only ever touches the former. Every changed field is
// logged to idea_status_history with its previous value.
app.patch('/api/ideas/:fingerprint', requireEditor, async (req, res) => {
  const { workflowStatus, owner, notes, contentUrl } = req.body || {};
  if (workflowStatus !== undefined && !WORKFLOW_STATUSES.includes(workflowStatus)) {
    return res.status(400).json({ error: `workflowStatus must be one of ${WORKFLOW_STATUSES.join(', ')}` });
  }
  const changes = {};
  if (workflowStatus !== undefined) changes.workflow_status = workflowStatus;
  if (owner !== undefined) changes.owner = owner;
  if (notes !== undefined) changes.notes = notes;
  if (contentUrl !== undefined) changes.contentUrl = contentUrl;

  const updated = await updateIdea(req.params.fingerprint, changes);
  if (!updated) return res.status(404).json({ error: `no idea with action_fingerprint ${req.params.fingerprint}` });
  const [detail] = await getIdeas({ actionFingerprint: req.params.fingerprint });
  res.json({ idea: serializeIdea(detail || updated) });
});

// Giving feedback FROM the Idea Tracker, which operates per idea
// (action_fingerprint), not per daily recommendation -- attaches to the
// most recent real recommendation row for that fingerprint, same
// validation and exclusion rules as the main dashboard's feedback
// controls (brief: "must update the same recommendation record").
app.post('/api/ideas/:fingerprint/feedback', requireEditor, async (req, res) => {
  const recommendation = await getMostRecentRecommendationByFingerprint(req.params.fingerprint);
  if (!recommendation) return res.status(404).json({ error: `no recommendation found for action_fingerprint ${req.params.fingerprint}` });

  const { feedbackType, reason, note, existingContentUrl, contentStatus } = req.body || {};
  const validation = validateFeedbackInput(feedbackType, { reason, note, contentStatus });
  if (!validation.valid) return res.status(400).json({ error: validation.error });

  const row = await insertFeedback({
    recommendationId: recommendation.id,
    microtrendId: recommendation.microtrend_id,
    actionFingerprint: recommendation.action_fingerprint,
    feedbackType, reason, note, existingContentUrl, contentStatus
  });
  res.status(201).json({ feedback: serializeFeedback(row) });
});

// Fire-and-forget: an ingestion run can take several minutes (bounded Apify
// polling in particular), far longer than a sane HTTP request should stay
// open. The client re-polls /api/reports/latest afterwards rather than this
// endpoint blocking until completion.
app.post('/admin/refresh', requireAdmin, async (req, res) => {
  // Best-effort immediate feedback only -- ingest.js's own lock-acquire at
  // the top of run() is the real enforcement (this check-then-spawn has an
  // unavoidable small race window). Peeking and immediately releasing
  // rather than holding it: if nobody else holds it right now, don't block
  // the real ingest from acquiring it a moment later.
  const peek = await tryAcquireIngestLock();
  if (!peek) {
    return res.status(409).json({ ok: false, error: 'An ingest run is already in progress' });
  }
  await releaseIngestLock(peek);

  const child = spawn(process.execPath, [path.join(__dirname, 'ingest.js')], {
    detached: true,
    stdio: 'ignore',
    // Marks every provider_runs/reports row this run produces as a manual
    // trigger -- healthMonitor.js's alert thresholds only count scheduled
    // runs, so this admin-initiated retry can never inflate a failure
    // streak the real cron is responsible for.
    env: { ...process.env, INGEST_TRIGGER: 'manual' }
  });
  child.unref();
  res.json({ ok: true, started: true });
});

// Stage 3 (IMPLEMENTATION_CHECKLIST.md): admin-only -- run history, error
// detail and alert state are operational detail, not something every
// dashboard viewer needs, same reasoning as gating Refresh. Recomputes
// fresh on every call (runHealthCheck is idempotent against the real DB
// state) so this always reflects reality, not just whatever it was after
// the last ingest run.
app.get('/admin/source-health', requireAdmin, async (req, res) => {
  try {
    const health = await runHealthCheck();
    res.json(health);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stage 1 of the roadmap (IMPLEMENTATION_CHECKLIST.md) -- computes and
// durably stores a point-in-time baseline from real, existing data, so a
// genuine before/after comparison is possible once later stages change
// recommendation behaviour. Each call is a NEW row (see
// recordBaselineSnapshot), never an overwrite -- there is no scratch DB
// with real history, so this only means something once run against the
// real deployment.
app.post('/admin/baseline', requireAdmin, async (req, res) => {
  try {
    const metrics = await computeBaseline();
    const row = await recordBaselineSnapshot(metrics, req.body?.notes || null);
    res.json({ ok: true, id: row.id, computedAt: row.computed_at, metrics });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Stage 4 (IMPLEMENTATION_CHECKLIST.md): audit trail for the eligibility
// filter -- admin-only, same reasoning as Source health (operational/
// internal detail, not something every dashboard viewer needs). No UI yet
// -- Stage 8's human review queue is where 'uncertain' rows get a real
// page; this is the endpoint-only pattern Stage 1's baseline also used
// before the data was worth building one around.
app.get('/admin/rejected-candidates', requireAdmin, async (req, res) => {
  const { theme, verdict, limit } = req.query;
  const rows = await getRejectedCandidates({ theme, verdict, limit: limit ? Number(limit) : undefined });
  res.json({
    rejected: rows.map((r) => ({
      id: r.id,
      reportId: r.report_id,
      microtrendId: r.microtrend_id,
      theme: r.theme,
      candidateName: r.candidate_name,
      verdict: r.verdict,
      reasonCode: r.reason_code,
      explanation: r.explanation,
      evidenceIds: r.evidence_ids,
      resurfacingExplanation: r.resurfacing_explanation,
      createdAt: r.created_at
    }))
  });
});

// Stage 5 (IMPLEMENTATION_CHECKLIST.md): "flag contradictions between the
// two stages for review" -- admin-only, same no-UI-yet pattern as
// rejected-candidates above.
app.get('/admin/fit-contradictions', requireAdmin, async (req, res) => {
  const { theme, limit } = req.query;
  const rows = await getFitContradictions({ theme, limit: limit ? Number(limit) : undefined });
  res.json({
    contradictions: rows.map((r) => ({
      id: r.id,
      reportId: r.report_id,
      microtrendId: r.microtrend_id,
      theme: r.theme,
      candidateName: r.candidate_name,
      eligibilityVerdict: r.eligibility_verdict,
      eligibilityReasonCode: r.eligibility_reason_code,
      sunriceFitScore: r.sunrice_fit_score,
      sunriceFitBand: r.sunrice_fit_band,
      explanation: r.explanation,
      createdAt: r.created_at
    }))
  });
});

// Stage 7 (IMPLEMENTATION_CHECKLIST.md): "3 distinct rejected
// recommendations, same narrow theme, same reason, within 60 days ->
// flags the theme for admin review (never auto-hard-bans)" -- a soft,
// computed-on-read signal, admin-only, same no-UI-yet pattern as
// rejected-candidates/fit-contradictions above. Acting on a flag (if an
// admin agrees) is always the separate, explicit POST below -- this
// endpoint itself never excludes anything.
app.get('/admin/theme-review-flags', requireAdmin, async (req, res) => {
  const rows = await getNotRelevantFeedbackForReview();
  const flags = themeReviewFlags(rows);
  res.json({
    flags: flags.map((f) => ({
      theme: f.theme,
      themeLabel: THEME_LABEL_BY_KEY[f.theme] || f.theme,
      reasonCode: f.reasonCode,
      reasonLabel: NOT_RELEVANT_REASON_LABELS[f.reasonCode] || f.reasonCode,
      distinctCount: f.distinctCount
    }))
  });
});

// Stage 7: "explicit theme exclusions -- admin-only action, reversible".
// A deliberate, separate step from the soft review-flag signal above --
// never applied automatically. GET lists every exclusion (active and
// historical, for the audit trail); POST excludes a theme; POST .../reverse
// undoes it. src/reportBuilder.js checks the active set before producing
// any evidence for that theme, so a reversal needs no repair -- the very
// next build just resumes normally.
app.get('/admin/theme-exclusions', requireAdmin, async (req, res) => {
  const rows = await getThemeExclusions();
  res.json({
    exclusions: rows.map((r) => ({
      id: r.id,
      theme: r.theme,
      themeLabel: THEME_LABEL_BY_KEY[r.theme] || r.theme,
      reason: r.reason,
      excludedAt: r.excluded_at,
      reversedAt: r.reversed_at
    }))
  });
});

app.post('/admin/theme-exclusions', requireAdmin, async (req, res) => {
  const { theme, reason } = req.body || {};
  const validThemes = ALL_TOPICS.map((t) => t.theme);
  if (!validThemes.includes(theme)) {
    return res.status(400).json({ error: `theme must be one of ${validThemes.join(', ')}` });
  }
  const row = await excludeTheme(theme, reason);
  res.status(201).json({
    exclusion: { id: row.id, theme: row.theme, reason: row.reason, excludedAt: row.excluded_at }
  });
});

app.post('/admin/theme-exclusions/:id/reverse', requireAdmin, async (req, res) => {
  const row = await reverseThemeExclusion(req.params.id);
  if (!row) return res.status(404).json({ error: `no active exclusion with id ${req.params.id}` });
  res.json({ exclusion: { id: row.id, theme: row.theme, reversedAt: row.reversed_at } });
});

// Public read, same as every other report read in this app -- lets
// anyone see the most recent baseline (and its full history) without
// needing database access.
app.get('/api/baseline', async (req, res) => {
  if (req.query.all === 'true') {
    const rows = await getAllBaselineSnapshots();
    return res.json({ snapshots: rows.map((r) => ({ id: r.id, computedAt: r.computed_at, notes: r.notes, metrics: r.metrics })) });
  }
  const latest = await getLatestBaselineSnapshot();
  if (!latest) return res.status(404).json({ error: 'no baseline snapshot has been captured yet' });
  res.json({ id: latest.id, computedAt: latest.computed_at, notes: latest.notes, metrics: latest.metrics });
});

const port = process.env.PORT || 3000;

initSchemaWithRetry()
  .then(() => {
    const server = app.listen(port, () => console.log(`Dashboard listening on port ${port}`));
    // Stop accepting new requests before closing the pool -- closing the
    // pool first while requests are still in flight is what crashes the
    // process on a mistimed shutdown.
    process.on('SIGTERM', () => {
      server.close(() => pool.end().then(() => process.exit(0)));
    });
  })
  .catch((err) => {
    console.error('Failed to init schema:', err);
    process.exit(1);
  });
