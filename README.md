# SunRice Opportunity Radar

A daily decision dashboard for SunRice: what's worth acting on today,
backed by real, sourced evidence -- never an invented metric or a
fabricated example. Duplicated from the Bakers Delight Opportunity Radar
(same account, same architecture) and re-pointed at SunRice's real product
range and content themes.

## What's live in this v1

- **Search demand** -- DataForSEO Google Trends, one keyword at a time, Australia-wide with a state breakdown.
- **Social trends** -- Reddit, TikTok and Instagram via Apify, each independently feature-flagged.
- **Google News RSS** -- free, no API key, feeds evidence and rationale (no separate News panel; it's not a source_type with its own signal, just extra corroborating evidence).
- **Today screen** -- top 3 evidence-backed recommendations, evidence drawer, History (by-date report browsing), filters (theme/audience/state) persisted in the URL.
- **Deterministic scoring** -- freshness 25% / velocity 25% / cross-source agreement 20% / relevance 20% / seasonal fit 10%. No LLM touches the numbers; only the score components decide what gets shown, in what order, with what confidence.

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
One token covers all three actors below. Each source is independently
switchable via `FEATURE_APIFY_REDDIT` / `FEATURE_APIFY_TIKTOK` /
`FEATURE_APIFY_INSTAGRAM` (all default `true`) -- turn one off without
touching code if it turns out unreliable or too expensive. Expect
TikTok/Instagram in particular to have off days; that's the flakiest part
of this whole pipeline and always will be.

Default actors (overridable, see `.env.example`):
- Reddit: `trudax/reddit-scraper-lite`, scoped to `APIFY_REDDIT_SUBREDDITS` (comma-separated, no `r/`) -- defaults to cooking-focused communities (MealPrepSunday, EatCheapAndHealthy, AskCulinary, budgetfood, AskAnAustralian).
- TikTok: `clockworks/tiktok-scraper`, searched against the active topic library's queries (or `APIFY_TIKTOK_SEARCH_TERMS` to override).
- Instagram: `instaprism/instagram-hashtag-posts` -- hashtag search is the closest thing to free-text search Instagram allows, so this only catches posts tagged with a topic-derived hashtag, not every relevant post.

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

## 4. Recommendation scoring

`src/scoring.js` -- five weighted components (see weights above), each a
plain 0-1 input:
- **freshness** -- linear decay to 0 over 7 days from first detection.
- **velocity** -- % change vs. a real 7-day trailing average queried from
  the DB (DataForSEO's own rising-query value is preferred when present).
  No prior history at all → neutral score, not a fabricated 0% or 100%.
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
from -- rising/top queries, regional interest, and a few matched social
post excerpts -- plus SunRice's real product range (`src/products.js`, 66
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
