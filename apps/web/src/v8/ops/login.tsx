'use client'

import { beginAdminLoginHandoff, twoFactorChallengeHandoffPath } from '@/lib/admin-session'
import { LogIn } from 'lucide-react'
import Link from '@/components/shared/list-navigation'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import LineLoginMark from '@/components/auth/line-login-mark'
import PasswordField from '@/components/auth/password-field'
import Turnstile, { type TurnstileHandle } from '@/components/auth/turnstile'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import { TextField } from '@/components/shared/text-field'
import { storeAdminSession, adminSessionHeaders } from '@/lib/admin-session'
import { authRequest, emailError, internalAuthFailureCopy, TURNSTILE_SITE_KEY } from '@/lib/auth-email'
import { resetAuthSelectionCleared } from '@/lib/hq-navigation'
import MusuboLogo from '@/components/shared/musubo-logo'
import styles from './auth.module.css'
import { Field } from '@/components/shared/form-controls'
import Card from '@/components/shared/card'
import { PageHeading } from '@/components/templates/page-frame'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'

const LINE_LOGIN_FAILURE_CODES = new Set([
  'line_token_failed',
  'line_id_token_missing',
  'line_verify_failed',
  'line_profile_missing',
  'line_login_failed',
])

/**
 * 運営コンソールのログイン V8。
 *
 * 動きは 管理画面（app/ops/login）と同じ：メール＋パスワードが主、LINE が副。
 * 入れた後に /api/auth/session で運営メンバーかを確かめてから /ops へ進む。
 * 二段階認証が要る人は /login/two-factor（設定がまだなら setup）へ送る。
 */
export default function OpsLoginV8() {
  const saveErrors = useSaveFormErrors()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [emailMessage, setEmailMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState<'password' | 'line' | null>(null)
  const busyRef = useRef<'password' | 'line' | null>(null)
  const [error, setError] = useState('')
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const turnstileRef = useRef<TurnstileHandle | null>(null)
  const setTurnstileHandle = useCallback((handle: TurnstileHandle | null) => {
    turnstileRef.current = handle
  }, [])

  useEffect(() => {
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      busyRef.current = null
      setBusy(null)
      turnstileRef.current?.reset()
    }
    window.addEventListener('pageshow', restore)
    const errorCode = new URLSearchParams(window.location.search).get('error')
    if (errorCode === 'not_authorized') {
      setError('このアカウントは運営メンバーに登録されていません。ほかの運営メンバーに追加を依頼してください。')
    } else if (errorCode === 'not_platform_admin') {
      setError('ログインはできましたが、運営メンバーではありません。')
    } else if (errorCode && (LINE_LOGIN_FAILURE_CODES.has(errorCode) || errorCode === 'invalid_state')) {
      setError('LINEログインを完了できませんでした。もう一度お試しください。')
    } else if (errorCode) {
      setError('ログインを完了できませんでした。もう一度お試しください。')
    }
    return () => window.removeEventListener('pageshow', restore)
  }, [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busyRef.current !== null) return
    const emailProblem = emailError(email)
    setEmailMessage(emailProblem)
    if (emailProblem) return
    if (!password) {
      setError('パスワードを入力してください')
      return
    }
    if (!turnstileToken) {
      setError('「私はロボットではありません」の確認を済ませてください')
      return
    }
    busyRef.current = 'password'
    setBusy('password')
    setError('')
    const res = await authRequest<{ twoFactor: boolean; twoFactorSetup?: boolean; challengeToken?: string; sessionToken?: string }>('/api/auth/password/login', {
      email: email.trim(),
      password,
      next: 'ops',
      turnstileToken,
    })
    turnstileRef.current?.reset()
    if (!res.ok || !res.data) {
      setError(internalAuthFailureCopy(res.status, res.error) ?? res.error ?? 'ログインできませんでした。時間をおいて、もう一度お試しください。')
      busyRef.current = null
      setBusy(null)
      return
    }
    resetAuthSelectionCleared(localStorage, sessionStorage)
    if (res.data.twoFactorSetup && res.data.challengeToken) {
      window.location.assign(twoFactorChallengeHandoffPath('/login/two-factor/setup?next=ops', res.data.challengeToken))
      return
    }
    if (res.data.twoFactor && res.data.challengeToken) {
      window.location.assign(twoFactorChallengeHandoffPath('/login/two-factor?next=ops', res.data.challengeToken))
      return
    }
    if (res.data.sessionToken) storeAdminSession(res.data.sessionToken, res.csrfToken)
    else if (res.csrfToken) {
      try { localStorage.setItem('lh_csrf', res.csrfToken) } catch (saveFailure) {
        saveErrors.capture(saveFailure) /* Cookie のセッションで足りる */ }
    }

    const apiUrl = process.env.NEXT_PUBLIC_API_URL
    try {
      const session = await fetch(`${apiUrl}/api/auth/session`, { credentials: 'include', headers: adminSessionHeaders() })
      const body = await session.json() as { data?: { platformAdmin?: boolean; platformAdminState?: string | null } }
      if (!body.data?.platformAdmin) {
        if (body.data?.platformAdminState === 'awaiting_totp') {
          window.location.assign('/ops/two-factor')
          return
        }
        setError('ログインはできましたが、運営メンバーではありません。')
        busyRef.current = null
        setBusy(null)
        return
      }
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)

      setError('ログイン状態を確認できませんでした。もう一度お試しください。') }
      busyRef.current = null
      setBusy(null);

      return
    }
    window.location.assign('/ops')
  }

  const lineLogin = () => {
    if (busyRef.current !== null) return
    busyRef.current = 'line'
    setBusy('line')
    resetAuthSelectionCleared(localStorage, sessionStorage)
    const apiUrl = process.env.NEXT_PUBLIC_API_URL
    if (!apiUrl) {
      busyRef.current = null
      return setBusy(null)
    }
    window.location.assign(`${apiUrl}/api/auth/line?${new URLSearchParams({ next: 'ops', handoff: beginAdminLoginHandoff() })}`)
  }

  return (
    <SaveErrorScope errors={saveErrors}><main className={styles.page} data-design-node="D9JALJ">
      <div className={styles.brand}>
        <MusuboLogo size="ops" />
        <span className={styles.brandSub}>運営コンソール</span>
      </div>
      <Card variant="form" className={styles.card} aria-labelledby="ops-login-title">
        <PageHeading inset="none" title="ログイン" titleId="ops-login-title" titleAs="h1" />
        <form onSubmit={(event) => void submit(event)} noValidate className={styles.form}>
          {error ? <Notice tone="danger" message={error} /> : null}
          <div className={styles.field}><Field label="メールアドレス" htmlFor="ops-login-email" required><SaveErrorField names={["email"]}><TextField
              id="ops-login-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              invalid={Boolean(emailMessage)}
              aria-describedby={emailMessage ? 'ops-login-email-error' : undefined}
              autoComplete="email"
              inputMode="email"
              placeholder="you@example.com"
            /></SaveErrorField>
{emailMessage ? <p id="ops-login-email-error" className={styles.error}>{emailMessage}</p> : null}</Field></div>
          <div className={styles.field}><Field label={<>パスワード</>} htmlFor="ops-login-password" required><PasswordField id="ops-login-password" value={password} onChange={setPassword} autoComplete="current-password" /></Field></div>
          <Turnstile onToken={setTurnstileToken} handleRef={setTurnstileHandle} />
          <Button fullWidth type="submit" variant="primary" disabled={busy !== null || !TURNSTILE_SITE_KEY} className={styles.wide} busy={busy === 'password'} busyLabel="ログインしています…">
            <LogIn aria-hidden="true" />ログイン
          </Button>
        </form>
        <div className={styles.or} aria-hidden="true">
          <span className={styles.rule} />
          <span>または</span>
          <span className={styles.rule} />
        </div>
        <Button fullWidth variant="line" onClick={lineLogin} disabled={busy !== null} className={styles.wide} busy={busy === 'line'} busyLabel="LINEへ移動中…">
          <LineLoginMark />LINE でログイン
        </Button>
        <Link href="/password/forgot" className={styles.forgot}>パスワードを忘れた方はこちら</Link>
        <p className={styles.note}>運営メンバーの招待を受けた方は、招待メールのリンクから設定してください</p>
      </Card>
      <p className={styles.foot}>この画面は運営メンバーだけが開けます。操作はすべて記録されます。</p>
    </main></SaveErrorScope>
  )
}
