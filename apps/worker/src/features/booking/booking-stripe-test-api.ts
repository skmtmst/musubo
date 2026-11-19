import { encodeForm } from '../../services/stripe-api.js';

/** Stripe Connect の予約決済専用。模擬プロバイダーは別のまま残す。 */
export class BookingStripeTestError extends Error {
  constructor(readonly code: string, readonly resultUnknown = false) { super(code); }
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
        'Idempotency-Key': input.idempotencyKey, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: encodeForm(input.body),
    });
  } catch { throw new BookingStripeTestError('stripe_result_unknown', true); }
  let value: unknown;
  try { value = await response.json(); } catch { throw new BookingStripeTestError('stripe_result_unknown', true); }
  if (!response.ok) throw new BookingStripeTestError('stripe_request_failed', response.status === 408 || response.status === 429 || response.status >= 500);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BookingStripeTestError('stripe_result_unknown', true);
  const result = value as Record<string, unknown>;
  if (result.livemode !== false) throw new BookingStripeTestError('live_mode_not_approved', true);
  return result;
}
