// Writes the recommendation rationale by reasoning over already-collected
// real evidence plus SunRice's real product catalog -- e.g. spotting that a
// rising "biryani" query under a curry-related theme maps onto Basmati
// Rice, something the deterministic scorer has no way to know since it
// only counts signals, it doesn't understand what they mean.
//
// Hard boundary: this NEVER touches score, confidence, action_type or which
// opportunities make the top 3 -- all of that stays deterministic and
// auditable per the brief's non-negotiable data rule. This only writes
// prose from data it's handed, and it must never invent a metric, source,
// or product that isn't in the evidence/catalog it's given. A missing key,
// a failed call, or a suspicious response all fall back to the existing
// deterministic template rationale -- this is a nice-to-have layer on top,
// never a dependency the report needs to succeed.
const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const { PRODUCTS } = require('./products');

// Catches a fabricated absolute search-volume count: a k/K-suffixed number
// (e.g. "103k") or a comma-grouped 4+ digit number (e.g. "600,000"). Our real
// evidence never contains either shape -- DataForSEO Trends only supplies a
// 0-100 relative index -- so a match here means the model invented a stat.
const FABRICATED_VOLUME_PATTERN = /\b\d+(?:\.\d+)?\s*[kK]\b|\b\d{1,3}(?:,\d{3})+\b/;

const MOMENTUM_SOURCE_LABELS = {
  google_trends: 'Google Trends (rising related queries)',
  pinterest: 'Pinterest (classified as a growing trend)'
};

function buildPrompt({ themeLabel, actionType, distinctSourceCount, risingQueries, topQueries, interestByRegion, socialExamples, momentumSources = [] }) {
  const productList = PRODUCTS.map((p) => `- ${p.name}${p.sizes ? ` (${p.sizes})` : ''}`).join('\n');
  const risingList = risingQueries.length > 0
    ? risingQueries.map((q) => `- "${q.query}"${q.value != null ? ` (${q.value})` : ''}`).join('\n')
    : '(none returned)';
  const topList = topQueries.length > 0 ? topQueries.map((q) => `- "${q.query}"`).join('\n') : '(none returned)';
  const regionList = interestByRegion.length > 0
    ? interestByRegion.map((r) => `- ${r.region}: ${r.value}`).join('\n')
    : '(none returned)';
  const socialList = socialExamples.length > 0
    ? socialExamples.map((s) => `- [${s.platform}] "${(s.excerpt || '').slice(0, 200)}" (matched query: "${s.queryOrTopic}")`).join('\n')
    : '(none)';
  const momentumList = momentumSources.length > 0
    ? momentumSources.map((s) => `- ${MOMENTUM_SOURCE_LABELS[s] || s}`).join('\n')
    : '(not independently flagged as rising/growing by either source today)';

  return `You are a sharp, commercially-minded social media strategist for SunRice, an Australian rice company. You are given REAL evidence already collected for one theme today, and SunRice's REAL current product range. Write ONE tight paragraph (2-4 sentences, no more): first the "why" grounded in the real evidence, then ONE concrete, specific action to actually take.

The concrete action must be ONE of these three types -- pick whichever the evidence actually supports, don't force one that doesn't fit:
1. A specific social post/video idea using a named product from the list (e.g. what to show, what angle -- concrete enough that someone could film it tomorrow).
2. A recipe or how-to content idea built around a named product (e.g. a real recognisable dish that product could be used for).
3. Directly engaging with the specific matched social post/thread already given as evidence below (reply, comment, join the conversation) -- reference what that post is about, not a generic "engage on social" instruction. Don't invent a URL or quote text not given below; the real link is already shown separately in the dashboard.

Hard rules -- breaking any of these makes your answer useless:
- Use ONLY the evidence given below. Never invent a metric, count, query, or source that isn't listed.
- Only mention a product from the list below. Never invent a product or suggest one that isn't listed.
- Only claim a specific product connection (e.g. a rising query maps onto an existing product) if it's a genuine, recognisable match -- if nothing in the evidence maps cleanly onto a listed product, don't force one; fall back to whichever of the three action types the evidence actually supports.
- Be specific and commercial, not generic marketing filler. No "own the moment" cliches, no exclamation points, no vague "leverage this opportunity" language.
- CRITICAL: the search numbers given below are a relative interest index (0-100, that topic's own scale) and a source count, NEVER absolute search volumes. You do not have real search volume data. Never state or imply an absolute number of searches, monthly volume, or count of people searching (e.g. "103k searches", "600,000 monthly searches") -- that number does not exist in the evidence and inventing one is the one thing that will get this rejected outright. If you want to describe strength of demand, use the actual 0-100 index value or plain words like "strong, sustained interest" -- never a fabricated count.
- If the list below shows this topic independently flagged as rising/growing by more than one source, that's a genuinely strong "why" worth naming explicitly (e.g. "rising on both Google Trends and Pinterest right now") -- but only state it if the list below actually shows it, and never attach a number or percentage to how much it grew.

Theme: ${themeLabel}
Action already decided (do not change or second-guess it): ${actionType}
Independent sources corroborating this: ${distinctSourceCount}
Independently flagged as rising/growing right now by:
${momentumList}

Rising related search queries:
${risingList}

Top related search queries:
${topList}

Regional search interest (0-100, this topic's own scale, not comparable to other topics):
${regionList}

Real social post examples matched to this theme:
${socialList}

SunRice's real current product range:
${productList}

Respond with ONLY the rationale paragraph. No preamble, no markdown, no quotes around it.`;
}

async function writeRationale(opportunity) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch(ANTHROPIC_API_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        messages: [{ role: 'user', content: buildPrompt(opportunity) }]
      })
    });
    if (!res.ok) throw new Error(`Anthropic strategist call failed: ${res.status} ${await res.text()}`);

    const data = await res.json();
    const text = (data.content?.[0]?.text || '').trim();
    // A suspiciously long or empty response is more likely a malformed
    // answer than a real rationale -- fall back rather than show it.
    if (!text || text.length > 1000) return null;
    // Safety net, not just a prompt instruction: our evidence never contains
    // an absolute search-volume number (DataForSEO Trends only gives a 0-100
    // relative index), so any k/K-suffixed count or comma-grouped 4+ digit
    // number in the output is a fabricated statistic -- reject outright
    // rather than show an invented metric on the dashboard.
    if (FABRICATED_VOLUME_PATTERN.test(text)) {
      console.warn(`[llmStrategist] falling back to deterministic rationale: response contained a fabricated absolute number`);
      return null;
    }
    return text;
  } catch (err) {
    console.warn(`[llmStrategist] falling back to deterministic rationale: ${err.message}`);
    return null;
  }
}

module.exports = { writeRationale };
