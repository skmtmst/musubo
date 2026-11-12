'use client'

import OperationTargetSummary from '@/components/shared/operation-target-summary'


import { useListItemHref } from '@/components/shared/list-navigation'
import { useDetailPanelUrl } from '@/components/shared/detail-panel'
import { useListUrlJsonValue } from '@/components/shared/list-url-state'
import { useListUrlValue } from '@/components/shared/list-url-state'
import { jstDate } from '@/lib/jst-datetime'
import CopyTextButton from '@/components/shared/copy-text-button'
import { useSamePageUrl } from '@/lib/use-same-page-url'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Banknote, CircleDot, CircleHelp, Download, Pause, Plus, Trophy, Users } from 'lucide-react'
import { api, type ConversionApprovalItem } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import Button from '@/components/shared/button'
import StatusBadge from '@/components/shared/status-badge'
import EmptyList from '@/components/shared/empty-list'
import BulkBar from '@/components/shared/bulk-bar'
import Checkbox, { UnavailableSelection } from '@/components/shared/checkbox'
import { FolderDotName } from '@/components/shared/folder-dot'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import FilterChip from '@/components/shared/filter-chip'
import ManagedFolderPanel, { managedFolderNavRows, useManagedFolders, folderDotFor } from '@/components/shared/managed-folder-panel'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import ListState from '@/components/shared/list-state'
import Pagination from '@/components/shared/pagination'
import Select from '@/components/shared/select'
import { RowNameLink, DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table'
import { notifyToast } from '@/components/shared/toast'
import { ListPagePagination } from '@/components/templates'
import { ListToolbarOptional } from '@/components/shared/list-toolbar'
import {
  calculateAffiliateReward,
  currentSettlementPeriod,
  deltaText,
  distributionUrl,
  downloadCsv,
  formatYen,
  listAllConversionApprovals,
  pageCountOf,
  pageOf,
  planText,
  previousSettlementPeriod,
  type AffiliateItem,
  type AffiliateLink,
  type AffiliateListRow,
  type AffiliateReportRow,
} from './display'
import { AffiliateArchiveDialog } from './dialogs'
import AffiliateDrawer from './drawer'
import { useFolderMove } from '@/components/shared/use-folder-move'
import MonthlyFlow from './monthly-flow'
import { AFFILIATE_TABLE_LAYOUT, AffiliateFrame, useAffiliateShell } from './frame'
import {
  AffiliateToolbar,
  PerPageSelect,
  RetryButton,
  RowMenu,
  SavedSelect,
  StateCard,
  ToolbarNotices,
} from './parts'
import styles from './affiliates.module.css'
import { csvFileName } from '@/lib/csv-file-name'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField, useSaveFormErrors, SaveErrorScope } from '@/components/shared/save-form-errors'


/*
 * ★V8 成果とアフィリエイト「アフィリエイター」（板 ・1152 ・
 * 閲覧のみ 、状態は見本帳 、行を押すと引き出し ）。
 *
 * app/affiliates/v8-affiliates-tab.tsx から動きを写し、見た目を一覧の型
 * （ListPage）で組み直した。データの口・操作は今と同じ（一覧・集計・承認待ち・
 * 今回の締めの見込み・紹介リンクのコピー・紹介を止める・まとめて止める・CSV）。
 *
 * フォルダの列：アフィリエイターを分けて保存する口は無いので、報酬の決め方で
 * 分けた見え方の切り替えとして持つ（保存しない）。
 */

type FilterKey = 'active' | 'reward'
type SortKey = 'conversions' | 'reward' | 'name' | 'newest'
type GroupKey = 'all' | 'rate' | 'fixed' | 'none' | 'stopped'
type LoadState = 'loading' | 'ready' | 'error'

/** 「よく使う絞り込み」：絞り込みと並びを1つにまとめた見方。 */
const SAVED_VIEWS: Array<{ value: string; label: string; filters: FilterKey[]; sort: SortKey; group?: GroupKey }> = [
  { value: '', label: 'よく使う絞り込み', filters: [], sort: 'conversions' },
  { value: 'active-results', label: '計測中・成果が多い順', filters: ['active'], sort: 'conversions' },
  { value: 'reward', label: '報酬あり・報酬が多い順', filters: ['reward'], sort: 'reward' },
  { value: 'stopped', label: '停止中のみ', filters: [], sort: 'newest', group: 'stopped' },
  { value: 'name', label: '名前順', filters: [], sort: 'name' },
  { value: 'newest', label: '登録が新しい順', filters: [], sort: 'newest' },
]

/*
 * 報酬の決め方で分けた見え方（保存しない）。作ったフォルダではないので、左のフォルダの列ではなく
 * 上の絞り込み（「報酬の決め方」の選ぶ欄）に置く（ 2026-10-09）。
 */
const GROUPS: Array<{ key: GroupKey; label: string; match: (row: AffiliateListRow) => boolean }> = [
  { key: 'all', label: '報酬の決め方：すべて', match: () => true },
  { key: 'rate', label: '売上の割合で払う', match: (row) => row.isActive && (row.rewardMode === 'rate' || (!row.rewardMode && row.commissionRate > 0)) },
  { key: 'fixed', label: '1件ごとに払う', match: (row) => row.isActive && (row.rewardMode === 'fixed' || (!row.rewardMode && row.commissionRate <= 0 && row.rewardAmount > 0)) },
  { key: 'none', label: '報酬なし（計測のみ）', match: (row) => row.isActive && (row.rewardMode === 'none' || (!row.rewardMode && row.commissionRate <= 0 && row.rewardAmount <= 0)) },
  { key: 'stopped', label: '停止中', match: (row) => !row.isActive },
]

export default function AffiliatorsTab() {
  const saveErrors = useSaveFormErrors()
  const samePageUrl = useSamePageUrl()
  const { readonly, narrow, accountId, setCount, focusAffiliateId } = useAffiliateShell()
  const settlementPeriod = useMemo(() => currentSettlementPeriod(), [])

  /* ===== 一覧 ===== */
  const { folders, error: folderError, reload: reloadFolders } = useManagedFolders('affiliate', accountId)
  const [folderId, setFolderId] = useListUrlValue('folderId', 'all')
  const folderAccount = useRef(accountId)
  useEffect(() => { if (folderAccount.current !== accountId) { folderAccount.current = accountId; setFolderId('all'); setPage(1) } }, [accountId, setFolderId])
  const [rows, setRows] = useState<AffiliateListRow[]>([])
  const [loadState, setLoadState] = useState<LoadState>('loading')

  /* ===== 数の帯の元 ===== */
  const [pendingItems, setPendingItems] = useState<ConversionApprovalItem[]>([])
  const [approvalState, setApprovalState] = useState<LoadState>('loading')
  const [approvalTruncated, setApprovalTruncated] = useState(false)
  const [paymentTotal, setPaymentTotal] = useState<number | null>(null)
  const [paymentState, setPaymentState] = useState<LoadState>('loading')
  const [monthly, setMonthly] = useState<{ count: number; delta: number | null } | null>(null)
  const [monthlyState, setMonthlyState] = useState<LoadState>('loading')

  /* ===== 見せ方 ===== */
  const [query, setQuery] = useListUrlValue('q', '')
  const [filters, setFilters] = useListUrlJsonValue<FilterKey[]>('filters', [])
  const [group, setGroup] = useState<GroupKey>('all')
  const [sort, setSort] = useListUrlValue<SortKey>('sort', 'conversions')
  const [saved, setSaved] = useState('')
  const [pageSize, setPageSize] = useListUrlValue('pageSize', 20)
  const [page, setPage] = useListUrlValue('page', 1)

  /* ===== 操作 ===== */
  const [archiveTarget, setArchiveTarget] = useState<{ id: string; name: string } | null>(null)
  const [resumeTarget, setResumeTarget] = useState<{ id: string; name: string } | null>(null)
  const [resuming, setResuming] = useState(false)
  const [resumeError, setResumeError] = useState('')
  const [drawerId, setDrawerId] = useDetailPanelUrl('affiliate')
  const itemHref = useListItemHref()
  const [drawerEdit, setDrawerEdit] = useState(false)
  const [monthlyFlowOpen, setMonthlyFlowOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [bulkConfirm, setBulkConfirm] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [linkBaseUrl, setLinkBaseUrl] = useState<string | null>(null)

  const listAccount = useRef(accountId)
  listAccount.current = accountId
  useEffect(() => { setRows([]) }, [accountId])
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  /* 配布URLの土台（短縮ドメイン）。取れなくても /r/ で作れる。 */
  useEffect(() => {
    let cancelled = false
    void api.accountSettings.getLinkBaseUrl().then((res) => {
      if (cancelled || !res.success || !res.data) return
      setLinkBaseUrl(res.data)
    }).catch(() => { /* 取れなくても /r/ で作れる */ })
    return () => { cancelled = true }
  }, [])

  const loadList = useCallback(async () => {
    if (!accountId) { setLoadState('ready'); return }
    setLoadState('loading')
    try {
      const [affiliatesRes, reportRes] = await Promise.all([api.affiliates.list(accountId), api.affiliates.allReport()])
      if (!affiliatesRes.success || !reportRes.success) throw new Error('fetch failed')
      const affiliates = affiliatesRes.data as unknown as AffiliateItem[]
      const report = new Map((reportRes.data as unknown as AffiliateReportRow[]).map((r) => [r.affiliateId, r]))
      if (!mounted.current || listAccount.current !== accountId) return
      setRows(affiliates.map((a) => {
        const rep = report.get(a.id)
        return {
          ...a,
          totalClicks: rep?.totalClicks ?? 0,
          totalConversions: rep?.totalConversions ?? 0,
          totalRevenue: rep?.totalRevenue ?? 0,
          rewardAmount: calculateAffiliateReward({
            commissionRate: a.commissionRate,
            totalRevenue: rep?.totalRevenue ?? 0,
            confirmedFixedReward: rep?.confirmedReward ?? 0,
          }),
          linkCount: rep?.linkCount ?? 0,
          friendAdds: rep?.friendAdds ?? 0,
        }
      }))
      setLoadState('ready')
    } catch {
      if (!mounted.current || listAccount.current !== accountId) return
      setRows([])
      setLoadState('error')
    }
  }, [accountId])

  const loadApprovals = useCallback(async (options: { fresh?: boolean } = {}) => {
    setApprovalState('loading')
    try {
      // 件数用（affiliates.tsx）と同じ条件なので、同時に走れば1本にまとまる（WEB003）。
      const pending = await listAllConversionApprovals('pending', 0, { accountId, fresh: options.fresh })
      if (!mounted.current) return
      setPendingItems(pending.items)
      setApprovalTruncated(pending.truncated)
      setApprovalState('ready')
    } catch {
      if (mounted.current) setApprovalState('error')
    }
  }, [accountId])

  const loadPayment = useCallback(async () => {
    if (!accountId) {
      setPaymentState('error')
      setPaymentTotal(null)
      return
    }
    setPaymentState('loading')
    try {
      const res = await api.affiliates.settlementPreview(accountId, settlementPeriod)
      if (!mounted.current) return
      if (!res.success || !Array.isArray(res.data.affiliates)) {
        setPaymentState('error')
        setPaymentTotal(null)
        return
      }
      setPaymentTotal(res.data.totalAmount)
      setPaymentState('ready')
    } catch (saveFailure) {
      saveErrors.capture(saveFailure);

      if (mounted.current) {
        setPaymentState('error')
        setPaymentTotal(null)
      }
    }
  }, [accountId, settlementPeriod, saveErrors]);


  const loadMonthly = useCallback(async () => {
    setMonthlyState('loading')
    try {
      const prev = previousSettlementPeriod(settlementPeriod.periodFrom)
      const [res, prevRes] = await Promise.all([
        api.affiliates.allReport({ startDate: settlementPeriod.periodFrom, endDate: settlementPeriod.periodTo }),
        api.affiliates.allReport({ startDate: prev.periodFrom, endDate: prev.periodTo }),
      ])
      if (!res.success) throw new Error('monthly report failed')
      const total = (arr: unknown) => (arr as Array<{ totalConversions: number }>).reduce((sum, row) => sum + row.totalConversions, 0)
      const current = total(res.data)
      if (!mounted.current) return
      setMonthly({ count: current, delta: prevRes.success ? current - total(prevRes.data) : null })
      setMonthlyState('ready')
    } catch {
      if (mounted.current) {
        setMonthly(null)
        setMonthlyState('error')
      }
    }
  }, [settlementPeriod])

  useEffect(() => {
    void loadList()
    void loadApprovals()
    void loadMonthly()
  }, [loadList, loadApprovals, loadMonthly])
  useEffect(() => { void loadPayment() }, [loadPayment])

  /* タブの名の横の件数。 */
  useEffect(() => {
    if (loadState === 'ready') setCount('affiliates', formatNumber(rows.length))
  }, [loadState, rows.length, setCount])
  useEffect(() => {
    if (approvalState === 'ready') setCount('approvals', formatNumber(pendingItems.length))
  }, [approvalState, pendingItems.length, setCount])

  /* ===== 絞り込み ===== */
  const groupRows = useMemo(() => {
    const match = GROUPS.find((g) => g.key === group)?.match ?? (() => true)
    return rows.filter(match).filter(row => folderId === 'all' || (folderId === 'unfiled' ? !row.folderId : row.folderId === folderId))
  }, [group, rows, folderId])
  const shownRows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('ja-JP')
    return groupRows
      .filter((row) => {
        if (needle && !`${row.name} ${row.code}`.toLocaleLowerCase('ja-JP').includes(needle)) return false
        if (filters.includes('active') && !row.isActive) return false
        if (filters.includes('reward') && row.rewardAmount <= 0) return false
        return true
      })
      .toSorted((a, b) => {
        if (sort === 'name') return a.name.localeCompare(b.name, 'ja-JP')
        if (sort === 'reward') return b.rewardAmount - a.rewardAmount
        if (sort === 'newest') return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        return b.totalConversions - a.totalConversions || b.rewardAmount - a.rewardAmount
      })
  }, [filters, groupRows, query, sort])

  const pageCount = pageCountOf(shownRows.length, pageSize)
  const currentPage = Math.min(page, pageCount)
  const pagedRows = pageOf(shownRows, currentPage, pageSize)
  const activeCount = rows.filter((row) => row.isActive).length
  const rewardCount = rows.filter((row) => row.rewardAmount > 0).length
  const pendingCount = pendingItems.length
  const ready = loadState === 'ready'

  const resetPage = (change: () => void) => { change(); setPage(1) }
  const resetConditions = () => {
    setQuery('')
    setFilters([])
    setGroup('all')
    setFolderId('all')
    setSaved('')
    setPage(1)
  }
  const toggleFilter = (key: FilterKey, on: boolean) => resetPage(() => {
    setSaved('')
    setFilters((cur) => (on ? [...cur, key] : cur.filter((value) => value !== key)))
  })

  /* ===== 行の操作 ===== */
  const openDrawer = useCallback((id: string, edit: boolean) => {
    setDrawerId(id)
    setDrawerEdit(edit)
  }, [])

  /* `?affiliate=` で来たとき、その人の引き出しを最初から開く（1回だけ）。 */
  const focusHandled = useRef(false)
  useEffect(() => {
    if (focusHandled.current || !focusAffiliateId || !ready) return
    focusHandled.current = true
    if (rows.some((row) => row.id === focusAffiliateId)) openDrawer(focusAffiliateId, false)
  }, [focusAffiliateId, ready, rows, openDrawer])

  const copyFirstLink = useCallback(async (row: AffiliateListRow) => {
    try {
      const res = await api.affiliates.links(row.id)
      if (!res.success) throw new Error('links failed')
      const links = res.data as unknown as AffiliateLink[]
      const link = links.find((item) => Boolean(item.is_active)) ?? links[0]
      if (!link) {
        throw new Error('この人には紹介リンクがまだありません。')
      }
      const url = distributionUrl(link.ref_code, linkBaseUrl)
      if (!url) throw new Error('URLを読み込めませんでした')
      return url
    } catch {
      throw new Error('紹介リンクを読み込めませんでした。')
    }
  }, [linkBaseUrl, openDrawer])

  /* まとめて「紹介を止める」。行ごとの確かめは「…」の紹介を止めるが担う。 */
  const bulkTargets = useMemo(() => rows.filter((row) => selected.has(row.id) && row.isActive), [rows, selected])
  const bulkAcknowledged = useRef(new Set<string>())
  const bulkArchiveTargets = useRef<AffiliateListRow[]>([])
  const bulkArchiveAccount = useRef(accountId)
  useEffect(() => {
    bulkArchiveAccount.current = accountId
    bulkArchiveTargets.current = []
    setBulkConfirm(false); setSelected(new Set()); setBulkBusy(false)
  }, [accountId])
  const [bulkError, setBulkError] = useState('')
  useEffect(() => { if (!bulkConfirm) { bulkAcknowledged.current.clear(); setBulkError('') } }, [bulkConfirm])
  const runBulkArchive = useCallback(async () => {
    const original = bulkArchiveTargets.current
    if (bulkArchiveAccount.current !== accountId || original.length === 0 || bulkBusy) return
    setBulkBusy(true); setBulkError('')
    try {
      const targets = original.filter(row => !bulkAcknowledged.current.has(row.id))
      const results = await Promise.allSettled(targets.map(row => api.affiliates.archive(row.id, { mode: 'pause' })))
      if (!mounted.current || bulkArchiveAccount.current !== accountId) return
      results.forEach((result, index) => { if (result.status === 'fulfilled' && result.value.success) bulkAcknowledged.current.add(targets[index].id) })
      const done = original.filter(row => bulkAcknowledged.current.has(row.id)).length
      const failed = original.length - done
      setSelected(current => new Set([...current].filter(id => !bulkAcknowledged.current.has(id))))
      setRows(current => current.map(row => bulkAcknowledged.current.has(row.id) ? { ...row, isActive: false } : row))
      if (failed) {
        setBulkError(`${formatNumber(done)} 人を止めました。${formatNumber(failed)} 人は止められませんでした。もう一度押すと未完了の人だけやり直します。`)
        return false
      }
      notifyToast(`${formatNumber(done)} 人の紹介を止めました。`)
      setSelected(new Set()); setBulkConfirm(false)
      void loadList()
      return true
    } finally { if (mounted.current && bulkArchiveAccount.current === accountId) setBulkBusy(false) }
  }, [accountId, bulkTargets, bulkBusy, loadList])

  const exportCsv = () => {
    downloadCsv(csvFileName("アフィリエイター"), [
      ['名前', '紹介コード', '紹介リンク数', '友だち追加', '成果', '承認済み報酬'],
      ...shownRows.map((row) => [row.name, row.code, row.linkCount, row.friendAdds, row.totalConversions, Math.round(row.rewardAmount)]),
    ])
  }

  /* ===== 数の帯（4マス） ===== */
  const loadingWord = '読み込んでいます'
  const errorWord = '読み込めませんでした'
  const stats = (
    <KpiBand>
      <KpiCard
        presentation="band"
        title="アフィリエイター"
        icon={<Users size={16} aria-hidden="true" />}
        value={ready ? rows.length : null}
        unit="人"
        detail={ready ? `計測中 ${formatNumber(activeCount)}・停止中 ${formatNumber(rows.length - activeCount)}` : loadState === 'loading' ? loadingWord : errorWord}
      />
      <KpiCard
        presentation="band"
        title="今月の成果"
        icon={<Trophy size={16} aria-hidden="true" />}
        value={monthlyState === 'ready' && monthly ? monthly.count : null}
        unit="件"
        detail={monthlyState === 'ready' && monthly ? deltaText(monthly.delta) : monthlyState === 'loading' ? loadingWord : errorWord}
      />
      <KpiCard
        presentation="band"
        title="今月の報酬"
        icon={<Banknote size={16} aria-hidden="true" />}
        value={null}
        valueText={paymentState === 'ready' && paymentTotal != null ? formatYen(paymentTotal) : emptyValue('unknown')}
        unit=""
        detail={paymentState === 'ready' ? `承認待ち ${formatNumber(pendingCount)} 件は入っていない` : paymentState === 'loading' ? loadingWord : errorWord}
      />
      <KpiCard
        presentation="band"
        title="承認待ち"
        icon={<CircleHelp size={16} aria-hidden="true" />}
        value={approvalState === 'ready' ? pendingCount : null}
        unit="件"
        detail={approvalState === 'ready' ? (approvalTruncated ? '直近の分まで表示' : '認めると報酬に入ります') : approvalState === 'loading' ? loadingWord : errorWord}
      />
    </KpiBand>
  )

  /* 主ボタンは素の Button で渡し、題の右の自動整列（副→主）に載せる。 */
  const createButton = (full: boolean) => (
    readonly ? null : (
      <Button variant="primary" className={full ? 'v8-folder-create w-full' : undefined} href="/affiliates/new" aria-label="アフィリエイターを作る" title="アフィリエイターを作る">
        {!full && <Plus size={16} aria-hidden="true" />} アフィリエイターを作る
      </Button>
    )
  )

  const groupCount = (key: GroupKey) => rows.filter(GROUPS.find((g) => g.key === key)?.match ?? (() => true)).length
  const chooseFolder = (id: string) => resetPage(() => setFolderId(id))
  const folderPanel = (
    <ManagedFolderPanel kind="affiliate" accountId={accountId} folders={folders}
      onChanged={async () => { await reloadFolders(); await loadList() }} canManage={!readonly} createAction={createButton(true)}
      itemLabel="アフィリエイター" activeId={folderId} onSelect={chooseFolder}
      allCount={ready ? rows.length : null} error={folderError}
      unfiledCount={ready ? rows.filter(row => !row.folderId).length : null}
      countOf={folder => ready ? rows.filter(row => row.folderId === folder.id).length : null}
      onDeleted={id => { if (folderId === id) chooseFolder('all'); void loadList() }} />
  )
  const folderMove = useFolderMove({ accountId, canEdit: !readonly, items: pagedRows, folders,
    move: async (row, targetId) => { const result = await api.affiliates.update(row.id, { folderId: targetId }); if (!result.success) throw new Error(result.error) },
    onChanged: async () => { await loadList(); await reloadFolders() },
  })

  const folderSelect = (
    <div className={styles.narrowFolder}>
      <SaveErrorField names={["group"]}><Select
        aria-label="報酬の決め方"
        value={group}
        options={GROUPS.map((item) => ({ value: item.key, label: item.key === 'all' || !ready ? item.label : `${item.label} ${groupCount(item.key)}` }))}
        onChange={(value) => resetPage(() => setGroup(value as GroupKey))}
      /></SaveErrorField>
    </div>
  )

  const chips = (
    <div role="group" aria-label="状態で絞り込む" className={styles.chipGroup}>
      <FilterChip
        selected={filters.includes('active')}
        icon={<CircleDot size={16} aria-hidden="true" />}
        onChange={(on) => toggleFilter('active', on)}
      >
        {ready ? `計測中 ${formatNumber(activeCount)}` : '計測中'}
      </FilterChip>
      <FilterChip
        selected={filters.includes('reward')}
        icon={<Banknote size={16} aria-hidden="true" />}
        onChange={(on) => toggleFilter('reward', on)}
      >
        {ready ? `報酬あり ${formatNumber(rewardCount)}` : '報酬あり'}
      </FilterChip>
    </div>
  )

  const trailing = (
    <>
      <SavedSelect
        value={saved}
        options={SAVED_VIEWS.map((view) => ({ value: view.value, label: view.label }))}
        onChange={(value) => {
          const view = SAVED_VIEWS.find((v) => v.value === value)
          if (!view) return
          resetPage(() => {
            setSaved(value)
            setFilters([...view.filters])
            setSort(view.sort)
            setGroup(view.group ?? 'all')
          })
        }}
      />
      <PerPageSelect value={pageSize} onChange={(value) => resetPage(() => setPageSize(value))} />
    </>
  )

  const notices = (
    <ToolbarNotices
      info={approvalState === 'ready' && pendingCount > 0
        ? `承認待ちの成果が ${formatNumber(pendingCount)} 件あります。「成果承認」で認めると、次の締めで報酬に入ります。`
        : undefined}
    />
  )

  const toolbar = (
    <AffiliateToolbar
      narrow={narrow}
      notices={notices}
      search={{ placeholder: '名前・紹介コードで探す', value: query, onChange: (value) => resetPage(() => setQuery(value)) }}
      chips={<><ListToolbarOptional compact label="報酬の決め方">{folderSelect}</ListToolbarOptional>{chips}</>}
      trailing={trailing}
      narrowLead={<>{createButton(false)}{folderSelect}</>}
    />
  )

  const allChecked = pagedRows.length > 0 && pagedRows.every((row) => selected.has(row.id))
  const setChecked = (ids: string[], checked: boolean) => setSelected((cur) => {
    const next = new Set(cur)
    for (const id of ids) {
      if (checked) next.add(id)
      else next.delete(id)
    }
    return next
  })

  const table = (
    <div className={styles.tableWrap}>
      <DataTable columnLayout={AFFILIATE_TABLE_LAYOUT}>
        <thead>
          <TableHeadRow data-table-layout="columns">
            <Th className={styles.colCheck}>
              {readonly ? <UnavailableSelection label="このページの全員を選ぶ" /> : (
                <SaveErrorField names={["allChecked","checked","all_checked"]}><Checkbox
                  aria-label="このページの全員を選ぶ"
                  checked={allChecked}
                  onCheckedChange={(checked) => setChecked(pagedRows.map((row) => row.id), checked)}
                /></SaveErrorField>
              )}
            </Th>
            <Th grow>アフィリエイター</Th>
            <Th className={styles.colState}>状態</Th>
            <Th align="right" className={styles.colLinks}>紹介リンク</Th>
            <Th collapseAt="narrow" align="right" className={styles.colFriends}>友だち追加</Th>
            <Th align="right" className={styles.colConv}>成果</Th>
            <Th align="right" className={styles.colReward}>報酬</Th>
            <Th className={styles.colOps}>操作</Th>
          </TableHeadRow>
        </thead>
        <tbody>
          {pagedRows.map((row, saveFieldIndex) => (
            <Tr selected={selected.has(row.id)} key={row.id} data-table-layout="columns" data-row-id={row.id} detailKey="affiliate" onOpen={() => { setDrawerId(current => current === row.id ? null : row.id); setDrawerEdit(false) }}>
              <Td className={styles.colCheck}>
                {readonly ? <UnavailableSelection label={`${row.name}を選ぶ`} /> : (
                  <SaveErrorField names={[`pagedRows.${saveFieldIndex}.id`,"id","row.id","checked"]}><Checkbox
                    aria-label={`${row.name}を選ぶ`}
                    checked={selected.has(row.id)}
                    onCheckedChange={(checked) => setChecked([row.id], checked)}
                  /></SaveErrorField>
                )}
              </Td>
              <Td grow>
                <span className={narrow ? styles.stack : `${styles.stack} ${styles.dotStack}`}>
                  <FolderDotName folder={folderDotFor(folders, row.folderId)}>
                    {nameButton(row)}
                  </FolderDotName>

                </span>
              </Td>
              <Td className={styles.colState}><StatusBadge tone={row.isActive ? 'success' : 'neutral'}>{row.isActive ? '計測中' : '停止中'}</StatusBadge></Td>
              <Td align="right" className={styles.colLinks}><span className={styles.cellNum}>{`${formatNumber(row.linkCount)}本`}</span></Td>
              <Td collapseAt="narrow" align="right" className={styles.colFriends}><span className={styles.cellNum}>{`${formatNumber(row.friendAdds)} 人`}</span></Td>
              <Td align="right" className={styles.colConv}><span className={styles.cellNum}>{`${formatNumber(row.totalConversions)} 件`}</span></Td>
              <Td align="right" className={styles.colReward}><span className={styles.cellNum}>{formatYen(row.rewardAmount)}</span></Td>
              <Td className={styles.colOps}>
                <span className={styles.rowActions}>
                  <Button type="button" onClick={() => openDrawer(row.id, false)}>成果を見る</Button>
                  <RowMenu
                    label={`${row.name}の操作`}
                    items={[
                      { id: 'copy', label: '紹介リンクをコピー', content: <CopyTextButton role="menuitem" label="紹介リンクをコピー" value={row.id} getValue={() => copyFirstLink(row)} aria-label="紹介リンクをコピー" />, onSelect: () => {} },
                      ...(readonly ? [] : [
                        { id: 'move', label: 'フォルダへ移す', onSelect: () => folderMove.open(row) },
                        { id: 'edit', label: '編集', onSelect: () => openDrawer(row.id, true) },
                        ...(row.isActive ? [{ id: 'archive', label: '紹介を止める', tone: 'danger' as const, dividerBefore: true, onSelect: () => setArchiveTarget({ id: row.id, name: row.name }) }] : [{ id: 'resume', label: '紹介を再開する', onSelect: () => { setResumeError(''); setResumeTarget({ id: row.id, name: row.name }) } }]),
                      ]),
                    ]}
                  />
                </span>
              </Td>
            </Tr>
          ))}
        </tbody>
      </DataTable>
    </div>
  )

  const body = loadState === 'loading' ? (
    <ListState kind="loading" title="アフィリエイターを読み込んでいます" />
  ) : loadState === 'error' ? (
    <StateCard
      tone="error"
      title="アフィリエイターを読み込めませんでした"
      description="数の帯は「—」にしています。道具はそのまま使えます。"
      action={<RetryButton onRetry={() => { void loadList() }} />}
    />
  ) : shownRows.length === 0 ? (
    /* 修正案 D-2：空の一覧。 */
    <EmptyList
      icon={<Users aria-hidden="true" />}
      title="まだアフィリエイターがいません"
      description="紹介してくれる人を登録して、その人だけの紹介リンクを作ります。"
      create={{ label: '最初のアフィリエイターを登録する', href: '/affiliates/new' }}
      canCreate={!readonly}
      filtered={rows.length > 0}
      onClearFilters={resetConditions}
    />
  ) : (
    <>
      {table}
      <BulkBar count={readonly ? 0 : selected.size} total={shownRows.length} onSelectAll={() => setSelected(new Set(shownRows.map(item => item.id)))} unit="人" hint="対象を確認してから操作を選んでください">
        <Button type="button" onClick={() => { bulkArchiveAccount.current = accountId; bulkArchiveTargets.current = bulkTargets; setBulkError(''); setBulkConfirm(true) }} disabled={bulkTargets.length === 0}>まとめて紹介を止める</Button>
        <Button type="button" onClick={() => setSelected(new Set())}>選ぶのをやめる</Button>
      </BulkBar>
    </>
  )

  const pager = ready && shownRows.length > 0 ? (
    <ListPagePagination>
      <Pagination page={currentPage} pageCount={pageCount} onPageChange={setPage} range={{ total: shownRows.length, first: (currentPage - 1) * pageSize + 1, last: Math.min(currentPage * pageSize, shownRows.length), unit: '人' }} />
    </ListPagePagination>
  ) : undefined

  async function resumeReferral() {
    if (!resumeTarget || resuming || readonly) return
    setResuming(true); setResumeError('')
    try {
      const result = await api.affiliates.update(resumeTarget.id, { isActive: true })
      if (!result.success) throw new Error(result.error)
      setResumeTarget(null)
      notifyToast('紹介を再開しました')
      await loadList()
    } catch (cause) { if (!saveErrors.capture(cause)) setResumeError('紹介を再開できませんでした。状態を読み直してお試しください。') }
    finally { setResuming(false) }
  }

  function nameButton(row: { id: string; name: string }) {
    return (
      <RowNameLink onOpen={() => openDrawer(row.id, false)} href={itemHref('affiliate', row.id)} title={row.name}>
        {row.name}
      </RowNameLink>
    )
  }
  const drawerRow = drawerId ? rows.find((row) => row.id === drawerId) ?? null : null

  return (
    <SaveErrorScope errors={saveErrors}><AffiliateFrame
      actions={
        <>
        <Button type="button" onClick={() => setMonthlyFlowOpen(true)}>今月の流れを確認</Button>
        <Button onClick={exportCsv} disabled={shownRows.length === 0}>
          <Download size={16} aria-hidden="true" /> CSVで書き出す
        </Button>
        </>
      }
      stats={stats}
      folderNav={{ rows: managedFolderNavRows('affiliate', folders), activeId: folderId, onSelect: chooseFolder, createAction: readonly ? undefined : createButton(false) }}
      folders={folderPanel}
      toolbar={toolbar}
      pagination={pager}
      overlays={<>
        {folderMove.overlays}
        <MonthlyFlow open={monthlyFlowOpen} accountId={accountId} onClose={() => setMonthlyFlowOpen(false)} />
        <ConfirmDialog open={resumeTarget !== null} title={`「${resumeTarget?.name ?? ''}」の紹介を再開しますか？`} description="紹介リンクからの成果を再び数えます。" confirmLabel="紹介を再開する" busy={resuming} error={resumeError} onConfirm={() => void resumeReferral()} onCancel={() => { if (!resuming) setResumeTarget(null) }} />
        <AffiliateArchiveDialog
          target={archiveTarget}
          accountId={accountId}
          onClose={() => setArchiveTarget(null)}
          onChanged={() => { void loadList() }}
        />
        <ConfirmDialog
          open={bulkConfirm}
          title={`${formatNumber(bulkArchiveTargets.current.length)} 人の紹介をまとめて止めますか？`}
          description="止めると、その人たちの紹介リンクからの成果はこれから数えません。承認待ちの成果がある人は、行の「…」から個別に中身を確認して止めてください。"
          confirmLabel="まとめて止める"
          confirmIcon={<Pause size={16} aria-hidden="true" />}
          destructive
          busy={bulkBusy}
          error={bulkError || undefined} onSuccess={() => setBulkConfirm(false)} onConfirm={() => runBulkArchive()}
          onCancel={() => { setBulkConfirm(false); void loadList() }}
        ><OperationTargetSummary accounts={[{ id: bulkArchiveAccount.current ?? '' }]} /></ConfirmDialog>
        {drawerRow ? (
          <AffiliateDrawer
            affiliate={drawerRow}
            accountId={accountId}
            readonly={readonly}
            startInEdit={drawerEdit}
            linkBaseUrl={linkBaseUrl}
            onClose={() => {
              setDrawerId(null)
            }}
            onChanged={() => { void loadList(); void loadApprovals({ fresh: true }) }}
            onStopRequest={(id, name) => setArchiveTarget({ id, name })}
          />
        ) : null}
      </>}
    >
      {body}
    </AffiliateFrame></SaveErrorScope>
  )
}
