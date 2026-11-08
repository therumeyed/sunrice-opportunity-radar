// SunRice brand-suitability configuration -- Stage 4 (IMPLEMENTATION_CHECKLIST.md).
// Editable, documented assumptions, not a fixed law. Fed directly into
// Claude's eligibility prompt (candidateAnalyst.js) as explicit judging
// criteria, replacing ad hoc/implicit judgment with a documented standard
// that's easy to review and correct -- review and adjust as real outcomes
// accumulate (Stage 8's review queue is where that feedback loop
// eventually closes). Every field below is an ASSUMPTION, not a measured
// fact; correct it here, in one place, not scattered across prompt text.
module.exports = {
  // ASSUMPTION: primary market is Australia, but an international trend
  // is never auto-rejected for being international -- only for failing to
  // translate. See internationalTrendsPolicy below.
  primaryMarket: 'Australia',
  primaryAudiences: ['home cooks', 'families', 'health-conscious consumers', 'multicultural audiences within Australia'],
  acceptedOccasions: [
    'everyday/weeknight cooking',
    'rice-based recipes and meal prep',
    'lunchbox/snacking',
    'seasonal and cultural food occasions, including non-Australian-origin ones, if they can genuinely resonate with an Australian audience',
    'health/dietary angles (low-GI, gluten-free, etc.) where a real SunRice product supports the claim'
  ],
  // ASSUMPTION: a credible product connection means the idea genuinely
  // suits an EXISTING, real SunRice product/format as sold today -- not a
  // hypothetical future product, and not a connection that requires
  // changing the trend into something it isn't.
  productConnectionStandard: 'The trend must connect to a real, current SunRice product or a genuine rice-based occasion, without requiring the core idea to change into something else to make the connection work.',
  // ASSUMPTION: generic, non-seasonal, evergreen advice with no fresh
  // angle or evidence of rising interest is not a brand-suitability
  // failure per se, but it is not eligible either -- being a real, on-
  // brand topic is not enough on its own.
  genericAdviceStandard: 'Reject as too_generic when the idea is evergreen advice with no specific new development, angle, or evidence of rising interest.',
  // ASSUMPTION: never reject solely for being international -- geography
  // confidence is tracked per evidence item (Stage 2) specifically so this
  // judgment can be made honestly rather than assumed.
  internationalTrendsPolicy: 'Never reject a candidate solely for being international. Assess only whether the underlying behaviour could credibly translate to an Australian audience. If an evidence item\'s geography is not confirmed Australian, say so honestly in your reasoning rather than assuming it is, or silently assuming it is not.',
  excludedTopics: [
    // ASSUMPTION: starting list, deliberately short -- document additions
    // here with a reason, never silently.
    'content unrelated to food/cooking/rice entirely',
    'competitor-branded content with no genuine SunRice angle'
  ],
  lastReviewed: '2026-11-08'
};
