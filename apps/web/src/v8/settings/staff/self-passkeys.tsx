'use client'

import { startRegistration } from '@simplewebauthn/browser'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiResponse } from '@line-crm/shared'
import { fetchApi, describeSaveFailure } from '@/lib/api'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { useStepUpGate } from '@/components/step-up-prompt'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { useStaffIdentity } from '@/lib/staff-role'
import styles from './staff.module.css'

type Passkey = { id: string; createdAt: string; lastUsedAt: string | null }
type Options = Parameters<typeof startRegistration>[0]['optionsJSON']
const registeredDate = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' })

export default function SelfPasskeys({ enabled }: { enabled: boolean | null }) {
  const [keys, setKeys] = useState<Passkey[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const loaded = loadState === 'ready'
  const loadSeq = useRef(0)
  const [keyToRemove, setKeyToRemove] = useState<(Passkey & { displayIndex: number }) | null>(null)
  const deleteTicket = useRef<object | null>(null)
  const renderedDeleteTicket = deleteTicket.current
  const deleteLock = useRef(false)
  const identity = useStaffIdentity()
  const identityId = identity?.id ?? null
  const currentIdentity = useRef(identityId)
  if (currentIdentity.current !== identityId) { deleteTicket.current = null; currentIdentity.current = identityId }
  useEffect(() => { setKeyToRemove(null) }, [identityId])
  const stepUp = useStepUpGate()
  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    setLoadState('loading')
    setError('')
    try {
      const res = await fetchApi<ApiResponse<Passkey[]>>('/api/auth/passkeys/self', { cache: 'no-store' })
      if (seq !== loadSeq.current) return
      if (!res.success || !Array.isArray(res.data)) throw new Error(res.success ? 'パスキー一覧を読み込めませんでした' : res.error)
      setKeys(res.data)
      setLoadState('ready')
    } catch (caught) {
      if (seq !== loadSeq.current) return
      setLoadState('error')
      setError(describeApiFailure(caught, 'パスキー一覧の読み込み'))
    }
  }, [])
  useEffect(() => {
    void load()
    return () => { loadSeq.current += 1 }
  }, [load])

  const register = async () => {
    if (busy) return
    setBusy(true); setError(''); setMessage('')
    try {
      if (typeof PublicKeyCredential === 'undefined') throw new Error('このブラウザはパスキーに対応していません')
      const grant = await stepUp.gate('auth.passkey.register', 'パスキーを登録する')
      if (!grant) return
      const begin = await fetchApi<ApiResponse<{ options: Options; challengeToken: string }>>('/api/auth/passkeys/register/options', { method: 'POST', body: '{}' })
      if (!begin.success) throw new Error(begin.error)
      const response = await startRegistration({ optionsJSON: begin.data.options })
      const finish = await fetchApi<ApiResponse<{ id: string }>>('/api/auth/passkeys/register/verify', {
        method: 'POST', headers: { 'X-Step-Up-Token': grant }, body: JSON.stringify({ challengeToken: begin.data.challengeToken, response }),
      })
      if (!finish.success) throw new Error(finish.error)
      setMessage('パスキーを登録しました。')
      await load()
    } catch (caught) {
      if (caught instanceof Error && caught.name === 'NotAllowedError') return
      setError(describeSaveFailure(caught))
    } finally { setBusy(false) }
  }

  const remove = async () => {
    const key = keyToRemove
    if (!key || busy || deleteLock.current || !renderedDeleteTicket || renderedDeleteTicket !== deleteTicket.current || identityId !== currentIdentity.current) return
    deleteLock.current = true
    setBusy(true); setError(''); setMessage('')
    try {
      const grant = await stepUp.gate('auth.passkey.remove', 'パスキーを削除する')
      if (!grant || renderedDeleteTicket !== deleteTicket.current || identityId !== currentIdentity.current) return
      const res = await fetchApi<ApiResponse<unknown>>('/api/auth/passkeys/self', {
        method: 'DELETE', headers: { 'X-Step-Up-Token': grant }, body: JSON.stringify({ id: key.id }),
      })
      if (!res.success) throw new Error(res.error)
      if (renderedDeleteTicket !== deleteTicket.current || identityId !== currentIdentity.current) return
      deleteTicket.current = null
      setMessage('パスキーを削除しました。')
      setKeyToRemove(null)
      await load()
    } catch (caught) { if (renderedDeleteTicket === deleteTicket.current && identityId === currentIdentity.current) setError(describeSaveFailure(caught)) }
    finally { deleteLock.current = false; setBusy(false) }
  }

  return <>
    <section className={styles.passkeyBlock} aria-label="パスキー">
      {error ? <Notice tone="danger" message={error} action={loadState === 'error' ? <Button size="compact" onClick={() => void load()}>もう一度読み込む</Button> : undefined} /> : null}
      {message ? <Notice tone="info" message={message} /> : null}
      <p className={styles.securityState}>パスキー　{loaded ? keys.length ? `登録済み ${keys.length}件` : '未登録' : loadState === 'error' ? '確認できませんでした' : '確認中'}</p>
      {loaded && keys.length ? <div className={styles.passkeyList}>{keys.map((key, index) => <div key={key.id} className={styles.passkeyItem}>
        <div><strong>パスキー {index + 1}</strong><span>{registeredDate.format(new Date(key.createdAt))} 登録</span></div>
        <Button variant="text" textTone="danger" size="compact" disabled={busy} onClick={() => { deleteTicket.current = {}; setKeyToRemove({ ...key, displayIndex: index + 1 }) }}>削除</Button>
      </div>)}</div> : null}
      <Button variant="primary" fullWidth disabled={busy || !enabled || !loaded || keys.length >= 10} onClick={() => void register()} busy={busy} busyLabel="確認しています…">パスキーを追加</Button>
      {enabled === false ? <p className={styles.securityHint}>追加するには認証アプリの登録が必要です。</p> : null}
    </section>
    <ConfirmDialog open={keyToRemove !== null} title="パスキーを削除しますか？" deleteName={keyToRemove ? `パスキー ${keyToRemove.displayIndex}` : undefined} description="選んだパスキーは次回から使えなくなります。認証アプリは引き続き使えます。" destructive busy={busy} error={error} onConfirm={() => void remove()} onCancel={() => { if (!busy && !deleteLock.current) { deleteTicket.current = null; setKeyToRemove(null) } }}><OperationTargetSummary accounts={[]} externalTarget={{ label: '担当者', name: identity?.name }} /></ConfirmDialog>
    {stepUp.prompt}
  </>
}
