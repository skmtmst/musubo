'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import type { MusuboLineRemovalState } from '@/lib/api/features/musubo-line-removal'
import StepUpPrompt, { isStepUpRequired, type StepUpRequest } from '@/components/step-up-prompt'
import Button from '@/components/shared/button'
import Dialog from '@/components/shared/dialog'
import Notice from '@/components/shared/notice'
import { japaneseDetailOf } from '@/components/shared/api-error-message'
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card'
import styles from './musubo-line-removal-dialog.module.css'

const date = (value: string | null) => value ? new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric',
}).format(new Date(value)) : '確認中'
const lastUsableDate = (value: string | null) => value
  ? date(new Date(Date.parse(value) - 1).toISOString()) : '確認中'
const yen = (value: number) => `¥${new Intl.NumberFormat('ja-JP').format(value)}`

export default function MusuboLineRemovalDialog({ lineId, onClose, onChanged }: {
  lineId: string; onClose: () => void; onChanged: () => void
}) {
  const [state, setState] = useState<MusuboLineRemovalState | null>(null)
  const [selection, setSelection] = useState<'schedule' | 'now'>('schedule')
  const [confirmNow, setConfirmNow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [stepUp, setStepUp] = useState<StepUpRequest | null>(null)
  const load = useCallback(async () => {
    const response = await api.musuboLineRemoval.get(lineId)
    if (!response.success) throw new Error(response.error)
    setState(response.data)
  }, [lineId])
  useEffect(() => { void load().catch(() => setError('利用終了の状態を読み込めませんでした。')) }, [load])

  const change = async (action: 'schedule' | 'now' | 'cancel', grant?: string) => {
    setBusy(true); setError('')
    try {
      const result = await api.musuboLineRemoval.change(lineId, action, grant)
      if (!result.success) throw new Error(result.error)
      await load()
      onChanged()
      setConfirmNow(false)
    } catch (cause) {
      if (!grant && isStepUpRequired(cause)) {
        setStepUp({ purpose: 'line_account.archive',
          action: action === 'cancel' ? '利用終了予約を取り消す' : 'LINEの利用を終了する',
          retry: async (token) => { await change(action, token) },
        })
      } else {
        await load().catch(() => undefined)
        setError(japaneseDetailOf(cause) || '利用終了の状態を確認できませんでした。')
      }
    } finally { setBusy(false) }
  }

  const endLabel = state?.billingStatus === 'trialing' ? '無料体験の終了日'
    : state?.billingInterval === 'year' ? '次の年次更新日' : '次の月次請求日'
  return <>
    <Dialog open title={`${state?.lineName ?? 'LINE'}の利用を終了しますか`}
      description="LINEアカウントの利用終了" size="large" onCancel={onClose} busy={busy}
      error={error || undefined} dirty={false}
      footer={<div className={styles.actions}>
        {state?.phase === 'scheduled' ? <Button type="button" variant="secondary" disabled={busy}
          onClick={() => void change('cancel')}>終了予約を取り消す</Button> : null}
        {state?.phase === 'choose' ? <Button type="button" variant={confirmNow ? 'danger' : 'primary'}
          disabled={busy || !state.priceEstimate} onClick={() => {
            if (selection === 'now' && !confirmNow) { setConfirmNow(true); return }
            void change(selection)
          }}>{confirmNow ? '今すぐ利用を終了する' : selection === 'schedule'
            ? 'この内容で終了を予約する' : '終了内容を確認する'}</Button> : null}
      </div>}>
      {!state ? <Notice tone="info">利用状況を確認しています…</Notice>
        : state.phase === 'ended' ? <div className={styles.result} role="status">
          <span className={styles.resultIcon} aria-hidden="true">✓</span>
          <div><h3>LINEの利用を終了しました</h3>
            <p>{state.otherLineName}は引き続き利用できます。次の請求から減額します。</p></div></div>
        : state.phase === 'scheduled' ? <div className={styles.result} role="status">
          <span className={styles.resultIcon} aria-hidden="true">✓</span>
          <div><h3>{date(state.requestedEndAt)}に終了します</h3>
            <p>{lastUsableDate(state.requestedEndAt)}まで利用できます。支払済みの基本料金の返金はありません。</p></div></div>
        : state.phase !== 'choose' ? <Notice tone="info">
          決済サービスとの料金照合を確認しています。少し待ってから再読み込みしてください。</Notice>
        : <>
          <p>残すLINEは「{state.otherLineName}」です。終了日を選んでください。</p>
          <RadioCardGroup className={styles.choices} legend="利用終了日">
            <RadioCard name="line-removal" value="schedule" checked={selection === 'schedule'}
              onChange={() => { setSelection('schedule'); setConfirmNow(false) }}
              title={`${endLabel}に終了する`} height="fit"
              note={<>{lastUsableDate(state.scheduledEndAt)}まで利用できます。LINE基本料金は{state.billingInterval === 'year' ? '次の年次更新' : '次の月次請求'}から1個分になります。</>}>
              <span className={styles.recommended}>推奨</span>
            </RadioCard>
            <RadioCard name="line-removal" value="now" checked={selection === 'now'}
              onChange={() => setSelection('now')} title="今すぐ利用を終了する" height="fit"
              note="接続と配信はすぐに停止します。支払済みのLINE基本料金は返金されません。" />
          </RadioCardGroup>
          <div className={styles.summary}>
            <h3>終了後のお支払い予定</h3>
            <div><span>有効LINE</span><strong>2個 → 1個</strong></div>
            <div><span>LINE基本料金</span><strong>{state.priceEstimate
              ? `${yen(state.priceEstimate.afterCoreYen)}／${state.billingInterval === 'year' ? '年' : '月'}` : '確認中'}</strong></div>
            <div><span>統括・追加料金</span><strong>{state.priceEstimate
              ? `${yen(state.priceEstimate.afterMonthlyOptionsYen)}／月` : '確認中'}</strong></div>
            <p>{state.billingInterval === 'year' && selection === 'now'
              ? `統括機能の減額は次の月次請求日（${date(state.nextMonthlyChargeAt ? `${state.nextMonthlyChargeAt}T00:00:00+09:00` : null)}）からです。LINE基本料金の減額は次の年次更新からです。`
              : '統括機能と友だち数などの料金は、終了日と実際の利用状況に合わせて計算します。'}
              表示額は現在の利用状況による概算です。</p>
          </div>
          {confirmNow && <p className={styles.warning}>確定すると、このLINEはすぐに利用できなくなります。</p>}
        </>}
    </Dialog>
    {stepUp && <StepUpPrompt request={stepUp} onDone={() => setStepUp(null)}
      onClose={() => setStepUp(null)} />}
  </>
}
