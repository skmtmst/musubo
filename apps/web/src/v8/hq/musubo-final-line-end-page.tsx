'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import type { MusuboFinalLineEndState } from '@/lib/api/features/musubo-final-line-end'
import ListState from '@/components/shared/list-state'
import StepUpPrompt, { isStepUpRequired, type StepUpRequest } from '@/components/step-up-prompt'
import LastLineEnd, { type LastLineEndSchedule } from './last-line-end'

const instant = (date: string | null) => date ? `${date}T00:00:00+09:00` : undefined

export default function MusuboFinalLineEndPage() {
  const router = useRouter()
  const [end, setEnd] = useState<MusuboFinalLineEndState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [stepUp, setStepUp] = useState<StepUpRequest | null>(null)
  const [now] = useState(() => new Date().toISOString())
  const load = useCallback(async () => {
    const result = await api.musuboFinalLineEnd.get()
    if (!result.success) throw new Error(result.error)
    setEnd(result.data)
  }, [])
  useEffect(() => {
    let disposed = false
    void load().catch(() => { if (!disposed) setError('利用終了の状態を確認できませんでした。') })
      .finally(() => { if (!disposed) setLoading(false) })
    return () => { disposed = true }
  }, [load])

  const change = async (action: 'schedule' | 'now' | 'cancel', token?: string) => {
    setError('')
    try {
      const result = await api.musuboFinalLineEnd.change(action, token)
      if (!result.success) throw new Error(result.error)
      setEnd(result.data.end)
    } catch (caught) {
      if (!token && isStepUpRequired(caught)) {
        setStepUp({ purpose: 'line_account.archive',
          action: action === 'cancel' ? '利用終了の予約を取り消す' : '最後のLINEの利用を終了する',
          retry: async (grant) => { await change(action, grant) },
        })
        return
      }
      await load().catch(() => undefined)
      setError(caught instanceof Error ? caught.message
        : '状態を確認できませんでした。内容を読み直してから再度お試しください。')
    }
  }

  if (loading) return <ListState kind="loading" title="利用終了の状態を確認しています" />
  if (!end) return <ListState kind="error" title="利用終了の状態を表示できませんでした" />
  const schedule: LastLineEndSchedule = {
    billingState: end.billingState === 'trialing' ? 'trialing' : 'active',
    interval: end.interval,
    trialFirstChargeAt: instant(end.firstChargeDate),
    nextMonthlyChargeAt: instant(end.nextMonthlyChargeDate),
    nextAnnualRenewalAt: instant(end.nextAnnualRenewalDate),
  }
  return <>
    {error && <p role="alert">{error}</p>}
    <LastLineEnd lineName={end.lineName} schedule={schedule} now={now}
      phase={end.phase} scheduledEndAt={end.scheduledEndAt ?? undefined}
      unpaidInvoiceYen={end.unpaidInvoiceYen}
      onSchedule={() => change('schedule')} onEndNow={() => change('now')}
      onCancelSchedule={() => change('cancel')} onBack={() => router.push('/accounts')} />
    {stepUp && <StepUpPrompt request={stepUp} onDone={() => setStepUp(null)}
      onClose={() => setStepUp(null)} />}
  </>
}
