'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import ListState from '@/components/shared/list-state'
import CardRegistration from '@/v8/onboarding/card-registration'

function CardRegistrationReturn() {
  const setup = useSearchParams().get('setup')
  return <CardRegistration returnState={setup === 'success' || setup === 'cancel' ? setup : null} />
}

/** Stripe Checkout returns here; the page verifies card status with the server. */
export default function CardRegistrationPage() {
  return <Suspense fallback={<ListState kind="loading" title="カード登録状況を確認しています" />}>
    <CardRegistrationReturn />
  </Suspense>
}
