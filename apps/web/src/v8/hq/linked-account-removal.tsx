'use client'

import Button from '@/components/shared/button'
import { useState } from 'react'
import { linkedAccountSlots, type LinkedAccountCounts } from '@line-crm/shared'
import styles from './linked-account-removal.module.css'

export interface LinkedAccountRemovalView {
  phase: 'confirm' | 'complete'
  lineName: string
  service: 'googleBusiness' | 'instagram'
  linkedAccountName: string
  before: LinkedAccountCounts
  after: LinkedAccountCounts
  linkedAccountSlotYen: number
  nextMonthlyChargeAt: string
  billingInterval: 'month' | 'year'
}

interface Props {
  view: LinkedAccountRemovalView
  onRemove: () => Promise<void> | void
  onBack: () => void
  onViewConnections?: () => void
}

const day = (iso: string) => new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric',
}).format(new Date(iso))
const yen = (value: number) => `¥${new Intl.NumberFormat('ja-JP').format(value)}`

export default function LinkedAccountRemoval({ view, onRemove, onBack, onViewConnections }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const beforeSlots = linkedAccountSlots(view.before)
  const afterSlots = linkedAccountSlots(view.after)
  const slotReduction = beforeSlots - afterSlots
  const monthlyReduction = slotReduction * view.linkedAccountSlotYen
  const serviceLabel = view.service === 'googleBusiness' ? 'Googleマイビジネス' : 'Instagram'
  const changedCount = view.service === 'googleBusiness'
    ? `${view.before.googleBusiness}個 → ${view.after.googleBusiness}個`
    : `${view.before.instagram}個 → ${view.after.instagram}個`

  const remove = async () => {
    if (busy) return
    setBusy(true); setError('')
    try { await onRemove() }
    catch { setError('連携を解除できませんでした。時間をおいて再度お試しください。') }
    finally { setBusy(false) }
  }

  return <div className={styles.page}>
    <p className={styles.breadcrumb}>ホーム › アカウント › 連携サービス › 連携解除</p>
    <h1>{view.phase === 'confirm' ? 'このアカウントの連携を解除しますか' : '連携を解除しました'}</h1>
    <p className={styles.lead}>{view.phase === 'confirm'
      ? '解除すると、このアカウントへの投稿や情報の取得はすぐに停止します。'
      : `「${view.linkedAccountName}」との連携は停止しました。料金の変更日をご確認ください。`}</p>

    <div className={view.phase === 'complete' ? styles.statusSuccess : styles.statusWarning}>
      <span className={view.phase === 'complete' ? styles.statusIconSuccess : styles.statusIconWarning} aria-hidden="true">{view.phase === 'complete' ? '✓' : '!'}</span>
      <div className={styles.statusCopy}><h2>{view.phase === 'complete' ? '連携を停止しました' : '解除後はこの連携先に投稿できません'}</h2>
        <p>{view.phase === 'complete'
          ? 'LINEの接続と、ほかのGoogleマイビジネス・Instagramの連携は継続しています。'
          : '設定済みの投稿先や予約配信を確認してから解除してください。'}</p></div>
      <span className={view.phase === 'complete' ? styles.badgeSuccess : styles.badgeWarning}>{view.phase === 'complete' ? '解除済み' : '連携中'}</span>
    </div>

    <div className={styles.columns}>
      <section className={styles.card} aria-labelledby="removal-account-title">
        <h2 id="removal-account-title">解除するアカウント</h2>
        <dl className={styles.details}>
          <div><dt>LINEアカウント</dt><dd>{view.lineName}</dd></div>
          <div><dt>連携サービス</dt><dd>{serviceLabel}</dd></div>
          <div><dt>連携先</dt><dd>{view.linkedAccountName}</dd></div>
          <div><dt>{serviceLabel}の連携数</dt><dd>{changedCount}</dd></div>
          <div><dt>有料の追加連携枠</dt><dd>{beforeSlots}枠 → {afterSlots}枠</dd></div>
        </dl>
        <p className={styles.info}>1つのLINEでは、GoogleマイビジネスとInstagramをそれぞれ1個まで基本料金で連携できます。追加枠は、連携数が多いサービスを基準に数えます。</p>
      </section>

      <section className={styles.card} aria-labelledby="removal-billing-title">
        <h2 id="removal-billing-title">お支払いの変更</h2>
        <div className={styles.saving}>
          <span>次回の月次請求から</span>
          <strong>{monthlyReduction > 0 ? `−${yen(monthlyReduction)}` : '変更なし'}<small>{monthlyReduction > 0 ? '／月（税込）' : ''}</small></strong>
        </div>
        <dl className={styles.details}>
          <div><dt>連携の停止</dt><dd>解除後すぐ</dd></div>
          <div><dt>減額の開始</dt><dd>{monthlyReduction > 0 ? day(view.nextMonthlyChargeAt) : '料金変更なし'}</dd></div>
          <div><dt>今回分の返金</dt><dd>なし</dd></div>
        </dl>
        <p className={styles.info}>{monthlyReduction > 0
          ? `${view.billingInterval === 'year' ? '年払いでも追加連携枠は月ごとの請求です。' : ''}${day(view.nextMonthlyChargeAt)}から1枠あたり${yen(view.linkedAccountSlotYen)}の減額を反映します。`
          : 'ほかのサービスの連携数が追加枠の基準のため、今回の解除では料金は変わりません。'}</p>
      </section>
    </div>

    {view.phase === 'complete' && <p className={styles.afterNote}>次回の月次請求までは、お支払い済みの追加枠に別の連携先を設定できます。再び連携数を増やす場合は、表示される料金を確認してから進みます。</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <div className={styles.bottom}>
      <button type="button" className={styles.secondary} onClick={onBack}>{view.phase === 'complete' ? 'アカウント一覧へ' : '戻る'}</button>
      {view.phase === 'confirm'
        ? <Button type="button" className={styles.primary} busy={busy} busyLabel="処理中…" onClick={() => void remove()}>この連携を解除する</Button>
        : onViewConnections && <button type="button" className={styles.primary} onClick={onViewConnections}>連携先を確認する</button>}
    </div>
  </div>
}
