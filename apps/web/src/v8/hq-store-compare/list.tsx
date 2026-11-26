'use client'
import { DetailContent, DetailField, DetailSection, DetailSectionTitle } from '@/components/shared/detail-content'

import PeriodPicker from '@/components/shared/period-picker'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Download } from 'lucide-react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { StoreComparisonDetail, HqAttentionKind, StoreComparisonResult, StoreComparisonRow } from '@line-crm/shared'
import { ListPage, ListPagePagination, ListPageSection } from '@/components/templates'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import { ValueBarChart } from '@/components/shared/charts'
import DeltaChip from '@/components/shared/delta-chip'
import Drawer from '@/components/shared/drawer'
import DisplayItemsDialog from '@/components/shared/display-items-dialog'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import ListToolbar from '@/components/shared/list-toolbar'
import Pagination from '@/components/shared/pagination'
import PageSizeSelect from '@/components/shared/page-size-select'
import { pastPeriod } from '@/components/shared/period-picker'
import Select from '@/components/shared/select'
import { DataTable, SortTh, TableHeadRow, Td, Th, Tr, type SortDirection } from '@/components/shared/table'
import Toggle from '@/components/shared/toggle'
import TruncatedText from '@/components/shared/truncated-text'
import { useAccount } from '@/contexts/account-context'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { storeComparisonApi } from '@/lib/api/helpers/gap3'
import { fetchApi } from '@/lib/api'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { readSessionSnapshot } from '@/lib/session-snapshot'
import type { AccountWithStats } from '@/contexts/account-context'
import { columnsWithDiff, coverageLabel, diffCount, diffCountLabel, diffCountShortLabel, diffTitle, formatDiff, formatMetric, METRICS, diffTone, sameAsAverage, worseCount, type MetricDef, type StoreAverage } from './metrics'
import styles from './list.module.css'
import { formatNumber } from '@/lib/format'
import { EmptyCell } from '@/components/shared/empty-value'
import { notifyToast } from '@/components/shared/toast'
import { readStaffIdentity, subscribeStaffIdentity } from '@/lib/staff-identity-state'
import { columnPreferenceKey, readColumnPreference } from './column-preference'

/*
 * ★V8 統括「店の比較」（G7-1 `W4fI7A`）。行＝店、列＝7つの数。
 * 各マスに値と平均との差の札（良い＝緑・悪い＝赤）。行を押すと右の引き出し（G7-2 `z0fSYt`）。
 * 「違いだけ表示」（?diffOnly=1）は全店の平均と同じ数を隠す。表は全部の店で同じ列、引き出しは同じ数の行。CSV は切り替えに関係なく全部の列。
 * CSV は書き出しの口（頼む→待つ→受け取る）につないだ。「店の組」の絞り込みは口がまだ無いので、形を残して共通の準備中の窓を出す。
 */

type Status = 'loading' | 'ready' | 'error'
type Order = 'asc' | 'desc'

const COMPARE_OPTIONS = [
  { value: 'previous', label: '比べる相手：前の期間' },
  { value: 'average', label: '比べる相手：全店の平均' },
]

/** 集計は毎朝 4 時半から、前の日の分まで（Worker の店の比較の集計と同じ時刻）。 */
const SNAPSHOT_TIME = '毎朝 4 時半'
const NOT_COMPUTED = `まだ集計していません（${SNAPSHOT_TIME}から、前の日の分まで集計します）`
/** 「N つが違う」の基準。違いは比べる相手の選択に関係なく全店の平均と比べる。 */
const DIFF_BASE = '全店の平均と比べて'

function rangeLabel(from: string, to: string): string {
  const f = (v: string) => `${Number(v.slice(5, 7))}/${Number(v.slice(8, 10))}`
  return `${f(from)}〜${f(to)}`
}

export default function StoreComparisonList() {
  usePageTitle('比較・分析')
  usePageCrumbs([{ label: 'ホーム', href: '/hq' }])
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [diffOnly, setDiffOnlyState] = useState(() => searchParams.get('diffOnly') === '1')
  const { accounts, refreshAccounts, selectedAccountId } = useAccount()
  const identity = useSyncExternalStore(subscribeStaffIdentity, readStaffIdentity, () => null)
  const preferenceKey = identity?.tenantId && identity.id ? columnPreferenceKey(identity.tenantId, identity.id, selectedAccountId) : null
  const role = useStaffRole()
  const canManage = readSessionSnapshot()?.impersonation?.mode !== 'read' && canManageRole(role)
  const [checkingId, setCheckingId] = useState<string | null>(null)
  const [checkFailed, setCheckFailed] = useState<string | null>(null)
  const [days, setDays] = useState(30)
  const [compare, setCompare] = useState<'previous' | 'average'>('previous')
  /* 初期は予約の少ない順（G7 §2-1）。 */
  const [sort, setSort] = useState<MetricDef['key']>('bookings')
  const [order, setOrder] = useState<Order>('asc')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<10 | 20 | 50>(20)
  const [status, setStatus] = useState<Status>('loading')
  const loadSequence = useRef(0)
  const [error, setError] = useState<unknown>(null)
  const [data, setData] = useState<StoreComparisonResult | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [notice, setNotice] = useState('')
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [preference, setPreference] = useState<{ key: string | null; metrics: MetricDef['key'][] }>(() => ({ key: null, metrics: METRICS.map(metric => metric.key) }))
  const visibleMetrics = preference.key === preferenceKey ? preference.metrics : METRICS.map(metric => metric.key)
  const period = useMemo(() => pastPeriod(days), [days])

  useEffect(() => {
    let metrics: MetricDef['key'][] | null = null
    try { if (preferenceKey) metrics = readColumnPreference(window.localStorage, preferenceKey) } catch { /* 保存領域を使えないときは既定値。 */ }
    const next = metrics ?? METRICS.map(metric => metric.key)
    setPreference({ key: preferenceKey, metrics: next })
    const initialSort = next.includes('bookings') ? 'bookings' : next[0]
    setSort(initialSort)
    setOrder(METRICS.find(metric => metric.key === initialSort)?.good === 'low' ? 'desc' : 'asc')
    setPage(1)
  }, [preferenceKey])

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current
    setStatus('loading')
    try {
      const response = await storeComparisonApi.get({ from: period.from, to: period.to, compare, sort, order, page, pageSize })
      if (!response.success) throw new Error('store_comparison_failed')
      if (sequence !== loadSequence.current) return
      setData(response.data)
      setStatus('ready')
    } catch (reason) {
      if (sequence !== loadSequence.current) return
      setError(reason)
      setStatus('error')
    }
  }, [period.from, period.to, compare, sort, order, page, pageSize])

  useEffect(() => { void load() }, [load])

  /* CSV：書き出しを頼み、できるまで待ってから受け取る（今の並び・期間・比べる相手のまま）。 */
  const exportCsv = async () => {
    setExporting(true)
    setNotice('')
    try {
      const started = await storeComparisonApi.export({ from: period.from, to: period.to, compare, sort, order }, crypto.randomUUID())
      if (!started.success) throw new Error('export_failed')
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const status = await storeComparisonApi.exportStatus(started.data.id)
        if (!status.success) throw new Error('export_failed')
        if (status.data.status === 'failed') throw new Error('export_failed')
        if (status.data.status === 'completed') { await storeComparisonApi.download(started.data.id); return }
        await new Promise((resolve) => window.setTimeout(resolve, 1000))
      }
      setNotice('CSV の用意に時間がかかっています。しばらくしてからもう一度お試しください。')
    } catch {
      setNotice('CSV を書き出せませんでした。時間をおいてもう一度お試しください。')
    } finally {
      setExporting(false)
    }
  }

  /* LINE の鍵が切れた店は、統括のアカウントと同じ確認（接続の確かめ直し）を頼んで読み直す。 */
  const recheck = async (account: AccountWithStats) => {
    if (checkingId) return
    setCheckingId(account.id)
    setCheckFailed(null)
    try {
      await fetchApi(`/api/line-accounts/${encodeURIComponent(account.id)}/connection-checks`, {
        method: 'POST',
        headers: { 'Idempotency-Key': `store-comparison-check-${account.id}-${crypto.randomUUID()}` },
        body: JSON.stringify({ expectedRevision: account.revision }),
      })
      await Promise.all([refreshAccounts(), load()])
    } catch {
      setCheckFailed(account.id)
    } finally {
      setCheckingId(null)
    }
  }
  const expiredOf = (accountId: string) => accounts.find((account) => account.id === accountId && account.connection?.tokenExpired) ?? null
  const notComputed = data?.rows.filter((row) => !row.computedAt).length ?? 0

  const total = data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1
  const last = Math.min(page * pageSize, total)
  const openRow = data?.rows.find((row) => row.accountId === openId) ?? null
  const matchingColumns = data && diffOnly ? columnsWithDiff(data.rows, data.average) : METRICS
  const columns = visibleMetrics.flatMap(key => matchingColumns.filter(metric => metric.key === key))

  /* 切り替えは URL に残す（再読込・共有でも同じ表示）。ほかの URL の条件は消さない。 */
  const setDiffOnly = (next: boolean) => {
    setDiffOnlyState(next)
    const params = new URLSearchParams(window.location.search)
    if (next) params.set('diffOnly', '1')
    else params.delete('diffOnly')
    const query = params.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }

  const sortDirection = (key: MetricDef['key']): SortDirection => (sort === key ? order : 'none')
  const changeSort = (key: MetricDef['key']) => {
    setPage(1)
    if (sort === key) setOrder(order === 'asc' ? 'desc' : 'asc')
    else { setSort(key); setOrder(METRICS.find((metric) => metric.key === key)?.good === 'low' ? 'desc' : 'asc') }
  }

  const toolbar = (
    <ListToolbar
      filters={<>
        <PeriodPicker days={days} onChange={(value) => { setPage(1); setDays(Number(value)) }} />
        <Select aria-label="比べる相手" value={compare} options={COMPARE_OPTIONS} onChange={(value) => { setPage(1); setCompare(value as 'previous' | 'average') }} />
        <DiffOnlyToggle checked={diffOnly} onChange={setDiffOnly} />
      </>}
      trailing={<>
        <Button variant="secondary" onClick={() => setColumnsOpen(true)}>表示する列</Button>
        <PageSizeSelect value={pageSize} onChange={(next) => { setPage(1); setPageSize(next as 10 | 20 | 50) }} />
        <Button variant="secondary" icon={<Download size={16} aria-hidden="true" />} onClick={() => void exportCsv()} busy={exporting} disabled={exporting}>CSVで書き出す</Button>
      </>}
    />
  )

  const body = status === 'loading' && !data ? (
    <ListState kind="loading" title="比較・分析を読み込んでいます" />
  ) : status === 'error' ? (
    <ListState kind="error" error={error} onRetry={() => void load()} />
  ) : !data || data.rows.length === 0 ? (
    <ListState kind="empty" emptyPreset="readonly" title="比べる店がまだありません" description="統括に店が入ると、ここで数を並べて見られます。" />
  ) : columns.length === 0 ? (
    <ListState kind="empty" emptyPreset="filtered" title={matchingColumns.length === 0 ? '全店の平均と違う数はありません' : '表示する列に、全店の平均と違う数はありません'} description={matchingColumns.length === 0 ? 'どの店も、7 つの数が全店の平均と同じです。' : '列を変更するか、違いだけ表示を解除してください。'} action={<Button variant="secondary" onClick={() => setDiffOnly(false)}>すべて表示</Button>} />
  ) : (
    <ListPageSection>
      <DataTable columns={`minmax(0, 1.1fr) repeat(${columns.length}, minmax(0, 1fr))`}>
        <thead>
          <TableHeadRow>
            <Th grow>店</Th>
            {columns.map((def) => (
              <SortTh key={def.key} align="right" sort={sortDirection(def.key)} onSort={() => changeSort(def.key)} sortLabel={`${def.label}で並べ替える`}>{def.short}</SortTh>
            ))}
          </TableHeadRow>
        </thead>
        <tbody>
          {data.rows.map((row) => {
            const expired = expiredOf(row.accountId)
            const revision = expired?.revision
            const canRecheck = canManage && typeof revision === 'number' && Number.isInteger(revision) && revision >= 1
            return (
              <Fragment key={row.accountId}>
                <Tr interactive onOpen={() => setOpenId(row.accountId)} data-row-id={row.accountId}>
                  <Td grow>
                    <span className={styles.storeCell}>
                      <span className={styles.storeName}><TruncatedText value={row.name} /></span>
                      <DiffCountLine row={row} average={data.average} />
                    </span>
                  </Td>
                  {columns.map((def) => (
                    <Td key={def.key} align="right"><MetricCell def={def} metric={row.metrics[def.key]} compare={compare} computed={!!row.computedAt} coverage={coverageLabel(def.key, row)} /></Td>
                  ))}
                </Tr>
                {expired ? (
                  <Tr data-store-connection={row.accountId}>
                    <Td colSpan={columns.length + 1}>
                      <Notice tone="warn" compact
                        heading={row.name?.trim() || expired.name?.trim() || '店名未取得'}
                        message={checkFailed === row.accountId ? 'LINE の接続が切れています。確かめ直せませんでした。時間をおいてもう一度押してください。' : 'LINE の接続が切れています。この店の数は取れないことがあります。'}
                        action={canRecheck ? <Button variant="text" onClick={() => void recheck(expired)} busy={checkingId === row.accountId} disabled={checkingId !== null}>更新する</Button> : undefined}
                      />
                    </Td>
                  </Tr>
                ) : null}
              </Fragment>
            )
          })}
        </tbody>
      </DataTable>
      <div className={styles.averageBand}>
        <span className={styles.averageTitle}>{`${formatNumber(total)} 店の平均`}</span>
        <TruncatedText className={styles.averageText} value={METRICS.map((def) => `${def.label} ${formatMetric(def.key, data.average[def.key] ?? null)}`).join('・')} />
        <span className={styles.averageNote}>{`数の横の印は${compare === 'average' ? '全店の平均' : '前の期間'}との差（赤＝悪い・緑＝良い）${compare === 'average' ? '' : '・「違う」の数は全店の平均と比べます'}`}</span>
      </div>
    </ListPageSection>
  )

  return (
    <>
      <ListPage
        skeleton
        boardId="W4fI7A"
        layout="store-comparison"
        title="比較・分析"
        help={<>店ごとに、友だち・予約・来店・返事の速さを並べて見ます。平均より悪い数は赤の印で知らせます。数は毎朝、前の日の分まで更新します。数の横の印は、「比べる相手」（前の期間か全店の平均）との差で、赤は悪い方・緑は良い方です。期間の途中から集計した店は、集計できた日の分だけで数を出し、件数の横に「12 日分」のように日数を出します（日数が違うので差の印は出しません）。{METRICS.map((def) => <span key={def.key}><br />{`${def.label}：${def.help}`}</span>)}</>}
        toolbar={toolbar}
        pagination={status === 'ready' && total > 0 ? (
          <ListPagePagination>
            <span className={styles.pagerCount}>{`${formatNumber(total)} 店中 ${first}〜${last}・期間 ${rangeLabel(period.from, period.to)}`}</span>
            <Pagination page={page} pageCount={pageCount} onPageChange={setPage} />
          </ListPagePagination>
        ) : undefined}
      >
        {notice || (status === 'ready' && notComputed > 0) ? (
          <ListPageSection>
            {notice ? <Notice tone="danger" message={notice} /> : null}
            {status === 'ready' && notComputed > 0 ? (
              <Notice tone="info" message={notComputed === data?.rows.length
                ? `${NOT_COMPUTED}。集計できた日の分から数が出ます。`
                : `まだ集計していない店が ${notComputed} 店あります。${SNAPSHOT_TIME}から前の日の分まで集計し、集計できた日の分から数が出ます。`} />
            ) : null}
          </ListPageSection>
        ) : null}
        {body}
      </ListPage>
      {columnsOpen ? <DisplayItemsDialog title="表示する列" presentation="columns" fixedLabel="店" minSelected={1} description="表に出す指標を選んで並べ替えます。CSV にはすべての指標が入ります。" items={METRICS.map(metric => ({ key: metric.key, label: metric.label, group: '指標' }))} selected={visibleMetrics} onCancel={() => setColumnsOpen(false)} onConfirm={keys => {
        const next = keys as MetricDef['key'][]
        setPreference({ key: preferenceKey, metrics: next })
        if (preferenceKey) { try { window.localStorage.setItem(preferenceKey, JSON.stringify(next)) } catch { /* この画面では選択を保持する。 */ } }
        if (!next.includes(sort)) {
          const first = next.find(key => matchingColumns.some(metric => metric.key === key)) ?? next[0]
          if (first) { setPage(1); setSort(first); setOrder(METRICS.find(metric => metric.key === first)?.good === 'low' ? 'desc' : 'asc') }
        }
        setColumnsOpen(false)
      }} /> : null}
      <StoreDrawer row={openRow} period={period} compare={compare} average={data?.average ?? null} diffOnly={diffOnly} onDiffOnly={setDiffOnly} onClose={() => setOpenId(null)} />
    </>
  )
}

function DiffOnlyToggle({ checked, onChange }: { checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <span className={styles.diffToggle}>
      <Toggle size="toolbar" checked={checked} label="違いだけ表示" onChange={onChange} />
      <span aria-hidden="true">違いだけ表示</span>
    </span>
  )
}

/** 店の名前の下の「7 項目中 5 つが違う」。集計前・比べられる数が無い店には出さない（「差が無い」と読ませない）。 */
function DiffCountLine({ row, average }: { row: StoreComparisonRow; average: StoreAverage }) {
  if (!row.computedAt) return null
  const count = diffCount(row, average)
  if (count.compared === 0) return null
  return <span className={styles.diffCount} data-diff-count={row.accountId} title={`${DIFF_BASE}、${diffCountLabel(count)}`}>{diffCountShortLabel(count)}</span>
}

function MetricCell({ def, metric, compare, computed, coverage }: { def: MetricDef; metric: StoreComparisonRow['metrics'][MetricDef['key']] | undefined; compare: 'previous' | 'average'; computed: boolean; coverage: string | null }) {
  if (!metric || !metric.available || metric.value === null) {
    return <span className={styles.cellEmpty} title={computed ? 'この数はまだ取れていません' : NOT_COMPUTED}>—</span>
  }
  const diff = formatDiff(def.key, metric.diff)
  const tone = diffTone(def, metric.diff)
  return (
    <span className={styles.cell} title={coverage ? `期間のうち${coverage}の数です（日数が違うので差は出しません）` : diffTitle(def.key, metric.diff, compare)}>
      <span className={styles.cellValue}>{formatMetric(def.key, metric.value)}</span>
      <span className={styles.chipSlot}>{diff && tone ? <DeltaChip tone={tone} direction={(metric.diff ?? 0) > 0 ? 'up' : 'down'}>{diff}</DeltaChip> : coverage ? <span className={styles.coverage}>{coverage}</span> : null}</span>
    </span>
  )
}

const ATTENTION: Array<{key:HqAttentionKind;label:string}> = [
 {key:'unhandledChats',label:'未対応・対応中・保留のトーク'},
 {key:'pendingBookings',label:'承認待ちの予約'},
 {key:'unpaid',label:'未払い'},
 {key:'connections',label:'接続の異常'},
]

function attentionTargetLabel(href:string) {
 const path=new URL(href,'https://qa.invalid');
 if(path.pathname==='/chats')return {unread:'未対応のトークを開く',in_progress:'対応中のトークを開く',on_hold:'保留のトークを開く'}[path.searchParams.get('status') ?? ''] ?? 'トークを開く';
 if(path.pathname==='/events/bookings')return 'イベントの申込を開く';
 if(path.pathname==='/restaurant-test/reservations')return '飲食店の予約台帳を開く';
 if(path.pathname==='/booking/bookings')return '承認待ちの予約を開く';
 if(path.pathname==='/booking/menus')return 'お支払いの記録を開く';
 return '接続の状態を開く';
}

function StoreDrawer({ row, period, compare, average, diffOnly, onDiffOnly, onClose }: { row: StoreComparisonRow | null; period: { from: string; to: string }; compare: 'previous' | 'average'; average: StoreAverage | null; diffOnly: boolean; onDiffOnly: (next: boolean) => void; onClose: () => void }) {
  const router = useRouter()
  const { setSelectedAccountId } = useAccount()
  const [detail, setDetail] = useState<{ id: string; status: Status; data: StoreComparisonDetail | null }>({ id: '', status: 'loading', data: null })
  const accountId = row?.accountId ?? null

  useEffect(() => {
    if (!accountId) return
    let cancelled = false
    setDetail({ id: accountId, status: 'loading', data: null })
    storeComparisonApi.detail(accountId, period.from, period.to)
      .then((response) => {
        if (cancelled) return
        if (!response.success) throw new Error('detail_failed')
        setDetail({ id: accountId, status: 'ready', data: response.data })
      })
      .catch(() => { if (!cancelled) setDetail({ id: accountId, status: 'error', data: null }) })
    return () => { cancelled = true }
  }, [accountId, period.from, period.to])

  const worse = row ? worseCount(row) : 0
  const count = row && average && row.computedAt ? diffCount(row, average) : null
  const base = compare === 'average' ? '全店の平均' : '前の期間'
  const worseText = worse > 0 ? `${base}より悪い数 ${worse} つ` : `${base}より悪い数はありません`
  /* 平均より下の数を上に並べる（G7 §2-1）。 */
  const sorted = row
    ? [...METRICS].sort((a, b) => Number(diffTone(b, row.metrics[b.key]?.diff ?? null) === 'down') - Number(diffTone(a, row.metrics[a.key]?.diff ?? null) === 'down'))
    : []
  /* 「違いだけ表示」：全店の平均と同じ数の行を隠す。取れない数は「同じ」に数えず残す。 */
  const hidden = row && average && diffOnly ? sorted.filter((def) => sameAsAverage(row, average, def.key)) : []
  const ordered = sorted.filter((def) => !hidden.includes(def))
  const current = detail.id === accountId ? detail : { id: '', status: 'loading' as Status, data: null }

  const attention = current.data?.attention

  return (
    <Drawer
      open={row !== null}
      title={row?.name ?? ''}
      description={row ? (count && count.compared > 0 ? <><span className={styles.descriptionLine}>{`${DIFF_BASE} ${diffCountLabel(count)}`}</span><span className={styles.descriptionLine}>{worseText}</span></> : worseText) : undefined}
      closeAppearance="box"
      heightMode="viewport"
      onClose={onClose}
      actions={{primary: ((row) ? <Button variant="primary" onClick={() => { notifyToast(`${row.name} に切り替えました`, { tone: 'info' }); setSelectedAccountId(row.accountId); router.push('/') }}>この店を開く</Button> : null),
menuItems: []}}
    >
<DetailContent>
      {row ? (
        <div className={styles.drawerBody}>
          <DetailSection label="7つの数">
            <div className={styles.cardHead}>
              <DetailSectionTitle>7 つの数</DetailSectionTitle>
              <DiffOnlyToggle checked={diffOnly} onChange={onDiffOnly} />
            </div>
            <div>
              {ordered.map((def) => {
                const metric = row.metrics[def.key]
                const tone = diffTone(def, metric?.diff ?? null)
                const diff = formatDiff(def.key, metric?.diff ?? null)
                const coverage = metric?.available && metric.value !== null ? coverageLabel(def.key, row) : null
                return (
                  <div key={def.key}>
                  <DetailField label={def.label}>
                      {metric?.available && metric.value !== null ? formatMetric(def.key, metric.value) : <EmptyCell />}
                      {diff && tone ? <DeltaChip tone={tone} direction={(metric.diff ?? 0) > 0 ? 'up' : 'down'}>{diff}</DeltaChip> : coverage ? <span className={styles.coverage}>{coverage}</span> : null}
                  </DetailField>
                  {current.status === 'ready' && current.data?.trend?.length ? <ValueBarChart label={`${def.label}の日ごとの推移`} unit={metric?.unit ?? ''} signed={def.key === 'friendChange'} items={current.data.trend.map(day => ({key:day.date,label:day.date,value:day.values[def.key],note:day.state==='failed'?'集計に失敗':day.state==='missing'?'取得待ち':undefined}))} /> : null}
                  {current.status === 'loading' ? <p className={styles.mute}>推移を読み込んでいます</p> : null}
                  {current.status === 'error' ? <p className={styles.mute}>推移を読み込めませんでした。</p> : null}
                  {current.status === 'ready' && !current.data?.trend?.length ? <p className={styles.mute}>推移はまだ取れていません。</p> : null}
                  </div>
                )
              })}
            </div>
            {hidden.length > 0 ? (
              <div className={styles.hiddenNote} data-diff-hidden>
                <p className={styles.mute}>{`全店の平均と同じ ${hidden.length} 項目（${hidden.map((def) => def.label).join('・')}）を隠しています。`}</p>
                <Button variant="text" textTone="ink" onClick={() => onDiffOnly(false)}>すべて表示</Button>
              </div>
            ) : null}
          </DetailSection>
          <DetailSection label="最近の配信">
            <DetailSectionTitle>最近の配信</DetailSectionTitle>
            {current.status === 'loading' ? <p className={styles.mute}>読み込んでいます</p> : null}
            {current.status === 'error' ? <p className={styles.mute}>最近の配信を読み込めませんでした。</p> : null}
            {current.status === 'ready' && (current.data?.recentBroadcasts.length ?? 0) === 0 ? <p className={styles.mute}>この店の配信はまだありません。</p> : null}
            {current.status === 'ready' && current.data && current.data.recentBroadcasts.length > 0 ? (
              <div className={styles.recent}>
                {current.data.recentBroadcasts.map((item) => (
                  <div key={item.id} className={styles.recentRow}>
                    <span className={styles.recentTitle} title={item.title}>{item.title}</span>
                    <span className={styles.recentDate}>{item.sent_at ? `${Number(item.sent_at.slice(5, 7))}/${Number(item.sent_at.slice(8, 10))}` : '—'}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </DetailSection>
          <DetailSection label="対応が要るもの">
            <DetailSectionTitle>対応が要るもの</DetailSectionTitle>
            {current.status === 'loading' ? <p className={styles.mute}>読み込んでいます</p> : null}
            {current.status === 'error' || (current.status === 'ready' && attention?.status !== 'ready') ? <p className={styles.mute}>対応が要るものを読み込めませんでした。</p> : null}
            {current.status === 'ready' && attention?.status === 'ready' ? ATTENTION.map(item => <div key={item.key}>
              <p>{item.label} {attention.counts[item.key]}件</p>
              {(attention.targets?.[item.key] ?? []).map(target => <Button key={target.href} variant="text" textTone="ink" onClick={() => { notifyToast(`${row.name} に切り替えました`, { tone: 'info' }); setSelectedAccountId(row.accountId); router.push(target.href) }}>{attentionTargetLabel(target.href)} {formatNumber(target.count)}件</Button>)}
            </div>) : null}
          </DetailSection>
        </div>
      ) : null}

</DetailContent>
</Drawer>
  )
}
