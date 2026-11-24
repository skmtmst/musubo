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
  lineAccountId: string | null
  status: 'awaiting_payment' | 'paid' | 'activated' | 'expired' | 'cancelled'
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
  addition?: MusuboLineAdditionPending
  pending?: MusuboLineAdditionPending
  expired?: boolean
}

export type MusuboLineAdditionTarget = { accountId: string } | { additionId: string }

const path = '/api/hq/billing/musubo/line-addition'

function additionPath(target?: MusuboLineAdditionTarget) {
  return target ? path + '?' + new URLSearchParams(target) : path
}
export const musuboLineAdditionMethods = {
  musuboLineAddition: {
    get: (target?: MusuboLineAdditionTarget) =>
      fetchApi<ApiResponse<MusuboLineAdditionState>>(additionPath(target), { cache: 'no-store' }),
    reconcile: (target: MusuboLineAdditionTarget) =>
      fetchApi<ApiResponse<MusuboLineAdditionPending>>(path, {
        method: 'POST', body: JSON.stringify({ action: 'reconcile', ...target }),
      }),
    accept: (input: { amountDueYen: number; activeLineCount: number }, stepUpToken?: string) =>
      fetchApi<ApiResponse<MusuboLineAdditionPending>>(path, {
        method: 'POST', headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined,
        body: JSON.stringify({ ...input, consent: true }),
      }),
  },
}
