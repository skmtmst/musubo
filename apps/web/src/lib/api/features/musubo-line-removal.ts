import { fetchApi } from '../transport/request'
import type { ApiResponse } from '@line-crm/shared'

export interface MusuboLineRemovalState {
  lineAccountId: string
  lineName: string
  otherLineName: string
  billingInterval: 'month' | 'year'
  billingStatus: 'trialing' | 'active' | 'past_due' | 'ended' | 'awaiting_first_line'
  nextMonthlyChargeAt: string | null
  nextAnnualRenewalAt: string | null
  scheduledEndAt: string | null
  requestedEndAt: string | null
  phase: 'choose' | 'requested' | 'scheduled' | 'cancelling' | 'ended'
  priceEstimate: { beforeMonthlyOptionsYen: number; afterMonthlyOptionsYen: number;
    afterCoreYen: number; interval: 'month' | 'year' } | null
}

const path = (lineId: string) => `/api/hq/billing/musubo/line-removal/${encodeURIComponent(lineId)}`
export const musuboLineRemovalMethods = {
  musuboLineRemoval: {
    get: (lineId: string) => fetchApi<ApiResponse<MusuboLineRemovalState>>(path(lineId)),
    change: (lineId: string, action: 'schedule' | 'now' | 'cancel', stepUpToken?: string) =>
      fetchApi<ApiResponse<{ phase: MusuboLineRemovalState['phase'] }>>(path(lineId), {
        method: 'POST', headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined,
        body: JSON.stringify({ action }),
      }),
  },
}
