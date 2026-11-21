import type { Env } from '../../worker-env.js';
import { executeMonthlyAttempt } from './monthly-attempt-execution.js';
import { scheduleMonthlyRetry } from './monthly-retry-ledger.js';
import { stopExhaustedMonthlyCycle } from './monthly-exhausted.js';

/** 確定失敗の模擬は検証先に限定し、2つの設定を明示した時だけ実行する。 */
export async function runMonthlyAttemptMockCron(env: Env['Bindings'], now: Date) {
  if (env.DEPLOY_ENV !== 'staging' || env.MONTHLY_INVOICE_MOCK_CRON_ENABLED !== 'true' || env.MONTHLY_PAYMENT_MOCK_FAILURE_ENABLED !== 'true') return { enabled: false };
  const db = env.DB, at = now.toISOString();
  const filter = `y.test_mode=1 AND y.invoice_id GLOB 'in_mock_*' AND c.test_mode=1
    AND c.state IN ('applying','active','stop_scheduled') AND c.service_state='enabled'
    AND EXISTS(SELECT 1 FROM account_settings s, json_each(CASE WHEN json_valid(s.value)
      THEN CASE WHEN json_type(s.value)='array' THEN s.value ELSE '[]' END ELSE '[]' END) j
      WHERE s.line_account_id=c.account_id AND s.key='test_recipients' AND j.value=c.friend_id)`;
  const first = (await db.prepare(`SELECT y.id FROM booking_monthly_cycles y JOIN booking_monthly_contracts c ON c.id=y.contract_id
    WHERE ${filter} AND y.state='open' AND y.invoice_status='open' AND julianday(y.due_at)<=julianday(?)
    AND c.payment_method_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM booking_monthly_attempts a WHERE a.cycle_id=y.id)
    ORDER BY y.due_at,y.id LIMIT 100`).bind(at).all<{id:string}>()).results;
  for (const row of first) await db.prepare(`INSERT INTO booking_monthly_attempts(cycle_id,tenant_id,account_id,attempt_no,scheduled_at,payment_method_id,payment_method_version,request_key,state)
    SELECT y.id,y.tenant_id,y.account_id,0,y.due_at,c.payment_method_id,c.payment_method_version,'monthly-attempt:'||y.id||':0','pending'
    FROM booking_monthly_cycles y JOIN booking_monthly_contracts c ON c.id=y.contract_id
    WHERE y.id=? AND ${filter} AND y.state='open' AND y.invoice_status='open' AND julianday(y.due_at)<=julianday(?)
    AND c.payment_method_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM booking_monthly_attempts a WHERE a.cycle_id=y.id)
    ON CONFLICT(cycle_id,attempt_no) DO NOTHING`).bind(row.id,at).run();
  const failed = (await db.prepare(`SELECT a.cycle_id,a.attempt_no FROM booking_monthly_attempts a
    JOIN booking_monthly_cycles y ON y.id=a.cycle_id JOIN booking_monthly_contracts c ON c.id=y.contract_id
    WHERE ${filter} AND a.state='failed' AND a.attempt_no<3
    AND NOT EXISTS(SELECT 1 FROM booking_monthly_attempts n WHERE n.cycle_id=a.cycle_id AND n.attempt_no=a.attempt_no+1)
    ORDER BY a.finished_at,a.cycle_id LIMIT 100`).all<{cycle_id:string;attempt_no:number}>()).results;
  for (const row of failed) await scheduleMonthlyRetry(db,row.cycle_id,row.attempt_no,now);
  const due = (await db.prepare(`SELECT a.cycle_id,a.attempt_no FROM booking_monthly_attempts a
    JOIN booking_monthly_cycles y ON y.id=a.cycle_id JOIN booking_monthly_contracts c ON c.id=y.contract_id
    WHERE ${filter} AND a.state='pending' AND julianday(a.scheduled_at)<=julianday(?)
    ORDER BY a.scheduled_at,a.cycle_id LIMIT 100`).bind(at).all<{cycle_id:string;attempt_no:number}>()).results;
  for (const row of due) await executeMonthlyAttempt(db,row.cycle_id,row.attempt_no,{pay:async()=> 'failed'},now);
  const exhausted = (await db.prepare(`SELECT y.id FROM booking_monthly_cycles y JOIN booking_monthly_contracts c ON c.id=y.contract_id
    JOIN booking_monthly_attempts a ON a.cycle_id=y.id AND a.attempt_no=3 AND a.state='failed'
    WHERE ${filter} AND y.state IN ('open','retry_wait','requires_action') ORDER BY a.finished_at,y.id LIMIT 100`)
    .all<{id:string}>()).results;
  for (const row of exhausted) await stopExhaustedMonthlyCycle(db,row.id,now);
  return { enabled: true, attempted: due.length };
}
