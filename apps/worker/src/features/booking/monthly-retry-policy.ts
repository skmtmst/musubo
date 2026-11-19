/** 初回失敗から3・5・7日後に最大3回再試行する。結果不明は再送しない。 */
export function monthlyRetryDecision(input: {
  firstFailedAt: string;
  attemptNo: number;
  outcome: 'failed' | 'authentication_required_unpaid' | 'succeeded' | 'unknown';
}): { action: 'retry'; attemptNo: number; scheduledAt: string } | { action: 'stop' | 'paid' | 'review' } {
  if (!Number.isInteger(input.attemptNo) || input.attemptNo < 0 || input.attemptNo > 3) throw new Error('invalid_attempt');
  const failedAt = Date.parse(input.firstFailedAt);
  if (!Number.isFinite(failedAt)) throw new Error('invalid_failed_at');
  if (input.outcome === 'succeeded') return { action: 'paid' };
  if (input.outcome === 'unknown') return { action: 'review' };
  if (input.attemptNo === 3) return { action: 'stop' };
  const attemptNo = input.attemptNo + 1;
  const days = [0, 3, 5, 7][attemptNo]!;
  return { action: 'retry', attemptNo, scheduledAt: new Date(failedAt + days * 86400000).toISOString() };
}
