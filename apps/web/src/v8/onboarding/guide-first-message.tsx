'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Button from '@/components/shared/button'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import { firstMessageApi, type FirstMessageState, type FirstMessageStatus } from '@/lib/first-message-api'
import { qrToDataURL } from '@/lib/qr-image'
import styles from './guide-last-step.module.css'

const TITLE = '最初の1通を受け取る'
const POLL_MS = 2500

const messages: Record<FirstMessageStatus, {
  tone: 'info' | 'success' | 'warn' | 'danger'
  title: string
  detail?: string
}> = {
  ready: { tone: 'success', title: '送信先を確認済み' },
  sending: { tone: 'info', title: 'テストメッセージを送信中…' },
  sent: { tone: 'warn', title: 'LINEが送信を受け付けました', detail: '届いたメッセージで「受け取りました」を押すと、自動で完了画面へ進みます。' },
  received: { tone: 'success', title: '受け取りを確認しました' },
  busy: { tone: 'danger', title: 'LINEが一時的に混み合っています', detail: '少し時間をおいて、もう一度送信してください。' },
  unknown: { tone: 'warn', title: '送信結果を確認できませんでした', detail: 'LINEに届いていれば「受け取りました」を押してください。' },
  identity_required: { tone: 'info', title: '本人のLINEの確認が必要です', detail: 'お店のLINEでご自身を確認すると、この画面に戻ります。' },
  connection: { tone: 'danger', title: 'お店のLINEとの接続を確認してください', detail: '接続を直したら、この画面に戻ってもう一度送信してください。' },
  friend_required: { tone: 'warn', title: 'このお店のLINEの友だち追加を確認', detail: 'お店のLINEを開き、友だち追加やブロックの状態を確認してください。' },
  sending_stopped: { tone: 'warn', title: 'テストメッセージの送信が停止中です', detail: '送信できる状態に戻ったら、もう一度確認してください。' },
  failed: { tone: 'danger', title: 'お店のLINEとの接続を確認してください', detail: '接続を直したら、この画面に戻ってもう一度送信してください。' },
}

export function GuideFirstMessage({ accountId, accountName, step, total, onReceived, onLater }: {
  accountId: string
  accountName?: string
  step: number
  total: number
  onReceived: () => void
  onLater: () => void
}) {
  const [data, setData] = useState<FirstMessageState | null>(null)
  const [error, setError] = useState(false)
  const [pending, setPending] = useState<'send' | 'identity' | 'status' | null>(null)
  const [verificationUrl, setVerificationUrl] = useState<string | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [checkedAt, setCheckedAt] = useState(Date.now)
  const [friendOpened, setFriendOpened] = useState(false)
  const [connectionOpened, setConnectionOpened] = useState(false)
  const receivedAction = useRef(onReceived)
  useEffect(() => { receivedAction.current = onReceived }, [onReceived])
  const mounted = useRef(false)
  const requestPending = useRef(false)

  const run = useCallback(async (action: 'send' | 'identity' | 'status', quiet = false) => {
    if (requestPending.current) return
    requestPending.current = true
    if (!quiet) setPending(action)
    try {
      const verification = action === 'identity' ? await firstMessageApi.identity(accountId) : null
      if (verification?.verificationUrl && mounted.current) setVerificationUrl(verification.verificationUrl)
      const resolved = action === 'send' ? await firstMessageApi.send(accountId) : await firstMessageApi.status(accountId)
      if (mounted.current) {
        setData(resolved)
        setError(false)
        setCheckedAt(Date.now())
        if (resolved.status !== 'identity_required') setVerificationUrl(null)
        if (resolved.status !== 'friend_required') setFriendOpened(false)
      }
    } catch {
      if (mounted.current && !quiet) {
        if (action === 'send') {
          setData(previous => previous && { ...previous, status: 'unknown' })
        } else {
          setError(true)
        }
      }
    } finally {
      requestPending.current = false
      if (mounted.current && !quiet) setPending(null)
    }
  }, [accountId])

  useEffect(() => {
    mounted.current = true
    void run('status')
    return () => { mounted.current = false }
  }, [run])

  const messageStatus = pending === 'send' ? 'sending' : data?.status
  const shouldPoll = messageStatus === 'sending' || messageStatus === 'sent' || messageStatus === 'unknown' ||
    (messageStatus === 'busy' && checkedAt < (data?.retryAt ?? 0)) || Boolean(data?.verificationPending || verificationUrl) || friendOpened

  useEffect(() => {
    const read = () => { if (!document.hidden) void run('status', true) }
    window.addEventListener('focus', read)
    document.addEventListener('visibilitychange', read)
    const timer = shouldPoll ? window.setInterval(read, POLL_MS) : null
    return () => {
      window.removeEventListener('focus', read)
      document.removeEventListener('visibilitychange', read)
      if (timer !== null) window.clearInterval(timer)
    }
  }, [run, shouldPoll])

  useEffect(() => {
    if (messageStatus !== 'received') return
    receivedAction.current()
    const timer = window.setInterval(() => receivedAction.current(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [messageStatus])

  useEffect(() => {
    if (!verificationUrl) return
    let active = true
    setQr(null)
    void qrToDataURL(verificationUrl, { width: 288, margin: 2 }).then(
      url => { if (active) setQr(url) },
      () => { if (active) setQr(null) },
    )
    return () => { active = false }
  }, [verificationUrl])

  const message = error ? {
    tone: 'warn' as const,
    title: '確認できませんでした',
    detail: 'もう一度お試しください。',
  } : messageStatus ? messages[messageStatus] : { tone: 'info' as const, title: '送信先を確認しています…' }
  const read = () => void run('status')
  const send = () => void run('send')
  const checkIdentity = () => void run('identity')
  const disableRetry = checkedAt < (data?.retryAt ?? 0)
  const profileLink = data?.friendUrl
  const expanded = error || messageStatus === 'busy' || messageStatus === 'unknown' || messageStatus === 'identity_required' || messageStatus === 'connection' || messageStatus === 'friend_required' || messageStatus === 'failed' || messageStatus === 'sending_stopped'

  const action = (() => {
    if (error || messageStatus === 'sending_stopped') return <Button variant="primary" className={styles.testAction} onClick={read}>もう一度確認する</Button>
    if (messageStatus === 'ready') return <Button variant="primary" className={styles.testAction} onClick={send}>自分のLINEにテスト送信</Button>
    if (messageStatus === 'sending') return <Button variant="primary" className={styles.testAction} busy busyLabel="送信中…">送信中…</Button>
    if (messageStatus === 'sent' || messageStatus === 'received') return <Button variant="primary" className={styles.testAction} disabled>確認を待っています…</Button>
    if (messageStatus === 'busy') return <Button variant="primary" className={styles.testAction} onClick={send} disabled={disableRetry}>もう一度送信する</Button>
    if (messageStatus === 'unknown') return <Button variant="primary" className={styles.testAction} onClick={read} busy={pending === 'status'} busyLabel="確認中…">送信結果を確認する</Button>
    if (messageStatus === 'identity_required') {
      return verificationUrl
        ? <Button variant="primary" className={styles.testAction} href={verificationUrl} external>お店のLINEを開く</Button>
        : <Button variant="primary" className={styles.testAction} onClick={checkIdentity} busy={pending === 'identity'} busyLabel="確認中…">自分のLINEを確認</Button>
    }
    if (messageStatus === 'friend_required' && profileLink) {
      return <Button variant="primary" className={styles.testAction} href={profileLink} external onClick={() => setFriendOpened(true)}>お店のLINEを開く</Button>
    }
    if ((messageStatus === 'connection' || messageStatus === 'failed') && connectionOpened && data?.accountName) {
      return <Button variant="primary" className={styles.testAction} onClick={send}>もう一度送信する</Button>
    }
    if (messageStatus === 'connection' || messageStatus === 'failed' || messageStatus === 'friend_required') {
      return <Button variant="primary" className={styles.testAction} href={'/accounts/detail?' + new URLSearchParams({ id: accountId })} external onClick={() => setConnectionOpened(true)}>LINEの接続を確認する</Button>
    }
    return null
  })()

  return (
    <Dialog open title={TITLE} titleContent={<span className={styles.testTitle}>
      <span className={styles.step}>{step}/{total}</span>
      <strong>{TITLE}</strong>
    </span>} designNode="waX3A" designLayout="stacked-guided" designWidth={650} exactDesignWidth designMinHeight={expanded ? 368 : 350}
      headerIcon={false} onCancel={onLater} footerDivider={false} showCloseButton
      footer={<DialogActions align="center" layout="inline">
        {action}
        <Button variant="text" size="inline" onClick={onLater}>あとで</Button>
      </DialogActions>}
    >
      <div className={styles.testMessage}>
        <p className={styles.testDescription}>{messageStatus === 'identity_required' ? '自分のLINEを確認してからテスト送信します。' : 'お店のLINEから、ご自身のLINEにテストメッセージを送ります。'}</p>
        <dl className={styles.testDestination}>
          <div><dt>お店のLINE</dt><dd>{data?.accountName ?? accountName ?? '接続中のお店のLINE'}</dd></div>
          <div><dt>送信先</dt><dd>{messageStatus === 'identity_required' ? '自分のLINEを確認する' : '自分のLINE'}</dd></div>
        </dl>
        <div className={styles.testStatus} data-tone={message.tone} role="status">
          <strong>{message.title}</strong>
          {message.detail ? <p>{message.detail}</p> : null}
        </div>
        {messageStatus === 'identity_required' && verificationUrl ? <div className={styles.testVerification}>
          {qr ? <img src={qr} alt="本人確認用のQRコード" width={144} height={144} /> : null}
          <p>スマホでQRコードを読み取るか、お店のLINEを開いて、トークに表示された確認メッセージを送ってください。</p>
        </div> : null}
      </div>
    </Dialog>
  )
}
