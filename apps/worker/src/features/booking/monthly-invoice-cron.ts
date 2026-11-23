import type { Env } from '../../worker-env.js';
import { dispatchMonthlyInvoices } from './monthly-invoice-dispatch.js';

/** 模擬IDはStripeの請求ではない。明示設定された検証環境のテスト対象のみ。 */
export async function runMonthlyInvoiceMockCron(env: Env['Bindings'], now: Date) {
  if (env.DEPLOY_ENV !== 'staging' || env.MONTHLY_INVOICE_MOCK_CRON_ENABLED !== 'true') return { enabled: false };
  const result = await dispatchMonthlyInvoices(env.DB, {
    create: async ({ idempotencyKey }) => ({
      id: `in_mock_${idempotencyKey.slice('monthly-invoice:'.length).replace(/[^A-Za-z0-9_]/g, '')}`,
      livemode: false, autoAdvance: false, status: 'open',
    }),
  }, now, { testRecipientsOnly: true });
  return { enabled: true, ...result };
}
