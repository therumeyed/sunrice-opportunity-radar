const { runActor } = require('../apifyClient');
const { themeForQuery } = require('../topics');
const { matchesAny } = require('../util/textMatch');

function subreddits() {
  return (process.env.APIFY_REDDIT_SUBREDDITS || 'MealPrepSunday,EatCheapAndHealthy,AskCulinary,budgetfood,AskAnAustralian')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

function slugifyHashtag(query) {
  return query.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Distinguishes "deliberately turned off" from "never configured" instead of
// a blank awaiting_connection row that leaves no way to tell which one it
// is from Source health alone.
function notConfiguredReason(featureFlagEnvVar) {
  if (process.env[featureFlagEnvVar] === 'false') return `Disabled via ${featureFlagEnvVar}=false`;
  if (!process.env.APIFY_TOKEN) return `APIFY_TOKEN not set in this process's environment`;
  return null;
}

// SocialProvider.search(topicQueries, sinceDate) for Reddit -- one actor run
// scanning each configured subreddit's newest posts, then locally matched
// against every active topic query (cheaper and more predictable than a
// site-wide search on a pay-per-result actor -- same approach proven on the
// Melbourne Airport dashboard in this account).
async function searchReddit(topicQueries, sinceDate) {
  const reason = notConfiguredReason('FEATURE_APIFY_REDDIT');
  if (reason) return { status: 'awaiting_connection', items: [], error: reason };

  const actorId = process.env.APIFY_REDDIT_ACTOR_ID || 'trudax/reddit-scraper-lite';
  try {
    const { items, runId, datasetId } = await runActor(actorId, {
      startUrls: subreddits().map((sub) => ({ url: `https://www.reddit.com/r/${sub}/new/` })),
      maxItems: 100,
      maxPostCount: 40,
      maxComments: 0,
      skipComments: true
    });

    const matched = (items || [])
      .filter((d) => !d.parentId) // comments carry parentId, posts don't
      .filter((d) => !d.createdAt || new Date(d.createdAt) >= sinceDate)
      .flatMap((d) => {
        const text = `${d.title || ''} ${d.body || ''}`;
        const hitQuery = topicQueries.find((q) => matchesAny(text, [q]));
        if (!hitQuery) return [];
        return [{
          platform: 'reddit',
          externalId: d.id || d.parsedId || d.url,
          url: d.url,
          title: d.title || null,
          excerpt: (d.body || '').slice(0, 500),
          author: d.username || null,
          publishedAt: d.createdAt || null,
          queryOrTopic: hitQuery,
          theme: themeForQuery(hitQuery),
          rawMetrics: { upvotes: d.upVotes, numComments: d.numberOfComments },
          rawPayload: { ...d, apifyRunId: runId, apifyDatasetId: datasetId }
        }];
      });
    return { status: 'live', items: matched };
  } catch (err) {
    return { status: 'failed', items: [], error: err.message };
  }
}

// TikTok via a search-based actor. One run covering every active topic query
// keeps this to a single billed run/day instead of one per query.
async function searchTikTok(topicQueries, sinceDate) {
  const reason = notConfiguredReason('FEATURE_APIFY_TIKTOK');
  if (reason) return { status: 'awaiting_connection', items: [], error: reason };

  const actorId = process.env.APIFY_TIKTOK_ACTOR_ID || 'clockworks/tiktok-scraper';
  const searchQueries = (process.env.APIFY_TIKTOK_SEARCH_TERMS
    ? process.env.APIFY_TIKTOK_SEARCH_TERMS.split(',').map((s) => s.trim()).filter(Boolean)
    : topicQueries);

  try {
    const { items, runId, datasetId } = await runActor(actorId, {
      searchQueries,
      resultsPerPage: 20,
      shouldDownloadVideos: false,
      shouldDownloadCovers: false
    });

    const matched = (items || [])
      .filter((d) => !d.createTimeISO || new Date(d.createTimeISO) >= sinceDate)
      .flatMap((d) => {
        const text = `${d.text || ''} ${(d.hashtags || []).map((h) => h.name).join(' ')}`;
        const hitQuery = d.searchQuery && searchQueries.includes(d.searchQuery)
          ? d.searchQuery
          : searchQueries.find((q) => matchesAny(text, [q]));
        if (!hitQuery) return [];
        return [{
          platform: 'tiktok',
          externalId: d.id || d.webVideoUrl,
          url: d.webVideoUrl,
          title: null,
          excerpt: (d.text || '').slice(0, 500),
          author: d.authorMeta?.name || null,
          publishedAt: d.createTimeISO || null,
          queryOrTopic: hitQuery,
          theme: themeForQuery(hitQuery),
          rawMetrics: { plays: d.playCount, likes: d.diggCount, comments: d.commentCount, shares: d.shareCount },
          rawPayload: { ...d, apifyRunId: runId, apifyDatasetId: datasetId }
        }];
      });
    return { status: 'live', items: matched };
  } catch (err) {
    return { status: 'failed', items: [], error: err.message };
  }
}

// Instagram has no free-text post search -- hashtag search is the closest
// real capability (same constraint documented on the Melbourne Airport
// dashboard), so this only catches posts tagged with a topic-derived hashtag.
async function searchInstagram(topicQueries, sinceDate) {
  const reason = notConfiguredReason('FEATURE_APIFY_INSTAGRAM');
  if (reason) return { status: 'awaiting_connection', items: [], error: reason };

  const actorId = process.env.APIFY_INSTAGRAM_ACTOR_ID || 'instaprism/instagram-hashtag-posts';
  const hashtags = (process.env.APIFY_INSTAGRAM_HASHTAGS
    ? process.env.APIFY_INSTAGRAM_HASHTAGS.split(',').map((h) => h.trim()).filter(Boolean)
    : topicQueries.map(slugifyHashtag)).slice(0, 10); // cap -- one actor call per hashtag on some plans

  try {
    const { items, runId, datasetId } = await runActor(actorId, {
      hashtags,
      limit: 30,
      sortBy: 'recent'
    });

    const matched = (items || [])
      .filter((d) => !d.publishedAt || new Date(d.publishedAt) >= sinceDate)
      .flatMap((d) => {
        const matchedHashtag = hashtags.find((h) => (d.hashtags || []).some((x) => String(x).toLowerCase() === h.toLowerCase()));
        const hitQuery = topicQueries[hashtags.indexOf(matchedHashtag)] || topicQueries.find((q) => slugifyHashtag(q) === matchedHashtag) || null;
        return [{
          platform: 'instagram',
          externalId: d.postId || d.url,
          url: d.url,
          title: null,
          excerpt: (d.caption || '').slice(0, 500),
          author: d.authorId || null,
          publishedAt: d.publishedAt || null,
          queryOrTopic: hitQuery,
          theme: hitQuery ? themeForQuery(hitQuery) : null,
          rawMetrics: { likes: d.likesCount, comments: d.commentsCount },
          rawPayload: { ...d, apifyRunId: runId, apifyDatasetId: datasetId }
        }];
      });
    return { status: 'live', items: matched };
  } catch (err) {
    return { status: 'failed', items: [], error: err.message };
  }
}

module.exports = { searchReddit, searchTikTok, searchInstagram };
