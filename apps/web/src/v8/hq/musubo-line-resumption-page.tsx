'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import type { MusuboLineResumptionState } from '@/lib/api/features/musubo-line-resumption'
import type { LineResumeCompleteView } from './line-resumption'
import ListState from '@/components/shared/list-state'
import StepUpPrompt, { isStepUpRequired, type StepUpRequest } from '@/components/step-up-prompt'
import { LineResumptionComplete, LineResumptionHandover, LineResumptionReview } from './line-resumption'

const reviewPath = '/hq/billing/resume'
const cardPath = '/hq/billing/resume/card'
const completePath = '/hq/billing/resume/complete'

export function MusuboLineResumptionReviewPage() {
  const router = useRouter()
  const [state, setState] = useState<MusuboLineResumptionState | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    const result = await api.musuboLineResumption.get()
    if (!result.success) throw new Error(result.error)
    setState(result.data)
  }, [])
  useEffect(() => { void load().catch(() => setError('再開時の料金を表示できませんでした。')) }, [load])
  if (!state) return <ListState kind={error ? 'error' : 'loading'}
    title={error || '再開時の料金を確認しています'} />
  const accept = async () => {
    const result = await api.musuboLineResumption.accept()
    if (!result.success) { await load(); throw new Error(result.error) }
    router.push(cardPath)
  }
  const payOutstanding = async () => {
    const result = await api.hqBilling.invoices()
    if (!result.success) throw new Error(result.error)
    const invoice = result.data.find((item) =>
      (item.status === 'open' || item.status === 'uncollectible') && item.hostedUrl)
    if (!invoice?.hostedUrl) throw new Error('請求書を確認できませんでした')
    window.location.assign(invoice.hostedUrl)
  }
  return <LineResumptionReview view={state.review} onContinue={accept}
    onPayOutstanding={payOutstanding} onBack={() => router.push('/hq/billing')} />
}

export function MusuboLineResumptionCardPage() {
  const router = useRouter()
  const [state, setState] = useState<MusuboLineResumptionState | null>(null)
  const [cardReady, setCardReady] = useState<boolean | null>(null)
  const [error, setError] = useState('')
  const [stepUp, setStepUp] = useState<StepUpRequest | null>(null)
  const load = useCallback(async () => {
    const [resume, card] = await Promise.all([
      api.musuboLineResumption.get(), api.hqBilling.cardStatus(),
    ])
    if (!resume.success) {
      const complete = await api.musuboLineResumption.complete()
      if (complete.success) { router.push(completePath); return }
      throw new Error('再開の状態を確認できませんでした')
    }
    if (!card.success) throw new Error('カードの状態を確認できませんでした')
    setState(resume.data); setCardReady(card.data.registered)
  }, [router])
  useEffect(() => { void load().catch(() => setError('再開の状態を確認できませんでした。')) }, [load])
  if (!state || cardReady === null) return <ListState kind={error ? 'error' : 'loading'}
    title={error || 'カードと再開条件を確認しています'} />
  if (!state.consented) return <ListState kind="error" title="料金の確認が必要です"
    description="再開時の料金が変わったか、未払いが発生しました。料金を読み直してください。"
    action={<a href={reviewPath}>料金を確認する</a>} />
  if (state.reconciliationPending) return <div role="status">
    <h1>お支払いとLINE接続を確認しています</h1>
    <p>再開の結果を確認中です。重複したお支払いは行わず、結果が確定すると利用を再開します。</p>
    <button type="button" onClick={() => void load()}>状態を再確認する</button>
  </div>
  const primary = async (token?: string) => {
    if (!cardReady) {
      const result = await api.hqBilling.cardSetup(undefined, true)
      if (!result.success) throw new Error(result.error)
      window.location.assign(result.data.url)
      return
    }
    try {
      const result = await api.musuboLineResumption.connect(token)
      if (!result.success) throw new Error(result.error)
      if (result.data.active) router.push(completePath)
      else await load()
    } catch (caught) {
      if (!token && isStepUpRequired(caught)) {
        setStepUp({ purpose: 'line_account.connect', action: 'LINEの利用を再開する',
          retry: async (grant) => { await primary(grant) } })
        return
      }
      await load().catch(() => undefined)
      throw caught
    }
  }
  return <>
    {error && <p role="alert">{error}</p>}
    <LineResumptionHandover phase={cardReady ? 'ready' : 'card_required'}
      onPrimary={() => primary()} onBack={() => router.push(reviewPath)} />
    {stepUp && <StepUpPrompt request={stepUp} onDone={() => setStepUp(null)}
      onClose={() => setStepUp(null)} />}
  </>
}

export function MusuboLineResumptionCompletePage() {
  const router = useRouter()
  const [view, setView] = useState<LineResumeCompleteView | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    void api.musuboLineResumption.complete().then((result) => {
      if (!result.success) throw new Error(result.error)
      setView(result.data)
    }).catch(() => setError('再開の決済結果を確認しています。少し待ってから読み直してください。'))
  }, [])
  if (!view) return <ListState kind={error ? 'error' : 'loading'}
    title={error || '利用再開の結果を確認しています'} />
  return <LineResumptionComplete view={view} onAccounts={() => router.push('/accounts')} />
}
