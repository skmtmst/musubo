import type { PlanKey, BillingInterval, BillingSummary, BillingInvoice } from '../../hq-billing'
import { fetchApi } from '../transport/request'
import type { ApiResponse } from '@line-crm/shared'
import type { FetchApiOptions } from '../types/transport'

export const hqBillingMethods = {
  hqBilling: {
    preview: (planKey: PlanKey, interval: BillingInterval = 'month') =>
      fetchApi<ApiResponse<{ planKey: PlanKey; interval: BillingInterval; afterAmountYen: number;
        amountDueYen: number; prorationDifferenceYen: number; nextBillingAt: string | null;
        estimatedAt: string; isEstimate: true; notice: string }>>(
        `/api/hq/billing/preview?${new URLSearchParams({ planKey, interval })}`),
    summary: (options?: FetchApiOptions) => fetchApi<ApiResponse<BillingSummary>>('/api/hq/billing/summary', options),
    /** Stripe の申込画面の URL。オーナーだけ。 */
    checkout: (planKey: PlanKey, interval: BillingInterval = 'month') =>
      fetchApi<ApiResponse<{ url: string }>>('/api/hq/billing/checkout', { method: 'POST', body: JSON.stringify({ planKey, interval }) }),
    /** 請求・契約を作らず、Stripe 上でカードだけ登録する。 */
    cardSetup: () => fetchApi<ApiResponse<{ url: string }>>('/api/hq/billing/card-setup', {
      method: 'POST', body: JSON.stringify({}),
    }),
    /** カード番号を返さず、Stripe の既定支払い方法があるかだけ確認する。 */
    cardStatus: (options?: FetchApiOptions) => fetchApi<ApiResponse<{ registered: boolean }>>('/api/hq/billing/card-status', options),
    /** 支払い方法・解約（Stripe のカスタマーポータル）の URL。 */
    portal: () => fetchApi<ApiResponse<{ url: string }>>('/api/hq/billing/portal', { method: 'POST', body: JSON.stringify({}) }),
    invoices: () => fetchApi<ApiResponse<BillingInvoice[]>>('/api/hq/billing/invoices'),
  },
}
