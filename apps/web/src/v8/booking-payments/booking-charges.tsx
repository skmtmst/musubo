'use client'
import { formatYen as yen } from '@line-crm/shared';

import ListDateTime from '@/components/shared/list-date-time'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, CreditCard, MessageCircle, RotateCcw } from 'lucide-react'
import type { BookingCancellationCharge, BookingCancellationQuote } from '@line-crm/shared'
import Button from '@/components/shared/button'
import { usePreparingDialog } from '@/components/shared/preparing-dialog'
import Dialog from '@/components/shared/dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import StatusBadge, { type StatusBadgeTone } from '@/components/shared/status-badge'
import TestModeNote from '@/components/shared/test-mode-note'
import ListState from '@/components/shared/list-state'
import { TextField } from '@/components/shared/text-field'
import { Field } from '@/components/shared/form-controls'
import { notifySaved } from '@/components/shared/toast'
import { ApiError } from '@/lib/api'
import { bookingCancellationApi } from '@/lib/api/helpers/gap1'
import { bookingAdvancedApi } from '@/lib/api/helpers/booking-advanced'
type BookingCard = NonNullable<Awaited<ReturnType<typeof bookingAdvancedApi.card>>['data']>
import styles from './booking-charges.module.css'
import Notice from '@/components/shared/notice'
import { withHonorific } from '@line-crm/shared'

/*
 * 予約の詳細の「お支払い」の段（B1・絵 Ae1W1・fom2A）。キャンセル料の請求・請求しない・返金（2 段の確かめ）。
 * 口は gap1（bookingCancellationApi・模擬の請求と返金。本当の請求・LINE の送信はしない）。
 * カード情報は予約の実APIから読む。未登録と取得失敗を分ける。
 * 権限：請求する・請求しないはオーナー・管理者・スタッフ、返金はオーナー・管理者だけ、閲覧のみはボタンを出さない。
 */

const STATUS: Record<BookingCancellationCharge['status'], { label: string; tone: StatusBadgeTone }> = {
  pending: { label: '請求できる', tone: 'warning' },
  processing: { label: '請求中', tone: 'info' },
  succeeded: { label: '請求済み', tone: 'success' },
  failed: { label: 'カードの失敗', tone: 'danger' },
  unknown: { label: '確かめ中', tone: 'neutral' },
  waived: { label: '請求しない', tone: 'neutral' },
  refunded: { label: '返金済み', tone: 'neutral' },
}
const uuid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`)

type Load = { state: 'loading' } | { state: 'ready'; charges: BookingCancellationCharge[]; quote: BookingCancellationQuote; testMode: boolean } | { state: 'error' }

export function BookingChargesSection(props: Parameters<typeof BookingChargesInner>[0]) {
  return <BookingChargesInner key={`${props.accountId}:${props.bookingId}`} {...props} />
}

function BookingChargesInner({ accountId, bookingId, customerName, bookingLabel, price, canCharge, canRefund }: {
  accountId: string
  bookingId: string
  customerName: string
  bookingLabel: string
  price: number | null
  /** 請求する・請求しない（オーナー・管理者・スタッフ）。 */
  canCharge: boolean
  /** 返金する（オーナー・管理者）。 */
  canRefund: boolean
}) {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [card, setCard] = useState<BookingCard | null>(null)
  const [cardFailure, setCardFailure] = useState<unknown>(null)
  const [cardLoading, setCardLoading] = useState(true)
  const cardRequest = useRef(0)
  const [dialog, setDialog] = useState<'charge' | 'waive' | 'refund' | null>(null)
  const [waiveTarget, setWaiveTarget] = useState<{ accountId: string; chargeId: string; version: number; customerName: string; bookingLabel: string; epoch: number } | null>(null)
  const scope = useRef({ canCharge, canRefund, epoch: 0 })
  if (scope.current.canCharge !== canCharge || scope.current.canRefund !== canRefund) scope.current = { canCharge, canRefund, epoch: scope.current.epoch + 1 }
  const [refundStep, setRefundStep] = useState<1 | 2>(1)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const key = useRef(uuid())
  const preparing = usePreparingDialog()

  const reloadCard = useCallback(async () => {
    const request = ++cardRequest.current
    setCardLoading(true); setCardFailure(null); setCard(null)
    try {
      const response = await bookingAdvancedApi.card(accountId, bookingId)
      if (!response.success) throw new Error('カード情報を読み込めませんでした')
      if (cardRequest.current === request) setCard(response.data)
    } catch (cause) {
      if (cardRequest.current === request) setCardFailure(cause)
    } finally {
      if (cardRequest.current === request) setCardLoading(false)
    }
  }, [accountId, bookingId])

  const reload = useCallback(async () => {
    void reloadCard()
    setLoad({ state: 'loading' })
    try {
      const response = await bookingCancellationApi.charges(accountId, bookingId)
      setLoad({ state: 'ready', charges: response.data.charges, quote: response.data.quote, testMode: response.data.testMode })
    } catch {
      setLoad({ state: 'error' })
    }
  }, [accountId, bookingId, reloadCard])
  useEffect(() => { void reload(); return () => { cardRequest.current += 1 } }, [reload])

  if (load.state === 'loading') return <section className={styles.section}><h3 className={styles.title}>お支払い</h3><p className={styles.minor}>読み込んでいます…</p></section>
  if (load.state === 'error') return <section className={styles.section}><h3 className={styles.title}>お支払い</h3><p className={styles.minor}>—（取得失敗）</p><Button size="compact" onClick={() => void reload()}>もう一度</Button></section>
  const charge = load.charges[load.charges.length - 1] ?? null
  if (!charge) return null
  const badge = STATUS[charge.status]
  const percent = price ? Math.round(charge.amount / price * 100) : null
  const cardLabel = card ? `${card.brand} •••• ${card.last4}` : '—'
  const open = (next: 'charge' | 'waive' | 'refund') => {
    if (next !== 'waive' && !load.testMode) {
      preparing.open(next === 'charge' ? 'カードの請求' : 'カードの返金')
      return
    }
    if (next === 'waive') setWaiveTarget({ accountId, chargeId: charge.id, version: charge.version, customerName, bookingLabel, epoch: scope.current.epoch })
    setError(null); setReason(''); setRefundStep(1); key.current = uuid(); setDialog(next)
  }
  const close = () => { if (!busy) setDialog(null) }

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true); setError(null)
    try {
      await action()
      notifySaved(done)
      setDialog(null)
      await reload()
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 409 ? (cause.code === 'card_not_registered' ? 'カードが登録されていないため請求できません。支払いのリンクを送ってください。' : 'すでに請求しています。読み直してください。')
        : cause instanceof ApiError && cause.status === 403 ? 'この操作をする権限がありません。'
          : cause instanceof ApiError && cause.status === 400 ? '理由を入れてください。'
            : 'できませんでした。もう一度お試しください。')
    } finally {
      setBusy(false)
    }
  }

  const reasonLine = `${charge.kind === 'no_show_fee' ? '連絡なしの欠席' : '期限を過ぎた取り消し'}・料金${price ? ` ${yen(price)}` : ''} の ${percent ?? '—'}%`
  return (
    <section className={styles.section} aria-label="お支払い">
      <div className={styles.headRow}><h3 className={styles.title}>キャンセル料</h3><StatusBadge tone={badge.tone}>{badge.label}</StatusBadge></div>
      {load.testMode ? <TestModeNote>本当の請求は起きません</TestModeNote> : null}
      {cardFailure ? <ListState kind="error" title="カード情報を読み込めませんでした" error={cardFailure} onRetry={() => void reloadCard()} /> : <p className={styles.line}><CreditCard size={16} aria-hidden="true" />{cardLoading ? 'カード情報を確かめています' : card ? <>{cardLabel}（登録済み{card.registeredAt ? <ListDateTime value={card.registeredAt} /> : null}）</> : 'カード：未登録'}</p>}
      <p className={styles.amount}>{`${yen(charge.amount)}（料金の ${percent ?? '—'}%）`}</p>
      {charge.reason ? <p className={styles.minor}>{`理由：${charge.reason}`}</p> : null}
      <p className={styles.minor}>{`予約のときの決まりで計算（${load.quote.text}）`}</p>
      <div className={styles.actions}>
        {canCharge && charge.status === 'pending' ? <><Button onClick={() => open('waive')}>請求しない（理由を書く）</Button><Button variant="primary" disabled={cardLoading || Boolean(cardFailure)} onClick={() => open('charge')}><CreditCard size={16} aria-hidden="true" />キャンセル料を請求する</Button></> : null}
        {canRefund && charge.status === 'succeeded' ? <Button onClick={() => open('refund')}>返金する</Button> : null}
      </div>

      {preparing.dialog}

      {/* 請求の確かめ（Ae1W1）：金額・カード・わけ。額は決まりの額だけ（上げられない）。 */}
      <Dialog open={dialog === 'charge'} title="キャンセル料を請求しますか？" titleNote={`${withHonorific(customerName, 'さま', { space: true })}・${bookingLabel}`} size="medium" contentLayout="form"
        busy={busy} error={error ?? undefined} cancelLabel="戻る" onCancel={close}
        confirmLabel={`${yen(charge.amount)} を請求する`} confirmIcon={<CreditCard size={16} aria-hidden="true" />}
        onConfirm={() => void run(() => bookingCancellationApi.charge(accountId, bookingId, { kind: charge.kind, amount: charge.amount, expectedVersion: charge.version }, key.current), `${yen(charge.amount)} の請求を模擬で記録しました。実際の請求・LINE送信はしていません`)}>
        <dl className={styles.facts}>
          <div><dt>金額</dt><dd className={styles.big}>{yen(charge.amount)}</dd></div>
          <div><dt>カード</dt><dd>{cardLabel}</dd></div>
          <div><dt>わけ</dt><dd>{reasonLine}</dd></div>
        </dl>
        {load.testMode ? <TestModeNote>本当の請求は起きません</TestModeNote> : null}
        <Notice tone="info" icon={<MessageCircle size={16} aria-hidden="true" />}>
          試験の請求を記録します。実際のカード請求・LINE送信はしていません。金額は決まりの額より上げられません。
        </Notice>
      </Dialog>

      {/* 請求しない：理由は必須。 */}
      <Dialog open={dialog === 'waive' && canCharge && waiveTarget !== null && waiveTarget.epoch === scope.current.epoch} title="キャンセル料を請求しませんか？" titleNote={`${withHonorific(waiveTarget?.customerName ?? '', 'さま', { space: true })}・${waiveTarget?.bookingLabel ?? ''}`} size="small" contentLayout="form"
        busy={busy} error={error ?? undefined} cancelLabel="戻る" onCancel={close} confirmLabel="請求しない" confirmDisabled={!reason.trim()} confirmDisabledReason="理由を入れてください"
        onConfirm={() => { if (!waiveTarget || !canCharge || waiveTarget.epoch !== scope.current.epoch || waiveTarget.chargeId !== charge.id || waiveTarget.version !== charge.version) { setError('請求内容が変わりました。閉じて読み直し、もう一度選んでください。'); return } void run(() => bookingCancellationApi.waive(waiveTarget.accountId, waiveTarget.chargeId, reason.trim(), waiveTarget.version), '請求しないにしました') }}>
        <OperationTargetSummary accounts={[{ id: waiveTarget?.accountId ?? '' }]} externalTarget={{ label: 'お客さま', name: waiveTarget?.customerName }} />
        <Field label="請求しない理由" required><TextField aria-label="請求しない理由" value={reason} maxLength={500} placeholder="例：初めての取り消しなので今回は請求しない" onChange={(event) => setReason(event.target.value)} /></Field>
        <p className={styles.minor}>理由は記録に残ります（だれが・いつ・理由）。</p>
      </Dialog>

      {/* 返金（2 段・fom2A は 2 段目）：全額だけ。 */}
      <Dialog open={dialog === 'refund' && refundStep === 1} title="返金する" titleNote={`手順 1 / 2・${withHonorific(customerName, 'さま', { space: true })}へキャンセル料を全額返金`} size="medium" contentLayout="form"
        cancelLabel="キャンセル" onCancel={close} confirmLabel="次へ" confirmDisabled={!reason.trim()} confirmDisabledReason="理由を入れてください" onConfirm={() => setRefundStep(2)}>
        <dl className={styles.facts}>
          <div><dt>金額</dt><dd className={styles.big}>{yen(charge.amount)}</dd></div>
          <div><dt>カード</dt><dd>{cardLabel}</dd></div>
        </dl>
        <Field label="返金の理由" required><TextField aria-label="返金の理由" value={reason} maxLength={500} placeholder="例：お店の都合で取り消しにした" onChange={(event) => setReason(event.target.value)} /></Field>
        <p className={styles.minor}>試験の全額返金だけを記録します。実際のカードへの返金・LINE送信はしません。</p>
      </Dialog>
      <Dialog open={dialog === 'refund' && refundStep === 2} title="返金すると戻せません" titleNote={`手順 2 / 2・${withHonorific(customerName, 'さま', { space: true })}へキャンセル料を全額返金`} size="medium" contentLayout="form" tone="destructive"
        busy={busy} error={error ?? undefined} cancelLabel="戻る" onCancel={() => { if (!busy) setRefundStep(1) }}
        confirmLabel={`${yen(charge.amount)} を返金する`} confirmIcon={<RotateCcw size={16} aria-hidden="true" />}
        onConfirm={() => void run(() => bookingCancellationApi.refund(accountId, charge.id, { reason: reason.trim(), expectedVersion: charge.version, confirmed: true, confirmedIrreversible: true }, key.current), `${yen(charge.amount)} の返金を模擬で記録しました。実際の返金・LINE送信はしていません`)}>
        <dl className={styles.facts}>
          <div><dt>金額</dt><dd className={styles.big}>{yen(charge.amount)}</dd></div>
          <div><dt>カード</dt><dd>{cardLabel}</dd></div>
          <div><dt>わけ</dt><dd>{`${reason.trim()}（理由は記録に残ります）`}</dd></div>
        </dl>
        <Notice tone="warn" icon={<AlertTriangle size={16} aria-hidden="true" />}>
          試験の返金を記録すると元に戻せません。実際のカードへの返金はしません。操作できるのはオーナー・管理者だけです。
        </Notice>
      </Dialog>
    </section>
  )
}
