// Pure-function tests for reportBuilder.js's editorial weighting, kept
// separate from reportBuilder.test.js (DB-backed, gated on
// TEST_DATABASE_URL) so these always run in plain `npm test`.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { seasonalFit, THEME_RELEVANCE } = require('../src/reportBuilder');

describe('theme editorial relevance', () => {
  test('rice basics and the core cooking/cuisine themes rank above lunchbox snacks', () => {
    assert.ok(THEME_RELEVANCE.rice_basics > THEME_RELEVANCE.lunchbox_snacks);
    assert.ok(THEME_RELEVANCE.weeknight_dinners > THEME_RELEVANCE.lunchbox_snacks);
    assert.ok(THEME_RELEVANCE.curry_night > THEME_RELEVANCE.lunchbox_snacks);
  });
  test('multicultural has no entry -- its weight comes entirely from the requiresReview lock', () => {
    assert.equal(THEME_RELEVANCE.multicultural, undefined);
  });
});

describe('seasonalFit', () => {
  test('rice basics stays flat year-round (evergreen content)', () => {
    assert.equal(seasonalFit('rice_basics', new Date('2026-01-15')), seasonalFit('rice_basics', new Date('2026-07-15')));
  });
  test('an unknown theme gets the same neutral default as before', () => {
    assert.equal(seasonalFit('something_new', new Date('2026-01-15')), 0.5);
  });
});
