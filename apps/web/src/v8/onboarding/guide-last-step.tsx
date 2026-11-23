'use client'

import { useEffect, useState } from 'react'
import { Bell, Check, Hourglass, Megaphone, Ticket } from 'lucide-react'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import ListState from '@/components/shared/list-state'
import Link from '@/components/shared/list-navigation'
import { InlineLoadFailure } from '@/components/shared/target-missing'
import { qrToDataURL } from '@/lib/qr-image'
import { resolveOfficialProfileUrl } from '@/components/dashboard/qr-dialog'
import styles from './guide-last-step.module.css'

const NEXT_ACTIONS = [
  { href: '/broadcasts/new', icon: Megaphone, label: 'はじめての配信を作る', note: 'お店のお知らせを友だちに届ける' },
  { href: '/templates/edit?kind=coupon', icon: Ticket, label: 'クーポンを作る', note: '来店のきっかけをつくる' },
  { href: '/line-notifications', icon: Bell, label: '予約の通知を設定', note: '新しい予約をすぐ知る' },
]

export function GuideReceiveFirstMessage({ basicId, step, total, watchExpired, onReload, onRewatch, onLater }: {
  basicId?: string | null
  step: number
  total: number
  watchExpired: boolean
  onReload?: () => Promise<void>
  onRewatch: () => void
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
      headerIcon={false} onCancel={onLater} footerDivider={false}
      footer={<DialogActions><Button variant="text" size="inline" onClick={onLater}>あとで</Button></DialogActions>}
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
        <p className={styles.waiting} role="status"><Hourglass size={16} aria-hidden="true" />{watchExpired ? 'まだ受信を確認できていません。' : '受信を待っています… 届くと自動で完了になり、開店準備完了の画面へ進みます'}</p>
        {watchExpired ? <Button onClick={onRewatch}>もう一度確かめる</Button> : null}
        </>}
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
