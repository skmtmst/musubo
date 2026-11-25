'use client'

import { useRef, useState } from 'react'
import { Bell, Check, Megaphone, Ticket } from 'lucide-react'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import Notice from '@/components/shared/notice'
import Link from '@/components/shared/list-navigation'
import type { RestaurantBookingExposure } from '@line-crm/shared'
import styles from './guide-last-step.module.css'

const NEXT_ACTIONS = [
  { href: '/broadcasts/new', icon: Megaphone, label: 'はじめての配信を作る', note: 'お店のお知らせを友だちに届ける' },
  { href: '/templates/edit?kind=coupon', icon: Ticket, label: 'クーポンを作る', note: '来店のきっかけをつくる' },
  { href: '/line-notifications', icon: Bell, label: '予約の通知を設定', note: '新しい予約をすぐ知る' },
]

export function GuideSetupComplete({ exposure, onAcknowledge, onNavigate }: {
  exposure?: RestaurantBookingExposure
  onAcknowledge: () => Promise<boolean>
  onNavigate: (href: string) => void
}) {
  const title = '開店準備が完了しました'
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<{ href?: string } | null>(null)
  const pending = useRef(false)
  const description = !exposure
    ? 'LINEでの予約受付状況を確認できませんでした。予約枠とリッチメニューをご確認ください。'
    : exposure.reservationLink && exposure.publicReservationMenu && exposure.availableCapacity
      ? 'LINEからの予約を受け付けています。ここからは、お客さまとのつながりを育てていきましょう。'
      : 'LINEで予約を受け付けるには、予約枠とリッチメニューの公開状況を確認してください。'
  const acknowledge = async (href?: string) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setFailed(null)
    try {
      if (await onAcknowledge()) {
        if (href) onNavigate(href)
      } else setFailed({ href })
    } catch {
      setFailed({ href })
    } finally {
      setBusy(false)
      pending.current = false
    }
  }
  return (
    <Dialog open title={title} titleContent={<span className={styles.completeTitle}>
      <span className={styles.completed}><Check size={30} strokeWidth={4} aria-hidden="true" /></span>
      {title}
    </span>} description={description}
      designNode="N9qLt" designLayout="stacked-centered" designWidth={560} exactDesignWidth designMinHeight={472}
      headerIcon={false} busy={busy} onCancel={() => void acknowledge()} footerDivider={false} initialFocusId="guide-complete-home"
      footer={<div className={styles.completeFooter}>
        <DialogActions padding="none">
          <Button id="guide-complete-home" fullWidth variant="primary" busy={busy} onClick={() => void acknowledge('/')}>ダッシュボードへ</Button>
        </DialogActions>
        <img src="/brand/musubo-color.png" width={78} height={23} alt="musubo" />
      </div>}
    >
      {failed ? <div className={styles.completeFailure}>
        <Notice tone="warn" appearance="subtle" statusWord={false}>完了の保存を確認できませんでした。もう一度お試しください。</Notice>
        <Button className={styles.confirmAction} presentation="first-run-start" onClick={() => void acknowledge(failed.href)}>もう一度確かめる</Button>
      </div> : null}
      <section className={styles.next} aria-label="次にできること">
        <h3>次にできること</h3>
        <div className={styles.nextActions}>
          {NEXT_ACTIONS.map(({ href, icon: Icon, label, note }) => (
            <Card key={href} edge="hairline" contentPadding="var(--space-14) var(--space-14)">
              <div className={styles.nextAction}>
                <Icon className={styles.choiceIcon} size={16} aria-hidden="true" />
                <Link className={styles.choiceLink} href={href} onClick={event => { event.preventDefault(); void acknowledge(href) }}>{label}</Link>
                <p className={styles.choiceNote}>{note}</p>
              </div>
            </Card>
          ))}
        </div>
      </section>
    </Dialog>
  )
}
