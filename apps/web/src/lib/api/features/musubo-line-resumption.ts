import type { ApiResponse } from '@line-crm/shared'
import { fetchApi } from '../transport/request'
import type { LineResumeCompleteView, LineResumeReviewView } from '@/v8/hq/line-resumption'

export interface MusuboLineResumptionState {
  review: LineResumeReviewView
  consented: boolean
  reconciliationPending: boolean
}

const path = '/api/hq/billing/musubo/resumption'

export const musuboLineResumptionMethods = {
  musuboLineResumption: {
    get: () => fetchApi<ApiResponse<MusuboLineResumptionState>>(path),
    accept: () => fetchApi<ApiResponse<MusuboLineResumptionState>>(`${path}/accept`, {
      method: 'POST', body: JSON.stringify({}),
    }),
    connect: (stepUpToken?: string) => fetchApi<ApiResponse<{ active: boolean; message?: string }>>(`${path}/connect`, {
      method: 'POST', headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined,
      body: JSON.stringify({}),
    }),
    complete: () => fetchApi<ApiResponse<LineResumeCompleteView>>(`${path}/complete`),
  },
}
