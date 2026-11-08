'use client'

import Button from '@/components/shared/button'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { musuboLinkedRemovalPrice, type LinkedAccountCounts, type MusuboLinkedService } from '@line-crm/shared'
import styles from './linked-account-addition.module.css'

interface BaseProps {
  lineName: string
  connectionName: string
  service: MusuboLinkedService
  before: LinkedAccountCounts
  slotUnitYen: number
  /** Server-calculated next monthly billing boundary. Never derive this from the client's clock. */
  nextMonthlyChargeAt: string
  onBack: () => void
}

type Props = BaseProps & (
  | { phase: 'review'; onConfirm: () => Promise<void> | void }
  | { phase: 'complete'; onAccounts: () => void; onBilling: () => void }
)

const yen = (value: number) => `¥${new Intl.NumberFormat('ja-JP').format(value)}`
const serviceName = (service: MusuboLinkedService) => service === 'googleBusiness' ? 'Googleマイビジネス' : 'Instagram'
const day = (value: string) => new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric',
}).format(new Date(value))

/** A server-verified removal preview. The actual disconnect and billing update are one backend transaction. */
export default function LinkedAccountRemovalModal(props: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dialogRef = useRef<HTMLElement>(null)
  const primaryRef = useRef<HTMLButtonElement>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  const result = useMemo(() => {
    try { return musuboLinkedRemovalPrice(props) }
    catch { return null }
  }, [props.before, props.service, props.slotUnitYen])
  const dateText = useMemo(() => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(props.nextMonthlyChargeAt)) return null
    const calendarPart = props.nextMonthlyChargeAt.slice(0, 10)
    const calendar = new Date(`${calendarPart}T00:00:00.000Z`)
    if (Number.isNaN(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== calendarPart) return null
    const date = new Date(props.nextMonthlyChargeAt)
    return Number.isNaN(date.getTime()) ? null : day(props.nextMonthlyChargeAt)
  }, [props.nextMonthlyChargeAt])

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    primaryRef.current?.focus()
    return () => { previous?.focus() }
  }, [])

  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); if (!busy) props.onBack(); return }
    if (event.key !== 'Tab') return
    const first = backRef.current
    const last = primaryRef.current
    if (!first || !last || !dialogRef.current) return
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }

  const confirm = async () => {
    if (props.phase !== 'review' || busy) return
    setBusy(true); setError('')
    try { await props.onConfirm() }
    catch { setError('連携を解除できませんでした。時間をおいて再度お試しください。') }
    finally { setBusy(false) }
  }

  if (!result || !dateText) return <div className={styles.backdrop} role="presentation">
    <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="linked-removal-error-title">
      <h2 id="linked-removal-error-title">料金を表示できません</h2>
      <p>連携数、料金、または次回の請求日を確認できませんでした。画面を閉じて、もう一度お試しください。</p>
      <button type="button" className={styles.backOnly} onClick={props.onBack}>戻る</button>
    </section>
  </div>

  const label = serviceName(props.service)
  const hasReduction = result.monthlyDecreaseYen > 0
  const counts = `Googleマイビジネス ${result.after.googleBusiness}個・Instagram ${result.after.instagram}個`
  return <div className={styles.backdrop} role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !busy) props.onBack()
  }}><section ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="linked-removal-title" onKeyDown={keyDown}>
    <h2 id="linked-removal-title">{props.phase === 'review' ? `${label}の連携を解除しますか` : '連携を解除しました'}</h2>
    <p className={styles.lead}>{props.phase === 'review'
      ? `${props.lineName}の「${props.connectionName}」を今すぐ停止します。`
      : `「${props.connectionName}」の連携は停止しています。`}</p>
    <div className={styles.priceBox}>
      <span>{props.phase === 'review' ? '次の月次請求からの減額（税込）' : '現在の追加枠'}</span>
      <strong>{props.phase === 'review'
        ? hasReduction ? `−${yen(result.monthlyDecreaseYen)} / 月` : '¥0 / 月（変更なし）'
        : `${result.slotsBefore}枠 → ${result.slotsAfter}枠`}</strong>
      <p>{props.phase === 'review'
        ? `${label} ${result.before[props.service]}個→${result.after[props.service]}個｜追加枠 ${result.slotsBefore}枠→${result.slotsAfter}枠`
        : `${counts}｜追加枠 ${result.slotsAfter}枠`}</p>
    </div>
    <div className={styles.afterPrice}><span>次の月次請求からの追加枠料金（税込）</span>
      <strong>{yen(result.monthlySlotsAfterYen)} / 月</strong></div>
    <div className={styles.dueBox}><span>{props.phase === 'review' ? '減額の開始日' : '減額の適用日'}</span>
      <strong>{dateText}（次の月次請求日）</strong></div>
    <p className={styles.note}>{props.phase === 'review'
      ? `連携は今すぐ停止します。支払済み期間の返金はなく、${hasReduction ? '次の月次請求日から減額します' : '追加枠の料金は変わりません'}。年払いでも追加枠は毎月請求します。`
      : hasReduction
        ? '支払済みの枠は次回請求日まで別の連携先に使えます。再追加した場合は減額予定を再計算します。'
        : 'ほかの連携先は引き続き利用できます。連携先を追加するときは料金を確認してから進みます。'}</p>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <div className={styles.actions}><button ref={backRef} type="button" className={styles.back} disabled={busy}
      onClick={props.phase === 'review' ? props.onBack : props.onBilling}>{props.phase === 'review' ? '戻る' : '請求を見る'}</button>
      <Button ref={primaryRef} type="button" variant="primary" className={styles.primary} busy={busy} busyLabel="処理中…"
        onClick={props.phase === 'review' ? () => void confirm() : props.onAccounts}>
        {props.phase === 'review' ? 'この連携を解除する' : 'アカウント一覧へ'}</Button></div>
  </section></div>
}
