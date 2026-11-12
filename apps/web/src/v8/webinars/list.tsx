'use client'
import { DetailContent, DetailField, DetailInlineEdit } from '@/components/shared/detail-content'
import DetailPanel from '@/components/shared/detail-panel';
import { useInlineDetailGuard } from '@/components/shared/use-inline-detail-guard'
import { canManageRole, useStaffRole } from '@/lib/staff-role';
import ListToolbar, { ListToolbarEnd, ListToolbarFrame, ListToolbarRow, ListToolbarSearchSlot, ListToolbarSort as SortSelect } from '@/components/shared/list-toolbar';
import { RowNameLink } from '@/components/shared/table';




import SharedStatusPill from '@/components/shared/status-pill'
import { useFeatureAccess } from '@/lib/use-feature-access';
import { Suspense, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { OverlayDepthContext } from '@/components/shared/overlay-utils'
import { useListScrollMemory, useListUrlState, useOnAccountSwitch } from '@/components/shared/list-url-state';
import type { ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { Archive, Bookmark, Download, Inbox, Plus, Video } from 'lucide-react';
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation';
import { Eye } from 'lucide-react';
import { ListPage, ListPagePagination } from '@/components/templates';
import SearchField from '@/components/shared/search-field'
import Button from '@/components/shared/button'
import EmptyList from '@/components/shared/empty-list'
import { notifyToast } from '@/components/shared/toast';
import { RowMenu } from '@/components/shared/row-actions';
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import Notice from '@/components/shared/notice'
import SegmentedControl from '@/components/shared/segmented'
import Select from '@/components/shared/select'
import PageSizeSelect from '@/components/shared/page-size-select'
import FolderEditorDialog from '@/components/shared/folder-editor-dialog'
import { FOLDER_SELECT_COLORS } from '@line-crm/shared';
import FolderPanel, { CollapsedFolderActions, FolderPanelNote, type FolderPanelRow } from '@/components/shared/folder-panel';
import { FolderDotName, type FolderDotFolder, folderDisplayColor } from '@/components/shared/folder-dot';
import { DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table';
import { type ActionMenuItem } from '@/components/shared/action-menu';
import ContextMenu, { type ContextMenuItem } from '@/components/shared/context-menu';
import InlineEdit from '@/components/shared/inline-edit'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import ListState from '@/components/shared/list-state'
import AccountRequiredState from '@/components/shared/account-required-state'
import Pagination from '@/components/shared/pagination'
import { DelayedSkeleton, Skeleton } from '@/components/shared/skeleton';
import { withViewTransition } from '@/components/shared/view-transition';
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome';
import { publicationStateLabel } from '@/components/webinars/publication-label';
import { useAccount } from '@/contexts/account-context';
import { useNarrowViewport } from '@/lib/use-narrow-viewport';
import { runUndoable } from '@/lib/undoable';
import { formatListTimestamp, formatNumber } from '@/lib/format';
import { ApiError, webinarApi, type Webinar, type WebinarFolder, type WebinarListItem, type WebinarListParams, type WebinarOverview } from '@/lib/api';
import { beforeStart, publicPath, showsCounts, statusLabel, statusTone, webinarListCsv, webinarLoadFailure, type WebinarLoadFailure } from './helpers';
import styles from './list.module.css'
import TruncatedText from '@/components/shared/truncated-text'
import { csvFileName } from '@/lib/csv-file-name';
import { emptyValue } from '@/components/shared/empty-value';
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors';
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { kpiCells } from './overview'

/*
 * ★V8 ウェビナーの一覧（Pencil：一覧 ・1152 ・閲覧のみ ・
 * アーカイブの確認 ）。
 *
 * 型（ListPage）に、数の帯・左のフォルダの列（上に「ウェビナーを作る」）・
 * 案内の帯・道具の段・表（列の並び）を渡す。行の右端は「編集」と「…」。
 * 「…」と右クリックは同じ操作（参加者・分析・コメント演出・アーカイブ）。
 * 行を押すと右に詳細が出る（↑↓で次の行へ・名前はその場で直せる）。
 *
 * データの口・保存の口・権限・失敗の扱いは BEHAVIOR.md に記録。
 */

type SortKey = 'updated' | 'created' | 'name'
type SavedFilter = '' | 'active' | 'draft' | 'archived'

const UNFILED = '__unfiled__'
const READONLY_REASON = 'この操作にはオーナーか管理者の権限が要ります'

function scheduleSummary(w: Webinar): string {
  if (w.schedule.length === 0) return '未設定'
  const DAYS = ['日', '月', '火', '水', '木', '金', '土']
  const dailyTimes = w.schedule
    .filter((rule) => rule.type === 'daily' && rule.time)
    .map((rule) => rule.time as string)
    .sort()
  const otherRules = w.schedule.filter((rule) => rule.type !== 'daily')
  const parts: string[] = []
  if (dailyTimes.length > 0) {
    const toMinutes = (time: string) => {
      const [hours, minutes] = time.split(':').map(Number)
      return hours * 60 + minutes
    }
    const intervals = dailyTimes.slice(1).map((time, index) => toMinutes(time) - toMinutes(dailyTimes[index]))
    const interval = intervals.length > 0 && intervals.every((value) => value === intervals[0]) ? intervals[0] : null
    parts.push(
      dailyTimes.length === 1
        ? `毎日 ${dailyTimes[0]}`
        : `毎日 ${dailyTimes[0]}〜${dailyTimes[dailyTimes.length - 1]}${interval ? `・${interval}分間隔` : ''}（${dailyTimes.length}枠）`,
    )
  }
  otherRules.forEach((rule) => {
    if (rule.type === 'weekly') parts.push(`毎週${(rule.days ?? []).map((day) => DAYS[day]).join('・')} ${rule.time}`)
    if (rule.type === 'once') parts.push(rule.at ? formatListTimestamp(rule.at) : '単発・日時未設定')
  })
  return parts.join(' / ')
}

function periodSummary(webinar: WebinarListItem): string {
  if (webinar.publicationState === 'scheduled') return formatListTimestamp(webinar.publicationStartsAt)
  if (webinar.publicationState === 'period' && webinar.publicationStartsAt && webinar.publicationEndsAt)
    return `${formatListTimestamp(webinar.publicationStartsAt)}〜${formatListTimestamp(webinar.publicationEndsAt)}`
  return publicationStateLabel(webinar.publicationState, webinar.publicationStartsAt, webinar.publicationEndsAt)
    ?? scheduleSummary(webinar)
}

function peopleText(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${formatNumber(value)}人` : emptyValue('unknown')
}

/** 行の「…」と右クリックの中身。2箇所で別々に書くとずれるので1つにする。 */
function rowMenuItems(
  w: WebinarListItem,
  canEdit: boolean,
  go: (href: string) => void,
  onArchive: (target: WebinarListItem) => void,
  onDuplicate: (target: WebinarListItem) => void,
  duplicating: boolean,
): ActionMenuItem[] {
  const id = encodeURIComponent(w.id)
  return [
    ...(canEdit ? [{ id: 'duplicate', label: '複製する', disabled: duplicating, onSelect: () => onDuplicate(w) }] : []),
    { id: 'participants', label: '参加者を見る', onSelect: () => go(`/webinars/edit?id=${id}&pane=participants`) },
    { id: 'analytics', label: '分析を見る', onSelect: () => go(`/webinars/edit?id=${id}&pane=analytics`) },
    { id: 'comments', label: 'コメント演出を開く', onSelect: () => go(`/webinars/edit?id=${id}&pane=comments`) },
    {
      id: 'archive',
      label: w.status === 'archived' ? '下書きに戻す' : 'アーカイブする',
      onSelect: () => onArchive(w),
    },
  ].filter((item) => canEdit || item.id !== 'archive')
}

function toContextItems(items: ActionMenuItem[]): ContextMenuItem[] {
  return items.map((item) => ({
    id: item.id,
    label: item.label,
    danger: item.tone === 'danger',
    disabled: item.disabled,
    onSelect: () => item.onSelect?.(),
  }))
}

function StatusPill({ webinar }: { webinar: WebinarListItem }) {
  return (
    <SharedStatusPill tone={statusTone(webinar) === 'active' ? 'success' : statusTone(webinar) === 'scheduled' ? 'neutral' : 'neutral'}>{statusLabel(webinar)}</SharedStatusPill>
  )
}

/*
 * アーカイブの確かめ（）。対象とアーカイブしたあとの3点を言う。
 * 公開中はこのままではアーカイブできない（先に公開を止める）。
 */
function ArchiveConfirm({
  target,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  target: WebinarListItem
  busy: boolean
  error: string | undefined
  onCancel: () => void
  onConfirm: () => void
}) {
  const blocked = target.status === 'active'
  const restoring = target.status === 'archived'
  return (
    <ConfirmDialog
      open
      designNode="VXZ6T"
      designWidth={500}
      designTop={380}
      title={restoring ? 'ウェビナーを下書きに戻しますか？' : 'ウェビナーをアーカイブしますか？'}
      /* 説明は本文の頭に置く（絵は 12px・題の下 4・×の左の幅で2行）。共通の説明の段は使わない。 */
      description=""
      designHeaderPadding="var(--tpl-fm2-wb-head-pad)"
      confirmLabel={restoring ? '下書きに戻す' : 'アーカイブする'}
      titleIcon={false}
      confirmIcon={<Archive size={16} aria-hidden="true" />}
      busy={busy}
      error={error}
      onCancel={onCancel}
      onConfirm={blocked ? undefined : onConfirm}
    >
      {/* 絵 VXZ6T：説明・対象（薄い灰の箱）・「アーカイブしたあと」の3点を 14 ずつ。消さずに残す操作なので主ボタンは緑。 */}
      <div className={styles.archiveBody}>
      <p className={styles.archiveLead}>
        {restoring ? '通常の一覧に戻します。公開するまでは、新しい申込は受け付けません。' : 'アーカイブすると、一覧から外れて新しく使えなくなります。記録は残ります。'}
      </p>
      <div className={styles.targetBox}>
        <p className={styles.targetLabel}>{restoring ? '下書きに戻す対象' : 'アーカイブする対象'}</p>
        <p className={styles.targetName}>{target.title}（{periodSummary(target)}）</p>
      </div>
      {restoring ? (
        <p className={styles.afterList}>参加者・視聴の記録・分析はそのまま残ります。</p>
      ) : (
        <div className={styles.afterGroup}>
          <p className={styles.afterTitle}>アーカイブしたあと</p>
          <ul className={styles.afterList}>
            <li>・参加者・視聴の記録・分析はそのまま見られます</li>
            <li>・公開ページは閉じ、新しい申し込みは受け付けません</li>
            <li>・絞り込みの「アーカイブ済み」から確認し、下書きに戻せます</li>
          </ul>
        </div>
      )}
      {blocked ? (
        <Notice tone="warn">
          公開中のウェビナーは、このままではアーカイブできません。先に公開を停止してから、もう一度アーカイブしてください。
          <span className={styles.dialogAction}><Button href={`/webinars/edit?id=${target.id}`}>編集画面で公開を停止する</Button></span>
        </Notice>
      ) : null}
      </div>
    </ConfirmDialog>
  )
}

/** フォルダの追加・名前の変更（右の詳細パネルの中身）。 */
function FolderForm({
  folder,
  busy,
  error,
  onCancel,
  onSave,
}: {
  folder: WebinarFolder | null
  busy: boolean
  error: string
  onCancel: () => void
  onSave: (name: string, color: string | null) => void
}) {
  const [name, setName] = useState(folder?.name ?? '')
  const [color, setColor] = useState<string | null>(folder ? folderDisplayColor(folder) : FOLDER_SELECT_COLORS[0].value)
  const depth = useContext(OverlayDepthContext)
  const initialColor = folder ? folderDisplayColor(folder) : FOLDER_SELECT_COLORS[0].value
  const guard = useUnsavedGuard({ dirty: name !== (folder?.name ?? '') || color !== initialColor || busy, busy, onDiscard: onCancel })
  return <><FolderEditorDialog open title={folder ? 'フォルダを直す' : 'フォルダを追加'}
    description="ウェビナーを分けてしまう箱です。消しても、中のウェビナーは未分類に残ります。"
    name={name} onNameChange={setName} color={color} onColorChange={setColor}
    busy={busy} error={error || undefined} placeholder="例：商品説明"
    onCancel={onCancel} onConfirm={() => onSave(name.trim(), color)} confirmLabel={folder ? '保存する' : '追加する'} />
    <OverlayDepthContext.Provider value={depth + 2}><UnsavedLeaveDialog open={guard.leaveTarget !== null} busy={busy} onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} /></OverlayDepthContext.Provider></>
}

/** 表の見出し。骨組みと本物で同じものを使う。 */
function TableHead() {
  return (
    <thead>
      <TableHeadRow className={styles.headRow} data-table-layout="columns">
        <Th className={styles.colName}>ウェビナー名</Th>
        <Th className={styles.colStatus}>状態</Th>
        <Th className={styles.colCount} align="right">申込</Th>
        <Th className={styles.colView} align="right">視聴</Th>
        <Th className={styles.colPeriod}>公開期間</Th>
        <Th className={styles.colOps}>操作</Th>
      </TableHeadRow>
    </thead>
  )
}

/**
 * 読み込み中の骨組み。本物と同じ見出し・行の高さで5行。
 * 0.3秒以内に来たら出さない（DelayedSkeleton）。
 */
function ListSkeleton() {
  return (
    <div className={styles.tableWrap} aria-busy="true">
      <span className="sr-only">ウェビナーの一覧を読み込んでいます</span>
      <DelayedSkeleton
        loading
        skeleton={
          <DataTable className={styles.table}>
            <TableHead />
            <tbody aria-hidden="true">
              {[0, 1, 2, 3, 4].map((index) => (
                <Tr key={index} className={styles.row} data-table-layout="columns">
                  <Td className={styles.colName}><Skeleton className={styles.skeletonName} /></Td>
                  <Td className={styles.colStatus}><Skeleton className={styles.skeletonPill} /></Td>
                  <Td className={styles.colCount}><Skeleton className={styles.skeletonNum} /></Td>
                  <Td className={styles.colView}><Skeleton className={styles.skeletonNum} /></Td>
                  <Td className={styles.colPeriod}><Skeleton className={styles.skeletonName} /></Td>
                  <Td className={styles.colOps}><Skeleton className={styles.skeletonPill} /></Td>
                </Tr>
              ))}
            </tbody>
          </DataTable>
        }
      />
    </div>
  )
}

export default function WebinarListV8() {
  return (
    <Suspense fallback={<ListState kind="loading" />}>
      <WebinarList />
    </Suspense>
  )
}

interface ListSnapshot {
  items: WebinarListItem[]
  total: number
  loadedAccountId: string | null
}

function WebinarList() {
  const saveErrors = useSaveFormErrors()
  usePageTitle('ウェビナー')
  usePageCrumbs([{ label: 'ホーム', href: '/' }])
  const router = useRouter()
  const narrow = useNarrowViewport()
  const { selectedAccountId, accounts, loading: accountLoading } = useAccount()
  const accountScope = useRef({ id: selectedAccountId })
  if (accountScope.current.id !== selectedAccountId) accountScope.current = { id: selectedAccountId }
  const renderedAccountScope = accountScope.current
  // 「閲覧のみ」：押せない形にする（隠さない）。
  const role = useStaffRole()
  const featureAccess = useFeatureAccess('webinars')
  const canEdit = featureAccess

  const requestGeneration = useRef(0)
  const overviewGeneration = useRef(0)
  const folderGeneration = useRef(0)
  const [items, setItems] = useState<WebinarListItem[]>([])
  const [total, setTotal] = useState(0)
  const [grandTotal, setGrandTotal] = useState(0)
  const [grandAccountId, setGrandAccountId] = useState<string | null>(null)
  const [chipCounts, setChipCounts] = useState<{ accountId: string; active: number; draft: number } | null>(null)
  const [loadedAccountId, setLoadedAccountId] = useState<string | null>(null)
  const [overview, setOverview] = useState<WebinarOverview | null>(null)
  const [overviewAccountId, setOverviewAccountId] = useState<string | null>(null)
  const [overviewFailure, setOverviewFailure] = useState<WebinarLoadFailure | null>(null)
  /*
   * 検索語・フォルダ・状態・並び順・件数・ページは URL に置く（動きの点検 5 番）。
   * 詳細へ行って「戻る」と、同じ絞り込み・同じページの一覧に戻る。
   * 絞り込みを変えたらページは 1 へ（同じ書き込みの中で戻す。効果で戻すと、来た瞬間に
   * URL から戻したページまで消える）。
   */
  const [view, setView] = useListUrlState({ q: '', folder: '', status: '', sort: 'updated', size: '20', page: '1' })
  const debouncedQuery = view.q
  const selectedFolder = view.folder
  const savedFilter: SavedFilter = (['', 'active', 'draft', 'archived'] as const).includes(view.status as SavedFilter) ? view.status as SavedFilter : ''
  const sortKey: SortKey = (['updated', 'created', 'name'] as const).includes(view.sort as SortKey) ? view.sort as SortKey : 'updated'
  const pageSize = [10, 20, 50].includes(Number(view.size)) ? Number(view.size) : 20
  const page = Math.max(1, Number.parseInt(view.page, 10) || 1)
  const setPage = useCallback((next: number) => setView({ page: String(next) }), [setView])
  const setSelectedFolder = useCallback((next: string) => setView({ folder: next, page: '1' }), [setView])
  const setSavedFilter = useCallback((next: SavedFilter) => setView({ status: next, page: '1' }), [setView])
  const setSortKey = useCallback((next: SortKey) => setView({ sort: next, page: '1' }), [setView])
  const setPageSize = useCallback((next: number) => setView({ size: String(next), page: '1' }), [setView])
  /* 打っている間の語は手元に持ち、止まってから URL へ（打つたびに URL を書かない）。 */
  const [query, setQuery] = useState(view.q)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadFailure, setLoadFailure] = useState<WebinarLoadFailure | null>(null)
  const snapshotRef = useRef<ListSnapshot>({ items: [], total: 0, loadedAccountId: null })
  const [highlightedId, setHighlightedId] = useState<string | null>(useSearchParams().get('highlight'))
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null)
  const [duplicateError, setDuplicateError] = useState('')
  const detailGuard = useInlineDetailGuard('webinar')
  const { id: activeId, setId: setActiveId } = detailGuard
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<WebinarListItem | null>(null)
  const [archiving, setArchiving] = useState(false)
  const [archiveError, setArchiveError] = useState('')
  const [foldersReady, setFoldersReady] = useState(false)
  const [foldersLoadError,setFoldersLoadError]=useState(false)
  const [folders, setFolders] = useState<WebinarFolder[]>([])
  const [folderFormOpen, setFolderFormOpen] = useState(false)
  const [editingFolder, setEditingFolder] = useState<WebinarFolder | null>(null)
  const [deletingFolder, setDeletingFolder] = useState<WebinarFolder | null>(null)
  const [deletingFolderAccountId, setDeletingFolderAccountId] = useState<string | null>(null)
  const [folderBusy, setFolderBusy] = useState(false)
  const [folderError, setFolderError] = useState('')

  const visibleItems = loadedAccountId === selectedAccountId ? items : []
  const visibleOverview = overviewAccountId === selectedAccountId ? overview : null

  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current
    if (!selectedAccountId) {
      setItems([])
      setTotal(0)
      setLoadedAccountId(null)
      setLoadFailure(null)
      setLoading(false)
      setRefreshing(false)
      return
    }
    const accountId = selectedAccountId
    const mode = snapshotRef.current.loadedAccountId === accountId ? 'background' : 'initial'
    if (mode === 'initial') {
      setLoading(true)
      setItems([])
      setLoadedAccountId(null)
    } else {
      setRefreshing(true)
    }
    setLoadFailure(null)
    try {
      const params: WebinarListParams = {
        page,
        limit: pageSize,
        q: debouncedQuery.trim() || undefined,
        folder: selectedFolder || undefined,
        status: savedFilter || undefined,
        sort: sortKey,
      }
      const res = await webinarApi.list(accountId, params)
      if (requestGeneration.current !== generation) return
      if (!res || !res.data || !Array.isArray(res.data.items) || typeof res.data.total !== 'number') {
        throw new ApiError(500, 'ウェビナーの一覧が読めない形で返りました')
      }
      setItems(res.data.items)
      setTotal(res.data.total)
      setLoadedAccountId(accountId)
    } catch (err) {
      const fieldFailure = saveErrors.capture(err);

      if (requestGeneration.current === generation) { if (!fieldFailure) setLoadFailure(webinarLoadFailure(err)) }
    } finally {
      if (requestGeneration.current === generation) {
        if (mode === 'initial') setLoading(false)
        else setRefreshing(false)
      }
    }
  }, [selectedAccountId, page, pageSize, debouncedQuery, selectedFolder, savedFilter, sortKey, saveErrors])

  const refreshOverview = useCallback(async () => {
    const generation = ++overviewGeneration.current
    setOverview(null)
    setOverviewFailure(null)
    setOverviewAccountId(null)
    if (!selectedAccountId) return
    const accountId = selectedAccountId
    try {
      const res = await webinarApi.overview(accountId)
      if (overviewGeneration.current !== generation) return
      setOverview(res.data)
      setOverviewAccountId(accountId)
    } catch (cause) {
      if (overviewGeneration.current !== generation) return
      const fieldFailure = saveErrors.capture(cause)
      setOverviewAccountId(accountId)
      { if (!fieldFailure)
      setOverviewFailure(webinarLoadFailure(cause))
    }
  }
  }, [selectedAccountId, saveErrors]);


  const refreshGrandTotal = useCallback(async () => {
    if (!selectedAccountId) {
      setGrandTotal(0)
      setGrandAccountId(null)
      setChipCounts(null)
      return
    }
    const accountId = selectedAccountId
    try {
      const res = await webinarApi.list(accountId, { limit: 1 })
      if (!res.data || typeof res.data.total !== 'number') return
      setGrandTotal(res.data.total)
      setGrandAccountId(accountId)
    } catch (saveFailure) {
      saveErrors.capture(saveFailure)
      /* 欄の件数だけの補助取得。失敗時は前の値を残す。 */
    }
    /* 札の件数（絵 「公開中 3」「下書き 1」）。札で絞ったときと同じ口・同じ条件で数える。取れなければ数を出さない。 */
    try {
      const [activeRes, draftRes] = await Promise.all([
        webinarApi.list(accountId, { limit: 1, status: 'active' }),
        webinarApi.list(accountId, { limit: 1, status: 'draft' }),
      ])
      const activeTotal = activeRes.data?.total
      const draftTotal = draftRes.data?.total
      setChipCounts(typeof activeTotal === 'number' && typeof draftTotal === 'number'
        ? { accountId, active: activeTotal, draft: draftTotal }
        : null)
    } catch (saveFailure) {
      saveErrors.capture(saveFailure)
      setChipCounts(null)
    }
  }, [selectedAccountId, saveErrors]);


  const refreshFolders = useCallback(async () => {
    const generation = ++folderGeneration.current
    setFolders([])
    setFoldersReady(false)
    setFoldersLoadError(false)
    if (!selectedAccountId) return
    try {
      const response = await webinarApi.folders(selectedAccountId)
      if (folderGeneration.current !== generation) return
      if(!response.success)throw new Error(response.error)
      setFolders(response.data)
      setFoldersReady(response.success && Array.isArray(response.data))
    } catch (saveFailure) {
      saveErrors.capture(saveFailure);

      if (folderGeneration.current === generation) setFoldersLoadError(true)
    }
  }, [selectedAccountId, saveErrors])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => { snapshotRef.current = { items, total, loadedAccountId } }, [items, total, loadedAccountId])
  // URL 側の語が替わった（戻る・読み込み直後）ときは入力欄も合わせる。
  useEffect(() => { setQuery((current) => (current.trim() === view.q ? current : view.q)) }, [view.q])
  useEffect(() => {
    if (query.trim() === view.q) return
    // 共通SearchFieldが300ms束ねた値を受ける。ここで二重に待たせない。
    setView({ q: query.trim(), page: '1' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])
  useEffect(() => { void refreshOverview() }, [refreshOverview])
  useEffect(() => { void refreshGrandTotal() }, [refreshGrandTotal])
  useEffect(() => { void refreshFolders() }, [refreshFolders])
  // アカウントを替えたらフォルダは外してページは 1 へ（来た瞬間は URL のまま）。
  useOnAccountSwitch(selectedAccountId, () => { setView({ folder: '', page: '1' }); setDeletingFolder(null); setDeletingFolderAccountId(null) })
  useListScrollMemory(!loading && !accountLoading)

  const saveFolder = async (name: string, color: string | null) => {
    if (!selectedAccountId || !canEdit || folderBusy) return
    setFolderBusy(true)
    setFolderError('')
    try {
      const result = editingFolder ? await webinarApi.updateFolder(selectedAccountId, editingFolder.id, { name, color })
        : await webinarApi.createFolder(selectedAccountId, { name, color })
      if (!result.success) throw new Error(result.error)
      setEditingFolder(null)
      setFolderFormOpen(false)
      await refreshFolders()
      await refreshGrandTotal()
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setFolderError('フォルダを保存できませんでした。もう一度お試しください。') }
    } finally {
      setFolderBusy(false)
    }
  }

  /* フォルダの並べ替えは押した瞬間に画面を変え、裏で保存する（5秒は元に戻せる）。 */
  const moveFolder = (index: number, direction: -1 | 1) => {
    if (!selectedAccountId || !canEdit || folderBusy) return
    const current = folders[index]
    const other = folders[index + direction]
    if (!current || !other) return
    const before = folders
    const swapped = [...folders]
    swapped[index] = other
    swapped[index + direction] = current
    setFolders(swapped)
    setFolderError('')
    runUndoable({
      message: `フォルダ「${current.name}」の並び順を変えました`,
      commit: async () => {
        const results = await Promise.all([
          webinarApi.updateFolder(selectedAccountId, current.id, { displayOrder: other.displayOrder }),
          webinarApi.updateFolder(selectedAccountId, other.id, { displayOrder: current.displayOrder }),
        ])
        if (results.some((result) => !result.success)) return { success: false }
      },
      undo: () => setFolders(before),
      onCommitted: () => {
        void refreshFolders()
        void refreshGrandTotal()
      },
      failureMessage: '並び順を保存できませんでした。もう一度お試しください。',
    })
  }

  const removeFolder = async () => {
    if (!selectedAccountId || selectedAccountId !== deletingFolderAccountId || !canEdit || !deletingFolder || folderBusy) return
    setFolderBusy(true)
    setFolderError('')
    try {
      await webinarApi.deleteFolder(selectedAccountId, deletingFolder.id)
      if (selectedFolder === deletingFolder.id) setSelectedFolder('')
      setDeletingFolder(null)
      await Promise.all([refresh(), refreshFolders(), refreshGrandTotal()])
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setFolderError('フォルダを削除できませんでした。もう一度お試しください。') }
    } finally {
      setFolderBusy(false)
    }
  }

  const hasListData = !accountLoading && !loading && loadFailure === null && Boolean(selectedAccountId)
  const visibleTotal = loadedAccountId === selectedAccountId ? total : 0
  const pageCount = Math.max(1, Math.ceil(visibleTotal / pageSize))
  const currentPage = Math.min(page, pageCount)
  // 読み終わってから。読み込み中（件数 0）に詰めると、URL から戻したページが 1 になる。
  useEffect(() => { if (hasListData && page > pageCount) setPage(pageCount) }, [hasListData, page, pageCount, setPage])

  /* 行 → 右の詳細パネル。開閉と↑↓の移動はつながる移り変わりで。 */
  const activeIndex = visibleItems.findIndex((w) => w.id === activeId)
  const active = activeIndex >= 0 ? visibleItems[activeIndex] : null
  const openDetail = useCallback((id: string) => { withViewTransition(() => setActiveId(current => current === id ? null : id)) }, [setActiveId])
  const closeDetail = useCallback(() => { withViewTransition(() => setActiveId(null)) }, [setActiveId])
  const goDetail = (direction: -1 | 1) => {
    const next = visibleItems[activeIndex + direction]
    if (next) withViewTransition(() => setActiveId(next.id))
  }

  /* 名前のその場の書き換え。題だけ送る（ほかは触らない）。失敗は入力欄に理由を出す。 */
  const renameWebinar = async (target: WebinarListItem, next: string) => {
    const trimmed = next.trim()
    if (!trimmed) throw new Error('empty_name')
    if (trimmed === target.title) return
    await webinarApi.update(target.id, { title: trimmed })
    setItems((current) => current.map((w) => (w.id === target.id ? { ...w, title: trimmed } : w)))
  }

  const panelGrand = grandAccountId === selectedAccountId ? grandTotal : null
  const unfiledCount = panelGrand === null || !foldersReady
    ? null
    : Math.max(0, panelGrand - folders.reduce((sum, folder) => sum + folder.count, 0))

  const openArchive = useCallback((target: WebinarListItem) => {
    setArchiveError('')
    setArchiveTarget(target)
  }, [])

  const duplicateWebinar = async (item: WebinarListItem) => {
    if (!canEdit || duplicatingId || !selectedAccountId) return
    const accountId = selectedAccountId
    setDuplicatingId(item.id); setDuplicateError('')
    try {
      const editor = await webinarApi.editor(item.id)
      const copied = await webinarApi.duplicate(item.id, editor.data.version)
      if (snapshotRef.current.loadedAccountId !== accountId) return
      setHighlightedId(copied.data.id)
      setQuery(''); setView({ q: '', status: 'draft', page: '1', sort: 'updated' })
      setTotal((current) => current + 1)
      setItems((current) => [{ ...copied.data, folderName: item.folderName, registrationCount: 0, viewerCount: 0 }, ...current])
      notifyToast('複製した下書きを追加しました')
      void refreshFolders()
    } catch { setDuplicateError('複製できませんでした。一覧を読み直してお試しください。') }
    finally { setDuplicatingId(null) }
  }

  const archiveSelected = async () => {
    if (!archiveTarget || archiving) return
    setArchiving(true)
    setArchiveError('')
    try {
      if (archiveTarget.status === 'archived') await webinarApi.update(archiveTarget.id, { status: 'draft' })
      else await webinarApi.archive(archiveTarget.id)
      setArchiveTarget(null)
      await Promise.all([refresh(), refreshOverview(), refreshGrandTotal()])
    } catch (error) {
      const fieldFailure = saveErrors.capture(error)

      { if (!fieldFailure)
      setArchiveError(error instanceof ApiError && error.status === 409
        ? '公開中のウェビナーは、先に公開を停止してください。'
        : archiveTarget.status === 'archived'
          ? '下書きに戻せませんでした。もう一度お試しください。'
          : 'アーカイブできませんでした。状態を読み直して、もう一度お試しください。') }
    } finally {
      setArchiving(false)
    }
  }

  const clearFilters = () => {
    setQuery('')
    setView({ q: '', folder: '', status: '', page: '1' })
  }

  /* CSV は表示中の条件に合う全頁。条件が変わったら古い結果は捨てる。 */
  const [csvBusy, setCsvBusy] = useState(false)
  const [csvError, setCsvError] = useState('')
  const csvLock = useRef(false)
  const csvScope = `${selectedAccountId}:${debouncedQuery}:${selectedFolder}:${savedFilter}:${sortKey}`
  const currentCsvScope = useRef(csvScope)
  currentCsvScope.current = csvScope
  useEffect(() => { setCsvError('') }, [csvScope])
  const exportCsv = async () => {
    if (!selectedAccountId || csvLock.current) return
    csvLock.current = true
    setCsvBusy(true)
    setCsvError('')
    try {
      const csv = await webinarListCsv({
        accountId: selectedAccountId,
        params: { q: debouncedQuery.trim() || undefined, folder: selectedFolder || undefined, status: savedFilter || undefined, sort: sortKey },
        list: webinarApi.list,
        isCurrent: () => currentCsvScope.current === csvScope,
      })
      if (csv === null) return
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
      const link = document.createElement('a')
      link.href = url
      link.download = csvFileName("動画セミナー")
      link.click()
      URL.revokeObjectURL(url)
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure);

      if (currentCsvScope.current === csvScope) { if (!fieldFailure) setCsvError('CSVを書き出せませんでした。通信を確認して、もう一度お試しください。') }
    } finally {
      csvLock.current = false
      setCsvBusy(false)
    }
  }

  const go = (href: string) => detailGuard.protect(() => router.push(href))

  /* ===== フォルダ ===== */
  /* 行の名前の前の丸は、左のフォルダの列と同じフォルダ（同じ色）を引く。 */
  const folderDotOf = (w: WebinarListItem): FolderDotFolder | null => {
    if (!w.folderId) return null
    const folder = folders.find((f) => f.id === w.folderId)
    if (folder) return { name: folder.name, color: folder.color }
    return w.folderName ? { name: w.folderName } : null
  }
  const folderRows: FolderPanelRow[] = [
    { kind: 'all' as const, id: '', label: 'すべて', count: panelGrand, icon: <Inbox size={16} aria-hidden="true" /> },
    /*
     * 絵どおり「…」は選んだ行だけに出す。選んでいない行に操作を渡すと、
     * 共通のフォルダの列では「…」の箱が場所を取り、件数が左へずれる。
     * 名前の変更・並べ替え・削除は、フォルダを選ぶとその行の「…」から開ける。
     */
    ...folders.map((folder, index) => {
      const manageable = canEdit && selectedFolder === folder.id
      return {
        kind: 'folder' as const,
        id: folder.id,
        label: folder.name,
        count: folder.count,
        color: folder.color,
        onEdit: manageable ? () => detailGuard.protect(() => { setFolderError(''); closeDetail(); setEditingFolder(folder) }) : undefined,
        onMoveUp: manageable && index > 0 ? () => detailGuard.protect(() => { void moveFolder(index, -1) }) : undefined,
        onMoveDown: manageable && index < folders.length - 1 ? () => detailGuard.protect(() => { void moveFolder(index, 1) }) : undefined,
        onDelete: manageable ? () => detailGuard.protect(() => { if (renderedAccountScope !== accountScope.current) return; setFolderError(''); setDeletingFolderAccountId(selectedAccountId); setDeletingFolder(folder) }) : undefined,
        deleteNote: '削除しても、中のウェビナーは未分類に残ります。',
      }
    }),
    { kind: 'unfiled' as const, id: UNFILED, label: '未分類', count: unfiledCount },
  ]
  const selectedFolderRow = folderRows.find(row => row.id === selectedFolder && row.onDelete)
  const folderSelect = (
    <SaveErrorField names={["selectedFolder","selected_folder"]}><Select
      narrowFolderPicker aria-label="フォルダ"
      value={selectedFolder}
      onChange={(value) => { setSelectedFolder(value); setPage(1) }}
      options={[
        { value: '', label: 'フォルダ：すべて' },
        ...folders.map((folder) => ({ value: folder.id, label: `フォルダ：${folder.name}` })),
        { value: UNFILED, label: 'フォルダ：未分類' },
      ]}
    /></SaveErrorField>
  )
  // 閲覧のみには押せない作るボタンを置かない（2026-10-06 オーナー決定）。
  const createButton = canEdit
    ? <Button variant="primary" href="/webinars/new"><Plus size={16} aria-hidden="true" />ウェビナーを作る</Button>
    : null

  /* ===== 道具の段 ===== */
  const shownChipCounts = chipCounts && chipCounts.accountId === selectedAccountId ? chipCounts : null
  const filterChips = (
    <SegmentedControl
      aria-label="状態で絞り込む"
      value={savedFilter}
      onChange={setSavedFilter}
      options={[
        { value: '', label: 'すべて' },
        { value: 'active', label: '公開中', count: shownChipCounts?.active },
        { value: 'draft', label: '下書き', count: shownChipCounts?.draft },
      ]}
    />
  )
  const sortBox = (
    <SortSelect
        value={sortKey}
        onChange={(value) => setSortKey(value as SortKey)}
        options={[{ value: 'updated', label: '更新順' }, { value: 'created', label: '作成順' }, { value: 'name', label: '名前順' }]}
        label="並び："
      />
  )
  const savedBox = (
      <SaveErrorField names={["savedFilter","status","saved_filter"]}><Select size="content" icon={<Bookmark size={16} aria-hidden="true" />} showChevron={false}
        aria-label="よく使う絞り込み"
        value={savedFilter}
        onChange={(value) => { setSavedFilter(value as SavedFilter); setPage(1) }}
        options={[
          { value: '', label: 'よく使う絞り込み' },
          { value: 'active', label: '公開中のみ' },
          { value: 'draft', label: '下書きのみ' },
          { value: 'archived', label: 'アーカイブ済み' },
        ]}
      /></SaveErrorField>
  )
  const perPageBox = <PageSizeSelect value={pageSize} onChange={setPageSize} options={[10, 20, 50]} label={null} />
  const notice = (
    null
  )
  const searchBox = (
    <SearchField
      value={query}
      onChange={(value) => setQuery(value)}
      onClear={() => setQuery('')}
      placeholder="ウェビナー名で探す"
      aria-label="ウェビナー名で探す"
    />
  )
  /* 1152 の板：案内の帯 → 1段目「作る・フォルダ・探す」→ 2段目「札 … 並び・よく使う絞り込み・件数」。 */

  const wideToolbar = (
    <>

      <ListToolbar
        search={{ placeholder: 'ウェビナー名で探す', label: 'ウェビナー名で探す', width: 240, value: query, onChange: setQuery }}
        filters={filterChips}
        trailing={<>{sortBox}{savedBox}{perPageBox}</>}
      />
    </>
  )

  /* ===== 表 ===== */
  let listBody: ReactNode
  if (accountLoading || loading) {
    listBody = <ListSkeleton />
  } else if (!selectedAccountId) {
    listBody = <AccountRequiredState hasAccounts={accounts.length > 0} />
  } else if (loadFailure && visibleItems.length === 0) {
    listBody = <ListState kind={loadFailure.kind} title={loadFailure.title} description={loadFailure.description} action={loadFailure.retryable ? <Button onClick={() => refresh()} busyLabel="処理中…">もう一度読み込む</Button> : undefined} />
  } else if (visibleItems.length === 0) {
    /* 修正案 D-2：空の一覧。 */
    listBody = (
      <EmptyList
        icon={<Video aria-hidden="true" />}
        title="まだウェビナーがありません"
        description="録画やライブのセミナーを、LINE で案内して申込を受け付けます。"
        create={{ label: '最初のウェビナーを作る', href: '/webinars/new' }}
        canCreate={canEdit}
        filtered={panelGrand !== 0}
        onClearFilters={clearFilters}
      />
    )
  } else {
    listBody = (
      <>
        {loadFailure ? (
          <Notice tone="danger" ><span>{loadFailure.title}</span>{loadFailure.retryable ? <Button onClick={() => refresh()} busyLabel="処理中…">もう一度読み込む</Button> : null}</Notice>
        ) : null}
        {refreshing ? <p role="status" className="sr-only">検索中…</p> : null}
        <div className={styles.tableWrap}>
          <DataTable className={styles.table}>
            <TableHead />
            <tbody>
              {visibleItems.map((w) => {
                const menuItems = [...(canEdit ? [{ id: 'edit', label: '編集する', onSelect: () => go(`/webinars/edit?id=${w.id}`) }] : []), ...rowMenuItems(w, canEdit, go, item => detailGuard.protect(() => openArchive(item)), item => detailGuard.protect(() => { void duplicateWebinar(item) }), duplicatingId !== null)]
                const counts = showsCounts(w)
                const period = periodSummary(w)
                const menuLabel = `ウェビナー「${w.title}」の操作`
                return (
                  <Tr
                    key={w.id}
                    selected={highlightedId === w.id}
                    interactive
                    className={styles.row}
                    data-table-layout="columns"
                    data-row-id={w.id}
                    detailKey="webinar" onOpen={() => openDetail(w.id)}
                  >
                    <Td className={styles.colName}>
                      <ContextMenu label={`「${w.title}」の操作`} items={toContextItems(menuItems)}>
                        <FolderDotName folder={folderDotOf(w)}>
                          <RowNameLink
                            href={`/webinars/edit?id=${encodeURIComponent(w.id)}`}
                            className={styles.nameButton}
                            title={w.title}
                            aria-label={`「${w.title}」の詳細を見る`}

                          >
                            {w.title}
                          </RowNameLink>
                        </FolderDotName>
                      </ContextMenu>

                    </Td>
                    <Td className={styles.colStatus}><StatusPill webinar={w} /></Td>
                    <Td className={styles.colCount}>
                      <span className={styles.numMain}>{counts ? peopleText(w.registrationCount) : emptyValue('unknown')}</span>
                    </Td>
                    <Td className={styles.colView}>
                      {beforeStart(w) ? (
                        <span className={styles.numMain}>開始前</span>
                      ) : counts ? (
                        <>
                          <span className={styles.numMain}>視聴完了 —</span>
                          <span className={styles.numSub}>{`視聴開始 ${peopleText(w.viewerCount)}`}</span>
                        </>
                      ) : (
                        <span className={styles.numMain} title="公開していないので視聴数はありません">{emptyValue('unknown')}</span>
                      )}
                    </Td>
                    <Td className={styles.colPeriod}><span className={styles.period} title={period}>{period}</span></Td>
                    <Td className={styles.colOps}>
                      <div className={styles.opsBox}>

                        <RowMenu
                          label={menuLabel}
                          open={openMenuId === w.id}
                          onOpenChange={(next) => setOpenMenuId(next ? w.id : null)}
                          note={canEdit ? undefined : READONLY_REASON}
                          items={menuItems.map((item) => ({ ...item, onSelect: () => { setOpenMenuId(null); item.onSelect?.() } }))}
                        />
                      </div>
                    </Td>
                  </Tr>
                )
              })}
            </tbody>
          </DataTable>
        </div>
      </>
    )
  }

  const pager = hasListData ? (
    <ListPagePagination>
      <Pagination page={currentPage} pageCount={pageCount} onPageChange={setPage} ariaLabel="ウェビナー一覧のページ送り"
        range={{ total: visibleTotal, first: (currentPage - 1) * pageSize + 1, last: (currentPage - 1) * pageSize + visibleItems.length }} />
    </ListPagePagination>
  ) : null

  const kpis = kpiCells(visibleOverview)

  return (
    <SaveErrorScope errors={saveErrors}><ListPage
      heightMode="content"
      skeleton
      help={<>{"録画やライブのセミナーをLINEで案内し、申込から視聴・相談までをつなげます。"}{`行の「…」から 参加者・分析・コメント演出${canEdit ? '・アーカイブ' : ''}。行を押すと右に詳細が出ます（↑↓で次の行へ）。`}{kpis.map((kpi) => kpi.help).join(" ")}</>}
      noticeSpacing="section"
      explanation="公開すると、申込ページとLINEの案内が使えるようになります。申込から相談までの流れは、各ウェビナーの「分析」で見られます。"
      boardId="UyUMw"
      headingSize="regular"
      title="ウェビナー"

      actions={
        <Button
          onClick={() => void exportCsv()}
          disabled={!hasListData || query !== debouncedQuery || csvBusy}
          busy={csvBusy}
          busyLabel="書き出しています…"
        >
          <Download size={16} aria-hidden="true" />CSVで書き出す
        </Button>
      }
      stats={<>
        {/* 役割が取れるまで（null）は閲覧のみの帯を出さない。出してから消すと一覧が 64px 跳ねていた（動きの点検 8 番）。 */}
        {role !== null && !canEdit ? (
          <div className={styles.viewerBand}><ReadOnlyNotice role="status"></ReadOnlyNotice></div>
        ) : null}
        {csvError ? <div className={styles.statsNotice}><Notice tone="info">{csvError}</Notice></div> : null}
        {overviewFailure && !loadFailure ? (
          <div className={styles.statsNotice}>
            <Notice tone="info" action={overviewFailure.retryable ? <Button onClick={() => refreshOverview()} busyLabel="処理中…">集計を読み直す</Button> : undefined}>集計を表示できませんでした。</Notice>
          </div>
        ) : null}
        <KpiBand>
          {kpis.map((kpi) => (
            <KpiCard
              key={kpi.key}
              presentation="band"
              title={kpi.title}
              icon={<kpi.icon size={16} aria-hidden="true" />}
              value={kpi.value}
              unit={kpi.value === null ? '' : kpi.unit}
              detail={kpi.detail}
            />
          ))}
        </KpiBand>
      </>}
      folders={foldersLoadError?<ListState kind="error" title="フォルダを読み込めませんでした" onRetry={()=>void refreshFolders()}/>:<>
        <FolderPanel
          createAction={createButton}
          activeId={selectedFolder}
          onSelect={(id) => { setSelectedFolder(id); setPage(1) }}
          onAddFolder={canEdit ? () => detailGuard.protect(() => { setFolderError(''); closeDetail(); setFolderFormOpen(true) }) : undefined}
          addFolderLabel="フォルダを追加"
          addFolderDisabled={!selectedAccountId}
          rows={folderRows}
        >
          <FolderPanelNote>フォルダを消しても、中のウェビナーは未分類に残ります</FolderPanelNote>
        </FolderPanel>
      </>}
      collapsedFolders={foldersLoadError?<ListState kind="error" title="フォルダを読み込めませんでした" onRetry={()=>void refreshFolders()}/>:<>{createButton}{folderSelect}{selectedFolderRow ? <CollapsedFolderActions row={selectedFolderRow} /> : null}</>}
      toolbar={<>{duplicateError ? <Notice tone="danger">{duplicateError}</Notice> : null}{wideToolbar}</>}
      pagination={pager}
      overlays={<>
        {detailGuard.dialog}
        {archiveTarget ? (
          <ArchiveConfirm
            target={archiveTarget}
            busy={archiving}
            error={archiveError || undefined}
            onCancel={() => { if (!archiving) setArchiveTarget(null) }}
            onConfirm={() => archiveSelected()}
          />
        ) : null}
        {(folderFormOpen || editingFolder) ? (
          <FolderForm key={editingFolder?.id ?? 'new'} folder={editingFolder} busy={folderBusy} error={folderError}
            onCancel={() => { if (!folderBusy) { setFolderFormOpen(false); setEditingFolder(null); setFolderError('') } }}
            onSave={(name, color) => void saveFolder(name, color)} />
        ) : null}
        <DetailPanel
          open={active !== null}
          busy={detailGuard.busy}
          title={active?.title ?? ''}
          description={active ? periodSummary(active) : undefined}
          onClose={closeDetail}
          hasPrev={activeIndex > 0}
          hasNext={activeIndex >= 0 && activeIndex < visibleItems.length - 1}
          onPrev={activeIndex > 0 ? () => goDetail(-1) : undefined}
          onNext={activeIndex >= 0 && activeIndex < visibleItems.length - 1 ? () => goDetail(1) : undefined}
          actions={{ primary: (active ? <Button variant="primary" href={`/webinars/edit?id=${active.id}`}>編集する</Button> : null),
    menuItems: [...(active ? [{ id: 'body-1', label: "分析を見る", onSelect: () => go(`/webinars/edit?id=${encodeURIComponent(active.id)}&pane=analytics`) }] : []),
        ...(active ? [{ id: 'body-2', label: "コメント演出を開く", onSelect: () => go(`/webinars/edit?id=${encodeURIComponent(active.id)}&pane=comments`) }] : []), ...(active ? [{ allowed: canEdit, id: 'detail-0', label: (active.status === 'archived' ? '下書きに戻す' : 'アーカイブする'), onSelect: () => detailGuard.protect(() => { closeDetail(); openArchive(active) }) }] : [])], secondary: (active ? <Button variant="secondary" onClick={() => go(`/webinars/edit?id=${encodeURIComponent(active.id)}&pane=participants`)}>参加者を見る</Button> : null), primaryAllowed: canEdit }}
         status={active ? <StatusPill webinar={active} /> : null}>
<DetailContent>
          {active ? (
            <div className={styles.detail}>
              <DetailField label="ウェビナー名"> <DetailInlineEdit {...detailGuard.editor} allowed={canEdit} value={active.title} label="ウェビナー名" onSave={(next) => renameWebinar(active, next)} /> </DetailField>

              <DetailField label="申込・視聴">
                申込 {showsCounts(active) ? peopleText(active.registrationCount) : emptyValue('unknown')}　視聴開始 {showsCounts(active) ? peopleText(active.viewerCount) : emptyValue('unknown')}
               </DetailField>
              <DetailField label="公開ページ"> {publicPath(active)} </DetailField>

              {!canEdit ? <p className={styles.dialogValue}>{READONLY_REASON}</p> : null}
            </div>
          ) : null}

</DetailContent>
</DetailPanel>
        <ConfirmDialog
          open={deletingFolder !== null && deletingFolderAccountId === selectedAccountId}
          title={`フォルダ「${deletingFolder?.name ?? ''}」を削除しますか？`}
          description={`削除しても、中のウェビナーは未分類に残ります。いまこのフォルダに入っているのは${deletingFolder?.count ?? 0} 件です。`}
          confirmLabel="削除する"
          destructive
          busy={folderBusy}
          error={folderError || undefined}
          onCancel={() => {
            if (folderBusy) return
            setDeletingFolder(null)
            setFolderError('')
          }}
          onConfirm={() => removeFolder()}
        >{deletingFolder ? <OperationTargetSummary accounts={[{ id: deletingFolderAccountId ?? '' }]} /> : null}</ConfirmDialog>
      </>}
    >
      {listBody}
    </ListPage></SaveErrorScope>
  )
}
