'use client'

import { useEffect, useRef, useState } from 'react'
import { Bell, Check, Hourglass, Megaphone, Ticket } from 'lucide-react'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import Link from '@/components/shared/list-navigation'
import { InlineLoadFailure } from '@/components/shared/target-missing'
import { qrToDataURL } from '@/lib/qr-image'
import { resolveOfficialProfileUrl } from '@/components/dashboard/qr-dialog'
import type { RestaurantBookingExposure } from '@line-crm/shared'
import styles from './guide-last-step.module.css'

const NEXT_ACTIONS = [
  { href: '/broadcasts/new', icon: Megaphone, label: 'はじめての配信を作る', note: 'お店のお知らせを友だちに届ける' },
  { href: '/templates/edit?kind=coupon', icon: Ticket, label: 'クーポンを作る', note: '来店のきっかけをつくる' },
  { href: '/line-notifications', icon: Bell, label: '予約の通知を設定', note: '新しい予約をすぐ知る' },
]

export function GuideReceiveFirstMessage({ basicId, step, total, watchExpired, onReload, onRewatch, onTest, onLater }: {
  basicId?: string | null
  step: number
  total: number
  watchExpired: boolean
  onReload?: () => Promise<void>
  onRewatch: () => void
  onTest?: () => void
  onLater: () => void
}) {
  const [result, setResult] = useState<{ url: string; qr: string | null } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [retrying, setRetrying] = useState(false)
  const lineId = basicId?.trim()
  const url = lineId && /^@?[a-z0-9._-]+$/i.test(lineId) ? resolveOfficialProfileUrl(undefined, lineId) : null
  const currentResult = result?.url === url ? result : null
  const qrError = !url || (currentResult !== null && !currentResult.qr)
  const retry = async () => {
    setRetrying(true)
    try { await onReload?.() } catch { /* 接続情報が取れない場合は再読み込みを案内したままにする。 */ }
    finally { setAttempt(value => value + 1); setRetrying(false) }
  }
  useEffect(() => {
    if (!url) return
    let current = true
    setResult(null)
    void qrToDataURL(url, { width: 300, margin: 2 }).then(
      qr => { if (current) setResult({ url, qr }) },
      () => { if (current) setResult({ url, qr: null }) },
    )
    return () => { current = false }
  }, [url, attempt])

  const title = '最初の1通を受け取る'
  const instructions = [
    'スマホのカメラでQRを読み取る',
    '友だち追加して、あいさつメッセージを確認する',
    '届いたら、この画面に自動でチェックが付きます',
  ]
  return (
    <Dialog open title={title} titleContent={<span className={styles.receiveTitle}>
      <span className={styles.step}>{step}/{total}</span>
      <span><strong>{title}</strong><span className={styles.description}>ご自分のスマホでQRコードを読み取り、お店のLINEを友だち追加してください。最初のメッセージが届いたら完了です。</span></span>
    </span>} designNode="waX3A" designLayout="stacked-guided" designWidth={640} exactDesignWidth designMinHeight={368}
      headerIcon={false} onCancel={onLater} footerDivider={false} showCloseButton designFooterGap={onTest ? 14 : undefined}
      footer={<div className={onTest ? styles.receiveFooter : undefined}>
        <DialogActions>
          {onTest ? <Button className={styles.confirmAction} presentation="first-run-start" onClick={onTest}>テスト送信を開く</Button> : null}
          <Button variant="text" size="inline" onClick={onLater}>あとで</Button>
        </DialogActions>
      </div>}
    >
      <div className={styles.receive}>
        {qrError ? <InlineLoadFailure
          title="QRコードを表示できませんでした"
          description="LINEアカウントの接続を確認してから、もう一度お試しください。"
          retrying={retrying}
          onRetry={() => void retry()}
          data-design-node="u2ajkD"
        /> : <>
        <div className={styles.receiveInstructions}>
          {currentResult?.qr ? <img className={styles.qr} src={currentResult.qr} alt="友だち追加のQRコード" width={150} height={150} />
              : <ListState kind="loading" title="QRコードを用意しています" />}
          <ol className={styles.instructions}>
            {instructions.map((instruction, index) => <li key={instruction}><span className={styles.instructionNumber} aria-hidden="true">{index + 1}</span>{instruction}</li>)}
          </ol>
        </div>
        <p className={styles.waiting} role="status"><Hourglass size={16} aria-hidden="true" />{watchExpired ? 'まだ受信を確認できていません。' : '受信を待っています…'}</p>
        {watchExpired ? <Button onClick={onRewatch}>もう一度確かめる</Button> : null}
        </>}
        {onTest ? <div className={styles.existingFriend}>
          <h3>すでに友だち追加している場合</h3>
          <p>このLINEアカウントから、ご自身のLINEにテストメッセージを送って確認できます。</p>
        </div> : null}
      </div>
    </Dialog>
  )
}

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
