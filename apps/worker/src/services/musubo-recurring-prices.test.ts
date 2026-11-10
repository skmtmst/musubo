import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_MUSUBO_PRICE_SCHEDULE, jstDateOffset } from '@line-crm/shared';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import type { WorkerBindings } from '../worker-bindings.js';
import { stripeApi, type StripeSubscription } from './stripe-api.js';
import { reconcileMusuboRecurringPrices } from './musubo-recurring-prices.js';

afterEach(() => vi.restoreAllMocks());

it('restores the full LINE basic price after a temporary discount without changing options', async () => {
  const fixture = createTestD1();
  const tenantId = DEFAULT_TENANT_ID;
  fixture.raw.prepare('UPDATE tenants SET stripe_customer_id=? WHERE id=?').run('cus_test', tenantId);
  const condition = { sourceConditionId: 'special', sourceVersion: 1, internalName: '特別条件',
    appliedAt: '2026-11-09', trialPeriod: { unit: 'days', value: 30 },
    lineBasicDiscountPercent: 50, discountEndsOn: '2027-01-31', schedule: DEFAULT_MUSUBO_PRICE_SCHEDULE };
  fixture.raw.prepare(`INSERT INTO musubo_tenant_billing
    (tenant_id,pricing_snapshot_json,billing_interval,status,first_line_activated_at,
      first_charge_date,core_subscription_id,options_subscription_id,next_monthly_charge_at,created_at,updated_at)
    VALUES (?,?,'month','active','2026-11-09','2026-12-09','sub_core','sub_options',
      '2027-02-09','2026-11-09','2026-11-09')`).run(tenantId, JSON.stringify(condition));
  fixture.raw.prepare(`INSERT INTO line_accounts
    (id,channel_id,name,channel_access_token,channel_secret,tenant_id,is_active)
    VALUES ('line-one','line-one','LINE','token','secret',?,1)`).run(tenantId);
  fixture.raw.prepare(`INSERT INTO musubo_line_usage
    (line_account_id,tenant_id,status,friend_count_excluding_blocked,
      friend_count_measured_on,updated_at)
    VALUES ('line-one',?,'active',3000,?,?)`).run(tenantId, jstDateOffset(-1), new Date().toISOString());
  const subscription = (id: string, amount: number): StripeSubscription => ({
    id, status: 'active', customer: 'cus_test',
    metadata: { tenant_id: tenantId, purpose: id === 'sub_core' ? 'musubo_core' : 'musubo_options' },
    items: { data: [{ id: `si_${id}`, price: { id: `price_${id}`,
      product: id === 'sub_core' ? 'prod_core' : 'prod_options', unit_amount: amount,
      currency: 'jpy', recurring: { interval: 'month' } } }] },
  });
  vi.spyOn(stripeApi, 'retrieveSubscription').mockImplementation(async (_env, id) =>
    subscription(id, id === 'sub_core' ? 2950 : 0));
  const update = vi.spyOn(stripeApi, 'updateMusuboRecurringAmount').mockImplementation(async (_env, input) =>
    subscription(input.subscriptionId, input.amountYen));
  const env = { DB: fixture.db, STRIPE_PRODUCT_MUSUBO_CORE: 'prod_core',
    STRIPE_PRODUCT_MUSUBO_OPTIONS: 'prod_options' } as WorkerBindings;
  expect(await reconcileMusuboRecurringPrices(env, tenantId)).toBe(true);
  expect(update).toHaveBeenCalledTimes(1);
  expect(update.mock.calls[0]?.[1]).toMatchObject({ subscriptionId: 'sub_core', amountYen: 5900 });
});
