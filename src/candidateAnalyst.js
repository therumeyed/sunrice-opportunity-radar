// Claude is AUTHORITATIVE for interpreting what today's real evidence
// means -- macro/micro/seasonal classification, whether a candidate is
// genuinely distinct from an obvious evergreen topic, semantic
// relationships between differently-worded candidates, brand relevance,
// product fit, why it matters now, and the specific action to propose.
// This is a correction from an earlier version of this file
// (src/llmStrategist.js, now retired) that only asked an LLM to write
// prose AFTER a purely deterministic pipeline had already decided
// everything that mattered -- that treated Claude as decoration. It is
// not decoration here: with no usable analysis, there is no recommendation
// at all (see reportBuilder.js) -- no generic deterministic fallback copy.
//
// Deterministic code stays authoritative for everything measurable:
// whether cited evidence IDs are real, all source metrics, freshness/
// velocity/agreement math, recommendation history, feedback exclusions,
// deduplication, minimum evidence requirements, and -- critically -- the
// final Watch/Investigate/Create tier. Claude's own `proposedAction` is
// the actual recommendation (what to go create or which conversation to
// join); it is never asked for and never gets to set the tier.
//
// Batched: one call covers every candidate across every theme from a
// single ingest run, so Claude can compare signals against each other
// and judge which ones are genuinely distinctive -- not one call per
// candidate.
const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const { PRODUCTS } = require('./products');

const PRODUCT_NAMES = new Set(PRODUCTS.map((p) => p.name));
const VALID_CLASSIFICATIONS = new Set(['macro', 'micro', 'seasonal']);

// Same safety net as the retired llmStrategist.js -- our real evidence
// never contains a k/K-suffixed or comma-grouped absolute number for a
// search metric, so one appearing in Claude's own prose is a tell that
// it invented a number rather than describing what it was actually given.
const FABRICATED_VOLUME_PATTERN = /\b\d+(?:\.\d+)?\s*[kK]\b|\b\d{1,3}(?:,\d{3})+\b/;

function isConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// --- Prompt construction (pure) ------------------------------------------

function formatMember(m) {
  const metric = m.metricValue != null ? `, ${m.metricType}=${m.metricValue}` : '';
  return `    - [evidenceId ${m.sourceItemId}] ${m.sourceType} (${m.matchType}${metric})`;
}

function formatCandidate(c) {
  return `  - clusterKey: "${c.clusterKey}"\n    wording seen in evidence: "${c.displayText}"\n    evidence:\n${c.members.map(formatMember).join('\n')}`;
}

function formatTheme(t) {
  const positives = (t.positiveExamples || []).length > 0
    ? t.positiveExamples.map((ex) => `  - "${ex.opportunity_name}" via ${ex.suggested_channel || '(no channel recorded)'}`).join('\n')
    : '  (none yet)';
  return `### Theme: ${t.themeLabel} (key: ${t.theme})
Seed queries for this theme (a candidate identical to one of these is MACRO, the theme's own baseline, not a microtrend): ${t.seedQueries.join(', ') || '(none)'}
Evergreen baseline phrases for this theme (also MACRO even if phrased as a full question -- not a microtrend just for being specific-sounding): ${(t.evergreenBaselines || []).join(', ') || '(none)'}
Past recommendations the team marked useful for this theme (style/channel reference only -- never a reason to repeat an idea outright):
${positives}

Candidates extracted from today's real evidence for this theme:
${t.candidates.map(formatCandidate).join('\n')}`;
}

function buildBatchPrompt(themeBatches) {
  const productList = PRODUCTS.map((p) => `- ${p.name}${p.sizes ? ` (${p.sizes})` : ''}`).join('\n');
  return `You are a sharp, commercially-minded content strategist for SunRice, an Australian rice company. You are given REAL candidate signals already extracted from today's real evidence (Google Trends rising/top queries, Pinterest trend terms), grouped by theme. Your job is to interpret what each one actually means -- never to invent anything.

Respond with ONLY a single valid JSON array (no markdown fences, no prose before or after it). Each element assesses ONE candidate idea, shaped exactly like this:

{
  "clusterKeys": ["<exact clusterKey string(s) from the input this assessment covers>"],
  "candidateName": "specific, concrete name grounded in the dominant evidence -- never the broad theme name",
  "parentTheme": "<theme key>",
  "classification": "macro" | "micro" | "seasonal",
  "isDistinctFromEvergreen": true or false,
  "brandRelevance": 0.0 to 1.0,
  "productConnection": ["exact product name(s) from the list below -- empty array if nothing genuinely fits"],
  "whyItMattersNow": "1-2 sentences: the specific reason this is worth attention today, grounded in the evidence given",
  "proposedAction": {
    "recommendedAction": "one concrete, specific action someone could execute tomorrow",
    "channel": "e.g. TikTok/Instagram Reels, Recipe/blog content, Pinterest board",
    "format": "e.g. Short-form how-to video, Written recipe post, Carousel",
    "creativeAngle": "the specific hook or execution idea"
  },
  "evidenceIds": [<real evidenceId numbers from the candidate(s) this assessment covers>]
}

How to use clusterKeys -- THIS IS WHERE YOU DO REAL ANALYTICAL WORK, not just restate the input:
- One candidate normally maps to one clusterKey.
- If two or more candidates in the SAME theme use different wording for what is clearly the same underlying idea (e.g. "sushi rice bowl recipe" and "how to make a sushi bowl at home"), list every one of their clusterKeys together in ONE assessment, so they're treated as a single idea. Only do this when you are confident they are genuinely the same idea -- when unsure, keep them separate.
- Every clusterKey from the input must appear in exactly one assessment in your output. Do not drop any, and do not invent a clusterKey that wasn't given to you.

Classification rules:
- macro: identical in meaning to the theme's own seed query, or matches an evergreen baseline phrase for that theme -- this is the theme's own baseline behaviour, not a trend. Still assess it (brand relevance, product fit, etc. all still apply) -- being macro doesn't mean "skip it", it means "this is the evergreen case, not a fresh discovery."
- seasonal: tied to a specific dated occasion (Christmas, Lunar New Year, etc.) regardless of theme.
- micro: a genuinely more specific, narrower idea than the theme's own baseline. The default is specificity -- do not call something a microtrend just because it's a long or unusual-sounding phrase; an evergreen idea stated as a full question is still macro.

Hard rules -- breaking any of these makes that assessment useless and it will be discarded:
- Use ONLY the evidence given below. Never invent a metric, count, query, evidenceId, or source that isn't listed. Never state or imply an absolute search-volume number (e.g. "103k searches") -- none of that exists in the evidence given.
- evidenceIds must be real evidenceId numbers copied from the candidates you're covering. Never invent one.
- productConnection must contain ONLY exact names from SunRice's real product range below, or be empty. Only claim a product connection if it's a genuine, recognisable match.
- Be specific and commercial, not generic marketing filler. No "own the moment" cliches, no exclamation points, no vague "leverage this opportunity" language.
- Action-to-intent fit is mandatory: recommendedAction/creativeAngle must genuinely match what the evidence suggests people are trying to do, not the most generic interpretation of the theme.

${themeBatches.map(formatTheme).join('\n\n')}

SunRice's real current product range:
${productList}

Respond with ONLY the JSON array described above. No preamble, no markdown fences, no text outside the array.`;
}

// --- Response parsing/validation (pure) ----------------------------------

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

// clusterKeyToMembers: Map<clusterKey, Array<{sourceItemId, ...}>> -- the
// real input, used to validate everything Claude cites against ground
// truth. Returns the normalized assessment, or null if it fails validation
// (missing required field, zero valid clusterKeys, zero valid evidenceIds,
// an invalid product, a fabricated-looking number, or a bad classification).
function validateAssessment(raw, clusterKeyToMembers) {
  if (!raw || typeof raw !== 'object') return null;
  const { candidateName, parentTheme, classification, whyItMattersNow, proposedAction } = raw;
  if (!candidateName || !parentTheme || !whyItMattersNow) return null;
  if (!VALID_CLASSIFICATIONS.has(classification)) return null;
  if (!proposedAction || typeof proposedAction !== 'object' || !proposedAction.recommendedAction) return null;

  const requestedKeys = Array.isArray(raw.clusterKeys) ? raw.clusterKeys : [];
  const clusterKeys = requestedKeys.filter((k) => clusterKeyToMembers.has(k));
  if (clusterKeys.length === 0) return null; // doesn't reference any real candidate -- invented or garbled

  const realEvidenceIds = new Set(clusterKeys.flatMap((k) => clusterKeyToMembers.get(k).map((m) => m.sourceItemId)));
  const requestedEvidenceIds = Array.isArray(raw.evidenceIds) ? raw.evidenceIds : [];
  const evidenceIds = requestedEvidenceIds.filter((id) => realEvidenceIds.has(id));
  if (evidenceIds.length === 0) return null; // no real evidence grounds this -- not a real candidate

  const products = Array.isArray(raw.productConnection) ? raw.productConnection : [];
  const invalidProduct = products.find((p) => !PRODUCT_NAMES.has(p));
  if (invalidProduct) {
    console.warn(`[candidateAnalyst] rejecting "${candidateName}": invalid product "${invalidProduct}" not in the real catalogue`);
    return null;
  }

  const combinedText = [candidateName, whyItMattersNow, proposedAction.recommendedAction, proposedAction.creativeAngle].filter(Boolean).join(' ');
  if (FABRICATED_VOLUME_PATTERN.test(combinedText)) {
    console.warn(`[candidateAnalyst] rejecting "${candidateName}": contains a fabricated-looking absolute number`);
    return null;
  }

  const brandRelevance = typeof raw.brandRelevance === 'number' && !Number.isNaN(raw.brandRelevance)
    ? Math.max(0, Math.min(1, raw.brandRelevance))
    : null;
  if (brandRelevance == null) return null;

  return {
    clusterKeys,
    candidateName: String(candidateName).slice(0, 200),
    parentTheme: String(parentTheme),
    classification,
    isDistinctFromEvergreen: Boolean(raw.isDistinctFromEvergreen),
    brandRelevance,
    productConnection: products,
    whyItMattersNow: String(whyItMattersNow).slice(0, 500),
    proposedAction: {
      recommendedAction: String(proposedAction.recommendedAction).slice(0, 500),
      channel: proposedAction.channel ? String(proposedAction.channel).slice(0, 120) : null,
      format: proposedAction.format ? String(proposedAction.format).slice(0, 120) : null,
      creativeAngle: proposedAction.creativeAngle ? String(proposedAction.creativeAngle).slice(0, 300) : null
    },
    evidenceIds
  };
}

// Builds clusterKeyToMembers once from the same themeBatches shape used to
// build the prompt, so callers never have to construct it separately.
function buildClusterKeyIndex(themeBatches) {
  const index = new Map();
  for (const theme of themeBatches) {
    for (const candidate of theme.candidates) {
      index.set(candidate.clusterKey, candidate.members);
    }
  }
  return index;
}

function parseAndValidateResponse(rawText, themeBatches) {
  const clusterKeyToMembers = buildClusterKeyIndex(themeBatches);
  let parsed;
  try {
    parsed = JSON.parse(extractJson(rawText));
  } catch (err) {
    return { assessments: [], rejectedCount: 0, parseError: err.message };
  }
  if (!Array.isArray(parsed)) return { assessments: [], rejectedCount: 0, parseError: 'response was not a JSON array' };

  const assessments = [];
  let rejectedCount = 0;
  for (const raw of parsed) {
    const validated = validateAssessment(raw, clusterKeyToMembers);
    if (validated) assessments.push(validated);
    else rejectedCount++;
  }
  return { assessments, rejectedCount };
}

// --- Network call with one retry -----------------------------------------

async function callOnce(prompt) {
  const res = await fetch(ANTHROPIC_API_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!res.ok) throw new Error(`Anthropic candidate-analysis call failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const text = (data.content?.[0]?.text || '').trim();
  if (!text) throw new Error('Anthropic candidate-analysis call returned empty content');
  return text;
}

/**
 * The single entry point reportBuilder.js calls. Analysis is mandatory for
 * a recommendation to exist at all -- no ANTHROPIC_API_KEY, or a call that
 * still fails after one retry, returns status 'unavailable' and
 * reportBuilder.js shows "AI analysis unavailable" with zero
 * recommendations rather than any deterministic fallback copy.
 * @returns {Promise<{status: 'ok', assessments: Array} | {status: 'unavailable', reason: string}>}
 */
async function analyzeCandidates(themeBatches) {
  if (!isConfigured()) {
    return { status: 'unavailable', reason: 'ANTHROPIC_API_KEY is not set in this process\'s environment' };
  }
  if (themeBatches.every((t) => t.candidates.length === 0)) {
    return { status: 'ok', assessments: [] }; // nothing to analyze -- not a failure
  }

  const prompt = buildBatchPrompt(themeBatches);
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await callOnce(prompt);
      const { assessments, rejectedCount, parseError } = parseAndValidateResponse(text, themeBatches);
      if (parseError) {
        lastError = parseError;
        continue; // malformed JSON is worth one retry, same as a transport failure
      }
      if (rejectedCount > 0) {
        console.warn(`[candidateAnalyst] ${rejectedCount} assessment(s) rejected validation this run`);
      }
      return { status: 'ok', assessments };
    } catch (err) {
      lastError = err.message;
      console.warn(`[candidateAnalyst] attempt ${attempt + 1} failed: ${err.message}`);
    }
  }
  return { status: 'unavailable', reason: `Anthropic candidate analysis failed after retry: ${lastError}` };
}

module.exports = {
  isConfigured, buildBatchPrompt, extractJson, validateAssessment, parseAndValidateResponse,
  buildClusterKeyIndex, analyzeCandidates
};
