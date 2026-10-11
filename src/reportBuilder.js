const {
  pool, insertSignal, insertRecommendation, linkEvidence,
  upsertThemeSnapshot, getPriorThemeSnapshots, getRecentRecommendationsForMicrotrend, getSameDayRecommendations,
  upsertMicrotrend, getMicrotrendObservationHistory, recordMicrotrendObservation, linkMicrotrendEvidence,
  updateMicrotrendScore, setMicrotrendStatus, getActiveExclusions, getPositiveFeedbackExamples,
  countRecentMicrotrendRecommendations, getMicrotrendEvidence, setReportAiStatus, ensureIdeaExists
} = require('./db');
const { ALL_TOPICS, evergreenBaselinesForTheme } = require('./topics');
const { scoreOpportunity, confidenceFor, actionTypeFor } = require('./scoring');
const { themeLifecycleFor } = require('./themeLifecycle');
const { computeActionFingerprint, determineContinuityStatus } = require('./continuity');
const { extractCandidates, aggregateObservations, evidenceLinksFor } = require('./microtrendExtraction');
const { hasMaterialChange } = require('./microtrends');
const { scoreMicrotrend, qualifiesForRecommendation, confidenceForMicrotrend, actionTypeForMicrotrend } = require('./microtrendScoring');
// Namespace import, not destructured -- reportBuilder.test.js monkeypatches
// candidateAnalyst.analyzeCandidates on this shared module object to test
// the AI-succeeds path without a real network call. A destructured
// `const { analyzeCandidates } = require(...)` would capture the original
// function reference at load time and never see that patch.
const candidateAnalyst = require('./candidateAnalyst');

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

// Fixed editorial priority used ONLY for theme-level ranking (which 3
// themes' slots compete for a recommendation today) -- NOT for a
// candidate's own relevance score, which is Claude's brandRelevance
// judgment (see scoreThemeCandidates below). Not derived from any live
// metric. multicultural is deliberately left out -- its weight is already
// forced to 0.5 by the requiresReview lock regardless of this map.
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

// Real inputs for microtrends.hasMaterialChange's macro-suppression gate --
// built only from genuinely stored history/today's observations, never
// invented. "Velocity" here is deliberately narrow: only dataforseo_trends'
// own rising_value is numeric and verified (see microtrendScoring.js's own
// velocityScore comment on why Pinterest's rank/count fields are excluded).
// todayVelocityPct compares today's reading against the highest value ever
// seen in this macro's PRIOR history -- "higher than anything seen before",
// not a smaller day-to-day wobble -- which is what makes a positive result
// here a genuine, defensible "something changed" signal.
function materialChangeInputs(priorHistory, todayObservations) {
  const historicalSourceTypes = [...new Set(priorHistory.map((r) => r.source_type))];
  const todaySourceTypes = [...new Set(todayObservations.map((o) => o.sourceType))];
  const historicalNumeric = priorHistory
    .filter((r) => r.source_type === 'dataforseo_trends' && r.metric_type === 'rising_value' && r.metric_value != null)
    .map((r) => Number(r.metric_value));
  const todayNumeric = todayObservations.find(
    (o) => o.sourceType === 'dataforseo_trends' && o.metricType === 'rising_value' && typeof o.metricValue === 'number'
  );
  const priorMax = historicalNumeric.length > 0 ? Math.max(...historicalNumeric) : null;
  const todayVelocityPct = (todayNumeric && priorMax != null && priorMax > 0)
    ? ((todayNumeric.metricValue - priorMax) / priorMax) * 100
    : null;
  return { historicalSourceTypes, todaySourceTypes, todayVelocityPct };
}

// For each of Claude's validated assessments, merges the first-pass
// cluster(s) it referenced into one microtrend identity, persists
// observations/evidence (for EVERY theme's candidates, not only the top 3
// -- this is what makes the Emerging section possible), scores it using
// Claude's own brandRelevance as the relevance input, and determines
// whether it's eligible to win a slot (macro baseline suppression, the
// not_relevant/dont_show_again/already_covered/implemented exclusions).
// Claude is authoritative for classification/relevance/product fit/the
// proposed action; this function is authoritative for everything
// measurable built on top of that -- evidence, momentum math, history,
// exclusions, dedup.
async function processThemeAssessments(opp, assessments, rawCandidateByClusterKey, reportId, reportDate, exclusions) {
  const forceEarlySignal = REQUIRES_REVIEW.has(opp.theme);
  const results = [];

  for (const assessment of assessments) {
    const referencedCandidates = assessment.clusterKeys.map((k) => rawCandidateByClusterKey.get(k)).filter(Boolean);
    if (referencedCandidates.length === 0) continue; // defensive -- validateAssessment already guarantees this

    // Canonical identity for the merged group: whichever referenced
    // candidate has the most real evidence members. The others are
    // recorded as semantic merges on that canonical microtrend -- Claude's
    // judgment that differently-worded candidates are the same idea,
    // stored and auditable, never silently applied.
    const canonical = [...referencedCandidates].sort((a, b) => b.members.length - a.members.length)[0];
    const semanticMerges = referencedCandidates
      .filter((c) => c !== canonical)
      .map((c) => ({ normalizedKey: c.normalizedKey, sourceWording: c.sourceWording, mergedAt: reportDate }));

    const microtrend = await upsertMicrotrend({
      theme: opp.theme,
      normalizedKey: canonical.normalizedKey,
      displayName: assessment.candidateName,
      sourceWording: canonical.sourceWording,
      candidateType: assessment.classification,
      observedDate: reportDate,
      semanticMerges
    });

    const allMembers = referencedCandidates.flatMap((c) => c.members);
    const fullHistory = await getMicrotrendObservationHistory(microtrend.id);
    const priorHistory = fullHistory.filter((h) => new Date(h.report_date).toISOString().slice(0, 10) < reportDate);
    const todayObservations = aggregateObservations(allMembers);
    const distinctSourceCount = new Set(allMembers.map((m) => m.sourceType)).size;
    const uniqueSourceItemCount = new Set(allMembers.map((m) => m.sourceItemId)).size;
    // True first-seen (microtrends.first_seen_at, set once on first insert
    // and never overwritten) -- never an evidence item's own published_at.
    const daysOld = (new Date(reportDate) - new Date(microtrend.first_seen_at)) / 86400000;
    const priorRecommendationCount = await countRecentMicrotrendRecommendations(microtrend.id, reportDate, 30, reportId);

    const { score, components } = scoreMicrotrend({
      daysOld,
      observationHistory: priorHistory,
      todayObservations,
      distinctSourceCount,
      // Claude's own judgment of brand relevance -- authoritative, replaces
      // the old static THEME_RELEVANCE lookup for this specific input.
      relevance: forceEarlySignal ? 0.5 : assessment.brandRelevance,
      daysSinceFirstSeen: daysOld,
      priorRecommendationCount,
      uniqueSourceItemCount
    });

    for (const obs of todayObservations) {
      await recordMicrotrendObservation(reportId, {
        microtrendId: microtrend.id, sourceType: obs.sourceType, metricType: obs.metricType,
        metricValue: obs.metricValue, evidenceCount: obs.evidenceCount, sourceNativeClassification: obs.sourceNativeClassification
      });
    }
    for (const link of evidenceLinksFor(allMembers)) {
      await linkMicrotrendEvidence(microtrend.id, reportId, link.sourceItemId, link.matchType);
    }
    await updateMicrotrendScore(microtrend.id, reportId, score, components);

    let qualifies = true;
    if (assessment.classification === 'macro') {
      const { historicalSourceTypes, todaySourceTypes, todayVelocityPct } = materialChangeInputs(priorHistory, todayObservations);
      const materialChange = hasMaterialChange({ historicalSourceTypes, todaySourceTypes, historicalMaxVelocity: null, todayVelocityPct });
      qualifies = qualifiesForRecommendation({
        candidateType: assessment.classification, baselineShownAt: microtrend.baseline_shown_at, reportDate,
        materialChangeSinceBaseline: materialChange
      });
    }

    // Every validated assessment carries a real proposedAction, so this
    // fingerprint is never degenerate/empty the way the old LLM-prose-only
    // flow's fingerprint could be when there was nothing to compare.
    const actionFingerprint = computeActionFingerprint({
      theme: opp.theme,
      primaryProducts: assessment.productConnection,
      channel: assessment.proposedAction.channel,
      format: assessment.proposedAction.format,
      creativeAngle: assessment.proposedAction.creativeAngle
    });

    results.push({
      microtrend, assessment, allMembers, score, components, distinctSourceCount, uniqueSourceItemCount,
      qualifies, hidden: exclusions.hiddenMicrotrendIds.has(microtrend.id),
      actionFingerprint, suppressed: exclusions.suppressedFingerprints.has(actionFingerprint)
    });
  }
  return results.sort((a, b) => b.score - a.score);
}

// Highest-scoring candidate for this theme that is qualified (macro
// baseline rule), not hidden (not_relevant), and not suppressed
// (dont_show_again / already_covered / implemented) -- results are
// already sorted by score, so the first match wins. Returns null when
// nothing in the theme's candidate list is winnable, which is exactly
// when this slot gets no recommendation at all today -- never a
// deterministic fallback.
function pickWinningCandidate(opp) {
  return (opp.candidateResults || []).find((c) => c.qualifies && !c.hidden && !c.suppressed) || null;
}

// Builds this report's signals + theme snapshots from whatever real
// evidence was actually collected in this run (getTodayItems), then runs
// the mandatory Claude candidate analysis once for the whole report and
// builds recommendations only from what passes it. A theme with zero
// collected items gets no signal, no snapshot, and no candidates. If the
// AI analysis is unavailable (no key, or failed after one retry), signals
// and theme history still build normally, but zero recommendations are
// created -- see aiAnalysisAvailable on the return value and on the
// reports row itself.
async function buildReport(reportId, reportDate) {
  // Captured BEFORE the same-day delete/rebuild below, so a manual Refresh
  // fired twice in one day doesn't lose the context of what this same
  // report already proposed earlier today -- see continuity.js.
  const sameDayRecs = await getSameDayRecommendations(reportId);
  const sameDayRecByTheme = new Map(sameDayRecs.filter((r) => r.theme).map((r) => [r.theme, r]));

  // A same-day re-run (a manual Refresh fired more than once before the
  // calendar day rolls over) must replace this report's derived
  // signals/recommendations, not pile more on top of them. Raw evidence in
  // source_items is untouched (it's deduped by content_hash anyway); only
  // the derived rows get cleared and rebuilt. theme_daily_snapshots is NOT
  // cleared here -- it upserts on (report_id, theme) instead, because it's
  // meant to accumulate across days, not be scoped to "this run".
  await pool.query('DELETE FROM recommendations WHERE report_id = $1', [reportId]); // cascades recommendation_evidence
  await pool.query('DELETE FROM signals WHERE report_id = $1', [reportId]);

  const items = await getTodayItems(reportDate);
  const opportunities = [];
  // Fetched once per build, not once per candidate.
  const exclusions = await getActiveExclusions();

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
      topic,
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
      searchItemsForTheme: searchItems,
      pinterestItemsForTheme: socialItemsByPlatform.pinterest,
      candidateResults: []
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
    opp.rawCandidates = extractCandidates({ theme: opp.theme, searchItems: opp.searchItemsForTheme, pinterestItems: opp.pinterestItemsForTheme });
  }

  // --- Mandatory Claude candidate analysis, ONE batched call for the
  // whole report (every theme's candidates together, so Claude can
  // compare signals against each other) -------------------------------
  const themesWithCandidates = opportunities.filter((opp) => opp.rawCandidates.length > 0);
  const themeBatches = [];
  for (const opp of themesWithCandidates) {
    themeBatches.push({
      theme: opp.theme,
      themeLabel: THEME_LABELS[opp.theme],
      seedQueries: opp.topic.queries,
      evergreenBaselines: evergreenBaselinesForTheme(opp.theme),
      positiveExamples: await getPositiveFeedbackExamples(opp.theme, 5),
      candidates: opp.rawCandidates.map((c) => ({ clusterKey: c.clusterKey, displayText: c.sourceWording, members: c.members }))
    });
  }

  const analysis = await candidateAnalyst.analyzeCandidates(themeBatches);
  await setReportAiStatus(reportId, analysis.status === 'ok', analysis.reason || null);

  if (analysis.status !== 'ok') {
    // Signals and theme history above already built normally -- only
    // recommendation generation is gated on AI. No deterministic fallback
    // copy, per the brief: this is a hard "AI analysis unavailable" state,
    // not a quieter "nothing qualified today".
    return {
      opportunitiesConsidered: opportunities.length, recommendationsCreated: 0, microtrendRecommendations: 0,
      aiAnalysisAvailable: false, aiAnalysisReason: analysis.reason
    };
  }

  const rawCandidateByClusterKey = new Map();
  for (const opp of opportunities) for (const c of opp.rawCandidates) rawCandidateByClusterKey.set(c.clusterKey, c);

  const assessmentsByTheme = new Map();
  for (const assessment of analysis.assessments) {
    if (!assessmentsByTheme.has(assessment.parentTheme)) assessmentsByTheme.set(assessment.parentTheme, []);
    assessmentsByTheme.get(assessment.parentTheme).push(assessment);
  }

  // Every theme with candidates gets scored/persisted, not only the top 3
  // -- this is what makes the Emerging section possible.
  for (const opp of themesWithCandidates) {
    opp.candidateResults = await processThemeAssessments(
      opp, assessmentsByTheme.get(opp.theme) || [], rawCandidateByClusterKey, reportId, reportDate, exclusions
    );
  }

  let recommendationsCreated = 0;
  for (let i = 0; i < top.length; i++) {
    const opp = top[i];
    const isMulticulturalDisclaimer = opp.actionType === 'Investigate' && opp.theme === 'multicultural';

    if (isMulticulturalDisclaimer) {
      await buildDisclaimerRecommendation({ reportId, rank: i + 1, opp });
      recommendationsCreated++;
      continue;
    }

    const winner = pickWinningCandidate(opp);
    if (!winner) continue; // no real, qualified, Claude-analyzed candidate for this slot -- no recommendation, no fallback

    const sameDayRec = sameDayRecByTheme.get(opp.theme) || null;
    await buildCandidateRecommendation({ reportId, rank: i + 1, opp, winner, reportDate, sameDayRec });
    recommendationsCreated++;
  }

  return {
    opportunitiesConsidered: opportunities.length, recommendationsCreated, microtrendRecommendations: recommendationsCreated,
    aiAnalysisAvailable: true, aiAnalysisReason: null
  };
}

async function buildDisclaimerRecommendation({ reportId, rank, opp }) {
  const label = THEME_LABELS[opp.theme];
  const rec = await insertRecommendation(reportId, {
    rank,
    actionType: opp.actionType,
    theme: opp.theme,
    title: `Investigate ${label.toLowerCase()}`,
    opportunityName: label,
    rationale: 'A related query surfaced without a hard-coded assumption -- human review is required before this is used for audience targeting.',
    audience: THEME_AUDIENCE[opp.theme] || 'general',
    state: 'National',
    suggestedChannel: null,
    momentumSources: opp.momentumSources,
    continuityStatus: null,
    actionFingerprint: null,
    continuityMeta: null,
    strategyOutput: null,
    freshness: opp.evidenceItems[0]?.collected_at ? `Collected ${new Date(opp.evidenceItems[0].collected_at).toISOString().slice(0, 10)}` : null,
    confidence: opp.confidence,
    score: opp.score,
    scoreComponents: opp.components,
    recommendationKind: 'theme_disclaimer'
  });
  await linkDiverseEvidence(rec.id, opp.evidenceItems);
  return rec;
}

// The recommendation unit: a specific, evidence-backed candidate inside a
// theme (macro, micro, or seasonal -- all go through the same pipeline
// now, Claude decides which). Score/confidence/actionType all come from
// the candidate's OWN score, never the surrounding theme's -- the theme
// only decided which 3 slots compete for a recommendation today.
// opportunityName/rationale/recommendedAction/channel/format/creativeAngle/
// productConnection all come directly from Claude's validated assessment;
// nothing here second-guesses or rewrites that semantic content, it only
// decides the tier (via actionTypeForMicrotrend, already computed into
// winner.score before this runs) and persists it.
async function buildCandidateRecommendation({ reportId, rank, opp, winner, reportDate, sameDayRec }) {
  const { microtrend, assessment, score, components, distinctSourceCount, actionFingerprint } = winner;
  const name = assessment.candidateName;

  const recentRecs = await getRecentRecommendationsForMicrotrend(microtrend.id, reportDate, 14, reportId);
  // Deterministic, system-of-record continuity status -- judged against
  // THIS microtrend's own recommendation history, never the theme's
  // combined one (a brand-new microtrend under a long-running theme must
  // never be mislabeled "continuing").
  const continuityStatus = determineContinuityStatus({ recentRecs, sameDayRec, newFingerprint: actionFingerprint, todayScore: score, reportDate });

  if (assessment.classification === 'macro' && !microtrend.baseline_shown_at) {
    await setMicrotrendStatus(microtrend.id, 'active', { baselineShownAt: reportDate });
  }

  const confidence = confidenceForMicrotrend(score, distinctSourceCount);
  // actionTypeForMicrotrend decides Watch/Investigate/Create purely from
  // the deterministic score -- Claude's own proposedAction is the WHAT
  // (recommendedAction), never the tier.
  const actionType = actionTypeForMicrotrend(score);

  const titleByAction = {
    Create: `Own "${name}"`,
    Investigate: `Investigate "${name}"`,
    Watch: `Keep watching "${name}"`
  };

  const rec = await insertRecommendation(reportId, {
    rank,
    actionType,
    theme: opp.theme,
    title: titleByAction[actionType] || `${name} update`,
    opportunityName: name,
    rationale: assessment.whyItMattersNow,
    audience: THEME_AUDIENCE[opp.theme] || 'general',
    state: 'National',
    suggestedChannel: assessment.proposedAction.channel || suggestedChannelFor(opp.realSocialPostCount, opp.hasSearch),
    momentumSources: opp.momentumSources,
    continuityStatus,
    actionFingerprint,
    continuityMeta: {
      previousRecommendationDate: recentRecs[0] ? new Date(recentRecs[0].report_date).toISOString().slice(0, 10) : null,
      appearances14d: recentRecs.length,
      daysActive: recentRecs.length + 1,
      changeSincePrevious: null
    },
    strategyOutput: assessment,
    recommendedAction: assessment.proposedAction.recommendedAction,
    freshness: `Collected ${microtrend.last_seen_at instanceof Date ? microtrend.last_seen_at.toISOString().slice(0, 10) : microtrend.last_seen_at}`,
    confidence,
    score,
    scoreComponents: components,
    microtrendId: microtrend.id,
    recommendationKind: 'candidate'
  });

  // Idea Tracker row -- keyed by this stable action_fingerprint. A
  // materially different action under the same microtrend gets a
  // different fingerprint and therefore its own row; this call only
  // ensures the row exists, it never touches workflow_status.
  await ensureIdeaExists(actionFingerprint);

  // Evidence actually linked to the recommendation is what Claude cited
  // as grounding its claim (assessment.evidenceIds), restricted to real
  // rows -- the microtrend's own broader evidence trail (every real
  // member, cited or not) still accumulates via microtrend_evidence
  // regardless, for the Emerging section / audit.
  const microtrendEvidence = await getMicrotrendEvidence(microtrend.id, reportId);
  const cited = microtrendEvidence.filter((e) => assessment.evidenceIds.includes(e.id));
  await linkDiverseEvidence(rec.id, cited.length > 0 ? cited : microtrendEvidence);

  return rec;
}

// Shared "up to one piece of evidence per contributing source_type, most
// recent first" diversity rule -- used by every recommendation kind so the
// evidence drawer never shows 5x the same platform.
async function linkDiverseEvidence(recommendationId, items) {
  const seenTypes = new Set();
  const evidenceToLink = [];
  for (const item of items) {
    if (evidenceToLink.length >= 5) break;
    if (seenTypes.has(item.source_type) && evidenceToLink.length < items.length) {
      if (seenTypes.size >= distinctCount(items)) evidenceToLink.push(item);
      continue;
    }
    seenTypes.add(item.source_type);
    evidenceToLink.push(item);
  }
  for (const item of evidenceToLink) {
    await linkEvidence(recommendationId, item.id, null);
  }
}

function distinctCount(items) {
  return new Set(items.map((i) => i.source_type)).size;
}

module.exports = { buildReport, seasonalFit, lifecycleFor, THEME_RELEVANCE };
