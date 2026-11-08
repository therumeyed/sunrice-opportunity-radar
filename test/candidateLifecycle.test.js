const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  observationDays, searchTrendDirection, socialTrendDirection, candidateLifecycleFor, urgencyNote, EXECUTION_LEAD_TIME_DAYS
} = require('../src/candidateLifecycle');

function obsRow(date, value) {
  return { report_date: date, source_type: 'dataforseo_trends', metric_type: 'rising_value', metric_value: value };
}
function socialRow(date, newPostCount) {
  return { report_date: date, new_post_count: newPostCount };
}

describe('observationDays', () => {
  test('counts the union of both histories\' distinct report_dates, plus 1 for today', () => {
    const observations = [obsRow('2026-01-01', 10), obsRow('2026-01-02', 12)];
    const social = [obsRow('2026-01-02', 1), socialRow('2026-01-03', 2)];
    // distinct dates: 01-01, 01-02, 01-03 = 3, +1 for today = 4
    assert.equal(observationDays(observations, social), 4);
  });

  test('a microtrend with zero history yet is just 1 (today alone)', () => {
    assert.equal(observationDays([], []), 1);
  });

  test('the same calendar day appearing in both histories is counted once, not twice', () => {
    const observations = [obsRow('2026-01-01', 10)];
    const social = [socialRow('2026-01-01', 1)];
    assert.equal(observationDays(observations, social), 2); // 1 distinct day + today
  });
});

describe('searchTrendDirection / socialTrendDirection', () => {
  test('returns null (never a default) with fewer than TREND_WINDOW+1 days of history', () => {
    assert.equal(searchTrendDirection([obsRow('2026-01-01', 10), obsRow('2026-01-02', 10)]), null);
  });

  test('a clear rising_value increase across the recent window is growing', () => {
    const rows = [obsRow('2026-01-01', 10), obsRow('2026-01-02', 10), obsRow('2026-01-03', 10), obsRow('2026-01-04', 50), obsRow('2026-01-05', 50)];
    assert.equal(searchTrendDirection(rows), 'growing');
  });

  test('a clear rising_value decrease across the recent window is declining', () => {
    const rows = [obsRow('2026-01-01', 50), obsRow('2026-01-02', 50), obsRow('2026-01-03', 50), obsRow('2026-01-04', 10), obsRow('2026-01-05', 10)];
    assert.equal(searchTrendDirection(rows), 'declining');
  });

  test('a flat series is established, not growing or declining', () => {
    const rows = [obsRow('2026-01-01', 30), obsRow('2026-01-02', 31), obsRow('2026-01-03', 29), obsRow('2026-01-04', 30), obsRow('2026-01-05', 30)];
    assert.equal(searchTrendDirection(rows), 'established');
  });

  test('Pinterest rows (no confirmed numeric scale) are excluded from the search trend, never counted', () => {
    const rows = [
      { report_date: '2026-01-01', source_type: 'apify_pinterest', metric_type: 'pinterest_rank', metric_value: 1 },
      { report_date: '2026-01-02', source_type: 'apify_pinterest', metric_type: 'pinterest_rank', metric_value: 1 },
      { report_date: '2026-01-03', source_type: 'apify_pinterest', metric_type: 'pinterest_rank', metric_value: 1 },
      { report_date: '2026-01-04', source_type: 'apify_pinterest', metric_type: 'pinterest_rank', metric_value: 1 }
    ];
    assert.equal(searchTrendDirection(rows), null, 'Pinterest-only history must never produce a search trend direction');
  });

  test('socialTrendDirection reads new_post_count, growing when recent days clearly outpace earlier ones', () => {
    const rows = [socialRow('2026-01-01', 1), socialRow('2026-01-02', 1), socialRow('2026-01-03', 1), socialRow('2026-01-04', 5), socialRow('2026-01-05', 5)];
    assert.equal(socialTrendDirection(rows), 'growing');
  });
});

describe('candidateLifecycleFor', () => {
  test('fewer than 3 observation days is always insufficient_history, regardless of any trend signal', () => {
    assert.equal(candidateLifecycleFor({ days: 1, searchDirection: 'growing', socialDirection: 'growing' }), 'insufficient_history');
    assert.equal(candidateLifecycleFor({ days: 2, searchDirection: 'declining', socialDirection: null }), 'insufficient_history');
  });

  test('3-6 observation days is always emerging, never growing/established/declining even with a clear trend signal', () => {
    assert.equal(candidateLifecycleFor({ days: 3, searchDirection: 'growing', socialDirection: null }), 'emerging');
    assert.equal(candidateLifecycleFor({ days: 6, searchDirection: 'declining', socialDirection: 'declining' }), 'emerging');
  });

  test('7+ days with a clear growing signal and no declining signal is growing', () => {
    assert.equal(candidateLifecycleFor({ days: 7, searchDirection: 'growing', socialDirection: null }), 'growing');
  });

  test('7+ days with a clear declining signal and no growing signal is declining', () => {
    assert.equal(candidateLifecycleFor({ days: 10, searchDirection: null, socialDirection: 'declining' }), 'declining');
  });

  test('7+ days with no directional signal at all is established -- the honest default, not a forced claim', () => {
    assert.equal(candidateLifecycleFor({ days: 7, searchDirection: null, socialDirection: null }), 'established');
    assert.equal(candidateLifecycleFor({ days: 20, searchDirection: 'established', socialDirection: 'established' }), 'established');
  });

  test('conflicting signals (one growing, one declining) resolve to established rather than guessing', () => {
    assert.equal(candidateLifecycleFor({ days: 10, searchDirection: 'growing', socialDirection: 'declining' }), 'established');
  });
});

describe('urgencyNote', () => {
  test('growing and declining both get a note mentioning the configurable lead-time assumption, never a precise date', () => {
    const growing = urgencyNote('growing');
    const declining = urgencyNote('declining');
    assert.ok(growing.includes(String(EXECUTION_LEAD_TIME_DAYS)));
    assert.ok(declining.includes(String(EXECUTION_LEAD_TIME_DAYS)));
    assert.ok(growing.toLowerCase().includes('assumption'));
    assert.ok(!/\b\d{4}-\d{2}-\d{2}\b/.test(growing), 'must never state a precise calendar date');
  });

  test('established/emerging/insufficient_history get no urgency note at all', () => {
    assert.equal(urgencyNote('established'), null);
    assert.equal(urgencyNote('emerging'), null);
    assert.equal(urgencyNote('insufficient_history'), null);
  });
});
