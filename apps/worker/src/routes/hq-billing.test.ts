import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';

const stripe = vi.hoisted(() => ({
  createInvoicePreview: vi.fn(),
  createCustomer: vi.fn(),
  createCheckoutSession: vi.fn(),
  createCardSetupSession: vi.fn(),
  createPortalSession: vi.fn(),
  retrieveSetupIntent: vi.fn(),
  retrieveCustomer: vi.fn(),
  setCustomerDefaultPaymentMethod: vi.fn(),
  retrievePrice: vi.fn(),
  retrieveSubscription: vi.fn(),
  retrievePaymentIntent: vi.fn(),
  listInvoices: vi.fn(),
}));
vi.mock('../services/stripe-api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/stripe-api.js')>();
  return { ...actual, stripeApi: stripe };
});

const { hqBilling } = await import('./hq-billing.js');

let testDb: SqliteD1;
const WEBHOOK_SECRET = 'whsec_test_secret';

const staffOf = (overrides: Partial<AuthenticatedStaff> = {}): AuthenticatedStaff => ({
  id: 'staff-1',
  name: '山田 太郎',
  role: 'owner',
  readOnly: false,
  tenantId: DEFAULT_TENANT_ID,
  ...overrides,
});

function app(staff: AuthenticatedStaff | null) {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    if (staff) c.set('staff', staff);
    return next();
  });
  instance.route('/', hqBilling);
  return instance;
}

function env(overrides: Partial<Env['Bindings']> = {}): Env['Bindings'] {
  return {
    DB: testDb.db,
    ADMIN_ORIGIN: 'https://admin.example.com',
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_BILLING_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_PRICE_LIGHT: 'price_light',
    STRIPE_PRICE_STANDARD: 'price_standard',
    STRIPE_PRICE_PRO: 'price_pro',
    STRIPE_PRICE_LIGHT_YEAR: 'price_test_light_year',
    STRIPE_PRICE_STANDARD_YEAR: 'price_test_standard_year',
    STRIPE_PRICE_PRO_YEAR: 'price_test_pro_year',
    ...overrides,
  } as Env['Bindings'];
}

async function call(method: string, path: string, body?: unknown, opts: { staff?: AuthenticatedStaff | null; env?: Partial<Env['Bindings']> } = {}) {
  return app(opts.staff === undefined ? staffOf() : opts.staff).request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env(opts.env));
}

async function sign(payload: string, secret = WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${payload}`));
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `t=${timestamp},v1=${hex}`;
}

async function webhook(event: Record<string, unknown>, opts: { secret?: string; env?: Partial<Env['Bindings']> } = {}) {
  const payload = JSON.stringify(event);
  return app(null).request('/api/hq/billing/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': await sign(payload, opts.secret) },
    body: payload,
  }, env(opts.env));
}

function setTenant(patch: Record<string, string | null>) {
  const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
  testDb.raw.prepare(`UPDATE tenants SET ${sets} WHERE id = ?`).run(...Object.values(patch), DEFAULT_TENANT_ID);
}

function tenantRow() {
  return testDb.raw.prepare('SELECT plan_key, plan_status, trial_ends_at, stripe_customer_id, stripe_subscription_id, current_period_ends_at FROM tenants WHERE id = ?').get(DEFAULT_TENANT_ID) as Record<string, string | null>;
}

beforeEach(() => {
  testDb = createTestD1();
  for (const fn of Object.values(stripe)) fn.mockReset();
  stripe.retrievePrice.mockResolvedValue({ id: 'price', unit_amount: 12345, currency: 'jpy' });
  testDb.raw.prepare(
    `INSERT INTO staff_members (id, name, email, role, api_key, tenant_id) VALUES ('staff-1', '山田 太郎', 'masato@example.com', 'admin', 'key-1', ?)`,
  ).run(DEFAULT_TENANT_ID);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('契約状況（summary）', () => {
  it('年も Stripe の金額が正本で、価格IDは応答に含まない', async () => {
    stripe.retrievePrice.mockImplementation(async (_env, id: string) => ({ unit_amount: id.endsWith('_year') ? 100001 : 10000, currency: 'jpy' }));
    const res = await call('GET', '/api/hq/billing/summary');
    const json = await res.json<{ data: { plans: Array<Record<string, unknown>> } }>();
    expect(json.data.plans[0]).toMatchObject({ monthlyYen: 10000, yearlyYen: 100001, yearlyPriceFromStripe: true, yearlyAvailable: true });
    expect(JSON.stringify(json)).not.toMatch(/price_test_|sk_test_|whsec_/);
  });

  it('年の価格が取れなくても仮の決定額を出し、未設定のプランだけ年の申込みを止める', async () => {
    stripe.retrievePrice.mockRejectedValue(new Error('unavailable'));
    const res = await call('GET', '/api/hq/billing/summary', undefined, { env: { STRIPE_PRICE_LIGHT_YEAR: undefined } });
    const { data } = await res.json<{ data: { plans: Array<Record<string, unknown>> } }>();
    expect(data.plans.map((p) => p.yearlyYen)).toEqual([99000, 303000, 609000]);
    expect(data.plans[0]).toMatchObject({ available: true, yearlyAvailable: false, yearlyPriceFromStripe: false });
    expect(data.plans[1]).toMatchObject({ available: true, yearlyAvailable: true, yearlyPriceFromStripe: false });
  });

  it('Stripe の契約取得に失敗しても画面は返し、月払いと誤表示しない', async () => {
    setTenant({ plan_key: 'light', plan_status: 'active', stripe_subscription_id: 'sub_test' });
    stripe.retrieveSubscription.mockRejectedValue(new Error('unavailable'));
    const res = await call('GET', '/api/hq/billing/summary');
    expect(res.status).toBe(200);
    expect((await res.json<{ data: { planInterval: string | null } }>()).data.planInterval).toBeNull();
  });

  it('既存の統括は課金対象外で、何も止まらない', async () => {
    const res = await call('GET', '/api/hq/billing/summary', undefined, { env: { STRIPE_SECRET_KEY: undefined } });
    expect(res.status).toBe(200);
    const data = (await res.json<{ data: { state: string; canSend: boolean; stripeReady: boolean; plans: Array<{ key: string; monthlyYen: number; available: boolean; priceFromStripe: boolean }> } }>()).data;
    expect(data.state).toBe('exempt');
    expect(data.canSend).toBe(true);
    expect(data.stripeReady).toBe(false);
    expect(data.plans.map((p) => p.key)).toEqual(['light', 'standard', 'pro']);
    expect(data.plans[0]).toMatchObject({ monthlyYen: 9800, available: false, priceFromStripe: false });
  });

  it('Stripe の価格が取れればその金額を出す', async () => {
    const res = await call('GET', '/api/hq/billing/summary');
    const data = (await res.json<{ data: { plans: Array<{ monthlyYen: number; priceFromStripe: boolean; available: boolean }> } }>()).data;
    expect(data.plans[1]).toMatchObject({ monthlyYen: 12345, priceFromStripe: true, available: true });
  });

  it('トライアル中は残り日数、期限切れは止まる理由が出る', async () => {
    setTenant({ plan_status: 'trialing', trial_ends_at: '2999-01-10T00:00:00.000' });
    const data = (await (await call('GET', '/api/hq/billing/summary')).json<{ data: { state: string; trialDaysLeft: number; trialEndsLabel: string } }>()).data;
    expect(data.state).toBe('trialing');
    expect(data.trialDaysLeft).toBeGreaterThan(0);
    expect(data.trialEndsLabel).toBe('1/10');

    setTenant({ trial_ends_at: '2020-01-01T00:00:00.000' });
    const expired = (await (await call('GET', '/api/hq/billing/summary')).json<{ data: { state: string; canSend: boolean; blockedReason: string } }>()).data;
    expect(expired.state).toBe('trial_expired');
    expect(expired.canSend).toBe(false);
    expect(expired.blockedReason).toContain('課金プラン');
  });
});

describe('申込（checkout）', () => {
  beforeEach(() => {
    setTenant({ plan_status: 'trialing', trial_ends_at: '2020-01-01T00:00:00.000' });
    stripe.createCustomer.mockResolvedValue({ id: 'cus_1', email: 'masato@example.com', name: '既定の統括' });
    stripe.createCheckoutSession.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1', customer: 'cus_1', subscription: null, client_reference_id: DEFAULT_TENANT_ID });
  });

  it.each(['light', 'standard', 'pro'])('%s を年払いで申し込むと年の Price を選ぶ', async (planKey) => {
    const res = await call('POST', '/api/hq/billing/checkout', { planKey, interval: 'year' });
    expect(res.status).toBe(200);
    expect(stripe.createCheckoutSession.mock.calls[0][1]).toMatchObject({ planKey, priceId: `price_test_${planKey}_year` });
  });

  it('年の Price 未設定は503と案内文、顧客・Checkoutは作らない（月払いは使える）', async () => {
    const opts = { env: { STRIPE_PRICE_LIGHT_YEAR: undefined } };
    const res = await call('POST', '/api/hq/billing/checkout', { planKey: 'light', interval: 'year' }, opts);
    expect(res.status).toBe(503);
    expect((await res.json<{ error: string }>()).error).toBe('このプランの価格がまだ設定されていません。運営にお問い合わせください');
    expect(stripe.createCustomer).not.toHaveBeenCalled();
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
    expect((await call('POST', '/api/hq/billing/checkout', { planKey: 'light', interval: 'month' }, opts)).status).toBe(200);
    expect(stripe.createCheckoutSession.mock.calls[0][1].priceId).toBe('price_light');
  });

  it.each(['week', '', null, 1, {}, []])('不正な周期 %j は400で止める', async (interval) => {
    expect((await call('POST', '/api/hq/billing/checkout', { planKey: 'light', interval })).status).toBe(400);
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
    expect(stripe.createCustomer).not.toHaveBeenCalled();
  });

  it('オーナーがプランを選ぶと、顧客を作って Checkout の URL を返す', async () => {
    const res = await call('POST', '/api/hq/billing/checkout', { planKey: 'standard' });
    expect(res.status).toBe(200);
    expect((await res.json<{ data: { url: string } }>()).data.url).toContain('checkout.stripe.com');
    expect(stripe.createCustomer).toHaveBeenCalledTimes(1);
    const args = stripe.createCheckoutSession.mock.calls[0][1] as { priceId: string; planKey: string; successUrl: string; cancelUrl: string };
    expect(args.priceId).toBe('price_standard');
    expect(args.planKey).toBe('standard');
    expect(args.successUrl).toBe('https://admin.example.com/hq/billing?checkout=success');
    expect(tenantRow().stripe_customer_id).toBe('cus_1');
  });

  it('2回目は顧客を作り直さない', async () => {
    setTenant({ stripe_customer_id: 'cus_existing' });
    await call('POST', '/api/hq/billing/checkout', { planKey: 'light' });
    expect(stripe.createCustomer).not.toHaveBeenCalled();
    expect((stripe.createCheckoutSession.mock.calls[0][1] as { customerId: string }).customerId).toBe('cus_existing');
  });

  it('管理者もプランを申し込める', async () => {
    const res = await call('POST', '/api/hq/billing/checkout', { planKey: 'light' }, { staff: staffOf({ role: 'admin' }) });
    expect(res.status).toBe(200);
    expect(stripe.createCheckoutSession).toHaveBeenCalledTimes(1);
  });

  it('課金対象外・契約中・設定なし・不正なプランは断る', async () => {
    expect((await call('POST', '/api/hq/billing/checkout', { planKey: 'gold' })).status).toBe(400);
    expect((await call('POST', '/api/hq/billing/checkout', { planKey: 'light' }, { env: { STRIPE_SECRET_KEY: undefined } })).status).toBe(503);
    expect((await call('POST', '/api/hq/billing/checkout', { planKey: 'light' }, { env: { STRIPE_PRICE_LIGHT: undefined } })).status).toBe(503);
    setTenant({ plan_status: 'exempt' });
    expect((await call('POST', '/api/hq/billing/checkout', { planKey: 'light' })).status).toBe(409);
    setTenant({ plan_status: 'active', stripe_subscription_id: 'sub_1' });
    expect((await call('POST', '/api/hq/billing/checkout', { planKey: 'light' })).status).toBe(409);
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
  });
});

describe('請求前のカード登録', () => {
  beforeEach(() => {
    setTenant({ plan_status: 'trialing', trial_ends_at: null });
    stripe.createCustomer.mockResolvedValue({ id: 'cus_setup', email: 'masato@example.com', name: '既定の統括' });
    stripe.createCardSetupSession.mockResolvedValue({ id: 'cs_setup', mode: 'setup', url: 'https://checkout.stripe.com/c/setup/cs_setup' });
  });

  it('登録時はsetupモードだけを作り、無料期間と請求を開始しない', async () => {
    const res = await call('POST', '/api/hq/billing/card-setup');
    expect(res.status).toBe(200);
    expect((await res.json<{ data: { url: string } }>()).data.url).toContain('checkout.stripe.com');
    expect(stripe.createCardSetupSession).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      customerId: 'cus_setup', tenantId: DEFAULT_TENANT_ID,
      successUrl: 'https://admin.example.com/hq/onboarding/card?setup=success',
    }));
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
    expect(tenantRow()).toMatchObject({ plan_status: 'trialing', trial_ends_at: null, stripe_subscription_id: null, stripe_customer_id: 'cus_setup' });
  });

  it('同時に別画面がStripe顧客を確定した場合は、その顧客でカード登録する', async () => {
    stripe.createCustomer.mockImplementationOnce(async () => {
      setTenant({ stripe_customer_id: 'cus_winner' });
      return { id: 'cus_loser', email: null, name: null };
    });
    const res = await call('POST', '/api/hq/billing/card-setup');
    expect(res.status).toBe(200);
    expect(stripe.createCardSetupSession).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ customerId: 'cus_winner' }));
    expect(tenantRow().stripe_customer_id).toBe('cus_winner');
  });

  it('カード状態はStripeの既定支払い方法の有無だけ返す', async () => {
    setTenant({ stripe_customer_id: 'cus_setup' });
    stripe.retrieveCustomer.mockResolvedValue({ id: 'cus_setup', invoice_settings: { default_payment_method: 'pm_test' } });
    const res = await call('GET', '/api/hq/billing/card-status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { registered: true } });
    expect(JSON.stringify(await (await call('GET', '/api/hq/billing/card-status')).json())).not.toContain('pm_test');
  });

  it('Stripeの戻り先がHTTPSの管理画面originでなければカード登録を開始しない', async () => {
    for (const origin of ['http://admin.example.com', 'https://admin.example.com/other',
      'https://user:pass@admin.example.com', 'https://admin.example.com/?next=other']) {
      expect((await call('POST', '/api/hq/billing/card-setup', undefined, { env: { ADMIN_ORIGIN: origin } })).status)
        .toBe(503);
    }
    expect(stripe.createCustomer).not.toHaveBeenCalled();
    expect(stripe.createCardSetupSession).not.toHaveBeenCalled();
  });
});

describe('ポータルと支払い履歴', () => {
  it('契約前はポータルが無く、履歴は空', async () => {
    expect((await call('POST', '/api/hq/billing/portal')).status).toBe(409);
    const res = await call('GET', '/api/hq/billing/invoices');
    expect((await res.json<{ data: unknown[] }>()).data).toEqual([]);
    expect(stripe.listInvoices).not.toHaveBeenCalled();
  });

  it('契約後はポータルの URL と履歴を返す', async () => {
    setTenant({ stripe_customer_id: 'cus_1', plan_status: 'active', plan_key: 'light' });
    stripe.createPortalSession.mockResolvedValue({ id: 'bps_1', url: 'https://billing.stripe.com/p/session/x' });
    stripe.listInvoices.mockResolvedValue({ data: [{ id: 'in_1', number: 'A-1', status: 'paid', amount_paid: 9800, amount_due: 9800, currency: 'jpy', created: 1_760_000_000, hosted_invoice_url: 'https://invoice', invoice_pdf: 'https://pdf', lines: { data: [{ description: 'ライト' }] } }] });
    expect((await (await call('POST', '/api/hq/billing/portal')).json<{ data: { url: string } }>()).data.url).toContain('billing.stripe.com');
    const invoices = (await (await call('GET', '/api/hq/billing/invoices')).json<{ data: Array<{ amountYen: number; description: string }> }>()).data;
    expect(invoices[0]).toMatchObject({ amountYen: 9800, description: 'ライト' });
  });
});

describe('課金 Webhook', () => {
  const completed = (id = 'evt_1') => ({
    id,
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_1', customer: 'cus_1', subscription: 'sub_1', client_reference_id: DEFAULT_TENANT_ID, metadata: { tenant_id: DEFAULT_TENANT_ID, plan_key: 'standard' } } },
  });

  beforeEach(() => {
    setTenant({ plan_status: 'trialing', trial_ends_at: '2020-01-01T00:00:00.000' });
    stripe.retrieveSubscription.mockResolvedValue({ id: 'sub_1', status: 'active', customer: 'cus_1', current_period_end: 1_760_000_000, items: { data: [{ price: { id: 'price_standard' } }] } });
  });

  it('カードsetup完了通知は契約開始と区別し、Stripeの既定カードだけ更新する', async () => {
    setTenant({ stripe_customer_id: 'cus_setup', plan_status: 'trialing', trial_ends_at: null });
    stripe.retrieveSetupIntent.mockResolvedValue({ id: 'seti_1', status: 'succeeded', customer: 'cus_setup', payment_method: 'pm_setup' });
    const event = { id: 'evt_card_setup_1', type: 'checkout.session.completed', created: 100,
      data: { object: { id: 'cs_setup', mode: 'setup', customer: 'cus_setup', setup_intent: 'seti_1',
        client_reference_id: DEFAULT_TENANT_ID, metadata: { tenant_id: DEFAULT_TENANT_ID, purpose: 'musubo_card_setup' } } } };
    expect((await webhook(event)).status).toBe(200);
    expect(stripe.setCustomerDefaultPaymentMethod).toHaveBeenCalledWith(expect.anything(), 'cus_setup', 'pm_setup');
    expect(tenantRow()).toMatchObject({ plan_status: 'trialing', trial_ends_at: null, stripe_subscription_id: null });
    expect((await webhook(event)).status).toBe(200);
    expect(stripe.setCustomerDefaultPaymentMethod).toHaveBeenCalledTimes(1);
  });

  it('setupの顧客がテナントと違う場合はカードを更新しない', async () => {
    setTenant({ stripe_customer_id: 'cus_right', plan_status: 'trialing', trial_ends_at: null });
    const event = { id: 'evt_card_setup_other', type: 'checkout.session.completed', created: 100,
      data: { object: { id: 'cs_setup', mode: 'setup', customer: 'cus_other', setup_intent: 'seti_1',
        client_reference_id: DEFAULT_TENANT_ID, metadata: { tenant_id: DEFAULT_TENANT_ID, purpose: 'musubo_card_setup' } } } };
    expect((await webhook(event)).status).toBe(200);
    expect(stripe.retrieveSetupIntent).not.toHaveBeenCalled();
    expect(stripe.setCustomerDefaultPaymentMethod).not.toHaveBeenCalled();
    expect(tenantRow().plan_status).toBe('trialing');
  });

  it('SetupIntentが未完了ならWebhookを完了扱いせず、再通知でカードを登録する', async () => {
    setTenant({ stripe_customer_id: 'cus_setup', plan_status: 'trialing', trial_ends_at: null });
    const event = { id: 'evt_card_setup_retry', type: 'checkout.session.completed', created: 100,
      data: { object: { id: 'cs_setup', mode: 'setup', customer: 'cus_setup', setup_intent: 'seti_retry',
        client_reference_id: DEFAULT_TENANT_ID, metadata: { tenant_id: DEFAULT_TENANT_ID, purpose: 'musubo_card_setup' } } } };
    stripe.retrieveSetupIntent.mockResolvedValueOnce({ id: 'seti_retry', status: 'processing', customer: 'cus_setup', payment_method: 'pm_setup' });
    expect((await webhook(event)).status).toBe(500);
    expect(stripe.setCustomerDefaultPaymentMethod).not.toHaveBeenCalled();
    expect(testDb.raw.prepare("SELECT summary FROM billing_events WHERE id='evt_card_setup_retry'").get()).toMatchObject({ summary: 'pending' });

    stripe.retrieveSetupIntent.mockResolvedValueOnce({ id: 'seti_retry', status: 'succeeded', customer: 'cus_setup', payment_method: 'pm_setup' });
    expect((await webhook(event)).status).toBe(200);
    expect(stripe.setCustomerDefaultPaymentMethod).toHaveBeenCalledTimes(1);
    expect(tenantRow()).toMatchObject({ plan_status: 'trialing', trial_ends_at: null, stripe_subscription_id: null });
  });

  it('業務更新が止まった受信は未完了で残り、同じIDで再開する', async () => {
    setTenant({ stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', plan_status: 'past_due' });
    const event = { id: 'evt_retry_atomic', type: 'invoice.paid', created: 200,
      data: { object: { id: 'in_atomic', customer: 'cus_1', subscription: 'sub_1', status: 'paid', amount_paid: 9800 } } };
    testDb.raw.exec("CREATE TRIGGER fail_billing_update BEFORE UPDATE ON tenants BEGIN SELECT RAISE(ABORT, 'injected'); END");
    expect((await webhook(event)).status).toBe(500);
    expect(testDb.raw.prepare("SELECT id FROM billing_invoices WHERE id='in_atomic'").get()).toBeUndefined();
    testDb.raw.exec('DROP TRIGGER fail_billing_update');
    expect((await webhook(event)).status).toBe(200);
    expect(tenantRow().plan_status).toBe('active');
    expect(testDb.raw.prepare("SELECT amount_paid FROM billing_invoices WHERE id='in_atomic'").get()).toMatchObject({ amount_paid: 9800 });
    expect((await (await webhook(event)).json<{data:{duplicate:boolean}}>()).data.duplicate).toBe(true);
  });

  it('完了印の保存失敗でも業務更新を巻き戻し、再通知で一度だけ保存する', async () => {
    setTenant({ stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', plan_status: 'past_due' });
    const event = { id: 'evt_commit_failure', type: 'invoice.paid', data: { object: { id: 'in_commit', customer: 'cus_1', subscription: 'sub_1' } } };
    testDb.raw.exec("CREATE TRIGGER fail_completed_event BEFORE UPDATE ON billing_events BEGIN SELECT RAISE(ABORT, 'injected'); END");
    expect((await webhook(event)).status).toBe(500);
    expect(tenantRow().plan_status).toBe('past_due');
    expect(testDb.raw.prepare("SELECT id FROM billing_invoices WHERE id='in_commit'").get()).toBeUndefined();
    testDb.raw.exec('DROP TRIGGER fail_completed_event');
    const results = await Promise.all([webhook(event), webhook(event)]);
    expect(results.map(r=>r.status)).toEqual([200,200]);
    expect(testDb.raw.prepare("SELECT count(*) AS n FROM billing_events WHERE id='evt_commit_failure'").get()).toEqual({n:1});
    expect(tenantRow().plan_status).toBe('active');
  });

  it('新契約の後に旧契約の取消が来ても契約と削除期限を変えない', async () => {
    setTenant({ stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_new', plan_status: 'active' });
    const before = testDb.raw.prepare('SELECT * FROM tenants WHERE id=?').get(DEFAULT_TENANT_ID);
    expect((await webhook({ id:'evt_old_cancel', type:'customer.subscription.deleted', created:300,
      data:{object:{id:'sub_old',customer:'cus_1',status:'canceled',items:{data:[]}}} })).status).toBe(200);
    expect(testDb.raw.prepare('SELECT * FROM tenants WHERE id=?').get(DEFAULT_TENANT_ID)).toEqual(before);
  });

  it('同じ契約の古い更新と取消を新しい版に適用しない', async () => {
    setTenant({ stripe_customer_id:'cus_1', stripe_subscription_id:'sub_1', plan_status:'active' });
    stripe.retrieveSubscription.mockRejectedValue(new Error('offline'));
    const object={id:'sub_1',customer:'cus_1',status:'active',items:{data:[{price:{id:'price_pro'}}]}};
    expect((await webhook({id:'evt_newer',type:'customer.subscription.updated',created:300,data:{object}})).status).toBe(200);
    expect((await webhook({id:'evt_older',type:'customer.subscription.deleted',created:200,data:{object}})).status).toBe(200);
    expect(tenantRow()).toMatchObject({plan_status:'active',plan_key:'pro'});
    expect((await webhook({id:'evt_canceled',type:'customer.subscription.deleted',created:400,data:{object}})).status).toBe(200);
    expect((await webhook({id:'evt_late_active',type:'customer.subscription.updated',created:350,data:{object}})).status).toBe(200);
    expect(tenantRow().plan_status).toBe('canceled');
  });

  it('古い契約作成通知で取消後の契約を復活させず、新しい再契約だけ受け入れる',async()=>{
    setTenant({stripe_customer_id:'cus_1',stripe_subscription_id:'sub_1',plan_status:'active'});
    const object={id:'sub_1',customer:'cus_1',status:'canceled',items:{data:[]}};
    await webhook({id:'evt_terminal',type:'customer.subscription.deleted',created:500,data:{object}});
    stripe.retrieveSubscription.mockRejectedValue(new Error('offline'));
    await webhook({id:'evt_stale_creation',type:'customer.subscription.created',created:100,data:{object:{...object,id:'sub_older',status:'active'}}});
    expect(tenantRow()).toMatchObject({plan_status:'canceled',stripe_subscription_id:'sub_1'});
    await webhook({id:'evt_recontract',type:'customer.subscription.created',created:600,data:{object:{...object,id:'sub_new',status:'active'}}});
    expect(tenantRow()).toMatchObject({plan_status:'active',stripe_subscription_id:'sub_new'});
    expect(testDb.raw.prepare('SELECT retention_anchor_at FROM tenants WHERE id=?').get(DEFAULT_TENANT_ID)).toEqual({retention_anchor_at:null});
  });

  it('署名が違えば 400、設定が無ければ 503', async () => {
    expect((await webhook(completed(), { secret: 'wrong' })).status).toBe(400);
    expect((await webhook(completed(), { env: { STRIPE_BILLING_WEBHOOK_SECRET: undefined } })).status).toBe(503);
    expect(tenantRow().plan_status).toBe('trialing');
  });

  it.each(['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated'])('%s で年払いを契約中にし、年の更新日をそのまま保存する', async (type) => {
    const end = Math.floor(Date.parse('2027-09-13T00:00:00Z') / 1000);
    const subscription = { id: 'sub_1', status: 'active', customer: 'cus_1', metadata: { plan_key: 'light' },
      items: { data: [{ price: { id: 'price_test_pro_year' }, current_period_end: end }] } };
    setTenant({ stripe_customer_id: 'cus_1' });
    stripe.retrieveSubscription.mockResolvedValue(subscription);
    const event = type === 'checkout.session.completed' ? completed() : { id: 'evt_test_year', type, data: { object: subscription } };
    expect((await webhook(event)).status).toBe(200);
    expect(tenantRow()).toMatchObject({ plan_key: 'pro', plan_status: 'active', current_period_ends_at: '2027-09-13T00:00:00.000Z' });
    const res = await call('GET', '/api/hq/billing/summary');
    expect((await res.json<{ data: Record<string, unknown> }>()).data).toMatchObject({ planInterval: 'year', planKey: 'pro', state: 'active', currentPeriodEndsAt: '2027-09-13T00:00:00.000Z' });
  });

  it('申込が完了すると契約中になり、プランは Stripe の価格から決まる', async () => {
    const res = await webhook(completed());
    expect(res.status).toBe(200);
    expect(tenantRow()).toMatchObject({ plan_status: 'active', plan_key: 'standard', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', trial_ends_at: null });
  });

  it('Checkout完了後に契約を確認できない間は有効化せず、再通知で確認してから進める', async () => {
    stripe.retrieveSubscription.mockRejectedValueOnce(new Error('Stripe temporarily unavailable'));
    expect((await webhook(completed('evt_retry_checkout'))).status).toBe(503);
    expect(tenantRow()).toMatchObject({ plan_status: 'trialing', stripe_subscription_id: null });
    expect(testDb.raw.prepare("SELECT summary FROM billing_events WHERE id='evt_retry_checkout'").get())
      .toEqual({ summary: 'pending' });
    expect((await webhook(completed('evt_retry_checkout'))).status).toBe(200);
    expect(tenantRow()).toMatchObject({ plan_status: 'active', stripe_subscription_id: 'sub_1' });
  });

  it('Checkout通知と取得した契約の顧客が違えば有効化しない', async () => {
    stripe.retrieveSubscription.mockResolvedValueOnce({ id: 'sub_1', status: 'active', customer: 'cus_other',
      items: { data: [{ price: { id: 'price_standard' } }] } });
    expect((await webhook(completed('evt_wrong_customer'))).status).toBe(503);
    expect(tenantRow()).toMatchObject({ plan_status: 'trialing', stripe_subscription_id: null });
  });

  it('active のあとに incomplete の作成通知が届いても契約中を保つ', async () => {
    await webhook(completed());
    stripe.retrieveSubscription.mockRejectedValueOnce(new Error('temporary Stripe failure'));

    await webhook({
      id: 'evt_incomplete_after_active',
      type: 'customer.subscription.created',
      data: { object: { id: 'sub_1', status: 'incomplete', customer: 'cus_1', items: { data: [{ price: { id: 'price_standard' } }] } } },
    });

    expect(tenantRow()).toMatchObject({ plan_status: 'active', plan_key: 'standard', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' });
  });

  it('作成通知が incomplete でも Stripe の現在値が active なら契約中にする', async () => {
    setTenant({ stripe_customer_id: 'cus_1' });
    stripe.retrieveSubscription.mockResolvedValueOnce({
      id: 'sub_1',
      status: 'active',
      customer: 'cus_1',
      current_period_end: 1_760_000_000,
      items: { data: [{ price: { id: 'price_standard' } }] },
    });

    await webhook({
      id: 'evt_retrieve_active',
      type: 'customer.subscription.created',
      data: { object: { id: 'sub_1', status: 'incomplete', customer: 'cus_1', items: { data: [{ price: { id: 'price_standard' } }] } } },
    });

    expect(stripe.retrieveSubscription).toHaveBeenCalledWith(expect.anything(), 'sub_1');
    expect(tenantRow()).toMatchObject({ plan_status: 'active', plan_key: 'standard' });
  });

  it('明細の current_period_end から次回更新日を記録する', async () => {
    setTenant({ stripe_customer_id: 'cus_1' });
    stripe.retrieveSubscription.mockResolvedValueOnce({
      id: 'sub_1',
      status: 'active',
      customer: 'cus_1',
      items: { data: [{ price: { id: 'price_standard' }, current_period_end: 1_760_000_000 }] },
    });

    await webhook({
      id: 'evt_item_period_end',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_1', status: 'active', customer: 'cus_1', items: { data: [{ price: { id: 'price_standard' } }] } } },
    });

    expect(tenantRow().current_period_ends_at).toBe(new Date(1_760_000_000 * 1000).toISOString());
  });

  it('同じイベントは二度処理しない', async () => {
    await webhook(completed());
    stripe.retrieveSubscription.mockClear();
    const res = await webhook(completed());
    expect((await res.json<{ data: { duplicate: boolean } }>()).data.duplicate).toBe(true);
    expect(stripe.retrieveSubscription).not.toHaveBeenCalled();
  });

  it('解約・支払い失敗・支払い成功で状態が動く', async () => {
    await webhook(completed());
    const invoice = { id: 'in_1', customer: 'cus_1', subscription: 'sub_1', amount_due: 5900, amount_paid: 0, currency: 'jpy' };
    await webhook({ id: 'evt_2', type: 'invoice.payment_failed', data: { object: invoice } });
    expect(tenantRow().plan_status).toBe('past_due');
    await webhook({ id: 'evt_subscription_active', type: 'customer.subscription.updated', data: { object: {
      id: 'sub_1', status: 'active', customer: 'cus_1', items: { data: [{ price: { id: 'price_standard' } }] },
    } } });
    expect(tenantRow().plan_status).toBe('past_due');
    await webhook({ id: 'evt_other_paid', type: 'invoice.paid', data: { object: {
      ...invoice, id: 'in_2', status: 'paid', amount_paid: 5900,
    } } });
    expect(tenantRow().plan_status).toBe('past_due');
    expect(testDb.raw.prepare("SELECT json_extract(summary,'$.applied') AS applied FROM billing_events WHERE id='evt_other_paid'").get())
      .toEqual({ applied: 0 });
    await webhook({ id: 'evt_3', type: 'invoice.paid', data: { object: { ...invoice, status: 'paid', amount_paid: 5900 } } });
    expect(tenantRow().plan_status).toBe('active');
    expect(testDb.raw.prepare("SELECT json_extract(summary,'$.applied') AS applied FROM billing_events WHERE id='evt_3'").get())
      .toEqual({ applied: 1 });
    await webhook({ id: 'evt_late_failure', type: 'invoice.payment_failed', data: { object: invoice } });
    expect(tenantRow().plan_status).toBe('active');
    expect(testDb.raw.prepare("SELECT status FROM billing_invoices WHERE id='in_1'").get()).toMatchObject({ status: 'paid' });
    await webhook({ id: 'evt_4', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', status: 'canceled', customer: 'cus_1', items: { data: [{ price: { id: 'price_standard' } }] } } } });
    expect(tenantRow().plan_status).toBe('canceled');
    const summary = (await (await call('GET', '/api/hq/billing/summary')).json<{ data: { canSend: boolean; state: string } }>()).data;
    expect(summary).toMatchObject({ state: 'canceled', canSend: false });
  });

  it('同じStripe顧客の単発請求では契約の停止や再開をしない', async () => {
    setTenant({ stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', plan_status: 'active' });
    const standalone = { id: 'in_standalone', customer: 'cus_1', subscription: null,
      amount_due: 5_900, amount_paid: 0, currency: 'jpy' };
    await webhook({ id: 'evt_standalone_failed', type: 'invoice.payment_failed',
      data: { object: standalone } });
    expect(tenantRow().plan_status).toBe('active');
    expect(testDb.raw.prepare("SELECT json_extract(summary,'$.applied') AS applied FROM billing_events WHERE id='evt_standalone_failed'").get())
      .toEqual({ applied: 0 });

    setTenant({ plan_status: 'past_due' });
    await webhook({ id: 'evt_standalone_paid', type: 'invoice.paid',
      data: { object: { ...standalone, status: 'paid', amount_paid: 5_900 } } });
    expect(tenantRow().plan_status).toBe('past_due');
    expect(testDb.raw.prepare("SELECT json_extract(summary,'$.applied') AS applied FROM billing_events WHERE id='evt_standalone_paid'").get())
      .toEqual({ applied: 0 });
  });

  it('請求失敗の7日後は利用を停止し、未払い請求の支払い先は権限者だけに返す', async () => {
    const failedAt = Math.floor(Date.now() / 1000) - 8 * 24 * 60 * 60;
    setTenant({ stripe_customer_id: 'cus_grace', stripe_subscription_id: 'sub_grace', plan_status: 'active', plan_key: 'light' });
    const invoice = {
      id: 'in_grace', customer: 'cus_grace', subscription: 'sub_grace', created: failedAt - 24 * 60 * 60,
      amount_due: 5900, amount_paid: 0, currency: 'jpy', status: 'open',
      hosted_invoice_url: 'https://invoice.stripe.com/i/test_grace',
    };
    expect((await webhook({ id: 'evt_grace_failed', type: 'invoice.payment_failed', created: failedAt,
      data: { object: invoice } })).status).toBe(200);
    const summary = (await (await call('GET', '/api/hq/billing/summary')).json<{ data: {
      state: string; canSend: boolean; canGenerate: boolean; paymentFailure: Record<string, unknown>;
    } }>()).data;
    expect(summary).toMatchObject({ state: 'payment_suspended', canSend: false, canGenerate: false,
      paymentFailure: { state: 'suspended' } });
    expect(summary.paymentFailure).not.toHaveProperty('paymentUrl');
    const detail = (await (await call('GET', '/api/hq/billing/payment-failure')).json<{ data: {
      amountYen: number; paymentUrl: string;
    } }>()).data;
    expect(detail).toMatchObject({ amountYen: 5900, paymentUrl: invoice.hosted_invoice_url });
    expect((await call('GET', '/api/hq/billing/payment-failure', undefined,
      { staff: staffOf({ role: 'staff' }) })).status).toBe(403);

    expect((await webhook({ id: 'evt_grace_paid', type: 'invoice.paid', created: failedAt + 10,
      data: { object: { ...invoice, status: 'paid', amount_paid: 5900 } } })).status).toBe(200);
    expect((await (await call('GET', '/api/hq/billing/summary')).json<{ data: {
      state: string; canSend: boolean; paymentFailure: unknown;
    } }>()).data).toMatchObject({ state: 'active', canSend: true, paymentFailure: null });
  });

  it('入金済み請求書の金額・入金日・年払いを保存し、同じイベントは増やさない', async () => {
    setTenant({ stripe_customer_id: 'cus_1', plan_status: 'past_due' });
    const paid = {
      id: 'evt_invoice_paid',
      type: 'invoice.paid',
      data: { object: {
        id: 'in_paid', customer: 'cus_1', subscription: 'sub_1', status: 'paid',
        amount_paid: 99_000, amount_due: 99_000, amount_remaining: 0, currency: 'jpy',
        created: 1_760_000_000, period_start: 1_760_000_000, period_end: 1_791_536_000,
        status_transitions: { paid_at: 1_760_000_100 }, hosted_invoice_url: 'https://invoice.example.test/in_paid',
        lines: { data: [{ description: 'ライト年払い', price: { recurring: { interval: 'year' } } }] },
      } },
    };
    expect((await webhook(paid)).status).toBe(200);
    expect((await webhook(paid)).status).toBe(200);
    const rows = testDb.raw.prepare(`SELECT * FROM billing_invoices WHERE id = 'in_paid'`).all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant_id: DEFAULT_TENANT_ID,
      status: 'paid',
      amount_paid: 99_000,
      amount_due: 99_000,
      interval: 'year',
      stripe_customer_id: 'cus_1',
      subscription_id: 'sub_1',
    });
    expect(String(rows[0]?.paid_at)).toMatch(/\+09:00$/);
    expect(tenantRow().plan_status).toBe('active');
  });

  it('支払い失敗・無効化・返金を請求書へ反映する', async () => {
    setTenant({ stripe_customer_id: 'cus_1', plan_status: 'active' });
    const invoice = {
      id: 'in_status', customer: 'cus_1', subscription: 'sub_1', amount_paid: 29_800,
      amount_due: 29_800, amount_remaining: 29_800, currency: 'jpy', created: 1_760_000_000,
      period_start: 1_760_000_000, period_end: 1_762_592_000, hosted_invoice_url: null, lines: { data: [] },
    };
    await webhook({ id: 'evt_failed', type: 'invoice.payment_failed', data: { object: invoice } });
    expect(testDb.raw.prepare(`SELECT status, amount_due FROM billing_invoices WHERE id = 'in_status'`).get()).toMatchObject({ status: 'open', amount_due: 29_800 });
    await webhook({ id: 'evt_void', type: 'invoice.voided', data: { object: invoice } });
    expect(testDb.raw.prepare(`SELECT status FROM billing_invoices WHERE id = 'in_status'`).get()).toMatchObject({ status: 'void' });
    await webhook({ id: 'evt_paid_again', type: 'invoice.paid', data: { object: { ...invoice, status: 'paid', status_transitions: { paid_at: 1_760_000_100 } } } });
    await webhook({ id: 'evt_refund', type: 'charge.refunded', data: { object: { id: 'ch_1', customer: 'cus_1', invoice: 'in_status', amount_refunded: 4_000 } } });
    expect(testDb.raw.prepare(`SELECT status, amount_refunded FROM billing_invoices WHERE id = 'in_status'`).get()).toMatchObject({ status: 'paid', amount_refunded: 4_000 });
  });

  it('統括IDが一致しても別のStripe顧客の請求書は取り込まない', async () => {
    setTenant({ stripe_customer_id: 'cus_1', plan_status: 'active' });
    const res = await webhook({ id: 'evt_wrong_invoice_customer', type: 'invoice.payment_failed',
      data: { object: { id: 'in_wrong_customer', customer: 'cus_other', subscription: 'sub_other',
        metadata: { tenant_id: DEFAULT_TENANT_ID }, amount_due: 5900, amount_paid: 0,
        currency: 'jpy', created: 1_760_000_000, lines: { data: [] } } } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { matched: false } });
    expect(tenantRow().plan_status).toBe('active');
    expect(testDb.raw.prepare("SELECT COUNT(*) AS n FROM billing_invoices WHERE id='in_wrong_customer'").get())
      .toEqual({ n: 0 });
  });

  it('Stripe顧客が未登録の統括にも、メタデータだけで請求書を結び付けない', async () => {
    setTenant({ stripe_customer_id: null, plan_status: 'active' });
    const res = await webhook({ id: 'evt_unbound_invoice_customer', type: 'invoice.payment_failed',
      data: { object: { id: 'in_unbound_customer', customer: 'cus_other', subscription: 'sub_other',
        metadata: { tenant_id: DEFAULT_TENANT_ID }, amount_due: 5900, amount_paid: 0,
        currency: 'jpy', created: 1_760_000_000, lines: { data: [] } } } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { matched: false } });
    expect(tenantRow().plan_status).toBe('active');
    expect(testDb.raw.prepare("SELECT COUNT(*) AS n FROM billing_invoices WHERE id='in_unbound_customer'").get())
      .toEqual({ n: 0 });
  });

  it('請求書のないEC-CUBE返金は対象外として記録し、請求書を変更しない', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const res = await webhook({
      id: 'evt_ec_refund',
      type: 'charge.refunded',
      data: { object: { id: 'ch_ec', customer: 'cus_ec', invoice: null, amount_refunded: 2_530 } },
    });

    expect(res.status).toBe(200);
    expect(await res.json<{ data: { matched: boolean } }>()).toMatchObject({ data: { matched: false } });
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM billing_invoices').get()).toMatchObject({ n: 0 });
    expect(info.mock.calls.map(([raw]) => JSON.parse(String(raw)))).toContainEqual({ code: 'routes_hq_billing_info', timestamp: expect.any(String), level: 'info', requestId: null, invocationId: null, source: 'background' });
  });

  it('invoiceが無くpayment_intentのみのEC-CUBE返金でも、Billing請求書のPaymentIntentならStripeに問い合わせて反映する', async () => {
    setTenant({ stripe_customer_id: 'cus_1' });
    testDb.raw.prepare(
      `INSERT INTO billing_invoices (id, tenant_id, status, amount_paid, amount_due, amount_refunded, currency, synced_at, created_at)
       VALUES ('in_pi_test', ?, 'paid', 4_000, 4_000, 0, 'jpy', '2026-09-27T00:00:00+09:00', '2026-09-27T00:00:00+09:00')`,
    ).run(DEFAULT_TENANT_ID);
    stripe.retrievePaymentIntent.mockResolvedValue({ id: 'pi_test', invoice: 'in_pi_test' });

    const res = await webhook({
      id: 'evt_pi_refund',
      type: 'charge.refunded',
      data: { object: { id: 'ch_pi', customer: 'cus_1', invoice: null, payment_intent: 'pi_test', amount_refunded: 4_000 } },
    });

    expect(res.status).toBe(200);
    expect(stripe.retrievePaymentIntent).toHaveBeenCalledWith(expect.anything(), 'pi_test');
    expect(testDb.raw.prepare(`SELECT amount_refunded FROM billing_invoices WHERE id = 'in_pi_test'`).get()).toMatchObject({ amount_refunded: 4_000 });
  });

  it('返金の請求書照合に失敗した通知を完了にせず、同じIDで再開する',async()=>{
    setTenant({stripe_customer_id:'cus_1'});
    testDb.raw.prepare("INSERT INTO billing_invoices(id,tenant_id,status,amount_paid,amount_due,amount_refunded,currency,synced_at,created_at) VALUES('in_lookup',?,'paid',4000,4000,0,'jpy','2026-10-01','2026-10-01')").run(DEFAULT_TENANT_ID);
    const event={id:'evt_lookup_failure',type:'charge.refunded',data:{object:{id:'ch_lookup',customer:'cus_1',payment_intent:'pi_lookup',amount_refunded:4000}}};
    stripe.retrievePaymentIntent.mockRejectedValueOnce(new Error('offline'));
    expect((await webhook(event)).status).toBe(500);
    stripe.retrievePaymentIntent.mockResolvedValueOnce({id:'pi_lookup',invoice:'in_lookup'});
    expect((await webhook(event)).status).toBe(200);
    expect(testDb.raw.prepare("SELECT amount_refunded FROM billing_invoices WHERE id='in_lookup'").get()).toEqual({amount_refunded:4000});
  });

  it('payment_intentがあっても請求書に紐付かなければ対象外として記録する（Stripe未設定時は問い合わせない）', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const res = await webhook({
      id: 'evt_pi_no_invoice',
      type: 'charge.refunded',
      data: { object: { id: 'ch_ec2', customer: 'cus_ec2', invoice: null, payment_intent: 'pi_ec', amount_refunded: 1_200 } },
    }, { env: { STRIPE_SECRET_KEY: undefined } });

    expect(res.status).toBe(200);
    expect(stripe.retrievePaymentIntent).not.toHaveBeenCalled();
    expect(info.mock.calls.map(([raw]) => JSON.parse(String(raw)))).toContainEqual({ code: 'routes_hq_billing_info', timestamp: expect.any(String), level: 'info', requestId: null, invocationId: null, source: 'background' });
  });

  it('請求書IDがあっても更新対象がなければ警告する', async () => {
    setTenant({ stripe_customer_id: 'cus_1' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await webhook({
      id: 'evt_missing_invoice_refund',
      type: 'charge.refunded',
      data: { object: { id: 'ch_missing', customer: 'cus_1', invoice: 'in_missing', amount_refunded: 1_000 } },
    });

    expect(res.status).toBe(200);
    expect(warn.mock.calls.map(([raw]) => JSON.parse(String(raw)))).toContainEqual({ code: 'routes_hq_billing_warn', timestamp: expect.any(String), level: 'warn', requestId: null, invocationId: null, source: 'background' });
  });

  it('知らない顧客の請求書はイベントだけ記録し、請求書行は作らない', async () => {
    const res = await webhook({ id: 'evt_unknown_invoice', type: 'invoice.paid', data: { object: { id: 'in_unknown', customer: 'cus_unknown', amount_paid: 9_800, amount_due: 9_800, currency: 'jpy' } } });
    expect((await res.json<{ data: { matched: boolean } }>()).data.matched).toBe(false);
    expect(testDb.raw.prepare(`SELECT COUNT(*) AS n FROM billing_invoices WHERE id = 'in_unknown'`).get()).toMatchObject({ n: 0 });
  });

  it('知らない顧客のイベントは受け取るだけで何も変えない', async () => {
    const res = await webhook({ id: 'evt_9', type: 'customer.subscription.updated', data: { object: { id: 'sub_x', status: 'active', customer: 'cus_unknown', items: { data: [] } } } });
    expect((await res.json<{ data: { matched: boolean } }>()).data.matched).toBe(false);
    expect(tenantRow().plan_status).toBe('trialing');
  });
});


describe('即時変更の日割り見積り', () => {
  const path = '/api/hq/billing/preview?planKey=standard&interval=month';
  beforeEach(() => {
    setTenant({ plan_key: 'light', plan_status: 'active', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' });
    stripe.retrieveSubscription.mockResolvedValue({ id: 'sub_1', customer: 'cus_1', status: 'active', items: { data: [{ id: 'si_1', quantity: 1, price: { id: 'price_light' } }] } });
    stripe.retrievePrice.mockImplementation(async (_env, id) => ({ unit_amount: id.endsWith('_year') ? 303000 : 30300, currency: 'jpy', recurring: { interval: id.endsWith('_year') ? 'year' : 'month' } }));
    stripe.createInvoicePreview.mockImplementation(async (_env, input) => ({
      currency: 'jpy', amount_due: 40400, lines: { has_more: false, data: [
        { amount: -5000, proration: true, period: { start: input.prorationDate } },
        { amount: 15100, proration: true, period: { start: input.prorationDate } },
        { amount: 700, proration: true, period: { start: input.prorationDate - 1 } },
        { amount: 30300, proration: false, type: 'subscription', subscription_item: 'si_1', period: { start: 1790812800 } },
      ] },
    }));
  });
  it('現在の時刻で参考額を読み、過去の日割り明細を除き、契約を変更しない', async () => {
    const before = tenantRow();
    const now = Math.floor(Date.now() / 1000);
    const res = await call('GET', path);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { data } = await res.json<{ data: Record<string, unknown> }>();
    expect(data).toMatchObject({ afterAmountYen: 30300, amountDueYen: 40400, prorationDifferenceYen: 10100, isEstimate: true, nextBillingAt: new Date(1790812800 * 1000).toISOString() });
    expect(stripe.createInvoicePreview.mock.calls[0][1]).toMatchObject({ subscriptionId: 'sub_1', itemId: 'si_1', priceId: 'price_standard', quantity: 1 });
    expect(stripe.createInvoicePreview.mock.calls[0][1].prorationDate).toBeGreaterThanOrEqual(now);
    expect(tenantRow()).toEqual(before);
    expect(stripe.createCustomer).not.toHaveBeenCalled();
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
  });
  it('年払いの価格を使い、マイナスの差額も返す', async () => {
    stripe.createInvoicePreview.mockImplementationOnce(async (_env, input) => ({ currency: 'jpy', amount_due: 0, lines: { has_more: false, data: [{ amount: -1000, proration: true, period: { start: input.prorationDate } }] } }));
    const res = await call('GET', path.replace('month', 'year'));
    expect((await res.json<{ data: Record<string, unknown> }>()).data).toMatchObject({ afterAmountYen: 303000, prorationDifferenceYen: -1000, nextBillingAt: null });
  });
  it('管理者も日割り見積りを確認できる', async () => {
    expect((await call('GET', path, undefined, { staff: staffOf({ role: 'admin' }) })).status).toBe(200);
    expect(stripe.createInvoicePreview).toHaveBeenCalledTimes(1);
  });
  it('担当者は日割り見積りを確認できない', async () => {
    expect((await call('GET', path, undefined, { staff: staffOf({ role: 'staff' }) })).status).toBe(403);
    expect(stripe.createInvoicePreview).not.toHaveBeenCalled();
  });
  it('未認証、設定なし、不正入力、契約なしを外部呼び出し前に拒否する', async () => {
    expect((await call('GET', path, undefined, { staff: null })).status).toBe(403);
    expect((await call('GET', path, undefined, { env: { STRIPE_SECRET_KEY: undefined } })).status).toBe(503);
    expect((await call('GET', path, undefined, { env: { STRIPE_PRICE_STANDARD: undefined } })).status).toBe(503);
    expect((await call('GET', path.replace('month', 'week'))).status).toBe(400);
    expect((await call('GET', path.replace('standard', 'other'))).status).toBe(400);
    setTenant({ stripe_subscription_id: null });
    expect((await call('GET', path)).status).toBe(409);
    expect(stripe.createInvoicePreview).not.toHaveBeenCalled();
  });
  it('自分の統括の契約だけを読む', async () => {
    expect((await call('GET', path, undefined, { staff: staffOf({ tenantId: 'other' }) })).status).toBe(404);
    expect(stripe.retrieveSubscription).not.toHaveBeenCalled();
  });
  it('外部失敗や不完全な明細は金額を作らず502にする', async () => {
    stripe.createInvoicePreview.mockRejectedValueOnce(new Error('secret details'));
    const failed = await call('GET', path);
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain('secret details');
    stripe.createInvoicePreview.mockResolvedValueOnce({ currency: 'jpy', lines: { has_more: true, data: [] } });
    expect((await call('GET', path)).status).toBe(502);
  });
});

type StoredBillingMetrics = NonNullable<Awaited<ReturnType<typeof import('../features/hq-billing/hq-billing-metrics.js').hqBillingMetrics>>>;
describe('統括の請求の数の帯（保存済み請求のみ）',()=>{
  it('今月の額・未払いと組織単位の契約を、他組織と分けて返す',async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-30T15:00:00Z'));
    try {
      setTenant({plan_status:'active',stripe_subscription_id:'sub-test',current_period_ends_at:'2026-11-01T00:00:00+09:00'});
      testDb.raw.prepare("INSERT INTO line_accounts(id,name,channel_id,channel_access_token,channel_secret,tenant_id) VALUES ('local','Local','local','test','test',?)").run(DEFAULT_TENANT_ID);
      testDb.raw.exec("INSERT INTO tenants(id,name) VALUES ('other','Other')");
      for(const [id,tenant,at,amount,status] of [['old',DEFAULT_TENANT_ID,'2026-09-01 00:00:00',900,'paid'],['new',DEFAULT_TENANT_ID,'2026-09-30T15:00:00Z',29800,'open'],['foreign','other','2026-10-01 00:00:00',99999,'open']])testDb.raw.prepare("INSERT INTO billing_invoices(id,tenant_id,created_at,amount_due,status,currency,synced_at) VALUES (?,?,?,?,?,'jpy','2026-10-01 00:00:00')").run(id,tenant,at,amount,status);
      const r=await call('GET','/api/hq/billing/metrics');expect(r.status).toBe(200);const b=await r.json() as {data:StoredBillingMetrics};
      expect(b.data).toMatchObject({thisMonthBilledYen:29800,contractCount:1,contractUnit:'organization',activeAccountCount:1,contractAccountCount:null,trialCount:0,unpaidInvoiceCount:1,paymentFailureCount:null,nextBillingAt:'2026-11-01T00:00:00+09:00'});
      expect(stripe.retrievePrice).not.toHaveBeenCalled();expect(stripe.retrieveSubscription).not.toHaveBeenCalled();
    } finally {vi.useRealTimers()}
  });
  it('請求の未取得は0で埋めず、アカウント限定とスタッフ権限は拒否する',async()=>{
    const r=await call('GET','/api/hq/billing/metrics');const b=await r.json() as {data:StoredBillingMetrics};expect(b.data).toMatchObject({thisMonthBilledYen:null,unpaidInvoiceCount:null,unavailable:{invoices:'NOT_SYNCED'}});
    testDb.raw.prepare("INSERT INTO billing_invoices(id,tenant_id,created_at,status,amount_due,amount_paid,currency,synced_at) VALUES ('past-only',?,'2020-01-01','paid',100,100,'jpy','2020-01-01')").run(DEFAULT_TENANT_ID);
    expect((await (await call('GET','/api/hq/billing/metrics')).json() as {data:StoredBillingMetrics}).data).toMatchObject({thisMonthBilledYen:null,unavailable:{thisMonthBilledYen:'NOT_OBSERVED_THIS_MONTH'}});
    setTenant({plan_status:'active',stripe_subscription_id:null});
    expect((await (await call('GET','/api/hq/billing/metrics')).json() as {data:StoredBillingMetrics}).data.contractCount).toBe(1);
    expect((await call('GET','/api/hq/billing/metrics',undefined,{staff:staffOf({role:'staff'})})).status).toBe(403);
    testDb.raw.exec("UPDATE staff_members SET account_scope='accounts' WHERE id='staff-1'");expect((await call('GET','/api/hq/billing/metrics')).status).toBe(403);
  });
});
