import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_MUSUBO_PRICE_SCHEDULE, musuboChargeDateEpoch } from '@line-crm/shared';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import type { WorkerBindings } from '../worker-bindings.js';
import { sendPlainMail } from './plain-mail.js';
import { stripeApi, type StripeSubscription } from './stripe-api.js';
import { sweepMusuboTrialNotices } from './musubo-trial-notification.js';

vi.mock('./plain-mail.js', () => ({ sendPlainMail: vi.fn(async () => undefined) }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

it('sends trial start once and the seven-day warning only when due, using annual and monthly amounts', async () => {
  const f = createTestD1();
  f.raw.prepare('UPDATE tenants SET stripe_customer_id=?,contact_email=? WHERE id=?')
    .run('cus_trial', 'owner@example.com', DEFAULT_TENANT_ID);
  const condition = { sourceConditionId: 'normal', sourceVersion: 1, internalName: '通常条件',
    appliedAt: '2026-11-08', trialPeriod: { unit: 'days', value: 30 },
    lineBasicDiscountPercent: 0, discountEndsOn: null, schedule: DEFAULT_MUSUBO_PRICE_SCHEDULE };
  f.raw.prepare(`INSERT INTO musubo_tenant_billing
    (tenant_id,pricing_snapshot_json,pricing_selection_json,pricing_consented_at,billing_interval,
      status,first_line_activated_at,trial_last_free_date,first_charge_date,
      core_subscription_id,options_subscription_id,created_at,updated_at)
    VALUES (?,?,?,'2026-11-08','year','trialing','2026-11-08T10:00:00+09:00',
      '2026-12-07','2026-12-08','sub_core','sub_options','2026-11-08','2026-11-08')`)
    .run(DEFAULT_TENANT_ID, JSON.stringify(condition), JSON.stringify({ selection: { lineCount: 1 } }));
  f.raw.prepare(`INSERT INTO musubo_line_usage
    (line_account_id,tenant_id,status,activated_at,friend_count_excluding_blocked,updated_at)
    VALUES ('line-first',?,'active','2026-11-08T10:00:00+09:00',2800,'2026-11-08')`)
    .run(DEFAULT_TENANT_ID);
  const subscription = (purpose: 'core' | 'options', amount: number): StripeSubscription => ({
    id: `sub_${purpose}`, customer: 'cus_trial', status: 'trialing',
    trial_end: musuboChargeDateEpoch('2026-12-08'),
    metadata: { tenant_id: DEFAULT_TENANT_ID, purpose: `musubo_${purpose}` },
    items: { data: [{ id: `si_${purpose}`, price: { id: `price_${purpose}`,
      product: `prod_${purpose}`, unit_amount: amount, currency: 'jpy', tax_behavior: 'inclusive',
      recurring: { interval: purpose === 'core' ? 'year' : 'month' } } }] },
  });
  vi.spyOn(stripeApi, 'retrieveSubscription').mockImplementation(async (_env, id) =>
    id === 'sub_core' ? subscription('core', 63720) : subscription('options', 0));
  const env = { DB: f.db, ADMIN_PUBLIC_URL: 'https://admin.example.com' } as WorkerBindings;
  expect(await sweepMusuboTrialNotices(env, new Date('2026-11-09T00:00:00+09:00')))
    .toEqual({ checked: 1, failed: 0 });
  expect(sendPlainMail).toHaveBeenCalledTimes(1);
  expect(vi.mocked(sendPlainMail).mock.calls[0]?.[1].body).toContain('63,720');
  expect(vi.mocked(sendPlainMail).mock.calls[0]?.[1].body).toContain('年払い');
  expect(await sweepMusuboTrialNotices(env, new Date('2026-11-30T00:00:00+09:00')))
    .toEqual({ checked: 0, failed: 0 });
  expect(await sweepMusuboTrialNotices(env, new Date('2026-12-01T00:00:00+09:00')))
    .toEqual({ checked: 1, failed: 0 });
  expect(sendPlainMail).toHaveBeenCalledTimes(2);
  expect(vi.mocked(sendPlainMail).mock.calls[1]?.[1].subject).toContain('初回請求');
  expect(await sweepMusuboTrialNotices(env, new Date('2026-12-01T00:00:00+09:00')))
    .toEqual({ checked: 0, failed: 0 });
});
