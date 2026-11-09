'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import ListState from '@/components/shared/list-state'
import { api } from '@/lib/api'
import type { MusuboOnboardingPricingState } from '@/lib/api/features/musubo-onboarding-pricing'
import PricingQuoteFlow from '@/v8/onboarding/pricing-quote-flow'

export default function MusuboOnboardingPricingPage() {
  const router = useRouter()
  const [state, setState] = useState<MusuboOnboardingPricingState | null>(null)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let disposed = false
    void api.musuboOnboardingPricing.get().then((result) => {
      if (disposed) return
      if (!result.success) { setError(true); return }
      if (result.data.quoteId) {
        router.replace(`/hq/onboarding/quotes?id=${encodeURIComponent(result.data.quoteId)}`)
        return
      }
      setState(result.data)
    }).catch(() => { if (!disposed) setError(true) })
      .finally(() => { if (!disposed) setLoading(false) })
    return () => { disposed = true }
  }, [router])
  if (loading) return <ListState kind="loading" title="利用料金を読み込んでいます" />
  if (error || !state) return <ListState kind="error" title="利用料金を表示できませんでした" />
  return <PricingQuoteFlow condition={state.condition} initialSelection={state.selection ?? undefined}
    onContinue={async (selection) => {
      const result = await api.musuboOnboardingPricing.accept(selection)
      if (!result.success) throw new Error(result.error)
      router.push(result.data.next)
    }} />
}
