const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

describe('llmStrategist', () => {
  test('returns null without ANTHROPIC_API_KEY -- never blocks report generation', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { writeRationale } = require('../src/llmStrategist');
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
