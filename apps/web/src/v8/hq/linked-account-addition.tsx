'use client'

import Button from '@/components/shared/button'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { musuboLinkedAdditionPrice, type LinkedAccountCounts, type MusuboLinkedAdditionInput,
  type MusuboLinkedService } from '@line-crm/shared'
import styles from './linked-account-addition.module.css'

interface Props {
  lineName: string
  service: MusuboLinkedService
  before: LinkedAccountCounts
  slotUnitYen: number
  billing: MusuboLinkedAdditionInput['billing']
  /** The server must recheck these inputs and the persisted billing state before any charge or activation. */
  onContinue: () => Promise<void> | void
  onBack: () => void
}

const yen = (value: number) => `¥${new Intl.NumberFormat('ja-JP').format(value)}`
const serviceName = (service: MusuboLinkedService) => service === 'googleBusiness' ? 'Googleマイビジネス' : 'Instagram'

export default function LinkedAccountAddition({ lineName, service, before, slotUnitYen, billing, onContinue, onBack }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dialogRef = useRef<HTMLElement>(null)
  const primaryRef = useRef<HTMLButtonElement>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  const result = useMemo(() => {
    try { return musuboLinkedAdditionPrice({ before, service, slotUnitYen, billing }) }
    catch { return null }
  }, [before, service, slotUnitYen, billing])

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    primaryRef.current?.focus()
    return () => { previous?.focus() }
  }, [])

  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); if (!busy) onBack(); return }
    if (event.key !== 'Tab') return
    const first = backRef.current
    const last = primaryRef.current
    if (!first || !last || !dialogRef.current) return
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }

  const advance = async () => {
    if (busy) return
    setBusy(true); setError('')
    try { await onContinue() }
    catch { setError('連携を開始できませんでした。時間をおいて再度お試しください。') }
    finally { setBusy(false) }
  }

  if (!result) return <div className={styles.backdrop} role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onBack()
  }}><section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="linked-addition-error-title" onKeyDown={keyDown}>
    <h2 id="linked-addition-error-title">料金を表示できません</h2>
    <p>連携数または料金を確認できませんでした。画面を閉じて、もう一度お試しください。</p>
    <button type="button" className={styles.backOnly} onClick={onBack}>戻る</button>
  </section></div>

  const addedSlot = result.addedSlots > 0
  const charged = result.monthlyIncreaseYen > 0
  const label = serviceName(service)
  const beforeText = `Googleマイビジネス ${result.before.googleBusiness}個${service === 'googleBusiness' ? `→${result.after.googleBusiness}個` : ''}・Instagram ${result.before.instagram}個${service === 'instagram' ? `→${result.after.instagram}個` : ''}`
  const slotText = addedSlot ? `追加枠 ${result.slotsBefore}枠→${result.slotsAfter}枠` : `追加枠 ${result.slotsAfter}枠のまま`
  return <div className={styles.backdrop} role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !busy) onBack()
  }}><section ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="linked-addition-title" onKeyDown={keyDown}>
    <h2 id="linked-addition-title">{charged ? '追加連携枠の料金を確認' : '追加料金はかかりません'}</h2>
    <p className={styles.lead}>{lineName}に{label}を1個追加します。</p>
    <div className={styles.priceBox}>
      <span>{charged ? '次回からの月額増分（税込）' : addedSlot ? '追加枠の料金は0円です' : '追加枠数は変わりません'}</span>
      <strong>{charged ? `＋${yen(result.monthlyIncreaseYen)} / 月` : '追加料金 ¥0'}</strong>
      <p>{beforeText}｜{slotText}</p>
    </div>
    <div className={styles.afterPrice}><span>追加後の連携枠料金（税込）</span>
      <strong>{yen(result.monthlySlotsAfterYen)} / 月{charged ? '' : '（料金は変更なし）'}</strong></div>
    <div className={styles.dueBox}><span>{charged && billing.kind === 'paid'
      ? `今回の追加分（次回請求まで残り${billing.daysRemaining}/${billing.daysInPeriod}日の見込み）`
      : '今回のお支払い'}</span>
      <strong>{charged && billing.kind === 'paid' ? `決済成功時のお支払い ${yen(result.dueNowYen)}（税込）`
        : charged ? '¥0｜無料期間中のため今は請求しません' : '¥0｜カード決済はありません'}</strong></div>
    <p className={styles.note}>{charged
      ? billing.kind === 'paid'
        ? '接続情報を確認後に決済し、成功したら追加先を有効化します。追加枠は年払いでも毎月請求します。'
        : '接続を確認後に追加先を有効化します。無料期間の終了後、追加枠は毎月請求します。'
      : `${addedSlot ? '適用中の条件では追加料金が0円のため' : '追加枠数が変わらないため'}、料金の同意や決済は不要です。接続確認後に${label}を有効化します。`}</p>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <div className={styles.actions}><button ref={backRef} type="button" className={styles.back} disabled={busy} onClick={onBack}>戻る</button>
      <Button ref={primaryRef} type="button" variant="primary" className={styles.primary} busy={busy} busyLabel="処理中…" onClick={() => void advance()}>
        {charged ? '料金に同意して連携へ' : `${label}の連携へ`}</Button></div>
  </section></div>
}
