import { expect, it, vi } from 'vitest';

const stripe = vi.hoisted(() => ({
  listCustomerSubscriptions: vi.fn(), retrieveInvoice: vi.fn(),
  createMusuboResumptionSubscription: vi.fn(),
}));
vi.mock('./stripe-api.js', () => ({ stripeApi: stripe }));

import { ensureMusuboResumptionSubscription, getMusuboResumptionPaymentState } from
  './musubo-resumption-subscription.js';

const input = { customerId: 'cus_test', tenantId: 'tenant-test', productId: 'prod_core',
  purpose: 'core' as const, interval: 'month' as const, unitAmountYen: 5_900, generation: 3 };

function subscription(status: string, invoiceId: string | null = 'in_test') {
  return { id: 'sub_test', status, customer: input.customerId, latest_invoice: invoiceId,
    metadata: { tenant_id: input.tenantId, purpose: 'musubo_core', resumption_generation: '3' },
    items: { data: [{ price: { product: 'prod_core', unit_amount: 5_900,
      currency: 'jpy', tax_behavior: 'inclusive', recurring: { interval: 'month' } } }] } };
}

it('keeps the LINE inactive and returns only a matching Stripe invoice for failed first payment', async () => {
  stripe.listCustomerSubscriptions.mockResolvedValue({ data: [subscription('incomplete')], has_more: false });
  stripe.retrieveInvoice.mockResolvedValue({ customer: input.customerId, subscription: 'sub_test',
    status: 'open', amount_remaining: 5_900,
    hosted_invoice_url: 'https://invoice.stripe.com/i/test' });
  await expect(getMusuboResumptionPaymentState({} as never, input.customerId,
    input.tenantId, input.generation)).resolves.toEqual({ kind: 'payment_required',
    hostedInvoiceUrl: 'https://invoice.stripe.com/i/test' });
  await expect(ensureMusuboResumptionSubscription({} as never, input))
    .rejects.toThrow('has not become payable');
  expect(stripe.createMusuboResumptionSubscription).not.toHaveBeenCalled();
  stripe.retrieveInvoice.mockResolvedValue({ customer: 'cus_wrong', subscription: 'sub_test',
    status: 'open', amount_remaining: 5_900,
    hosted_invoice_url: 'https://invoice.stripe.com/i/test' });
  await expect(getMusuboResumptionPaymentState({} as never, input.customerId,
    input.tenantId, input.generation)).rejects.toThrow('identity');
});

it('does not offer another payment link after the first invoice expires', async () => {
  stripe.listCustomerSubscriptions.mockResolvedValue({ data: [subscription('incomplete_expired')],
    has_more: false });
  await expect(getMusuboResumptionPaymentState({} as never, input.customerId,
    input.tenantId, input.generation)).resolves.toEqual({ kind: 'payment_expired',
    hostedInvoiceUrl: null });
});

it('refuses an invoice with a charge different from the accepted amount', async () => {
  stripe.listCustomerSubscriptions.mockResolvedValue({ data: [subscription('active')],
    has_more: false });
  stripe.retrieveInvoice.mockResolvedValue({ customer: input.customerId, subscription: 'sub_test',
    status: 'paid', currency: 'jpy', amount_paid: 7_000 });
  await expect(ensureMusuboResumptionSubscription({} as never, input))
    .rejects.toThrow('not confirmed');
});
