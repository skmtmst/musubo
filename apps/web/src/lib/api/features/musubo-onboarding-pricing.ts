import { fetchApi } from '../transport/request'
import type { ApiResponse, MusuboPriceBreakdown, MusuboPriceSchedule, MusuboTrialPeriod } from '@line-crm/shared'

export interface PricingSelection {
  lineCount: number
  friendCountExcludingBlocked: number | null
  googleBusinessCount: number
  instagramCount: number
  interval: 'month' | 'year'
}

export interface MusuboOnboardingPricingState {
  condition: {
    name: string
    trialPeriod: MusuboTrialPeriod
    lineBasicDiscountPercent: number
    schedule: MusuboPriceSchedule
    discountEndsOn: string | null
  }
  selection: PricingSelection | null
  consentedAt: string | null
  status: 'awaiting_first_line' | 'trialing' | 'active' | 'past_due' | 'ended'
  quoteId: string | null
}

export const musuboOnboardingPricingMethods = {
  musuboOnboardingPricing: {
    get: () => fetchApi<ApiResponse<MusuboOnboardingPricingState>>('/api/hq/onboarding/pricing'),
    accept: (selection: PricingSelection) => fetchApi<ApiResponse<{
      selection: PricingSelection; price: MusuboPriceBreakdown; next: string
    }>>('/api/hq/onboarding/pricing', {
      method: 'POST', body: JSON.stringify({ selection, consent: true }),
    }),
  },
}
