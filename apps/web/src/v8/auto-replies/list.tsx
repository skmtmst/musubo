'use client'

import OperationTargetSummary from '@/components/shared/operation-target-summary'


import { duplicateAutoReply } from './list-duplicate-action'
import { AutoReply,displayName,PAGE_SIZE_OPTIONS,PendingDelete,PendingToggle,SAVED_FILTER_OPTIONS,TemplateLite,UNFILED } from './list-model'
import { renderAutoReplyList } from './list-table'
import { toggleAutoReply } from './list-toggle-action'
import { canEditAutoReplyListNow } from './list-access'
import { autoReplyContextMenu, autoReplyRowMenu } from './list-row-menu'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'

import { useDetailPanelUrl } from '@/components/shared/detail-panel'
import FolderSelect from '@/components/shared/folder-select'
import ListToolbar,{ ListToolbarOptional,ListToolbarSort as SortSelect } from '@/components/shared/list-toolbar'
import { useStaffRole } from '@/lib/staff-role'
import { Ban,Bookmark,ChevronDown,CircleCheck,CircleHelp,CirclePlay,Layers,MessageCircle,Pause,Plus,TriangleAlert,Zap } from 'lucide-react'
import { SORT_OPTIONS,type SortKey } from './list-options'
import { autoReplyMatchesQuery,isCurrentAutoReplyLoad,LOAD_STATE_WORDS,NO_WRITE_PERMISSION,visibleAutoReplyLoadState,type LoadState } from './words'





import { useEscapeToClearSelection } from '@/components/shared/bulk-bar'
import { useListScrollMemory,useListUrlFlag,useListUrlParam,useListUrlValue } from '@/components/shared/list-url-state'
import { ListPage,ListPagePagination } from '@/components/templates'
import { useFeatureAccess } from '@/lib/use-feature-access'
import { useCallback,useEffect,useMemo,useRef,useState } from 'react'


import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'

import ActionMenu,{ type ActionMenuItem } from '@/components/shared/action-menu'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import { type ContextMenuItem } from '@/components/shared/context-menu'
import Dialog,{ DialogActions } from '@/components/shared/dialog'
import { emptyValue } from '@/components/shared/empty-value'
import FilterChip from '@/components/shared/filter-chip'
import { type FolderDotFolder } from '@/components/shared/folder-dot'
import { Field } from '@/components/shared/form-controls'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import ManagedFolderPanel, { useManagedFolders } from '@/components/shared/managed-folder-panel'
import Notice from '@/components/shared/notice'
import Pagination from '@/components/shared/pagination'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { SaveErrorField,SaveErrorScope,useSaveFormErrors } from '@/components/shared/save-form-errors'
import Select from '@/components/shared/select'
import { Th } from '@/components/shared/table'
import { TextField } from '@/components/shared/text-field'
import { notifyToast } from '@/components/shared/toast'
import { useDuplicateFeedback } from '@/components/shared/use-duplicate-feedback'
import { withViewTransition } from '@/components/shared/view-transition'
import { usePageCrumbs,usePageTitle } from '@/components/shell/page-chrome'
import { useAccount } from '@/contexts/account-context'
import { api,ApiError } from '@/lib/api'
import { conversationAiUiEnabled } from '@/lib/environment-features'
import { formatNumber } from '@/lib/format'
import { clampSearchQuery } from '@/lib/search-query'
import { describeApiFailure } from '@/components/shared/api-error-message'
import type { ConfirmedUndoHandle } from '@/lib/undoable'
import { runUndoable } from '@/lib/undoable'
import { useLiveReorder } from '@/lib/use-live-reorder'
import { useNarrowViewport } from '@/lib/use-narrow-viewport'
import { AutoReplyTabs } from '@/v8/ai-reply/public/auto-reply-tabs/index'
import styles from './list.module.css'
import { compareEvaluationOrder,movePriorityUpdates } from './order'
import QuickCreateV8 from './quick-create'

/* 作るボタン（板  の ▾）。窓は1つだけ置き、押したボタンの位置に出す。 */
function CreateRuleButton({ full, compact, disabled, disabledTitle, lockedReason, menuOpen, onOpenMenu }: {
  full?: boolean
  /** 1152 の板：▾ なし・＋は印（絵どおり）。押すと同じ窓が開く。 */
  compact?: boolean
  disabled: boolean
  disabledTitle?: string
  lockedReason?: string
  menuOpen: boolean
  onOpenMenu: (anchor: HTMLButtonElement | null) => void
}) {
  return (
    <Button
      type="button"
      variant="primary"
      className={full ? 'v8-folder-create w-full' : undefined}
      disabled={disabled}
      lockedReason={lockedReason}
      title={disabledTitle}
      onClick={(event) => onOpenMenu(event.currentTarget)}
      aria-expanded={menuOpen}
      aria-haspopup="menu"
    >
      {compact ? <><Plus size={16} aria-hidden="true" />ルールを作る</> : <>＋ ルールを作る <ChevronDown size={16} aria-hidden="true" /></>}
    </Button>
  )
}

export default function AutoRepliesListV8() {
  const saveErrors = useSaveFormErrors()
  usePageTitle('自動応答')
  usePageCrumbs([{ label: 'ホーム', href: '/' }])
  const router = useRouter()
  const { selectedAccountId } = useAccount()
  const staffRole = useStaffRole()
  const featureAccess = useFeatureAccess('autoReplies')
  const resolvedReason = usePermissionLockReason(featureAccess)
  const lockedReason = staffRole === null ? undefined : resolvedReason
  const canEdit = staffRole !== null && featureAccess && !lockedReason
  // 1152の板（）。折り畳みはCSSのコンテナ問い合わせが担い、
  // ここでは板IDだけを切り替える。
  const narrow = useNarrowViewport()

  const [items, setItems] = useState<AutoReply[]>([])
  /* 絞り込み・検索語・ページは URL に置く（戻ると同じ一覧に戻る。動きの点検 5 番）。 */
  const [query, setQuery] = useListUrlParam('q')
  const [templates, setTemplates] = useState<TemplateLite[]>([])
  const [templateListAvailable, setTemplateListAvailable] = useState(true)
  const [conflictCount, setConflictCount] = useState<number | null>(null)
  const [dispatchStopped, setDispatchStopped] = useState<boolean | null>(null)
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [loadError, setLoadError] = useState<unknown>(null)
  const { folders, reload: loadFolders } = useManagedFolders('auto_reply', selectedAccountId)
  const [folderFilter, setFolderFilter] = useListUrlParam('folder')
  const [sortKey, setSortKey] = useListUrlValue<SortKey>('sortKey', 'priority')
  const [savedFilter, setSavedFilter] = useListUrlParam('view')
  const [stoppedOnly, setStoppedOnly] = useListUrlFlag('stopped')
  const [timedOnly, setTimedOnly] = useListUrlFlag('timed')
  const [zeroThisMonthOnly, setZeroThisMonthOnly] = useListUrlFlag('zero')
  /** 「重なりあり」の絞り込み。要確認の帯・行の札から入る。 */
  const [conflictOnly, setConflictOnly] = useListUrlFlag('conflict')
  const [pageSize, setPageSize] = useListUrlValue('pageSize', 20)
  const [pageParam, setPageParam] = useListUrlParam('page', '1')
  const page = Math.max(1, Number.parseInt(pageParam, 10) || 1)
  const setPage = useCallback((next: number) => setPageParam(String(next)), [setPageParam])

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  /* 板 ：作るボタンは ▾ で作り方を選ぶ。 */
  const [createMenuOpen, setCreateMenuOpen] = useState(false)
  const createMenuAnchorRef = useRef<HTMLButtonElement | null>(null)
  /* ★V8 かんたんに作る（板 ）。詳しい分け方は  待ち。 */
  const [quickOpen, setQuickOpen] = useState(false)
  /* 行の詳細パネル（V8「サクサク感」C①・D・E）。開いている行のID。 */
  const [panelId, setPanelId] = useDetailPanelUrl('reply')
  const [pendingDelete, setPendingDelete] = useState<(PendingDelete & { generation: number }) | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [pendingToggle, setPendingToggle] = useState<PendingToggle | null>(null)
  const [toggleReason, setToggleReason] = useState('')
  const [toggleError, setToggleError] = useState('')
  const [moveIds, setMoveIds] = useState<string[] | null>(null)
  const moveConfirmed = useRef(new Map<string, string | null>())
  const [pendingMove, setPendingMove] = useState<ConfirmedUndoHandle | null>(null)
  const [moveAccountId, setMoveAccountId] = useState(selectedAccountId)
  const [moveDraft, setMoveDraft] = useState('')
  const duplicateLock = useRef(false)
  const duplicateFeedback = useDuplicateFeedback(selectedAccountId)
  const [duplicating, setDuplicating] = useState(false)
  const setDuplicateError =(message: string | null) => { if (message) notifyToast(message, { tone: 'error' }) }
  const [actionError, setActionError] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [moveNotice, setMoveNotice] = useState('')

  const selectedAccountIdRef = useRef(selectedAccountId)
  const accountScope = useRef({ id: selectedAccountId, generation: 0 })
  if (accountScope.current.id !== selectedAccountId) accountScope.current = { id: selectedAccountId, generation: accountScope.current.generation + 1 }
  const renderedScope = accountScope.current
  const loadedScope = useRef<typeof accountScope.current | null>(null)
  const deleteLock = useRef(false)
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  selectedAccountIdRef.current = selectedAccountId
  const canRunList = () => mounted.current && canEditAutoReplyListNow() && renderedScope === accountScope.current && loadedScope.current === renderedScope && selectedAccountIdRef.current === selectedAccountId
  useEffect(() => {
    setSelectedIds(new Set()); setOpenMenuId(null); setCreateMenuOpen(false); setDragId(null)
  }, [selectedAccountId])
  const loadGenerationRef = useRef(0)
  const [loadedAccountId, setLoadedAccountId] = useState<string | null | undefined>(undefined)

  const load = useCallback(async () => {
    const requestAccountId = selectedAccountId
    const requestScope = renderedScope
    const requestGeneration = ++loadGenerationRef.current
    setLoadState('loading')
    setLoadError(null)
    setConflictCount(null)
    setDispatchStopped(null)
    try {
      const [arRes, tplRes, summaryRes] = await Promise.all([
        api.autoReplies.list({ accountId: selectedAccountId || undefined }),
        api.templates.list(undefined, selectedAccountId || undefined),
        selectedAccountId
          ? api.autoReplies.summary(selectedAccountId).catch(() => null)
          : Promise.resolve(null),
      ])
      if (!isCurrentAutoReplyLoad(
        requestAccountId,
        selectedAccountIdRef.current,
        requestGeneration,
        loadGenerationRef.current,
      )) return
      if (!arRes.success) {
        setLoadedAccountId(requestAccountId)
        setLoadState('error')
        return
      }
      if (requestScope !== accountScope.current) return
      loadedScope.current = requestScope
      setItems(arRes.data as AutoReply[])
      setConflictCount(summaryRes?.success ? summaryRes.data.conflictCount : null)
      setDispatchStopped(summaryRes?.success ? summaryRes.data.dispatchStopped ?? null : null)
      setTemplateListAvailable(tplRes.success)
      setTemplates(tplRes.success
        ? tplRes.data.map((t) => ({
            id: t.id,
            name: t.name,
            messageType: t.messageType,
            messageContent: t.messageContent,
          }))
        : [])
      setLoadedAccountId(requestAccountId)
      setLoadState('ready')
    } catch (reason) {
      if (!isCurrentAutoReplyLoad(
        requestAccountId,
        selectedAccountIdRef.current,
        requestGeneration,
        loadGenerationRef.current,
      )) return
      const fieldFailure = saveErrors.capture(reason)
      setLoadedAccountId(requestAccountId)
      { if (!fieldFailure)
      setLoadError(reason) }
      { if (!fieldFailure)
      setLoadState(reason instanceof ApiError && reason.status === 403 ? 'forbidden' : 'error')
    }
  }
  }, [selectedAccountId, saveErrors])

  useEffect(() => { load() }, [load])


  const templateById = useMemo(() => new Map(templates.map((t) => [t.id, t])), [templates])

  /*
   * 押した瞬間の見せ方（★V8 サクサク感 B）。軽い操作は先にこの重ねで
   * 描き換え、裏で保存する。確定・失敗・取り消しで重ねを外し、読み直す。
   * ページ・絞り込みが変わったら重ねは捨てる（違う一覧に貼らない）。
   */
  const [optimisticRows, setOptimisticRows] = useState<{ key: string; rows: AutoReply[] } | null>(null)
  const listContextKey = JSON.stringify({
    account: selectedAccountId ?? '',
    query,
    folder: folderFilter,
    sort: sortKey,
    chips: [conflictOnly, stoppedOnly, timedOnly, zeroThisMonthOnly, savedFilter],
    pageSize,
    page,
  })
  const rules = optimisticRows && optimisticRows.key === listContextKey ? optimisticRows.rows : items
  const pendingToggleRef = useRef(pendingToggle); pendingToggleRef.current = pendingToggle
  const openPendingToggle = (target: PendingToggle) => {
    if (!canRunList()) return
    const targets = target.ids.map(id => rules.find(rule => rule.id === id)?.lineAccountId)
    const next: PendingToggle = { ...target, versions: Object.fromEntries(target.ids.flatMap(id => { const version = rules.find(rule => rule.id === id)?.confirmationRevision; return Number.isSafeInteger(version) && Number(version) > 0 ? [[id, Number(version)]] : [] })), generation: renderedScope.generation, allAccounts: targets.some(id => id === null), targetAccountIds: [...new Set(targets.filter(id => id !== null).map(id => id ?? ''))] }
    pendingToggleRef.current = next
    setPendingToggle(next)
  }
  const setPendingToggleFromList: typeof setPendingToggle = (value) => {
    if (typeof value === 'function') { setPendingToggle(value); return }
    if (value) openPendingToggle(value)
    else { pendingToggleRef.current = null; setPendingToggle(null) }
  }
  /* 削除は、利用状況にかかわらず確認してから実行する。 */
  const requestDelete = (r: AutoReply) => { if (!canRunList() || !mounted.current || renderedScope !== accountScope.current || loadedScope.current !== renderedScope) return; setDeleteError(''); setPendingDelete({ item: r, accountId: selectedAccountId, generation: renderedScope.generation }) }

  /* ===== 数の帯 ===== */
  const hitsAllKnown = rules.every((r) => r.hits !== undefined)
  const monthlyHits = hitsAllKnown
    ? rules.reduce((sum, r) => sum + (r.hits?.period ?? 0), 0)
    : null
  const totalHits = hitsAllKnown
    ? rules.reduce((sum, r) => sum + (r.hits?.total ?? 0), 0)
    : null
  const actionExecutionsAllKnown = rules.every((r) => r.actionExecutionCount != null)
  const actionExecutionCount = actionExecutionsAllKnown
    ? rules.reduce((sum, r) => sum + (r.actionExecutionCount ?? 0), 0)
    : null

  const visibleLoadState = visibleAutoReplyLoadState(loadState, loadedAccountId, selectedAccountId)
  const ready = visibleLoadState === 'ready'

  /* ===== 絞り込み ===== */
  const afterQuery = rules.filter((r) => autoReplyMatchesQuery(r, query))
  const inFolder = afterQuery.filter((r) => {
    if (folderFilter === UNFILED) return !r.folderId
    if (folderFilter) return r.folderId === folderFilter
    return true
  })
  const inChips = inFolder.filter((r) => {
    if (conflictOnly && (r.conflictAttentionCount ?? 0) <= 0) return false
    if (stoppedOnly && r.isActive) return false
    if (timedOnly && !Boolean(r.activeFrom || r.activeUntil || (r.responseWeekdays?.length ?? 0) > 0)) return false
    /* ヒット数が分からないルールを「今月0回」に混ぜない。0 は「当たらなかった」の意味。 */
    if (zeroThisMonthOnly && (r.hits === undefined || r.hits.period !== 0)) return false
    if (savedFilter === 'used' && (r.hits?.period ?? 0) <= 0) return false
    return true
  })
  const sortedItems = useMemo(() => [...inChips].sort((a, b) => {
    switch (sortKey) {
      case 'hits':
        return (b.hits?.period ?? 0) - (a.hits?.period ?? 0)
      case 'name':
        return displayName(a).localeCompare(displayName(b), 'ja')
      case 'created':
        return b.createdAt.localeCompare(a.createdAt)
      default:
        // 評価順は「実際に見る順」。一覧の並びと動く順を合わせる。
        return compareEvaluationOrder(a, b)
    }
  }), [inChips, sortKey])

  const filterActive = Boolean(
    query || folderFilter || conflictOnly || stoppedOnly || timedOnly || zeroThisMonthOnly || savedFilter,
  )
  const clearFilters = () => {
    setQuery('')
    setFolderFilter('')
    setConflictOnly(false)
    setStoppedOnly(false)
    setTimedOnly(false)
    setZeroThisMonthOnly(false)
    setSavedFilter('')
  }

  const pageCount = Math.max(1, Math.ceil(sortedItems.length / pageSize))
  const safePage = Math.min(page, pageCount)
  const shownItems = sortedItems.slice((safePage - 1) * pageSize, safePage * pageSize)

  // 絞り込みや件数の変更でページが溢れたら先頭へ戻す。
  // 読み込みが終わる前は件数が 0 なので戻さない（URL のページを先頭へ潰さない）。
  useEffect(() => {
    if (loadState !== 'ready') return
    if (page > pageCount) setPage(pageCount)
  }, [loadState, page, pageCount, setPage])
  useListScrollMemory(loadState === 'ready')

  const nextPriority = items.length === 0
    ? 0
    : Math.min(9999, Math.max(...items.map((item) => item.priority)) + 1)

  /* ===== 選択 ===== */
  const toggleOne = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const pageIds = shownItems.map((r) => r.id)
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id))
  const toggleAllOnPage = () => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (allOnPageSelected) pageIds.forEach((id) => next.delete(id))
      else pageIds.forEach((id) => next.add(id))
      return next
    })
  }
  const selectedCount = selectedIds.size
  /* 選んでいる間は Esc で選択を外す（動きの点検 12 番）。 */
  const clearSelection = useCallback(() => setSelectedIds(new Set()), [])
  useEscapeToClearSelection(selectedCount > 0, clearSelection)
  const selectedRules = rules.filter((r) => selectedIds.has(r.id))
  const stoppableIds = selectedRules.filter((r) => r.isActive).map((r) => r.id)
  const resumableIds = selectedRules.filter((r) => !r.isActive && r.lifecycleStatus !== 'draft').map((r) => r.id)

  /* ===== 操作 ===== */

  /*
   * 停止・再開は確認窓の決定で窓を閉じて即反映し、すぐ裏で送る
   * （裁定 C：5秒待たない）。止める理由（任意）は窓で受け取り、そのまま
   * 記録へ送る。知らせの「元に戻す」は逆の操作を送る（止めたなら再開・
   * 再開したなら止める。止め直すときは変える前の理由を使う）。
   * 送れなかったら戻して「もう一度」の知らせを出す。
   */
  const runToggle = (target = pendingToggle) => { if (!canRunList()) return; if (target && target === pendingToggle) { if (target !== pendingToggleRef.current || target.generation !== accountScope.current.generation) return; pendingToggleRef.current = null }; toggleAutoReply({ listContextKey, load, pendingToggle, rules, saveErrors, selectedAccountId, selectedAccountIdRef, isCurrent: () => mounted.current && renderedScope === accountScope.current, setOptimisticRows, setPendingToggle, setSelectedIds, setToggleError, setToggleReason, toggleReason }, target) }

  const runDelete = async () => {
    if (!canRunList() || !pendingDelete || !mounted.current || deleteLock.current || pendingDelete.generation !== accountScope.current.generation || loadedScope.current !== accountScope.current) return
    if (pendingDelete.accountId !== selectedAccountId) {
      setDeleteError('アカウントが切り替わりました。削除する自動応答を選び直してください。')
      return
    }
    const requestAccountId = pendingDelete.accountId
    const targetId = pendingDelete.item.id
    deleteLock.current = true
    setDeleting(true)
    setDeleteError('')
    try {
      const result = await api.autoReplies.delete(targetId)
      if (!mounted.current || pendingDelete.generation !== accountScope.current.generation) return
      if (!result.success) {
        setDeleteError('自動応答を削除できませんでした。状態を読み直してからお試しください。')
        return
      }
      setPendingDelete(null)
      if (selectedAccountIdRef.current === requestAccountId) await load()
    } catch (reason) {
      if (!mounted.current || pendingDelete.generation !== accountScope.current.generation) return
      const fieldFailure = saveErrors.capture(reason)

      { if (!fieldFailure)
      setDeleteError(
        reason instanceof ApiError && reason.status === 403
          ? `${NO_WRITE_PERMISSION.label}。${NO_WRITE_PERMISSION.note}`
          : '自動応答を削除できませんでした。状態を読み直してからお試しください。',
      ) }
    } finally {
      deleteLock.current = false
      if (mounted.current) setDeleting(false)
    }
  }

  /** 削除の窓の「代わりに止める」。削除をやめて、停止の窓へ移す。 */
  const stopInsteadOfDelete = () => {
    if (!canRunList() || !pendingDelete || !mounted.current || pendingDelete.generation !== accountScope.current.generation || loadedScope.current !== accountScope.current) return
    setToggleError('')
    setToggleReason('')
    openPendingToggle({
      ids: [pendingDelete.item.id],
      names: [displayName(pendingDelete.item)],
      kind: 'stop',
      accountId: pendingDelete.accountId,
    })
    setPendingDelete(null)
    setDeleteError('')
  }

  /** フォルダへ移す（1件でもまとめてでも同じ窓）。 */
  const openMove = (ids: string[]) => {
    if (!canRunList() || ids.length === 0) return
    moveConfirmed.current = new Map()
    setMoveIds(ids)
    setMoveAccountId(selectedAccountId)
    setMoveDraft('')
  }
  /*
   * フォルダ移動は窓で行き先だけ選び、押した瞬間に描き換えて裏で保存する
   * （★V8 サクサク感 B）。5秒のあいだ知らせの「元に戻す」で送らずに戻せる。
   */
  const runMove = async () => {
    if (!canRunList() || moveAccountId !== selectedAccountId || !moveIds?.length) return
    const confirmed = moveConfirmed.current
    const ids = moveIds
    const requestAccountId = selectedAccountId
    const folderId = moveDraft || null
    const key = listContextKey
    const before = rules
    const restore = () => {
      if (!(moveConfirmed.current === confirmed && selectedAccountIdRef.current === requestAccountId)) return
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
          if (!(moveConfirmed.current === confirmed && selectedAccountIdRef.current === requestAccountId) || !(canEditAutoReplyListNow())) {
            const saved = ids.filter(value => confirmed.has(value) && confirmed.get(value) === folderId).length
            moveFailure = `${formatNumber(ids.length)} 件中 ${formatNumber(saved)} 件を保存しました。残りは本人・権限・LINEアカウントが変わったため送っていません。`
            throw new Error(moveFailure)
          }
          try {
            const result = await api.autoReplies.update(id, { folderId })
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
      onCommitError: () => { restore(); if (moveConfirmed.current === confirmed && selectedAccountIdRef.current === requestAccountId) { void load(); void loadFolders() } },
      get failureMessage() { return moveFailure || undefined },
      onCommitted: () => {
        if (!(moveConfirmed.current === confirmed && selectedAccountIdRef.current === requestAccountId)) return
        setOptimisticRows(null)
        const moved = new Set(ids)
        setSelectedIds(values => new Set([...values].filter(id => !moved.has(id))))
        void load(); void loadFolders()
      },
    })
    setPendingMove(handle)
    try {
      const result = await handle.finished
      return (moveConfirmed.current === confirmed && selectedAccountIdRef.current === requestAccountId) ? result : undefined
    }
    finally { setPendingMove(value => value === handle ? null : value) }
  }

  /*
   * 複製（行の「…」→「複製する」）。複製の口は無いので、同じ内容で新しく作る。
   * コピーは必ず「停止中」で作る（AUTOREPLY-08：動かすのは別の操作）。
   * 名前や確認の窓は出さず、その場で作る。
   */
  const duplicateKeysRef = useRef(new Map<string, string>())
  const runDuplicate = async (duplicateTarget: AutoReply) => { if (!canRunList()) return; await duplicateAutoReply({ duplicateFeedback, duplicateKeysRef, duplicateLock, duplicating, load, nextPriority, saveErrors, selectedAccountId, setDuplicateError, setDuplicating }, duplicateTarget) }

  /*
   * R28: 順番は一覧で上下を入れ替えて決める。入れ替えは隣との数字の交換
   * （同点だけ1ずらし）で、既存の更新口を使う。ドラッグで任意の位置へ
   * 落としたときは、隣との交換を目的の位置まで繰り返す。
   */
  /*
   * 並べ替えは押した瞬間に描き換え、裏で番号を保存する（★V8 サクサク感 B）。
   * 5秒のあいだ知らせの「元に戻す」で送らずに戻せる。読み上げには
   * 動かした結果をそのまま知らせる（`moveNotice` は残す）。
   */
  const applyPriorityUpdates = (updates: Array<{ id: string; priority: number }>, notice: string) => {
    if (!canRunList()) return
    duplicateFeedback.clear()
    if (updates.length === 0) return
    const requestAccountId = selectedAccountId
    const nextById = new Map(updates.map((u) => [u.id, u.priority] as const))
    const key = listContextKey
    setOptimisticRows({
      key,
      rows: rules.map((r) =>
        nextById.has(r.id) ? { ...r, priority: nextById.get(r.id) as number } : r,
      ),
    })
    setMoveNotice(notice)
    setActionError('')
    runUndoable({
      message: '並び順を変えました',
      commit: async () => {
        for (const update of updates) {
          if (!canEditAutoReplyListNow() || selectedAccountIdRef.current !== requestAccountId) throw new Error('並べ替え中に操作できる状態が変わりました')
          const result = await api.autoReplies.update(update.id, { priority: update.priority })
          if (!result.success) throw new Error('reorder_failed')
        }
      },
      undo: () => setOptimisticRows(current => current?.key === key ? null : current),
      onCommitError: () => {
        setOptimisticRows(current => current?.key === key ? null : current)
        if (selectedAccountIdRef.current === requestAccountId) void load()
      },
      failureMessage: '順番を変えられませんでした。画面を読み直してからお試しください。',
      onCommitted: () => {
        setOptimisticRows(current => current?.key === key ? null : current)
        if (selectedAccountIdRef.current === requestAccountId) void load()
      },
    })
  }

  const keyboardMove = (id: string, direction: -1 | 1) => {
    if (!canRunList()) return
    const updates = movePriorityUpdates(sortedItems, id, direction)
    if (!updates) return
    const name = displayName(rules.find((r) => r.id === id) ?? ({} as AutoReply))
    applyPriorityUpdates(updates, `${name}を${direction === -1 ? '1つ上' : '1つ下'}へ動かしました`)
  }

  /* 動かしている間、置き場所を入れ替えて見せ、ほかの行は滑らかに場所を空ける（フルード ②）。 */
  const liveOrder = useLiveReorder(shownItems, (r) => r.id, dragId)

  const dropOn = (targetId: string) => {
    if (!dragId || dragId === targetId || !canRunList() || sortKey !== 'priority') {
      setDragId(null)
      return
    }
    const ordered = [...sortedItems]
    const fromIndex = ordered.findIndex((r) => r.id === dragId)
    const targetIndex = ordered.findIndex((r) => r.id === targetId)
    setDragId(null)
    if (fromIndex < 0 || targetIndex < 0) return
    // 目的の位置まで隣との交換を繰り返し、各行の最終の番号だけを送る。
    const working = [...ordered]
    const direction = targetIndex > fromIndex ? 1 : -1
    const finalUpdates = new Map<string, number>()
    let current = fromIndex
    while (current !== targetIndex) {
      const step = movePriorityUpdates(working, dragId, direction as -1 | 1)
      if (!step) return
      for (const u of step) {
        finalUpdates.set(u.id, u.priority)
        const position = working.findIndex(rule => rule.id === u.id)
        working[position] = { ...working[position], priority: u.priority }
      }
      const [moved] = working.splice(current, 1)
      working.splice(current + direction, 0, moved)
      current += direction
    }
    const name = displayName(ordered[fromIndex])
    applyPriorityUpdates(
      [...finalUpdates.entries()].map(([id, priority]) => ({ id, priority })),
      `${name}の順番を変えました`,
    )
  }

  /* ===== 行の「…」（Pencil ） ===== */
  const rowMenuItems = (r: AutoReply): ActionMenuItem[] => autoReplyRowMenu(r, {
    canEdit, lockedReason, canRun: canRunList,
    edit: () => goEdit(r.id),
    runs: () => withViewTransition(() => router.push(`/auto-replies/runs?id=${r.id}`)),
    duplicate: () => { setDuplicateError(''); void runDuplicate(r) },
    stop: () => {
      setToggleError(''); setToggleReason('')
      openPendingToggle({ ids: [r.id], names: [displayName(r)], kind: 'stop', accountId: selectedAccountId })
    },
    resume: () => { setToggleError(''); runToggle({ ids: [r.id], names: [displayName(r)], kind: 'resume', accountId: selectedAccountId }) },
    move: () => openMove([r.id]),
    remove: () => requestDelete(r),
  })

  /* ===== 行の詳細パネル（V8「サクサク感」C①・D・E） ===== */

  /** 一覧の行→詳細はつながる移り変わりで開く。 */
  const goEdit = (id: string) => {
    withViewTransition(() => {
      router.push(`/auto-replies/edit?id=${id}`)
    })
  }

  /** 右クリックは「…」と同じ項目をマウスの位置に出す。 */
  const rowContextItems = (r: AutoReply): ContextMenuItem[] => autoReplyContextMenu(rowMenuItems(r))

  const panelIndex = panelId === null ? -1 : items.findIndex((r) => r.id === panelId)
  const panelRow = panelIndex >= 0 ? items[panelIndex] : null

  /** パネルから止める・再開する。窓の流れは「…」と同じ。 */
  const toggleFromPanel = (r: AutoReply) => {
    if (!canRunList()) return
    const name = displayName(r)
    setToggleError('')
    setToggleReason('')
    const target: PendingToggle = { ids: [r.id], names: [name], kind: r.isActive ? 'stop' : 'resume', accountId: selectedAccountId }
    if (r.isActive) openPendingToggle(target)
    else runToggle(target)
    setPanelId(null)
  }

  /* ===== フォルダの列 ===== */
  /* 行の名前の前の丸は、左のフォルダの列と同じフォルダ（同じ色）を引く。未分類は色の無い輪。 */
  const folderDotOf = (r: { folderId: string | null }): FolderDotFolder | null => {
    if (!r.folderId) return null
    const folder = folders.find((f) => f.id === r.folderId)
    return folder ? { name: folder.name, color: folder.color } : null
  }
  const folderSelectOptions = [
    { value: '', label: 'フォルダ：すべて' },
    ...folders.map((f) => ({ value: f.id, label: f.name })),
    { value: UNFILED, label: '未分類' },
  ]

  const folderPanel = (
    <ManagedFolderPanel
      createAction={<CreateRuleButton
        full
        disabled={!canEdit}
        lockedReason={lockedReason}
        menuOpen={createMenuOpen}
        onOpenMenu={(anchor) => { if (!canRunList()) return; createMenuAnchorRef.current = anchor; setCreateMenuOpen(true) }}
      />}
      kind="auto_reply"
      accountId={selectedAccountId}
      folders={folders}
      onChanged={loadFolders}
      canManage={canEdit}
      lockedReason={lockedReason ?? null}
      itemLabel="ルール"
      activeId={folderFilter}
      onSelect={(id) => {
        setFolderFilter(id)
        setPage(1)
      }}
      allId=""
      unfiledId={UNFILED}
      allCount={visibleLoadState === 'ready' ? rules.length : null}
      unfiledCount={visibleLoadState === 'ready' ? rules.filter(rule => !rule.folderId).length : null}
      countOf={folder => visibleLoadState === 'ready' ? rules.filter(rule => rule.folderId === folder.id).length : null}
      placeholder="例：01_営業時間外"
    />
  )

  /* ===== 数の帯 ===== */
  const kpis: Array<{
    key: string
    title: string
    icon: typeof CircleCheck
    help?: string
    helpLabel?: string
    value: number | null
    unit: string
    detail: React.ReactNode
  }> = [
    {
      key: 'active',
      title: '有効',
      icon: CircleCheck,
      value: ready ? rules.filter((r) => r.isActive).length : null,
      unit: '件',
      detail: ready
        ? `動いていない ${formatNumber(rules.filter((r) => !r.isActive).length)} 件`
        : LOAD_STATE_WORDS[visibleLoadState].label,
    },
    {
      key: 'monthly',
      title: '今月の応答',
      icon: MessageCircle,
      value: ready ? (monthlyHits === null ? null : monthlyHits) : null,
      unit: '回',
      detail: ready
        ? monthlyHits === null
          ? '実行結果を読み込めませんでした'
          : `累計 ${totalHits === null ? emptyValue('unknown') : formatNumber(totalHits)}回`
        : LOAD_STATE_WORDS[visibleLoadState].label,
    },
    {
      key: 'actions',
      title: '後続の処理',
      icon: Zap,
      help: '返したあとに動いた処理の回数',
      helpLabel: '後続の処理',
      value: ready ? (actionExecutionCount === null ? null : actionExecutionCount) : null,
      unit: '回',
      detail: ready
        ? actionExecutionCount === null
          ? '実行結果を読み込めませんでした'
          : 'タグ・シナリオ・対応マークなど'
        : LOAD_STATE_WORDS[visibleLoadState].label,
    },
    {
      key: 'conflict',
      title: '要確認',
      icon: TriangleAlert,
      help: '同じ受信に当たり得る、ほかのルールがあるもの',
      helpLabel: '要確認',
      value: ready ? (conflictCount === null ? null : conflictCount) : null,
      unit: '件',
      detail: ready
        ? conflictCount === null
          ? '重なりを確認できませんでした'
          : <span className={styles.kpiDetailBreak}>条件が重なっているルール</span>
        : LOAD_STATE_WORDS[visibleLoadState].label,
    },
  ]

  /* ===== 一覧の中身 ===== */
  const deleteTargetStale =
    pendingDelete !== null && (pendingDelete.accountId !== selectedAccountId || pendingDelete.generation !== accountScope.current.generation)
  const toggleTargetStale =
    pendingToggle !== null && (pendingToggle.accountId !== selectedAccountId || pendingToggle.generation !== accountScope.current.generation)
  const moveTargetStale = moveIds !== null && moveAccountId !== selectedAccountId

  /*
   * 見出しの6列は実表と共有する。骨組み用に書き写すと直書きの見出し
   * （`direct-th`）が二重に数えられるため、同じ要素を使い回す。
   * 選択の列だけは実表が箱（Checkbox）付き・骨組みが共通 `Th` の空見出し。
   */
  // 見出しは本文と同じ左揃え（絵どおり）。Th（.cell の左余白20）だと本文より20右へずれる。型の持ち主へ依頼済み。
  // 狭い板は回数の列だけ出さない（絵どおり。選ぶ・つまみ・操作は残す）。フォルダの列は型が畳む。
  const tableHeadCells = (
    <>
      <Th aria-label="並び替え" />
      <Th className={styles.headCell}>ルール（どんなときに動くか）</Th>
      <Th className={styles.headCell}>返すもの</Th>
      {!narrow && <Th className={styles.headCell}>今月動いた回数</Th>}
      <Th className={styles.headCell}>状態</Th>
      <Th aria-label="操作" />
    </>
  )

  const listBody = renderAutoReplyList({ allOnPageSelected, canEdit, canRunList, lockedReason, clearFilters, clearSelection, dragId, dropOn, duplicateFeedback, filterActive, folderDotOf, goEdit, items, keyboardMove, liveOrder, load, loadError, moveNotice, narrow, openMenuId, openMove, panelId, panelIndex, panelRow, requestDelete, resumableIds, router, rowContextItems, rowMenuItems, runDuplicate, runToggle, selectedAccountId, selectedCount, selectedIds, setConflictOnly, setDragId, setDuplicateError, setOpenMenuId, setPage, setPanelId, setPendingToggle: setPendingToggleFromList, setSelectedIds, setToggleError, setToggleReason, sortedItems, sortKey, stoppableIds, tableHeadCells, templateById, templateListAvailable, toggleAllOnPage, toggleFromPanel, toggleOne, visibleLoadState })

  /* ページ送りは型の pagination 枠へ（余白は型）。 */
  const listPager = ready ? (
    <ListPagePagination>
      <Pagination page={safePage} pageCount={pageCount} onPageChange={setPage}
        range={{ total: sortedItems.length, first: (safePage - 1) * pageSize + 1, last: Math.min(safePage * pageSize, sortedItems.length) }} />
    </ListPagePagination>
  ) : null

  const filterChips = (
            <div role="group" aria-label="状態で絞り込む">
            <FilterChip
              selected={stoppedOnly}
              onChange={(next) => {
                setStoppedOnly(next)
                setPage(1)
              }}
              title="無効にしてあるルール"
              icon={<Pause size={16} aria-hidden="true" />}
            >
              停止中のみ
            </FilterChip>
            <FilterChip
              selected={timedOnly}
              onChange={(next) => {
                setTimedOnly(next)
                setPage(1)
              }}
              title="曜日か時間帯を決めているルール"
              icon={<CircleHelp size={16} aria-hidden="true" />}
            >
              時間帯あり
            </FilterChip>
<FilterChip
              selected={zeroThisMonthOnly}
              onChange={(next) => {
                setZeroThisMonthOnly(next)
                setPage(1)
              }}
              title="今月1度も当たっていないルール"
              icon={<Ban size={16} aria-hidden="true" />}
            >
              今月0回
            </FilterChip>
            {conflictOnly ? (
              <FilterChip
                selected={conflictOnly}
                onChange={(next) => {
                  setConflictOnly(next)
                  setPage(1)
                }}
                title="同じ受信に当たり得る、ほかのルールがあるもの"
                icon={<Layers size={16} aria-hidden="true" />}
              >
                重なりあり
              </FilterChip>
            ) : null}
            </div>
  )
  const sortBox = (
              <div data-sort-select className={styles.sortBox}>
                <SortSelect value={sortKey} onChange={(value) => setSortKey(value as SortKey)} options={SORT_OPTIONS} label="並び：" />
              </div>
  )
  const savedBox = (
              <SaveErrorField names={["savedFilter","zeroThisMonthOnly","saved_filter","zero_this_month_only"]}><Select
                aria-label="よく使う絞り込み"
                icon={<Bookmark size={16} aria-hidden="true" />}
                value={savedFilter}
                onChange={(value) => {
                  if (value === 'toggle-zero') setZeroThisMonthOnly(!zeroThisMonthOnly)
                  else if (value === 'toggle-conflict') setConflictOnly(!conflictOnly)
                  else setSavedFilter(value)
                  setPage(1)
                }}
                options={[
                  ...SAVED_FILTER_OPTIONS,
                  { value: 'toggle-zero', label: zeroThisMonthOnly ? '今月0回の絞り込みを外す' : '今月0回で絞り込む' },
                  ...((conflictCount ?? 0) > 0 || conflictOnly ? [{ value: 'toggle-conflict', label: conflictOnly ? '重なりの絞り込みを外す' : '重なりありで絞り込む' }] : []),
                ]}
              /></SaveErrorField>
  )
  const perPageBox = (
              <div data-per-page-select>
                <SaveErrorField names={["pageSize","page_size"]}><Select
                  className="w-full"
                  aria-label="1ページに出す件数"
                  size="page-size"
                  value={String(pageSize)}
                  onChange={(value) => {
                    setPageSize(Number(value))
                    setPage(1)
                  }}
                  options={PAGE_SIZE_OPTIONS}
                /></SaveErrorField>
              </div>
  )
  const createButton = (<>

          {<CreateRuleButton
            disabled={!canEdit}
            lockedReason={lockedReason}
            menuOpen={createMenuOpen}
            onOpenMenu={(anchor) => { if (!canRunList()) return; createMenuAnchorRef.current = anchor; setCreateMenuOpen(true) }}
          />}
  </>)
  const folderSelect = (
          <SaveErrorField names={["folderFilter","folder","folder_filter"]}><Select
            narrowFolderPicker aria-label="フォルダ"
            label="フォルダ"
            value={folderFilter}
            onChange={(value) => {
              setFolderFilter(value)
              setPage(1)
            }}
            options={folderSelectOptions}
          /></SaveErrorField>
  )

  /*
   * 1152 の板：案内の帯 → 1段目「作る・フォルダ・探す … 件数」→ 2段目「札・並び・よく使う絞り込み（印だけ）」。
   * 部品は広い板と同じもの（動きは同じ）。並びと段だけを変える。
   */


  return (
    <SaveErrorScope errors={saveErrors}><ListPage heightMode="content" skeleton boardId={narrow ? 'WPrd5' : 'uE9gf'} headingSize="regular" tabs={conversationAiUiEnabled() ? <AutoReplyTabs active="keyword" /> : undefined} title={<>
        自動応答
      </>} help={<>{<>
        届いたメッセージに、決めた言葉・曜日・時間帯で自動で返します。上のルールから順に、最初に当たった1つだけが動きます。
      </>}{canEdit ? '□ で選ぶと、下に「まとめて止める・再開・フォルダへ移す」の帯が出ます。行を押すと編集。「…」に 停止・複製・実行結果・削除。' : 'ルールの内容と実行結果を確認できます。'}{'「重なり」の印は、同じ受信に先に当たるルールがあるという印（押すと重なりのあるルールだけを表示します）。'}{kpis.map((kpi) => kpi.help).filter(Boolean).join(" ")}</>}
      explanation={canEdit ? '上のルールから順に見て、最初に当たった1つだけが動きます。順番は行の左のつまみで入れ替えます。' : '上のルールから順に見て、最初に当たった1つだけが動きます。'}
      stats={<>
        {/* 見るだけの人への帯（`Q5lOCc`）。数の帯の上。 */}
        {lockedReason && (
          <div className={styles.viewerBand}><ReadOnlyNotice need="feature" role="status" data-design-node="Q5lOCc"></ReadOnlyNotice></div>
        )}
        {ready ? <Notice tone={dispatchStopped ? 'warn' : 'info'} role="status" message={dispatchStopped === true
          ? '停止中です。いま自動応答は送られません。'
          : selectedAccountId && dispatchStopped === null ? '自動応答全体の送信状態を確認できません。'
          : rules.some((rule) => rule.isActive)
          ? '確認できる自動応答に、有効なルールがあります。'
          : '確認できる自動応答に、有効なルールはありません。'} /> : null}
        {/* 数の帯 4つ。並びと間は共有の帯（KpiStrip）に任せ、画面CSSで書かない。 */}
        <KpiBand data-design="KPIs">
          {kpis.map((kpi) => (
            <KpiCard key={kpi.key} presentation="band" title={kpi.title} icon={<kpi.icon size={16} aria-hidden="true" />} value={kpi.value} unit={kpi.value == null ? '' : kpi.unit} detail={kpi.detail} detailLayout={kpi.key === 'actions' ? 'single' : undefined} action={kpi.key === 'conflict' && ready && (conflictCount ?? 0) > 0 ? { label: '重なりを見る', onClick: () => { setConflictOnly(true); setPage(1) } } : undefined} />
          ))}
        </KpiBand>
      </>}
      overlays={<>
      {/*
        骨格の印（data-design）は v7 の page.tsx 側が担う。ここへ別の節名を
        足すと、設計と画面の対を調べる design-structure の検査が
        V7＋V8 の和集合で見えてしまい、どちらの設計とも一致しなくなる。
        KPIs は V7 と同じ節名なので残す。
      */}

      {/* 止める・再開の確認窓（`i8F12`：理由つき）。単体でもまとめてでも同じ形。 */}
      <Dialog
        open={pendingToggle !== null}
        title={
          pendingToggle === null
            ? ''
            : pendingToggle.kind === 'resume'
              ? pendingToggle.ids.length === 1 && pendingToggle.names[0]
                ? `自動応答「${pendingToggle.names[0]}」を再開しますか？`
                : `${formatNumber(pendingToggle.ids.length)} 件の自動応答を再開しますか？`
              : pendingToggle.ids.length === 1 && pendingToggle.names[0]
                ? `「${pendingToggle.names[0]}」を止める`
                : `${formatNumber(pendingToggle.ids.length)} 件の自動応答を止めますか？`
        }
        description={
          pendingToggle?.kind === 'resume'
            ? 'これから届くメッセージで動き始めます。止めているあいだに届いた分は、さかのぼって動きません。あとから止め直せます。'
            : '止めているあいだ、このルールは動きません。届いたメッセージは、下のルールが代わりに見ます。いつ・誰が・なぜ止めたかが記録に残り、あとから再開できます。'
        }
        confirmLabel={pendingToggle?.kind === 'resume' ? '再開する' : '止める'}
        confirmIcon={pendingToggle?.kind === 'stop' ? <Pause size={16} aria-hidden="true" /> : undefined}
        designNode="i8F12" actionWidthReserve="idle"
        confirmation
        designLayout="stacked"
        designWidth={480}
        designTop={280}
        footerAlign="center"
        headerIcon={pendingToggle?.kind === 'resume' ? <CirclePlay /> : <Pause />}
        error={toggleError}
        onCancel={() => {
          setToggleError('')
          setToggleReason('')
          pendingToggleRef.current = null
          setPendingToggle(null)
        }}
        confirmDisabled={toggleTargetStale || !canEdit}
        confirmLockedReason={lockedReason}
        onConfirm={() => runToggle()}
      >
        <OperationTargetSummary allAccounts={pendingToggle?.allAccounts} accounts={(pendingToggle?.targetAccountIds ?? ['']).map(id => ({ id }))} />
        {pendingToggle?.kind === 'stop' && (
          <div className={styles.reasonField}>
            <Field label="止める理由" htmlFor="auto-reply-stop-reason" optional>
              <SaveErrorField names={["toggleReason","toggle_reason"]}><TextField
                id="auto-reply-stop-reason"
                value={toggleReason}
                disabled={!canEdit}
                onChange={(event) => { if (canRunList()) setToggleReason(event.target.value) }}
                maxLength={500}
                placeholder="例：キャンペーンが終わったので"
              /></SaveErrorField>
            </Field>
          </div>
        )}
        {toggleTargetStale && (
          <Notice tone="warn" role="alert">アカウントが切り替わりました。操作する自動応答を選び直してください。</Notice>
        )}
      </Dialog>

      {/*
        削除の確認窓（`u8sKN`）。
        「削除は元に戻せない」ので、残す側の「代わりに止める」を一緒に出す。
        止まっている・下書きのルールでは「代わりに止める」は出さない（押しても意味が無い）。
      */}
      <Dialog
        open={pendingDelete !== null}
        title={`「${pendingDelete ? displayName(pendingDelete.item) : ''}」を削除しますか？`}
        description="新しく届くメッセージへの自動返信と、タグ付けなどの後の処理が止まります。これまでの実行結果は消えません。"
        busy={deleting}
        error={deleteError}
        designNode="u8sKN"
        confirmation
        designLayout="stacked"
        designWidth={480}
        designTop={280}
        onCancel={() => {
          if (deleting) return
          setDeleteError('')
          setPendingDelete(null)
        }}
        footer={
          <DialogActions>
              <Button
                type="button"
                variant="secondary"
                disabled={deleting}
                onClick={() => {
                  if (deleting) return
                  setDeleteError('')
                  setPendingDelete(null)
                }}
              >
                キャンセル
              </Button>
              {pendingDelete?.item.isActive ? (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={deleting || deleteTargetStale || !canEdit}
                  lockedReason={lockedReason}
                  onClick={stopInsteadOfDelete}
                >
                  <Pause size={16} aria-hidden="true" />
                  代わりに止める
                </Button>
              ) : null}
            {/* 81: 取り消しを左、実行をいちばん右（［キャンセル］［代わりに止める］［削除する］）。 */}
            <Button
              type="button"
              variant="danger"
              disabled={deleting || deleteTargetStale || !canEdit}
              lockedReason={lockedReason}
              busy={deleting}
              busyLabel="削除中…"
              /* 絵 ：幅は「削除する」の文字で決める（結果の文字の分を控えない）。 */
              widthReserve="idle"
              onClick={() => void runDelete()}
            >
              削除する
            </Button>
          </DialogActions>
        }
      >
        {pendingDelete ? <OperationTargetSummary allAccounts={pendingDelete.item.lineAccountId === null} accounts={pendingDelete.item.lineAccountId === null ? [] : [{ id: pendingDelete.item.lineAccountId ?? '' }]} /> : null}
        <Notice tone="warn" role="alert" appearance="soft" icon={<TriangleAlert size={16} aria-hidden="true" />} message={pendingDelete?.item.isActive ? '削除は元に戻せません。しばらく使わないだけなら「止める」を使ってください。' : '削除は元に戻せません。'} />
        {deleteTargetStale && (
          <Notice tone="warn" role="alert">アカウントが切り替わりました。削除する自動応答を選び直してください。</Notice>
        )}
      </Dialog>

      {/* フォルダへ移すの窓。1件でもまとめてでも同じ形。 */}
      <ConfirmDialog
        open={moveIds !== null}
        title={
          moveIds && moveIds.length === 1
            ? `「${displayName(rules.find((r) => r.id === moveIds[0]) ?? ({} as AutoReply))}」のフォルダを移す`
            : `${moveIds?.length ?? 0} 件の自動応答をフォルダへ移す`
        }
        description="移動先のフォルダを選んでください。「未分類」を選ぶとフォルダから外れます。"
        confirmLabel="移動する"
        confirmDisabled={!canEdit || moveTargetStale}
        confirmDisabledReason={moveTargetStale ? 'アカウントが切り替わりました。いったん閉じて選び直してください。' : undefined}
        confirmLockedReason={lockedReason}
        pendingUndo={pendingMove} onSuccess={() => setMoveIds(null)} onUndone={() => setMoveIds(null)}
        busyLabel="移動中…" onConfirm={() => runMove()}
        onCancel={() => {
          setMoveIds(null)
        }}
      >
        <div className={styles.moveBody}>
          <span className={styles.moveLabel}>移動先のフォルダ</span>
          <SaveErrorField names={["moveDraft","move_draft"]}><FolderSelect
            aria-label="移動先のフォルダ"
            size="full"
            value={moveDraft}
            disabled={!canEdit || moveTargetStale || Boolean(pendingMove)}
            onChange={(value) => { if (canRunList()) setMoveDraft(value) }}
            folders={folders.map((folder) => ({ value: folder.id, label: folder.name }))}
          /></SaveErrorField>
        </div>
      </ConfirmDialog>

      {/* 複製の確認窓。コピーは停止中で作る（動かすのは別の操作）。 */}
      <></>
      {quickOpen ? (
        <QuickCreateV8
          accountId={selectedAccountId}
          onClose={() => setQuickOpen(false)}
          onCreated={() => void load()}
        />
      ) : null}
      </>}

      folders={<>
          <ActionMenu
            open={createMenuOpen}
            onClose={() => setCreateMenuOpen(false)}
            anchorRef={createMenuAnchorRef}
            align="start"
            ariaLabel="ルールの作り方"
            items={[
              { id: 'full', label: 'くわしく作る', disabled: !canEdit && !lockedReason, lockedReason, onSelect: () => { if (!canRunList()) return; setCreateMenuOpen(false); router.push('/auto-replies/edit') } },
              { id: 'quick', label: 'かんたんに作る', disabled: !canEdit && !lockedReason, lockedReason, onSelect: () => { if (!canRunList()) return; setCreateMenuOpen(false); setQuickOpen(true) } },
            ]}
          />
          {folderPanel}
        </>}
        collapsedFolders={<>{createButton}{folderSelect}</>}
        toolbar={<>
          {/* 案内の帯は表の上の主列に置く（板 uE9gf）。左のフォルダの列を押し下げないよう toolbar 枠の先頭に置き、一行を取る。 */}

          {/* 道具の段は型の toolbar 枠に渡す（中身だけ渡す）。 */}
          <ListToolbar preserveFilterChips
            search={{
              placeholder: 'ルール名・言葉で探す',
              width: 160,
              value: query,
              onChange: (value) => {
                setQuery(clampSearchQuery(value))
                setPage(1)
              },
            }}
            filters={<>
            {filterChips}
            </>}
            trailing={<>
              {/* 絵 uE9gf：「並び：評価順」（合格したリマインダ一覧と同じ並びの部品）→ 印つきの「よく使う絞り込み」→ 件数。 */}
              {sortBox}
              <ListToolbarOptional label="よく使う絞り込み">{savedBox}</ListToolbarOptional>
              {perPageBox}
            </>}
          />
        </>}

          pagination={listPager}
      >
        {actionError ? (
          <Notice tone="danger" >{actionError}<Button variant="text" size="inline" data-notice-inline-action type="button" onClick={() => { setActionError(''); void load() }}>状態を確認する</Button></Notice>
        ) : null}
        {listBody}
      </ListPage></SaveErrorScope>
  )
}
