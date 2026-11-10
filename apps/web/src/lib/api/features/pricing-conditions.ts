import { fetchApi } from '../transport/request'
import type { ApiResponse, MusuboConditionDefinition } from '@line-crm/shared'

export interface StoredMusuboPricingCondition extends MusuboConditionDefinition {
  conditionKey: string
  createdAt: string
  activatedAt: string | null
  hasCode: boolean
}

export const pricingConditionMethods = {
  pricingConditions: {
    list: () => fetchApi<ApiResponse<StoredMusuboPricingCondition[]>>('/api/ops/pricing-conditions'),
    create: (definition: MusuboConditionDefinition) => fetchApi<ApiResponse<StoredMusuboPricingCondition>>(
      '/api/ops/pricing-conditions', { method: 'POST', body: JSON.stringify(definition) }),
    revise: (id: string, definition: MusuboConditionDefinition) => fetchApi<ApiResponse<StoredMusuboPricingCondition>>(
      `/api/ops/pricing-conditions/${encodeURIComponent(id)}`,
      { method: 'PUT', body: JSON.stringify(definition) }),
  },
}
