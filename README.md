# SunRice Opportunity Radar

A daily decision dashboard for SunRice: what's worth acting on today,
backed by real, sourced evidence -- never an invented metric or a
fabricated example. Duplicated from the Bakers Delight Opportunity Radar
(same account, same architecture) and re-pointed at SunRice's real product
range and content themes.

## What's live in this v1

- **Search demand** -- DataForSEO Google Trends, one keyword at a time, Australia-wide with a state breakdown.
- **Social trends** -- Reddit, TikTok, Instagram and Pinterest Trends via Apify, each independently feature-flagged.
- **Google News RSS** -- free, no API key, feeds evidence and rationale (no separate News panel; it's not a source_type with its own signal, just extra corroborating evidence).
- **Today screen** -- top 3 evidence-backed recommendations, evidence drawer, History (by-date report browsing), filters (theme/audience/state) persisted in the URL.
- **Claude-authoritative candidate analysis** -- mandatory, not optional: Claude interprets what today's evidence means (macro/micro/seasonal, brand relevance, product fit, the actual proposed action); deterministic code validates evidence/products and owns the final tier. No AI = zero recommendations that day, shown plainly, never a generic fallback (sections 5, 5c).
- **Microtrend discovery** -- each of today's 3 slots is a specific, evidence-backed candidate inside a theme when one qualifies, not just the theme itself; "What's emerging" surfaces every real candidate tracked today that didn't win a slot.
- **Recommendation feedback** -- Useful / Already covered / Not relevant / Don't show again, each a precise deterministic exclusion rule, plus a Hidden & covered items manager with Undo (section 5c).
- **Idea Tracker** -- a second tab: one row per stable action, searchable/filterable, with workflow status, feedback, owner, notes and a content URL editable from the table, full audit history (section 5d).
- **Deterministic scoring** -- freshness 25% / velocity 25% / cross-source agreement 20% / relevance 20% / seasonal fit 10% at the theme level, a separate candidate-level formula underneath that uses Claude's own brand-relevance judgment as one real input (section 5c). The score, confidence and final tier are never decided by Claude -- only the score components decide what gets shown, in what order, with what confidence.

## What's deliberately not built yet

Cut from v1 because they need a custom crawler/change-detection engine, not just a source connection:

- **Digital availability** (own site crawl, store locator, ordering audit) -- `FEATURE_DIGITAL_AVAILABILITY`
- **Competitor pulse** (competitor site/social monitoring) -- `FEATURE_COMPETITOR_PULSE`
- **Local visibility** (DataForSEO Google Maps grid scanning) -- `FEATURE_LOCAL_VISIBILITY`
- **Customer voice** -- undefined for now, stubbed behind `FEATURE_CUSTOMER_VOICE` pending a decision on what feeds it (Google reviews is the obvious candidate, and the account already has a working Apify actor for it on a sibling project)

All four show as disabled nav items rather than pretending to work. Turning
one on later means implementing its provider adapter and flipping the flag
in `.env` / `render.yaml` -- the schema and UI already know about them.

Source health (per-provider status/task-id/error detail) exists in the API
but is not shown in the UI -- that's internal debugging info, not something
end users need on their daily dashboard. Check the API response or Render's
logs directly if something needs debugging.

## The non-negotiable rule

Every number on screen carries a `data_status` (`live`, `cached`, `imported`,
`awaiting_connection`, `failed`) and traces back to a `source_items` row with
the original URL, raw payload, and collection timestamp. A recommendation
with zero real evidence is never created -- if fewer than 3 themes have
actual collected evidence on a given day, fewer than 3 recommendations are
shown. Nothing is padded to hit "exactly 3."

A recommendation also never exists without a valid Claude candidate
analysis behind it (section 5). If `ANTHROPIC_API_KEY` is missing, or the
call fails validation after one retry, the dashboard shows real signals
and theme history as normal but zero recommendations, with "AI analysis
unavailable" stated plainly -- never a generic deterministic sentence
standing in for one.

## 1. Local setup

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL and whichever API keys you have
npm start               # dashboard at http://localhost:3000
npm run ingest           # one collection + report-build pass, manually
npm test                 # unit tests (DB-backed suite auto-skips without TEST_DATABASE_URL)
```

Needs a local or hosted Postgres for `DATABASE_URL`. Tables are created
automatically on first run.

Every source works fine with no keys configured at all -- it just shows
`awaiting_connection` and the rest of the report still builds from whatever
*is* connected. Google News RSS needs nothing and always attempts a live pull.

## 2. Getting each API key

This account's DataForSEO/Apify/Anthropic credentials are shared with the
Bakers Delight dashboard (same accounts, more usage on the same bill) --
set the same values here rather than creating new ones, unless billing
separation becomes a priority later.

**DataForSEO** (dataforseo.com) -- login is the account email, API password
from the dashboard → `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD`. Billed per
task; `DATAFORSEO_DAILY_COST_CEILING_USD` (default $5) stops submitting new
tasks once the day's spend hits it and falls back to the last successful
(`cached`) pull for the remaining topics instead.

**Apify** (apify.com) -- Settings → Integrations → API token → `APIFY_TOKEN`.
One token covers all four actors below. Each source is independently
switchable via `FEATURE_APIFY_REDDIT` / `FEATURE_APIFY_TIKTOK` /
`FEATURE_APIFY_INSTAGRAM` / `FEATURE_APIFY_PINTEREST` (all default `true`) --
turn one off without touching code if it turns out unreliable or too
expensive. Expect TikTok/Instagram in particular to have off days; that's
the flakiest part of this whole pipeline and always will be.

Default actors (overridable, see `.env.example`):
- Reddit: `trudax/reddit-scraper-lite`, scoped to `APIFY_REDDIT_SUBREDDITS` (comma-separated, no `r/`) -- defaults to cooking-focused communities (MealPrepSunday, EatCheapAndHealthy, AskCulinary, budgetfood, AskAnAustralian).
- TikTok: `clockworks/tiktok-scraper`, searched against the active topic library's queries (or `APIFY_TIKTOK_SEARCH_TERMS` to override).
- Instagram: `instaprism/instagram-hashtag-posts` -- hashtag search is the closest thing to free-text search Instagram allows, so this only catches posts tagged with a topic-derived hashtag, not every relevant post.
- Pinterest Trends: `automation-lab/pinterest-trends-scraper` (see section 3a below).

## 3. Topic library

`src/topics.js` is the editable query library: rice cooking & prep,
weeknight dinners, curry night, healthy eating, lunchbox & snacks, sushi &
Asian cooking, seasonal occasions -- chosen from SunRice's own real product
categories (Everyday Rice, Healthy Rice Blends, Microwave Rice, Rice
Snacks) and the cuisine categories their own site organizes recipe content
around. **Rice cooking & prep** (washing, cooking, choosing the right type
for a recipe) is evergreen, foundational content every rice buyer searches
for eventually, so it carries the top editorial relevance weight alongside
the other core cooking/cuisine themes. **Seasonal occasions** is
fixed-date, mainstream-Australian only (Christmas, Australia Day) -- a
shifting or non-Gregorian occasion never belongs there, because that theme
can auto-promote straight to a `Create` recommendation. **Multicultural
discovery** is where Lunar New Year, Diwali and Ramadan live instead: real,
recurring, worth tracking, but culturally-specific and date-shifting, so
every hit from this theme is hard-locked to `early_signal` confidence and
the `Investigate` action -- it can never auto-promote to `Create`. That's
enforced in `src/scoring.js` / `src/reportBuilder.js`, not just documented.

`src/reportBuilder.js`'s `THEME_RELEVANCE` is the fixed editorial priority
ranking between themes -- rice basics and the meal/cuisine themes score
full relevance, `lunchbox_snacks` is weighted down (real signal, just a
narrower audience), and multicultural needs no entry since its relevance is
already forced down by the `requiresReview` lock regardless. Not derived
from any live metric, same as `seasonalFit`.

Queries are deliberately short/broad (single words or short phrases) rather
than long compound phrases -- Google Trends' related-queries feature
returns much thinner data for a specific 3-4 word phrase than for the
broad word it's built from. The tradeoff: a short word can be ambiguous on
social (`curry` also means Steph/Stephen/Seth/Dell Curry, NBA) -- a topic
can carry an `exclude` list (see `curry_night`) and
`src/providers/apifySocial.js`'s `isGenuineMatch` rejects a hit whose text
also trips it, rather than trust a bare substring match on its own.

A rising/related query under a culturally-specific theme can look "early"
for a reason that's actually just how Google Trends works, not a bug: a
`% growth`-style rising value off a tiny prior base (a handful of early
planners searching "chinese lunar new year 2027" months out) can look
disproportionately significant well before the occasion is close. That's
exactly why `multicultural` is hard-locked to `Investigate`/`early_signal`
regardless of score -- it's designed to surface this kind of early,
unverified signal for a human to judge, not to assert it's worth acting on
today.

## 3a. Pinterest Trends -- a second, independent trend source

`src/providers/pinterestTrends.js` pulls Pinterest's own trending-term lists
(growing / top-monthly / seasonal) via Apify's
`automation-lab/pinterest-trends-scraper`, matched locally against the same
topic library as every other source (same `exclude`/`isGenuineMatch`
guard, so an ambiguous term like `curry` gets the same NBA-collision
protection here as on Reddit/TikTok/Instagram).

Two things worth knowing before trusting it blindly:
- **Australia+NZ, not Australia-only.** This actor only offers Australia
  bundled with New Zealand ("AU+NZ") -- there's no standalone AU option.
  Every other source here is Australia-only; this one isn't, and the
  evidence drawer's source name says so (`Pinterest Trends (via Apify,
  AU+NZ)`) rather than silently treating it as equivalent.
- **Most of its numeric fields have no documented meaning.** The actor's
  own README confirms `term`, `trendType` and `rank` but doesn't state
  units for `weeklyChange`/`monthlyChange`/`yearlyChange`/`normalizedCount`/
  `searchCount` -- no percentage, no 0-100 scale, nothing. That's exactly
  the kind of gap that bit this project once already with DataForSEO's
  query values turning out not to match their own documented scale in
  production. So here: those fields are kept in `rawMetrics` for audit/
  evidence only, and never surfaced as a headline stat or handed to the
  LLM strategist as if their magnitude were known. Only `trendType`
  (growing/top_monthly/seasonal) and `rank` -- both unambiguous -- drive
  anything. Velocity for this source still comes from a real, verifiable
  number: a week-over-week count of how many matched trend rows showed up,
  the same count-based mechanism already used for Reddit/TikTok/Instagram.

**Not a social post.** Pinterest contributes to source agreement, momentum
and creative context exactly like a real social post would -- but it's a
trend-list entry, not a post, and is deliberately excluded from "N matching
social posts" wording and from `suggestedChannelFor()`'s post-count check.
Before this was fixed, a theme with Pinterest evidence alone (zero actual
Reddit/TikTok/Instagram posts) could still get recommended with "Short-form
video (TikTok/Instagram)" as the suggested channel, purely because Pinterest
padded the post count above zero. The Social trends panel labels Pinterest
rows "matched trend term(s)", never "matching post(s)".

**Cross-source momentum callout.** When the same theme is independently
flagged as rising by more than one source -- Google Trends showing a real
(sanitized) rising related query, Pinterest classifying a matched term as
`growing` -- that's genuinely strong corroboration, not a coincidence.
`reportBuilder.js` computes this deterministically per recommendation
(`momentumSources`, stored in `recommendations.momentum_sources`) and it
shows up two ways: a small badge on the Today card ("Rising on Google
Trends + Pinterest"), and as an explicit, factual input to the LLM
strategist so the written rationale can name it too -- never with an
invented number attached, only the fact that it's independently confirmed.

## 4. Recommendation scoring

`src/scoring.js` -- five weighted components (see weights above), each a
plain 0-1 input:
- **freshness** -- linear decay to 0 over 7 days from first detection.
- **velocity** -- % change vs. a real 7-day trailing average queried from
  the DB (DataForSEO's own sanitized rising-query values are preferred when
  present, aggregated as the median of the top 3 rather than the single
  highest -- one generous outlier used to be able to max out this whole
  component alone). No prior history at all → neutral score, not a
  fabricated 0% or 100%.
- **agreement** -- how many distinct source types corroborate it (1 source
  is a hunch, 3+ is a pattern).
- **relevance** / **seasonal fit** -- fixed editorial weighting per theme
  (`src/reportBuilder.js`), not derived from any live metric. `seasonal`
  itself stays flat year-round rather than guessing at exact dates for
  occasions with shifting/non-Gregorian calendars (Lunar New Year, Diwali,
  Ramadan) -- that would be exactly the kind of invented precision the
  data rule exists to prevent.

Scoring itself has no LLM in it, and never will -- score, confidence and
which 3 opportunities win stay 100% deterministic and auditable.

## 5. Candidate analysis (Claude, mandatory)

`src/candidateAnalyst.js` is not a nice-to-have prose layer -- it is
load-bearing. Claude is authoritative for interpreting what today's real
evidence *means*: whether a candidate is macro/micro/seasonal, whether
it's genuinely distinct from an obvious evergreen topic, its semantic
relationship to other candidates, brand relevance, product fit, why it
matters now, and the specific action to propose. Deterministic code stays
authoritative for everything measurable on top of that: whether cited
evidence exists, source metrics, freshness/velocity/agreement math,
recommendation history, feedback exclusions, deduplication, and --
critically -- the final Watch/Investigate/Create tier. See section 5c for
the full pipeline; this section is about the call itself.

One batched call per ingest run covers every candidate across every theme
together (not one call per candidate), so Claude can compare signals
against each other and judge which ones are genuinely distinctive. Given
SunRice's real product range (`src/products.js`, 66 products, confirmed
directly against the live "Showing 66 Products" count on sunrice.com.au --
the site is JS-rendered and couldn't be scraped automatically, so the
client pasted the actual rendered product grid), each theme's seed
queries/evergreen baselines, and past "useful" feedback for style
reference, Claude returns one structured assessment per candidate (or per
group of candidates it judges to be the same idea in different words --
see "semantic merges" in 5c).

Deterministic validation on every assessment before it can become a
recommendation:
- Every cited `evidenceId` must be real and must belong to the candidate(s)
  that assessment actually references -- an invented ID, or one borrowed
  from a different candidate, gets silently dropped; if NONE of an
  assessment's cited IDs survive, the whole assessment is rejected.
- `productConnection` must be empty or contain only exact names from the
  real catalogue -- one invented name rejects the whole assessment.
- The same fabricated-absolute-number safety net as before (a k/K-suffixed
  or comma-grouped number in free text is a tell nothing in real evidence
  ever produces).
- `classification` must be `macro`, `micro`, or `seasonal`; a concrete
  `recommendedAction` is required.

No `ANTHROPIC_API_KEY`, or a call that still fails validation/parsing after
one retry, returns `status: 'unavailable'` -- `reportBuilder.js` then
builds signals and theme history as normal but creates **zero**
recommendations for that report, and the dashboard says "AI analysis
unavailable" plainly. There is no deterministic fallback copy to catch
the fall -- that was the explicit correction this round made: AI usage
here is mandatory, not decorative.

## 5a. Theme lifecycle, trend history and recommendation memory

Two gaps this round closed: the dashboard only ever saw "today" (no memory
of what it said yesterday), and it only ever saw the themes that happened
to win a top-3 slot (anything else left zero trace).

**`theme_daily_snapshots`** (new table) gets one row per theme per report
date, for *every* theme with real evidence that day -- not just the 3 that
became recommendations. `was_recommended` records which ones did.
Same-day refreshes upsert this row rather than duplicating it; past days'
rows are never touched or deleted by a later day's run. This is what makes
the rest of this section possible -- `signals` is rebuilt fresh every
report and keeps no cross-day history, and `recommendations` only ever had
rows for themes that won a slot.

**`src/themeLifecycle.js`** -- a theme's lifecycle (`new` / `validating` /
`building` / `cooling` / `sustained` / `peaking`) is computed from that
theme's own accumulated snapshot history, completely separate from the
existing per-platform `lifecycleFor()` in `reportBuilder.js` (which stays
exactly as it was, for the existing Social trends panel -- conflating the
two was explicitly the thing to avoid). Every threshold is named in
`LIFECYCLE_THRESHOLDS` so it can be recalibrated later from real data
without re-deriving the logic. Deliberately conservative: fewer than 7
observations can only ever say `new`/`validating`, and `peaking` needs 14+
observations *and* a real flattening pattern (near its own recent high,
genuinely building recently, now flattened) -- a 3-day-old theme can never
be told it's peaking just because today looked a certain way. The API
exposes `peakingEligible` per theme precisely so the UI can say
"insufficient history to determine a peak" instead of implying a young
theme was checked and simply isn't.

**Recommendation memory** reuses the real, already-persisted
`recommendations` history (never deleted except that same day's own
re-run) rather than a second table. Before writing today's rationale,
`reportBuilder.js` pulls the last 14 days of this theme's recommendations
plus anything already proposed earlier *today* (captured before the
same-day delete, so a second manual Refresh doesn't erase the first run's
context) and hands both to `llmStrategist.js`.

**`src/continuity.js`** -- `computeActionFingerprint()` hashes the
*specific* proposal (product + channel + format + creative angle,
normalized), and `determineContinuityStatus()` compares it against recent
history to classify `new` / `continuing` / `strengthening` / `weakening` /
`new_angle` / `repeat_action`. Both are deterministic and this is the
system of record -- the LLM proposes its own guess at continuity as part
of its structured output (see below) purely for its own prose, but
reportBuilder.js's own comparison is what actually gets stored and shown.
When there's no usable LLM output at all (no key, failed call, rejected
response), there's no real execution detail to fingerprint -- the
fingerprint is `null` in that case rather than a hash of empty fields, and
continuity falls back to score-trend classification only, never a false
"repeat_action"/"new_angle" claim it can't actually back.

**`llmStrategist.js` now returns structured JSON**, not a free paragraph:
`opportunityName` (a specific, concrete name -- "Homemade sushi tutorials",
never the broad theme label), `intentSummary`, `rationale`,
`recommendedAction`, `primaryProducts[]`, `channel`/`format`/
`creativeAngle`, its own `continuityStatus` guess, `changeSincePrevious`,
and `evidenceReferences[]`. Every field that matters is validated before
use: `primaryProducts` rejected outright if it names anything outside
`src/products.js`, the existing fabricated-number regex still runs as a
second-layer safety net, and a parse/validation failure falls back to the
same deterministic template as before -- this is still a nice-to-have
layer, never a dependency the report needs to succeed.

Two related fixes to the prompt itself: a rising query's own numeric
`value` is no longer sent to the LLM at all (only the query text and the
fact that it's classified rising) -- its unit isn't actually verified for
that context specifically, separate from the existing out-of-range
sanitizer. And the LLM is explicitly told not to use the word "sustained"
unless the real lifecycle/history given to it actually supports it.

The `/api/reports/*` endpoints now return `themeTrends` -- every active
theme's lifecycle, score/change, source badges, appearance counts and a
30-day sparkline, ending at the *selected* report date (never today's
latest, so browsing a historical report shows the trend as it stood that
day). Rendered as a new "National theme momentum" section on the Today
screen, below the top 3 and above the existing search/social panels --
deliberately national only; audience/state filters narrow recommendations
and signals but not this section, since neither dimension is truly
calculated at the theme level.

## 5b. Ingest concurrency

The daily cron and a manual Refresh can overlap (cron fires while a
Refresh is still running, or two Refreshes close together) -- without a
guard this wastes DataForSEO/Apify spend and can race on the same-day
DELETE-then-rebuild sequence in `buildReport()`. `ingest.js` now takes a
Postgres advisory lock (`pg_try_advisory_lock`) for its whole run; a
second process that can't acquire it logs and exits cleanly rather than
starting a competing run -- not a queue, the next cron fire or manual
Refresh just tries again later. `POST /admin/refresh` also does a quick
best-effort peek at the same lock to return `409` immediately for the
obvious case of clicking Refresh twice in a row; the real enforcement is
always `ingest.js`'s own acquire, since the peek-then-spawn has an
unavoidable small race window.

## 5c. Candidate discovery, Claude-authoritative analysis, and feedback

The daily recommendation unit is "a specific, evidence-backed candidate
inside a theme" (macro, micro, or seasonal -- Claude decides which, see
section 5). Theme snapshots/lifecycle/theme-level ranking (5a) are kept
exactly as they were and still drive the "National theme momentum"
section and decide which 3 themes' slots compete for a recommendation
today -- this candidate layer decides what (if anything) fills each slot.

**Extraction (`src/microtrendExtraction.js`)** pulls real candidate
phrases only from evidence that can name a specific `source_items` row as
proof: each `dataforseo_trends` row's own rising/top related queries, each
matched Pinterest trend-list row's own term, and now every real matched
Reddit/TikTok/Instagram post (see 5c-i below). Google News stays
corroboration only -- there's no first-person "here's what I'm actually
doing" signal in article text the way there is in a social caption, so
news alone never produces a candidate or a recommendation.

**First-pass clustering (`src/microtrends.js`)** is deterministic text
processing only, no vector database or embeddings: lowercase +
punctuation-strip + singularize + a small synonym map produces a
`normalized_key`; near-duplicates cluster via stopword-filtered token
overlap. This used to also decide macro/micro/seasonal classification --
that's now Claude's call (section 5), since judging whether something is
genuinely a fresh, specific idea vs. an obvious evergreen restatement is
exactly the kind of semantic read deterministic string-matching can't
reliably make.

**Semantic merges**: Claude can additionally unify candidates this
deterministic first pass missed -- two genuinely different wordings for
the same real idea that don't share enough tokens to cluster
automatically. When it does, every merged clusterKey beyond the canonical
one is recorded on that microtrend's `semantic_merges` column (original
wording + when), so the grouping stays auditable rather than silently
reshaping history.

### 5c-i. Social-native candidate discovery

Losing social-only opportunities is not an acceptable side effect of the
"Claude is mandatory, no fallback" rule -- that rule only governs what
happens when Claude is *unavailable*, never whether real social evidence
is allowed to produce a candidate at all. So every real matched
Reddit/TikTok/Instagram post is sent to Claude for microtrend extraction,
on equal footing with search/Pinterest candidates:

- Each real post is its own atomic, un-clustered "seed candidate"
  (`socialCandidatesFor`) -- unlike search/Pinterest terms, there's no
  reliable string-matching heuristic for free-form post text, so
  deterministic code never guesses the phrase. Claude reads the actual
  post text and identifies the specific dish, behaviour, problem,
  ingredient combination, audience, or creative format it describes,
  grounded only in what the post actually says (never an invented detail,
  never an implied engagement number -- a view/like count has no more
  confirmed scale than Pinterest's rank field).
- Social posts merge into the same microtrend via the exact same
  `clusterKeys` mechanism search/Pinterest candidates already use --
  Claude can unify two differently-worded posts about the same real
  behaviour, or merge a social post with a search/Pinterest clusterKey for
  cross-source corroboration. No separate validation path was built for
  this; it's the same merge-and-audit mechanism, same `semantic_merges`
  column.
- Posts are deduplicated by `source_items`' own `(source_type,
  content_hash)` constraint at ingest, and each post's real `author` is
  carried through so distinct creators can be counted deterministically
  (`uniqueCreatorCount` in `aggregateObservations`) -- never something
  Claude is asked to estimate.

**Social-only tier gating (`resolveSocialTier` in
`src/microtrendScoring.js`)** is a deterministic, downgrade-only gate
applied *after* the normal score-driven Watch/Investigate/Create tier, and
only when every contributing source is a real social platform
(`isSocialOnly` -- if Claude merged in a search/Pinterest clusterKey, this
is false and the gate never applies, which is exactly what "corroboration
from another source" means in practice):
- **Watch** is always reachable from a single credible post; the gate
  never touches an already-Watch tier.
- **Investigate** needs multiple real posts or multiple creators -- a
  single post, however credible, downgrades to Watch.
- **Create** additionally needs creator diversity (2+ distinct real
  authors). "Measurable momentum" and "corroboration from another source"
  remain valid alternatives in principle, but a verified engagement metric
  for social platforms doesn't exist yet in this system -- the same
  caution already applied to Pinterest's own rank/count fields -- so for a
  *pure* social-only candidate, creator diversity is currently the only
  satisfiable path to Create.

**`evidence_basis` (`'search' | 'social' | 'mixed'`)** is a write-time
snapshot on every recommendation (and, recomputed for display, on every
tracked microtrend in "What's emerging") of what actually grounded it --
never recomputed after the fact. The dashboard labels a `social` idea with
a "Social-first signal" badge and a `mixed` one with "Social + search", so
a social-only find is never presented as if it were broader search
demand it never had. The common `search` case gets no badge at all, to
keep that case visually quiet.

**Scoring (`src/microtrendScoring.js`)** is a separate deterministic
formula from theme-level `scoring.js` -- freshness 20% / velocity 25% /
agreement 20% / relevance 15% / novelty 10% / evidence quality 10%, same
"every component is a plain 0-1 input, weights sum to 1" auditability
rule. **Relevance is now Claude's own `brandRelevance` judgment**, not a
static per-theme map -- a direct, measurable use of Claude's semantic read
rather than cosmetic prose. Novelty decays the more times this exact
candidate has already won a slot, so a strong one that keeps winning on
its own merits doesn't also get credited as "new" forever. Velocity only
trusts a real number from DataForSEO's rising-query value (Pinterest's
rank/count fields have no confirmed scale) -- without one, it falls back
to the source's own rising/growing flag. Candidates never compete across
themes for a slot: each of the top-3 theme slots fills itself from that
theme's own best-qualifying, Claude-analyzed candidate, highest score
first; **if none exists or qualifies, that slot gets no recommendation at
all** -- there is no deterministic fallback standing in.

**Macro suppression**: a macro candidate (identical to the theme's own
seed query or an evergreen baseline, e.g. "how to cook sushi rice" under
Sushi & Asian cooking) is shown once, then suppressed for 30 days unless
something genuinely changes (a new contributing source type, or a
verified acceleration past anything seen before) -- otherwise every report
would "discover" the same evergreen basics every single day.

**Every candidate Claude assessed today, win or not**, gets persisted
(`microtrends` / `microtrend_observations` / `microtrend_evidence`, plus a
recomputed `last_score`) -- this is what powers **"What's emerging"**,
between today's 3 priorities and theme momentum: real candidates tracked
today that didn't win a slot, ranked purely by their own score, never
padded.

**Feedback (`src/feedback.js`, `recommendation_feedback` table)** is used
only as explicit, named exclusion rules -- never silent material for an
LLM to infer a hidden preference profile from:
- **Useful** -- no suppression; stored as a positive example shown
  directly and transparently to Claude for style/channel reference on
  future candidates for that theme (never a reason to repeat an idea
  outright, and never a trend-metric boost). Every 10 new "useful"
  examples should trigger a human-reviewed summary before anything acts on
  the pattern (`needsBrandPreferenceReview`) -- the summary itself is
  plain counts, never an LLM-inferred profile.
- **Already covered** / **Don't show this idea again** -- both suppress by
  the specific `action_fingerprint` (the proposed products/channel/format/
  angle), not the underlying candidate, so a genuinely different angle on
  the same real candidate is never blocked. (Every validated Claude
  assessment carries a real proposed action, so unlike the retired
  LLM-prose-only flow, this fingerprint is never degenerate/empty.)
- **Not relevant** -- hides the whole candidate cluster permanently.

An idea's `workflow_status` (see 5d) can also suppress it: `implemented`
adds that `action_fingerprint` to the same suppression set as
`dont_show_again`/`already_covered` (presenting it again as "new" would be
wrong), while `ignored` deliberately does **not** suppress anything -- a
human skipping it once isn't the same as permanently hiding it.

`recommendation_feedback.recommendation_id` is nullable with
`ON DELETE SET NULL`, deliberately not `CASCADE` -- `buildReport()` deletes
and rebuilds a report's recommendations on every same-day re-run (a normal,
supported operation), and a `CASCADE` here would silently destroy every
feedback decision recorded against that day's recommendations the moment
someone clicks Refresh again. `microtrend_id`/`action_fingerprint` are
stored directly on the feedback row specifically so the exclusion rules
never need a live `recommendation_id` to keep working.

Feedback-writing endpoints (`POST /api/recommendations/:id/feedback`,
`POST /api/feedback/:id/undo`, plus the Idea Tracker's own `/api/ideas/*`
mutations below) are gated behind `EDITOR_TOKEN` -- same session-scoped UX
as `ADMIN_TOKEN` (browser prompt, `sessionStorage`, never written to the
report JSON or any source file), but a separate token, since these are a
distinct, lower-risk write than triggering a paid ingest run. Reading
feedback (`GET /api/feedback/active`, the "Hidden & covered items" manager
on the dashboard) stays public, same as every other report read.

**Two semantic contradictions fixed along the way:**
- A theme's "recommended N times in the last 14 days" count used to differ
  by one depending on which part of the dashboard showed it (the theme
  momentum card counted today's own just-created recommendation; the
  priority card's own count didn't) -- both now mean the same thing,
  appearances strictly before today.
- `action_type: 'Create'` could be shown with no concrete action behind it
  whenever the (now-retired) LLM prose layer didn't run. This is now
  structurally impossible: `validateAssessment` rejects any candidate
  analysis missing a concrete `recommendedAction` before it can become a
  recommendation at all, and that action is actually stored and surfaced
  ("Do this: ..." on the card).

## 5d. Idea Tracker

A second tab, independent of the daily Today view: one row per stable
`action_fingerprint` (the specific proposed action), not one row per daily
appearance -- a microtrend recommended 5 days running with the same
execution is one row with `recommendation_count: 5`, and a materially
different execution on the same microtrend is a different row with its
own fingerprint. `first_recommended_at`/`last_recommended_at`/
`recommendation_count` are computed live from the real `recommendations`
history on every read (`getIdeas` in `src/db.js`), never a hand-maintained
counter -- nothing to keep in sync, no same-day-rebuild double-counting
risk.

Two fields the brief is explicit must never be conflated:
- **`workflow_status`** (`ideas` table) -- `new` / `reviewing` / `planned`
  / `in_production` / `implemented` / `ignored`. Where this idea sits in
  the team's own pipeline. Edited from the table, logged to
  `idea_status_history` (previous value, new value, timestamp) on every
  real change.
- **`feedback_type`** -- read live from `recommendation_feedback` (the
  same system the main dashboard's feedback buttons use), never duplicated
  onto the `ideas` table. Giving feedback from the tracker
  (`POST /api/ideas/:fingerprint/feedback`) attaches to that idea's most
  recent real recommendation row and updates the exact same record the
  main dashboard would -- there is only one feedback system, two places to
  use it.

Filters: date range, theme, microtrend, workflow status, feedback, tier
(Watch/Investigate/Create), source, plus free-text search over the idea
name/action/notes. Default sort is newest first. Compact summary tiles
(New / Planned+In production / Implemented / Ignored) sit above the table,
computed from real `workflow_status` counts (`GET /api/ideas/summary`).
Owner, notes, and an optional content URL are plain editable fields on
each row, saved via `PATCH /api/ideas/:fingerprint` -- same `EDITOR_TOKEN`
gate as feedback, read access public.

## 6. Deploy to Render

`render.yaml` provisions a web service, a daily cron job (ingestion), and
Postgres from one Blueprint -- same pattern as the Bakers Delight dashboard
in this account. Push, then in Render: **New → Blueprint**, point it at
this repo. Fill in the `sunrice-radar-secrets` group values (same
DataForSEO/Apify/Anthropic credentials as Bakers Delight's, unless billing
separation becomes a priority).

Cron fires at `20:00 UTC` (~6am Melbourne) -- Render cron is UTC-only, no DST
awareness; shift by an hour at each daylight-saving change.

## 7. Triggering a refresh manually

The dashboard's **Refresh** button prompts for the admin token at click time
(never stored, never shipped to the browser) and calls `POST /admin/refresh`,
which spawns an ingestion run in the background and returns immediately --
a full run (bounded Apify polling included) can take several minutes, far
longer than an HTTP request should stay open. Reload the page after a bit to
see the new report.

```bash
curl -X POST -H "Authorization: Bearer <ADMIN_TOKEN>" https://<your-service>.onrender.com/admin/refresh
```

On Render, `ADMIN_TOKEN` is auto-generated -- find it under the web
service's Environment tab.

`EDITOR_TOKEN` works the same way for the feedback-writing endpoints (see
section 5c) -- the dashboard's feedback buttons and the Hidden & covered
items manager's Undo prompt for it the same way, and it's also
auto-generated on Render under the same Environment tab.

## 8. Extending later

- Wiring in Customer voice, Local visibility, Digital availability or
  Competitor pulse: each is a new provider adapter under `src/providers/`
  plus flipping its feature flag -- the schema (`source_items.source_type`,
  `signals`, feature-flag plumbing in `server.js`) already expects them.
- If SunRice's product range changes, update `src/products.js` -- it's a
  plain data file, not something scraped or inferred.
- The Riviana sub-brand is included in the product catalog but doesn't yet
  have its own theme/audience distinction -- worth revisiting if Riviana
  content needs to be treated separately from core SunRice content.
