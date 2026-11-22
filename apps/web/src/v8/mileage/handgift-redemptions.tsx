'use client'

import { useEffect, useRef, useState } from 'react'
import { ApiError, fetchApi } from '@/lib/api'
import { withHonorific } from '@line-crm/shared'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { canAdministerRole, useStaffRole } from '@/lib/staff-role'
import Button from '@/components/shared/button'
import Card, { CardHeader } from '@/components/shared/card'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import { Field } from '@/components/shared/form-controls'
import ListState from '@/components/shared/list-state'
import Pagination from '@/components/shared/pagination'
import StatusBadge from '@/components/shared/status-badge'
import Notice from '@/components/shared/notice'
import { DataTable, TableHeadRow, Th, Td, Tr } from '@/components/shared/table'
import { TextField } from '@/components/shared/text-field'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'

type Item = { anonymizedAt: string | null; createdAt: string; friendName: string | null; requiredMiles: number; id: string; rewardName: string; rewardNameSnapshot: string | null; rewardKindSnapshot: string | null; beneficiaryFriendId: string | null; status: string }
type Page = { items: Item[]; pagination: { total: number } }
type Target = { item: Item; action: 'deliver' | 'cancel' }

export default function HandgiftRedemptions({ accountId, readonly }: { accountId: string; readonly: boolean }) {
  const saveErrors = useSaveFormErrors()
  const role = useStaffRole()
  const allowed = !readonly && canAdministerRole(role)
  const disabledReason = allowed ? undefined : readonly ? '閲覧のみのため操作できません。' : 'オーナーまたは管理者に依頼してください。'
  const [page, setPage] = useState(1)
  const [loaded, setLoaded] = useState<{ accountId: string; data: Page } | null>(null)
  const [failed, setFailed] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [target, setTarget] = useState<Target | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState('')
  const lock = useRef(false)
  useEffect(() => { setPage(1); setTarget(null); setReason(''); setError(''); saveErrors.reset() }, [accountId, saveErrors])
  useEffect(() => {
    let active = true
    setLoaded(null); setFailed(false)
    void (async () => {
      const result = await fetchApi<{ success: boolean; data: Page }>(`/api/mileage/redemptions?accountId=${encodeURIComponent(accountId)}&status=all&kind=handgift&limit=100&offset=${(page - 1) * 100}`, { cache: 'no-store' })
      if (!result.success || !Array.isArray(result.data?.items)) throw new Error('load_failed')
      if (active) setLoaded({ accountId, data: result.data })
    })().catch(() => { if (active) setFailed(true) })
    return () => { active = false }
  }, [accountId, page, refresh])
  const data = loaded?.accountId === accountId ? loaded : null
  const items = data?.data.items ?? []
  const submit = async () => {
    if (!target || !allowed || lock.current || !data || target.item.anonymizedAt) return
    if (target.action === 'cancel' && target.item.status === 'succeeded' && !reason.trim()) { setError('取り消す理由を入力してください'); return }
    lock.current = true; setBusy(true); setError(''); setPending(''); saveErrors.reset()
    try {
      const endpoint = target.action === 'deliver' ? 'hand-delivery' : 'hand-cancel'
      const body = target.action === 'deliver' ? { accountId } : { accountId, expectedStatus: target.item.status, reason: reason.trim() }
      const result = await fetchApi<{ success: boolean; error?: string }>(`/api/mileage/redemptions/${encodeURIComponent(target.item.id)}/${endpoint}`, { method: 'POST', body: JSON.stringify(body) })
      if (!result.success && target.action === 'cancel') { setPending(result.error || '取消は確定しました。マイルを戻す処理を続けています。'); return }
      if (!result.success) throw new Error(result.error || '操作を完了できませんでした')
      setTarget(null); setReason(''); setRefresh(n => n + 1)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) { setTarget(null); setReason(''); setNotice('状態が変わったため、最新の一覧を表示しました。'); setRefresh(n => n + 1) }
      else if (!saveErrors.capture(err)) setError(describeApiFailure(err, '操作'))
    }
    finally { lock.current = false; setBusy(false) }
  }
  if (failed) return <ListState kind="error" title="交換の一覧を読み込めませんでした" onRetry={() => setRefresh(n => n + 1)} />
  if (!data) return <ListState kind="loading" title="交換の一覧を読み込んでいます" />
  return <Card variant="form" aria-label="手渡し景品の交換">
    <CardHeader size="stacked" title="手渡し景品の交換" />
    {notice ? <Notice tone="info">{notice}</Notice> : null}
    {items.length === 0 ? <ListState kind="empty" title="手渡しの交換はありません" /> : <DataTable><thead><TableHeadRow><Th grow>お客さま</Th><Th grow>景品</Th><Th>状態</Th><Th>操作</Th></TableHeadRow></thead><tbody>
      {items.map(item => {
        const name = item.friendName || (!item.anonymizedAt ? '名前未設定' : null)
        const status = item.status === 'reserved' ? '手渡し待ち' : item.status === 'succeeded' ? '手渡し済み' : item.status === 'cancelled' ? 'データ削除により取消（マイル返却なし）' : item.status === 'refunded' ? '取消済み' : item.status
        return <Tr key={item.id}><Td grow>{name || (item.status === 'cancelled' ? '削除済みのお客さま' : '名前を確認できません')}</Td><Td grow>{item.rewardNameSnapshot || item.rewardName}・{item.requiredMiles}マイル</Td><Td><StatusBadge tone={item.status === 'reserved' ? 'caution' : 'neutral'}>{status}</StatusBadge></Td><Td>{!item.anonymizedAt && item.status === 'reserved' ? <><Button disabled={!allowed} disabledReason={disabledReason} lockedReason={disabledReason} onClick={() => { setError(''); setTarget({ item, action: 'deliver' }) }}>渡した</Button> <Button disabled={!allowed} disabledReason={disabledReason} lockedReason={disabledReason} onClick={() => { setError(''); setTarget({ item, action: 'cancel' }) }}>取り消す</Button></> : null}{!item.anonymizedAt && item.status === 'succeeded' ? <Button disabled={!allowed} disabledReason={disabledReason} lockedReason={disabledReason} onClick={() => { setError(''); setTarget({ item, action: 'cancel' }) }}>渡した記録を取り消す</Button> : null}</Td></Tr>
      })}
    </tbody></DataTable>}
    {data.data.pagination.total > 100 ? <Pagination page={page} pageCount={Math.ceil(data.data.pagination.total / 100)} onPageChange={setPage} ariaLabel="交換のページ送り" /> : null}
    <SaveErrorScope errors={saveErrors}><ConfirmDialog open={target !== null} title={target?.action === 'deliver' ? '景品を渡しましたか？' : '交換を取り消しますか？'} description={target?.action === 'deliver' ? '景品を渡した記録を残します。' : target?.item.status === 'succeeded' ? '景品が戻ったことを確認してください。取り消すとマイルを戻し、渡した記録と取消の記録を残します。' : '取り消すと交換したマイルをお客さまに戻します。'} confirmLabel={target?.action === 'deliver' ? '渡した' : '取り消す'} busy={busy} error={error} onCancel={() => { if (!busy) { setTarget(null); setReason(''); setError(''); saveErrors.reset(); if (pending) { setNotice(pending); setRefresh(n => n + 1) }; setPending('') } }} onConfirm={() => { void submit() }}>
      {pending ? <Notice tone="info">{pending} もう一度押すと処理を再開します。</Notice> : null}
      {target ? <p>{target.item.friendName ? withHonorific(target.item.friendName, 'さん', { space: true }) : '名前未設定'}・{target.item.rewardNameSnapshot || target.item.rewardName}・交換番号 {target.item.id.slice(-8)}</p> : null}
      {target?.action === 'cancel' && target.item.status === 'succeeded' ? <Field label="取り消す理由（必須）" htmlFor="handgift-reason"><SaveErrorField names={["reason", "cancellation_reason", "cancellationReason"]}><TextField id="handgift-reason" value={reason} onChange={event => setReason(event.target.value)} maxLength={500} /></SaveErrorField></Field> : null}
    </ConfirmDialog></SaveErrorScope>
  </Card>
}
