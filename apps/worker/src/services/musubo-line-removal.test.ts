import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_MUSUBO_PRICE_SCHEDULE, jstDateOffset } from '@line-crm/shared';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import type { WorkerBindings } from '../worker-bindings.js';
import { stripeApi, type StripeSubscription } from './stripe-api.js';
import { getMusuboLineRemoval, requestMusuboLineRemoval,
  sweepMusuboLineRemovals } from './musubo-line-removal.js';

afterEach(() => vi.restoreAllMocks());

function fixture(interval: 'month' | 'year') {
  const sqlite = createTestD1();
  const tenantId = DEFAULT_TENANT_ID;
  const nextMonth = jstDateOffset(28);
  const nextYear = jstDateOffset(360);
  sqlite.raw.prepare('UPDATE tenants SET stripe_customer_id=? WHERE id=?').run('cus_test', tenantId);
  const condition = { sourceConditionId: 'normal', sourceVersion: 1, internalName: '通常条件',
    appliedAt: jstDateOffset(-30), trialPeriod: { unit: 'days', value: 30 },
    lineBasicDiscountPercent: 0, schedule: DEFAULT_MUSUBO_PRICE_SCHEDULE };
  sqlite.raw.prepare(`INSERT INTO musubo_tenant_billing
    (tenant_id,pricing_snapshot_json,billing_interval,status,first_line_activated_at,
      first_charge_date,core_subscription_id,options_subscription_id,
      next_monthly_charge_at,next_annual_renewal_at,created_at,updated_at)
    VALUES (?,?,?,'active',? ,?,'sub_core','sub_options',?,?,?,?)`)
    .run(tenantId, JSON.stringify(condition), interval, jstDateOffset(-30), jstDateOffset(-1),
      nextMonth, nextYear, jstDateOffset(-30), jstDateOffset(-30));
  for (const id of ['line-one','line-two']) {
    sqlite.raw.prepare(`INSERT INTO line_accounts
      (id,channel_id,name,channel_access_token,channel_secret,tenant_id,is_active)
      VALUES (?,?,?,'token','secret',?,1)`).run(id, id, id, tenantId);
    sqlite.raw.prepare(`INSERT INTO musubo_line_usage
      (line_account_id,tenant_id,status,activated_at,friend_count_excluding_blocked,
        friend_count_measured_on,updated_at)
      VALUES (?,?,'active',?,2800,?,?)`)
      .run(id, tenantId, jstDateOffset(-30), jstDateOffset(-1), jstDateOffset(-1));
  }
  const prices = new Map([['sub_core', interval === 'year' ? 149040 : 13800], ['sub_options', 5500]]);
  const subscription = (id: string): StripeSubscription => ({
    id, status: 'active', customer: 'cus_test',
    metadata: { tenant_id: tenantId, purpose: id === 'sub_core' ? 'musubo_core' : 'musubo_options' },
    items: { data: [{ id: `si_${id}`, price: { id: `price_${id}`,
      product: id === 'sub_core' ? 'prod_core' : 'prod_options', unit_amount: prices.get(id),
      currency: 'jpy', recurring: { interval: id === 'sub_core' ? interval : 'month' } } }] },
  });
  vi.spyOn(stripeApi, 'retrieveSubscription').mockImplementation(async (_env, id) => subscription(id));
  const update = vi.spyOn(stripeApi, 'updateMusuboRecurringAmount').mockImplementation(async (_env, input) => {
    prices.set(input.subscriptionId, input.amountYen);
    return subscription(input.subscriptionId);
  });
  const env = { DB: sqlite.db, STRIPE_PRODUCT_MUSUBO_CORE: 'prod_core',
    STRIPE_PRODUCT_MUSUBO_OPTIONS: 'prod_options' } as WorkerBindings;
  return { sqlite, tenantId, nextMonth, nextYear, prices, update, env };
}

it('ends one of two LINE accounts immediately and lowers only the next recurring invoices', async () => {
  const setup = fixture('month');
  const now = new Date().toISOString();
  expect(await requestMusuboLineRemoval(setup.env, setup.tenantId, 'line-two', 'now', now))
    .toBe('ended');
  expect(setup.prices).toEqual(new Map([['sub_core', 5900], ['sub_options', 0]]));
  expect(setup.sqlite.raw.prepare('SELECT is_active FROM line_accounts WHERE id=?').get('line-two'))
    .toEqual({ is_active: 0 });
  expect(setup.sqlite.raw.prepare('SELECT status FROM musubo_line_usage WHERE line_account_id=?')
    .get('line-one')).toEqual({ status: 'active' });
  expect(setup.sqlite.raw.prepare('SELECT status FROM musubo_line_removals').get()).toEqual({ status: 'ended' });
});

it('keeps annual options until renewal while preparing the lower annual basic price', async () => {
  const setup = fixture('year');
  const now = new Date().toISOString();
  expect((await getMusuboLineRemoval(setup.env, setup.tenantId, 'line-two', now)).phase)
    .toBe('choose');
  expect(await requestMusuboLineRemoval(setup.env, setup.tenantId, 'line-two', 'schedule', now))
    .toBe('scheduled');
  expect(await requestMusuboLineRemoval(setup.env, setup.tenantId, 'line-two', 'schedule', now))
    .toBe('scheduled');
  expect(setup.prices).toEqual(new Map([['sub_core', 63720], ['sub_options', 5500]]));
  expect(setup.sqlite.raw.prepare('SELECT is_active FROM line_accounts WHERE id=?').get('line-two'))
    .toEqual({ is_active: 1 });
  setup.sqlite.raw.prepare('UPDATE musubo_tenant_billing SET next_monthly_charge_at=? WHERE tenant_id=?')
    .run(setup.nextYear, setup.tenantId);
  const { reconcileMusuboRecurringPrices } = await import('./musubo-recurring-prices.js');
  expect(await reconcileMusuboRecurringPrices(setup.env, setup.tenantId)).toBe(true);
  expect(setup.prices.get('sub_options')).toBe(0);
  expect(await sweepMusuboLineRemovals(setup.env, `${setup.nextYear}T00:00:01+09:00`))
    .toEqual({ attempted: 1, failed: 0 });
  expect(setup.sqlite.raw.prepare('SELECT status FROM musubo_line_removals').get())
    .toEqual({ status: 'ended' });
});

it('restores both prices when a scheduled removal is cancelled', async () => {
  const setup = fixture('month');
  const now = new Date().toISOString();
  expect(await requestMusuboLineRemoval(setup.env, setup.tenantId, 'line-two', 'schedule', now))
    .toBe('scheduled');
  expect(await requestMusuboLineRemoval(setup.env, setup.tenantId, 'line-two', 'cancel', now))
    .toBe('cancelled');
  expect(setup.prices).toEqual(new Map([['sub_core', 13800], ['sub_options', 5500]]));
  expect(setup.sqlite.raw.prepare('SELECT status FROM musubo_line_usage WHERE line_account_id=?')
    .get('line-two')).toEqual({ status: 'active' });
});
