'use client'

import PermissionGatedButton from '@/components/shared/permission-gated-button'

import { renderFormDialogs } from './list-dialogs'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { OverlayDepthContext } from '@/components/shared/overlay-utils'
import { VIEWER_NOTE } from './list-helpers'
import { loadFormsPage } from './list-load'

import CopyTextButton from '@/components/shared/copy-text-button'
import { useInlineDetailGuard } from '@/components/shared/use-inline-detail-guard'
import ListToolbar,{ ListToolbarFrame,ListToolbarSort } from '@/components/shared/list-toolbar'
import { useListScrollMemory,useListUrlValue } from '@/components/shared/list-url-state'
import { pageSizeOptions } from '@/components/shared/page-size-options'
import { useFeatureAccess } from '@/lib/use-feature-access'
import { useSamePageUrl } from '@/lib/use-same-page-url'
import { CircleCheck,ClipboardList,Inbox,Percent,Plus,TriangleAlert } from 'lucide-react'
import { useSearchParams } from 'next/navigation'
import { useCallback,useContext,useEffect,useMemo,useRef,useState,type MouseEvent as ReactMouseEvent,type ReactNode } from 'react'

import Link from '@/components/shared/list-navigation'
import { RowNameLink,StatusCell } from '@/components/shared/table'

import { type ActionMenuItem } from '@/components/shared/action-menu'
import { loadFailureCopy } from '@/components/shared/api-error-message'
import Button from '@/components/shared/button'
import ContextMenu,{ type ContextMenuItem } from '@/components/shared/context-menu'
import EmptyList from '@/components/shared/empty-list'
import { emptyValue } from '@/components/shared/empty-value'
import SegmentedControl from '@/components/shared/segmented'
import FolderPanel,{ FolderPanelNote,type FolderPanelRow } from '@/components/shared/folder-panel'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import Pagination from '@/components/shared/pagination'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { RowMenu } from '@/components/shared/row-actions'
import { SaveErrorField,SaveErrorScope,useSaveFormErrors } from '@/components/shared/save-form-errors'
import Select from '@/components/shared/select'
import { DelayedSkeleton,Skeleton } from '@/components/shared/skeleton'
import StatusBadge from '@/components/shared/status-badge'
import { DataTable,NameCell,TableHeadRow,Td,Th,Tr } from '@/components/shared/table'
import { notifyToast } from '@/components/shared/toast'
import TruncatedText from '@/components/shared/truncated-text'
import { insertDuplicateAfter,useDuplicateFeedback } from '@/components/shared/use-duplicate-feedback'
import { withViewTransition } from '@/components/shared/view-transition'
import { usePageCrumbs,usePageTitle } from '@/components/shell/page-chrome'
import { ListPage } from '@/components/templates'
import { useAccount } from '@/contexts/account-context'
import { api,ApiError,fetchApi,type FormDeleteImpact,type ListStats } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import { canManageRole,useStaffRole } from '@/lib/staff-role'
import { runUndoable } from '@/lib/undoable'
import { useNarrowViewport } from '@/lib/use-narrow-viewport'
import { displayFormName,hasStoredDestination,type Folder } from '@line-crm/shared'
import { Link2 } from 'lucide-react'
import styles from './list.module.css'
import { answerSubText,destinationText,FORM_PAGE_SIZES,formQuestionCount,formAnswerCount,formAnswerUrl,listQueryString,SORT_OPTIONS,sortForms,subLineText,UNFILED_VALUE,validFilter,validPage,validPageSize,validSort,type Form,type FormFilter,type FormListResponse,type FormSort } from './model'

/* 行の「…」を右クリックでも開けるように直す。中身は「…」と同じ。 */
function toContextMenuItems(menuItems: ActionMenuItem[]): ContextMenuItem[] {
  return menuItems.map((item) => ({
    id: item.id,
    label: item.label,
    danger: item.tone === 'danger',
    disabled: item.disabled,
    onSelect: () => item.onSelect?.(),
  }))
}

export default function FormsListV8() {
  const saveErrors = useSaveFormErrors()
  usePageTitle('回答フォーム')
  usePageCrumbs([{ label: 'ホーム', href: '/' }])
  const router = useRouter()
  const samePageUrl = useSamePageUrl()
  const searchParams = useSearchParams()
  const { selectedAccountId, selectedAccount, loading: accountLoading } = useAccount()
  const accountScope = useRef({ id: selectedAccountId, generation: 0 })
  if (accountScope.current.id !== selectedAccountId) accountScope.current = { id: selectedAccountId, generation: accountScope.current.generation + 1 }
  const renderedScope = accountScope.current
  const loadedScope = useRef<typeof accountScope.current | null>(null)
  const mounted = useRef(false)
  const deleteLock = useRef(false)
  const stopLock = useRef(false)
  const deleteTicket = useRef<object | null>(null)
  const stopTicket = useRef<object | null>(null)
  const renderedDeleteTicket = deleteTicket.current
  const renderedStopTicket = stopTicket.current
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  /*
   * 箱の作成・名前変更・削除・並び替えは `/api/folders` が owner/admin で閉じている。
   * 役割と鍵は本人APIで確かめ、答えが来るまでは変更操作を隠す。
   * 変えられない人には操作を出さず、閲覧のみの帯（）を出す。
   */
  const staffRole = useStaffRole()
  const canManageFolders = canManageRole(staffRole)
  const canEditForms = useFeatureAccess('forms')
  const canEditRef = useRef(canEditForms); canEditRef.current = canEditForms
  /* 1152 の板（）。フォルダの列は型が畳み、道具の段を2段にする。 */
  const narrow = useNarrowViewport()

  const [forms, setForms] = useState<Form[]>([])
  const [folders, setFolders] = useState<Folder[]>([])
  const [unfiledCount, setUnfiledCount] = useState<number | null>(null)
  const [folderDialogOpen, setFolderDialogOpen] = useState(false)
  const [editingFolder, setEditingFolder] = useState<Folder | null>(null)
  const [deletingFolder, setDeletingFolder] = useState<Folder | null>(null)
  const [folderDeleteScope, setFolderDeleteScope] = useState<typeof accountScope.current | null>(null)
  const folderDeleteTicket = useRef<object | null>(null)
  const renderedFolderDeleteTicket = folderDeleteTicket.current
  /** 消す箱に入っているフォーム数。`null` はまだ数えていない。 */
  const [deletingFolderCount, setDeletingFolderCount] = useState<number | null>(null)
  const [folderBusy, setFolderBusy] = useState(false)
  const folderReorder = useRef<object | null>(null)
  const [folderReordering, setFolderReordering] = useState(false)
  /** 箱の読み込み・操作の失敗。箱の場所に小さく出す。一覧は普通に出す。 */
  const [folderError, setFolderError] = useState('')
  const [moveTarget, setMoveTarget] = useState<Form | null>(null)
  const [moveFolderId, setMoveFolderId] = useState<string>(UNFILED_VALUE)
  const [moveBusy, setMoveBusy] = useState(false)
  const [moveError, setMoveError] = useState('')
  const [formTotal, setFormTotal] = useState(0)
  /** フォルダ欄の「すべて」件数。絞り込み前の件数（all_total）。 */
  const [folderTotal, setFolderTotal] = useState(0)
  const [activeFolderId, setActiveFolderId] = useListUrlValue('activeFolderId', 'all')
  const [loading, setLoading] = useState(true)
  /* 戻ってきたら前のスクロール位置へ（絞り込みは前から URL に置いている）。 */
  useListScrollMemory(!loading)
  const [loadError, setLoadError] = useState('')
  /** 掴んだ失敗そのもの。403（権限不足）と 503（通信失敗）の案内を言い分ける。 */
  const [loadFailure, setLoadFailure] = useState<unknown>(null)
  const [query, setQuery] = useState(() => searchParams.get('q') || '')
  /** 実際の取得に使う遅らせた検索語（1打鍵ごとの往復を避ける）。 */
  const [fetchQuery, setFetchQuery] = useState(() => searchParams.get('q') || '')
  /** 管理者確認（担当未割り当て）。URL には載せない。選んだときだけ専用口を読む。 */
  const [reviewMode, setReviewMode] = useState(false)
  const [reviewForbidden, setReviewForbidden] = useState(false)
  const listReady = useRef(false); listReady.current = !loading && !loadError && !reviewForbidden
  const [formFilter, setFormFilter] = useState<FormFilter>(() => validFilter(searchParams.get('filter')))
  const [formSort, setFormSort] = useState<FormSort>(() => validSort(searchParams.get('sort')))
  const [pageSize, setPageSize] = useState(() => validPageSize(searchParams.get('limit')))
  const [page, setPage] = useState(() => validPage(searchParams.get('page')))
  const duplicateLock = useRef(false)
  const duplicateFeedback = useDuplicateFeedback(selectedAccountId)
  const [duplicating, setDuplicating] = useState(false)
  const setDuplicateError =(message: string | null) => { if (message) notifyToast(message, { tone: 'error' }) }
  /* アーカイブ・削除の窓（）。開いたら影響を読んでから2つの道を出す。 */
  const [deleteTarget, setDeleteTarget] = useState<Form | null>(null)
  const [deleteScope, setDeleteScope] = useState<typeof accountScope.current | null>(null)
  const [deleteImpact, setDeleteImpact] = useState<FormDeleteImpact | null>(null)
  const [deleteImpactLoading, setDeleteImpactLoading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  /* 名前を変更。保存は編集保存と同じ口なので版を添える。 */
  const [renameTarget, setRenameTarget] = useState<Form | null>(null)
  const [renameScope, setRenameScope] = useState<typeof accountScope.current | null>(null)
  const [renameName, setRenameName] = useState('')
  const [renameRevision, setRenameRevision] = useState<number | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [renameError, setRenameError] = useState('')
  const overlayDepth = useContext(OverlayDepthContext)
  const renameGuard = useUnsavedGuard({
    dirty: renameTarget !== null && (renameName !== displayFormName(renameTarget.name) || renaming),
    busy: renameTarget !== null && renaming,
    onDiscard: () => { setRenameTarget(null); setRenameError('') },
  })
  /* 受付を止める。止めるにも編集の版が要るので影響口で読む。 */
  const [stopTarget, setStopTarget] = useState<Form | null>(null)
  const [stopScope, setStopScope] = useState<typeof accountScope.current | null>(null)
  const [stopRevision, setStopRevision] = useState<number | null>(null)
  const [stopImpactLoading, setStopImpactLoading] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState('')
  const [restoringId, setRestoringId] = useState<string | null>(null)
  /** 数の帯。取れないときは全部「—」（0 とは言わない）。 */
  const [stats, setStats] = useState<ListStats | null>(null)
  const [statsFailed, setStatsFailed] = useState(false)
  /** 行の「…」。開いている行のID。 */
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  /* 右から出る詳細パネル。管理者確認は読み取り専用なので開かない。 */
  const detailGuard = useInlineDetailGuard('form')
  const { id: activeId, setId: setActiveId } = detailGuard
  /* 右クリックされた行（「…」と同じ項目を出す）。 */
  const [contextId, setContextId] = useState<string | null>(null)
  const formRequest = useRef(0)
  const activeAccountRef = useRef<string | null>(selectedAccountId)

  useEffect(() => {
    activeAccountRef.current = selectedAccountId
    // フォルダはアカウント単位。切り替えたら前の帯・窓・選択を残さない。
    folderReorder.current = null
    setFolderReordering(false)
    setFolders([])
    setUnfiledCount(null)
    setActiveFolderId('all')
    setFolderDialogOpen(false)
    setEditingFolder(null)
    folderDeleteTicket.current = null
    setDeletingFolder(null)
    setFolderDeleteScope(null)
    setFolderError('')
    setDeleteTarget(null)
    setDeleteImpact(null)
    setStopTarget(null)
    setMoveTarget(null)
    setRenameTarget(null)
    setRenaming(false)
    setOpenMenuId(null)
    setStats(null)
    setStatsFailed(false)
    setPage(1)
  }, [selectedAccountId])

  const clearList = () => {
    setForms([])
    if (!folderReorder.current) setFolders([])
    setUnfiledCount(null)
    setFormTotal(0)
    setFolderTotal(0)
  }

  const loadForms = useCallback(() => loadFormsPage({ activeFolderId, clearList, fetchQuery, formFilter, formRequest, formSort, page, pageSize, reviewMode, saveErrors, selectedAccountId, setFolderError, setFolders: (value) => { if (renderedScope === accountScope.current && !folderReorder.current) setFolders(value) }, setFolderTotal, setForms: (value) => { if (renderedScope !== accountScope.current) return; loadedScope.current = renderedScope; setForms(value) }, setFormTotal, setLoadError, setLoadFailure, setLoading, setReviewForbidden, setUnfiledCount }), [reviewMode, selectedAccountId, activeFolderId, page, pageSize, formFilter, formSort, fetchQuery, saveErrors])

  const loadFormsRef = useRef(loadForms)
  loadFormsRef.current = loadForms

  useEffect(() => {
    void loadForms()
  }, [loadForms])

  /* 数の帯の4枚。取れなくても一覧は出す。 */
  const loadStats = useCallback(async () => {
    if (!selectedAccountId) {
      setStats(null)
      setStatsFailed(false)
      return
    }
    const accountId = selectedAccountId
    try {
      const res = await api.listStats.get(accountId)
      if (activeAccountRef.current !== accountId) return
      if (res.success) {
        setStats(res.data)
        setStatsFailed(false)
      } else {
        setStatsFailed(true)
      }
    } catch (saveFailure) {
      saveErrors.capture(saveFailure);

      if (activeAccountRef.current === accountId) setStatsFailed(true)
    }
  }, [selectedAccountId, saveErrors])

  useEffect(() => {
    void loadStats()
  }, [loadStats])

  /* URL（?q=&filter=&sort=&limit=&page=）が替わったら画面の状態へ写す。 */
  const searchKey = searchParams.toString()
  useEffect(() => {
    const params = new URLSearchParams(searchKey)
    setQuery(params.get('q') || '')
    setFormFilter(validFilter(params.get('filter')))
    setFormSort(validSort(params.get('sort')))
    setPageSize(validPageSize(params.get('limit')))
    setPage(validPage(params.get('page')))
  }, [searchKey])

  // 検索語のサーバー取得は少し遅らせ、1打鍵ごとの往復を避ける。
  useEffect(() => {
    setFetchQuery(query)
  }, [query])

  const listState = { query, filter: formFilter, sort: formSort, pageSize, page }
  const listHref = (next: Partial<typeof listState>) => {
    const queryString = listQueryString({ ...listState, ...next })
    return queryString ? `/form-submissions?${queryString}` : '/form-submissions'
  }
  const updateListState = (next: Partial<typeof listState>) => {
    if (next.query !== undefined) setQuery(next.query)
    if (next.filter !== undefined) setFormFilter(next.filter)
    if (next.sort !== undefined) setFormSort(next.sort)
    if (next.pageSize !== undefined) setPageSize(next.pageSize)
    if (next.page !== undefined) setPage(next.page)
    samePageUrl.replace(listHref(next))
  }

  const createDraft = () => {
    if (!selectedAccountId) return
    router.push(`/form-submissions/edit?new=${crypto.randomUUID()}&tab=basic`)
  }

  /* ===== 詳細パネル（行の名前→右から出る） ===== */
  const clientFilteredForms = useMemo(() => {
    /*
     * 管理者確認（未割り当て一覧）は専用口が全件を返すので、画面側で絞り込み・並び替え・
     * ページ切りをする。通常一覧は Worker が同じ規則で済ませた1ページ分だけを返す。
     */
    const normalizedQuery = query.trim().toLocaleLowerCase('ja-JP')
    return sortForms(forms, formSort).filter((form) => {
      if (formFilter === 'published' && !form.isActive) return false
      if (formFilter === 'draft' && form.isActive) return false
      if (formFilter === 'stored' && !hasStoredDestination(form.layout, form.onSubmitTagId)) return false
      if (formFilter === 'pending' && !(form.pendingPostActionCount ?? 0)) return false
      if (!normalizedQuery) return true
      return (
        displayFormName(form.name).toLocaleLowerCase('ja-JP').includes(normalizedQuery)
        || form.fields.some((field) => field.label.toLocaleLowerCase('ja-JP').includes(normalizedQuery))
        || form.usedByAccounts.some((account) => account.name.toLocaleLowerCase('ja-JP').includes(normalizedQuery))
      )
    })
  }, [formFilter, query, formSort, forms])

  /* 取り消し待ちの削除（5秒）の行は一覧から外して描く（動きの点検 17 番）。 */
  const listTotal = reviewMode ? clientFilteredForms.length : formTotal
  const pageCount = Math.max(1, Math.ceil(listTotal / pageSize))
  const visiblePage = Math.min(page, pageCount)
  const pageStart = (visiblePage - 1) * pageSize
  const pageForms = reviewMode
    ? clientFilteredForms.slice(pageStart, pageStart + pageSize)
    : forms
  const visibleForms = pageForms
  /* 行の名前の前の丸は、左のフォルダの列と同じフォルダ（同じ色）を引く。無ければ未分類の輪。 */
  const folderDotOf = (folderId: string | null | undefined) => {
    const folder = folderId ? folders.find((f) => f.id === folderId) : undefined
    return folder ? { name: folder.name, color: folder.color } : null
  }

  const activeIndex = reviewMode ? -1 : visibleForms.findIndex((form) => form.id === activeId)
  const currentActive = activeIndex >= 0 ? visibleForms[activeIndex] : null
  const heldActive = useRef<Form | null>(null)
  const heldAccount = useRef(selectedAccountId)
  if (heldAccount.current !== selectedAccountId) { heldAccount.current = selectedAccountId; heldActive.current = null }
  if (currentActive) heldActive.current = currentActive
  else if (!detailGuard.holding || heldActive.current?.id !== activeId) heldActive.current = null
  const active = currentActive ?? heldActive.current
  const openDetail = useCallback((id: string) => {
    withViewTransition(() => setActiveId(activeId === id ? null : id))
  }, [activeId, setActiveId])
  const closeDetail = useCallback(() => {
    withViewTransition(() => setActiveId(null))
  }, [setActiveId])
  const goDetail = (direction: -1 | 1) => {
    const next = visibleForms[activeIndex + direction]
    if (!next) return
    withViewTransition(() => setActiveId(next.id))
  }

  const openDuplicate = (form: Form) => { void duplicateForm(form)
  }

  const duplicateForm = async (duplicateTarget: Form) => {
    if (duplicateLock.current) return
    if (!duplicateTarget || duplicating || !selectedAccountId) return
    duplicateLock.current = true
    const name = `${displayFormName(duplicateTarget.name)}のコピー`
    setDuplicating(true)
    setDuplicateError('')
    try {
      const res = await api.forms.duplicate(duplicateTarget.id, selectedAccountId, name)
      if (!res.success) throw new Error(res.error)

      notifyToast('複製しました', { tone: 'success' })
      // 保存済みのコピーをその場に表示する。取得失敗を複製の失敗として再実行させない。
      const query = new URLSearchParams({ account_id: selectedAccountId, with_list_summary: '1', q: name, limit: '20' })
      try {
        const listed = await fetchApi<{ success: boolean; data: FormListResponse }>(`/api/forms?${query}`)
        const candidates = listed.success ? (Array.isArray(listed.data) ? listed.data : listed.data.items) : []
        const copy = candidates.find((row) => row.id === res.data.id)
        if (copy) setForms((current) => insertDuplicateAfter(current, duplicateTarget.id, copy))
        else await loadForms()
      } catch {
        void loadForms()
        notifyToast('複製はできました。一覧を読み直して確認してください。', { tone: 'success' })
      }
      duplicateFeedback.mark(duplicateTarget.id, res.data.id)
      void loadStats()
    } catch (error) {
      const fieldFailure = saveErrors.capture(error)

      { if (!fieldFailure)
      setDuplicateError(error instanceof ApiError && error.status === 404
        ? '元のフォームが見つかりませんでした。一覧を開き直してください。'
        : 'フォームを複製できませんでした。もう一度お試しください。') }
    } finally {
      duplicateLock.current = false
      setDuplicating(false)
    }
  }

  /* アーカイブ・削除の窓を開く。影響（回答数・利用先・版）を先に読む。 */
  const openDelete = async (form: Form) => {
    if (!selectedAccountId || !mounted.current || !canEditRef.current || !listReady.current || renderedScope !== accountScope.current || loadedScope.current !== renderedScope) return
    const ticket = {}; deleteTicket.current = ticket; setDeleteScope(renderedScope)
    const current = () => mounted.current && canEditRef.current && renderedScope === accountScope.current && deleteTicket.current === ticket
    closeDetail()
    setDeleteTarget(form)
    setDeleteImpact(null)
    setDeleteImpactLoading(true)
    setDeleteError('')
    if (!selectedAccountId) {
      setDeleteImpactLoading(false)
      setDeleteError('LINE公式アカウントを選んでください。')
      return
    }
    try {
      const result = await api.forms.deleteImpact(form.id, selectedAccountId)
      if (!current()) return
      if (!result.success) throw new Error(result.error)
      setDeleteImpact(result.data)
    } catch (saveFailure) {
      if (!current()) return
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setDeleteError('アーカイブしたときの影響を確認できませんでした。もう一度開き直してください。') }
    } finally {
      if (current()) setDeleteImpactLoading(false)
    }
  }

  /* 削除は、利用状況にかかわらず確認してから実行する。 */
  const requestDelete = (form: Form) => { void openDelete(form) }

  const closeDelete = () => {
    if (deleting) return
    deleteTicket.current = null
    setDeleteTarget(null)
    setDeleteImpact(null)
    setDeleteError('')
  }

  /*
   * 窓の実行。完全削除（できるときだけ）と保管で口と文言を分ける。
   * 応答が失われたときは対象を読み直し、既に消えていれば成功として扱う。
   */
  const removeForm = async (permanentDelete: boolean) => {
    if (!deleteTarget || !deleteImpact || deleting || !selectedAccountId || !deleteScope || !mounted.current || !canEditRef.current || !listReady.current || deleteScope !== accountScope.current || loadedScope.current !== deleteScope || deleteLock.current) return
    const ticket = renderedDeleteTicket
    if (!ticket || ticket !== deleteTicket.current) return
    const current = () => mounted.current && canEditRef.current && deleteScope === accountScope.current && deleteTicket.current === ticket
    const targetId = deleteTarget.id
    deleteLock.current = true
    setDeleting(true)
    setDeleteError('')
    const finish = () => {
      deleteTicket.current = null
      setForms((current) => current.filter((form) => form.id !== targetId))
      setDeleteTarget(null)
      setDeleteImpact(null)
      // ページの欠け・件数のずれを残さないよう、サーバー側の一覧を読み直す。
      void loadForms()
      void loadStats()
    }
    try {
      const result = permanentDelete
        ? await api.forms.remove(targetId, selectedAccountId, deleteImpact.revision)
        : await api.forms.archive(targetId, selectedAccountId, deleteImpact.revision)
      if (!current()) return
      if (!result.success) throw new Error('delete_failed')
      finish()
    } catch (saveFailure) {
      if (!current()) return
      const fieldFailure = saveErrors.capture(saveFailure);

      let gone = false
      try {
        await api.forms.get(targetId, selectedAccountId)
      } catch (checkError) {
        saveErrors.capture(checkError);

        if (checkError instanceof ApiError && checkError.status === 404) gone = true
      }
      if (!current()) return
      if (gone) {
        finish()
      } else {
        { if (!fieldFailure)
        setDeleteError(permanentDelete
          ? 'この回答フォームを削除できませんでした。状態を読み直してから、もう一度お試しください。'
          : 'この回答フォームをアーカイブできませんでした。状態を読み直してから、もう一度お試しください。') }
      }
    } finally {
      deleteLock.current = false
      if (mounted.current) setDeleting(false)
    }
  }

  /* 名前を変更（「…」の中の操作）。一覧は版を持たないので、窓を開くときに1件取得で読む。 */
  const readContentRevision = async (formId: string, accountId: string): Promise<number> => {
    const res = await fetchApi<{ success: boolean; data: { contentRevision?: number } }>(
      `/api/forms/${formId}?account_id=${encodeURIComponent(accountId)}`,
    )
    if (!res.success || !Number.isInteger(res.data.contentRevision)) throw new Error('rename_revision_failed')
    return res.data.contentRevision as number
  }

  const openRename = async (form: Form) => {
    if (!selectedAccountId || renderedScope !== accountScope.current || loadedScope.current !== renderedScope) return
    setRenameScope(renderedScope)
    setRenameTarget(form)
    setRenameName(displayFormName(form.name))
    setRenameError('')
    setRenameRevision(null)
    try {
      const revision = await readContentRevision(form.id, selectedAccountId)
      if (renderedScope === accountScope.current) setRenameRevision(revision)
    } catch (saveFailure) {
      if (renderedScope !== accountScope.current) return
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setRenameError('フォームの状態を確認できませんでした。開き直してください。') }
    }
  }

  const saveRename = async () => {
    if (!renameTarget || !renameName.trim() || renaming || !selectedAccountId || renameScope !== accountScope.current) return
    const name = displayFormName(renameName)
    setRenaming(true)
    setRenameError('')
    try {
      let revision = renameRevision
      if (revision === null) {
        revision = await readContentRevision(renameTarget.id, selectedAccountId)
        if (renameScope !== accountScope.current) return
        setRenameRevision(revision)
      }
      const res = await api.forms.update(renameTarget.id, selectedAccountId, {
        name,
        expectedContentRevision: revision,
      })
      if (renameScope !== accountScope.current) return
      if (!res.success) throw new Error('rename_failed')
      setForms((current) => current.map((form) => (
        form.id === renameTarget.id ? { ...form, name } : form
      )))
      setRenameTarget(null)
      // 名前は検索・名前順の対象。サーバー側の絞り込み・並びとずれないよう読み直す。
      void loadForms()
    } catch (error) {
      if (renameScope !== accountScope.current) return
      const fieldFailure = saveErrors.capture(error)

      { if (!fieldFailure)
      setRenameError(error instanceof ApiError && error.status === 409
        ? 'ほかの人が先にこの回答フォームを保存しました。開き直して、もう一度お試しください。'
        : 'フォーム名を変更できませんでした。もう一度お試しください。') }
    } finally {
      if (renameScope === accountScope.current) setRenaming(false)
    }
  }

  const closeRename = () => {
    if (renaming) return
    setRenameTarget(null)
    setRenameError('')
  }

  const openStop = async (form: Form) => {
    if (!selectedAccountId || !mounted.current || !canEditRef.current || !listReady.current || renderedScope !== accountScope.current || loadedScope.current !== renderedScope) return
    const ticket = {}; stopTicket.current = ticket; setStopScope(renderedScope)
    const current = () => mounted.current && canEditRef.current && renderedScope === accountScope.current && stopTicket.current === ticket
    closeDetail()
    setStopTarget(form)
    setStopRevision(null)
    setStopImpactLoading(true)
    setStopError('')
    if (!selectedAccountId) {
      setStopImpactLoading(false)
      setStopError('LINE公式アカウントを選んでください。')
      return
    }
    try {
      const result = await api.forms.deleteImpact(form.id, selectedAccountId)
      if (!current()) return
      if (!result.success) throw new Error(result.error)
      setStopRevision(result.data.contentRevision)
    } catch (saveFailure) {
      if (!current()) return
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setStopError('フォームの状態を確認できませんでした。もう一度開き直してください。') }
    } finally {
      if (current()) setStopImpactLoading(false)
    }
  }

  const stopAccepting = async () => {
    if (!stopTarget || stopping || !selectedAccountId || !stopScope || !mounted.current || !canEditRef.current || !listReady.current || stopScope !== accountScope.current || loadedScope.current !== stopScope || stopLock.current) return
    const ticket = renderedStopTicket
    if (!ticket || ticket !== stopTicket.current) return
    const current = () => mounted.current && canEditRef.current && stopScope === accountScope.current && stopTicket.current === ticket
    stopLock.current = true
    setStopping(true)
    setStopError('')
    try {
      /* 受付停止も編集保存と同じ口（`PUT /api/forms/:id`）なので版を免除しない。 */
      let revision = stopRevision
      if (revision === null) {
        const impact = await api.forms.deleteImpact(stopTarget.id, selectedAccountId)
        if (!current()) return
        if (!impact.success) throw new Error('revision_failed')
        revision = impact.data.contentRevision
        setStopRevision(revision)
      }
      const result = await api.forms.update(stopTarget.id, selectedAccountId, {
        isActive: false,
        expectedContentRevision: revision,
      })
      if (!current()) return
      if (!result.success) throw new Error(result.error)
      setForms((current) => current.map((form) => (
        form.id === stopTarget.id ? { ...form, isActive: false } : form
      )))
      stopTicket.current = null
      setStopTarget(null)
      setStopRevision(null)
      // 公開中/下書きの絞り込み対象が変わるため読み直す。
      void loadForms()
      void loadStats()
    } catch (error) {
      if (!current()) return
      const fieldFailure = saveErrors.capture(error)

      { if (!fieldFailure)
      setStopError(error instanceof ApiError && error.status === 409
        ? 'ほかの人が先にこの回答フォームを保存しました。開き直して、もう一度お試しください。'
        : '回答の受付を止められませんでした。状態を読み直してから、もう一度お試しください。') }
    } finally {
      stopLock.current = false
      if (mounted.current) setStopping(false)
    }
  }

  /* フォルダは先に並べ替え、保存と読み直しの間もその並びを保つ。 */
  const moveFolder = (index: number, direction: -1 | 1) => {
    const target = folders[index]
    const neighbor = folders[index + direction]
    if (!target || !neighbor || folderBusy || folderReorder.current || !selectedAccountId) return
    const ticket = {}
    const scope = accountScope.current
    folderReorder.current = ticket
    setFolderReordering(true)
    const before = folders
    const swapped = [...folders]
    swapped[index] = neighbor
    swapped[index + direction] = target
    setFolders(swapped)
    setFolderError('')
    runUndoable({
      message: `フォルダ「${target.name}」の並び順を変えました`,
      commit: async () => {
        const result = await api.folders.swapOrder(target.id, neighbor.id, selectedAccountId)
        if (!result.success) return { success: false, error: result.error }
      },
      undo: () => {
        if (folderReorder.current !== ticket || scope !== accountScope.current) return
        folderReorder.current = null
        setFolderReordering(false)
        setFolders(before)
        void loadFormsRef.current()
      },
      onCommitted: async () => {
        if (folderReorder.current !== ticket || scope !== accountScope.current) return
        folderReorder.current = null
        try { await loadFormsRef.current() }
        finally { if (scope === accountScope.current) setFolderReordering(false) }
      },
      failureMessage: '並び順を変えられませんでした。',
    })
  }

  const openFolderDelete = async (folder: Folder) => {
    const scope = accountScope.current
    if (!scope.id) return
    const ticket = {}
    folderDeleteTicket.current = ticket
    setFolderDeleteScope(scope)
    setDeletingFolder(folder)
    setDeletingFolderCount(null)
    setFolderError('')
    if (!selectedAccountId) return
    try {
      const account = `account_id=${encodeURIComponent(selectedAccountId)}`
      const res = await fetchApi<{ success: boolean; data: FormListResponse }>(
        `/api/forms?${account}&folder_id=${encodeURIComponent(folder.id)}&with_list_summary=1&page=1&limit=1&filter=all&sort=latest-answer`,
      )
      if (res.success && scope === accountScope.current && ticket === folderDeleteTicket.current) {
        setDeletingFolderCount(Array.isArray(res.data) ? res.data.length : res.data.total)
      }
    } catch (saveFailure) {
      if (scope !== accountScope.current || ticket !== folderDeleteTicket.current) return
      saveErrors.capture(saveFailure)
      setDeletingFolderCount(null)
    }
  }

  const removeFolder = async () => {
    if (!deletingFolder || folderBusy || !selectedAccountId || !renderedFolderDeleteTicket || renderedFolderDeleteTicket !== folderDeleteTicket.current || folderDeleteScope !== accountScope.current) return
    if (deletingFolder.accountId === undefined || (typeof deletingFolder.accountId === 'string' && deletingFolder.accountId !== selectedAccountId)) {
      setFolderError('フォルダの所有先を確認できません。一覧を読み直してください。')
      return
    }
    const scope = folderDeleteScope
    const targetId = deletingFolder.id
    setFolderBusy(true)
    setFolderError('')
    try {
      const res = await api.folders.delete(targetId, deletingFolder.accountId ?? undefined)
      if (!res.success) throw new Error(res.error)
      if (scope !== accountScope.current) return
      folderDeleteTicket.current = null
      setDeletingFolder(null)
      if (activeFolderId === targetId) setActiveFolderId('all')
      await loadForms()
    } catch (saveFailure) {
      if (scope !== accountScope.current) return
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setFolderError('フォルダを削除できませんでした。時間をおいて、もう一度お試しください。') }
    } finally {
      setFolderBusy(false)
    }
  }

  const openMove = (form: Form) => {
    closeDetail()
    setMoveTarget(form)
    setMoveFolderId(form.folderId ?? UNFILED_VALUE)
    setMoveError('')
  }

  const closeMove = () => {
    if (moveBusy) return
    setMoveTarget(null)
    setMoveError('')
  }

  const moveForm = async () => {
    if (!moveTarget || moveBusy || !selectedAccountId) return
    const nextFolderId = moveFolderId === UNFILED_VALUE ? null : moveFolderId
    if ((moveTarget.folderId ?? null) === nextFolderId) {
      setMoveTarget(null)
      return
    }
    /* 押した瞬間に移した形を見せて窓を閉じ、裏で保存する（動きの点検・7）。失敗したら戻して知らせる。 */
    const target = moveTarget
    const previousFolderId = target.folderId ?? null
    const setFolderOf = (folderId: string | null) => setForms((current) => current.map((form) => (form.id === target.id ? { ...form, folderId } : form)))
    setFolderOf(nextFolderId)
    setMoveTarget(null)
    setMoveError('')
    try {
      const res = await fetchApi<{ success: boolean; data: Form }>(
        `/api/forms/${target.id}?account_id=${encodeURIComponent(selectedAccountId)}`,
        { method: 'PUT', body: JSON.stringify({ folderId: nextFolderId }) },
      )
      if (!res.success) throw new Error('move_failed')
      void loadForms()
    } catch (error) {
      const fieldFailure = saveErrors.capture(error)
      setFolderOf(previousFolderId)
      { if (!fieldFailure)
      notifyToast(error instanceof ApiError && error.status === 422
        ? 'そのフォルダはありません。開き直して、もう一度お試しください。'
        : 'フォルダへ移せませんでした。', { tone: 'error' }) }
    }
  }

  /* 名前のその場の書き換え（詳細パネル）。影響口で読んだ版を付けて同じ更新口へ送る。 */
  const renameForm = async (target: Form, next: string) => {
    if (!selectedAccountId) throw new Error('no_account')
    const trimmed = next.trim()
    if (!trimmed) throw new Error('empty_name')
    if (trimmed === target.name) return
    const impact = await api.forms.deleteImpact(target.id, selectedAccountId)
    if (!impact.success) throw new Error('revision_failed')
    const result = await api.forms.update(target.id, selectedAccountId, {
      name: trimmed,
      expectedContentRevision: impact.data.contentRevision,
    })
    if (!result.success) throw new Error(result.error)
    setForms((current) => current.map((form) => (form.id === target.id ? { ...form, name: trimmed } : form)))
  }

  useEffect(() => {
    if (!loading && !loadError && page > pageCount) updateListState({ page: pageCount })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadError, loading, page, pageCount])

  const filterActive = formFilter !== 'all' || query.trim() !== '' || activeFolderId !== 'all'
  const clearFilters = () => {
    setActiveFolderId('all')
    updateListState({ query: '', filter: 'all', page: 1 })
  }

  /* ===== 数の帯（4枚）。値が無いときは「—」（0とは言わない）。 ===== */
  const formStats = stats?.forms
  const kpis = [
    {
      key: 'published',
      title: '公開中',
      icon: CircleCheck,
      value: statsFailed ? null : formStats?.published ?? null,
      unit: '件',
      detail: `下書き ${statsFailed || !formStats ? emptyValue('unknown') : formatNumber(formStats.draft)}件`,
    },
    {
      key: 'monthly-submits',
      title: '今月の回答',
      icon: Inbox,
      value: statsFailed ? null : formStats?.monthlySubmits ?? null,
      unit: '件',
      detail: `先月 ${statsFailed || !formStats ? emptyValue('unknown') : formatNumber(formStats.prevMonthSubmits)}件`,
    },
    {
      key: 'completion-rate',
      title: '答え終えた割合',
      icon: Percent,
      value: statsFailed ? null : formStats?.monthlyCompletionRate ?? null,
      unit: '%',
      detail: '開いた人のうち',
    },
    {
      key: 'pending-post-actions',
      title: '後処理の未完',
      icon: TriangleAlert,
      value: statsFailed ? null : formStats?.pendingPostActions ?? null,
      unit: '件',
      detail: 'タグ・シナリオが失敗',
      action: { label: '未完を見る', href: listHref({ filter: 'pending', page: 1 }) },
    },
  ]

  /* ===== 行の「…」（編集・名前を変更・集まった回答・複製・受付を止める・フォルダへ移す・アーカイブ・削除） ===== */
  const restoreForm = async (form: Form) => {
    if (!selectedAccountId || !canEditForms || restoringId) return
    const accountId = selectedAccountId
    setRestoringId(form.id)
    try {
      const response = await api.forms.unarchive(form.id, accountId, form.revision)
      if (!response.success) throw new Error('restore_failed')
      if (activeAccountRef.current !== accountId) return
      notifyToast('アーカイブから戻しました。受付は停止中です。')
      await loadForms()
    } catch {
      if (activeAccountRef.current === accountId) notifyToast('戻せませんでした。一覧を読み直してお試しください。', { tone: 'error' })
    } finally { setRestoringId(null) }
  }

  const rowMenuItemsRaw = (form: Form): ActionMenuItem[] => !canEditForms ? [{
    id: 'responses', label: '集まった回答', external: true,
    href: `/form-submissions/responses?id=${encodeURIComponent(form.id)}`, onSelect: () => router.push(`/form-submissions/responses?id=${encodeURIComponent(form.id)}`),
  }] : form.status === 'archived' ? [
    { id: 'restore', label: 'アーカイブから戻す', disabled: restoringId !== null, onSelect: () => void restoreForm(form) },
    { id: 'responses', label: '集まった回答', onSelect: () => router.push(`/form-submissions/responses?id=${encodeURIComponent(form.id)}`) },
  ] : [
    {
      id: 'edit',
      label: '編集',
      onSelect: () => router.push(`/form-submissions/edit?id=${encodeURIComponent(form.id)}&tab=basic`),
    },
    { id: 'rename', label: '名前を変更', onSelect: () => void openRename(form) },
    {
      id: 'responses',
      label: '集まった回答',
      external: false,
      href: `/form-submissions/responses?id=${encodeURIComponent(form.id)}`, onSelect: () => router.push(`/form-submissions/responses?id=${encodeURIComponent(form.id)}`),
    },
    { id: 'duplicate', label: '複製する', onSelect: () => openDuplicate(form) },
    ...(form.isActive
      ? [{ id: 'stop', label: '受付を止める', onSelect: () => void openStop(form) }]
      : []),
    { id: 'move', label: 'フォルダへ移す', onSelect: () => openMove(form) },
    { id: 'archive', label: 'アーカイブ', dividerBefore: true, onSelect: () => void openDelete(form) },
    { id: 'delete', label: '削除', tone: 'danger' as const, onSelect: () => void requestDelete(form) },
  ]
  const rowMenuItems = (form: Form): ActionMenuItem[] => rowMenuItemsRaw(form).map(item => item.onSelect ? { ...item, onSelect: () => detailGuard.protect(() => { void item.onSelect?.() }) } : item)

  /* ===== フォルダの列 ===== */
  const folderRows: FolderPanelRow[] = [
    { kind: 'all' as const, id: 'all', label: 'すべて', count: loading || loadError ? null : folderTotal },
    ...folders.map((folder, index) => ({
      kind: 'folder' as const,
      id: folder.id,
      label: folder.name,
      count: folder.itemCount ?? null,
      color: folder.color,
      onEdit: canManageFolders ? () => detailGuard.protect(() => { closeDetail(); setEditingFolder(folder) }) : undefined,
      onMoveUp: canManageFolders && !folderReordering && index > 0 ? () => detailGuard.protect(() => { void moveFolder(index, -1) }) : undefined,
      onMoveDown: canManageFolders && !folderReordering && index < folders.length - 1 ? () => detailGuard.protect(() => { void moveFolder(index, 1) }) : undefined,
      onDelete: canManageFolders ? () => detailGuard.protect(() => { if (renderedScope === accountScope.current) void openFolderDelete(folder) }) : undefined,
      deleteNote: '削除しても、中のフォームは未分類に残ります。',
    })),
    { kind: 'unfiled' as const, id: UNFILED_VALUE, label: '未分類', count: loading || loadError ? null : unfiledCount },
  ]

  const selectFolder = (folderId: string) => {
    setActiveFolderId(folderId)
    updateListState({ page: 1 })
  }

  const createButton = (full: boolean) => (
    <PermissionGatedButton allowed={canEditForms}
      type="button"
      variant="primary"
      className={full ? 'v8-folder-create w-full' : undefined}
      onClick={() => detailGuard.protect(createDraft)}
    >
      <Plus size={16} aria-hidden="true" />フォームを作る
    </PermissionGatedButton>
  )

  const folderPanel = (
    <FolderPanel
      createAction={createButton(true)}
      reserveCreateSpace={false}
      activeId={activeFolderId}
      onSelect={selectFolder}
      onAddFolder={canManageFolders ? () => detailGuard.protect(() => { closeDetail(); setFolderDialogOpen(true) }) : undefined}
      addFolderLabel="フォルダを追加"
      rows={folderRows}
    >
      <FolderPanelNote>フォルダを消しても、中のフォームは未分類に残ります。</FolderPanelNote>
      {folderError ? (
        <Notice tone="danger" className={styles.folderNoteNoticePlacement} action={<>
          <Button variant="text" size="inline" data-notice-inline-action type="button" onClick={() => void loadForms()}>
            もう一度
          </Button>
        </>}>{folderError}
        </Notice>
      ) : null}
    </FolderPanel>
  )

  /* ===== 道具の段の部品（広い板と 1152 で同じものを並べ替える） ===== */
  const onSearch = (value: string) => updateListState({ query: value, page: 1 })
  const filterChips = (
    <SegmentedControl<FormFilter>
      aria-label="状態で絞り込む"
      value={formFilter}
      onChange={(next) => updateListState({ filter: next, page: 1 })}
      options={([
        { value: 'all', label: 'すべて' },
        { value: 'published', label: '公開中' },
        { value: 'draft', label: '下書き' },
        { value: 'stored', label: '情報欄に保存' },
        { value: 'archived', label: 'アーカイブ済み' },
        ...(formFilter === 'pending' ? [{ value: 'pending' as const, label: '後処理未完' }] : []),
      ] satisfies Array<{ value: FormFilter; label: string }>)}
    />
  )
  const sortBox = (
    <div className={styles.sortBox}>
      <SaveErrorField names={["formSort","sort","form_sort"]}><ListToolbarSort
        aria-label="並び順"
        label="並び"
        value={formSort}
        options={SORT_OPTIONS}
        onChange={(value) => updateListState({ sort: value as FormSort, page: 1 })}
      /></SaveErrorField>
    </div>
  )
  const perPageBox = (
    <div className={styles.perPageBox}>
      <SaveErrorField names={["pageSize","page_size"]}><Select
        aria-label="表示件数"
        size="page-size"
        value={String(pageSize)}
        options={pageSizeOptions(FORM_PAGE_SIZES)}
        onChange={(value) => updateListState({ pageSize: Number(value), page: 1 })}
      /></SaveErrorField>
    </div>
  )

  /* 1152 の板：1段目「作る・フォルダ・探す … 件数」、2段目「札・並び」。 */

  const wideToolbar = (
    <ListToolbarFrame>
      <ListToolbar
        search={{
          placeholder: 'フォーム名・質問文',
          label: 'フォーム名・質問文で探す',
          width: 200,
          value: query,
          onChange: onSearch,
        }}
        filters={filterChips}
        trailing={<>{sortBox}{perPageBox}</>}
      />
    </ListToolbarFrame>
  )

  /* ===== 一覧の中身（読込中・失敗・空・0件・表を分ける） ===== */
  const stateCard = (icon: ReactNode, title: string, desc: string, action?: ReactNode, error = false, node?: string) => (
    <ListState kind={error ? 'error' : 'empty'} title={title} description={desc} data-design-node={node} icon={icon} action={action} />
  )

  const tableHead = (
    <>
      <colgroup>
        <col />
        {!narrow && <col className={styles.colDest} />}
        <col className={styles.colStatus} />
        <col className={styles.colAnswers} />
        <col className={styles.colUrl} />
        {!reviewMode ? <col className={styles.colMenu} /> : null}
      </colgroup>
      <thead>
        <TableHeadRow>
          <Th className={styles.headCell}>フォーム（質問の数）</Th>
          {!narrow && <Th className={styles.headCell}>保存先</Th>}
          <Th className={styles.headCell}>状態</Th>
          <Th className={styles.headCell}>回答</Th>
          <Th aria-label="URL" />
          {!reviewMode ? <Th aria-label="操作" /> : null}
        </TableHeadRow>
      </thead>
    </>
  )

  const skeleton = (
    <div className={styles.tableWrap} aria-busy="true">
      <span className="sr-only">回答フォームの一覧を読み込んでいます</span>
      <DelayedSkeleton
        loading
        skeleton={
          <DataTable columnSizing="content">
            {tableHead}
            <tbody aria-hidden="true">
              {[0, 1, 2, 3, 4].map((index) => (
                <Tr key={index}>
                  <Td><Skeleton className={styles.skeletonName} /></Td>
                  {!narrow && <Td><Skeleton className={styles.skeletonShort} /></Td>}
                  <Td><Skeleton className={styles.skeletonShort} /></Td>
                  <Td><Skeleton className={styles.skeletonShort} /></Td>
                  <Td><Skeleton className={styles.skeletonShort} /></Td>
                  {!reviewMode ? <Td /> : null}
                </Tr>
              ))}
            </tbody>
          </DataTable>
        }
      />
    </div>
  )

  let listBody: ReactNode
  if ((accountLoading || (loading && selectedAccountId)) && !detailGuard.holding) {
    listBody = skeleton
  } else if (!selectedAccountId) {
    listBody = stateCard(
      <ClipboardList size={20} aria-hidden="true" />,
      'LINE公式アカウントを選んでください',
      '上のアカウント切替から、回答フォームを使う公式アカウントを選びます。',
    )
  } else if (loadError) {
    // 403は再試行せず、429は待ち秒数を添える。
    const failure = loadFailureCopy(loadFailure, '回答フォーム')
    listBody = stateCard(
      <TriangleAlert size={20} aria-hidden="true" />,
      failure.title,
      failure.description,
      failure.retryable ? (
        <Button type="button" variant="secondary" onClick={() => loadForms()} busyLabel="処理中…">もう一度読み込む</Button>
      ) : null,
      true,
    )
  } else if (reviewMode && reviewForbidden) {
    listBody = stateCard(
      <ClipboardList size={20} aria-hidden="true" />,
      '確認できる未割り当てフォームはありません',
      '管理者確認は既定テナントの管理者のみ利用できます。',
    )
  } else if (reviewMode && forms.length === 0) {
    listBody = stateCard(
      <ClipboardList size={20} aria-hidden="true" />,
      '担当未割り当てのフォームはありません',
      '担当の決まっていない旧フォームはここに出ます。',
    )
  } else if (listTotal === 0 || folderTotal === 0) {
    /* 修正案 D-2：空の一覧。閲覧のみには作るボタンを出さない。 */
    listBody = (
      <EmptyList
        icon={<ClipboardList aria-hidden="true" />}
        title="まだ回答フォームがありません"
        description="アンケートや申し込みを LINE の中で受け付け、答えを友だち情報に保存します。"
        canCreate={canEditForms}
        create={{ label: '最初のフォームを作る', onClick: () => detailGuard.protect(createDraft) }}
        filtered={filterActive}
        onClearFilters={clearFilters}
        data-design-node="I3L41O-empty"
      />
    )
  } else {
    listBody = (
      <div className={styles.tableWrap}>
        <DataTable columnSizing="content">
          {tableHead}
          <tbody>
            {duplicateFeedback.order(visibleForms).map((form) => {
              const name = displayFormName(form.name)
              const answerCount = formAnswerCount(form)
              const sub = subLineText(form)
              const answerSub = answerSubText(form)
              const destination = destinationText(form)
              const pendingCount = form.pendingPostActionCount ?? 0
              const answerUrl = formAnswerUrl(selectedAccount?.liffId, form.id)
              const nameNode = reviewMode ? (
                <span className={styles.cellTitle} ><TruncatedText value={String(name ?? '')} /></span>
              ) : (
                <RowNameLink
                  href={`/form-submissions/edit?id=${encodeURIComponent(form.id)}&tab=basic`}
                  title={`${name}の詳細を見る`}
                  aria-label={`「${name}」の詳細を見る`}
                  className={styles.cellTitleButton}
                >
                  {name}
                </RowNameLink>
              )
              const row = (
                <Tr highlighted={duplicateFeedback.highlightedId === form.id} key={form.id} data-row-id={form.id} detailKey={reviewMode ? undefined : "form"} onOpen={reviewMode ? undefined : () => openDetail(form.id)}>
                  <NameCell name={nameNode} description={`質問 ${formQuestionCount(form)}`} folder={folderDotOf(form.folderId)} />
                  {!narrow && (
                    <Td className={styles.destCell} title={destination}>{destination}</Td>
                  )}
                  <StatusCell primary={<>
                    <StatusBadge tone={form.isActive ? 'success' : 'neutral'}>
                      {form.isActive ? '公開中' : '下書き'}
                    </StatusBadge>
                    {reviewMode && form.accountScopeReviewRequired ? <StatusBadge tone="warning" size="compact">管理者確認</StatusBadge> : null}
                  </>}>
                    {pendingCount > 0 ? <StatusBadge tone="danger" size="compact">{`後処理の未完 ${pendingCount}`}</StatusBadge> : null}
                  </StatusCell>
                  <Td className={styles.answerCell}>
                    {reviewMode ? (
                      <span className={styles.answerCount}>{answerCount ? `${formatNumber(answerCount)}件` : emptyValue('unknown')}</span>
                    ) : (
                      <Link
                        href={`/form-submissions/responses?id=${encodeURIComponent(form.id)}`}
                        aria-label={`${name}の集まった回答を見る`}
                        title="集まった回答を見る"
                        className={styles.answerCount}
                        data-zero={answerCount === 0 || undefined}
                      >
                        {`${formatNumber(answerCount)} 件`}
                      </Link>
                    )}
                    {/*
                      今月は日本時間の1日から数える。完了率＝今月の回答完了÷今月開いた人。
                      試しの回答は入れない。取れていない数は「—」だけ出す（0 とは言わない）。
                    */}
                    <span className={styles.answerSub} title={answerSub}>{answerSub}</span>
                  </Td>
                  <Td>
                    <CopyTextButton value={answerUrl ?? ''} label="URL" icon={<Link2 size={16} aria-hidden="true" />} aria-label={`${name}のURLをコピー`} disabled={!answerUrl} />
                  </Td>
                  {!reviewMode ? (
                    /* 管理者確認は読み取り専用。編集・削除・回答の口は担当アカウント経由しか受けない。 */
                    <Td className={styles.menuCell}>
                      {/* 横並びにして、メニューの位置の目印が行を1段増やさないようにする。 */}
                      <div className={styles.menuBox}>
                        <RowMenu
                          title={`「${name}」のその他の操作（編集・集まった回答・複製・受付を止める・フォルダへ移す・アーカイブ・削除）`}
                          label={`「${name}」のその他の操作`}
                          menuLabel={`「${name}」の操作`}
                          items={rowMenuItems(form)}
                          open={openMenuId === form.id}
                          onOpenChange={(next) => setOpenMenuId(next ? form.id : null)}
                        />
                      </div>
                    </Td>
                  ) : null}
                </Tr>
              )
              return row
            })}
          </tbody>
        </DataTable>
      </div>
    )
  }

  /*
   * 右クリックでも「…」と同じ項目（行のどこでも）。管理者確認では出さない。
   * 項目は押した瞬間の行から作る（itemsFor）。state に入れた行から作ると、
   * 1回目は空で開かず、2回目は前に押した行の中身が出ていた。
   */
  const contextForm = visibleForms.find((form) => form.id === contextId) ?? null
  const rowIdOf = (event: ReactMouseEvent) =>
    (event.target as HTMLElement | null)?.closest?.('tr[data-row-id]')?.getAttribute('data-row-id') ?? null
  const listContent = reviewMode || !selectedAccountId || loading || loadError || visibleForms.length === 0 ? listBody : (
    <ContextMenu
      label={contextForm ? `「${displayFormName(contextForm.name)}」の操作` : '回答フォームの操作'}
      items={contextForm ? toContextMenuItems(rowMenuItems(contextForm)) : []}
      shouldOpen={(event) => {
        const id = rowIdOf(event)
        setContextId(id)
        return Boolean(id)
      }}
      itemsFor={(event) => {
        const form = visibleForms.find((item) => item.id === rowIdOf(event))
        return form ? toContextMenuItems(rowMenuItems(form)) : []
      }}
    >
      {listBody}
    </ContextMenu>
  )

  /* ページ送り（絵：左に件数、右に頁）。1ページでも現在のページを出す。 */
  const showPager = !loading && !loadError && visibleForms.length > 0
  const listPager = !showPager ? null : (
    <Pagination
      page={visiblePage}
      pageCount={pageCount}
      onPageChange={(next) => updateListState({ page: next })}
      ariaLabel="回答フォームのページ送り"
      range={{ total: listTotal, first: pageStart + 1, last: Math.min(pageStart + visibleForms.length, listTotal) }}
    />
  )

  /* 閲覧のみの帯（）。見出しの下・数の帯の上。 */
  const viewerBand = !canEditForms ? (
    <div className={styles.viewerBand}><ReadOnlyNotice role="status" data-design-node="JV2oR">{VIEWER_NOTE}</ReadOnlyNotice></div>
  ) : null

  const overlays = <>{renderFormDialogs({ active, activeIndex, canEditForms, closeDelete, closeDetail, closeMove, closeRename, deleteError, deleteImpact, deleteImpactLoading, deleteTarget: deleteScope === accountScope.current ? deleteTarget : null, deleteAccountId: deleteScope?.id ?? null, deleting, deletingFolder: folderDeleteScope === accountScope.current ? deletingFolder : null, deletingFolderCount, editingFolder, folderBusy, folderDialogOpen, folderError, folders, goDetail, loadForms, moveBusy, moveError, moveFolderId, moveForm, moveTarget, openDelete, openDuplicate, openMove, openStop, removeFolder, removeForm, renameError, renameForm, renameName, renameTarget: renameScope === accountScope.current ? renameTarget : null, renameAccountId: renameScope?.id ?? null, renaming, saveRename, selectedAccount, selectedAccountId, setDeletingFolder: (value) => { if (value === null) folderDeleteTicket.current = null; setDeletingFolder(value) }, setEditingFolder, setFolderDialogOpen, setFolderError, setMoveFolderId, setRenameName, setStopError, setStopRevision, setStopTarget: (value) => { if (value === null) stopTicket.current = null; setStopTarget(value) }, stopAccepting, stopError, stopImpactLoading, stopping, stopRevision, stopTarget: stopScope === accountScope.current ? stopTarget : null, stopAccountId: stopScope?.id ?? null, visibleForms, detailGuard })}{detailGuard.dialog}<OverlayDepthContext.Provider value={overlayDepth + 2}><UnsavedLeaveDialog open={renameGuard.leaveTarget !== null} busy={renaming} onConfirm={renameGuard.confirmLeave} onCancel={renameGuard.cancelLeave} /></OverlayDepthContext.Provider></>

  return (
    /* 一覧の状態（読込中・失敗・空・表）を外から待てるように出す。箱は作らない（display: contents）。 */
    <SaveErrorScope errors={saveErrors}><div
      className={styles.root}
      data-list-state={accountLoading || loading ? 'loading' : loadError ? 'error' : visibleForms.length === 0 ? 'empty' : 'ready'}
    >
      <ListPage heightMode="content"
      skeleton
        boardId={narrow ? 'GrnO4' : 'I3L41O'}
        headingSize="regular"
        bottomSpacing="compact"
        title="回答フォーム"
        help="LINEの中で開くアンケート・申し込みフォームです。答えは友だち情報に保存できます。"
        /* 絵に無い機能（管理者確認）は見出しの右に小さく残す。 */
        actions={canManageFolders ? (
          <Button variant="secondary" onClick={() => detailGuard.protect(() => { setReviewMode(!reviewMode); setPage(1) })}>
            {reviewMode ? '通常の一覧に戻る' : '管理者確認（担当未割り当て）'}
          </Button>
        ) : undefined}
        tabs={viewerBand}
        stats={reviewMode ? undefined : (
          /* 数の帯 4つ。管理者確認は別のアカウント群の数なので出さない。 */
          <KpiBand data-design="KPIs">
            {kpis.map((kpi) => (
              <KpiCard
                key={kpi.key}
                presentation="band"
                title={kpi.title}
                icon={<kpi.icon size={16} aria-hidden="true" />}
                value={kpi.value}
                unit={kpi.value == null ? '' : kpi.unit}
                detail={kpi.detail}
                action={kpi.action}
              />
            ))}
          </KpiBand>
        )}
        folderNav={{ rows: folderRows, activeId: activeFolderId, onSelect: selectFolder, createAction: createButton(false) }}
        folders={reviewMode ? undefined : folderPanel}
        toolbar={(
          <>
            {wideToolbar}
            {reviewMode ? (
              <Notice tone="warn">
                <p><strong>管理者確認中のフォーム</strong> — 担当アカウントが決まっていない旧フォームだけを出しています。公開URLは生きているため回答は入り続けます。</p>
                <p>担当の割り当ては後続の対応で行います。この画面では割り当て操作はできません。</p>
              </Notice>
            ) : null}
          </>
        )}
        pagination={listPager}
        overlays={overlays}
      >
        {listContent}
      </ListPage>
    </div></SaveErrorScope>
  )
}
