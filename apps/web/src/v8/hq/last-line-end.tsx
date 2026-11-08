'use client'

import { useMemo, useState } from 'react'
import { finalLineEndOption } from '@line-crm/shared'
import styles from './last-line-end.module.css'

export interface LastLineEndSchedule {
  billingState: 'trialing' | 'active'
  interval: 'month' | 'year'
  trialFirstChargeAt?: string
  nextMonthlyChargeAt?: string
  nextAnnualRenewalAt?: string
}

interface Props {
  lineName: string
  schedule: LastLineEndSchedule
  now: string
  phase?: 'choose' | 'scheduled' | 'ended'
  scheduledEndAt?: string
  unpaidInvoiceYen?: number
  onSchedule: (endAt: string) => Promise<void> | void
  onEndNow: () => Promise<void> | void
  onCancelSchedule?: () => Promise<void> | void
  onBack: () => void
}

const day = (iso: string) => new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric',
}).format(new Date(iso))
const yen = (value: number) => `¥${new Intl.NumberFormat('ja-JP').format(value)}`

export default function LastLineEnd({
  lineName, schedule, now, phase = 'choose', scheduledEndAt, unpaidInvoiceYen = 0,
  onSchedule, onEndNow, onCancelSchedule, onBack,
}: Props) {
  const [selection, setSelection] = useState<'scheduled' | 'immediate'>('scheduled')
  const [confirmImmediate, setConfirmImmediate] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const option = useMemo(() => finalLineEndOption(schedule, now), [schedule, now])
  const isTrial = schedule.billingState === 'trialing'
  const dateLabel = isTrial ? '無料体験の終了日' : schedule.interval === 'month' ? '次の請求日' : '次の年次更新日'
  const chargeDate = isTrial ? schedule.trialFirstChargeAt! : schedule.interval === 'month'
    ? schedule.nextMonthlyChargeAt! : schedule.nextAnnualRenewalAt!
  const defaultTitle = isTrial ? '無料体験の終了日に終了する'
    : schedule.interval === 'month' ? '次の請求日の前日に終了する' : '年次更新日の前日に終了する'

  const submit = async (action: () => Promise<void> | void) => {
    if (busy) return
    setBusy(true); setError('')
    try { await action() }
    catch { setError('手続きを完了できませんでした。時間をおいて再度お試しください。') }
    finally { setBusy(false) }
  }

  if (phase === 'ended') return <main className={styles.page}>
    <p className={styles.breadcrumb}>ホーム › アカウント › LINEの利用終了</p>
    <h1>LINEの利用を終了しました</h1>
    <p className={styles.lead}>「{lineName}」の接続を停止しました。</p>
    <section className={styles.result} aria-label="利用終了の結果">
      <span className={styles.resultIcon} aria-hidden="true">✓</span>
      <div><h2>有効なLINEは0個です</h2><p>アカウントと請求履歴は引き続き確認できます。</p></div>
    </section>
    <div className={styles.bottom}><button type="button" className={styles.primary} onClick={onBack}>アカウント一覧へ</button></div>
  </main>

  if (phase === 'scheduled') return <main className={styles.page}>
    <p className={styles.breadcrumb}>ホーム › アカウント › LINEの利用終了</p>
    <h1>LINEの利用終了を予約しました</h1>
    <p className={styles.lead}>「{lineName}」は{day(scheduledEndAt ?? option.defaultEndAt)}の前日まで利用できます。</p>
    <section className={styles.result} aria-label="利用終了の予約内容">
      <span className={styles.resultIcon} aria-hidden="true">✓</span>
      <div><h2>{day(scheduledEndAt ?? option.defaultEndAt)}に利用を終了します</h2>
        <p>終了後の次回請求は発生しません。すでに確定した未払い分は請求対象です。</p></div>
    </section>
    <div className={styles.bottom}>
      {onCancelSchedule && <button type="button" className={styles.secondary} disabled={busy} onClick={() => void submit(onCancelSchedule)}>終了予約を取り消す</button>}
      <button type="button" className={styles.primary} onClick={onBack}>アカウント一覧へ</button>
    </div>
    {error && <p role="alert" className={styles.error}>{error}</p>}
  </main>

  return <main className={styles.page}>
    <p className={styles.breadcrumb}>ホーム › アカウント › LINEの利用終了</p>
    <h1>{confirmImmediate ? '今すぐLINEの利用を終了しますか' : '最後のLINEの利用を終了しますか'}</h1>
    <p className={styles.lead}>{confirmImmediate
      ? 'この操作を確定すると、LINEの接続と有料機能はすぐに停止します。'
      : '利用終了日を選んでください。終了後もアカウントと請求履歴を確認できます。'}</p>

    <div className={styles.columns}>
      <section className={styles.card} aria-labelledby="end-choice-title">
        <h2 id="end-choice-title">{confirmImmediate ? '終了前の最終確認' : '終了日を選択'}</h2>
        {confirmImmediate ? <div className={styles.confirmBox}>
          <span className={styles.warningIcon} aria-hidden="true">!</span>
          <div><strong>「{lineName}」を今すぐ停止します</strong>
            <p>予約配信を含む有料機能は停止し、この操作は取り消せません。お支払い済み期間の返金はありません。</p></div>
        </div> : <div className={styles.choices} role="radiogroup" aria-label="利用終了日">
          <label className={selection === 'scheduled' ? styles.choiceSelected : styles.choice}>
            <input type="radio" name="last-line-end" checked={selection === 'scheduled'} onChange={() => setSelection('scheduled')} />
            <span className={styles.choiceBody}><span className={styles.choiceHeading}>{defaultTitle}<em>推奨</em></span>
              <span>{day(option.defaultEndAt)}に終了。{day(`${option.lastUsableDateJst}T12:00:00+09:00`)}まで利用できます。</span>
              <span className={styles.choiceNote}>{day(chargeDate)}の請求は発生しません。</span></span>
          </label>
          <label className={selection === 'immediate' ? styles.choiceSelected : styles.choice}>
            <input type="radio" name="last-line-end" checked={selection === 'immediate'} onChange={() => setSelection('immediate')} />
            <span className={styles.choiceBody}><span className={styles.choiceHeading}>今すぐ終了する</span>
              <span>確定すると、LINEの接続と有料機能をすぐに停止します。</span>
              {!isTrial && <span className={styles.choiceNote}>お支払い済み期間の返金はありません。</span>}</span>
          </label>
        </div>}
        <p className={styles.small}>有効なLINEが0個になると、有料機能は利用できなくなります。請求履歴とアカウント情報は引き続き確認できます。</p>
      </section>
      <aside className={styles.card} aria-labelledby="end-summary-title">
        <h2 id="end-summary-title">利用終了のご確認</h2>
        <dl className={styles.details}>
          <div><dt>対象のLINE</dt><dd>{lineName}</dd></div>
          <div><dt>{dateLabel}</dt><dd>{day(chargeDate)}</dd></div>
          <div><dt>利用できる最終日</dt><dd>{confirmImmediate || selection === 'immediate' ? '今すぐ終了' : day(`${option.lastUsableDateJst}T12:00:00+09:00`)}</dd></div>
          <div><dt>終了後の有効LINE</dt><dd>0個</dd></div>
          <div><dt>確定済みの未払い</dt><dd>{yen(unpaidInvoiceYen)}</dd></div>
        </dl>
        <p className={styles.summaryNote}>終了日以降の新しい請求はありません。すでに確定した未払い分は残ります。</p>
      </aside>
    </div>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <div className={styles.bottom}>
      <button type="button" className={styles.secondary} onClick={confirmImmediate ? () => setConfirmImmediate(false) : onBack}>戻る</button>
      <button type="button" className={confirmImmediate ? styles.danger : styles.primary} disabled={busy}
        onClick={() => {
          if (confirmImmediate) void submit(onEndNow)
          else if (selection === 'immediate') setConfirmImmediate(true)
          else void submit(() => onSchedule(option.defaultEndAt))
        }}>
        {busy ? '処理中…' : confirmImmediate ? '今すぐ利用を終了する' : selection === 'immediate' ? '終了内容を確認する' : 'この内容で終了を予約する'}
      </button>
    </div>
  </main>
}
