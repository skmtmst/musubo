import { afterEach, expect, it } from 'vitest';
import { activateMonthly, monthlyContract, monthlyCycle, monthlyFixture } from '../../test-utils/monthly-ledger.js';
import { scheduleMonthlyRenewals } from './monthly-schedule.js';

const opened: ReturnType<typeof monthlyFixture>[] = [];
afterEach(() => { for (const d of opened.splice(0)) d.raw.close(); });
it('店の1日に一度だけ当月の請求予定を記録する', async () => {
  const d = monthlyFixture(); opened.push(d);
  await monthlyContract(d); monthlyCycle(d, { month: '2026-10', paid: true }); activateMonthly(d);
  expect(await scheduleMonthlyRenewals(d.db, new Date('2026-10-31T14:59:00Z'))).toEqual({ scheduled: 0 });
  expect(await scheduleMonthlyRenewals(d.db, new Date('2026-10-31T15:00:00Z'))).toEqual({ scheduled: 1 });
  expect(await scheduleMonthlyRenewals(d.db, new Date('2026-10-31T15:01:00Z'))).toEqual({ scheduled: 0 });
  expect(d.raw.prepare("SELECT state,due_at,service_end,amount FROM booking_monthly_cycles WHERE month_key='2026-11'").get())
    .toEqual({ state: 'planned', due_at: '2026-10-31T15:00:00.000Z', service_end: '2026-11-30T15:00:00.000Z', amount: 6000 });
});
