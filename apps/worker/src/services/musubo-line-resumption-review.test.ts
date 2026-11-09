import { expect, it, vi } from 'vitest';
import { DEFAULT_MUSUBO_PRICE_SCHEDULE } from '@line-crm/shared';
import type { WorkerBindings } from '../worker-bindings.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import { acceptMusuboLineResumption, acceptedMusuboLineResumption,
  getMusuboLineResumptionReview } from './musubo-line-resumption-review.js';

const tenantId = DEFAULT_TENANT_ID;
vi.mock('./musubo-large-line-consultation.js', () => ({
  fetchPreConnectFollowerInsight: vi.fn(async () => ({ followers: 3000,
    friendsExcludingBlocked: 2800, measuredOn: '2027-01-24' })),
}));
const condition = JSON.stringify({ sourceConditionId: 'normal', sourceVersion: 1,
  internalName: '通常条件', appliedAt: '2026-11-09',
  trialPeriod: { unit: 'days', value: 30 }, lineBasicDiscountPercent: 0,
  discountEndsOn: null, schedule: DEFAULT_MUSUBO_PRICE_SCHEDULE });

function ended(interval: 'month' | 'year', firstChargeDate = '2026-12-09') {
  const fixture = createTestD1();
  fixture.raw.prepare(`INSERT INTO musubo_tenant_billing
    (tenant_id,pricing_snapshot_json,billing_interval,status,first_line_activated_at,
      trial_last_free_date,first_charge_date,core_subscription_id,options_subscription_id,
      ended_at,created_at,updated_at) VALUES (?,?,?,'ended','2026-11-09T00:00:00+09:00',
      '2026-12-08',?,'sub_core','sub_options','2027-01-20T00:00:00+09:00',
      '2026-11-09T00:00:00+09:00','2027-01-20T00:00:00+09:00')`)
    .run(tenantId, condition, interval, firstChargeDate);
  fixture.raw.prepare(`INSERT INTO line_accounts
    (id,channel_id,name,channel_access_token,channel_secret,tenant_id,is_active,archived_at)
    VALUES ('line-old','123456','旧LINE','token','secret',?,0,NULL)`).run(tenantId);
  fixture.raw.prepare(`INSERT INTO musubo_line_usage
    (line_account_id,tenant_id,status,activated_at,ended_at,updated_at)
    VALUES ('line-old',?,'ended','2026-11-09T00:00:00+09:00',
      '2027-01-20T00:00:00+09:00','2027-01-20T00:00:00+09:00')`).run(tenantId);
  return fixture;
}

function invoice(fixture: ReturnType<typeof ended>, input: { id: string; subscription: string;
  status: string; due: number; paid: number; start: string; end: string }) {
  fixture.raw.prepare(`INSERT INTO billing_invoices
    (id,tenant_id,subscription_id,status,amount_due,amount_paid,period_start,period_end,
      created_at,synced_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(input.id, tenantId, input.subscription, input.status, input.due, input.paid,
      input.start, input.end, input.start, input.start);
}

it('reuses the original trial deadline and never starts a second trial', async () => {
  const fixture = ended('month', '2026-12-09');
  const view = await getMusuboLineResumptionReview(fixture.db, tenantId,
    new Date('2026-11-20T00:00:00+09:00'));
  expect(view).toMatchObject({ kind: 'trial_remaining', nextChargeAt: '2026-12-09T00:00:00+09:00',
    nextLineBaseYen: 5_900, trialPeriodLabel: '30日間' });
});

it('recognizes the paid monthly remainder from the core invoice', async () => {
  const fixture = ended('month');
  invoice(fixture, { id: 'in_core', subscription: 'sub_core', status: 'paid', due: 5_900, paid: 5_900,
    start: '2027-01-09T00:00:00+09:00', end: '2027-02-09T00:00:00+09:00' });
  const view = await getMusuboLineResumptionReview(fixture.db, tenantId,
    new Date('2027-01-25T00:00:00+09:00'));
  expect(view).toMatchObject({ kind: 'monthly_paid', renewalAt: '2027-02-09T00:00:00+09:00',
    nextLineBaseYen: 5_900 });
});

it('recognizes the paid annual remainder without applying a new annual charge', async () => {
  const fixture = ended('year');
  invoice(fixture, { id: 'in_core', subscription: 'sub_core', status: 'paid', due: 63_720, paid: 63_720,
    start: '2026-12-09T00:00:00+09:00', end: '2027-12-09T00:00:00+09:00' });
  const view = await getMusuboLineResumptionReview(fixture.db, tenantId,
    new Date('2027-01-25T00:00:00+09:00'));
  expect(view).toMatchObject({ kind: 'annual_paid', renewalAt: '2027-12-09T00:00:00+09:00',
    nextAnnualLineBaseYen: 63_720 });
});

it('blocks resumption while either core or options has an unpaid invoice', async () => {
  const fixture = ended('month');
  invoice(fixture, { id: 'in_options', subscription: 'sub_options', status: 'open', due: 1_100, paid: 0,
    start: '2027-01-09T00:00:00+09:00', end: '2027-02-09T00:00:00+09:00' });
  const view = await getMusuboLineResumptionReview(fixture.db, tenantId,
    new Date('2027-01-25T00:00:00+09:00'));
  expect(view).toMatchObject({ kind: 'unpaid', amountDueYen: 1_100 });
});

it('does not infer paid coverage from a future date without a settled invoice', async () => {
  const fixture = ended('month');
  fixture.raw.prepare(`UPDATE musubo_tenant_billing SET next_monthly_charge_at='2027-02-09'
    WHERE tenant_id=?`).run(tenantId);
  await expect(getMusuboLineResumptionReview(fixture.db, tenantId,
    new Date('2027-01-25T00:00:00+09:00'))).rejects.toThrow('reconciled');
});

it('saves consent once and invalidates it when an invoice becomes unpaid', async () => {
  const fixture = ended('month');
  const now = new Date('2027-01-25T00:00:00+09:00');
  const env = { DB: fixture.db } as WorkerBindings;
  const accepted = await acceptMusuboLineResumption(env, tenantId, now);
  expect(accepted.kind).toBe('paid_expired');
  await acceptMusuboLineResumption(env, tenantId, now);
  expect((await acceptedMusuboLineResumption(env, tenantId, now)).generation).toBe(1);
  invoice(fixture, { id: 'in_late', subscription: 'sub_core', status: 'open', due: 5_900, paid: 0,
    start: '2027-01-09T00:00:00+09:00', end: '2027-02-09T00:00:00+09:00' });
  await expect(acceptedMusuboLineResumption(env, tenantId, now))
    .rejects.toThrow('changed');
});
