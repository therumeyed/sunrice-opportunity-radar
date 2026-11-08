// Stage 1 of the 8-stage roadmap (IMPLEMENTATION_CHECKLIST.md): capture
// what this system can already measure, from real existing data, before
// any later stage changes recommendation behaviour. A metric this system
// genuinely cannot compute yet (no review queue, no mismatch reason
// codes) is marked `unavailable` with a reason -- never approximated,
// defaulted to zero, or silently dropped. Missing feedback on a
// recommendation is never read as approval; it just isn't counted either
// way.
const { pool } = require('./db');

const UNAVAILABLE = (reason) => ({ status: 'unavailable', reason });

// Raw counts per feedback_type as the system actually has them today --
// the brief's "relevant vs not-relevant" split doesn't exist pre-Stage-7,
// so this reports today's real 4-type shape rather than inventing a
// binary mapping that would misrepresent what was actually recorded.
async function feedbackCounts() {
  const res = await pool.query(
    `SELECT feedback_type, COUNT(*)::int AS count FROM recommendation_feedback
     WHERE reversed_at IS NULL GROUP BY feedback_type`
  );
  const byType = Object.fromEntries(res.rows.map((r) => [r.feedback_type, r.count]));
  const reversedRes = await pool.query(`SELECT COUNT(*)::int AS count FROM recommendation_feedback WHERE reversed_at IS NOT NULL`);
  return {
    status: 'measured',
    note: "Today's real feedback_type shape (useful/already_covered/not_relevant/dont_show_again) -- Stage 7 collapses this to Relevant/Not relevant; re-baseline after that ships to compare like with like.",
    activeByType: { useful: 0, already_covered: 0, not_relevant: 0, dont_show_again: 0, ...byType },
    reversedCount: reversedRes.rows[0].count
  };
}

// Fraction of all recommendation rows whose action_fingerprint had
// already appeared in an EARLIER report -- a genuine repeat of the same
// concrete action, not a different angle on the same microtrend (those
// get different fingerprints, see continuity.js).
async function duplicateRecommendationRate() {
  const res = await pool.query(
    `WITH ranked AS (
       SELECT rec.id,
              ROW_NUMBER() OVER (PARTITION BY rec.action_fingerprint ORDER BY r.report_date) AS rn
       FROM recommendations rec
       JOIN reports r ON r.id = rec.report_id
       WHERE rec.action_fingerprint IS NOT NULL
     )
     SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE rn > 1)::int AS repeats FROM ranked`
  );
  const { total, repeats } = res.rows[0];
  if (total === 0) return UNAVAILABLE('no recommendations with an action_fingerprint yet');
  return { status: 'measured', total, repeats, rate: Math.round((repeats / total) * 1000) / 1000 };
}

// Days between a microtrend's TRUE first-seen date (first_seen_at, set
// once and never overwritten) and the report_date it first won a
// recommendation slot. Only microtrends that have ever won a slot are
// included -- this measures speed-to-recommendation, not coverage.
async function timeToRecommendation() {
  const res = await pool.query(
    `SELECT AVG(days)::float AS avg_days, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY days) AS median_days, COUNT(*)::int AS sample_size
     FROM (
       SELECT (MIN(r.report_date) - m.first_seen_at) AS days
       FROM microtrends m
       JOIN recommendations rec ON rec.microtrend_id = m.id
       JOIN reports r ON r.id = rec.report_id
       GROUP BY m.id, m.first_seen_at
     ) t`
  );
  const row = res.rows[0];
  if (!row.sample_size) return UNAVAILABLE('no microtrend has won a recommendation slot yet');
  return {
    status: 'measured',
    avgDays: row.avg_days != null ? Math.round(row.avg_days * 10) / 10 : null,
    medianDays: row.median_days != null ? Number(row.median_days) : null,
    sampleSize: row.sample_size
  };
}

// Tier (action_type) of a microtrend's OWN FIRST recommendation --
// a defensible, auditable proxy for "identified while emerging" (Watch/
// Investigate at first appearance) vs "already obvious" (Create at first
// appearance). Named explicitly as a proxy so it can be refined, not
// treated as the brief's own exact definition.
async function tierAtFirstAppearance() {
  const res = await pool.query(
    `WITH first_rec AS (
       SELECT DISTINCT ON (rec.microtrend_id) rec.microtrend_id, rec.action_type
       FROM recommendations rec
       JOIN reports r ON r.id = rec.report_id
       WHERE rec.microtrend_id IS NOT NULL
       ORDER BY rec.microtrend_id, r.report_date ASC
     )
     SELECT action_type, COUNT(*)::int AS count FROM first_rec GROUP BY action_type`
  );
  const byTier = Object.fromEntries(res.rows.map((r) => [r.action_type, r.count]));
  const total = res.rows.reduce((sum, r) => sum + r.count, 0);
  if (total === 0) return UNAVAILABLE('no microtrend has won a recommendation slot yet');
  const emerging = (byTier.Watch || 0) + (byTier.Investigate || 0);
  return {
    status: 'measured',
    definition: 'Share of microtrends whose FIRST-EVER recommendation was Watch or Investigate rather than already Create',
    byTier,
    total,
    shareIdentifiedWhileEmerging: Math.round((emerging / total) * 1000) / 1000
  };
}

// % of recommendations with at least one real linked evidence row, and
// the average age (days, report_date minus the evidence's own published
// date or, failing that, collected_at) of the evidence actually cited.
async function evidenceCompletenessAndFreshness() {
  const totalRes = await pool.query(`SELECT COUNT(*)::int AS count FROM recommendations`);
  const total = totalRes.rows[0].count;
  if (total === 0) return UNAVAILABLE('no recommendations exist yet');

  const withEvidenceRes = await pool.query(
    `SELECT COUNT(DISTINCT rec.id)::int AS count FROM recommendations rec
     JOIN recommendation_evidence re ON re.recommendation_id = rec.id`
  );
  const freshnessRes = await pool.query(
    `SELECT AVG(r.report_date - COALESCE(si.published_at::date, si.collected_at::date))::float AS avg_age_days,
            COUNT(*)::int AS evidence_links
     FROM recommendation_evidence re
     JOIN recommendations rec ON rec.id = re.recommendation_id
     JOIN reports r ON r.id = rec.report_id
     JOIN source_items si ON si.id = re.source_item_id`
  );
  return {
    status: 'measured',
    completeness: Math.round((withEvidenceRes.rows[0].count / total) * 1000) / 1000,
    totalRecommendations: total,
    recommendationsWithEvidence: withEvidenceRes.rows[0].count,
    avgEvidenceAgeDays: freshnessRes.rows[0].avg_age_days != null ? Math.round(freshnessRes.rows[0].avg_age_days * 10) / 10 : null,
    evidenceLinksSampled: freshnessRes.rows[0].evidence_links
  };
}

// Stage 4 (IMPLEMENTATION_CHECKLIST.md): now that real reason codes exist
// (rejected_candidates.reason_code), productMismatchRate/genericRecommendationRate
// can finally be measured -- computed once here and shared by both, rather
// than two near-identical queries.
async function rejectionReasonCounts() {
  const res = await pool.query(
    `SELECT reason_code, COUNT(*)::int AS count FROM rejected_candidates WHERE verdict = 'rejected' GROUP BY reason_code`
  );
  const total = res.rows.reduce((sum, r) => sum + r.count, 0);
  if (total === 0) return null;
  return { total, byReason: Object.fromEntries(res.rows.map((r) => [r.reason_code, r.count])) };
}

// Plain counting context -- not asked for explicitly, but needed to read
// every other number here in proportion (a 20% duplicate rate on 5
// recommendations means something very different than on 500).
async function context() {
  const res = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM reports WHERE status = 'completed')::int AS completed_reports,
       (SELECT MIN(report_date) FROM reports WHERE status = 'completed') AS earliest_report_date,
       (SELECT MAX(report_date) FROM reports WHERE status = 'completed') AS latest_report_date,
       (SELECT COUNT(*) FROM recommendations)::int AS total_recommendations,
       (SELECT COUNT(*) FROM microtrends)::int AS total_microtrends,
       (SELECT COUNT(*) FROM reports WHERE ai_analysis_available = false)::int AS ai_unavailable_days`
  );
  return res.rows[0];
}

async function computeBaseline() {
  const [ctx, feedback, duplicateRate, timeToRec, tierAtFirst, evidence, rejectionCounts] = await Promise.all([
    context(), feedbackCounts(), duplicateRecommendationRate(), timeToRecommendation(), tierAtFirstAppearance(), evidenceCompletenessAndFreshness(),
    rejectionReasonCounts()
  ]);
  return {
    context: ctx,
    feedbackCounts: feedback,
    duplicateRecommendationRate: duplicateRate,
    timeToRecommendation: timeToRec,
    tierAtFirstAppearance: tierAtFirst,
    evidenceCompletenessAndFreshness: evidence,
    // Stage 4: now measurable from real rejected_candidates rows -- share
    // of all REJECTED candidates (not all candidates evaluated; there's no
    // stored count of eligible ones to compare against) whose reason was
    // this specific one.
    productMismatchRate: rejectionCounts ? {
      status: 'measured',
      definition: 'Share of all rejected candidates (Stage 4 eligibility gate) rejected specifically for product_mismatch',
      totalRejected: rejectionCounts.total,
      productMismatchCount: rejectionCounts.byReason.product_mismatch || 0,
      rate: Math.round(((rejectionCounts.byReason.product_mismatch || 0) / rejectionCounts.total) * 1000) / 1000
    } : UNAVAILABLE('no candidate has been rejected by the Stage 4 eligibility gate yet'),
    genericRecommendationRate: rejectionCounts ? {
      status: 'measured',
      definition: 'Share of all rejected candidates (Stage 4 eligibility gate) rejected specifically for too_generic',
      totalRejected: rejectionCounts.total,
      tooGenericCount: rejectionCounts.byReason.too_generic || 0,
      rate: Math.round(((rejectionCounts.byReason.too_generic || 0) / rejectionCounts.total) * 1000) / 1000
    } : UNAVAILABLE('no candidate has been rejected by the Stage 4 eligibility gate yet'),
    // Explicitly named as unavailable rather than silently absent -- needs
    // the human review queue that doesn't exist until Stage 8 ships, and
    // must never be read as "zero" in the meantime.
    usefulCandidatesIncorrectlyRejectedRate: UNAVAILABLE('no human review queue exists yet -- lands in Stage 8')
  };
}

module.exports = { computeBaseline };

if (require.main === module) {
  require('dotenv').config();
  const { recordBaselineSnapshot } = require('./db');
  computeBaseline()
    .then(async (metrics) => {
      console.log(JSON.stringify(metrics, null, 2));
      const row = await recordBaselineSnapshot(metrics, 'Captured after Stage 4 (eligibility) shipped, before Stage 5 (brand-fit scoring) changes ship');
      console.log(`\nSaved as baseline_snapshots.id=${row.id} at ${row.computed_at}`);
      await pool.end();
    })
    .catch((err) => {
      console.error('Baseline computation failed:', err);
      process.exit(1);
    });
}
