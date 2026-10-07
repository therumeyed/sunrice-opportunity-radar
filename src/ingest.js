require('dotenv').config();
const { pool, initSchemaWithRetry, getOrCreateReport, completeReport, recordProviderRun, upsertSourceItem } = require('./db');
const { ALL_TOPICS, allQueries } = require('./topics');
const dataforseoTrends = require('./providers/dataforseoTrends');
const googleNewsRss = require('./providers/googleNewsRss');
const apifySocial = require('./providers/apifySocial');
const { buildReport } = require('./reportBuilder');
const { contentHash } = require('./util/hash');

function melbourneDateString(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne' }).format(date);
}

async function cachedFallbackForTrends(theme, query, providerRunId, reportDate) {
  const res = await pool.query(
    `SELECT * FROM source_items
     WHERE source_type = 'dataforseo_trends' AND theme = $1 AND query_or_topic = $2 AND data_status IN ('live','cached')
     ORDER BY collected_at DESC LIMIT 1`,
    [theme, query]
  );
  const prev = res.rows[0];
  if (!prev) return null;
  return upsertSourceItem({
    providerRunId,
    sourceType: 'dataforseo_trends',
    sourceName: 'DataForSEO (cached)',
    contentHash: contentHash(['dataforseo_trends', theme, query, reportDate, 'cached']),
    title: `${query} (cached)`,
    excerpt: 'Live collection failed or was skipped today; showing the last successful pull.',
    queryOrTopic: query,
    theme,
    geography: 'Australia',
    normalizedMetrics: prev.normalized_metrics,
    dataStatus: 'cached',
    rawPayload: prev.raw_payload,
    publishedAt: prev.collected_at
  });
}

// One task per keyword (DataForSEO requirement for queries_list/topics_list
// item types), with a hard daily cost ceiling -- once hit, remaining topics
// fall back to the last successful dataset instead of submitting more paid
// tasks, per the brief's "enforce a configurable daily cost ceiling" rule.
async function collectTrends(report, reportDate) {
  const ceiling = Number(process.env.DATAFORSEO_DAILY_COST_CEILING_USD || 5);
  let spent = 0;
  const summary = { live: 0, cached: 0, failed: 0, awaiting_connection: 0, costUsd: 0 };

  for (const topic of ALL_TOPICS) {
    for (const query of topic.queries) {
      let result;
      if (spent >= ceiling) {
        result = { status: 'failed', cost: 0, error: `Skipped: daily DataForSEO cost ceiling ($${ceiling}) reached` };
      } else {
        result = await dataforseoTrends.explore(query);
        spent += result.cost || 0;
      }

      if (result.status !== 'live') {
        console.warn(`[ingest] dataforseo_trends "${query}" (${topic.theme}): ${result.status}${result.error ? ` -- ${result.error}` : ''}`);
      }

      const run = await recordProviderRun(report.id, {
        providerName: 'DataForSEO',
        sourceType: 'dataforseo_trends',
        status: result.status,
        inputParams: { query, theme: topic.theme },
        cost: result.cost,
        error: result.error
      });

      if (result.status === 'live') {
        await upsertSourceItem({
          providerRunId: run.id,
          sourceType: 'dataforseo_trends',
          sourceName: 'DataForSEO',
          contentHash: contentHash(['dataforseo_trends', topic.theme, query, reportDate]),
          title: query,
          excerpt: `Relative search interest for "${query}" across Australia, last 30 days.`,
          queryOrTopic: query,
          theme: topic.theme,
          geography: 'Australia',
          normalizedMetrics: result.data,
          dataStatus: 'live',
          rawPayload: result.rawPayload,
          publishedAt: new Date()
        });
        summary.live++;
      } else {
        const cached = await cachedFallbackForTrends(topic.theme, query, run.id, reportDate);
        summary[cached ? 'cached' : result.status]++;
      }
    }
  }
  summary.costUsd = Math.round(spent * 100) / 100;
  return summary;
}

async function collectGoogleNews(report, reportDate, sinceDate) {
  const summary = { live: 0, failed: 0 };
  for (const topic of ALL_TOPICS) {
    for (const query of topic.queries) {
      const result = await googleNewsRss.search(query);
      const run = await recordProviderRun(report.id, {
        providerName: 'Google News RSS',
        sourceType: 'google_news',
        status: result.status,
        inputParams: { query, theme: topic.theme },
        error: result.error
      });
      if (result.status === 'live') {
        for (const item of result.items) {
          const publishedAt = item.pubDate ? new Date(item.pubDate) : null;
          if (publishedAt && publishedAt < sinceDate) continue;
          if (!item.link) continue;
          await upsertSourceItem({
            providerRunId: run.id,
            sourceType: 'google_news',
            sourceName: item.source || 'Google News',
            sourceUrl: item.link,
            externalId: item.guid || item.link,
            contentHash: contentHash([item.guid || item.link]),
            title: item.title,
            queryOrTopic: query,
            theme: topic.theme,
            publishedAt,
            dataStatus: 'live',
            rawPayload: item.raw
          });
        }
        summary.live++;
      } else {
        summary.failed++;
      }
    }
  }
  return summary;
}

async function collectSocial(report, reportDate, sinceDate) {
  const queries = allQueries().map((q) => q.query);
  const platforms = [
    { key: 'reddit', sourceType: 'apify_reddit', sourceName: 'Reddit (via Apify)', fn: apifySocial.searchReddit },
    { key: 'tiktok', sourceType: 'apify_tiktok', sourceName: 'TikTok (via Apify)', fn: apifySocial.searchTikTok },
    { key: 'instagram', sourceType: 'apify_instagram', sourceName: 'Instagram (via Apify)', fn: apifySocial.searchInstagram }
  ];
  const summary = {};

  for (const platform of platforms) {
    const result = await platform.fn(queries, sinceDate);
    const run = await recordProviderRun(report.id, {
      providerName: platform.sourceName,
      sourceType: platform.sourceType,
      status: result.status,
      inputParams: { queries },
      error: result.error
    });
    if (result.status === 'live') {
      for (const item of result.items) {
        if (!item.theme) continue; // couldn't attribute to a topic -- drop rather than mislabel
        await upsertSourceItem({
          providerRunId: run.id,
          sourceType: platform.sourceType,
          sourceName: platform.sourceName,
          sourceUrl: item.url,
          externalId: item.externalId,
          contentHash: contentHash([platform.sourceType, item.externalId || item.url]),
          title: item.title,
          excerpt: item.excerpt,
          author: item.author,
          publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
          queryOrTopic: item.queryOrTopic,
          theme: item.theme,
          rawMetrics: item.rawMetrics,
          dataStatus: 'live',
          rawPayload: item.rawPayload
        });
      }
    }
    // Omit the error key entirely when there isn't one -- Render's log
    // viewer flags any line containing the literal word "error" as red,
    // even at value `undefined`, so a clean run was showing as failed.
    summary[platform.key] = {
      status: result.status,
      items: result.items?.length || 0,
      ...(result.error ? { error: result.error } : {})
    };
  }
  return summary;
}

async function run() {
  await initSchemaWithRetry();
  const now = new Date();
  const reportDate = melbourneDateString(now);
  const sinceDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); // 7-day recency window for social/news

  console.log(`[ingest] starting report ${reportDate}`);
  // Booleans only, never the values -- but seeing this line in Render's log
  // viewer immediately answers "did this process actually get the secrets"
  // without needing to load the dashboard and dig through Source health.
  console.log('[ingest] credentials seen by this process:', {
    DATAFORSEO_LOGIN: Boolean(process.env.DATAFORSEO_LOGIN),
    DATAFORSEO_PASSWORD: Boolean(process.env.DATAFORSEO_PASSWORD),
    APIFY_TOKEN: Boolean(process.env.APIFY_TOKEN)
  });
  const report = await getOrCreateReport(reportDate);

  // A same-day re-run (Refresh fired more than once before midnight) should
  // reflect only its own latest attempt on Source health, not accumulate
  // every historical attempt from earlier runs today. Safe to clear: raw
  // evidence in source_items just loses this FK (ON DELETE SET NULL) and is
  // looked up by collected_at date in reportBuilder.js, not through this join.
  await pool.query('DELETE FROM provider_runs WHERE report_id = $1', [report.id]);

  const providerSummary = {};
  providerSummary.dataforseo_trends = await collectTrends(report, reportDate);
  console.log('[ingest] trends done', providerSummary.dataforseo_trends);

  providerSummary.google_news = await collectGoogleNews(report, reportDate, sinceDate);
  console.log('[ingest] news done', providerSummary.google_news);

  providerSummary.social = await collectSocial(report, reportDate, sinceDate);
  console.log('[ingest] social done', providerSummary.social);

  const buildResult = await buildReport(report.id, reportDate);
  console.log('[ingest] report built', buildResult);

  await completeReport(report.id, providerSummary);
  console.log(`[ingest] report ${reportDate} completed`);

  await pool.end();
}

run().catch(async (err) => {
  console.error('Fatal ingest error:', err);
  try { await pool.end(); } catch { /* already closed */ }
  process.exit(1);
});
