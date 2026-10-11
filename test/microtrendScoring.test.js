const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  WEIGHTS, scoreMicrotrend, qualifiesForRecommendation, confidenceForMicrotrend, actionTypeForMicrotrend,
  resolveSocialTier, freshnessScore, velocityScore, noveltyScore, evidenceQualityScore
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
  test('never touches a non-social-only candidate -- search/Pinterest and mixed-evidence candidates are unaffected', () => {
    assert.equal(resolveSocialTier('Create', { isSocialOnly: false, distinctPostCount: 1, distinctCreatorCount: 1 }), 'Create');
  });

  test('a single credible post can still be Watch -- the gate never touches an already-Watch tier', () => {
    assert.equal(resolveSocialTier('Watch', { isSocialOnly: true, distinctPostCount: 1, distinctCreatorCount: 1 }), 'Watch');
  });

  test('Investigate requires multiple posts or creators -- a single post downgrades to Watch', () => {
    assert.equal(resolveSocialTier('Investigate', { isSocialOnly: true, distinctPostCount: 1, distinctCreatorCount: 1 }), 'Watch');
  });

  test('Investigate survives with multiple posts even from one creator', () => {
    assert.equal(resolveSocialTier('Investigate', { isSocialOnly: true, distinctPostCount: 3, distinctCreatorCount: 1 }), 'Investigate');
  });

  test('Investigate survives with multiple creators even from few posts', () => {
    assert.equal(resolveSocialTier('Investigate', { isSocialOnly: true, distinctPostCount: 1, distinctCreatorCount: 2 }), 'Investigate');
  });

  test('Create requires creator diversity -- without it, downgrades to Investigate (not all the way to Watch) when multiple posts exist', () => {
    assert.equal(resolveSocialTier('Create', { isSocialOnly: true, distinctPostCount: 5, distinctCreatorCount: 1 }), 'Investigate');
  });

  test('Create with neither creator diversity nor multiple posts cascades all the way down to Watch', () => {
    assert.equal(resolveSocialTier('Create', { isSocialOnly: true, distinctPostCount: 1, distinctCreatorCount: 1 }), 'Watch');
  });

  test('Create survives with real creator diversity', () => {
    assert.equal(resolveSocialTier('Create', { isSocialOnly: true, distinctPostCount: 3, distinctCreatorCount: 3 }), 'Create');
  });
});
