'use client'

import { formatListTimestamp } from '@/lib/format'
import StatusBadge from '@/components/shared/status-badge'

import { useActionError } from '@/lib/use-action-error'

import { ListToolbarSort } from '@/components/shared/list-toolbar'
import { useListUrlValue } from '@/components/shared/list-url-state'
import { useFolderMove } from '@/components/shared/use-folder-move'
import { moveAutomationToFolder } from '@/lib/move-to-folder'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useSearchParams } from 'next/navigation'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import {
  Activity,
  Archive,
  Bookmark,
  FileWarning,
  Filter,
  LayoutTemplate,
  ListChecks,
  Pause,
  Play,
  Plus,
  Zap,
} from 'lucide-react'
import {
  automationActionLabel,
  automationTriggerLabel,
  type Folder,
} from '@line-crm/shared'
import { api, ApiError, fetchApi, type AutomationListItem } from '@/lib/api'
import { describeAutomationEditFailure } from './list-errors'
import { useAccount } from '@/contexts/account-context'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { useNarrowViewport } from '@/lib/use-narrow-viewport'
import { formatNumber } from '@/lib/format'
import { ListPage, ListPagePagination } from '@/components/templates'
import ListToolbar from '@/components/shared/list-toolbar'
import SearchField from '@/components/shared/search-field'
import Button from '@/components/shared/button'
import EmptyList from '@/components/shared/empty-list'
import Notice from '@/components/shared/notice'
import { notifyToast } from '@/components/shared/toast'
import { useListUrlState } from '@/components/shared/list-url-state'
import SegmentedControl from '@/components/shared/segmented'
import Select from '@/components/shared/select'
import PageSizeSelect from '@/components/shared/page-size-select'
import ManagedFolderPanel, { managedFolderOptions } from '@/components/shared/managed-folder-panel'
import { FolderDotName } from '@/components/shared/folder-dot'
import { ActionCell, RowNameLink, DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table'
import { type ActionMenuItem } from '@/components/shared/action-menu'
import { RowMenu } from '@/components/shared/row-actions'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import { Field } from '@/components/shared/form-controls'

import ListState from '@/components/shared/list-state'
import Pagination from '@/components/shared/pagination'
import {
  AUTOMATIONS_DESCRIPTION,
  AUTOMATION_TABLE_LAYOUT,
  AutomationBand,
  AutomationTabs,
  READONLY_REASON,
  ViewerBand,
  automationTabHref,
  useAutomationManage,
  useAutomationTabCounts,
  type BandCell,
} from './shell'
import styles from './list.module.css'
import TruncatedText from '@/components/shared/truncated-text'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField, useSaveFormErrors, SaveErrorScope } from '@/components/shared/save-form-errors'
import FriendPickerField from '@/components/shared/friend-picker-field'

/*
 * ★V8 オートメーションのルール一覧（Pencil：一覧 ・1152 ・閲覧のみ ）。
 *
 * 2026-10-06 オーナー決定で src/v8 に一から書いた。データの口・保存・権限・失敗時の扱いは
 * 今までの V8 一覧（app/automations/list-v8.tsx）と同じ（BEHAVIOR.md）。違いは見せ方だけ——
 * 型（ListPage）に、タブ・数の帯・左のフォルダの列（上に「ルールを作る」）・案内の帯・
 * 道具の段・表（列の並び）を渡す。行の右端は「編集する」と「…」。
 */

type ApiResponse<T> = { success: true; data: T } | { success: false; error: string }
type LoadStatus = 'loading' | 'ready' | 'error'
type Automation = AutomationListItem

type RunsSummary = {
  total: number
  executed: number
  skipped: number
  failed: number
}

/** よく使う絞り込み（数えられるものだけ）と並び。既定は更新が新しい順（絵の並び）。 */
type SavedKey = '' | 'failed' | 'idle' | 'runs' | 'name'
const SAVED_OPTIONS: Array<{ value: SavedKey; label: string }> = [
  { value: '', label: 'よく使う絞り込み' },
  { value: 'failed', label: '失敗があったルール' },
  { value: 'idle', label: 'この30日に動いていないルール' },
  { value: 'runs', label: '動いた回数が多い順' },
  { value: 'name', label: '名前順' },
]

const UNFILED = '__unfiled__'

/** きっかけの1行。言葉で動くものは言葉まで（「〇〇」と送られた）、ほかは正本の名前。 */
export function triggerSummary(item: Pick<Automation, 'eventType' | 'triggerConfig' | 'conditions'>): string {
  const config = item.triggerConfig ?? {}
  const keyword = typeof config.keyword === 'string' ? config.keyword.trim() : ''
  if (item.eventType === 'message_received' && keyword) return `「${keyword}」と送られた`
  return automationTriggerLabel(item.eventType)
}

/** だれに（条件）の1行。条件が無ければ全員。 */
export function conditionSummary(conditions: Record<string, unknown>): string {
  const keyword = typeof conditions.keyword === 'string' ? conditions.keyword.trim() : ''
  if (keyword) return `「${keyword}」を含む人`
  if (Object.keys(conditions).length === 0) return '全員'
  return '登録した条件'
}

/** すること：1行目に最初の処理、2行目に残りの処理（正本の名前）。 */
export function actionSummary(item: Pick<Automation, 'actions'>): { title: string; detail: string } {
  const [first, ...rest] = item.actions
  if (!first) return { title: '登録した処理', detail: '' }
  return {
    title: automationActionLabel(first.type),
    detail: rest.map((action) => automationActionLabel(action.type)).join('・'),
  }
}

function TableHead({ selection }: { selection?: ReactNode } = {}) {
  return (
    <thead>
      <TableHeadRow data-table-layout="columns">
        <Th grow>{selection}ルール</Th>
        <Th className={styles.colTrigger}>きっかけ</Th>
        <Th collapseAt="narrow" className={styles.colWho}>だれに（条件）</Th>
        <Th className={styles.colDo}>すること</Th>
        <Th className={styles.colRuns} align="right">この30日</Th>
        <Th className={styles.colState}>状態</Th>
        <Th className={styles.colOps}>操作</Th>
      </TableHeadRow>
    </thead>
  )
}

export default function AutomationListV8() {
  const saveErrors = useSaveFormErrors()
  usePageTitle('オートメーション')
  usePageCrumbs([{ label: 'ホーム', href: '/' }])
  const router = useRouter()
  const searchParams = useSearchParams()
  const { selectedAccountId, loading: accountLoading } = useAccount()
  // 1152 の板（）。道具の段の並びと列だけを切り替える。
  const narrow = useNarrowViewport()
  /*
   * 閲覧のみ（変える権限が無い人）：作る・編集・複製・1人で試す・止める・削除・フォルダを追加は
   * 置かずに隠す（場所だけ空ける。2026-10-06 オーナー決定）。役割が読めるまで（null）は今までどおり出す。
   */
  const canManage = useAutomationManage()
  const canEdit = canManage === true
  const viewerOnly = canManage === false

  const [items, setItems] = useState<Automation[]>([])
  const [loadStatus, setLoadStatus] = useState<LoadStatus>('loading')
  const [summary, setSummary] = useState<{ executionCount30d: number; failureCount30d: number } | null>(null)
  const [skipped, setSkipped] = useState<number | null>(null)
  const [folders, setFolders] = useState<Folder[]>([])
  const [foldersError,setFoldersError]=useState(false)
  const [folderFilter, setFolderFilter] = useListUrlValue('folderFilter', '')
  /* ?search= で開くと、その言葉で探した状態から始める（動いた記録の「ルールを開く」）。 */
  const [search, setSearch] = useListUrlValue('search', '')
  const [onlyActive, setOnlyActive] = useListUrlValue('onlyActive', false)
  const [onlyStopped, setOnlyStopped] = useListUrlValue('onlyStopped', false)
  const [saved, setSaved] = useListUrlValue<SavedKey>('saved', '')
  const [sort, setSort] = useListUrlValue<'updated' | 'runs' | 'name'>('sort', 'updated')
  const [pageSize, setPageSize] = useListUrlValue('pageSize', 20)
  const [page, setPage] = useListUrlValue('page', 1)
  const [view, setView] = useListUrlState({ archived: '' })
  const onlyArchived = view.archived === '1'
  const folderItems = items.filter(item => (item.status === 'archived') === onlyArchived)
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const [rowBusyId, setRowBusyId] = useState<string | null>(null)
  const { error: actionError, setError: setActionError } = useActionError(selectedAccountId ?? '')
  const [pending, setPending] = useState<{ kind: 'toggle' | 'archive' | 'restore'; item: Automation; accountId: string | null } | null>(null)
  const [working, setWorking] = useState(false)
  const [testing, setTesting] = useState<Automation | null>(null)
  const [testFriendId, setTestFriendId] = useState('')
  const [testBusy, setTestBusy] = useState(false)
  const [testError, setTestError] = useState('')
  const [testDone, setTestDone] = useState(false)
  const requestRef = useRef(0)
  const selectedAccountIdRef = useRef(selectedAccountId)
  selectedAccountIdRef.current = selectedAccountId
  const rowActionLockRef = useRef<object | null>(null)
  const pendingLockRef = useRef<object | null>(null)

  const load = useCallback(async () => {
    const requestId = ++requestRef.current
    setLoadStatus('loading')
    try {
      const [listRes, runsRes] = await Promise.all([
        api.automations.list({ accountId: selectedAccountId || undefined, includeArchived: true }),
        selectedAccountId
          ? fetchApi<ApiResponse<{ summary: RunsSummary }>>(
            `/api/automation-runs?lineAccountId=${encodeURIComponent(selectedAccountId)}&limit=1`,
          ).catch(() => null)
          : Promise.resolve(null),
      ])
      if (requestId !== requestRef.current) return
      if (!listRes.success) throw new Error(listRes.error)
      setItems(listRes.data)
      setSummary(listRes.summary ?? null)
      setSkipped(runsRes && runsRes.success ? runsRes.data.summary.skipped : null)
      setLoadStatus('ready')
    } catch {
      if (requestId !== requestRef.current) return
      setItems([])
      setSummary(null)
      setSkipped(null)
      setLoadStatus('error')
    }
  }, [selectedAccountId])

  /* フォルダの箱（kind=automation）。ルールをフォルダへ入れる口がまだ無いので、件数は出さない。 */
  const loadFolders = useCallback(async () => {
    if (!selectedAccountId) { setFolders([]); return }
    setFoldersError(false)
    try {
      const res = await api.folders.list('automation', selectedAccountId)
      if(!res.success)throw new Error(res.error)
      setFolders(res.data)
    } catch {
      setFoldersError(true)
    }
  }, [selectedAccountId])

  useEffect(() => {
    if (accountLoading) return
    void load()
    return () => { requestRef.current += 1 }
  }, [accountLoading, load])
  useEffect(() => { void loadFolders() }, [loadFolders])
  useEffect(() => {
    setFolderFilter(''); setPending(null); setRowBusyId(null); setWorking(false)
    rowActionLockRef.current = null; pendingLockRef.current = null
  }, [selectedAccountId])

  const currentRules = items.filter((item) => item.status !== 'archived')
  const tabCounts = useAutomationTabCounts(loadStatus === 'ready' ? currentRules.length : null)

  const activeCount = useMemo(() => items.filter((item) => item.status !== 'archived' && item.isActive).length, [items])
  const stoppedCount = items.filter((item) => item.status !== 'archived' && !item.isActive).length
  /** 動かしているのに、この30日に一度も動いていないルール。 */
  const neverRunCount = useMemo(() => items.filter((item) => item.status !== 'archived' && item.isActive && item.executionCount30d === 0).length, [items])

  const visible = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('ja')
    const filtered = items.filter((item) => {
      // 分類先のIDで絞り、未分類にはフォルダのない行だけを出す。
      if (folderFilter === UNFILED ? Boolean(item.folderId) : folderFilter !== '' && item.folderId !== folderFilter) return false
      if ((item.status === 'archived') !== onlyArchived) return false
      if (onlyActive && !item.isActive) return false
      if (onlyStopped && item.isActive) return false
      if (saved === 'failed' && item.failureCount30d === 0) return false
      if (saved === 'idle' && item.executionCount30d > 0) return false
      if (!query) return true
      const actions = item.actions.map((action) => automationActionLabel(action.type)).join(' ')
      return `${item.name} ${item.description ?? ''} ${automationTriggerLabel(item.eventType)} ${triggerSummary(item)} ${actions}`
        .toLocaleLowerCase('ja')
        .includes(query)
    })
    return [...filtered].sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name, 'ja')
      if (sort === 'runs') return b.executionCount30d - a.executionCount30d || a.name.localeCompare(b.name, 'ja')
      return b.updatedAt.localeCompare(a.updatedAt)
    })
  }, [items, search, folderFilter, onlyActive, onlyStopped, onlyArchived, saved, sort])

  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize))
  const current = Math.min(Math.max(1, page), pageCount)
  const paged = visible.slice((current - 1) * pageSize, current * pageSize)
  useEffect(() => { setPage(1) }, [search, folderFilter, onlyActive, onlyStopped, onlyArchived, saved, sort, pageSize, selectedAccountId])

  const folderMove = useFolderMove({
    accountId: selectedAccountId, canEdit: canEdit, items: paged, folders,
    move: (item, folderId) => moveAutomationToFolder(item.id, selectedAccountId!, folderId),
    onChanged: async () => { await load(); await loadFolders() },
  })

  const runRowAction = async (fn: () => Promise<void>, id: string) => {
    if (rowActionLockRef.current || !selectedAccountId || !canEdit) return
    const accountAtStart = selectedAccountId
    const lock = {}
    rowActionLockRef.current = lock
    setRowBusyId(id)
    setActionError('')
    try {
      await fn()
      if (selectedAccountIdRef.current !== accountAtStart) return
      await load()
    } catch (caught) {
      if (selectedAccountIdRef.current !== accountAtStart) return
      if (caught instanceof ApiError && (caught.status === 404 || caught.status === 409)) await load()
      if (selectedAccountIdRef.current === accountAtStart) setActionError(describeAutomationEditFailure(caught))
    } finally {
      if (rowActionLockRef.current === lock) { rowActionLockRef.current = null; setRowBusyId(null) }
    }
  }

  /* 「編集する」は改訂用の下書きを作って（あれば同じ下書き）開く。「複製する」は写しの下書き。 */
  const openEditor = async (id: string, duplicate: boolean) => {
    const accountAtStart = selectedAccountId
    await runRowAction(async () => {
      const res = duplicate ? await api.automations.duplicate(id) : await api.automations.createDraftFromAutomation(id)
      if (!res.success) throw new Error(res.error)
      if (selectedAccountIdRef.current !== accountAtStart) return
      router.push(`/automations/drafts?id=${encodeURIComponent(res.data.id)}`)
    }, id)
  }

  const confirmPending = async () => {
    if (!pending || pendingLockRef.current || !selectedAccountId || !canEdit || pending.accountId !== selectedAccountIdRef.current) return
    const accountAtStart = pending.accountId
    const lock = {}
    pendingLockRef.current = lock
    setWorking(true)
    setActionError('')
    try {
      if (pending.kind !== 'restore' && !Number.isSafeInteger(pending.item.confirmationRevision)) throw new Error('確認した版がありません')
      const status = pending.kind === 'archive' ? 'archived' : pending.item.isActive ? 'stopped' : 'active'
      const res = pending.kind === 'restore'
        ? await api.automations.restore(pending.item.id, selectedAccountId)
        : await api.automations.setStatus(pending.item.id, status, pending.item.confirmationRevision)
      if (!res.success) throw new Error(res.error)
      if (selectedAccountIdRef.current !== accountAtStart) return
      notifyToast(pending.kind === 'restore' ? 'ルールを保管から戻しました' : pending.kind === 'archive' ? 'ルールを保管しました' : 'ルールの状態を変えました')
      setPending(null)
      await load()
    } catch (saveFailure) {
      if (selectedAccountIdRef.current !== accountAtStart) return
      const fieldFailure = saveErrors.capture(saveFailure);
      await load()
      if (selectedAccountIdRef.current !== accountAtStart) return
      if (!fieldFailure) {
      setActionError(
        pending.kind === 'archive'
          ? 'このルールを保管できませんでした。状態を読み直してから、もう一度お試しください。'
          : pending.kind === 'restore' ? '保管から戻せませんでした。状態を読み直してから、もう一度お試しください。'
          : '稼働を切り替えられませんでした。状態を読み直してから、もう一度お試しください。',
      ) }
    } finally {
      if (pendingLockRef.current === lock) { pendingLockRef.current = null; setWorking(false) }
    }
  }

  const runSingleTest = async () => {
    if (!testing || !selectedAccountId || testBusy) return
    const friendId = testFriendId.trim()
    if (!friendId) {
      setTestError('試す友だちのIDを入力してください')
      return
    }
    setTestBusy(true)
    setTestError('')
    try {
      const res = await api.automations.test(testing.id, selectedAccountId, friendId)
      if (!res.success) throw new Error(res.error)
      setTestDone(true)
    } catch {
      setTestError('試しに動かせませんでした。通信を確かめて、もう一度お試しください。')
    } finally {
      setTestBusy(false)
    }
  }

  const closeTestDialog = () => {
    setTesting(null)
    setTestFriendId('')
    setTestError('')
    setTestDone(false)
  }

  const runsHref = (item: Automation) => `${automationTabHref('runs')}?search=${encodeURIComponent(item.name)}`

  /* 行の「…」：編集・複製・1人で試す・止める・動いた記録を見る・削除（閲覧のみは動いた記録だけ）。 */
  const rowMenuItems = (item: Automation): ActionMenuItem[] => {
    const busy = rowBusyId === item.id
    const runs: ActionMenuItem = { id: 'runs', label: '動いた記録を見る', onSelect: () => router.push(runsHref(item)) }
    if (!canEdit) return [runs]
    if (item.status === 'archived') return [runs, { id: 'restore', label: '保管から戻す', disabled: busy, onSelect: () => { setActionError(''); setPending({ kind: 'restore', item, accountId: selectedAccountId }) } }]
    return [
      { id: 'move', label: 'フォルダへ移す', onSelect: () => folderMove.open(item) },
      { id: 'edit', label: '編集する', disabled: busy, onSelect: () => void openEditor(item.id, false) },
      { id: 'duplicate', label: '複製する', disabled: busy, onSelect: () => void openEditor(item.id, true) },
      {
        id: 'test',
        label: '1人で試す',
        disabled: busy,
        onSelect: () => { setTesting(item); setTestFriendId(''); setTestError(''); setTestDone(false) },
      },
      { id: 'toggle', label: item.isActive ? '止める' : '動かす', disabled: busy, onSelect: () => setPending({ kind: 'toggle', item, accountId: selectedAccountId }) },
      runs,
      { id: 'archive', label: '保管する', tone: 'danger', dividerBefore: true, disabled: busy, onSelect: () => setPending({ kind: 'archive', item, accountId: selectedAccountId }) },
    ]
  }

  /* ===== 数の帯（4つ） ===== */
  const ready = loadStatus === 'ready'
  const estimatedHoursSaved = summary ? Math.round(summary.executionCount30d / 120) : null
  const cells: BandCell[] = [
    { key: 'rules', title: 'ルール', icon: <ListChecks size={16} aria-hidden="true" />, value: ready ? currentRules.length : null, unit: '件', detail: ready ? `動いている ${activeCount}・止めている ${stoppedCount}` : emptyValue('unknown') },
    { key: 'runs', title: '今月動いた', icon: <Activity size={16} aria-hidden="true" />, value: summary?.executionCount30d ?? null, unit: '回', detail: 'この30日に動いた回数' },
    { key: 'failed', title: '失敗', icon: <FileWarning size={16} aria-hidden="true" />, value: summary?.failureCount30d ?? null, unit: '件', detail: '「動いた記録」からやり直せます' },
    { key: 'skipped', title: '条件に外れた', icon: <Filter size={16} aria-hidden="true" />, value: skipped, unit: '回', detail: ready ? `稼働中で直近30日動いていないルール ${neverRunCount}` : emptyValue('unknown') },
  ]

  /* ===== フォルダ ===== */
  const folderSelect = (
    <SaveErrorField names={["folderFilter","folder_filter"]}><Select
      narrowFolderPicker aria-label="フォルダ"
      value={folderFilter}
      onChange={setFolderFilter}
      options={managedFolderOptions('automation', folders, { allId: '', unfiledId: UNFILED })}
    /></SaveErrorField>
  )
  /* 閲覧のみには押せない「ルールを作る」を置かない（場所だけ空ける）。 */
  const createButton = (full: boolean) => canEdit ? (
    <Button variant="primary" href="/automations/new" className={full ? 'v8-folder-create w-full' : undefined}>
      <Plus size={16} aria-hidden="true" />ルールを作る
    </Button>
  ) : <span className={full ? styles.createSpace : styles.createSpaceInline} aria-hidden="true" />

  /* ===== 道具の段 ===== */
  const filterChips = (
    <SegmentedControl
      aria-label="状態で絞り込む"
      value={onlyActive ? 'active' : onlyStopped ? 'stopped' : onlyArchived ? 'archived' : 'all'}
      onChange={(next) => {
        setOnlyActive(next === 'active')
        setOnlyStopped(next === 'stopped')
        setView({ archived: next === 'archived' ? '1' : '' })
      }}
      options={[
        { value: 'all', label: 'すべて' },
        { value: 'active', label: '動いている', count: ready ? activeCount : undefined },
        { value: 'stopped', label: '止めている', count: ready ? stoppedCount : undefined },
        { value: 'archived', label: '保管したもの' },
      ]}
    />
  )
  const savedBox = (
      <SaveErrorField names={["saved"]}><Select size="content" icon={<Bookmark size={16} aria-hidden="true" />} showChevron={false} aria-label="よく使う絞り込み" value={saved} onChange={(value) => {
        setSaved(value as SavedKey)
        if (value === 'name' || value === 'runs') setSort(value)
        else setSort('updated')
      }} options={SAVED_OPTIONS} /></SaveErrorField>
  )
  const perPageBox = <PageSizeSelect value={pageSize} onChange={setPageSize} options={[10, 20, 50]} label={null} />
  const notice = (
    null
  )
  /* 1152 の板：案内の帯 → 1段目「作る・フォルダ・探す」→ 2段目「札 … よく使う絞り込み・件数」。 */

  const wideToolbar = (
    <>

      <ListToolbar
        search={{ placeholder: 'ルール名・きっかけで探す', label: 'ルールを検索', width: 240, value: search, onChange: setSearch }}
        filters={filterChips}
        trailing={<>{savedBox}<SaveErrorField names={["sort"]}><ListToolbarSort aria-label="並び順" width={170} value={sort} onChange={(value) => {
          setSort(value as 'updated' | 'runs' | 'name')
          if (saved === 'runs' || saved === 'name') setSaved('')
        }} options={[
          { value: 'updated', label: '並び：更新が新しい順' },
          { value: 'runs', label: '並び：動いた回数が多い順' },
          { value: 'name', label: '並び：名前順' },
        ]} /></SaveErrorField>{perPageBox}</>}
      />
    </>
  )

  /* ===== 表 ===== */
  let listBody: ReactNode
  if (accountLoading || loadStatus === 'loading') {
    listBody = <ListState kind="loading" title="ルールを読み込んでいます" />
  } else if (!selectedAccountId) {
    listBody = <ListState kind="empty" title="LINE公式アカウントを選んでください" description="選んだアカウントのルールだけを表示します。" />
  } else if (loadStatus === 'error') {
    listBody = (
      <ListState
        kind="error"
        title="ルールを読み込めませんでした"
        description="ルールは消えていません。通信を確かめて、もう一度お試しください。"
        onRetry={() => void load()}
      />
    )
  } else if (paged.length === 0) {
    /* 修正案 D-2：空の一覧。 */
    listBody = (
      <EmptyList
        icon={<Zap aria-hidden="true" />}
        title="まだオートメーションがありません"
        description="「友だち追加でお礼を送る」など、決めた動きを自動で続けます。"
        create={{ label: '最初のオートメーションを作る', href: '/automations/new' }}
        canCreate={canEdit}
        filtered={items.length > 0}
        onClearFilters={() => { setSearch(''); setOnlyActive(false); setOnlyStopped(false); setSaved(''); setFolderFilter(''); setView({ archived: '' }) }}
        filteredDescription="検索や絞り込みを外すと、すべて出ます"
      />
    )
  } else {
    listBody = (
      <>
        {actionError ? <div className={styles.errorRow}><Notice tone="danger">{actionError}</Notice></div> : null}
        <div className={styles.tableWrap}>
          <DataTable columnLayout={AUTOMATION_TABLE_LAYOUT}>
            <TableHead selection={folderMove.pageCheckbox} />
            <tbody>
              {paged.map((item) => {
                const action = actionSummary(item)
                const busy = rowBusyId === item.id
                const menuLabel = `ルール「${item.name}」の操作`
                const trigger = triggerSummary(item)
                const who = conditionSummary(item.conditions)
                return (
                  <Tr selected={folderMove.isSelected(item.id)} key={item.id} data-table-layout="columns" data-row-id={item.id}>
                    <Td grow>
                      <FolderDotName folder={folders.find((folder) => folder.id === item.folderId) ?? null}>{folderMove.checkbox(item)}
                        {canEdit && item.status !== 'archived' ? <RowNameLink href={`/automations/drafts?automationId=${encodeURIComponent(item.id)}`} className={styles.name}><TruncatedText value={String(item.name ?? '')} /></RowNameLink> : <TruncatedText value={String(item.name ?? '')} />}
                      </FolderDotName>
                    </Td>
                    <Td className={styles.colTrigger}><TruncatedText value={trigger} /></Td>
                    <Td collapseAt="narrow" className={styles.colWho}><TruncatedText value={who} /></Td>
                    <Td className={styles.colDo}>
                      <span className={styles.cellOne} title={action.title}>{action.title}</span>
                      {action.detail ? <span className={styles.sub} title={action.detail}>{action.detail}</span> : null}
                    </Td>
                    <Td className={styles.colRuns}>
                      <span className={styles.numMain}>{`${formatNumber(item.executionCount30d)} 回`}</span>
                      <span className={styles.numSub}>
                        {item.isActive ? `失敗 ${formatNumber(item.failureCount30d)} 回` : <TruncatedText value={`更新 ${formatListTimestamp(item.updatedAt)}`} />}
                      </span>
                    </Td>
                    <Td className={styles.colState}>
                      <StatusBadge tone={(item.followupManagement?item.followupManagement.effectiveSendingStatus==='active':item.isActive)?'success':'neutral'} help={item.followupManagement?`来店フォロー（${item.followupManagement.storeName}）で管理しています。${item.followupManagement.reason??'承認された内容で送っています'}`:undefined} helpHref={item.followupManagement?.path}>
                        {item.status === 'archived' ? '保管' : (item.followupManagement?item.followupManagement.effectiveSendingStatus==='active':item.isActive) ? '動いています' : '止めています'}
                      </StatusBadge>
                    </Td>
                    <ActionCell className={styles.colOps}>
                      <div className={styles.opsBox}>

                        <RowMenu
                          label={menuLabel}
                          open={openMenuId === item.id}
                          onOpenChange={(next) => setOpenMenuId(next ? item.id : null)}
                          note={canEdit ? undefined : READONLY_REASON}
                          items={rowMenuItems(item).map((menuItem) => ({ ...menuItem, onSelect: () => { setOpenMenuId(null); menuItem.onSelect?.() } }))}
                        />
                      </div>
                    </ActionCell>
                  </Tr>
                )
              })}
            </tbody>
          </DataTable>
        </div>
      </>
    )
  }

  const pager = ready && paged.length > 0 ? (
    <ListPagePagination>
      <Pagination page={current} pageCount={pageCount} onPageChange={setPage} ariaLabel="ルール一覧のページ送り" range={{ total: visible.length, first: (current - 1) * pageSize + 1, last: (current - 1) * pageSize + paged.length }} />
    </ListPagePagination>
  ) : null

  return (
    <SaveErrorScope errors={saveErrors}><ListPage
      skeleton
      help={<>{AUTOMATIONS_DESCRIPTION}{canEdit
            ? '行の「…」から 編集・複製・1人で試す・止める・動いた記録を見る・削除。'
            : '行の「…」から 動いた記録を見る。'}{estimatedHoursSaved === null
              ? '削減時間はまだ数えられていません。'
              : `およそ${formatNumber(estimatedHoursSaved)}時間の削減（この30日の実行1回30秒として計算しています）。`}</>}
      explanation="ルールは1人で試してから動かすと、まちがいを防げます。動いた結果は「動いた記録」で見られます。"
      boardId={narrow ? 'En14p' : viewerOnly ? 'nH9L8' : 'LWQXd'}
      headingSize="regular"
      title="オートメーション"

      actions={canEdit
        ? <Button href={automationTabHref('templates')}><LayoutTemplate size={16} aria-hidden="true" />見本から作る</Button>
        : <span className={styles.createSpaceInline} aria-hidden="true" />}
      tabs={<AutomationTabs active="rules" counts={tabCounts} />}
      stats={<>
        {viewerOnly ? <ViewerBand /> : null}
        <AutomationBand label="ルールの数の帯" cells={cells} />
      </>}
      folders={foldersError?<ListState kind="error" title="フォルダを読み込めませんでした" onRetry={()=>void loadFolders()}/>:<>
        {createButton(true)}
        {/* 共通のフォルダの列（種類 automation）。ルールの一覧がフォルダを返すまでは、件数を出さずルールは未分類に数える。 */}
        <ManagedFolderPanel
          kind="automation"
          accountId={selectedAccountId}
          folders={folders}
          onChanged={loadFolders}
          canManage={canEdit}
          itemLabel="ルール"
          activeId={folderFilter}
          onSelect={setFolderFilter}
          allId=""
          unfiledId={UNFILED}
          allCount={ready ? folderItems.length : null}
          unfiledCount={ready ? folderItems.filter((item) => !item.folderId).length : null}
          countOf={folder => ready ? folderItems.filter(item => item.folderId === folder.id).length : null}
          placeholder="例： 予約・購入"
        />
      </>}
      collapsedFolders={foldersError?<ListState kind="error" title="フォルダを読み込めませんでした" onRetry={()=>void loadFolders()}/>:<>{createButton(false)}{folderSelect}</>}
      toolbar={wideToolbar}
      pagination={pager}
      overlays={<>
        {folderMove.overlays}
        <ConfirmDialog
          key={selectedAccountId}
          open={pending !== null && pending.accountId === selectedAccountId}
          title={pending ? `「${pending.item.name}」を${pending.kind === 'restore' ? '保管から戻し' : pending.kind === 'archive' ? '保管し' : pending.item.isActive ? '止め' : '動か'}ますか？` : ''}
          description={
            pending?.kind === 'restore' ? '通常の一覧へ戻します。動いた記録と設定は残り、稼働は再開しません。' : pending?.kind === 'archive'
              ? '通常の一覧から外します。動いた記録と設定は残り、「保管したもの」の絞り込みから戻せます。'
              : '切り替えても、動いた記録は残ります。'
          }
          confirmLabel={pending?.kind === 'restore' ? '保管から戻す' : pending?.kind === 'archive' ? '保管する' : pending?.item.isActive ? '止める' : '動かす'}
          destructive={pending?.kind === 'archive'}
          busy={working}
          error={actionError}
          onConfirm={pending?.accountId === selectedAccountId ? () => confirmPending() : undefined}
          onCancel={() => { if (!working) setPending(null) }}
        ><OperationTargetSummary accounts={[{ id: pending?.accountId ?? '' }]} /></ConfirmDialog>
        <Dialog
          open={testing !== null}
          dirty={testDone ? false : undefined}
          onCancel={closeTestDialog}
          title={testing ? `「${testing.name}」を1人で試す` : ''}
          description="選んだ友だち1人に、保存されている内容のまま動かします。取り消せません。"
          footer={testing && !testDone ? (<DialogActions>
              <Button variant="secondary" onClick={closeTestDialog}>やめる</Button>
              <Button onClick={() => runSingleTest()} disabled={testBusy || !testFriendId.trim()} busy={testBusy} busyLabel="動かしています…">試しに動かす</Button>
            </DialogActions>) : undefined}
        >
          {testing ? (
            <div className={styles.testBody}>
              <Field note={<>
                すること：{testing.actions.map((action) => automationActionLabel(action.type)).join('・') || '登録した処理'}
              </>} label="試す友だち">
                <SaveErrorField names={["testFriendId","test_friend_id"]}><FriendPickerField label="試す友だち" accountId={selectedAccountId ?? null}
                  value={testFriendId}
                  onChange={ setTestFriendId}
                  disabled={testBusy || testDone}
                /></SaveErrorField>
              </Field>

              {testError ? <Notice tone="danger">{testError}</Notice> : null}
              {testDone ? <Notice tone="info">試しに動かしました。「動いた記録」で結果を確かめてください。</Notice> : null}
            </div>
          ) : null}
        </Dialog>
      </>}
    >
      {listBody}
    </ListPage></SaveErrorScope>
  )
}
