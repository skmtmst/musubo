'use client'

import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import { PageHeading } from '@/components/templates/page-frame'
import { Steps } from '@/components/templates/steps'
import { useState } from 'react'
import type { MusuboLinkedService } from '@line-crm/shared'
import styles from './musubo-payment-recovery.module.css'

export interface LinkedAdditionPaymentFailureView {
  lineName: string
  service: MusuboLinkedService
  addedOrdinal: number
  activeServiceCount: number
  amountYen: number
  monthlyIncreaseYen: number
  /** Server-confirmed, fixed proration snapshot for this pending addition. */
  monthlyDaysRemaining: number
  monthlyDaysInPeriod: number
}

const yen = (amount: number) => `¥${new Intl.NumberFormat('ja-JP').format(amount)}`
const label = (service: MusuboLinkedService) => service === 'googleBusiness' ? 'Googleマイビジネス' : 'Instagram'

/** Payment failure affects the pending linked account only; existing LINE and connections stay active. */
export default function LinkedAdditionPaymentFailure({ view, onRetry, onCancel }: {
  view: LinkedAdditionPaymentFailureView
  onRetry: () => Promise<void> | void
  onCancel: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const serviceName = label(view.service)
  const retry = async () => {
    if (busy) return
    setBusy(true); setError('')
    try { await onRetry() }
    catch { setError('お支払い手続きを開始できませんでした。時間をおいて再度お試しください。') }
    finally { setBusy(false) }
  }
  return <div className={styles.page}>
    <p className={styles.breadcrumb}>ホーム › アカウント › 連携先を追加 › お支払い</p>
    <PageHeading title="追加連携枠のお支払いが未完了です" subtitle={`${serviceName}${view.addedOrdinal}個目の連携は有効化待ちです。既存の連携は使えます。`} />
    <div className={styles.statusWarning}>
      <span className={styles.iconWarning} aria-hidden="true">!</span>
      <div className={styles.statusCopy}><h2>追加連携枠のお支払いが未完了です</h2>
        <p>新しい連携先の接続情報は保存済みです。決済成功後に有効化します。</p></div>
      <span className={styles.badgeWarning}>既存利用中</span>
    </div>
    <div className={styles.columns}>
      <section className={styles.card} aria-labelledby="linked-failure-price-title">
        <h2 id="linked-failure-price-title">連携枠の追加分</h2>
        <div className={styles.amountRow}><div><span>今回の追加分（税込・{view.monthlyDaysRemaining}/{view.monthlyDaysInPeriod}日）</span>
          <strong>{yen(view.amountYen)}</strong></div><span className={styles.amountWarning}>追加は保留中</span></div>
        <dl className={styles.details}>
          <div><dt>LINEアカウント</dt><dd>{view.lineName}</dd></div>
          <div><dt>追加対象</dt><dd>{serviceName}{view.addedOrdinal}個目</dd></div>
          <div><dt>現在の有効連携</dt><dd>{serviceName}{view.activeServiceCount}個</dd></div>
          <div><dt>次回以降の月額増分</dt><dd>＋{yen(view.monthlyIncreaseYen)}／月</dd></div>
        </dl>
        <p className={styles.info}>既存のLINEと連携先は通常どおり利用できます。新しい連携先だけ保留します。</p>
      </section>
      <section className={styles.card} aria-labelledby="linked-failure-next-title">
        <h2 id="linked-failure-next-title">連携先の追加を完了するには</h2>
        <p className={styles.actionLead}>お支払い方法を確認し、追加1枠分の決済を再試行してください。</p>
        <Steps label="連携先の追加手順" steps={[
          { key: 'payment', label: 'お支払い方法を確認', state: 'current' },
          { key: 'verification', label: '必要な認証を完了', state: 'todo' },
          { key: 'activation', label: '成功後に連携先を有効化', state: 'todo' },
        ]} />
        <p className={styles.info}>Stripeでカードを確認し、求められた場合は本人認証を完了してください。決済成功後に{serviceName}を使えるようにします。</p>
        <p className={styles.footnote}>処理中は再度請求しません。カード情報はStripeで扱い、musuboには保存しません。</p>
        {error && <Notice tone="danger" role="alert">{error}</Notice>}
        <Button type="button" variant="primary" busy={busy} busyLabel="処理中…"
          onClick={() => void retry()}>カードを確認して再試行</Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>追加を取り消す</Button>
      </section>
    </div>
  </div>
}
