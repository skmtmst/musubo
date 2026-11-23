import { monthlyRetryDecision } from './monthly-retry-policy.js';

/** 確定した失敗だけを台帳から読み、次の試行を同じ請求に一度だけ積む。 */
export async function scheduleMonthlyRetry(db: D1Database, cycleId: string, attemptNo: number, now = new Date()) {
  const row = await db.prepare(`SELECT y.first_failed_at,y.state,a.state attempt_state,a.finished_at
    FROM booking_monthly_cycles y JOIN booking_monthly_attempts a ON a.cycle_id=y.id
    WHERE y.id=? AND a.attempt_no=?`).bind(cycleId, attemptNo)
    .first<{first_failed_at:string|null;state:string;attempt_state:string;finished_at:string|null}>();
  if (!row || row.attempt_state !== 'failed' || !row.finished_at || !['open','retry_wait','requires_action'].includes(row.state)) return { status: 'unavailable' as const };
  const firstFailedAt = row.first_failed_at ?? (attemptNo === 0 ? row.finished_at : null);
  if (!firstFailedAt) return { status: 'unavailable' as const };
  const decision = monthlyRetryDecision({ firstFailedAt, attemptNo, outcome: 'failed' });
  if (decision.action !== 'retry') return { status: 'exhausted' as const };
  const at = now.toISOString();
  const results = await db.batch([
    db.prepare(`UPDATE booking_monthly_cycles SET first_failed_at=COALESCE(first_failed_at,?),state='retry_wait',version=version+1,updated_at=?
      WHERE id=? AND state IN ('open','retry_wait','requires_action') AND (first_failed_at IS NULL OR first_failed_at=?)
      AND EXISTS(SELECT 1 FROM booking_monthly_attempts WHERE cycle_id=? AND attempt_no=? AND state='failed' AND finished_at=?)
      AND NOT EXISTS(SELECT 1 FROM booking_monthly_attempts WHERE cycle_id=? AND attempt_no=?)`)
      .bind(firstFailedAt,at,cycleId,firstFailedAt,cycleId,attemptNo,row.finished_at,cycleId,decision.attemptNo),
    db.prepare(`INSERT INTO booking_monthly_attempts(cycle_id,tenant_id,account_id,attempt_no,scheduled_at,payment_method_id,payment_method_version,request_key,state)
      SELECT y.id,y.tenant_id,y.account_id,?,?,c.payment_method_id,c.payment_method_version,?,'pending'
      FROM booking_monthly_cycles y JOIN booking_monthly_contracts c ON c.id=y.contract_id
      WHERE y.id=? AND changes()=1`).bind(decision.attemptNo,decision.scheduledAt,`monthly-attempt:${cycleId}:${decision.attemptNo}`,cycleId),
  ]);
  return { status: results[1]?.meta.changes === 1 ? 'scheduled' as const : 'unavailable' as const };
}
