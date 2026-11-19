import { afterEach, expect, it } from 'vitest';
import { activateMonthly, monthlyContract, monthlyCycle, monthlyFixture, monthlyNow } from '../../test-utils/monthly-ledger.js';
import { scheduleMonthlyRetry } from './monthly-retry-ledger.js';

const opened: ReturnType<typeof monthlyFixture>[] = [];
afterEach(() => { for (const d of opened.splice(0)) d.raw.close(); });
it('確定した失敗から同じ請求の次の試行を一度だけ記録する', async () => {
  const d = monthlyFixture(); opened.push(d);
  await monthlyContract(d); monthlyCycle(d, { id: 'initial', month: '2026-10', paid: true }); activateMonthly(d);
  monthlyCycle(d, { id: 'renewal', kind: 'renewal' });
  d.raw.prepare(`INSERT INTO booking_monthly_attempts(cycle_id,tenant_id,account_id,attempt_no,scheduled_at,payment_method_id,payment_method_version,request_key,state)
    VALUES('renewal','t','a',0,?,'pm_original',1,'attempt-0','pending')`).run(monthlyNow);
  expect(await scheduleMonthlyRetry(d.db,'renewal',0,new Date(monthlyNow))).toEqual({ status: 'unavailable' });
  d.raw.prepare("UPDATE booking_monthly_attempts SET state='failed',finished_at=?,version=version+1 WHERE cycle_id='renewal' AND attempt_no=0").run(monthlyNow);
  const results = await Promise.all([scheduleMonthlyRetry(d.db,'renewal',0,new Date(monthlyNow)),scheduleMonthlyRetry(d.db,'renewal',0,new Date(monthlyNow))]);
  expect(results.filter(r => r.status === 'scheduled')).toHaveLength(1);
  expect(d.raw.prepare("SELECT attempt_no,scheduled_at,state FROM booking_monthly_attempts WHERE cycle_id='renewal' AND attempt_no=1").get())
    .toEqual({ attempt_no: 1, scheduled_at: '2026-11-13T00:00:00.000Z', state: 'pending' });
});
