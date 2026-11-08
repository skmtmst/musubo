import { tracedFetch as fetch } from '@line-crm/shared/server';
import { boundedHttpRequest } from '../lib/external-call/bounded-http.js';
/**
 * Stripe の API を呼ぶ小さな道具。SDK は使わず fetch で叩く（Workers で軽く保つ）。
 *
 * 鍵は `STRIPE_SECRET_KEY`（secret）。ここには値を書かない。
 * 送る形は Stripe の決まり（application/x-www-form-urlencoded、入れ子は `a[b]`）。
 */

export interface StripeEnv {
  STRIPE_SECRET_KEY?: string;
}

export class StripeApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly resultUnknown: boolean;
  constructor(status: number, message: string, code: string | null = null, resultUnknown = false) {
    super(message);
    this.name = 'StripeApiError';
    this.status = status;
    this.code = code;
    this.resultUnknown = resultUnknown;
  }
}

type FormValue = string | number | boolean | null | undefined | FormValue[] | { [key: string]: FormValue };

/** 入れ子のオブジェクトを `a[b][0]=x` の形にする。 */
export function encodeForm(input: Record<string, FormValue>): string {
  const params = new URLSearchParams();
  const walk = (prefix: string, value: FormValue) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(`${prefix}[${index}]`, item));
      return;
    }
    if (typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) walk(`${prefix}[${key}]`, inner);
      return;
    }
    params.set(prefix, String(value));
  };
  for (const [key, value] of Object.entries(input)) walk(key, value);
  return params.toString();
}

export async function stripeRequest<T>(
  env: StripeEnv,
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, FormValue>,
  options: { idempotencyKey?: string; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) throw new StripeApiError(503, 'Stripe の接続設定がまだありません', 'not_configured');
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    Authorization: `Basic ${btoa(`${env.STRIPE_SECRET_KEY}:`)}`,
    'Stripe-Version': '2024-06-20',
  };
  let url = `https://api.stripe.com${path}`;
  let payload: string | undefined;
  if (method === 'GET') {
    if (body) url += `?${encodeForm(body)}`;
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = body ? encodeForm(body) : '';
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  }
  /*
   * Stripe への輸送失敗（到達不能）は fetch 自体の throw になる。
   * 包まずに投げると口側の汎用 500（内部文）へ落ちる。502 の
   * StripeApiError に包み、口側の日本語案内（502）へ載せる。
   * 実際の決済・送信はしない（試験は偽の応答で）。
   */
  let res: Response;
  try {
    res = await boundedHttpRequest(url, { method, headers, body: payload, signal: options.signal }, { timeoutMs: 10_000, maxResponseBytes: 1024 * 1024, fetch: fetchImpl });
  } catch {
    throw new StripeApiError(502, '決済サービスにつながりませんでした', 'network_unreachable', method === 'POST');
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const error = (json as { error?: { message?: string; code?: string } } | null)?.error;
    throw new StripeApiError(res.status, error?.message ?? `Stripe error ${res.status}`, error?.code ?? null, method === 'POST' && (res.status === 408 || res.status >= 500));
  }
  return json as T;
}

export interface StripeCustomer {
  id: string;
  email: string | null;
  name: string | null;
  invoice_settings?: { default_payment_method?: string | null } | null;
}

export interface StripeCheckoutSession {
  id: string;
  url: string | null;
  customer: string | null;
  subscription: string | null;
  setup_intent?: string | null;
  mode?: 'payment' | 'setup' | 'subscription';
  client_reference_id: string | null;
  metadata?: Record<string, string>;
}

export interface StripeSetupIntent {
  id: string;
  status: string;
  customer: string | null;
  payment_method: string | null;
}

export interface StripePortalSession {
  id: string;
  url: string;
}

export interface StripePrice {
  id: string;
  unit_amount: number | null;
  currency: string;
  recurring?: { interval: string } | null;
}

export interface StripeSubscription {
  id: string;
  status: string;
  customer: string;
  current_period_end?: number;
  cancel_at_period_end?: boolean;
  metadata?: Record<string, string>;
  items: { data: Array<{ id?: string; quantity?: number; price: { id: string }; current_period_end?: number }> };
}

export interface StripeInvoicePreview {
  amount_due: number;
  currency: string;
  lines: { has_more: boolean; data: Array<{
    amount: number;
    proration: boolean;
    type: string;
    subscription_item: string | null;
    period: { start: number; end: number };
  }> };
}

export interface StripeInvoice {
  id: string;
  number: string | null;
  status: string | null;
  amount_paid: number;
  amount_due: number;
  amount_remaining: number;
  currency: string;
  created: number;
  customer: string | null;
  subscription: string | null;
  charge: string | { id: string; amount_refunded: number } | null;
  period_start: number | null;
  period_end: number | null;
  status_transitions?: { paid_at?: number | null } | null;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  lines?: { data: Array<{
    description: string | null;
    price?: { recurring?: { interval?: string | null } | null } | null;
  }> };
}

export interface StripeInvoiceListOptions {
  limit?: number;
  startingAfter?: string;
  createdGte?: number;
}

export interface StripePaymentIntent {
  id: string;
  invoice: string | null;
}

export const stripeApi = {
  createInvoicePreview: (
    env: StripeEnv,
    input: { subscriptionId: string; itemId: string; priceId: string; quantity: number; prorationDate: number },
    fetchImpl?: typeof fetch,
  ) => stripeRequest<StripeInvoicePreview>(env, 'POST', '/v1/invoices/create_preview', {
    subscription: input.subscriptionId,
    subscription_details: {
      items: [{ id: input.itemId, price: input.priceId, quantity: input.quantity }],
      proration_behavior: 'create_prorations',
      proration_date: input.prorationDate,
    },
  }, { fetchImpl }),

  createCustomer: (env: StripeEnv, input: { name: string; email: string | null; tenantId: string }, fetchImpl?: typeof fetch) =>
    stripeRequest<StripeCustomer>(env, 'POST', '/v1/customers', {
      name: input.name,
      email: input.email,
      metadata: { tenant_id: input.tenantId },
    }, { fetchImpl, idempotencyKey: `customer-${input.tenantId}` }),

  createCheckoutSession: (
    env: StripeEnv,
    input: { customerId: string; priceId: string; tenantId: string; planKey: string; successUrl: string; cancelUrl: string },
    fetchImpl?: typeof fetch,
  ) =>
    stripeRequest<StripeCheckoutSession>(env, 'POST', '/v1/checkout/sessions', {
      mode: 'subscription',
      customer: input.customerId,
      client_reference_id: input.tenantId,
      line_items: [{ price: input.priceId, quantity: 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      allow_promotion_codes: true,
      locale: 'ja',
      metadata: { tenant_id: input.tenantId, plan_key: input.planKey },
      subscription_data: { metadata: { tenant_id: input.tenantId, plan_key: input.planKey } },
    }, { fetchImpl }),

  /** Card collection without a charge or a subscription. The webhook must verify the SetupIntent. */
  createCardSetupSession: (
    env: StripeEnv,
    input: { customerId: string; tenantId: string; successUrl: string; cancelUrl: string },
    fetchImpl?: typeof fetch,
  ) => stripeRequest<StripeCheckoutSession>(env, 'POST', '/v1/checkout/sessions', {
    mode: 'setup',
    customer: input.customerId,
    client_reference_id: input.tenantId,
    currency: 'jpy',
    payment_method_types: ['card'],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    locale: 'ja',
    metadata: { tenant_id: input.tenantId, purpose: 'musubo_card_setup' },
  }, { fetchImpl }),

  retrieveSetupIntent: (env: StripeEnv, setupIntentId: string, fetchImpl?: typeof fetch) =>
    stripeRequest<StripeSetupIntent>(env, 'GET', `/v1/setup_intents/${encodeURIComponent(setupIntentId)}`, undefined, { fetchImpl }),

  retrieveCustomer: (env: StripeEnv, customerId: string, fetchImpl?: typeof fetch) =>
    stripeRequest<StripeCustomer>(env, 'GET', `/v1/customers/${encodeURIComponent(customerId)}`, undefined, { fetchImpl }),

  setCustomerDefaultPaymentMethod: (env: StripeEnv, customerId: string, paymentMethodId: string, fetchImpl?: typeof fetch) =>
    stripeRequest<StripeCustomer>(env, 'POST', `/v1/customers/${encodeURIComponent(customerId)}`, {
      invoice_settings: { default_payment_method: paymentMethodId },
    }, { fetchImpl, idempotencyKey: `default-card-${customerId}-${paymentMethodId}` }),

  createPortalSession: (env: StripeEnv, input: { customerId: string; returnUrl: string }, fetchImpl?: typeof fetch) =>
    stripeRequest<StripePortalSession>(env, 'POST', '/v1/billing_portal/sessions', {
      customer: input.customerId,
      return_url: input.returnUrl,
      locale: 'ja',
    }, { fetchImpl }),

  retrievePrice: (env: StripeEnv, priceId: string, fetchImpl?: typeof fetch) =>
    stripeRequest<StripePrice>(env, 'GET', `/v1/prices/${encodeURIComponent(priceId)}`, undefined, { fetchImpl }),

  retrieveSubscription: (env: StripeEnv, subscriptionId: string, fetchImpl?: typeof fetch) =>
    stripeRequest<StripeSubscription>(env, 'GET', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, undefined, { fetchImpl }),

  // charge.refunded の Charge に invoice が付かず payment_intent だけの場合の解決用。
  // PaymentIntent.invoice は請求書払いなら常にIDが入る（2024-06-20 API版で有効）。
  retrievePaymentIntent: (env: StripeEnv, paymentIntentId: string, fetchImpl?: typeof fetch) =>
    stripeRequest<StripePaymentIntent>(env, 'GET', `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`, undefined, { fetchImpl }),

  listInvoices: (
    env: StripeEnv,
    customerId: string,
    options: StripeInvoiceListOptions = {},
    fetchImpl?: typeof fetch,
  ) => stripeRequest<{ data: StripeInvoice[]; has_more: boolean }>(env, 'GET', '/v1/invoices', {
    customer: customerId,
    limit: options.limit ?? 100,
    starting_after: options.startingAfter,
    created: options.createdGte === undefined ? undefined : { gte: options.createdGte },
    expand: ['data.charge'],
  }, { fetchImpl }),
};
