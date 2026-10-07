const { XMLParser } = require('fast-xml-parser');
const { fetchWithTimeout } = require('../util/fetchWithTimeout');

const parser = new XMLParser({ ignoreAttributes: false });

/**
 * Google News RSS for one query, scoped to Australia. Free, no ToS risk, no
 * API key -- this is why it's in the "build now" list instead of behind a
 * feature flag. Returns { status, items } where each item is the original
 * RSS <item> plus a few pulled-out fields; nothing is invented if the feed
 * is briefly unreachable, that just comes back status: 'failed'.
 * @param {string} query
 */
async function search(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-AU&gl=AU&ceid=AU:en`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`Google News RSS returned ${res.status}`);
    const xml = await res.text();
    const parsed = parser.parse(xml);
    const rawItems = parsed?.rss?.channel?.item;
    const items = (Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : []).map((item) => ({
      title: typeof item.title === 'string' ? item.title : item.title?.['#text'],
      link: item.link,
      pubDate: item.pubDate,
      source: item.source?.['#text'] || item.source,
      guid: typeof item.guid === 'string' ? item.guid : item.guid?.['#text'],
      raw: item
    }));
    return { status: 'live', items };
  } catch (err) {
    return { status: 'failed', items: [], error: err.message };
  }
}

module.exports = { search };
