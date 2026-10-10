const {
  pool, insertSignal, insertRecommendation, linkEvidence,
  upsertThemeSnapshot, getPriorThemeSnapshots, getRecentRecommendations, getSameDayRecommendations
} = require('./db');
const { ALL_TOPICS } = require('./topics');
const { scoreOpportunity, confidenceFor, actionTypeFor } = require('./scoring');
const { writeRationale } = require('./llmStrategist');
const { themeLifecycleFor } = require('./themeLifecycle');
const { computeActionFingerprint, determineContinuityStatus } = require('./continuity');

const THEME_LABELS = Object.fromEntries(ALL_TOPICS.map((t) => [t.theme, t.label]));
const REQUIRES_REVIEW = new Set(ALL_TOPICS.filter((t) => t.requiresReview).map((t) => t.theme));

// Pinterest is trend/planning evidence, not a social post -- it contributes
// to source agreement, momentum and creative context same as before, but
// is never counted toward "N matching social posts" or used to trigger a
// TikTok/Instagram channel recommendation. Both of those bugs were real:
// a theme with Pinterest evidence alone (zero actual Reddit/TikTok/
// Instagram posts) could previously still get suggestedChannelFor() to
// recommend "Short-form video (TikTok/Instagram)" purely because Pinterest
// padded socialTotal above zero.
const REAL_SOCIAL_PLATFORMS = ['reddit', 'tiktok', 'instagram'];

// Taxonomy, not evidence -- a fixed editorial mapping of theme to the
// audience/filter values the brief's nav requires, decided once here rather
// than invented per report. Never used as a substitute for a real metric.
const THEME_AUDIENCE = {
  rice_basics: 'home cooks',
  weeknight_dinners: 'home cooks',
  curry_night: 'multicultural audiences',
  healthy_eating: 'health-conscious',
  lunchbox_snacks: 'parents',
  sushi_asian: 'multicultural audiences',
  seasonal: 'families',
  multicultural: 'multicultural audiences'
};

// Fixed editorial priority per theme -- rice cooking fundamentals and the
// meal/cuisine themes are this brand's core, highest-value content; lunchbox
// snacks is real but narrower, so it's weighted down rather than treated as
// equally important by default. Not derived from any live metric, same as
// THEME_AUDIENCE/seasonalFit above and below. multicultural is deliberately
// left out here -- its relevance is already forced to 0.5 by the
// requiresReview lock regardless of this map, so giving it its own entry
// would just be a second, easily-stale way of saying the same thing.
const THEME_RELEVANCE = {
  rice_basics: 1,
  weeknight_dinners: 1,
  curry_night: 1,
  healthy_eating: 1,
  sushi_asian: 1,
  seasonal: 1,
  lunchbox_snacks: 0.7
};

function suggestedChannelFor(realSocialPostCount, hasSearch) {
  if (realSocialPostCount > 0) return 'Short-form video (TikTok/Instagram)';
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
    case 'rice_basics': return 0.7; // evergreen, no seasonal dip -- still ranks a little below an active seasonal moment
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

// Per-platform lifecycle for the existing social panel ONLY -- a single
// snapshot comparison (today's count vs. a 7-day trailing average), no
// memory. Left exactly as it was; theme-level lifecycle (new/validating/
// building/cooling/sustained/peaking, informed by real accumulated
// history) is themeLifecycleFor() in themeLifecycle.js, a separate
// function entirely. Conflating the two was explicitly the thing to avoid.
function lifecycleFor(daysOld, velocityPct) {
  if (daysOld == null) return null;
  if (daysOld <= 2) return 'new';
  if (velocityPct == null) return 'sustained';
  if (velocityPct > 20) return 'building';
  if (velocityPct < -20) return 'cooling';
  return 'sustained';
}

// Robust aggregation: the median of up to the 3 strongest verified rising-
// query values (already range-checked by sanitizeQueryValue in
// dataforseoTrends.js) rather than the single highest one. Math.max() let
// one generous outlier single-handedly max out 25% of the score; the
// median of the top 3 needs at least two consistent readings to move the
// number nearly as far. 1 value -> that value; 2 values -> their average
// (the natural median of a 2-element set) -- both sensible fallbacks when
// there isn't enough data for a true 3-way median.
function extractSearchVelocity(searchItem) {
  const rising = searchItem?.normalized_metrics?.relatedQueries?.rising || [];
  const nums = rising.map((r) => (typeof r.value === 'number' ? r.value : null)).filter((v) => v != null);
  if (nums.length === 0) return null;
  const topThree = [...nums].sort((a, b) => b - a).slice(0, 3);
  const sorted = [...topThree].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// source_type + author, counting only items with a real author -- a
// missing author is never treated as a distinct creator. Pinterest items
// never carry an author (no creator concept for a trend-list entry), so
// they contribute 0 here without needing a special case.
function uniqueCreatorCount(items) {
  const seen = new Set();
  for (const item of items) {
    if (item.author) seen.add(`${item.source_type}:${item.author}`);
  }
  return seen.size;
}

// Up to 5 real query strings (rising preferred, then top) -- evidence-
// derived only, never invented, used for the Thematic trends card and for
// theme_daily_snapshots.leading_queries.
function leadingQueriesFor(searchItem) {
  const rising = (searchItem?.normalized_metrics?.relatedQueries?.rising || []).map((q) => q.query);
  const top = (searchItem?.normalized_metrics?.relatedQueries?.top || []).map((q) => q.query);
  return [...rising, ...top].filter(Boolean).slice(0, 5);
}

// Builds this report's signals + theme snapshots + top recommendations from
// whatever real evidence was actually collected in this run (getTodayItems).
// A theme with zero collected items gets no signal, no snapshot, and is
// never considered for a recommendation -- there is no "pad to exactly 3"
// step; if fewer than 3 themes have real evidence, fewer than 3
// recommendations are saved. Every theme WITH evidence gets a
// theme_daily_snapshots row, not only the 3 that win a recommendation slot.
async function buildReport(reportId, reportDate) {
  // Captured BEFORE the same-day delete/rebuild below, so a manual Refresh
  // fired twice in one day doesn't lose the context of what this same
  // report already proposed earlier today -- see continuity.js.
  const sameDayRecs = await getSameDayRecommendations(reportId);
  const sameDayRecByTheme = new Map(sameDayRecs.filter((r) => r.theme).map((r) => [r.theme, r]));

  // A same-day re-run (a manual Refresh fired more than once before the
  // calendar day rolls over) must replace this report's derived
  // signals/recommendations, not pile more on top of them -- otherwise
  // "exactly 3 priorities" silently becomes 6, 9, 12... across repeated
  // runs. Raw evidence in source_items is untouched (it's deduped by
  // content_hash anyway); only the derived rows get cleared and rebuilt.
  // theme_daily_snapshots is NOT cleared here -- it upserts on
  // (report_id, theme) instead, because it's meant to accumulate across
  // days, not be scoped to "this run" the way signals/recommendations are.
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
      instagram: items.filter((i) => i.source_type === 'apify_instagram' && i.theme === theme),
      pinterest: items.filter((i) => i.source_type === 'apify_pinterest' && i.theme === theme)
    };
    const newsItems = items.filter((i) => i.source_type === 'google_news' && i.theme === theme);

    const allThemeItems = [...searchItems, ...Object.values(socialItemsByPlatform).flat(), ...newsItems];
    if (allThemeItems.length === 0) continue; // no real evidence -- no opportunity, no signal, no snapshot

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
          // Pinterest trend rows aren't posts -- labelled distinctly so the
          // UI never says "matching posts" for a trend-list entry.
          matchingPosts: platformItems.length,
          itemLabel: platform === 'pinterest' ? 'matched trend term' : 'matching post',
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

    // Deterministic, named "it's rising/growing right now" flag per source --
    // by that source's OWN definition of rising/growing, never a magnitude we
    // can't verify (Pinterest's change/count fields have no documented
    // scale, see pinterestTrends.js). Google Trends: at least one rising
    // query survived sanitizeQueryValue's out-of-range check. Pinterest: at
    // least one matched item is classified trendType 'growing'.
    const momentumSources = [];
    if ((searchItems[0]?.normalized_metrics?.relatedQueries?.rising || []).some((q) => q.value != null)) {
      momentumSources.push('google_trends');
    }
    if (socialItemsByPlatform.pinterest.some((i) => i.raw_metrics?.trendType === 'growing')) {
      momentumSources.push('pinterest');
    }

    const realSocialPostCount = REAL_SOCIAL_PLATFORMS.reduce((sum, p) => sum + socialItemsByPlatform[p].length, 0);

    const forceEarlySignal = REQUIRES_REVIEW.has(theme);
    const { score, components } = scoreOpportunity({
      daysOld,
      velocityPct,
      distinctSourceCount: distinctSourceTypes.size,
      relevance: forceEarlySignal ? 0.5 : (THEME_RELEVANCE[theme] ?? 1),
      seasonalFit: seasonalFit(theme, new Date(reportDate))
    });

    opportunities.push({
      theme,
      score,
      components,
      velocityPct,
      distinctSourceCount: distinctSourceTypes.size,
      sourceTypes: [...distinctSourceTypes],
      confidence: confidenceFor(score, distinctSourceTypes.size, forceEarlySignal),
      actionType: actionTypeFor(score, forceEarlySignal),
      momentumSources,
      evidenceItems: allThemeItems.sort((a, b) => new Date(b.collected_at) - new Date(a.collected_at)),
      socialCounts: Object.fromEntries(Object.entries(socialItemsByPlatform).map(([k, v]) => [k, v.length])),
      realSocialPostCount,
      uniqueCreatorCount: uniqueCreatorCount(allThemeItems),
      hasSearch: searchItems.length > 0,
      leadingQueries: leadingQueriesFor(searchItems[0]),
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
  const topThemes = new Set(top.map((o) => o.theme));

  // --- Theme snapshots: every theme with evidence, not only the top 3 ----
  // This is what makes lifecycle and the Thematic trends section possible
  // at all -- signals/recommendations never kept this cross-day history.
  for (const opp of opportunities) {
    const priorSnapshots = await getPriorThemeSnapshots(opp.theme, reportDate, 30);
    const lifecycle = themeLifecycleFor(priorSnapshots, opp.score, opp.velocityPct);
    await upsertThemeSnapshot(reportId, reportDate, {
      theme: opp.theme,
      score: opp.score,
      scoreComponents: opp.components,
      velocityPct: opp.velocityPct,
      distinctSourceCount: opp.distinctSourceCount,
      sourceTypes: opp.sourceTypes,
      momentumSources: opp.momentumSources,
      socialCounts: opp.socialCounts,
      uniqueCreatorCount: opp.uniqueCreatorCount,
      hasSearch: opp.hasSearch,
      leadingQueries: opp.leadingQueries,
      lifecycle,
      wasRecommended: topThemes.has(opp.theme)
    });
    opp.lifecycle = lifecycle;
    opp.priorSnapshots = priorSnapshots;
  }

  for (let i = 0; i < top.length; i++) {
    const opp = top[i];
    const label = THEME_LABELS[opp.theme];
    const parts = [];
    if (opp.hasSearch) parts.push('rising search interest');
    if (opp.realSocialPostCount > 0) parts.push(`${opp.realSocialPostCount} matching social post${opp.realSocialPostCount === 1 ? '' : 's'}`);
    const isMulticulturalDisclaimer = opp.actionType === 'Investigate' && opp.theme === 'multicultural';

    // --- Recommendation memory ------------------------------------------
    const sameDayRec = sameDayRecByTheme.get(opp.theme) || null;
    const recentRecs = await getRecentRecommendations(opp.theme, reportDate, 14, reportId);
    const priorForScoreChange = opp.priorSnapshots[opp.priorSnapshots.length - 1];
    const scoreChange = priorForScoreChange ? Math.round((opp.score - Number(priorForScoreChange.score)) * 10) / 10 : null;
    const priorSourceTypes = new Set(priorForScoreChange?.source_types || []);
    const newSources = opp.sourceTypes.filter((s) => !priorSourceTypes.has(s));
    const lostSources = [...priorSourceTypes].filter((s) => !opp.sourceTypes.includes(s));
    const daysActive = opp.priorSnapshots.length + 1;

    const deterministicRationale = isMulticulturalDisclaimer
      ? `A related query surfaced without a hard-coded assumption -- human review is required before this is used for audience targeting.`
      : buildDeterministicFallback({ opp, label, parts, sameDayRec, recentRecs });

    let strategy = null;
    if (!isMulticulturalDisclaimer) {
      strategy = await writeRationale({
        themeLabel: label,
        actionType: opp.actionType,
        distinctSourceCount: opp.distinctSourceCount,
        risingQueries: opp.risingQueries,
        topQueries: opp.topQueries,
        interestByRegion: opp.interestByRegion,
        socialExamples: opp.socialExamples,
        momentumSources: opp.momentumSources,
        recentRecs,
        sameDayRec,
        lifecycle: opp.lifecycle,
        daysActive,
        scoreChange,
        newSources,
        lostSources
      });
    }

    const opportunityName = strategy?.opportunityName || label;
    const rationale = strategy?.rationale || deterministicRationale;
    // Null, not a degenerate hash of empty fields, whenever there's no real
    // strategist output to fingerprint -- no ANTHROPIC_API_KEY, a failed
    // call, or a validation rejection all mean there's no actual execution
    // detail (products/channel/format/angle) to compare day to day, so
    // asserting "repeat_action" from an all-empty fingerprint would be a
    // specific claim this system can't actually back. determineContinuityStatus
    // treats a null fingerprint as "fall back to the score trend only".
    const actionFingerprint = strategy
      ? computeActionFingerprint({
          theme: opp.theme,
          primaryProducts: strategy.primaryProducts,
          channel: strategy.channel,
          format: strategy.format,
          creativeAngle: strategy.creativeAngle
        })
      : null;

    // Deterministic, system-of-record continuity status -- never the
    // LLM's own guess (strategy.continuityStatusGuess is kept in
    // strategy_output for comparison/audit only).
    const continuityStatus = isMulticulturalDisclaimer
      ? null
      : determineContinuityStatus({ recentRecs, sameDayRec, newFingerprint: actionFingerprint, todayScore: opp.score, reportDate });

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
      opportunityName,
      rationale,
      audience: THEME_AUDIENCE[opp.theme] || 'general',
      state: 'National',
      suggestedChannel: strategy?.channel || suggestedChannelFor(opp.realSocialPostCount, opp.hasSearch),
      momentumSources: opp.momentumSources,
      continuityStatus,
      actionFingerprint,
      continuityMeta: {
        previousRecommendationDate: recentRecs[0] ? new Date(recentRecs[0].report_date).toISOString().slice(0, 10) : null,
        appearances14d: recentRecs.length,
        daysActive,
        scoreChange,
        newSources,
        lostSources,
        changeSincePrevious: strategy?.changeSincePrevious || null
      },
      strategyOutput: strategy?.raw || null,
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

// Factual, structured fallback (brief section 13) -- used whenever the LLM
// is unavailable/invalid, or as the base every opportunityName/rationale
// falls back to. Never invents a creative execution; states what's known
// and what changed, nothing more.
function buildDeterministicFallback({ opp, label, parts, sameDayRec, recentRecs }) {
  const whySources = `${opp.distinctSourceCount} independent source${opp.distinctSourceCount === 1 ? '' : 's'} point to ${label.toLowerCase()} right now: ${parts.join(' and ') || 'early signal only'}.`;
  let continuityNote;
  if (sameDayRec) {
    continuityNote = 'Already surfaced earlier today -- review the existing evidence rather than treating this as a new idea.';
  } else if (recentRecs.length > 0) {
    const lastDate = new Date(recentRecs[0].report_date).toISOString().slice(0, 10);
    continuityNote = `This theme was last recommended on ${lastDate} (${recentRecs.length} time${recentRecs.length === 1 ? '' : 's'} in the last 14 days) -- recommended again today on the strength of current evidence, not as a brand-new idea.`;
  } else {
    continuityNote = 'This is a new appearance for this theme in the last 14 days.';
  }
  return `${whySources} ${continuityNote} Evidence should be reviewed before committing to a specific creative execution.`;
}

function distinctCount(items) {
  return new Set(items.map((i) => i.source_type)).size;
}

module.exports = { buildReport, seasonalFit, lifecycleFor, THEME_RELEVANCE };
