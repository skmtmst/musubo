'use client'

import OperationTargetSummary from '@/components/shared/operation-target-summary'

import StatusBadge from '@/components/shared/status-badge'
import { DetailContent, DetailField } from '@/components/shared/detail-content'
import { RefreshCover } from '@/components/shared/refresh-cover'
import FolderSelect from '@/components/shared/folder-select'

import ListDateTime from '@/components/shared/list-date-time'

import DetailPanel, { useDetailPanelUrl } from '@/components/shared/detail-panel';
import { useStaffRole } from '@/lib/staff-role';
import ListToolbar, { ListToolbarSort as SortSelect } from '@/components/shared/list-toolbar';
import { RowMenu } from '@/components/shared/row-actions';

import { RowNameLink } from '@/components/shared/table';

import { permissionDeniedMessage } from '@/components/shared/api-error-message';
import { formatListTimestamp, formatNumber } from '@/lib/format';
import { useFeatureAccess } from '@/lib/use-feature-access';
import { RovingTbody } from '@/components/shared/row-roving';
import BulkBar, { useEscapeToClearSelection } from '@/components/shared/bulk-bar';
import { collectListRows } from '@/components/shared/collect-list-rows';
import { ListPageBody } from '@/components/templates';
import SearchField from '@/components/shared/search-field'
import { PageFrame, PageHeading } from '@/components/templates/page-frame';
import { useCallback, useDeferredValue, useEffect, useRef, useState } from 'react';
import { useListScrollMemory, useListUrlParam, useListUrlValue } from '@/components/shared/list-url-state';
import { Activity, AlertCircle, ArrowRight, Bell, CalendarClock, Copy, Folder as FolderIcon, FolderInput, Pause, Pencil, Play, Send, Square, Trash2, TriangleAlert, Users } from 'lucide-react';
import Link from '@/components/shared/list-navigation'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation';

import type { ApiResponse, ReminderTriggerType } from '@line-crm/shared';
import { api, fetchApi, type ListStats } from '@/lib/api';
import { useOffsetServerList, type ServerListResponse } from '@/lib/use-server-list';
import { clampSearchQuery } from '@/lib/search-query';
import { useAccount } from '@/contexts/account-context';
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome';
import { useNarrowViewport } from '@/lib/use-narrow-viewport';
import Button from '@/components/shared/button'
import EmptyList from '@/components/shared/empty-list'
import KpiCard from '@/components/shared/kpi-card'
import KpiBand from '@/components/shared/kpi-band'
import Checkbox, { UnavailableSelection } from '@/components/shared/checkbox'
import Select from '@/components/shared/select'
import SegmentedControl from '@/components/shared/segmented'
import ManagedFolderPanel, { useManagedFolders } from '@/components/shared/managed-folder-panel'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import { type ActionMenuItem } from '@/components/shared/action-menu';
import ContextMenu, { type ContextMenuItem } from '@/components/shared/context-menu';
import { withViewTransition } from '@/components/shared/view-transition';
import { ListPagePagination } from '@/components/templates/list-page'
import Pagination from '@/components/shared/pagination'
import SheetDialog from '@/v8/reminders/sheet-dialog'
import { DelayedSkeleton } from '@/components/shared/skeleton';
import { DataTable, TableHeadRow, Tr, Td, Th, NameCell } from '@/components/shared/table';
import { type FolderDotFolder } from '@/components/shared/folder-dot';
import { describeSaveFailure } from '@/lib/api'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import type { ConfirmedUndoHandle } from '@/lib/undoable'
import { runUndoable, runOptimistic } from '@/lib/undoable';
import PageSizeSelect from '@/components/shared/page-size-select'
import { completeReorder } from '@/lib/complete-reorder';
import ReorderHandle, { useReorder } from '@/components/shared/reorder-handle';
import { formatTriggerOffset } from './reminder-timing';
import styles from '../../app/reminders/list-v8.module.css'
import TruncatedText from '@/components/shared/truncated-text'
import { emptyValue } from '@/components/shared/empty-value';
import { Field } from '@/components/shared/form-controls';
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors';
import { useDuplicateFeedback } from '@/components/shared/use-duplicate-feedback';
import { notifyToast } from '@/components/shared/toast';
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import Notice from '@/components/shared/notice'
import FriendFilterBand from '@/components/shared/friend-filter-band'
import { friendReminderPage } from '@/lib/friend-reminder-list'
import type { FriendDetail } from '@/lib/api'

/*
 * ★V8 リマインダの一覧（Pencil「★V8 画面の地図」のリマインダの行：
 * 一覧 、行の「…」は 、一時停止は 、削除は 、
 * 状態の板は ）。
 *
 * 管理画面 の一覧（app/reminders/page.tsx 内の RemindersPageV7）とは別の部品
 * として持つ。データの口（取得・絞り込み・並び・ページ送り）は同じ。
 * 違いは置き場と見せ方だけ——「リマインダを作る」は左のフォルダの列の上、
 * 行の右端は「…」（詳細・登録者・配信予定・実行結果・編集・複製・
 * 一時停止/再開・フォルダへ移す・削除）、行の左の □ を選ぶと表の下に
 * まとめての帯（止める・再開・フォルダへ移す）。
 * 管理画面 を直す必要が出たら page.tsx 側も同じ判断を入れる（V8 完成までの二重管理）。
 */

/** 未分類を表す印。空文字は「すべて」なので別の値にする。 */
const UNFILED = '__unfiled__'
const PER_PAGE_OPTIONS = [20, 50, 100]
const SORT_OPTIONS = [
  { value: 'order', label: '自分で並べた順' },
  { value: 'next', label: '次の送信が近い順' },
  { value: 'created', label: '作成日が新しい順' },
  { value: 'updated', label: '更新が新しい順' },
  { value: 'name', label: '名前順' },
]
const STATUS_CHIPS = ['有効', '下書き', '停止中', '失敗あり'] as const
interface ReminderRow {
  followupManagement?:import('@line-crm/shared').RestaurantFollowupManagement
  id: string
  lineAccountId?: string | null
  name: string
  description: string | null
  isActive: boolean
  triggerType?: ReminderTriggerType
  deliveryMode?: 'time' | 'countdown'
  triggerOffsetMinutes?: number | null
  sendAtTime?: string | null
  folderId?: string | null
  stepCount?: number
  displayOrder?: number
  hasFailure?: boolean
  /** 送れなかった通の数（retry_wait / permanent_failed）。 */
  failedCount?: number | null
  /** これから送る通の数（queued / retry_wait）。 */
  plannedDeliveries?: number | null
  /** いちばん近い送信予定（queued / retry_wait の最小 scheduled_at）。 */
  nextScheduledAt?: string | null
  lifecycleStatus?: 'draft' | 'published' | 'stopped'
  timingSummary?: string | null
  baseDateSummary?: string | null
  createdAt: string
  updatedAt: string
}

type StatusKey = 'draft' | 'stopped' | 'active'

function statusKeyOf(row: ReminderRow): StatusKey {
  if(row.followupManagement)return row.followupManagement.effectiveSendingStatus==='active'?'active':'stopped'
  if (row.lifecycleStatus === 'draft') return 'draft'
  if (row.lifecycleStatus === 'stopped' || !row.isActive) return 'stopped'
  return 'active'
}

const BASE_LABELS: Record<string, string> = {
  booking: '予約日時',
  event: 'イベントの予約日時',
  friend_field: '友だち情報欄の日付',
  manual: '指定日時',
}

/** 行ごとに作ると件数分だけ重いため、外で1回作って使い回す。 */
function rowView(reminder: ReminderRow) {
  // 板 ：副題は「基準日・1日前 18:00・テキスト1通」の形で「・」でつなぐ。
  const timing = reminder.timingSummary
    ? reminder.timingSummary.replace(' ／ テキスト ', '・テキスト')
    : `${formatTriggerOffset(reminder.triggerOffsetMinutes)}${reminder.sendAtTime ? ` ${reminder.sendAtTime}` : ''}・テキスト${reminder.stepCount ?? 0}通`
  const base =
    reminder.baseDateSummary ?? BASE_LABELS[reminder.triggerType ?? 'manual'] ?? '指定日時'
  return { status: statusKeyOf(reminder), subtitle: `${base}・${timing}` }
}

/** 次に送る日時は、別年でも時刻を残す。 */
function formatNextSend(iso: string | null | undefined): string {
  return formatListTimestamp(iso)
}

/** 閲覧のみでも出す行の「…」の項目（見るだけのもの）。 */
const VIEW_ONLY_MENU_IDS = new Set(['detail', 'registrants', 'planned', 'runs'])

export default function RemindersListV8() {
  const saveErrors = useSaveFormErrors()
  usePageTitle('リマインダ')
  usePageCrumbs([{ label: 'ホーム', href: '/' }])
  const router = useRouter()
  const { selectedAccountId } = useAccount()
  const pauseContext = useRef({ accountId: selectedAccountId, generation: 0 })
  if (pauseContext.current.accountId !== selectedAccountId) pauseContext.current = { accountId: selectedAccountId, generation: pauseContext.current.generation + 1 }
  const duplicateFeedback = useDuplicateFeedback(selectedAccountId)
  const role = useStaffRole()
  const canEdit = useFeatureAccess('reminders')
  const moveLockedReason = usePermissionLockReason(canEdit)
  const moveAllowed = useRef(canEdit)
  moveAllowed.current = canEdit
  const readonlyReason = 'この操作にはオーナーか管理者の権限が要ります'
  // 1152の板（）。折り畳みはCSSのコンテナ問い合わせが担い、
  // ここでは板IDだけを切り替える。
  const narrow = useNarrowViewport()

  const { folders, unfiledCount, error: foldersError, reload: loadFolders } = useManagedFolders('reminder', selectedAccountId)
  /* 絞り込み・検索語・並び順・ページは URL に置く（戻ると同じ一覧に戻る。動きの点検 5 番）。 */
  const [nameQuery, setNameQuery] = useListUrlParam('q')
  const [friendId] = useListUrlParam('friendId')
  const [filterFriend, setFilterFriend] = useState<{ id: string; value: FriendDetail } | null>(null)
  const deferredNameQuery = useDeferredValue(nameQuery.trim())
  const [folderFilter, setFolderFilter] = useListUrlParam('folder')
  const [statusFilter, setStatusFilter] = useListUrlParam('status')
  const [perPage, setPerPage] = useListUrlValue('limit', 20)
  // ・ の一覧は、次に送る予定が近いものから確認する。
  const [sort, setSort] = useListUrlParam('sort', 'next')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  /* 行の詳細パネル（V8「サクサク感」C①・D・E）。開いている行のID。 */
  const [panelId, setPanelId] = useDetailPanelUrl('reminder')
  const [actionError, setActionError] = useState('')

  /* 数の帯。 */
  const [stats, setStats] = useState<ListStats | null>(null)
  const [statsFailed, setStatsFailed] = useState(false)

  /* 窓・まとめての帯の状態。 */
  const [bulkPauseIds, setBulkPauseIds] = useState<string[] | null>(null)
  const [bulkPauseAccounts, setBulkPauseAccounts] = useState<Array<{ id: string; name?: string }>>([])
  const [bulkPauseGeneration, setBulkPauseGeneration] = useState(0)
  const [bulkPauseAccountId, setBulkPauseAccountId] = useState(selectedAccountId)
  useEffect(() => { setBulkPauseIds(null) }, [selectedAccountId])
  const [pauseTarget, setPauseTarget] = useState<ReminderRow | null>(null)
  const pauseRef = useRef<{ target: ReminderRow; generation: number } | null>(null)
  const openedPause = pauseRef.current
  const [deleteTarget, setDeleteTarget] = useState<ReminderRow | null>(null)
  const deleteRef = useRef<{ target: ReminderRow; generation: number } | null>(null)
  const openedDelete = deleteRef.current
  const [deleteAccountId, setDeleteAccountId] = useState(selectedAccountId)
  useEffect(() => { deleteRef.current = null; setDeleteTarget(null) }, [selectedAccountId])
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [moveIds, setMoveIds] = useState<string[] | null>(null)
  const moveConfirmed = useRef(new Map<string, string | null>())
  const [pendingMove, setPendingMove] = useState<ConfirmedUndoHandle | null>(null)
  const [moveDraft, setMoveDraft] = useState('')
  const duplicateLock = useRef(false)
  const [duplicating, setDuplicating] = useState(false)
  const setDuplicateError =(message: string | null) => { if (message) notifyToast(message, { tone: 'error' }) }
  const [moveNotice, setMoveNotice] = useState('')

  const loadStats = useCallback(async () => {
    setStatsFailed(false)
    try {
      const res = await api.listStats.get(selectedAccountId ?? undefined)
      if (res.success) setStats(res.data)
      else setStatsFailed(true)
    } catch (saveFailure) {
      saveErrors.capture(saveFailure)
      setStatsFailed(true)
    }
  }, [selectedAccountId, saveErrors])

  useEffect(() => {
    void loadStats()
  }, [loadStats])

  const loadReminderPage = useCallback(
    async (
      request: { page: number; limit: number },
      signal: AbortSignal,
    ): Promise<ServerListResponse<ReminderRow>> => {
      const query = new URLSearchParams({
        page: String(request.page),
        limit: String(request.limit),
      })
      if (selectedAccountId) query.set('lineAccountId', selectedAccountId)
      if (deferredNameQuery) query.set('q', deferredNameQuery)
      if (folderFilter) query.set('folderId', folderFilter)
      if (statusFilter) {
        query.set(
          'status',
          statusFilter === '有効'
            ? 'active'
            : statusFilter === '下書き'
              ? 'draft'
              : statusFilter === '停止中'
                ? 'stopped'
                : 'failed',
        )
      }
      query.set('sort', sort)
      const load = async (page: number, limit: number) => {
        const params = new URLSearchParams(query)
        params.set('page', String(page)); params.set('limit', String(limit))
        const response = await fetchApi<ApiResponse<ServerListResponse<ReminderRow>>>(`/api/reminders?${params}`, { signal })
        if (!response.success) throw new Error(response.error)
        return response.data
      }
      if (!friendId) return load(request.page, request.limit)
      const [person, enrollments] = await Promise.all([
        fetchApi<ApiResponse<FriendDetail>>(`/api/friends/${encodeURIComponent(friendId)}?submissions=0`, { signal }),
        fetchApi<ApiResponse<Array<{ reminderId: string }>>>(`/api/friends/${encodeURIComponent(friendId)}/reminders`, { signal }),
      ])
      if (!person.success || !enrollments.success) throw new Error('この友だちのリマインダを確認できませんでした。時間をおいて、もう一度お試しください。')
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      setFilterFriend({ id: friendId, value: person.data })
      return friendReminderPage(enrollments.data.map(row => row.reminderId), request, load)
    },
    [deferredNameQuery, folderFilter, selectedAccountId, sort, statusFilter, friendId],
  )
  const reminderList = useOffsetServerList({
    requestKey: JSON.stringify([selectedAccountId, deferredNameQuery, folderFilter, statusFilter, perPage, sort, friendId]),
    load: loadReminderPage,
    initialLimit: perPage,
    pageUrlKey: 'page',
  })
  useListScrollMemory(reminderList.loaded)
  /*
   * 押した瞬間の見せ方（★V8 サクサク感 B）。軽い操作は先にこの重ねで
   * 描き換え、裏で保存する。確定・失敗・取り消しで重ねを外し、読み直す。
   * ページ・絞り込みが変わったら重ねは捨てる（違う一覧に貼らない）。
   */
  const [optimisticRows, setOptimisticRows] = useState<{ key: string; rows: ReminderRow[] } | null>(null)
  const listContextKey = JSON.stringify({
    friendId,
    account: selectedAccountId ?? '',
    query: deferredNameQuery,
    folder: folderFilter,
    status: statusFilter,
    perPage,
    sort,
    page: reminderList.page,
  })
  const currentListContext = useRef(listContextKey)
  currentListContext.current = listContextKey
  const listedReminders = optimisticRows && optimisticRows.key === listContextKey ? optimisticRows.rows : reminderList.items
  const reminders = listedReminders
  const detailHref = (id: string) => `/reminders/detail?id=${encodeURIComponent(id)}`
  const filterActive = Boolean(friendId || nameQuery.trim() || folderFilter || statusFilter)

  /* ===== 行の操作 ===== */

  /*
   * 1件の「一時停止／再開」は押した瞬間に描き換え、裏で保存する
   * （・決まり3）。失敗したら元に戻して知らせる。一時停止の窓（）は残し、確定で即反映する。
   */
  const runToggle = (row: ReminderRow, next: boolean) => {
    setActionError('')
    const key = listContextKey
    setOptimisticRows({
      key,
      rows: reminders.map((item) =>
        item.id === row.id
          ? { ...item, isActive: next, lifecycleStatus: next ? 'published' : 'stopped' }
          : item,
      ),
    })
    runOptimistic({
      isCurrent: () => key === currentListContext.current,
      request: async () => {
        const res = await api.reminders.update(row.id, { isActive: next })
        if (!res.success) throw new Error(res.error)
      },
      revert: () => setOptimisticRows(null),
      failureMessage: next
        ? `「${row.name}」を再開できませんでした。`
        : `「${row.name}」を一時停止できませんでした。`,
      onSuccess: () => {
        setOptimisticRows(null)
        reminderList.retry()
        void loadStats()
      },
    })
  }

  const confirmedStops = useRef<{ target: object | null; done: Set<string> }>({ target: null, done: new Set() })
  const stopLock = useRef(false)
  const [stopBusy, setStopBusy] = useState(false)
  const [stopError, setStopError] = useState('')
  useEffect(() => { setStopError('') }, [pauseTarget, bulkPauseIds])
  const stopConfirmed = async (ids: string[], target: object) => {
    if (!moveAllowed.current || !ids.length || stopLock.current) return
    if (confirmedStops.current.target !== target) confirmedStops.current = { target, done: new Set() }
    const attempt = confirmedStops.current
    const key = listContextKey
    const current = () => key === currentListContext.current && confirmedStops.current === attempt
    stopLock.current = true; setStopBusy(true); setStopError('')
    try {
      for (const id of ids) {
        if (attempt.done.has(id)) continue
        if (!current()) return
        if (!moveAllowed.current) { setStopError(`${formatNumber(ids.length)} 件中 ${formatNumber(attempt.done.size)} 件を保存しました。残りは本人・権限・LINEアカウントが変わったため送っていません。`); return false }
        try {
          const response = await api.reminders.update(id, { isActive: false })
          if (!response.success) throw new Error(response.error)
          attempt.done.add(id)
        } catch (failure) {
          if (!current()) return
          saveErrors.capture(failure)
          setStopError(`${formatNumber(ids.length)} 件中 ${formatNumber(attempt.done.size)} 件を保存しました。残り ${formatNumber(ids.length - attempt.done.size)} 件は停止できませんでした。${describeSaveFailure(failure)}`)
          return false
        }
      }
      if (!current()) return
      setSelectedIds(new Set()); setOptimisticRows(null)
      reminderList.retry(); void loadStats()
      return true
    } finally { stopLock.current = false; if (current()) setStopBusy(false) }
  }

  const openPause = (target: ReminderRow) => { pauseRef.current = { target, generation: pauseContext.current.generation }; setPauseTarget(target) }
  const runPause = () => pauseTarget && openedPause && pauseRef.current === openedPause && openedPause.target === pauseTarget && openedPause.generation === pauseContext.current.generation ? stopConfirmed([pauseTarget.id], pauseTarget) : false

  const runResume = (row: ReminderRow) => runToggle(row, true)

  /* ===== 削除 ===== */

  // 下書きも公開済みも、削除は必ず確認する（・決まり2）。
  const requestDelete = (row: ReminderRow) => {
    deleteRef.current = { target: row, generation: pauseContext.current.generation }
    setDeleteError('')
    setDeleteAccountId(selectedAccountId)
    setDeleteTarget(row)
  }

  const deleteStillListed =
    deleteTarget !== null && reminders.some((row) => row.id === deleteTarget.id)

  const runDelete = async () => {
    if (!deleteTarget || deleting || !deleteStillListed || deleteAccountId !== selectedAccountId || !openedDelete || deleteRef.current !== openedDelete || openedDelete.target !== deleteTarget || openedDelete.generation !== pauseContext.current.generation) return
    setDeleting(true)
    setDeleteError('')
    try {
      const res = await api.reminders.delete(deleteTarget.id)
      if (!res.success) throw new Error(res.error)
      deleteRef.current = null
      setDeleteTarget(null)
      setSelectedIds((current) => {
        const next = new Set(current)
        next.delete(deleteTarget.id)
        return next
      })
      reminderList.retry()
      void loadStats()
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setDeleteError('このリマインダを削除できませんでした。状態を読み直してから、もう一度お試しください。') }
    } finally {
      setDeleting(false)
    }
  }

  /* ===== 複製（下書きとして写す） ===== */

  const runDuplicate = async (duplicateTarget: ReminderRow) => {
    if (duplicateLock.current) return
    if (!duplicateTarget || duplicating) return
    duplicateLock.current = true
    setDuplicating(true)
    setDuplicateError('')
    try {
      const draft = await api.reminders.getDraft(duplicateTarget.id)
      if (!draft.success) throw new Error(draft.error)
      const settings = draft.data.settings
      const res = await api.reminders.createDraft({
        ...settings,
        name: `${duplicateTarget.name} のコピー`,
      })
      if (!res.success) throw new Error(res.error)
      const newId = String(res.data.reminderId)

      notifyToast('複製しました', { tone: 'success' })
      reminderList.retry()
      duplicateFeedback.mark(duplicateTarget.id, newId)
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setDuplicateError('複製できませんでした。通信を確かめて、もう一度お試しください。') }
      reminderList.retry()
    } finally {
      duplicateLock.current = false
      setDuplicating(false)
    }
  }

  /* ===== フォルダ移動 ===== */

  const openMove = (ids: string[]) => {
    if (ids.length === 0) return
    setMoveDraft('')
    moveConfirmed.current = new Map()
    setMoveIds(ids)
  }

  /*
   * フォルダ移動は窓で行き先だけ選び、押した瞬間に描き換えて裏で保存する
   * （★V8 サクサク感 B）。5秒のあいだ知らせの「元に戻す」で送らずに戻せる。
   */
  const runMove = async () => {
    if (!moveAllowed.current || !moveIds?.length) return
    const confirmed = moveConfirmed.current
    const ids = moveIds
    const folderId = moveDraft || null
    const key = listContextKey
    const before = reminders
    const restore = () => {
      if (!(moveConfirmed.current === confirmed && currentListContext.current === key)) return
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
          if (!(moveConfirmed.current === confirmed && currentListContext.current === key) || !(moveAllowed.current)) {
            const saved = ids.filter(value => confirmed.has(value) && confirmed.get(value) === folderId).length
            moveFailure = `${formatNumber(ids.length)} 件中 ${formatNumber(saved)} 件を保存しました。残りは本人・権限・LINEアカウントが変わったため送っていません。`
            throw new Error(moveFailure)
          }
          try {
            const result = await api.reminders.update(id, { folderId })
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
        if (!(moveConfirmed.current === confirmed && currentListContext.current === key)) return
        setOptimisticRows(null)
        const moved = new Set(ids)
        setSelectedIds(values => new Set([...values].filter(id => !moved.has(id))))
        reminderList.retry()
      },
    })
    setPendingMove(handle)
    try {
      const result = await handle.finished
      return (moveConfirmed.current === confirmed && currentListContext.current === key) ? result : undefined
    }
    finally { setPendingMove(value => value === handle ? null : value) }
  }

  /* ===== まとめて「止める／再開」 ===== */

  const allOnPageSelected = reminders.length > 0 && reminders.every((row) => selectedIds.has(row.id))
  const selectedCount = selectedIds.size
  // 選んでいる間は Esc で選択を外す（動きの点検 12・20 番）。
  const clearSelection = useCallback(() => setSelectedIds(new Set()), [])
  useEscapeToClearSelection(selectedCount > 0, clearSelection)
  const [selectionRows, setSelectionRows] = useState<ReminderRow[]>([])
  const selectionScope = JSON.stringify([selectedAccountId, deferredNameQuery, folderFilter, statusFilter, sort, friendId])
  useEffect(() => { setSelectedIds(new Set()); setSelectionRows([]) }, [selectionScope])
  const selectAllReminders = async () => {
    const key = currentListContext.current
    const all = await collectListRows(reminderList.total, async (offset, limit) => {
      const response = await loadReminderPage({ page: offset / limit + 1, limit }, new AbortController().signal)
      return { items: response.items, total: response.total }
    })
    if (key !== currentListContext.current) return
    setSelectionRows(all)
    setSelectedIds(new Set(all.map(row => row.id)))
  }
  const selectedRows = [...new Map([...selectionRows, ...reminders].map(row => [row.id, row])).values()].filter((row) => selectedIds.has(row.id))
  const stoppableIds = selectedRows.filter((row) => statusKeyOf(row) === 'active').map((row) => row.id)
  const resumableIds = selectedRows.filter((row) => statusKeyOf(row) === 'stopped').map((row) => row.id)

  const toggleAllOnPage = () => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (allOnPageSelected) reminders.forEach((row) => next.delete(row.id))
      else reminders.forEach((row) => next.add(row.id))
      return next
    })
  }
  const toggleOne = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /*
   * まとめて「一時停止／再開」は押した瞬間に描き換え、裏で保存する
   * （★V8 サクサク感 B）。確認の窓は出さず、5秒のあいだ知らせの
   * 「元に戻す」で送らずに戻せる。
   */
  const runBulkToggle = (next: boolean, ids: string[]) => {
    if (ids.length === 0) return
    const key = listContextKey
    setOptimisticRows({
      key,
      rows: reminders.map((row) =>
        ids.includes(row.id)
          ? { ...row, isActive: next, lifecycleStatus: next ? 'published' : 'stopped' }
          : row,
      ),
    })
    runOptimistic({
      isCurrent: () => key === currentListContext.current,
      request: async () => {
        const results = await Promise.all(
          ids.map((id) => api.reminders.update(id, { isActive: next }).catch((saveFailure) => { saveErrors.capture(saveFailure); return null })),
        );

        const failed = results.filter((res) => !res || !res.success).length
        if (failed > 0) throw new Error(`${formatNumber(failed)}件の保存に失敗しました`)
      },
      revert: () => setOptimisticRows(null),
      failureMessage: next ? '再開できませんでした。' : '一時停止できませんでした。',
      onSuccess: () => {
        setOptimisticRows(null)
        setSelectedIds(new Set())
        reminderList.retry()
        void loadStats()
      },
    })
  }

  /* ===== 並び替え ===== */

  /*
   * 掴んで入れ替えた並びを先に描き換え、裏で保存する（★V8 サクサク感 B）。
   * 5秒のあいだは知らせの「元に戻す」で送らずに戻せる。
   */
  const handleReorder = (order: string[]) => {
    setActionError('')
    const key = listContextKey
    const byId = new Map(reminders.map((row) => [row.id, row]))
    const nextRows = order.map((id) => byId.get(id)).filter((row): row is ReminderRow => row !== undefined)
    if (nextRows.length !== reminders.length) {
      reminderList.retry()
      return
    }
    setOptimisticRows({ key, rows: nextRows })
    runUndoable({
      message: '並び順を変えました',
      commit: async () => {
        const fullOrder = await completeReorder(order, loadReminderPage, 500)
        const res = await api.reminders.reorder(fullOrder)
        if (!res.success) throw new Error(res.error)
      },
      undo: () => setOptimisticRows(null),
      failureMessage: '並び替えを保存できませんでした。',
      onCommitted: () => {
        setOptimisticRows(null)
        reminderList.retry()
      },
    })
  }

  /*
   * 動かせるのは「自分で並べた順」で、絞り込みが無く、全件が500件以内のときだけ
   * （リッチメニュー・自動応答と同じ決まり）。保存は渡した行に 0 からの番号を振り直すため、
   * 別の順・一部の行のまま保存すると、読み直したときに並べた順が崩れる。全順位を読んで送り、ページ外の位置を保つ。
   */
  const reorderDisabledReason = !canEdit
    ? '閲覧のみのため並び替えできません'
    : sort !== 'order'
      ? '並びを「自分で並べた順」にすると動かせます'
      : filterActive
        ? '絞り込みを外すと動かせます'
        : reminderList.total > 500
          ? '500件を超える一覧では並び替えできません'
          : null

  /* ドラッグ・上下キー・「…」の上へ／下へを1つの入口にする（共通の並び替え）。 */
  const reorder = useReorder({
    items: reminders,
    idOf: (row) => row.id,
    disabledReason: reorderDisabledReason,
    onReorder: ({ id, to, ids, via }) => {
      if (via !== 'drag') {
        const name = reminders.find((row) => row.id === id)?.name ?? 'このリマインダ'
        const direction = to < reminders.findIndex((row) => row.id === id) ? '上' : '下'
        setMoveNotice(`「${name}」を${direction}へ移動しました。${to + 1}番目です`)
      }
      handleReorder(ids)
    },
    onEdge: (id, direction) => {
      const name = reminders.find((row) => row.id === id)?.name ?? 'このリマインダ'
      setMoveNotice(`「${name}」は${direction < 0 ? '先頭' : '末尾'}にあるため、これ以上動かせません`)
    },
  })

  /* ===== フォルダの列 ===== */

  /* 行の名前の前の丸は、左のフォルダの列と同じフォルダ（同じ色）を引く。未分類は色の無い輪。 */
  const folderDotOf = (row: { folderId?: string | null }): FolderDotFolder | null => {
    if (!row.folderId) return null
    const folder = folders.find((f) => f.id === row.folderId)
    return folder ? { name: folder.name, color: folder.color } : null
  }
  const folderSelectOptions = [
    { value: '', label: 'フォルダ：すべて' },
    ...folders.map((folder) => ({ value: folder.id, label: `フォルダ：${folder.name}` })),
    { value: UNFILED, label: 'フォルダ：未分類' },
  ]

  const reminderStats = stats?.reminders as (ListStats['reminders'] & { failed?: number | null }) | undefined

  const kpis = [
    {
      title: 'リマインダ',
      icon: Bell,
      value: statsFailed ? null : reminderStats?.total ?? null,
      unit: '件',
      detail: reminderStats ? `有効 ${reminderStats.active}件` : emptyValue('unknown'),
      link: null as null | (() => void),
    },
    {
      title: 'これから送る',
      icon: CalendarClock,
      value: statsFailed ? null : reminderStats?.waiting ?? null,
      unit: '通',
      detail: '今後7日',
      link: null,
    },
    {
      title: '今月送った',
      icon: Send,
      value: statsFailed ? null : reminderStats?.sentThisMonth ?? null,
      unit: '通',
      detail: '正常に送れた分',
      link: null,
    },
    {
      title: '送れなかった',
      icon: TriangleAlert,
      value: statsFailed ? null : reminderStats?.failed ?? null,
      unit: '通',
      detail: '',
      link: () => setStatusFilter('失敗あり'),
    },
  ]

  /* ===== 行の「…」の中身（★V8 ） ===== */

  /** 一覧の行→詳細はつながる移り変わりで開く。 */
  const goDetail = (href: string) => {
    withViewTransition(() => {
      router.push(href)
    })
  }

  /** 右クリックは「…」と同じ項目をマウスの位置に出す。 */
  const rowContextItems = (row: ReminderRow): ContextMenuItem[] =>
    rowMenuItems(row).map((item) => ({
      id: item.id,
      label: item.label,
      danger: item.tone === 'danger',
      disabled: item.disabled,
      onSelect: () => item.onSelect?.(),
    }))

  const panelIndex = panelId === null ? -1 : reminders.findIndex((row) => row.id === panelId)
  const panelRow = panelIndex >= 0 ? reminders[panelIndex] : null

  const rowMenuItems = (row: ReminderRow): ActionMenuItem[] => {
    const status = statusKeyOf(row)
    const items: ActionMenuItem[] = [
      { id: 'detail', label: "リマインダの詳細を見る", icon: <ArrowRight size={16} aria-hidden="true" />, onSelect: () => goDetail(detailHref(row.id)) },
      /*
       * 詳細のタブは ?tab=（registrants・schedule・runs）で開く（src/v8/reminders/BEHAVIOR.md）。
       * 前は tab を付けず・status=planned だけで、どれを押しても概要が開いていた（監査 WEB-013）。
       * status=planned は 管理画面 の詳細（実行結果の画面）が読む名前なので残す。
       */
      { id: 'registrants', label: '登録者を管理', icon: <Users size={16} aria-hidden="true" />, onSelect: () => goDetail(`${detailHref(row.id)}&tab=registrants`) },
      { id: 'planned', label: '配信予定を見る', icon: <CalendarClock size={16} aria-hidden="true" />, onSelect: () => goDetail(`${detailHref(row.id)}&tab=schedule&status=planned`) },
      { id: 'runs', label: '実行結果を見る', icon: <Activity size={16} aria-hidden="true" />, onSelect: () => goDetail(`${detailHref(row.id)}&tab=runs`) },
      {
        id: 'edit',
        label: '編集する',
        icon: <Pencil size={16} aria-hidden="true" />,
        dividerBefore: true,
        disabledReason: canEdit ? undefined : readonlyReason,
        onSelect: () => goDetail(`/reminders/edit?id=${encodeURIComponent(row.id)}`),
      },
      {
        id: 'duplicate',
        label: '複製する',
        icon: <Copy size={16} aria-hidden="true" />,
        disabledReason: canEdit ? undefined : readonlyReason,
        onSelect: () => {
          setDuplicateError('')
          void runDuplicate(row)
        },
      },
      status === 'active'
        ? {
            id: 'pause',
            label: '一時停止する',
            icon: <Pause size={16} aria-hidden="true" />,
            disabledReason: canEdit ? undefined : readonlyReason,
            onSelect: () => {
                        openPause(row)
            },
          }
        : status === 'stopped'
          ? {
              id: 'resume',
              label: '再開する',
              icon: <Play size={16} aria-hidden="true" />,
                disabledReason: canEdit ? undefined : readonlyReason,
              onSelect: () => void runResume(row),
            }
          : {
              id: 'pause-none',
              label: '一時停止する',
              icon: <Pause size={16} aria-hidden="true" />,
              disabled: true,
              disabledReason: '下書きはまだ送っていないため、止める予定がありません',
              onSelect: () => {},
            },
      {
        id: 'move',
        label: 'フォルダへ移す',
        icon: <FolderInput size={16} aria-hidden="true" />,
        disabledReason: canEdit ? undefined : readonlyReason,
        onSelect: () => openMove([row.id]),
      },
      /* 並べた順で見ているときだけ、つまみと同じ「上へ／下へ」（共通の並び替え）。 */
      ...reorder.menuItems(row.id, () => setOpenMenuId(null)),
      {
        id: 'delete',
        label: '削除する',
        icon: <Trash2 size={16} aria-hidden="true" />,
        tone: 'danger',
        dividerBefore: true,
        disabledReason: canEdit ? undefined : readonlyReason,
        onSelect: () => requestDelete(row),
      },
    ]
    // 閲覧のみには押せない項目を置かない（2026-10-06 オーナー決定）。見る項目だけ残す。
    return canEdit ? items : items.filter((item) => VIEW_ONLY_MENU_IDS.has(item.id))
  }

  /* ===== 表 ===== */

  /*
   * 見出しの6列は実表と共有する。骨組み用に書き写すと直書きの見出し
   * （`direct-th`）が二重に数えられるため、同じ要素を使い回す。
   * 選択の列だけは実表が箱（Checkbox）付き・骨組みが共通 `Th` の空見出し。
   */
  const tableHeadCells = (
    <>
      <Th aria-label="並び替え" />
      <Th>リマインダ（基準日・いつ送るか）</Th>
      <Th>状態</Th>
      <Th>これから送る</Th>
      <Th>次に送る</Th>
      <Th aria-label="操作" />
    </>
  )

  /* 板 「読み込み中」：見出しなしの骨4行。 */
  const loadingSkeleton = (
    <div className={styles.skeletonRows} aria-label="読み込み中">
      {[0, 1, 2, 3].map((n) => (
        <div key={n} className={styles.skeletonRow} data-skeleton aria-hidden="true">
          <span className={styles.skeletonDot} />
          <span className={styles.skeletonBar} />
          <span className={styles.skeletonBar} />
          <span className={styles.skeletonBar} />
          <span className={styles.skeletonBar} />
        </div>
      ))}
    </div>
  )

  const table =
    !reminderList.loaded && !reminderList.error ? (
      <div className={styles.tableWrap} aria-busy="true" aria-label="読み込んでいます">
        <DelayedSkeleton loading skeleton={loadingSkeleton} />
      </div>
    ) : reminderList.error ? (
      <div className={styles.stateCard} data-design-node="RrYYJ">
        <span className={`${styles.stateIcon} ${styles.stateIconError}`}>
          <AlertCircle size={16} aria-hidden="true" />
        </span>
        <p className={styles.stateTitle}>リマインダを読み込めませんでした</p>
        <p className={styles.stateDesc}>
          数の帯は「—」、道具はそのまま使えます。条件を変えてから試し直せます。
        </p>
        <Button type="button" onClick={reminderList.retry}>もう一度試す</Button>
      </div>
    ) : reminders.length === 0 ? (
      /* 修正案 D-2：空の一覧。 */
      <EmptyList
        data-design-node="RrYYJ"
        icon={<Bell aria-hidden="true" />}
        title="まだリマインダがありません"
        description="予約日や誕生日などの日付を基準に、その前後で自動で知らせます。"
        create={{ label: '最初のリマインダを作る', href: '/reminders/new' }}
        canCreate={canEdit}
        filtered={filterActive}
        onClearFilters={() => {
          setNameQuery('')
          setFolderFilter('')
          setStatusFilter('')
        }}
        filteredDescription="「有効」「下書き」「停止中」「失敗あり」や検索を外すと、すべて出ます"
      />
    ) : (
      <>
        {/* キーボードで動かした結果を読み上げる。画面には出さない。 */}
        <span className="sr-only" role="status" aria-live="polite">
          {moveNotice}
        </span>
        {reorderDisabledReason ? <span className="sr-only" data-reorder-reason>{reorderDisabledReason}</span> : null}
        <div className={styles.tableWrap}>
          <DataTable>
            <colgroup>
              {/* ★V8 列の幅＝絵の中身の幅＋欄の間16（左右8ずつ）。端の列は端の24も足す（apLqS：選ぶ16・並べ替え14・状態80・予定90・次120・操作28） */}
              {/* 閲覧のみでも選ぶ列の幅は残す（箱は出さない）。名前の位置を絵どおりに保つ。 */}
              <col style={{ width: 16 + 24 + 8 }} />
              <col style={{ width: 14 + 16 }} />
              <col />
              <col style={{ width: 80 + 16 }} />
              <col style={{ width: 90 + 16 }} />
              <col style={{ width: 120 + 16 }} />
              <col style={{ width: 28 + 8 + 24 }} />
            </colgroup>
            <thead>
              <TableHeadRow>
                {canEdit ? (
                  <Th className={styles.selectCell} aria-label="選択">
                    <SaveErrorField names={["allOnPageSelected","all_on_page_selected"]}><Checkbox
                      checked={allOnPageSelected}
                      indeterminate={!allOnPageSelected && selectedCount > 0}
                      onCheckedChange={toggleAllOnPage}
                      aria-label="このページのリマインダをすべて選択"
                    /></SaveErrorField>
                  </Th>
                ) : <Th className={styles.selectCell}><UnavailableSelection label="このページのリマインダをすべて選択" /></Th>}
                {tableHeadCells}
              </TableHeadRow>
            </thead>
            <RovingTbody reorderKey={duplicateFeedback.order(reorder.shown, reminders).map((row) => row.id).join(',')}>
              {duplicateFeedback.order(reorder.shown, reminders).map((row, saveFieldIndex) => {
                const view = rowView(row)
                const planned =
                  view.status === 'draft' || view.status === 'stopped'
                    ? emptyValue('unknown')
                    : row.plannedDeliveries == null
                      ? emptyValue('unknown')
                      : `${formatNumber(row.plannedDeliveries)}通`
                const nextSend =
                  view.status === 'active' ? <ListDateTime value={row.nextScheduledAt} /> : emptyValue('unknown')
                return (
                  <Tr selected={selectedIds.has(row.id)} interactive
                    highlighted={duplicateFeedback.highlightedId === row.id}
                    key={row.id}
                    {...reorder.rowProps(row.id)}
                    className={styles.rowClick}
                    tabIndex={0}
                    onClick={() => setPanelId(row.id)}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        setPanelId(row.id)
                      }
                    }}
                  >
                    {canEdit ? (
                      <Td className={styles.selectCell} onClick={(event) => event.stopPropagation()}>
                        <SaveErrorField names={[`shown.${saveFieldIndex}.id`,"id","row.id"]}><Checkbox
                          checked={selectedIds.has(row.id)}
                          onCheckedChange={() => toggleOne(row.id)}
                          aria-label={`${row.name}を選択`}
                        /></SaveErrorField>
                      </Td>
                     ) : <Td className={styles.selectCell}><UnavailableSelection label={`${row.name}を選択`} /></Td>}
                    <Td
                      className={styles.gripCell}
                      onClick={(event) => event.stopPropagation()}
                      {...reorder.handleProps(row.id)}
                      title={reorder.blocked ? undefined : '上下に動かして並び替え'}
                    >
                      {/* 動かせない時（閲覧のみ・別の並び・絞り込み中）はつまみを出さず、理由は一覧の前で一度だけ読み上げる。 */}
                      <ReorderHandle label={row.name} {...reorder.handle(row.id)} announceDisabledReason={false}>
                        <span aria-hidden>⠿</span>
                      </ReorderHandle>
                    </Td>
                    <NameCell name={<div className={styles.nameRow}>
                        <>
                          <RowNameLink
                            href={detailHref(row.id)}

                            className={styles.cellTitle}
                            onClick={(event) => {
                              event.stopPropagation()
                              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
                              event.preventDefault()
                              goDetail(detailHref(row.id))
                            }}
                          >
                            <TruncatedText value={String(row.name ?? '')} />
                          </RowNameLink>
                        </>

                      </div>} folder={folderDotOf(row)}
                    />
                    <Td>
                      <StatusBadge tone={view.status==='active'?'success':'neutral'} help={row.followupManagement?`来店フォロー（${row.followupManagement.storeName}）で管理しています。${row.followupManagement.reason??'承認された内容で送っています'}`:undefined} helpHref={row.followupManagement?.path}>{view.status==='active'?'有効':view.status==='draft'?'下書き':'停止中'}</StatusBadge>
                        {row.hasFailure || (row.failedCount ?? 0) > 0 ? (
                          <button
                            type="button"
                            className={styles.miniBadgeDanger}
                            title="失敗があるリマインダだけに絞り込みます"
                            onClick={(event) => {
                              event.stopPropagation()
                              setStatusFilter('失敗あり')
                            }}
                          >
                            <span className={styles.miniBadgeDot} aria-hidden="true" />
                            失敗{row.failedCount != null && row.failedCount > 0 ? ` ${row.failedCount}` : ''}
                          </button>
                        ) : null}
                    </Td>
                    <Td className={styles.countCell}>
                      <div className={styles.countMain}>{planned}</div>
                    </Td>
                    <Td className={styles.countCell}>
                      <div className={styles.countMain}>{nextSend}</div>
                    </Td>
                    <Td className={styles.menuCell} onClick={(event) => event.stopPropagation()} data-design-node={openMenuId === row.id ? 'SkY9V' : undefined}>
                      {/* 横並びにして、メニューの位置の目印（空の span）が行を1段増やさないようにする。 */}
                      <div className={styles.menuBox}>
                      <ContextMenu
                        label={`リマインダ「${row.name}」の操作`}
                        items={rowContextItems(row)}
                      >
                        <RowMenu
                          label={`リマインダ「${row.name}」の操作`}
                          items={rowMenuItems(row)}
                          size="row"
                          open={openMenuId === row.id}
                          onOpenChange={(open) => setOpenMenuId(open ? row.id : null)}
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

        {/* 行の詳細パネル（V8「サクサク感」C①・E）。一覧は左に見えたまま。 */}
        {panelRow &&
          (() => {
            const view = rowView(panelRow)
            const planned =
              view.status === 'draft' || view.status === 'stopped'
                ? emptyValue('unknown')
                : panelRow.plannedDeliveries == null
                  ? emptyValue('unknown')
                  : `${formatNumber(panelRow.plannedDeliveries)}通`
            const nextSend = view.status === 'active' ? formatNextSend(panelRow.nextScheduledAt) : emptyValue('unknown')
            return (
              <DetailPanel
                open
                title={panelRow.name}
                description={view.subtitle}
                onClose={() => setPanelId(null)}
                onPrev={panelIndex > 0 ? () => setPanelId(reminders[panelIndex - 1].id) : undefined}
                onNext={
                  panelIndex < reminders.length - 1
                    ? () => setPanelId(reminders[panelIndex + 1].id)
                    : undefined
                }
                hasPrev={panelIndex > 0}
                hasNext={panelIndex < reminders.length - 1}
                actions={{ primary: <Button variant="primary" onClick={() => goDetail(detailHref(panelRow.id))}>
                      詳細を見る
                    </Button>,
    secondary: (<Button variant="secondary" onClick={() => goDetail(`/reminders/edit?id=${encodeURIComponent(panelRow.id)}`)}>
                          編集する
                        </Button>),
    menuItems: [...([{ allowed: canEdit, id: 'detail-0', label: "複製する", onSelect: () => {
                    setDuplicateError('');
                    void runDuplicate(panelRow);
                    setPanelId(null);
                } }]),
        ...([{ allowed: canEdit, id: 'detail-1', label: "削除する", onSelect: () => {
                    setPanelId(null);
                    requestDelete(panelRow);
                } }])], secondaryAllowed: canEdit }}
               status={<StatusBadge tone={view.status === 'active' ? 'success' : 'neutral'} help={panelRow.followupManagement?`来店フォローで管理しています。${panelRow.followupManagement.reason??'承認された内容で送っています'}`:undefined} helpHref={panelRow.followupManagement?.path}>{view.status === 'active' ? '有効' : view.status === 'draft' ? '下書き' : '停止中'}</StatusBadge>}>
<DetailContent><DetailField label="これから送る">{planned}</DetailField><DetailField label="次に送る">{nextSend}</DetailField></DetailContent>
</DetailPanel>
            )
          })()}

        {/* まとめての帯（選ぶと表の下に出る）：止める・再開・フォルダへ移す。 */}
        {canEdit && selectedCount > 0 ? (
          <BulkBar count={selectedCount} total={reminderList.total} onSelectAll={selectAllReminders} onClear={clearSelection}>
            <Button
              type="button"
              variant="secondary"
              disabled={stoppableIds.length === 0}
              title={stoppableIds.length === 0 ? '有効なリマインダが選ばれていません' : undefined}
              onClick={() => { setBulkPauseAccountId(selectedAccountId); setBulkPauseGeneration(pauseContext.current.generation); setBulkPauseAccounts([...new Set(selectedRows.filter(row => stoppableIds.includes(row.id)).map(row => row.lineAccountId ?? ''))].map(id => ({ id, name: id ? undefined : '不明' }))); setBulkPauseIds(stoppableIds) }}
            >
              <Square size={16} aria-hidden="true" style={{ marginRight: 4, verticalAlign: -1 }} />
              止める
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={resumableIds.length === 0}
              title={resumableIds.length === 0 ? '停止中のリマインダが選ばれていません' : undefined}
              onClick={() => runBulkToggle(true, resumableIds)}
            >
              <Play size={16} aria-hidden="true" style={{ marginRight: 4, verticalAlign: -1 }} />
              再開
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => openMove([...selectedIds])}
            >
              <FolderIcon size={16} aria-hidden="true" style={{ marginRight: 4, verticalAlign: -1 }} />
              フォルダへ移す
            </Button>
          </BulkBar>
        ) : null}

        <ListPagePagination>
          <Pagination page={reminderList.page} pageCount={reminderList.pageCount} onPageChange={reminderList.setPage}
            range={{ total: reminderList.total, first: (reminderList.page - 1) * reminderList.limit + 1, last: Math.min(reminderList.page * reminderList.limit, reminderList.total) }} />
        </ListPagePagination>
      </>
    )

  const folderSelect = (
    <SaveErrorField names={["folderFilter","folder","folder_filter"]}><Select
      narrowFolderPicker aria-label="フォルダ"
      value={folderFilter}
      onChange={setFolderFilter}
      options={folderSelectOptions}
    /></SaveErrorField>
  )
  const statusChips = (
    <SegmentedControl
      aria-label="状態で絞り込む"
      value={statusFilter}
      onChange={setStatusFilter}
      options={[
        { value: '', label: 'すべて' },
        ...STATUS_CHIPS.map((status) => ({ value: status, label: status })),
      ]}
    />
  )
  const sortSelect = <SortSelect value={sort} onChange={setSort} options={SORT_OPTIONS} label="並び：" />
  const perPageSelect = <PageSizeSelect value={perPage} onChange={setPerPage} options={PER_PAGE_OPTIONS} label={null} />

  return (
    <SaveErrorScope errors={saveErrors}><PageFrame heightMode="content" skeleton kind="list" boardId={narrow ? 'Iffil' : 'apLqS'}>
      <PageHeading headingSize="regular" title={<>リマインダ</>} help={<>
            予約日時・誕生日・契約終了日などの「基準日」を決めて、その前や後に自動で送ります。
          </>}  />
      {friendId && filterFriend?.id === friendId ? <FriendFilterBand friend={filterFriend.value} subject="リマインダ" listHref={typeof window === 'undefined' ? '/reminders' : `${window.location.pathname}${window.location.search}`} /> : null}

      {/* 見るだけの人への帯（`a5C1p`）。押せない操作は置かずに隠す（2026-10-06 オーナー決定）。 */}
      {role !== null && !canEdit && (
        <div className={styles.viewerBand}><ReadOnlyNotice role="status" data-design-node="a5C1p">閲覧のみで見ています。{permissionDeniedMessage('store')}</ReadOnlyNotice></div>
      )}

      <ConfirmDialog
        open={bulkPauseIds !== null}
        title={`${bulkPauseIds?.length ?? 0} 件のリマインダを停止しますか？`}
        description="再開するまで、選んだリマインダの通知は送られません。"
        confirmLabel="停止する"
        onCancel={() => setBulkPauseIds(null)}
        busy={stopBusy} error={stopError || undefined}
        confirmDisabled={!canEdit || bulkPauseGeneration !== pauseContext.current.generation} confirmLockedReason={moveLockedReason}
        onSuccess={() => setBulkPauseIds(null)}
        onConfirm={() => bulkPauseIds && bulkPauseGeneration === pauseContext.current.generation && bulkPauseAccountId === selectedAccountId ? stopConfirmed(bulkPauseIds, bulkPauseIds) : undefined}
      ><OperationTargetSummary accounts={bulkPauseAccounts} /></ConfirmDialog>
      {/* 一時停止の窓（★V8 `RwVo5`）。確定で即反映し、裏で保存する。 */}
      <ConfirmDialog
        open={pauseTarget !== null && openedPause?.generation === pauseContext.current.generation}
        designNode="RwVo5" designWidth={480} footerAlign="center" actionWidthReserve="idle"
        title={pauseTarget ? `「${pauseTarget.name}」を一時停止する` : ''}
        description="再開するまで、このリマインダの通知は送られません。"
        confirmLabel="一時停止する"
        busy={stopBusy} error={stopError || undefined}
        confirmDisabled={!canEdit || !openedPause || openedPause.generation !== pauseContext.current.generation} confirmLockedReason={moveLockedReason}
        onSuccess={() => { pauseRef.current = null; setPauseTarget(null) }}
        onConfirm={() => runPause()}
        onCancel={() => {
          pauseRef.current = null; setPauseTarget(null)
              }}
      >
        <OperationTargetSummary accounts={[{ id: pauseTarget?.lineAccountId ?? '', name: pauseTarget?.lineAccountId ? undefined : '不明' }]} externalTarget={{ label: '対象件数', name: '1件' }} />
        {pauseTarget && (
          <Notice tone="warn" icon={<TriangleAlert size={16} aria-hidden="true" />}>
            {pauseTarget.plannedDeliveries != null && pauseTarget.plannedDeliveries > 0
              ? `これから送る予定の ${formatNumber(pauseTarget.plannedDeliveries)}通 が送られなくなります。`
              : 'これから送る予定の通知があれば、送られなくなります。'}
          </Notice>
        )}
      </ConfirmDialog>

      {/* 削除の窓（★V8 `VsSyu`）。 */}
      <SheetDialog
        open={deleteTarget !== null && deleteAccountId === selectedAccountId && openedDelete?.generation === pauseContext.current.generation}
        designNode="VsSyu" designWidth={480}
        title={deleteTarget ? `「${deleteTarget.name}」を削除しますか？` : ''}
        description="通知の予定と登録者がすべて消えます。すでに送ったメッセージは友だちのトークに残ります。"
        band={deleteTarget && statusKeyOf(deleteTarget) === 'active' ? '削除は元に戻せません。しばらく使わないだけなら「一時停止する」を使ってください。' : '削除は元に戻せません。'}
        bandTone="danger"
        busy={deleting}
        error={deleteError || (deleteTarget && !deleteStillListed ? 'このリマインダが一覧から外れました。この窓を閉じて、いまの一覧から選び直してください。' : undefined)}
        onClose={() => {
          if (deleting) return
          deleteRef.current = null
          setDeleteTarget(null)
          setDeleteError('')
        }}
        destructive={(
          <Button variant="danger" widthReserve="idle" onClick={() => void runDelete()} disabled={deleting || !deleteStillListed} busy={deleting} busyLabel="削除しています…">
            削除する
          </Button>
        )}
        actions={(
          <>
            <Button
              onClick={() => {
                deleteRef.current = null
                setDeleteTarget(null)
                setDeleteError('')
              }}
              disabled={deleting}
            >
              キャンセル
            </Button>
            {deleteTarget && statusKeyOf(deleteTarget) === 'active' ? (
              <Button
                onClick={() => {
                  openPause(deleteTarget)
                  deleteRef.current = null
                  setDeleteTarget(null)
                }}
                disabled={deleting}
              >
                <Pause size={16} aria-hidden="true" />代わりに一時停止
              </Button>
            ) : null}
          </>
        )}
      ><OperationTargetSummary accounts={[{ id: deleteTarget?.lineAccountId ?? '', name: deleteTarget?.lineAccountId ? undefined : '不明' }]} /></SheetDialog>

      {/* 複製の窓。下書きとして写し、確認してから有効にする。 */}
      <></>

      {/* フォルダ移動の窓。1件でも複数件でも同じ形。 */}
      <ConfirmDialog
        open={moveIds !== null}
        title={
          moveIds && moveIds.length === 1
            ? `「${reminders.find((row) => row.id === moveIds[0])?.name ?? 'リマインダ'}」のフォルダを移動`
            : `${moveIds?.length ?? 0}件のリマインダのフォルダを移動`
        }
        description="移動先のフォルダを選んでください。「未分類」を選ぶとフォルダから外れます。"
        confirmLabel="移動する"
        confirmDisabled={!canEdit} confirmLockedReason={moveLockedReason}
        pendingUndo={pendingMove} onSuccess={() => setMoveIds(null)} onUndone={() => setMoveIds(null)}
        busyLabel="移動中…" onConfirm={() => runMove()}
        onCancel={() => {
          setMoveIds(null)
        }}
      >
        <div className={styles.moveBody}>
          <Field label={<><span className={styles.moveLabel}>移動先のフォルダ</span></>}><SaveErrorField names={["moveDraft","move_draft"]}><FolderSelect
              aria-label="移動先のフォルダ"
              size="full"
              disabled={!canEdit || Boolean(pendingMove)} lockedReason={moveLockedReason}
              value={moveDraft}
              onChange={(value) => setMoveDraft(value)}
              folders={folders.map((folder) => ({ value: folder.id, label: folder.name }))}
            /></SaveErrorField></Field>
        </div>
      </ConfirmDialog>

      <ListPageBody skeleton
        stats={!friendId ? <KpiBand border="dividers" data-design="KPIs">
          {kpis.map((kpi) => (
            <KpiCard key={kpi.title} presentation="band" title={kpi.title} icon={<kpi.icon size={16} aria-hidden="true" />} value={kpi.value} unit={kpi.value == null ? '' : kpi.unit} detail={kpi.detail} action={kpi.link && !statsFailed && kpi.value !== null && kpi.value > 0 ? { label: '失敗を見る', onClick: kpi.link } : undefined} />
          ))}
        </KpiBand> : null}
        folders={<>
          <ManagedFolderPanel
            createAction={canEdit ? <Button href="/reminders/new" variant="primary" className="v8-folder-create w-full">
              ＋ リマインダを作る
            </Button> : undefined}
            kind="reminder"
            accountId={selectedAccountId}
            folders={folders}
            onChanged={loadFolders}
            canManage={canEdit}
            itemLabel="リマインダ"
            activeId={folderFilter}
            onSelect={setFolderFilter}
            allId=""
            unfiledId={UNFILED}
            allCount={reminderList.total ?? null}
            unfiledCount={unfiledCount}
            placeholder="例：予約"
          >
            {foldersError && (reminders.length > 0 || !reminderList.error) ? (
            <Notice tone="danger" className={styles.folderNoteNoticePlacement} action={<>
              <Button variant="text" size="inline" data-notice-inline-action
                type="button"
                onClick={() => void loadFolders()}
              >
                もう一度
              </Button>
            </>}>フォルダを読み込めませんでした。
            </Notice>
            ) : null}
          </ManagedFolderPanel>
        </>}
        collapsedFolders={<>
          {canEdit ? (
            <Button href="/reminders/new" variant="primary">
              ＋ リマインダを作る
            </Button>
          ) : null}
          {folderSelect}
        </>}
        toolbar={<>
          {/* 道具の段は型の toolbar 枠に渡す（中身だけ渡す）。 */}
          <ListToolbar
            search={{
              placeholder: '名前・内容で探す',
              width: 200,
              value: nameQuery,
              onChange: (value) => setNameQuery(clampSearchQuery(value)),
            }}
            filters={<>{statusChips}</>}
            trailing={<>
              {sortSelect}
              {perPageSelect}
            </>}
          />
        </>}>

          {filterActive && reminderList.loaded && (
            <p className={styles.folderNote} style={{ fontVariantNumeric: 'tabular-nums' }}>
              条件に一致したリマインダ：{formatNumber(reminderList.total)}件
            </p>
          )}

          {actionError && (
          <Notice tone="danger" className={styles.errorBandNoticePlacement} action={<>
            <Button variant="text" size="inline" data-notice-inline-action type="button" onClick={() => setActionError('')}>閉じる</Button>
          </>}>
            {actionError}
          </Notice>
          )}

          <RefreshCover refreshing={reminderList.refreshing}>{table}</RefreshCover>
        </ListPageBody>
    </PageFrame></SaveErrorScope>
  )
}
