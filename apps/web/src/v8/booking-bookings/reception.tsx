'use client'

import { useEffect, useState } from 'react'
import { bookingApi, type BookingRequest } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { jstDate } from '@/lib/jst-datetime'
import Card, { CardHeader } from '@/components/shared/card'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import Pagination from '@/components/shared/pagination'
import StatusBadge from '@/components/shared/status-badge'
import { DataTable, TableHeadRow, Th, Td, Tr, RowNameButton } from '@/components/shared/table'
import { formatDay, formatTime } from '@/lib/format'

type Page = { account: string; requests: BookingRequest[]; total: number }
const PAGE_SIZE = 20
export default function BookingReception({ onOpen, refreshKey }: { onOpen: (id: string) => void; refreshKey?: string }) {
  const { selectedAccountId } = useAccount()
  const [page, setPage] = useState(1)
  const [state, setState] = useState<Page | null>(null)
  const [error, setError] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => { setPage(1) }, [selectedAccountId])
  useEffect(() => {
    if (!selectedAccountId) return
    const account = selectedAccountId
    let active = true
    setState(null); setError(false)
    const from = new Date(`${jstDate()}T00:00:00+09:00`).toISOString()
    void bookingApi.listRequests(account, 'requested', { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, from })
      .then(result => {
        if (!Array.isArray(result.requests) || !Number.isFinite(result.total)) throw new Error('load_failed')
        if (active) setState({ account, requests: result.requests, total: result.total })
      }).catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [selectedAccountId, revision, refreshKey, page])
  if (!selectedAccountId) return null
  if (error) return <ListState kind="error" title="予約受付を読み込めませんでした" onRetry={() => setRevision(n => n + 1)} />
  if (state?.account !== selectedAccountId) return <ListState kind="loading" title="予約受付を読み込んでいます" />
  return <Card variant="form" aria-label="予約受付管理">
    <CardHeader size="stacked" title="予約受付管理" />
    <KpiBand layout="booking"><KpiCard presentation="band" title="承認待ち" value={state.total} unit="件" detail="今日以降の予約" /></KpiBand>
    <Notice tone="info">未割り当ての予約は、この一覧では確認できません。</Notice>
    {state.requests.length ? <DataTable><thead><TableHeadRow><Th grow>予約</Th><Th>日時</Th><Th grow>内容</Th><Th>担当</Th><Th>状態</Th></TableHeadRow></thead><tbody>
      {state.requests.map(row => <Tr key={row.id}><Td grow><RowNameButton onClick={() => onOpen(row.id)}>{row.friend_name || '名前未設定'}</RowNameButton></Td><Td>{formatDay(row.starts_at)} {formatTime(row.starts_at)}</Td><Td grow>{row.menu_name}</Td><Td>{row.staff_name || '担当を確認'}</Td><Td><StatusBadge tone="caution">承認待ち</StatusBadge></Td></Tr>)}
    </tbody></DataTable> : <ListState kind="empty" title="今日以降の承認待ちはありません" />}
    {state.total > PAGE_SIZE ? <Pagination page={page} pageCount={Math.ceil(state.total / PAGE_SIZE)} onPageChange={setPage} ariaLabel="予約受付のページ送り" /> : null}
  </Card>
}
