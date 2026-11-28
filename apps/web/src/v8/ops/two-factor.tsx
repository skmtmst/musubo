'use client'
import { Check, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import OpsShell from '@/components/ops/ops-shell'
import { OpsHead } from '@/v8/ops/shell'
import { SelfMfa } from '@/v8/settings/public/staff-self-mfa/index'
import { SelfPasskeys } from '@/v8/settings/public/staff-self-passkeys/index'
import { MfaPolicy } from '@/v8/settings/public/staff-mfa-policy/index'
import Button from '@/components/shared/button'
import ListState from '@/components/shared/list-state'
import NoteBar from '@/components/shared/note-bar'
import Notice from '@/components/shared/notice'
import OtpInput, { otpFailureMessage } from '@/components/shared/otp-input'
import { DelayedSkeleton, Skeleton } from '@/components/shared/skeleton'
import { adminSessionHeaders, captureAdminSessionHandoff } from '@/lib/admin-session'
import { rememberSessionSnapshot } from '@/lib/session-snapshot'
import { api } from '@/lib/api'
import { logoutAndGoToLogin } from '@/lib/logout'
import { qrToDataURL } from '@/lib/qr-image'
import { opsCall } from '@/components/ops/ops-ui'
import MusuboLogo from '@/components/shared/musubo-logo'
import styles from './auth.module.css'
import { emptyValue } from '@/components/shared/empty-value'
import Card from '@/components/shared/card'
import { PageHeading } from '@/components/templates/page-frame'
import { useSaveFormErrors, SaveErrorScope } from '@/components/shared/save-form-errors'
import { isForbiddenOrRateLimited } from '@/components/shared/api-error-message'

type Session = { id: string; name: string; platformAdmin?: boolean; platformAdminState?: string | null; stepUpMethod?: string }

/**
 * 運営コンソールの 二段階認証の設定 V8。
 *
 * 動きは 管理画面（app/ops/two-factor）と同じ。招待を受けた人（awaiting_totp）と、
 * 登録済みで未設定の運営メンバーだけが開ける。確認が通るとサーバーが
 * ログインを解除するので、ログインし直しを案内する。
 */
export default function OpsTwoFactorV8() {
  const saveErrors = useSaveFormErrors()
  const [session, setSession] = useState<Session | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'done' | 'denied' | 'security'>('loading')
  const [uri, setUri] = useState('')
  const [manualKey, setManualKey] = useState('')
  const [qr, setQr] = useState('')
  const [typedCode, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [setupError, setSetupError] = useState<unknown>(null)
  const [qrFailed, setQrFailed] = useState(false)
  const [qrAttempt, setQrAttempt] = useState(0)
  const cancelledRef = useRef(false)

  const load = useCallback(async () => {
    setError('')
    setSetupError(null)
    setQrFailed(false)
    setState('loading')
    const apiUrl = process.env.NEXT_PUBLIC_API_URL
    try {
      const handoffToken = captureAdminSessionHandoff()
      const res = await fetch(`${apiUrl}/api/auth/session`, { credentials: 'include', headers: adminSessionHeaders(handoffToken) })
      if (!res.ok) throw new Error('unauthenticated')
      const body = await res.json() as { success?: boolean; data?: Session; csrfToken?: string }
      if (!body.success || !body.data) throw new Error('unauthenticated')
      if (body.csrfToken) localStorage.setItem('lh_csrf', body.csrfToken)
      if (cancelledRef.current) return
      if (!body.data.platformAdmin && body.data.platformAdminState !== 'awaiting_totp') { setState('denied'); return }
      setSession(body.data)
      if (body.data.platformAdmin && body.data.stepUpMethod === 'totp') {
        rememberSessionSnapshot({ impersonation: null, unfamiliarAt: null, stepUpMethod: 'totp' })
        setState('security'); return
      }
      // QR の準備の失敗はログイン切れではない。ログイン中のまま理由と取り直しを出す。
      let setup: Awaited<ReturnType<typeof api.staff.beginTwoFactorSetup>> | null = null
      let caughtSetupError: unknown = null
      try {
        setup = await api.staff.beginTwoFactorSetup(body.data.id)
      } catch (saveFailure) {
        saveErrors.capture(saveFailure)
        caughtSetupError = saveFailure
        setup = null
      }
      if (cancelledRef.current)
 return
      if (!setup || !setup.success) {
        const fallbackMessage = !setup || typeof setup.error !== 'string' || !setup.error ? 'QRコードを用意できませんでした。時間をおいて、もう一度お試しください。' : setup.error
        setSetupError(caughtSetupError ?? new Error(fallbackMessage))
        setError(fallbackMessage)
        setState('ready')
        return
      }
      setUri(setup.data.provisioningUri)
      setManualKey(setup.data.manualKey)
      setState('ready')
    } catch (saveFailure) {
      saveErrors.capture(saveFailure);

      if (!cancelledRef.current) window.location.assign('/ops/login')
    }
  }, [saveErrors])

  useEffect(() => {
    cancelledRef.current = false
    void load();

    return () => { cancelledRef.current = true }
  }, [load])

  useEffect(() => {
    if (!uri) return
    let cancelled = false
    setQr('')
    setQrFailed(false)
    void qrToDataURL(uri, { width: 200, margin: 1 })
      .then((data) => { if (!cancelled) setQr(data) })
      .catch(() => { if (!cancelled) setQrFailed(true) })
    return () => { cancelled = true }
  }, [uri, qrAttempt])

  const digits = typedCode.replace(/\D/g, '')
  const codeComplete = digits.length === 6

  /* 6桁目が入った瞬間にも送る（entered）。送っている間は二重に送らない。 */
  const submit = async (event?: FormEvent, entered?: string) => {
    event?.preventDefault()
    if (busy) return
    const code = entered ?? typedCode
    if (!session) return
    const digits = code.replace(/\D/g, '')
    if (digits.length !== 6) { setError('6桁の数字を入力してください'); return }
    setBusy(true)
    setError('')
    const res = await opsCall(api.staff.confirmTwoFactorSetup(session.id, digits))
    setBusy(false)
    if (!res.success) { setError(otpFailureMessage(res.error || '認証コードが正しくありません')); return }
    setState('done')
  }

  if (state === 'security') return <OpsShell><OpsHead title="二段階認証" description="管理画面へ入る時の確かめ方を決めます" /><MfaPolicy loginPath="/ops/login" /><SelfPasskeys enabled /><SelfMfa loginPath="/ops/login" /></OpsShell>

  return (
    <SaveErrorScope errors={saveErrors}><main className={styles.page} data-design-node="qod6X">
      <div className={styles.brand}>
        <MusuboLogo size="ops" />
        <span className={styles.brandSub}>運営コンソール</span>
      </div>
      <Card variant="form" className={styles.card} aria-labelledby="ops-totp-title">
        <PageHeading inset="none" title="二段階認証を設定" titleId="ops-totp-title" titleAs="h1" subtitleSize="body" help={<> 認証アプリ（Google Authenticator など）で QR を読み取り、表示された6桁を入れます。</>} subtitle={<> 認証アプリ（Google Authenticator など）で QR を読み取り、表示された6桁を入れます。</>} />

        {session?.platformAdmin ? <MfaPolicy loginPath="/ops/login" /> : null}
        {state === 'loading' ? (
          <ListState permissionScope="hq" kind="loading" title="準備しています" />
        ) : state === 'denied' ? (
          <>
            <ListState permissionScope="hq" kind="forbidden" title="この画面は運営メンバーだけが開けます" description="招待メールのリンクから進んでください。" />
            <Button fullWidth href="/ops/login" className={styles.wide}>運営のログインへ</Button>
          </>
        ) : state === 'done' ? (
          <>
            <NoteBar tone="info">二段階認証を登録しました。安全のため一度ログアウトしています。メールとパスワード、次に6桁の数字でログインし直してください。</NoteBar>
            <Button fullWidth variant="primary" onClick={() => logoutAndGoToLogin('/ops/login')} className={styles.wide}>運営のログインへ</Button>
          </>
        ) : !uri && setupError !== null ? (
          /* QR準備の失敗時は原因（403/429/5xx）を言い分け、ListState の「もう一度読み込む」から取り直す。 */
          <ListState
            permissionScope="hq"
            kind="error"
            title={isForbiddenOrRateLimited(setupError) ? undefined : 'QRコードを用意できませんでした'}
            description={isForbiddenOrRateLimited(setupError) ? undefined : (error || '時間をおいて、もう一度お試しください。')}
            error={setupError}
            onRetry={() => void load()}
          />
        ) : (
          <form onSubmit={(event) => void submit(event)} noValidate className={styles.form}>
            {error ? <Notice tone="danger" message={error} /> : null}
            <div className={styles.qrRow}>
              <div className={styles.qr}>
                {qr ? (
                  // eslint-disable-next-line @next/next/no-img-element -- 手元で描いた data: URL の QR。最適化の対象ではない
                  <img width={200} height={200} src={qr} alt="認証アプリ登録用のQRコード" />
                ) : qrFailed ? (
                  <Notice tone="danger" >QRコードを表示できませんでした</Notice>
                ) : (
                  <DelayedSkeleton loading skeleton={<Skeleton className="block h-full w-full" />} />
                )}
              </div>
              <div className={styles.qrSide}>
                <p className={styles.qrHint}>読み取れないときは、このキーを手で入力</p>
                <p className={styles.secret}>{manualKey || emptyValue('unknown')}</p>
                <Button onClick={() => setQrAttempt((n) => n + 1)} disabled={!uri}>
                  <RefreshCw aria-hidden="true" />QRをもう一度表示する
                </Button>
              </div>
            </div>
            <div className={styles.field}>
              <span id="ops-totp-label" className={styles.label}>認証コード（6桁）</span>
              <OtpInput id="ops-totp-code" value={typedCode} onChange={setCode} onComplete={(entered) => void submit(undefined, entered)} labelledBy="ops-totp-label" invalid={Boolean(error)} busy={busy} />
            </div>
            <Button fullWidth type="submit" variant="primary" disabled={busy || !uri || !codeComplete} className={styles.wide} busy={busy} busyLabel="確認しています…">
              <Check aria-hidden="true" />登録する
            </Button>
            <p className={styles.note}>登録すると安全のため一度ログアウトします。メールとパスワード、次に6桁の数字でログインし直してください。</p>
          </form>
        )}
      </Card>
      <p className={styles.foot}>この画面は運営メンバーだけが開けます。操作はすべて記録されます。</p>
    </main></SaveErrorScope>
  )
}
