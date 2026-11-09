import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_MUSUBO_PRICE_SCHEDULE } from '@line-crm/shared';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import type { WorkerBindings } from '../worker-bindings.js';
import { StripeApiError, stripeApi, type StripeInvoice, type StripeSubscription } from './stripe-api.js';
import { collectMusuboLineAddition, connectReservedMusuboLine,
  reserveMusuboLineAddition, sweepMusuboLineAdditions, type MusuboPendingLineAddition } from './musubo-line-addition.js';

afterEach(() => vi.restoreAllMocks());

it('expires an unused free reservation so it cannot be connected after its price period', async () => {
  const fixture = createTestD1();
  const tenantId = DEFAULT_TENANT_ID;
  fixture.raw.prepare(`INSERT INTO musubo_pending_additions
    (id,tenant_id,kind,status,amount_due_yen,price_snapshot_json,expires_at,
      paid_at,created_at,updated_at)
    VALUES ('free-expired',?,'line','paid',0,'{}','2020-01-01','2020-01-01',
      '2020-01-01','2020-01-01')`).run(tenantId);
  expect(await sweepMusuboLineAdditions({ DB: fixture.db } as WorkerBindings))
    .toEqual({ attempted: 1, failed: 0 });
  expect(fixture.raw.prepare('SELECT status FROM musubo_pending_additions WHERE id=?').get('free-expired'))
    .toEqual({ status: 'expired' });
});

it('keeps a trial LINE inactive until both recurring contracts match, without charging on confirmation', async () => {
  const fixture = createTestD1();
  const tenantId = DEFAULT_TENANT_ID;
  fixture.raw.prepare('UPDATE tenants SET stripe_customer_id=? WHERE id=?').run('cus_test', tenantId);
  const condition = { sourceConditionId: 'normal', sourceVersion: 1, internalName: '通常条件',
    appliedAt: '2026-11-09', trialPeriod: { unit: 'days', value: 30 },
    lineBasicDiscountPercent: 0, discountEndsOn: null, schedule: DEFAULT_MUSUBO_PRICE_SCHEDULE };
  fixture.raw.prepare(`INSERT INTO musubo_tenant_billing
    (tenant_id,pricing_snapshot_json,pricing_selection_json,pricing_consented_at,
      billing_interval,status,first_line_activated_at,first_charge_date,
      core_subscription_id,options_subscription_id,created_at,updated_at)
    VALUES (?,?,?,'2026-11-09','month','trialing','2026-11-09','2099-01-01',
      'sub_core','sub_options','2026-11-09','2026-11-09')`)
    .run(tenantId, JSON.stringify(condition), JSON.stringify({ selection: { lineCount: 2 } }));
  for (const [id, active] of [['line-first', 1], ['line-second', 0]] as const) {
    fixture.raw.prepare(`INSERT INTO line_accounts
      (id,channel_id,name,channel_access_token,channel_secret,tenant_id,is_active)
      VALUES (?,?,?,?,?,?,?)`).run(id, id, id, 'token', 'secret', tenantId, active);
  }
  fixture.raw.prepare(`INSERT INTO musubo_line_usage
    (line_account_id,tenant_id,status,activated_at,friend_count_excluding_blocked,friend_count_measured_on,updated_at)
    VALUES ('line-first',?,'active','2026-11-09',1000,'2026-11-08','2026-11-09')`).run(tenantId);
  const subscription = (id: string, purpose: string, amount: number): StripeSubscription => ({
    id, status: 'trialing', customer: 'cus_test', trial_end: Date.parse('2098-12-31T15:00:00Z') / 1000,
    metadata: { tenant_id: tenantId, purpose }, items: { data: [{ id: `si_${id}`,
      price: { id: `price_${id}`, product: purpose === 'musubo_core' ? 'prod_core' : 'prod_options',
        unit_amount: amount, currency: 'jpy', tax_behavior: 'inclusive', recurring: { interval: 'month' } } }] },
  });
  const core = subscription('sub_core', 'musubo_core', 5900);
  const options = subscription('sub_options', 'musubo_options', 0);
  vi.spyOn(stripeApi, 'retrieveSubscription').mockImplementation(async (_env, id) => id === 'sub_core' ? core : options);
  const update = vi.spyOn(stripeApi, 'updateMusuboRecurringAmount').mockImplementation(async (_env, input) =>
    subscription(input.subscriptionId, input.subscriptionId === 'sub_core' ? 'musubo_core' : 'musubo_options', input.amountYen));
  const createInvoice = vi.spyOn(stripeApi, 'createMusuboAdditionInvoice');
  const env = { DB: fixture.db, STRIPE_PRODUCT_MUSUBO_CORE: 'prod_core',
    STRIPE_PRODUCT_MUSUBO_OPTIONS: 'prod_options' } as WorkerBindings;
  const pending = await reserveMusuboLineAddition(env, tenantId, 0, 1);
  expect(pending.status).toBe('paid');
  expect(pending.line_account_id).toBeNull();
  expect(createInvoice).not.toHaveBeenCalled();
  expect(fixture.raw.prepare('SELECT is_active FROM line_accounts WHERE id=?').get('line-second'))
    .toEqual({ is_active: 0 });
  expect(await connectReservedMusuboLine(env, { tenantId, lineAccountId: 'line-second',
    friendsExcludingBlocked: 500, measuredOn: '2026-11-08' })).toBe('active');
  expect(update).toHaveBeenCalledTimes(2);
  expect(update.mock.calls.map((call) => call[1].amountYen)).toEqual([13800, 5500]);
  expect(fixture.raw.prepare('SELECT is_active FROM line_accounts WHERE id=?').get('line-second'))
    .toEqual({ is_active: 1 });
  expect(fixture.raw.prepare('SELECT status FROM musubo_pending_additions WHERE id=?').get(pending.id))
    .toEqual({ status: 'activated' });
});

it('leaves only the new LINE pending after its one-off invoice payment fails', async () => {
  const fixture = createTestD1();
  const tenantId = DEFAULT_TENANT_ID;
  const now = new Date().toISOString();
  fixture.raw.prepare(`INSERT INTO line_accounts
    (id,channel_id,name,channel_access_token,channel_secret,tenant_id,is_active)
    VALUES ('line-existing','channel-existing','既存LINE','token','secret',?,1),
           ('line-pending','channel-pending','追加LINE','token','secret',?,0)`)
    .run(tenantId, tenantId);
  fixture.raw.prepare(`INSERT INTO musubo_pending_additions
    (id,tenant_id,kind,line_account_id,status,amount_due_yen,price_snapshot_json,
      expires_at,created_at,updated_at)
    VALUES ('addition-failed',?,'line','line-pending','awaiting_payment',6700,'{}',?,?,?)`)
    .run(tenantId, new Date(Date.now() + 7 * 86_400_000).toISOString(), now, now);
  const invoice = (status: string): StripeInvoice => ({
    id: 'in_addition', number: null, status, amount_paid: 0, amount_due: 6700,
    amount_remaining: 6700, currency: 'jpy', created: Math.floor(Date.now() / 1000),
    customer: 'cus_test', subscription: null,
    metadata: { tenant_id: tenantId, purpose: 'musubo_addition', addition_id: 'addition-failed' },
    charge: null, period_start: null, period_end: null, hosted_invoice_url: 'https://invoice.stripe.com/example',
    invoice_pdf: null,
  });
  vi.spyOn(stripeApi, 'listInvoices').mockResolvedValue({ data: [], has_more: false });
  vi.spyOn(stripeApi, 'createMusuboAdditionInvoice').mockResolvedValue(invoice('draft'));
  vi.spyOn(stripeApi, 'listInvoiceLines').mockResolvedValue({ data: [], has_more: false });
  vi.spyOn(stripeApi, 'createMusuboAdditionInvoiceItem').mockResolvedValue({ id: 'ii_addition', invoice: 'in_addition', amount: 6700 });
  vi.spyOn(stripeApi, 'finalizeMusuboAdditionInvoice').mockResolvedValue(invoice('open'));
  vi.spyOn(stripeApi, 'payMusuboAdditionInvoice').mockRejectedValue(new StripeApiError(402, 'Card declined', 'card_declined'));
  vi.spyOn(stripeApi, 'retrieveInvoice').mockResolvedValue(invoice('open'));
  const row = fixture.raw.prepare('SELECT * FROM musubo_pending_additions WHERE id=?')
    .get('addition-failed') as MusuboPendingLineAddition;
  const result = await collectMusuboLineAddition({ DB: fixture.db } as WorkerBindings, row, 'cus_test');
  expect(result.status).toBe('awaiting_payment');
  expect(result.stripe_invoice_id).toBe('in_addition');
  expect(fixture.raw.prepare('SELECT is_active FROM line_accounts WHERE id=?').get('line-existing'))
    .toEqual({ is_active: 1 });
  expect(fixture.raw.prepare('SELECT is_active FROM line_accounts WHERE id=?').get('line-pending'))
    .toEqual({ is_active: 0 });
});
