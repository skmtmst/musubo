'use client'

import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import StatusBadge from '@/components/shared/status-badge'
import { PageHeading } from '@/components/templates/page-frame'
import { Steps } from '@/components/templates/steps'
import { useState } from 'react'
import styles from './musubo-payment-recovery.module.css'

type InvoiceView = {
  kind: 'invoice'
  state: 'grace' | 'processing' | 'suspended' | 'recovered'
  amountYen: number
  invoiceDate: string
  graceDeadline: string
  nextAutomaticRetryAt?: string | null
  paidAt?: string | null
  nextChargeAt?: string | null
}
type AdditionView = {
  kind: 'addition'
  state: 'failed' | 'processing' | 'expired' | 'activated'
  amountYen: number
  addedLineOrdinal: number
  activeLineCount: number
  holdUntil: string
  nextMonthlyYen?: number | null
}
export type MusuboPaymentRecoveryView = InvoiceView | AdditionView

interface Props {
  view: MusuboPaymentRecoveryView
  onPrimary: () => Promise<void> | void
  onSecondary: () => void
}

const money = (yen: number) => `¥${new Intl.NumberFormat('ja-JP').format(yen)}`
const date = (iso: string, time = false) => new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric',
  ...(time ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
}).format(new Date(iso))

export default function MusuboPaymentRecovery({ view, onPrimary, onSecondary }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const invoice = view.kind === 'invoice'
  const success = invoice ? view.state === 'recovered' : view.state === 'activated'
  const processing = view.state === 'processing'
  const expired = view.kind === 'addition' && view.state === 'expired'
  const suspended = view.kind === 'invoice' && view.state === 'suspended'

  const title = invoice
    ? view.state === 'grace' ? 'お支払いに対応が必要です'
      : processing ? 'お支払いを確認しています'
        : suspended ? '利用を一時停止しています' : 'お支払いを確認しました'
    : view.state === 'failed' ? 'LINE追加のお支払いが未完了です'
      : processing ? '追加分のお支払いを確認しています'
        : expired ? 'LINE追加の期限が切れました' : `${view.addedLineOrdinal}個目のLINEを追加しました`
  const subtitle = invoice
    ? view.state === 'grace' ? `${date(view.invoiceDate, true)}の請求が完了していません。未払いの場合、${date(view.graceDeadline, true)}に利用を一時停止します。`
      : processing ? 'Stripeでのお手続き後、未払い分の決済結果を確認しています。'
        : suspended ? '請求失敗から7日が経過しました。お支払い完了後に利用を再開します。'
          : '未払い分の決済が完了し、通常の利用状態に戻りました。'
    : view.state === 'failed' ? `${view.addedLineOrdinal}個目のLINEは有効化待ちです。利用中のLINE ${view.activeLineCount}個はそのまま使えます。`
      : processing ? `決済結果が確定するまで、${view.addedLineOrdinal}個目のLINEは有効化待ちです。`
        : expired ? '追加分は有効化されていません。現在の料金でもう一度確認できます。'
          : '追加分の決済を確認し、LINEアカウントを有効化しました。'
  const statusTitle = invoice
    ? view.state === 'grace' ? 'お支払いを確認できませんでした'
      : processing ? '決済結果を確認しています'
        : suspended ? '利用を一時停止しています' : '通常の利用に戻りました'
    : view.state === 'failed' ? '追加分のお支払いが完了していません'
      : processing ? '決済結果を確認中です'
        : expired ? '追加分のお支払いが完了しませんでした' : '追加したLINEを利用できます'
  const statusDescription = invoice
    ? view.state === 'grace' ? '期限までは利用できます。お支払い方法を確認してください。'
      : processing ? 'お支払い手続きの結果が反映されるまでお待ちください。'
        : suspended ? 'お支払い期限を過ぎました。決済完了後に利用を再開できます。'
          : '未払い分の決済を確認しました。LINEの接続と設定は維持されています。'
    : view.state === 'failed' ? `接続情報は保存済みです。決済成功後に${view.addedLineOrdinal}個目のLINEを有効化します。`
      : processing ? '手続きが終わっても、決済の確認ができるまで追加分は使えません。'
        : expired ? '保留期限を過ぎたため、この追加分の決済と有効化を終了しました。'
          : `既存のLINEとあわせて、${view.activeLineCount}個のLINEを利用できるようになりました。`
  const badge = invoice
    ? view.state === 'grace' ? '利用継続中' : processing ? '決済確認中' : suspended ? '一時停止中' : '通常利用'
    : success ? `${view.activeLineCount}個 利用中` : '既存利用中'
  const mainTitle = invoice ? success ? 'お支払いの記録' : '未払いのご請求'
    : success ? '今回のお支払い' : expired ? '期限切れの追加申込' : '追加分のお支払い'
  const amountLabel = invoice
    ? success ? 'お支払い済みの金額（税込）' : processing ? '確認中の金額（税込）' : 'お支払い金額（税込）'
    : success ? '追加分のお支払い（税込）' : processing ? '確認中の追加分（税込）'
      : expired ? '前回の見積もり額（税込）' : '今回の追加分（税込）'
  const amountStatusLabel = success ? '支払い済み' : processing ? '確認中' : expired ? '期限切れ'
    : invoice ? '未払い' : '追加は保留中'
  const guidance = invoice
    ? view.state === 'grace' ? `${date(view.graceDeadline, true)}の停止予定時刻までは、LINEの接続と機能を通常どおり利用できます。`
      : processing ? 'カードの更新だけではお支払い完了になりません。決済結果を確認中です。'
        : suspended ? 'LINEの接続とデータは保持しています。' : '未払い分のお支払いが完了し、利用状態が通常に戻りました。'
    : view.state === 'failed' ? '既存のLINEは通常どおり利用できます。追加分は決済成功まで有効化しません。'
      : processing ? `既存のLINE ${view.activeLineCount}個は引き続き利用できます。決済が確定するまで再請求しません。`
        : expired ? '既存のLINEは通常どおり利用できます。前回の追加分の請求は確定していません。'
          : '今回分は次の請求日までの残期間で日割り計算しました。'
  const heading = invoice
    ? view.state === 'grace' ? 'お支払いの手続き' : processing ? 'このあとの流れ'
      : suspended ? '利用再開まで' : '再開後に確認すること'
    : view.state === 'failed' ? '追加を完了するには' : processing ? '決済結果をお待ちください'
      : expired ? '追加を希望する場合' : '追加後に確認すること'
  const description = invoice
    ? view.state === 'grace' ? 'Stripeの画面でカード情報の更新や認証を行えます。'
      : processing ? '結果が確定するまで、再度のカード登録は不要です。'
        : suspended ? '未払いのお支払いが完了すると利用を再開します。' : 'LINEの接続と設定はそのまま利用できます。'
    : view.state === 'failed' ? 'カードの更新や本人認証を行い、同じ追加分の決済を再試行できます。'
      : processing ? '決済成功なら追加LINEを有効化し、失敗なら再試行をご案内します。'
        : expired ? '日割り額が変わるため、最新の料金に再同意してから進みます。'
          : '追加したLINEの接続と請求内容を確認できます。'
  const steps = invoice
    ? view.state === 'grace' ? ['お支払い画面を開く', 'カードを更新・認証する', '決済完了を確認する']
      : processing ? ['決済結果を確認', '結果をメールでご案内', '必要ならお支払いへ']
        : suspended ? ['お支払いを完了', '決済結果を確認', '予約配信を確認']
          : ['通常利用を再開', '請求の記録を確認', '予約配信を確認']
    : view.state === 'failed' ? ['お支払い方法を確認', '必要な認証を完了', '決済成功後に有効化']
      : processing ? ['決済結果を確認', '成功ならLINEを有効化', '結果をメールでご案内']
        : expired ? ['最新の料金を確認', '料金に同意して再開', '決済成功後に有効化']
          : ['LINEの設定を確認', '今回の料金を確認', '次回の料金を確認']
  const primary = invoice
    ? success ? '請求を確認する' : processing ? '請求状況を更新' : 'お支払いへ進む'
    : success ? 'アカウント一覧へ' : processing ? '決済状況を更新'
      : expired ? '料金を再確認する' : 'カードを確認して再試行'
  const footnote = invoice
    ? view.state === 'grace' ? 'カード情報はmusuboに保存しません。お支払い手続きはStripeの画面で行います。'
      : processing ? '画面を閉じても状況は保存されます。「請求状況を更新」では新たな決済は発生しません。'
        : suspended ? '自動応答・配信などの有料機能は停止中です。停止中の予約配信は自動で再送されません。'
          : '停止中に送れなかった予約配信は自動で再送しません。必要に応じて内容をご確認ください。'
    : view.state === 'failed' ? '処理中は再度請求しません。カード情報はStripeで扱い、musuboには保存しません。'
      : processing ? 'このボタンで新たな決済は発生しません。画面を閉じても結果は保存されます。'
        : expired ? '接続情報が有効なら引き継ぎます。期限切れならLINEの再認証をご案内します。'
          : 'この追加は決済成功後に有効化しました。確認中や失敗時に二重で有効化しません。'
  const secondary = invoice ? success ? 'アカウント一覧へ' : '請求に戻る'
    : success ? '請求を確認する' : expired ? '追加を取りやめる' : processing ? 'アカウント一覧へ' : '追加を取り消す'
  const invoke = async () => {
    if (busy) return
    setBusy(true); setError('')
    try { await onPrimary() }
    catch { setError('手続きを開始できませんでした。時間をおいて再度お試しください。') }
    finally { setBusy(false) }
  }

  return <div className={styles.page}>
    <p className={styles.breadcrumb}>ホーム › {invoice ? '統括の設定 › 請求' : 'アカウント › LINE追加'} › お支払い</p>
    <PageHeading title={title} subtitle={subtitle} inset="none" />
    <div className={success ? styles.statusSuccess : styles.statusWarning}>
      <span className={success ? styles.iconSuccess : styles.iconWarning} aria-hidden="true">{success ? '✓' : processing ? '…' : '!'}</span>
      <div className={styles.statusCopy}><h2>{statusTitle}</h2><p>{statusDescription}</p></div>
      <StatusBadge tone={success ? 'success' : 'warning'} dot={false}>{badge}</StatusBadge>
    </div>
    <div className={styles.columns}>
      <section className={styles.card} aria-labelledby="payment-detail-title">
        <h2 id="payment-detail-title">{mainTitle}</h2>
        <div className={styles.amountRow}><div><span>{amountLabel}</span><strong>{money(view.amountYen)}</strong></div>
          <StatusBadge tone={success ? 'success' : 'warning'} dot={false}>{amountStatusLabel}</StatusBadge></div>
        <dl className={styles.details}>
          {invoice ? <><div><dt>請求日</dt><dd>{date(view.invoiceDate)}</dd></div>
            <div><dt>{success ? 'お支払い確認日' : 'お支払い期限'}</dt><dd>{success
              ? view.paidAt ? date(view.paidAt, true) : '確認中'
              : date(view.graceDeadline, true)}</dd></div>
            <div><dt>{success ? '次回請求予定' : processing ? '決済状況' : suspended ? '現在の利用状態' : '次回の自動再請求'}</dt>
              <dd>{success ? view.nextChargeAt ? date(view.nextChargeAt) : '確認中'
                : processing ? '結果の反映待ち' : suspended ? '一時停止中'
                  : view.nextAutomaticRetryAt ? date(view.nextAutomaticRetryAt) : '案内待ち'}</dd></div></>
            : <><div><dt>追加対象</dt><dd>{view.addedLineOrdinal}個目のLINE</dd></div>
              <div><dt>{success ? '有効LINE' : '現在の有効LINE'}</dt><dd>{success ? `${view.activeLineCount - 1}個 → ${view.activeLineCount}個` : `${view.activeLineCount}個（通常利用中）`}</dd></div>
              <div><dt>{success ? '次回からの月額（税込）' : processing ? '追加LINEの状態' : expired ? '前回の保留期限' : '保留期限'}</dt>
                <dd>{success ? view.nextMonthlyYen == null ? '確認中' : `${money(view.nextMonthlyYen)}／月`
                  : processing ? '有効化待ち' : date(view.holdUntil, true)}</dd></div></>}
        </dl>
        <p className={styles.info}>{guidance}</p>
      </section>
      <section className={styles.card} aria-labelledby="payment-action-title">
        <h2 id="payment-action-title">{heading}</h2><p className={styles.actionLead}>{description}</p>
        <Steps label={heading} steps={steps.map((step, index) => ({
          key: String(index), label: step, state: index === 0 ? 'current' : 'todo',
        }))} />
        <p className={styles.footnote}>{footnote}</p>
        {error && <Notice tone="danger" role="alert">{error}</Notice>}
        <Button type="button" variant="primary" busy={busy} busyLabel="処理中…" onClick={() => void invoke()}>{primary}</Button>
        <Button type="button" variant="secondary" onClick={onSecondary}>{secondary}</Button>
      </section>
    </div>
  </div>
}
