# Data-Use Audit

Living reference for Stage 2 (`IMPLEMENTATION_CHECKLIST.md`). Re-audit
whenever a new field, table, or source is added -- this file should
never go stale by more than one stage.

Real sources and fields against what's collected, stored, used, and
where the gaps are. Not every column in every table -- the ones that
matter for how this system actually decides what to recommend.

| Dataset/field | Collected? | Stored? | Used where | Historical coverage | Limitation / proposed change |
|---|---|---|---|---|---|
| DataForSEO rising/top queries | Yes | `source_items.normalized_metrics` | Candidate extraction (`microtrendExtraction.js`), search-demand panel | Daily since each theme's first collection | None major |
| DataForSEO region breakdown | Yes | `normalized_metrics.interestByRegion` | Search-demand-by-state panel only | Not kept day-over-day | Never used in scoring -- could support an audience/geography check in Stage 4's eligibility filter |
| Reddit/TikTok/Instagram post text, author, publishedAt | Yes | `source_items` (excerpt/author/published_at) | Social candidate extraction, recency/creator-diversity gating (`resolveSocialTier`) | Since social-native discovery shipped | Instagram's publishedAt isn't trusted for recency (no reliable date from that actor) -- by design, not a bug |
| Reddit/TikTok/Instagram engagement (likes/upvotes/plays) | Yes | `source_items.raw_metrics` | Nowhere in scoring (deliberately -- no verified scale) | N/A | Correct as-is per the explicit "cumulative popularity must never masquerade as velocity" rule -- a DATED, comparable change in the same content's own metric remains a legitimate future signal, just not built yet |
| Pinterest trend terms + rank/trendType | Yes | `source_items` | Candidate extraction, `sourceNativeClassification` ('growing' flag feeds `hasMomentumCorroboration`) | Since Pinterest integration | rank/count have no confirmed scale -- never used numerically, only the categorical flag |
| Google News articles | Yes | `source_items` | Corroboration only, by design -- never a candidate source | Since launch | Working as intended |
| `geography` | Yes, where a source gives it | `source_items.geography` | Signal display only | N/A | Was previously undifferentiated (any string looked equally trustworthy) |
| `geography_confidence` **(new, Stage 2)** | Derived, not collected | `source_items.geography_confidence` | **Stage 4:** shown on every evidence line in Claude's eligibility prompt (`candidateAnalyst.js`'s `formatMember`), so "could this translate to an Australian audience" can be judged honestly instead of assumed | Since Stage 2 | Set to `'confirmed'` only for DataForSEO's AU-targeted queries; every social/news item stays `null` (genuinely unknown) rather than inheriting the dashboard's AU default |
| `content_format` **(new, Stage 2)** | Derived, not collected | `source_items.content_format` | Not read anywhere yet | Since Stage 2 | Only set where certain: `'video'` for every TikTok item. Reddit/Instagram left `null` -- their raw payload shape hasn't actually been inspected against a live Apify run, so guessing a field name would be worse than leaving it unknown |
| `content_hash` dedup | Yes | Unique constraint `(source_type, content_hash)` | Prevents same-source duplicates at ingest | Permanent | Within-source only |
| `possible_reposts` **(new, Stage 2)** | Derived, not collected | `possible_reposts` table | Not read by scoring -- detection/storage only | Since Stage 2 | Cross-source near-identical-text flag (`src/repostDetection.js`, threshold 0.9), scoped to candidates Claude already merged into one assessment -- does NOT yet scan across the whole report for reposts that landed in different candidate groups. A flag, never a merge -- creators are never conflated |
| `recommendation_evidence.product_connection` **(new, Stage 2)** | Derived, not collected | `recommendation_evidence.product_connection` | Not read anywhere yet | Since Stage 2 | A snapshot of the recommendation's own assessment-level `productConnection`, propagated onto each linked evidence row -- not a new, separate per-evidence judgment Claude was asked to make |
| provider run status/cost/error | Yes | `provider_runs` | Admin refresh log, cost ceiling enforcement, **Stage 3's alert evaluation (`src/alerts.js`/`src/healthMonitor.js`) and Source health tab** | Since launch | Alerting/staleness detection now shipped (Stage 3) |
| `raw_item_count` / `hit_retrieval_cap` | Yes (social sources only) | `provider_runs` | Nowhere yet -- stored for future use | Since the momentum round | Still not surfaced on the dashboard -- distinct from Stage 3's new/duplicate counts, which ARE now surfaced |
| `trigger_type` (`'scheduled'`\|`'manual'`) **(new, Stage 3)** | Derived, not collected | `reports.trigger_type` | Gates which runs count toward Stage 3's alert thresholds -- a manual `/admin/refresh` must never inflate a failure streak the real cron is responsible for | Since Stage 3 | Working as intended |
| `new_item_count` / `duplicate_item_count` **(new, Stage 3)** | Derived, not collected | `provider_runs` | Stage 3's `zero_usable_records` rule and the Source health tab's per-source run history | Since Stage 3 | Null (not 0) for a run that never attempted any items (e.g. the DataForSEO cost-ceiling skip with no cached fallback available) -- "didn't try" is never recorded the same as "tried and found nothing" |
| `source_health_alerts` **(new, Stage 3)** | Derived, not collected | `source_health_alerts` | In-app admin alerts, email trigger, the public evidence-outage notice (names no source, just a boolean) | Since Stage 3 | At most one OPEN row per (source_type, alert_type) by construction (partial unique index) -- a repeat firing bumps the existing row, never creates a duplicate |
| `microtrend_observations` (daily score/classification per source) | Yes | `microtrend_observations`, append-only per report | `scoreMicrotrend`'s velocity input, material-change checks | Since microtrend discovery shipped | Working as intended |
| `microtrend_social_signals` (new posts/creators/platforms/dateable/recent) | Yes | `microtrend_social_signals`, append-only per report | **Stage 6:** `new_post_count` history now feeds `candidateLifecycleFor`'s social-direction check (`src/candidateLifecycle.js`) -- the other columns (creators/platforms/dateable/recent) are still unread | Since the momentum round | First real read happened this stage, once enough history existed to make it meaningful |
| `recommendation_feedback` | Yes | `recommendation_feedback` | Exclusion rules (`deriveExclusions`), "useful" style examples shown to Claude | Since feedback system shipped | **Stage 7:** UI now only writes `relevant`/`not_relevant`; the 3 older values (`useful`/`already_covered`/`dont_show_again`) stay valid forever for historical rows but are no longer written. `useful`'s style-examples read is unchanged and still scoped to just that value -- `relevant` never joins it. No feedback-to-scoring numeric loop yet |
| `recommendation_feedback.reason_code` **(new, Stage 7)** | Derived, not collected | `recommendation_feedback` | `deriveExclusions` (exclusion scope -- see below), `themeReviewFlags`'s 3-strikes tally, `GET /admin/theme-review-flags` | Since Stage 7 | Null on every row given before this stage -- that null is itself the signal `deriveExclusions` reads to keep an old `not_relevant` vote under its original, broader (whole-microtrend) meaning rather than the new, narrower (fingerprint-only) one |
| `ideas.workflow_status` | Yes | `ideas` | Idea Tracker | Since Idea Tracker shipped | Already correctly separate from `feedback_type` -- no change needed |
| `action_fingerprint` | Yes | `recommendations`, `ideas`, `recommendation_feedback` | Continuity, suppression, Idea Tracker identity | Since launch | Working as intended |
| `baseline_snapshots` **(new, Stage 1)** | Computed on demand | `baseline_snapshots`, append-only | `POST /admin/baseline`, `GET /api/baseline` | One real snapshot captured 2026-11-08 | Stage 9 compares later snapshots against this one |
| `src/products.js` catalogue | Partially verified (10 of 66 products) | `src/products.js` | `candidateAnalyst.js`'s product-fit validation, **Stage 5 brand-fit scoring (shipped)** | Verified 2026-11-08 for 10 representative products across every real site category; the rest are best-effort URL/category matches, `uses: null` | `verified: false` entries' `uses` must never be treated as a real site claim -- see the file's own header |
| `rejected_candidates` **(new, Stage 4)** | Derived, not collected | `rejected_candidates` | `GET /admin/rejected-candidates` (audit, admin-only), `baseline.js`'s `productMismatchRate`/`genericRecommendationRate`, Stage 4's own reason-aware resurfacing check | Since Stage 4 | `verdict` distinguishes a confident `rejected` from `uncertain` (Claude's own read wasn't confident) -- both are kept out of the feed, but only `uncertain` rows are what Stage 8's human review queue is specifically for |
| `recommendations.resurfacing_note` **(new, Stage 4)** | Derived, not collected | `recommendations.resurfacing_note` | Displayed on the recommendation itself (`resurfacingNote` in the API, shown on the card and in the evidence drawer) | Since Stage 4 | Null in the normal case (never previously rejected) -- set only when a prior rejection's bar was genuinely cleared |
| `microtrends.sunrice_fit_*` / `recommendations.sunrice_fit_*` **(new, Stage 5)** | Derived, not collected | `microtrends`, `recommendations` | Displayed on every priority/Emerging card and the evidence drawer (`sunriceFit` in the API); `detectFitEligibilityContradiction`'s input | Since Stage 5 | Stored on `microtrends` for EVERY observed candidate regardless of outcome (same "store now" reasoning as `last_score`); `recommendations`' copy is a write-time snapshot, never recomputed later |
| `fit_contradictions` **(new, Stage 5)** | Derived, not collected | `fit_contradictions` | `GET /admin/fit-contradictions` (audit, admin-only) | Since Stage 5 | Scoped to the one component that overlaps both Stage 4 and Stage 5's primary question -- product connection -- the only place a disagreement between the two stages is actually meaningful to compare |
| `microtrends.candidate_lifecycle` / `recommendations.candidate_lifecycle` / `recommendations.urgency_note` **(new, Stage 6)** | Derived, not collected | `microtrends`, `recommendations` | Displayed on every priority/Emerging card and the evidence drawer (`candidateLifecycle`/`urgencyNote` in the API), explicitly labelled as the idea's own trend, not the theme's | Since Stage 6 | Stored on `microtrends` for every observed candidate (same "store now" reasoning as `last_score`/`sunrice_fit_*`); `recommendations`' copy is a write-time snapshot, never recomputed later |
| `theme_exclusions` **(new, Stage 7)** | Derived, not collected | `theme_exclusions` | `src/reportBuilder.js` checks the active set before producing any evidence for a theme; `GET`/`POST /admin/theme-exclusions*` (admin-only) | Since Stage 7 | The only thing that removes a whole theme -- always an explicit, reversible admin action, never an automatic consequence of feedback. At most one active row per theme (partial unique index); reversed rows are kept for the audit trail |

## Known gaps carried forward (not yet closed)

- **No acceleration/2nd-derivative signal anywhere in scoring** --
  `candidateLifecycleFor` only ever reports a direction
  (growing/established/declining), never a rate of change.
- **Social-only candidates can't accumulate cross-day history** --
  `socialCandidatesFor()`'s per-post identity (`social-${item.id}`) means
  only a candidate that also carries search/Pinterest evidence (a stable,
  text-based identity) can build the multi-day history Stage 6's
  lifecycle math needs. Pre-existing extraction-layer limitation, not
  something Stage 6 changed.
- `microtrend_social_signals`' creator/platform/dateable/recent counts
  are still unread by anything -- only `new_post_count` feeds Stage 6's
  social direction check so far.
- **`themeReviewFlags`' distinct-decision count needs a stable key** --
  it falls back to the recommendation's own id only when no
  `action_fingerprint` ever existed; a row with neither is skipped from
  the tally rather than risk double- or under-counting it (rare in
  practice -- `recommendation_feedback` stores `microtrend_id`/
  `action_fingerprint` directly specifically so this almost never
  happens, same reasoning as `deriveExclusions`).
- **No review-queue-derived signal** -- `usefulCandidatesIncorrectlyRejectedRate`
  in the baseline stays `unavailable` until Stage 8 ships (`rejected_candidates`'
  `uncertain` rows are the raw material Stage 8's queue will read).
- **Repost detection is scoped to already-merged candidate groups** --
  it does not (yet) scan across the whole report for a repost whose two
  copies landed in different candidate groups entirely.
