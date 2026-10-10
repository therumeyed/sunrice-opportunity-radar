// Writes a structured recommendation (opportunity name, rationale,
// recommended action, products, channel/format/angle) by reasoning over
// already-collected real evidence plus SunRice's real product catalog and
// real recommendation history -- e.g. spotting that a rising "biryani"
// query under a curry theme maps onto Basmati Rice, or that this exact
// theme was recommended three days ago and only needs a fresh angle, not
// a reinvented idea.
//
// Hard boundary: this NEVER decides score, confidence, action_type, ranking
// or continuity_status -- all of that stays deterministic (scoring.js,
// continuity.js) and auditable. This only writes prose and a creative
// proposal from data it's handed, and it must never invent a metric,
// source, product, or absolute number that isn't in the evidence/catalog
// it's given. A missing key, a failed call, an invalid/unparseable
// response, or a response that fails field validation all fall back to
// the existing deterministic template rationale -- this is a nice-to-have
// layer on top, never a dependency the report needs to succeed.
const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const { PRODUCTS } = require('./products');

// Catches a fabricated absolute search-volume count: a k/K-suffixed number
// (e.g. "103k") or a comma-grouped 4+ digit number (e.g. "600,000"). Our
// real evidence never contains either shape for a search metric -- kept as
// a safety net on top of the field-level validation below, not instead of it.
const FABRICATED_VOLUME_PATTERN = /\b\d+(?:\.\d+)?\s*[kK]\b|\b\d{1,3}(?:,\d{3})+\b/;

const MOMENTUM_SOURCE_LABELS = {
  google_trends: 'Google Trends (rising related queries)',
  pinterest: 'Pinterest (classified as a growing trend)'
};

const VALID_CONTINUITY_GUESSES = ['new', 'continuing', 'strengthening', 'weakening', 'new_angle', 'repeat_action'];
const PRODUCT_NAMES = new Set(PRODUCTS.map((p) => p.name));

// Every number this function hands to the LLM carries an explicit
// metricType so the prompt never passes an untyped field called just
// "value" -- the exact gap flagged after DataForSEO's rising-query value
// turned out not to match its own documented scale in production once
// already. `regional_interest_index` is the only number confirmed 0-100
// relative; a rising-query's own numeric value is NOT passed at all until
// its unit is verified for that context specifically (see risingList
// below) -- only the query text and the fact that it's classified rising.
function buildRisingList(risingQueries) {
  if (risingQueries.length === 0) return '(none returned)';
  return risingQueries.map((q) => `- "${q.query}" (classified by the source as a rising query; no verified numeric magnitude is passed for this field)`).join('\n');
}

function buildTopList(topQueries) {
  return topQueries.length > 0 ? topQueries.map((q) => `- "${q.query}"`).join('\n') : '(none returned)';
}

function buildRegionList(interestByRegion) {
  if (interestByRegion.length === 0) return '(none returned)';
  return interestByRegion.map((r) => `- ${r.region}: ${r.value} [metricType: regional_interest_index, 0-100, relative to this topic's own scale only]`).join('\n');
}

function buildMemoryBlock({ recentRecs, sameDayRec, lifecycle, daysActive, scoreChange, newSources, lostSources }) {
  const lines = [];
  if (sameDayRec) {
    lines.push(`This theme was ALREADY recommended once earlier today (before this refresh): "${sameDayRec.opportunity_name || sameDayRec.title}" -- action: ${sameDayRec.rationale?.slice(0, 200) || '(no rationale recorded)'}`);
  }
  if (recentRecs.length > 0) {
    lines.push(`Recommended ${recentRecs.length} time(s) in the last 14 days. Most recent: ${new Date(recentRecs[0].report_date).toISOString().slice(0, 10)} -- "${recentRecs[0].opportunity_name || recentRecs[0].title}", action: ${(recentRecs[0].rationale || '').slice(0, 200)}`);
  } else {
    lines.push('Not recommended in the last 14 days -- this is a fresh appearance for this theme.');
  }
  if (lifecycle) lines.push(`Current theme lifecycle: ${lifecycle}${daysActive != null ? ` (active ${daysActive} day${daysActive === 1 ? '' : 's'})` : ''}.`);
  if (scoreChange != null) lines.push(`Score change since the previous observation: ${scoreChange > 0 ? '+' : ''}${scoreChange}.`);
  if (newSources && newSources.length > 0) lines.push(`Newly contributing source(s) since last time: ${newSources.join(', ')}.`);
  if (lostSources && lostSources.length > 0) lines.push(`Source(s) that dropped out since last time: ${lostSources.join(', ')}.`);
  return lines.join('\n');
}

function buildPrompt(opportunity) {
  const {
    themeLabel, actionType, distinctSourceCount, risingQueries, topQueries, interestByRegion, socialExamples,
    momentumSources = [], recentRecs = [], sameDayRec = null, lifecycle = null, daysActive = null,
    scoreChange = null, newSources = [], lostSources = []
  } = opportunity;

  const productList = PRODUCTS.map((p) => `- ${p.name}${p.sizes ? ` (${p.sizes})` : ''}`).join('\n');
  const socialList = socialExamples.length > 0
    ? socialExamples.map((s) => `- [${s.platform}] "${(s.excerpt || '').slice(0, 200)}" (matched query: "${s.queryOrTopic}")`).join('\n')
    : '(none)';
  const momentumList = momentumSources.length > 0
    ? momentumSources.map((s) => `- ${MOMENTUM_SOURCE_LABELS[s] || s}`).join('\n')
    : '(not independently flagged as rising/growing by either source today)';
  const memoryBlock = buildMemoryBlock({ recentRecs, sameDayRec, lifecycle, daysActive, scoreChange, newSources, lostSources });

  return `You are a sharp, commercially-minded social media strategist for SunRice, an Australian rice company. You are given REAL evidence already collected for one theme today, SunRice's REAL current product range, and REAL recommendation history for this theme. Respond with ONLY a single valid JSON object (no markdown fences, no prose before or after it) matching exactly this shape:

{
  "opportunityName": "specific, concrete name grounded in the dominant evidence -- e.g. 'Homemade sushi tutorials', never the broad theme name like 'Sushi & Asian cooking'",
  "intentSummary": "one sentence: what people appear to be trying to do, based on the evidence",
  "rationale": "2-4 sentences: the why, grounded in the real evidence given below",
  "recommendedAction": "one concrete, specific action someone could execute tomorrow",
  "primaryProducts": ["exact product name(s) from the list below -- empty array if none genuinely fit"],
  "channel": "e.g. TikTok/Instagram Reels, Recipe/blog content, Pinterest board",
  "format": "e.g. Short-form how-to video, Written recipe post, Carousel",
  "creativeAngle": "the specific hook or execution idea",
  "continuityStatus": "your own best guess, one of: new | continuing | strengthening | weakening | new_angle | repeat_action -- this is advisory only, the system decides the real value deterministically from stored history",
  "changeSincePrevious": "one short factual sentence on what's different since the last time this theme was recommended, or 'first appearance' if new",
  "isMateriallyDifferentFromRecent": true or false,
  "evidenceReferences": ["which specific queries/excerpts above this is grounded in"]
}

Action-to-intent fit is mandatory: explicitly make sure recommendedAction/creativeAngle genuinely matches what intentSummary says people are trying to do. Do not default to the most generic, obvious interpretation of a theme when the evidence actually points somewhere more specific -- e.g. "school holidays" search interest fits road-trip snacks, picnic/park food, or activity-day snacks; it does NOT automatically fit ordinary school-day lunchboxes, because term-time lunchbox behaviour isn't what "school holidays" describes.

Hard rules -- breaking any of these makes your answer useless and it will be discarded:
- Use ONLY the evidence given below. Never invent a metric, count, query, or source that isn't listed.
- primaryProducts must contain ONLY exact names from SunRice's real product range below, or be empty. Never invent or guess a product.
- Only claim a specific product connection if it's a genuine, recognisable match -- if nothing maps cleanly, leave primaryProducts empty and recommend a non-product action (e.g. engaging with the matched social post) instead.
- CRITICAL -- metric types: every number given below carries an explicit metricType. Regional interest values are a 0-100 RELATIVE index only, never an absolute count. Rising queries below are given as TEXT ONLY, with no numeric magnitude -- because that field's real-world unit isn't verified for this context. Never state or imply an absolute number of searches (e.g. "103k searches", "600,000 monthly searches") -- none of that exists in the evidence and inventing one gets this rejected outright. Never call a rising query's classification a "search volume". If you want to describe strength of demand, use the actual regional index value or plain words like "strong, sustained interest" -- and only use the word "sustained" if the lifecycle/history information below actually supports it; otherwise say "early" or "rising" instead.
- If recommendation history below shows this exact theme was recently recommended, do not present it as a brand-new idea -- say so plainly in changeSincePrevious, and propose a genuinely different angle/execution if the evidence supports one, or state plainly that nothing material has changed if it doesn't.
- Be specific and commercial, not generic marketing filler. No "own the moment" cliches, no exclamation points, no vague "leverage this opportunity" language.

Theme: ${themeLabel}
Action already decided (do not change or second-guess it): ${actionType}
Independent sources corroborating this: ${distinctSourceCount}
Independently flagged as rising/growing right now by:
${momentumList}

Rising related search queries (text only, no numeric magnitude -- see metric-type rule above):
${buildRisingList(risingQueries)}

Top related search queries:
${buildTopList(topQueries)}

Regional search interest:
${buildRegionList(interestByRegion)}

Real social post examples matched to this theme:
${socialList}

Recommendation history for this theme:
${memoryBlock}

SunRice's real current product range:
${productList}

Respond with ONLY the JSON object described above. No preamble, no markdown fences, no text outside the JSON.`;
}

// Strips a markdown code fence if the model wrapped the JSON in one despite
// being told not to -- cheap, common failure mode, worth tolerating rather
// than discarding an otherwise-valid response over it.
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

// Every field the deterministic layer or the UI will actually read gets
// validated here -- this is the primary validator per the brief; the regex
// above is an additional safety net, not a substitute for this. Returns
// the validated object, or null (triggering the deterministic fallback).
function validateStructuredResponse(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const { opportunityName, intentSummary, rationale, recommendedAction, primaryProducts, channel, format, creativeAngle } = parsed;
  if (!opportunityName || !rationale || !recommendedAction) return null;
  if (typeof rationale !== 'string' || rationale.length > 1000) return null;

  const products = Array.isArray(primaryProducts) ? primaryProducts : [];
  const invalidProduct = products.find((p) => !PRODUCT_NAMES.has(p));
  if (invalidProduct) {
    console.warn(`[llmStrategist] rejecting response: invalid product "${invalidProduct}" not in the real catalogue`);
    return null;
  }

  const combinedText = [opportunityName, intentSummary, rationale, recommendedAction, creativeAngle].filter(Boolean).join(' ');
  if (FABRICATED_VOLUME_PATTERN.test(combinedText)) {
    console.warn('[llmStrategist] rejecting response: contains a fabricated-looking absolute number');
    return null;
  }

  const continuityGuess = VALID_CONTINUITY_GUESSES.includes(parsed.continuityStatus) ? parsed.continuityStatus : null;

  return {
    opportunityName: String(opportunityName).slice(0, 200),
    intentSummary: intentSummary ? String(intentSummary).slice(0, 300) : null,
    rationale: String(rationale),
    recommendedAction: String(recommendedAction).slice(0, 500),
    primaryProducts: products,
    channel: channel ? String(channel).slice(0, 120) : null,
    format: format ? String(format).slice(0, 120) : null,
    creativeAngle: creativeAngle ? String(creativeAngle).slice(0, 300) : null,
    continuityStatusGuess: continuityGuess,
    changeSincePrevious: parsed.changeSincePrevious ? String(parsed.changeSincePrevious).slice(0, 300) : null,
    isMateriallyDifferentFromRecent: Boolean(parsed.isMateriallyDifferentFromRecent),
    evidenceReferences: Array.isArray(parsed.evidenceReferences) ? parsed.evidenceReferences.slice(0, 10).map(String) : []
  };
}

// Returns the validated structured object (plus `raw`, the verbatim parsed
// JSON kept for strategy_output audit), or null on any failure -- missing
// key, HTTP failure, unparseable JSON, or failed field validation all fall
// back identically. Never a dependency the report needs to succeed.
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
        max_tokens: 700,
        messages: [{ role: 'user', content: buildPrompt(opportunity) }]
      })
    });
    if (!res.ok) throw new Error(`Anthropic strategist call failed: ${res.status} ${await res.text()}`);

    const data = await res.json();
    const text = (data.content?.[0]?.text || '').trim();
    if (!text || text.length > 4000) return null;

    let parsed;
    try {
      parsed = JSON.parse(extractJson(text));
    } catch (parseErr) {
      console.warn(`[llmStrategist] falling back to deterministic rationale: response was not valid JSON (${parseErr.message})`);
      return null;
    }

    const validated = validateStructuredResponse(parsed);
    if (!validated) {
      console.warn('[llmStrategist] falling back to deterministic rationale: response failed field validation');
      return null;
    }
    return { ...validated, raw: parsed };
  } catch (err) {
    console.warn(`[llmStrategist] falling back to deterministic rationale: ${err.message}`);
    return null;
  }
}

module.exports = { writeRationale, validateStructuredResponse, extractJson };
