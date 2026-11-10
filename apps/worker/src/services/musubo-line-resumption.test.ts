import { expect, it, vi } from 'vitest';
import { DEFAULT_MUSUBO_PRICE_SCHEDULE } from '@line-crm/shared';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import type { WorkerBindings } from '../worker-bindings.js';

const stripe = vi.hoisted(() => ({ retrieveCustomer: vi.fn(async () => ({
  invoice_settings: { default_payment_method: 'pm_test' },
})) }));
const follower = vi.hoisted(() => ({ friends: 2800, measuredOn: '2027-01-24' }));
const ensure = vi.hoisted(() => vi.fn(async (_env: unknown, input: { purpose: 'core' | 'options';
  chargeAtEpoch?: number; unitAmountYen: number }) => ({
  id: input.purpose === 'core' ? 'sub_resumed_core' : 'sub_resumed_options',
  current_period_end: input.chargeAtEpoch ?? 1800000000,
})));
vi.mock('./stripe-api.js', () => ({ stripeApi: stripe }));
vi.mock('./musubo-resumption-subscription.js', () => ({
  ensureMusuboResumptionSubscription: ensure,
}));
vi.mock('./line-messaging-identity.js', () => ({
  verifyLineMessagingIdentity: vi.fn(async () => true),
}));
vi.mock('./musubo-large-line-consultation.js', () => ({
  fetchPreConnectFollowerInsight: vi.fn(async () => ({ followers: follower.friends + 200,
    friendsExcludingBlocked: follower.friends, measuredOn: follower.measuredOn })),
}));

import { acceptMusuboLineResumption, getMusuboLineResumptionOffer } from
  './musubo-line-resumption-review.js';
import { reconcileMusuboLineResumption, requestMusuboLineResumption,
  sweepMusuboLineResumptions } from './musubo-line-resumption.js';

function setup() {
  follower.friends = 2800; follower.measuredOn = '2027-01-24';
  const fixture = createTestD1();
  const tenantId = DEFAULT_TENANT_ID;
  fixture.raw.prepare('UPDATE tenants SET stripe_customer_id=? WHERE id=?')
    .run('cus_resumption', tenantId);
  fixture.raw.prepare(`INSERT INTO line_accounts
    (id,channel_id,name,channel_access_token,channel_secret,tenant_id,is_active,archived_at)
    VALUES ('line-old','123456','旧LINE','token','secret',?,0,NULL)`).run(tenantId);
  const condition = JSON.stringify({ sourceConditionId: 'normal', sourceVersion: 1,
    internalName: '通常条件', appliedAt: '2026-11-09',
    trialPeriod: { unit: 'days', value: 30 }, lineBasicDiscountPercent: 0,
    discountEndsOn: null, schedule: DEFAULT_MUSUBO_PRICE_SCHEDULE });
  fixture.raw.prepare(`INSERT INTO musubo_tenant_billing
    (tenant_id,pricing_snapshot_json,billing_interval,status,first_line_activated_at,
      trial_last_free_date,first_charge_date,core_subscription_id,options_subscription_id,
      ended_at,created_at,updated_at) VALUES (?,?,'month','ended',
      '2026-11-09T00:00:00+09:00','2026-12-08','2026-12-09',
      'sub_old_core','sub_old_options','2027-01-20T00:00:00+09:00',
      '2026-11-09T00:00:00+09:00','2027-01-20T00:00:00+09:00')`)
    .run(tenantId, condition);
  fixture.raw.prepare(`INSERT INTO musubo_line_usage
    (line_account_id,tenant_id,status,activated_at,ended_at,updated_at)
    VALUES ('line-old',?,'ended','2026-11-09T00:00:00+09:00',
      '2027-01-20T00:00:00+09:00','2027-01-20T00:00:00+09:00')`).run(tenantId);
  const env = { DB: fixture.db, STRIPE_PRODUCT_MUSUBO_CORE: 'prod_core',
    STRIPE_PRODUCT_MUSUBO_OPTIONS: 'prod_options' } as WorkerBindings;
  return { fixture, env, tenantId };
}

it('restarts only after consent, card, LINE proof and two reconciled subscriptions', async () => {
  stripe.retrieveCustomer.mockClear(); ensure.mockClear();
  const { fixture, env, tenantId } = setup();
  const now = new Date('2027-01-25T00:00:00+09:00');
  await expect(requestMusuboLineResumption(env, tenantId, now)).rejects.toThrow('consent');
  await acceptMusuboLineResumption(env, tenantId, now);
  await requestMusuboLineResumption(env, tenantId, now);
  expect(fixture.raw.prepare('SELECT status FROM musubo_tenant_billing WHERE tenant_id=?')
    .get(tenantId)).toMatchObject({ status: 'ended' });
  await reconcileMusuboLineResumption(env, tenantId, now);
  expect(ensure).toHaveBeenCalledTimes(2);
  expect(ensure.mock.calls[0]?.[1]).toMatchObject({ purpose: 'core', unitAmountYen: 5_900 });
  expect(fixture.raw.prepare(`SELECT status,core_subscription_id,resumption_requested_at
    FROM musubo_tenant_billing WHERE tenant_id=?`).get(tenantId)).toMatchObject({
    status: 'active', core_subscription_id: 'sub_resumed_core', resumption_requested_at: null,
  });
  expect(fixture.raw.prepare(`SELECT status FROM musubo_line_usage WHERE line_account_id='line-old'`)
    .get()).toMatchObject({ status: 'active' });
  expect(fixture.raw.prepare(`SELECT is_active,is_default FROM line_accounts WHERE id='line-old'`)
    .get()).toMatchObject({ is_active: 1, is_default: 1 });
});

it('shows and charges the accepted friend and linked-slot options without changing the offer', async () => {
  const { fixture, env, tenantId } = setup();
  const now = new Date('2027-01-25T00:00:00+09:00');
  follower.friends = 12_000;
  fixture.raw.prepare(`UPDATE musubo_line_usage SET google_business_count=2,
    instagram_count=3 WHERE line_account_id='line-old'`).run();
  const offer = await getMusuboLineResumptionOffer(env, tenantId, now);
  expect(offer).toMatchObject({ kind: 'paid_expired', options: {
    friendBlocks: 1, linkedSlots: 2, friendOverageMonthlyYen: 1_100,
    linkedSlotsMonthlyYen: 6_600, optionsMonthlyYen: 7_700,
    optionsDueNowYen: 7_700, totalDueNowYen: 13_600,
  } });
  await acceptMusuboLineResumption(env, tenantId, now);
  follower.friends = 12_001;
  await expect(requestMusuboLineResumption(env, tenantId, now)).rejects.toThrow('changed');
  follower.friends = 12_000;
  ensure.mockClear();
  await requestMusuboLineResumption(env, tenantId, now);
  await reconcileMusuboLineResumption(env, tenantId, now);
  expect(ensure.mock.calls[1]?.[1]).toMatchObject({ purpose: 'options', unitAmountYen: 7_700 });
});

it('holds LINE access when one Stripe subscription cannot be confirmed, then retries', async () => {
  const { fixture, env, tenantId } = setup();
  const now = new Date('2027-01-25T00:00:00+09:00');
  await acceptMusuboLineResumption(env, tenantId, now);
  await requestMusuboLineResumption(env, tenantId, now);
  ensure.mockImplementationOnce(async () => ({ id: 'sub_resumed_core', current_period_end: 1800000000 }))
    .mockRejectedValueOnce(new Error('Stripe payment pending'));
  await expect(reconcileMusuboLineResumption(env, tenantId, now)).rejects.toThrow('pending');
  expect(fixture.raw.prepare('SELECT status FROM musubo_tenant_billing WHERE tenant_id=?')
    .get(tenantId)).toMatchObject({ status: 'ended' });
  ensure.mockImplementation(async (_env: unknown, input: { purpose: 'core' | 'options' }) => ({
    id: input.purpose === 'core' ? 'sub_resumed_core' : 'sub_resumed_options',
    current_period_end: 1800000000,
  }));
  expect(await sweepMusuboLineResumptions(env, now)).toEqual({ processed: 1, failed: 0 });
  expect(fixture.raw.prepare('SELECT status FROM musubo_tenant_billing WHERE tenant_id=?')
    .get(tenantId)).toMatchObject({ status: 'active' });
});

it('rejects a saved offer whose immediate charge no longer matches its itemized total', async () => {
  const { fixture, env, tenantId } = setup();
  const now = new Date('2027-01-25T00:00:00+09:00');
  await acceptMusuboLineResumption(env, tenantId, now);
  await requestMusuboLineResumption(env, tenantId, now);
  const billing = fixture.raw.prepare(`SELECT resumption_offer_json FROM musubo_tenant_billing
    WHERE tenant_id=?`).get(tenantId) as { resumption_offer_json: string };
  const altered = JSON.parse(billing.resumption_offer_json) as { options: { totalDueNowYen: number } };
  altered.options.totalDueNowYen += 1_100;
  fixture.raw.prepare(`UPDATE musubo_tenant_billing SET resumption_offer_json=? WHERE tenant_id=?`)
    .run(JSON.stringify(altered), tenantId);
  ensure.mockClear();
  await expect(reconcileMusuboLineResumption(env, tenantId, now))
    .rejects.toThrow('does not match');
  expect(ensure).not.toHaveBeenCalled();
  expect(fixture.raw.prepare('SELECT status FROM musubo_tenant_billing WHERE tenant_id=?')
    .get(tenantId)).toMatchObject({ status: 'ended' });
});
