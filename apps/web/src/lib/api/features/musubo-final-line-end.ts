import { fetchApi } from '../transport/request'
import type { ApiResponse } from '@line-crm/shared'

export interface MusuboFinalLineEndState {
  phase: 'choose' | 'scheduled' | 'ending' | 'ended'
  lineAccountId: string | null
  lineName: string
  billingState: 'awaiting_first_line' | 'trialing' | 'active' | 'past_due' | 'ended'
  interval: 'month' | 'year'
  firstChargeDate: string | null
  nextMonthlyChargeDate: string | null
  nextAnnualRenewalDate: string | null
  defaultEndAt: string | null
  lastUsableDateJst: string | null
  scheduledEndAt: string | null
  unpaidInvoiceYen: number
}

const path = '/api/hq/billing/musubo/last-line-end'
export const musuboFinalLineEndMethods = {
  musuboFinalLineEnd: {
    get: () => fetchApi<ApiResponse<MusuboFinalLineEndState>>(path),
    change: (action: 'schedule' | 'now' | 'cancel', stepUpToken?: string) =>
      fetchApi<ApiResponse<{ phase: MusuboFinalLineEndState['phase']; end: MusuboFinalLineEndState }>>(path, {
        method: 'POST', headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined,
        body: JSON.stringify({ action }),
      }),
  },
}
