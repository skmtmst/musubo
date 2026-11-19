import { describe, expect, it, vi } from 'vitest';
import { bookingStripeTestRequest } from './booking-stripe-test-api.js';

const input = { key: 'sk_test_example', connectedAccount: 'acct_example', operation: 'payment_intents' as const,
  idempotencyKey: 'charge:1', body: { amount: 4000, currency: 'jpy' } };

describe('booking Stripe test API', () => {
  it('sends to the connected account with a stable idempotency key', async () => {
    const call = vi.fn(async () => Response.json({ id: 'pi_1', livemode: false }));
    await expect(bookingStripeTestRequest(input, call as typeof fetch)).resolves.toMatchObject({ id: 'pi_1' });
    const request = call.mock.calls[0] as unknown as [string, RequestInit];
    expect(request[0]).toBe('https://api.stripe.com/v1/payment_intents');
    expect(request[1].headers).toMatchObject({ 'Stripe-Account': 'acct_example', 'Idempotency-Key': 'charge:1' });
  });
  it('rejects live keys before sending and live responses after sending', async () => {
    const call = vi.fn(async () => Response.json({ livemode: true }));
    await expect(bookingStripeTestRequest({ ...input, key: 'sk_live_example' }, call as typeof fetch)).rejects.toMatchObject({ code: 'stripe_test_key_required' });
    expect(call).not.toHaveBeenCalled();
    await expect(bookingStripeTestRequest(input, call as typeof fetch)).rejects.toMatchObject({ code: 'live_mode_not_approved', resultUnknown: true });
  });
  it('treats timeouts and invalid responses as unknown outcomes', async () => {
    const call = vi.fn(async () => { throw new Error('timeout'); });
    await expect(bookingStripeTestRequest(input, call as typeof fetch)).rejects.toMatchObject({ resultUnknown: true });
    await expect(bookingStripeTestRequest(input, vi.fn(async () => Response.json({ id: 'pi_1' })) as typeof fetch)).rejects.toMatchObject({ resultUnknown: true });
  });
});
