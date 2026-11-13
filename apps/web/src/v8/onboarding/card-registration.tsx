'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import ListState from '@/components/shared/list-state'
import { api } from '@/lib/api'

type ReturnState = 'success' | 'cancel' | null

interface Props {
  returnState?: ReturnState
  sessionId?: string | null
  quoteId?: string | null
  onContinue: () => void
  onBackToPricing: () => void
  onOpenCheckout?: (url: string) => void
}

/** Open only a genuine hosted card setup URL returned by the server. */
export function isStripeCardSetupUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'checkout.stripe.com'
  } catch {
    return false
  }
}

/** The route is a transition only: pricing → hosted card form → existing LINE wizard. */
export default function CardRegistration({ returnState = null, sessionId, quoteId,
  onContinue, onBackToPricing, onOpenCheckout }: Props) {
  const [error, setError] = useState(false)
  const [retry, setRetry] = useState(0)
  const startedAttempt = useRef<number | null>(null)
  const run = useCallback(async () => {
    if (returnState === 'success' && sessionId) {
      const confirmed = await api.hqBilling.cardConfirm(sessionId)
      if (!confirmed.success || !confirmed.data.registered) throw new Error('card_not_confirmed')
      onContinue()
      return
    }
    const status = await api.hqBilling.cardStatus({ cache: 'reload' })
    if (!status.success) throw new Error('card_status_unavailable')
    if (status.data.registered) {
      onContinue()
      return
    }
    if (returnState === 'cancel') {
      onBackToPricing()
      return
    }
    // A legacy success URL can be recovered by card-status, but never treated as proof by itself.
    if (returnState === 'success') throw new Error('card_not_confirmed')
    const setup = await api.hqBilling.cardSetup(quoteId ?? undefined)
    if (!setup.success || !isStripeCardSetupUrl(setup.data.url)) throw new Error('invalid_checkout_url')
    if (onOpenCheckout) onOpenCheckout(setup.data.url)
    else window.location.assign(setup.data.url)
  }, [onBackToPricing, onContinue, onOpenCheckout, quoteId, returnState, sessionId])

  useEffect(() => {
    // Route callbacks can change identity during hydration; one attempt opens one Checkout session.
    if (startedAttempt.current === retry) return
    startedAttempt.current = retry
    let active = true
    void run().catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [run, retry])

  if (error) return <ListState kind="error" title="クレジットカード登録を確認できませんでした"
    description="登録済みの情報を確認してから続けます。時間をおいて再試行してください。"
    onRetry={() => { setError(false); setRetry((value) => value + 1) }} />
  return <ListState kind="loading" title={returnState === 'success'
    ? 'クレジットカードの登録を確認しています' : 'クレジットカード登録画面を開いています'} />
}
