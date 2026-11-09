import { fetchApi } from '../transport/request'
import type { ApiResponse } from '@line-crm/shared'

export interface MusuboLineAdditionPrice {
  addedLineOrdinal: number
  coreIncrementYen: number
  coreIncrementInterval: 'month' | 'year'
  headquartersIncrementMonthlyYen: number
  dueNowYen: number
  contractedLineCapacity: number
}

export interface MusuboLineAdditionPending {
  id: string
  status: 'awaiting_payment' | 'paid' | 'activated'
  amountDueYen: number
  expiresAt: string
  canConnect: boolean
  activationPending: boolean
  paymentUrl: string | null
}

export interface MusuboLineAdditionState {
  price: MusuboLineAdditionPrice
  activeLineCount: number
  recurringAfter: { coreYen: number; coreInterval: 'month' | 'year'; optionsYen: number }
  monthlyPeriod?: { start: string; end: string }
  annualPeriod?: { start: string; end: string } | null
  pending?: MusuboLineAdditionPending
  expired?: boolean
}

const path = '/api/hq/billing/musubo/line-addition'
export const musuboLineAdditionMethods = {
  musuboLineAddition: {
    get: () => fetchApi<ApiResponse<MusuboLineAdditionState>>(path),
    accept: (input: { amountDueYen: number; activeLineCount: number }, stepUpToken?: string) =>
      fetchApi<ApiResponse<MusuboLineAdditionPending>>(path, {
        method: 'POST', headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined,
        body: JSON.stringify({ ...input, consent: true }),
      }),
  },
}
