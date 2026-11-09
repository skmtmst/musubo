'use client'

import Card from '@/components/shared/card'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import type { BillingInvoice, BillingSummary } from '@/lib/hq-billing'
import { formatYen } from '@line-crm/shared'
import styles from './musubo-billing.module.css'

type NewPricing = NonNullable<BillingSummary['newPricing']>

function shortDate(value: string | null): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '確認中'
  const [, month, day] = value.split('-')
  return `${Number(month)}月${Number(day)}日`
}

function statusMessage(pricing: NewPricing): string {
  if (pricing.terminationPhase === 'scheduled') return '最後のLINEの利用終了を予約しています。終了予定日は手続き画面で確認・変更できます。'
  if (pricing.terminationPhase === 'ending') return '最後のLINEの利用終了を確認しています。手続き画面で現在の状態を確認できます。'
  switch (pricing.status) {
    case 'awaiting_first_line': return 'LINEを接続すると無料期間が始まります。カード登録だけでは請求されません。'
    case 'trialing': return `無料体験中です。無料期間は${shortDate(pricing.trialLastFreeDate)}までです。`
    case 'active': return 'LINEアカウントを利用中です。現在の利用状況を確認できます。'
    case 'past_due': return 'お支払いを確認しています。カード情報と未払い請求を確認してください。'
    case 'ended': return 'LINEの利用を終了しています。請求履歴は引き続き確認できます。'
  }
}

export default function MusuboBilling({ pricing, invoices, invoiceFailed, onRetry,
  portalAvailable, canManagePayment, onPortal }: {
  pricing: NewPricing
  invoices: BillingInvoice[] | null
  invoiceFailed: boolean
  onRetry: () => void
  portalAvailable: boolean
  canManagePayment: boolean
  onPortal: () => void
}) {
  const openInvoices = invoices?.filter((invoice) => invoice.status === 'open').length ?? null
  const firstCharge = pricing.status === 'awaiting_first_line' ? 'LINE接続後に確定'
    : shortDate(pricing.firstChargeDate)
  return <div className={styles.page} data-design="MusuboBilling">
    <div className={styles.metrics}>
      <div><span>今月の請求</span><strong>{pricing.status === 'trialing' ? '¥0' : '確認中'}</strong></div>
      <div><span>有効なLINE</span><strong>{pricing.activeLines.length}個</strong></div>
      <div><span>未払い</span><strong>{openInvoices === null ? '確認中' : `${openInvoices}件`}</strong></div>
      <div><span>初回請求日</span><strong>{firstCharge}</strong></div>
    </div>
    <Notice tone={pricing.status === 'past_due' ? 'danger' : 'info'} message={statusMessage(pricing)} />
    <h2 className={styles.heading}>現在の利用と次の請求</h2>
    <div className={styles.columns}>
      <Card as="section" layout="vertical" padding="default" gap="normal">
        <div className={styles.cardHead}><h3>有効なLINEアカウント</h3><strong>{pricing.activeLines.length}個</strong></div>
        {pricing.activeLines.length ? <ul className={styles.lineList}>{pricing.activeLines.map((line) =>
          <li key={line.id}><span>{line.name}</span><span className={styles.active}>利用中</span></li>)}</ul>
          : <p className={styles.muted}>まだLINEは接続されていません。</p>}
        {pricing.status !== 'ended' && canManagePayment ? <div className={styles.actions}>
          {pricing.terminationPhase === 'scheduled' || pricing.terminationPhase === 'ending'
            ? <Button variant="secondary" href="/hq/billing/last-line-end">利用終了の状況を確認</Button>
            : <>
          <Button href={pricing.status === 'awaiting_first_line' ? '/hq/onboarding/card' : '/hq/billing/line-addition'}>
            {pricing.status === 'awaiting_first_line' ? '利用開始の準備へ' : 'LINEを追加する'}
          </Button>
          {pricing.activeLines.length === 1 && <Button variant="secondary" href="/hq/billing/last-line-end">最後のLINEの利用を終了する</Button>}
          </>}
        </div> : null}
      </Card>
      <Card as="section" layout="vertical" padding="default" gap="normal">
        <div className={styles.cardHead}><h3>次回のお支払い予定料金</h3></div>
        {pricing.contractedCore ? <>
          <p className={styles.amount}>{formatYen(pricing.contractedCore.amountYen)}<small>／{pricing.contractedCore.interval === 'year' ? '年' : '月'}（税込・LINE基本料金）</small></p>
          <p className={styles.muted}>契約枠{pricing.contractedCore.lineCapacity}個分の基本料金です。接続数が少なくても無料期間終了後に請求します。オプションは実際の利用で別に計算します。</p>
        </> : pricing.estimatedPrice ? <>
          {pricing.billingInterval === 'month' ? <p className={styles.amount}>{formatYen(pricing.estimatedPrice.monthlyTotalYen)}<small>／月（税込）</small></p>
            : <><p className={styles.amount}>{formatYen(pricing.estimatedPrice.annualLineChargeYen)}<small>／年（税込・LINE基本料金）</small></p>
              <p className={styles.option}>オプション {formatYen(pricing.estimatedPrice.optionsMonthlyYen)}／月（税込）</p></>}
          <p className={styles.muted}>申込時の友だち数による概算です。確定額は接続後に確認できます。</p>
        </> : <p className={styles.muted}>接続するLINEと料金条件が確定すると表示されます。</p>}
        {pricing.firstChargeDate ? <p className={styles.date}>初回請求予定日：{shortDate(pricing.firstChargeDate)}</p> : null}
        {portalAvailable && canManagePayment ? <button className={styles.textButton} onClick={onPortal}>カード情報を確認・変更 →</button> : null}
      </Card>
    </div>
    <section className={styles.history}>
      <h2 className={styles.heading}>支払い履歴</h2>
      {invoiceFailed ? <div className={styles.historyState}>支払い履歴を読み込めませんでした。<button onClick={onRetry}>再読み込み</button></div>
        : invoices?.length ? <ul className={styles.invoiceList}>{invoices.map((invoice) =>
          <li key={invoice.id}><span>{invoice.description ?? invoice.number ?? '請求'}</span>
            <strong>{formatYen(invoice.amountYen)}</strong>
            {invoice.hostedUrl ? <a href={invoice.hostedUrl} target="_blank" rel="noopener noreferrer">明細を見る</a> : null}</li>)}</ul>
          : <p className={styles.muted}>まだお支払いはありません。</p>}
    </section>
  </div>
}
