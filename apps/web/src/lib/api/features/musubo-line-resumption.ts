import type { ApiResponse } from '@line-crm/shared'
import { fetchApi } from '../transport/request'
import type { LineResumeReviewView } from '@/v8/hq/line-resumption'

export interface MusuboLineResumptionState {
  review: LineResumeReviewView
  consented: boolean
}

const path = '/api/hq/billing/musubo/resumption'

export const musuboLineResumptionMethods = {
  musuboLineResumption: {
    get: () => fetchApi<ApiResponse<MusuboLineResumptionState>>(path),
    accept: () => fetchApi<ApiResponse<MusuboLineResumptionState>>(`${path}/accept`, {
      method: 'POST', body: JSON.stringify({}),
    }),
  },
}
