'use client'

import { useFeatureAccess } from '@/lib/use-feature-access'
import { loadStaffIdentity, useStaffRole, canManageRole } from '@/lib/staff-role'
import { deleteMediaSelection } from './list-bulk-delete'
import { loadMediaDeleteImpact } from './list-delete-impact'
import { loadMediaFolders,loadMediaList,loadMediaSummary } from './list-load'

import { deleteMediaItem } from './list-delete-action'
import { MediaCardV8 } from './list-media-card'
import { isKnownUnused,KINDS,MediaDetailFailure,mediaDetailIdFromLocation,mediaDetailPath,MediaDetailPhase,MediaKpis,MediaManagementPermission,MediaSort,MediaView,PAGE_SIZE_OPTIONS,SORT_OPTIONS,UNGROUPED,usableMediaCounts } from './list-model'

import { describeApiFailure, classifyApiFailure,permissionDeniedMessage } from '@/components/shared/api-error-message'
import BulkBar from '@/components/shared/bulk-bar'
import Button from '@/components/shared/button'
import TextLink from '@/components/shared/text-link'
import Checkbox from '@/components/shared/checkbox'
import { collectListRows } from '@/components/shared/collect-list-rows'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import EmptyList from '@/components/shared/empty-list'
import { emptyValue } from '@/components/shared/empty-value'
import FilterChip from '@/components/shared/filter-chip'
import { type FolderDotFolder } from '@/components/shared/folder-dot'
import FolderSelect,{ folderById,folderCreator } from '@/components/shared/folder-select'
import { Field } from '@/components/shared/form-controls'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import ListState, { LOADING_MESSAGE } from '@/components/shared/list-state'
import ListToolbar from '@/components/shared/list-toolbar'
import { useListUrlSetValue,useListUrlValue } from '@/components/shared/list-url-state'
import ManagedFolderPanel from '@/components/shared/managed-folder-panel'
import Notice from '@/components/shared/notice'
import Pagination from '@/components/shared/pagination'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { SaveErrorField,SaveErrorScope,useSaveFormErrors } from '@/components/shared/save-form-errors'
import SegmentedControl from '@/components/shared/segmented'
import Select from '@/components/shared/select'
import { notifyToast } from '@/components/shared/toast'
import { ListPage } from '@/components/templates'
import { ListPageCards,ListPager } from '@/components/templates/list-page'
import ListRange from '@/components/ui/list-range'
import { useAccount } from '@/contexts/account-context'
import { api,ApiError,type MediaQuota } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import type { Folder,MediaDeleteImpact,MediaDeleteImpactReference,MediaItem } from '@line-crm/shared'
import { hasDeliveryAccess } from '@line-crm/shared'
import { Archive,EyeOff,HardDrive,Images,LayoutGrid,List as ListIcon,Plus } from 'lucide-react'
import { useCallback,useContext,useEffect,useRef,useState } from 'react'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { OverlayDepthContext } from '@/components/shared/overlay-utils'
import FileScanStoppedBanner from './file-scan-stopped-banner'
import styles from './list.module.css'
import { blockedReason,canDelete as canDeleteMedia,checkedAtText,dialogTitle,referenceKindText,referenceNameText,usageText } from './media-delete-impact'
import MediaDetailDialog from './media-detail-dialog'
import MediaPreviewOverlay from './media-preview-overlay'
import { MediaQuotaGuidance } from './media-quota-guidance'
import MediaReplacementDialog from './media-replacement-dialog'
import MediaUploadDialog from './media-upload-dialog'
import { formatMediaSize } from './media-usage-display'
import { TextField as SharedTextField } from '@/components/shared/text-field'

const EMPTY_KPIS: MediaKpis = {
  known: false,
  total: null,
  kindTotals: { image: null, audio: null, video: null, file: null },
  unusedTotal: null,
  archivedTotal: null,
}

export default function MediaLibraryListV8() {
  const saveErrors = useSaveFormErrors()
  const [view, setView] = useListUrlValue<MediaView>('view', 'grid')
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const latestAccountRef = useRef(selectedAccountId)
  latestAccountRef.current = selectedAccountId
  const accountScope = useRef({ id: selectedAccountId, generation: 0 })
  if (accountScope.current.id !== selectedAccountId) accountScope.current = { id: selectedAccountId, generation: accountScope.current.generation + 1 }
  const renderedScope = accountScope.current
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [items, setItems] = useState<MediaItem[]>([])
  const [total, setTotal] = useState(0)
  /*
    R38: `total` は絞り込み後の件数。フォルダ欄の「すべて」には絞り込み前の
    総数を出すため、同じ棚（アーカイブの扱い）で数えた総数を別に持つ。
  */
  const [overallTotal, setOverallTotal] = useState<number | null>(null)
  /*
    m26m: 一覧の総数が「分かっている」かどうか。初期値の total=0 や
    失敗時の残留値をそのまま出すと、実在する件を0件と誤案内する。
    成功したときだけ真にし、フォルダ欄の「すべて」と表の下の件数は
    真のときだけ出す（vars 側の listFailed と同じ約束）。
  */
  const [listKnown, setListKnown] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [quota, setQuota] = useState<MediaQuota | null>(null)
  const [quotaFailed, setQuotaFailed] = useState(false)
  /* 数の帯の4マス。種別・未使用・アーカイブの件数は1件だけ取って数を読む。 */
  const [kpis, setKpis] = useState<MediaKpis>(EMPTY_KPIS)
  const [error, setError] = useState('')
  const [folders, setFolders] = useState<Folder[]>([])
  // #721: 未分類の件数は GET /api/folders の unfiledCount をそのまま出す。
  // kind=media は件数未対応のため来ない。来ないときは null（「—」表示）。
  const [unfiledCount, setUnfiledCount] = useState<number | null>(null)
  /* カードの名前の前の丸は、左のフォルダの列と同じフォルダ（同じ色）を引く。無ければ未分類の輪。 */
  const folderDotOf = (folderId: string | null | undefined): FolderDotFolder | null => {
    const folder = folderId ? folders.find((f) => f.id === folderId) : undefined
    return folder ? { name: folder.name, color: folder.color } : null
  }
  /*
    R587: フォルダの取得失敗は一覧・容量と切り分ける。フォルダだけ503でも
    取得済みのメディアと容量は見せ、フォルダ欄だけ失敗と再試行を示す。
  */
  const [folderFailure, setFolderFailure] = useState<unknown>(null)
  const [folderReloading, setFolderReloading] = useState(false)
  const [folderFilter, setFolderFilter] = useListUrlValue('folderFilter', '')
  /*
    R37: フォルダの名前・色・並べ替え・削除は共通のフォルダの列（ManagedFolderPanel）の「…」から。
    追加だけあって直し・消しが無いと、整理し直す手段が無い。
  */
  const [uploadOpen, setUploadOpen] = useState(false)
  /* 札の操作は「…」へ集める。行末にボタンは1つも置かない。 */
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)

  const [kinds, setKinds] = useListUrlSetValue<MediaItem['kind']>('kinds', KINDS.map((k) => k.key))
  const [query, setQuery] = useListUrlValue('q', '')
  const [showUnusedOnly, setShowUnusedOnly] = useListUrlValue('showUnusedOnly', false)
  const [showNearLimitOnly, setShowNearLimitOnly] = useListUrlValue('showNearLimitOnly', false)
  /** 退避済みだけを見る棚。普段の一覧には出ない。 */
  const [showArchivedOnly, setShowArchivedOnly] = useListUrlValue('showArchivedOnly', false)
  /*
    退避・一覧への復帰はどちらも理由が必須（あとから「なぜ」を追えるように）。
    押し口を開いた札と向きを持ち、確定時に同じ窓で理由を聞く。
  */
  const [archiveTarget, setArchiveTarget] = useState<{ item: MediaItem; mode: 'archive' | 'restore' } | null>(null)
  const [archiveReason, setArchiveReason] = useState('')
  const [archiveBusy, setArchiveBusy] = useState(false)
  const [archiveError, setArchiveError] = useState('')
  /* フォルダへ移す窓。移し先だけを選び、確定で PATCH する。 */
  const [moveTarget, setMoveTarget] = useState<MediaItem | null>(null)
  const [moveFolderId, setMoveFolderId] = useState('')
  const [moveBusy, setMoveBusy] = useState(false)
  const [moveError, setMoveError] = useState('')
  const [sort, setSort] = useListUrlValue<MediaSort>('sort', 'newest')
  const [pageSize, setPageSize] = useListUrlValue('pageSize', 20)
  const [page, setPage] = useListUrlValue('page', 1)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  /** 名前を直している札。null なら誰も直していない。 */
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  // 名前変更の多重押し防ぎと、札のそばに出す失敗文。一覧全体の欄には出さない。
  const [renamingBusy, setRenamingBusy] = useState(false)
  const [renameError, setRenameError] = useState('')
  const depth = useContext(OverlayDepthContext)
  const renameOriginal = renaming ? items.find(item => item.id === renaming.id)?.filename : undefined
  const editBusy = renamingBusy || (archiveTarget !== null && archiveBusy) || (moveTarget !== null && moveBusy)
  const guard = useUnsavedGuard({
    dirty: Boolean((renaming && renaming.value !== renameOriginal) || (archiveTarget && archiveReason) || (moveTarget && moveFolderId !== (moveTarget.folderId ?? '')) || editBusy),
    busy: editBusy,
    onDiscard: () => { setRenaming(null); setArchiveTarget(null); setArchiveReason(''); setMoveTarget(null); setMoveFolderId('') },
  })
  /** 取得中の札。保存URLへ直接行かず、認証と監査を通る口から受け取る。 */
  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(new Set())

  /**
   * 管理画面の表示は認証付きの口だけを使う。item.url は配信用の公開URL
   * （配信本文に埋めてLINEが取りに行く）で、画面の表示には使わない。
   * 札はアカウントを選んだときだけ並ぶので、空のときは出さない。
   */
  const displaySrc = (item: MediaItem): string =>
    selectedAccountId ? api.media.contentUrl(item.id, selectedAccountId) : ''
  const [urlReady, setUrlReady] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [detailsFor, setDetailsFor] = useState<MediaItem | null>(null)
  const [detailFolderName, setDetailFolderName] = useState<string | null>(null)
  const [detailPhase, setDetailPhase] = useState<MediaDetailPhase>('idle')
  const [detailFailure, setDetailFailure] = useState<MediaDetailFailure | null>(null)
  const [detailRetry, setDetailRetry] = useState(0)
  const detailRequestRef = useRef(0)
  const detailAccountRef = useRef<string | null | undefined>(undefined)
  const [replacementFor, setReplacementFor] = useState<MediaItem | null>(null)
  /*
    1件ずつの削除確認（設計 `YfTfJ`）。**窓を開けてから読む。**
    一覧を出すたびに全件ぶん読むと、消さない人にも7種類の走査が走る。
  */
  const [deleting, setDeleting] = useState<MediaItem | null>(null)
  const [impact, setImpact] = useState<MediaDeleteImpact | null>(null)
  const [impactPhase, setImpactPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  /*
    いま影響を読んでいる対象。遅れて返った別の結果を捨てるために持つ。

    **メディアIDだけでは足りない。** 同じメディアを開き直したときや、
    アカウントを変えたあとに前の要求の返事が届いたときを止められない。
    アカウント・メディア・読み込み回数の3つで照合する。
  */
  const impactRequestRef = useRef<{ accountId: string | null; mediaId: string | null; generation: number }>({
    accountId: null,
    mediaId: null,
    generation: 0,
  })
  /** 削除要求そのものも、アカウント切替や窓の閉鎖後に結果を映さない。 */
  const deleteRequestRef = useRef(0)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  /** まとめて削除の確認。ブラウザ標準の確認では戻せないことが伝わらない。 */
  const [bulkConfirm, setBulkConfirm] = useState<string[] | null>(null)
  const [bulkContext, setBulkContext] = useState<{ scope: typeof renderedScope; ticket: object; accounts: string[] } | null>(null)
  const bulkTicket = useRef<object | null>(null)
  const singleTicket = useRef<object | null>(null)
  const [singleContext, setSingleContext] = useState<{ scope: typeof renderedScope; ticket: object } | null>(null)
  const singleLock = useRef(false)
  const bulkLock = useRef(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  /** まとめて削除の進み具合。件数が多いときに止まっているように見せない。 */
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null)
  /** 大きく出している札。押した札の中身を原寸で見せる。 */
  const [preview, setPreview] = useState<MediaItem | null>(null)
  /** 管理操作は確認済みの機能権限で判定し、取得失敗時は止める。 */
  const [mediaManagementPermission, setMediaManagementPermission] = useState<MediaManagementPermission>('loading')
  const staffRole = useStaffRole()
  const canRegisterMedia = canManageRole(staffRole) || staffRole === 'staff'
  const mediaEditAccess = useFeatureAccess('contents')

  const setDetailUrl = useCallback((id: string | null, mode: 'push' | 'replace' = 'push') => {
    const nextUrl = mediaDetailPath(id, selectedAccountId)
    if (mode === 'replace') window.history.replaceState(window.history.state, '', nextUrl)
    else window.history.pushState(window.history.state, '', nextUrl)
    setDetailId(id)
  }, [selectedAccountId])

  useEffect(() => {
    const syncFromUrl = () => setDetailId(mediaDetailIdFromLocation())
    syncFromUrl()
    setUrlReady(true)
    window.addEventListener('popstate', syncFromUrl)
    return () => window.removeEventListener('popstate', syncFromUrl)
  }, [])

  useEffect(() => {
    let active = true
    void loadStaffIdentity().then((response) => {
      if (!active) return
      if (!response.success) {
        setMediaManagementPermission('error')
        return
      }
      setMediaManagementPermission(
        hasDeliveryAccess(response.data, 'contents', 'edit') ? 'allowed' : 'denied',
      )
      // Registration is available to staff, while a view-only session cannot
      // write. Use the same verified identity as the management controls.
    }).catch(() => {
      if (active) setMediaManagementPermission('error')
    })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!urlReady || accountLoading) return
    const targetAccount = new URL(window.location.href).searchParams.get('mediaAccountId')
    if (detailId && targetAccount && targetAccount !== selectedAccountId) {
      setDetailUrl(null, 'replace')
      return
    }
    const previousAccount = detailAccountRef.current
    detailAccountRef.current = selectedAccountId
    if (previousAccount !== undefined && previousAccount !== selectedAccountId) {
      detailRequestRef.current += 1
      setDetailsFor(null)
      setDetailFolderName(null)
      setDetailPhase('idle')
      if (detailId) setDetailUrl(null, 'replace')
      return
    }
    const request = detailRequestRef.current + 1
    detailRequestRef.current = request
    setDetailsFor(null)
    setDetailFolderName(null)
    setDetailFailure(null)
    if (!detailId) {
      setDetailPhase('idle')
      return
    }
    if (!selectedAccountId) {
      setDetailPhase('unavailable')
      setDetailFailure('missing')
      return
    }
    const accountAtRequest = selectedAccountId
    setDetailPhase('loading')
    void api.media.detail(detailId, accountAtRequest).then((response) => {
      if (detailRequestRef.current !== request || latestAccountRef.current !== accountAtRequest) return
      if (!response.success) {
        setDetailPhase('unavailable')
        // R588: 原因不明の失敗を「存在しない」と断定しない。読み直せる側に倒す。
        setDetailFailure('retryable')
        return
      }
      setDetailsFor(response.data.item)
      setDetailFolderName(response.data.folderName)
      setDetailPhase('ready')
    }).catch((caught) => {
      if (detailRequestRef.current === request && latestAccountRef.current === accountAtRequest) {
        setDetailPhase('unavailable')
        // R588: 404は対象なし、403は権限案内、それ以外は通信失敗として再試行させる。
        setDetailFailure(
          caught instanceof ApiError && caught.status === 404
            ? 'missing'
            : caught instanceof ApiError && caught.status === 403
              ? 'denied'
              : 'retryable',
        )
      }
    })
    return () => {
      if (detailRequestRef.current === request) detailRequestRef.current += 1
    }
  }, [accountLoading, detailId, detailRetry, selectedAccountId, setDetailUrl, urlReady])

  /** R588: 通信失敗の詳細は同じIDで読み直す。URLは変えない。 */
  const retryDetail = useCallback(() => {
    if (!detailId) return
    setDetailFailure(null)
    setDetailPhase('loading')
    setDetailRetry((count) => count + 1)
  }, [detailId])

  const canManageMedia = mediaManagementPermission === 'allowed' && mediaEditAccess
  const canManageRef = useRef(canManageMedia); canManageRef.current = canManageMedia
  const managementPermissionReason = mediaManagementPermission === 'loading'
    ? LOADING_MESSAGE
    : mediaManagementPermission === 'error'
      ? '操作権限を確認できないため、安全のため管理操作を止めています'
      : '使用箇所の確認・名前の変更・削除・フォルダの追加は管理者だけができます'

  useEffect(() => {
    /*
      アカウントを切り替えた瞬間に、前の窓と読み込み・削除要求を無効にする。
      ref の accountId は要求開始時の値なので、世代も進めなければ前の返事が
      そのまま「現在」と判定される。
    */
    impactRequestRef.current = {
      accountId: selectedAccountId,
      mediaId: null,
      generation: impactRequestRef.current.generation + 1,
    }
    deleteRequestRef.current += 1
    setDeleting(null)
    setImpact(null)
    setImpactPhase('idle')
    setDeleteBusy(false)
    setDeleteError('')
    setBulkConfirm(null)
    setBulkBusy(false)
    setBulkProgress(null)
    setArchiveTarget(null)
    setArchiveError('')
    setMoveTarget(null)
    setMoveError('')
  }, [selectedAccountId])

  /*
    R587: フォルダは一覧・容量と独立して読む。フォルダだけ503でも
    取得済みのメディアと容量は見せたままにする。
  */
  const loadFolders = useCallback(() => loadMediaFolders({ latestAccountRef, saveErrors, selectedAccountId, setFolderFailure, setFolderReloading, setFolders, setUnfiledCount }), [selectedAccountId, saveErrors])

  /*
    WEB097: 同じアカウントの中でも、検索・絞り込み・ページを変えるたびに新しい要求を出す。
    遅い検索 A の返事が速い検索 B の結果を上書きしないよう、最後に出した要求の世代だけを反映する。
    失敗の表示と「読み込み中」の解除も最新の要求だけが行う。
  */
  const listSeqRef = useRef(0)
  const summarySeqRef = useRef(0)

  const loadList = useCallback(() => loadMediaList({ folderFilter, kinds, latestAccountRef, listSeqRef, page, pageSize, query, saveErrors, selectedAccountId, setError, setItems, setListKnown, setLoadFailed, setLoading, setTotal, showArchivedOnly, showNearLimitOnly, showUnusedOnly, sort }), [folderFilter, kinds, page, pageSize, query, selectedAccountId, showArchivedOnly, showNearLimitOnly, showUnusedOnly, sort, saveErrors])

  /*
    WEB098: 容量と「すべて」の総数は検索・ページ送り・種別では変わらない。
    アカウントとアーカイブの表示を変えたとき、または変えた後（load）だけ読み直す。
    R587: 一覧の失敗で容量まで隠さない（別々に成否を決める）。
  */
  const loadSummary = useCallback(() => loadMediaSummary({ latestAccountRef, selectedAccountId, setOverallTotal, setQuota, setQuotaFailed, showArchivedOnly, summarySeqRef }), [selectedAccountId, showArchivedOnly])

  /** 変えた後の読み直し。一覧と容量・総数の両方を読む（フォルダ・数の帯は呼ぶ側が決める）。 */
  const load = useCallback(async () => {
    await Promise.all([loadList(), loadSummary()])
  }, [loadList, loadSummary])

  /*
    数の帯は絞り込み・ページ送りでは変わらない。種別・未使用・保管済みの
    件数を既存の一括集計で読む。一覧の部分件数を総数へ流用しない。
    失敗したマスは null のまま「—」で出す（偽ゼロを置かない）。
  */
  const loadKpis = useCallback(async () => {
    const accountAtRequest = selectedAccountId
    if (!accountAtRequest) {
      setKpis(EMPTY_KPIS)
      return
    }
    const response = await api.media.counts(accountAtRequest).catch(() => null)
    if (accountAtRequest !== latestAccountRef.current) return
    /*
      集計の形が違う（古いAPIや画面確認の見本）・失敗のときは、
      数の帯を「—（未取得）」のままにする。一覧の口を読み直して数を作らない。
      画面は落とさず、偽ゼロも置かない。
    */
    const counts = response?.success ? usableMediaCounts(response.data) : null
    if (!counts) {
      setKpis(EMPTY_KPIS)
      return
    }
    setKpis({
      known: true,
      total: null,
      kindTotals: counts.byKind,
      unusedTotal: counts.unused,
      archivedTotal: counts.archived,
    })
  }, [selectedAccountId])

  useEffect(() => {
    if (accountLoading) return
    setSelected(new Set())
    setDetailsFor(null)
    setReplacementFor(null)
    setPreview(null)
    setPage(1)
    // m26m: 別アカウントの総数を残さない。読み直すまで「すべて」は未知。
    setListKnown(false)
    setOverallTotal(null)
    setKpis(EMPTY_KPIS)
  }, [accountLoading, selectedAccountId])

  /*
    WEB098: 一覧・容量と総数・フォルダは変わる時が違うので、別々に読む。
    検索・ページ送りで読み直すのは一覧だけ。
  */
  useEffect(() => {
    if (!accountLoading && urlReady && !detailId) void loadList()
  }, [accountLoading, detailId, loadList, urlReady])

  useEffect(() => {
    if (!accountLoading && urlReady && !detailId) void loadSummary()
  }, [accountLoading, detailId, loadSummary, urlReady])

  useEffect(() => {
    // R587: フォルダの成否は一覧・容量と切り分ける。
    if (!accountLoading && urlReady && !detailId) void loadFolders()
  }, [accountLoading, detailId, loadFolders, urlReady])

  /*
    数の帯は絞り込み・ページ送りでは変わらない。アカウントが変わったときと、
    変えたあと（削除・退避・登録の確定で loadKpis を呼ぶ）だけ読み直す。
  */
  useEffect(() => {
    if (!accountLoading && urlReady && !detailId) {
      void loadKpis()
    }
  }, [accountLoading, detailId, loadKpis, urlReady])

  const rename = async () => {
    if (!renaming || !selectedAccountId || renamingBusy) return
    const accountAtRequest = selectedAccountId
    const filename = renaming.value.trim()
    if (!filename) return
    setRenamingBusy(true)
    setRenameError('')
    try {
      const res = await api.media.update(renaming.id, accountAtRequest, { filename })
      if (accountAtRequest !== latestAccountRef.current) return
      if (!res.success) {
        setRenameError(`「${renaming.value}」に変更できませんでした。${res.error}`)
        return
      }
      setRenaming(null)
      void load()
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setRenameError('名前の変更に失敗しました。もう一度お試しください。') }
    } finally {
      setRenamingBusy(false)
    }
  }

  /** 選んだ札をまとめて消す。使用中はAPIでも必ず止める。 */
  const removeSelected = async () => {
    if (selected.size === 0 || !selectedAccountId || !mounted.current || !canManageRef.current || renderedScope !== accountScope.current) return
    const removableSelected = [...selected].filter((id) =>
      [...items, ...selectionItems].some((item) => item.id === id && isKnownUnused(item)),
    )
    if (removableSelected.length !== selected.size) {
      setSelected(new Set(removableSelected))
      setError('使用先を確認できないメディアは削除できません。状態を読み直して確認してください。')
      return
    }
    /*
      **ブラウザ標準の確認を使わない。** 何件消えるかは出るが、
      戻せないことも、どこにも使われていないと確かめた結果も出ない。
      画面の中の窓で読み合わせてから押させる。
    */
    const ticket = {}; bulkTicket.current = ticket
    const accounts = [...new Set(removableSelected.map(id => [...items, ...selectionItems].find(item => item.id === id)?.lineAccountId ?? ''))]
    setBulkContext({ scope: renderedScope, ticket, accounts })
    setBulkConfirm(removableSelected)
  }

  function runBulkDelete(ids: string[]) {
    const context = bulkContext
    const current = () => mounted.current && canManageRef.current && context?.scope === accountScope.current && context.ticket === bulkTicket.current
    if (!current() || bulkLock.current) return
    bulkLock.current = true
    void deleteMediaSelection({ items, latestAccountRef, load, loadKpis, saveErrors, selectedAccountId, selectionItems, setBulkBusy, setBulkConfirm, setBulkProgress, setError, setSelected, isCurrent: current }, ids).finally(() => {
      bulkLock.current = false
      if (mounted.current && context?.scope === accountScope.current && context.ticket === bulkTicket.current) {
        bulkTicket.current = null; setBulkBusy(false); setBulkConfirm(null); setBulkProgress(null)
      }
    })
  }

  /**
   * 札のダウンロード。保存URL（認証なし）へ直接リンクせず、
   * 権限確認と監査を通る口から受け取って保存させる。
   */
  async function downloadItem(item: MediaItem) {
    const accountAtRequest = selectedAccountId
    if (!accountAtRequest || downloadingIds.has(item.id)) return
    setDownloadingIds((current) => new Set(current).add(item.id))
    try {
      const blob = await api.media.download(item.id, accountAtRequest)
      const href = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = href
      anchor.download = item.filename
      anchor.click()
      URL.revokeObjectURL(href)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)


      setError(describeApiFailure(caught, 'ダウンロード')) }
    } finally {
      setDownloadingIds((current) => {
        const next = new Set(current)
        next.delete(item.id)
        return next
      })
    }
  }

  function openDelete(item: MediaItem) {
    if (!mounted.current || !canManageRef.current || renderedScope !== accountScope.current) return
    const ticket = {}; singleTicket.current = ticket; setSingleContext({ scope: renderedScope, ticket })
    return loadMediaDeleteImpact({ deleteRequestRef, impactRequestRef, saveErrors, selectedAccountId, setDeleteError, setDeleting, setImpact, setImpactPhase }, item)
  }

  async function confirmDeleteOne() {
    if (!mounted.current || !canManageRef.current || !singleContext || singleContext.scope !== accountScope.current || singleContext.ticket !== singleTicket.current || singleLock.current || impactRequestRef.current.accountId !== selectedAccountId || impactRequestRef.current.mediaId !== deleting?.id) return
    singleLock.current = true
    try {
      const success = await deleteMediaItem({ deleteBusy, deleteRequestRef, deleting, impactRequestRef, latestAccountRef, load, loadKpis, saveErrors, selectedAccountId, setDeleteBusy, setDeleteError, setDeleting, setImpact, setImpactPhase })
      if (success && singleContext.ticket === singleTicket.current) singleTicket.current = null
    } finally { singleLock.current = false }
  }

  function closeDeleteDialog() {
    singleTicket.current = null
    impactRequestRef.current = {
      accountId: selectedAccountId,
      mediaId: null,
      generation: impactRequestRef.current.generation + 1,
    }
    deleteRequestRef.current += 1
    setDeleting(null)
    setImpact(null)
    setImpactPhase('idle')
    setDeleteBusy(false)
    setDeleteError('')
  }

  /**
   * 退避・復帰の確定。両方とも理由が必須。409（直前に誰かが同じ操作を
   * 済ませた）は一覧を読み直して最新の見え方に合わせる。
   */
  async function confirmArchiveChange() {
    if (!archiveTarget || !selectedAccountId || archiveBusy) return
    const reason = archiveReason.trim()
    if (!reason) return
    const accountAtRequest = selectedAccountId
    const { item, mode } = archiveTarget
    setArchiveBusy(true)
    setArchiveError('')
    try {
      const res = mode === 'archive'
        ? await api.media.archive(item.id, accountAtRequest, reason)
        : await api.media.restore(item.id, accountAtRequest, reason)
      if (accountAtRequest !== latestAccountRef.current) return
      if (!res.success) {
        setArchiveError(`処理できませんでした。${res.error}`)
        void load()
        return
      }
      setArchiveTarget(null)
      notifyToast(mode === 'archive'
        ? `「${item.filename}」をアーカイブしました。使っている場所はそのまま動き、一覧と新規選択からだけ外れます。`
        : `「${item.filename}」を一覧へ戻しました。`)
      void load()
      void loadKpis()
    } catch (e) {
      const fieldFailure = saveErrors.capture(e)
      /*
        fetchApi は 2xx 以外で ApiError を投げる。409（直前に誰かが
        同じ操作を済ませた）は汎用エラーで止めず、一覧を読み直して
        最新の見え方に合わせる。
      */
      if (e instanceof ApiError && e.status === 409) {
        { if (!fieldFailure)
        setArchiveError(mode === 'archive'
          ? 'このメディアは既にアーカイブ済みです。一覧を読み直しました。'
          : 'このメディアは既に一覧へ戻っています。一覧を読み直しました。') }
        void load()
        return
      }
      { if (!fieldFailure)
      setArchiveError('処理に失敗しました。もう一度お試しください。') }
    } finally {
      setArchiveBusy(false)
    }
  }

  /**
   * フォルダへ移す確定。未分類へ戻すときは null を渡す。
   * 二重押しは止め、競合（409）は一覧を読み直して最新の見え方に合わせる。
   */
  async function confirmMove() {
    if (!moveTarget || !selectedAccountId || moveBusy) return
    const accountAtRequest = selectedAccountId
    const { id, filename } = moveTarget
    setMoveBusy(true)
    setMoveError('')
    try {
      const res = await api.media.update(id, accountAtRequest, {
        folderId: moveFolderId || null,
      })
      if (accountAtRequest !== latestAccountRef.current) return
      if (!res.success) {
        setMoveError(`移動できませんでした。${res.error}`)
        return
      }
      setMoveTarget(null)
      notifyToast(`「${filename}」を${moveFolderId ? 'フォルダへ移しました。' : '未分類へ移しました。'}`)
      void load()
      void loadFolders()
    } catch (e) {
      const fieldFailure = saveErrors.capture(e);

      if (e instanceof ApiError && e.status === 409) {
        { if (!fieldFailure)
        setMoveError('直前に誰かが変えたため、移動できませんでした。一覧を読み直しました。') }
        void load();

        return
      }
      { if (!fieldFailure)
      setMoveError('移動に失敗しました。もう一度お試しください。') }
    } finally {
      setMoveBusy(false)
    }
  }

  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const current = items

  /*
    R38: 絞り込みが1つでも効いているか。「すべて」の選び方・0件表示・
    フォルダ欄の件数を使い分ける。
  */
  const hasFilter = query.trim() !== ''
    || folderFilter !== ''
    || kinds.size !== KINDS.length
    || showUnusedOnly
    || showNearLimitOnly
    || showArchivedOnly

  /** R38: 「条件に合うものがありません」の次に置く、条件を外す口。 */
  const clearFilters = () => {
    setQuery('')
    setFolderFilter('')
    setKinds(new Set(KINDS.map((kind) => kind.key)))
    setShowUnusedOnly(false)
    setShowNearLimitOnly(false)
    setShowArchivedOnly(false)
    setPage(1)
  }

  /** 数の帯の押し口。帯のマスを選ぶと対応する絞り込みになる。 */
  const applyUnusedFilter = () => {
    setShowUnusedOnly(true)
    setShowNearLimitOnly(false)
    setShowArchivedOnly(false)
    setKinds(new Set(KINDS.map((kind) => kind.key)))
    setPage(1)
  }
  const applyNearLimitFilter = () => {
    setShowNearLimitOnly(true)
    setShowUnusedOnly(false)
    setShowArchivedOnly(false)
    setKinds(new Set(KINDS.map((kind) => kind.key)))
    setPage(1)
  }
  const applyArchivedFilter = () => {
    setShowArchivedOnly(true)
    setShowUnusedOnly(false)
    setShowNearLimitOnly(false)
    setKinds(new Set(KINDS.map((kind) => kind.key)))
    setPage(1)
  }

  useEffect(() => {
    if (page > pageCount) setPage(pageCount)
  }, [page, pageCount])

  // まとめて削除の候補は未使用かつ一覧にいるものだけ。退避済みは選ばない。
  const [selectionItems, setSelectionItems] = useState<MediaItem[]>([])
  const [selectionTotal, setSelectionTotal] = useState<number | undefined>(undefined)
  const [selectionLoading, setSelectionLoading] = useState(false)
  const [selectionError, setSelectionError] = useState('')
  const selectionScope = JSON.stringify([selectedAccountId, folderFilter, query, [...kinds].sort(), showNearLimitOnly, showArchivedOnly, sort])
  const selectionScopeRef = useRef(selectionScope)
  selectionScopeRef.current = selectionScope
  useEffect(() => { setSelected(new Set()); setSelectionItems([]); setSelectionTotal(undefined); setSelectionLoading(false); setSelectionError('') }, [selectionScope])
  const readSelectableMedia = useCallback(async () => {
    const account = selectedAccountId
    const scope = selectionScope
    if (!account) return
    setSelectionLoading(true)
    setSelectionError('')
    try {
      const all = await collectListRows(total, async (offset, limit) => {
        const response = await api.media.list(account, { kind: kinds.size === 1 ? [...kinds][0] : undefined, folderId: folderFilter || undefined, query: query.trim() || undefined, unusedOnly: true, nearLimitOnly: showNearLimitOnly, archived: showArchivedOnly ? 'only' : undefined, sort, limit, offset })
        if (!response.success) throw new Error('読み込めませんでした')
        return response.data
      })
      if (scope !== selectionScopeRef.current) return
      const eligible = all.filter(item => isKnownUnused(item) && !item.archivedAt && kinds.has(item.kind))
      setSelectionItems(eligible)
      setSelectionTotal(eligible.length)
    } catch {
      if (scope === selectionScopeRef.current) setSelectionError('すべての対象を読み込めませんでした。')
    } finally {
      if (scope === selectionScopeRef.current) setSelectionLoading(false)
    }
  }, [selectedAccountId, selectionScope, total, kinds, folderFilter, query, showNearLimitOnly, showArchivedOnly, sort])
  useEffect(() => {
    if (selected.size > 0 && selectionTotal === undefined && !selectionLoading && !selectionError) void readSelectableMedia()
  }, [selected.size, selectionTotal, selectionLoading, selectionError, readSelectableMedia])
  const selectAllMedia = () => {
    if (selectionTotal === undefined) return
    setSelected(new Set(selectionItems.map(item => item.id)))
  }
  const removable = items.filter((item) => isKnownUnused(item) && !item.archivedAt)
  const allSelected = removable.length > 0 && removable.every((item) => selected.has(item.id))
  /** R587: フォルダ欄の失敗は403（権限）とそれ以外（通信）で案内を分ける。 */
  const folderForbidden = folderFailure != null && classifyApiFailure(folderFailure) === 'forbidden'

  /* 数の帯の文言。失敗・未取得は「—」で出し、偽ゼロを置かない。 */
  const kpiTotalText = !listKnown || loadFailed || overallTotal === null ? emptyValue('unknown') : formatNumber(overallTotal)
  const kindBreakdown = KINDS
    .map((kind) => (kpis.kindTotals[kind.key] == null ? null : `${kind.label}${formatNumber(kpis.kindTotals[kind.key] as number)}`))
    .filter((text): text is string => text !== null)
    .join('・')
  const unusedText = kpis.unusedTotal == null ? emptyValue('unknown') : formatNumber(kpis.unusedTotal)
  const archivedText = kpis.archivedTotal == null ? emptyValue('unknown') : formatNumber(kpis.archivedTotal)
  const quotaPercent = quota && quota.limitBytes > 0
    ? Math.round((quota.usageBytes / quota.limitBytes) * 100)
    : null

  if (!urlReady || (detailId && (detailPhase === 'idle' || detailPhase === 'loading'))) {
    return <SaveErrorScope errors={saveErrors}><ListState kind="loading" title="メディアの詳細を読み込んでいます" /></SaveErrorScope>
  }

  if (detailId && (detailPhase === 'unavailable' || !detailsFor)) {
    // R588: 403は権限案内を残し、権限変更後に同じIDを読み直せる。
    if (detailFailure === 'denied') {
      return (
        <SaveErrorScope errors={saveErrors}><ListState
          kind="forbidden"
          onRetry={retryDetail}
          title="メディアの詳細を見る権限がありません"
          description={permissionDeniedMessage('store')}
          action={<Button type="button" onClick={() => setDetailUrl(null)}>登録メディア一覧へ戻る</Button>}
        /></SaveErrorScope>
      )
    }
    // R588: 503などの通信失敗は通信失敗と言い、同じIDで読み直せるようにする。
    if (detailFailure === 'retryable') {
      return (
        <SaveErrorScope errors={saveErrors}><ListState
          kind="error"
          title="表示できませんでした"
          description="通信が切れたか、サーバが応えませんでした。登録した内容は消えていません。"
          onRetry={retryDetail}
          action={<Button type="button" onClick={() => setDetailUrl(null)}>登録メディア一覧へ戻る</Button>}
        /></SaveErrorScope>
      )
    }
    return (
      <SaveErrorScope errors={saveErrors}><ListState
        kind="empty"
        title="メディアの詳細を開けません"
        description="メディアが存在しないか、このLINEアカウントでは表示できません。"
        action={<Button type="button" onClick={() => setDetailUrl(null)}>登録メディア一覧へ戻る</Button>}
      /></SaveErrorScope>
    )
  }

  if (detailsFor) {
    return (
      <SaveErrorScope errors={saveErrors}><MediaDetailDialog
        item={detailsFor}
        accountId={selectedAccountId}
        folderName={detailsFor.folderId ? detailFolderName ?? '—（未取得）' : '未分類'}
        canManage={canManageMedia}
        onClose={() => setDetailUrl(null)}
        onOpenReplacement={(item) => {
          setDetailUrl(null)
          setReplacementFor(item)
        }}
        onVersionCreated={(message) => {
          setDetailUrl(null)
          notifyToast(message)
          void load()
          void loadKpis()
        }}
        onItemUpdated={(updated) => setDetailsFor(updated)}
      /></SaveErrorScope>
    )
  }

  /* 種類と状態の絞り込みのうち、絵の札（画像・どこでも使っていない）に無いものは「ほかの絞り込み」から選ぶ。 */
  const otherFilterValue = showArchivedOnly ? 'archived' : showNearLimitOnly ? 'near-limit'
    : kinds.size === 1 && !kinds.has('image') ? [...kinds][0] : ''
  const applyOtherFilter = (value: string) => {
    if (value === 'archived') applyArchivedFilter()
    else if (value === 'near-limit') applyNearLimitFilter()
    else if (value === 'video' || value === 'audio' || value === 'file') {
      setKinds(new Set([value as MediaItem['kind']]))
      setShowUnusedOnly(false)
      setShowNearLimitOnly(false)
      setShowArchivedOnly(false)
      setPage(1)
    } else {
      clearFilters()
    }
  }
  const kpiCards = [
    { key: 'total', title: '登録メディア', icon: Images, value: kpiTotalText === '—' ? null : overallTotal, unit: '件', detail: kindBreakdown || '—（未取得）' },
    { key: 'unused', title: 'どこでも使っていない', icon: EyeOff, value: kpis.unusedTotal ?? null, unit: '件', detail: '消してよいか確かめられます' },
    { key: 'usage', title: '使っている容量', icon: HardDrive, value: null, valueText: quota ? formatMediaSize(quota.usageBytes).split(' ')[0] : undefined, valueTextWithUnit: true, unit: quota ? formatMediaSize(quota.usageBytes).split(' ')[1] : '', detail: quota && quotaPercent != null ? `上限 ${formatMediaSize(quota.limitBytes)} の ${quotaPercent}%` : '—（未取得）' },
    { key: 'archived', title: 'アーカイブ', icon: Archive, value: kpis.archivedTotal ?? null, unit: '件', detail: '一覧と新規選択から外したもの' },
  ]

  /* 登録と取得は担当者も使える（今と同じ）。消す・移す・名前を変えるは管理者だけ。 */
  const uploadButton = canRegisterMedia ? (
    <Button type="button" variant="primary" className="v8-folder-create w-full" onClick={() => setUploadOpen(true)}>
      <Plus size={16} aria-hidden="true" />メディアを登録する
    </Button>
  ) : null
  const selectFolder = (id: string) => {
    setFolderFilter(id)
    setPage(1)
  }
  const mediaFolderRows = [
    // R38: 「すべて」は絞り込み前の総数。絞り込み後の件数を
    // 入れると「すべて0・未分類2」のように母集団が混ざる。
    // m26m: 一覧が読めていない（初回・失敗・別アカウント切替直後）の
    // total=0 は偽ゼロなので数えない（null は数を出さない約束）。
    { kind: 'all' as const, id: '', label: 'すべて', count: listKnown && !loadFailed ? overallTotal : null },
    ...folders.map((folder) => ({
      kind: 'folder' as const,
      id: folder.id,
      label: folder.name,
      // #721: フォルダ件数はAPI(itemCount)をそのまま出す。kind=media
      // は件数未対応で来ないため「—」になる。読み込み済み範囲だけを
      // 数える計算は、黙って別の母集団にすり替わるため廃止。
      count: folder.itemCount ?? null,
      color: folder.color,
    })),
    { kind: 'unfiled' as const, id: UNGROUPED, label: '未分類', count: unfiledCount },
  ]

  return (
    <SaveErrorScope errors={saveErrors}><ListPage heightMode="content"
      skeleton
      contentInset
      boardId="O7hUt7"
      toolbarRowGap="card"
      headingSize="regular"
      title="登録メディア一覧"
      help="配信で使う画像・動画・音声・ファイルの置き場です。LINE アカウントごとに管理します。"
      explanation="使っているメディアは消せません。いらなくなったら「アーカイブ」にすると一覧と新規選択から外れます（使っている場所や過去の配信はそのまま動きます）。"
      tabs={!canManageMedia && mediaManagementPermission !== 'loading' ? (
        <div className={styles.roBand}><ReadOnlyNotice role="note">{`閲覧のみで見ています。${managementPermissionReason}。`}</ReadOnlyNotice></div>
      ) : undefined}
      stats={(
        <KpiBand aria-label="登録メディアの集計">
          {kpiCards.map((card) => (
            <KpiCard
              key={card.key}
              presentation="band"
              title={card.title}
              icon={<card.icon size={16} aria-hidden="true" />}
              value={card.value}
              valueText={card.valueText}
              valueTextWithUnit={card.valueTextWithUnit}
              unit={card.value == null && card.valueText == null ? '' : card.unit}
              detail={card.detail}
            />
          ))}
        </KpiBand>
      )}
      folders={(
        <>
          {/*
            共通のフォルダの列（種類 media・B-136）。m18s: 見出しの総数は「すべて」の行と同じ数なので出さない。
            閲覧のみ：フォルダを追加・「…」は置かない（理由は上の閲覧のみの帯で伝える。2026-10-06 オーナー決定）。
            名前・色・並べ替え・消すは「…」から。消すと中身は未分類へ移るので、一覧も読み直す。
          */}
          <ManagedFolderPanel
            kind="media"
            accountId={selectedAccountId}
            folders={folders}
            onChanged={() => Promise.all([load(), loadFolders()]).then(() => undefined)}
            canManage={canManageMedia && Boolean(selectedAccountId)}
            itemLabel="メディア"
            activeId={folderFilter}
            onSelect={selectFolder}
            allId=""
            unfiledId={UNGROUPED}
            allCount={mediaFolderRows[0].count}
            unfiledCount={unfiledCount}
            onAdded={(created) => setFolderFilter(created.id)}
            placeholder="例：01_商品写真"
            createAction={uploadButton}
            reserveCreateSpace={false}
          >
            {folderFailure ? (
              <Notice tone="danger" action={<> {folderForbidden ? null : (
                  <Button type="button" onClick={() => void loadFolders()} disabled={folderReloading}>
                    {folderReloading ? '読み込んでいます' : 'もう一度読み込む'}
                  </Button>
                )} </>} >{folderForbidden
                    ? permissionDeniedMessage('store')
                    : 'フォルダを読み込めませんでした。登録したメディアは消えていません。'}</Notice>
            ) : null}
          </ManagedFolderPanel>
        </>
      )}
      folderNav={{ rows: mediaFolderRows, activeId: folderFilter, onSelect: selectFolder, createAction: uploadButton }}
      toolbar={(
        <>
          <div className={styles.noticeRow}>

            {error ? <Notice tone="danger" message={error} onClose={() => setError('')} /> : null}
            {!error && selectedAccountId ? <FileScanStoppedBanner accountId={selectedAccountId} /> : null}
            {/* 容量は数の帯に出す。案内は 80% を超えたとき・満杯・読めなかったときだけ（いつも出すと道具の段を押し下げる）。 */}
            {(quota && quota.state !== 'normal') || (!quota && quotaFailed) ? (
              <MediaQuotaGuidance quota={quota} failed={quotaFailed} onShowNearLimit={() => { applyNearLimitFilter() }} />
            ) : null}
          </div>
          <ListToolbar
            search={{
              placeholder: 'ファイル名で探す',
              label: 'ファイル名で探す',
              width: 240,
              value: query,
              onChange: (value) => {
                setQuery(value)
                setPage(1)
              },
            }}
            filters={(
              <div role="group" aria-label="種類と使い方で絞り込む" className={styles.chipGroup}>
                <FilterChip
                  icon={<Images size={16} aria-hidden="true" />}
                  selected={kinds.size === 1 && kinds.has('image') && !showArchivedOnly}
                  onChange={(selectedValue) => {
                    if (selectedValue) {
                      setKinds(new Set(['image']))
                      setShowNearLimitOnly(false)
                      setShowArchivedOnly(false)
                    } else {
                      setKinds(new Set(KINDS.map((kind) => kind.key)))
                    }
                    setPage(1)
                  }}
                >
                  {`画像${kpis.kindTotals.image == null ? '' : ` ${formatNumber(kpis.kindTotals.image as number)}`}`}
                </FilterChip>
                <FilterChip
                  icon={<EyeOff size={16} aria-hidden="true" />}
                  selected={showUnusedOnly}
                  onChange={(selectedValue) => {
                    setShowUnusedOnly(selectedValue)
                    setShowNearLimitOnly(false)
                    setShowArchivedOnly(false)
                    setPage(1)
                  }}
                >
                  {`どこでも使っていない${kpis.unusedTotal == null ? '' : ` ${formatNumber(kpis.unusedTotal)}`}`}
                </FilterChip>
              </div>
            )}
            trailing={(
              <>
                <div className={styles.otherBox}>
                  <SaveErrorField names={["otherFilterValue","sort","other_filter_value"]}><Select
                    aria-label="よく使う絞り込み"
                    value={otherFilterValue}
                    options={[
                      { value: '', label: 'よく使う絞り込み' },
                      ...KINDS.filter((kind) => kind.key !== 'image').map((kind) => ({ value: kind.key, label: `${kind.label}だけ` })),
                      { value: 'near-limit', label: '上限に近いものだけ' },
                      { value: 'archived', label: 'アーカイブ済みだけ' },
                      ...SORT_OPTIONS.map((option) => ({ value: `sort:${option.value}`, label: `並び：${option.label}${sort === option.value ? '（いま）' : ''}` })),
                    ]}
                    onChange={(value) => {
                      if (value.startsWith('sort:')) {
                        setSort(value.slice(5) as MediaSort)
                        setPage(1)
                        return
                      }
                      applyOtherFilter(value)
                    }}
                  /></SaveErrorField>
                </div>
                <SegmentedControl<MediaView> aria-label="並べ方" size="small" value={view} onChange={setView}
                  options={[
                    {value:'grid',label:<LayoutGrid aria-hidden="true" size={16} />,ariaLabel:'格子で並べる'},
                    {value:'list',label:<ListIcon aria-hidden="true" size={16} />,ariaLabel:'一覧で並べる'},
                  ]} />
                <SaveErrorField names={["pageSize","limit","page_size"]}><Select
                  aria-label="表示件数"
                  value={String(pageSize)}
                  options={PAGE_SIZE_OPTIONS}
                  onChange={(value) => {
                    setPageSize(Number(value))
                    setPage(1)
                  }}
                  size="page-size"
                /></SaveErrorField>
              </>
            )}
          />
        </>
      )}
      pagination={(
        <div className={styles.footBlock}>
          <p className={styles.helpNote}>
            「…」から プレビュー・使用箇所を見る・名前を変える・フォルダへ移す・ダウンロード・アーカイブ・削除（使っているものは消せません）。
          </p>
          {listKnown && !loadFailed ? (
            <ListPager>
                <ListRange total={total} first={total === 0 ? 0 : (page - 1) * pageSize + 1} last={Math.min(page * pageSize, total)} />
                {canManageMedia ? (
                    <SaveErrorField names={["allSelected","selected","all_selected"]}><Checkbox
                      checked={allSelected}
                      onCheckedChange={() =>
                        setSelected((prev) => {
                          if (allSelected) return new Set<string>()
                          const next = new Set(prev)
                          for (const item of removable) next.add(item.id)
                          return next
                        })
                      }
                    >すべてのメディアを選択</Checkbox></SaveErrorField>
                ) : null}
              <Pagination page={page} pageCount={pageCount} onPageChange={setPage}/>
            </ListPager>
          ) : null}
          {canManageMedia ? (
            <BulkBar
              count={selected.size}
              total={selectionTotal}
              onSelectAll={selectAllMedia}
              hint={selectionLoading ? 'すべての対象を確認しています…' : selectionError ? <><Notice tone="danger">{selectionError}</Notice><Button size="compact" onClick={() => readSelectableMedia()} busyLabel="処理中…">もう一度読み込む</Button></> : '対象を確認してから操作を選んでください'}
            >
              <Button type="button" variant="secondary" onClick={() => setSelected(new Set())}>
                選択を外す
              </Button>
              <Button type="button" variant="danger" onClick={() => removeSelected()} busyLabel="処理中…">
                選択したメディアを削除
                {selected.size > 0 && <span>（{selected.size}）</span>}
              </Button>
            </BulkBar>
          ) : null}
        </div>
      )}
      overlays={(
        <>
        <OverlayDepthContext.Provider value={depth + 2}><UnsavedLeaveDialog open={guard.leaveTarget !== null} busy={editBusy} onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} /></OverlayDepthContext.Provider>
      {/*
        1件ずつの削除確認（設計 `YfTfJ`）。**消せないときは「削除しますか？」と
        聞かない。** 聞いてから断るより、最初から消せないと言うほうが短い。
      */}
      <Dialog
        open={deleting !== null && singleContext?.scope === accountScope.current}
        designNode="YfTfJ"
        tone="destructive"
        title={deleting ? dialogTitle(impact, deleting.filename) : ''}
        description="消すと、この画像・動画・ファイルそのものが無くなります。元に戻せません。"
        busy={deleteBusy}
        error={deleteError || undefined}
        onCancel={() => {
          if (deleteBusy) return
          closeDeleteDialog()
        }}
        footer={deleting && impact && (impact.usageCount > 0 || canDeleteMedia({ impact, busy: false })) ? (
          <DialogActions leadingAction={impact && impact.verified !== false && !impact.canDelete ? '使用先から外して削除' : undefined}>
            <>
              <Button type="button" onClick={closeDeleteDialog} disabled={deleteBusy}>
                キャンセル
              </Button>
              {deleting && impact && impact.usageCount > 0 ? (<Button
                  type="button"
                  variant="primary"
                  disabled={deleteBusy}
                  onClick={() => {
                    const source = deleting
                    closeDeleteDialog()
                    setReplacementFor(source)
                  }}
                >
                  別のメディアに差し替える
                </Button>) : null}
              {/* 消せないときは押し口ごと出さない。押せるように見えて何も起きない形にしない。 */}
              {canDeleteMedia({ impact, busy: deleteBusy }) ? (<Button type="button" variant="primary" onClick={() => void confirmDeleteOne()} busy={deleteBusy} busyLabel="処理中…">削除する
                </Button>) : null}
            </>
          </DialogActions>
        ) : undefined}
      >
        <div data-design-node="YfTfJ">
        {deleting ? <OperationTargetSummary accounts={[{ id: deleting.lineAccountId ?? '' }]} /> : null}
        {impactPhase === 'loading' ? (
          <p>使われている場所を確認しています…</p>
        ) : impactPhase === 'error' ? (
          <div>
            <Notice tone="danger" >使われている場所を確認できませんでした。読み直してから、もう一度お試しください。</Notice>
            {/* R34: 詳細と同じように、確認時刻と読み直しを一覧でも出す。 */}
            <Button type="button" onClick={() => { if (deleting) return openDelete(deleting) }} busyLabel="処理中…">もう一度読み込む</Button>
          </div>
        ) : impact ? (
          <div>
            <p>
              {usageText(impact)}
              {blockedReason(impact) ? ` ${blockedReason(impact)}` : ''}
            </p>
            {impact.verified === false ? (
              <div>
                <Button type="button" onClick={() => { if (deleting) return openDelete(deleting) }} busyLabel="処理中…">もう一度読み込む</Button>
              </div>
            ) : null}

            {impact.references.length > 0 ? (
              <div>
                <p>使われている場所</p>
                <ul>
                  {impact.references.map((ref: MediaDeleteImpactReference, index: number) => (
                    <li key={`${ref.kind}-${index}`}>
                      <span>
                        <span>{referenceKindText(ref.kind)}</span>
                        <span>「{referenceNameText(ref)}」</span>
                      </span>
                      {/* 開ける先があるときだけリンクにする。無い画面へ送らない。 */}
                      {ref.href ? (
                        <TextLink href={ref.href}>ここを開く</TextLink>
                      ) : (
                        <span>開けません</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <p>
              {impact.verified !== false && impact.usageCount > 0 ? <>使われている場所から外すと削除できます。別のメディアを選ぶと、使用先をまとめて差し替えられます。<br /></> : null}
              {checkedAtText(impact.checkedAt)} 時点で、{impact.verified === false ? '確認できなかった場所があります。' : '登録メディアの使用先を確認しました。'}
            </p>
          </div>
        ) : null}
        </div>
      </Dialog>

      <Dialog
        open={bulkConfirm !== null && bulkContext?.scope === accountScope.current}
        tone="destructive"
        title={bulkConfirm ? `${formatNumber(bulkConfirm.length)} 件のメディアを削除しますか？` : ''}
        description="どこにも使われていないと確かめたものだけを消します。元に戻せません。"
        busy={bulkBusy}
        onCancel={() => {
          if (bulkBusy) return
          bulkTicket.current = null; setBulkConfirm(null)
        }}
        footer={
          <DialogActions>
            <Button type="button" onClick={() => { bulkTicket.current = null; setBulkConfirm(null) }} disabled={bulkBusy}>
              キャンセル
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={bulkBusy}
              onClick={() => void runBulkDelete(bulkConfirm ?? [])} busy={bulkBusy} busyLabel="処理中…">削除する
            </Button>
          </DialogActions>
        }
      >
        {bulkContext ? <OperationTargetSummary accounts={bulkContext.accounts.map(id => ({ id }))} /> : null}
        <p>
          使われている場所があるものは、はじめから選べません。消したあとは元に戻せません。
        </p>
        {bulkBusy && bulkProgress ? (
          <p aria-live="polite">
            処理中…（{bulkProgress.done}/{formatNumber(bulkProgress.total)} 件）
          </p>
        ) : null}
      </Dialog>

      {/*
        退避・復帰の理由を聞く窓。監査に残すため理由なしでは確定できない。
        退避しても本文・過去配信からの参照は切れない旨を先に伝える。
      */}
      <Dialog
        open={archiveTarget !== null}
        title={archiveTarget?.mode === 'archive'
          ? `「${archiveTarget.item.filename}」をアーカイブしますか？`
          : archiveTarget ? `「${archiveTarget.item.filename}」を一覧へ戻しますか？` : ''}
        description={archiveTarget?.mode === 'archive'
          ? '一覧と新規選択から外れます。使っている場所や過去の配信はそのまま動きます。'
          : '一覧と新規選択へ戻ります。'}
        busy={archiveBusy}
        error={archiveError || undefined}
        onCancel={() => {
          if (archiveBusy) return
          setArchiveTarget(null)
        }}
        footer={
          <DialogActions>
            <Button type="button" onClick={() => setArchiveTarget(null)} disabled={archiveBusy}>
              キャンセル
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={archiveBusy || !archiveReason.trim()}
              onClick={() => void confirmArchiveChange()} busy={archiveBusy} busyLabel="処理中…">
              {archiveTarget?.mode === 'archive' ? 'アーカイブする' : '一覧へ戻す'}
            </Button>
          </DialogActions>
        }
      >
        <Field label="理由（あとから履歴で確認できます）" required><SaveErrorField names={["archiveReason","archive_reason"]}><SharedTextField
            type="text"
            autoFocus
            value={archiveReason}
            onChange={(event) => setArchiveReason(event.target.value)}
            placeholder={archiveTarget?.mode === 'archive' ? '例：古いキャンペーンの素材のため' : '例：再び使うため'}
            aria-label="理由"
          /></SaveErrorField></Field>
      </Dialog>

      {/*
        フォルダへ移す窓。移し先だけを選ぶ。未分類へ戻すときは空を選ぶ。
        二重押しは止め、確定するまで窓は閉じない。
      */}
      <Dialog
        open={moveTarget !== null}
        title={moveTarget ? `「${moveTarget.filename}」をフォルダへ移しますか？` : ''}
        description="中のメディアはそのまま残り、しまう場所だけが変わります。"
        busy={moveBusy}
        error={moveError || undefined}
        onCancel={() => {
          if (moveBusy) return
          setMoveTarget(null)
        }}
        footer={
          <DialogActions>
            <Button type="button" onClick={() => setMoveTarget(null)} disabled={moveBusy}>
              キャンセル
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={moveBusy}
              onClick={() => void confirmMove()} busy={moveBusy} busyLabel="処理中…">
              移す
            </Button>
          </DialogActions>
        }
      >
        <div className={styles.moveField}>
          <span className={styles.moveLabel}>移し先のフォルダ</span>
          <SaveErrorField names={["moveFolderId","folderId","move_folder_id"]}><FolderSelect
            aria-label="移し先のフォルダ"
            value={moveFolderId}
            folders={folders.map((folder) => ({ value: folder.id, label: folder.name }))}
            onChange={(value) => setMoveFolderId(value)}
          /></SaveErrorField>
        </div>
      </Dialog>

      <MediaUploadDialog
        open={uploadOpen}
        accountId={selectedAccountId}
        folders={folders}
        initialFolderId={folderFilter}
        // 左の列の「フォルダを追加」と同じ口・同じ権限。作ったフォルダは左の列にも足す。
        onCreateFolder={canManageMedia
          ? folderCreator((name, color) => api.folders.create({ kind: 'media', name, color, accountId: selectedAccountId }), folderById, (created) => setFolders((current) => [...current, created]))
          : undefined}
        onClose={() => setUploadOpen(false)}
        onComplete={() => {
          notifyToast('登録できたメディアを一覧へ反映しました。')
          void load()
          void loadKpis()
          void loadFolders()
        }}
      />

      <MediaReplacementDialog
        source={replacementFor}
        accountId={selectedAccountId}
        onClose={() => setReplacementFor(null)}
        onComplete={(message) => {
          setReplacementFor(null)
          notifyToast(message)
          void load()
        }}
      />


      {preview && (
        <MediaPreviewOverlay
          filename={preview.filename}
          kind={preview.kind}
          src={displaySrc(preview)}
          onClose={() => setPreview(null)}
        />
      )}
        </>
      )}
    >
      {!selectedAccountId && !accountLoading ? (
        <ListState kind="empty" title="LINEアカウントを選択してください" description="登録メディアはLINEアカウントごとに管理します。" />
      ) : null}
          {listKnown && !loadFailed && total > 200 ? (
            <p className={styles.moreNote}>200件を超えるメディアも、ページを移動してすべて確認できます。</p>
          ) : null}
          {loading ? (
            <ListState kind="loading" title="読み込んでいます" description="このまま少しお待ちください。" />
          ) : loadFailed ? (
            <ListState
              kind="error"
              title="表示できませんでした"
              description="再読み込みしても直らないときは、エラー報告へお知らせください。"
              onRetry={() => void load()}
            />
          ) : current.length === 0 ? (
            <div>
              {/*
                R38: まだ1件も無いときと、絞り込みで0件のときを分ける。
                `total` は絞り込み後の件数のため、絞り込みの有無も見る。
                絞り込みの0件に作る口を出すと、保存済みが消えたと誤読される。
                代わりに「条件を外す」を置く。
              */}
              <EmptyList
                icon={<Images aria-hidden="true" />}
                title="まだメディアがありません"
                description="配信で使う画像・動画・音声・ファイルを置いておきます。"
                create={{ label: '最初のメディアを登録する', onClick: () => setUploadOpen(true) }}
                filtered={hasFilter}
                onClearFilters={clearFilters}
                filteredDescription="種類、フォルダ、検索を外すと、すべて出ます"
              />
            </div>
          ) : (
            <ListPageCards key={view} columns={view === 'grid' ? 4 : 1}>
              {current.map((item) => (
                <MediaCardV8
                  key={item.id}
                  item={item}
                  view={view}
                  displaySrc={displaySrc(item)}
                  kindLabel={KINDS.find((k) => k.key === item.kind)?.label ?? 'ファイル'}
                  folder={folderDotOf(item.folderId)}
                  canManageMedia={canManageMedia}
                  managementPermissionReason={managementPermissionReason}
                  selected={selected.has(item.id)}
                  downloading={downloadingIds.has(item.id)}
                  menuOpen={openMenuId === item.id}
                  renaming={renaming?.id === item.id ? renaming : null}
                  renamingBusy={renamingBusy}
                  renameError={renameError}
                  onToggleSelect={() =>
                    setSelected((prev) => {
                      const next = new Set(prev)
                      if (next.has(item.id)) next.delete(item.id)
                      else next.add(item.id)
                      return next
                    })
                  }
                  onPreview={() => setPreview(item)}
                  onToggleMenu={() => setOpenMenuId((currentId) => (currentId === item.id ? null : item.id))}
                  onCloseMenu={() => setOpenMenuId(null)}
                  onDetail={() => guard.guarded(() => setDetailUrl(item.id))}
                  onDownload={() => { void downloadItem(item) }}
                  onRenameStart={() => guard.guarded(() => { setRenameError(''); setRenaming({ id: item.id, value: item.filename }) })}
                  onRenameCancel={() => guard.guarded(() => setRenaming(null))}
                  onRenameChange={(value) => setRenaming({ id: item.id, value })}
                  onRenameConfirm={() => { void rename() }}
                  onMoveStart={() => guard.guarded(() => { setMoveError(''); setMoveFolderId(item.folderId ?? ''); setMoveTarget(item) })}
                  onArchiveStart={() => guard.guarded(() => { setArchiveError(''); setArchiveReason(''); setArchiveTarget({ item, mode: item.archivedAt ? 'restore' : 'archive' }) })}
                  onDeleteStart={() => guard.guarded(() => { void openDelete(item) })}
                  onReplaceStart={() => guard.guarded(() => {
                    closeDeleteDialog()
                    setReplacementFor(item)
                  })}
                />
              ))}
            </ListPageCards>
          )}
    </ListPage></SaveErrorScope>
  )
}
