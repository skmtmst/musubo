'use client'

import { isRichVideoTemplate } from './list-model'

import { renderTemplateDialogs } from './list-dialogs'
import { ChipKey,FolderCountSection,PAGE_SIZE_OPTIONS,PendingDelete,SAVED_FILTER_OPTIONS,Section,Template,latestContentOf, hasMultipleMessages,normalizeTemplateSearchText } from './list-model'
import { useInsertTokenNames } from '@/lib/use-insert-token-names'
import { renderTemplateList } from './list-table'



import AssetTemplatesList from './asset-list'
import { KIND_CARDS } from './list-model'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import ActionMenu,{ type ActionMenuItem } from '@/components/shared/action-menu'
import { permissionDeniedMessage } from '@/components/shared/api-error-message'
import { useEscapeToClearSelection } from '@/components/shared/bulk-bar'
import Button from '@/components/shared/button'
import { type ContextMenuItem } from '@/components/shared/context-menu'
import { InlineDetailHoldingContext, useInlineDetailGuard, useInlineDetailHoldingState } from '@/components/shared/use-inline-detail-guard'
import { requestUnsavedAction } from '@/lib/unsaved-action'
import { OverlayDepthContext } from '@/components/shared/overlay-utils'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { emptyValue } from '@/components/shared/empty-value'
import SegmentedControl from '@/components/shared/segmented'
import FilterChip from '@/components/shared/filter-chip'
import { type FolderDotFolder } from '@/components/shared/folder-dot'
import FolderPanel,{ FOLDER_RAIL_WIDTH,FolderPanelNote,type FolderPanelRow } from '@/components/shared/folder-panel'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import ListToolbar,{ ListToolbarFrame,ListToolbarOptional } from '@/components/shared/list-toolbar'
import { useListScrollMemory,useListUrlState,useOnAccountSwitch } from '@/components/shared/list-url-state'
import Notice from '@/components/shared/notice'
import Pagination from '@/components/shared/pagination'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { SaveErrorField,SaveErrorScope,useSaveFormErrors } from '@/components/shared/save-form-errors'
import Select from '@/components/shared/select'
import { Tabs } from '@/components/shared/tabs'
import { notifyToast } from '@/components/shared/toast'
import { useDuplicateFeedback } from '@/components/shared/use-duplicate-feedback'
import { withViewTransition } from '@/components/shared/view-transition'
import { usePageCrumbs,usePageTitle } from '@/components/shell/page-chrome'
import { ListPage } from '@/components/templates'
import { useAccount } from '@/contexts/account-context'
import { ApiError,api,type BroadcastAssetKind } from '@/lib/api'
import { clampSearchQuery } from '@/lib/search-query'
import { useStaffRole } from '@/lib/staff-role'
import { runOptimistic } from '@/lib/undoable'
import { useFeatureAccess } from '@/lib/use-feature-access'
import { useNarrowViewport } from '@/lib/use-narrow-viewport'
import type { Folder } from '@line-crm/shared'
import { Bookmark,Braces,Copy,FileText,Folder as FolderIcon,Link2,Mail,Plus,Send,Unlink } from 'lucide-react'
import { Fragment,useCallback,useContext,useEffect,useMemo,useRef,useState } from 'react'
import { loadTemplateExamples,type TemplateExample } from './examples'
import styles from './list.module.css'
import { useTemplatePanelDetail } from './panel-detail'
import { createBlockedReason,failureOf,failureOfResponse,listView,usageRows,type TemplatesFailure,type UsageDetail } from './words'
import { formatNumber } from '@/lib/format'

export default function TemplatesListV8() {
  const saveErrors = useSaveFormErrors()
  usePageTitle('テンプレート')
  usePageCrumbs([{ label: 'ホーム', href: '/' }])
  const router = useRouter()
  const { selectedAccountId, accounts, loading: accountLoading } = useAccount()
  const accountScope = useRef({ id: selectedAccountId, generation: 0 })
  if (accountScope.current.id !== selectedAccountId) accountScope.current = { id: selectedAccountId, generation: accountScope.current.generation + 1 }
  const renderedScope = accountScope.current
  const loadedScope = useRef<typeof renderedScope | null>(null)
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const tokenNames = useInsertTokenNames(selectedAccountId)
  /*
   * 作成・編集・公開・削除は API が owner/admin で閉じている。
   * それ以外の人には押せない形で出す（閲覧は残す）。
   */
  /* 役割はサーバ（/api/staff/me）で確かめる。答えが来るまでは手元の値で決める。 */
  const staffRole = useStaffRole()
  const featureAccess = useFeatureAccess('templates')
  const canMutateTemplates = featureAccess
  const canMutateRef = useRef(canMutateTemplates); canMutateRef.current = canMutateTemplates
  const lockedReason = usePermissionLockReason(canMutateTemplates)
  /* 1152 の板（）。フォルダの列は型が畳み、道具の段を2段にする。 */
  const narrow = useNarrowViewport()
  const [moveIds, setMoveIds] = useState<string[] | null>(null)
  const [moveDraft, setMoveDraft] = useState('')
  const [moving, setMoving] = useState(false)
  const moveLock = useRef(false)
  const [moveError, setMoveError] = useState('')
  const [panelMove, setPanelMove] = useState(false)
  const moveDirty = moveIds !== null && moveDraft !== ''
  const moveGuard = useUnsavedGuard({ dirty: moveDirty, busy: moving && moveIds !== null, subject: 'フォルダの移動先', onDiscard: () => {
    setMoveIds(null)
    setPanelMove(false)
    setMoveDraft('')
    setMoveError('')
  } })
  const detailGuard = useInlineDetailGuard('row', panelMove && (moveDirty || moving))
  const { holding: folderHolding, onHoldingChange: setFolderHolding } = useInlineDetailHoldingState()
  const { id: activeId, setId: setActiveId } = detailGuard
  const overlayDepth = useContext(OverlayDepthContext)
  const changeActiveId: typeof setActiveId = next => requestUnsavedAction(() => detailGuard.protect(() => {
    setActiveId(next)
    setPanelMove(false)
    setMoveIds(null)
    setMoveDraft('')
    setMoveError('')
  }))

  /*
   * 検索語・フォルダ・札・絞り込み・件数・ページは URL に置く（動きの点検 5 番）。
   * テンプレートを開いて「戻る」と同じ一覧に戻る。
   */
  const [urlView, setUrlView] = useListUrlState({ q: '', folder: 'all', chips: '', view: '', size: '20', page: '1', tab: 'message' })
  const knownSections: Section[] = ['message', 'question', 'rich_video', 'card_message', 'rich_message', 'coupon', 'research']
  const requestedSection: Section = knownSections.includes(urlView.tab as Section) ? urlView.tab as Section : 'message'
  const heldSection = useRef(requestedSection)
  if (!detailGuard.holding && !folderHolding) heldSection.current = requestedSection
  const activeSection = detailGuard.holding || folderHolding ? heldSection.current : requestedSection
  /* フォルダの数は、テンプレート以外のタブでは最後の種類を保つ。 */
  const [folderSection, setFolderSection] = useState<FolderCountSection>(() => activeSection === 'question' || activeSection === 'rich_video' ? activeSection : 'message')
  useEffect(() => { if (activeSection === 'message' || activeSection === 'question' || activeSection === 'rich_video') setFolderSection(activeSection) }, [activeSection])
  /* 古いタブの答えが後から届いても数を上書きしない。 */
  const folderRequestRef = useRef(0)
  const [templates, setTemplates] = useState<Template[]>([])
  const [assetCounts, setAssetCounts] = useState<Partial<Record<BroadcastAssetKind, number>>>({})
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<TemplatesFailure | null>(null)
  const templateQuery = urlView.q
  const setTemplateQuery = useCallback((next: string) => setUrlView({ q: next, page: '1' }), [setUrlView])
  const chips = useMemo<Record<ChipKey, boolean>>(() => {
    const on = new Set(urlView.chips ? urlView.chips.split(',') : [])
    return { single: on.has('single'), multiple: on.has('multiple'), variables: on.has('variables'), unused: on.has('unused') }
  }, [urlView.chips])
  const setChips = useCallback((update: Record<ChipKey, boolean> | ((current: Record<ChipKey, boolean>) => Record<ChipKey, boolean>)) => {
    const next = typeof update === 'function' ? update(chips) : update
    setUrlView({ chips: (Object.keys(next) as ChipKey[]).filter((key) => next[key]).join(','), page: '1' })
  }, [chips, setUrlView])
  const savedFilter = urlView.view
  const setSavedFilter = useCallback((update: string | ((current: string) => string)) => {
    setUrlView({ view: typeof update === 'function' ? update(savedFilter) : update, page: '1' })
  }, [savedFilter, setUrlView])
  const selectedCategory = urlView.folder
  const setSelectedCategory = useCallback((next: string) => setUrlView({ folder: next, page: '1' }), [setUrlView])
  const pageSize = [10, 20, 50].includes(Number(urlView.size)) ? Number(urlView.size) : 20
  const setPageSize = useCallback((next: number) => setUrlView({ size: String(next), page: '1' }), [setUrlView])
  const page = Math.max(1, Number.parseInt(urlView.page, 10) || 1)
  const setPage = useCallback((next: number) => setUrlView({ page: String(next) }), [setUrlView])

  const [folders, setFolders] = useState<Folder[]>([])
  const [unfiledCount, setUnfiledCount] = useState<number | null>(null)
  const [folderError, setFolderError] = useState('')
  const [folderDialogOpen, setFolderDialogOpen] = useState(false)
  const [editingFolder, setEditingFolder] = useState<Folder | null>(null)
  const [deletingFolder, setDeletingFolder] = useState<Folder | null>(null)
  const folderDeleteTicket = useRef<object | null>(null)
  const renderedFolderDeleteTicket = folderDeleteTicket.current
  const folderDeleteLock = useRef(false)
  const [folderBusy, setFolderBusy] = useState(false)

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  /* 見本から作る（F-5）。窓を初めて開いたときに1回だけ読む。読めなければ段を出さない。 */
  const [examples, setExamples] = useState<TemplateExample[] | null>(null)
  const [examplesError,setExamplesError]=useState(false)
  const [examplesRetry,setExamplesRetry]=useState(0)
  const examplesRequested = useRef(false)
  useEffect(() => {
    if (!pickerOpen || examplesRequested.current) return
    examplesRequested.current = true
    setExamplesError(false)
    let cancelled = false
    loadTemplateExamples()
      .then((items) => { if (!cancelled) setExamples(items) })
      .catch(() => {
        examplesRequested.current = false
        if (!cancelled) setExamplesError(true)
      })
    return () => { cancelled = true }
  }, [pickerOpen,examplesRetry])
  const [savedMenuOpen, setSavedMenuOpen] = useState(false)
  const savedAnchorRef = useRef<HTMLElement | null>(null)

  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  const [deleteScope, setDeleteScope] = useState<{ scope: typeof renderedScope; ticket: object } | null>(null)
  const deleteTicket = useRef<object | null>(null)
  const deleteLock = useRef<object | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  /** 使っている所があるので削除できない窓（）。中身は usage 口で取る。 */
  const [blockedDelete, setBlockedDelete] = useState<PendingDelete | null>(null)
  const [blockedUsage, setBlockedUsage] = useState<UsageDetail | null>(null)
  const [blockedLoading, setBlockedLoading] = useState(false)
  const [blockedLoadError, setBlockedLoadError] = useState(false)

  /* 右クリックされた行（「…」と同じ項目を出す）。 */
  const [contextId, setContextId] = useState<string | null>(null)

  const duplicateLock = useRef(false)
  const duplicateFeedback = useDuplicateFeedback(selectedAccountId)
  const [duplicating, setDuplicating] = useState(false)
  const setDuplicateError =(message: string | null) => { if (message) notifyToast(message, { tone: 'error' }) }

  /** まとめて削除の確認。対象は「使っていない」ものだけ。 */
  const [pendingBulkDelete, setPendingBulkDelete] = useState<Template[] | null>(null)
  const [bulkScope, setBulkScope] = useState<{ scope: typeof renderedScope; ticket: object } | null>(null)
  const bulkTicket = useRef<object | null>(null)
  const bulkLock = useRef<object | null>(null)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [bulkDeleteError, setBulkDeleteError] = useState('')

  const activeAccountRef = useRef<string | null>(selectedAccountId)
  activeAccountRef.current = selectedAccountId
  const loadGenerationRef = useRef(0)

  useEffect(() => {
    activeAccountRef.current = selectedAccountId
    deleteTicket.current = null; bulkTicket.current = null
    deleteLock.current = null; bulkLock.current = null
    setDeleting(false); setBulkDeleting(false)
    // フォルダはアカウント単位。切り替えたら前のアカウントの帯も選択も残さない。
    setFolders([])
    setUnfiledCount(null)
    setFolderDialogOpen(false)
    setEditingFolder(null)
    folderDeleteTicket.current = null
    setDeletingFolder(null)
    setFolderError('')
    setPendingDelete(null)
    setBlockedDelete(null)
    setBlockedUsage(null)
    setPendingBulkDelete(null)
    setMoveIds(null)
    setOpenMenuId(null)
    setSelectedIds(new Set())
  }, [selectedAccountId])
  // アカウントを替えたらフォルダとページを戻す（来た瞬間は URL のまま）。
  useOnAccountSwitch(selectedAccountId, () => setUrlView({ folder: 'all', page: '1' }))

  const load = useCallback(async () => {
    if (!mounted.current || renderedScope !== accountScope.current) return
    if (!selectedAccountId) {
      setTemplates([])
      setFailure(null)
      setLoading(false)
      return
    }
    const accountId = selectedAccountId
    const requestGeneration = ++loadGenerationRef.current
    setLoading(true)
    setFailure(null)
    // アカウントを切り替えたとき、前のアカウントの行を残さない。
    setTemplates([])
    try {
      const res = await api.templates.list(undefined, accountId)
      if (renderedScope !== accountScope.current || activeAccountRef.current !== accountId || requestGeneration !== loadGenerationRef.current) return
      if (res.success) { loadedScope.current = renderedScope; setTemplates(res.data as Template[]) }
      else setFailure(failureOfResponse())
    } catch (e) {
      if (!mounted.current || renderedScope !== accountScope.current || activeAccountRef.current !== accountId || requestGeneration !== loadGenerationRef.current) return
      const fieldFailure = saveErrors.capture(e);

      if (renderedScope === accountScope.current && activeAccountRef.current === accountId && requestGeneration === loadGenerationRef.current) {
        // 権限不足を「読み込めませんでした」に混ぜない。
        { if (!fieldFailure)
        setFailure(failureOf(e)) }
      }
    } finally {
      if (renderedScope === accountScope.current && activeAccountRef.current === accountId && requestGeneration === loadGenerationRef.current) {
        setLoading(false)
      }
    }
  }, [selectedAccountId, saveErrors, renderedScope])

  useEffect(() => { void load() }, [load])

  /* 種類タブの件数は集計専用の口で取る。 */
  const loadAssetCounts = useCallback(async () => {
    const accountId = selectedAccountId
    if (!accountId) {
      setAssetCounts({})
      return
    }
    try {
      const result = await api.broadcastMessageAssets.counts({ accountId })
      if (activeAccountRef.current !== accountId) return
      if (result.success) setAssetCounts(result.data)
    } catch (saveFailure) {
      saveErrors.capture(saveFailure)
      /* 件数が取れなくても一覧は出す。黙って古い件数のままにする。 */
    }
  }, [selectedAccountId, saveErrors])

  useEffect(() => { void loadAssetCounts() }, [loadAssetCounts])

  /** フォルダを読み直す。並び順は API の displayOrder に従う。 */
  const loadFolders = useCallback(async () => {
    if (!selectedAccountId) {
      setFolders([])
      setUnfiledCount(null)
      return
    }
    const accountId = selectedAccountId
    const section = folderSection
    const request = ++folderRequestRef.current
    setFolderError('')
    try {
      // フォルダと未分類の数は、今のタブの種類だけをサーバーで数える。
      const res = await api.folders.list('template', accountId, section)
      if (activeAccountRef.current !== accountId || folderRequestRef.current !== request) return
      if (res.success) {
        setFolders(res.data)
        setUnfiledCount(res.unfiledCount ?? null)
      } else setFolderError('フォルダを読み込めませんでした。')
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure);

      if (activeAccountRef.current === accountId && folderRequestRef.current === request) { if (!fieldFailure) setFolderError('フォルダを読み込めませんでした。')
    }
  }
  }, [selectedAccountId, folderSection, saveErrors])

  useEffect(() => { void loadFolders() }, [loadFolders])

  /** 削除できない窓を開いたとき、使っている所の明細を取る。 */
  useEffect(() => {
    if (!blockedDelete) {
      setBlockedUsage(null)
      setBlockedLoadError(false)
      setBlockedLoading(false)
      return
    }
    let cancelled = false
    setBlockedLoading(true)
    setBlockedLoadError(false)
    api.templates.usages(blockedDelete.item.id).then((res) => {
      if (cancelled) return
      if (res.success && res.data) setBlockedUsage(res.data as UsageDetail)
      else setBlockedLoadError(true)
    }).catch(() => {
      if (!cancelled) setBlockedLoadError(true)
    }).finally(() => {
      if (!cancelled) setBlockedLoading(false)
    })
    return () => { cancelled = true }
  }, [blockedDelete])

  /* ===== 絞り込み ===== */
  const tabItems = useMemo(
    () => templates.filter((t) => activeSection === 'rich_video' ? isRichVideoTemplate(t) : activeSection === 'question' ? Boolean(t.question) : !t.question && !isRichVideoTemplate(t)),
    [templates, activeSection],
  )

  /* 本文は長いので、templates が替わったときだけ検索索引を作る。 */
  const templateSearchIndex = useMemo(() => tabItems.map((template) => ({
    template,
    normalizedSearchText: [template.name, template.messageContent, template.draftMessageContent ?? '']
      .map(normalizeTemplateSearchText)
      .join('\0'),
  })), [tabItems])
  const normalizedTemplateQuery = useMemo(() => normalizeTemplateSearchText(templateQuery), [templateQuery])

  // 使われていないテンプレートは窓なしで消し、5秒は「元に戻す」で取り消せる（動きの点検 17 番）。
  const filteredTemplates = useMemo(() => templateSearchIndex.flatMap(({ template: t, normalizedSearchText }) => {
    if (normalizedTemplateQuery && !normalizedSearchText.includes(normalizedTemplateQuery)) return []
    /* フォルダで絞る。`category` の文字列ではなく `folderId` で見る。 */
    if (selectedCategory === 'unfiled' && t.folderId !== null) return []
    if (selectedCategory !== 'all' && selectedCategory !== 'unfiled' && t.folderId !== selectedCategory) return []
    if (chips.unused && t.usageCount !== 0) return []
    if (chips.single && hasMultipleMessages(t)) return []
    const content = latestContentOf(t)
    if (chips.multiple && !hasMultipleMessages(t)) return []
    if (chips.variables && !content.includes('{{')) return []
    if (savedFilter === 'used' && !(t.usageCount > 0)) return []
    if (savedFilter === 'draft-changes' && !(t.hasDraft && t.publishedAt != null)) return []
    if (savedFilter === 'draft-only' && t.publishedAt != null) return []
    // 消して「元に戻す」を待っている行は出さない。
    return [t]
  }), [normalizedTemplateQuery, selectedCategory, templateSearchIndex, chips, savedFilter])

  const filterActive = Boolean(
    normalizedTemplateQuery
      || selectedCategory !== 'all'
      || chips.single
      || chips.multiple
      || chips.variables
      || chips.unused
      || savedFilter,
  )
  const clearFilters = () => {
    setUrlView({ q: '', folder: 'all', chips: '', view: '', page: '1' })
  }

  const toggleChip = (key: ChipKey) => {
    setChips((current) => {
      const next = { ...current, [key]: !current[key] }
      // 「1通のみ」と「複数通」は同時に選べない。
      if (key === 'single' && next.single) next.multiple = false
      if (key === 'multiple' && next.multiple) next.single = false
      return next
    })
    setPage(1)
  }

  const pageCount = Math.max(1, Math.ceil(filteredTemplates.length / pageSize))
  const safePage = Math.min(page, pageCount)
  const shownItems = filteredTemplates.slice((safePage - 1) * pageSize, safePage * pageSize)

  // 絞り込みや件数の変更でページが溢れたら戻す。
  // 読み終わってから。読み込み中（0件）に詰めると、URL から戻したページが 1 になる。
  useEffect(() => {
    if (!loading && page > pageCount) setPage(pageCount)
  }, [loading, page, pageCount, setPage])
  useListScrollMemory(!loading)

  const view = listView({ loading, failure, total: tabItems.length, matched: filteredTemplates.length })
  const createBlocked = createBlockedReason({ loading, failure })

  /* ===== 数の帯（このタブのテンプレートから） ===== */
  const ready = view === 'ready' || view === 'empty' || view === 'no-match'
  const draftChanges = tabItems.filter((t) => t.hasDraft && t.publishedAt != null).length
  const usageAllKnown = tabItems.every((t) => typeof t.usageCount === 'number')
  const usageTotal = usageAllKnown ? tabItems.reduce((sum, t) => sum + t.usageCount, 0) : null
  const monthlyAllKnown = tabItems.every((t) => typeof t.monthlySendCount === 'number')
  const monthlyTotal = monthlyAllKnown ? tabItems.reduce((sum, t) => sum + (t.monthlySendCount ?? 0), 0) : null
  const unusedCount = usageAllKnown ? tabItems.filter((t) => t.usageCount === 0).length : null
  const kpis = [
    {
      key: 'templates',
      title: 'テンプレート',
      icon: FileText,
      value: ready ? tabItems.length : null,
      unit: '件',
      detail: ready ? `未公開の変更 ${draftChanges}件` : emptyValue('unknown'),
    },
    {
      key: 'usage',
      title: '使っている所',
      icon: Link2,
      value: ready ? usageTotal : null,
      unit: 'か所',
      detail: ready ? (usageTotal === null ? '使っている所を確認できません' : '一斉配信・自動応答・シナリオなど') : emptyValue('unknown'),
    },
    {
      key: 'monthly',
      title: '今月送った数',
      icon: Send,
      value: ready ? monthlyTotal : null,
      unit: '通',
      detail: ready ? (monthlyTotal === null ? '送信数を確認できません' : 'このタブのテンプレートから') : emptyValue('unknown'),
    },
    {
      key: 'unused',
      title: '使っていない',
      icon: Mail,
      value: ready ? unusedCount : null,
      unit: '件',
      detail: ready ? (unusedCount === null ? '使っている所を確認できません' : '整理の候補') : emptyValue('unknown'),
    },
  ]

  /* ===== 選択 ===== */
  const toggleOne = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const pageIds = duplicateFeedback.order( shownItems, templates).map((t) => t.id)
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
  // 選んでいる間は Esc で選択を外す（旧い一覧と同じ）。
  const clearSelection = useCallback(() => setSelectedIds(new Set()), [])
  useEscapeToClearSelection(selectedCount > 0, clearSelection)
  const selectedTemplates = templates.filter((t) => selectedIds.has(t.id))
  /** まとめて削除は「使っていない」ものだけ。 */
  const removableSelected = selectedTemplates.filter((t) => t.usageCount === 0)
  const usedSelectedCount = selectedTemplates.length - removableSelected.length

  /* ===== 操作 ===== */
  /** 行の編集先。質問とそうでないもので作る画面が分かれる。 */
  const editHref = (t: Template) =>
    t.question
      ? `/templates/questions/new?id=${encodeURIComponent(t.id)}`
      : `/templates/edit?id=${encodeURIComponent(t.id)}${isRichVideoTemplate(t) ? '&kind=rich_video' : ''}`
  const detailHref = (t: Template) => `/templates/detail?id=${encodeURIComponent(t.id)}`

  /** フォルダの並び順を入れ替える（隣と番号を交換）。 */
  const moveFolder = async (index: number, direction: -1 | 1) => {
    const target = folders[index]
    const neighbor = folders[index + direction]
    if (!target || !neighbor) return
    setFolderBusy(true)
    setFolderError('')
    try {
      const res = await api.folders.swapOrder(target.id, neighbor.id, selectedAccountId ?? undefined)
      if (!res.success) throw new Error(res.error)
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
    if (!deletingFolder || folderBusy || folderDeleteLock.current || !renderedFolderDeleteTicket || renderedFolderDeleteTicket !== folderDeleteTicket.current || renderedScope !== accountScope.current) return
    if (deletingFolder.accountId === undefined || (typeof deletingFolder.accountId === 'string' && deletingFolder.accountId !== selectedAccountId)) {
      setFolderError('フォルダの所有先を確認できません。一覧を読み直してください。')
      return
    }
    folderDeleteLock.current = true
    setFolderBusy(true)
    setFolderError('')
    try {
      const res = await api.folders.delete(deletingFolder.id, deletingFolder.accountId ?? undefined)
      if (!res.success) throw new Error(res.error ?? '削除できませんでした。時間をおいて、もう一度お試しください。')
      if (renderedFolderDeleteTicket !== folderDeleteTicket.current || renderedScope !== accountScope.current) return
      folderDeleteTicket.current = null
      setDeletingFolder(null)
      if (selectedCategory === deletingFolder.id) setSelectedCategory('all')
      await loadFolders()
    } catch (saveFailure) {
      if (renderedFolderDeleteTicket !== folderDeleteTicket.current || renderedScope !== accountScope.current) return
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setFolderError('フォルダを削除できませんでした。時間をおいて、もう一度お試しください。') }
    } finally {
      folderDeleteLock.current = false
      setFolderBusy(false)
    }
  }
  const cancelFolderDelete = () => {
    if (folderBusy || folderDeleteLock.current) return
    folderDeleteTicket.current = null
    setDeletingFolder(null)
    setFolderError('')
  }

  /*
   * 使用中なら「使っている所」の窓へ。どこでも使われていない（0か所と分かっている）なら、
   * 確かめの窓を出さずに一覧から外し、5秒は「元に戻す」で取り消せる（動きの点検 17 番）。
   * 使っている数が分からないときは、今までどおり確かめの窓。
   */
  const handleDelete = (t: Template) => {
    if (!mounted.current || !canMutateRef.current || renderedScope !== accountScope.current || loadedScope.current !== renderedScope || loading) return
    setDeleteError('')
    if (t.usageCount > 0) { setBlockedDelete({ item: t, accountId: selectedAccountId }); return }
    const ticket = {}; deleteTicket.current = ticket; setDeleteScope({ scope: renderedScope, ticket })
    setPendingDelete({ item: t, accountId: selectedAccountId })
  }

  const confirmDelete = async () => {
    // 二度押しを受け付けない。切り替わった後も走らせない。
    if (!pendingDelete || deleting || deleteLock.current || !mounted.current || !canMutateRef.current || !deleteScope || deleteScope.scope !== accountScope.current || deleteScope.ticket !== deleteTicket.current || loadedScope.current !== deleteScope.scope) return
    if (pendingDelete.accountId !== selectedAccountId) {
      setDeleteError('アカウントが切り替わりました。削除するテンプレートを選び直してください。')
      return
    }
    const target = pendingDelete.item
    const current = () => mounted.current && canMutateRef.current && deleteScope.scope === accountScope.current && deleteScope.ticket === deleteTicket.current
    const lock = {}; deleteLock.current = lock; setDeleting(true)
    setDeleteError('')
    try {
      const res = await api.templates.delete(target.id)
      if (!current()) return
      if (!res.success) throw new Error(res.error)
      deleteTicket.current = null
      setPendingDelete(null)
      // 件数（未分類・フォルダ別）はフォルダ側の集計が持つので両方読み直す。
      await Promise.all([load(), loadFolders()])
    } catch (saveFailure) {
      if (!current()) return
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setDeleteError('このテンプレートを削除できませんでした。状態を読み直してから、もう一度お試しください。') }
    } finally {
      if (deleteLock.current === lock) deleteLock.current = null
      if (mounted.current && deleteScope.scope === accountScope.current) setDeleting(false)
    }
  }

  /** フォルダへ移す（1件でもまとめてでも同じ窓）。 */
  const openMove = (ids: string[]) => {
    setPanelMove(ids.length === 1 && ids[0] === activeId)
    setMoveIds(ids)
    setMoveDraft('')
    setMoveError('')
  }
  /*
   * 押した瞬間に移した形を見せて窓を閉じ、裏で保存する（動きの点検・7）。
   * 1件でも失敗したら元に戻して知らせる（「もう一度」で同じ移動をやり直せる）。
   */
  const runMove = async () => {
    if (!moveIds || moveLock.current) return
    moveLock.current = true
    setMoving(true)
    const requestAccountId = selectedAccountId
    const ids = moveIds
    const folderId = moveDraft === '' ? null : moveDraft
    const previous = templates
    const idSet = new Set(ids)
    setTemplates((current) => current.map((t) => (idSet.has(t.id) ? { ...t, folderId } : t)))
    setMoveIds(null)
    setPanelMove(false)
    setSelectedIds(new Set())
    setMoveError('')
    const send = async () => {
      try {
        let failed = 0
        for (const id of ids) {
          const result = await api.templates.update(id, { folderId })
          if (!result.success) failed += 1
        }
        return failed > 0 ? { success: false as const, error: `${formatNumber(failed)} 件` } : { success: true as const }
      } finally {
        moveLock.current = false
        setMoving(false)
      }
    }
    runOptimistic({
      isCurrent: () => activeAccountRef.current === requestAccountId,
      request: send,
      revert: () => {
        setTemplates(previous)
        void Promise.all([load(), loadFolders()])
      },
      failureMessage: 'フォルダへ移せませんでした。状態を読み直したので、もう一度お試しください。',
      onSuccess: () => {
        notifyToast('フォルダへ移しました', { tone: 'success' })
        void loadFolders()
      },
    })
  }

  /* 複製。複製の口は無いので、同じ内容で「下書き」として新しく作る。 */
  const runDuplicate = async (duplicateTarget: Template) => {
    if (duplicateLock.current) return
    if (!duplicateTarget) return
    duplicateLock.current = true
    setDuplicating(true)
    setDuplicateError('')
    const source = duplicateTarget
    try {
      const result = await api.templates.create({
        accountId: selectedAccountId ?? '',
        name: `${source.name}（コピー）`,
        category: source.category,
        messageType: source.messageType,
        messageContent: latestContentOf(source),
        question: source.question ?? null,
        questionStatus: 'draft',
        folderId: source.folderId,
      })
      if (!result.success) {
        setDuplicateError('複製できませんでした。状態を読み直してからお試しください。')
        return
      }

      duplicateFeedback.mark(source.id, result.data.id)
      notifyToast('複製しました', { tone: 'success' })
      await Promise.all([load(), loadFolders()])
    } catch (reason) {
      const fieldFailure = saveErrors.capture(reason)

      { if (!fieldFailure)
      setDuplicateError(
        reason instanceof ApiError && reason.status === 403
          ? permissionDeniedMessage('store')
          : '複製できませんでした。状態を読み直してからお試しください。',
      ) }
    } finally {
      duplicateLock.current = false
      setDuplicating(false)
    }
  }

  /** まとめて削除。使用中のものはここへ来ない（帯の側で弾く）。 */
  const runBulkDelete = async () => {
    if (!pendingBulkDelete || !bulkScope || bulkScope.scope !== accountScope.current || bulkScope.ticket !== bulkTicket.current || loadedScope.current !== bulkScope.scope || !mounted.current || !canMutateRef.current || bulkLock.current) return
    const current = () => mounted.current && canMutateRef.current && bulkScope.scope === accountScope.current && bulkScope.ticket === bulkTicket.current
    const lock = {}; bulkLock.current = lock; setBulkDeleting(true)
    setBulkDeleteError('')
    try {
      if (pendingBulkDelete.some(t => !Number.isSafeInteger(t.confirmationRevision) || !t.confirmationRevision || t.confirmationRevision < 1)) throw new Error('確認した版を読み直してください')
      const result = await api.templates.bulkDelete(pendingBulkDelete.map(t => ({ id: t.id, expectedRevision: t.confirmationRevision! })))
      if (!current()) return
      if (!result.success) {
        setBulkDeleteError(`${formatNumber(pendingBulkDelete.length)} 件を削除できませんでした。状態を読み直してからお試しください。`)
        await Promise.all([load(), loadFolders()])
        return
      }
      bulkTicket.current = null
      setPendingBulkDelete(null)
      setSelectedIds(new Set())
      notifyToast(`${formatNumber(pendingBulkDelete.length)} 件のテンプレートを削除しました`, { tone: 'success' })
      await Promise.all([load(), loadFolders()])
    } catch (reason) {
      if (!current()) return
      const fieldFailure = saveErrors.capture(reason)

      { if (!fieldFailure)
      setBulkDeleteError(
        reason instanceof ApiError && reason.status === 403
          ? permissionDeniedMessage('store')
          : '削除できませんでした。状態を読み直してからお試しください。',
      ) }
    } finally {
      if (bulkLock.current === lock) bulkLock.current = null
      if (mounted.current && bulkScope.scope === accountScope.current) setBulkDeleting(false)
    }
  }

  const changeBulkDelete: typeof setPendingBulkDelete = (next) => {
    const value = typeof next === 'function' ? next(pendingBulkDelete) : next
    if (value) {
      if (!mounted.current || !canMutateRef.current || renderedScope !== accountScope.current || loadedScope.current !== renderedScope || loading) return
      const ticket = {}; bulkTicket.current = ticket; setBulkScope({ scope: renderedScope, ticket }); setPendingBulkDelete(value)
    } else if (bulkScope?.ticket === bulkTicket.current) { bulkTicket.current = null; setPendingBulkDelete(null) }
  }
  const changePendingDelete: typeof setPendingDelete = (next) => {
    const value = typeof next === 'function' ? next(pendingDelete) : next
    if (value) return
    if (deleteScope?.ticket === deleteTicket.current) { deleteTicket.current = null; setPendingDelete(null) }
  }
  const targetAccounts = (items: Template[]) => [...new Set(items.map(item => item.accountId ?? ''))].map(id => ({ id, name: accounts.find(account => account.id === id)?.name }))

  /* ===== 行の「…」（一斉配信で使う・複製・使っている所・削除） ===== */
  const rowMenuItems = (t: Template): ActionMenuItem[] => {
    // 閲覧のみには押せない項目を置かない（2026-10-06 オーナー決定）。見るだけの項目（使っている所・一斉配信で使う）は残す。
    const canMutate = canMutateTemplates
    return [
      ...(canMutate ? [{
        id: 'edit',
        label: '編集する',
        onSelect: () => withViewTransition(() => router.push(editHref(t))),
      }] : []),
      {
        id: 'usage',
        label: '使っている所を見る',
        external: false,
        href: detailHref(t), onSelect: () => withViewTransition(() => router.push(detailHref(t))),
      },
      {
        id: 'broadcast',
        label: '一斉配信で使う',
        onSelect: () => router.push(`/broadcasts/new?templateId=${encodeURIComponent(t.id)}`),
      },
      ...(canMutate ? [
        {
          id: 'duplicate',
          label: '複製する',
          icon: <Copy size={16} aria-hidden="true" />,
          onSelect: () => {
            setDuplicateError('')
            void runDuplicate(t)
          },
        },
        {
          id: 'move',
          label: 'フォルダへ移す',
          icon: <FolderIcon size={16} aria-hidden="true" />,
          onSelect: () => openMove([t.id]),
        },
        {
          id: 'delete',
          label: '削除する',
          tone: 'danger' as const,
          dividerBefore: true,
          onSelect: () => handleDelete(t),
        },
      ] : []),
    ].map(item => item.onSelect ? { ...item, onSelect: () => requestUnsavedAction(() => detailGuard.protect(() => { void item.onSelect?.() })) } : item)
  }

  /* 右から出る詳細パネルの今の行。一覧に無ければ閉じる。 */
  const currentTemplate = activeId ? (templates.find((t) => t.id === activeId) ?? null) : null
  const heldTemplate = useRef<Template | null>(null)
  const heldAccount = useRef(selectedAccountId)
  if (heldAccount.current !== selectedAccountId) { heldAccount.current = selectedAccountId; heldTemplate.current = null }
  if (currentTemplate) heldTemplate.current = currentTemplate
  else if (!detailGuard.holding || heldTemplate.current?.id !== activeId) heldTemplate.current = null
  const activeTemplate = currentTemplate ?? heldTemplate.current
  const panelDetail = useTemplatePanelDetail(activeTemplate?.id ?? null, selectedAccountId, canMutateTemplates, load)
  const panelUsageRows = panelDetail.detail?.usedBy ? usageRows(panelDetail.detail.usedBy) : []
  const navItems = activeTemplate && shownItems.some((t) => t.id === activeTemplate.id) ? shownItems : templates
  const activeIndex = activeTemplate ? navItems.findIndex((t) => t.id === activeTemplate.id) : -1
  const activeFolderName = activeTemplate
    ? (activeTemplate.folderId === null
      ? '未分類'
      : (folders.find((f) => f.id === activeTemplate.folderId)?.name ?? null))
    : null

  /* 名前のその場の書き換え。Enter で保存・Esc でやめる。 */
  const renameTemplate = async (t: Template, next: string) => {
    const name = next.trim()
    if (!name || name === t.name) return
    const res = await api.templates.update(t.id, { name })
    if (!res.success) throw new Error(res.error ?? 'rename_failed')
    setTemplates((rows) => rows.map((row) => (row.id === t.id ? { ...row, name } : row)))
  }

  /* 右クリックは「…」と同じ項目。 */
  const contextTemplate = contextId ? (templates.find((t) => t.id === contextId) ?? null) : null
  const contextMenuItems: ContextMenuItem[] = contextTemplate
    ? rowMenuItems(contextTemplate).map((item) => ({
      id: item.id,
      label: item.label,
      danger: item.tone === 'danger',
      disabled: item.disabled,
      onSelect: () => item.onSelect?.(),
    }))
    : []

  /* ===== フォルダの列 ===== */
  /* 行の名前の前の丸は、左のフォルダの列と同じフォルダ（同じ色）を引く。未分類は色の無い輪。 */
  const folderDotOf = (t: { folderId: string | null }): FolderDotFolder | null => {
    if (!t.folderId) return null
    const folder = folders.find((f) => f.id === t.folderId)
    return folder ? { name: folder.name, color: folder.color } : null
  }
  /*
   * 「すべて」は全部の数＝各フォルダと未分類のサーバーの数の合計。フォルダと未分類と
   * 同じ数え方にする（今のタブの行数だと「すべて 0」なのに「未分類 1」と食い違った）。
   */
  const allCount = ready && unfiledCount !== null && folders.every((folder) => typeof folder.itemCount === 'number')
    ? folders.reduce((sum, folder) => sum + (folder.itemCount ?? 0), unfiledCount)
    : null
  const folderRows: FolderPanelRow[] = [
    { kind: 'all' as const, id: 'all', label: 'すべて', count: allCount },
    ...folders.map((folder, index) => ({
      kind: 'folder' as const,
      id: folder.id,
      label: folder.name,
      count: folder.itemCount ?? null,
      color: folder.color,
      qaOpen: canMutateTemplates && folder.name === '予約' ? 'CzndJ' : undefined,
      onEdit: canMutateTemplates ? () => detailGuard.protect(() => setEditingFolder(folder)) : undefined,
      onMoveUp: canMutateTemplates && index > 0 ? () => detailGuard.protect(() => { void moveFolder(index, -1) }) : undefined,
      onMoveDown: canMutateTemplates && index < folders.length - 1 ? () => detailGuard.protect(() => { void moveFolder(index, 1) }) : undefined,
      onDelete: canMutateTemplates ? () => detailGuard.protect(() => { if (renderedScope !== accountScope.current) return; folderDeleteTicket.current = {}; setDeletingFolder(folder) }) : undefined,
      deleteNote: '削除しても、中のテンプレートは未分類に残ります。',
    })),
    { kind: 'unfiled' as const, id: 'unfiled', label: '未分類', count: ready ? unfiledCount : null },
  ]
  const folderSelectOptions = [
    { value: 'all', label: 'フォルダ：すべて' },
    ...folders.map((f) => ({ value: f.id, label: f.name })),
    { value: 'unfiled', label: '未分類' },
  ]

  const openPicker = () => setPickerOpen(true)
  const createKind = KIND_CARDS.find(card => card.key === activeSection)!
  const createButton = (full: boolean) => (
    <Button variant="primary"
      {...(canMutateTemplates && createBlocked === null ? { href: createKind.href } : { disabled: true })}
      className={full ? 'v8-folder-create w-full' : undefined}
      lockedReason={lockedReason} title={createBlocked ?? undefined}>
      <Plus size={16} aria-hidden="true" />{createKind.title}を作る
    </Button>
  )

  const selectCategory = (id: string) => {
    setSelectedCategory(id)
    setPage(1)
  }
  const folderPanel = (
    <FolderPanel
      createAction={createButton(true)}
      activeId={selectedCategory}
      onSelect={selectCategory}
      onAddFolder={canMutateTemplates ? () => detailGuard.protect(() => setFolderDialogOpen(true)) : undefined}
      addFolderLabel="フォルダを追加"
      rows={folderRows}
    >
      {/* 補助のデータ（フォルダ）だけ取れないときは、その場所に小さく1行だけ。 */}
      {folderError ? <Notice tone="danger" className={styles.folderNoteNoticePlacement} >{folderError}</Notice> : null}
      <FolderPanelNote>
        フォルダは種類のタブをまたいで使えます。消しても、中のテンプレートは未分類に残ります
      </FolderPanelNote>
    </FolderPanel>
  )

  /* ===== 道具の段の部品（広い板と 1152 で同じものを並べ替える） ===== */
  const onSearch = (value: string) => {
    setTemplateQuery(clampSearchQuery(value))
    setPage(1)
  }
  const filterChips = (
    <div role="group" aria-label="中身で絞り込む" className={styles.chipGroup}>
      <SegmentedControl aria-label="メッセージの数" value={chips.single ? 'single' : chips.multiple ? 'multiple' : 'all'}
        onChange={value => setChips(current => ({ ...current, single: value === 'single', multiple: value === 'multiple' }))}
        options={[{ value: 'all', label: 'すべて' }, { value: 'single', label: '1通のみ' }, ...(tabItems.some(hasMultipleMessages) ? [{ value: 'multiple', label: '複数通' }] : [])]} />
      <FilterChip selected={chips.variables} onChange={() => toggleChip('variables')} title="名前や情報を差し込むテンプレート" icon={<Braces size={16} aria-hidden="true" />}>
        差し込みあり
      </FilterChip>
      <FilterChip selected={chips.unused} onChange={() => toggleChip('unused')} title="どこからも使われていないテンプレート" icon={<Unlink size={16} aria-hidden="true" />}>
        使っていない
      </FilterChip>
    </div>
  )
  /* よく使う絞り込み（絵：栞の印＋文字のボタン。押すと選ぶメニュー）。1152 は印だけ。 */
  const savedLabel = SAVED_FILTER_OPTIONS.find((o) => o.value === savedFilter && o.value !== '')?.label
  const savedBox = (iconOnly: boolean) => (
    <Button
      type="button"
      variant="secondary"
      aria-label={iconOnly ? `よく使う絞り込み${savedLabel ? `：${savedLabel}` : ''}` : undefined}
      title={iconOnly ? (savedLabel ?? 'よく使う絞り込み') : undefined}
      aria-haspopup="menu"
      aria-expanded={savedMenuOpen}
      aria-pressed={savedFilter !== ''}
      onClick={(event) => {
        savedAnchorRef.current = event.currentTarget
        setSavedMenuOpen((current) => !current)
      }}
    >
      <Bookmark size={16} aria-hidden="true" />
      {iconOnly ? null : (savedLabel ?? 'よく使う絞り込み')}
    </Button>
  )
  const savedMenu = (
    <ActionMenu
      open={savedMenuOpen}
      onClose={() => setSavedMenuOpen(false)}
      anchorRef={savedAnchorRef}
      ariaLabel="よく使う絞り込み"
      items={SAVED_FILTER_OPTIONS.filter((o) => o.value !== '').map((o) => ({
        id: o.value,
        label: savedFilter === o.value ? `${o.label}（選択中・押すと外す）` : o.label,
        onSelect: () => {
          setSavedMenuOpen(false)
          setSavedFilter((current) => (current === o.value ? '' : o.value))
          setPage(1)
        },
      }))}
    />
  )
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

  /* 1152 の板：1段目「作る・フォルダ・探す … 件数」、2段目「札・よく使う絞り込み（印だけ）」。 */


  const wideToolbar = (
    <ListToolbarFrame>
      <ListToolbar
        search={{
          placeholder: '名前・本文・差し込みで探す',
          label: 'テンプレートを検索',
          value: templateQuery,
          onChange: onSearch,
        }}
        filters={filterChips}
        trailing={<><ListToolbarOptional label="よく使う絞り込み">{savedBox(false)}</ListToolbarOptional>{perPageBox}</>}
      />
    </ListToolbarFrame>
  )

  /* ===== 一覧の中身（：読込中・読み込めない・空・0件を分ける） ===== */
  const sectionWord = activeSection === 'rich_video' ? 'リッチビデオのテンプレート' : activeSection === 'question' ? '質問のテンプレート' : 'メッセージのテンプレート'
  const listBody = renderTemplateList({ tokenNames, accountLoading, accounts, activeId, allOnPageSelected, bulkDeleting, canMutateTemplates, createHref: createKind.href, createLabel: createKind.title, lockedReason, clearFilters, clearSelection, contextMenuItems, contextTemplate, detailHref, duplicateFeedback, failure, filterActive, filteredTemplates, folderDotOf, load, moving, narrow, openMenuId, openMove: ids => requestUnsavedAction(() => detailGuard.protect(() => openMove(ids))), removableSelected, rowMenuItems, sectionWord, selectedAccountId, selectedCount, selectedIds, setActiveId: changeActiveId, setBulkDeleteError, setContextId, setOpenMenuId, setPendingBulkDelete: changeBulkDelete, setSelectedIds, shownItems, templates, toggleAllOnPage, toggleOne, usedSelectedCount, view })

  /* ページ送りは型の pagination 枠へ。件数は部品の summary に入れる（絵：左に「26件中 1〜20件」、右に頁。帯の内側は部品の 10・20）。 */
  const showPager = view === 'ready' && filteredTemplates.length > 0
  const listPager = !showPager ? null : (
    <Pagination page={safePage} pageCount={pageCount} onPageChange={setPage} range={{ total: filteredTemplates.length, first: (safePage - 1) * pageSize + 1, last: Math.min(safePage * pageSize, filteredTemplates.length) }} />
  )

  const assetScopeGuard = useRef<((action: () => void) => void) | null>(null)
  const setAssetScopeGuard = useCallback((guard: ((action: () => void) => void) | null) => { assetScopeGuard.current = guard }, [])
  const isTemplateSection = activeSection === 'message' || activeSection === 'question' || activeSection === 'rich_video'
  const switchSection = (next: Section) => {
    const change = () => requestUnsavedAction(() => {
      setUrlView({ tab: next, page: '1' })
      if (next === 'message' || next === 'question' || next === 'rich_video') setFolderSection(next)
      setSelectedIds(new Set())
    })
    if (assetScopeGuard.current) assetScopeGuard.current(change)
    else change()
  }

  /* 種類のタブ（件数つき）。閲覧のみの帯（）はタブの上。 */
  const tabs = (
    <>
      {!canMutateTemplates ? (
        <div className={styles.viewerBand}><ReadOnlyNotice role="status" data-design-node="hEDTK"></ReadOnlyNotice></div>
      ) : null}
      <Tabs
        size="compact"
        label="テンプレートの種類"
        items={[
          { label: 'メッセージ', count: loading ? undefined : templates.filter((t) => !t.question && !isRichVideoTemplate(t)).length, current: activeSection === 'message', onClick: () => switchSection('message') },
          { label: 'カルーセル', count: assetCounts.card_message, current: activeSection === 'card_message', onClick: () => switchSection('card_message') },
          { label: 'リッチメッセージ', count: assetCounts.rich_message, current: activeSection === 'rich_message', onClick: () => switchSection('rich_message') },
          { label: 'リッチビデオ', count: loading ? undefined : templates.filter(isRichVideoTemplate).length, current: activeSection === 'rich_video', onClick: () => switchSection('rich_video') },
          { label: '質問', count: loading ? undefined : templates.filter((t) => Boolean(t.question)).length, current: activeSection === 'question', onClick: () => switchSection('question') },
          { label: 'クーポン', count: assetCounts.coupon, current: activeSection === 'coupon', onClick: () => switchSection('coupon') },
          { label: 'リサーチ', count: assetCounts.research, current: activeSection === 'research', onClick: () => switchSection('research') },
        ]}
      />
    </>
  )

  const blockedRows = blockedUsage ? usageRows(blockedUsage) : []
  const blockedTotal = blockedDelete ? Math.max(blockedDelete.item.usageCount, blockedRows.length) : 0

  const overlays = <Fragment key={renderedScope.generation}><InlineDetailHoldingContext.Provider value={setFolderHolding}>{renderTemplateDialogs({ moveGuard, folderDeleteAccounts: deletingFolder?.accountId === null ? [] : [{ id: deletingFolder?.accountId ?? '', name: accounts.find(account => account.id === deletingFolder?.accountId)?.name }], cancelFolderDelete, deleteAccounts: targetAccounts(pendingDelete ? [pendingDelete.item] : []), bulkDeleteAccounts: targetAccounts(pendingBulkDelete ?? []), activeFolderName, activeIndex, activeTemplate, blockedDelete, blockedLoadError, blockedLoading, blockedRows, blockedTotal, blockedUsage, bulkDeleteError, bulkDeleting, canMutateTemplates, confirmDelete, deleteError, deleting, deletingFolder, detailHref, editHref, editingFolder, examples, examplesError, folderBusy, folderDialogOpen, folderError, folders, handleDelete, isTemplateSection, loadFolders, moveDraft, moveError, moveIds, moving, navItems, openMove, panelDetail, panelMove, panelUsageRows, pendingBulkDelete: bulkScope?.scope === accountScope.current ? pendingBulkDelete : null, pendingDelete: deleteScope?.scope === accountScope.current ? pendingDelete : null, pickerOpen, removeFolder, renameTemplate, router, runBulkDelete, runDuplicate, runMove, savedMenu, selectedAccountId, setActiveId: changeActiveId, setBlockedDelete, setBlockedUsage, setBulkDeleteError, setDeleteError, setDuplicateError, setEditingFolder, setExamplesRetry, setFolderDialogOpen, setFolderError, setMoveDraft, setMoveError, setMoveIds, setPanelMove, setPendingBulkDelete: changeBulkDelete, setPendingDelete: changePendingDelete, setPickerOpen, templates, detailGuard })}</InlineDetailHoldingContext.Provider>{detailGuard.dialog}<OverlayDepthContext.Provider value={overlayDepth + 2}><UnsavedLeaveDialog open={moveGuard.leaveTarget !== null} busy={moving && moveIds !== null} onConfirm={moveGuard.confirmLeave} onCancel={moveGuard.cancelLeave} /></OverlayDepthContext.Provider></Fragment>

  const heading = {
    title: 'テンプレート',
    help: '一斉配信・自動応答・シナリオなどで使う、メッセージのひな形です。直して公開すると、使っている所に反映されます。',
  }

  if (!isTemplateSection && selectedAccountId) {
    return <>{detailGuard.dialog}<AssetTemplatesList key={`${selectedAccountId}:${activeSection}`} kind={activeSection}
      accountId={selectedAccountId} tabs={tabs} canMutate={canMutateTemplates} onScopeGuardChange={setAssetScopeGuard}
      lockedReason={lockedReason} onChanged={() => void loadAssetCounts()} /></>
  }

  return (
    <SaveErrorScope errors={saveErrors}><ListPage heightMode="content" tableInset folderWidth={FOLDER_RAIL_WIDTH}
      skeleton
      boardId={narrow ? 'L7zA7C' : 'v19Ivv'}
      headingSize="regular"
      {...heading}
      actions={activeSection === 'message' ? <Button onClick={() => detailGuard.protect(openPicker)}
        disabled={!canMutateTemplates} lockedReason={lockedReason}>種類を選んで作る</Button> : undefined}
      tabs={tabs}
      stats={
        /* 数の帯 4つ。並びと間は共有の帯に任せる。 */
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
              loading={loading}
            />
          ))}
        </KpiBand>
      }
      folderNav={{ rows: folderRows, activeId: selectedCategory, onSelect: selectCategory, createAction: createButton(false) }}
      folders={folderPanel}
      toolbar={wideToolbar}
      pagination={listPager}
      overlays={overlays}
    >
      {listBody}
    </ListPage></SaveErrorScope>
  )
}
