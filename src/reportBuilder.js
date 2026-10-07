const { pool, insertSignal, insertRecommendation, linkEvidence } = require('./db');
const { ALL_TOPICS } = require('./topics');
const { scoreOpportunity, confidenceFor, actionTypeFor } = require('./scoring');
const { writeRationale } = require('./llmStrategist');

const THEME_LABELS = Object.fromEntries(ALL_TOPICS.map((t) => [t.theme, t.label]));
const REQUIRES_REVIEW = new Set(ALL_TOPICS.filter((t) => t.requiresReview).map((t) => t.theme));

// Taxonomy, not evidence -- a fixed editorial mapping of theme to the
// audience/filter values the brief's nav requires, decided once here rather
// than invented per report. Never used as a substitute for a real metric.
const THEME_AUDIENCE = {
  weeknight_dinners: 'home cooks',
  curry_night: 'multicultural audiences',
  healthy_eating: 'health-conscious',
  lunchbox_snacks: 'parents',
  sushi_asian: 'multicultural audiences',
  seasonal: 'families',
  multicultural: 'multicultural audiences'
};

function suggestedChannelFor(socialTotal, hasSearch) {
  if (socialTotal > 0) return 'Short-form video (TikTok/Instagram)';
  if (hasSearch) return 'Recipe/blog content + SEO';
  return null;
}

// Simple, documented month-based seasonal weighting -- not a forecast,
// just a deterministic tiebreaker component. getMonth() is 0-indexed
// (0 = January). `seasonal` and `multicultural` both stay flat: occasions
// with shifting or non-Gregorian dates (Lunar New Year, Diwali, Ramadan,
// under `multicultural`) and fixed-date ones (Christmas, Australia Day,
// under `seasonal`) are mixed in across these themes, and pretending to
// know precisely when each one falls this year would be exactly the kind
// of invented precision the data rule exists to prevent.
function seasonalFit(theme, date = new Date()) {
  const month = date.getMonth();
  const isSchoolTerm = month !== 0; // roughly: not January
  switch (theme) {
    case 'lunchbox_snacks': return isSchoolTerm ? 0.8 : 0.3;
    case 'healthy_eating': return month === 0 ? 0.9 : 0.6; // January health resolutions
    case 'weeknight_dinners': return 0.6;
    case 'curry_night': return 0.6;
    case 'sushi_asian': return 0.6;
    case 'seasonal': return 0.7;
    case 'multicultural': return 0.5;
    default: return 0.5;
  }
}

// Deliberately keyed on collected_at's calendar date (Melbourne), not on
// joining through provider_runs -- a same-day re-run (manual Refresh fired
// more than once before midnight) clears and re-records provider_runs (see
// ingest.js), which would silently drop already-collected evidence from
// this query if it depended on that join.
async function getTodayItems(reportDate) {
  const res = await pool.query(
    `SELECT * FROM source_items
     WHERE theme IS NOT NULL
       AND (collected_at AT TIME ZONE 'Australia/Melbourne')::date = $1::date`,
    [reportDate]
  );
  return res.rows;
}

// Real, queried baseline -- not invented. Zero history (day one, or a theme
// with no prior data) means "no baseline yet", which the scorer treats as
// neutral rather than as a fabricated 0% or 100% change.
async function previousAvgCount(theme, sourceType, reportDate) {
  const res = await pool.query(
    `SELECT COUNT(*)::float / 7 AS avg_count FROM source_items
     WHERE theme = $1 AND source_type = $2
       AND collected_at >= $3::date - interval '7 days' AND collected_at < $3::date`,
    [theme, sourceType, reportDate]
  );
  return Number(res.rows[0]?.avg_count) || 0;
}

async function firstDetectedAt(items) {
  const dates = items.map((i) => i.published_at || i.collected_at).filter(Boolean).map((d) => new Date(d));
  if (dates.length === 0) return null;
  return new Date(Math.min(...dates.map((d) => d.getTime())));
}

function lifecycleFor(daysOld, velocityPct) {
  if (daysOld == null) return null;
  if (daysOld <= 2) return 'new';
  if (velocityPct == null) return 'sustained';
  if (velocityPct > 20) return 'building';
  if (velocityPct < -20) return 'cooling';
  return 'sustained';
}

function extractSearchVelocity(searchItem) {
  const rising = searchItem?.normalized_metrics?.relatedQueries?.rising || [];
  const nums = rising.map((r) => (typeof r.value === 'number' ? r.value : null)).filter((v) => v != null);
  return nums.length > 0 ? Math.max(...nums) : null;
}

// Builds this report's signals + top recommendations from whatever real
// evidence was actually collected in this run (getTodayItems). A theme with
// zero collected items produces no signal and is never considered for a
// recommendation -- there is no "pad to exactly 3" step; if fewer than 3
// themes have real evidence, fewer than 3 recommendations are saved.
async function buildReport(reportId, reportDate) {
  // A same-day re-run (a manual Refresh fired more than once before the
  // calendar day rolls over) must replace this report's derived
  // signals/recommendations, not pile more on top of them -- otherwise
  // "exactly 3 priorities" silently becomes 6, 9, 12... across repeated
  // runs. Raw evidence in source_items is untouched (it's deduped by
  // content_hash anyway); only the derived rows get cleared and rebuilt.
  await pool.query('DELETE FROM recommendations WHERE report_id = $1', [reportId]); // cascades recommendation_evidence
  await pool.query('DELETE FROM signals WHERE report_id = $1', [reportId]);

  const items = await getTodayItems(reportDate);
  const opportunities = [];

  for (const topic of ALL_TOPICS) {
    const theme = topic.theme;
    const searchItems = items.filter((i) => i.source_type === 'dataforseo_trends' && i.theme === theme);
    const socialItemsByPlatform = {
      reddit: items.filter((i) => i.source_type === 'apify_reddit' && i.theme === theme),
      tiktok: items.filter((i) => i.source_type === 'apify_tiktok' && i.theme === theme),
      instagram: items.filter((i) => i.source_type === 'apify_instagram' && i.theme === theme)
    };
    const newsItems = items.filter((i) => i.source_type === 'google_news' && i.theme === theme);

    const allThemeItems = [...searchItems, ...Object.values(socialItemsByPlatform).flat(), ...newsItems];
    if (allThemeItems.length === 0) continue; // no real evidence -- no opportunity, no signal

    // --- Signals -----------------------------------------------------
    if (searchItems.length > 0) {
      const s = searchItems[0];
      await insertSignal(reportId, {
        signalType: 'search_topic',
        topic: s.query_or_topic,
        theme,
        state: 'National',
        metricSummary: {
          interestByRegion: s.normalized_metrics?.interestByRegion || [],
          topQueries: s.normalized_metrics?.relatedQueries?.top || [],
          risingQueries: s.normalized_metrics?.relatedQueries?.rising || []
        },
        dataStatus: s.data_status
      });
    }

    for (const [platform, platformItems] of Object.entries(socialItemsByPlatform)) {
      if (platformItems.length === 0) continue;
      const sourceType = `apify_${platform}`;
      const prevAvg = await previousAvgCount(theme, sourceType, reportDate);
      const velocityPct = prevAvg > 0 ? ((platformItems.length - prevAvg) / prevAvg) * 100 : null;
      const firstDetected = await firstDetectedAt(platformItems);
      const daysOld = firstDetected ? (new Date(reportDate) - firstDetected) / 86400000 : null;
      await insertSignal(reportId, {
        signalType: 'social_topic',
        topic: THEME_LABELS[theme],
        platform,
        theme,
        metricSummary: {
          matchingPosts: platformItems.length,
          exampleUrl: platformItems[0].source_url,
          engagementSample: platformItems.slice(0, 3).map((i) => i.raw_metrics)
        },
        lifecycle: lifecycleFor(daysOld, velocityPct),
        momentum: velocityPct == null ? null : velocityPct >= 0 ? 'up' : 'down',
        firstDetectedAt: firstDetected,
        dataStatus: platformItems[0].data_status
      });
    }

    // --- Opportunity scoring inputs -----------------------------------
    const distinctSourceTypes = new Set(allThemeItems.map((i) => i.source_type));
    const firstDetected = await firstDetectedAt(allThemeItems);
    const daysOld = firstDetected ? (new Date(reportDate) - firstDetected) / 86400000 : 0;

    const searchVelocity = searchItems.length > 0 ? extractSearchVelocity(searchItems[0]) : null;
    let socialVelocity = null;
    for (const [platform, platformItems] of Object.entries(socialItemsByPlatform)) {
      if (platformItems.length === 0) continue;
      const prevAvg = await previousAvgCount(theme, `apify_${platform}`, reportDate);
      if (prevAvg > 0) socialVelocity = Math.max(socialVelocity ?? -Infinity, ((platformItems.length - prevAvg) / prevAvg) * 100);
    }
    const velocityPct = searchVelocity ?? (socialVelocity === -Infinity ? null : socialVelocity);

    const forceEarlySignal = REQUIRES_REVIEW.has(theme);
    const { score, components } = scoreOpportunity({
      daysOld,
      velocityPct,
      distinctSourceCount: distinctSourceTypes.size,
      relevance: forceEarlySignal ? 0.5 : 1,
      seasonalFit: seasonalFit(theme, new Date(reportDate))
    });

    opportunities.push({
      theme,
      score,
      components,
      distinctSourceCount: distinctSourceTypes.size,
      confidence: confidenceFor(score, distinctSourceTypes.size, forceEarlySignal),
      actionType: actionTypeFor(score, forceEarlySignal),
      evidenceItems: allThemeItems.sort((a, b) => new Date(b.collected_at) - new Date(a.collected_at)),
      socialCounts: Object.fromEntries(Object.entries(socialItemsByPlatform).map(([k, v]) => [k, v.length])),
      hasSearch: searchItems.length > 0,
      // Carried through for the LLM strategist step below -- real evidence
      // only, nothing derived or invented here.
      risingQueries: searchItems[0]?.normalized_metrics?.relatedQueries?.rising || [],
      topQueries: searchItems[0]?.normalized_metrics?.relatedQueries?.top || [],
      interestByRegion: searchItems[0]?.normalized_metrics?.interestByRegion || [],
      socialExamples: Object.values(socialItemsByPlatform).flat().slice(0, 5).map((i) => ({
        platform: i.source_type.replace('apify_', ''),
        excerpt: i.excerpt,
        queryOrTopic: i.query_or_topic
      }))
    });
  }

  opportunities.sort((a, b) => b.score - a.score);
  const top = opportunities.slice(0, 3);

  for (let i = 0; i < top.length; i++) {
    const opp = top[i];
    const label = THEME_LABELS[opp.theme];
    const socialTotal = Object.values(opp.socialCounts).reduce((a, b) => a + b, 0);
    const parts = [];
    if (opp.hasSearch) parts.push('rising search interest');
    if (socialTotal > 0) parts.push(`${socialTotal} matching social post${socialTotal === 1 ? '' : 's'}`);
    const isMulticulturalDisclaimer = opp.actionType === 'Investigate' && opp.theme === 'multicultural';
    const deterministicRationale = isMulticulturalDisclaimer
      ? `A related query surfaced without a hard-coded assumption -- human review is required before this is used for audience targeting.`
      : `${opp.distinctSourceCount} independent source${opp.distinctSourceCount === 1 ? '' : 's'} point to ${label.toLowerCase()} right now: ${parts.join(' and ') || 'early signal only'}.`;

    // The compliance disclaimer above is fixed wording, not something to
    // let an LLM improvise on. Everywhere else, let it write a sharper
    // rationale from the same real evidence -- falling back to the
    // deterministic sentence on any failure, missing key, or bad response.
    const rationale = isMulticulturalDisclaimer
      ? deterministicRationale
      : (await writeRationale({
          themeLabel: label,
          actionType: opp.actionType,
          distinctSourceCount: opp.distinctSourceCount,
          risingQueries: opp.risingQueries,
          topQueries: opp.topQueries,
          interestByRegion: opp.interestByRegion,
          socialExamples: opp.socialExamples
        })) || deterministicRationale;

    const titleByAction = {
      Create: `Own the "${label}" moment`,
      Investigate: `Investigate ${label.toLowerCase()}`,
      Watch: `Keep watching ${label.toLowerCase()}`
    };

    const rec = await insertRecommendation(reportId, {
      rank: i + 1,
      actionType: opp.actionType,
      theme: opp.theme,
      title: titleByAction[opp.actionType] || `${label} update`,
      rationale,
      audience: THEME_AUDIENCE[opp.theme] || 'general',
      state: 'National',
      suggestedChannel: suggestedChannelFor(socialTotal, opp.hasSearch),
      freshness: opp.evidenceItems[0]?.collected_at ? `Collected ${new Date(opp.evidenceItems[0].collected_at).toISOString().slice(0, 10)}` : null,
      confidence: opp.confidence,
      score: opp.score,
      scoreComponents: opp.components
    });

    // Up to one piece of evidence per contributing source_type, most recent
    // first -- keeps the drawer diverse rather than 5x the same platform.
    const seenTypes = new Set();
    const evidenceToLink = [];
    for (const item of opp.evidenceItems) {
      if (evidenceToLink.length >= 5) break;
      if (seenTypes.has(item.source_type) && evidenceToLink.length < opp.evidenceItems.length) {
        if (seenTypes.size >= distinctCount(opp.evidenceItems)) evidenceToLink.push(item);
        continue;
      }
      seenTypes.add(item.source_type);
      evidenceToLink.push(item);
    }
    for (const item of evidenceToLink) {
      await linkEvidence(rec.id, item.id, null);
    }
  }

  return { opportunitiesConsidered: opportunities.length, recommendationsCreated: top.length };
}

function distinctCount(items) {
  return new Set(items.map((i) => i.source_type)).size;
}

module.exports = { buildReport, seasonalFit, lifecycleFor };
