'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import ListState from '@/components/shared/list-state'
import { api } from '@/lib/api'
import CardRegistration from '@/v8/onboarding/card-registration'

function CardRegistrationReturn() {
  const router = useRouter()
  const setup = useSearchParams().get('setup')
  const quoteId = useSearchParams().get('quote')
  const [entry, setEntry] = useState<'checking' | 'ready' | 'error'>('checking')
  useEffect(() => {
    let disposed = false
    const check = async () => {
      try {
        if (quoteId) {
          const response = await api.individualQuotes.customer.get(quoteId)
          if (!response.success) throw new Error(response.error)
          if (!response.data.cardRegistrationAvailable) {
            router.replace(`/hq/onboarding/quotes?id=${encodeURIComponent(quoteId)}`)
            return
          }
        } else {
          const response = await api.musuboOnboardingPricing.get()
          if (!response.success) throw new Error(response.error)
          if (response.data.quoteId) {
            router.replace(`/hq/onboarding/quotes?id=${encodeURIComponent(response.data.quoteId)}`)
            return
          }
          if (!response.data.consentedAt) {
            router.replace('/hq/onboarding/pricing')
            return
          }
        }
        if (!disposed) setEntry('ready')
      } catch { if (!disposed) setEntry('error') }
    }
    void check()
    return () => { disposed = true }
  }, [quoteId, router])
  if (entry === 'checking') return <ListState kind="loading" title="料金の確認状況を読み込んでいます" />
  if (entry === 'error') return <ListState kind="error" title="料金の確認状況を表示できませんでした" />
  return <CardRegistration returnState={setup === 'success' || setup === 'cancel' ? setup : null}
    quoteId={quoteId} onBackToPricing={quoteId ? undefined : () => router.push('/hq/onboarding/pricing')} />
}

/** Stripe Checkout returns here; the page verifies card status with the server. */
export default function CardRegistrationPage() {
  return <Suspense fallback={<ListState kind="loading" title="カード登録状況を確認しています" />}>
    <CardRegistrationReturn />
  </Suspense>
}
