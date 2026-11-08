import { describe, expect, it } from 'vitest';
import { stripeApi } from './stripe-api.js';

describe('Stripeのカード登録専用セッション', () => {
  it('請求なしのsetupモードを使い、カード情報をmusuboへ送らない', async () => {
    let requestUrl = '';
    let requestBody = '';
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(url);
      requestBody = String(init?.body ?? '');
      return new Response(JSON.stringify({ id: 'cs_setup_1', mode: 'setup', url: 'https://checkout.stripe.com/c/setup/cs_setup_1' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    };
    const session = await stripeApi.createCardSetupSession({ STRIPE_SECRET_KEY: 'sk_test_example' }, {
      customerId: 'cus_1', tenantId: 'tenant_1',
      successUrl: 'https://admin.example.com/hq/onboarding/card?setup=success',
      cancelUrl: 'https://admin.example.com/hq/onboarding/card?setup=cancel',
    }, fakeFetch as typeof fetch);
    const form = new URLSearchParams(requestBody);
    expect(requestUrl).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(form.get('mode')).toBe('setup');
    expect(form.get('payment_method_types[0]')).toBe('card');
    expect(form.get('currency')).toBe('jpy');
    expect(form.get('metadata[purpose]')).toBe('musubo_card_setup');
    expect(form.has('line_items[0][price]')).toBe(false);
    expect(form.has('subscription_data[metadata][tenant_id]')).toBe(false);
    expect(session.url).toContain('checkout.stripe.com');
  });
});
