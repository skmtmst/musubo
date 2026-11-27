'use client'
import { twoFactorFailureMessage } from '@/v8/login/two-factor/two-factor-error'
import { requestPasskeyLoginOptions, verifyPasskeyLogin } from '@/lib/passkey-login-transport'
import { responseApiError } from '@/lib/api'
import { useEffect, useState } from 'react'
import { startAuthentication } from '@simplewebauthn/browser'
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser'
import { LogIn } from 'lucide-react'
import {
  adminSessionHandoffPath,
  adminSessionHeaders,
  captureTwoFactorChallenge,
  captureTwoFactorMethod,
  clearTwoFactorChallenge,
  storeAdminSession,
  takeTwoFactorNextPath,
  type TwoFactorMethod,
} from '@/lib/admin-session'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import OtpInput, { otpFailureMessage } from '@/components/shared/otp-input'
import styles from './two-factor-ops.module.css'
import { Field } from '@/components/shared/form-controls'
import Card from '@/components/shared/card'
import TextLink from '@/components/shared/text-link'
import SectionHeader from '@/components/shared/section-header'
import { AuthPage, AuthActions, AuthHelp, AuthSubmit } from '@/components/templates/auth-page'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'


/*
 * ★V8-B 運営 ログイン 2段目（板 「6桁の確認」）。
 *
 * 運営のログイン（/ops/login）でパスワードを確かめたあと、`/login/two-factor?next=ops#lh_2fa=…`
 * で来たときだけ出す。動き（合言葉の受け取り・確認の口・運営権限の確かめ・失敗の文）は
 * 管理画面 の app/login/two-factor/page.tsx と同じ。見た目だけ絵どおりに1枚のカードへまとめた。
 */

/** 6 桁が違った時の 1 行。 */
const WRONG_CODE_MESSAGE = 'コードが違います。今の数字を入れ直してください。'

/* 通信断・JSON でない返事は技術文言を出さない（管理画面 の two-factor-error と同じ決まりを写した）。 */
export function opsTwoFactorFailureMessage(caught: unknown, fallback = '認証できませんでした'): string {
  return twoFactorFailureMessage(caught, fallback)
}

export default function OpsTwoFactorV8({ scope = 'ops' }: { scope?: 'ops' | 'admin' }) {
  const saveErrors = useSaveFormErrors()
  const [typedCode, setCode] = useState('')
  const [succeeded, setSucceeded] = useState(false)
  /** 失敗のたびに6マスを作り直し、1マス目へ戻す。 */
  const [attempt, setAttempt] = useState(0)
  const [challenge, setChallenge] = useState('')
  const [ready, setReady] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [method, setMethod] = useState<TwoFactorMethod>('line')
  const [helpOpen, setHelpOpen] = useState(false)
  const [passkeyMode, setPasskeyMode] = useState<'checking' | 'available' | 'totp' | 'none'>('checking')
  const [hasPasskey, setHasPasskey] = useState(false)

  // 方法の受け取りは合言葉より先に（合言葉の受け取りで hash が消えるため。管理画面 と同じ順）。
  useEffect(() => { setMethod(captureTwoFactorMethod()); setChallenge(captureTwoFactorChallenge()); setReady(true) }, [])

  useEffect(() => {
    if (!challenge) return
    let cancelled = false
    void requestPasskeyLoginOptions(challenge).then(response => response.json()).then((body: { success?: boolean; data?: { available?: boolean } }) => {
      if (cancelled) return
      const available = body.success === true && body.data?.available === true
      setHasPasskey(available)
      setPasskeyMode(available ? 'available' : 'none')
    }).catch(() => { if (!cancelled) setPasskeyMode('none') })
    return () => { cancelled = true }
  }, [challenge])

  const missingChallenge = ready && !challenge

  const finish = (href: string) => {
    setSucceeded(true)
    window.setTimeout(() => window.location.assign(href), 420)
  }

  const completeLogin = async (body: { data?: { sessionToken?: string }; csrfToken?: string }) => {
    if (body.data?.sessionToken) storeAdminSession(body.data.sessionToken, body.csrfToken)
    else if (body.csrfToken) {
      try { localStorage.setItem('lh_csrf', body.csrfToken) } catch (saveFailure) { saveErrors.capture(saveFailure) }
    }
    const nextPath = takeTwoFactorNextPath()
    if (nextPath === '/ops') {
      const session = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/auth/session`, {
        credentials: 'include', headers: adminSessionHeaders(body.data?.sessionToken),
      })
      const sessionBody = await session.json().catch(() => ({})) as { success?: boolean; data?: { platformAdmin?: boolean; platformAdminState?: string | null } }
      if (!session.ok || !sessionBody.success || !sessionBody.data) throw new Error('ログイン状態を確認できませんでした。もう一度ログインしてください')
      if (!sessionBody.data.platformAdmin) {
        if (sessionBody.data.platformAdminState === 'awaiting_totp') {
          clearTwoFactorChallenge()
          finish(adminSessionHandoffPath('/ops/two-factor', body.data?.sessionToken, body.csrfToken))
          return
        }
        throw new Error('このアカウントは運営メンバーとして有効ではありません。招待メールのリンクから登録を完了してください')
      }
    }
    clearTwoFactorChallenge()
    finish(adminSessionHandoffPath(nextPath, body.data?.sessionToken, body.csrfToken))
  }

  const submitPasskey = async () => {
    if (loading || succeeded || !challenge) return
    setLoading(true)
    setError('')
    try {
      const optionsResponse = await requestPasskeyLoginOptions(challenge)
      const optionsBody = await optionsResponse.json() as { success?: boolean; error?: string; data?: { available?: boolean; options?: PublicKeyCredentialRequestOptionsJSON; challengeToken?: string } }
      if (!optionsResponse.ok || !optionsBody.success || !optionsBody.data?.available || !optionsBody.data.options || !optionsBody.data.challengeToken) throw new Error(optionsBody.error || 'パスキーを使用できません。認証アプリで確認してください。')
      const response = await startAuthentication({ optionsJSON: optionsBody.data.options })
      const verifyResponse = await verifyPasskeyLogin({ loginChallengeToken: challenge, challengeToken: optionsBody.data.challengeToken, response })
      const verifyBody = await verifyResponse.json() as { success?: boolean; error?: string; data?: { sessionToken?: string }; csrfToken?: string }
      if (!verifyResponse.ok || !verifyBody.success) throw new Error(verifyBody.error || 'パスキーを確認できませんでした。')
      await completeLogin(verifyBody)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)
      if (!fieldFailure) setError(caught instanceof Error && caught.name === 'NotAllowedError'
        ? 'パスキーの操作を中止しました。もう一度試すか、認証アプリを使用してください。'
        : opsTwoFactorFailureMessage(caught, 'パスキーを確認できませんでした。認証アプリでもログインできます。'))
    } finally { setLoading(false) }
  }

  /* 6桁目が入った瞬間に送る（送るボタンも残す）。送っている間・送り終えた後は二重に送らない。 */
  const submit = async (entered?: string) => {
    const code = entered ?? typedCode
    if (loading || succeeded) return
    if (!challenge) return setError('ログインの情報が見つかりませんでした。ログインからやり直してください。')
    if (code.length !== 6) return setError('6桁の認証コードを入力してください')
    setLoading(true)
    setError('')
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/auth/two-factor/verify`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeToken: challenge, code }),
      })
      const body = await response.json() as { success: boolean; error?: string; data?: { sessionToken?: string }; csrfToken?: string }
      if (!response.ok || !body.success) throw responseApiError(response, JSON.stringify(body), undefined, undefined, { preserveBodyMessage: true, fallbackMessage: '認証できませんでした' })
      await completeLogin(body)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)

      setError(otpFailureMessage(opsTwoFactorFailureMessage(caught), { wrongCode: WRONG_CODE_MESSAGE })) }
      setCode('')
      setAttempt((current) => current + 1)
    } finally { setLoading(false) }
  }

  const isAdmin = scope === 'admin'
  const codeLabel = '認証コード（6桁）'
  const title = isAdmin ? '二段階認証' : '6桁の確認'
  const adminHelp = '認証アプリの 6 桁のコードを入れてください。'
  const backHref = scope === 'ops' ? '/ops/login' : '/login'
  /* 6 マスの下の 1 行：何が起きたかを言う（違った・通った・入れている時の案内）。確かめ中はボタンが言う。 */
  const status = error
    ? { tone: 'danger', text: error }
    : succeeded ? { tone: 'success', text: '確認できました。開いています…' }
    : isAdmin && !missingChallenge ? { tone: 'muted', text: 'コードは約 30 秒ごとに変わります' }
    : null

  /* 6 桁は入れ終わると自動で確かめる。入力不足の間は主ボタンを押せない形にする。 */
  const incomplete = typedCode.length !== 6

  if (passkeyMode === 'available') return (
    <SaveErrorScope errors={saveErrors}><AuthPage layout={scope} title={isAdmin ? '二段階認証' : 'パスキーで確認'} titleId="ops-two-factor-title"
      help={isAdmin ? `${method === 'password' ? 'パスワード' : 'LINEでのログイン'}を確かめました。パスキーで本人確認してください。` : undefined}>
      {scope === 'ops' ? <AuthHelp>{`${method === 'password' ? 'パスワード' : 'LINEでのログイン'}を確かめました。パスキーで本人確認してください。`}</AuthHelp> : null}
      <div className={styles.passkeyNotice}>✓ このアカウントにパスキーが登録されています</div>
      <p className={styles.passkeyDescription}>端末の顔・指紋・画面ロックで本人確認します。</p>
      {error ? <Notice tone="danger" message={error} /> : null}
      <AuthSubmit><Button variant="primary" fullWidth className={styles.submit} onClick={() => void submitPasskey()}
        disabled={loading || succeeded || missingChallenge} busy={loading || succeeded}
        busyLabel={succeeded ? '開いています' : '確かめています…'}>パスキーで認証する</Button></AuthSubmit>
      <p className={styles.passkeyHint}>端末の確認画面が開きます</p>
      <div className={styles.passkeyDivider}><span>または</span></div>
      <Button variant="secondary" fullWidth className={styles.submit} disabled={loading || succeeded}
        onClick={() => { setPasskeyMode('totp'); setError('') }}>認証アプリで確認</Button>
      <div className={styles.helpArea}>
        <p className={styles.passkeyHint}>パスキーが使えない場合は認証アプリへ切り替えられます。</p>
        <TextLink inline href={backHref} onClick={clearTwoFactorChallenge}>別のアカウントで入る</TextLink>
      </div>
    </AuthPage></SaveErrorScope>
  )

  return (
    <SaveErrorScope errors={saveErrors}><AuthPage layout={scope} boardId="tOPeY" title={title} titleId="ops-two-factor-title" help={isAdmin ? adminHelp : undefined}>

        {scope === 'ops' && ready && challenge ? <AuthHelp>{`${method === 'password' ? 'パスワード' : 'LINEでのログイン'}を確かめました。認証アプリに出ている6桁を入れてください。認証アプリが使えないときは、運営のオーナーに連絡してください。`}</AuthHelp> : null}

        {missingChallenge ? (
          <Notice tone="info" id="ops-two-factor-missing" message="ログインの情報が見つかりませんでした。ログインからやり直してください。" action={<Button variant="text" textTone="ink" size="inline" href={backHref} onClick={clearTwoFactorChallenge}>ログインに戻る</Button>} />
        ) : null}
        {isAdmin ? <span id="ops-two-factor-code-label" className="sr-only">{codeLabel}</span> : null}
        <div className={styles.code}>
          <Field density="input" contentGap={12} optional={false} label={isAdmin ? undefined : <span id="ops-two-factor-code-label">{codeLabel}</span>}>
            <SaveErrorField names={["typedCode","code"]} key={attempt}><OtpInput
              length={6}
              value={typedCode} onComplete={entered => void submit(entered)}
              onChange={next => { setCode(next); if (error) setError('') }} labelledBy="ops-two-factor-code-label"
              describedBy={missingChallenge ? 'ops-two-factor-missing' : error ? 'ops-two-factor-error' : undefined}
              invalid={Boolean(error)} success={succeeded} busy={loading} disabled={missingChallenge || succeeded} autoFocus inlineStatus={false}
            /></SaveErrorField>
          </Field>
          {/* 読み上げは 6 マスの「確かめています・確認できました」と、違った時の alert が言う。 */}
          {status ? <p id={status.tone === 'danger' ? 'ops-two-factor-error' : undefined} role={status.tone === 'danger' ? 'alert' : undefined} className={styles.status} data-tone={status.tone}>{status.text}</p> : null}
        </div>
        <AuthSubmit><Button
          variant="primary" fullWidth
          className={styles.submit}
          onClick={() => void submit()}
          disabled={loading || missingChallenge || succeeded || incomplete}
          disabledReason={!missingChallenge && incomplete ? '認証アプリの6桁の数字を入力してください。' : undefined}
          busy={loading || succeeded}
          busyLabel={succeeded ? '開いています' : '確かめています…'}
        >
          {scope === 'ops' ? <LogIn aria-hidden="true" className={styles.icon} /> : null}{scope === 'ops' ? 'ログイン' : '確認してログイン'}
        </Button></AuthSubmit>
        {hasPasskey ? <Button variant="secondary" fullWidth className={styles.submit} disabled={loading || succeeded} onClick={() => { setPasskeyMode('available'); setError('') }}>パスキーを使う</Button> : null}
        {isAdmin ? (
          <div className={styles.helpArea}>
            <div className={styles.footRow}>
              <button type="button" className={styles.helpToggle} aria-expanded={helpOpen} aria-controls="two-factor-help-choices" onClick={() => setHelpOpen(open => !open)}>
                コードが使えない場合
              </button>
              {/* ログインの 1 段目に戻る（合言葉は捨てる）。 */}
              <TextLink inline href={backHref} onClick={clearTwoFactorChallenge}>別のアカウントで入る</TextLink>
            </div>
            {helpOpen ? (
              <div id="two-factor-help-choices" className={styles.helpChoices} role="group" aria-label="コードが使えない場合の選択肢">
                <p>認証アプリが使えない場合は管理者に連絡してください。</p>
                {challenge && method === 'line' ? <TextLink inline href={backHref} onClick={clearTwoFactorChallenge}>別のLINEアカウントでログイン</TextLink> : null}
              </div>
            ) : null}
          </div>
        ) : (
          <Card surface="muted" padding="compact" layout="vertical" gap="normal">
            <SectionHeader title="コードを入力できない場合" />
            <AuthActions><Button variant="text" textTone="ink" size="inline" href={backHref} onClick={clearTwoFactorChallenge}>ログインに戻る</Button>
            </AuthActions>
          </Card>
        )}

    </AuthPage></SaveErrorScope>
  )
}
