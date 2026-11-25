'use client'
import { DetailContent, DetailField } from '@/components/shared/detail-content'
import ListDateTime from '@/components/shared/list-date-time'
import { canChangeBroadcastNow, canEditBroadcastNow, canManageBroadcastListNow, captureBroadcastWriteAccess, isFromHeadquarters, useBroadcastEditAccess, useBroadcastManagementAccess } from './write-access'
import DetailPanel, { useDetailPanelUrl } from '@/components/shared/detail-panel';
import { canManageRole, useStaffRole } from '@/lib/staff-role';
import { ListToolbarFrame, ListToolbarRow, ListToolbarSearchSlot, ListToolbarSort, ListToolbarEnd, ListToolbarOptional } from '@/components/shared/list-toolbar';
import { RowNameLink } from '@/components/shared/table';



import SharedStatusBadge from '@/components/shared/status-badge'
import SharedStatusPill from '@/components/shared/status-pill'
import { useListUrlValue, useListScrollMemory, useListUrlParam } from '@/components/shared/list-url-state';
import { RovingTbody } from '@/components/shared/row-roving';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Bookmark, CalendarClock, CalendarDays, ChevronDown, Copy, FileText, Gauge, List as ListIcon, Lock, MailOpen, Plus, Send, SendHorizontal, UserCheck } from 'lucide-react';

import { useBroadcastFolderSelection } from './folder-selection'
import Link from '@/components/shared/list-navigation'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation';
import { ArrowUpDown, Eye, Folder as FolderIcon } from 'lucide-react';
import type { Folder, Tag } from '@line-crm/shared';
import { ApiError, api, type ApiBroadcast, type BroadcastInsight, type BroadcastListKpis, type BroadcastSavedView } from '@/lib/api';
import { loadFailureNotice, permissionDeniedMessage } from '@/components/shared/api-error-message';
import { useAccount } from '@/contexts/account-context';
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome';
import { useNarrowViewport } from '@/lib/use-narrow-viewport';
import { ListPage, ListPagePagination } from '@/components/templates';
import BroadcastForm from '@/components/broadcasts/broadcast-form-lazy'
import FolderPanel, { FolderPanelNote, type FolderPanelRow } from '@/components/shared/folder-panel';
import { FolderDotName } from '@/components/shared/folder-dot';
import FolderAddDialog from '@/components/shared/folder-add-dialog'
import { useManagedFolders } from '@/components/shared/managed-folder-panel'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import ActionMenu, { type ActionMenuItem } from '@/components/shared/action-menu';
import BulkBar, { useEscapeToClearSelection } from '@/components/shared/bulk-bar';
import Checkbox, { UnavailableSelection } from '@/components/shared/checkbox';
import { RowMenu } from '@/components/shared/row-actions';
import ContextMenu, { type ContextMenuItem } from '@/components/shared/context-menu';
import { withViewTransition } from '@/components/shared/view-transition';
import Select from '@/components/shared/select'
import Button from '@/components/shared/button'
import EmptyList from '@/components/shared/empty-list'
import DateField from '@/components/shared/date-field'
import SearchField from '@/components/shared/search-field'
import SegmentedControl from '@/components/shared/segmented'
import FilterChip from '@/components/shared/filter-chip'
import { FilterPopover } from '@/components/shared/filter-popover'
import { useRowLeaving } from '@/lib/use-row-leaving'
import { rowPrimary } from '@/components/shared/row-roving'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import Pagination from '@/components/shared/pagination'
import { DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table';
import { DelayedSkeleton, Skeleton } from '@/components/shared/skeleton';
import { audienceSummary, messageTypeLabel } from '@/lib/broadcast-summary';
import { runOptimistic } from '@/lib/undoable';
import { notifyToast } from '@/components/shared/toast'
import { formatDateTime, formatNumber } from '@/lib/format';
import { terms } from '@/lib/terms';
import QuickSendV8 from './quick-send'
import styles from './list.module.css'
import { emptyValue, EmptyCell } from '@/components/shared/empty-value';
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors';
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { RefreshCover } from '@/components/shared/refresh-cover'
import { useListSnapshot } from '@/lib/use-list-snapshot'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import { TextField as SharedTextField } from '@/components/shared/text-field'

/*
 * ★V8 一斉配信の一覧（Pencil ・1152 は ・閲覧のみは ）。
 *
 * 今までの V8 一覧（app/broadcasts/list-v8.tsx）の動きを写し、見た目は
 * 型（ListPage）と共通部品で一から組み直した。データの口・保存先は今と同じ。
 * 動きの一覧は同じ場所の BEHAVIOR.md。
 */

/** 未分類を表す印。空文字は「すべて」なので別の値にする。 */
const UNFILED = '__unfiled__'
// 検索APIがないため100件ずつ取得。上限超過は不完全な結果を出さず、条件を絞るよう案内する。
const SEARCH_LIMIT = 10_000
const EDIT_KEY = 'broadcast.definition.edit'

/**
 * サーバが「運用担当」と答えたときは、配信の編集キーを持つかだけを見る。
 * 手元の役割（lh_staff_role）は古いことがあるので、ここでは読まない。
 */
function hasStaffEditKey(permission: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem('lh_staff_permissions') ?? '[]')
    return Array.isArray(parsed) && parsed.includes(permission)
  } catch {
    return false
  }
}

/**
 * 絞り込みの札：すべて・予約中・下書き・承認待ち・送信済み・エラー。
 * 札は 10 の状態（displayStatus）で絞る。
 */
type StatusChipKey = 'all' | 'scheduled' | 'draft' | 'pending_approval' | 'sent' | 'error'

const STATUS_CHIPS: Array<{ key: StatusChipKey; label: string; icon: typeof CalendarClock; query: string }> = [
  { key: 'all', label: 'すべて', icon: ListIcon, query: '' },
  { key: 'scheduled', label: '予約中', icon: CalendarClock, query: 'scheduled' },
  { key: 'draft', label: '下書き', icon: FileText, query: 'draft' },
  { key: 'pending_approval', label: '承認待ち', icon: UserCheck, query: 'pending_approval' },
  { key: 'sent', label: '送信済み', icon: SendHorizontal, query: 'sent' },
  { key: 'error', label: 'エラー', icon: AlertCircle, query: 'failed,partial_failed' },
]

function chipCount(statusCounts: Record<string, number> | null, key: StatusChipKey): number | null {
  if (!statusCounts) return null
  if (key === 'all') return statusCounts.all ?? null
  if (key === 'error') return (statusCounts.failed ?? 0) + (statusCounts.partial_failed ?? 0)
  return statusCounts[key] ?? null
}

/** 状態の札の色。10 の状態を5色に畳む（色は CSS の data-tone）。 */
const BADGE_TONE: Record<string, 'neutral' | 'info' | 'warning' | 'caution' | 'success' | 'danger'> = {
  draft: 'neutral',
  pending_approval: 'caution',
  scheduled: 'info',
  preparing: 'info',
  sending: 'warning',
  sent: 'success',
  partial_failed: 'warning',
  failed: 'danger',
  stopped: 'neutral',
  expired: 'neutral',
}

function percent(rate: number | null | undefined): string | null {
  return rate != null ? `${(rate * 100).toFixed(1)}%` : null
}

/** R4：受け付けた数。宛先のタブの札と同じ言葉と出し方。届いたとは言わない。 */
function acceptedCountText(count: number): string {
  return `${terms.W07}：${formatNumber(count)}人`
}

/**
 * 結果の列。広い幅は「届いた・開封・クリック」の3列で右にそろえ、狭い幅（1280 以下）は
 * 1列の2段（上に人数・下に開封とクリック）。どちらも省略しない。
 * まだ送っていない配信は数を作らず — にする（0件・0人は「届かなかった」に読める）。
 * R4：届いたと言えるのはLINE集計がある時だけ。無い時は受け付けた数を
 * 受け付けの言葉（宛先のタブと同じ）で出す。
 */
function BroadcastResultCells({ broadcast, insight, narrow }: { broadcast: ApiBroadcast; insight: BroadcastInsight | undefined; narrow: boolean }) {
  const sent = broadcast.status === 'sent'
  /* 集計なしの受け付け数は、列に収めるため数だけ出す。説明の全文は title に残す。 */
  const acceptedFull = !sent ? null : insight?.delivered == null ? acceptedCountText(broadcast.successCount) : null
  const delivered = !sent ? null : insight?.delivered != null
    ? `${formatNumber(insight.delivered)} 人`
    : `${formatNumber(broadcast.successCount)} 人`
  const open = sent ? percent(insight?.openRate) : null
  const click = sent ? percent(insight?.clickRate) : null
  if (!narrow) {
    return (
      <>
        <Td align="right"><span className={styles.resultNumber} title={acceptedFull ?? undefined}>{delivered ?? emptyValue('unknown')}</span></Td>
        <Td align="right"><span className={styles.resultNumber}>{open ?? emptyValue('unknown')}</span></Td>
        <Td align="right"><span className={styles.resultNumber}>{click ?? emptyValue('unknown')}</span></Td>
      </>
    )
  }
  return (
    <Td align="right">
      {delivered === null ? <span className={styles.cellMain}>{emptyValue('unknown')}</span> : (
        <>
          <span className={styles.resultMain} title={acceptedFull ?? undefined}>{delivered}</span>
          {open !== null || click !== null ? (
            <span className={styles.resultSub}>{[open !== null ? `開封 ${open}` : '', click !== null ? `クリック ${click}` : ''].filter(Boolean).join('・')}</span>
          ) : null}
        </>
      )}
    </Td>
  )
}

function StatusBadge({ broadcast }: { broadcast: ApiBroadcast }) {
  const key = broadcast.displayStatus ?? broadcast.status
  const label = broadcast.displayStatusLabel ?? key
  return (
    <SharedStatusPill tone={BADGE_TONE[key] ?? 'neutral'}>{label}</SharedStatusPill>
  )
}

function dateRangeLabel(dateFrom: string, dateTo: string): string {
  if (!dateFrom && !dateTo) return '配信日：指定なし'
  if (dateFrom && dateTo) return `配信日：${dateFrom}〜${dateTo}`
  return `配信日：${dateFrom || dateTo}〜`
}

function summaryInsight(summary: ApiBroadcast['insightSummary']): BroadcastInsight | undefined {
  if (!summary) return undefined
  if (summary.delivered == null && summary.uniqueImpression == null
    && summary.uniqueClick == null && summary.openRate == null && summary.clickRate == null) {
    return undefined
  }
  return {
    delivered: summary.delivered,
    uniqueImpression: summary.uniqueImpression,
    uniqueClick: summary.uniqueClick,
    uniqueMediaPlayed: null,
    openRate: summary.openRate,
    clickRate: summary.clickRate,
  }
}

/** 名前の横の「統括から」の札と鍵（店では変えられない印。l3RQH）。 */
function HqMark() {
  return (
    <span className={styles.hqMark} title="統括から送った配信です。店では変えられません（見る・複製するだけ）">
      <span className={styles.hqChip}>統括から</span>
      <Lock size={16} aria-label="店では変えられません" className={styles.hqLock} />
    </span>
  )
}

export default function BroadcastListV8() {
  const saveErrors = useSaveFormErrors()
  usePageTitle('一斉配信')
  const router = useRouter()
  const { selectedAccountId } = useAccount()
  const accountScope = useRef({ id: selectedAccountId, generation: 0 })
  if (accountScope.current.id !== selectedAccountId) accountScope.current = { id: selectedAccountId, generation: accountScope.current.generation + 1 }
  /* かんたんに送る（板 ）の窓。 */
  const [quickSendOpen, setQuickSendOpen] = useState(false)
  const staffRole = useStaffRole()
  const narrow = useNarrowViewport()
  /*
   * 閲覧のみ：作る・保存する・フォルダを足す・…の変える項目は押せない形にする。
   * 役割が読めていない間は、理由を作らずに無効にする。
   * 管理者・オーナーと、配信の編集キーを持つ運用担当が変えられる（役割はサーバの答え）。
   */
  const editAccess = useBroadcastEditAccess()
  const canEdit = editAccess.allowed
  const management = useBroadcastManagementAccess()

  const [tags, setTags] = useState<Tag[]>([])
  const [scenarios, setScenarios] = useState<Array<{ id: string; name: string }>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [forbidden, setForbidden] = useState(false)
  /* 絞り込み・検索語は URL に置く（戻ると同じ一覧に戻る。動きの点検 5 番）。 */
  const [statusParam, setStatusParam] = useListUrlParam('status', 'all')
  const statusFilter: StatusChipKey = STATUS_CHIPS.some((chip) => chip.key === statusParam) ? (statusParam as StatusChipKey) : 'all'
  const setStatusFilter = setStatusParam as (next: StatusChipKey) => void
  const [showCreate, setShowCreate] = useState(false)
  /*
   * 作る画面は一覧と同じ URL のまま開くので、上の帯のパンくずの「一斉配信」で一覧へ戻す
   * （板の頭の「← 一斉配信一覧」は 2026-10-08 に無くした）。書きかけなら確かめてから戻る。
   */
  usePageCrumbs(showCreate
    ? [{ label: '一斉配信', href: '/broadcasts', onSelect: () => setShowCreate(false) }]
    : [{ label: 'ホーム', href: '/' }])
  const [openTemplatePicker, setOpenTemplatePicker] = useState(false)
  const [createMenuOpen, setCreateMenuOpen] = useState(false)
  const createAnchorRef = useRef<HTMLElement | null>(null)
  const [titleQuery, setTitleQuery] = useListUrlParam('q')
  const [savedViewId, setSavedViewId] = useState('')
  const [dateFrom, setDateFrom] = useListUrlValue('dateFrom', '')
  const [dateTo, setDateTo] = useListUrlValue('dateTo', '')
  const [datePopoverOpen, setDatePopoverOpen] = useState(false)
  const { leave, isLeaving } = useRowLeaving()
  const { folders, unfiledCount, error: folderLoadError, reload: loadFolders } = useManagedFolders('broadcast', selectedAccountId)
  const [folderFilter, setFolderFilter] = useListUrlParam('folder')
  const [folderDialogOpen, setFolderDialogOpen] = useState(false)
  const [editingFolder, setEditingFolder] = useState<Folder | null>(null)
  const [deletingFolder, setDeletingFolder] = useState<Folder | null>(null)
  const [folderDeleteScope, setFolderDeleteScope] = useState<typeof accountScope.current | null>(null)
  const folderDeleteTicket = useRef<object | null>(null)
  const renderedFolderDeleteTicket = folderDeleteTicket.current
  const [folderBusy, setFolderBusy] = useState(false)
  const [folderActionError, setFolderError] = useState('')
  const folderError = folderActionError || folderLoadError
  /* 行を選んでまとめてフォルダへ移す（左の選ぶ欄）。選ぶのはこのページの行だけ。 */
  const bulkAnchorRef = useRef<HTMLButtonElement | null>(null)
  const [insights, setInsights] = useState<Record<string, BroadcastInsight>>({})
  const [pageSize, setPageSize] = useListUrlValue('pageSize', 20)
  const [sortKey, setSortKey] = useListUrlValue<'newest' | 'oldest'>('sortKey', 'newest')
  const [page, setPage] = useListUrlValue('page', 1)
  const [deleteTarget, setDeleteTarget] = useState<ApiBroadcast | null>(null)
  const deleteScope = useRef<{ generation: number } | null>(null)
  const renderedDeleteScope = deleteScope.current
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const [panelId, setPanelId] = useDetailPanelUrl('broadcast')
  const [menuMoveFor, setMenuMoveFor] = useState<string | null>(null)
  /* 「フォルダへ移す」を選んだ直後の onClose は2段目への切り替えなので閉じない。 */
  const keepMenuOpenRef = useRef(false)
  const [moving, setMoving] = useState(false)
  const [savedViews, setSavedViews] = useState<BroadcastSavedView[]>([])
  const [savedViewsSeq, setSavedViewsSeq] = useState(0)
  const [savedMenuOpen, setSavedMenuOpen] = useState(false)
  const savedAnchorRef = useRef<HTMLElement | null>(null)
  const [savedViewName, setSavedViewName] = useState('')
  const [savedViewOpen, setSavedViewOpen] = useState(false)
  const [savedViewBusy, setSavedViewBusy] = useState(false)
  const [savedViewError, setSavedViewError] = useState('')

  const listScope = JSON.stringify([selectedAccountId, statusFilter, folderFilter, dateFrom, dateTo, titleQuery, titleQuery.trim() ? null : page, pageSize])
  const { value: broadcasts, setValue: setBroadcasts, hasValue: listLoaded } = useListSnapshot<ApiBroadcast[]>(listScope, [])
  const { value: listKpis, setValue: setListKpis } = useListSnapshot<BroadcastListKpis | null | undefined>(listScope, undefined)
  const { value: statusCounts, setValue: setStatusCounts } = useListSnapshot<Record<string, number> | null>(listScope, null)
  const { value: listTotal, setValue: setListTotal } = useListSnapshot<number | null>(listScope, null)
  const [quota, setQuota] = useState<{ limit: number | null; used: number | null; unlimited: boolean; reason: 'not_connected' | 'fetch_failed' | null } | null>(null)
  const [quotaLoading, setQuotaLoading] = useState(false)

  const listRequestKey = JSON.stringify([listScope, sortKey])
  const currentListRequest = useRef(listRequestKey)
  currentListRequest.current = listRequestKey

  /* 一覧同梱の集計が無い送信済みだけ1回ずつ取る（管理画面 と同じ補充）。 */
  const fetchedInsightIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const missing = broadcasts.filter((b) =>
      b.status === 'sent'
      && !insights[b.id]
      && !summaryInsight(b.insightSummary)
      && !fetchedInsightIdsRef.current.has(b.id))
    if (missing.length === 0) return
    missing.forEach((b) => {
      fetchedInsightIdsRef.current.add(b.id)
      api.broadcasts.getInsight(b.id).then((res) => {
        if (res.success && res.data) {
          setInsights((prev) => ({ ...prev, [b.id]: res.data as BroadcastInsight }))
        }
      }).catch(() => undefined)
    })
  }, [broadcasts, insights])



  const moveFolderOrder = async (index: number, direction: -1 | 1) => {
    const target = folders[index]
    const neighbor = folders[index + direction]
    if (!canManageBroadcastListNow()) { setFolderError('権限が変わったため、フォルダの並べ替えを中止しました。'); return }
    if (!target || !neighbor || folderBusy) return
    setFolderBusy(true)
    setFolderError('')
    try {
      const result = await api.folders.swapOrder(target.id, neighbor.id)
      if (!result.success) throw new Error(result.error)
      await loadFolders()
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setFolderError('並び順を変えられませんでした。') }
    } finally {
      setFolderBusy(false)
    }
  }

  const removeFolder = async () => {
    if (!canManageBroadcastListNow()) { setFolderError('権限が変わったため、フォルダの削除を中止しました。'); return }
    if (!deletingFolder || folderBusy || !renderedFolderDeleteTicket || renderedFolderDeleteTicket !== folderDeleteTicket.current || folderDeleteScope !== accountScope.current) return
    const scope = folderDeleteScope
    const ticket = renderedFolderDeleteTicket
    const targetId = deletingFolder.id
    setFolderBusy(true)
    setFolderError('')
    try {
      const res = await api.folders.delete(targetId)
      if (!res.success) throw new Error(res.error)
      if (scope !== accountScope.current || ticket !== folderDeleteTicket.current) return
      folderDeleteTicket.current = null
      setDeletingFolder(null)
      if (folderFilter === targetId) setFolderFilter('')
      await loadFolders()
    } catch (saveFailure) {
      if (scope !== accountScope.current || ticket !== folderDeleteTicket.current) return
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setFolderError('フォルダを削除できませんでした。時間をおいて、もう一度お試しください。') }
    } finally {
      setFolderBusy(false)
    }
  }

  /* ページ送りは口側の cursor（= オフセット）。条件を変えたら一覧の口だけ取り直す。 */
  /* 遅れて返った前の条件の答えで、今の一覧を上書きしない（URL から条件が入る直後など）。 */
  const loadSeqRef = useRef(0)
  const loadList = useCallback(async (cursor = 0) => {
    const seq = ++loadSeqRef.current
    const stale = () => seq !== loadSeqRef.current || currentListRequest.current !== listRequestKey
    setLoading(true)
    setError('')
    setForbidden(false)
    let searchError: string | undefined
    const stopSearch = (message: string): never => {
      searchError = message
      throw new Error(message)
    }
    try {
      const chip = STATUS_CHIPS.find((item) => item.key === statusFilter)
      const searching = titleQuery.trim() !== ''
      const params = {
        accountId: selectedAccountId || undefined,
        limit: searching ? 100 : pageSize,
        cursor: searching ? 0 : cursor,
        displayStatus: chip && chip.query !== '' ? chip.query : undefined,
        folderId: folderFilter === UNFILED ? 'unfiled' : folderFilter || undefined,
        sort: sortKey,
        from: dateFrom || undefined,
        to: dateTo || undefined,
      }
      const res = await api.broadcasts.list(params)
      if (searching && res.success) {
        if ((res.pagination?.total ?? res.data.length) > SEARCH_LIMIT) {
          stopSearch('検索できる上限は10,000件です。状態・フォルダ・配信日で絞ってから検索してください。')
        }
        const rows = [...res.data]
        let nextCursor = res.pagination?.nextCursor
        const seen = new Set<string>()
        while (nextCursor != null) {
          if (stale()) return
          if (seen.has(nextCursor) || rows.length >= SEARCH_LIMIT) stopSearch('検索結果を読み込めませんでした。条件を絞ってから再試行してください。')
          seen.add(nextCursor)
          const next = await api.broadcasts.list({ ...params, cursor: Number(nextCursor) })
          if (!next.success) throw new Error(next.error)
          rows.push(...next.data)
          if (rows.length > SEARCH_LIMIT) stopSearch('検索できる上限は10,000件です。条件を絞ってください。')
          nextCursor = next.pagination?.nextCursor
        }
        res.data = rows
      }
      if (stale()) return
      if (res.success) {
        setBroadcasts(res.data)
        setListKpis(res.kpis)
        setStatusCounts(res.statusCounts ?? null)
        setListTotal(res.pagination?.total ?? null)
      } else {
        setError(res.error)
      }
    } catch (err) {
      if (stale()) return
      const fieldFailure = saveErrors.capture(err);

      if (err instanceof ApiError && err.status === 403) setForbidden(true)
      else { if (!fieldFailure)


 setError(searchError || loadFailureNotice(err, '一斉配信')) }
    } finally {
      if (!stale()) setLoading(false)
    }
  }, [selectedAccountId, pageSize, sortKey, statusFilter, folderFilter, dateFrom, dateTo, titleQuery, saveErrors, listScope, listRequestKey, setBroadcasts, setListKpis, setStatusCounts, setListTotal])
  /* 戻ってきたら前のスクロール位置へ（中身が描けてから）。 */
  useListScrollMemory(!loading)

  /* タグ・シナリオは宛先の名前解決だけ。アカウントが変わったときだけ取り直す。 */
  const loadCandidates = useCallback(async () => {
    try {
      const [tagsRes, scenariosRes] = await Promise.all([
        api.tags.list(selectedAccountId ? { accountId: selectedAccountId } : undefined),
        api.scenarios.list(selectedAccountId ? { accountId: selectedAccountId } : undefined).catch(() => null),
      ])
      if (tagsRes && tagsRes.success) setTags(tagsRes.data)
      if (scenariosRes && scenariosRes.success) {
        setScenarios(scenariosRes.data.map((item) => ({ id: item.id, name: item.name })))
      }
    } catch (saveFailure) {
      saveErrors.capture(saveFailure)
      // 名前が引けない行はID表示に倒す（一覧の取得とは別物）。
    }
  }, [selectedAccountId, saveErrors])

  const listCursor = titleQuery.trim() ? 0 : (page - 1) * pageSize
  useEffect(() => {
    void loadList(listCursor)
    return () => { loadSeqRef.current += 1 }
  }, [loadList, listCursor])

  useEffect(() => { void loadCandidates() }, [loadCandidates])

  const goPage = (next: number) => {
    setPage(next)
  }

  /* 今月の送信枠（ダッシュボードの口から quota を借りる。上限なし・読み込み中・失敗を分ける）。 */
  useEffect(() => {
    if (!selectedAccountId) {
      setQuota(null)
      setQuotaLoading(false)
      return
    }
    let cancelled = false
    setQuota(null)
    setQuotaLoading(true)
    api.dashboard.overview({ accountId: selectedAccountId })
      .then((res) => {
        if (cancelled) return
        setQuotaLoading(false)
        if (!res.success) return
        const metric = res.data.metrics?.monthlyQuota
        const rawReason = metric?.reason ?? res.data.sections?.quota?.reason ?? null
        const reason = rawReason === 'not_connected' || rawReason === 'fetch_failed' ? rawReason : null
        if (metric === undefined || metric === null) {
          setQuota({ limit: res.data.delivery.quotaLimit, used: res.data.delivery.quotaUsed, unlimited: false, reason })
        } else {
          setQuota({ limit: metric.value?.limit ?? null, used: metric.value?.used ?? null, unlimited: metric.value?.unlimited === true, reason })
        }
      })
      .catch(() => { if (!cancelled) setQuotaLoading(false) })
    return () => { cancelled = true }
  }, [selectedAccountId])

  useEffect(() => {
    if (!selectedAccountId) {
      setSavedViews([])
      return
    }
    let cancelled = false
    setSavedViewError('')
    api.broadcasts.savedViews.list(selectedAccountId).then((res) => {
      if (cancelled) return
      if (res.success) setSavedViews(res.data)
      else setSavedViewError('保存した検索を読み込めませんでした。')
    }).catch(() => {
      if (!cancelled) setSavedViewError('保存した検索を読み込めませんでした。')
    })
    return () => { cancelled = true }
  }, [selectedAccountId, savedViewsSeq])

  const applySavedView = (id: string) => {
    const view = savedViews.find((item) => item.id === id)
    if (!view) return
    setSavedViewId(id)
    const filters = view.filters
    const legacyStatuses = Array.isArray(filters.statuses) ? filters.statuses : []
    const legacyStatus = STATUS_CHIPS.find(chip => legacyStatuses.includes(chip.key)
      || (chip.key === 'error' && legacyStatuses.some(status => status === 'failed' || status === 'partial_failed')))?.key
    setTitleQuery(typeof filters.titleQuery === 'string' ? filters.titleQuery : '')
    setStatusFilter(STATUS_CHIPS.some(chip => chip.key === filters.statusFilter)
      ? filters.statusFilter as StatusChipKey : legacyStatus ?? 'all')
    setPageSize(filters.pageSize === 10 ? 10 : view.pageSize)
    setSortKey(view.sortKey === 'oldest' ? 'oldest' : 'newest')
    setDateFrom(typeof filters.dateFrom === 'string' ? filters.dateFrom : '')
    setDateTo(typeof filters.dateTo === 'string' ? filters.dateTo : '')
    setFolderFilter(typeof filters.folderFilter === 'string' ? filters.folderFilter : '')
  }

  const saveCurrentView = async () => {
    if (!canManageBroadcastListNow()) { setSavedViewError('権限が変わったため、検索条件の保存を中止しました。'); return }
    if (!selectedAccountId || !savedViewName.trim() || savedViewBusy) return
    setSavedViewBusy(true)
    setSavedViewError('')
    try {
      const res = await api.broadcasts.savedViews.create(selectedAccountId, {
        name: savedViewName.trim(),
        filters: { titleQuery, statusFilter, dateFrom, dateTo, folderFilter, pageSize },
        sortKey,
        pageSize: (pageSize === 10 ? 20 : pageSize) as BroadcastSavedView['pageSize'],
      })
      if (!res.success) throw new Error(res.error)
      setSavedViews((current) => [...current, res.data])
      setSavedViewName('')
      setSavedViewOpen(false)
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setSavedViewError('この検索条件を保存できませんでした。時間をおいて、もう一度お試しください。') }
    } finally {
      setSavedViewBusy(false)
    }
  }

  /* 削除は、利用状況にかかわらず確認してから実行する。 */
  const requestDelete = (broadcast: ApiBroadcast) => {
    if (!canChangeBroadcastNow(broadcast)) { notifyToast('権限が変わったため、配信の削除を中止しました。', { tone: 'error' }); return }
    deleteScope.current = { generation: accountScope.current.generation }
    setDeleteError(''); setDeleteTarget({ ...broadcast })
  }

  const handleDelete = async () => {
    if (!deleteTarget || deleting || !renderedDeleteScope || renderedDeleteScope !== deleteScope.current || renderedDeleteScope.generation !== accountScope.current.generation) return
    if (!canChangeBroadcastNow(deleteTarget)) { setDeleteError('権限が変わったため、配信の削除を中止しました。'); return }
    const targetId = deleteTarget.id
    const requestKey = listRequestKey
    setDeleting(true)
    setDeleteError('')
    try {
      const res = await api.broadcasts.delete(targetId)
      if (!res.success) throw new Error(res.error)
      const rows = Array.from(document.querySelectorAll<HTMLTableRowElement>('tr[data-row-id]'))
      const index = rows.findIndex(row => row.dataset.rowId === targetId)
      const neighbor = rows[index + 1] ?? rows[index - 1]
      const focus = neighbor ? rowPrimary(neighbor) : null
      setDeleteTarget(null)
      // 確認窓の焦点復帰より後に、次の行へ移す。削除済みの行は戻さない。
      requestAnimationFrame(() => {
        const activeRow = document.activeElement?.closest('tr')?.getAttribute('data-row-id')
        if (currentListRequest.current === requestKey && (activeRow === targetId || document.activeElement === document.body)) focus?.isConnected && focus.focus()
      })
      leave(targetId, () => {
        setBroadcasts(current => current.filter(item => item.id !== targetId))
        // loadList は読み直し専用の失敗表示を持つ。削除のcatchへは戻さない。
        if (currentListRequest.current === requestKey) {
          void loadList((page - 1) * pageSize)
          void loadFolders()
        }
      })
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setDeleteError('この配信を削除できませんでした。状態を読み直してから、もう一度お試しください。') }
    } finally {
      setDeleting(false)
    }
  }

  /* 行の「…」→「フォルダへ移す」。押した瞬間に移した形を見せて裏で保存し、失敗したら戻す。 */
  const moveBroadcastToFolder = (broadcast: ApiBroadcast, folderId: string | null) => {
    if (!canChangeBroadcastNow(broadcast)) { notifyToast('権限が変わったため、フォルダへの移動を中止しました。', { tone: 'error' }); return }
    if (moving) return
    const permitted = captureBroadcastWriteAccess()
    setMoving(true)
    const previous = broadcasts
    setBroadcasts((current) => current.map((item) => (item.id === broadcast.id ? { ...item, folderId } : item)))
    setOpenMenuId(null)
    setMenuMoveFor(null)
    runOptimistic({
      request: () => {
        if (!permitted(broadcast)) throw new Error('権限が変わったため、フォルダへの移動を中止しました。')
        return api.broadcasts.update(broadcast.id, { folderId, expectedVersion: broadcast.version ?? 0 })
      },
      revert: () => { setBroadcasts(previous); setMoving(false) },
      failureMessage: 'フォルダへ移せませんでした。',
      retry: () => moveBroadcastToFolder(broadcast, folderId),
      onSuccess: () => {
        setMoving(false)
        void loadList((page - 1) * pageSize)
        void loadFolders()
      },
    })
  }

  const getTagName = (tagId: string | null) => (tagId ? tags.find((t) => t.id === tagId)?.name ?? null : null)
  const getScenarioName = (scenarioId: string) => scenarios.find((s) => s.id === scenarioId)?.name ?? null

  /* タイトル・内容は手元で絞る。フォルダも手元で当て直す（移動の重ねをすぐ表へ出すため）。 */
  const matchingBroadcasts = broadcasts.filter((b) => {
    if (folderFilter === UNFILED && b.folderId) return false
    if (folderFilter && folderFilter !== UNFILED && b.folderId !== folderFilter) return false
    const query = titleQuery.trim().toLowerCase()
    if (query && !`${b.title} ${b.messageContent}`.toLowerCase().includes(query)) return false
    return true
  })

  const searching = titleQuery.trim() !== ''
  const visibleBroadcasts = searching
    ? matchingBroadcasts.slice((page - 1) * pageSize, page * pageSize)
    : matchingBroadcasts
  const resultTotal = searching ? matchingBroadcasts.length : listTotal

  const filterActive = statusFilter !== 'all' || folderFilter !== '' || titleQuery.trim() !== ''
    || dateFrom !== '' || dateTo !== '' || savedViewId !== ''
  const clearFilters = () => {
    setStatusFilter('all')
    setFolderFilter('')
    setTitleQuery('')
    setDateFrom('')
    setDateTo('')
    setSavedViewId('')
  }

  const openCreate = (withTemplate: boolean) => {
    if (!canEditBroadcastNow()) { notifyToast('権限が変わったため、配信の作成を中止しました。', { tone: 'error' }); return }
    setCreateMenuOpen(false)
    setOpenTemplatePicker(withTemplate)
    setShowCreate(true)
  }

  /* 送信枠は表示幅にかかわらず、同じ月の使用量から残りを出す。 */
  const quotaUnlimited = quota?.unlimited === true
  const quotaReadable = !quotaUnlimited && quota?.limit != null && quota?.used != null
  const quotaFailed = !quotaLoading && !quotaUnlimited && !quotaReadable
  const quotaRemaining = quotaReadable ? (quota?.limit ?? 0) - (quota?.used ?? 0) : null
  /* 未接続・取得失敗のときだけ、トークンを入れ直す場所（アカウント設定の資格情報）への行き先を出す。上限なし・読み込み中は出さない。 */
  const quotaAction = quotaFailed && quota?.reason != null ? {
    label: 'アカウント設定へ',
    href: selectedAccountId ? `/accounts/detail?id=${encodeURIComponent(selectedAccountId)}` : '/accounts',
  } : undefined
  const kpiPending = listKpis === undefined
  const kpis = [
    {
      key: 'scheduled',
      title: '予約中',
      icon: CalendarClock,
      value: kpiPending ? null : (listKpis?.scheduled ?? null),
      unit: '件',
      detail: <span title="今日の予約件数は取得していません">今日 {emptyValue('unknown')}</span>,
    },
    {
      key: 'quota',
      title: '今月の送信枠',
      icon: Gauge,
      value: quotaUnlimited ? quota?.used ?? null : quotaRemaining,
      unit: quotaUnlimited ? '通 使用' : '通 残り',
      detail: quotaLoading
        ? '読み込んでいます'
        : quotaUnlimited
          ? '上限なし'
          : quotaReadable
            ? `${formatNumber(quota?.limit ?? 0)} 通のうち ${formatNumber(quota?.used ?? 0)} 通を使用`
            : '送信枠を確認できません',
    },
    {
      key: 'thisMonth',
      title: '今月の配信',
      icon: Send,
      value: kpiPending ? null : (listKpis?.thisMonth ?? null),
      unit: '件',
      detail: listKpis?.delivered == null ? emptyValue('unknown') : acceptedCountText(listKpis.delivered),
    },
    {
      key: 'openRate',
      title: '平均の開封率',
      icon: MailOpen,
      value: kpiPending ? null : (listKpis?.openRate ?? null),
      unit: '%',
      detail: '過去28日',
    },
  ]

  const pageCount = resultTotal == null ? 1 : Math.max(1, Math.ceil(resultTotal / pageSize))
  const rangeFirst = visibleBroadcasts.length === 0 ? 0 : (page - 1) * pageSize + 1
  const rangeLast = (page - 1) * pageSize + visibleBroadcasts.length

  const folderRows: FolderPanelRow[] = [
    { kind: 'all' as const, id: '', label: 'すべて', count: statusCounts?.all ?? listTotal },
    ...folders.map((f, index) => ({
      kind: 'folder' as const,
      id: f.id,
      label: f.name,
      count: f.itemCount ?? null,
      color: f.color,
      onEdit: () => {
        if (!canManageBroadcastListNow()) { setFolderError('権限が変わったため、フォルダの編集を中止しました。'); return }
        setEditingFolder(f)
      },
      lockedReason: management.reason,
      actionsDisabled: !management.known,
      onMoveUp: index > 0 ? () => void moveFolderOrder(index, -1) : undefined,
      onMoveDown: index < folders.length - 1 ? () => void moveFolderOrder(index, 1) : undefined,
      onDelete: () => {
        if (!canManageBroadcastListNow()) { setFolderError('権限が変わったため、フォルダの削除を中止しました。'); return }
        folderDeleteTicket.current = {}
        setFolderDeleteScope(accountScope.current)
        setDeletingFolder(f)
      },
      deleteNote: '削除しても、中の配信は未分類に残ります。',
    })),
    { kind: 'unfiled' as const, id: UNFILED, label: '未分類', count: unfiledCount },
  ]

  /** 行の「…」。編集を続ける（下書き・予約）・複製・フォルダへ移す・削除。 */
  const withCurrentEdit = (run: () => void, action: '変更' | '作成' = '変更') => () => {
    if (!canEditBroadcastNow()) { notifyToast(`権限が変わったため、配信の${action}を中止しました。`, { tone: 'error' }); return }
    run()
  }
  const openNewBroadcast = withCurrentEdit(() => { setCreateMenuOpen(false); router.push('/broadcasts/new') }, '作成')

  const lockedWriteItems = (items: ActionMenuItem[]) => items.map(item => ({
    ...item,
    lockedReason: editAccess.reason,
    disabled: item.disabled || !canEdit,
    href: editAccess.known ? item.href : undefined,
  }))
  const rowMenuItems = (broadcast: ApiBroadcast): ActionMenuItem[] => {
    if (menuMoveFor === broadcast.id) {
      return [
        { id: 'move-back', label: '← 操作にもどる', onSelect: () => { keepMenuOpenRef.current = true; setMenuMoveFor(null) } },
        ...lockedWriteItems([{ id: 'move-unfiled', label: '未分類', onSelect: () => void moveBroadcastToFolder(broadcast, null) },
        ...folders.map((f) => ({ id: `move-${f.id}`, label: f.name, onSelect: () => void moveBroadcastToFolder(broadcast, f.id) }))]),
      ]
    }
    /*
     * 統括から来た配信（提案 E-9・l3RQH）は店では変えられない（口が 403）。「…」は見る・複製するだけ。
     * 閲覧のみでも複製の口を残し、現在の権限で拒否する。
     */
    if (isFromHeadquarters(broadcast)) {
      return [
        { id: 'view', label: "配信の詳細を見る", external: false, href: `/broadcasts/detail?id=${encodeURIComponent(broadcast.id)}`, onSelect: () => goDetail(broadcast.id) },
        ...lockedWriteItems([{ id: 'duplicate', label: '複製', external: false, icon: <Copy size={16} aria-hidden="true" />, href: `/broadcasts/new?duplicateFrom=${encodeURIComponent(broadcast.id)}`, onSelect: withCurrentEdit(() => router.push(`/broadcasts/new?duplicateFrom=${encodeURIComponent(broadcast.id)}`)) }]),
      ]
    }
    const items: ActionMenuItem[] = []
    if (broadcast.status === 'draft' || broadcast.status === 'scheduled') {
      items.push({
        id: 'resume',
        label: '編集を続ける',
        external: false,
        href: `/broadcasts/new?draft=${encodeURIComponent(broadcast.id)}`, onSelect: withCurrentEdit(() => router.push(`/broadcasts/new?draft=${encodeURIComponent(broadcast.id)}`)),
      })
    }
    items.push({
      id: 'duplicate',
      label: '複製',
      external: false,
      icon: <Copy size={16} aria-hidden="true" />,
      href: `/broadcasts/new?duplicateFrom=${encodeURIComponent(broadcast.id)}`, onSelect: withCurrentEdit(() => router.push(`/broadcasts/new?duplicateFrom=${encodeURIComponent(broadcast.id)}`)),
    })
    items.push({
      id: 'move-folder',
      label: 'フォルダへ移す',
      disabled: folders.length === 0,
      disabledReason: folders.length === 0 ? '移せるフォルダがありません' : undefined,
      onSelect: () => {
        keepMenuOpenRef.current = true
        setMenuMoveFor(broadcast.id)
      },
    })
    items.push({
      id: 'delete',
      label: '削除する',
      tone: 'danger',
      dividerBefore: true,
      onSelect: () => requestDelete(broadcast),
    })
    return lockedWriteItems(items)
  }

  /** 右クリックは「…」と同じ品ぞろえ（「…」でも必ず開ける）。 */
  const rowContextItems = (broadcast: ApiBroadcast): ContextMenuItem[] =>
    rowMenuItems(broadcast).map((item) => ({
      id: item.id,
      label: item.label,
      external: item.external,
      href: item.href,
      dividerBefore: item.dividerBefore,
      icon: item.icon,
      danger: item.tone === 'danger',
      disabled: item.disabled,
      disabledReason: item.disabledReason,
      lockedReason: item.lockedReason,
      onSelect: item.onSelect,
    }))

  const goDetail = (id: string) => {
    withViewTransition(() => {
      router.push(`/broadcasts/detail?id=${encodeURIComponent(id)}`)
    })
  }

  const panelIndex = visibleBroadcasts.findIndex((b) => b.id === panelId)
  const panelRow = panelIndex >= 0 ? visibleBroadcasts[panelIndex] : null

  /* ===== 部品（広い板・1152 で同じものを並べ替えて使う） ===== */
  /* 作る口は同じ場所に残し、権限の理由と入力の状態を分ける。 */
  const createButton = (full: boolean) => (
    <Button
      type="button"
      variant="primary"
      className={full ? `v8-folder-create ${styles.createFull}` : undefined}
      aria-haspopup="menu"
      aria-expanded={createMenuOpen}
      lockedReason={editAccess.reason}
      disabled={!canEdit}
      onClick={(event) => {
        if (!canEditBroadcastNow()) { notifyToast('権限が変わったため、配信の作成を中止しました。', { tone: 'error' }); return }
        createAnchorRef.current = event.currentTarget; setCreateMenuOpen(true)
      }}
    >
      <Plus size={16} aria-hidden="true" />
      {full ? <>配信を作る<ChevronDown size={16} aria-hidden="true" /></> : '配信を作る'}
    </Button>
  )

  const searchBox = (
    <ListToolbarSearchSlot>
      <SearchField
        aria-label="タイトル・内容で探す"
        placeholder="タイトル・内容で探す"
        value={titleQuery}
        onChange={setTitleQuery}
        onClear={() => setTitleQuery('')}
      />
    </ListToolbarSearchSlot>
  )

  const dateBox = (
    <FilterPopover open={datePopoverOpen} onClose={() => setDatePopoverOpen(false)} label="配信日で絞る（開始〜終了）"
      trigger={<FilterChip selected={Boolean(dateFrom || dateTo)} aria-haspopup="dialog" aria-expanded={datePopoverOpen}
        onChange={() => setDatePopoverOpen((open) => !open)} selectedIcon={false}>
        {dateRangeLabel(dateFrom, dateTo)}<CalendarDays size={16} aria-hidden="true" />
      </FilterChip>}
      actions={<>
        {(dateFrom || dateTo) ? <Button type="button" onClick={() => { setDateFrom(''); setDateTo('') }}>外す</Button> : null}
        <Button type="button" variant="primary" onClick={() => setDatePopoverOpen(false)}>閉じる</Button>
      </>}
    >
      <SaveErrorField names={["dateFrom","from","date_from"]}><DateField value={dateFrom} onChange={setDateFrom} max={dateTo || undefined} aria-label="配信日（開始）" placeholder="開始日" /></SaveErrorField>
      <SaveErrorField names={["dateTo","to","date_to"]}><DateField value={dateTo} onChange={setDateTo} min={dateFrom || undefined} aria-label="配信日（終了）" placeholder="終了日" /></SaveErrorField>
    </FilterPopover>
  )

  const savedSearchBox = (
    <div className={styles.savedBox}>
      <Button
        type="button"
        aria-haspopup="menu"
        aria-expanded={savedMenuOpen}
        onClick={(event) => { savedAnchorRef.current = event.currentTarget; setSavedMenuOpen(true) }}
      >
        <Bookmark size={16} aria-hidden="true" />
        {savedViews.find((view) => view.id === savedViewId)?.name ?? '保存した検索'}
        <ChevronDown size={16} aria-hidden="true" />
      </Button>
      {/* 絞り込み中で、まだ保存した検索として開いていない時だけ、保存できることを小さな点で知らせる。 */}
      {canEdit && !savedViewId && (filterActive || dateFrom || dateTo) ? <span className={styles.savableDot} data-savable-dot="" title="今の条件を保存できます" aria-hidden="true" /> : null}
      <ActionMenu
        open={savedMenuOpen}
        onClose={() => setSavedMenuOpen(false)}
        anchorRef={savedAnchorRef}
        ariaLabel="保存した検索"
        choiceHeading="保存した検索"
        items={[
          ...savedViews.map((view) => ({
            id: `view-${view.id}`,
            label: view.name,
            onSelect: () => { setSavedMenuOpen(false); applySavedView(view.id) },
          })),
          ...(savedViewId ? [{ id: 'view-clear', label: '保存した検索を外す', onSelect: () => { setSavedMenuOpen(false); clearFilters() } }] : []),
          ...[{
            id: 'view-save',
            label: '＋ 今の条件を保存する',
            dividerBefore: savedViews.length > 0,
            lockedReason: management.reason,
            disabled: !management.known,
            onSelect: () => {
              if (!canManageBroadcastListNow()) { setSavedViewError('権限が変わったため、検索条件の保存を中止しました。'); return }
              setSavedMenuOpen(false); setSavedViewOpen(true)
            },
          }],
        ]}
      />
    </div>
  )

  const statusChips = (
    <SegmentedControl aria-label="状態" value={statusFilter} onChange={setStatusFilter}
      options={STATUS_CHIPS.map(chip => ({ value: chip.key, label: chip.label,
        count: chipCount(statusCounts, chip.key) ?? undefined }))} />
  )

  const pageSizeBox = (
    <div className={styles.pageSizeBox}>
      <SaveErrorField names={["pageSize","page_size"]}><Select
        aria-label="表示件数"
        size="page-size"
        value={String(pageSize)}
        onChange={(value) => setPageSize(Number(value) || 20)}
        options={[
          { value: '10', label: '10件表示' },
          { value: '20', label: '20件表示' },
          { value: '50', label: '50件表示' },
          ...(pageSize === 100 ? [{ value: '100', label: '100件表示' }] : []),
        ]}
      /></SaveErrorField>
    </div>
  )

  const sortButton = (
<ListToolbarSort value={sortKey} onChange={(value) => { setSortKey(value as typeof sortKey); setPage(1) }} options={[{ value: 'newest', label: '新しい順' }, { value: 'oldest', label: '古い順' }]} />
  )

  /* 道具の段：1440 は「探す・配信日 … 保存した検索（この条件を保存するはこの中）」／「札 … 件数・並び」。1152 は作る・フォルダが前に入り、札は選ぶ欄。 */
  const toolbar = (
    <ListToolbarFrame layout="stacked">
      <ListToolbarRow>
        {searchBox}
        <ListToolbarOptional collapse="overflow" label="配信日・検索条件">{dateBox}<ListToolbarEnd>{savedSearchBox}</ListToolbarEnd></ListToolbarOptional>
      </ListToolbarRow>
      <ListToolbarRow>
        {statusChips}
        <ListToolbarEnd>{sortButton}{pageSizeBox}</ListToolbarEnd>
      </ListToolbarRow>
      {savedViewOpen ? (
        <div className={styles.saveRow}>
          <SaveErrorField names={["savedViewName","name","saved_view_name"]}><SharedTextField
            aria-label="保存する検索の名前"
            placeholder="検索条件の名前"
            disabled={!management.allowed}
            value={savedViewName}
            onChange={(event) => setSavedViewName(event.target.value)}
            className={styles.saveInput}
          /></SaveErrorField>
          <Button type="button" variant="primary" lockedReason={management.reason} disabled={!management.known || !savedViewName.trim() || savedViewBusy} onClick={() => void saveCurrentView()} busy={savedViewBusy} busyLabel="保存中">保存する</Button>
          <Button type="button" onClick={() => setSavedViewOpen(false)}>閉じる</Button>
        </div>
      ) : null}
      {savedViewError ? (
        <Notice tone="danger" className={styles.noteNoticePlacement} >{savedViewError}
          <Button variant="text" size="inline" data-notice-inline-action type="button" onClick={() => setSavedViewsSeq((n) => n + 1)}>もう一度</Button></Notice>
      ) : null}
    </ListToolbarFrame>
  )

  /* ===== 表 ===== */
  const folderDotOf = (folderId: string | null | undefined) => {
    const folder = folderId ? folders.find((f) => f.id === folderId) : undefined
    return folder ? { name: folder.name, color: folder.color } : null
  }

  const selection = useBroadcastFolderSelection({ accountId: selectedAccountId || null, canEdit, lockedReason: editAccess.reason, broadcasts: visibleBroadcasts.filter(item => !isFromHeadquarters(item)), folders, onChanged: async () => { await loadList((page - 1) * pageSize); await loadFolders() } })
  const tableHead = (
    <thead>
      <TableHeadRow>
        <Th className={styles.colTitle}>{selection.pageCheckbox}タイトル・内容</Th>
        <Th className={styles.colStatus}>状態</Th>
        {narrow ? null : <Th className={styles.colAudience}>配信条件</Th>}
        <Th className={styles.colDate}>配信日時</Th>
        {narrow ? <Th className={styles.colResult}>結果</Th> : (
          <>
            <Th align="right" className={styles.colDelivered}>届いた</Th>
            <Th align="right" className={styles.colRate}>開封</Th>
            <Th align="right" className={styles.colRate}>クリック</Th>
          </>
        )}
        <Th showActionLabel className={styles.colMenu}>操作</Th>
      </TableHeadRow>
    </thead>
  )

  const loadingSkeleton = (
    <DataTable className={styles.table}>
      {tableHead}
      <tbody>
        {[0, 1, 2, 3, 4].map((n) => (
          <Tr key={n} className={styles.row}>
            <Td><Skeleton width={200} height={16} /><Skeleton width={140} height={12} /></Td>
            <Td><Skeleton width={72} height={22} className="rounded-pill" /></Td>
            {narrow ? null : <Td><Skeleton width={120} height={12} /></Td>}
            <Td><Skeleton width={96} height={16} /></Td>
            {narrow ? <Td><Skeleton width={64} height={16} /></Td> : <>
              <Td align="right"><Skeleton width={48} height={16} /></Td>
              <Td align="right"><Skeleton width={40} height={16} /></Td>
              <Td align="right"><Skeleton width={40} height={16} /></Td>
            </>}
            <Td />
          </Tr>
        ))}
      </tbody>
    </DataTable>
  )

  const stateCard = (icon: React.ReactNode, title: string, desc: string | null, action: React.ReactNode, danger = false) => (
    <ListState kind={danger ? 'error' : 'empty'} title={title} description={desc ?? undefined} icon={icon} action={action} />
  )

  const listLoading = !listLoaded && !error && !forbidden
  const listBody = forbidden ? (
    stateCard(<AlertCircle size={20} aria-hidden="true" />, '配信を見る権限がありません', permissionDeniedMessage('store'), <Button onClick={() => loadList((page - 1) * pageSize)} busyLabel="処理中…">もう一度読み込む</Button>, true)
  ) : error ? (
    stateCard(<AlertCircle size={20} aria-hidden="true" />, '一斉配信を読み込めませんでした', error,
      <Button type="button" onClick={() => loadList((page - 1) * pageSize)} busyLabel="処理中…">もう一度読み込む</Button>, true)
  ) : visibleBroadcasts.length === 0 ? (
    /* 空の一覧でも作る口を残し、閲覧と変更の権限を分ける。 */
    <EmptyList
      icon={<Send aria-hidden="true" />}
      title="まだ一斉配信がありません"
      description="友だちみんなや絞り込んだ人に、お知らせをまとめて送ります。"
      create={{ label: '最初の一斉配信を作る', onClick: openNewBroadcast }}
      canCreate={canEdit}
      lockedReason={editAccess.reason ?? null}
      filtered={filterActive}
      onClearFilters={clearFilters}
      filteredDescription="「予約中のみ」「下書き」や配信日を外すと、すべて出ます"
    />
  ) : (
    <DataTable className={styles.table}>
      {tableHead}
      <RovingTbody reorderKey={visibleBroadcasts.map(row => row.id).join(',')} reorderScope={JSON.stringify([listScope, page])}>
        {visibleBroadcasts.map((broadcast) => {
          const insight = insights[broadcast.id] ?? summaryInsight(broadcast.insightSummary)
          const audience = audienceSummary(broadcast, getTagName, getScenarioName)
          const detailHref = `/broadcasts/detail?id=${encodeURIComponent(broadcast.id)}`
          const menuLabel = `配信「${broadcast.title}」の操作`
          const titleLink = (
            <RowNameLink
              href={detailHref}
              className={styles.cellTitle}
              title={broadcast.title}
              onClick={(event) => {
                event.stopPropagation()

              }}
            >
              {broadcast.title}
            </RowNameLink>
          )
          return (
            <Tr
              key={broadcast.id}
              selected={selection.isSelected(broadcast.id)}
              leaving={isLeaving(broadcast.id)}
              data-reorder-id={broadcast.id}
              className={styles.row}
              interactive
              tabIndex={0}
              detailKey="broadcast" onOpen={() => setPanelId(panelId === broadcast.id ? null : broadcast.id)}
               data-row-id={broadcast.id}
            >
              <Td>
                <FolderDotName folder={folderDotOf(broadcast.folderId)} selection={selection.checkbox(broadcast)}>{titleLink}</FolderDotName>
              </Td>
              <Td><StatusBadge broadcast={broadcast} />{isFromHeadquarters(broadcast) ? <HqMark /> : null}</Td>
              {narrow ? null : (
                <Td><span className={styles.audience} title={audience}>{audience}</span></Td>
              )}
              <Td>
                {/* 日時だけの1行。予約中（まだ先）の日時だけ少し濃くする。「予約」は状態の札にあるので重ねない。 */}
                {(() => {
                  const at = broadcast.status === 'sent' ? broadcast.sentAt : broadcast.scheduledAt
                  if (!at) return <EmptyCell />
                  return <span className={styles.cellMain} data-upcoming={broadcast.status === 'scheduled' || undefined}><ListDateTime value={at} /></span>
                })()}
              </Td>
              <BroadcastResultCells broadcast={broadcast} insight={insight} narrow={narrow} />
              <Td className={styles.colMenu}>
                {/* 変更の口も同じ列に残し、見る口を権限ロックに巻き込まない。 */}
                {<div className={styles.menuBox}>
                  <ContextMenu label={menuLabel} items={rowContextItems(broadcast)}>
                    <RowMenu
                      appearance="box"
                      size="row"
                      label={menuLabel}
                      items={rowMenuItems(broadcast)}
                      open={openMenuId === broadcast.id}
                      onOpenChange={(next) => {
                        /* 開く：サブメニュー（フォルダへ移す）を戻してから開く。 */
                        if (next) {
                          setMenuMoveFor(null)
                          setOpenMenuId(broadcast.id)
                          return
                        }
                        /* 閉じる：サブメニューへの切り替え・戻る では開いたままにする。 */
                        if (keepMenuOpenRef.current) {
                          keepMenuOpenRef.current = false
                          return
                        }
                        setOpenMenuId(null)
                      }}
                    />
                  </ContextMenu>
                </div>}
              </Td>
            </Tr>
          )
        })}
      </RovingTbody>
    </DataTable>
  )
  const pager = !loading && !error && !forbidden && (resultTotal !== null || visibleBroadcasts.length > 0) ? (
    <ListPagePagination>
      <Pagination page={page} pageCount={pageCount} onPageChange={goPage} ariaLabel="一斉配信のページ送り" correctOutOfRange={resultTotal !== null}
        range={{ total: resultTotal ?? visibleBroadcasts.length, first: rangeFirst, last: rangeLast }} />
    </ListPagePagination>
  ) : null

  const boardId = narrow ? 'jjFNi' : canEdit ? 'l5V9a' : 'NtCE3'

  return (
    <SaveErrorScope errors={saveErrors}><ListPage
      heightMode="content"
      skeleton
      boardId={boardId}
      headingSize="compact"
      title="一斉配信"
      help="友だちにまとめて送るメッセージの一覧です。予約・下書き・送った結果をここで見ます。"
      stats={<>
        {editAccess.reason ? (
          <div className={styles.viewerBand}><ReadOnlyNotice need="feature" /></div>
        ) : null}
        <KpiBand>
          {kpis.map((kpi) => (
            <KpiCard
              key={kpi.key}
              presentation="band"
              density="compact"
              title={kpi.title}
              icon={<kpi.icon size={16} aria-hidden="true" />}
              value={kpi.value}
              unit={kpi.value == null ? '' : kpi.unit}
              detail={kpi.detail}
              loading={kpi.key === 'quota' ? quotaLoading : undefined}
              action={kpi.key === 'quota' ? quotaAction : undefined}
            />
          ))}
        </KpiBand>
      </>}
      folderNav={error ? undefined : { rows: folderRows, activeId: folderFilter, onSelect: setFolderFilter, createAction: createButton(false) }}
      folders={error ? undefined : (
        <FolderPanel
          createAction={createButton(true)}
          activeId={folderFilter}
          onSelect={setFolderFilter}
          onAddFolder={() => {
            if (!canManageBroadcastListNow()) { setFolderError('権限が変わったため、フォルダの作成を中止しました。'); return }
            setFolderDialogOpen(true)
          }}
          addFolderLockedReason={management.reason}
          addFolderDisabled={!management.known}
          addFolderLabel="フォルダを追加"
          rows={folderRows}
        >
          <FolderPanelNote>フォルダを消しても、入っていたものは未分類に残ります</FolderPanelNote>
          {folderError ? (
            <Notice tone="danger" className={styles.noteNoticePlacement} >{folderError}
              <Button variant="text" size="inline" data-notice-inline-action type="button" onClick={() => void loadFolders()}>もう一度</Button></Notice>
          ) : null}
        </FolderPanel>
      )}
      toolbar={toolbar}
      pagination={pager}
      overlays={<>{selection.overlays}
        <ActionMenu
          open={createMenuOpen}
          onClose={() => setCreateMenuOpen(false)}
          anchorRef={createAnchorRef}
          align="start"
          ariaLabel="配信の作り方"
          items={lockedWriteItems([
            /* 絵  の分け方：かんたんに送る（1画面・板 ）と詳しく作る（5つの手順 `/broadcasts/new`）。
               テンプレートから作るは絵に無いが今ある機能なので、その下に残す。 */
            { id: 'create-quick', label: 'かんたんに送る', description: '文字1通を、全員かタグで。1画面で送れる', onSelect: withCurrentEdit(() => { setCreateMenuOpen(false); setQuickSendOpen(true) }, '作成') },
            { id: 'create-new', label: '詳しく作る', description: '画像・カード・絞り込み・承認（5手順）', onSelect: openNewBroadcast },
            { id: 'create-template', label: 'テンプレートから作る', onSelect: () => openCreate(true) },
          ])}
        />
        <QuickSendV8
          open={quickSendOpen}
          accountId={selectedAccountId || null}
          onClose={() => setQuickSendOpen(false)}
          onSent={() => void loadList(0)}
        />
        {folderDialogOpen && (
          <FolderAddDialog
            kind="broadcast"
            canSaveNow={canManageBroadcastListNow}
            confirmDisabled={!management.known}
            confirmLockedReason={management.reason}
            note="配信を分けてしまう箱です。消しても、入っていた配信は未分類として残ります。"
            placeholder="例：01_キャンペーン"
            onClose={() => setFolderDialogOpen(false)}
            onAdded={() => void loadFolders()}
          />
        )}
        {editingFolder && (
          <FolderAddDialog
            kind="broadcast"
            canSaveNow={canManageBroadcastListNow}
            confirmDisabled={!management.known}
            confirmLockedReason={management.reason}
            folder={editingFolder}
            note="配信を分けてしまう箱です。削除しても、中の配信は未分類に残ります。"
            placeholder="例：01_キャンペーン"
            onClose={() => setEditingFolder(null)}
            onAdded={() => { setEditingFolder(null); void loadFolders() }}
          />
        )}
        {panelRow ? (() => {
          const audience = audienceSummary(panelRow, getTagName, getScenarioName)
          const insight = insights[panelRow.id] ?? summaryInsight(panelRow.insightSummary)
          /* 統括から来た配信は店では変えられない（編集・削除を出さない。複製はできる）。 */
          const fromHq = isFromHeadquarters(panelRow)
          const canResume = !fromHq && (panelRow.status === 'draft' || panelRow.status === 'scheduled')
          return (
            <DetailPanel
              open
              title={panelRow.title}
              description={audience}
              onClose={() => setPanelId(null)}
              onPrev={panelIndex > 0 ? () => setPanelId(visibleBroadcasts[panelIndex - 1].id) : undefined}
              onNext={panelIndex < visibleBroadcasts.length - 1 ? () => setPanelId(visibleBroadcasts[panelIndex + 1].id) : undefined}
              hasPrev={panelIndex > 0}
              hasNext={panelIndex < visibleBroadcasts.length - 1}
              actions={{primary: <Button variant="primary" onClick={() => goDetail(panelRow.id)}>開く</Button>,
secondary: ((canResume) ? <Button
                    variant="secondary"
                    lockedReason={editAccess.reason}
                    disabled={!canEdit}
                    onClick={withCurrentEdit(() => withViewTransition(() => { router.push(`/broadcasts/new?draft=${encodeURIComponent(panelRow.id)}`) }))}
                   busyLabel="移動中…">
                    編集を続ける
                  </Button> : null),
menuItems: [{id: 'detail-0', label: "複製する", disabled: !canEdit, "lockedReason": editAccess.reason, onSelect: withCurrentEdit(() => withViewTransition(() => { router.push(`/broadcasts/new?duplicateFrom=${encodeURIComponent(panelRow.id)}`) }))},
...((!(fromHq)) ? [{id: 'detail-1', label: "削除する", disabled: !canEdit, "lockedReason": editAccess.reason, onSelect: withCurrentEdit(() => { setPanelId(null); requestDelete(panelRow) })}] : [])]}}
             status={<StatusBadge broadcast={panelRow} />}>
<DetailContent>
<DetailField label={panelRow.status === 'sent' ? '送信日時' : '送る日時'}>{panelRow.status === 'sent' ? (panelRow.sentAt ? formatDateTime(panelRow.sentAt) : '送信済み') : (panelRow.scheduledAt ? formatDateTime(panelRow.scheduledAt) : '下書き')}</DetailField>
{panelRow.status === 'sent' ? <DetailField label="届いた人数">{insight?.delivered != null ? formatNumber(insight.delivered) + ' 人に届いた' : acceptedCountText(panelRow.successCount)}</DetailField> : null}
</DetailContent>
</DetailPanel>
          )
        })() : null}
        <ConfirmDialog
          open={deletingFolder !== null && folderDeleteScope === accountScope.current}
          title={`フォルダ「${deletingFolder?.name ?? ''}」を削除しますか？`}
          description={`削除しても、中の配信は未分類に残ります。いまこのフォルダに入っているのは${
            deletingFolder ? broadcasts.filter((b) => b.folderId === deletingFolder.id).length : 0
          } 件です。`}
          confirmLabel="削除する"
          destructive
          busy={folderBusy}
          confirmLockedReason={management.reason}
          confirmDisabled={!management.allowed}
          error={folderError || undefined}
          onConfirm={() => removeFolder()}
          onCancel={() => {
            if (folderBusy) return
            folderDeleteTicket.current = null
            setDeletingFolder(null)
            setFolderError('')
          }}
        >{deletingFolder ? <OperationTargetSummary accounts={deletingFolder.accountId === null ? [] : [{ id: deletingFolder.accountId ?? '' }]} externalTarget={deletingFolder.accountId === null ? { label: 'フォルダの対象', name: '共通（全アカウント）' } : undefined} /> : null}</ConfirmDialog>
        <ConfirmDialog
          open={deleteTarget !== null && renderedDeleteScope?.generation === accountScope.current.generation}
          title={`「${deleteTarget?.title ?? ''}」を削除しますか？`}
          description="削除すると配信設定と確認画面から消えます。予約中の配信は中止され、この操作は取り消せません。"
          confirmLabel="削除する"
          destructive
          busy={deleting}
          confirmLockedReason={editAccess.reason}
          confirmDisabled={!canEdit}
          error={deleteError}
          onConfirm={() => handleDelete()}
          onCancel={() => {
            if (deleting) return
            setDeleteTarget(null)
            setDeleteError('')
          }}
        >{deleteTarget ? <OperationTargetSummary accounts={(() => { const ids = deleteTarget.targetType === 'multi-account-dedup' ? deleteTarget.accountIds : deleteTarget.lineAccountId ? [deleteTarget.lineAccountId] : null; return ids?.length ? [...new Set(ids)].map(id => ({ id })) : [{ id: '' }] })()} showAccountCount={deleteTarget.targetType === 'multi-account-dedup'} /> : null}</ConfirmDialog>
      </>}
    >
      {showCreate ? (
        <div className={styles.createForm}>
          <BroadcastForm
            tags={tags}
            onSuccess={() => { setShowCreate(false); void loadList(); void loadFolders() }}
            onDraftSaved={() => { void loadList(); void loadFolders() }}
            onCancel={() => setShowCreate(false)}
            openTemplatePickerInitially={openTemplatePicker}
          />
        </div>
      ) : null}
      <RefreshCover refreshing={loading && listLoaded}>
        <DelayedSkeleton loading={listLoading} skeleton={
          <div aria-busy="true" aria-label="読み込んでいます">{loadingSkeleton}</div>
        }>
          {listLoading ? undefined : listBody}
        </DelayedSkeleton>
      </RefreshCover>
    </ListPage></SaveErrorScope>
  )
}
