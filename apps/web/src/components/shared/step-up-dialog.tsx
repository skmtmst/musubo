'use client'

import React, { useEffect, useId, useState } from 'react'
import { KeyRound } from 'lucide-react'
import Dialog from './dialog'
import OtpInput, { otpFailureMessage } from './otp-input'
import TextLink from './text-link'
import { TextField } from './text-field'

interface StepUpDialogProps {
  /** この操作を見出しでも区別する。 */
  showActionInTitle?: boolean
  /** パスワード入力を窓の幅に合わせる。 */
  fullWidthPassword?: boolean
  presentation?: 'mfa-off'
  open: boolean
  /** 何のための再認証かを運用者の言葉で。例: '権限を変更する' */
  action: string
  /**
   * 再確認の聞き方（V-1）。2段階認証を使っている人は 'totp'（6桁コード）、
   * 使っていない人は 'password'。/api/auth/session の stepUpMethod を渡す。
   * どちらも未設定は 'none'（R502: 入力欄も実行ボタンも出さず案内だけ出す）。
   */
  method?: 'totp' | 'password' | 'none'
  busy?: boolean
  error?: string
  /** 入力が確定したら呼ぶ。親が step-up grant の取得と本操作のやり直しを行う。 */
  onSubmit: (value: string) => void
  onCancel: () => void
}

/**
 * 高危険操作の直前再認証ダイアログ（N-427 → V-1）。
 *
 * 緊急停止・権限変更・LINE接続の変更・配信の承認など、STEP_UP_REQUIRED で
 * 止まった操作の前に立てる。聞くのは本人の設定で決まり、二段階認証があれば
 * 6桁コード、なければパスワード。grant 取得と本操作のやり直しは呼び出し側。
 */
export default function StepUpDialog({ open, action, showActionInTitle = false, fullWidthPassword = false, presentation, method = 'totp', busy = false, error, onSubmit, onCancel }: StepUpDialogProps) {
  const [value, setValue] = useState('')
  const labelId = useId()
  useEffect(() => { if (open) setValue('') }, [open])
  const mfaOff = presentation === 'mfa-off'
  // Owner decision pending: change this one value to change the off action color.
  const offTone: 'default' | 'destructive' = 'default'
  const isTotp = method === 'totp'
  const isNone = method === 'none'
  const PasswordField = fullWidthPassword ? TextField : 'input'
  const ready = !isNone && (isTotp ? /^\d{6}$/.test(value) : value.length > 0)
  // R502: 方法未設定では使えない入力欄・実行ボタンを出さない。案内と設定への導線だけ出す。
  if (isNone) {
    return (
      <Dialog
        open={open}
        title="本人確認の方法が未設定です"
        description={`${action}には本人確認が必要です。先に確認方法を設定してください。`}
        busy={false}
        titleIcon={<KeyRound size={20} />}
        onCancel={onCancel}
        cancelLabel="閉じる"
      >
        <p className="text-sm leading-6 text-ink-secondary">
          認証アプリ（6桁コード）またはパスワードのどちらかを登録すると、この操作へ進めます。
        </p>
        <p className="mt-2 text-sm font-bold">
          <TextLink inline href="/staff">確認方法を設定する</TextLink>
        </p>
      </Dialog>
    )
  }
  return (
    <Dialog
      open={open}
      tone={mfaOff ? offTone : undefined} footerAlign={mfaOff ? 'start' : undefined}
      title={mfaOff ? '二段階認証の必須をオフにしますか' : `${showActionInTitle ? `${action}：` : ''}${isTotp ? '認証アプリで本人確認' : 'パスワードで本人確認'}`}
      description={mfaOff ? 'オフにすると、パスワードやLINEだけで入れるようになります' : isTotp
        ? `${action}には、権限を持つ本人の確認が必要です。この操作専用に、5分以内に1回だけ使える6桁コードを入力してください。`
        : `${action}には、権限を持つ本人の確認が必要です。この操作専用に、5分以内に1回だけ使える確認を発行するため、パスワードを入力してください。`}
      confirmLabel={mfaOff ? 'オフにする' : '本人確認して実行'}
      busy={busy}
      error={error && isTotp ? otpFailureMessage(error) : error}
      titleIcon={mfaOff ? undefined : <KeyRound size={20} />}
      onConfirm={ready ? () => onSubmit(value) : undefined}
      onCancel={onCancel}
    >
      {mfaOff ? <p>{isTotp ? '続けるには、あなたの認証アプリの6桁を入れてください。' : '続けるには、あなたのパスワードを入れてください。'}</p> : null}
      {isTotp ? (
        <>
          <p id={labelId} className="mt-1 block text-sm font-medium text-ink">{mfaOff ? '認証コード（6桁）' : '認証アプリに表示された6桁コード'}</p>
          {/* ★V7 共通 認証コード入力（xHzFK）。6桁目が入った瞬間に確かめる（「本人確認して実行」も残す）。 */}
          <div className="mt-2">
            <OtpInput
              value={value}
              onChange={setValue}
              labelledBy={labelId}
              onComplete={mfaOff ? undefined : (code) => onSubmit(code)}
              invalid={Boolean(error)}
              busy={busy}
              autoFocus
            />
          </div>
        </>
      ) : (
        <>
          <label htmlFor={labelId} className="mt-1 block text-sm font-medium text-ink">パスワード</label>
          <div className={fullWidthPassword ? 'mt-2 w-full' : 'mt-2'}>
            <PasswordField
              id={labelId}
              type="password"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              disabled={busy}
              autoFocus
              autoComplete="current-password"
              aria-invalid={Boolean(error)}
              className={fullWidthPassword ? undefined : 'w-full rounded-control border border-shell-gray bg-canvas px-3 py-2 text-sm text-ink outline-none focus:border-action'}
            />
          </div>
        </>
      )}
      {mfaOff ? <p>自分で登録した人には、オフのあいだも確かめが出ます。オンに戻すのは、いつでもできます。</p> : null}
    </Dialog>
  )
}
