'use client'

import { Check } from 'lucide-react'
import { useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useState, type FormEvent } from 'react'
import AuthCard, { AuthField } from '@/components/auth/auth-card'
import PasswordField from '@/components/auth/password-field'
import PasswordRequirements from '@/components/auth/password-requirements'
import Button from '@/components/shared/button'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import { storeAdminSession, twoFactorChallengeHandoffPath } from '@/lib/admin-session'
import { authRequest, confirmError, CONTACT_URL, internalAuthFailureCopy, passwordError, readDeviceMarker, storeDeviceMarker } from '@/lib/auth-email'
import { resetAuthSelectionCleared } from '@/lib/hq-navigation'
import styles from './complete.module.css'

/**
 * 会員登録の本登録。★管理画面 36-4-B（`jk88n`、カード `oVX3x`）。
 *
 * 承認メールの URL（`?token=`）から開く。申込済み会社名・担当者名を確認してパスワードを入れると
 * 統括（トライアル 30 日）とオーナー権限者を作り、二段階認証の設定へ進む。
 */
export default function RegisterCompletePage() {
  return (
    <Suspense fallback={<CompletePending />}>
      <CompleteInner />
    </Suspense>
  )
}

function CompletePending() {
  return (
    <AuthCard node="jk88n" cardNode="oVX3x" title="本登録" description="URL を確かめています">
      <ListState kind="loading" title="URL を確かめています" />
    </AuthCard>
  )
}

type TokenCheck = { state: 'checking' } | { state: 'ok'; email: string; trialDays: number; companyName: string; contactName: string } | { state: 'pending' } | { state: 'expired'; maskedEmail: string } | { state: 'bad'; message: string }

function CompleteInner() {
  const params = useSearchParams()
  const token = params.get('token') ?? ''
  const [check, setCheck] = useState<TokenCheck>({ state: 'checking' })
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [messages, setMessages] = useState<Record<string, string | null>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent'>('idle')

  useEffect(() => {
    let alive = true
    if (!token) {
      setCheck({ state: 'bad', message: 'この URL は正しくありません。メールの URL をそのまま開いてください' })
      return
    }
    void authRequest<{ email: string; trialDays: number; companyName: string; contactName: string } | { maskedEmail: string; canResend: boolean }>(`/api/auth/register/check?token=${encodeURIComponent(token)}`).then((res) => {
      if (!alive) return
      if (res.ok && res.data && 'email' in res.data) setCheck({ state: 'ok', email: res.data.email, trialDays: res.data.trialDays, companyName: res.data.companyName, contactName: res.data.contactName })
      else if (res.code === 'approval_required') setCheck({ state: 'pending' })
      else if (res.code === 'expired' && res.data && 'maskedEmail' in res.data && res.data.canResend) {
        setCheck({ state: 'expired', maskedEmail: res.data.maskedEmail })
      }
      else setCheck({ state: 'bad', message: res.error || 'この URL は使えません' })
    })
    return () => {
      alive = false
    }
  }, [token])

  const resendExpired = async () => {
    setResendState('sending')
    setError('')
    const res = await authRequest<{ maskedEmail: string; sent: boolean }>('/api/auth/register/resend-expired', { token })
    if (res.ok && res.data) {
      setResendState('sent')
      return
    }
    setError(res.error ?? 'ご案内メールを送れませんでした。時間をおいて再度お試しください')
    setResendState('idle')
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const next: Record<string, string | null> = {
      password: passwordError(password),
      confirm: confirmError(password, confirm),
    }
    setMessages(next)
    if (Object.values(next).some(Boolean)) return
    setBusy(true)
    setError('')
    const res = await authRequest<{ tenantId: string; deviceMarker: string; sessionToken?: string; twoFactorSetup?: boolean; challengeToken?: string }>('/api/auth/register/complete', {
      token,
      password,
      deviceMarker: readDeviceMarker(),
    })
    if (!res.ok || !res.data) {
      if (res.errors) setMessages((current) => ({ ...current, ...res.errors }))
      setError(internalAuthFailureCopy(res.status, res.error) ?? res.error ?? '登録を完了できませんでした。時間をおいて、もう一度お試しください。')
      setBusy(false)
      return
    }
    storeDeviceMarker(res.data.deviceMarker)
    resetAuthSelectionCleared(localStorage, sessionStorage)
    // オーナーは二段階認証が必須（N-426）。設定画面へ進み、完了後にセッションが出る。
    if (res.data.twoFactorSetup && res.data.challengeToken) {
      window.location.assign(twoFactorChallengeHandoffPath('/login/two-factor/setup', res.data.challengeToken))
      return
    }
    if (res.data.sessionToken) storeAdminSession(res.data.sessionToken, res.csrfToken)
    else if (res.csrfToken) {
      // M045: 保存に失敗しても登録は進める（Cookie のセッションで足りる）。
      // 投げたままにすると登録中の表示で止まる。
      try { localStorage.setItem('lh_csrf', res.csrfToken) } catch { /* Cookie session is sufficient */ }
    }
    window.location.assign('/hq')
  }

  if (check.state === 'checking') return <CompletePending />
  if (check.state === 'expired') {
    return <AuthCard node="xdN8H" applicationFlow="recovery" title="ログイン設定のご案内"
      description={resendState === 'sent' ? '申込時のメールアドレスに、新しいアカウント作成リンクをお送りしました。' : 'お申し込みは承認済みです。新しいご案内を申込時のメールアドレスへお送りします。'}>
      <div className={styles.recoveryPanel}>
        <span className={styles.recoveryIcon} aria-hidden="true">{resendState === 'sent' ? '✓' : '!'}</span>
        <h2>{resendState === 'sent' ? 'ご案内メールをお送りしました' : 'アカウント作成のリンクが期限切れです'}</h2>
        <p>送信先 <strong>{check.maskedEmail}</strong></p>
        <p>{resendState === 'sent' ? 'メールの「アカウント作成へ」から設定を続けてください。' : '送信先は申込時のアドレスに固定されています。'}</p>
        <p>新しいリンクは送信から24時間有効です。再送後、以前のリンクは利用できません。</p>
      </div>
      {error ? <Notice tone="danger" message={error} /> : null}
      {resendState !== 'sent' ? <Button type="button" variant="primary" disabled={resendState === 'sending'}
        busy={resendState === 'sending'} busyLabel="送信しています…" className={styles.recoveryButton}
        onClick={() => void resendExpired()}>案内メールを再送する</Button> : null}
      <a href="/login" className={styles.login}>すでに設定を終えた方はログインへ</a>
      <a href={CONTACT_URL} target="_blank" rel="noreferrer" className={styles.recoveryLink}>リンクを確認できない場合はお問い合わせへ</a>
    </AuthCard>
  }
  if (check.state === 'bad') {
    return (
      <AuthCard node="r2pk7" applicationFlow="recovery" title="ログイン設定のご案内" description="このリンクが正しくないか、すでに使われています。">
        <div className={styles.recoveryPanel}>
          <span className={styles.recoveryIcon} aria-hidden="true">!</span>
          <h2>このリンクを確認できません</h2>
          <p>安全のため、この画面では申込情報を表示しません。</p>
          <p>まだアカウントを作成していない場合は、申込時のメールアドレスを添えてお問い合わせください。担当者が登録状況を確認します。</p>
        </div>
        <a href={CONTACT_URL} target="_blank" rel="noreferrer" className={styles.contact}>お問い合わせへ</a>
        <a href="/login" className={styles.login}>すでに設定を終えた方はログインへ</a>
      </AuthCard>
    )
  }
  if (check.state === 'pending') {
    return <AuthCard node="VA42o" applicationFlow="pending" title="お申し込みを確認中です"
      description="担当者からご連絡します。承認のご案内が届くまで、musuboへのログインはできません。">
      <div className={styles.pendingNext}>
        <strong>次に行うこと</strong>
        お申し込み時のメールをご確認ください。担当者からの連絡がない場合はお問い合わせください。
      </div>
      <a href={CONTACT_URL} target="_blank" rel="noreferrer" className={styles.contact}>お問い合わせ</a>
      <a href="/login" className={styles.login}>ログイン画面に戻る</a>
    </AuthCard>
  }

  return (
    <AuthCard
      node="x73h3"
      applicationFlow="setup"
      title="利用開始の設定"
      description="お申し込みが承認されました。ログイン用アカウントを作成し、料金と無料期間を確認してからLINEを接続します。"
    >
      <div className={styles.approved}>✓ 承認済み　初期設定を完了してください</div>
      <form onSubmit={(event) => void submit(event)} noValidate className="flex w-full flex-col gap-4">
        {error ? (
          <Notice tone="danger" message={error} />
        ) : null}
        <ConfirmedField label="メールアドレス" id="complete-email" value={check.email} />
        <ConfirmedField label="会社名" id="complete-tenant" value={check.companyName} />
        <ConfirmedField label="担当者名" id="complete-name" value={check.contactName} />
        <AuthField label="パスワード" htmlFor="complete-password" error={messages.password}>
          <PasswordField id="complete-password" value={password} onChange={setPassword} invalid={Boolean(messages.password)} autoComplete="new-password" placeholder="新しいパスワードを入力" />
          <PasswordRequirements value={password} />
        </AuthField>
        <AuthField label="パスワード（確認）" htmlFor="complete-confirm" error={messages.confirm}>
          <PasswordField id="complete-confirm" value={confirm} onChange={setConfirm} invalid={Boolean(messages.confirm)} autoComplete="new-password" />
        </AuthField>
        <Button type="submit" variant="primary" disabled={busy} className="w-full" busy={busy} busyLabel="設定しています…">アカウントを作成する
        </Button>
      </form>
    </AuthCard>
  )
}

function ConfirmedField({ label, id, value }: { label: string; id: string; value: string }) {
  return <AuthField label={label} htmlFor={id}>
    <output id={id} className="flex h-11 w-full items-center justify-between rounded-control border border-hairline bg-surface-pearl px-3 text-label text-ink-secondary">
      <span className="truncate">{value}</span>
      <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-accent-deep" />
    </output>
  </AuthField>
}
