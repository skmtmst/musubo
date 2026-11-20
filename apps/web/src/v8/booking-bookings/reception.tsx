'use client'

import { useEffect, useState } from 'react'
import { bookingApi, type BookingRequest } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { jstDate } from '@/lib/jst-datetime'
import Card, { CardHeader } from '@/components/shared/card'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import Pagination from '@/components/shared/pagination'
import { DEFAULT_PAGE_SIZE as PAGE_SIZE } from '@/components/shared/page-size-options'
import SegmentedControl from '@/components/shared/segmented'
import StatusBadge from '@/components/shared/status-badge'
import { DataTable, TableHeadRow, Th, Td, Tr, RowNameButton } from '@/components/shared/table'
import { formatDay, formatTime } from '@/lib/format'

type Filter = 'all' | 'requested' | 'unassigned' | 'attention'
type Page = { account: string; requests: BookingRequest[]; total: number; requestedCount: number; unassignedCount: number; attentionCount: number; unknownCount: number }
export default function BookingReception({ onOpen, refreshKey, canOperate = false }: { onOpen: (id: string) => void; refreshKey?: string; canOperate?: boolean }) {
  const { selectedAccountId } = useAccount()
  const [filter, setFilter] = useState<Filter>('all')
  const [page, setPage] = useState(1)
  const [state, setState] = useState<Page | null>(null)
  const [error, setError] = useState(false)
  const [actionError, setActionError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [target, setTarget] = useState<BookingRequest | null>(null)
  const [revision, setRevision] = useState(0)
  useEffect(() => { setPage(1); setFilter('all'); setActionError(''); setTarget(null) }, [selectedAccountId])
  useEffect(() => {
    if (!selectedAccountId) return
    const account = selectedAccountId
    let active = true
    setState(null); setError(false)
    const from = new Date(`${jstDate()}T00:00:00+09:00`).toISOString()
    void bookingApi.listRequests(account, 'all', { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, from, reception: filter }).then(result => {
      if (!active) return
      if (!Array.isArray(result.requests) || [result.total, result.requestedCount, result.unassignedCount, result.attentionCount, result.unknownCount].some(n => !Number.isFinite(n) || n < 0)) throw new Error('load_failed')
      const lastPage = Math.max(1, Math.ceil(result.total / PAGE_SIZE))
      if (page > lastPage) { setPage(lastPage); return }
      setState({ ...result, account })
    }).catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [selectedAccountId, revision, refreshKey, page, filter])
  const review = async (row: BookingRequest) => {
    if (!selectedAccountId || busy) return
    setBusy(row.id); setActionError('')
    try { await bookingApi.reviewAssignment(selectedAccountId, row.id, row.lock_version) }
    catch { setActionError('担当を確認できませんでした。最新の予約を確認してください。') }
    finally { setBusy(null); setTarget(null); setRevision(n => n + 1) }
  }
  if (!selectedAccountId) return null
  if (error) return <ListState kind="error" title="予約受付を読み込めませんでした" onRetry={() => setRevision(n => n + 1)} />
  if (state?.account !== selectedAccountId) return <ListState kind="loading" title="予約受付を読み込んでいます" />
  return <Card variant="form" aria-label="予約受付管理">
    <CardHeader size="stacked" title="予約受付管理" meta={`要対応 ${state.unknownCount && !state.attentionCount ? '確認できません' : `${state.attentionCount}件${state.unknownCount ? '以上' : ''}`}・未割り当て ${state.unknownCount && !state.unassignedCount ? '確認できません' : `${state.unassignedCount}件${state.unknownCount ? '以上' : ''}`}・承認待ち ${state.requestedCount}件（今日以降）`} />
    <Notice tone="info" compact>担当の記録前の予約は未割り当ての件数に含まれません</Notice>
    {actionError ? <Notice tone="danger" role="alert">{actionError}</Notice> : null}
    <SegmentedControl aria-label="予約受付の絞り込み" value={filter} onChange={next => { setPage(1); setFilter(next) }} options={[
      { value: 'all', label: 'すべて' }, { value: 'unassigned', label: '未割り当て' }, { value: 'requested', label: '承認待ち' }, { value: 'attention', label: '要対応' },
    ]} />
    {state.requests.length ? <DataTable><thead><TableHeadRow><Th grow>予約</Th><Th>日時</Th><Th grow>内容</Th><Th>担当</Th><Th>状態</Th><Th>操作</Th></TableHeadRow></thead><tbody>
      {state.requests.map(row => { const pending = row.assignment_method === 'automatic' && !row.assignment_reviewed_at; return <Tr key={row.id}><Td grow><RowNameButton onClick={() => onOpen(row.id)}>{row.friend_name || '名前未設定'}</RowNameButton></Td><Td>{formatDay(row.starts_at)} {formatTime(row.starts_at)}</Td><Td grow>{row.menu_name}</Td><Td>{row.staff_name || '担当を確認'}</Td><Td><StatusBadge tone={pending || row.status === 'requested' ? 'caution' : 'neutral'}>{row.status === 'requested' ? '承認待ち' : pending ? '担当を確認' : '予約済み'}</StatusBadge></Td><Td>{pending && canOperate ? <Button variant="text" size="compact" busy={busy === row.id} disabled={!!busy} onClick={() => setTarget(row)}>担当を確認</Button> : null}</Td></Tr> })}
    </tbody></DataTable> : <ListState kind="empty" title={state.unknownCount && (filter === 'unassigned' || filter === 'attention') ? '担当の記録前の予約があるため、すべては確認できません' : '今日以降の該当する予約はありません'} />}
    <ConfirmDialog open={target !== null} title="担当を確認しましたか？" description={`${target?.staff_name || '担当者'}さんが担当する予約として確認します。`} confirmLabel="確認した" busy={!!busy} onCancel={() => { if (!busy) setTarget(null) }} onConfirm={() => { if (target) void review(target) }} />
    {state.total > PAGE_SIZE ? <Pagination page={page} pageCount={Math.ceil(state.total / PAGE_SIZE)} onPageChange={setPage} ariaLabel="予約受付のページ送り" /> : null}
  </Card>
}
