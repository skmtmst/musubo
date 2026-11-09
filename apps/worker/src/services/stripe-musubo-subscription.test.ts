import { expect, it } from 'vitest';
import { stripeApi, type MusuboSubscriptionInput } from './stripe-api.js';

const input: MusuboSubscriptionInput = {
  customerId: 'cus_test', tenantId: 'tenant-1', productId: 'prod_core', purpose: 'core',
  interval: 'year', unitAmountYen: 63_720, firstChargeDateJst: '2027-02-08',
  idempotencyKey: 'musubo-tenant-1-core-first-line',
};

it('年払い基本料金を税込の単独契約で作り、無料期間終了前に請求しない', async () => {
  let request: { url: string; body: URLSearchParams; headers: Headers } | null = null;
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    request = { url: String(url), body: new URLSearchParams(String(init?.body)), headers: new Headers(init?.headers) };
    return Response.json({ id: 'sub_core', customer: input.customerId, status: 'trialing',
      items: { data: [] } });
  };
  const result = await stripeApi.createMusuboSubscription({ STRIPE_SECRET_KEY: 'sk_test_example' },
    input, fakeFetch as typeof fetch);
  expect(result.id).toBe('sub_core');
  expect(request).not.toBeNull();
  const sent = request!;
  expect(sent.url).toBe('https://api.stripe.com/v1/subscriptions');
  expect(sent.headers.get('Stripe-Version')).toBe('2024-06-20');
  expect(sent.headers.get('Idempotency-Key')).toBe(input.idempotencyKey);
  expect(sent.body.get('customer')).toBe(input.customerId);
  expect(sent.body.get('trial_end')).toBe(String(Date.parse('2027-02-08T00:00:00+09:00') / 1000));
  expect(sent.body.get('items[0][price_data][unit_amount]')).toBe('63720');
  expect(sent.body.get('items[0][price_data][recurring][interval]')).toBe('year');
  expect(sent.body.get('items[0][price_data][tax_behavior]')).toBe('inclusive');
  expect(sent.body.get('metadata[purpose]')).toBe('musubo_core');
  expect(sent.body.get('trial_settings[end_behavior][missing_payment_method]')).toBe('create_invoice');
  expect(sent.body.has('coupon')).toBe(false);
});

it('月払いオプションを別契約にし、無い場合は0円を許容する', async () => {
  let body = new URLSearchParams();
  const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
    body = new URLSearchParams(String(init?.body));
    return Response.json({ id: 'sub_options', customer: input.customerId, status: 'trialing',
      items: { data: [] } });
  };
  await stripeApi.createMusuboSubscription({ STRIPE_SECRET_KEY: 'sk_test_example' }, {
    ...input, productId: 'prod_options', purpose: 'options', interval: 'month',
    unitAmountYen: 0, idempotencyKey: 'musubo-tenant-1-options-first-line',
  }, fakeFetch as typeof fetch);
  expect(body.get('items[0][price_data][unit_amount]')).toBe('0');
  expect(body.get('items[0][price_data][recurring][interval]')).toBe('month');
  expect(body.get('metadata[purpose]')).toBe('musubo_options');
});

it('不正な金額やStripe商品IDは送信前に止める', async () => {
  let called = false;
  const fakeFetch = async () => { called = true; return Response.json({}); };
  expect(() => stripeApi.createMusuboSubscription({ STRIPE_SECRET_KEY: 'sk_test_example' }, {
    ...input, unitAmountYen: -1,
  }, fakeFetch as typeof fetch)).toThrow(RangeError);
  expect(() => stripeApi.createMusuboSubscription({ STRIPE_SECRET_KEY: 'sk_test_example' }, {
    ...input, productId: 'wrong',
  }, fakeFetch as typeof fetch)).toThrow(RangeError);
  expect(called).toBe(false);
});

it('利用終了の予約と即時停止で日割り・追加請求を作らない', async () => {
  const sent: Array<{ method: string; body: URLSearchParams }> = [];
  const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push({ method: String(init?.method), body: new URLSearchParams(String(init?.body)) });
    return Response.json({ id: 'sub_core', customer: 'cus_test', status: 'canceled',
      items: { data: [] } });
  };
  const env = { STRIPE_SECRET_KEY: 'sk_test_example' };
  await stripeApi.scheduleMusuboTermination(env, 'sub_core', 1800000000,
    'end-scheduled', fakeFetch as typeof fetch);
  await stripeApi.cancelMusuboSubscription(env, 'sub_core',
    'end-now', fakeFetch as typeof fetch);
  expect(sent[0].method).toBe('POST');
  expect(sent[0].body.get('cancel_at')).toBe('1800000000');
  expect(sent[0].body.get('proration_behavior')).toBe('none');
  expect(sent[1].method).toBe('DELETE');
  expect(sent[1].body.get('invoice_now')).toBe('false');
  expect(sent[1].body.get('prorate')).toBe('false');
});

it('再開時の支払い済み期間を元の請求日まで引き継ぐ', async () => {
  let body = new URLSearchParams();
  const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
    body = new URLSearchParams(String(init?.body));
    return Response.json({ id: 'sub_new', customer: 'cus_test', status: 'trialing', items: { data: [] } });
  };
  await stripeApi.createMusuboResumptionSubscription({ STRIPE_SECRET_KEY: 'sk_test_example' }, {
    customerId: 'cus_test', tenantId: 'tenant-1', productId: 'prod_core', purpose: 'core',
    interval: 'month', unitAmountYen: 5_900, generation: 2,
    chargeAtEpoch: 1800000000, idempotencyKey: 'resume-2-core',
  }, fakeFetch as typeof fetch);
  expect(body.get('trial_end')).toBe('1800000000');
  expect(body.get('metadata[resumption_generation]')).toBe('2');
  expect(body.get('payment_behavior')).toBe('default_incomplete');
});

it('支払い済み期間終了後の再開は即時決済に失敗したら契約を進めない', async () => {
  let body = new URLSearchParams();
  const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
    body = new URLSearchParams(String(init?.body));
    return Response.json({ id: 'sub_new', customer: 'cus_test', status: 'active', items: { data: [] } });
  };
  await stripeApi.createMusuboResumptionSubscription({ STRIPE_SECRET_KEY: 'sk_test_example' }, {
    customerId: 'cus_test', tenantId: 'tenant-1', productId: 'prod_core', purpose: 'core',
    interval: 'month', unitAmountYen: 5_900, generation: 3,
    idempotencyKey: 'resume-3-core',
  }, fakeFetch as typeof fetch);
  expect(body.has('trial_end')).toBe(false);
  expect(body.get('payment_behavior')).toBe('error_if_incomplete');
});
