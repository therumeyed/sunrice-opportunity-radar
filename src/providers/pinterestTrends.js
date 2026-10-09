const { runActor } = require('../apifyClient');
const { themeForQuery } = require('../topics');
const { isGenuineMatch } = require('./apifySocial');

// A second, independent trend source alongside DataForSEO Google Trends
// (automation-lab/pinterest-trends-scraper, wrapping trends.pinterest.com).
// When the same query shows up rising on both, that's real cross-source
// corroboration -- reportBuilder.js's distinctSourceCount agreement scoring
// already rewards this automatically just by this being its own source_type,
// and separately flags it as a named momentum source (see momentumSources).
//
// Pinterest only offers Australia bundled with New Zealand ("AU+NZ") -- there
// is no standalone AU option for this actor -- so unlike every other source
// here, this is Australia+NZ data. Labelled as such in sourceName rather than
// silently treated as Australia-only.
const COUNTRY = 'AU+NZ';

// Only `term`, `trendType` and `rank` have a documented, verifiable meaning.
// The actor's own README doesn't state units for weeklyChange/monthlyChange/
// yearlyChange/normalizedCount/searchCount -- no percentage, no 0-100 scale,
// nothing confirmed. Per this project's data rule, an unverified number is
// never asserted as meaningful: these are kept in rawMetrics for audit/
// evidence only, never surfaced as a headline stat or handed to the LLM
// strategist as if their magnitude were known (the same caution DataForSEO's
// query values needed once their real production values didn't match their
// own documented scale either).
const TREND_TYPE_LABELS = {
  growing: 'Growing on Pinterest',
  top_monthly: 'Top monthly search on Pinterest',
  seasonal: 'Seasonal trend on Pinterest'
};

function notConfiguredReason() {
  if (process.env.FEATURE_APIFY_PINTEREST === 'false') return 'Disabled via FEATURE_APIFY_PINTEREST=false';
  if (!process.env.APIFY_TOKEN) return `APIFY_TOKEN not set in this process's environment`;
  return null;
}

// PinterestProvider.search(topicQueries, sinceDate) -- one actor run pulling
// Pinterest's own trending-term lists for AU+NZ (growing/top-monthly/
// seasonal), matched locally against every active topic query. Same
// one-run-covers-everything shape as the other Apify sources here, for the
// same reason: cheaper and more predictable than a per-query call.
async function searchPinterest(topicQueries, sinceDate) {
  const reason = notConfiguredReason();
  if (reason) return { status: 'awaiting_connection', items: [], error: reason };

  const actorId = process.env.APIFY_PINTEREST_ACTOR_ID || 'automation-lab/pinterest-trends-scraper';
  try {
    const { items, runId, datasetId } = await runActor(actorId, {
      countries: [COUNTRY],
      trendTypes: ['growing', 'top_monthly', 'seasonal'],
      lookbackWindow: '30D',
      maxResultsPerCountry: 150
    });

    const matched = (items || [])
      .flatMap((d) => {
        const term = (d.term || '').trim();
        if (!term) return [];
        const hitQuery = topicQueries.find((q) => isGenuineMatch(term, q));
        if (!hitQuery) return [];
        const scrapedAt = d.scrapedAt ? new Date(d.scrapedAt) : null;
        if (sinceDate && scrapedAt && scrapedAt < sinceDate) return []; // shouldn't fire given lookbackWindow, kept for parity with the other platforms
        // Pinterest's trending terms recur day to day (the same term can be
        // "growing" again tomorrow with a different rank) -- the content
        // hash needs today's date baked in via scrapedAt so each day gets
        // its own row, the same way dataforseo_trends' content_hash bakes
        // in reportDate. Without this, day 2's row would just dedupe away
        // against day 1's and this theme would show zero Pinterest evidence
        // on a day it's still genuinely trending.
        const dateKey = (d.scrapedAt || new Date().toISOString()).slice(0, 10);
        return [{
          platform: 'pinterest',
          externalId: `${term}:${d.country || COUNTRY}:${d.trendType || 'unknown'}:${dateKey}`,
          url: d.pinterestTrendsUrl || null,
          title: term,
          excerpt: TREND_TYPE_LABELS[d.trendType] || `Pinterest trend (${d.trendType || 'unspecified type'})`,
          author: null,
          publishedAt: scrapedAt,
          queryOrTopic: hitQuery,
          theme: themeForQuery(hitQuery),
          rawMetrics: {
            trendType: d.trendType || null,
            rank: typeof d.rank === 'number' ? d.rank : null,
            // Kept for audit/evidence only -- see the header comment above.
            // Never surfaced as a headline stat or handed to the LLM.
            normalizedCount: d.normalizedCount ?? null,
            searchCount: d.searchCount ?? null,
            weeklyChange: d.weeklyChange ?? null,
            monthlyChange: d.monthlyChange ?? null,
            yearlyChange: d.yearlyChange ?? null,
            seasonalityScore: d.seasonalityScore ?? null
          },
          rawPayload: { ...d, apifyRunId: runId, apifyDatasetId: datasetId }
        }];
      });
    return { status: 'live', items: matched };
  } catch (err) {
    return { status: 'failed', items: [], error: err.message };
  }
}

module.exports = { searchPinterest, COUNTRY, TREND_TYPE_LABELS };
