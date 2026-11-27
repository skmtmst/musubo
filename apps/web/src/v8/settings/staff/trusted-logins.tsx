'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiResponse } from '@line-crm/shared'
import { fetchApi } from '@/lib/api'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import Notice from '@/components/shared/notice'
import { formatDate } from '@/lib/format'
import { SESSION_SNAPSHOT_CHANGED } from '@/lib/session-snapshot'

type TrustedLogin = { id: string; ipPrefix: string; confirmedAt: string; expiresAt: string; current: boolean }

export default function TrustedLogins() {
  const requestId = useRef(0)
  const [rows, setRows] = useState<TrustedLogin[] | null>(null)
  const [target, setTarget] = useState<TrustedLogin | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [dialogError, setDialogError] = useState('')
  const load = useCallback(async () => {
    const request = ++requestId.current
    setLoading(true); setError('')
    try {
      const response = await fetchApi<ApiResponse<TrustedLogin[]>>('/api/auth/trusted-logins', { cache: 'no-store' })
      if (!response.success) throw new Error(response.error)
      if (request === requestId.current) { setRows(response.data); setError('') }
    } catch { if (request === requestId.current) setError('信頼済みの端末を読み込めませんでした') }
    finally { if (request === requestId.current) setLoading(false) }
  }, [])
  useEffect(() => {
    void load()
    const refresh = () => { void load() }
    window.addEventListener(SESSION_SNAPSHOT_CHANGED, refresh)
    window.addEventListener('lh-trusted-logins-changed', refresh)
    return () => { requestId.current++; window.removeEventListener(SESSION_SNAPSHOT_CHANGED, refresh); window.removeEventListener('lh-trusted-logins-changed', refresh) }
  }, [load])
  const remove = async () => {
    if (!target || busy) return
    setBusy(true); setDialogError('')
    try {
      const response = await fetchApi<ApiResponse<null>>(`/api/auth/trusted-logins/${encodeURIComponent(target.id)}`, { method: 'DELETE' })
      if (!response.success) throw new Error(response.error)
      setTarget(null); await load()
    } catch { setDialogError('信頼を外せませんでした。最新の一覧を確認してください'); await load() }
    finally { setBusy(false) }
  }
  return <section aria-label="信頼済みの端末" className="mt-4">
    <h3 className="text-sm font-bold text-ink">信頼済みの端末</h3>
    <p className="mt-1 text-xs text-ink-secondary">本人確認した端末と接続元です。信頼は確認から90日で切れます。</p>
    {error && <Notice tone="danger" className="mt-3" message={error} action={<Button variant="secondary" onClick={() => { void load() }}>もう一度読み込む</Button>} />}
    {loading && rows === null ? <p className="mt-3 text-xs text-ink-faint">読み込んでいます…</p> : rows === null ? null : rows.length === 0 ? <p className="mt-3 text-xs text-ink-faint">信頼済みの端末はありません。</p> : <ul className="mt-3 divide-y divide-hairline">
      {rows.map(row => <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div><p className="text-sm font-medium text-ink">接続元：{row.ipPrefix}{row.current ? '（この端末）' : ''}</p><p className="mt-0.5 text-xs text-ink-faint">確認：{formatDate(row.confirmedAt, { style: 'day' })}・期限：{formatDate(row.expiresAt, { style: 'day' })}</p></div>
        <Button variant="secondary" onClick={() => { setDialogError(''); setTarget(row) }}>信頼を外す</Button>
      </li>)}
    </ul>}
    <ConfirmDialog open={!!target} title="この端末の信頼を外しますか？" description="この端末と接続元の信頼済みの記録を削除します。" confirmLabel="信頼を外す" onConfirm={remove} onCancel={() => { setDialogError(''); setTarget(null) }} busy={busy} error={dialogError || undefined} />
  </section>
}
