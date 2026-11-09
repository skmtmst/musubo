'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import type { MusuboIndividualQuote } from '@line-crm/shared'
import ListState from '@/components/shared/list-state'
import { api } from '@/lib/api'
import IndividualQuoteReview from '@/v8/onboarding/individual-quote-review'

type View = { quote: MusuboIndividualQuote; now: string }

/** The mailed link opens the current server-backed quote, never embedded mail content. */
export default function IndividualQuoteReviewPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const [view, setView] = useState<View | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    let disposed = false
    const load = async () => {
      try {
        const response = await api.individualQuotes.customer.get(params.id)
        if (!response.success) throw new Error(response.error)
        if (!disposed) { setView({ quote: response.data.quote, now: new Date().toISOString() }); setState('ready') }
      } catch { if (!disposed) setState('error') }
    }
    void load()
    return () => { disposed = true }
  }, [params.id])

  if (state === 'loading') return <ListState kind="loading" title="お見積もりを確認しています" />
  if (state === 'error' || !view) return <ListState kind="error" title="お見積もりを表示できませんでした" />

  return <IndividualQuoteReview quote={view.quote} now={view.now}
    onAccept={async (id) => {
      const result = await api.individualQuotes.customer.accept(id)
      if (!result.success || !result.data.accepted) throw new Error('quote_not_accepted')
      setView({ quote: result.data.quote, now: new Date().toISOString() })
    }}
    onResumeCardRegistration={(id) => router.push(`/hq/onboarding/card?quote=${encodeURIComponent(id)}`)}
    onRequestReissue={async (id) => {
      const result = await api.hqSupport.create({ kind: 'billing', purpose: 'individual_quote',
        subject: `個別見積もり ${id} の再発行依頼`,
        body: `個別見積もり ${id} の期限が切れました。料金を確認し、再発行をお願いします。` })
      if (!result.success) throw new Error('reissue_request_failed')
      router.push('/hq/support')
    }}
    onOpenLatestQuote={() => {
      void api.individualQuotes.customer.latest().then((result) => {
        if (result.success) router.push(`/hq/onboarding/quotes/${encodeURIComponent(result.data.quoteId)}`)
      })
    }} />
}
