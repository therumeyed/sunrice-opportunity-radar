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
// Batched: a handful of calls cover every candidate across every theme
// from a single ingest run (chunkThemeBatches), so Claude can still
// compare signals within a theme and judge which ones are genuinely
// distinctive -- never one call per candidate, and never so few calls
// that a busy day's total candidate volume overruns a single response.
const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const { PRODUCTS } = require('./products');
const suitabilityConfig = require('./suitabilityConfig');
const { validateEligibilityBlock } = require('./eligibility');
const { computeSunriceFit } = require('./sunriceFit');

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

const SOURCE_LABELS = { apify_reddit: 'Reddit post', apify_tiktok: 'TikTok post', apify_instagram: 'Instagram post' };

function formatMember(m) {
  const metric = m.metricValue != null ? `, ${m.metricType}=${m.metricValue}` : '';
  const label = SOURCE_LABELS[m.sourceType] || m.sourceType;
  // Stage 4 (IMPLEMENTATION_CHECKLIST.md): geography is shown so Claude can
  // judge "could this translate to an Australian audience" honestly --
  // "unknown" is a real, distinct state from "confirmed Australian", never
  // collapsed into one or the other.
  const geo = m.geography
    ? ` [geography: ${m.geography}, ${m.geographyConfidence === 'confirmed' ? 'confirmed' : 'unconfirmed'}]`
    : ' [geography: unknown]';
  return `    - [evidenceId ${m.sourceItemId}] ${label} (${m.matchType}${metric})${geo}`;
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
  return `You are a sharp, commercially-minded content strategist for SunRice, an Australian rice company. You are given REAL candidate signals from today's real evidence, grouped by theme. Two kinds of candidate:
1. Google Trends rising/top queries and Pinterest trend terms -- short query/term strings.
2. Real social posts (Reddit/TikTok/Instagram) -- each one is the ACTUAL text of one real post, given to you verbatim as that candidate's "wording seen in evidence". For these, your job is to read the post and identify the specific dish, behaviour, problem, ingredient combination, audience, or creative format it's actually about -- grounded ONLY in what that post actually says. Never invent a dish or behaviour the post doesn't describe.

Your job is to interpret what each candidate actually means -- never to invent anything.

Respond with ONLY a single valid JSON array (no markdown fences, no prose before or after it). Each element assesses ONE candidate idea, shaped exactly like this:

{
  "clusterKeys": ["<exact clusterKey string(s) from the input this assessment covers>"],
  "candidateName": "specific, concrete name grounded in the dominant evidence -- never the broad theme name",
  "parentTheme": "<theme key>",
  "classification": "macro" | "micro" | "seasonal",
  "isDistinctFromEvergreen": true or false,
  "sunriceFit": {
    "productConnectionFit": "strong" | "moderate" | "weak" | "none",
    "formatSuitability": "strong" | "moderate" | "weak" | "none",
    "audienceOccasionRelevance": "strong" | "moderate" | "weak" | "none",
    "trendFidelity": "strong" | "moderate" | "weak" | "none"
  },
  "productConnection": ["exact product name(s) from the list below -- empty array if nothing genuinely fits"],
  "whyItMattersNow": "1-2 sentences: the specific reason this is worth attention today, grounded in the evidence given",
  "proposedAction": {
    "recommendedAction": "one concrete, specific action someone could execute tomorrow",
    "channel": "e.g. TikTok/Instagram Reels, Recipe/blog content, Pinterest board",
    "format": "e.g. Short-form how-to video, Written recipe post, Carousel",
    "creativeAngle": "the specific hook or execution idea"
  },
  "eligibility": {
    "verdict": "eligible" | "rejected" | "uncertain",
    "reasonCode": "product_mismatch" | "audience_mismatch" | "too_generic" | "too_late" | null,
    "explanation": "1-2 sentences -- required whenever verdict is \\"rejected\\" or \\"uncertain\\", must be null when verdict is \\"eligible\\""
  },
  "evidenceIds": [<real evidenceId numbers from the candidate(s) this assessment covers>]
}

Eligibility judgment -- this is a SEPARATE, equally important job from the rest of the assessment above. Use SunRice's suitability standard below:
- Primary market: ${suitabilityConfig.primaryMarket}. Primary audiences: ${suitabilityConfig.primaryAudiences.join(', ')}.
- Accepted occasions: ${suitabilityConfig.acceptedOccasions.join('; ')}.
- Product connection standard: ${suitabilityConfig.productConnectionStandard}
- Generic-advice standard: ${suitabilityConfig.genericAdviceStandard}
- International trends: ${suitabilityConfig.internationalTrendsPolicy}
- Excluded entirely: ${suitabilityConfig.excludedTopics.join('; ')}.

Reason codes YOU may use (reject or mark uncertain with exactly one of these):
- product_mismatch: no credible connection to a real SunRice product or rice-based occasion, OR the connection only works if the original trend is changed into something it isn't.
- audience_mismatch: outside the audience/market/brand suitability standard above. Do NOT use this reason just because an evidence item's geography is non-Australian or unconfirmed -- judge only whether the underlying behaviour could translate to an Australian audience (see the international trends policy above).
- too_generic: evergreen advice with no specific new development, angle, or evidence of rising interest -- a real, on-brand topic is not enough on its own.
- too_late: the trend has clearly already peaked or passed its relevant window, based only on what the evidence actually shows (never invent a timeline).
- verdict "uncertain": use this, with no reasonCode, whenever you are genuinely not confident enough to call eligible or rejected -- never force a confident-sounding verdict you don't actually have evidence for.
- verdict "eligible": the normal case when none of the above applies. reasonCode and explanation must both be null.
Do NOT use "already_covered" or "insufficient_evidence" -- those are decided deterministically by code, not by you.

SunRice fit scoring (sunriceFit) -- a SEPARATE job from eligibility above. Eligibility asks "is there a credible connection at all?"; this asks "how strong is it?". Pick exactly one anchor per component -- never invent a number, pick the closest named anchor:
- productConnectionFit (most heavily weighted): strong = a real, current SunRice product is the natural core of the idea. moderate = a real SunRice product fits naturally but isn't the central focus, or needs only a small, reasonable substitution (e.g. "any white rice" -> a specific SunRice variety). weak = a SunRice product could technically be used but the idea doesn't highlight or need rice specifically. none = no genuine link to any real SunRice product.
- formatSuitability: strong = the format/preparation shown is one SunRice's real products genuinely support today (e.g. microwave rice for a quick-bowl trend). moderate = plausible with a minor adaptation. weak = requires a real stretch to make the format work with an actual SunRice product. none = fundamentally incompatible with how SunRice's real products are prepared or sold.
- audienceOccasionRelevance: strong = squarely matches SunRice's core audiences/occasions (see the suitability standard above). moderate = an adjacent audience/occasion, plausible crossover. weak = a stretch to connect to SunRice's actual audience. none = clearly a different audience or occasion entirely.
- trendFidelity: strong = the proposed action stays faithful to exactly what the evidence shows people doing/wanting. moderate = a minor, reasonable extrapolation beyond the literal evidence. weak = a significant stretch from what the evidence actually supports. none = barely resembles what the evidence shows.
This score is an assessed suitability, never a statistically calibrated probability -- do not imply otherwise in whyItMattersNow or anywhere else.

How to use clusterKeys -- THIS IS WHERE YOU DO REAL ANALYTICAL WORK, not just restate the input:
- One candidate normally maps to one clusterKey.
- If two or more candidates in the SAME theme use different wording for what is clearly the same underlying idea (e.g. "sushi rice bowl recipe" and "how to make a sushi bowl at home"), list every one of their clusterKeys together in ONE assessment, so they're treated as a single idea. Only do this when you are confident they are genuinely the same idea -- when unsure, keep them separate.
- This applies just as much across different social posts as it does across query strings: several posts describing the same real behaviour in different words (e.g. three different TikTok captions all about air-frying leftover rice into crispy bites) should become ONE assessment covering all of their clusterKeys, so the resulting count of supporting posts/creators is accurate.
- A candidate assessment can also mix a social post's clusterKey with a search or Pinterest clusterKey, when the same real idea is corroborated across both -- do this whenever it's genuinely the same idea, since it's a stronger signal than either alone.
- Every clusterKey from the input must appear in exactly one assessment in your output. Do not drop any, and do not invent a clusterKey that wasn't given to you.

Classification rules:
- macro: identical in meaning to the theme's own seed query, or matches an evergreen baseline phrase for that theme -- this is the theme's own baseline behaviour, not a trend. Still assess it (brand relevance, product fit, etc. all still apply) -- being macro doesn't mean "skip it", it means "this is the evergreen case, not a fresh discovery."
- seasonal: tied to a specific dated occasion (Christmas, Lunar New Year, etc.) regardless of theme.
- micro: a genuinely more specific, narrower idea than the theme's own baseline. The default is specificity -- do not call something a microtrend just because it's a long or unusual-sounding phrase; an evergreen idea stated as a full question is still macro.

Hard rules -- breaking any of these makes that assessment useless and it will be discarded:
- Use ONLY the evidence given below. Never invent a metric, count, query, evidenceId, source, dish, or behaviour that isn't actually in it. Never state or imply an absolute search-volume or engagement number (e.g. "103k searches", "50k views") -- none of that is verified in the evidence given, for search OR social.
- evidenceIds must be real evidenceId numbers copied from the candidates you're covering. Never invent one.
- For a social post candidate specifically: candidateName and whyItMattersNow must describe something the post's actual text supports -- a dish, behaviour, problem, ingredient combination, audience, or format it genuinely mentions or shows, not a generic guess at what the theme is "probably" about.
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

  // Stage 5 (IMPLEMENTATION_CHECKLIST.md): replaces the old scalar
  // brandRelevance with 4 anchored components -- computeSunriceFit returns
  // null if any anchor is missing/invalid, same "this whole assessment is
  // unusable" severity brandRelevance's own missing-value check had.
  const sunriceFit = computeSunriceFit(raw.sunriceFit);
  if (sunriceFit == null) return null;

  return {
    clusterKeys,
    candidateName: String(candidateName).slice(0, 200),
    parentTheme: String(parentTheme),
    classification,
    isDistinctFromEvergreen: Boolean(raw.isDistinctFromEvergreen),
    sunriceFit,
    productConnection: products,
    whyItMattersNow: String(whyItMattersNow).slice(0, 500),
    proposedAction: {
      recommendedAction: String(proposedAction.recommendedAction).slice(0, 500),
      channel: proposedAction.channel ? String(proposedAction.channel).slice(0, 120) : null,
      format: proposedAction.format ? String(proposedAction.format).slice(0, 120) : null,
      creativeAngle: proposedAction.creativeAngle ? String(proposedAction.creativeAngle).slice(0, 300) : null
    },
    // Stage 4 (IMPLEMENTATION_CHECKLIST.md): a missing/malformed eligibility
    // block degrades to 'uncertain' here (see validateEligibilityBlock),
    // never to a fabricated 'eligible' -- this is deliberately NOT a reason
    // to reject the whole assessment (real evidence/scoring/Emerging
    // visibility shouldn't be lost over a formatting hiccup in one
    // sub-object); reportBuilder.js is what actually keeps an 'uncertain'
    // candidate out of the recommendation feed.
    eligibility: validateEligibilityBlock(raw.eligibility),
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

// A single call covering every theme's candidates doesn't scale once
// social-native discovery is in the mix -- one real post is one
// un-clustered candidate, so a busy day's total candidate count across
// every theme can comfortably outgrow max_tokens, and a truncated
// response fails identically on the retry (not a transient fluke a bare
// retry fixes). So instead of one call for the whole report, candidates
// are chunked into several smaller calls, each kept under a conservative
// candidate budget: small themes are grouped together up to that budget;
// a single theme that alone exceeds it is split into same-theme
// sub-batches (each still carrying that theme's full seed
// queries/evergreen baselines/positive examples, so classification and
// relevance judgment stay correct) rather than ever dropping evidence.
// The only real cost is that Claude can no longer merge a candidate in
// one sub-batch with one in another sub-batch of the SAME theme -- first-
// pass deterministic clustering (microtrends.js) still catches exact/
// near-duplicate search/Pinterest wording regardless; only Claude's own
// cross-wording semantic merge is narrowed to within a sub-batch.
const MAX_CANDIDATES_PER_CALL = 20;

function chunkThemeBatches(themeBatches) {
  const chunks = [];
  let current = [];
  let currentCount = 0;
  for (const theme of themeBatches) {
    if (theme.candidates.length === 0) continue;
    if (theme.candidates.length > MAX_CANDIDATES_PER_CALL) {
      if (current.length > 0) {
        chunks.push(current);
        current = [];
        currentCount = 0;
      }
      for (let i = 0; i < theme.candidates.length; i += MAX_CANDIDATES_PER_CALL) {
        chunks.push([{ ...theme, candidates: theme.candidates.slice(i, i + MAX_CANDIDATES_PER_CALL) }]);
      }
      continue;
    }
    if (current.length > 0 && currentCount + theme.candidates.length > MAX_CANDIDATES_PER_CALL) {
      chunks.push(current);
      current = [];
      currentCount = 0;
    }
    current.push(theme);
    currentCount += theme.candidates.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
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
      // Raised from 4000 -- social-native discovery (one candidate per real
      // Reddit/TikTok/Instagram post, un-clustered) can put far more
      // candidates in a single batch than search/Pinterest alone ever did,
      // and a response cut off mid-array by hitting max_tokens is NOT a
      // transient failure: it fails identically on the retry too (the same
      // batch, the same length), so "AI analysis unavailable" could
      // otherwise become the everyday state rather than a real exception.
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!res.ok) throw new Error(`Anthropic candidate-analysis call failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const text = (data.content?.[0]?.text || '').trim();
  if (!text) throw new Error('Anthropic candidate-analysis call returned empty content');
  // stop_reason 'max_tokens' means the response was cut off mid-array --
  // surfaced explicitly rather than left to be inferred from a cryptic
  // JSON parse error, since it's a systematic "the batch is too big for
  // this ceiling" problem, not a one-off fluke a bare retry will fix.
  if (data.stop_reason === 'max_tokens') {
    throw new Error('response was truncated at max_tokens -- the batch likely has too many candidates for the current ceiling');
  }
  return text;
}

// One chunk's call, with its own one-retry loop -- same resilience
// contract as the old single-call version, just scoped to one chunk.
async function analyzeChunk(chunk) {
  const prompt = buildBatchPrompt(chunk);
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await callOnce(prompt);
      const { assessments, rejectedCount, parseError } = parseAndValidateResponse(text, chunk);
      if (parseError) {
        lastError = parseError;
        continue; // malformed JSON is worth one retry, same as a transport failure
      }
      return { ok: true, assessments, rejectedCount };
    } catch (err) {
      lastError = err.message;
      console.warn(`[candidateAnalyst] chunk (${chunk.map((t) => t.theme).join(', ')}) attempt ${attempt + 1} failed: ${err.message}`);
    }
  }
  return { ok: false, error: lastError };
}

/**
 * The single entry point reportBuilder.js calls. Analysis is mandatory for
 * a recommendation to exist at all -- no ANTHROPIC_API_KEY returns status
 * 'unavailable' immediately. Otherwise candidates are chunked
 * (chunkThemeBatches) and each chunk is analyzed independently: one bad
 * chunk (failed after its own retry) never discards every other chunk's
 * real, valid assessments -- same "a bad element doesn't void the whole
 * batch" principle as validateAssessment, just one level up. Only a report
 * where EVERY chunk failed returns 'unavailable' with zero recommendations
 * -- a partial failure still returns 'ok' with whatever succeeded, plus a
 * `reason` noting what was skipped (surfaced to the report row, same
 * field reportBuilder.js already reads either way).
 * @returns {Promise<{status: 'ok', assessments: Array, reason?: string} | {status: 'unavailable', reason: string}>}
 */
async function analyzeCandidates(themeBatches) {
  if (!isConfigured()) {
    return { status: 'unavailable', reason: 'ANTHROPIC_API_KEY is not set in this process\'s environment' };
  }
  if (themeBatches.every((t) => t.candidates.length === 0)) {
    return { status: 'ok', assessments: [] }; // nothing to analyze -- not a failure
  }

  const chunks = chunkThemeBatches(themeBatches);
  const assessments = [];
  const failures = [];
  let totalRejected = 0;

  for (const chunk of chunks) {
    const result = await analyzeChunk(chunk);
    if (result.ok) {
      assessments.push(...result.assessments);
      totalRejected += result.rejectedCount;
    } else {
      failures.push(`[${chunk.map((t) => t.theme).join(', ')}] ${result.error}`);
    }
  }

  if (totalRejected > 0) {
    console.warn(`[candidateAnalyst] ${totalRejected} assessment(s) rejected validation this run`);
  }

  if (failures.length === chunks.length) {
    return { status: 'unavailable', reason: `Anthropic candidate analysis failed after retry: ${failures.join(' | ')}` };
  }
  return {
    status: 'ok',
    assessments,
    reason: failures.length > 0
      ? `${failures.length} of ${chunks.length} theme batch(es) failed and were skipped: ${failures.join(' | ')}`
      : null
  };
}

module.exports = {
  isConfigured, buildBatchPrompt, extractJson, validateAssessment, parseAndValidateResponse,
  buildClusterKeyIndex, chunkThemeBatches, analyzeCandidates
};
