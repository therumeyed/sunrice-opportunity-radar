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
**Status:** in progress

Capture what the system can already measure before any of Stages 4-7
change recommendation behaviour. Metrics that genuinely can't be
measured yet (no review queue, no mismatch reason codes) are marked
`unavailable`, never approximated or defaulted to zero.

- [ ] `baseline_snapshots` table (additive)
- [ ] `src/baseline.js` -- computes feedback-type counts, duplicate-recommendation
      rate, time-to-recommendation, evidence completeness/freshness, tier-at-
      first-appearance distribution
- [ ] `POST /admin/baseline` endpoint (requireAdmin) to trigger + store + return it
- [ ] Verified against fixtures in a scratch DB
- [ ] Run once for real against production after this stage deploys (this
      needs the user to trigger it on Render -- a local scratch DB has no
      real history to snapshot)

## Stage 2: Evidence-store additions, catalogue enrichment, data-use audit
**Status:** pending

- [ ] `source_items.geography_confidence`, `content_format` columns (additive)
- [ ] Cross-source repost detection (flags, never merges/conflates creators)
- [ ] Per-evidence product linkage
- [ ] `products.js` enriched with category/format/uses/url/verifiedAt/provenance,
      inferred vs verified clearly distinguished
- [ ] Data-use audit committed to the repo as a living file

## Stage 3: Monitoring and failure visibility
**Status:** pending

- [ ] Per-source run history surfaced (last attempted/successful, duration,
      new vs duplicate counts)
- [ ] 4 alert rules: 2 consecutive failures; no success for 2x refresh
      interval; 3 consecutive zero-usable-record runs flagged (not failed);
      auth/quota errors immediate
- [ ] In-app admin alerts + configurable email (unconfigured state shown
      honestly, never claimed as tested without a real send)
- [ ] Alerts grouped by source+incident, notify on recovery
- [ ] Scraper health kept separate from AI-analysis health
- [ ] Admin section: inspect failures, retry without duplicating

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
