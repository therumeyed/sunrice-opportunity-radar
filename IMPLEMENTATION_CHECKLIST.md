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
**Status:** pending

- [ ] Configurable SunRice suitability config, documented assumptions,
      non-blocking while in review
- [ ] Eligibility stage between extraction and scoring -- Claude judges
      semantic suitability/trend fidelity; deterministic code enforces
      evidence integrity/catalogue validity/duplicates/explicit exclusions
- [ ] Uncertain candidates routed to review, never given a fabricated
      confident verdict
- [ ] Every rejection persisted with a reason code + explanation
- [ ] Reason-aware resurfacing (5 reason categories, new-source-type-alone
      is insufficient, short explanation stored/displayed on resurfacing)

## Stage 5: Brand-fit scoring (SunRice fit)
**Status:** pending

- [ ] 4-component weighted score (product connection 40%, format fit 25%,
      audience/occasion 20%, trend fidelity 15%), anchored criteria
- [ ] Composite rounded to nearest 5, High (80+) / Moderate (60-79) / Low (<60)
- [ ] Low stays stored, out of the main feed; Moderate can qualify with
      strong rationale/evidence
- [ ] Eligibility-vs-fit contradictions flagged for review
- [ ] "Assessed suitability, not a calibrated probability" stated plainly
      wherever the score is shown

## Stage 6: Momentum and lifecycle improvements
**Status:** pending

- [ ] History eligibility accounts for elapsed calendar time + successful
      collection windows, not raw run count (same-day refreshes don't
      count as separate days)
- [ ] Candidate-level Emerging/Growing/Established/Declining, kept
      distinct from theme-level lifecycle, both explained in the UI
- [ ] "Insufficient history" shown rather than a forced label; never an
      invented growth rate
- [ ] 2-day execution lead time as a labelled, configurable assumption --
      informs urgency only, never auto-rejects, never claims a precise
      remaining window

## Stage 7: Feedback interface and reason-specific integration
**Status:** pending

- [ ] UI collapsed to Relevant / Not relevant; Useful folds into Relevant
      without implying style/execution endorsement; historical Useful
      examples preserved with their original meaning
- [ ] One Not-relevant vote: exact recommendation removed from the active
      feed, unchanged duplicates blocked
- [ ] One vote also creates a soft, reason-specific signal (not a ban)
- [ ] 3 distinct rejected recommendations, same narrow theme, same reason,
      within 60 days -> flags the theme for admin review (never
      auto-hard-bans)
- [ ] Explicit theme exclusions: admin-only action, reversible
- [ ] Too-late affects timing only; already-covered affects repetition only
- [ ] Counts distinct recommendation decisions, not repeated clicks

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
