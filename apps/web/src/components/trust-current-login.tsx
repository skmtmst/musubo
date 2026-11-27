'use client'

import { useState } from 'react'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import { useStepUpGate } from '@/components/step-up-prompt'
import { api } from '@/lib/api'
import { readSessionSnapshot, rememberSessionSnapshot } from '@/lib/session-snapshot'

export default function TrustCurrentLogin({ onSuccess }: { onSuccess?: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const stepUp = useStepUpGate()
  const enabled = readSessionSnapshot()?.stepUpMethod === 'totp'
  const trustLogin = async () => {
    setError('')
    const token = await stepUp.gate('auth.login.trust', '自分のログインとして確認する')
    if (!token) return
    setBusy(true)
    try {
      const result = await api.auth.trustCurrentLogin(token)
      if (!result.success) throw new Error(result.error)
      const fresh = await api.auth.session()
      if (!fresh.success) throw new Error(fresh.error)
      const previous = readSessionSnapshot()
      if (previous) rememberSessionSnapshot({ ...previous, unfamiliarAt: fresh.data.unfamiliarAt ?? null, stepUpMethod: fresh.data.stepUpMethod ?? previous.stepUpMethod })
      onSuccess?.()
    } catch { setError('確認できませんでした。状態を読み直して、もう一度お試しください。') }
    finally { setBusy(false) }
  }
  return <>
    <Button variant="secondary" lockedReason={!enabled ? '二段階認証を設定すると使えます' : undefined} busy={busy} onClick={() => void trustLogin()}>自分のログインです</Button>
    {!enabled && <Button variant="text" href="/staff#self-security">二段階認証を設定する</Button>}
    {error && <Notice tone="danger" message={error} />}
    {stepUp.prompt}
  </>
}
