'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import type { MusuboLineAdditionState } from '@/lib/api/features/musubo-line-addition'
import PageHeader from '@/components/shared/page-header'
import Card from '@/components/shared/card'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import ListState from '@/components/shared/list-state'
import StepUpPrompt, { isStepUpRequired, type StepUpRequest } from '@/components/step-up-prompt'
import styles from './musubo-line-addition.module.css'

const yen = (value: number) => `¥${new Intl.NumberFormat('ja-JP').format(value)}`
const dateTime = (value: string) => new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric',
  hour: '2-digit', minute: '2-digit',
}).format(new Date(value))

export default function MusuboLineAdditionPage() {
  const router = useRouter()
  const [state, setState] = useState<MusuboLineAdditionState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [stepUp, setStepUp] = useState<StepUpRequest | null>(null)
  const [justActivated, setJustActivated] = useState(false)
  const load = useCallback(async () => {
    const result = await api.musuboLineAddition.get()
    if (!result.success) throw new Error(result.error)
    setState((previous) => {
      if (previous?.pending && !result.data.pending) setJustActivated(true)
      return result.data
    })
  }, [])
  useEffect(() => {
    let disposed = false
    void load().catch(() => { if (!disposed) setError('追加料金を読み込めませんでした。もう一度お試しください。') })
      .finally(() => { if (!disposed) setLoading(false) })
    return () => { disposed = true }
  }, [load])

  const confirm = async (token?: string) => {
    if (!state || busy) return
    setBusy(true); setError('')
    try {
      const amountDueYen = state.pending?.amountDueYen ?? state.price.dueNowYen
      const result = await api.musuboLineAddition.accept({
        amountDueYen, activeLineCount: state.activeLineCount,
      }, token)
      if (!result.success) throw new Error(result.error)
      if (result.data.status === 'activated') {
        setJustActivated(true)
        await load()
      } else if (result.data.canConnect) {
        router.push('/accounts/new')
      } else {
        await load()
      }
    } catch (caught) {
      if (!token && isStepUpRequired(caught)) {
        setStepUp({ purpose: 'line_account.connect', action: 'LINEの追加料金を確定する', retry: confirm })
      } else setError('決済状況を確認できませんでした。内容を読み直して再度お試しください。')
    } finally { setBusy(false) }
  }

  if (loading) return <ListState kind="loading" title="LINE追加料金を確認しています" />
  if (!state) return <ListState kind="error" title="LINE追加料金を表示できませんでした" />
  const pending = state.pending
  const expired = state.expired === true
  const ordinal = state.price.addedLineOrdinal
  const failed = pending && !pending.canConnect && pending.status === 'awaiting_payment' && !expired
  const checking = pending?.activationPending
  return <div className={styles.page}>
    <PageHeader breadcrumb={[{ label: 'ホーム', href: '/' }, { label: 'アカウント', href: '/accounts' },
      { label: 'LINE追加' }]} title={justActivated ? `${ordinal}個目のLINEを追加しました`
      : failed ? 'LINE追加のお支払いが未完了です'
        : checking ? '追加分のお支払いを確認しています'
          : expired ? '追加料金の確認期限が過ぎました'
            : `${ordinal}個目のLINEを追加しますか`} />
    {error && <Notice tone="danger" message={error} />}
    {justActivated ? <Notice tone="success" heading="追加したLINEを利用できます"
      message="追加分の決済とLINEの有効化が完了しました。" />
      : failed ? <Notice tone="warn" heading="追加分のお支払いが完了していません"
        message="接続情報は保存済みです。決済成功後に追加したLINEを有効化します。既存のLINEはそのまま使えます。" />
        : checking ? <Notice tone="info" heading="決済結果を確認しています"
          message="追加したLINEは有効化待ちです。既存のLINEはそのまま使えます。" />
          : expired ? <Notice tone="warn" heading="追加分の保留期限が過ぎました"
            message="最新の料金を確認してから、もう一度追加してください。" /> : null}
    <div className={styles.columns}>
      <Card as="section" layout="vertical" padding="roomy" gap="normal">
        <h2>{failed ? '追加分のお支払い' : '追加料金のご確認'}</h2>
        <div className={styles.priceRows}>
          <div><span>追加するLINE</span><strong>{ordinal}個目</strong></div>
          <div><span>LINE基本料金の増分</span><strong>{yen(state.price.coreIncrementYen)}／{state.price.coreIncrementInterval === 'year' ? '年' : '月'}</strong></div>
          {state.price.headquartersIncrementMonthlyYen > 0 &&
            <div><span>統括料金の増分</span><strong>{yen(state.price.headquartersIncrementMonthlyYen)}／月</strong></div>}
          <div><span>追加後のLINE基本料金</span><strong>{yen(state.recurringAfter.coreYen)}／{state.recurringAfter.coreInterval === 'year' ? '年' : '月'}</strong></div>
          <div><span>追加後の月額オプション</span><strong>{yen(state.recurringAfter.optionsYen)}／月</strong></div>
        </div>
        <div className={styles.due}><span>今回の追加分（税込）</span>
          <strong>{yen(pending?.amountDueYen ?? state.price.dueNowYen)}</strong></div>
        <p className={styles.explanation}>{state.price.dueNowYen === 0
          ? '無料体験中のため、本日の請求はありません。LINEの接続が完了すると追加分を有効化します。'
          : 'LINEの接続情報を確認した後、追加分の決済が成功すると有効化します。決済が完了しなければ既存のLINEはそのまま使えます。'}</p>
        {pending && !justActivated && <p className={styles.explanation}>保留期限：{dateTime(pending.expiresAt)}</p>}
      </Card>
      <Card as="section" layout="vertical" padding="roomy" gap="normal">
        <h2>{failed ? '追加を完了するには' : 'この後の流れ'}</h2>
        <ol className={styles.flow}>
          <li>料金を確認してLINEアカウントを接続</li>
          <li>有料利用中は追加分のお支払いを確認</li>
          <li>決済成功後に新しいLINEを有効化</li>
        </ol>
        <p className={styles.explanation}>カード情報はStripeで扱い、musuboには保存しません。</p>
        <div className={styles.actions}>
          {justActivated ? <Button href="/accounts">アカウント一覧へ</Button>
            : pending?.canConnect && !expired ? <Button href="/accounts/new">LINE接続へ</Button>
              : failed ? <>
                {pending?.paymentUrl && <Button variant="secondary" external href={pending.paymentUrl}>Stripeでお支払いを確認</Button>}
                <Button type="button" busy={busy} onClick={() => void confirm()}>カードを確認して再試行</Button>
              </> : checking ? <Button type="button" busy={busy} onClick={() => void load()}>決済状況を再確認</Button>
                : expired ? <Button type="button" busy={busy} onClick={() => void confirm()}>最新の料金でLINE接続へ</Button>
                  : <Button type="button" busy={busy} onClick={() => void confirm()}>確認してLINE接続へ</Button>}
        </div>
      </Card>
    </div>
    {stepUp && <StepUpPrompt request={stepUp} onDone={() => setStepUp(null)} onClose={() => setStepUp(null)} />}
  </div>
}
