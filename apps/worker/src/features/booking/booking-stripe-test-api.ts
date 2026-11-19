import { STRIPE_BOOKING_API_VERSION } from './booking-stripe-webhooks/types.js';
import { encodeForm } from '../../services/stripe-api.js';

/** Stripe Connect の予約決済専用。模擬プロバイダーは別のまま残す。 */
export class BookingStripeTestError extends Error {
  constructor(readonly code: string, readonly resultUnknown = false, readonly paymentIntent?: Record<string,unknown>) { super(code); }
}

type Operation = 'customers' | 'checkout/sessions' | 'payment_intents' | 'refunds';
type Value = string | number | boolean | undefined;

export async function bookingStripeTestRequest(
  input: { key?: string; connectedAccount: string; operation: Operation; idempotencyKey: string; body: Record<string, Value> },
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  if (!input.key || !/^sk_test_[A-Za-z0-9]+$/.test(input.key)) throw new BookingStripeTestError('stripe_test_key_required');
  if (!/^acct_[A-Za-z0-9]+$/.test(input.connectedAccount)) throw new BookingStripeTestError('invalid_stripe_account');
  if (!/^[A-Za-z0-9:_-]{1,200}$/.test(input.idempotencyKey)) throw new BookingStripeTestError('invalid_idempotency_key');
  let response: Response;
  try {
    response = await fetchImpl(`https://api.stripe.com/v1/${input.operation}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${input.key}`, 'Stripe-Account': input.connectedAccount,
        'Idempotency-Key': input.idempotencyKey, 'Stripe-Version': STRIPE_BOOKING_API_VERSION, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: encodeForm(input.body),
    });
  } catch { throw new BookingStripeTestError('stripe_result_unknown', true); }
  let value: unknown;
  try { value = await response.json(); } catch { throw new BookingStripeTestError('stripe_result_unknown', true); }
  if (!response.ok) {
    const error = value && typeof value==='object' ? (value as {error?:{type?:unknown;payment_intent?:unknown}}).error : undefined;
    const intent = error?.type==='card_error' && error.payment_intent && typeof error.payment_intent==='object' && !Array.isArray(error.payment_intent)
      ? error.payment_intent as Record<string,unknown> : undefined;
    throw new BookingStripeTestError('stripe_request_failed', response.status === 408 || response.status === 429 || response.status >= 500, intent);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BookingStripeTestError('stripe_result_unknown', true);
  const result = value as Record<string, unknown>;
  if (result.livemode !== false) throw new BookingStripeTestError('live_mode_not_approved', true);
  return result;
}

/** 結果不明の請求だけを、固定した申込IDで照会する。見つからなくても再請求の根拠にはしない。 */
export async function searchBookingStripeTestCharge(input:{key?:string;connectedAccount:string;chargeId:string},fetchImpl:typeof fetch=fetch):Promise<Record<string,unknown>[]> {
  if (!input.key || !/^sk_test_[A-Za-z0-9]+$/.test(input.key)) throw new BookingStripeTestError('stripe_test_key_required');
  if (!/^acct_[A-Za-z0-9]+$/.test(input.connectedAccount) || !/^[A-Za-z0-9-]{1,80}$/.test(input.chargeId)) throw new BookingStripeTestError('invalid_stripe_account');
  const query=new URLSearchParams({query:`metadata['booking_charge_id']:'${input.chargeId}'`,limit:'2'});
  let response:Response;
  try { response=await fetchImpl(`https://api.stripe.com/v1/payment_intents/search?${query}`,{method:'GET',redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:`Bearer ${input.key}`,'Stripe-Account':input.connectedAccount,'Stripe-Version':STRIPE_BOOKING_API_VERSION}}); }
  catch { throw new BookingStripeTestError('stripe_result_unknown',true); }
  let data:unknown;
  try { data=await response.json(); } catch { throw new BookingStripeTestError('stripe_result_unknown',true); }
  if (!response.ok || !data || typeof data!=='object' || !Array.isArray((data as {data?:unknown}).data) || (data as {has_more?:unknown}).has_more!==false) throw new BookingStripeTestError('stripe_result_unknown',true);
  const rows=(data as {data:unknown[]}).data;
  if (rows.some(row=>!row || typeof row!=='object' || Array.isArray(row) || (row as {livemode?:unknown}).livemode!==false)) throw new BookingStripeTestError('stripe_result_unknown',true);
  return rows as Record<string,unknown>[];
}
