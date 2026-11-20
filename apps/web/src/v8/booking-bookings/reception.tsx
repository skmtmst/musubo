'use client'

import { useEffect, useState } from 'react'
import { bookingApi, type BookingRequest } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { jstDate } from '@/lib/jst-datetime'
import Card, { CardHeader } from '@/components/shared/card'
import ListState from '@/components/shared/list-state'
import Pagination from '@/components/shared/pagination'
import SegmentedControl from '@/components/shared/segmented'
import StatusBadge from '@/components/shared/status-badge'
import { DataTable, TableHeadRow, Th, Td, Tr, RowNameButton } from '@/components/shared/table'
import { formatDay, formatTime } from '@/lib/format'

type Filter = 'all' | 'requested'
type Page = { account: string; requests: BookingRequest[]; total: number; requestedCount: number }
type Result = { requests: BookingRequest[]; total: number }
const PAGE_SIZE = 20
function valid(result: Result): Result {
  if (!Array.isArray(result.requests) || !Number.isFinite(result.total) || result.total < 0) throw new Error('load_failed')
  return result
}
export default function BookingReception({ onOpen, refreshKey }: { onOpen: (id: string) => void; refreshKey?: string }) {
  const { selectedAccountId } = useAccount()
  const [filter, setFilter] = useState<Filter>('all')
  const [page, setPage] = useState(1)
  const [state, setState] = useState<Page | null>(null)
  const [error, setError] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => { setPage(1); setFilter('all') }, [selectedAccountId])
  useEffect(() => {
    if (!selectedAccountId) return
    const account = selectedAccountId
    let active = true
    setState(null); setError(false)
    const from = new Date(`${jstDate()}T00:00:00+09:00`).toISOString()
    const get = async (status: 'requested' | 'confirmed', limit: number, offset: number) => valid(await bookingApi.listRequests(account, status, { limit, offset, from }))
    void (async () => {
      const start = (page - 1) * PAGE_SIZE
      if (filter !== 'all') {
        const requested = await get('requested', PAGE_SIZE, start)
        return { account, requests: requested.requests, total: requested.total, requestedCount: requested.total }
      }
      // まず件数を取得し、ページ境界にかかる分だけを読む。承認待ちを必ず先に並べる。
      const [requestedCount, confirmedCount] = await Promise.all([get('requested', 1, 0), get('confirmed', 1, 0)])
      const requestedLength = Math.max(0, Math.min(PAGE_SIZE, requestedCount.total - start))
      const confirmedLength = PAGE_SIZE - requestedLength
      const [requested, confirmed] = await Promise.all([
        requestedLength ? get('requested', requestedLength, start) : Promise.resolve(null),
        confirmedLength ? get('confirmed', confirmedLength, Math.max(0, start - requestedCount.total)) : Promise.resolve(null),
      ])
      return { account, requests: [...(requested?.requests ?? []), ...(confirmed?.requests ?? [])], total: requestedCount.total + confirmedCount.total, requestedCount: requestedCount.total }
    })().then(result => {
      if (!active) return
      const lastPage = Math.max(1, Math.ceil(result.total / PAGE_SIZE))
      if (page > lastPage) { setPage(lastPage); return }
      setState(result)
    }).catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [selectedAccountId, revision, refreshKey, page, filter])
  if (!selectedAccountId) return null
  if (error) return <ListState kind="error" title="予約受付を読み込めませんでした" onRetry={() => setRevision(n => n + 1)} />
  if (state?.account !== selectedAccountId) return <ListState kind="loading" title="予約受付を読み込んでいます" />
  return <Card variant="form" aria-label="予約受付管理">
    <CardHeader size="stacked" title="予約受付管理" meta={`承認待ち ${state.requestedCount}件（今日以降）`} />
    <SegmentedControl aria-label="予約受付の絞り込み" value={filter} onChange={next => { setPage(1); setFilter(next) }} options={[
      { value: 'all', label: 'すべて' }, { value: 'requested', label: '承認待ち' },
    ]} />
    {state.requests.length ? <DataTable><thead><TableHeadRow><Th grow>予約</Th><Th>日時</Th><Th grow>内容</Th><Th>担当</Th><Th>状態</Th></TableHeadRow></thead><tbody>
      {state.requests.map(row => <Tr key={row.id}><Td grow><RowNameButton onClick={() => onOpen(row.id)}>{row.friend_name || '名前未設定'}</RowNameButton></Td><Td>{formatDay(row.starts_at)} {formatTime(row.starts_at)}</Td><Td grow>{row.menu_name}</Td><Td>{row.staff_name || '担当を確認'}</Td><Td><StatusBadge tone={row.status === 'requested' ? 'caution' : 'neutral'}>{row.status === 'requested' ? '承認待ち' : '予約済み'}</StatusBadge></Td></Tr>)}
    </tbody></DataTable> : <ListState kind="empty" title="今日以降の該当する予約はありません" />}
    {state.total > PAGE_SIZE ? <Pagination page={page} pageCount={Math.ceil(state.total / PAGE_SIZE)} onPageChange={setPage} ariaLabel="予約受付のページ送り" /> : null}
  </Card>
}
