import { expect, it } from 'vitest';
import type { MusuboSubscriptionInput, StripeSubscription } from './stripe-api.js';
import { ensureMusuboSubscription, findMusuboSubscription } from './musubo-subscription-reconciliation.js';

const input: MusuboSubscriptionInput = {
  customerId: 'cus_test', tenantId: 'tenant-1', productId: 'prod_core', purpose: 'core',
  interval: 'year', unitAmountYen: 63_720, firstChargeDateJst: '2027-02-08',
  idempotencyKey: 'musubo-tenant-1-core-first-line',
};
const subscription: StripeSubscription = {
  id: 'sub_existing', customer: input.customerId, status: 'trialing',
  metadata: { tenant_id: input.tenantId, purpose: 'musubo_core' },
  trial_end: Date.parse('2027-02-08T00:00:00+09:00') / 1000,
  items: { data: [{ price: { id: 'price_core', product: input.productId,
    unit_amount: input.unitAmountYen, currency: 'jpy', tax_behavior: 'inclusive',
    recurring: { interval: 'year' } } }] },
};
const env = { STRIPE_SECRET_KEY: 'sk_test_example' };

it('結果不明の再試行では既存契約を照合し、二重作成しない', async () => {
  const methods: string[] = [];
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    methods.push(init?.method ?? 'GET');
    expect(String(url)).toContain('customer=cus_test');
    return Response.json({ data: [subscription], has_more: false });
  };
  const result = await ensureMusuboSubscription(env, input, fakeFetch as typeof fetch);
  expect(result.id).toBe('sub_existing');
  expect(methods).toEqual(['GET']);
});

it('既存契約がないときだけ同じ冪等キーで作成する', async () => {
  const methods: string[] = [];
  const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
    methods.push(init?.method ?? 'GET');
    return Response.json(init?.method === 'POST' ? subscription : { data: [], has_more: false });
  };
  const result = await ensureMusuboSubscription(env, input, fakeFetch as typeof fetch);
  expect(result.id).toBe('sub_existing');
  expect(methods).toEqual(['GET', 'POST']);
});

it('2ページ目も読み、同じ会社・用途の価格違いを契約し直さず停止する', async () => {
  const calls: string[] = [];
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url));
    expect(init?.method).toBe('GET');
    return Response.json(calls.length === 1
      ? { data: [{ ...subscription, id: 'sub_other', metadata: { tenant_id: 'other', purpose: 'musubo_core' } }], has_more: true }
      : { data: [{ ...subscription, items: { data: [{ price: {
        ...subscription.items.data[0].price, unit_amount: 9_999 } }] } }], has_more: false });
  };
  await expect(findMusuboSubscription(env, input, fakeFetch as typeof fetch))
    .rejects.toThrow('does not match');
  expect(calls[1]).toContain('starting_after=sub_other');
});

it('一覧が失敗したときは新規契約を作らない', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return Response.json({ error: { message: 'unavailable' } }, { status: 503 });
  };
  await expect(ensureMusuboSubscription(env, input, fakeFetch as typeof fetch)).rejects.toThrow();
  expect(calls).toBe(1);
});

it('作成結果の金額が同意した条件と違えば確定しない', async () => {
  const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) =>
    Response.json(init?.method === 'POST'
      ? { ...subscription, items: { data: [{ price: {
        ...subscription.items.data[0].price, unit_amount: 1 } }] } }
      : { data: [], has_more: false });
  await expect(ensureMusuboSubscription(env, input, fakeFetch as typeof fetch))
    .rejects.toThrow('could not be verified');
});
