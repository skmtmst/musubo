import { expect, it } from 'vitest';
import { monthlyRetryDecision } from './monthly-retry-policy.js';

it('初回失敗を基点に3・5・7日後に再試行し、最後の失敗で止める', () => {
  const firstFailedAt = '2026-11-01T00:00:00.000Z';
  for (const [attemptNo, date] of [[0, '2026-11-04'], [1, '2026-11-06'], [2, '2026-11-08']] as const) {
    expect(monthlyRetryDecision({ firstFailedAt, attemptNo, outcome: 'failed' }))
      .toEqual({ action: 'retry', attemptNo: attemptNo + 1, scheduledAt: `${date}T00:00:00.000Z` });
  }
  expect(monthlyRetryDecision({ firstFailedAt, attemptNo: 3, outcome: 'failed' })).toEqual({ action: 'stop' });
});
it('結果不明は確認に回し、追加認証で未入金確定なら失敗として扱う', () => {
  const firstFailedAt = '2026-11-01T00:00:00.000Z';
  expect(monthlyRetryDecision({ firstFailedAt, attemptNo: 3, outcome: 'unknown' })).toEqual({ action: 'review' });
  expect(monthlyRetryDecision({ firstFailedAt, attemptNo: 3, outcome: 'authentication_required_unpaid' })).toEqual({ action: 'stop' });
  expect(monthlyRetryDecision({ firstFailedAt, attemptNo: 3, outcome: 'succeeded' })).toEqual({ action: 'paid' });
  expect(() => monthlyRetryDecision({ firstFailedAt, attemptNo: 4, outcome: 'failed' })).toThrow();
});
