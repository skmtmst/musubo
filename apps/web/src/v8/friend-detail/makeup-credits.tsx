'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { MakeupCredit } from '@line-crm/shared'
import Button from '@/components/shared/button'
import Card, { CardHeader } from '@/components/shared/card'
import DateField from '@/components/shared/date-field'
import Dialog from '@/components/shared/dialog'
import { Field } from '@/components/shared/form-controls'
import Notice from '@/components/shared/notice'
import { TextArea } from '@/components/shared/text-field'
import { ApiError } from '@/lib/api'
import { bookingMakeupApi } from '@/lib/api/helpers/gap2'
import { canAdministerRole, useStaffRole } from '@/lib/staff-role'
import { formatListTimestamp } from '@/lib/format'

export default function MakeupCredits({ accountId, friendId, canEdit }: { accountId: string | null; friendId: string; canEdit: boolean }) {
  const role = useStaffRole()
  const allowed = canEdit && canAdministerRole(role)
  const [credits, setCredits] = useState<MakeupCredit[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [target, setTarget] = useState<MakeupCredit | null>(null)
  const [date, setDate] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const generation = useRef(0)
  const reload = useCallback(async () => {
    if (!accountId) return
    const current = ++generation.current
    setLoadError(false)
    try {
      const response = await bookingMakeupApi.listByStore(accountId, friendId)
      if (generation.current === current) { setCredits(response.data); setLoadError(false) }
    } catch { if (generation.current === current) { setCredits(null); setLoadError(true) } }
  }, [accountId, friendId])
  useEffect(() => { void reload(); return () => { generation.current++ } }, [reload])
  const timestamp = date ? Date.parse(`${date}T23:59:59+09:00`) : NaN
  const expiresAt = Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : ''
  const valid = target && expiresAt && Date.parse(expiresAt) > Date.parse(target.expires_at) && Date.parse(expiresAt) > Date.now() && reason.trim().length > 0 && reason.trim().length <= 1000
  const extend = async () => {
    if (!allowed || !accountId || !target || !valid || busy || conflict) return
    setBusy(true); setError('')
    try {
      await bookingMakeupApi.extend(accountId, target.id, { expiresAt, reason: reason.trim(), expectedVersion: target.version })
      setTarget(null); await reload()
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409 && cause.code === 'version_conflict') { setConflict(true); setError('') }
      else setError('期限を延ばせませんでした。内容を確認して、もう一度お試しください。')
    } finally { setBusy(false) }
  }
  const refreshConflict = async () => { setTarget(null); setConflict(false); await reload() }
  return <Card variant="form" gap="normal">
    <CardHeader size="stacked" title="振替" />
    {loadError ? <Notice tone="warn" message="振替を読み込めませんでした。" action={<Button onClick={() => void reload()}>もう一度読み込む</Button>} /> : credits === null ? <p role="status">振替を読み込んでいます…</p> : credits.filter(item => item.status === 'open' || item.status === 'expired').length === 0 ? <p>使える振替はありません。</p> : credits.filter(item => item.status === 'open' || item.status === 'expired').map(item => <div key={item.id}>
      <span>期限：{formatListTimestamp(item.expires_at)}{item.status === 'expired' ? '（期限切れ）' : ''}</span>{' '}
      <Button disabled={!allowed} lockedReason={allowed ? undefined : 'オーナー・管理者のみ操作できます'} onClick={() => { setTarget(item); setDate(''); setReason(''); setError(''); setConflict(false) }}>期限を延ばす</Button>
    </div>)}
    <Dialog open={Boolean(target) && !conflict} title="振替の期限を延ばす" description={target ? `現在の期限：${formatListTimestamp(target.expires_at)}` : ''} confirmLabel="期限を延ばす" confirmDisabled={!valid || !allowed} confirmDisabledReason={!valid ? '現在より後の期限と理由を入力してください' : undefined} busy={busy} error={error} onCancel={() => setTarget(null)} onConfirm={() => void extend()}>
      <Field label="新しい期限" required><DateField aria-label="新しい期限" value={date} onChange={setDate} disabled={busy} /></Field>
      <Field label="理由" required><TextArea aria-label="理由" value={reason} onChange={event => setReason(event.target.value)} maxLength={1000} disabled={busy} /></Field>
      <p>オーナー・管理者のみ操作できます。現在の期限より後の日付を指定してください。</p>
    </Dialog>
    <Dialog open={conflict} title="期限が変更されています" description="ほかの担当者が先に期限を延ばしました。最新の情報を確認してから、もう一度操作してください。" confirmLabel="最新の情報を確認" busy={busy} onCancel={() => { setTarget(null); setConflict(false) }} onConfirm={() => void refreshConflict()} />
  </Card>
}
