'use client'

import { describeApiFailure } from '@/components/shared/api-error-message'
import React, { useCallback, useState } from 'react'
import { api, ApiError, type StepUpPurpose } from '@/lib/api'
import { readSessionSnapshot } from '@/lib/session-snapshot'
import StepUpDialog from '@/components/shared/step-up-dialog'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'

export type StepUpRequest = {
  purpose: StepUpPurpose
  /** 運用者の言葉で操作名。例: 'LINEアカウントを停止する' */
  action: string
  /** grant を受け取って本操作をやり直す関数 */
  retry: (token: string) => Promise<void>
}

/** STEP_UP_REQUIRED で止まったか。401/428 両方でこの code が来る。 */
export function isStepUpRequired(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'STEP_UP_REQUIRED'
}

/*
 * R503: 入力上限（429）は回数制限と待ち時間の案内にする。
 * サーバーは待ち秒数を data.retryAfterSeconds と Retry-After で返す。
 * 無ければ本文（429も表示対象）か汎用文へ落とす。内部情報は出さない。
 */
export function stepUpFailureMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 429) {
    const data = error.data as { retryAfterSeconds?: unknown } | null | undefined
    const seconds = typeof data?.retryAfterSeconds === 'number' && data.retryAfterSeconds > 0
      ? Math.ceil(data.retryAfterSeconds)
      : null
    if (seconds !== null) {
      const minutes = Math.max(1, Math.ceil(seconds / 60))
      return `入力回数の上限に達しました。約${minutes}分待ってからやり直してください。正しい内容でも待ち時間中は通りません。`
    }
  }
  return describeApiFailure(error, '読み込み')
}

type PendingStepUp = { purpose: StepUpPurpose; action: string; resolve: (token: string | null) => void }

/**
 * onSave のような「async関数の途中で待つ」画面向けの窓。
 *
 * `gate` が呼ばれると V-1 ダイアログを開き、本人確認が済むか窓を閉じるまで
 * Promise で待つ。戻り値は発行された grant token（閉じられたら null）。
 * フォームシェルが onSave を呼ぶ形でも、その場で待ってやり直せる。
 */
export function useStepUpGate({ showActionInTitle = false, fullWidthPassword = false }: { showActionInTitle?: boolean; fullWidthPassword?: boolean } = {}): {
  gate: (purpose: StepUpPurpose, action: string) => Promise<string | null>
  prompt: React.ReactNode
  /**
   * 開いている本人確認の窓を外から閉じる(d23b R420)。待っている gate は
   * null で返り、待っていた保存処理は「確認されなかった」として進む。
   * アカウント切り替えのように、開いた時点の前提が崩れたときに使う。
   */
  cancel: () => void
} {
  const [pending, setPending] = useState<PendingStepUp | null>(null)
  const gate = (purpose: StepUpPurpose, action: string) =>
    new Promise<string | null>((resolve) => setPending({ purpose, action, resolve }))
  const cancel = useCallback(() => {
    setPending((current) => {
      current?.resolve(null)
      return null
    })
  }, [])
  const prompt = pending ? (
    <StepUpPrompt
      showActionInTitle={showActionInTitle}
      fullWidthPassword={fullWidthPassword}
      request={{
        purpose: pending.purpose,
        action: pending.action,
        retry: async (token) => { pending.resolve(token) },
      }}
      onDone={() => setPending(null)}
      onClose={() => { pending.resolve(null); setPending(null) }}
    />
  ) : null
  return { gate, prompt, cancel }
}

/**
 * V-1: 大事な操作の前に立てる再確認の窓（共通部品）。
 *
 * 聞き方はセッションが持つ本人の設定（2段階認証なら6桁、無ければパスワード）
 * で決まる。設定がどちらも無い人には案内だけを出す。
 */
export default function StepUpPrompt({
  request,
  showActionInTitle = false,
  fullWidthPassword = false,
  onDone,
  onClose,
}: {
  request: StepUpRequest
  showActionInTitle?: boolean
  fullWidthPassword?: boolean
  onDone: () => void
  onClose: () => void
}) {
  const saveErrors = useSaveFormErrors()

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const method = readSessionSnapshot()?.stepUpMethod ?? 'totp'
  const submit = async (value: string) => {
    // 確認の方法が無い人（2段階認証もパスワードも未設定）は送らない。案内だけ出す。
    if (busy || method === 'none') return
    setBusy(true)
    setError('')
    try {
      const res = await api.auth.stepUp({ method, value, purpose: request.purpose })
      if (!res.success) throw new Error(res.error)
      await request.retry(res.data.token)
      onDone()
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure) setError(stepUpFailureMessage(caught)) }
    } finally {
      setBusy(false)
    }
  }
  return (
    <SaveErrorScope errors={saveErrors}><StepUpDialog
      open
      action={request.action}
      showActionInTitle={showActionInTitle}
      fullWidthPassword={fullWidthPassword}
      presentation={request.purpose === 'auth.mfa.policy' ? 'mfa-off' : undefined}
      method={method}
      busy={busy}
      error={method === 'none' ? undefined : error}
      onSubmit={(value) => void submit(value)}
      onCancel={onClose}
    /></SaveErrorScope>
  )
}
