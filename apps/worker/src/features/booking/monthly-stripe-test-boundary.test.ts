import { expect, it } from 'vitest';
import { unavailableMonthlyStripeTestProvider } from './monthly-stripe-test-boundary.js';

it('未接続の試験用決済口は成功したことにせず、外部決済を始めない', async () => {
  const provider=unavailableMonthlyStripeTestProvider();
  await expect(provider.create({account:'acct_test',customer:'cus_test',amount:6000,currency:'jpy',idempotencyKey:'cycle'}))
    .rejects.toThrow('monthly_stripe_test_not_connected');
  expect(await provider.pay({account:'acct_test',invoiceId:'in_test',paymentMethod:'pm_test',idempotencyKey:'attempt'})).toBe('unknown');
});
