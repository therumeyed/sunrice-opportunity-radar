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
- **Microtrend discovery** -- each of today's 3 slots is a specific, evidence-backed microtrend inside a theme when one qualifies, not just the theme itself (section 5c); "What's emerging" surfaces every real microtrend tracked today that didn't win a slot.
- **Recommendation feedback** -- Useful / Already covered / Not relevant / Don't show again, each a precise deterministic exclusion rule, plus a Hidden & covered items manager with Undo (section 5c).
- **Deterministic scoring** -- freshness 25% / velocity 25% / cross-source agreement 20% / relevance 20% / seasonal fit 10% at the theme level, a separate microtrend-level formula underneath (section 5c). No LLM touches either set of numbers; only the score components decide what gets shown, in what order, with what confidence.

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

## 5. Recommendation rationale (LLM strategist, optional)

`src/llmStrategist.js` writes the rationale sentence for each of the top 3
recommendations, reading the same real evidence the score was computed
from -- rising/top queries, regional interest, matched social/Pinterest
post excerpts, and which sources independently flag this theme as
rising/growing right now (`momentumSources`, see section 3a) -- plus
SunRice's real product range (`src/products.js`, 66
products, confirmed directly against the live "Showing 66 Products" count
on sunrice.com.au -- the site is JS-rendered and couldn't be scraped
automatically, so the client pasted the actual rendered product grid).
This is what lets it notice things the deterministic scorer structurally
can't, like a rising "biryani" query under a curry theme mapping onto
Basmati Rice -- the scorer only counts signals, it has no idea what
biryani *is*.

Hard boundaries, enforced in code not just prompted for:
- It never sees or touches score, confidence, action_type, or which themes
  make the top 3 -- all of that is decided before this runs.
- It's given a fixed, real product list and told never to suggest anything
  outside it.
- No `ANTHROPIC_API_KEY`, a failed call, or a suspicious response (empty,
  or implausibly long) all fall back to the existing deterministic template
  sentence -- this is a nice-to-have layer, never a dependency the report
  needs to succeed. The multicultural-discovery compliance disclaimer is
  fixed wording and is never handed to the LLM at all.

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

## 5c. Microtrend discovery and feedback

The daily recommendation unit changed from "a theme" to "a specific,
evidence-backed microtrend inside a theme" -- everything in 5a/5b above
(theme snapshots, lifecycle, theme-level recommendation memory) is kept
exactly as it was and still drives the "National theme momentum" section;
this is an additional layer underneath the top-3 slots, not a replacement
for it.

**Candidate extraction (`src/microtrendExtraction.js`)** pulls real
candidate phrases only from evidence that can name a specific `source_items`
row as proof: each `dataforseo_trends` row's own rising/top related
queries, and each matched Pinterest trend-list row's own term. News and
real social posts (Reddit/TikTok/Instagram) stay corroboration only -- there
is no reliable way to pull a specific emerging phrase out of a post/article
body without an LLM inventing one, which this explicitly never does.

**Normalization, clustering, classification (`src/microtrends.js`)** is
deterministic text processing, no vector database or embeddings: lowercase
+ punctuation-strip + singularize + a small synonym map produces a
`normalized_key`; near-duplicates cluster via stopword-filtered token
overlap. Each cluster classifies as:
- **macro** -- identical (post-normalization) to the theme's own seed query
  or an editorial evergreen-baseline phrase (`evergreenBaselines` in
  `src/topics.js`, e.g. "how to cook sushi rice" under Sushi & Asian
  cooking). Macros are suppressed for 30 days after first being shown,
  unless something genuinely changes (a new contributing source type, or a
  verified acceleration past anything seen before) -- otherwise every report
  would "discover" the same evergreen basics every single day.
- **seasonal** -- tied to a known dated occasion, regardless of theme.
- **micro** -- everything else. The default is specificity: nothing is
  treated as a microtrend just because it's a long or unusual-sounding
  phrase, and nothing evergreen is promoted to "trend" status just because
  it happened to phrase itself as a question.

**Scoring (`src/microtrendScoring.js`)** is a separate deterministic formula
from theme-level `scoring.js` -- freshness 20% / velocity 25% / agreement
20% / relevance 15% / novelty 10% / evidence quality 10%, same "every
component is a plain 0-1 input, weights sum to 1" auditability rule. Novelty
specifically decays the more times this exact microtrend has already won a
recommendation slot, so a strong microtrend that keeps winning on its own
merits doesn't also get credited as "new" forever. Velocity only trusts a
real number from DataForSEO's rising-query value (Pinterest's rank/count
fields have no confirmed scale, same caution as section 3a) -- without one,
it falls back to the source's own rising/growing classification flag.
Microtrends never compete across themes for a slot: each of the existing
top-3 theme slots tries to fill itself with that theme's own best-qualifying
microtrend first, falling back to the theme-level recommendation (now
tagged `recommendation_kind: 'baseline_opportunity'`) only when none exists
or qualifies -- this keeps the existing theme-ranking mechanism as the
safety net rather than risking an unfamiliar cross-theme reshuffle.

**Every microtrend observed today, win or not**, gets persisted
(`microtrends` / `microtrend_observations` / `microtrend_evidence`, plus a
recomputed `last_score`) -- this is what powers **"What's emerging"**, a new
section between today's 3 priorities and theme momentum: real microtrends
tracked today that didn't win a slot, ranked purely by their own score,
never padded.

**Feedback (`src/feedback.js`, `recommendation_feedback` table)** is used
only as explicit, named exclusion rules -- never silent material for an LLM
to infer a hidden preference profile from:
- **Useful** -- no suppression; stored as a positive example shown directly
  and transparently to the LLM strategist for style/channel reference on
  future recommendations for that theme (never a reason to repeat an idea
  outright). Every 10 new "useful" examples should trigger a human-reviewed
  summary before anything acts on the pattern (`needsBrandPreferenceReview`)
  -- the summary itself is plain counts, never an LLM-inferred profile.
- **Already covered** / **Don't show this idea again** -- both suppress by
  the specific `action_fingerprint` (the proposed products/channel/format/
  angle), not the underlying microtrend, so a genuinely different angle on
  the same real microtrend is never blocked. When no real LLM action ever
  existed to fingerprint (no API key, a failed call, a rejected response),
  there's no finer-grained "angle" to suppress than the microtrend's own
  deterministic recommendation, so this correctly falls back to hiding the
  whole microtrend instead of silently staying eligible forever.
- **Not relevant** -- hides the whole microtrend cluster permanently.

`recommendation_feedback.recommendation_id` is nullable with
`ON DELETE SET NULL`, deliberately not `CASCADE` -- `buildReport()` deletes
and rebuilds a report's recommendations on every same-day re-run (a normal,
supported operation), and a `CASCADE` here would silently destroy every
feedback decision recorded against that day's recommendations the moment
someone clicks Refresh again. `microtrend_id`/`action_fingerprint` are
stored directly on the feedback row specifically so the exclusion rules
never need a live `recommendation_id` to keep working.

Feedback-writing endpoints (`POST /api/recommendations/:id/feedback`,
`POST /api/feedback/:id/undo`) are gated behind `EDITOR_TOKEN` -- same
session-scoped UX as `ADMIN_TOKEN` (browser prompt, `sessionStorage`, never
written to the report JSON or any source file), but a separate token, since
feedback is a distinct, lower-risk write than triggering a paid ingest run.
Reading feedback (`GET /api/feedback/active`, the "Hidden & covered items"
manager on the dashboard) stays public, same as every other report read.

**Two semantic contradictions fixed in this round:**
- A theme's "recommended N times in the last 14 days" count used to differ
  by one depending on which part of the dashboard showed it (the theme
  momentum card counted today's own just-created recommendation; the
  priority card's own count didn't) -- both now mean the same thing,
  appearances strictly before today.
- `action_type: 'Create'` could be shown with no concrete action behind it
  whenever the LLM strategist didn't run -- the LLM's own validated
  `recommendedAction` field is now actually stored and surfaced ("Do this:
  ..." on the card), and `Create` deterministically downgrades to
  `Investigate` whenever no real `recommendedAction` exists, rather than
  asserting a verdict this system can't back with anything specific.

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
