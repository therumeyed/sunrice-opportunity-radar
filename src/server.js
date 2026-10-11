require('dotenv').config();
const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const {
  pool, initSchemaWithRetry, getReportByDate, getLatestReport, listReportDates, getReportBundle,
  tryAcquireIngestLock, releaseIngestLock, getRecommendationById, insertFeedback, restoreFeedback, listActiveFeedback,
  getActiveExclusions
} = require('./db');
const { ALL_TOPICS } = require('./topics');
const { peakingEligible } = require('./themeLifecycle');
const { FEEDBACK_TYPES, REASONS_BY_TYPE, validateFeedbackInput } = require('./feedback');

const app = express();
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

function requireAdmin(req, res, next) {
  const token = req.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

// Same session-scoped-token UX as ADMIN_TOKEN (browser prompt(), Bearer
// header, sessionStorage on the frontend) but a separate token and a
// separate env var -- feedback is a distinct, lower-risk write than
// triggering a paid ingest run, and read access to feedback (the
// hidden/covered-items manager) stays public same as every other report
// read in this app; only the mutations below are gated.
function requireEditor(req, res, next) {
  const token = req.get('Authorization')?.replace(/^Bearer\s+/i, '');
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

function serializeMicrotrend(m) {
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
    todayObservations: m.today_observations || [],
    todayEvidenceCount: Number(m.today_evidence_count) || 0
  };
}

async function serializeBundle(bundle) {
  const exclusions = await getActiveExclusions();
  const winningMicrotrendIds = new Set(bundle.recommendations.filter((r) => r.microtrend_id).map((r) => r.microtrend_id));
  return {
    report: {
      date: bundle.report.report_date,
      status: bundle.report.status,
      generatedAt: bundle.report.generated_at,
      providerSummary: bundle.report.provider_summary
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
      recommendationKind: r.recommendation_kind,
      microtrendId: r.microtrend_id,
      recommendedAction: r.recommended_action,
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
app.get('/api/feedback/reasons', (req, res) => {
  res.json({ feedbackTypes: FEEDBACK_TYPES, reasonsByType: REASONS_BY_TYPE });
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

  const { feedbackType, reason, note, existingContentUrl, contentStatus } = req.body || {};
  const validation = validateFeedbackInput(feedbackType, { reason, note, contentStatus });
  if (!validation.valid) return res.status(400).json({ error: validation.error });

  const row = await insertFeedback({
    recommendationId: recommendation.id,
    microtrendId: recommendation.microtrend_id,
    actionFingerprint: recommendation.action_fingerprint,
    feedbackType,
    reason,
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
    env: process.env
  });
  child.unref();
  res.json({ ok: true, started: true });
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
