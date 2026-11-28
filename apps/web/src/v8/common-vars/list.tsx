'use client'

import PermissionGatedButton from '@/components/shared/permission-gated-button'
import SegmentedControl from '@/components/shared/segmented'

import { openCommonVarDelete,prepareCommonVarRemoval,removeCommonVars } from './list-delete-actions'
import { renderCommonVarDialogs } from './list-dialogs'
import { CHIP_FILTER,EXPIRING_SOON_MS,ORDER_OPTIONS,PAGE_SIZE_OPTIONS,UNGROUPED,VarsChip } from './list-model'
import { renderCommonVarList } from './list-table'

import ListToolbar,{ ListToolbarFrame,ListToolbarSort } from '@/components/shared/list-toolbar'
import { useStaffRole } from '@/lib/staff-role'

import CopyTextButton from '@/components/shared/copy-text-button'
import { useListUrlValue } from '@/components/shared/list-url-state'
import { useFeatureAccess } from '@/lib/use-feature-access'
import { useSamePageUrl } from '@/lib/use-same-page-url'
import { Braces,CalendarClock,Link2,Pause,Plus,TriangleAlert } from 'lucide-react'
import { useSearchParams } from 'next/navigation'
import { Suspense,useCallback,useContext,useEffect,useMemo,useRef,useState,type SetStateAction } from 'react'
import { OverlayDepthContext } from '@/components/shared/overlay-utils'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'

import { type ActionMenuItem } from '@/components/shared/action-menu'
import { classifyApiFailure,permissionDeniedMessage } from '@/components/shared/api-error-message'
import Button from '@/components/shared/button'
import { type ContextMenuItem } from '@/components/shared/context-menu'
import { useDetailPanelUrl } from '@/components/shared/detail-panel'
import { emptyValue } from '@/components/shared/empty-value'
import { type FolderDotFolder } from '@/components/shared/folder-dot'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import ManagedFolderPanel,{ managedFolderNavRows,type ManagedFolderControl } from '@/components/shared/managed-folder-panel'
import Notice from '@/components/shared/notice'
import Pagination from '@/components/shared/pagination'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { SaveErrorField,SaveErrorScope,useSaveFormErrors } from '@/components/shared/save-form-errors'
import Select from '@/components/shared/select'
import { withViewTransition } from '@/components/shared/view-transition'
import { usePageCrumbs,usePageTitle } from '@/components/shell/page-chrome'
import { ListPage } from '@/components/templates'
import { useAccount } from '@/contexts/account-context'
import { ApiError,api,type CommonVarReplacementCandidate,type CommonVarReplacementImpact } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import { clampSearchQuery } from '@/lib/search-query'
import { useNarrowViewport } from '@/lib/use-narrow-viewport'
import type { CommonVar,CommonVarDeleteImpact,Folder } from '@line-crm/shared'
import { useVarsExportPanel } from './export-panel'
import styles from './list.module.css'
import { filterAndSortCommonVars,placeholderText,reasonRequirement,type CommonVarOrder } from './model'

function CommonVarsListInner() {
  const saveErrors = useSaveFormErrors()
  usePageTitle('共通情報')
  usePageCrumbs([{ label: 'ホーム', href: '/' }])
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const latestAccountRef = useRef(selectedAccountId)
  latestAccountRef.current = selectedAccountId
  const router = useRouter()
  const samePageUrl = useSamePageUrl()
  const params = useSearchParams()
  /* 1152 の板（）。フォルダの列は型が畳み、道具の段を2段にする。 */
  const narrow = useNarrowViewport()

  /*
   * 書き込みの口（作成・更新・削除・状態切替・フォルダ操作）は
   * `requireRole('owner', 'admin')` で閉じている。staff へ操作を見せると
   * 押しても 403 になるだけなので、閲覧のみの帯を出して押せない形にする
   * （板 ）。一覧・差し込み名のコピーは使える。CSVは管理者だけ。
   * 役割と鍵は本人APIで確かめ、答えが来るまでは変更操作を隠す。
   */
  const staffRole = useStaffRole()
  const featureAccess = useFeatureAccess('commonVars')
  const canWrite = featureAccess
  const canExport = useFeatureAccess('commonVars', 'export')

  const [items, setItems] = useState<CommonVar[]>([])
  const [folders, setFolders] = useState<Folder[]>([])
  const [unfiledCount, setUnfiledCount] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [listFailure, setListFailure] = useState<unknown>(null)
  const [folderFailure, setFolderFailure] = useState<unknown>(null)
  const [folderReloading, setFolderReloading] = useState(false)
  const [listLimited, setListLimited] = useState(false)

  const [query, setQuery] = useListUrlValue('q', '')
  const [page, setPage] = useListUrlValue('page', 1)
  const [pageSize, setPageSize] = useListUrlValue('pageSize', 20)
  const [chip, setChip] = useState<VarsChip>('all')
  const [order, setOrder] = useListUrlValue<CommonVarOrder>('order', 'usage_desc')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const [orderMenuOpen, setOrderMenuOpen] = useState(false)
  const orderAnchorRef = useRef<HTMLButtonElement | null>(null)
  const [folderMenuOpen, setFolderMenuOpen] = useState(false)
  const folderMenuAnchorRef = useRef<HTMLButtonElement | null>(null)
  /* 畳んだ板の「フォルダの操作」から、列と同じ窓（共通のフォルダの列）を開く。 */
  const folderControlRef = useRef<ManagedFolderControl | null>(null)

  /** 選んでいるフォルダ。URLに出して、戻るとブックマークを壊さない（管理画面 と同じ `?folder=`）。 */
  const folderFilter = params.get('folder') ?? ''
  const setFolderFilter = (id: string) => {
    setPage(1)
    samePageUrl.replace(id ? `/contents/vars?folder=${encodeURIComponent(id)}` : '/contents/vars')
  }

  const loadFolders = useCallback(async () => {
    const accountAtRequest = selectedAccountId
    if (!accountAtRequest) {
      setFolders([])
      setUnfiledCount(null)
      setFolderFailure(null)
      return
    }
    setFolderReloading(true)
    setFolderFailure(null)
    try {
      const folderList = await api.folders.list('common_var', accountAtRequest)
      if (accountAtRequest !== latestAccountRef.current) return
      if (folderList.success) {
        setFolders(folderList.data)
        setUnfiledCount(folderList.unfiledCount ?? null)
      } else {
        setFolderFailure(new ApiError(500, folderList.error))
      }
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught);

      if (accountAtRequest === latestAccountRef.current) { if (!fieldFailure) setFolderFailure(caught) }
    } finally {
      if (accountAtRequest === latestAccountRef.current) setFolderReloading(false)
    }
  }, [selectedAccountId, saveErrors])

  const load = useCallback(async () => {
    const accountAtRequest = selectedAccountId
    if (!accountAtRequest) {
      setItems([])
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    setListFailure(null)
    try {
      const vars = await api.commonVars.list(accountAtRequest)
      if (accountAtRequest !== latestAccountRef.current) return
      if (vars.success) {
        setItems(vars.data)
        setListLimited(vars.meta?.limited ?? false)
      } else {
        setListFailure(new ApiError(500, vars.error))
        setError('読み込みに失敗しました。接続を確かめて、もう一度お試しください。')
      }
    } catch (e) {
      const fieldFailure = saveErrors.capture(e);

      if (accountAtRequest === latestAccountRef.current) {
        { if (!fieldFailure)
        setListFailure(e) }
        { if (!fieldFailure)

        setError(e instanceof ApiError && e.status === 403
          ? permissionDeniedMessage('store')
          : '読み込みに失敗しました。接続を確かめて、もう一度お試しください。')
      }
    }
    } finally {
      if (accountAtRequest === latestAccountRef.current) setLoading(false)
    }
  }, [selectedAccountId, saveErrors])

  useEffect(() => {
    if (accountLoading) return
    void load()
    void loadFolders()
  }, [accountLoading, load, loadFolders])

  useEffect(() => {
    setSelected(new Set())
    setListLimited(false)
  }, [selectedAccountId])

  const baseFiltered = useMemo(
    () => filterAndSortCommonVars(items, {
      query,
      folderId: folderFilter,
      ungroupedValue: UNGROUPED,
      filter: CHIP_FILTER[chip],
      order,
    }),
    [folderFilter, items, order, query, chip],
  )
  /*
   * 「下書き・止めた」は1枚の札にまとめる。絞り込みの共有関数に
   * 触らず、この画面だけで下書きと止めたの和を取る（管理画面 の動きは変えない）。
   */
  const filtered = useMemo(
    () => chip === 'draftStopped'
      ? baseFiltered.filter((item) => (item.state ?? 'active') === 'draft' || (item.state ?? 'active') === 'stopped')
      : baseFiltered,
    [baseFiltered, chip],
  )

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const current = useMemo(
    () => filtered.slice((page - 1) * pageSize, page * pageSize),
    [filtered, page, pageSize],
  )

  useEffect(() => {
    if (page > pageCount) setPage(pageCount)
  }, [page, pageCount])

  /** 数の帯と黄色の帯の素。取れていない数字は 0 にしない。 */
  const listFailed = listFailure != null
  const stats = useMemo(() => {
    const usageCounts = items.map((item) => item.usageCount)
    const knownUsage = usageCounts.filter((count): count is number => typeof count === 'number')
    return {
      total: items.length,
      draftCount: items.filter((item) => (item.state ?? 'active') === 'draft').length,
      stoppedCount: items.filter((item) => (item.state ?? 'active') === 'stopped').length,
      expiredCount: items.filter((item) => (item.state ?? 'active') === 'expired').length,
      usageTotal: knownUsage.length === 0 && items.length > 0 ? null : knownUsage.reduce((sum, count) => sum + count, 0),
      emptyInUse: items.filter((item) => item.value === '' && typeof item.usageCount === 'number' && item.usageCount > 0),
      expiringSoon: items.filter((item) => {
        if (!item.validUntil || (item.state ?? 'active') === 'expired') return false
        const until = new Date(item.validUntil).getTime()
        if (Number.isNaN(until)) return false
        const rest = until - Date.now()
        return rest > 0 && rest <= EXPIRING_SOON_MS
      }).length,
    }
  }, [items])

  const clearVarFilters = () => {
    setQuery('')
    setFolderFilter('')
    setChip('all')
    setPage(1)
  }

  const applyEmptyFilter = () => {
    setChip('empty')
    setPage(1)
  }



  /*
   * 止める窓（板 ）。止めているあいだ、この共通情報を差し込んだ
   * 配信は送られない。あとで再開できる。理由は記録に残すので必須。
   */
  const [statusTarget, setStatusTarget] = useState<CommonVar | null>(null)
  const [statusAction, setStatusAction] = useState<'stop' | 'resume'>('stop')
  const [statusReason, setStatusReason] = useState('')
  const [statusBusy, setStatusBusy] = useState(false)
  const [statusError, setStatusError] = useState('')
  const statusWindow = useRef<object>({})
  const statusAccount = useRef(selectedAccountId)
  if (statusAccount.current !== selectedAccountId) statusWindow.current = {}
  statusAccount.current = selectedAccountId
  const renderedStatusWindow = statusWindow.current
  /* 右から出る詳細パネル。URL に今の行を残す（`?row=`）。 */
  const [nameDirty, setNameDirty] = useState(false)
  const [nameSaving, setNameSaving] = useState(false)
  const [nameReset, setNameReset] = useState(0)
  const holdDetail = useRef(false)
  const guardRef = useRef<ReturnType<typeof useUnsavedGuard> | null>(null)
  const protect = useCallback((action: () => void) => { if (guardRef.current) guardRef.current.guarded(action); else action() }, [])
  const [activeId, setActiveIdRaw] = useDetailPanelUrl('row', () => holdDetail.current)
  const setActiveId = useCallback((next: SetStateAction<string | null>) => protect(() => setActiveIdRaw(next)), [protect, setActiveIdRaw])
  /* パネルを開いている1件の止める・再開は、窓ではなくパネルの中で聞く。 */
  const [panelStatus, setPanelStatus] = useState(false)
  /* 右クリックされた行（「…」と同じ項目を出す）。 */
  const [contextId, setContextId] = useState<string | null>(null)
  /* 板 ：予約中の配信があるときだけ出す帯。読めなくても止める操作は止めない。 */
  const [statusScheduled, setStatusScheduled] = useState<CommonVarDeleteImpact['items']>([])

  const openStatusDialog = (item: CommonVar, action: 'stop' | 'resume') => {
    statusWindow.current = {}
    setPanelStatus(item.id === activeId)
    setStatusTarget(item)
    setStatusAction(action)
    setStatusReason('')
    setStatusError('')
    setStatusScheduled([])
    if (action === 'stop' && selectedAccountId) {
      const varId = item.id
      const accountId = selectedAccountId
      void api.commonVars.deleteImpact(varId, accountId)
        .then((res) => {
          if (!res.success) return
          setStatusScheduled(res.data.items.filter((usage) => usage.status === '配信予約中'))
        })
        .catch(() => {
          /* 読めないときは帯を出さない。 */
        })
    }
  }

  const closeStatusDialog = () => {
    if (statusBusy) return
    statusWindow.current = {}
    setStatusTarget(null)
    setStatusReason('')
    setStatusError('')
  }

  useEffect(() => { setStatusTarget(null); setPanelStatus(false); setStatusBusy(false); return () => { statusWindow.current = {} } }, [selectedAccountId])

  const applyStatus = async () => {
    if (!statusTarget || !selectedAccountId || statusTarget.lineAccountId !== selectedAccountId || latestAccountRef.current !== selectedAccountId || statusWindow.current !== renderedStatusWindow || statusBusy) return
    const reason = statusReason.trim()
    if (reasonRequirement.check(reason)) {
      setStatusError(statusAction === 'stop' ? '止める理由を入力してください' : '再開する理由を入力してください')
      return
    }
    setStatusBusy(true)
    setStatusError('')
    try {
      const res = await api.commonVars.setStatus(statusTarget.id, selectedAccountId, {
        to: statusAction === 'stop' ? 'stopped' : 'active',
        changeReason: reason,
      })
      if (statusWindow.current !== renderedStatusWindow || latestAccountRef.current !== selectedAccountId) return
      if (!res.success) {
        setStatusError(res.error)
        return
      }
      setStatusBusy(false); statusWindow.current = {}; setStatusTarget(null)
      setPanelStatus(false)
      setStatusReason('')
      await load()
    } catch (e) {
      if (statusWindow.current !== renderedStatusWindow || latestAccountRef.current !== selectedAccountId) return
      const fieldFailure = saveErrors.capture(e)

      { if (!fieldFailure)
      setStatusError(
        e instanceof ApiError && e.status === 409
          ? '別の担当者が先に更新しました。最新内容を読み直してください。'
          : '状態を変えられませんでした。通信を確かめて、もう一度お試しください。',
      ) }
    } finally {
      if (statusWindow.current === renderedStatusWindow && latestAccountRef.current === selectedAccountId) setStatusBusy(false)
    }
  }

  /*
   * 削除の窓（板 ）。**窓を開けてから使用先を読む。**
   * 一覧を出すたびに全件ぶん読むと、消さない人にも使用先の走査が走る。
   * 使われているものは「まだ消せません」と言い、差し替えか止めるへ導く。
   * 差し替え・削除・止めるのどれにも理由が要る（版履歴に残すため）。
   */
  const [deleteTarget, setDeleteTarget] = useState<CommonVar | null>(null)
  const [deleteImpact, setDeleteImpact] = useState<CommonVarDeleteImpact | null>(null)
  const [deletePhase, setDeletePhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [deleteChoice, setDeleteChoice] = useState<'replace' | 'stop'>('replace')
  const [replacementCandidates, setReplacementCandidates] = useState<CommonVarReplacementCandidate[]>([])
  const [replacementId, setReplacementId] = useState('')
  const [replacementImpact, setReplacementImpact] = useState<CommonVarReplacementImpact | null>(null)
  const [replacementPhase, setReplacementPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  /** 消した理由・止める理由。差し替え・削除・止めるのどれにも必須。 */
  const [deleteReason, setDeleteReason] = useState('')
  /** 削除の確認のために打ってもらう差し込みキー。 */
  const [typedKey, setTypedKey] = useState('')
  /** 使用先が多いときは畳む（板  の「ほか 5か所・すべて見る」）。 */
  const [usageExpanded, setUsageExpanded] = useState(false)
  const deleteRequestRef = useRef({ accountId: selectedAccountId, itemId: null as string | null, generation: 0 })
  const deleteWindow = useRef<object>({})
  const deleteWindowAccount = useRef(selectedAccountId)
  if (deleteWindowAccount.current !== selectedAccountId) deleteWindow.current = {}
  deleteWindowAccount.current = selectedAccountId
  const renderedDeleteWindow = deleteWindow.current

  const openDelete = (item: CommonVar) => { deleteWindow.current = {}; return openCommonVarDelete({ deleteRequestRef, saveErrors, selectedAccountId, setDeleteChoice, setDeleteError, setDeleteImpact, setDeletePhase, setDeleteReason, setDeleteTarget, setReplacementCandidates, setReplacementId, setReplacementImpact, setReplacementPhase, setTypedKey, setUsageExpanded }, item) }

  const selectReplacement = async (nextId: string) => {
    if (!deleteTarget || !selectedAccountId)

 return
    setReplacementId(nextId)
    setReplacementImpact(null)
    if (!nextId) {
      setReplacementPhase('ready')
      return
    }
    const request = {
      accountId: selectedAccountId,
      itemId: deleteTarget.id,
      generation: deleteRequestRef.current.generation + 1,
    }
    deleteRequestRef.current = request
    setReplacementPhase('loading')
    try {
      const res = await api.commonVars.replacementImpact(request.itemId, request.accountId, nextId)
      if (deleteRequestRef.current.generation !== request.generation) return
      if (!res.success) throw new Error('replacement_impact_failed')
      setReplacementImpact(res.data)
      setReplacementPhase('ready')
    } catch (saveFailure) {
      saveErrors.capture(saveFailure);

      if (deleteRequestRef.current.generation === request.generation) setReplacementPhase('error')
    }
  }

  /** 窓の中身を空にする。処理中は `closeDelete` が止めるので、成功時はこっちを使う。 */
  const resetDeleteState = () => {
    deleteWindow.current = {}
    deleteRequestRef.current = {
      accountId: selectedAccountId,
      itemId: null,
      generation: deleteRequestRef.current.generation + 1,
    }
    setDeleteTarget(null)
    setDeleteImpact(null)
    setDeletePhase('idle')
    setDeleteError('')
    setTypedKey('')
    setDeleteReason('')
    setDeleteChoice('replace')
    setUsageExpanded(false)
    setReplacementCandidates([])
    setReplacementId('')
    setReplacementImpact(null)
    setReplacementPhase('idle')
    setDeleteBusy(false)
  }

  const closeDelete = () => {
    if (deleteBusy) return
    resetDeleteState()
  }

  useEffect(() => { resetDeleteState(); return () => { deleteWindow.current = {} } }, [selectedAccountId])

  const confirmReplacement = async () => {
    if (!deleteTarget || !selectedAccountId || deleteWindow.current !== renderedDeleteWindow || deleteTarget.lineAccountId !== selectedAccountId || latestAccountRef.current !== selectedAccountId || !replacementImpact?.canReplace || deleteBusy) return
    if (reasonRequirement.check(deleteReason)) {
      setDeleteError('消した理由を入力してください。')
      return
    }
    const request = {
      accountId: selectedAccountId,
      itemId: deleteTarget.id,
      generation: deleteRequestRef.current.generation + 1,
    }
    deleteRequestRef.current = request
    setDeleteBusy(true)
    setDeleteError('')
    try {
      const res = await api.commonVars.replace(request.itemId, request.accountId, {
        replacementId: replacementImpact.replacement.id,
        expectedVersion: replacementImpact.source.version,
        expectedRevision: replacementImpact.revision,
        changeReason: deleteReason.trim(),
      })
      if (deleteRequestRef.current.generation !== request.generation) return
      if (!res.success) throw new Error('replace_failed')
      resetDeleteState()
      await load()
    } catch (caught) {
      if (deleteRequestRef.current.generation !== request.generation) return
      const fieldFailure = saveErrors.capture(caught);

      if (caught instanceof ApiError && caught.status === 409) {
        { if (!fieldFailure)
        setDeleteError('使用先が変わりました。影響をもう一度確認してください。') }
        await selectReplacement(replacementImpact.replacement.id)
      } else {
        { if (!fieldFailure)
        setDeleteError('差し替えを完了できませんでした。状態を読み直して、もう一度お試しください。') }
      }
    } finally {
      if (deleteRequestRef.current.generation === request.generation) setDeleteBusy(false)
    }
  }

  const confirmDirectDelete = async () => {
    if (!deleteTarget || !selectedAccountId || deleteWindow.current !== renderedDeleteWindow || deleteTarget.lineAccountId !== selectedAccountId || latestAccountRef.current !== selectedAccountId || deleteBusy) return
    const request = {
      accountId: selectedAccountId,
      itemId: deleteTarget.id,
      generation: deleteRequestRef.current.generation + 1,
    }
    deleteRequestRef.current = request
    const isCurrentRequest = () =>
      deleteRequestRef.current.accountId === request.accountId &&
      deleteRequestRef.current.itemId === request.itemId &&
      deleteRequestRef.current.generation === request.generation
    setDeleteBusy(true)
    setDeleteError('')
    try {
      const res = await api.commonVars.delete(request.itemId, request.accountId, deleteReason.trim())
      if (!isCurrentRequest()) return
      if (!res.success) throw new Error('delete_failed')
      resetDeleteState()
      await load()
    } catch (e) {
      if (!isCurrentRequest()) return
      const fieldFailure = saveErrors.capture(e);

      if (e instanceof ApiError && e.status === 409) {
        { if (!fieldFailure)
        setDeleteError('いま使われ始めたため、削除できませんでした。使用先を読み直しました。') }
        try {
          const again = await api.commonVars.deleteImpact(request.itemId, request.accountId)
          if (!isCurrentRequest()) return
          if (again.success) setDeleteImpact(again.data)
        } catch (saveFailure) {
          saveErrors.capture(saveFailure);

          if (isCurrentRequest()) setDeletePhase('error')
        }
        return
      }
      { if (!fieldFailure)
      setDeleteError('削除できませんでした。状態を読み直してから、もう一度お試しください。') }
    } finally {
      if (isCurrentRequest()) setDeleteBusy(false)
    }
  }

  /** 「消さずに止める」を選んだとき。理由を止める理由として使う。 */
  const confirmStopInstead = async () => {
    if (!deleteTarget || !selectedAccountId || deleteWindow.current !== renderedDeleteWindow || deleteTarget.lineAccountId !== selectedAccountId || latestAccountRef.current !== selectedAccountId || deleteBusy) return
    if (reasonRequirement.check(deleteReason)) {
      setDeleteError('止める理由を入力してください。')
      return
    }
    setDeleteBusy(true)
    setDeleteError('')
    try {
      const res = await api.commonVars.setStatus(deleteTarget.id, selectedAccountId, {
        to: 'stopped',
        changeReason: deleteReason.trim(),
      })
      if (!res.success) {
        setDeleteError(res.error)
        return
      }
      resetDeleteState()
      await load()
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setDeleteError('止められませんでした。通信を確かめて、もう一度お試しください。') }
    } finally {
      setDeleteBusy(false)
    }
  }

  /*
   * まとめて削除。使う前に使用先を確かめ、使われているものが混ざって
   * いたら止める（管理画面 と同じ守り）。理由は版履歴に残すので必須。
   */
  const [deleteTargets, setDeleteTargets] = useState<CommonVar[]>([])
  const [batchReason, setBatchReason] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [deleteBatchError, setDeleteBatchError] = useState('')
  const batchRequestRef = useRef({ accountId: selectedAccountId, generation: 0 })
  const renderedBatchGeneration = batchRequestRef.current.generation
  useEffect(() => {
    batchRequestRef.current = { accountId: selectedAccountId, generation: batchRequestRef.current.generation + 1 }
    setDeleteTargets([]); setDeleting(false); setBatchReason(''); setDeleteBatchError('')
    return () => { batchRequestRef.current.generation += 1 }
  }, [selectedAccountId])

  const hasChanges = nameDirty || Boolean(statusTarget && statusReason) || Boolean(deleteTarget && deleteReason) || Boolean(deleteTargets.length && batchReason)
  const savingChanges = nameSaving || statusBusy || deleteBusy || deleting
  holdDetail.current = hasChanges || savingChanges
  const depth = useContext(OverlayDepthContext)
  const guard = useUnsavedGuard({ dirty: hasChanges || savingChanges, busy: savingChanges, onDiscard: () => {
    holdDetail.current = false
    setNameDirty(false); setNameReset(value => value + 1)
    if (statusTarget) closeStatusDialog()
    if (deleteTarget) resetDeleteState()
    if (deleteTargets.length) {
      batchRequestRef.current = { accountId: selectedAccountId, generation: batchRequestRef.current.generation + 1 }
      setDeleteTargets([]); setBatchReason(''); setDeleteBatchError('')
    }
  } })
  guardRef.current = guard

  /* 行の「…」の中身。右クリックでも同じものを出す。 */
  const rowMenuItems = (item: CommonVar): ActionMenuItem[] => {
    const stopped = (item.status ?? 'active') === 'stopped'
    const copyKey: ActionMenuItem = {
      id: 'copy-key',
      label: '差し込みキーをコピー',
      content: <CopyTextButton role="menuitem" value={placeholderText(item.varKey)} label="差し込みキーをコピー" aria-label={`${item.name}の差し込みキーをコピー`} />,
    }
    // 閲覧のみでもコピーは使える。変更の項目は隠す。
    if (!canWrite) return [copyKey]
    return [
      copyKey,
      {
        id: 'edit',
        label: '編集',
        onSelect: () => protect(() => withViewTransition(() => router.push(`/contents/vars/edit?id=${item.id}`))),
      },
      stopped ? {
        id: 'resume',
        label: '再開する',
        onSelect: () => protect(() => openStatusDialog(item, 'resume')),
      } : {
        id: 'stop',
        label: '止める',
        icon: <Pause size={16} aria-hidden="true" />,
        onSelect: () => protect(() => openStatusDialog(item, 'stop')),
      },
      {
        id: 'delete',
        label: '削除する',
        tone: 'danger',
        dividerBefore: true,
        onSelect: () => protect(() => { void openDelete(item) }),
      },
    ]
  }

  /* 右から出る詳細パネルの今の行。 */
  const activeItem = activeId ? (items.find((v) => v.id === activeId) ?? null) : null
  const activeIndex = activeItem ? current.findIndex((v) => v.id === activeItem.id) : -1
  const activeStopped = (activeItem?.status ?? 'active') === 'stopped'

  /* 名前のその場の書き換え。Enter で保存・Esc でやめる。 */
  const renameVar = async (item: CommonVar, next: string) => {
    const accountId = selectedAccountId
    if (!accountId) return
    const name = next.trim()
    if (!name || name === item.name) return
    const res = await api.commonVars.update(item.id, accountId, { name })
    if (!res.success) throw new Error(res.error ?? 'rename_failed')
    setItems((rows) => rows.map((v) => (v.id === item.id ? { ...v, name } : v)))
  }

  /* 右クリックは「…」と同じ項目。消す操作は赤くする。 */
  const contextItem = contextId ? (items.find((v) => v.id === contextId) ?? null) : null
  const contextMenuItems: ContextMenuItem[] = contextItem
    ? rowMenuItems(contextItem).map((entry) => ({
      id: entry.id,
      label: entry.label,
      danger: entry.tone === 'danger',
      disabled: entry.disabled,
      onSelect: () => entry.onSelect?.(),
    }))
    : []

  const prepareRemoveSelected = () => prepareCommonVarRemoval({ batchRequestRef, items, saveErrors, selected, selectedAccountId, setBatchReason, setDeleteBatchError, setDeleteTargets, setError })

  const removeSelected = () => {
    if (!selectedAccountId || latestAccountRef.current !== selectedAccountId || batchRequestRef.current.generation !== renderedBatchGeneration || batchRequestRef.current.accountId !== selectedAccountId || deleteTargets.some(item => item.lineAccountId !== selectedAccountId)) return Promise.resolve()
    return removeCommonVars({ batchReason, batchRequestRef, deleteTargets, deleting, load, saveErrors, selectedAccountId, setBatchReason, setDeleteBatchError, setDeleteTargets, setDeleting, setSelected })
  }

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const allOnPageSelected = current.length > 0 && current.every((item) => selected.has(item.id))
  const someOnPageSelected = current.some((item) => selected.has(item.id))

  /* ===== フォルダの列 ===== */
  const folderForbidden = folderFailure != null && classifyApiFailure(folderFailure) === 'forbidden'
  const folderFailureNote = folderFailure ? (
    <Notice tone="danger" action={<> {folderForbidden ? null : (
        <Button type="button" onClick={() => void loadFolders()} disabled={folderReloading}>
          {folderReloading ? '読み込んでいます' : 'もう一度読み込む'}
        </Button>
      )} </>} >{folderForbidden
          ? permissionDeniedMessage('store')
          : 'フォルダを読み込めませんでした。登録した共通情報は消えていません。'}</Notice>
  ) : null

  /* 行の名前の前の丸は、左のフォルダの列と同じフォルダ（同じ色）を引く。未分類は色の無い輪。 */
  const folderDotOf = (row: { folderId: string | null }): FolderDotFolder | null => {
    if (!row.folderId) return null
    const folder = folders.find((f) => f.id === row.folderId)
    return folder ? { name: folder.name, color: folder.color } : null
  }
  /* 並びは絵どおり：すべて → 作ったフォルダ → 未分類（最後）。 */
  const selectedUserFolder = folders.find((folder) => folder.id === folderFilter) ?? null
  const folderRows = managedFolderNavRows('common_var', folders, { allId: '', unfiledId: UNGROUPED }).map(row => ({ ...row,
    leadingActions: canWrite && selectedUserFolder?.id === row.id ? [
      { id: 'edit-folder', label: 'フォルダ名を変更する', onSelect: () => folderControlRef.current?.startEdit(selectedUserFolder) },
      { id: 'delete-folder', label: 'フォルダを削除する', tone: 'danger' as const, onSelect: () => folderControlRef.current?.startDelete(selectedUserFolder) },
    ] : [],
  }))
  const folderOptions = [
    { value: '', label: 'フォルダ：すべて' },
    ...folders.map((folder) => ({ value: folder.id, label: folder.name })),
    { value: UNGROUPED, label: '未分類' },
  ]

  const createButton = (full: boolean) => (
    <PermissionGatedButton allowed={canWrite} href="/contents/vars/new" variant="primary" className={full ? 'v8-folder-create w-full' : undefined}>
      <Plus size={16} aria-hidden="true" />共通情報を作る
    </PermissionGatedButton>
  )

  const folderPanel = (
    /* 共通のフォルダの列（種類 common_var・）。名前・色・並べ替え・消すは「…」から。消すと中身は未分類へ移るので一覧も読み直す。 */
    <ManagedFolderPanel
      kind="common_var"
      accountId={selectedAccountId}
      folders={folders}
      onChanged={() => Promise.all([load(), loadFolders()]).then(() => undefined)}
      canManage={canWrite && Boolean(selectedAccountId)}
      itemLabel="共通情報"
      activeId={folderFilter}
      onSelect={setFolderFilter}
      allId=""
      unfiledId={UNGROUPED}
      allCount={listFailed ? null : items.length}
      unfiledCount={unfiledCount}
      placeholder="例：01_店舗案内"
      controlRef={folderControlRef}
    >
      {folderFailureNote}
    </ManagedFolderPanel>
  )

  /* ===== 道具の段（広い板と 1152 で同じ部品を並べ替える） ===== */
  const onSearch = (value: string) => {
    setQuery(clampSearchQuery(value))
    setPage(1)
  }
  const showExpiredChip = chip === 'expired' || stats.expiredCount > 0
  const filterChips = (
    <SegmentedControl<VarsChip> aria-label="状態で絞り込む" fit="content" value={chip} onClear={() => { setChip('all'); setPage(1) }} onChange={(value) => { setChip(value); setPage(1) }} options={[
      { value: 'all', label: 'すべて' },
      { value: 'empty', label: '空のまま', title: '中身が空のもの' },
      { value: 'scheduled', label: '期限つき', title: '有効期間か、決めた日の切り替えがあるもの' },
      { value: 'unused', label: '使われていない', title: 'どこにも差し込まれていないもの' },
      { value: 'draftStopped', label: '下書き・止めた', title: '下書きと、止めているもの' },
      ...(showExpiredChip ? [{ value: 'expired' as const, label: '期限切れ', title: '期限が切れたもの' }] : []),
    ]} />
  )
  /* 並び替え：絵に無いが今の機能。場所を取らないよう印だけのボタン＋メニュー。 */
  const orderLabel = ORDER_OPTIONS.find((option) => option.value === order)?.label ?? ''
  const orderBox = <ListToolbarSort value={order} onChange={(value) => { setOrder(value as typeof order); setPage(1) }} options={ORDER_OPTIONS} />
  const perPageBox = (
    <div className={styles.perPageBox}>
      <SaveErrorField names={["pageSize","page_size"]}><Select
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

  /*
   * 1152 の板（）：1段目「作る・フォルダ・探す … 件数」、2段目「札」。
   * フォルダの追加・名前変更・削除は、縦の列が無いぶん、フォルダの印のメニューから。
   */

  const wideToolbar = (
    <ListToolbarFrame>
      <ListToolbar
        search={{
          placeholder: '名前・差し込み名・中身',
          label: '共通情報を検索',
          value: query,
          onChange: onSearch,
        }}
        filters={filterChips}
        trailing={<>{orderBox}{perPageBox}</>}
      />
    </ListToolbarFrame>
  )

  /* 空のまま使われているときの黄色の帯（絵：表の列の上・道具の段の上）。 */
  const firstEmpty = stats.emptyInUse[0] ?? null
  const alerts = (
    <>
      {firstEmpty && !listFailed ? (
        <Notice tone="warn" role="status" icon={<TriangleAlert size={16} aria-hidden="true" />} action={<>
          <Button type="button" actionWording onClick={applyEmptyFilter}>{canWrite ? "直す" : "空のままを見る"}</Button>
        </>}>
          <span className={styles.alertText}>
            {`「${firstEmpty.name}」が空のまま ${typeof firstEmpty.usageCount === 'number' ? `${formatNumber(firstEmpty.usageCount)}か所` : '何か所か'}で使われています。差し込んだところが空欄のまま送られます。`}
          </span>
        </Notice>
      ) : null}
      {listLimited && !listFailed ? (
        <Notice tone="warn" role="status" icon={<TriangleAlert size={16} aria-hidden="true" />}>
          <span className={styles.alertText}>表示は最初の200件までです。フォルダや検索で絞り込んでください。</span>
        </Notice>
      ) : null}
      {error && !listFailed ? (
        <Notice tone="danger" onClose={() => setError('')}>{error}</Notice>
      ) : null}
    </>
  )
  const hasAlerts = Boolean((firstEmpty && !listFailed) || (listLimited && !listFailed) || (error && !listFailed))

  /* ===== 一覧の中身（読込中・読み込めない・空・0件を分ける。状態の板 ） ===== */
  const listBody = renderCommonVarList({ accountLoading, activeId, allOnPageSelected, canWrite, clearVarFilters, contextItem, contextMenuItems, current, error, filtered, folderDotOf, items, listFailed, listFailure, load, loading, narrow, openMenuId, prepareRemoveSelected, rowMenuItems, selected, selectedAccountId, setActiveId, setContextId, setOpenMenuId, setSelected, someOnPageSelected, toggle })

  const listPager = listFailed || !selectedAccountId || filtered.length === 0 ? null : (
    <Pagination page={page} pageCount={pageCount} onPageChange={setPage} range={{ total: filtered.length, first: (page - 1) * pageSize + 1, last: Math.min(page * pageSize, filtered.length) }} />
  )

  /* 数の帯。取れていない数字は「—」（0 とは言わない）。 */
  const kpis = [
    {
      key: 'total',
      title: '共通情報',
      icon: Braces,
      value: listFailed ? null : stats.total,
      unit: '件',
      detail: `下書き ${listFailed ? emptyValue('unknown') : stats.draftCount}・止めた ${listFailed ? emptyValue('unknown') : stats.stoppedCount}`,
    },
    {
      key: 'usage',
      title: '使っている所',
      icon: Link2,
      value: listFailed ? null : stats.usageTotal,
      unit: 'か所',
      detail: 'テンプレート・配信など',
    },
    {
      key: 'empty',
      title: '空のまま使われている',
      icon: TriangleAlert,
      value: listFailed ? null : stats.emptyInUse.length,
      unit: '件',
      detail: '空欄のまま送られます',
      fix: !listFailed && stats.emptyInUse.length > 0,
    },
    {
      key: 'expiring',
      title: '期限が近い',
      icon: CalendarClock,
      value: listFailed ? null : stats.expiringSoon,
      unit: '件',
      detail: '7日以内に期限切れ',
    },
  ]

  const exportPanel = useVarsExportPanel({
    accountId: canExport ? selectedAccountId : null,
    folderId: folderFilter && folderFilter !== UNGROUPED ? folderFilter : null,
    ungrouped: folderFilter === UNGROUPED,
  })

  const overlays = <>{renderCommonVarDialogs({ activeIndex, activeItem, activeStopped, applyStatus, batchReason, batchRequestRef, canWrite, closeDelete, closeStatusDialog, confirmDirectDelete, confirmReplacement, confirmStopInstead, current, deleteBatchError, deleteBusy, deleteChoice, deleteError, deleteImpact, deletePhase, deleteReason, deleteTarget, deleteTargets, deleting, folderDotOf, items, openDelete, openStatusDialog, panelStatus, removeSelected, renameVar, replacementCandidates, replacementId, replacementImpact, replacementPhase, router, selectedAccountId, selectReplacement, setActiveId, setBatchReason, setDeleteBatchError, setDeleteChoice, setDeleteReason, setDeleteTargets, setPanelStatus, setStatusError, setStatusReason, setTypedKey, setUsageExpanded, statusAction, statusBusy, statusError, statusReason, statusScheduled, statusTarget, typedKey, usageExpanded, nameSaving, nameReset, setNameDirty, setNameSaving, protect })}<OverlayDepthContext.Provider value={depth + 2}><UnsavedLeaveDialog open={guard.leaveTarget !== null} busy={savingChanges} onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} /></OverlayDepthContext.Provider></>

  return (
    <SaveErrorScope errors={saveErrors}><ListPage
      skeleton
      boardId={narrow ? 'XIzkJ' : canWrite ? 'FM94M' : 'OxSw8'}
      headingSize="regular"
      title="共通情報"
      help="会社名・営業時間・電話番号など、何度も使う文字をここで持ち、テンプレートや配信に差し込みます。ここを変えると、差し込んだ所がまとめて変わります。"
      actions={canExport ? exportPanel.action : null}
      tabs={canWrite ? undefined : (
        /* 閲覧のみの帯（）。数の帯の上。 */
        <div className={styles.viewerBand}><ReadOnlyNotice role="status"></ReadOnlyNotice></div>
      )}
      stats={
        <KpiBand data-design="KPIs" aria-label="共通情報の集計">
          {kpis.map((kpi) => (
            <KpiCard
              key={kpi.key}
              presentation="band"
              title={kpi.title}
              icon={<kpi.icon size={16} aria-hidden="true" />}
              value={kpi.value}
              unit={kpi.value == null ? '' : kpi.unit}
              detail={kpi.detail}
              action={kpi.fix ? { label: canWrite ? '直す' : '空のままを見る', onClick: applyEmptyFilter } : undefined}
            />
          ))}
        </KpiBand>
      }
      /* 1281〜1339 の幅は板が狭いのに 1152 用の道具の段にならない。そこだけ型が作る・フォルダを出す。 */
      folderNav={{ rows: folderRows, activeId: folderFilter, onSelect: setFolderFilter, createAction: createButton(false) }}
      folders={<>{createButton(true) ?? <span className={styles.viewerCreateSpace} aria-hidden="true" />}{folderPanel}</>}
      toolbar={<>
        {hasAlerts || (canExport && exportPanel.status) ? <div className={styles.alertSlot}>{canExport ? exportPanel.status : null}{alerts}</div> : null}
        {wideToolbar}
      </>}
      pagination={listPager}
      overlays={overlays}
    >
      {listBody}
    </ListPage></SaveErrorScope>
  )
}

export default function CommonVarsListV8() {
  return (
    <Suspense fallback={<div className={styles.suspense}>読み込み中…</div>}>
      <CommonVarsListInner />
    </Suspense>
  )
}
