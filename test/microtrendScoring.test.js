const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  WEIGHTS, scoreMicrotrend, qualifiesForRecommendation, confidenceForMicrotrend, actionTypeForMicrotrend,
  resolveSocialTier, hasMomentumCorroboration, socialObservationEligibility,
  freshnessScore, velocityScore, noveltyScore, evidenceQualityScore
} = require('../src/microtrendScoring');

describe('WEIGHTS', () => {
  test('sums to 1 so the score formula stays auditable as a plain percentage', () => {
    const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    assert.equal(Math.round(total * 1000) / 1000, 1);
  });
});

describe('freshnessScore', () => {
  test('brand new (0 days old) scores highest', () => {
    assert.equal(freshnessScore(0), 1);
  });
  test('decays to 0 by 10 days', () => {
    assert.equal(freshnessScore(10), 0);
    assert.equal(freshnessScore(20), 0); // clamped, never negative
  });
  test('unknown age is neutral, not zero', () => {
    assert.equal(freshnessScore(null), 0.5);
  });
});

describe('velocityScore', () => {
  test('a real numeric rise vs. prior average scores higher than flat', () => {
    const history = [
      { source_type: 'dataforseo_trends', metric_type: 'rising_value', metric_value: 50 },
      { source_type: 'dataforseo_trends', metric_type: 'rising_value', metric_value: 50 }
    ];
    const today = [{ sourceType: 'dataforseo_trends', metricType: 'rising_value', metricValue: 150 }];
    const flat = [{ sourceType: 'dataforseo_trends', metricType: 'rising_value', metricValue: 50 }];
    assert.ok(velocityScore({ observationHistory: history, todayObservations: today }) > velocityScore({ observationHistory: history, todayObservations: flat }));
  });

  test('Pinterest rank is never used as a numeric velocity signal (no confirmed scale)', () => {
    const history = [{ source_type: 'apify_pinterest', metric_type: 'pinterest_rank', metric_value: 10 }];
    const today = [{ sourceType: 'apify_pinterest', metricType: 'pinterest_rank', metricValue: 1, sourceNativeClassification: 'growing' }];
    // Should fall through to the categorical "growing" flag path, not treat rank 1 vs 10 as a 90% velocity drop/rise.
    const result = velocityScore({ observationHistory: history, todayObservations: today });
    assert.equal(result, 0.55); // seen before (history.length > 0), flag present
  });

  test('brand new with a rising/growing flag scores higher than brand new without one', () => {
    const withFlag = velocityScore({ observationHistory: [], todayObservations: [{ sourceType: 'apify_pinterest', metricType: 'pinterest_rank', metricValue: 1, sourceNativeClassification: 'growing' }] });
    const withoutFlag = velocityScore({ observationHistory: [], todayObservations: [{ sourceType: 'apify_pinterest', metricType: 'pinterest_rank', metricValue: 1, sourceNativeClassification: 'top_monthly' }] });
    assert.ok(withFlag > withoutFlag);
  });
});

describe('noveltyScore', () => {
  test('recently first-seen and never recommended scores highest', () => {
    assert.equal(noveltyScore({ daysSinceFirstSeen: 0, priorRecommendationCount: 0 }), 1);
  });

  test('each prior recommendation knocks novelty down', () => {
    const once = noveltyScore({ daysSinceFirstSeen: 0, priorRecommendationCount: 1 });
    const twice = noveltyScore({ daysSinceFirstSeen: 0, priorRecommendationCount: 2 });
    assert.ok(once > twice);
    assert.ok(twice > 0);
  });

  test('never goes negative even after many repeats', () => {
    assert.equal(noveltyScore({ daysSinceFirstSeen: 0, priorRecommendationCount: 10 }), 0);
  });

  test('unknown first-seen date is neutral', () => {
    assert.equal(noveltyScore({ daysSinceFirstSeen: null, priorRecommendationCount: 0 }), 0.5);
  });
});

describe('evidenceQualityScore', () => {
  test('more distinct source items score higher, capped at 3+', () => {
    assert.equal(evidenceQualityScore(0), 0);
    assert.equal(evidenceQualityScore(1), 0.4);
    assert.equal(evidenceQualityScore(2), 0.7);
    assert.equal(evidenceQualityScore(3), 1);
    assert.equal(evidenceQualityScore(10), 1);
  });
});

describe('scoreMicrotrend', () => {
  test('a strong, fresh, corroborated, novel microtrend scores well above a weak one', () => {
    const strong = scoreMicrotrend({
      daysOld: 0, observationHistory: [], todayObservations: [{ sourceType: 'dataforseo_trends', metricType: 'rising_value', metricValue: 90, sourceNativeClassification: 'rising' }],
      distinctSourceCount: 3, relevance: 1, daysSinceFirstSeen: 0, priorRecommendationCount: 0, uniqueSourceItemCount: 3
    });
    const weak = scoreMicrotrend({
      daysOld: 9, observationHistory: [], todayObservations: [], distinctSourceCount: 1, relevance: 0.5,
      daysSinceFirstSeen: 13, priorRecommendationCount: 3, uniqueSourceItemCount: 1
    });
    assert.ok(strong.score > weak.score);
  });

  test('returns every named component so the number is always auditable', () => {
    const { components } = scoreMicrotrend({
      daysOld: 2, observationHistory: [], todayObservations: [], distinctSourceCount: 2, relevance: 1,
      daysSinceFirstSeen: 2, priorRecommendationCount: 0, uniqueSourceItemCount: 2
    });
    assert.deepEqual(Object.keys(components).sort(), ['agreement', 'evidenceQuality', 'freshness', 'novelty', 'relevance', 'velocity'].sort());
  });
});

describe('qualifiesForRecommendation', () => {
  test('micro and seasonal candidates are never baseline-locked', () => {
    assert.equal(qualifiesForRecommendation({ candidateType: 'micro', baselineShownAt: new Date(), reportDate: new Date() }), true);
    assert.equal(qualifiesForRecommendation({ candidateType: 'seasonal', baselineShownAt: new Date(), reportDate: new Date() }), true);
  });

  test('a macro never shown before is eligible (first time showing the baseline)', () => {
    assert.equal(qualifiesForRecommendation({ candidateType: 'macro', baselineShownAt: null, reportDate: '2026-01-10' }), true);
  });

  test('a macro shown 10 days ago with no material change is suppressed', () => {
    const result = qualifiesForRecommendation({
      candidateType: 'macro', baselineShownAt: '2026-01-01', reportDate: '2026-01-11', materialChangeSinceBaseline: false
    });
    assert.equal(result, false);
  });

  test('a macro shown 10 days ago WITH a verified material change is allowed through', () => {
    const result = qualifiesForRecommendation({
      candidateType: 'macro', baselineShownAt: '2026-01-01', reportDate: '2026-01-11', materialChangeSinceBaseline: true
    });
    assert.equal(result, true);
  });

  test('a macro shown 31 days ago is eligible again regardless of material change', () => {
    const result = qualifiesForRecommendation({
      candidateType: 'macro', baselineShownAt: '2026-01-01', reportDate: '2026-02-01', materialChangeSinceBaseline: false
    });
    assert.equal(result, true);
  });
});

describe('confidenceForMicrotrend / actionTypeForMicrotrend', () => {
  test('high score with multi-source agreement is high confidence / Create', () => {
    assert.equal(confidenceForMicrotrend(75, 2), 'high');
    assert.equal(actionTypeForMicrotrend(75), 'Create');
  });
  test('high score but single-source is only medium confidence', () => {
    assert.equal(confidenceForMicrotrend(75, 1), 'medium');
  });
  test('low score is early_signal / Watch', () => {
    assert.equal(confidenceForMicrotrend(20, 1), 'early_signal');
    assert.equal(actionTypeForMicrotrend(20), 'Watch');
  });
});

describe('resolveSocialTier', () => {
  test('a single credible post can still be Watch -- the gate never touches an already-Watch tier', () => {
    assert.equal(resolveSocialTier('Watch', { isSocialOnly: true, distinctPostCount: 1, distinctCreatorCount: 1 }), 'Watch');
  });

  test('pure social, no corroboration: Investigate requires multiple posts or creators -- a single post downgrades to Watch', () => {
    assert.equal(resolveSocialTier('Investigate', { isSocialOnly: true, distinctPostCount: 1, distinctCreatorCount: 1 }), 'Watch');
  });

  test('pure social: Investigate survives with multiple posts even from one creator', () => {
    assert.equal(resolveSocialTier('Investigate', { isSocialOnly: true, distinctPostCount: 3, distinctCreatorCount: 1 }), 'Investigate');
  });

  test('pure social: Investigate survives with multiple creators even from few posts', () => {
    assert.equal(resolveSocialTier('Investigate', { isSocialOnly: true, distinctPostCount: 1, distinctCreatorCount: 2 }), 'Investigate');
  });

  test('pure social: Create requires reliable-recent creator diversity -- distinctCreatorCount alone (stale/undated) is not enough', () => {
    assert.equal(resolveSocialTier('Create', {
      isSocialOnly: true, distinctPostCount: 5, distinctCreatorCount: 3, reliableRecentCreatorCount: 0
    }), 'Investigate');
  });

  test('pure social: Create with neither creator diversity nor multiple posts cascades all the way down to Watch', () => {
    assert.equal(resolveSocialTier('Create', { isSocialOnly: true, distinctPostCount: 1, distinctCreatorCount: 1 }), 'Watch');
  });

  test('pure social: Create survives with 2+ reliable-recent distinct creators', () => {
    assert.equal(resolveSocialTier('Create', {
      isSocialOnly: true, distinctPostCount: 3, distinctCreatorCount: 3, reliableRecentCreatorCount: 2
    }), 'Create');
  });

  test('a single reliable-recent creator alone is not diversity -- still downgrades to Investigate', () => {
    assert.equal(resolveSocialTier('Create', {
      isSocialOnly: true, distinctPostCount: 3, distinctCreatorCount: 3, reliableRecentCreatorCount: 1
    }), 'Investigate');
  });

  // Cross-source corroboration: a bare merge with search/Pinterest evidence
  // is no longer enough on its own -- only GENUINE momentum (a real rising
  // query, a Pinterest "growing" term, or a measured increase) fully lifts
  // the gate. This is the exact behavior change the user asked for: "a
  // candidate with one social post plus a non-rising top query should
  // remain capped at Investigate."
  test('weak (non-momentum) cross-source corroboration caps Create at Investigate, even for a single post with no creator diversity', () => {
    assert.equal(resolveSocialTier('Create', {
      isSocialOnly: false, hasMomentumCorroboration: false, distinctPostCount: 1, distinctCreatorCount: 1
    }), 'Investigate');
  });

  test('weak cross-source corroboration still lets Investigate stand on a single post -- it is not pushed down to Watch', () => {
    assert.equal(resolveSocialTier('Investigate', {
      isSocialOnly: false, hasMomentumCorroboration: false, distinctPostCount: 1, distinctCreatorCount: 1
    }), 'Investigate');
  });

  test('genuine momentum corroboration fully lifts the gate -- Create survives on a single post with no creator diversity', () => {
    assert.equal(resolveSocialTier('Create', {
      isSocialOnly: false, hasMomentumCorroboration: true, distinctPostCount: 1, distinctCreatorCount: 1
    }), 'Create');
  });

  test('genuine momentum corroboration is irrelevant when the candidate is pure social-only (no non-social evidence to be genuine about)', () => {
    // isSocialOnly stays true only when there is literally no non-social
    // member, so hasMomentumCorroboration:true here is a defensive
    // input-shape check, not a realistic caller state -- the gate must
    // still apply the normal pure-social rules.
    assert.equal(resolveSocialTier('Create', {
      isSocialOnly: true, hasMomentumCorroboration: true, distinctPostCount: 1, distinctCreatorCount: 1
    }), 'Watch');
  });
});

describe('hasMomentumCorroboration', () => {
  test('a Google rising query counts as genuine momentum', () => {
    const result = hasMomentumCorroboration({
      nonSocialTodayObservations: [{ sourceType: 'dataforseo_trends', metricType: 'rising_value', metricValue: 80, sourceNativeClassification: 'rising' }],
      nonSocialPriorHistory: []
    });
    assert.equal(result, true);
  });

  test('a Pinterest "growing" classification counts as genuine momentum', () => {
    const result = hasMomentumCorroboration({
      nonSocialTodayObservations: [{ sourceType: 'apify_pinterest', metricType: 'pinterest_rank', metricValue: 1, sourceNativeClassification: 'growing' }],
      nonSocialPriorHistory: []
    });
    assert.equal(result, true);
  });

  test('a bare "top" query with no rising/growing flag and no history is NOT genuine momentum', () => {
    const result = hasMomentumCorroboration({
      nonSocialTodayObservations: [{ sourceType: 'dataforseo_trends', metricType: 'top_value', metricValue: 50, sourceNativeClassification: 'top' }],
      nonSocialPriorHistory: []
    });
    assert.equal(result, false);
  });

  test('a measured increase vs. real stored history counts as genuine momentum, even for a "top" query', () => {
    const result = hasMomentumCorroboration({
      nonSocialTodayObservations: [{ sourceType: 'dataforseo_trends', metricType: 'top_value', metricValue: 90, sourceNativeClassification: 'top' }],
      nonSocialPriorHistory: [
        { source_type: 'dataforseo_trends', metric_type: 'top_value', metric_value: 50 },
        { source_type: 'dataforseo_trends', metric_type: 'top_value', metric_value: 50 }
      ]
    });
    assert.equal(result, true);
  });

  test('a flat or declining numeric value vs. history is NOT genuine momentum', () => {
    const result = hasMomentumCorroboration({
      nonSocialTodayObservations: [{ sourceType: 'dataforseo_trends', metricType: 'top_value', metricValue: 50, sourceNativeClassification: 'top' }],
      nonSocialPriorHistory: [{ source_type: 'dataforseo_trends', metric_type: 'top_value', metric_value: 50 }]
    });
    assert.equal(result, false);
  });

  test('no non-social evidence at all is NOT genuine momentum', () => {
    assert.equal(hasMomentumCorroboration({ nonSocialTodayObservations: [], nonSocialPriorHistory: [] }), false);
  });
});

describe('socialObservationEligibility', () => {
  test('fewer than 3 observations is insufficient history', () => {
    assert.equal(socialObservationEligibility(0), 'insufficient_history');
    assert.equal(socialObservationEligibility(2), 'insufficient_history');
  });

  test('3 to 6 observations is preliminary direction only', () => {
    assert.equal(socialObservationEligibility(3), 'preliminary');
    assert.equal(socialObservationEligibility(6), 'preliminary');
  });

  test('7 or more observations is eligible for measured momentum scoring', () => {
    assert.equal(socialObservationEligibility(7), 'eligible');
    assert.equal(socialObservationEligibility(30), 'eligible');
  });
});
