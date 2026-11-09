'use client'

import { useState } from 'react'
import OnboardingPricing, { type OnboardingCondition, type PricingSelection } from './pricing'
import IndividualQuoteInquiry from './individual-quote-inquiry'

interface Props {
  condition?: OnboardingCondition
  initialSelection?: PricingSelection
  onContinue: (selection: PricingSelection) => Promise<void>
  onQuoteSubmitted?: (ticketId: string) => void
}

/** Reuses the existing billing-support request for either 11+ inquiry branch. */
export default function PricingQuoteFlow({ condition, initialSelection, onContinue, onQuoteSubmitted }: Props) {
  const [inquiry, setInquiry] = useState<PricingSelection | null>(null)
  const [draftSelection, setDraftSelection] = useState<PricingSelection | null>(initialSelection ?? null)
  if (inquiry) return <IndividualQuoteInquiry selection={inquiry} onBack={() => setInquiry(null)} onSubmitted={onQuoteSubmitted} />
  return <OnboardingPricing condition={condition} initialSelection={draftSelection ?? undefined} onContinue={onContinue}
    onContact={async (selection) => { setDraftSelection(selection); setInquiry(selection) }} />
}
