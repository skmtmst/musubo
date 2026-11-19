import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { activateMonthly, monthlyContract, monthlyCycle, monthlyFixture, monthlyNow } from '../../test-utils/monthly-ledger.js';
import { stopExhaustedMonthlyCycle } from './monthly-exhausted.js';

const opened: ReturnType<typeof monthlyFixture>[] = [];
afterEach(() => { for (const d of opened.splice(0)) d.raw.close(); });
it('最後の確定失敗だけで停止し、本人と店の通知予約を一度だけ残す', async () => {
  const d = monthlyFixture(); opened.push(d);
  d.raw.exec(readFileSync(new URL('../../../../../packages/db/migrations/772_monthly_failure_notices.sql',import.meta.url),'utf8'));
  await monthlyContract(d); monthlyCycle(d,{id:'initial',month:'2026-10',paid:true}); activateMonthly(d);
  monthlyCycle(d,{id:'renewal',kind:'renewal'});
  expect(await stopExhaustedMonthlyCycle(d.db,'renewal',new Date(monthlyNow))).toEqual({stopped:false});
  const dates = ['2026-11-10','2026-11-13','2026-11-15','2026-11-17'];
  for (let n=0;n<4;n++) {
    if (n===1) d.raw.prepare("UPDATE booking_monthly_cycles SET first_failed_at=?,state='retry_wait',version=version+1 WHERE id='renewal'").run(monthlyNow);
    d.raw.prepare(`INSERT INTO booking_monthly_attempts(cycle_id,tenant_id,account_id,attempt_no,scheduled_at,payment_method_id,payment_method_version,request_key,state)
      VALUES('renewal','t','a',?,?,'pm_original',1,?,'pending')`).run(n,`${dates[n]}T00:00:00.000Z`,`key-${n}`);
    d.raw.prepare("UPDATE booking_monthly_attempts SET state='failed',finished_at=?,version=version+1 WHERE cycle_id='renewal' AND attempt_no=?").run(`${dates[n]}T00:00:00.000Z`,n);
  }
  const now = new Date('2026-11-17T00:00:00Z');
  expect(await stopExhaustedMonthlyCycle(d.db,'renewal',now)).toEqual({stopped:true});
  expect(await stopExhaustedMonthlyCycle(d.db,'renewal',now)).toEqual({stopped:false});
  expect(d.raw.prepare("SELECT state,stop_reason FROM booking_monthly_contracts WHERE id='contract'").get()).toEqual({state:'stopped',stop_reason:'unpaid'});
  expect(d.raw.prepare("SELECT audience FROM booking_monthly_failure_notices ORDER BY audience").all()).toEqual([{audience:'friend'},{audience:'store'}]);
});
