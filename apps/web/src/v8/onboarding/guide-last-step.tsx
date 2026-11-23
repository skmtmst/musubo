'use client'

import { useEffect, useState } from 'react'
import { Bell, Check, Hourglass, Megaphone, Ticket } from 'lucide-react'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import ListState from '@/components/shared/list-state'
import Link from '@/components/shared/list-navigation'
import { qrToDataURL } from '@/lib/qr-image'
import styles from './guide-last-step.module.css'

const NEXT_ACTIONS = [
  { href: '/broadcasts/new', icon: Megaphone, label: 'はじめての配信を作る', note: 'お店のお知らせを友だちに届ける' },
  { href: '/templates/edit?kind=coupon', icon: Ticket, label: 'クーポンを作る', note: '来店のきっかけをつくる' },
  { href: '/line-notifications', icon: Bell, label: '予約の通知を設定', note: '新しい予約をすぐ知る' },
]

export function GuideReceiveFirstMessage({ channelId, step, total, watchExpired, richMenuPublished, onRewatch, onLater }: {
  channelId: string
  step: number
  total: number
  watchExpired: boolean
  richMenuPublished: boolean
  onRewatch: () => void
  onLater: () => void
}) {
  const [qr, setQr] = useState<string | null>(null)
  const [qrError, setQrError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const base = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/$/, '')
    const url = new URL(`${base}/auth/line`, window.location.origin)
    url.searchParams.set('account', channelId)
    let current = true
    setQr(null)
    setQrError(false)
    void qrToDataURL(url.toString(), { width: 300, margin: 2 }).then(
      value => { if (current) setQr(value) },
      () => { if (current) setQrError(true) },
    )
    return () => { current = false }
  }, [channelId, attempt])

  const title = '最初の1通を受け取る'
  const instructions = [
    'スマホのカメラでQRを読み取る',
    richMenuPublished ? '友だち追加すると、あいさつ＋リッチメニューが届く' : '友だち追加して、あいさつメッセージを確認する',
    '届いたら、この画面に自動でチェックが付きます',
  ]
  return (
    <Dialog open title={title} titleContent={<span className={styles.receiveTitle}>
      <span className={styles.step}>{step}/{total}</span>
      <span><strong>{title}</strong><span className={styles.description}>ご自分のスマホでQRコードを読み取り、お店のLINEを友だち追加してください。最初のメッセージが届いたら完了です。</span></span>
    </span>} designNode="WK9eH" designLayout="stacked-guided" designWidth={640} exactDesignWidth designMinHeight={368}
      headerIcon={false} onCancel={onLater} footerDivider={false} showCloseButton
      footer={<DialogActions><Button variant="text" size="inline" onClick={onLater}>あとで</Button></DialogActions>}
    >
      <div className={styles.receive}>
        <div className={styles.receiveInstructions}>
          {qrError ? <ListState kind="error" title="QRコードを表示できませんでした" onRetry={() => setAttempt(value => value + 1)} />
            : qr ? <img className={styles.qr} src={qr} alt="友だち追加のQRコード" width={150} height={150} />
              : <ListState kind="loading" title="QRコードを用意しています" />}
          <ol className={styles.instructions}>
            {instructions.map((instruction, index) => <li key={instruction}><span className={styles.instructionNumber} aria-hidden="true">{index + 1}</span>{instruction}</li>)}
          </ol>
        </div>
        <p className={styles.waiting} role="status"><Hourglass size={16} aria-hidden="true" />{watchExpired ? 'まだ受信を確認できていません。' : '受信を待っています… 届くと自動で完了になり、開店準備完了の画面へ進みます'}</p>
        {watchExpired ? <Button onClick={onRewatch}>もう一度確かめる</Button> : null}
      </div>
    </Dialog>
  )
}

export function GuideSetupComplete({ onClose, onHome }: { onClose: () => void; onHome: () => void }) {
  const title = '開店準備が完了しました'
  return (
    <Dialog open title={title} titleContent={<span className={styles.completeTitle}>
      <span className={styles.completed}><Check size={30} strokeWidth={4} aria-hidden="true" /></span>
      {title}
    </span>} description="LINEからの予約を受け付けています。ここからは、お客さまとのつながりを育てていきましょう。"
      designNode="N9qLt" designLayout="stacked-centered" designWidth={560} exactDesignWidth designMinHeight={472}
      headerIcon={false} onCancel={onClose} footerDivider={false} initialFocusId="guide-complete-home"
      footer={<div className={styles.completeFooter}>
        <DialogActions padding="none">
          <Button id="guide-complete-home" fullWidth variant="primary" onClick={onHome}>ダッシュボードへ</Button>
        </DialogActions>
        <img src="/brand/musubo-color.png" width={78} height={23} alt="musubo" />
      </div>}
    >
      <section className={styles.next} aria-label="次にできること">
        <h3>次にできること</h3>
        <div className={styles.nextActions}>
          {NEXT_ACTIONS.map(({ href, icon: Icon, label, note }) => (
            <Card key={href} edge="hairline" contentPadding="var(--space-14) var(--space-14)">
              <div className={styles.nextAction}>
                <Icon className={styles.choiceIcon} size={16} aria-hidden="true" />
                <Link className={styles.choiceLink} href={href} onClick={onClose}>{label}</Link>
                <p className={styles.choiceNote}>{note}</p>
              </div>
            </Card>
          ))}
        </div>
      </section>
    </Dialog>
  )
}
