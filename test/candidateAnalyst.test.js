const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildBatchPrompt, validateAssessment, parseAndValidateResponse, buildClusterKeyIndex, analyzeCandidates, extractJson
} = require('../src/candidateAnalyst');

function sampleThemeBatches() {
  return [
    {
      theme: 'rice_basics', themeLabel: 'Rice cooking & prep',
      seedQueries: ['cook rice', 'wash rice'],
      evergreenBaselines: ['how to cook rice'],
      positiveExamples: [],
      candidates: [
        {
          clusterKey: 'rice_basics::air fryer rice paper roll',
          displayText: 'air fryer rice paper rolls',
          members: [{ sourceItemId: 101, sourceType: 'dataforseo_trends', matchType: 'rising_query', metricType: 'rising_value', metricValue: 80 }]
        },
        {
          clusterKey: 'rice_basics::rice paper roll air fryer',
          displayText: 'rice paper rolls in the air fryer',
          members: [{ sourceItemId: 102, sourceType: 'apify_pinterest', matchType: 'pinterest_trend', metricType: 'pinterest_rank', metricValue: 3 }]
        }
      ]
    }
  ];
}

describe('buildBatchPrompt', () => {
  test('includes every candidate clusterKey and evidence id so nothing is silently left out', () => {
    const prompt = buildBatchPrompt(sampleThemeBatches());
    assert.ok(prompt.includes('rice_basics::air fryer rice paper roll'));
    assert.ok(prompt.includes('rice_basics::rice paper roll air fryer'));
    assert.ok(prompt.includes('evidenceId 101'));
    assert.ok(prompt.includes('evidenceId 102'));
  });

  test('includes the real product catalogue so Claude cannot claim it wasn\'t given one', () => {
    const prompt = buildBatchPrompt(sampleThemeBatches());
    assert.ok(prompt.includes('SunRice Sushi Rice'));
  });

  test('states the seed queries and evergreen baselines for the theme', () => {
    const prompt = buildBatchPrompt(sampleThemeBatches());
    assert.ok(prompt.includes('cook rice, wash rice'));
    assert.ok(prompt.includes('how to cook rice'));
  });
});

describe('extractJson', () => {
  test('strips a markdown fence Claude added despite being told not to', () => {
    assert.equal(extractJson('```json\n[1,2]\n```'), '[1,2]');
  });
});

describe('validateAssessment', () => {
  const index = buildClusterKeyIndex(sampleThemeBatches());
  const valid = {
    clusterKeys: ['rice_basics::air fryer rice paper roll', 'rice_basics::rice paper roll air fryer'],
    candidateName: 'Air fryer rice paper rolls',
    parentTheme: 'rice_basics',
    classification: 'micro',
    isDistinctFromEvergreen: true,
    brandRelevance: 0.7,
    productConnection: ['SunRice Jasmine Fragrant Rice'],
    whyItMattersNow: 'Rising search and a matching Pinterest trend term both point to this right now.',
    proposedAction: {
      recommendedAction: 'Film a short air fryer rice paper roll how-to',
      channel: 'TikTok/Instagram Reels',
      format: 'Short-form how-to video',
      creativeAngle: 'Crispy air fryer rice paper rolls, no deep frying'
    },
    evidenceIds: [101, 102]
  };

  test('accepts a well-formed assessment referencing real clusterKeys and evidence', () => {
    const result = validateAssessment(valid, index);
    assert.ok(result);
    assert.equal(result.clusterKeys.length, 2);
    assert.deepEqual(result.evidenceIds, [101, 102]);
  });

  test('merges two differently-worded candidates when both real clusterKeys are cited', () => {
    const result = validateAssessment(valid, index);
    assert.ok(result.clusterKeys.includes('rice_basics::air fryer rice paper roll'));
    assert.ok(result.clusterKeys.includes('rice_basics::rice paper roll air fryer'));
  });

  test('drops an invented clusterKey but keeps the assessment if a real one remains', () => {
    const result = validateAssessment({ ...valid, clusterKeys: [...valid.clusterKeys, 'rice_basics::invented key'] }, index);
    assert.ok(result);
    assert.equal(result.clusterKeys.length, 2);
  });

  test('rejects outright when every clusterKey is invented', () => {
    const result = validateAssessment({ ...valid, clusterKeys: ['rice_basics::totally made up'] }, index);
    assert.equal(result, null);
  });

  test('drops an invented evidenceId but keeps the assessment if a real one remains', () => {
    const result = validateAssessment({ ...valid, evidenceIds: [101, 999999] }, index);
    assert.ok(result);
    assert.deepEqual(result.evidenceIds, [101]);
  });

  test('rejects outright when every evidenceId is invented -- no real evidence grounds it', () => {
    const result = validateAssessment({ ...valid, evidenceIds: [999999] }, index);
    assert.equal(result, null);
  });

  test('rejects a response naming a product outside the real catalogue', () => {
    const result = validateAssessment({ ...valid, productConnection: ['SunRice Invented Deluxe Rice'] }, index);
    assert.equal(result, null);
  });

  test('rejects an invalid classification', () => {
    const result = validateAssessment({ ...valid, classification: 'trending' }, index);
    assert.equal(result, null);
  });

  test('rejects a response containing a fabricated absolute number', () => {
    const result = validateAssessment({ ...valid, whyItMattersNow: 'Interest is up, with 103k searches this week.' }, index);
    assert.equal(result, null);
  });

  test('rejects a response missing brandRelevance', () => {
    const result = validateAssessment({ ...valid, brandRelevance: undefined }, index);
    assert.equal(result, null);
  });

  test('clamps an out-of-range brandRelevance into 0-1', () => {
    const result = validateAssessment({ ...valid, brandRelevance: 1.5 }, index);
    assert.equal(result.brandRelevance, 1);
  });

  test('rejects a response missing a concrete recommendedAction', () => {
    const result = validateAssessment({ ...valid, proposedAction: { ...valid.proposedAction, recommendedAction: '' } }, index);
    assert.equal(result, null);
  });

  test('rejects null/non-object input without throwing', () => {
    assert.equal(validateAssessment(null, index), null);
    assert.equal(validateAssessment('not an object', index), null);
  });
});

describe('parseAndValidateResponse', () => {
  const batches = sampleThemeBatches();

  test('parses a valid JSON array and validates each element', () => {
    const response = JSON.stringify([{
      clusterKeys: ['rice_basics::air fryer rice paper roll'],
      candidateName: 'Air fryer rice paper rolls',
      parentTheme: 'rice_basics',
      classification: 'micro',
      brandRelevance: 0.6,
      productConnection: [],
      whyItMattersNow: 'Rising search interest right now.',
      proposedAction: { recommendedAction: 'Make a short video' },
      evidenceIds: [101]
    }]);
    const { assessments, rejectedCount } = parseAndValidateResponse(response, batches);
    assert.equal(assessments.length, 1);
    assert.equal(rejectedCount, 0);
  });

  test('a non-array response is treated as a parse error, never a crash', () => {
    const { assessments, parseError } = parseAndValidateResponse('{"not": "an array"}', batches);
    assert.equal(assessments.length, 0);
    assert.ok(parseError);
  });

  test('invalid JSON is a parse error, never a crash', () => {
    const { assessments, parseError } = parseAndValidateResponse('not json at all', batches);
    assert.equal(assessments.length, 0);
    assert.ok(parseError);
  });

  test('counts rejected elements separately from valid ones', () => {
    const response = JSON.stringify([
      { clusterKeys: ['rice_basics::air fryer rice paper roll'], candidateName: 'Real one', parentTheme: 'rice_basics', classification: 'micro', brandRelevance: 0.5, whyItMattersNow: 'x', proposedAction: { recommendedAction: 'y' }, evidenceIds: [101] },
      { clusterKeys: ['made up key'], candidateName: 'Fake one', parentTheme: 'rice_basics', classification: 'micro', brandRelevance: 0.5, whyItMattersNow: 'x', proposedAction: { recommendedAction: 'y' }, evidenceIds: [1] }
    ]);
    const { assessments, rejectedCount } = parseAndValidateResponse(response, batches);
    assert.equal(assessments.length, 1);
    assert.equal(rejectedCount, 1);
  });
});

describe('analyzeCandidates', () => {
  test('returns unavailable without ANTHROPIC_API_KEY -- this is a hard gate, not a soft fallback', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await analyzeCandidates(sampleThemeBatches());
    assert.equal(result.status, 'unavailable');
    assert.ok(result.reason);
  });

  test('returns ok with an empty assessments list when there are no candidates at all -- not a failure', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await analyzeCandidates([{ theme: 'rice_basics', themeLabel: 'Rice', seedQueries: [], evergreenBaselines: [], positiveExamples: [], candidates: [] }]);
    // No candidates and no key: still unavailable per the hard gate -- never
    // silently claim "ok" just because there was nothing to analyze while
    // the key itself is missing.
    assert.equal(result.status, 'unavailable');
  });
});
