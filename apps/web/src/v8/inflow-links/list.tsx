'use client'

import ListDateTime from '@/components/shared/list-date-time'

import ListToolbar, { ListToolbarFrame, ListToolbarOptional, ListToolbarSort } from '@/components/shared/list-toolbar';

import { RowNameLink } from '@/components/shared/table';

import { useListUrlValue } from '@/components/shared/list-url-state';
import CopyTextButton from '@/components/shared/copy-text-button'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Bookmark, CircleAlert, Code, Inbox, Link2, Megaphone, Plus, Users } from 'lucide-react';
import Link from '@/components/shared/list-navigation'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation';
import { Eye } from 'lucide-react';
import type { ApiResponse, EntryRoute, EntryRouteGenre, Scenario, Tag, TrafficPool } from '@line-crm/shared';
import { ApiError, api, fetchApi } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { canManageRole, useStaffRole } from '@/lib/staff-role';
import { canEditFeature } from '@/lib/staff-capability';
import { useFeatureVisibility } from '@/lib/use-feature-visibility';
import { isPoolsFeatureAvailable } from '@/lib/pools-availability';
import type { FeatureKey } from '../../lib/feature-key'
import { useAccount } from '@/contexts/account-context';
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome';
import { ListPage, ListPagePagination } from '@/components/templates';
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Button from '@/components/shared/button'
import { Field } from '@/components/shared/form-controls'
import { TextField } from '@/components/shared/text-field'
import EmptyList from '@/components/shared/empty-list'
import Checkbox, { UnavailableSelection } from '@/components/shared/checkbox'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import Notice from '@/components/shared/notice'
import SegmentedControl from '@/components/shared/segmented'
import Select from '@/components/shared/select'
import PageSizeSelect from '@/components/shared/page-size-select'
import FolderPanel, { FolderPanelNote, type FolderPanelRow } from '@/components/shared/folder-panel';
import { FolderDotName } from '@/components/shared/folder-dot';
import { DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table';
import { type ActionMenuItem } from '@/components/shared/action-menu';
import { RowMenu } from '@/components/shared/row-actions';
import BulkBar from '@/components/shared/bulk-bar'
import ListState from '@/components/shared/list-state'
import Pagination from '@/components/shared/pagination'
import { describeApiFailure, japaneseDetailOf, loadFailureCopy, permissionDeniedMessage } from '@/components/shared/api-error-message';
import { notifyToast } from '@/components/shared/toast';
import EditRouteDialog from './edit-route-dialog'
import GenreDialog from './genre-dialog'
import BulkDialog, { type BulkRouteAction } from './bulk-dialog';
import StatusBadge from '@/components/shared/status-badge'
import QrDialog, { referralUrl, type QrRoute } from './qr-dialog';
import { becameLines, buildRows, isRefSummaryData, isUnconfigured, matchesFilter, routeStatus, shouldShowRow, sortRows, type RefSummaryData, type RouteFilter, type RouteRow, type RouteSort, type TrackedLinkRow } from './rows';
import styles from './list.module.css'
import TruncatedText from '@/components/shared/truncated-text'
import { emptyValue } from '@/components/shared/empty-value';
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors';
import ReadOnlyNotice from '@/components/shared/read-only-notice'

/*
 * ★V8-B 流入と計測の一覧（Pencil「★V8-B 画面の地図」：
 * 一覧 、1152 、閲覧のみ 、QR コードの小窓 ）。
 *
 * 型（ListPage）に、数の帯・左のフォルダの列（上に「流入リンクを作る」）・
 * 案内の帯・道具の段・表を置く。行は「コピー」「…」「編集」。
 * データの口と判断は今の一覧（app/inflow-links/page.tsx の InflowLinksPageInner）と同じ。
 * 動きの一覧は同じ場所の BEHAVIOR.md。
 */

interface MessageTemplate {
  id: string
  name: string
  messageType: string
  messageContent: string
}

/** フォルダの「未分類」。空文字は「すべて」なので別の値にする。 */
const UNCATEGORIZED = '__uncategorized__'

const SORT_OPTIONS: Array<{ value: RouteSort; label: string }> = [
  { value: 'friends-desc', label: '友だち追加が多い順' },
  { value: 'clicks-desc', label: 'クリックが多い順' },
  { value: 'latest-desc', label: '最近追加された順' },
  { value: 'name', label: '流入元名順' },
]

/** 流入の操作を任された staff の項目キー（Worker の INFLOW_LINKS_PERMISSION と同じ）。 */
const INFLOW_LINKS_EDIT_KEY = '/inflow-links'

export default function InflowListV8({
  onRouteCountChange,
  editId,
}: {
  /** 入口（page.tsx）へ「この一覧に見えている経路の数」を渡す。読み込み前・失敗は null。 */
  editId?: string | null
  onRouteCountChange?: (count: number | null) => void
}) {
  const saveErrors = useSaveFormErrors()
  usePageTitle('流入と計測')
  usePageCrumbs([{ label: 'ホーム', href: '/' }])
  const router = useRouter()
  const { selectedAccountId } = useAccount()
  // PERF-03: 編集窓の候補が属する機能のオン・オフ。切られている系統は取らない。
  const visibility = useFeatureVisibility(selectedAccountId)
  const role = useStaffRole()
  // 役割が読めるまでは今までどおり操作を出す。staff と分かったら押せない形にする（最後の守りは口の 403）。
  /*
   * WEB034：経路の作成・編集・止める／再開は、口（requireEntryRouteManagement）が
   * owner/admin に加えて「流入」を任された staff にも許している。画面も同じ条件で出す。
   * フォルダの作成・名前の変更は口が owner/admin だけなので、別に分ける。
   */
  const readonly = !canManageRole(role) && !canEditFeature(INFLOW_LINKS_EDIT_KEY, role)
  const canManageFolders = canManageRole(role)

  const latestAccountRef = useRef(selectedAccountId)
  latestAccountRef.current = selectedAccountId
  const accountScope = useRef({ id: selectedAccountId, generation: 0 })
  if (accountScope.current.id !== selectedAccountId) accountScope.current = { id: selectedAccountId, generation: accountScope.current.generation + 1 }
  const loadRequestRef = useRef(0)
  const [routes, setRoutes] = useState<EntryRoute[]>([])
  const [genres, setGenres] = useState<EntryRouteGenre[]>([])
  const [auxiliaryError,setAuxiliaryError]=useState(false)
  const [auxiliaryRetry,setAuxiliaryRetry]=useState(0)
  const [pools, setPools] = useState<TrafficPool[]>([])
  const [scenarios, setScenarios] = useState<Scenario[]>([])
  const [templates, setTemplates] = useState<MessageTemplate[]>([])
  const [trackedLinks, setTrackedLinks] = useState<TrackedLinkRow[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [summary, setSummary] = useState<RefSummaryData | null>(null)
  const [summaryAvailable, setSummaryAvailable] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [sort, setSort] = useListUrlValue<RouteSort>('sort', 'friends-desc')
  const [filter, setFilter] = useListUrlValue<RouteFilter>('filter', 'all')
  const [pageSize, setPageSize] = useListUrlValue('pageSize', 20)
  const [page, setPage] = useListUrlValue('page', 1)
  // null＝閉じている／'new'＝作る／EntryRoute＝直す／{register}＝未登録 ref を登録する
  const [editing, setEditing] = useState<EntryRoute | 'new' | { register: string } | null>(null)
  useEffect(() => {
    if (editId) setEditing(routes.find((route) => route.id === editId) ?? null)
  }, [editId, routes])
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [copyFailedId, setCopyFailedId] = useState<string | null>(null)
  const [selectedGenre, setSelectedGenre] = useListUrlValue('selectedGenre', '')
  const [search, setSearch] = useListUrlValue('q', '')
  const [editingGenre, setEditingGenre] = useState<EntryRouteGenre | 'new' | null>(null)
  const [qrRoute, setQrRoute] = useState<QrRoute | null>(null)
  const [openMenuRefCode, setOpenMenuRefCode] = useState<string | null>(null)
  const [presetOpen, setPresetOpen] = useState(false)
  const [adConnected, setAdConnected] = useState<{ total: number; names: string[] } | null>(null)
  const [poolMembers, setPoolMembers] = useState<Record<string, Set<string>>>({})
  const [poolMemberNames, setPoolMemberNames] = useState<Record<string, string[]>>({})
  const [selectedRouteIds, setSelectedRouteIds] = useState<Set<string>>(() => new Set())
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string; accountId: string | null; routeAccountId: string | null; generation: number } | null>(null)
  const activeDelete = useRef<typeof deleteTarget>(null)
  const [deleteName, setDeleteName] = useState('')
  const [stopTarget, setStopTarget] = useState<{ id: string; name: string; routeAccountId: string | null; generation: number } | null>(null)
  const activeStop = useRef<typeof stopTarget>(null)
  const toggleLocks = useRef(new Set<string>())
  const [bulkAction, setBulkAction] = useState<BulkRouteAction | null>(null)
  // 数の帯のマスの「…」。開いているマスの名前。

  const load = useCallback(async () => {
    const requestGeneration = ++loadRequestRef.current
    const accountAtRequest = latestAccountRef.current
    const isCurrent = () =>
      requestGeneration === loadRequestRef.current && accountAtRequest === latestAccountRef.current
    setLoading(true)
    setLoadFailed(false)
    setLoadError(null)
    try {
      // ref-summary は lineAccountId でそのアカウントに実流入があった ref だけに絞れる。
      const summaryQuery = accountAtRequest ? `?lineAccountId=${accountAtRequest}` : ''
      // N-011: 経路一覧も選んでいるアカウントで絞る。
      const routeQuery = accountAtRequest ? `?account_id=${encodeURIComponent(accountAtRequest)}` : ''
      const [r, genreRes, sum, tl] = await Promise.all([
        fetchApi<{ success: boolean; data: EntryRoute[] }>(`/api/entry-routes${routeQuery}`),
        api.entryRouteGenres.list(),
        fetchApi<{ success: boolean; data: RefSummaryData }>(`/api/analytics/ref-summary${summaryQuery}`)
          .catch(() => ({ success: false, data: null })),
        api.trackedLinks.list().catch(() => ({ success: false, data: null })),
      ])
      if (!isCurrent()) return
      if (r.success) {
        setRoutes(r.data)
        // 消えた経路を「まとめて操作」の対象に残さない。
        const alive = new Set(r.data.map((route) => route.id))
        setSelectedRouteIds((current) => {
          const next = new Set([...current].filter((id) => alive.has(id)))
          return next.size === current.size ? current : next
        })
      } else {
        setLoadFailed(true)
      }
      if(!genreRes.success)throw new Error(genreRes.error)
      setGenres(genreRes.data)
      if ('success' in sum && sum.success && isRefSummaryData(sum.data)) {
        setSummary(sum.data)
        setSummaryAvailable(true)
      } else {
        setSummary(null)
        setSummaryAvailable(false)
      }
      if (tl.success && tl.data) {
        setTrackedLinks(tl.data.map((row) => ({
          id: row.id,
          name: row.name,
          scenarioId: row.scenarioId,
          isActive: row.isActive,
        })))
      }
    } catch (e) {
      if (!isCurrent()) return
      const fieldFailure = saveErrors.capture(e)
      // 空（1件も無い）と言い分けるため、失敗として覚える。403・429 は ListState が言い分ける。
      setLoadFailed(true)
      { if (!fieldFailure)
      setLoadError(e) }
      setSummary(null)
      setSummaryAvailable(false)
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [saveErrors])

  useEffect(() => {
    // アカウントを変えた瞬間に前の一覧・集計・開いた操作を捨てる。
    setRoutes([])
    setGenres([])
    setPools([])
    setScenarios([])
    setTemplates([])
    setTrackedLinks([])
    setTags([])
    setSummary(null)
    setSummaryAvailable(false)
    setPoolMembers({})
    setPoolMemberNames({})
    setEditing(null)
    setQrRoute(null)
    setSelectedRouteIds(new Set())
    setBulkAction(null)
    activeStop.current = null
    activeDelete.current = null
    setStopTarget(null)
    setDeleteTarget(null)
    setDeleteName('')
    setOpenMenuRefCode(null)
    setPresetOpen(false)
    setAdConnected(null)
    setPage(1)
    void load()
    return () => {
      loadRequestRef.current += 1
    }
  }, [selectedAccountId, load])

  // 広告とつないだ数だけを軽く取る。失敗しても帯の4枚目が「—」になるだけ。
  useEffect(() => {
    let cancelled = false
    setAdConnected(null)
    void (async () => {
      try {
        const res = await api.adPlatforms.list(selectedAccountId)
        if (cancelled || !res.success) return
        const connected = res.data.filter((platform) => platform.isActive)
        setAdConnected({
          total: connected.length,
          names: connected.map((platform) => platform.displayName ?? platform.name),
        })
      } catch (saveFailure) {
        saveErrors.capture(saveFailure);

        if (!cancelled) setAdConnected(null)
      }
    })();

    return () => { cancelled = true }
  }, [selectedAccountId, saveErrors])

  /*
   * PERF-03: 編集窓の候補（プール・シナリオ・テンプレート・タグ）。一覧の行を待たせない補助取得。
   * 機能を切っている系統は呼ばず、補助の失敗は一覧を巻き込まない。
   */
  useEffect(() => {
    if (selectedAccountId && visibility.status === 'loading') return
    const accountAtRequest = selectedAccountId
    const featureAllowed = (key: FeatureKey) =>
      visibility.features == null || visibility.features[key] === true
    let cancelled = false
    /*
     * WEB032：候補（プール・シナリオ・テンプレート・タグ）の世代は、一覧の読み直しの
     * 世代と分ける。一覧を読み直す（切り替え・やり直し・保存）たびに候補を捨てると、
     * 候補の取り直しは走らないので、編集窓の候補が空のまま残る。
     * 捨てるのは、アカウント・機能の可否が変わったとき（この effect の作り直し）だけ。
     */
    const isCurrent = () => !cancelled && accountAtRequest === latestAccountRef.current
    const loadAuxiliary = async () => {
      // プールは multi_store_hierarchy が有効と分かるときだけ呼ぶ（403 を出さない、#703）。
      const poolsDisabled = { success: false as const, error: 'feature_disabled' }
      const fetchPools = () => api.pools.list({ suppressFeatureDisabledEvent: true })
      const poolsPromise: Promise<ApiResponse<TrafficPool[]>> = visibility.features != null
        ? (visibility.features['multi_store_hierarchy'] === true ? fetchPools() : Promise.resolve(poolsDisabled))
        : isPoolsFeatureAvailable(selectedAccountId ? [selectedAccountId] : null)
          .then((ok) => (ok ? fetchPools() : poolsDisabled))
      // R23横展開: 行の名前解決に使う候補は今のアカウントだけ。
      const candidateParams = accountAtRequest ? { accountId: accountAtRequest } : undefined
      const [p, s, t, tagRes] = await Promise.all([
        poolsPromise,
        featureAllowed('scenarios')
          ? api.scenarios.list(candidateParams)
          : Promise.resolve({ success: false as const, data: [] as Scenario[] }),
        featureAllowed('templates')
          ? api.messageTemplates.list()
          : Promise.resolve({ success: false as const, data: [] as MessageTemplate[] }),
        api.tags.list(candidateParams),
      ])
      if (!isCurrent()) return
      if(!tagRes.success || (featureAllowed('scenarios')&&!s.success) || (featureAllowed('templates')&&!t.success) || (!p.success && p.error!=='feature_disabled'))throw new Error('candidates unavailable')
      // 形の違う返事（古い Worker など）で行の描画ごと落ちないよう、配列のときだけ受け取る。
      if (p.success && Array.isArray(p.data)) setPools(p.data)
      if (s.success && Array.isArray(s.data)) setScenarios(s.data)
      if (t.success && Array.isArray(t.data)) setTemplates(t.data)
      if (tagRes.success && Array.isArray(tagRes.data)) setTags(tagRes.data)
      if (p.success && Array.isArray(p.data)) {
        // プール→所属アカウントは1回でまとめて取る。
        const batch = p.data.length > 0
          ? await api.pools.listAccounts(p.data.map((pool) => pool.id), { suppressFeatureDisabledEvent: true })
          : { success: true as const, data: [] }
        if (!isCurrent()) return
        if (batch.success) {
          setPoolMembers(Object.fromEntries(batch.data.map(({ poolId, accounts }) => [
            poolId,
            new Set(accounts.filter((account) => account.isActive).map((account) => account.lineAccountId)),
          ])))
          setPoolMemberNames(Object.fromEntries(batch.data.map(({ poolId, accounts }) => [
            poolId,
            accounts.filter((account) => account.isActive).map((account) => account.accountName ?? emptyValue('unknown')),
          ])))
        }
      }
    }
    setAuxiliaryError(false)
    void loadAuxiliary().catch(()=>{if(isCurrent())setAuxiliaryError(true)})
    return () => { cancelled = true }
  }, [selectedAccountId, visibility.status, visibility.features,auxiliaryRetry])

  /*
   * 行の受付・停止を切り替える（行の「…」から）。押した瞬間に札を変え、裏で保存する
   * （動きの点検・7）。失敗したら元に戻して知らせる。終わったら取り直す。
   */
  const [stopError, setStopError] = useState('')
  const toggleRouteActive = async (entryRouteId: string, nextActive: boolean, name: string, confirmed = false) => {
    if (confirmed) setStopError('')
    if (toggleLocks.current.has(entryRouteId)) return false
    toggleLocks.current.add(entryRouteId)
    const accountAtRequest = selectedAccountId
    const isCurrent = () => accountAtRequest === latestAccountRef.current
    setOpenMenuRefCode(null)
    const setActive = (active: boolean) => setRoutes((current) => current.map((route) => (route.id === entryRouteId ? { ...route, isActive: active } : route)))
    setActive(nextActive)
    try {
      const res = await api.entryRoutes.update(entryRouteId, { isActive: nextActive })
      if (!isCurrent()) return false
      if (!res.success) throw new Error(res.error || '更新できませんでした。時間をおいて、もう一度お試しください。')
      notifyToast(nextActive ? `「${name}」の受付を再開しました` : `「${name}」の受付を停止しました`)
      void load()
      return true
    } catch (cause) {
      const fieldFailure = saveErrors.capture(cause);

      if (!isCurrent())

 return false
      setActive(!nextActive)
      if (confirmed) setStopError(cause instanceof ApiError && cause.status === 403 ? permissionDeniedMessage('store') : '受付を切り替えられませんでした。')
      { if (!fieldFailure && !confirmed)
      notifyToast(
        cause instanceof ApiError && cause.status === 403 ? permissionDeniedMessage('store') : '受付を切り替えられませんでした。',
        { tone: 'error', actionLabel: 'もう一度', onAction: () => { void toggleRouteActive(entryRouteId, nextActive, name) } },
      )
      }
      return false
    } finally {
      toggleLocks.current.delete(entryRouteId)
    }
  }

  /* ===== 行づくり（今の一覧と同じ判断） ===== */
  const allRows = useMemo(() => buildRows(routes, trackedLinks, summary), [routes, trackedLinks, summary])
  const mainPool = pools.find((p) => p.slug === 'main')
  const poolRoutesToAccount = (poolId: string | null, accountId: string): boolean => {
    const targetPoolId = poolId ?? mainPool?.id
    if (!targetPoolId) return false
    return poolMembers[targetPoolId]?.has(accountId) ?? false
  }
  const accountRows = allRows.filter((row) => shouldShowRow({
    source: row.source,
    poolId: row.poolId,
    friendCount: row.stats?.friendCount ?? 0,
  }, selectedAccountId, poolRoutesToAccount))

  const availableGenres = useMemo(() => {
    const routeGenreNames = routes.map((route) => route.genre).filter((genre): genre is string => !!genre)
    return [
      ...genres,
      ...Array.from(new Set(routeGenreNames))
        .filter((name) => !genres.some((genre) => genre.name === name))
        .map((name) => ({ id: `legacy-${name}`, name, createdAt: '', updatedAt: '' })),
    ]
  }, [genres, routes])
  useEffect(() => {
    const selectable = ['', ...availableGenres.map((genre) => genre.name), UNCATEGORIZED]
    setSelectedGenre((current) => (selectable.includes(current) ? current : ''))
  }, [availableGenres])

  const selectedGenreLabel = selectedGenre === UNCATEGORIZED ? '未分類' : selectedGenre || 'すべて'
  const genreRows = selectedGenre === ''
    ? accountRows
    : selectedGenre === UNCATEGORIZED
      ? accountRows.filter((row) => !row.genre)
      : accountRows.filter((row) => row.genre === selectedGenre)
  const normalizedSearch = search.trim().toLocaleLowerCase('ja')
  const searchedRows = normalizedSearch
    ? genreRows.filter((row) =>
        row.name.toLocaleLowerCase('ja').includes(normalizedSearch)
        || row.refCode.toLocaleLowerCase('ja').includes(normalizedSearch))
    : genreRows
  const sortedRows = sortRows(searchedRows.filter((row) => matchesFilter(row, filter, summaryAvailable)), sort)
  const pageCount = Math.max(1, Math.ceil(sortedRows.length / pageSize))
  const currentPage = Math.min(page, pageCount)
  const currentRows = sortedRows.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  // まとめて操作の対象は、絞り込んだ行のうち登録済み（entry_routes）だけ。
  const selectableIds = sortedRows.flatMap((row) => (row.entryRouteId ? [row.entryRouteId] : []))
  const allShownSelected = selectableIds.length > 0 && selectableIds.every((id) => selectedRouteIds.has(id))
  const selectedRoutes = routes.filter((route) => selectedRouteIds.has(route.id))
  useEffect(() => {
    if (page > pageCount) setPage(pageCount)
  }, [page, pageCount])

  /* ===== 帯の数（フォルダ・検索・絞り込みの前で数える） ===== */
  const routeCountAvailable = !loading && !loadFailed
  const accountRouteCount = summary?.routeTotal ?? accountRows.length
  const unconfiguredCount = accountRows.filter(isUnconfigured).length
  const hasFriendsCount = accountRows.filter((row) => matchesFilter(row, 'has-friends', summaryAvailable)).length
  const genreNames = availableGenres.map((genre) => genre.name)
  const adNamesSub = adConnected === null
    ? '読み込めませんでした'
    : adConnected.names.length === 0
      ? 'まだ接続がありません'
      : adConnected.names.slice(0, 2).join('・') + (adConnected.names.length > 2 ? 'など' : '')
  const loadFailure = loadError ? loadFailureCopy(loadError, '流入経路') : null

  // #980: 入口へ「この一覧に見えている経路の数」を渡す（読み込み前・失敗は null）。
  useEffect(() => {
    onRouteCountChange?.(routeCountAvailable ? accountRows.length : null)
  }, [onRouteCountChange, routeCountAvailable, accountRows.length])

  /* ===== 行の「…」 ===== */
  const qrFor = (row: RouteRow): QrRoute => ({
    refCode: row.refCode,
    couponEnabled: routes.find((route) => route.id === row.entryRouteId)?.couponEnabled,
    name: row.name,
    genre: row.genre,
    isActive: row.isActive,
    id: row.entryRouteId ?? undefined,
  })
  const rowMenuItems = (row: RouteRow): ActionMenuItem[] => {
    const items: ActionMenuItem[] = []
    {
      items.push({ id: 'qr', label: 'QRコードを見る', onSelect: () => { setOpenMenuRefCode(null); setQrRoute(qrFor(row)) } })
      items.push({ id: 'copy', label: 'URLをコピー', content: <CopyTextButton role="menuitem" value={referralUrl(row.refCode)} aria-label={`${row.name}のURLをコピー`} />, onSelect: () => {} })
    }
    // 閲覧のみには押せない項目を置かない（2026-10-06 オーナー決定）。見る項目（QR・コピー）だけ残す。
    if (row.entryRouteId && !readonly) {
      const target = routes.find((entry) => entry.id === row.entryRouteId) ?? null
      if (target) {
        items.push({
          id: 'edit',
          label: 'リンクを編集',
          onSelect: () => { setOpenMenuRefCode(null); router.push(`/inflow-links/edit?id=${encodeURIComponent(target.id)}`) },
        })
      }
      if (target && canManageRole(role)) items.push({
        id: 'delete', label: '削除する', tone: 'danger',
        onSelect: () => { const value = { id: target.id, name: target.name, accountId: selectedAccountId, routeAccountId: target.lineAccountId ?? null, generation: accountScope.current.generation }; activeDelete.current = value; setOpenMenuRefCode(null); setDeleteName(''); setDeleteTarget(value) },
      })
      items.push(row.isActive === false
        ? {
          id: 'resume',
          label: '受付を再開する',
          onSelect: () => void toggleRouteActive(row.entryRouteId!, true, row.name),
        }
        : {
          id: 'stop',
          label: '受付を止める',
          tone: 'danger' as const,
          onSelect: () => { const value = { id: row.entryRouteId!, name: row.name, routeAccountId: target?.lineAccountId ?? null, generation: accountScope.current.generation }; activeStop.current = value; setOpenMenuRefCode(null); setStopError(''); setStopTarget(value) },
        })
    }
    return items
  }

  /* ===== フォルダ ===== */
  const folderRows: FolderPanelRow[] = [
    { kind: 'all' as const, id: '', label: 'すべて', count: routeCountAvailable ? accountRows.length : null, icon: <Inbox size={16} aria-hidden="true" /> },
    ...availableGenres.map((genre) => ({
      kind: 'folder' as const,
      id: genre.name,
      label: genre.name,
      // entry_route_genres に color 欄がない。追加はオーナーの migration 承認待ち。
      colorEditable: false,
      count: routeCountAvailable ? accountRows.filter((row) => row.genre === genre.name).length : null,
      // 名前の変更は各フォルダの「…」から（ほかの一覧と同じ・）。
      // 消す・並べ替え・色はフォルダの口（entry-route-genres）に無いので出さない（押せない口を置かない）。
      ...(canManageFolders && !genre.id.startsWith('legacy-')
        ? { onEdit: () => setEditingGenre(genre) }
        : {}),
    })),
    { kind: 'unfiled' as const, id: UNCATEGORIZED, label: '未分類', count: routeCountAvailable ? accountRows.filter((row) => !row.genre).length : null },
  ]
  const selectGenre = (id: string) => { setSelectedGenre(id); setPage(1) }
  const folderSelect = (
    <SaveErrorField names={["selectedGenre","selected_genre"]}><Select
      narrowFolderPicker aria-label="フォルダ"
      value={selectedGenre}
      onChange={selectGenre}
      options={[
        { value: '', label: 'フォルダ：すべて' },
        ...availableGenres.map((genre) => ({ value: genre.name, label: `フォルダ：${genre.name}` })),
        { value: UNCATEGORIZED, label: 'フォルダ：未分類' },
      ]}
    /></SaveErrorField>
  )
  // 閲覧のみには押せない作るボタンを置かない（2026-10-06 オーナー決定）。
  const createButton = readonly
    ? null
    : <Button variant="primary" href="/inflow-links/new"><Plus size={16} aria-hidden="true" />流入リンクを作る</Button>

  /* ===== 道具の段 ===== */
  const filterChips = (
    <SegmentedControl<RouteFilter> aria-label="流入経路の絞り込み" fit="content" value={filter} onClear={() => { setFilter('all'); setPage(1) }} onChange={(value) => { setFilter(value); setPage(1) }} options={[
      { value: 'all', label: 'すべて' },
      { value: 'has-friends', label: '友だち追加あり', title: summaryAvailable ? `友だち追加あり ${formatNumber(hasFriendsCount)} 件` : undefined },
      { value: 'unconfigured', label: '動きが未設定', count: routeCountAvailable ? unconfiguredCount : undefined },
    ]} />
  )
  const presetCounts: Array<[RouteFilter, string, number | undefined]> = [
    ['all', 'すべて', genreRows.length],
    ['has-friends', '友だち追加あり', summaryAvailable ? genreRows.filter((row) => matchesFilter(row, 'has-friends', summaryAvailable)).length : undefined],
    ['no-friends', '友だち追加なし', summaryAvailable ? genreRows.filter((row) => matchesFilter(row, 'no-friends', summaryAvailable)).length : undefined],
    ['unconfigured', '動きが未設定', genreRows.filter(isUnconfigured).length],
  ]
  const presetBox = (
    <div className={styles.presetWrap}>
      <Button variant="secondary" onClick={() => setPresetOpen((current) => !current)} aria-expanded={presetOpen}>
        <Bookmark size={16} aria-hidden="true" />よく使う絞り込み
      </Button>
      {presetOpen ? (
        <div className={styles.presetPanel} role="dialog" aria-label="よく使う絞り込みと並び順">
          <span className={styles.presetLabel}>絞り込み</span>
          <div className={styles.presetChips}>
            <SegmentedControl
              aria-label="絞り込み"
              value={filter}
              onChange={(next) => { setFilter(next); setPage(1); setPresetOpen(false) }}
              options={presetCounts.map(([value, label, count]) => ({ value, label, count }))}
            />
          </div>
          <span className={styles.presetLabel}>並び順</span>
          <SaveErrorField names={["sort"]}><ListToolbarSort
            aria-label="並び順"
            value={sort}
            options={SORT_OPTIONS}
            onChange={(value) => { setSort(value as RouteSort); setPage(1); setPresetOpen(false) }}
          /></SaveErrorField>
        </div>
      ) : null}
    </div>
  )
  const perPageBox = (
    <PageSizeSelect
      value={pageSize}
      options={[10, 20, 50]}
      label={null}
      aria-label="表示件数"
      onChange={(value) => { setPageSize(value); setPage(1) }}
    />
  )
  const notice = routeCountAvailable && unconfiguredCount > 0 ? (
    <div className={styles.noticeRow}>
      <Notice tone="info">
        {`友だちになっても何も起きない経路が ${formatNumber(unconfiguredCount)} 件あります。「動きが未設定」で絞って、タグやメッセージを決めてください。`}
      </Notice>
    </div>
  ) : null
  const searchLabel = '経路の名前・URLで探す'
  const onSearch = (value: string) => { setSearch(value); setPage(1) }
  // 1152 の板：案内の帯 → 1段目「作る・フォルダ・探す」→ 2段目「札 … よく使う絞り込み・件数」。
  const toolbar = (
    <ListToolbarFrame>
      {notice}
      <ListToolbar
        search={{ placeholder: searchLabel, label: searchLabel, width: 240, value: search, onChange: onSearch }}
        filters={filterChips}
        trailing={<><ListToolbarOptional compact label="保存した絞り込み">{presetBox}</ListToolbarOptional>{perPageBox}</>}
      />
    </ListToolbarFrame>
  )

  /* ===== 表 ===== */
  let listBody: ReactNode
  if (loading) {
    listBody = <ListState kind="loading" title="流入経路を読み込んでいます" />
  } else if (loadFailed) {
    listBody = (
      <ListState
        kind="error"
        /* ：分からない失敗のときだけ「流入リンクを読み込めませんでした」と言う（権限・混雑は言い分けたまま）。 */
        title={loadFailure && loadFailure.title !== '表示できませんでした' ? loadFailure.title : '流入リンクを読み込めませんでした'}
        description={loadFailure?.description}
        error={loadError ?? undefined}
        onRetry={loadFailure === null || loadFailure.retryable ? () => void load() : undefined}
      />
    )
  } else if (sortedRows.length === 0) {
    // 絞り込み・検索で0件のときは「まだ無い」と言わない（R173）。修正案 D-2：空の一覧。
    listBody = (
      <EmptyList
        icon={<Link2 aria-hidden="true" />}
        title={selectedGenre && accountRows.length === 0 ? `「${selectedGenreLabel}」にはまだ流入リンクがありません` : 'まだ流入リンクがありません'}
        description="QR コードや URL ごとに、どこから友だちになったかを数えます。"
        create={{ label: '最初の流入リンクを作る', href: '/inflow-links/new' }}
        canCreate={!readonly}
        filtered={accountRows.length > 0 && (normalizedSearch !== '' || filter !== 'all' || selectedGenre !== '')}
        onClearFilters={() => { setSearch(''); setFilter('all'); setSelectedGenre(''); setPage(1) }}
      />
    )
  } else {
    listBody = (
      <>
        <div className={styles.tableWrap}>
          <DataTable columnSizing="content" columnLayout={{ headHeight: 'var(--polish-table-head)', rowHeight: 'var(--polish-table-row)', gap: 'var(--tpl-il-col-gap)', padding: '0 var(--tpl-list-inset)', bodyTextSize: 'var(--polish-text-body)', numberInset: 'var(--tpl-il-num-pad-end)', collapseScope: 'page' }}>
            <thead>
              <TableHeadRow data-table-layout="columns">
                <Th className={styles.colCheck}>
                  {readonly ? <UnavailableSelection label="このページの全経路をまとめて操作の対象にする" /> : <SaveErrorField names={["allShownSelected","selectedRouteIds","all_shown_selected","selected_route_ids"]}><Checkbox
                    aria-label="表示中の登録済み経路をすべて選ぶ"
                    checked={allShownSelected}
                    indeterminate={!allShownSelected && selectableIds.some((id) => selectedRouteIds.has(id))}
                    disabled={selectableIds.length === 0}
                    title={selectableIds.length === 0 ? 'まとめて操作できる登録済みの経路がありません' : undefined}
                    onCheckedChange={(checked) => setSelectedRouteIds(checked ? new Set(selectableIds) : new Set())}
                  /></SaveErrorField>}
                </Th>
                <Th grow>流入元名</Th>
                <Th collapseAt="narrow" className={styles.colPool}>追加先</Th>
                <Th className={styles.colBecame}>友だちになったら</Th>
                <Th align="right" className={styles.colFriends}>友だち追加</Th>
                <Th align="right" className={styles.colClicks}>クリック</Th>
                <Th collapseAt="narrow" className={styles.colLatest}>最新追加</Th>

                <Th className={styles.colStatus}>状態</Th><Th className={styles.colOps}>操作</Th>
              </TableHeadRow>
            </thead>
            <tbody>
              {currentRows.map((r, saveFieldIndex) => {
                const pool = pools.find((p) => p.id === r.poolId)
                const sc = scenarios.find((s) => s.id === r.scenarioId)
                const tag = tags.find((t) => t.id === r.tagId)
                const editTarget = r.source === 'entry_route' ? routes.find((e) => e.id === r.entryRouteId) ?? null : null
                const status = routeStatus(r)
                const introTemplate = r.introTemplateId ? templates.find((t) => t.id === r.introTemplateId) : undefined
                const [becameFirst, becameSecond] = becameLines(r, sc, tag, introTemplate?.name ?? null)
                const menuItems = rowMenuItems(r)
                const menuLabel = `「${r.name}」の操作`
                const nameNode = r.source === 'entry_route' && r.entryRouteId ? (
                  <RowNameLink href={`/inflow-links/detail?id=${r.entryRouteId}`} >
                    <TruncatedText value={String(r.name ?? '')} />
                  </RowNameLink>
                ) : (
                  <span className={styles.nameText} ><TruncatedText value={String(r.name ?? '')} /></span>
                )
                return (
                  <Tr selected={Boolean(r.entryRouteId && selectedRouteIds.has(r.entryRouteId))} key={r.refCode} href={r.source === 'entry_route' && r.entryRouteId ? `/inflow-links/detail?id=${encodeURIComponent(r.entryRouteId)}` : undefined} data-table-layout="columns" data-row-id={r.entryRouteId ?? r.refCode}>
                    <Td className={styles.colCheck}>
                      {r.entryRouteId && !readonly ? (
                        <SaveErrorField names={[`currentRows.${saveFieldIndex}.entryRouteId`,`currentRows.${saveFieldIndex}.entry_route_id`,"entryRouteId","r.entryRouteId","selectedRouteIds","entry_route_id","r.entry_route_id","selected_route_ids"]}><Checkbox
                          aria-label={`${r.name}をまとめて操作の対象にする`}
                          checked={selectedRouteIds.has(r.entryRouteId)}
                          onCheckedChange={(checked) => {
                            const id = r.entryRouteId!
                            setSelectedRouteIds((current) => {
                              const next = new Set(current)
                              if (checked) next.add(id)
                              else next.delete(id)
                              return next
                            })
                          }}
                        /></SaveErrorField>
                      ) : (
                        <UnavailableSelection label={`${r.name}をまとめて操作の対象にする`} reason={readonly ? "閲覧のみのため選べません" : "まとめて操作は登録済みの流入経路だけに使えます"} />
                      )}
                    </Td>
                    <Td grow data-list-name-cell>
                      <FolderDotName folder={r.genre ? { name: r.genre } : null}>{nameNode}</FolderDotName>
                    </Td>
                    <Td collapseAt="narrow" className={styles.colPool}>
                      {pool ? (
                        <span className={styles.cellMain} ><TruncatedText value={String(pool.name ?? '')} /></span>
                      ) : r.source === 'tracked_link' ? (
                        <span className={styles.cellMain} title="追加先の振り分けは全体設定に従います。">{emptyValue('unknown')}</span>
                      ) : (
                        <span className={styles.cellMain} title="追加先が設定されていません。">{emptyValue('unconfigured')}</span>
                      )}
                    </Td>
                    <Td className={styles.colBecame}>
                      <span className={styles.cellMain} title={becameFirst}>{becameFirst}</span>
                      <span className={styles.cellSub} title={becameSecond}>{becameSecond}</span>
                    </Td>
                    <Td align="right" className={styles.colFriends}>
                      {summaryAvailable ? (
                        <>
                          <span className={styles.cellMain}>{`${formatNumber(r.stats?.friendCount ?? 0)} 人`}</span>
                          <span className={styles.cellSub}>{`累計 ${formatNumber(r.stats?.friendCount ?? 0)} 人`}</span>
                        </>
                      ) : (
                        <span className={styles.cellMain}>{emptyValue('unknown')}</span>
                      )}
                    </Td>
                    <Td align="right" className={styles.colClicks}>
                      <span className={styles.cellMain}>{summaryAvailable && r.stats ? formatNumber(r.stats.clickCount) : emptyValue('unknown')}</span>
                    </Td>
                    <Td collapseAt="narrow" className={styles.colLatest}>
                      <span className={styles.cellMain}>{summaryAvailable ? <ListDateTime value={r.stats?.latestAt} /> : emptyValue('unknown')}</span>
                    </Td>
                    <Td className={styles.colStatus}>
                      {status ? (
                        <StatusBadge
                          tone={status === 'measured' ? 'success' : status === 'unregistered' ? 'warning' : 'neutral'}
                          title={status === 'measured'
                            ? (r.source === 'tracked_link'
                              ? 'クリック計測とシナリオ起動が設定されています。追加先の振り分けは全体設定に従います。'
                              : '流入の計測ができています。')
                            : status === 'unregistered'
                              ? '外部で発行されたREFです。流入実績だけを集計しています。'
                              : '受付を止めています。このURLを開いても友だち追加できません。'}
                        >
                          {status === 'measured' ? '計測済' : status === 'unregistered' ? '未登録' : '停止中'}
                        </StatusBadge>
                      ) : null}
                    </Td>
                    <Td className={styles.colOps} data-list-action-cell>
                      <div className={styles.opsBox}>
                        {/* 閲覧のみ：編集・登録するは置かない（列の幅は残す） */}
                        {readonly ? null : editTarget ? (
                          null
                        ) : r.source === 'tracked_link' ? (
                          // tracked_links は別管理（画面に編集の口が無い）。昇格登録は上書きになるので出さない。
                          <span className={styles.cellMain} title="この経路は別の仕組み（クリック計測）で管理しています">{emptyValue('unknown')}</span>
                        ) : (
                          <Button
                            size="compact"
                            data-row-quick-action=""
                            onClick={() => setEditing({ register: r.refCode })}
                            title="未登録 ref を登録します。流入実績はそのまま引き継がれます。"
                          >
                            登録する
                          </Button>
                        )}
                        <RowMenu appearance="plain" label={menuLabel} items={menuItems}
                          open={openMenuRefCode === r.refCode}
                          onOpenChange={(next) => setOpenMenuRefCode(next ? r.refCode : null)} />
                      </div>
                    </Td>
                  </Tr>
                )
              })}
            </tbody>
          </DataTable>
        </div>

        <BulkBar count={selectedRouteIds.size} onClear={() => setSelectedRouteIds(new Set())} total={selectableIds.length} onSelectAll={() => setSelectedRouteIds(new Set(selectableIds))} hint="まとめて操作できるのは登録済みの経路だけです">
          <Button onClick={() => setBulkAction('pause')}>まとめて止める</Button>
          <Button onClick={() => setBulkAction('resume')}>まとめて再開する</Button>
          <Button onClick={() => setBulkAction('move')}>フォルダへ移す</Button>
        </BulkBar>
      </>
    )
  }

  const pager = !loading && !loadFailed && currentRows.length > 0 ? (
    <ListPagePagination>
      <Pagination page={currentPage} pageCount={pageCount} onPageChange={setPage} ariaLabel="流入経路のページ送り" range={{ total: sortedRows.length, first: (currentPage - 1) * pageSize + 1, last: (currentPage - 1) * pageSize + currentRows.length }} />
    </ListPagePagination>
  ) : null

  const routeEditor = editing ? (auxiliaryError?<ListState kind="error" title="候補を読み込めませんでした" onRetry={()=>setAuxiliaryRetry(value=>value+1)}/>: <EditRouteDialog surface={editId !== undefined ? 'page' : 'dialog'}
            route={editing === 'new' || (typeof editing === 'object' && 'register' in editing) ? null : editing}
            initialRefCode={typeof editing === 'object' && editing !== null && 'register' in editing ? editing.register : undefined}
            initialGenre={editing === 'new' && selectedGenre !== UNCATEGORIZED ? selectedGenre : undefined}
            pools={pools}
            scenarios={scenarios}
            templates={templates}
            tags={tags}
            existingGenres={genreNames}
            poolMemberNames={poolMemberNames}
            accountId={selectedAccountId}
            onClose={() => editId ? router.push('/inflow-links') : setEditing(null)}
            onSaved={(savedRoute, created) => {
              if (editId !== undefined) { router.push(`/inflow-links?highlight=${savedRoute.id}`); return }
              setEditing(null)
              void load()
              if (created) setQrRoute({ refCode: savedRoute.refCode, name: savedRoute.name, genre: savedRoute.genre, isActive: savedRoute.isActive, id: savedRoute.id })
            }}
          />) : null
  if (editId !== undefined) {
    if (loading) return <ListState kind="loading" />
    if (readonly || !routeEditor) return <ListState kind="error" title="この経路を編集できません" description="権限と経路を確認してください。" />
    return routeEditor
  }

  return (
    <SaveErrorScope errors={saveErrors}><ListPage
      skeleton
      help={readonly
            ? '行の「…」から QRコードを表示・URLをコピーできます。'
            : '行の「…」から QRコードを表示・URLをコピー・リンクを編集・止める。左のチェックで、まとめて操作できます。'}
      boardId="xbHxg"
      headingSize="regular"
      title="流入と計測"

      actions={<div className={styles.headActions}>
        <Button href="/inflow-links?tab=connections"><Megaphone size={16} aria-hidden="true" />広告とのつなぎ</Button>
        {/* #859: site_tracking が切れているときは口を出さない。直 URL はホスト側の停止画面が出す。 */}
        {visibility.enabled('site_tracking') ? (
          <Button href="/inflow-links?tab=script"><Code size={16} aria-hidden="true" />サイトスクリプト</Button>
        ) : null}
      </div>}
      stats={<>
        {readonly ? (
          <div className={styles.viewerBand}><ReadOnlyNotice role="status"></ReadOnlyNotice></div>
        ) : null}
        <KpiBand>
          <KpiCard
            presentation="band"
            title="経路"
            icon={<Link2 size={16} aria-hidden="true" />}
            value={routeCountAvailable ? accountRouteCount : null}
            unit={routeCountAvailable ? '件' : ''}
            loading={loading}
            detail={routeCountAvailable ? '停止中を含むすべての経路' : loading ? '読み込んでいます' : '読み込めませんでした'}
          />
          <KpiCard
            presentation="band"
            title="友だち追加"
            icon={<Users size={16} aria-hidden="true" />}
            help="集計は累計です（月ごとの内訳は出せません）。経路が分かる人は、流入リンクから友だちになった人です。"
            value={summaryAvailable && summary ? summary.totalFriends : null}
            unit={summaryAvailable && summary ? '人' : ''}
            loading={loading}
            detail={summaryAvailable && summary
              ? `累計。経路が分かる人 ${formatNumber(summary.friendsWithRef)} 人`
              : loading ? '読み込んでいます' : '読み込めませんでした'}
          />
          <KpiCard
            presentation="band"
            title="動きが未設定"
            icon={<CircleAlert size={16} aria-hidden="true" />}
            value={routeCountAvailable ? unconfiguredCount : null}
            unit={routeCountAvailable ? '件' : ''}
            loading={loading}
            detail="友だちになっても何も起きない"
            action={routeCountAvailable && unconfiguredCount > 0 ? {
              label: '未設定を見る',
              onClick: () => { setFilter('unconfigured'); setPage(1) },
            } : undefined}
          />
          <KpiCard
            presentation="band"
            title="広告とつないだ"
            icon={<Megaphone size={16} aria-hidden="true" />}
            value={adConnected ? adConnected.total : null}
            unit={adConnected ? '件' : ''}
            detail={adNamesSub}
            action={{ label: '広告連携を開く', href: '/inflow-links?tab=ads' }}
          />
        </KpiBand>
      </>}
      folders={<>
        <FolderPanel
          createAction={createButton}
          reserveCreateSpace={false}
          activeId={selectedGenre}
          onSelect={selectGenre}
          onAddFolder={canManageFolders ? () => setEditingGenre('new') : undefined}
          addFolderLabel="フォルダを追加"
          rows={folderRows}
        >
          <FolderPanelNote>フォルダを消しても、中の経路は未分類に残ります</FolderPanelNote>
        </FolderPanel>
      </>}
      collapsedFolders={<>{createButton}{folderSelect}</>}
      toolbar={<>{auxiliaryError ? <ListState kind="error" title="候補を読み込めませんでした" onRetry={() => setAuxiliaryRetry(value => value + 1)} /> : null}{toolbar}</>}
      pagination={pager}
      overlays={<>
        <ConfirmDialog
          open={stopTarget !== null}
          title={`「${stopTarget?.name ?? ''}」の受付を停止しますか？`}
          description="この経路からの新しい受付が止まります。再開するまで、お客さまはこのリンクから登録できません。"
          confirmLabel="受付を停止する"
          destructive
          error={stopError || undefined} onSuccess={() => { activeStop.current = null; setStopTarget(null) }} onCancel={() => { activeStop.current = null; setStopTarget(null); setStopError('') }}
          onConfirm={async () => {
            if (!stopTarget || activeStop.current !== stopTarget || stopTarget.generation !== accountScope.current.generation) return false
            return toggleRouteActive(stopTarget.id, false, stopTarget.name, true)
          }}
        >
          <OperationTargetSummary accounts={[{ id: stopTarget?.routeAccountId ?? '', label: '経路の所属LINEアカウント' }]} externalTarget={{ label: '対象件数', name: stopTarget ? '1件' : null }} />
          <p>受付先のすべてのアカウントは確認できません。リンクの設定や利用時の指定によって変わります。</p>
        </ConfirmDialog>
        <ConfirmDialog
          open={deleteTarget !== null}
          title={`「${deleteTarget?.name ?? ''}」を削除しますか？`}
          description="利用履歴がない経路だけ完全に削除できます。URL・QRコードから開けなくなり、元には戻せません。友だちや付いたタグは消えません。"
          confirmLabel="削除する" destructive
          confirmDisabled={!deleteTarget || deleteName !== deleteTarget.name || !canManageRole(role)}
          confirmDisabledReason="経路名を正確に入力してください。"
          onCancel={() => { activeDelete.current = null; setDeleteTarget(null); setDeleteName('') }}
          onSuccess={() => { activeDelete.current = null; setDeleteTarget(null); setDeleteName(''); void load() }}
          onConfirm={async () => {
            if (!deleteTarget || activeDelete.current !== deleteTarget || deleteTarget.generation !== accountScope.current.generation || !canManageRole(role) || deleteTarget.accountId !== latestAccountRef.current || deleteName !== deleteTarget.name) return false
            try {
              const response = await fetchApi<{ success: boolean; error?: string }>(`/api/entry-routes/${encodeURIComponent(deleteTarget.id)}`, { method: 'DELETE', body: JSON.stringify({ confirmationName: deleteName }) })
              if (!response.success) return { status: 'failed' as const, error: response.error, message: response.error || '削除できませんでした。' }
              return true
            } catch (error) {
              return { status: 'failed' as const, error, message: japaneseDetailOf(error) || describeApiFailure(error, '削除') }
            }
          }}
        >
          <OperationTargetSummary accounts={[{ id: deleteTarget?.routeAccountId ?? '', label: '経路の所属LINEアカウント' }]} externalTarget={{ label: '対象件数', name: deleteTarget ? '1件' : null }} />
          <p>受付先のすべてのアカウントは確認できません。リンクの設定や利用時の指定によって変わります。</p>
          <Field required label={`完全削除するには「${deleteTarget?.name ?? ''}」と入力`}>
            <TextField required value={deleteName} onChange={event => setDeleteName(event.target.value)} autoComplete="off" />
          </Field>
        </ConfirmDialog>
        {routeEditor}
        {editingGenre ? (
          <GenreDialog
            genre={editingGenre === 'new' ? null : editingGenre}
            onClose={() => setEditingGenre(null)}
            onSaved={(savedGenre, previousName) => {
              setGenres((current) => previousName
                ? current.map((genre) => (genre.id === savedGenre.id ? savedGenre : genre))
                : [...current, savedGenre])
              if (previousName) {
                setRoutes((current) => current.map((route) => (route.genre === previousName ? { ...route, genre: savedGenre.name } : route)))
              }
              setSelectedGenre(savedGenre.name)
              setEditingGenre(null)
            }}
          />
        ) : null}
        {qrRoute ? <QrDialog route={qrRoute} routes={routes} onClose={() => setQrRoute(null)} /> : null}
        {bulkAction ? (
          <BulkDialog
            scopeRef={accountScope}
            targets={selectedRoutes}
            genreOptions={genreNames}
            initialAction={bulkAction}
            onApplied={(remainingIds) => {
              // 反映できなかった分だけを選んだ状態に戻す。
              setSelectedRouteIds(new Set(remainingIds))
              void load()
            }}
            onClose={() => setBulkAction(null)}
          />
        ) : null}
      </>}
    >
      {listBody}
    </ListPage></SaveErrorScope>
  )
}
