import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_MUSUBO_PRICE_SCHEDULE } from '@line-crm/shared';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import type { WorkerBindings } from '../worker-bindings.js';
import { stripeApi, type StripeSubscription } from './stripe-api.js';
import { getMusuboFinalLineEnd, requestMusuboFinalLineEnd,
  sweepMusuboFinalLineEnds } from './musubo-final-line-end.js';

afterEach(() => vi.restoreAllMocks());

function fixture(interval: 'month' | 'year' = 'month') {
  const sqlite = createTestD1();
  const tenantId = DEFAULT_TENANT_ID;
  sqlite.raw.prepare('UPDATE tenants SET stripe_customer_id=? WHERE id=?').run('cus_test', tenantId);
  const condition = { sourceConditionId: 'normal', sourceVersion: 1, internalName: '通常条件',
    appliedAt: '2026-11-09', trialPeriod: { unit: 'days', value: 30 },
    lineBasicDiscountPercent: 0, schedule: DEFAULT_MUSUBO_PRICE_SCHEDULE };
  sqlite.raw.prepare(`INSERT INTO musubo_tenant_billing
    (tenant_id,pricing_snapshot_json,billing_interval,status,first_line_activated_at,
      first_charge_date,core_subscription_id,options_subscription_id,
      next_monthly_charge_at,next_annual_renewal_at,created_at,updated_at)
    VALUES (?,?,?,'active','2026-11-09','2026-12-09','sub_core','sub_options',
      '2027-02-09','2027-12-09','2026-11-09','2026-11-09')`)
    .run(tenantId, JSON.stringify(condition), interval);
  sqlite.raw.prepare(`INSERT INTO line_accounts
    (id,channel_id,name,channel_access_token,channel_secret,tenant_id,is_active)
    VALUES ('line-one','line-one','店舗LINE','token','secret',?,1)`).run(tenantId);
  sqlite.raw.prepare(`INSERT INTO musubo_line_usage
    (line_account_id,tenant_id,status,updated_at) VALUES ('line-one',?,'active','2026-11-09')`)
    .run(tenantId);
  const subscriptions = new Map<string, StripeSubscription>();
  for (const purpose of ['core', 'options'] as const) {
    const id = `sub_${purpose}`;
    subscriptions.set(id, { id, status: 'active', customer: 'cus_test',
      metadata: { tenant_id: tenantId, purpose: `musubo_${purpose}` },
      items: { data: [{ price: { id: `price_${purpose}` } }] } });
  }
  vi.spyOn(stripeApi, 'retrieveSubscription').mockImplementation(async (_env, id) => subscriptions.get(id)!);
  const schedule = vi.spyOn(stripeApi, 'scheduleMusuboTermination').mockImplementation(async (_env, id, epoch) => {
    const value = { ...subscriptions.get(id)!, cancel_at: epoch };
    subscriptions.set(id, value);
    return value;
  });
  const undo = vi.spyOn(stripeApi, 'undoMusuboTermination').mockImplementation(async (_env, id) => {
    const value = { ...subscriptions.get(id)!, cancel_at: null, cancel_at_period_end: false };
    subscriptions.set(id, value);
    return value;
  });
  const cancel = vi.spyOn(stripeApi, 'cancelMusuboSubscription').mockImplementation(async (_env, id) => {
    const value = { ...subscriptions.get(id)!, status: 'canceled' };
    subscriptions.set(id, value);
    return value;
  });
  return { sqlite, tenantId, env: { DB: sqlite.db } as WorkerBindings, schedule, undo, cancel };
}

it('schedules both contracts at the next monthly charge and allows undo before the end', async () => {
  const setup = fixture();
  const now = '2027-01-09T00:00:00.000Z';
  expect(await requestMusuboFinalLineEnd(setup.env, setup.tenantId, 'schedule', now)).toBe('scheduled');
  const view = await getMusuboFinalLineEnd(setup.env, setup.tenantId, now);
  expect(view.scheduledEndAt).toBe('2027-02-08T15:00:00.000Z');
  expect(setup.schedule).toHaveBeenCalledTimes(2);
  expect(setup.sqlite.raw.prepare('SELECT is_active FROM line_accounts WHERE id=?').get('line-one'))
    .toMatchObject({ is_active: 1 });
  expect(setup.sqlite.raw.prepare(`SELECT event,snapshot_json FROM musubo_final_line_notices
    WHERE tenant_id=? AND event='scheduled'`).get(setup.tenantId))
    .toMatchObject({ event: 'scheduled' });
  expect(await requestMusuboFinalLineEnd(setup.env, setup.tenantId, 'cancel', now)).toBe('choose');
  expect(setup.undo).toHaveBeenCalledTimes(2);
  expect(setup.sqlite.raw.prepare('SELECT termination_effective_at FROM musubo_tenant_billing WHERE tenant_id=?')
    .get(setup.tenantId)).toMatchObject({ termination_effective_at: null });
  expect(setup.sqlite.raw.prepare(`SELECT COUNT(*) AS count FROM musubo_final_line_notices
    WHERE tenant_id=? AND event='cancelled'`).get(setup.tenantId)).toMatchObject({ count: 1 });
});

it('stops the final LINE immediately and cancels both contracts without a new invoice', async () => {
  const setup = fixture('year');
  const now = '2027-01-09T00:00:00.000Z';
  expect(await requestMusuboFinalLineEnd(setup.env, setup.tenantId, 'now', now)).toBe('ended');
  expect(setup.cancel).toHaveBeenCalledTimes(2);
  expect(setup.sqlite.raw.prepare('SELECT status FROM musubo_tenant_billing WHERE tenant_id=?')
    .get(setup.tenantId)).toMatchObject({ status: 'ended' });
  expect(setup.sqlite.raw.prepare('SELECT is_active FROM line_accounts WHERE id=?').get('line-one'))
    .toMatchObject({ is_active: 0 });
  expect(setup.sqlite.raw.prepare(`SELECT COUNT(*) AS count FROM musubo_final_line_notices
    WHERE tenant_id=? AND event='immediate'`).get(setup.tenantId)).toMatchObject({ count: 1 });
});

it('keeps the annual contract and monthly options until the annual renewal, then ends both', async () => {
  const setup = fixture('year');
  const now = '2027-01-09T00:00:00.000Z';
  expect(await requestMusuboFinalLineEnd(setup.env, setup.tenantId, 'schedule', now)).toBe('scheduled');
  const annualEnd = Math.floor(Date.parse('2027-12-08T15:00:00.000Z') / 1000);
  expect(setup.schedule.mock.calls.map((call) => call[2])).toEqual([annualEnd, annualEnd]);
  expect(await sweepMusuboFinalLineEnds(setup.env, '2027-02-09T00:00:00.000Z'))
    .toEqual({ processed: 0, failed: 0 });
  expect(setup.sqlite.raw.prepare('SELECT is_active FROM line_accounts WHERE id=?').get('line-one'))
    .toMatchObject({ is_active: 1 });
  expect(await sweepMusuboFinalLineEnds(setup.env, '2027-12-08T15:00:00.000Z'))
    .toEqual({ processed: 1, failed: 0 });
  expect(setup.cancel).toHaveBeenCalledTimes(2);
});

it('allows immediate termination while an earlier invoice remains unpaid', async () => {
  const setup = fixture();
  setup.sqlite.raw.prepare(`UPDATE musubo_tenant_billing SET status='past_due',next_monthly_charge_at=NULL
    WHERE tenant_id=?`).run(setup.tenantId);
  const now = '2027-01-09T00:00:00.000Z';
  expect((await getMusuboFinalLineEnd(setup.env, setup.tenantId, now)).defaultEndAt).toBeNull();
  expect(await requestMusuboFinalLineEnd(setup.env, setup.tenantId, 'now', now)).toBe('ended');
});

it('does not end the only active LINE while a paid addition is awaiting activation', async () => {
  const setup = fixture();
  setup.sqlite.raw.prepare(`INSERT INTO musubo_pending_additions
    (id,tenant_id,kind,status,amount_due_yen,price_snapshot_json,expires_at,created_at,updated_at)
    VALUES ('addition-1',?,'line','paid',0,'{}','2027-02-01','2027-01-01','2027-01-01')`)
    .run(setup.tenantId);
  await expect(requestMusuboFinalLineEnd(setup.env, setup.tenantId, 'now',
    '2027-01-09T00:00:00.000Z')).rejects.toThrow('PENDING_ADDITION');
  expect(setup.cancel).not.toHaveBeenCalled();
});

it('recovers a partial Stripe failure from the saved intent without reactivating a canceled contract', async () => {
  const setup = fixture();
  const now = '2027-01-09T00:00:00.000Z';
  setup.cancel.mockRejectedValueOnce(new Error('Stripe unavailable'));
  await expect(requestMusuboFinalLineEnd(setup.env, setup.tenantId, 'now', now)).rejects.toThrow();
  expect(setup.sqlite.raw.prepare(`SELECT COUNT(*) AS count FROM musubo_final_line_notices
    WHERE tenant_id=?`).get(setup.tenantId)).toMatchObject({ count: 0 });
  expect(setup.sqlite.raw.prepare('SELECT is_active FROM line_accounts WHERE id=?').get('line-one'))
    .toMatchObject({ is_active: 0 });
  expect(await sweepMusuboFinalLineEnds(setup.env, now)).toEqual({ processed: 1, failed: 0 });
  expect(setup.sqlite.raw.prepare('SELECT status FROM musubo_tenant_billing WHERE tenant_id=?')
    .get(setup.tenantId)).toMatchObject({ status: 'ended' });
  expect(setup.sqlite.raw.prepare(`SELECT COUNT(*) AS count FROM musubo_final_line_notices
    WHERE tenant_id=? AND event='immediate'`).get(setup.tenantId)).toMatchObject({ count: 1 });
});
