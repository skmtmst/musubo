'use client'

import { twoFactorChallengeHandoffPath } from '@/lib/admin-session'
import { ArrowRight } from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import PasswordField from '@/components/auth/password-field'
import PasswordRequirements from '@/components/auth/password-requirements'
import Button from '@/components/shared/button'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import { TextField } from '@/components/shared/text-field'
import { isForbiddenOrRateLimited } from '@/components/shared/api-error-message'
import { adminSessionHandoffPath, storeAdminSession } from '@/lib/admin-session'
import { authRequest, passwordError } from '@/lib/auth-email'
import { ApiError } from '@/lib/api'
import { resetAuthSelectionCleared } from '@/lib/hq-navigation'
import MusuboLogo from '@/components/shared/musubo-logo'
import styles from './auth.module.css'
import { Field } from '@/components/shared/form-controls'
import Card from '@/components/shared/card'
import { PageHeading } from '@/components/templates/page-frame'
import { SaveErrorField } from '@/components/shared/save-form-errors'

type Check = { email: string; name: string; needsPassword: boolean }

/**
 * 運営メンバーの招待を受ける V8。
 *
 * 動きは 管理画面（app/ops/invite）と同じ。メールの URL の `#invite=…` を読み、
 * パスワードが無い人は名前とパスワードを決める。進んだ先は 二段階認証の設定。
 */
export default function OpsInviteV8() {
  const [token, setToken] = useState('')
  const [inviteCode, setInviteCode] = useState<string | null>(null)
  const [acceptCode, setAcceptCode] = useState<string | null>(null)
  const [check, setCheck] = useState<Check | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'invalid'>('loading')
  const [message, setMessage] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [nameMessage, setNameMessage] = useState<string | null>(null)
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null)
  const [confirmMessage, setConfirmMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [checkFailed, setCheckFailed] = useState<unknown>(null)
  /* 使えない招待（未使用でない・期限切れ・見つからない）では「もう一度読み込む」を出さない。通信・混雑・サーバーの失敗だけ再試行する。 */
  const [checkRetryable, setCheckRetryable] = useState(false)

  const checkInvite = useCallback(async () => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const value = hash.get('invite') ?? ''
    setToken(value)
    setState('loading')
    setMessage('')
    setCheckFailed(null)
    setCheckRetryable(false)
    setInviteCode(null)
    if (!value) { setState('invalid'); setMessage('この招待は見つかりません。招待した運営メンバーに確認してください'); return }
    const res = await authRequest<Check>(`/api/auth/ops-invite/check?token=${encodeURIComponent(value)}`)
    if (!res.ok || !res.data) {
      setCheckFailed(new ApiError(res.status, res.error))
      setCheckRetryable(res.status === 0 || res.status === 429 || res.status >= 500)
      setInviteCode(res.code ?? null)
      setState('invalid'); setMessage(res.error || 'この招待は使えません'); return
    }
    setCheck(res.data)
    setName(res.data.needsPassword ? '' : res.data.name)
    setState('ready')
  }, [])

  useEffect(() => { void checkInvite() }, [checkInvite])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!check) return
    if (check.needsPassword) {
      const nameProblem = name.trim() ? null : 'お名前を入力してください'
      const passwordProblem = passwordError(password)
      const confirmProblem = password === confirm ? null : 'パスワードが一致しません'
      setNameMessage(nameProblem)
      setPasswordMessage(passwordProblem)
      setConfirmMessage(confirmProblem)
      if (nameProblem || passwordProblem || confirmProblem) return
    }
    setBusy(true)
    setError('')
    setAcceptCode(null)
    const res = await authRequest<{ next: string; sessionToken?: string; challengeToken?: string; twoFactorSetup?: boolean }>('/api/auth/ops-invite/accept', {
      token,
      ...(check.needsPassword ? { name: name.trim(), password } : {}),
    })
    if (!res.ok || !res.data) {
      setError(res.error || '登録を進められませんでした')
      setAcceptCode(res.code ?? null)
      setBusy(false)
      return
    }
    resetAuthSelectionCleared(localStorage, sessionStorage)
    if (res.data.challengeToken) {
      const path = res.data.twoFactorSetup ? '/login/two-factor/setup' : '/login/two-factor';
      window.location.assign(twoFactorChallengeHandoffPath(`${path}?next=ops`, res.data.challengeToken))
      return
    }

    if (res.data.sessionToken) storeAdminSession(res.data.sessionToken, res.csrfToken)
    else if (res.csrfToken) {
      try { localStorage.setItem('lh_csrf', res.csrfToken) } catch { /* Cookie のセッションで足りる */ }
    }
    window.location.assign(adminSessionHandoffPath('/ops/two-factor', res.data.sessionToken, res.csrfToken))
  }

  const usedInvite = inviteCode === 'used' || acceptCode === 'used'
  const fieldError = (id: string, text: string | null) => (text ? <p id={id} className={styles.error}>{text}</p> : null)
  /* 名前とパスワードの説明は、招待が有効で入力へ進めるときだけ出す。確認中・使えない招待では出さない。 */
  const headingSubtitle = state === 'ready' ? (<>
    {check && !check.needsPassword
      ? '運営コンソールに招待されました（有効期限は24時間）。続けると二段階認証の設定に進みます。'
      : '運営コンソールに招待されました（有効期限は24時間）。名前とパスワードを決めると、次に二段階認証を設定します。'}
  </>) : undefined
  const invalidTitle = checkRetryable
    ? '招待を読み込めませんでした'
    : inviteCode === 'used' ? 'この招待はすでに使われています' : inviteCode === 'expired' ? 'この招待は期限切れです' : 'この招待は使えません'

  return (
    <main className={styles.page} data-design-node="tVaUh">
      <div className={styles.brand}>
        <MusuboLogo size="ops" />
        <span className={styles.brandSub}>運営コンソール</span>
      </div>
      <Card variant="form" className={styles.card} aria-labelledby="ops-invite-title">
        <PageHeading inset="none" title="運営メンバーの招待" titleId="ops-invite-title" titleAs="h1" subtitleSize="body" subtitle={headingSubtitle} />

        {state === 'loading' ? (
          <ListState permissionScope="hq" kind="loading" title="招待を確認しています" />
        ) : state === 'invalid' ? (
          <>
            <ListState permissionScope="hq"
              kind="error"
              title={invalidTitle}
              description={isForbiddenOrRateLimited(checkFailed) ? undefined : message}
              error={checkFailed ?? undefined}
              onRetry={checkRetryable ? () => void checkInvite() : undefined}
              action={checkRetryable ? undefined : null}
            />
            {checkRetryable ? null : <Button href="/ops/login" className={styles.wide}>運営のログインへ</Button>}
          </>
        ) : (
          <form onSubmit={(event) => void submit(event)} noValidate className={styles.form}>
            {error ? <Notice tone="danger" message={error} /> : null}
            {usedInvite && error ? <Button href="/ops/login" className={styles.wide}>運営のログインへ</Button> : null}
            <div className={styles.field}><Field label="メールアドレス" htmlFor="ops-invite-email"><SaveErrorField names={["email","check?.email"]}><TextField id="ops-invite-email" type="email" value={check?.email ?? ''} readOnly /></SaveErrorField></Field></div>
            {check?.needsPassword ? (
              <>
                <div className={styles.field}><Field label="名前" htmlFor="ops-invite-name" required><SaveErrorField names={["name"]}><TextField id="ops-invite-name" value={name} onChange={(event) => setName(event.target.value)} invalid={Boolean(nameMessage)} aria-describedby={nameMessage ? 'ops-invite-name-error' : undefined} autoComplete="name" placeholder="山田 花子" /></SaveErrorField>
{fieldError('ops-invite-name-error', nameMessage)}</Field></div>
                <div className={styles.field}><Field label={<>パスワード</>} htmlFor="ops-invite-password" required><PasswordField id="ops-invite-password" value={password} onChange={setPassword} invalid={Boolean(passwordMessage)} autoComplete="new-password" />
<PasswordRequirements value={password} />
{fieldError('ops-invite-password-error', passwordMessage)}</Field></div>
                <div className={styles.field}><Field label={<>パスワード（確認）</>} htmlFor="ops-invite-confirm" required><PasswordField id="ops-invite-confirm" value={confirm} onChange={setConfirm} invalid={Boolean(confirmMessage)} autoComplete="new-password" />
{fieldError('ops-invite-confirm-error', confirmMessage)}</Field></div>
              </>
            ) : null}
            <Button type="submit" variant="primary" disabled={busy} className={styles.wide} busy={busy} busyLabel="進めています…">
              {check?.needsPassword ? 'パスワードを設定して次へ' : '設定して二段階認証へ進む'}<ArrowRight aria-hidden="true" />
            </Button>
          </form>
        )}
      </Card>
      <p className={styles.foot}>この画面は運営メンバーだけが開けます。操作はすべて記録されます。</p>
    </main>
  )
}
