'use client'

import { knownValue } from '@/lib/known-value'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import Button from '@/components/shared/button'
import Dialog from '@/components/shared/dialog'
import SearchField from '@/components/shared/search-field'
import Select from '@/components/shared/select'
import Pagination from '@/components/shared/pagination'
import { ActionCell, DataTable, Td, Tr } from '@/components/shared/table'
import { Tabs } from '@/components/shared/tabs'
import { TableHeadRow, TableStateRow, Th } from '@/components/shared/table'
import { useAccount } from '@/contexts/account-context'
import { api, ApiError, type AuditEventItem, type AuditEventSummary } from '@/lib/api'
import ListRange from '@/components/ui/list-range'
import Notice from '@/components/shared/notice'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import { formatDateTime } from '@/lib/format'
import { SaveErrorField } from '@/components/shared/save-form-errors'

const EMPTY_SUMMARY: AuditEventSummary = {
  periodDays: null,
  total: 0,
  deleted: 0,
  sent: 0,
  changed: 0,
  logins: 0,
  suspiciousLogins: 0,
  attention: 0,
}

const ROLE_LABELS: Record<string, string> = {
  owner: '管理者',
  admin: '管理者',
  staff: '運用',
  viewer: '閲覧のみ',
}

const PERIOD_OPTIONS = [
  { value: '30', label: 'この30日' },
  { value: '90', label: '過去90日' },
  { value: 'all', label: 'すべての期間' },
]

const PAGE_SIZE_OPTIONS = [
  { value: '20', label: '20件表示' },
  { value: '50', label: '50件表示' },
  { value: '100', label: '100件表示' },
]

const SORT_OPTIONS = [
  { value: 'new', label: '記録が新しい順' },
  { value: 'old', label: '記録が古い順' },
]

function isAttention(row: AuditEventItem): boolean {
  return row.riskLevel !== 'normal' || row.result !== 'success'
}

/*
 * 監査 R69: タブの絞り込みはサーバ側の集計と同じ分類（group）で行う。
 * 以前は画面側の独自条件で、集計が数えた publish・change・patch・put の
 * 記録が「配信した」「設定を変えた」の一覧から消えていた。
 */
const TAB_GROUP: Record<string, 'deleted' | 'sent' | 'changed' | 'login' | 'attention' | undefined> = {
  all: undefined,
  deleted: 'deleted',
  sent: 'sent',
  settings: 'changed',
  login: 'login',
  attention: 'attention',
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '日時を取得できませんでした'
  return formatDateTime(date)
}

function actionLabel(row: AuditEventItem): string {
  const action = row.action.toLowerCase()
  if (action === 'auth.login') return row.result === 'success' ? 'ログインしました' : 'ログインに失敗しました'
  if (action === 'auth.logout') return 'ログアウトしました'
  if (action === 'auth.totp_reset') return '二段階認証の登録を外しました'
  if (action.includes('delete')) return '削除しました'
  if (action.includes('send') || action.includes('publish')) return '配信しました'
  if (action.includes('suspend')) return '利用を停止しました'
  if (action.includes('update') || action.includes('change') || action.includes('patch') || action.includes('put')) return '設定を変えました'
  return row.category === 'auth' ? '認証を確認しました' : '操作しました'
}

function targetLabel(row: AuditEventItem): string {
  if (!row.target) return '—'
  return [row.target.kind, row.target.id].filter(Boolean).join(' ／ ') || '—'
}

function objectValue(value: Record<string, unknown> | null): string {
  if (!value) return '—'
  const parts = Object.values(value).flatMap((item) => {
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') return [String(item)]
    return []
  })
  return parts.length > 0 ? parts.slice(0, 2).join('・') : '変更内容あり'
}

function changeLabel(row: AuditEventItem): string {
  if (!row.before && !row.after) return '—'
  return `${objectValue(row.before)} → ${objectValue(row.after)}`
}

function locationLabel(row: AuditEventItem): string {
  const source = [row.ipPrefix, row.deviceFamily].filter(Boolean).join(' ／ ')
  const region = row.regionLabel ?? '—'
  if (row.riskLevel === 'normal') return `${region}${source ? ` ／ ${source}` : ''}（いつもの場所）`
  return `${region}${source ? ` ／ ${source}` : ''}（要確認）`
}

export default function LoginAudit({ userId }: { userId?: string }) {
  const { selectedAccountId, loading: accountsLoading } = useAccount()
  const [rows, setRows] = useState<AuditEventItem[]>([])
  const [summary, setSummary] = useState<AuditEventSummary>(EMPTY_SUMMARY)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  /*
   * STAFF-02: 集計カード・タブの件数は「最後に取得成功した期間」のもの。
   * 読み込み中・失敗中に、選択中の期間の結果と見せかけて古い期間の数を
   * 出さないため、表示中の集計がどの期間のものかを別に持つ。
   */
  const [loadedPeriod, setLoadedPeriod] = useState<string | null>(null)
  /* 期間を素早く切り替えたとき、先に投げた遅い応答が新しい結果を上書きしないよう世代で捨てる。 */
  const requestSeq = useRef(0)
  const [query, setQuery] = useState('')
  const [actionFilter, setActionFilter] = useState('all')
  const [periodFilter, setPeriodFilter] = useState('30')
  const [sort, setSort] = useState('new')
  const [pageSize, setPageSize] = useState(20)
  const [page, setPage] = useState(1)
  const [detail, setDetail] = useState<AuditEventItem | null>(null)

  const load = useCallback(async () => {
    const requestId = ++requestSeq.current
    setLoading(true)
    setError('')
    if (!selectedAccountId) {
      setRows([])
      setSummary(EMPTY_SUMMARY)
      setTotal(0)
      setLoadedPeriod(null)
      setLoading(accountsLoading)
      setError(accountsLoading ? '' : 'LINEアカウントを選択してください。')
      return
    }
    try {
      const from = periodFilter === 'all'
        ? undefined
        : new Date(Date.now() - Number(periodFilter) * 24 * 60 * 60 * 1000).toISOString()
      const auditResult = await api.audit.events({
        lineAccountId: selectedAccountId,
        actorId: userId,
        query: query.trim() || undefined,
        from,
        group: TAB_GROUP[actionFilter],
        // 監査 R68: 並び順もAPIへ渡し、DBが同じ順序でページを分ける。
        sort: sort === 'old' ? 'asc' : 'desc',
        limit: pageSize,
        offset: (page - 1) * pageSize,
      })
      if (requestId !== requestSeq.current) return // 新しい条件の取得が続いている。古い応答は捨てる。
      if (auditResult.success) {
        setRows(auditResult.data.items)
        setSummary(auditResult.data.summary)
        setTotal(auditResult.data.pagination.total)
        // 集計がどの期間のものかを、取得に成功した条件へそろえる。
        setLoadedPeriod(periodFilter)
      } else {
        // 集計だけ残すと「失敗した期間の件数」と読み違える。件数は前回取得成功時のままにし、行は消す。
        setRows([])
        setTotal(0)
        setError(auditResult.error || '入った記録を読み込めませんでした。時間をおいて、もう一度お試しください。')
      }
    } catch (caught) {
      if (requestId !== requestSeq.current) return
      setRows([])
      setTotal(0)
      setError(caught instanceof ApiError && caught.status === 403
        ? '入った記録を見る権限がありません。管理者へ確認してください。'
        : '入った記録を読み込めませんでした。時間をおいて、もう一度お試しください。')
    } finally {
      if (requestId === requestSeq.current) setLoading(false)
    }
  }, [accountsLoading, actionFilter, page, pageSize, periodFilter, query, selectedAccountId, sort, userId])

  useLayoutEffect(() => {
    requestSeq.current += 1
    setRows([])
    setSummary(EMPTY_SUMMARY)
    setTotal(0)
    setLoadedPeriod(null)
    setDetail(null)
    setError('')
  }, [selectedAccountId])
  useEffect(() => { void load() }, [load])

  const counts = {
    all: summary.total,
    deleted: summary.deleted,
    sent: summary.sent,
    settings: summary.changed,
    login: summary.logins,
    attention: summary.attention,
  }
  // 絞り込み・並び替えはサーバ側で済んでいるので、返ってきた頁をそのまま出す。
  const shown = rows
  useEffect(() => { setPage(1) }, [actionFilter, pageSize, periodFilter, query, sort])
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const currentPage = Math.min(page, pageCount)
  const visible = shown
  const first = total === 0 ? 0 : (currentPage - 1) * pageSize + 1
  const last = visible.length === 0 ? 0 : Math.min(first + visible.length - 1, total)

  /*
   * STAFF-02: 集計題は「表示中の数が属する期間」（loadedPeriod）で出す。
   * 選択中の期間とずれている間は読み込み中であること、失敗したときは
   * 前回の集計のままであることを、件数の横の補足で明記する。
   */
  const periodLabel = (period: string): string =>
    PERIOD_OPTIONS.find((option) => option.value === period)?.label ?? period
  const summaryTitle = loadedPeriod === null ? '記録' : `${periodLabel(loadedPeriod)}の記録`
  const summaryNote = error
    ? (loadedPeriod === null ? '記録を取得できませんでした' : '読み込みに失敗したため、前回の集計を表示しています')
    : loading
      ? (loadedPeriod === null || periodFilter === loadedPeriod
          ? '記録を読み込み中…'
          : `${periodLabel(periodFilter)}の記録を読み込み中…`)
      : '認証と業務操作をまとめて集計'
  const summaryValue = (value: number): number | null => (loadedPeriod === null ? null : value)

  return <div id="staff-audit">
    <KpiBand data-design="KPIs" className="mb-4" aria-busy={loading}>
      <AuditKpi label={summaryTitle} value={summaryValue(summary.total)} note={summaryNote} />
      <AuditKpi label="消した操作" value={summaryValue(summary.deleted)} note="削除として記録された操作" />
      <AuditKpi label="配信した操作" value={summaryValue(summary.sent)} note="送信・公開として記録された操作" />
      <AuditKpi label="いつもと違う場所から" value={summaryValue(summary.suspiciousLogins)} note="見なれない場所からのログイン" attention={summary.suspiciousLogins > 0} />
    </KpiBand>
    <Notice tone="info" className="mb-4">だれが、いつ、何をしたかの記録です。いつもと違う場所からのログインは赤く出します。消した・配信した・設定を変えたで絞れます。</Notice>
    <div className="mb-3 flex flex-wrap items-center gap-3">
      <SearchField aria-label="人の名前・操作の内容で検索" value={query} onChange={setQuery} placeholder="人の名前・操作の内容で検索" className="min-w-64 flex-1" />
      <SaveErrorField names={["periodFilter","period_filter"]}><Select aria-label="期間で絞り込む" label="期間" value={periodFilter} onChange={setPeriodFilter} options={PERIOD_OPTIONS} /></SaveErrorField>
      <SaveErrorField names={["pageSize","limit","page_size"]}><Select aria-label="表示件数" value={String(pageSize)} onChange={(value) => setPageSize(Number(value))} options={PAGE_SIZE_OPTIONS} /></SaveErrorField>
    </div>
    <div className="mb-3 flex flex-wrap items-center gap-3">
      <Tabs items={[
        { label: 'すべて', count: counts.all, current: actionFilter === 'all', onClick: () => setActionFilter('all') },
        { label: '消した', count: counts.deleted, current: actionFilter === 'deleted', onClick: () => setActionFilter('deleted') },
        { label: '配信した', count: counts.sent, current: actionFilter === 'sent', onClick: () => setActionFilter('sent') },
        { label: '設定を変えた', count: counts.settings, current: actionFilter === 'settings', onClick: () => setActionFilter('settings') },
        { label: 'ログイン', count: counts.login, current: actionFilter === 'login', onClick: () => setActionFilter('login') },
        { label: '気になるもの', count: counts.attention, current: actionFilter === 'attention', onClick: () => setActionFilter('attention') },
      ]} />
      <SaveErrorField names={["sort"]}><Select aria-label="並び順" value={sort} onChange={setSort} options={SORT_OPTIONS} /></SaveErrorField>
    </div>
    {error
      ? <Notice tone="danger" action={<Button onClick={() => void load()}>もう一度読み込む</Button>}>{error}</Notice>
      : <div className="overflow-hidden rounded-card border border-hairline bg-canvas"><DataTable className="rounded-none border-0"><thead><TableHeadRow><Th className="w-1/4">いつ・だれが</Th><Th className="w-1/5">何をしたか</Th><Th className="w-1/5">対象</Th><Th className="w-1/5">元の値 → 新しい値</Th><Th>場所</Th><Th align="right">操作</Th></TableHeadRow></thead><tbody>{loading
        ? <TableStateRow colSpan={6} kind="loading" title="記録を読み込んでいます…" />
        : visible.length === 0
          ? <TableStateRow colSpan={6} kind="empty" title="条件に合う記録はありません。条件を変えてお試しください。" />
          : visible.map((row) => <Tr key={row.id} interactive><Td><p className="truncate font-semibold text-ink" title={`${formatDate(row.createdAt)} ／ ${row.actor.name ?? '名前未取得'}`}>{formatDate(row.createdAt)} ／ {row.actor.name ?? '名前未取得'}</p><p className="mt-1 text-xs text-ink-faint">{row.actor.role ? knownValue(ROLE_LABELS, row.actor.role, row.actor.role) : '権限を取得できませんでした'}</p></Td><Td className={`truncate font-medium ${isAttention(row) ? 'text-danger' : 'text-ink'}`} title={actionLabel(row)}>{actionLabel(row)}</Td><Td className="truncate text-ink-secondary" title={targetLabel(row)}>{targetLabel(row)}</Td><Td className="truncate text-ink-secondary" title={changeLabel(row)}>{changeLabel(row)}</Td><Td className={`truncate ${isAttention(row) ? 'text-danger' : 'text-ink-secondary'}`} title={locationLabel(row)}>{locationLabel(row)}</Td><ActionCell><Button variant="secondary" onClick={() => setDetail(row)}>開く</Button></ActionCell></Tr>)}</tbody></DataTable></div>}
    {!loading && !error && total > 0 && <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-ink-faint"><ListRange label="記録" total={total} first={first} last={last} /><Pagination page={currentPage} pageCount={pageCount} onPageChange={setPage} /></div>}
    <Dialog
      open={detail !== null}
      title="操作記録の詳細"
      description={detail ? `${formatDate(detail.createdAt)} ／ ${detail.actor.name ?? '名前未取得'}` : undefined}
      onCancel={() => setDetail(null)}
    >
      {detail ? <dl className="grid gap-3 text-sm"><div><dt className="text-xs text-ink-faint">対象</dt><dd className="mt-1 text-ink">{targetLabel(detail)}</dd></div><div><dt className="text-xs text-ink-faint">変更前 → 変更後</dt><dd className="mt-1 text-ink">{changeLabel(detail)}</dd></div><div><dt className="text-xs text-ink-faint">場所</dt><dd className="mt-1 text-ink">{locationLabel(detail)}</dd></div></dl> : null}
    </Dialog>
  </div>
}

function AuditKpi({ label, value, note, attention = false }: { label: string; value: number | null; note: string; attention?: boolean }) {
  return <KpiCard presentation="band" title={label} value={value} unit="件" detail={note} valueTone={attention ? 'danger' : 'default'} />
}
