require('dotenv').config();
const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const {
  pool, initSchemaWithRetry, getReportByDate, getLatestReport, listReportDates, getReportBundle
} = require('./db');
const { ALL_TOPICS } = require('./topics');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

const FEATURE_FLAGS = {
  local_visibility: process.env.FEATURE_LOCAL_VISIBILITY === 'true',
  digital_availability: process.env.FEATURE_DIGITAL_AVAILABILITY === 'true',
  competitor_pulse: process.env.FEATURE_COMPETITOR_PULSE === 'true',
  customer_voice: process.env.FEATURE_CUSTOMER_VOICE === 'true'
};

const AUDIENCES = ['parents', 'families', 'home cooks', 'health-conscious', 'multicultural audiences', 'general'];
const STATES = ['National', 'VIC', 'NSW', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT'];

function requireAdmin(req, res, next) {
  const token = req.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

function applyFilters(bundle, query) {
  const { theme, audience, state, lifecycle } = query;
  let recommendations = bundle.recommendations;
  let signals = bundle.signals;

  if (theme) {
    recommendations = recommendations.filter((r) => r.theme === theme);
    signals = signals.filter((s) => s.theme === theme);
  }
  if (audience) recommendations = recommendations.filter((r) => r.audience === audience);
  if (state) recommendations = recommendations.filter((r) => r.state === state || r.state === 'National');
  if (lifecycle) signals = signals.filter((s) => s.lifecycle === lifecycle);

  return { ...bundle, recommendations, signals };
}

function serializeBundle(bundle) {
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
  res.json(serializeBundle(applyFilters(bundle, req.query)));
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
  res.json(serializeBundle(applyFilters(bundle, req.query)));
});

// Fire-and-forget: an ingestion run can take several minutes (bounded Apify
// polling in particular), far longer than a sane HTTP request should stay
// open. The client re-polls /api/reports/latest afterwards rather than this
// endpoint blocking until completion.
app.post('/admin/refresh', requireAdmin, (req, res) => {
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
