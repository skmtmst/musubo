'use client'

import { KpiValueMotionProvider } from '@/components/shared/kpi-value-motion'
import { jstDate } from '@/lib/jst-datetime'
import { useAttentionStarMotion } from '@/components/shared/use-attention-star-motion'

import Avatar from '@/components/shared/avatar';
import IconButton from '@/components/shared/icon-button';
import PageSizeSelect from '@/components/shared/page-size-select';
import { scoreBoundary,validAdvancedSearch } from './list-search-validation';

import { RowMenu } from '@/components/shared/row-actions';
import { ListToolbarEnd,ListToolbarFrame,ListToolbarRow,ListToolbarSearchSlot,ListToolbarSort,ResponsiveFilterChips } from '@/components/shared/list-toolbar';

import { collectListRows } from '@/components/shared/collect-list-rows';
import Link from '@/components/shared/list-navigation';
import { useListScrollMemory,useListUrlJsonValue,useListUrlValue } from '@/components/shared/list-url-state';
import StatusBadge from '@/components/shared/status-badge';
import DeltaChip from '@/components/shared/delta-chip';
import { statusLabel } from '@/lib/status-labels';
import { SUPPORT_STATUS_TONES } from '@/components/shared/status-pill';
import TagOverflow from '@/components/shared/tag-overflow';
import { Bookmark,CircleDot,Columns3,Download,Megaphone,MessageSquare,SlidersHorizontal,Star,Upload,UserPlus,UserRoundX,Users,type LucideIcon } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useCallback,useEffect,useMemo,useRef,useState } from 'react';

import AdvancedSearchDialog,{ type AdvancedSearchResult } from '@/components/friends/advanced-search-dialog';
import BulkRunDialog from '@/components/friends/bulk-run-dialog';
import { canRunBulk } from '@/components/friends/bulk-run-view';
import FriendRowMenu from '@/components/friends/friend-row-menu';
import NoticeDialog from '@/components/friends/notice-dialog';
import SavedSearchDialog from '@/components/friends/saved-search-dialog';
import { conditionsToEditorState,savedSearchParams,savedSearchSummary } from '@/components/friends/saved-search-utils';
import SingleFriendActions,{ type FriendAction } from '@/components/friends/single-friend-actions';
import BulkBar from '@/components/shared/bulk-bar';
import Button from '@/components/shared/button';
import Checkbox from '@/components/shared/checkbox';
import Chip from '@/components/shared/chip';
import Dialog from '@/components/shared/dialog';
import DisplayItemsDialog from '@/components/shared/display-items-dialog';
import { emptyValue, EmptyCell } from '@/components/shared/empty-value';
import EntitySelect,{ entityOptionMetadata } from '@/components/shared/entity-select';
import FilterChip from '@/components/shared/filter-chip';
import { FilterPopover } from '@/components/shared/filter-popover';
import KpiBand from '@/components/shared/kpi-band';
import KpiCard from '@/components/shared/kpi-card';
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation';
import { useListUrlState } from '@/components/shared/list-url-state'
import { RefreshCover } from '@/components/shared/refresh-cover'
import { useListSnapshot } from '@/lib/use-list-snapshot'
import ListState from '@/components/shared/list-state';
import { PAGE_SIZES as STANDARD_PAGE_SIZES } from '@/components/shared/page-size-select';
import Pagination,{ paginationSummary } from '@/components/shared/pagination';
import ReadOnlyNotice from '@/components/shared/read-only-notice';
import { SaveErrorField } from '@/components/shared/save-form-errors';
import SearchField from '@/components/shared/search-field';
import Select from '@/components/shared/select';
import { DelayedSkeleton,Skeleton } from '@/components/shared/skeleton';
import { DataTable,RowNameLink,TableHeadRow,Td,Th,Tr } from '@/components/shared/table';
import { TableBody } from '@/components/shared/table-body';
import TagPill from '@/components/shared/tag-pill';
import { notifyToast } from '@/components/shared/toast';
import { usePageTitle } from '@/components/shell/page-chrome';
import { ListPage } from '@/components/templates';
import { ListPager } from '@/components/templates/list-page';
import { useAccount } from '@/contexts/account-context';
import { api,ApiError,fetchApi,type FriendListItem,type FriendStats,type SupportMarkListItem } from '@/lib/api';
import { csvFileName } from '@/lib/csv-file-name';
import { formatNumber } from '@/lib/format';
import { buildBroadcastHandoff } from '@/lib/friends-broadcast-condition';
import { loadOperators } from '@/lib/operators-cache';
import { canManageRole,useStaffRole } from '@/lib/staff-role';
import { useFeatureVisibility } from '@/lib/use-feature-visibility';
import { useNarrowViewport } from '@/lib/use-narrow-viewport';
import { BASIC_FRIEND_FIELDS,kpiChangeTone,type Folder,type FriendField,type Scenario,type Tag } from '@line-crm/shared';
import { FriendsTabs } from '../shared/head';
import { canEditFeature } from '@/lib/staff-capability'
import { csvExportLine } from './csv-export';
import { emptyMessageOf, hasAnyFilter } from './empty';
import { prefixed } from './list-filter-options';
import { readFriendsListSnapshot,writeFriendsListSnapshot } from './list-state';
import styles from './list.module.css';
import { lastContactOf,messageWord,monthDay,monthDayTime,statusOf } from './words';


/*
 * ★V8 友だち一覧（Pencil ：閲覧のみ。いつもの形は同じ板からボタンを出したもの）。
 *
 * 管理画面 の一覧（app/friends/page.tsx の FriendsPageInner）とは別の部品として持つ。
 * 呼ぶ API・送る形・保存先（sessionStorage・localStorage）は今と同じ。
 * 違いは見せ方だけ：頭（題・CSVで書き出す・CSVから取り込む）→ 閲覧のみの帯 → タブ → 数の帯 →
 * 道具2段（探す・絞り込み4つ・詳細条件・保存した検索／未対応・注目のみ・件数・
 * 表示項目・件数・並び）→ 表（□・☆・友だち・対応/担当・シナリオ・最新・タグ・流入元・最終接触・…）→ ページ送り。
 */

const friendKey = (friend: FriendListItem) => friend.id
const PAGE_SIZE_OPTIONS = STANDARD_PAGE_SIZES
type PageSize = (typeof PAGE_SIZE_OPTIONS)[number]
type SortMode = 'recent' | 'oldest'
type ResponseFilter = 'all' | 'unhandled'
type Notice = { title: string; message: string } | null
const EMPTY_URL_FILTERS = { q: '', tag: '', advanced: '', responseFilter: 'all', operatorId: '', scenarioId: '', attentionOnly: '', scoreMin: '', scoreMax: '', scoredOnly: '', audienceId: '', savedSearch: '', page: '1' }

/** 増減の符号を全角の＋／−にそろえる（R1・10-29 オーナー「おすすめで」）。半角の - は使わない。 */
const signedDeltaText = (value: number, digits: string) =>
  value < 0 ? digits.replace(/^-/, '−') : `＋${digits}`

/** 友だち一覧の数の帯の1マス。増減の向きは共通の kpiChangeTone（増えると良い）で決め、画面で色は選ばない。 */
type FriendKpi = {
  key: string; title: string; icon: LucideIcon; value: number | null; detail: string
  delta: { text: string; tone: 'up' | 'down' | 'warn' } | null; href: string
}

/** 札の色の口。要確認は黄、ほかは増減の向きのまま緑・赤へつなぐ。 */
const deltaTone = (tone: 'up' | 'down' | 'warn'): 'up' | 'down' | 'attention' =>
  tone === 'warn' ? 'attention' : tone

type LoadStatus = 'loading' | 'ready' | 'error'
type Column = string

const COLUMNS: Array<{ key: Column; label: string }> = [
  { key: 'support', label: '対応・担当' },
  { key: 'scenario', label: 'シナリオ' },
  { key: 'latest', label: '最新の受信' },
  { key: 'tags', label: 'タグ' },
  { key: 'source', label: '流入元' },
  { key: 'last', label: '最終接触' },
]

const VIEWER_NOTE = '閲覧のみで見ています。変える操作はオーナーか管理者に頼んでください。'

function isPageSize(value: number): value is PageSize {
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(value)
}

/** シナリオの列：状態は地の色の札（動いている＝緑「有効」・停止中＝灰）、シナリオ名は札の右。札と同じ言葉なら重ねて書かない。 */
function ScenarioState({ scenario }: { scenario: { name: string; status: string } }) {
  const running = scenario.status === 'active' || scenario.status === 'delivering'
  const label = running ? statusLabel('active') : scenario.status === 'paused' ? '停止中' : statusLabel(scenario.status)
  return (
    <span className={styles.scenarioCell} title={scenario.name}>
      <StatusBadge tone={running ? 'success' : 'neutral'} size="compact">{label}</StatusBadge>
      {statusLabel(scenario.name.trim()) === label ? null : <span className={styles.cellText}>{scenario.name}</span>}
    </span>
  )
}

export default function FriendsListV8() {
  const attentionMotion = useAttentionStarMotion()
  usePageTitle('友だち')
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const featureVisibility = useFeatureVisibility(selectedAccountId)
  const marksEnabled = featureVisibility.enabled('support_marks')
  const savedSearchEnabled = featureVisibility.enabled('saved_searches')
  const staffRole = useStaffRole()
  const manager = canManageRole(staffRole)
  const canEditFriends = canEditFeature('/friends', staffRole)
  const canEditChats = canEditFeature('/chats', staffRole)
  const readOnly = !canEditFriends && !canEditChats
  const canImport = manager

  const router = useRouter()
  const searchParams = useSearchParams()
  const scoreMin = scoreBoundary(searchParams.get('scoreMin'))
  const scoreMax = scoreBoundary(searchParams.get('scoreMax'))
  const hasScoreRange = scoreMin !== undefined || scoreMax !== undefined
  const scoredOnly = searchParams.get('scoredOnly') === '1'
  const audienceId = searchParams.get('audienceId')?.trim() || ''
  const directSavedSearchId = searchParams.get('savedSearch')
  const directTagId = (searchParams.get('tag') ?? '').trim()
  const directQuery = (searchParams.get('q') ?? '').trim()

  const [fieldDefinitions, setFieldDefinitions] = useState<FriendField[]>([])
  const [fieldFolders, setFieldFolders] = useState<Folder[]>([])
  const [fieldsReady, setFieldsReady] = useState(false)
  const [fieldNames, setFieldNames] = useState<string[]>([])
  const [allTags, setAllTags] = useState<Tag[]>([])
  const [operators, setOperators] = useState<Array<{ id: string; name: string }>>([])
  const [scenarios, setScenarios] = useState<Scenario[]>([])
  const [marks, setMarks] = useState<SupportMarkListItem[]>([])
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [savedOpen, setSavedOpen] = useState(false)
  const [advanced, setAdvanced] = useListUrlJsonValue<AdvancedSearchResult | null>('advanced', null, validAdvancedSearch)
  const [page, setPage] = useListUrlValue('page', 1)
  const [pageSize, setPageSize] = useListUrlValue<PageSize>('pageSize', 20)
  const [selectedTagId, setSelectedTagId] = useListUrlValue('tag', '')
  const [searchInput, setSearchInput] = useListUrlValue('q', '')
  const [searchSubmitted, setSearchSubmitted] = useListUrlValue('q', '')
  const [sortMode, setSortMode] = useListUrlValue<SortMode>('sortMode', 'recent')
  const [responseFilter, setResponseFilter] = useListUrlValue<ResponseFilter>('responseFilter', 'all')
  const [operatorId, setOperatorId] = useListUrlValue('operatorId', '')
  const [scenarioId, setScenarioId] = useListUrlValue('scenarioId', '')
  const [attentionOnly, setAttentionOnly] = useListUrlValue('attentionOnly', false)
  const [refreshing, setRefreshing] = useState(false)
  const [optionsFailed, setOptionsFailed] = useState(false)
  const [selectionFriends, setSelectionFriends] = useState<FriendListItem[]>([])
  const [bulkOpen, setBulkOpen] = useState(false)
  const [rowAction, setRowAction] = useState<{ friend: FriendListItem; action: FriendAction } | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const attentionSavingRef = useRef(new Map<string, object>())
  const loadRequestRef = useRef(0)

  useEffect(() => { setRowAction(null) }, [selectedAccountId])

  /* ── 表示項目（今と同じ保存先 `friends.visibleColumns`） ── */
  const [visible, setVisible] = useState<Set<Column>>(() => new Set(COLUMNS.map((column) => column.key)))
  const [columnsReady, setColumnsReady] = useState(false)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [fieldCatalogRevision, setFieldCatalogRevision] = useState(0)
  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('friends.visibleColumns') ?? 'null') as unknown
      if (Array.isArray(stored)) setVisible(new Set(stored.filter((key): key is Column => typeof key === 'string' && (COLUMNS.some(column => column.key === key) || BASIC_FRIEND_FIELDS.some(field => key === `fixed:${field.key}`) || /^field:[a-zA-Z0-9_-]{1,128}$/.test(key)))))
    } catch {
      // 壊れた保存値は既定の列で開く。
    } finally {
      setColumnsReady(true)
    }
  }, [])
  useEffect(() => {
    if (!columnsReady) return
    try { localStorage.setItem('friends.visibleColumns', JSON.stringify([...visible])) } catch { /* 保存できなくても一覧は動く */ }
  }, [columnsReady, visible])

  const narrow = useNarrowViewport()
  const maxColumns = narrow ? 4 : 7
  const columnItems = useMemo(() => [
    ...COLUMNS.map(column => ({...column, group:'今の列'})),
    ...BASIC_FRIEND_FIELDS.map(field => ({key:`fixed:${field.key}`,label:field.label,group:'決まった欄（回答フォームの答えが入ります）'})),
    ...fieldDefinitions.filter(field => !field.fixedKey && field.status !== 'archived').map(field => ({key:`field:${field.id}`,label:field.name,group:`お店が作った情報欄 / ${fieldFolders.find(folder => folder.id === field.folderId)?.name ?? '未分類'}`})),
  ], [fieldDefinitions, fieldFolders])
  const displayColumns = useMemo(() => [...visible].map(key => columnItems.find(column => column.key === key)).filter((column): column is typeof columnItems[number] => Boolean(column)).slice(0,maxColumns), [visible, columnItems, maxColumns])
  const requestedFieldColumns = displayColumns.filter(column => column.key.startsWith('fixed:') || column.key.startsWith('field:')).map(column => column.key).join('|')
  const listScope = JSON.stringify([selectedAccountId, page, pageSize, advanced, selectedTagId, searchSubmitted, responseFilter, operatorId, scenarioId, attentionOnly, scoreMin, scoreMax, scoredOnly, audienceId, requestedFieldColumns, sortMode])
  const { value: friends, setValue: setFriends } = useListSnapshot<FriendListItem[]>(listScope, [])
  const { value: total, setValue: setTotal } = useListSnapshot(listScope, 0)
  const { value: loadStatus, setValue: setLoadStatus } = useListSnapshot<LoadStatus>(listScope, 'loading')
  const selectionScope = JSON.stringify([listScope, staffRole, canEditFriends, canEditChats])
  const { value: selectedIds, setValue: setSelectedIds } = useListSnapshot<Set<string>>(selectionScope, new Set())
  useEffect(() => { setBulkOpen(false); setSelectionFriends([]); setRowAction(null) }, [selectionScope])
  const clearSelection = useCallback(() => setSelectedIds(new Set()), [setSelectedIds])
  const identity = useMemo(() => ({}), [selectionScope])
  // 権限の確定では一覧を取り直さず、選択と保存操作だけを無効にする。
  const readIdentity = useMemo(() => ({}), [listScope])
  const loadContextRef = useRef({ accountId: selectedAccountId, scope: listScope, identity, readIdentity, setSelectedIds })
  loadContextRef.current = { accountId: selectedAccountId, scope: listScope, identity, readIdentity, setSelectedIds }
  const displayedFriendsRef = useRef(friends)
  displayedFriendsRef.current = friends
  const hasRowsRef = useRef(false)
  hasRowsRef.current = loadStatus === 'ready'

  useEffect(() => {
    if (!fieldsReady) return
    setVisible(current => {
      const kept = [...current].filter(key => columnItems.some(column => column.key === key))
      return kept.length === current.size ? current : new Set(kept)
    })
  }, [fieldsReady, columnItems])

  /* ── 数の帯（今の FriendKpis と同じ口・同じ守り） ── */
  const [stats, setStats] = useState<FriendStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(true)
  const [statsFailed, setStatsFailed] = useState(false)
  const statsRequestRef = useRef(0)
  const loadStats = useCallback(async (accountId: string | null) => {
    const requestId = ++statsRequestRef.current
    setStats(null)
    setStatsFailed(false)
    setStatsLoading(true)
    try {
      const res = await api.friendStats.get(accountId ?? undefined)
      if (statsRequestRef.current !== requestId) return
      if (res.success) setStats(res.data)
      else setStatsFailed(true)
    } catch {
      if (statsRequestRef.current === requestId) setStatsFailed(true)
    } finally {
      if (statsRequestRef.current === requestId) setStatsLoading(false)
    }
  }, [])
  useEffect(() => { void loadStats(selectedAccountId) }, [selectedAccountId, loadStats])

  /* ── 一覧の状態の保存・復元（IDEA-03・今と同じ） ── */
  const restoredRef = useRef<string | null>(null)
  const [restoredAccount, setRestoredAccount] = useState<string | null>(null)
  const restored = !accountLoading && Boolean(selectedAccountId) && restoredAccount === selectedAccountId
  const hasExplicitUrlFilters = ['advanced', 'q', 'tag', 'sortMode', 'responseFilter', 'operatorId', 'scenarioId', 'attentionOnly', 'page', 'pageSize'].some((key) => searchParams.has(key)) || hasScoreRange || audienceId !== '' || Boolean(directSavedSearchId) || directTagId !== '' || directQuery !== ''
  useEffect(() => {
    if (accountLoading || !selectedAccountId || restoredRef.current === selectedAccountId) return
    restoredRef.current = selectedAccountId
    if (!hasExplicitUrlFilters && selectedAccountId) {
      const snapshot = readFriendsListSnapshot(selectedAccountId)
      if (snapshot) {
        setSearchInput(snapshot.searchInput)
        setSearchSubmitted(snapshot.searchSubmitted)
        setSelectedTagId(snapshot.selectedTagId)
        setResponseFilter(snapshot.responseFilter)
        setOperatorId(snapshot.operatorId)
        setScenarioId(snapshot.scenarioId)
        setAttentionOnly(snapshot.attentionOnly)
        setSortMode(snapshot.sortMode)
        if (isPageSize(snapshot.pageSize)) setPageSize(snapshot.pageSize)
        setPage(snapshot.page)
        setAdvanced(snapshot.advanced)
      } else {
        setSearchInput(''); setSearchSubmitted(''); setSelectedTagId(''); setResponseFilter('all')
        setOperatorId(''); setScenarioId(''); setAttentionOnly(false); setSortMode('recent'); setPageSize(20); setPage(1); setAdvanced(null)
      }
    }
    setRestoredAccount(selectedAccountId)
  }, [accountLoading, selectedAccountId, hasExplicitUrlFilters])

  useEffect(() => {
    if (!restored || !selectedAccountId) return
    writeFriendsListSnapshot(selectedAccountId, {
      searchInput, searchSubmitted, selectedTagId, responseFilter, operatorId, scenarioId,
      attentionOnly, sortMode, page, pageSize, advanced,
    })
  }, [restored, selectedAccountId, searchInput, searchSubmitted, selectedTagId, responseFilter, operatorId, scenarioId, attentionOnly, sortMode, page, pageSize, advanced])
  /*
   * 打って 300ms 止まったら自動で絞り込む（Enter 不要。動きの点検・9）。Enter はすぐ絞る。
   * 控えから戻した直後（入力と絞り込みが同じ）は何もしない。
   */
  useEffect(() => {
    if (!restored) return
    const next = searchInput.trim()
    if (next === searchSubmitted) return
     setSearchSubmitted(next); setPage(1)
  }, [restored, searchInput, searchSubmitted])

  /* 絞り込みは上の控えが戻す。スクロール位置も、戻ったときだけ同じ所へ戻す（動きの点検 5 番）。 */
  useListScrollMemory(restored && loadStatus === 'ready')

  const emptyFilters = {
    search: searchSubmitted,
    tagId: selectedTagId,
    advanced: advanced !== null,
    others: responseFilter !== 'all' || operatorId !== '' || scenarioId !== '' || attentionOnly || hasScoreRange || scoredOnly || audienceId !== '' || Boolean(directSavedSearchId),
  }
  const emptyMessage = emptyMessageOf(emptyFilters)
  const [, setEmptyFilters] = useListUrlState(EMPTY_URL_FILTERS)
  const clearEmptyFilters = () => setEmptyFilters(EMPTY_URL_FILTERS)
  const emptyFiltered = hasAnyFilter(emptyFilters)
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const broadcastHandoff = useMemo(() => buildBroadcastHandoff({
    searchSubmitted, selectedTagId, responseFilter, operatorId, scenarioId, attentionOnly,
    scoreMin, scoreMax, scoredOnly, audienceId, advanced,
  }), [searchSubmitted, selectedTagId, responseFilter, operatorId, scenarioId, attentionOnly, scoreMin, scoreMax, scoredOnly, audienceId, advanced])
  const broadcastHandoffHref = broadcastHandoff.kind === 'ready' && canRunBulk(staffRole)
    ? `/broadcasts/new?condition=${encodeURIComponent(JSON.stringify(broadcastHandoff.condition))}`
    : null

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [setSelectedIds])

  const fieldsEnabled = featureVisibility.enabled('friend_fields')
  useEffect(() => {
    let cancelled = false
    setFieldNames([]); setFieldDefinitions([]); setFieldFolders([]); setFieldsReady(false)
    if (!selectedAccountId || !fieldsEnabled) return
    void Promise.all([api.friendFields.list(selectedAccountId), api.folders.list('friend_field', selectedAccountId).catch(() => null)]).then(([response, folders]) => {
      if (cancelled) return
      if (response.success) {setFieldNames(response.data.map(field => field.name)); setFieldDefinitions(response.data); setFieldsReady(true)}
      if (folders?.success) setFieldFolders(folders.data)
    }).catch(() => { if (!cancelled) setOptionsFailed(true) })
    return () => { cancelled = true }
  }, [selectedAccountId, fieldsEnabled, fieldCatalogRevision])

  const loadOptions = useCallback(async () => {
    const requestedAccountId = selectedAccountId
    try {
      const [tagResponse, operatorResponse, scenarioResponse] = await Promise.all([
        api.tags.list(requestedAccountId ? { accountId: requestedAccountId } : undefined),
        loadOperators(requestedAccountId),
        api.scenarios.list(requestedAccountId ? { accountId: requestedAccountId } : undefined),
      ])
      if (loadContextRef.current.accountId !== requestedAccountId) return
      if (tagResponse.success) setAllTags(tagResponse.data)
      if (operatorResponse.success) setOperators(operatorResponse.data)
      if (scenarioResponse.success) setScenarios(scenarioResponse.data)
      setOptionsFailed(false)
    } catch {
      if (loadContextRef.current.accountId !== requestedAccountId) return
      setOptionsFailed(true)
    }
  }, [selectedAccountId])

  const loadMarks = useCallback(async () => {
    const requestedAccountId = selectedAccountId
    if (!requestedAccountId || !marksEnabled) {
      setMarks([])
      return
    }
    try {
      const markResponse = await api.supportMarks.list(requestedAccountId, { suppressFeatureDisabledEvent: true })
      if (loadContextRef.current.accountId !== requestedAccountId) return
      if (markResponse.success) setMarks(markResponse.data)
    } catch {
      if (loadContextRef.current.accountId !== requestedAccountId) return
      setOptionsFailed(true)
    }
  }, [selectedAccountId, marksEnabled])

  const selectAllFriends = async () => {
    const request = loadRequestRef.current
    const all = await collectListRows(total, async (offset, limit) => {
      const response = await api.friends.list({
        ...(advanced?.params ?? {}),
        offset: String(offset),
        limit,
        tagId: selectedTagId || undefined,
        accountId: selectedAccountId || undefined,
        audienceId: audienceId || undefined,
        search: searchSubmitted || undefined,
        includeChatStatus: true,
        fieldColumns: requestedFieldColumns ? requestedFieldColumns.split('|') : undefined,
        sort: sortMode,
        handled: responseFilter === 'unhandled' ? 'unhandled' : undefined,
        operatorId: operatorId || undefined,
        scenarioId: scenarioId || undefined,
        metadata: attentionOnly ? { __attention: '1' } : undefined,
        scoreMin,
        scoreMax,
        scoredOnly: scoredOnly || undefined,
      })
      if (!response.success) throw new Error('読み込めませんでした')
      return response.data
    })
    if (request !== loadRequestRef.current || loadContextRef.current.scope !== listScope || loadContextRef.current.identity !== identity) return
    setSelectionFriends(all)
    setSelectedIds(new Set(all.map(friend => friend.id)))
  }

  const loadFriends = useCallback(async () => {
    if (loadContextRef.current.readIdentity !== readIdentity) return
    const requestId = ++loadRequestRef.current
    const requestedScope = listScope
    if (hasRowsRef.current) {
      setRefreshing(true)
    } else {
      setLoadStatus('loading')
      setFriends([])
      setTotal(0)
    }
    if (!hasRowsRef.current) { setRefreshing(false); setBulkOpen(false) }
    const stale = () => {
      return requestId !== loadRequestRef.current || loadContextRef.current.scope !== requestedScope || loadContextRef.current.readIdentity !== readIdentity
    }
    try {
      const response = await api.friends.list({
        ...(advanced?.params ?? {}),
        offset: String((page - 1) * pageSize),
        limit: pageSize,
        tagId: selectedTagId || undefined,
        accountId: selectedAccountId || undefined,
        audienceId: audienceId || undefined,
        search: searchSubmitted || undefined,
        includeChatStatus: true,
        fieldColumns: requestedFieldColumns ? requestedFieldColumns.split('|') : undefined,
        sort: sortMode,
        handled: responseFilter === 'unhandled' ? 'unhandled' : undefined,
        operatorId: operatorId || undefined,
        scenarioId: scenarioId || undefined,
        metadata: attentionOnly ? { __attention: '1' } : undefined,
        scoreMin,
        scoreMax,
        scoredOnly: scoredOnly || undefined,
      })
      if (stale()) return
      if (response.success) {
        // 一部のページだけでは、見えない行が対象から除かれたかは分からない。
        if (response.data.items.length >= response.data.total) {
          const returnedIds = new Set(response.data.items.map(friend => friend.id))
          loadContextRef.current.setSelectedIds(ids => new Set([...ids].filter(id => returnedIds.has(id))))
        }
        setFriends(response.data.items)
        setTotal(response.data.total)
        setLoadStatus('ready')
      } else {
        setFriends([])
        setTotal(0)
        setLoadStatus('error')
      }
      setRefreshing(false)
      return response.success
    } catch {
      if (stale()) return
      setFriends([])
      setTotal(0)
      setLoadStatus('error')
      setRefreshing(false)
    }
    return false
  }, [advanced, attentionOnly, audienceId, operatorId, page, pageSize, responseFilter, scenarioId, scoreMax, scoreMin, scoredOnly, searchSubmitted, selectedAccountId, selectedTagId, sortMode, requestedFieldColumns, listScope, readIdentity, setFriends, setTotal, setLoadStatus])

  useEffect(() => void loadOptions(), [loadOptions])
  useEffect(() => void loadMarks(), [loadMarks])
  useEffect(() => setPage(1), [selectedAccountId])
  useEffect(() => {
    if (!directSavedSearchId || !savedSearchEnabled || !selectedAccountId) return
    let cancelled = false
    const accountId = selectedAccountId
    const savedId = directSavedSearchId
    setAdvanced({ params: { savedSearchId: savedId }, summary: ['保存した検索を適用中'] })
    setPage(1)
    void api.savedSearches.detail(savedId, accountId).then((res) => {
      if (cancelled || !res.success) return
      const params = savedSearchParams(savedId, res.data.conditions)
      setAdvanced({
        params,
        summary: [`対象：${res.data.name}`, ...savedSearchSummary(res.data.conditions, allTags)],
        editorState: conditionsToEditorState(res.data.conditions),
      })
      if (params.sort) setSortMode(params.sort)
      if (params.limit && isPageSize(Number(params.limit))) setPageSize(Number(params.limit) as PageSize)
      setPage(1)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [directSavedSearchId, savedSearchEnabled, selectedAccountId, allTags])
  useEffect(() => {
    if (!restored) return
    void loadFriends()
    return () => { loadRequestRef.current += 1 }
  }, [loadFriends, restored])
  useEffect(() => {
    if (loadStatus === 'ready' && page > totalPages) setPage(totalPages)
  }, [loadStatus, page, totalPages])

  const resetPageWith = (update: () => void) => {
    update()
    setPage(1)
  }

  const applyFriendTags = useCallback((friendId: string, next: Tag[]) => {
    const previous = friends.find((friend) => friend.id === friendId)?.tags ?? []
    setFriends((current) => current.map((friend) => (friend.id === friendId ? { ...friend, tags: next } : friend)))
    return () => {
      setFriends((current) => current.map((friend) => (friend.id === friendId ? { ...friend, tags: previous } : friend)))
    }
  }, [friends, setFriends])

  const exportCurrentPage = useCallback(() => {
    const header = ['友だち名', '対応', 'シナリオ', '最新の受信メッセージ', '流入元', '登録日']
    const rows = friends.map((friend) => [
      friend.displayName,
      statusOf(friend.chatStatus).label,
      friend.activeScenario?.name ?? '',
      friend.latestIncomingMessage?.content ?? '',
      friend.firstTrackedLinkName ?? '',
      friend.createdAt.slice(0, 10),
    ])
    // 先頭 =+-@ の数式インジェクション対策つき。出るのは表示中のページ分だけ。
    const csv = [header, ...rows].map((row) => csvExportLine(row)).join('\n')
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = csvFileName("友だち")
    anchor.click()
    URL.revokeObjectURL(url)
  }, [friends])

  /*
   * 注目の ★ は押した瞬間に変え、裏で保存する（動きの点検・7）。失敗したら元に戻して知らせる。
   * ほかの変更と重なった（409）ときは、最新を読み直して知らせる。
   */
  const toggleAttention = useCallback(async (friend: FriendListItem) => {
    const savingScope = listScope
    const savingIdentity = identity
    const savingKey = `${savingScope}:${friend.id}`
    if (attentionSavingRef.current.get(savingKey) === savingIdentity) return
    attentionSavingRef.current.set(savingKey, savingIdentity)
    const current = String(friend.metadata?.__attention ?? '') === '1'
    const apply = (on: boolean) => setFriends((rows) => rows.map((row) => (
      row.id === friend.id ? { ...row, metadata: { ...(row.metadata ?? {}), __attention: on ? '1' : null } } : row
    )))
    apply(!current)
    try {
      const saved = await fetchApi<{ success: boolean; data: Pick<FriendListItem, 'metadata' | 'updatedAt'> }>(
        `/api/friends/${friend.id}/metadata?expectedUpdatedAt=${encodeURIComponent(friend.updatedAt)}`,
        { method: 'PUT', body: JSON.stringify({ __attention: current ? null : '1' }) },
      )
      if (loadContextRef.current.identity !== savingIdentity) return
      if (!saved.success || !saved.data?.updatedAt) throw new Error('保存後の状態を確認できませんでした。時間をおいて、もう一度お試しください。')
      // 保存前に始まった一覧の応答で、新しい版を上書きしない。
      loadRequestRef.current += 1
      setRefreshing(false)
      setFriends(rows => rows.map(row => row.id === friend.id ? { ...row, ...saved.data } : row))
      if (attentionOnly || advanced || audienceId) {
        if (attentionOnly && current) {
          setFriends(rows => rows.filter(row => row.id !== friend.id))
          setTotal(count => Math.max(0, count - 1))
          setSelectedIds(ids => new Set([...ids].filter(id => id !== friend.id)))
        }
        void loadFriends()
      }
    } catch (error) {
      if (loadContextRef.current.identity !== savingIdentity) return
      apply(current)
      if (error instanceof ApiError && error.status === 409) {
        const refreshed = await loadFriends()
        if (loadContextRef.current.identity !== savingIdentity) return
        notifyToast(refreshed
          ? '注目がほかの変更と重なりました。最新の状態を読み直したので、確かめてもう一度押してください。'
          : '注目がほかの変更と重なりました。最新の状態を読み込めませんでした。一覧をもう一度読み直してください。', { tone: 'error' })
      } else {
        notifyToast('注目を変えられませんでした。', { tone: 'error', actionLabel: 'もう一度', onAction: () => { if (loadContextRef.current.identity === savingIdentity) { const latest = displayedFriendsRef.current.find(row => row.id === friend.id); if (latest) void toggleAttentionRef.current(latest) } } })
      }
    } finally {
      if (attentionSavingRef.current.get(savingKey) === savingIdentity) attentionSavingRef.current.delete(savingKey)
    }
  }, [loadFriends, setFriends, setTotal, setSelectedIds, listScope, identity, attentionOnly, advanced, audienceId])
  const toggleAttentionRef = useRef(toggleAttention)
  toggleAttentionRef.current = toggleAttention

  const allowedActions = useMemo<FriendAction[]>(() => [
    ...(canRunBulk(staffRole) || canEditFriends ? ['tag', 'field'] as FriendAction[] : []),
    ...(canRunBulk(staffRole) || canEditChats ? ['status', 'operator', 'template'] as FriendAction[] : []),
    ...(canRunBulk(staffRole) ? ['scenario', 'reminder'] as FriendAction[] : []),
  ], [staffRole, canEditFriends, canEditChats])
  const rowCanEdit = canRunBulk(staffRole) || canEditFriends
  const selectedCount = friends.filter((friend) => selectedIds.has(friend.id)).length
  const allSelected = friends.length > 0 && selectedCount === friends.length
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1
  const rangeEnd = Math.min(page * pageSize, total)

  /* ── 数の帯 ── */
  const addedDiff = stats ? stats.addedThisMonth - stats.addedLastMonth : 0
  const activeDelta = stats?.activeMonthDelta ?? null
  const kpis: FriendKpi[] = [
    {
      key: 'active', title: '有効な友だち', icon: Users, value: stats?.active ?? null,
      detail: stats ? `総友だち ${formatNumber(stats.total)}` : statsFailed ? '読み込めませんでした' : emptyValue('unknown'),
      delta: activeDelta != null && activeDelta !== 0 ? { text: signedDeltaText(activeDelta, formatNumber(activeDelta)), tone: kpiChangeTone('high', activeDelta) === 'good' ? 'up' : 'down' } : null,
      href: '/chats',
    },
    {
      key: 'blocked', title: 'ブロック・非表示', icon: UserRoundX, value: stats ? stats.blockedByThem + stats.hiddenByUs : null,
      detail: stats ? `相手から ${stats.blockedByThem}・自分から ${stats.hiddenByUs}` : statsFailed ? '読み込めませんでした' : emptyValue('unknown'),
      delta: null,
      href: '/chats',
    },
    {
      key: 'unanswered', title: '未対応', icon: MessageSquare, value: stats?.unanswered ?? null,
      detail: stats ? `対応済み ${formatNumber(stats.resolved)}` : statsFailed ? '読み込めませんでした' : emptyValue('unknown'),
      delta: stats && stats.unanswered > 0 ? { text: '要確認', tone: 'warn' } : null,
      href: '/chats?status=unread',
    },
    {
      key: 'added', title: '今月の追加', icon: UserPlus, value: stats?.addedThisMonth ?? null,
      detail: stats ? `前月 ${formatNumber(stats.addedLastMonth)}人` : statsFailed ? '読み込めませんでした' : emptyValue('unknown'),
      delta: stats && addedDiff !== 0 ? { text: signedDeltaText(addedDiff, String(addedDiff)), tone: kpiChangeTone('high', addedDiff) === 'good' ? 'up' : 'down' } : null,
      href: '/chats',
    },
  ]

  const statsBand = (
    <KpiBand data-design="V8FriendKpis">
      {kpis.map((kpi) => (
        <KpiCard
          key={kpi.key}
          presentation="band"
          density="compact"
          title={kpi.title}
          icon={<kpi.icon size={16} aria-hidden="true" />}
          value={kpi.value}
          unit="人"
          loading={statsLoading}
          detail={kpi.detail}
          onRetry={statsFailed ? () => void loadStats(selectedAccountId) : undefined}
          delta={kpi.delta ? (
            <DeltaChip tone={deltaTone(kpi.delta.tone)}>{kpi.delta.text}</DeltaChip>
          ) : undefined}
        />
      ))}
    </KpiBand>
  )

  const headActions = (
    <>
      <Button type="button" variant="primary" onClick={exportCurrentPage} disabled={loadStatus !== 'ready'} disabledReason={loadStatus !== 'ready' ? '一覧の読み込み後に書き出せます' : undefined}>
        <Download size={16} aria-hidden="true" />
        表示中をCSVで書き出す
      </Button>
      {/* 閲覧のみは押せないボタンを置かない。CSV が右端へ寄る（絵 x6QsVz）。 */}
      {canImport ? (
        <Button variant="secondary" href="/friends/migrations">
          <Upload size={16} aria-hidden="true" />
          CSVから取り込む
        </Button>
      ) : null}
    </>
  )

  const primaryFilter = (
    <SaveErrorField names={["selectedTagId","tagId","selected_tag_id"]}><EntitySelect kind="tag" aria-label="タグで絞り込む" width={119} value={selectedTagId} valuePrefix="タグ"
          onChange={(value) => resetPageWith(() => setSelectedTagId(value))}
          options={prefixed('タグ', [{ value: '', label: 'すべて' }, ...allTags.map((tag) => ({ ...entityOptionMetadata(tag), value: tag.id, label: tag.name }))])} /></SaveErrorField>
  )
  const openColumns = () => {setFieldCatalogRevision(current => current+1);setColumnsOpen(true)}
  const extraFilterCount = Number(responseFilter !== 'all') + Number(Boolean(operatorId)) + Number(Boolean(scenarioId)) + Number(advanced !== null)
  const toolbar = (
    <>
    <ListToolbarFrame layout="stacked" data-design="V8SearchPanel">
      <ListToolbarRow as="form"
        onSubmit={(event) => {
          event.preventDefault()
          resetPageWith(() => setSearchSubmitted(searchInput.trim()))
        }}
      >
        <ListToolbarSearchSlot>
          <SearchField
            className={styles.searchField}
            aria-label="名前・LINE名・タグ・メモで探す"
            value={searchInput}
            onChange={(value) => {
              setSearchInput(value)
              if (!value.trim() && searchSubmitted) resetPageWith(() => setSearchSubmitted(''))
            }}
            onClear={() => {
              setSearchInput('')
              if (searchSubmitted) resetPageWith(() => setSearchSubmitted(''))
            }}
            placeholder="名前・LINE名・タグ・メモで探す"
          />
        </ListToolbarSearchSlot>
        {/* 閉じた欄は「タグ：すべて」（絵どおり。valuePrefix が頭を付け、既定は灰・選択で黒太字＋緑枠）。
            先頭の口（leading）は白い板が狭い時だけ出るので、広い幅で消えないよう検索の隣に置く。 */}
        {primaryFilter}

        <FilterPopover open={filtersOpen} onClose={() => setFiltersOpen(false)} label="絞り込み"
          trigger={<FilterChip selected={extraFilterCount > 0} showCheck={false} count={extraFilterCount || undefined} aria-haspopup="dialog" aria-expanded={filtersOpen} onChange={() => setFiltersOpen(!filtersOpen)}>絞り込み</FilterChip>}
          actions={<Button onClick={() => setFiltersOpen(false)}>閉じる</Button>}>
        <SaveErrorField names={["responseFilter","response_filter"]}><Select aria-label="対応状況で絞り込む" size="full" value={responseFilter}
          onChange={(value) => resetPageWith(() => setResponseFilter(value as ResponseFilter))}
          options={prefixed('対応', [{ value: 'all', label: 'すべて' }, { value: 'unhandled', label: '未対応のみ' }])} /></SaveErrorField>
        <SaveErrorField names={["operatorId","operator_id"]}><EntitySelect aria-label="担当で絞り込む" size="full" value={operatorId} valuePrefix="担当者"
          onChange={(value) => resetPageWith(() => setOperatorId(value))}
          options={prefixed('担当者', [{ value: '', label: 'すべて' }, ...operators.map((operator) => ({ ...entityOptionMetadata(operator), value: operator.id, label: operator.name }))])} /></SaveErrorField>
        <SaveErrorField names={["scenarioId","scenario_id"]}><EntitySelect kind="scenario" aria-label="シナリオで絞り込む" size="full" value={scenarioId} valuePrefix="シナリオ"
          onChange={(value) => resetPageWith(() => setScenarioId(value))}
          options={prefixed('シナリオ', [{ value: '', label: 'すべて' }, ...scenarios.map((scenario) => ({ ...entityOptionMetadata(scenario), value: scenario.id, label: scenario.name }))])} /></SaveErrorField>
        <Button fullWidth filterActive={advanced !== null} aria-haspopup="dialog"
          onClick={() => { setFiltersOpen(false); setAdvancedOpen(true) }}
        >
          <SlidersHorizontal size={16} aria-hidden="true" />
          詳細条件
        </Button>
        </FilterPopover>
      </ListToolbarRow>
      <ListToolbarRow>
        {/* 絵 y2n1z：1152 でも［未対応］［注目のみ］は札のまま（「状態」の選ぶ欄に畳まない）。 */}
        <div role="group" aria-label="すばやく絞り込む" className={styles.chips}><ResponsiveFilterChips preserveChips>
          <FilterChip selected={responseFilter === 'unhandled'} icon={<CircleDot size={16} aria-hidden="true" />} onChange={() => resetPageWith(() => setResponseFilter(responseFilter === 'unhandled' ? 'all' : 'unhandled'))}>
            未対応
          </FilterChip>
          <FilterChip selected={attentionOnly} onChange={() => resetPageWith(() => setAttentionOnly(!attentionOnly))} icon={<Star size={16} aria-hidden="true" />}>
            注目のみ
          </FilterChip>
        </ResponsiveFilterChips></div>
        <span className={styles.count}>{loadStatus === 'ready' ? `${formatNumber(total)}件` : emptyValue('unknown')}</span>
        <span className={styles.spacer} />
        {selectedCount > 0 ? <span className={styles.selectedCount}>{selectedCount} 件選択中</span> : null}
        {columnsOpen && !readOnly ? <DisplayItemsDialog presentation="columns" items={columnItems} selected={[...visible]} maxSelected={maxColumns} manageHref="/tags?tab=fields" onCancel={() => setColumnsOpen(false)} onConfirm={keys => {setVisible(new Set(keys));setColumnsOpen(false)}} /> : null}
        {/* 絞り込みと操作を分け、操作は右端へ集める。 */}
        <ListToolbarEnd>
        <SaveErrorField names={["pageSize","limit","page_size"]}><PageSizeSelect label={null} options={PAGE_SIZE_OPTIONS} value={pageSize} onChange={(value) => resetPageWith(() => setPageSize(value as PageSize))} /></SaveErrorField>
        <SaveErrorField names={["sortMode","sort","sort_mode"]}><ListToolbarSort
          aria-label="並び順"
          treatment="text"
          width={171}
          value={sortMode}
          onChange={(value) => resetPageWith(() => setSortMode(value as SortMode))}
          options={[{ value: 'recent', label: '友だち追加の新しい順' }, { value: 'oldest', label: '友だち追加の古い順' }]}
        /></SaveErrorField>
        <RowMenu appearance="box" label="一覧のほかの操作" items={[
          ...(!readOnly ? [{ id: 'columns', label: '表示項目を編集', icon: <Columns3 size={16} aria-hidden="true" />, onSelect: openColumns }] : []),
          ...(savedSearchEnabled ? [{ id: 'saved-search', label: '保存した検索', icon: <Bookmark size={16} aria-hidden="true" />, onSelect: () => setSavedOpen(true) }] : []),
          ...(broadcastHandoffHref ? [{ id: 'broadcast', label: 'この条件で配信を作る', icon: <Megaphone size={16} aria-hidden="true" />, href: broadcastHandoffHref }] : []),
          { id: 'export', label: '表示中をCSVで書き出す', icon: <Download size={16} aria-hidden="true" />, disabled: loadStatus !== 'ready', disabledReason: '一覧の読み込み後に書き出せます', onSelect: exportCurrentPage },
        ]} />
        </ListToolbarEnd>
      </ListToolbarRow>
      {advanced?.summary.length ? (
        <div className={styles.applied}>
          <span className={styles.appliedLabel}>絞り込み中</span>
          {advanced.summary.map((summary) => <Chip key={summary} tone="neutral">{summary}</Chip>)}
          <button type="button" onClick={() => resetPageWith(() => setAdvanced(null))} className={styles.linkButton}>条件を外す</button>
        </div>
      ) : null}
      {hasScoreRange ? (
        <div className={styles.applied}>
          <span>
            行動スコア：{scoreMin !== undefined ? `${scoreMin} 点以上` : ''}
            {scoreMin !== undefined && scoreMax !== undefined ? '〜' : ''}
            {scoreMax !== undefined ? `${scoreMax} 点以下` : ''}
            {scoredOnly ? '（点数がついている人のみ）' : ''}
          </span>
          <Link href="/friends" className={styles.linkButton}>この条件を外す</Link>
        </div>
      ) : null}
      {optionsFailed ? (
        <p className={styles.optionsFailed}>
          絞り込みの選択肢を読み込めませんでした。タグが空なのは、取れなかっただけかもしれません。
          <button type="button" onClick={() => { void loadOptions(); void loadMarks() }} className={styles.linkButton}>もう一度読み込む</button>
        </p>
      ) : null}
    </ListToolbarFrame>
    </>
  )

  // 閲覧のみは選んでできる操作が無いので、選ぶチェックの列を出さない。
  const selectable = !readOnly
  const colCount = (selectable ? 4 : 3) + displayColumns.length
  const renderFriendRow = useCallback((friend: FriendListItem) => {
    const status = statusOf(friend.chatStatus)
    const latest = friend.latestIncomingMessage
    const lastContact = lastContactOf(friend)
    const attention = String(friend.metadata?.__attention ?? '') === '1'
    return (
      <Tr key={friend.id} interactive href={`/friends/detail?id=${friend.id}`} onOpen={() => router.push(`/friends/detail?id=${friend.id}`)} selected={selectedIds.has(friend.id) || undefined} className={styles.row} data-friend-row data-row-id={friend.id}>
        {selectable ? (
          <Td columnKind="check">
            <Checkbox checked={selectedIds.has(friend.id)} onCheckedChange={() => toggleSelect(friend.id)} aria-label={`${friend.displayName}を選ぶ`} />
          </Td>
        ) : null}
        <Td columnKind="star">
          {rowCanEdit ? (
            <IconButton
              variant="attention"
              size="row"
              data-part="attention-star"
              data-hit-area=""
              pressed={attention}
              aria-label={`${friend.displayName}の注目を${attention ? '外す' : '付ける'}`}
              onClick={(event) => attentionMotion(event, () => toggleAttention(friend))}
            >
              <Star size={16} aria-hidden="true" />
            </IconButton>
          ) : (
            /* 16：閲覧のみは押せない星を置かない。星は付いている行だけ見せる。 */
            attention ? (
              <span className={`${styles.star} ${styles.starOn}`} title="注目">
                <Star size={16} aria-hidden="true" />
              </span>
            ) : null
          )}
        </Td>
        <Td presentation="friend-list">
          {/* 絵 nF4ts・x6QsVz：名前の前に顔の丸（写真が無ければ頭文字）。 */}
          <div className={styles.friendCell}>
            {narrow ? null : <Avatar name={friend.displayName} src={friend.pictureUrl} size={32} />}
            <RowNameLink href={`/friends/detail?id=${friend.id}`} title={friend.displayName} className={styles.friendName}>{friend.displayName}</RowNameLink>
          </div>
        </Td>
        {displayColumns.map(column => {
          if (column.key === 'support') return (
          <Td key={column.key} presentation="friend-list">
            <div className={styles.supportCell}>
              <span className={styles.statusRow}>
                <StatusBadge tone={SUPPORT_STATUS_TONES[friend.chatStatus ?? 'resolved']} title={friend.supportMark && friend.supportMark.name !== status.label ? `対応マーク：${friend.supportMark.name}` : undefined}>{status.label}</StatusBadge>
              </span>
              {/* 絵 y2n1z：札は対応の状態1つ、下の行は担当だけ。対応マークは札の title で読む（札と違う言葉を並べない）。 */}
              <span className={styles.sub}>{`担当：${friend.operator?.name ?? 'なし'}`}</span>
            </div>
          </Td>
          )
          if (column.key === 'scenario') return (
          <Td key={column.key} presentation="friend-list" className={styles.fixedContent}>{friend.activeScenario ? <ScenarioState scenario={friend.activeScenario} /> : <EmptyCell />}</Td>
          )
          if (column.key === 'latest') return (
          <Td key={column.key} presentation="friend-list">
            {latest ? (
              <div className={styles.twoLine}>
                <span className={styles.cellText} title={latest.content}>{messageWord(latest)}</span>
                <span className={styles.sub}>{monthDayTime(latest.createdAt)}</span>
              </div>
            ) : <EmptyCell />}
          </Td>
          )
          if (column.key === 'tags') return (
          <Td key={column.key} presentation="friend-list" className={styles.fixedContent}>
            <div className={styles.tags} title={friend.tags.map((tag) => tag.name).join('・') || undefined}>
              <TagOverflow>{friend.tags.map((tag) => <TagPill key={tag.id} name={tag.name} color={tag.color} size="sm" />)}</TagOverflow>

              {friend.tags.length === 0 ? <EmptyCell /> : null}
            </div>
          </Td>
          )
          if (column.key === 'source') return (
          <Td key={column.key} presentation="friend-list" className={styles.fixedContent}>{friend.firstTrackedLinkName ? <span className={styles.cellText} title={friend.firstTrackedLinkName}>{friend.firstTrackedLinkName}</span> : <EmptyCell />}</Td>
          )
          if (column.key === 'last') return (
          <Td key={column.key} presentation="friend-list" className={styles.fixedContent}><span className={styles.cellText} title={monthDayTime(lastContact)}>{monthDay(lastContact)}</span></Td>
          )
          const value = friend.fieldValues?.[column.key]
          return <Td key={column.key}>{value ? <span className={styles.cellText} title={value}>{value}</span> : <EmptyCell />}</Td>
        })}
        <Td columnKind="menu">
          <div className={styles.menuBox}>
            <FriendRowMenu
              friendId={friend.id}
              friendName={friend.displayName}
              attention={attention}
              canEdit={rowCanEdit}
              allowedActions={allowedActions}
              onAction={(action) => setRowAction({ friend, action })}
              onToggleAttention={() => void toggleAttention(friend)}
            />
          </div>
        </Td>
      </Tr>
    )
  }, [attentionMotion, selectable, router, selectedIds, toggleSelect, rowCanEdit, toggleAttention, narrow, displayColumns, allowedActions])
  const table = (
    <RefreshCover refreshing={refreshing && loadStatus === 'ready'}><div className={styles.tableWrap} aria-busy={loadStatus === 'loading' || refreshing || undefined}>
      <DataTable cellPresentation="friends" data-design="V8FriendTable">
        <colgroup>
          {selectable ? <col className={styles.colCheck} /> : null}
          <col className={styles.colStar} />
          {/* 1152（y2n1z）：顔の丸を外して名前の列を詰め、対応・シナリオの列を狭めてタグ名を全部入れる。 */}
          <col className={narrow ? styles.colNameNarrow : styles.colName} />
          {displayColumns.map(column => <col key={column.key} className={narrow ? column.key === 'support' ? styles.colSupportNarrow : column.key === 'scenario' ? styles.colScenarioNarrow : column.key === 'latest' ? styles.colLatestNarrow : column.key.startsWith('fixed:') || column.key.startsWith('field:') ? styles.colFieldNarrow : undefined : column.key === 'support' ? styles.colSupport : column.key === 'scenario' ? styles.colScenario : column.key === 'tags' ? styles.colTags : column.key === 'source' ? styles.colSource : undefined} />)}
          <col className={styles.colMenu} />
        </colgroup>
        <thead>
          <TableHeadRow>
            {selectable ? (
              <Th columnKind="check">
                <SaveErrorField names={["allSelected","selectedIds","all_selected","selected_ids"]}><Checkbox
                  checked={allSelected}
                  indeterminate={selectedCount > 0 && !allSelected}
                  onCheckedChange={(checked) => setSelectedIds(checked ? new Set(friends.map((friend) => friend.id)) : new Set())}
                  aria-label="表示中の友だちをすべて選ぶ"
                /></SaveErrorField>
              </Th>
            ) : null}
            <Th colSpan={2} columnKind="name">
              <span className={styles.thFriendInner}><Star size={16} aria-label="注目" className={styles.thStar} />友だち</span>
            </Th>
            {displayColumns.map((column) => (
              <Th key={column.key}>{column.label}</Th>
            ))}
            <Th columnKind="menu"><span className="sr-only">操作</span></Th>
          </TableHeadRow>
        </thead>
        <TableBody
          items={loadStatus === 'ready' ? friends : []}
          itemKey={friendKey}
          colSpan={colCount}
          renderRow={renderFriendRow}
        >
          {loadStatus === 'loading' ? (
            <tr>
              <td colSpan={colCount}>
                <DelayedSkeleton
                  loading
                  skeleton={(
                    <div aria-hidden="true">
                      {[0, 1, 2, 3, 4, 5].map((row) => (
                        <div key={row} className={styles.skeletonRow}>
                          <Skeleton className={styles.skelBox} />
                          <Skeleton circle className={styles.skelAvatar} />
                          <Skeleton className={styles.skelName} />
                          <Skeleton className={styles.skelCell} />
                          <Skeleton className={styles.skelCell} />
                        </div>
                      ))}
                    </div>
                  )}
                />
              </td>
            </tr>
          ) : loadStatus === 'error' ? (
            <tr>
              <td colSpan={colCount} className={styles.stateCell}>
                <ListState kind="error" title="友だちを読み込めませんでした" description="通信が切れたか、サーバが応えませんでした。しばらくしてから、もう一度試してください。" onRetry={() => void loadFriends()} />
              </td>
            </tr>
          ) : friends.length === 0 ? (
            <tr>
              <td colSpan={colCount} className={styles.stateCell}>
                <ListState kind="empty" title={emptyMessage.title} description={emptyMessage.description} emptyPreset={emptyFiltered ? 'filtered' : 'readonly'} action={emptyFiltered ? <Button onClick={clearEmptyFilters}>条件を外す</Button> : readOnly ? undefined : <Button href="/inflow-links">友だち追加の URL を作る</Button>} />
              </td>
            </tr>
          ) : null}
        </TableBody>
      </DataTable>
    </div></RefreshCover>
  )

  const pager = (
    <ListPager>
      <Pagination page={page} pageCount={totalPages} onPageChange={setPage} disabled={loadStatus !== 'ready'} ariaLabel="友だち一覧のページ"
        summary={loadStatus === 'ready' ? paginationSummary(total, rangeStart, rangeEnd, '人') : emptyValue('unknown')} />
    </ListPager>
  )

  return (
    <KpiValueMotionProvider scope={selectedAccountId ? JSON.stringify([selectedAccountId, jstDate().slice(0, 7)]) : null}>
    <ListPage
      tableInset
      heightMode="content"
      skeleton
      boardId="x6QsVz"
      headingSize="compact"
      title="友だち"
      help="LINE でつながっている人の一覧です。タグと対応の状態で絞り込めます。"
      actions={headActions}
      tabs={(
        <>
          {readOnly ? (
            <div className={styles.viewerBand}><ReadOnlyNotice role="status">{VIEWER_NOTE}</ReadOnlyNotice></div>
          ) : null}
          <FriendsTabs current="list" />
        </>
      )}
      stats={statsBand}
      toolbar={toolbar}
      overlays={(
        <>
          <span className={styles.bulkWrap} data-design="V8BulkBar">
            <BulkBar total={total} onSelectAll={selectAllFriends} count={selectedIds.size} unit="人" hint="対象を確認してから操作を選んでください" onClear={clearSelection}>
              {selectedIds.size > 1 && canRunBulk(staffRole) ? (
                <Button variant="secondary" data-qa-open="IAf7j" onClick={() => setBulkOpen(true)}>操作を選択する</Button>
              ) : null}
              {selectedIds.size > 1 && staffRole !== null && !canRunBulk(staffRole) ? (
                <span className={styles.faint}>一括操作ができるのはオーナーと管理者だけです</span>
              ) : null}
            </BulkBar>
          </span>
          <BulkRunDialog
            open={bulkOpen}
            friendIds={[...selectedIds]}
            selectedFriends={[...new Map([...selectionFriends, ...friends].map(friend => [friend.id, friend])).values()].filter(friend => selectedIds.has(friend.id))}
            tags={allTags}
            accountId={selectedAccountId}
            supportMarksEnabled={marksEnabled}
            onClose={() => setBulkOpen(false)}
            onDone={() => { clearSelection(); void loadFriends() }}
          />
          {rowAction ? (
            <Dialog open title={`${rowAction.friend.displayName}への操作`} onCancel={() => setRowAction(null)} >
              <SingleFriendActions
                friendId={rowAction.friend.id}
                friendName={rowAction.friend.displayName}
                accountId={selectedAccountId}
                tags={allTags}
                initialAction={rowAction.action}
                hideActions
                friendTags={rowAction.friend.tags}
                onFriendTagsChange={(next) => applyFriendTags(rowAction.friend.id, next)}
                onDone={() => { setSelectedIds(ids => new Set([...ids].filter(id => id !== rowAction.friend.id))); setRowAction(null); void loadFriends() }}
              />
            </Dialog>
          ) : null}
          <div data-friends-advanced-search>
            <AdvancedSearchDialog
              open={advancedOpen}
              accountId={selectedAccountId}
              tags={allTags}
              fieldNames={fieldNames}
              marks={marks}
              scenarios={scenarios}
              onClose={() => setAdvancedOpen(false)}
              onLoadSaved={() => {
                if (!savedSearchEnabled) return
                setAdvancedOpen(false)
                setSavedOpen(true)
              }}
              applied={advanced}
              initialSort={sortMode}
              initialLimit={pageSize}
              onApply={(result) => {
                setAdvanced(result)
                if (result.params.sort) setSortMode(result.params.sort)
                if (result.params.limit && isPageSize(Number(result.params.limit))) setPageSize(Number(result.params.limit) as PageSize)
                setAdvancedOpen(false)
                setPage(1)
              }}
              features={{ savedSearch: savedSearchEnabled, marks: marksEnabled, fields: featureVisibility.enabled('friend_fields') }}
            />
          </div>
          {savedOpen && savedSearchEnabled ? (
            <SavedSearchDialog
              accountId={selectedAccountId}
              tags={allTags}
              onClose={() => setSavedOpen(false)}
              onApply={(result) => {
                setAdvanced(result)
                if (result.params.sort) setSortMode(result.params.sort)
                if (result.params.limit && isPageSize(Number(result.params.limit))) setPageSize(Number(result.params.limit) as PageSize)
                setSavedOpen(false)
                setPage(1)
              }}
              onOpenAdvanced={() => {
                setSavedOpen(false)
                setAdvancedOpen(true)
              }}
            />
          ) : null}
          {notice ? <NoticeDialog notice={notice} onClose={() => setNotice(null)} /> : null}
        </>
      )}
      pagination={pager}
    >
      {table}
    </ListPage>
    </KpiValueMotionProvider>
  )
}
