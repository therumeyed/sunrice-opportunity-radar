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
| `geography_confidence` **(new, Stage 2)** | Derived, not collected | `source_items.geography_confidence` | Not read anywhere yet | Since Stage 2 | Set to `'confirmed'` only for DataForSEO's AU-targeted queries; every social/news item stays `null` (genuinely unknown) rather than inheriting the dashboard's AU default. Ready for Stage 4's eligibility filter to consult |
| `content_format` **(new, Stage 2)** | Derived, not collected | `source_items.content_format` | Not read anywhere yet | Since Stage 2 | Only set where certain: `'video'` for every TikTok item. Reddit/Instagram left `null` -- their raw payload shape hasn't actually been inspected against a live Apify run, so guessing a field name would be worse than leaving it unknown |
| `content_hash` dedup | Yes | Unique constraint `(source_type, content_hash)` | Prevents same-source duplicates at ingest | Permanent | Within-source only |
| `possible_reposts` **(new, Stage 2)** | Derived, not collected | `possible_reposts` table | Not read by scoring -- detection/storage only | Since Stage 2 | Cross-source near-identical-text flag (`src/repostDetection.js`, threshold 0.9), scoped to candidates Claude already merged into one assessment -- does NOT yet scan across the whole report for reposts that landed in different candidate groups. A flag, never a merge -- creators are never conflated |
| `recommendation_evidence.product_connection` **(new, Stage 2)** | Derived, not collected | `recommendation_evidence.product_connection` | Not read anywhere yet | Since Stage 2 | A snapshot of the recommendation's own assessment-level `productConnection`, propagated onto each linked evidence row -- not a new, separate per-evidence judgment Claude was asked to make |
| provider run status/cost/error | Yes | `provider_runs` | Admin refresh log, cost ceiling enforcement | Since launch | No alerting, no staleness detection yet -- Stage 3 |
| `raw_item_count` / `hit_retrieval_cap` | Yes (social sources only) | `provider_runs` | Nowhere yet -- stored for future use | Since the momentum round | Not surfaced on the dashboard yet -- Stage 3 |
| `microtrend_observations` (daily score/classification per source) | Yes | `microtrend_observations`, append-only per report | `scoreMicrotrend`'s velocity input, material-change checks | Since microtrend discovery shipped | Working as intended |
| `microtrend_social_signals` (new posts/creators/platforms/dateable/recent) | Yes | `microtrend_social_signals`, append-only per report | **Nowhere yet** -- explicitly deferred pending real history | Since the momentum round | Stage 6 is where this finally gets read, once enough real history exists |
| `recommendation_feedback` | Yes | `recommendation_feedback` | Exclusion rules (`deriveExclusions`), "useful" style examples shown to Claude | Since feedback system shipped | 4 types today, not the Relevant/Not-relevant split -- Stage 7. No feedback-to-scoring numeric loop yet |
| `ideas.workflow_status` | Yes | `ideas` | Idea Tracker | Since Idea Tracker shipped | Already correctly separate from `feedback_type` -- no change needed |
| `action_fingerprint` | Yes | `recommendations`, `ideas`, `recommendation_feedback` | Continuity, suppression, Idea Tracker identity | Since launch | Working as intended |
| `baseline_snapshots` **(new, Stage 1)** | Computed on demand | `baseline_snapshots`, append-only | `POST /admin/baseline`, `GET /api/baseline` | One real snapshot captured 2026-11-08 | Stage 9 compares later snapshots against this one |
| `src/products.js` catalogue | Partially verified (10 of 66 products) | `src/products.js` | `candidateAnalyst.js`'s product-fit validation, (future) Stage 5 brand-fit scoring | Verified 2026-11-08 for 10 representative products across every real site category; the rest are best-effort URL/category matches, `uses: null` | `verified: false` entries' `uses` must never be treated as a real site claim -- see the file's own header |

## Known gaps carried forward (not yet closed)

- **No acceleration/2nd-derivative signal anywhere in scoring** --
  `microtrend_social_signals` stores the raw material (Stage 6 reads it).
- **No review-queue-derived signal** -- `usefulCandidatesIncorrectlyRejectedRate`
  in the baseline stays `unavailable` until Stage 8 ships.
- **No mismatch-reason-code-derived signal** -- `productMismatchRate`/
  `genericRecommendationRate` in the baseline stay `unavailable` until
  Stage 7 ships.
- **Repost detection is scoped to already-merged candidate groups** --
  it does not (yet) scan across the whole report for a repost whose two
  copies landed in different candidate groups entirely.
