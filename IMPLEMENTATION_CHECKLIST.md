# SunRice Dashboard: Implementation Checklist

Tracks the 8-stage build agreed on 2026-11-03, following the decisions in
the "SunRice Roadmap: Status & Open Questions" planning doc. Order is
fixed by that agreement: each stage ships, is verified, and is documented
before the next starts. Nothing here reorders itself without a new
decision from the user.

For each stage: what changed, how it was verified, and what's still a
known limitation -- filled in as each stage actually ships, not drafted
in advance.

## Stage 1: Baseline snapshot
**Status:** done

Capture what the system can already measure before any of Stages 4-7
change recommendation behaviour. Metrics that genuinely can't be
measured yet (no review queue, no mismatch reason codes) are marked
`unavailable`, never approximated or defaulted to zero.

- [x] `baseline_snapshots` table (additive, append-only -- each run is its
      own row, never overwritten)
- [x] `src/baseline.js` -- computes feedback-type counts, duplicate-recommendation
      rate, time-to-recommendation, evidence completeness/freshness, tier-at-
      first-appearance distribution, plus plain context counts (report/
      recommendation/microtrend totals, AI-unavailable day count)
- [x] `POST /admin/baseline` endpoint (requireAdmin) to trigger + store + return it;
      `GET /api/baseline` (public, same as every other report read) to read the
      latest or full history
- [x] Verified against known fixtures in a scratch DB (`test/baseline.test.js`,
      3/3 passing) -- confirmed both the empty-DB "everything unavailable,
      nothing zero" case and real computed numbers against hand-checked
      fixture data (duplicate rate, time-to-recommendation, tier-at-first-
      appearance, evidence completeness/freshness all matched by hand)
- [x] Run once for real against production -- `baseline_snapshots.id=1`,
      computed 2026-11-08T08:03:53.664Z. This is the real day-zero number
      Stage 9 compares against once Stages 4-7 ship.

**Found and fixed along the way (not new work, a standing regression):**
the site-wide login wall (shipped earlier) and `ADMIN_TOKEN`/`EDITOR_TOKEN`
were silently incompatible -- both tried to use the `Authorization`
header, and a browser can only send one. Since the login wall shipped,
clicking **Refresh** or any feedback button was actually broken in
production (blocked by the login wall's own gate, which saw a Bearer
token where it expected Basic auth). Fixed by moving `ADMIN_TOKEN`/
`EDITOR_TOKEN` to dedicated `X-Admin-Token`/`X-Editor-Token` headers --
verified live, both gates now compose correctly. See README section 6a/7.

## Stage 2: Evidence-store additions, catalogue enrichment, data-use audit
**Status:** done

- [x] `source_items.geography_confidence`, `content_format` columns (additive).
      `geography_confidence` is `'confirmed'` only for DataForSEO's real
      AU-targeted queries, `null` everywhere else (never inherited as
      "probably Australian"). `content_format` is set to `'video'` only
      for TikTok (the one source where it's a certainty, not a guess);
      Reddit/Instagram stay `null` until their raw payload shape is
      actually inspected
- [x] Cross-source repost detection (`src/repostDetection.js`,
      `possible_reposts` table) -- flags near-identical text (0.9 token-
      overlap threshold, deliberately much stricter than the 0.75 used
      for "same idea" clustering) across different platforms, never
      merges candidates or conflates creators. **Known scope limit:**
      only checks within candidates Claude already merged into one
      assessment, not across the whole report -- see DATA_USE_AUDIT.md
- [x] Per-evidence product linkage (`recommendation_evidence.product_connection`)
      -- a snapshot of the recommendation's own real `productConnection`,
      propagated onto each linked evidence row
- [x] `products.js` enriched: real URLs for 65/66 products (1 genuinely
      ambiguous, flagged `url: null`) and real categories for all 66,
      matched against the site's own actual category taxonomy
      (discovered via sitemap.xml, since the listing GRID is client-
      rendered but individual product pages are not) -- `uses` populated
      with real, fetched, verified text for 10 representative products
      spanning every category; the other 56 stay `uses: null`, never
      inferred or guessed. `verified`/`verifiedAt` fields distinguish the two
- [x] Data-use audit committed to the repo as `DATA_USE_AUDIT.md`

**Verification:** `test/repostDetection.test.js` (5/5) proves reposts are
flagged only across platforms on near-identical text, never for merely-
similar independent posts, and never merge/delete anything.
`test/reportBuilder.test.js`'s new Stage 2 suite (2/2) proves the flag
persists end-to-end through a real report build without destroying
either evidence row, and that `product_connection` reaches the
recommendation's actual linked evidence. Full suite: 242/242.

## Stage 3: Monitoring and failure visibility
**Status:** done

- [x] Per-source run history surfaced (`src/db.js` `getSourceRunHistory`/
      `getAiAnalysisHistory`, aggregated per source+day across the real,
      already-stored `provider_runs` rows -- new/duplicate counts are a
      new `provider_runs.new_item_count`/`duplicate_item_count` pair,
      populated in `ingest.js`'s 3 collection loops from whether each
      upsert actually inserted a fresh row)
- [x] 4 alert rules in `src/alerts.js` (pure, no DB access, fixture-tested):
      2 consecutive failed **scheduled** runs; no successful scheduled run
      for >2x the refresh interval (a documented, configurable assumption
      -- `DEFAULT_REFRESH_INTERVAL_HOURS`, currently 24h since the cron
      runs once/day); 3 consecutive scheduled zero-usable-record runs
      flagged as `zero_usable_records`, a distinct alert type from
      `consecutive_failures` so "ran fine, found nothing" is never
      conflated with "broke"; an auth/quota-shaped error (`isAuthOrQuotaError`,
      pattern-matched against the free-text error column) alerts
      immediately, no streak required
- [x] Scheduled vs. manual is a real, persisted distinction: new
      `reports.trigger_type` column, set by `ingest.js` from
      `INGEST_TRIGGER` (only `/admin/refresh` in `server.js` sets this env
      var on the spawned process); alert evaluation only ever reads
      scheduled runs, so a manual retry can never inflate a failure streak
- [x] In-app admin alerts (new `source_health_alerts` table, reconciled by
      `src/healthMonitor.js`) + configurable email via Resend's HTTP API
      (`src/emailAlerts.js`) -- unconfigured by default (`ALERT_EMAIL_API_KEY`/
      `ALERT_EMAIL_TO`/`ALERT_EMAIL_FROM` unset), shown honestly as such on
      the Source health tab; no send has been claimed as tested in this
      environment (no real Resend credentials exist here)
- [x] Alerts grouped by source+incident (partial unique index: at most one
      OPEN row per source_type+alert_type); notify-on-recovery fires an
      email (when configured) the moment a condition stops being true
- [x] Scraper health kept separate from AI-analysis health -- `ai_analysis`
      is evaluated as its own distinct "source" against the same 4 rules,
      read from `reports.ai_analysis_available`/`ai_analysis_reason`,
      never merged into any real scraper source's history or alerts
- [x] Real admin section, not just endpoints: a **Source health** nav tab
      (`public/index.html`/`app.js`), gated behind the same `X-Admin-Token`
      prompt as Refresh -- shows per-source run history (last 14 days),
      active alerts, recently-recovered alerts, email config state, and a
      **Run ingestion now** button that reuses the existing dedup-safe
      `/admin/refresh` (no separate per-source retry needed: the same
      action safely re-attempts everything)
- [x] One public-facing piece (original spec item #7): a plain, generic
      notice on the Today view when a real scraper source has an open
      alert -- never names the source, the alert type, or any error text;
      AI-analysis outages keep their existing, separately-worded message

**Verification:** `test/alerts.test.js` (15/15) -- pure fixture tests for
all 4 rules, including that a single failure/zero-record run is never
enough, a success breaking up 2 failures resets the streak, and
`newItemCount: null` (never measured) correctly skips the
zero-usable-records rule rather than treating "unknown" as "zero".
`test/healthMonitor.test.js` (6/6, DB-backed) -- `getOrCreateReport`'s
trigger_type lifecycle; `getSourceRunHistory`'s per-source-per-day
aggregation across multiple raw rows; `upsertOpenAlert`/`resolveOpenAlert`'s
group-not-duplicate and resolve-is-a-no-op-if-not-open behaviour; and an
end-to-end `runHealthCheck` proof that a manual retry between two real
scheduled failures does NOT trigger the alert, a third scheduled failure
does, and a real scheduled success resolves it -- plus that a
never-configured source (every run `awaiting_connection`) raises nothing,
and `ai_analysis` is tracked as a fully separate entry. Full suite:
263/263 passing in a scratch Postgres instance.

**Known limitations:**
- The refresh-interval assumption (24h, so the staleness threshold is 48h)
  is a single global default, not yet configurable per source -- fine
  while every source shares the same once-daily cron; would need a
  per-source override if that ever changes.
- Email sending uses Resend's HTTP API but has never actually been
  test-sent in this environment (no real API key here) -- the code path
  is real, not a stub, but "configured" only means the 3 env vars are
  set, not that a send has been verified.
- The auth/quota-error detection is a regex over free-text error strings
  (no structured error-code field exists yet on `provider_runs`) -- could
  miss a provider's own non-standard error wording.

## Stage 4: Eligibility filtering and rejection storage
**Status:** done

- [x] Configurable SunRice suitability config (`src/suitabilityConfig.js`)
      -- plain, documented assumptions (primary market/audiences, accepted
      occasions, product-connection/generic-advice standards, the
      international-trends policy), fed verbatim into Claude's eligibility
      prompt; non-blocking (ships with sensible defaults, edited directly
      by a human, no approval gate before use)
- [x] Eligibility stage between extraction and scoring, wired into
      `processThemeAssessments` (`src/reportBuilder.js`) -- every candidate
      is still scored/stored (Emerging section unaffected); only
      `pickWinningCandidate` and the Idea Tracker are gated on `eligible`.
      Claude judges semantic suitability/trend fidelity (`product_mismatch`,
      `audience_mismatch`, `too_generic`, `too_late` -- new `eligibility`
      block in `candidateAnalyst.js`'s schema); deterministic code
      (`src/eligibility.js`) enforces evidence integrity
      (`checkInsufficientEvidence` -- every evidence item non-`live`) and
      duplicates (`isDuplicateWithoutNewEvidence` -- same `action_fingerprint`
      within 7 days citing nothing new). Explicit admin/feedback exclusions
      were already enforced pre-Stage-4 (`src/feedback.js`'s
      `hiddenMicrotrendIds`/`suppressedFingerprints`) -- reused, not
      duplicated
- [x] Uncertain candidates routed to review, never given a fabricated
      confident verdict -- a missing/malformed `eligibility` block from
      Claude degrades to `uncertain` (`validateEligibilityBlock`'s
      `UNCERTAIN_FALLBACK`), same treatment as Claude saying so itself
- [x] Every rejection (and every uncertain verdict) persisted with a
      reason code + explanation + cited evidence ids + a full assessment
      snapshot, in the new `rejected_candidates` table -- readable via
      `GET /admin/rejected-candidates` (admin-gated; no UI yet, same
      endpoint-only pattern Stage 1's baseline used before a page existed)
- [x] Reason-aware resurfacing (`src/eligibility.js`'s `canResurface`) --
      `product_mismatch` needs a genuinely new product connection,
      `audience_mismatch`/`too_late` need genuinely new evidence,
      `too_generic` needs an improved classification/distinctness or new
      evidence, `already_covered` needs a meaningfully different execution.
      A new source type alone is explicitly never sufficient for any of
      them. A short explanation is stored (`rejected_candidates.resurfacing_explanation`)
      and displayed on the resurfaced recommendation itself
      (`recommendations.resurfacing_note` -> `resurfacingNote` in the API)
- [x] Geography/geography_confidence (Stage 2) now actually read: shown on
      every evidence line in Claude's eligibility prompt, with explicit
      instruction never to reject merely for being international
- [x] `baseline.js`'s `productMismatchRate`/`genericRecommendationRate`
      (previously `unavailable` pending this exact stage) now measured
      from real `rejected_candidates` rows

**Verification:** `test/eligibility.test.js` (21/21, pure) -- every
deterministic rule and resurfacing case, including the explicit "a new
source type alone must never be enough to resurface any reason" guarantee.
`test/candidateAnalyst.test.js`'s new Stage 4 tests (prompt includes the
suitability config + reason codes + geography; `validateAssessment`
preserves a real eligibility verdict, degrades a missing one to
`uncertain`, and rejects Claude citing a deterministic-only reason code).
`test/reportBuilder.test.js`'s new Stage 4 suite (5/5, DB-backed): a
Claude-rejected candidate never wins a slot and is stored; an `uncertain`
one is stored as `uncertain`, never silently treated as rejected;
all-non-live evidence is rejected regardless of Claude's own verdict;
citing literally the same evidence as a recent identical recommendation is
rejected as `already_covered`; and a full 3-day resurfacing scenario
(rejected -> still rejected on a bare retry -> allowed through once a
genuinely new product connection appears, with a stored/displayed
resurfacing note). `test/baseline.test.js`'s new test proves
`productMismatchRate`/`genericRecommendationRate` go from `unavailable` to
`measured` once real rejection rows exist. Full suite: 305/305 passing in
a scratch Postgres instance (now run with `--test-concurrency=1` --
found and fixed a real flake: enough DB-backed suites now exist that
`node --test`'s default parallel-file execution was colliding against the
one shared scratch database).

**Known limitations:**
- `isDuplicateWithoutNewEvidence`'s "no new evidence" check compares
  literal evidence-row identity. Given this pipeline's daily-refresh data
  model (DataForSEO/social content hashes bake in the collection date, so
  a genuinely unchanged real-world signal still gets a fresh row each
  day), this means it rarely fires in realistic day-over-day data -- it's
  a correct, tested safety net for an exact-repeat edge case, not the
  primary defence against stale repeats. The existing continuity/
  `repeat_action` labelling plus admin-driven `implemented` suppression
  remain the primary real-world mechanisms; a content-level (not just
  evidence-id) duplicate check is a natural refinement once Stage 5's
  brand-fit scoring and Stage 6's momentum math exist to inform it.
- `too_late` is accepted as a reason code Claude may choose, but there's
  no deterministic timing/lifecycle backstop yet -- that's explicitly
  Stage 6 territory (momentum and lifecycle improvements).
- No review-queue UI for `uncertain` rows yet -- `GET /admin/rejected-candidates`
  is endpoint-only, same pattern Stage 1's baseline used before a page
  existed. Stage 8 is where this gets a real page.

## Stage 5: Brand-fit scoring (SunRice fit)
**Status:** done

- [x] 4-component weighted score (`src/sunriceFit.js`): product connection
      40%, format suitability 25%, audience/occasion relevance 20%, trend
      fidelity 15%. Anchored criteria -- Claude picks one of 4 named
      anchors (`strong`/`moderate`/`weak`/`none`) per component, with
      written criteria for each in the prompt, never a raw float. Replaces
      the old scalar `brandRelevance` entirely (also now feeds
      `scoreMicrotrend`'s `relevance` input, as `sunriceFit.score / 100`)
- [x] Composite rounded to nearest 5, High (80+) / Moderate (60-79) / Low
      (<60) -- `computeSunriceFit`/`bandForScore`
- [x] Low stays fully scored/stored (visible in Emerging, same "store now"
      treatment as every other candidate) but can never win a
      recommendation slot (`fitQualifies` gate in `pickWinningCandidate`,
      `src/reportBuilder.js`); Moderate/High compete normally, no extra gate
- [x] Eligibility-vs-fit contradictions flagged for review
      (`detectFitEligibilityContradiction`, scoped to the one component
      that overlaps both stages -- product connection) -- persisted to the
      new `fit_contradictions` table, readable via
      `GET /admin/fit-contradictions` (admin-gated, no UI yet)
- [x] "Assessed suitability, not a statistically calibrated probability"
      (`DISCLAIMER`) shown on every recommendation card, Emerging card, and
      in the evidence drawer's component breakdown -- real UI, not just an
      API field (verified live with a seeded fixture + Playwright
      screenshot of all three: the card badge, the Emerging card badge,
      and the drawer breakdown)

**Verification:** `test/sunriceFit.test.js` (15/15, pure) -- composite
math, band thresholds, both contradiction directions, and that product
connection (40% weight) isn't trivially dominant on its own.
`test/candidateAnalyst.test.js`'s Stage 5 additions -- the prompt shows
the 4 anchored criteria; `validateAssessment` rejects a missing/invalid
`sunriceFit` block (same severity the old `brandRelevance` check had) and
computes the real weighted composite. `test/reportBuilder.test.js`'s new
Stage 5 suite (4/4, DB-backed): a Low-fit candidate is eligible but never
wins a slot and stays queryable for review; a Moderate/High candidate
wins normally with the composite stored on the recommendation; the
eligible+"none"-product-connection contradiction is flagged; a consistent
eligible+"strong" case raises nothing. Full suite: 325/325 passing in a
scratch Postgres instance.

**Known limitations:**
- Contradiction detection is scoped to the product-connection component
  only -- the other 3 fit components have no eligibility-stage
  counterpart to compare against, so a contradiction there (e.g. eligible
  but `formatSuitability: none`) isn't flagged. Could be extended if real
  review data shows it's needed.
- "Moderate can qualify with strong rationale/evidence" is implemented as
  "Moderate competes normally, no extra gate" -- there's no separate
  rationale-strength check beyond the existing score/evidence-completeness
  ranking a Moderate candidate already has to clear to win a slot.

## Stage 6: Momentum and lifecycle improvements
**Status:** done

- [x] History eligibility accounts for elapsed calendar time + distinct
      successful collection days, not raw run count (`observationDays`,
      `src/candidateLifecycle.js`) -- a same-day refresh can never inflate
      a microtrend's history, since both `microtrend_observations` and
      `microtrend_social_signals` are upserted one row per `report_id`
      (1:1 with calendar date) via a real UNIQUE constraint
- [x] Reuses the existing 3/7-day eligibility tiers rather than inventing
      new thresholds -- `socialObservationEligibility()`
      (`src/microtrendScoring.js`, already shipped in an earlier stage) now
      also gates candidate-level lifecycle: under 3 days is always
      `insufficient_history`, 3-6 days is always `emerging`, never a
      forced direction either way
- [x] Candidate-level Emerging/Growing/Established/Declining
      (`candidateLifecycleFor`, `src/candidateLifecycle.js`), kept
      genuinely distinct from theme-level lifecycle
      (`themeLifecycle.js`'s new/validating/building/cooling/sustained/
      peaking): different states, different badge shape in the UI
      (non-pill `.bd-candidate-lifecycle` vs pill `.bd-lifecycle`), and
      both panels' copy explicitly says which is which -- verified live,
      see below
- [x] Direction (growing/declining/established) comes from comparing a
      3-day windowed average against everything before it (the same
      ±20%-threshold convention `scoring.js`/`themeLifecycle.js` already
      use), across two real, separately-tracked series: the numeric
      search signal (`dataforseo_trends` rising value) and, for the first
      time, real `microtrend_social_signals` history (new post count per
      day) -- stored since Stage 2/3 and explicitly deferred until now.
      Either series alone can call it `growing`/`declining`; they're never
      averaged together
- [x] Today's own reading is folded into the trend series before the
      direction check runs, not just prior history -- a genuine same-day
      spike shows up in today's lifecycle label immediately, not
      tomorrow
- [x] "Insufficient history" shown rather than a forced label -- the
      eligibility gate above is checked before any direction math runs,
      so a 1- or 2-day-old candidate can never get `growing`/`established`/
      `declining` by chance of the numbers lining up
- [x] 2-day execution lead time (`EXECUTION_LEAD_TIME_DAYS`,
      `src/candidateLifecycle.js`) as a named, configurable constant --
      only ever produces an informational `urgencyNote` string on
      `growing`/`declining` candidates (e.g. "~2-day planning/production
      lead time"), never a gate, never a precise deadline

**Verification:** `test/candidateLifecycle.test.js` (17/17, pure) --
day-counting never double-counts a same-day rerun, eligibility tiers
never forced early, direction math on both series independently,
urgency note only on growing/declining. `test/reportBuilder.test.js`'s
new Stage 6 suite (3/3, DB-backed): one real 8-day history walking
through all three states in order (insufficient_history on day 1,
emerging on day 3, growing on day 8 off a genuine spike, with the
recommendation itself carrying the urgency note); a flat 7-day history
settling on `established` as the honest default; a mixed search+social
candidate whose `growing` label is driven specifically by real
`microtrend_social_signals` rows (asserted directly against the table --
8 rows, one per real day, never duplicated). Full suite: 345/345 passing
in a scratch Postgres instance, run twice back-to-back against a fresh
database with no flakiness. Live-verified with a seeded smoke database
and a Playwright screenshot: the priority card shows the "Growing" badge
next to the SunRice fit badge plus the urgency note; the evidence drawer
shows a "Candidate lifecycle: Growing" row under its own heading
("this idea's own trend, not the theme's"), visibly separate from the
theme-level "BUILDING" badge shown on the National theme momentum panel
for the same underlying theme.

**Known limitations:**
- Social-only candidates can't naturally persist their identity across
  days under the current clustering scheme: `socialCandidatesFor()`
  (`src/microtrendExtraction.js`) keys each raw social candidate to one
  specific post's database id (`social-${item.id}`), which is different
  every day even for the "same" recurring topic. A social-only cluster
  therefore can't accumulate multi-day history on its own -- only a
  candidate that also has search/Pinterest evidence (whose normalized key
  is stable, text-based, and shared across days) gets a persistent
  identity for the lifecycle math to track. This is a pre-existing
  extraction-layer limitation, not something Stage 6 was asked to fix or
  changed; it's the reason the Stage 6 "social" test above uses a mixed
  search+social candidate rather than a social-only one.
- Direction detection needs at least 4 real data points in a series
  (3-day window + 1 to compare against) before it can call a direction at
  all; below that, `candidateLifecycleFor` already short-circuits to
  `insufficient_history`/`emerging` via the 3/7-day gate, so this never
  surfaces as a separate edge case in practice.
- Only the `growing` state (with its urgency note) was live-screenshotted
  end-to-end; `emerging`/`established`/`declining`/`insufficient_history`
  share the exact same render path (`candidateLifecycleBadge()`,
  `public/app.js`) and are each covered by the pure/DB-backed tests above,
  but weren't individually screenshotted.

## Stage 7: Feedback interface and reason-specific integration
**Status:** done

- [x] UI collapsed to Relevant / Not relevant (`public/app.js`'s priority
      card buttons, `src/feedback.js`'s `WRITABLE_FEEDBACK_TYPES`) --
      Useful folds into Relevant without implying style/execution
      endorsement: `relevant` is a new, separate, lighter-weight type that
      never feeds `getPositiveFeedbackExamples` (the style-example
      harvesting Claude's prompt reads); historical `useful` rows are
      untouched and keep feeding it under their original meaning, exactly
      as before this stage
- [x] One Not-relevant vote: exact recommendation removed from the active
      feed, unchanged duplicates blocked -- `not_relevant` now carries a
      `reason_code` (new column, same 6-value taxonomy as Claude's own
      eligibility gate, `src/eligibility.js`'s `REASON_CODES`) and is
      scoped to that recommendation's `action_fingerprint`, never the
      whole microtrend (`deriveExclusions`, `src/feedback.js`). A
      pre-Stage-7 vote (`reason_code IS NULL`) keeps its original, broader
      whole-microtrend meaning rather than being silently reinterpreted --
      verified both ways in `test/reportBuilder.test.js`
- [x] One vote also creates a soft, reason-specific signal (not a ban) --
      every reason-coded `not_relevant` row is raw material for
      `themeReviewFlags` below; nothing about giving the vote itself
      excludes a theme
- [x] 3 distinct rejected recommendations, same narrow theme, same reason,
      within 60 days -> flags the theme for admin review, never
      auto-hard-bans (`themeReviewFlags`, `src/feedback.js`; surfaced via
      `GET /admin/theme-review-flags`, admin-gated, no UI yet -- same
      pattern as Stage 4/5's rejected-candidates/fit-contradictions
      endpoints). Purely a computed-on-read signal -- nothing is written
      or excluded just by crossing the threshold
- [x] Explicit theme exclusions: admin-only action, reversible -- new
      `theme_exclusions` table (at most one active row per theme, a
      partial unique index), `POST /admin/theme-exclusions` /
      `POST /admin/theme-exclusions/:id/reverse` / `GET` to list, all
      `requireAdmin`-gated. `src/reportBuilder.js` checks the active set
      before producing any evidence for that theme, so an excluded theme
      gets no signal, no snapshot, no candidate -- and reversing it needs
      no repair, the very next build just resumes normally
- [x] Too-late affects timing only; already-covered affects repetition
      only -- both are `not_relevant` reason codes, not separate verdicts,
      and both get the same fingerprint-scoped suppression: a genuinely
      different, later proposal on the same real trend (too_late) or a
      genuinely different angle (already_covered) is never blocked by
      either, only the literal unchanged duplicate is. No separate expiry
      machinery was built for either -- fingerprint scoping already makes
      both statements true
- [x] Counts distinct recommendation decisions, not repeated clicks --
      `themeReviewFlags` groups by `action_fingerprint` (falling back to
      the recommendation's own id only when no fingerprint was ever
      generated), never by raw feedback-row count, so undoing and
      re-voting on the same recommendation can't inflate the tally

**Verification:** `test/feedback.test.js`'s Stage 7 additions (pure) --
`validateFeedbackInput` only accepts `relevant`/`not_relevant` as new
writes and requires a real shared reason code on `not_relevant`;
`requiresContentDetails` correctly keys off `reasonCode` as well as the
legacy type; `deriveExclusions` proven both ways (pre-Stage-7 whole-
microtrend vs. reason-coded fingerprint-only, for every reason code
including already_covered); `themeReviewFlags` proven against the 3-vote
threshold, the 60-day window, distinct-theme/distinct-reason isolation,
de-duplication by fingerprint (including repeated clicks on one decision
never inflating the count), and the fingerprint-id fallback.
`test/reportBuilder.test.js`'s new Stage 7 suite (4/4, DB-backed): a
reason-coded `not_relevant` vote blocking only the exact recommendation
while a genuinely different angle on the same microtrend still wins; an
explicit theme exclusion producing zero signals/recommendations for that
theme and a reversal resuming normal processing with no repair; 3
distinct reason-coded rejections flagging a theme for review while never
auto-excluding it; a `relevant` vote never suppressing anything. Full
suite: 368/368 passing in a scratch Postgres instance, run twice with no
flakiness. Live-verified with a seeded smoke database and Playwright: the
priority card shows exactly the 2 new buttons (no legacy buttons
rendered); clicking "Not relevant" shows the 6 shared reason codes;
selecting "Already covered" reveals the existing-content URL/status
fields, and switching away from it hides them again. This live check
caught a real bug -- hiding those fields on a reason change didn't clear
their values, so a stray `contentStatus` was being submitted on votes
with an unrelated reason -- fixed in `submitFeedback`
(`public/app.js`) before shipping, and re-verified live.

**Known limitations:**
- The free-text `reason` lists for the 3 legacy types
  (`REASONS_BY_TYPE`) are kept only for rendering old rows under their
  original labels -- the API no longer accepts writing `useful`,
  `already_covered`, or `dont_show_again` at all; attempting to is
  rejected the same way an unknown type would be.
- `themeReviewFlags`' distinct-decision count falls back to the
  recommendation's own id only when no `action_fingerprint` ever existed;
  if a recommendation's row is later lost entirely (same-day rebuild
  nulls `recommendation_id` but never the fingerprint, so this is rare in
  practice) with no fingerprint either, that one decision has nothing
  stable to de-duplicate on and is skipped from the tally rather than
  risk double- or under-counting it.
- No UI yet for the two new admin endpoints (theme review flags, theme
  exclusions) -- same "endpoint now, page later" pattern as Stage 4/5's
  admin-only audit endpoints; Stage 8's human review queue is the natural
  place a real page for these eventually belongs.

## Stage 8: Human review queue and evaluation
**Status:** pending

- [ ] Access-gap audit on EDITOR_TOKEN's actual server-side enforcement,
      fixed or flagged before the admin section is exposed
- [ ] Weekly queue: 10 accepted + 10 rejected (fewer if unavailable),
      mixed high-priority/borderline/random, including potentially-useful
      rejects
- [ ] 6 review questions, stored separately from `recommendation_feedback`
- [ ] Review history + score/prompt versions tracked against outcomes

---

**Delivery notes carried through every stage:** safe, additive migrations
only; existing data is never destroyed or silently reinterpreted; each
stage's own section above gets filled in with what actually shipped, how
it was verified, and what's still a known limitation, before the next
stage starts.
