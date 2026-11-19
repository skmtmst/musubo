import type { MonthlyAttemptProvider } from './monthly-attempt-execution.js';
import type { MonthlyInvoiceProvider } from './monthly-invoice.js';

/**
 * Stripe試験接続の注入点。共通の予約用Stripeクライアント統合と
 * 受信イベントの照合が揃うまでは決済を開始しない。
 */
export function unavailableMonthlyStripeTestProvider(): MonthlyInvoiceProvider & MonthlyAttemptProvider {
  return {
    async create() { throw new Error('monthly_stripe_test_not_connected'); },
    async pay() { return 'unknown'; },
  };
}
