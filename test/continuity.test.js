const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { computeActionFingerprint, determineContinuityStatus } = require('../src/continuity');

describe('computeActionFingerprint', () => {
  test('identical inputs fingerprint identically regardless of casing/punctuation', () => {
    const a = computeActionFingerprint({ theme: 'sushi_asian', primaryProducts: ['SunRice Sushi Rice'], channel: 'TikTok', format: 'Short-form video', creativeAngle: 'Cook sushi rice at home' });
    const b = computeActionFingerprint({ theme: 'Sushi_Asian', primaryProducts: ['sunrice sushi rice'], channel: 'tiktok', format: 'short form video', creativeAngle: 'Cook Sushi Rice At Home!' });
    assert.equal(a, b);
  });
  test('a different creative angle fingerprints differently', () => {
    const a = computeActionFingerprint({ theme: 'sushi_asian', primaryProducts: ['SunRice Sushi Rice'], channel: 'TikTok', format: 'video', creativeAngle: 'Cook sushi rice at home' });
    const b = computeActionFingerprint({ theme: 'sushi_asian', primaryProducts: ['SunRice Sushi Rice'], channel: 'TikTok', format: 'video', creativeAngle: 'Compare jasmine vs sushi rice' });
    assert.notEqual(a, b);
  });
  test('product order does not change the fingerprint', () => {
    const a = computeActionFingerprint({ theme: 't', primaryProducts: ['A', 'B'], channel: 'c', format: 'f', creativeAngle: 'x' });
    const b = computeActionFingerprint({ theme: 't', primaryProducts: ['B', 'A'], channel: 'c', format: 'f', creativeAngle: 'x' });
    assert.equal(a, b);
  });
});

describe('determineContinuityStatus', () => {
  const reportDate = '2026-10-10';

  test('no recent history and no same-day recommendation is new', () => {
    assert.equal(determineContinuityStatus({ recentRecs: [], sameDayRec: null, newFingerprint: 'abc', todayScore: 70, reportDate }), 'new');
  });

  test('a same-day recommendation with the same fingerprint is a repeat within the same day', () => {
    const sameDayRec = { action_fingerprint: 'abc' };
    assert.equal(determineContinuityStatus({ recentRecs: [], sameDayRec, newFingerprint: 'abc', todayScore: 70, reportDate }), 'repeat_action');
  });

  test('a same-day recommendation with a different fingerprint is a new angle', () => {
    const sameDayRec = { action_fingerprint: 'abc' };
    assert.equal(determineContinuityStatus({ recentRecs: [], sameDayRec, newFingerprint: 'xyz', todayScore: 70, reportDate }), 'new_angle');
  });

  test('same fingerprint recommended within the last 7 days is a repeat, regardless of score', () => {
    const recentRecs = [{ report_date: '2026-10-05', score: 60, action_fingerprint: 'abc' }];
    assert.equal(determineContinuityStatus({ recentRecs, sameDayRec: null, newFingerprint: 'abc', todayScore: 90, reportDate }), 'repeat_action');
  });

  test('same fingerprint but more than 7 days ago is not forced into repeat_action', () => {
    const recentRecs = [{ report_date: '2026-09-20', score: 60, action_fingerprint: 'abc' }];
    const result = determineContinuityStatus({ recentRecs, sameDayRec: null, newFingerprint: 'abc', todayScore: 60, reportDate });
    assert.notEqual(result, 'repeat_action');
  });

  test('a different fingerprint than the most recent recommendation is a new angle', () => {
    const recentRecs = [{ report_date: '2026-10-03', score: 60, action_fingerprint: 'old' }];
    assert.equal(determineContinuityStatus({ recentRecs, sameDayRec: null, newFingerprint: 'new', todayScore: 60, reportDate }), 'new_angle');
  });

  test('same fingerprint as most recent, score up meaningfully, is strengthening', () => {
    const recentRecs = [{ report_date: '2026-09-25', score: 60, action_fingerprint: 'abc' }];
    assert.equal(determineContinuityStatus({ recentRecs, sameDayRec: null, newFingerprint: 'abc', todayScore: 75, reportDate }), 'strengthening');
  });

  test('same fingerprint as most recent, score down meaningfully, is weakening', () => {
    const recentRecs = [{ report_date: '2026-09-25', score: 75, action_fingerprint: 'abc' }];
    assert.equal(determineContinuityStatus({ recentRecs, sameDayRec: null, newFingerprint: 'abc', todayScore: 60, reportDate }), 'weakening');
  });

  test('same fingerprint, score roughly flat, is continuing -- not flapping on noise', () => {
    const recentRecs = [{ report_date: '2026-09-25', score: 70, action_fingerprint: 'abc' }];
    assert.equal(determineContinuityStatus({ recentRecs, sameDayRec: null, newFingerprint: 'abc', todayScore: 72, reportDate }), 'continuing');
  });

  test('null fingerprint (no LLM output) never asserts repeat_action or new_angle -- falls back to score trend', () => {
    // Without real execution detail there's nothing honest to fingerprint;
    // a null fingerprint must never be treated as "same as last time".
    const recentRecs = [{ report_date: '2026-10-08', score: 70, action_fingerprint: null }];
    const result = determineContinuityStatus({ recentRecs, sameDayRec: null, newFingerprint: null, todayScore: 72, reportDate });
    assert.equal(result, 'continuing');
  });

  test('null fingerprint still reflects a real score change', () => {
    const recentRecs = [{ report_date: '2026-10-08', score: 50, action_fingerprint: null }];
    assert.equal(determineContinuityStatus({ recentRecs, sameDayRec: null, newFingerprint: null, todayScore: 70, reportDate }), 'strengthening');
  });

  test('null fingerprint same-day recommendation is continuing, not a forced repeat', () => {
    const sameDayRec = { action_fingerprint: null };
    assert.equal(determineContinuityStatus({ recentRecs: [], sameDayRec, newFingerprint: null, todayScore: 70, reportDate }), 'continuing');
  });
});
