import { expect, it, vi } from 'vitest';
import { DEFAULT_MUSUBO_PRICE_SCHEDULE } from '@line-crm/shared';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import type { WorkerBindings } from '../worker-bindings.js';

const ensureSubscription = vi.hoisted(() => vi.fn(async (_env: unknown, input: {
  purpose: 'core' | 'options'; unitAmountYen: number;
}) => ({ id: input.purpose === 'core' ? 'sub_core' : 'sub_options' })));
vi.mock('./musubo-subscription-reconciliation.js', () => ({
  ensureMusuboSubscription: ensureSubscription,
}));

import { ensureMusuboCoreContract, ensureMusuboOptionsContract } from './musubo-core-subscription.js';

it('claims both trial contracts once and charges verified friend overage only on monthly options', async () => {
  ensureSubscription.mockClear();
  const fixture = createTestD1();
  const tenantId = DEFAULT_TENANT_ID;
  fixture.raw.prepare('UPDATE tenants SET stripe_customer_id=? WHERE id=?').run('cus_test', tenantId);
  const condition = {
    sourceConditionId: 'normal', sourceVersion: 1, internalName: '通常条件',
    appliedAt: '2026-11-09', trialPeriod: { unit: 'days', value: 30 },
    lineBasicDiscountPercent: 0, discountEndsOn: null,
    schedule: DEFAULT_MUSUBO_PRICE_SCHEDULE,
  };
  fixture.raw.prepare(`INSERT INTO musubo_tenant_billing
    (tenant_id,pricing_snapshot_json,pricing_selection_json,pricing_consented_at,
      billing_interval,status,first_line_activated_at,first_charge_date,created_at,updated_at)
    VALUES (?,?,?,'2026-11-09','year','trialing','2026-11-09','2026-12-09','2026-11-09','2026-11-09')`)
    .run(tenantId, JSON.stringify(condition), JSON.stringify({ selection: { lineCount: 1 } }));
  fixture.raw.prepare(`INSERT INTO line_accounts
    (id,channel_id,name,channel_access_token,channel_secret,tenant_id)
    VALUES ('line-first','channel-first','公式LINE','token','secret',?)`).run(tenantId);
  fixture.raw.prepare(`INSERT INTO musubo_line_usage
    (line_account_id,tenant_id,status,activated_at,friend_count_excluding_blocked,friend_count_measured_on,updated_at)
    VALUES ('line-first',?,'active','2026-11-09',3100,'2026-11-08','2026-11-09')`).run(tenantId);
  const env = { DB: fixture.db, STRIPE_PRODUCT_MUSUBO_CORE: 'prod_core',
    STRIPE_PRODUCT_MUSUBO_OPTIONS: 'prod_options' } as WorkerBindings;
  expect(await ensureMusuboCoreContract(env, tenantId)).toBe('sub_core');
  expect(await ensureMusuboOptionsContract(env, tenantId)).toBe('sub_options');
  expect(await ensureMusuboCoreContract(env, tenantId)).toBe('sub_core');
  expect(await ensureMusuboOptionsContract(env, tenantId)).toBe('sub_options');
  expect(ensureSubscription).toHaveBeenCalledTimes(2);
  expect(ensureSubscription.mock.calls[0]?.[1]).toMatchObject({
    interval: 'year', unitAmountYen: 63_720, firstChargeDateJst: '2026-12-09',
  });
  expect(ensureSubscription.mock.calls[1]?.[1]).toMatchObject({
    interval: 'month', unitAmountYen: 1_100, firstChargeDateJst: '2026-12-09',
  });
});
