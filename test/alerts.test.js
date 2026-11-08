const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateSourceConditions, isAuthOrQuotaError, DEFAULT_REFRESH_INTERVAL_HOURS } = require('../src/alerts');

function run(status, overrides = {}) {
  return { status, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), newItemCount: null, error: null, ...overrides };
}

describe('isAuthOrQuotaError', () => {
  test('recognizes common auth/quota error shapes', () => {
    assert.equal(isAuthOrQuotaError('401 Unauthorized'), true);
    assert.equal(isAuthOrQuotaError('Request failed with status code 403'), true);
    assert.equal(isAuthOrQuotaError('429 Too Many Requests'), true);
    assert.equal(isAuthOrQuotaError('Quota exceeded for this account'), true);
    assert.equal(isAuthOrQuotaError('Rate limit hit'), true);
  });
  test('does not flag an unrelated or missing error', () => {
    assert.equal(isAuthOrQuotaError('Network timeout'), false);
    assert.equal(isAuthOrQuotaError(null), false);
    assert.equal(isAuthOrQuotaError(undefined), false);
  });
});

describe('evaluateSourceConditions', () => {
  test('no runs at all -> no conditions', () => {
    assert.deepEqual(evaluateSourceConditions('apify_reddit', []), []);
  });

  test('a single failure is never enough for consecutive_failures', () => {
    const conditions = evaluateSourceConditions('apify_reddit', [run('failed', { error: 'timeout' })]);
    assert.ok(!conditions.some((c) => c.alertType === 'consecutive_failures'));
  });

  test('2 consecutive failed scheduled runs -> consecutive_failures', () => {
    const conditions = evaluateSourceConditions('apify_reddit', [
      run('failed', { error: 'timeout' }),
      run('failed', { error: 'timeout' })
    ]);
    assert.ok(conditions.some((c) => c.alertType === 'consecutive_failures'));
  });

  test('a success breaking up 2 failures does not trigger consecutive_failures', () => {
    const conditions = evaluateSourceConditions('apify_reddit', [
      run('failed', { error: 'timeout' }),
      run('ok', { newItemCount: 3 }),
      run('failed', { error: 'timeout' })
    ]);
    assert.ok(!conditions.some((c) => c.alertType === 'consecutive_failures'));
  });

  test('no successful run ever -> stale_no_success', () => {
    const conditions = evaluateSourceConditions('apify_reddit', [run('failed'), run('failed'), run('failed')]);
    assert.ok(conditions.some((c) => c.alertType === 'stale_no_success'));
  });

  test('a success within 2x the refresh interval -> no stale_no_success', () => {
    const recent = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(); // 10h ago
    const conditions = evaluateSourceConditions('apify_reddit', [run('ok', { finishedAt: recent, newItemCount: 2 })]);
    assert.ok(!conditions.some((c) => c.alertType === 'stale_no_success'));
  });

  test('a success older than 2x the refresh interval -> stale_no_success', () => {
    const stale = new Date(Date.now() - (DEFAULT_REFRESH_INTERVAL_HOURS * 2 + 1) * 60 * 60 * 1000).toISOString();
    const conditions = evaluateSourceConditions('apify_reddit', [run('ok', { finishedAt: stale, newItemCount: 2 })]);
    assert.ok(conditions.some((c) => c.alertType === 'stale_no_success'));
  });

  test('3 consecutive zero-usable-record successes -> zero_usable_records, not consecutive_failures', () => {
    const conditions = evaluateSourceConditions('dataforseo_trends', [
      run('ok', { newItemCount: 0 }),
      run('ok', { newItemCount: 0 }),
      run('ok', { newItemCount: 0 })
    ]);
    assert.ok(conditions.some((c) => c.alertType === 'zero_usable_records'));
    assert.ok(!conditions.some((c) => c.alertType === 'consecutive_failures'));
  });

  test('2 zero-record successes is not enough for zero_usable_records', () => {
    const conditions = evaluateSourceConditions('dataforseo_trends', [
      run('ok', { newItemCount: 0 }),
      run('ok', { newItemCount: 0 })
    ]);
    assert.ok(!conditions.some((c) => c.alertType === 'zero_usable_records'));
  });

  test('zero_usable_records is skipped when newItemCount was never tracked (null)', () => {
    const conditions = evaluateSourceConditions('ai_analysis', [
      run('ok', { newItemCount: null }),
      run('ok', { newItemCount: null }),
      run('ok', { newItemCount: null })
    ]);
    assert.ok(!conditions.some((c) => c.alertType === 'zero_usable_records'));
  });

  test('a failed run with an auth/quota error alerts immediately, even as the only run', () => {
    const conditions = evaluateSourceConditions('dataforseo_trends', [run('failed', { error: '401 Unauthorized' })]);
    assert.ok(conditions.some((c) => c.alertType === 'auth_or_quota_error'));
  });

  test('a failed run with a non-auth error never raises auth_or_quota_error', () => {
    const conditions = evaluateSourceConditions('dataforseo_trends', [run('failed', { error: 'DNS lookup failed' })]);
    assert.ok(!conditions.some((c) => c.alertType === 'auth_or_quota_error'));
  });

  test('a recovered source (latest run ok, recent) raises no conditions at all', () => {
    const recent = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const conditions = evaluateSourceConditions('apify_tiktok', [
      run('ok', { finishedAt: recent, newItemCount: 5 }),
      run('failed', { error: 'timeout' }),
      run('failed', { error: 'timeout' })
    ]);
    assert.deepEqual(conditions, []);
  });
});
