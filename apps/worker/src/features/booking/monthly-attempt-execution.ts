import { scheduleMonthlyRetry } from './monthly-retry-ledger.js';

export interface MonthlyAttemptProvider {
  pay(input: { invoiceId: string; account: string; paymentMethod: string; idempotencyKey: string }): Promise<'failed' | 'processing' | 'unknown'>;
}

/** 予定時刻を過ぎた試行のみ確保。外部結果が不明なら再送しない。 */
export async function executeMonthlyAttempt(db: D1Database, cycleId: string, attemptNo: number, provider: MonthlyAttemptProvider, now = new Date()) {
  const at = now.toISOString();
  const row = await db.prepare(`SELECT a.payment_method_id,a.request_key,y.invoice_id,y.connected_account
    FROM booking_monthly_attempts a JOIN booking_monthly_cycles y ON y.id=a.cycle_id
    JOIN booking_monthly_contracts c ON c.id=y.contract_id
    JOIN line_accounts l ON l.id=c.account_id AND l.tenant_id=c.tenant_id JOIN tenants t ON t.id=c.tenant_id
    WHERE a.cycle_id=? AND a.attempt_no=? AND a.state='pending' AND julianday(a.scheduled_at)<=julianday(?)
    AND y.state IN('open','retry_wait','requires_action') AND y.invoice_status='open' AND y.test_mode=1 AND c.test_mode=1
    AND c.state IN('applying','active','stop_scheduled') AND c.service_state='enabled'
    AND c.payment_method_id=a.payment_method_id AND c.payment_method_version=a.payment_method_version
    AND (c.stop_effective_at IS NULL OR julianday(c.stop_effective_at)>julianday(?))
    AND l.is_active=1 AND l.archived_at IS NULL AND t.status='active'`).bind(cycleId,attemptNo,at,at)
    .first<{payment_method_id:string;request_key:string;invoice_id:string;connected_account:string}>();
  if (!row) return { status: 'unavailable' as const };
  const claim = await db.prepare(`UPDATE booking_monthly_attempts SET state='running',started_at=?,version=version+1
    WHERE cycle_id=? AND attempt_no=? AND state='pending' AND julianday(scheduled_at)<=julianday(?)
    AND EXISTS(SELECT 1 FROM booking_monthly_cycles y JOIN booking_monthly_contracts c ON c.id=y.contract_id
      JOIN line_accounts l ON l.id=c.account_id AND l.tenant_id=c.tenant_id JOIN tenants t ON t.id=c.tenant_id
      WHERE y.id=booking_monthly_attempts.cycle_id AND y.state IN('open','retry_wait','requires_action') AND y.invoice_status='open'
      AND y.test_mode=1 AND c.test_mode=1 AND c.state IN('applying','active','stop_scheduled') AND c.service_state='enabled'
      AND c.payment_method_id=booking_monthly_attempts.payment_method_id AND c.payment_method_version=booking_monthly_attempts.payment_method_version
      AND (c.stop_effective_at IS NULL OR julianday(c.stop_effective_at)>julianday(?)) AND l.is_active=1 AND l.archived_at IS NULL AND t.status='active')`)
    .bind(at,cycleId,attemptNo,at,at).run();
  if (claim.meta.changes !== 1) return { status: 'unavailable' as const };
  let outcome: 'failed' | 'processing' | 'unknown' = 'unknown';
  try { outcome = await provider.pay({ invoiceId: row.invoice_id, account: row.connected_account,
    paymentMethod: row.payment_method_id, idempotencyKey: row.request_key }); } catch { /* 結果不明は照合へ */ }
  if (!['failed','processing','unknown'].includes(outcome)) outcome = 'unknown';
  const saved = await db.prepare(`UPDATE booking_monthly_attempts SET state=?,finished_at=?,version=version+1
    WHERE cycle_id=? AND attempt_no=? AND state='running'`).bind(outcome,at,cycleId,attemptNo).run();
  if (saved.meta.changes !== 1) return { status: 'unknown' as const };
  if (outcome === 'failed') await scheduleMonthlyRetry(db,cycleId,attemptNo,now);
  return { status: outcome };
}
