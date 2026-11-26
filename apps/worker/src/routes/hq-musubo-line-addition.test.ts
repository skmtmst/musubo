import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MUSUBO_PRICE_SCHEDULE } from '@line-crm/shared';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { stripeApi, type StripeInvoice, type StripeSubscription } from '../services/stripe-api.js';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import type { Env } from '../worker-env.js';
import { hqMusuboLineAddition } from './hq-musubo-line-addition.js';

const path = '/api/hq/billing/musubo/line-addition';
const tenantId = DEFAULT_TENANT_ID;
const staff: AuthenticatedStaff = { id: 'env-owner', role: 'owner', name: '検証用管理者', readOnly: false, tenantId };
const amountDueYen = 6700;
const price = {
  addedLineOrdinal: 2, coreIncrementYen: 7900,
  coreIncrementInterval: 'month', headquartersIncrementMonthlyYen: 5500, dueNowYen: amountDueYen,
};

function setup(status: 'awaiting_payment' | 'paid' | 'expired' | 'cancelled' = 'awaiting_payment') {
  const fixture = createTestD1();
  const condition = { sourceConditionId: 'normal', sourceVersion: 1, internalName: '通常条件',
    appliedAt: '2026-11-09', trialPeriod: { unit: 'days', value: 30 },
    lineBasicDiscountPercent: 0, discountEndsOn: null, schedule: DEFAULT_MUSUBO_PRICE_SCHEDULE };
  fixture.raw.prepare('UPDATE tenants SET stripe_customer_id=? WHERE id=?').run('cus_recovery', tenantId);
  fixture.raw.prepare("INSERT INTO tenants (id,name) VALUES ('other-tenant','別の統括')").run();
  fixture.raw.prepare(`INSERT INTO musubo_tenant_billing
    (tenant_id,pricing_snapshot_json,billing_interval,status,first_line_activated_at,first_charge_date,
      core_subscription_id,options_subscription_id,created_at,updated_at)
    VALUES (?,?,'month','active','2026-11-09','2026-12-09','sub_core','sub_options','2026-11-09','2026-11-09')`)
    .run(tenantId, JSON.stringify(condition));
  for (const [id, active] of [['line-existing', 1], ['line-addition', 0]] as const) {
    fixture.raw.prepare(`INSERT INTO line_accounts
      (id,channel_id,name,channel_access_token,channel_secret,tenant_id,is_active)
      VALUES (?,?,?,?,?,?,?)`).run(id, id, id, 'token', 'secret', tenantId, active);
  }
  fixture.raw.prepare(`INSERT INTO musubo_line_usage
    (line_account_id,tenant_id,status,friend_count_excluding_blocked,friend_count_measured_on,updated_at)
    VALUES ('line-existing',?,'active',100,'2026-11-08','2026-11-09'),
           ('line-addition',?,'pending',200,'2026-11-08','2026-11-09')`).run(tenantId, tenantId);
  fixture.raw.prepare(`INSERT INTO musubo_pending_additions
    (id,tenant_id,kind,line_account_id,status,amount_due_yen,price_snapshot_json,stripe_invoice_id,
     expires_at,created_at,updated_at)
    VALUES ('addition-one',?,'line','line-addition',?,?,?,'in_addition','2099-01-02','2026-11-09','2026-11-09')`)
    .run(tenantId, status, amountDueYen, JSON.stringify({
      price, activeLineCount: 1, recurringAfter: { coreYen: 13800, coreInterval: 'month', optionsYen: 5500 },
    }));
  const call = (suffix = '', body?: object, identity = staff) => {
    const app = new Hono<Env>();
    app.use('*', async (c, next) => {
      c.set('staff', { ...identity });
      await next();
    });
    app.route('/', hqMusuboLineAddition);
    return app.request(path + suffix, {
      method: body ? 'POST' : 'GET',
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    }, {
      DB: fixture.db, STRIPE_PRODUCT_MUSUBO_CORE: 'prod_core', STRIPE_PRODUCT_MUSUBO_OPTIONS: 'prod_options',
    } as Env['Bindings']);
  };
  return { ...fixture, call };
}

function stripeMocks(invoiceStatus: 'open' | 'paid', invoiceOverrides: Partial<StripeInvoice> = {}) {
  const invoice: StripeInvoice = {
    id: 'in_addition', number: null, status: invoiceStatus,
    amount_paid: invoiceStatus === 'paid' ? amountDueYen : 0, amount_due: amountDueYen,
    amount_remaining: invoiceStatus === 'paid' ? 0 : amountDueYen, currency: 'jpy', created: 1,
    customer: 'cus_recovery', subscription: null,
    metadata: { tenant_id: tenantId, purpose: 'musubo_addition', addition_id: 'addition-one' },
    charge: null, period_start: null, period_end: null, hosted_invoice_url: 'https://invoice.stripe.com/example',
    invoice_pdf: null, ...invoiceOverrides,
  };
  const subscription = (id: string, amount: number): StripeSubscription => {
    const purpose = id === 'sub_core' ? 'core' : 'options';
    return {
      id, status: 'active', customer: 'cus_recovery', metadata: { tenant_id: tenantId, purpose: 'musubo_' + purpose },
      items: { data: [{ id: 'item_' + purpose, price: { id: 'price_' + purpose,
        product: 'prod_' + purpose, unit_amount: amount, currency: 'jpy',
        tax_behavior: 'inclusive', recurring: { interval: 'month' } } }] },
    };
  };
  const retrieveInvoice = vi.spyOn(stripeApi, 'retrieveInvoice').mockResolvedValue(invoice);
  const retrieveSubscription = vi.spyOn(stripeApi, 'retrieveSubscription')
    .mockImplementation(async (_env, id) => subscription(id, id === 'sub_core' ? 5900 : 0));
  const update = vi.spyOn(stripeApi, 'updateMusuboRecurringAmount')
    .mockImplementation(async (_env, input) => subscription(input.subscriptionId, input.amountYen));
  const pay = vi.spyOn(stripeApi, 'payMusuboAdditionInvoice').mockRejectedValue(new Error('No attempt should charge an invoice'));
  const create = vi.spyOn(stripeApi, 'createMusuboAdditionInvoice').mockRejectedValue(new Error('No attempt should create an invoice'));
  return { retrieveInvoice, retrieveSubscription, update, pay, create };
}

afterEach(() => vi.restoreAllMocks());

describe('LINE追加の決済再開', () => {
  it('同じ決済済みの追加を明示的に有効化し、再読込と再試行で請求しない', async () => {
    const { call, raw } = setup();
    const stripe = stripeMocks('paid');
    const response = await call('', { action: 'reconcile', accountId: 'line-addition' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: {
      id: 'addition-one', lineAccountId: 'line-addition', status: 'activated', activationPending: false, paymentUrl: null,
    } });
    expect(raw.prepare("SELECT is_active FROM line_accounts WHERE id='line-addition'").get()).toEqual({ is_active: 1 });
    expect(raw.prepare("SELECT status FROM musubo_line_usage WHERE line_account_id='line-addition'").get()).toEqual({ status: 'active' });
    const reload = await call('?additionId=addition-one');
    expect(reload.headers.get('Cache-Control')).toBe('no-store');
    expect(await reload.json()).toMatchObject({ success: true, data: {
      price, activeLineCount: 2, addition: { id: 'addition-one', lineAccountId: 'line-addition', status: 'activated' },
    } });
    const retry = await call('', { action: 'reconcile', additionId: 'addition-one' });
    expect(await retry.json()).toMatchObject({ success: true, data: { status: 'activated' } });
    expect(stripe.retrieveInvoice).toHaveBeenCalledTimes(1);
    expect(stripe.update.mock.calls.map(call => call[1].idempotencyKey)).toEqual([
      'musubo-addition-addition-one-core', 'musubo-addition-addition-one-options',
    ]);
    expect(stripe.pay).not.toHaveBeenCalled();
    expect(stripe.create).not.toHaveBeenCalled();
  });

  it('支払い済みの反映に失敗しても、同じ追加を次の確認で有効化できる', async () => {
    const { call, raw } = setup('paid');
    const stripe = stripeMocks('paid');
    stripe.update.mockRejectedValueOnce(new Error('Stripe is temporarily unavailable'));
    const first = await call('', { action: 'reconcile', accountId: 'line-addition' });
    expect(first.status).toBe(409);
    expect(raw.prepare("SELECT status FROM musubo_pending_additions WHERE id='addition-one'").get()).toEqual({ status: 'paid' });
    expect(raw.prepare("SELECT is_active FROM line_accounts WHERE id='line-addition'").get()).toEqual({ is_active: 0 });
    const next = await call('', { action: 'reconcile', accountId: 'line-addition' });
    expect(await next.json()).toMatchObject({ success: true, data: { lineAccountId: 'line-addition', status: 'activated' } });
    expect(stripe.retrieveInvoice).not.toHaveBeenCalled();
    expect(stripe.update.mock.calls.map(call => call[1].idempotencyKey)).toEqual([
      'musubo-addition-addition-one-core', 'musubo-addition-addition-one-core', 'musubo-addition-addition-one-options',
    ]);
    expect(stripe.pay).not.toHaveBeenCalled();
    expect(stripe.create).not.toHaveBeenCalled();
  });

  it('未払いの同じ請求へのリンクを返し、再確認から支払いを開始しない', async () => {
    const { call, raw } = setup();
    const stripe = stripeMocks('open');
    const response = await call('?accountId=line-addition');
    expect(await response.json()).toMatchObject({ success: true, data: {
      addition: { lineAccountId: 'line-addition', status: 'awaiting_payment', canConnect: false,
        paymentUrl: 'https://invoice.stripe.com/example' },
    } });
    const retry = await call('', { action: 'reconcile', additionId: 'addition-one' });
    expect(await retry.json()).toMatchObject({ success: true, data: {
      status: 'awaiting_payment', paymentUrl: 'https://invoice.stripe.com/example',
    } });
    expect(raw.prepare("SELECT is_active FROM line_accounts WHERE id='line-addition'").get()).toEqual({ is_active: 0 });
    expect(stripe.retrieveSubscription).not.toHaveBeenCalled();
    expect(stripe.pay).not.toHaveBeenCalled();
    expect(stripe.create).not.toHaveBeenCalled();
  });

  it('請求金額が一致しない支払いでは有効化しない', async () => {
    const { call, raw } = setup();
    const stripe = stripeMocks('paid', { amount_due: amountDueYen + 1 });
    const response = await call('', { action: 'reconcile', additionId: 'addition-one' });
    expect(response.status).toBe(409);
    expect(raw.prepare("SELECT status FROM musubo_pending_additions WHERE id='addition-one'").get())
      .toEqual({ status: 'awaiting_payment' });
    expect(stripe.retrieveSubscription).not.toHaveBeenCalled();
    expect(stripe.pay).not.toHaveBeenCalled();
  });

  it('期限を過ぎた未払い追加を確認しても決済リンクを再表示しない', async () => {
    const { call, raw } = setup();
    raw.prepare("UPDATE musubo_pending_additions SET expires_at='2020-01-01' WHERE id='addition-one'").run();
    const stripe = stripeMocks('open');
    const response = await call('?additionId=addition-one');
    expect(await response.json()).toMatchObject({ success: true, data: {
      expired: true, addition: { status: 'awaiting_payment', paymentUrl: null },
    } });
    const retry = await call('', { action: 'reconcile', additionId: 'addition-one' });
    expect(await retry.json()).toMatchObject({ success: true, data: { status: 'awaiting_payment', paymentUrl: null } });
    expect(stripe.pay).not.toHaveBeenCalled();
  });

  it.each(['expired', 'cancelled'] as const)('%s の行を復旧や請求の対象にしない', async status => {
    const { call } = setup(status);
    const stripe = stripeMocks('paid');
    const response = await call('', { action: 'reconcile', additionId: 'addition-one' });
    expect(await response.json()).toMatchObject({ success: true, data: { status, paymentUrl: null } });
    expect(stripe.retrieveInvoice).not.toHaveBeenCalled();
    expect(stripe.retrieveSubscription).not.toHaveBeenCalled();
    expect(stripe.pay).not.toHaveBeenCalled();
  });

  it('対象IDを決め打ちし、他統括・担当外・閲覧のみを拒否する', async () => {
    const { call, raw } = setup('paid');
    const stripe = stripeMocks('paid');
    const crossTenant = { ...staff, tenantId: 'other-tenant' };
    const wrongAssignment = { ...staff, featureEnabledLineAccountIds: ['line-existing'] };
    expect((await call('?additionId=addition-one', undefined, crossTenant)).status).toBe(404);
    expect((await call('', { action: 'reconcile', accountId: 'line-addition' }, crossTenant)).status).toBe(404);
    expect((await call('', { action: 'reconcile', additionId: 'addition-one' }, wrongAssignment)).status).toBe(404);
    expect((await call('', { action: 'reconcile', additionId: 'addition-one' }, { ...staff, readOnly: true })).status).toBe(403);
    expect((await call('', { action: 'reconcile', additionId: 'addition-one', accountId: 'line-existing' })).status).toBe(400);
    expect((await call('', { action: 'reconcile', additionId: 'missing' })).status).toBe(404);
    expect((await call('', { consent: true, amountDueYen, activeLineCount: 1 })).status).toBe(401);
    expect(raw.prepare("SELECT status FROM musubo_pending_additions WHERE id='addition-one'").get()).toEqual({ status: 'paid' });
    expect(stripe.retrieveInvoice).not.toHaveBeenCalled();
    expect(stripe.retrieveSubscription).not.toHaveBeenCalled();
  });
});
