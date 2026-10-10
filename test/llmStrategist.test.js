const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { writeRationale, validateStructuredResponse, extractJson } = require('../src/llmStrategist');

describe('llmStrategist writeRationale', () => {
  test('returns null without ANTHROPIC_API_KEY -- never blocks report generation', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await writeRationale({
      themeLabel: 'Curry night',
      actionType: 'Create',
      distinctSourceCount: 2,
      risingQueries: [{ query: 'biryani', value: 160 }],
      topQueries: [],
      interestByRegion: [],
      socialExamples: []
    });
    assert.equal(result, null);
  });
});

describe('extractJson', () => {
  test('passes through plain JSON unchanged', () => {
    assert.equal(extractJson('{"a":1}'), '{"a":1}');
  });
  test('strips a markdown code fence the model added despite being told not to', () => {
    assert.equal(extractJson('```json\n{"a":1}\n```'), '{"a":1}');
  });
});

describe('validateStructuredResponse', () => {
  const valid = {
    opportunityName: 'Homemade sushi tutorials',
    intentSummary: 'People want to learn to make sushi at home',
    rationale: 'Rising search interest and a matched TikTok suggest real demand for a how-to.',
    recommendedAction: 'Film a short how-to on preparing sushi rice',
    primaryProducts: ['SunRice Sushi Rice'],
    channel: 'TikTok/Instagram Reels',
    format: 'Short-form how-to video',
    creativeAngle: 'Cook, season and roll sushi rice at home',
    continuityStatus: 'new',
    changeSincePrevious: 'first appearance',
    isMateriallyDifferentFromRecent: true,
    evidenceReferences: ['sushi rice']
  };

  test('accepts a well-formed response referencing a real product', () => {
    const result = validateStructuredResponse(valid);
    assert.ok(result);
    assert.equal(result.opportunityName, 'Homemade sushi tutorials');
    assert.deepEqual(result.primaryProducts, ['SunRice Sushi Rice']);
  });

  test('rejects a response naming a product outside the real catalogue', () => {
    const result = validateStructuredResponse({ ...valid, primaryProducts: ['SunRice Invented Rice Deluxe'] });
    assert.equal(result, null);
  });

  test('rejects a response missing required fields', () => {
    assert.equal(validateStructuredResponse({ ...valid, rationale: undefined }), null);
  });

  test('rejects a response containing a fabricated absolute number', () => {
    const result = validateStructuredResponse({ ...valid, rationale: 'Interest is up, with 103k searches this week.' });
    assert.equal(result, null);
  });

  test('rejects null/non-object input without throwing', () => {
    assert.equal(validateStructuredResponse(null), null);
    assert.equal(validateStructuredResponse('not an object'), null);
  });

  test('an invalid continuityStatus guess is dropped, not rejected -- advisory only', () => {
    const result = validateStructuredResponse({ ...valid, continuityStatus: 'something-made-up' });
    assert.ok(result);
    assert.equal(result.continuityStatusGuess, null);
  });

  test('empty primaryProducts is accepted -- not every action needs a product', () => {
    const result = validateStructuredResponse({ ...valid, primaryProducts: [] });
    assert.ok(result);
  });
});
