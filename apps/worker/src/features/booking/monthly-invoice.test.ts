import { afterEach, expect, it, vi } from 'vitest';
import { activateMonthly, monthlyContract, monthlyCycle, monthlyFixture, monthlyNow } from '../../test-utils/monthly-ledger.js';
import { createMonthlyInvoice } from './monthly-invoice.js';
import { dispatchMonthlyInvoices } from './monthly-invoice-dispatch.js';

const opened: ReturnType<typeof monthlyFixture>[] = [];
afterEach(() => { for (const d of opened.splice(0)) d.raw.close(); });
async function fixture() {
  const d = monthlyFixture(); opened.push(d);
  await monthlyContract(d); monthlyCycle(d, { month: '2026-10', paid: true }); activateMonthly(d);
  d.raw.exec(`INSERT INTO booking_monthly_cycles(id,contract_id,tenant_id,account_id,connected_account,month_key,kind,due_at,period_start,service_start,service_end,amount,created_at,updated_at)
    VALUES('next','contract','t','a','acct_original','2026-11','renewal','2026-10-31T15:00:00Z','2026-10-31T15:00:00Z','2026-10-31T15:00:00Z','2026-11-30T15:00:00Z',6000,'${monthlyNow}','${monthlyNow}')`);
  return d;
}
it('同時実行でも請求は一度だけ作る', async () => {
  const d = await fixture();
  const create = vi.fn(async () => ({ id: 'in_test', livemode: false, autoAdvance: false, status: 'open' as const }));
  await Promise.all([createMonthlyInvoice(d.db, 'next', { create }, new Date(monthlyNow)), createMonthlyInvoice(d.db, 'next', { create }, new Date(monthlyNow))]);
  expect(create).toHaveBeenCalledOnce();
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ amount: 6000, idempotencyKey: 'monthly-invoice:next' }));
  expect(d.raw.prepare("SELECT state,invoice_id,auto_advance FROM booking_monthly_cycles WHERE id='next'").get())
    .toEqual({ state: 'open', invoice_id: 'in_test', auto_advance: 0 });
});
it('結果不明や本番応答では自動で再請求しない', async () => {
  const d = await fixture();
  const create = vi.fn(async () => ({ id: 'in_live', livemode: true, autoAdvance: false, status: 'open' as const }));
  expect((await createMonthlyInvoice(d.db, 'next', { create }, new Date(monthlyNow))).status).toBe('unknown');
  expect((await createMonthlyInvoice(d.db, 'next', { create }, new Date(monthlyNow))).status).toBe('unavailable');
  expect(create).toHaveBeenCalledOnce();
});
it('期限になった予定だけを試験の請求口に渡す', async () => {
  const d = await fixture();
  const create = vi.fn(async () => ({ id: 'in_test', livemode: false, autoAdvance: false, status: 'open' as const }));
  expect(await dispatchMonthlyInvoices(d.db, { create }, new Date('2026-10-31T14:59:00Z'))).toEqual({ created: 0, unknown: 0 });
  expect(await dispatchMonthlyInvoices(d.db, { create }, new Date(monthlyNow))).toEqual({ created: 1, unknown: 0 });
  expect(await dispatchMonthlyInvoices(d.db, { create }, new Date(monthlyNow))).toEqual({ created: 0, unknown: 0 });
  expect(create).toHaveBeenCalledOnce();
});
