'use client'

import OperationTargetSummary from '@/components/shared/operation-target-summary'

import { DetailContent, DetailField, DetailSection } from '@/components/shared/detail-content'
import { RefreshCover } from '@/components/shared/refresh-cover'
import DetailPanel from '@/components/shared/detail-panel';
import { useHeldDetail, useInlineDetailGuard } from '@/components/shared/use-inline-detail-guard'
import { useStaffRole } from '@/lib/staff-role';
import ListToolbar from '@/components/shared/list-toolbar';

import { RowNameLink } from '@/components/shared/table';
import StatusBadge from '@/components/shared/status-badge'
import SharedStatusPill from '@/components/shared/status-pill'
import { collectListRows } from '@/components/shared/collect-list-rows';
import BulkBar, { useEscapeToClearSelection } from '@/components/shared/bulk-bar';
import { useListUrlValue, readListUrlParam, useListScrollMemory, useListUrlFlag, useListUrlParam } from '@/components/shared/list-url-state';
import { captureScenarioWriteAccess, useScenarioWriteAccess, type ScenarioWriteOperation } from './write-access'
import { RovingTbody } from '@/components/shared/row-roving';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Bookmark, CalendarPlus, CheckCheck, Folder as FolderIcon, ListVideo, Pause, Play, Plus, Send, Square, Users, Workflow } from 'lucide-react';


import Link from '@/components/shared/list-navigation'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation';

import type { Scenario, DeliveryMode, Folder } from '@line-crm/shared';
import { api, type ListStats } from '@/lib/api';
import { useOffsetServerList } from '@/lib/use-server-list';
import { clampSearchQuery } from '@/lib/search-query';
import { completeReorder } from '@/lib/complete-reorder';
import { useAccount } from '@/contexts/account-context';
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome';
import { ROLE_LABELS } from '@/lib/hq-members';
import { describeApiFailure, isForbidden } from '@/components/shared/api-error-message';
import { NoPermissionBoard } from '@/v8/no-permission/index'
import { useNarrowViewport } from '@/lib/use-narrow-viewport';
import { formatNumber } from '@/lib/format';
import { ProgressBar } from '@/components/shared/progress';
import { describeSaveFailure } from '@/lib/api'
import type { ConfirmedUndoHandle } from '@/lib/undoable'
import { runUndoable, runOptimistic } from '@/lib/undoable';
import { useLiveReorder } from '@/lib/use-live-reorder';
import { ListPage, ListPagePagination } from '@/components/templates';
import SearchField from '@/components/shared/search-field'
import { DataTable, TableHeadRow, Th, Tr, Td, NameCell } from '@/components/shared/table';
import Button from '@/components/shared/button'
import EmptyList from '@/components/shared/empty-list'
import KpiCard from '@/components/shared/kpi-card'
import KpiBand from '@/components/shared/kpi-band'
import Notice from '@/components/shared/notice'
import Checkbox from '@/components/shared/checkbox'
import Select from '@/components/shared/select'
import PageSizeSelect from '@/components/shared/page-size-select'
import { PAGE_SIZES as STANDARD_PAGE_SIZES } from '@/components/shared/page-size-select';
import FilterChip from '@/components/shared/filter-chip'
import ManagedFolderPanel from '@/components/shared/managed-folder-panel'

import ConfirmDialog from '@/components/shared/confirm-dialog'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import Card, { CardHeader } from '@/components/shared/card'
import HelpTip from '@/components/shared/help-tip'
import type { ActionMenuItem } from '@/components/shared/action-menu';
import { RowMenu } from '@/components/shared/row-actions';
import ContextMenu, { type ContextMenuItem } from '@/components/shared/context-menu';
import InlineEdit from '@/components/shared/inline-edit'

import { withViewTransition } from '@/components/shared/view-transition';
import { DelayedSkeleton, Skeleton } from '@/components/shared/skeleton';
import Pagination from '@/components/shared/pagination'
import ReorderHandle from '@/components/shared/reorder-handle'
import ScenarioDeleteDialog from './delete-dialog'
import ScenarioMoveDialog from './move-dialog'
import { scenarioAccountTargets } from './list-account-targets';
import { duplicateScenario, DuplicateAborted } from '@/components/scenarios/duplicate-scenario';
import styles from './list.module.css'
import TruncatedText from '@/components/shared/truncated-text'

import { emptyValue } from '@/components/shared/empty-value';
import { SaveErrorField, useSaveFormErrors, SaveErrorScope } from '@/components/shared/save-form-errors';
import { useDuplicateFeedback } from '@/components/shared/use-duplicate-feedback';
import { notifyToast } from '@/components/shared/toast';
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import ListState from '@/components/shared/list-state'

/*
 * ★V8 シナリオ配信の一覧（Pencil「★V8 画面の地図」のシナリオ配信の行：
 * 一覧 ・狭い板 ・閲覧のみ ・複製の窓 、状態の板は ）。
 *
 * 2026-10-06 オーナー決定で src/v8 に一から書いた。データの口・保存・権限・
 * 失敗時の扱いは今までの一覧（app/scenarios/list-v8.tsx）と同じ。違いは見せ方だけ——
 * 型（ListPage）の枠に、数の帯・フォルダの列・案内の帯・道具の段・表を渡す。
 * 「シナリオを作る」は左のフォルダの列の上、行の右端は「…」（複製・配信結果・削除）、
 * 行の左の □ を選ぶと表の下にまとめての帯（止める・再開・フォルダへ移す）。
 */

/** 未分類を表す印。空文字は「すべて」なので別の値にする。 */
const UNFILED = '__unfiled__'

/** 1ページに出す件数の選択肢（表示は PageSizeSelect が「N件表示」にする）。 */
const PAGE_SIZE_OPTIONS = STANDARD_PAGE_SIZES

/** よく使う絞り込み（数えられるものだけ）。札の「停止中のみ」と対になる「有効のみ」。 */
const SAVED_FILTER_OPTIONS = [
  { value: '', label: 'よく使う絞り込み' },
  { value: 'active', label: '有効のみ' },
]

type ScenarioRow = Scenario & {
  stepCount?: number
  subscriberCount?: number | null
  completedCount?: number | null
}

function isKnownScenarioCount(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function scenarioCountLabel(value: number | null | undefined): string {
  return isKnownScenarioCount(value) ? `${formatNumber(value)} 人` : emptyValue('unknown')
}

/** 実際の配信時刻の起点を、利用者向けの言葉で示す。 */
const deliveryModeLabels: Record<DeliveryMode, string> = {
  relative: '前の配信からの間隔',
  elapsed: '経過時間で指定',
  absolute_time: '時刻で指定',
}

/** 読み終えた人の補足行（板 ：「登録した 1,756 人の 41%」）。0 人は割合が決まらないので人数だけ薄い灰で出す。 */
function scenarioCompletionDetail(active: number, completed: number): string {
  const enrolled = active + completed
  if (enrolled === 0) return '登録した 0 人'
  const rate = Math.round((completed / enrolled) * 100)
  return `登録した ${formatNumber(enrolled)} 人の ${rate}%`
}

/** 運用画面の基準である日本時間の今月初日。 */
function currentMonthStart(now = new Date()): string {
  const month = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
  })
  return `${month.format(now)}-01T00:00:00+09:00`
}

export default function ScenariosListV8() {
  const saveErrors = useSaveFormErrors()
  usePageTitle('シナリオ配信')
  usePageCrumbs([{ label: 'ホーム', href: '/' }])

  const { selectedAccountId, loading: accountLoading } = useAccount()
  const duplicateFeedback = useDuplicateFeedback(selectedAccountId)
  const router = useRouter()
  // 1152 の板（）。板IDと道具の段の並びだけを切り替える。
  const narrow = useNarrowViewport()

  // 表示と実行直前の判定は、本人APIの控えと代理モードにそろえる。
  const staffRole = useStaffRole()
  const editAccess = useScenarioWriteAccess()
  const folderAccess = useScenarioWriteAccess('manageFolders')
  const publishAccess = useScenarioWriteAccess('publish')
  const canEdit = editAccess.allowed

  /* 絞り込み・検索語・ページは URL に置く（戻ると同じ一覧に戻る。動きの点検 5 番）。 */
  const [nameQuery, setNameQuery] = useListUrlParam('q')
  const [serverQuery, setServerQuery] = useState(() => clampSearchQuery(readListUrlParam('q').trim()))
  /** よく使う絞り込み。いま数えられるのは「停止中のみ」「今月作った」「有効のみ」。 */
  const [stoppedOnly, setStoppedOnly] = useListUrlFlag('stopped')
  const [createdThisMonthOnly, setCreatedThisMonthOnly] = useListUrlFlag('thisMonth')
  const [savedFilter, setSavedFilter] = useListUrlParam('view')
  const [actionError, setActionError] = useState('')
  const [folders, setFolders] = useState<Folder[]>([])
  /** 「未分類」の件数。`null` は数えていない。 */
  const [unfiledCount, setUnfiledCount] = useState<number | null>(null)
  const [folderFilter, setFolderFilter] = useListUrlParam('folder')
  /** 絞り込みを掛けない「すべて」の件数。`null` は「まだ数えられていない」。 */
  const [overallTotal, setOverallTotal] = useState<number | null>(null)

  /* 数の帯。/api/list-stats から取る。 */
  const [stats, setStats] = useState<ListStats | null>(null)
  const [statsFailed, setStatsFailed] = useState(false)

  /* 複数選択（まとめての帯）。 */
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())

  /* まとめて/1件のフォルダ移動の窓。 */
  const [moveIds, setMoveIds] = useState<string[] | null>(null)
  const [moveAccountTargets, setMoveAccountTargets] = useState<{ accounts: Array<{ id: string }>; allAccounts: boolean }>({ accounts: [], allAccounts: false })
  const moveConfirmed = useRef(new Map<string, string | null>())
  const [pendingMove, setPendingMove] = useState<ConfirmedUndoHandle | null>(null)
  const [moveDraft, setMoveDraft] = useState('')

  /* 削除の確認窓。 */
  const [deleteTarget, setDeleteTarget] = useState<ScenarioRow | null>(null)
  const [deleteSnapshot, setDeleteSnapshot] = useState<import('@/lib/api/types/scenarios').ScenarioConfirmation | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  /* 複製の窓（★V8 ）。 */
  const duplicateLock = useRef(false)
  const [duplicating, setDuplicating] = useState(false)
  const setDuplicateError =(message: string | null) => { if (message) notifyToast(message, { tone: 'error' }) }

  /* 行の「…」。開いている行のID。 */
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  /* 行の詳細パネル。開いている行のID。 */
  const [pendingStop, setPendingStop] = useState<string[] | null>(null)
  const [stopAccountTargets, setStopAccountTargets] = useState<{ accounts: Array<{ id: string }>; allAccounts: boolean }>({ accounts: [], allAccounts: false })
  const toggleBusyRef = useRef(false)
  const detailGuard = useInlineDetailGuard('scenario')
  const { id: panelId, setId: setPanelId } = detailGuard
  /** いま掴んでいるシナリオ。落とした先と入れ替える。 */
  const [dragId, setDragId] = useState<string | null>(null)
  /** キーボードで動かした結果を読み上げる（live 領域）。 */
  const [moveNotice, setMoveNotice] = useState('')

  /*
   * 直近で選んでいるアカウント。切替後に前のアカウント宛の遅い応答が
   * 返ってきても採用しないための印。
   */
  const activeAccountRef = useRef<string | null>(selectedAccountId)

  const scope = useRef({ accountId: selectedAccountId, loading: accountLoading })
  const mounted = useRef(true)
  if (scope.current.accountId !== selectedAccountId || scope.current.loading !== accountLoading) scope.current = { accountId: selectedAccountId, loading: accountLoading }
  const renderedScope = scope.current
  const currentScope = () => mounted.current && scope.current === renderedScope
  const leases = {
    edit: captureScenarioWriteAccess(),
    publish: captureScenarioWriteAccess('publish'),
    manageFolders: captureScenarioWriteAccess('manageFolders'),
  }
  const canWriteHere = (operation: ScenarioWriteOperation = 'edit') => currentScope() && !accountLoading && scenarioList.loaded && leases[operation]()
  const stoppedMessage = (completed = 0, total?: number) => total === undefined
    ? '本人・権限・LINEアカウントを確認できないため、変更を中止しました。'
    : `${formatNumber(total)} 件中 ${formatNumber(completed)} 件を保存しました。残りは本人・権限・LINEアカウントが変わったため送っていません。`
  const requireWrite = (operation: ScenarioWriteOperation = 'edit', completed = 0, total?: number) => {
    if (canWriteHere(operation)) return true
    if (currentScope()) setActionError(stoppedMessage(completed, total))
    return false
  }
  const deleteRun = useRef<object | null>(null)
  const duplicateRun = useRef<object | null>(null)
  const toggleRun = useRef<object | null>(null)
  const deleteWindow = useRef<object | null>(null)
  const moveWindow = useRef<object | null>(null)
  const renderedDeleteWindow = deleteWindow.current
  const renderedMoveWindow = moveWindow.current
  const deleteWindowScope = useRef(scope.current)
  const moveWindowScope = useRef(scope.current)
  const stopWindowScope = useRef(scope.current)
  const stopWindow = useRef<object>({})
  const renderedStopWindow = stopWindow.current
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  /* アカウントを切り替えたときだけフォルダの絞り込みを外す（最初の描画では URL の値を残す）。 */
  const previousAccountRef = useRef(selectedAccountId)
  useEffect(() => {
    activeAccountRef.current = selectedAccountId
    setFolders([])
    setUnfiledCount(null)
    if (previousAccountRef.current && previousAccountRef.current !== selectedAccountId) setFolderFilter('')
    previousAccountRef.current = selectedAccountId
    setOverallTotal(null)
    setStats(null)
    setStatsFailed(false)
    setSelectedIds(new Set())
    setPendingStop(null)
    toggleBusyRef.current = false
    toggleRun.current = null
    deleteRun.current = null
    duplicateRun.current = null
    duplicateLock.current = false
    setDuplicating(false)
    setDeleting(false)
  }, [selectedAccountId])

  const loadFolders = useCallback(async () => {
    try {
      const accountId = selectedAccountId
      const res = await api.folders.list('scenario', accountId ?? undefined)
      if (activeAccountRef.current !== accountId) return
      if (res.success) setFolders(res.data)
      setUnfiledCount(res.success ? res.unfiledCount ?? null : null)
    } catch {
      // 置き場が取れなくても一覧は出す。
    }
  }, [selectedAccountId])

  useEffect(() => {
    void loadFolders()
  }, [loadFolders])

  const loadOverallTotal = useCallback(async () => {
    const accountId = selectedAccountId
    try {
      const res = await api.scenarios.listPage({
        accountId: accountId || undefined,
        page: 1,
        limit: 1,
      })
      if (activeAccountRef.current !== accountId) return
      setOverallTotal(res.success ? res.data.total : null)
    } catch {
      if (activeAccountRef.current === accountId) setOverallTotal(null)
    }
  }, [selectedAccountId])

  useEffect(() => {
    void loadOverallTotal()
  }, [loadOverallTotal])

  const loadStats = useCallback(async () => {
    const accountId = selectedAccountId
    try {
      const res = await api.listStats.get(accountId ?? undefined)
      if (activeAccountRef.current !== accountId) return
      if (res.success) {
        setStats(res.data)
        setStatsFailed(false)
      } else {
        setStatsFailed(true)
      }
    } catch {
      if (activeAccountRef.current === accountId) setStatsFailed(true)
    }
  }, [selectedAccountId])

  useEffect(() => {
    void loadStats()
  }, [loadStats])

  useEffect(() => {
    setServerQuery(clampSearchQuery(nameQuery.trim()))
  }, [nameQuery])

  /* 「停止中のみ」と「有効のみ」は同時に掛からない（札が勝つ）。 */
  const activeParam: 0 | 1 | undefined = stoppedOnly ? 0 : savedFilter === 'active' ? 1 : undefined

  const loadScenarioPage = useCallback(async (
    request: { page: number; limit: number },
    signal: AbortSignal,
  ) => {
    if (accountLoading) return { items: [], total: 0, limit: request.limit, sort: [] }
    const res = await api.scenarios.listPage({
      accountId: selectedAccountId || undefined,
      page: request.page,
      limit: request.limit,
      query: serverQuery || undefined,
      active: activeParam,
      createdFrom: createdThisMonthOnly ? currentMonthStart() : undefined,
      folderId: folderFilter || undefined,
    }, signal)
    if (!res.success) throw new Error(res.error)
    return res.data
  }, [accountLoading, activeParam, createdThisMonthOnly, folderFilter, selectedAccountId, serverQuery])

  /* 板 ：右端は「20件表示」。 */
  const [perPage, setPerPage] = useListUrlValue('perPage', 20)
  const scenarioList = useOffsetServerList<ScenarioRow>({
    requestKey: JSON.stringify({
      ready: !accountLoading,
      accountId: selectedAccountId ?? '',
      query: serverQuery,
      active: activeParam ?? '',
      createdThisMonthOnly,
      folderFilter,
      perPage,
    }),
    load: loadScenarioPage,
    initialLimit: perPage,
    pageUrlKey: 'page',
  })
  /*
   * 押した瞬間の見せ方（★V8 サクサク感 B）。軽い操作は先にこの重ねで
   * 描き換え、裏で保存する。確定・失敗・取り消しで重ねを外し、読み直す。
   * ページ・絞り込みが変わったら重ねは捨てる（違う一覧に貼らない）。
   */
  const [optimisticRows, setOptimisticRows] = useState<{ key: string; rows: ScenarioRow[] } | null>(null)
  const listContextKey = JSON.stringify({
    account: selectedAccountId ?? '',
    query: serverQuery,
    active: activeParam ?? '',
    month: createdThisMonthOnly,
    folder: folderFilter,
    page: scenarioList.page,
  })
  /* 取り消し待ちの削除（5秒）の行は一覧から外して描く（動きの点検 17 番）。 */
  const shownRows = optimisticRows && optimisticRows.key === listContextKey ? optimisticRows.rows : scenarioList.items
  const scenarios = useMemo(
    () => shownRows,
    [shownRows],
  )
  /* 戻ってきたら前のスクロール位置へ（中身が描けてから）。 */
  useListScrollMemory(scenarioList.loaded)
  const loadScenarios = scenarioList.retry
  const editDisabled = !canEdit || !scenarioList.loaded || accountLoading

  /*
   * 選択状態はIDで持ち、一覧が読み直されたときに居なくなった行はそのまま
   * 外す（アカウント切替・削除・検索で外れた行を数え続けない）。
   */
  useEffect(() => {
    setSelectedIds((current) => {
      if (current.size === 0) return current
      const listed = new Set(scenarios.map((s) => s.id))
      const next = new Set([...current].filter((id) => listed.has(id)))
      return next.size === current.size ? current : next
    })
  }, [scenarios])

  /** 配信方式の選択へ送るだけ。ここでは作らない。作るのは方式を選んで確定したとき。 */
  const handleCreate = () => {
    if (!requireWrite()) return
    router.push('/scenarios/mode')
  }

  /** 絞り込み0件の1枚から条件を外す。 */
  const clearScenarioFilters = () => {
    setNameQuery('')
    setServerQuery('')
    setStoppedOnly(false)
    setCreatedThisMonthOnly(false)
    setSavedFilter('')
    setFolderFilter('')
  }
  const scenarioFilterActive = Boolean(serverQuery || activeParam !== undefined || createdThisMonthOnly || folderFilter)

  /*
   * 掴んで入れ替えた並びを先に描き換え、裏で保存する（★V8 サクサク感 B）。
   * 5秒のあいだは知らせの「元に戻す」で送らずに戻せる。
   */
  const handleReorder = (ids: string[]) => {
    if (!requireWrite()) return
    setActionError('')
    const key = listContextKey
    const byId = new Map(scenarios.map((s) => [s.id, s]))
    const nextRows = ids.map((id) => byId.get(id)).filter((s): s is ScenarioRow => s !== undefined)
    if (nextRows.length !== scenarios.length) {
      void loadScenarios()
      return
    }
    setOptimisticRows({ key, rows: nextRows })
    runUndoable({
      message: '並び順を変えました',
      commit: async () => {
        if (!currentScope()) return
        if (!requireWrite()) throw new Error(stoppedMessage())
        const fullOrder = await completeReorder(ids, loadScenarioPage)
        if (!currentScope()) return
        if (!requireWrite()) throw new Error(stoppedMessage())
        const res = await api.scenarios.reorder(fullOrder)
        if (!res.success) throw new Error(res.error)
      },
      undo: () => { if (currentScope()) setOptimisticRows(null) },
      failureMessage: '並び順を保存できませんでした。',
      onCommitted: () => {
        if (!currentScope()) return
        setOptimisticRows(null)
        void loadScenarios()
      },
    })
  }

  const handleDelete = async (target: ScenarioRow) => {
    if (!requireWrite()) throw new Error(stoppedMessage())
    if (!deleteSnapshot) throw new Error('シナリオの対象を確認できません。')
    try {
      const res = await api.scenarios.delete(target.id, deleteSnapshot)
      if (!res.success) throw new Error(res.error)
      if (!currentScope()) return
      void loadScenarios()
      void loadFolders()
      void loadOverallTotal()
      void loadStats()
    } catch {
      throw new Error('シナリオを削除できませんでした。時間をおいて、もう一度お試しください。')
    }
  }

  /* 削除は、利用状況にかかわらず確認してから実行する。 */
  const requestDelete = async (s: ScenarioRow) => {
    if (!requireWrite()) return
    const ticket = {}; deleteWindow.current = ticket; deleteWindowScope.current = renderedScope
    setDeleteError(''); setDeleteSnapshot(null); setDeleteLoading(true); setDeleteTarget(s)
    try {
      const result = await api.scenarios.confirmation(s.id, 'delete')
      if (!result.success || !result.data || !Array.isArray(result.data.referrers) || ![result.data.contentRevision, result.data.activeCount, result.data.rowIdSum, result.data.rowIdSquareSum, result.data.totalCount, result.data.totalRowIdSum, result.data.totalRowIdSquareSum].every(Number.isSafeInteger)) throw new Error('確認できません')
      if (deleteWindow.current === ticket && currentScope()) setDeleteSnapshot(result.data)
    } catch { if (deleteWindow.current === ticket && currentScope()) setDeleteError('削除対象を確認できません。閉じてもう一度お試しください。') }
    finally { if (deleteWindow.current === ticket && currentScope()) setDeleteLoading(false) }
  }

  /* ===== まとめて「止める／再開」 ===== */

  const allOnPageSelected = scenarios.length > 0 && scenarios.every((s) => selectedIds.has(s.id))
  const selectedCount = selectedIds.size
  /* 選んでいる間は Esc で選択を外す（動きの点検 12 番）。 */
  const clearSelection = useCallback(() => setSelectedIds(new Set()), [])
  useEscapeToClearSelection(selectedCount > 0, clearSelection)
  const [selectionRows, setSelectionRows] = useState<ScenarioRow[]>([])
  const selectedRows = [...new Map([...scenarios, ...selectionRows].map(row => [row.id, row])).values()].filter(row => selectedIds.has(row.id))
  const selectAllScenarios = async () => {
    const account = selectedAccountId
    const rows = await collectListRows(scenarioList.total, (offset, limit) => loadScenarioPage({ page: Math.floor(offset / limit) + 1, limit }, new AbortController().signal))
    if (activeAccountRef.current !== account) return
    setSelectionRows(rows); setSelectedIds(new Set(rows.map(row => row.id)))
  }
  const stoppableIds = selectedRows.filter((s) => s.isActive).map((s) => s.id)
  const resumableIds = selectedRows.filter((s) => !s.isActive).map((s) => s.id)

  const toggleAllOnPage = () => {
    if (!canWriteHere()) return
    setSelectedIds((current) => {
      const next = new Set(current)
      if (allOnPageSelected) scenarios.forEach((s) => next.delete(s.id))
      else scenarios.forEach((s) => next.add(s.id))
      return next
    })
  }
  const toggleOne = (id: string) => {
    if (!canWriteHere()) return
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /*
   * まとめて「止める／再開」は押した瞬間に描き換え、裏で保存する
   * （★V8 サクサク感 B）。確認の窓は出さず、5秒のあいだ知らせの
   * 「元に戻す」で送らずに戻せる。1本ずつの開始前チェックは詳細画面で行う。
   */
  const runBulkToggle = (next: boolean, ids: string[]) => {
    if (!requireWrite('publish')) return
    if (ids.length === 0 || toggleBusyRef.current) return
    toggleBusyRef.current = true
    const ticket = {}; toggleRun.current = ticket
    let toggleFailure = next ? '配信を始められませんでした。' : '停止できませんでした。'
    const key = listContextKey
    setOptimisticRows({
      key,
      rows: scenarios.map((s) => (ids.includes(s.id) ? { ...s, isActive: next } : s)),
    })
    runOptimistic({
      isCurrent: () => currentScope() && toggleRun.current === ticket,
      request: async () => {
        let saved = 0
        for (const id of ids) {
          if (!currentScope()) return
          if (!canWriteHere('publish')) { toggleFailure = stoppedMessage(saved, ids.length); throw new Error(toggleFailure) }
          try {
            const res = await api.scenarios.update(id, { isActive: next })
            if (!res.success) throw new Error(res.error)
            saved++
          } catch (failure) {
            saveErrors.capture(failure)
            toggleFailure = `全 ${formatNumber(ids.length)} 件中 ${formatNumber(saved)} 件の保存を確認しました。${formatNumber(saved + 1)} 件目で止めました。未送信は ${formatNumber(ids.length - saved - 1)} 件です。理由：${describeApiFailure(failure, next ? '開始' : '停止')}`
            throw failure
          }
        }
      },
      revert: () => { toggleBusyRef.current = false; setOptimisticRows(null); void loadScenarios() },
      get failureMessage() { return toggleFailure },
      onSuccess: () => {
        toggleBusyRef.current = false
        setOptimisticRows(null)
        setSelectedIds(new Set())
        void loadScenarios()
        void loadStats()
      },
    })
  }

  /* ===== フォルダ移動の窓 ===== */

  const confirmedStops = useRef<Array<{ id: string; revision: number; activeCount: number; rowIdSum: number; rowIdSquareSum: number }> | null>(null)
  const [stopLoading, setStopLoading] = useState(false)
  const [stopPeople, setStopPeople] = useState<number | null>(null)
  const [stopBusy, setStopBusy] = useState(false)
  const [stopError, setStopError] = useState('')
  useEffect(() => { setStopError('') }, [pendingStop])
  const openConfirmedStop = async (ids: string[], rows: ScenarioRow[]) => {
    const ticket = {}; stopWindow.current = ticket; stopWindowScope.current = renderedScope
    confirmedStops.current = null; setStopPeople(null); setStopLoading(true); setStopError('')
    setStopAccountTargets(scenarioAccountTargets(ids, rows)); setPendingStop(ids)
    try {
      const snapshots = await Promise.all(ids.map(async id => {
        const response = await api.scenarios.confirmation(id, 'stop')
        if (!response.success || !response.data) throw new Error('確認できませんでした')
        const { contentRevision, activeCount, rowIdSum, rowIdSquareSum } = response.data
        if (![contentRevision, activeCount, rowIdSum, rowIdSquareSum].every(Number.isSafeInteger)) throw new Error('確認できませんでした')
        return { id, revision: contentRevision, activeCount, rowIdSum, rowIdSquareSum }
      }))
      if (stopWindow.current !== ticket || stopWindowScope.current !== renderedScope || !currentScope()) return
      confirmedStops.current = snapshots; setStopPeople(snapshots.reduce((sum, item) => sum + item.activeCount, 0))
    } catch {
      if (stopWindow.current === ticket && currentScope()) setStopError('停止する対象を確認できません。閉じてもう一度お試しください。')
    } finally { if (stopWindow.current === ticket && currentScope()) setStopLoading(false) }
  }
  const runConfirmedStop = async () => {
    const ids = pendingStop
    if (!ids?.length || stopWindow.current !== renderedStopWindow || stopWindowScope.current !== renderedScope || !requireWrite('publish') || toggleBusyRef.current) return
    const attempt = confirmedStops.current
    if (!attempt || attempt.length !== ids.length) { setStopError('停止できませんでした。'); return false }
    const current = () => currentScope() && stopWindow.current === renderedStopWindow && confirmedStops.current === attempt
    toggleBusyRef.current = true; setStopBusy(true); setStopError('')
    try {
      if (!canWriteHere('publish')) { setStopError(stoppedMessage(0, ids.length)); return false }
      try {
        const response = await api.scenarios.bulkStop(attempt)
        if (!response.success) throw new Error(response.error)
      } catch (failure) {
        if (!current()) return false
        saveErrors.capture(failure)
        setStopError(describeApiFailure(failure, '停止'))
        return false
      }
      if (!current()) return
      setSelectedIds(new Set()); setOptimisticRows(null)
      void loadScenarios(); void loadStats()
      return true
    } finally { toggleBusyRef.current = false; if (current()) setStopBusy(false) }
  }

  const openMove = (ids: string[]) => {
    if (!requireWrite()) return
    if (ids.length === 0) return
    setMoveAccountTargets(scenarioAccountTargets(ids, [...selectionRows, ...scenarios]))
    moveWindow.current = {}; moveWindowScope.current = renderedScope
    setMoveDraft('')
    moveConfirmed.current = new Map()
    setMoveIds(ids)
  }

  /*
   * フォルダ移動は窓で行き先だけ選び、押した瞬間に描き換えて裏で保存する
   * （★V8 サクサク感 B）。5秒のあいだ知らせの「元に戻す」で送らずに戻せる。
   */
  const runMove = async () => {
    if (moveWindow.current !== renderedMoveWindow || moveWindowScope.current !== renderedScope || !requireWrite() || !moveIds?.length) return
    const confirmed = moveConfirmed.current
    const ids = moveIds
    const folderId = moveDraft || null
    const key = listContextKey
    const before = scenarios
    const restore = () => {
      if (!(moveConfirmed.current === confirmed && currentScope())) return
      setOptimisticRows(confirmed.size ? {
        key,
        rows: before.map(row => confirmed.has(row.id)
          ? { ...row, folderId: confirmed.get(row.id) ?? null } : row),
      } : null)
    }
    setOptimisticRows({ key, rows: before.map(row => ids.includes(row.id) ? { ...row, folderId } : row) })
    let moveFailure = ''
    const handle = runUndoable({
      confirmation: true,
      message: folderId ? 'フォルダへ移しました' : 'フォルダから外しました',
      commit: async () => {
        for (const id of ids) {
          if (confirmed.has(id) && confirmed.get(id) === folderId) continue
          if (!(moveConfirmed.current === confirmed && currentScope()) || !(canWriteHere())) {
            const saved = ids.filter(value => confirmed.has(value) && confirmed.get(value) === folderId).length
            moveFailure = stoppedMessage(saved, ids.length)
            throw new Error(moveFailure)
          }
          try {
            const result = await api.scenarios.update(id, { folderId })
            if (!result.success) throw new Error(result.error)
            confirmed.set(id, folderId)
          } catch (reason) {
            saveErrors.capture(reason)
            const saved = ids.filter(value => confirmed.has(value) && confirmed.get(value) === folderId).length
            moveFailure = `全 ${formatNumber(ids.length)} 件中 ${formatNumber(saved)} 件の保存を確認しました。${formatNumber(ids.indexOf(id) + 1)} 件目で止めました。未送信は ${formatNumber(ids.slice(ids.indexOf(id) + 1).filter(value => !confirmed.has(value) || confirmed.get(value) !== folderId).length)} 件です。理由：${describeApiFailure(reason, 'フォルダ移動')}`
            throw reason
          }
        }
      },
      undo: restore,
      onCommitError: restore,
      get failureMessage() { return moveFailure || undefined },
      onCommitted: () => {
        if (!(moveConfirmed.current === confirmed && currentScope())) return
        setOptimisticRows(null)
        const moved = new Set(ids)
        setSelectedIds(values => new Set([...values].filter(id => !moved.has(id))))
        void loadScenarios(); void loadFolders()
      },
    })
    setPendingMove(handle)
    try {
      const result = await handle.finished
      return (moveConfirmed.current === confirmed && currentScope()) ? result : undefined
    }
    finally { setPendingMove(value => value === handle ? null : value) }
  }

  /* ===== 削除 ===== */

  /*
   * 押した時点のシナリオを窓に固定する。一覧が引き直されて対象が
   * 居なくなったら消さずに選び直してもらう。
   */
  const targetStillListed =
    deleteTarget !== null && scenarios.some((s) => s.id === deleteTarget.id)

  const runDelete = async () => {
    if (deleteWindow.current !== renderedDeleteWindow) return
    if (deleteWindowScope.current !== renderedScope) { if (currentScope()) setActionError('LINEアカウントが変わったため、この窓では保存できません。閉じて選び直してください。'); return }
    if (!requireWrite()) return
    if (!deleteTarget || deleting || !targetStillListed) return
    const ticket = {}; deleteRun.current = ticket
    setDeleting(true)
    setDeleteError('')
    try {
      await handleDelete(deleteTarget)
      if (!currentScope() || deleteRun.current !== ticket) return
      setDeleteTarget(null)
      if (!canWriteHere()) notifyToast('削除しました。変更後の権限で一覧を確認してください。', { tone: 'success' })
    } catch {
      if (!currentScope() || deleteRun.current !== ticket) return
      setDeleteError('このシナリオを削除できませんでした。状態を読み直してから、もう一度お試しください。')
    } finally {
      if (currentScope() && deleteRun.current === ticket) setDeleting(false)
    }
  }

  /* ===== 複製（★V8 ） ===== */

  const openDuplicate = (s: ScenarioRow) => { void runDuplicate(s)
  }

  const runDuplicate = async (duplicateTarget: ScenarioRow) => {
    if (!requireWrite()) return
    if (duplicateLock.current) return
    if (!duplicateTarget || duplicating) return
    duplicateLock.current = true
    const ticket = {}; duplicateRun.current = ticket
    const name = `${duplicateTarget.name}のコピー`
    setDuplicating(true)
    setDuplicateError('')
    try {
      const copyId = await duplicateScenario(duplicateTarget.id, name, canWriteHere)
      if (!currentScope() || duplicateRun.current !== ticket) return
      if (!canWriteHere()) { setDuplicateError('本人・権限が変わったため処理を止めました。作成済みのコピーを一覧で確認してください。'); void loadScenarios(); return }

      notifyToast('複製しました', { tone: 'success' })
      void loadScenarios()
      void loadOverallTotal()
      void loadStats()
      duplicateFeedback.mark(duplicateTarget.id, copyId)
    } catch (e) {
      if (!currentScope() || duplicateRun.current !== ticket) return
      if (e instanceof DuplicateAborted) {
        setDuplicateError(`複製が「${e.stage}」で止まりました。作成済みのコピーを一覧で確認してください。`)
      } else {
        setDuplicateError(describeApiFailure(e, '複製'))
      }
      void loadScenarios()
    } finally {
      if (currentScope() && duplicateRun.current === ticket) { duplicateLock.current = false; setDuplicating(false) }
    }
  }

  /* ===== 並び替え ===== */

  /*
   * 動かせるのは絞り込みが無く、全件が1ページに出ているときだけ（リマインダ・リッチメニューと同じ決まり）。
   * 保存は渡した行に 0 から番号を振り直すため、一部の行だけで保存すると隠れた行と番号がぶつかる。
   */
  const reorderDisabledReason = serverQuery || activeParam !== undefined || createdThisMonthOnly || folderFilter
    ? '絞り込みを外すと動かせます' : null
  const canReorder = !editDisabled && reorderDisabledReason === null

  /* 動かしている間、置き場所を入れ替えて見せ、ほかの行は滑らかに場所を空ける（フルード ②）。 */
  const liveOrder = useLiveReorder(scenarios, (row) => row.id, dragId)

  const dropOn = (targetId: string) => {
    const from = dragId
    setDragId(null)
    if (!from || from === targetId || !canReorder) return
    const order = scenarios.map((s) => s.id)
    const fromIdx = order.indexOf(from)
    const toIdx = order.indexOf(targetId)
    if (fromIdx < 0 || toIdx < 0) return
    order.splice(toIdx, 0, ...order.splice(fromIdx, 1))
    void handleReorder(order)
  }

  const keyboardMove = (id: string, direction: -1 | 1) => {
    const order = scenarios.map((s) => s.id)
    const fromIdx = order.indexOf(id)
    const toIdx = fromIdx + direction
    const name = scenarios.find((s) => s.id === id)?.name ?? 'このシナリオ'
    if (fromIdx < 0 || !canReorder) return
    if (toIdx < 0 || toIdx >= order.length) {
      setMoveNotice(`「${name}」は${direction < 0 ? '先頭' : '末尾'}にあるため、これ以上動かせません`)
      return
    }
    order.splice(toIdx, 0, ...order.splice(fromIdx, 1))
    setMoveNotice(`「${name}」を${direction < 0 ? '上' : '下'}へ移動しました。${toIdx + 1}番目です`)
    void handleReorder(order)
  }

  /* ===== フォルダの列 ===== */

  /*
   * 「すべて」とフォルダ内訳の母集団の差。全アカウント共通のシナリオは
   * 一覧（＝「すべて」）には出るが、フォルダAPIの件数には入らない。
   * 差があるときだけ理由を書く。
   */
  const folderedTotal = folders.every((f) => f.itemCount !== undefined)
    ? folders.reduce((sum, f) => sum + (f.itemCount ?? 0), 0)
    : null
  const sharedScenarioCount =
    overallTotal !== null && unfiledCount !== null && folderedTotal !== null
      ? Math.max(0, overallTotal - folderedTotal - unfiledCount)
      : 0

  const folderSelectOptions = [
    { value: '', label: 'フォルダ：すべて' },
    ...folders.map((f) => ({ value: f.id, label: `フォルダ：${f.name}` })),
    { value: UNFILED, label: 'フォルダ：未分類' },
  ]

  const createButton = (full: boolean) => (
    <Button
      type="button"
      variant="primary"
      className={full ? 'v8-folder-create w-full' : undefined}
      onClick={handleCreate}
      disabled={editDisabled}
      lockedReason={editAccess.reason}
    >
      <Plus size={16} aria-hidden="true" />
      シナリオを作る
    </Button>
  )

  const folderPanel = (
    <ManagedFolderPanel
      createAction={createButton(true)}
      kind="scenario"
      accountId={selectedAccountId ?? null}
      folders={folders}
      onChanged={loadFolders}
      canManage={folderAccess.allowed}
      canWriteNow={() => canWriteHere('manageFolders')}
      lockedReason={folderAccess.reason ?? null}
      itemLabel="シナリオ"
      activeId={folderFilter}
      onSelect={(id) => detailGuard.protect(() => setFolderFilter(id))}
      allId=""
      unfiledId={UNFILED}
      allCount={overallTotal}
      unfiledCount={unfiledCount}
      placeholder="例：01_新規フォロー"
    >
      {sharedScenarioCount > 0 ? (
        <p className={styles.folderNote}>
          全アカウントに共通で適用されるシナリオが{formatNumber(sharedScenarioCount)} 件あります。「すべて」の件数には含まれますが、フォルダ別の件数と「未分類」には含まれません。
        </p>
      ) : null}
    </ManagedFolderPanel>
  )

  /* ===== 数の帯（4つ） ===== */

  /* 板 ：1つ目の補足は「有効 3・停止中 2」。止めた数は合計から出す。 */
  const scenarioStopped = stats ? Math.max(0, stats.scenarios.total - stats.scenarios.active) : null
  const kpis = [
    {
      title: 'シナリオ',
      icon: Workflow,
      value: overallTotal,
      unit: '件',
      detail: `有効 ${stats ? stats.scenarios.active : emptyValue('unknown')}・停止中 ${scenarioStopped ?? emptyValue('unknown')}`,
    },
    {
      title: '配信中',
      icon: Users,
      value: statsFailed ? null : stats?.scenarios.subscribers ?? null,
      unit: '人',
      detail: 'いま途中にいる人（重複を含む）',
    },
    {
      title: '最後まで配信した人',
      icon: CheckCheck,
      value: statsFailed ? null : stats?.scenarios.completed ?? null,
      unit: '人',
      detail: stats && overallTotal !== null ? `全${formatNumber(overallTotal)}件の合計` : emptyValue('unknown'),
    },
    {
      title: '今週送った数',
      icon: Send,
      value: statsFailed ? null : stats?.scenarios.sentThisWeek ?? null,
      unit: '通',
      detail: '過去7日',
    },
  ]

  /* ===== 行の「…」の中身（★V8：複製・配信結果・削除） ===== */

  // 結果を見る操作は残し、書込の項目だけ理由付きで拒否する。
  const rowMenuItems = (s: ScenarioRow): ActionMenuItem[] => ([
    {
      id: 'duplicate',
      label: '複製する',
      disabled: editDisabled || duplicating,
      lockedReason: editAccess.reason,
      disabledReason: duplicating ? '複製しています…' : undefined,
      onSelect: () => detailGuard.protect(() => openDuplicate(s)),
    },
    {
      id: 'results',
      label: '配信結果を見る',
      onSelect: () =>
        withViewTransition(() => {
          router.push(`/scenarios/results?id=${encodeURIComponent(s.id)}`)
        }),
    },
    {
      id: 'delete',
      label: '削除する',
      disabled: editDisabled,
      lockedReason: editAccess.reason,
      tone: 'danger',
      dividerBefore: true,
      onSelect: () => detailGuard.protect(() => { void requestDelete(s) }),
    },
  ] as ActionMenuItem[])

  /** 一覧の行→詳細はつながる移り変わりで開く。 */
  const goDetail = (id: string) => {
    withViewTransition(() => {
      router.push(`/scenarios/detail?id=${id}`)
    })
  }

  /** 右クリックは「…」と同じ項目をマウスの位置に出す。 */
  const rowContextItems = (s: ScenarioRow): ContextMenuItem[] =>
    rowMenuItems(s).map((item) => ({
      id: item.id,
      label: item.label,
      danger: item.tone === 'danger',
      disabled: item.disabled,
      lockedReason: item.lockedReason,
      disabledReason: item.disabledReason,
      onSelect: () => item.onSelect?.(),
    }))

  const panelIndex = panelId === null ? -1 : scenarios.findIndex((s) => s.id === panelId)
  const panelRow = useHeldDetail(panelIndex >= 0 ? scenarios[panelIndex] : null, panelId, detailGuard.holding, selectedAccountId ?? null)

  /** パネル内の名前のその場の書き換え。失敗したら InlineEdit が戻す。 */
  const renameScenario = async (id: string, next: string): Promise<unknown> => {
    if (!requireWrite()) throw new Error(stoppedMessage())
    const res = await api.scenarios.update(id, { name: next })
    if (!res.success) throw new Error(res.error)
    if (currentScope()) await loadScenarios()
    return res
  }

  /* ===== 表 ===== */

  /*
   * 列の幅（絵 ：シナリオ 608・購読中 / 読み終えた 146・状態 96。
   * 狭い板  はシナリオが残りの幅を取る）。値は変数、ここは class だけ。
   */
  const colgroup = (
    <colgroup>
      <col className={styles.colSelect} />
      <col className={styles.colGrip} />
      <col className={narrow ? undefined : styles.colName} />
      <col className={styles.colCount} />
      <col className={styles.colState} />
      <col className={styles.colMenu} />
    </colgroup>
  )

  const tableHeadCells = (
    <>
      <Th aria-label="並び替え" />
      <Th className={styles.headCell}>シナリオ</Th>
      <Th className={styles.headCell}>配信中・最後まで配信</Th>
      <Th className={styles.headCell}>状態</Th>
      <Th aria-label="操作" />
    </>
  )

  /*
   * 読み込み中の骨組み（★V8 サクサク感 A）。出来上がりの表と同じ
   * 列幅で5行出し、入れ替わってもガタつかない。
   * 0.3秒以内に来たら出さず、出したら最低0.4秒残すのは共通部品に任せる。
   */
  const loadingSkeleton = (
    <DataTable>
      {colgroup}
      <thead>
        <TableHeadRow>
          <Th className={styles.selectCell} aria-label="選択" />
          {tableHeadCells}
        </TableHeadRow>
      </thead>
      <tbody>
        {[0, 1, 2, 3, 4].map((n) => (
          <Tr key={n} className={styles.row}>
            <Td className={styles.selectCell} />
            <Td className={styles.gripCell} />
            <Td>
              <Skeleton width={200} height={16} />
              <span className={styles.skeletonGap} aria-hidden="true" />
              <Skeleton width={280} height={12} />
            </Td>
            <Td className={styles.countCell}>
              <Skeleton width={56} height={16} />
            </Td>
            <Td>
              <Skeleton width={72} height={24} className="rounded-pill" />
            </Td>
            <Td className={styles.menuCell} />
          </Tr>
        ))}
      </tbody>
    </DataTable>
  )

  const listBody =
    !scenarioList.loaded && !scenarioList.error ? (
      <div className={styles.tableWrap} aria-busy="true" aria-label="読み込んでいます">
        <DelayedSkeleton loading skeleton={loadingSkeleton} />
      </div>
    ) : scenarioList.error ? (
      /* 板 「読み込めなかった」。数の帯は「—」のまま。 */
      <ListState kind="error" title="シナリオを読み込めませんでした" description="作ったシナリオは消えていません。通信を確かめて、もう一度試してください。" data-design-node="BxGhV" action={<><Button type="button" onClick={() => void loadScenarios()}>もう一度読み込む</Button></>} />
    ) : scenarios.length === 0 ? (
      /* 修正案 D-2（2026-10-07 採用）：空の一覧は次の一歩へ導く。 */
      <EmptyList
        data-design-node="BxGhV"
        icon={<ListVideo aria-hidden="true" />}
        title="まだシナリオがありません"
        description="友だち追加や購入をきっかけに、決めた順番でメッセージを届けます。"
        create={{ label: '最初のシナリオを作る', onClick: handleCreate }}
        canCreate={!editDisabled}
        lockedReason={editAccess.reason ?? null}
        filtered={scenarioFilterActive}
        onClearFilters={clearScenarioFilters}
        filteredDescription="「停止中のみ」「今月作った」や検索を外すと、すべて出ます"
      />
    ) : (
      <>
        {/* キーボードで動かした結果を読み上げる。画面には出さない。 */}
        <span className="sr-only" role="status" aria-live="polite">
          {moveNotice}
        </span>
        <div className={styles.tableWrap} data-content-in="">
          <DataTable>
            {colgroup}
            <thead>
              <TableHeadRow>
                <Th className={styles.selectCell} aria-label="選択">
                  <SaveErrorField names={["allOnPageSelected","all_on_page_selected"]}><Checkbox
                    checked={allOnPageSelected}
                    indeterminate={!allOnPageSelected && selectedCount > 0}
                    onCheckedChange={() => toggleAllOnPage()}
                    aria-label="このページのシナリオをすべて選択"
                    disabled={editDisabled}
                    lockedReason={editAccess.reason}
                  /></SaveErrorField>
                </Th>
                {tableHeadCells}
              </TableHeadRow>
            </thead>
            <RovingTbody reorderKey={duplicateFeedback.order(liveOrder.shown, scenarios).map((s) => s.id).join(',')}>
              {duplicateFeedback.order(liveOrder.shown, scenarios).map((s, saveFieldIndex) => {
                const rowFolder = s.folderId ? folders.find((f) => f.id === s.folderId) : undefined
                const folderName = s.folderId
                  ? rowFolder?.name ?? 'フォルダ'
                  : '未分類'
                const showFolder = folders.length > 0 || s.folderId
                const meta = [
                  deliveryModeLabels[s.deliveryMode ?? 'relative'],
                  s.stepCount === undefined ? '—通' : `${s.stepCount} 通`,
                  ...(showFolder ? [folderName] : []),
                ].join('・')
                /* 絵：送り方・通数・フォルダのあとに全角の間を空けて説明。1つの文字列で書く。 */
                const sub = s.description ? `${meta}　${s.description}` : meta
                const subscribers = scenarioCountLabel(s.subscriberCount)
                const completedLabel = scenarioCountLabel(s.completedCount)
                return (
                  <Tr selected={selectedIds.has(s.id)}
                    interactive
                    highlighted={duplicateFeedback.highlightedId === s.id}
                    key={s.id}
                    data-reorder-id={s.id}
                    onDragEnter={() => liveOrder.enter(s.id)}
                    onDragOver={dragId ? (event) => event.preventDefault() : undefined}
                    onDrop={dragId ? () => dropOn(liveOrder.dropTarget(s.id)) : undefined}
                    className={`${styles.row} ${styles.rowClick}`}
                    tabIndex={0}
                    detailKey="scenario" onOpen={() => setPanelId(panelId === s.id ? null : s.id)}
                     data-row-id={s.id}
                  >
                    <Td className={styles.selectCell}>
                      <SaveErrorField names={[`shown.${saveFieldIndex}.id`,"id","s.id"]}><Checkbox
                        checked={selectedIds.has(s.id)}
                        onCheckedChange={() => toggleOne(s.id)}
                        aria-label={`${s.name}を選択`}
                        disabled={editDisabled}
                        lockedReason={editAccess.reason}
                      /></SaveErrorField>
                    </Td>
                    <Td
                      className={styles.gripCell}
                      onClick={(event) => event.stopPropagation()}
                      draggable={canReorder}
                      onDragStart={() => { if (canWriteHere() && canReorder) setDragId(s.id) }}
                      onDragEnd={() => setDragId(null)}
                      title={canReorder ? '上下に動かして並び替え' : undefined}
                    >
                      <ReorderHandle
                        label={s.name}
                        disabledReason={reorderDisabledReason}
                        disabled={editDisabled}
                        lockedReason={editAccess.reason}
                        onMove={(direction) => keyboardMove(s.id, direction)}
                      />
                    </Td>
                    <NameCell name={
                        <div className={styles.nameRow}>
                          <>
                            <RowNameLink
                              href={`/scenarios/detail?id=${s.id}`}

                              className={styles.cellTitle}
                              onClick={(event) => {
                                event.stopPropagation()

                              }}
                            >
                              <TruncatedText value={String(s.name ?? '')} />
                            </RowNameLink>
                          </>
                          {s.lineAccountId === null && (
                            <span className={styles.miniBadge} title="全アカウントに適用されるシナリオです">
                              全アカウント共通
                            </span>
                          )}
                        </div>
                      } folder={rowFolder ? { name: rowFolder.name, color: rowFolder.color } : null}
                    />
                    <Td
                      className={styles.countCell}
                      title={`配信中 ${subscribers}・最後まで配信 ${completedLabel}`}
                    >
                      {/* 配信中と最後まで配信は別の人。割らずに並べ、棒は「最後まで ÷ 登録した人（＝足した数）」で分母を言葉で書く。 */}
                      <div className={styles.countMain}>{`配信中 ${subscribers}・最後まで配信 ${completedLabel}`}</div>
                      {(() => {
                        if (!isKnownScenarioCount(s.subscriberCount) || !isKnownScenarioCount(s.completedCount)) return null
                        const completed = s.completedCount
                        const enrolled = s.subscriberCount + completed
                        return enrolled === 0 ? <div className={styles.countRow}><span className={styles.countSub}>登録した 0 人</span></div> : (
                          <div className={styles.countRow}>
                            <ProgressBar value={completed} max={enrolled} label={`${s.name ?? 'シナリオ'}を最後まで配信した割合`} className={styles.countBar} />
                            <span className={styles.countSub}>{scenarioCompletionDetail(s.subscriberCount, completed)}</span>
                          </div>
                        )
                      })()}
                    </Td>
                    <Td>
                      <SharedStatusPill tone={s.isActive ? 'success' : 'neutral'}>{s.isActive ? '有効' : '停止中'}</SharedStatusPill>
                    </Td>
                    <Td className={styles.menuCell}>
                      {/* 横並びにして、メニューの位置の目印（空の span）が行を1段増やさないようにする。 */}
                      <div className={styles.menuBox}>
                        <ContextMenu label={`シナリオ「${s.name}」の操作`} items={rowContextItems(s)}>
                          <RowMenu
                            size="row"
                            label={`シナリオ「${s.name}」の操作`}
                            items={rowMenuItems(s)}
                            open={openMenuId === s.id}
                            onOpenChange={(next) => setOpenMenuId(next ? s.id : null)}
                          />
                        </ContextMenu>
                      </div>
                    </Td>
                  </Tr>
                )
              })}
            </RovingTbody>
          </DataTable>
        </div>

        {/* まとめての帯（選ぶと表の下に出る）：止める・再開・フォルダへ移す。 */}
        {selectedCount > 0 ? (
          <BulkBar count={selectedCount} total={scenarioList.total} onSelectAll={selectAllScenarios} onClear={clearSelection}><Button
              type="button"
              variant="secondary"
              disabled={!publishAccess.allowed || !scenarioList.loaded || stoppableIds.length === 0}
              lockedReason={publishAccess.reason}
              disabledReason={publishAccess.allowed && stoppableIds.length === 0 ? '有効のシナリオが選ばれていません' : undefined}
              onClick={() => { if (requireWrite('publish')) void openConfirmedStop(stoppableIds, [...scenarios, ...selectionRows]) }}
            >
              <Square size={16} aria-hidden="true" />
              止める
            </Button><Button
              type="button"
              variant="secondary"
              disabled={!publishAccess.allowed || !scenarioList.loaded || resumableIds.length === 0}
              lockedReason={publishAccess.reason}
              disabledReason={publishAccess.allowed && resumableIds.length === 0 ? '停止中のシナリオが選ばれていません' : undefined}
              onClick={() => runBulkToggle(true, resumableIds)}
            >
              <Play size={16} aria-hidden="true" />
              再開
            </Button><Button
              type="button"
              variant="secondary"
              disabled={editDisabled}
              lockedReason={editAccess.reason}
              onClick={() => openMove([...selectedIds])}
            >
              <FolderIcon size={16} aria-hidden="true" />
              フォルダへ移す
            </Button><Button type="button" variant="secondary" onClick={() => setSelectedIds(new Set())}>
              選択を外す
            </Button></BulkBar>
        ) : null}
      </>
    )

  /* ページ送りは型の pagination 枠へ。 */
  const listPager = scenarioList.loaded && !scenarioList.error ? (
    <ListPagePagination>
      <Pagination page={scenarioList.page} pageCount={scenarioList.pageCount} onPageChange={scenarioList.setPage} correctOutOfRange={scenarioList.loaded && !scenarioList.error}
        range={{ total: scenarioList.total, first: (scenarioList.page - 1) * scenarioList.limit + 1, last: Math.min(scenarioList.page * scenarioList.limit, scenarioList.total) }} />
    </ListPagePagination>
  ) : null

  /* ===== 道具の段の部品（広い板と狭い板で同じものを並べ替える） ===== */

  const filterChips = (
    <div role="group" aria-label="状態で絞り込む" className={styles.chipGroup}>
      <FilterChip
        selected={stoppedOnly}
        onChange={(next) => {
          setStoppedOnly(next)
          if (next && savedFilter === 'active') setSavedFilter('')
        }}
        title="止めてあるシナリオだけ"
        icon={<Pause size={16} aria-hidden="true" />}
      >
        停止中のみ
      </FilterChip>
      <FilterChip
        selected={createdThisMonthOnly}
        onChange={(next) => setCreatedThisMonthOnly(next)}
        title="今月（日本時間）作ったシナリオだけ"
        icon={<CalendarPlus size={16} aria-hidden="true" />}
      >
        今月作った
      </FilterChip>
    </div>
  )

  const savedFilterControl = (
    <SaveErrorField names={["savedFilter","saved_filter"]}><Select
      aria-label="よく使う絞り込み"
      size="full"
      icon={<Bookmark aria-hidden="true" />}
      valueAlign="start"
      showChevron={false}
      iconOnly={narrow}
      value={savedFilter}
      onChange={(value) => {
        setSavedFilter(value)
        if (value === 'active') setStoppedOnly(false)
      }}
      options={SAVED_FILTER_OPTIONS}
    /></SaveErrorField>
  )
  const savedBox = narrow ? savedFilterControl : <div className={styles.savedBox}>{savedFilterControl}</div>

  const perPageBox = (
    <div data-per-page-select>
      <PageSizeSelect className="w-full" value={perPage} onChange={setPerPage} options={PAGE_SIZE_OPTIONS} label={null} />
    </div>
  )

  const folderSelect = (
    <SaveErrorField names={["folderFilter","folderId","folder","folder_filter"]}><Select width={narrow ? 152 : undefined} narrowFolderPicker aria-label="フォルダ" value={folderFilter} onChange={setFolderFilter} options={folderSelectOptions} /></SaveErrorField>
  )

  const filteredCount =
    scenarioFilterActive && scenarioList.loaded ? (
      <p className={styles.filteredCount}>条件に一致したシナリオ：{formatNumber(scenarioList.total)} 件</p>
    ) : null

  /*
   * 1152 の板：案内の帯 → 1段目「作る・フォルダ・探す … 件数」→ 2段目「札・よく使う絞り込み（印だけ）」。
   * 部品は広い板と同じもの（動きは同じ）。並びと段だけを変える。
   */


  const wideToolbar = (
    <>
      <ListToolbar
        search={{
          placeholder: 'シナリオ名で探す',
          label: 'シナリオ名で探す',
          width: 240,
          value: nameQuery,
          onChange: (value) => setNameQuery(clampSearchQuery(value)),
        }}
        filters={filterChips}
        trailing={<>
          {savedBox}
          {perPageBox}
        </>}
      />
      {filteredCount ? <div className={styles.noteRow}>{filteredCount}</div> : null}
    </>
  )

  /* 板 ：一覧の口が 403（この役割では開けない）なら、画面ごと権限なしの板にする。 */
  if (scenarioList.error && isForbidden(scenarioList.error)) {
    return (
      <SaveErrorScope errors={saveErrors}><NoPermissionBoard
        featureName="シナリオ配信"
        roleLabel={staffRole && staffRole in ROLE_LABELS ? ROLE_LABELS[staffRole as keyof typeof ROLE_LABELS] : null}
        capabilitiesHref="/staff"
      /></SaveErrorScope>
    )
  }

  return (
    <SaveErrorScope errors={saveErrors}><ListPage
      heightMode="content"
      toolbarSpacing={narrow ? undefined : 'section'}
      noticeSpacing="section"
      skeleton
      boardId={narrow ? 'wjfLe' : canEdit ? 'axFrW' : 'X0QrW0'}
      headingSize="regular"
      title="シナリオ配信"
      explanationKey="scenarios"
      explanation="作っただけでは送られません。「開始のきっかけ」を決めて、テストを送ってから配信を始めます。"

      help={<>{"きっかけ（友だち追加・タグ・予約など）から、決めた順と日時でメッセージを送り続けます。"}{canEdit ? "左の □ で選ぶと、下に「まとめて止める・再開・フォルダへ移す」の帯が出ます。行を押すと編集、「…」に複製・配信結果・削除。" : "行を押すと詳細、「…」から配信結果を確認できます。"}</>}
      stats={<>
        {/* 板 `X0QrW0`：閲覧のみの帯。数の帯の上。 */}
        {editAccess.reason ? (
          <div className={styles.viewerBand}><ReadOnlyNotice need="feature" /></div>
        ) : null}
        <KpiBand data-design="KPIs">
          {kpis.map((kpi) => (
            <KpiCard
              key={kpi.title}
              presentation="band"
              title={kpi.title}
              icon={<kpi.icon size={16} aria-hidden="true" />}
              value={kpi.value}
              unit={kpi.value == null ? '' : kpi.unit}
              detail={kpi.detail}
              help={kpi.title === '最後まで配信した人' && stats ? scenarioCompletionDetail(stats.scenarios.subscribers, stats.scenarios.completed) : undefined}
              detailLayout={narrow ? 'qualifier' : undefined}
            />
          ))}
        </KpiBand>
      </>}
      overlays={<>
        {detailGuard.dialog}

        {/* 行の詳細パネル。一覧は左に見えたまま。 */}
        {panelRow && (
          <DetailPanel
            open
            busy={detailGuard.busy}
            contentSpacing="sections"
            title={panelRow.name}
            description={[
              panelRow.deliveryMode ? deliveryModeLabels[panelRow.deliveryMode] : '配信方法は未確認',
              panelRow.stepCount == null ? '通数は未確認' : `${panelRow.stepCount} 通`,
            ].join('・')}
            onClose={() => setPanelId(null)}
            onPrev={panelIndex > 0 ? () => setPanelId(scenarios[panelIndex - 1].id) : undefined}
            onNext={panelIndex < scenarios.length - 1 ? () => setPanelId(scenarios[panelIndex + 1].id) : undefined}
            hasPrev={panelIndex > 0}
            hasNext={panelIndex < scenarios.length - 1}
            actions={{menuLabel: `「${panelRow.name}」のその他操作`,primary: <Button variant="primary" onClick={() => goDetail(panelRow.id)}>
                  開く
                </Button>,
secondary: <Button
                  variant="secondary"
                  onClick={() =>
                    withViewTransition(() => {
                      router.push(`/scenarios/results?id=${encodeURIComponent(panelRow.id)}`)
                    })
                  }
                 busyLabel="移動中…">
                  配信結果
                </Button>,
menuItems: [...(rowMenuItems(panelRow).filter(item => item.id !== 'results').map(item => item.id === 'delete' ? { ...item, onSelect: () => detailGuard.protect(() => { if (!requireWrite()) return; setPanelId(null); void requestDelete(panelRow) }) } : item))]}}
           status={<StatusBadge status={panelRow.isActive ? 'active' : 'stopped'} tone={panelRow.isActive ? 'success' : 'neutral'} />}>
<DetailContent>
            <DetailSection label="配信状況" title="配信状況" help={<HelpTip label="配信状況の説明">配信中は、このシナリオに登録されていて最後までの配信が終わっていない人です。シナリオが停止中の間は送信されません。最後まで配信は、最終ステップまで処理が終わった人です。既読人数ではありません。</HelpTip>}>
              <DetailField label="人数">配信中 {scenarioCountLabel(panelRow.subscriberCount)}・最後まで配信 {scenarioCountLabel(panelRow.completedCount)}</DetailField>
            </DetailSection>
            {panelRow.description ? <DetailSection label="シナリオの説明">
              <DetailField label="説明">
              {panelRow.description}</DetailField>
            </DetailSection> : null}
            <DetailSection label="シナリオ名の変更" title="名前を変更" help={<HelpTip label="名前の変更方法">下の名前を押すと編集できます。Enterで保存し、Escで取り消します。</HelpTip>}>
              <InlineEdit
                {...detailGuard.editor}
                value={panelRow.name}
                label="シナリオ名"
                onSave={(next) => renameScenario(panelRow.id, next)}
                maxLength={60}
                disabled={editDisabled}
                lockedReason={editAccess.reason}
                canSaveNow={canWriteHere}
              />
            </DetailSection>

</DetailContent>
</DetailPanel>
        )}

        <ScenarioMoveDialog
          ids={moveIds}
          scenarios={scenarios}
          folders={folders}
          accountTargets={moveAccountTargets}
          disabled={editDisabled}
          sameScope={moveWindowScope.current === renderedScope}
          lockedReason={editAccess.reason}
          pending={pendingMove}
          draft={moveDraft}
          onDraftChange={(value) => { if (canWriteHere() && moveWindowScope.current === renderedScope) setMoveDraft(value) }}
          onConfirm={() => runMove()}
          onClose={() => setMoveIds(null)}
        />

        <ScenarioDeleteDialog
          target={deleteTarget}
          busy={deleting}
          error={deleteError}
          disabled={editDisabled || deleteLoading || !deleteSnapshot}
          summary={deleteSnapshot}
          targetStillListed={targetStillListed}
          sameScope={deleteWindowScope.current === renderedScope}
          lockedReason={editAccess.reason}
          countLabel={scenarioCountLabel}
          onConfirm={() => { void runDelete() }}
          onCancel={() => { if (!deleting) { deleteWindow.current = {}; setDeleteTarget(null); setDeleteSnapshot(null); setDeleteError('') } }}
        />

        {/* 複製の窓（★V8 `Al4Ek`：新しい名前・引き継ぐもの・引き継がないもの・停止中で作られる）。題の左に印は置かない（絵どおり）。 */}
        <></>
      </>}
      folders={<>
        <ConfirmDialog open={pendingStop !== null && stopWindowScope.current === renderedScope} title="選んだシナリオを停止しますか？" description="これから送る予定のシナリオ配信が止まります。" confirmLabel="停止する" confirmDisabled={!publishAccess.allowed || !scenarioList.loaded || stopLoading || stopPeople === null} confirmLockedReason={publishAccess.reason} onCancel={() => { stopWindow.current = {}; setPendingStop(null) }} busy={stopBusy} error={stopError || undefined} onSuccess={() => { stopWindow.current = {}; setPendingStop(null) }} onConfirm={() => runConfirmedStop()} ><OperationTargetSummary accounts={stopAccountTargets.accounts} allAccounts={stopAccountTargets.allAccounts} /><p>{stopLoading ? '対象を確認しています。' : stopPeople === null ? '対象を確認できません。' : `配信中・配信処理中の購読 ${formatNumber(stopPeople)} 件`}</p></ConfirmDialog>
        {folderPanel}
      </>}
      collapsedFolders={<>{createButton(false)}{folderSelect}</>}
      toolbar={wideToolbar}
      pagination={listPager}
    >
      {actionError ? (
        <Notice tone="danger" >{actionError}<Button variant="text" size="inline" data-notice-inline-action type="button" onClick={() => setActionError('')}>閉じる</Button></Notice>
      ) : null}
      <RefreshCover refreshing={scenarioList.refreshing}>{listBody}</RefreshCover>
    </ListPage></SaveErrorScope>
  )
}
