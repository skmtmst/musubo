'use client'

import PermissionGatedButton from '@/components/shared/permission-gated-button'
import { DetailContent, DetailField, DetailInlineEdit } from '@/components/shared/detail-content'

import { useListUrlValue } from '@/components/shared/list-url-state'
import { RowNameLink } from '@/components/shared/table'
import { useFolderMove } from '@/components/shared/use-folder-move'
import { moveEventToFolder } from '@/lib/move-to-folder'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from '@/components/shared/list-navigation'
import { useSearchParams } from 'next/navigation'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { Bookmark, CalendarClock, CalendarX, Eye, Hourglass, Plus, TrendingDown, TriangleAlert, Users } from 'lucide-react'
import type { Folder } from '@line-crm/shared'
import { api, ApiError, eventsApi, fetchApi, type EventListItem, type EventListSummary } from '@/lib/api'
import { clampSearchQuery, SEARCH_QUERY_MAX_LENGTH } from '@/lib/search-query'
import { withRequestTimeout } from '@/lib/request-timeout'
import { useAccount } from '@/contexts/account-context'
import { useStaffRole, canManageRole } from '@/lib/staff-role'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { ListPage } from '@/components/templates'
import Button from '@/components/shared/button'
import EmptyList from '@/components/shared/empty-list'
import TagPill from '@/components/shared/tag-pill'
import Select from '@/components/shared/select'
import ListToolbar from '@/components/shared/list-toolbar'
import SegmentedControl from '@/components/shared/segmented'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import Notice from '@/components/shared/notice'
import HelpTip from '@/components/shared/help-tip'
import { DataTable, TableHeadRow, Th, Tr, Td, NameCell } from '@/components/shared/table'
import ManagedFolderPanel, { managedFolderNavRows } from '@/components/shared/managed-folder-panel'
import { FolderDotName } from '@/components/shared/folder-dot'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { eventOperationAccounts } from '@/components/events/event-draft-shared'
import DetailPanel from '@/components/shared/detail-panel'
import { useInlineDetailGuard } from '@/components/shared/use-inline-detail-guard'
import InlineEdit from '@/components/shared/inline-edit'
import ContextMenu, { type ContextMenuItem } from '@/components/shared/context-menu'
import { type ActionMenuItem } from '@/components/shared/action-menu'
import { notifyToast } from '@/components/shared/toast'
import { RowMenu } from '@/components/shared/row-actions'
import { withViewTransition } from '@/components/shared/view-transition'
import Pagination from '@/components/shared/pagination'
import ListRange from '@/components/ui/list-range'
import { DelayedSkeleton, Skeleton } from '@/components/shared/skeleton'
import { daysUntilIso, eventRowState, isLowApplication, summarizeEventAttention, type EventRowState } from './attention'
import { jstDay, jstTime } from './shared'
import styles from './list.module.css'
import TruncatedText from '@/components/shared/truncated-text'
import { emptyValue, EmptyCell } from '@/components/shared/empty-value'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import StatusBadge from '@/components/shared/status-badge'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import ListState from '@/components/shared/list-state'
import { PAGE_SIZES as STANDARD_PAGE_SIZES } from '@/components/shared/page-size-select'

/*
 * ★V8 イベント予約の一覧（Pencil ）。
 *
 * 型（ListPage）に、数の帯（これからの回・申込・あと少しで満席・申し込みが少ない）、
 * 左のフォルダの列（上に「イベントを作る」）、案内の帯と道具の段、表、ページ送りをはめる。
 * データの口は取得・絞り込み・並び・ページ送り・名前の変更・削除・フォルダ。
 * 行の名前の前にフォルダの色の丸（2026-10-07 オーナー）。
 */

type LoadStatus = 'loading' | 'ready' | 'error' | 'forbidden'

/** 未分類を表す印。裏側（events.ts）が `__ungrouped__` で受ける。 */
const UNFILED = '__ungrouped__'
const PAGE_SIZES = STANDARD_PAGE_SIZES
const VIEWER_NOTE = '閲覧のみで見ています。イベントを作る・直す・消す操作はオーナーか管理者に頼んでください。'

/*
 * よく使う絞り込み（絵の選ぶ欄）。「満席の回がある」をここから選ぶ。
 */
const SAVED_OPTIONS = [
  { value: '', label: 'よく使う絞り込み' },
  { value: 'full', label: '満席のイベントだけ' },
]

const STATE_LABEL: Record<EventRowState, string> = {
  draft: '下書き',
  paused: '停止中',
  cancelled: '中止',
  ended: '終了',
  full: '満席',
  open: '公開中',
}

function whenText(iso: string | null): string {
  return iso ? `${jstDay(iso)}${jstTime(iso)}` : '日時未設定'
}

function displaySlot(item: EventListItem): { startsAt: string | null; label: string | null } {
  if (item.next_slot_starts_at) return { startsAt: item.next_slot_starts_at, label: '次の回' }
  const past = item.latest_past_slot_starts_at
  const date = past?.match(/^((\d{4})-(\d{2})-(\d{2}))T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/)
  const calendar = date ? new Date(`${date[1]}T00:00:00Z`) : null
  if (past && date && calendar && Number.isFinite(Date.parse(past))
    && calendar.getUTCFullYear() === Number(date[2])
    && calendar.getUTCMonth() + 1 === Number(date[3])
    && calendar.getUTCDate() === Number(date[4])) {
    return { startsAt: past, label: '直近の回' }
  }
  return { startsAt: null, label: null }
}

function toContextMenuItems(menuItems: ActionMenuItem[]): ContextMenuItem[] {
  return menuItems.map((item) => ({
    id: item.id,
    label: item.label,
    danger: item.tone === 'danger',
    disabled: item.disabled,
    onSelect: () => item.onSelect?.(),
  }))
}

export default function EventsListV8() {
  usePageTitle('イベント予約')
  usePageCrumbs([{ label: 'ホーム', href: '/' }])
  const router = useRouter()
  const { selectedAccountId } = useAccount()
  const role = useStaffRole()
  /* 作る・名前の変更・削除・フォルダの追加は統括と管理者だけ（Worker も同じ権限）。 */
  const canEdit = canManageRole(role)
  const [highlightedId, setHighlightedId] = useState<string | null>(useSearchParams().get('highlight'))
  const activeAccountRef = useRef(selectedAccountId)
  activeAccountRef.current = selectedAccountId
  const accountScope = useRef({ accountId: selectedAccountId })
  if (accountScope.current.accountId !== selectedAccountId) accountScope.current = { accountId: selectedAccountId }
  const duplicateLock = useRef(false)
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null)
  const [duplicateError, setDuplicateError] = useState('')
  const [items, setItems] = useState<EventListItem[]>([])
  const [itemsScope, setItemsScope] = useState<object | null>(null)
  const [listTotal, setListTotal] = useState(0)
  const [summary, setSummary] = useState<EventListSummary | null>(null)
  const [loadStatus, setLoadStatus] = useState<LoadStatus>('loading')
  const [query, setQuery] = useListUrlValue('q', '')
  const [filter, setFilter] = useListUrlValue<'all' | 'open' | 'pending' | 'full'>('filter', 'all')
  const [sort, setSort] = useListUrlValue<'soon' | 'name'>('sort', 'soon')
  const [page, setPage] = useListUrlValue('page', 1)
  const [perPage, setPerPage] = useListUrlValue('perPage', 20)
  const [folderFilter, setFolderFilter] = useListUrlValue('folderFilter', '')
  const [folders, setFolders] = useState<Folder[]>([])
  const [unfiledCount, setUnfiledCount] = useState<number | null>(null)
  const [foldersError, setFoldersError] = useState(false)
  const [pendingTotal, setPendingTotal] = useState<number | null>(null)
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const detailGuard = useInlineDetailGuard('event')
  const { id: activeId, setId: setActiveId } = detailGuard
  const [deleteTarget, setDeleteTarget] = useState<{ event: EventListItem; accountId: string; scope: object } | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const loadRequestRef = useRef(0)

  const loadFolders = useCallback(async () => {
    if (!selectedAccountId) {
      setFolders([])
      setUnfiledCount(null)
      return
    }
    setFoldersError(false)
    try {
      const res = await api.folders.list('event', selectedAccountId)
      if (res.success) {
        setFolders(res.data)
        setUnfiledCount(res.unfiledCount ?? null)
      } else {
        setFoldersError(true)
      }
    } catch {
      setFoldersError(true)
    }
  }, [selectedAccountId])

  useEffect(() => {
    void loadFolders()
  }, [loadFolders])

  const refresh = useCallback(async () => {
    const requestId = ++loadRequestRef.current
    const scope = accountScope.current
    if (!selectedAccountId) {
      setItems([])
      setListTotal(0)
      setSummary(null)
      setLoadStatus('ready')
      return
    }
    setLoadStatus('loading')
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(perPage) })
      const trimmed = clampSearchQuery(query.trim())
      if (trimmed) params.set('q', trimmed)
      params.set('filter', filter)
      params.set('sort', sort)
      if (folderFilter) params.set('folderId', folderFilter)
      params.set('account_id', selectedAccountId)
      if (highlightedId) params.set('highlight', highlightedId)
      const res = await withRequestTimeout(
        fetchApi<{ items: EventListItem[]; total?: number; summary?: EventListSummary | null }>(`/api/events/admin/events?${params}`),
      )
      if (requestId !== loadRequestRef.current || accountScope.current !== scope) return
      setItems(res.items)
      setItemsScope(scope)
      setListTotal(res.total ?? res.items.length)
      setSummary(res.summary ?? null)
      setLoadStatus('ready')
    } catch (cause) {
      if (requestId !== loadRequestRef.current || accountScope.current !== scope) return
      setItems([])
      setListTotal(0)
      setSummary(null)
      // 403 は権限不足（管理者への依頼）、それ以外は通信失敗（もう一度）。
      setLoadStatus(cause instanceof ApiError && cause.status === 403 ? 'forbidden' : 'error')
    }
  }, [selectedAccountId, page, perPage, query, filter, sort, folderFilter, highlightedId])

  useEffect(() => {
    void refresh()
    return () => {
      loadRequestRef.current += 1
    }
  }, [refresh])
  useEffect(() => { setDeleteTarget(null); setDeleteBusy(false); setDeleteError('') }, [selectedAccountId])

  useEffect(() => {
    setPage(1)
  }, [query, filter, sort, folderFilter, perPage])

  /* 「承認待ちあり」の札の件数。行とは別に軽く数えるだけ。 */
  useEffect(() => {
    if (!selectedAccountId) {
      setPendingTotal(null)
      return
    }
    let alive = true
    const params = new URLSearchParams({ page: '1', limit: '1', filter: 'pending', account_id: selectedAccountId })
    void fetchApi<{ items: EventListItem[]; total?: number }>(`/api/events/admin/events?${params}`)
      .then((res) => { if (alive) setPendingTotal(res.total ?? res.items.length) })
      .catch(() => { if (alive) setPendingTotal(null) })
    return () => { alive = false }
  }, [selectedAccountId])

  const attention = useMemo(() => summarizeEventAttention(items), [items])
  /* 数の帯は応答の全体集計を使う（ページ内の行だけで数えると、21件目以降があるとき小さく見える）。 */
  const kpi: EventListSummary = summary ?? {
    upcoming_slots: attention.upcoming.length,
    upcoming_active: attention.applied,
    upcoming_capacity: attention.capacity,
    fill_rate: attention.fillRate,
    nearly_full: attention.nearlyFull.length,
    low_applications: attention.lowApplications.length,
    nearest_upcoming_starts_at: attention.upcoming[0]?.next_slot_starts_at ?? null,
    nearest_low_starts_at: attention.lowApplications[0]?.next_slot_starts_at ?? null,
  }

  async function confirmDeleteEvent() {
    if (!deleteTarget || deleteBusy || deleteTarget.scope !== accountScope.current || activeAccountRef.current !== deleteTarget.accountId) return
    setDeleteBusy(true)
    setDeleteError('')
    try {
      await eventsApi.deleteEvent(deleteTarget.accountId, deleteTarget.event.id)
      if (deleteTarget.scope !== accountScope.current) return
      setDeleteTarget(null)
      await refresh()
      void loadFolders()
    } catch (cause) {
      if (deleteTarget.scope !== accountScope.current) return
      setDeleteError(
        cause instanceof ApiError && (cause.code === 'event_has_active_bookings' || cause.status === 409)
          ? '申込中・確定済みの予約、またはキャンセル待ちの人がいるため削除できません。先に申込者への対応を終えてください。'
          : '削除できませんでした。時間をおいて、もう一度お試しください。',
      )
    } finally {
      if (deleteTarget.scope === accountScope.current) setDeleteBusy(false)
    }
  }

  const renameEvent = async (target: EventListItem, next: string) => {
    if (!selectedAccountId) throw new Error('no_account')
    const trimmed = next.trim()
    if (!trimmed) throw new Error('empty_name')
    if (trimmed === target.name) return
    const updated = await eventsApi.updateEvent(selectedAccountId, target.id, { name: trimmed }, target.version)
    setItems((current) => current.map((e) => (
      e.id === target.id ? { ...e, name: trimmed, version: typeof updated?.version === 'number' ? updated.version : e.version } : e
    )))
  }

  const requestDelete = useCallback((target: EventListItem) => {
    if (!selectedAccountId || itemsScope !== accountScope.current) return
    setDeleteError('')
    setDeleteTarget({ event: target, accountId: selectedAccountId, scope: itemsScope })
  }, [selectedAccountId, itemsScope])

  const duplicateEvent = async (event: EventListItem) => {
    if (!selectedAccountId || !canEdit || duplicateLock.current) return
    const accountId = selectedAccountId
    duplicateLock.current = true
    setDuplicatingId(event.id); setDuplicateError('')
    try {
      const copied = await eventsApi.duplicate(accountId, event.id, event.version)
      if (activeAccountRef.current !== accountId) return
      setHighlightedId(copied.id)
      setFilter('all'); setQuery(''); setPage(1)
      setItems((current) => [{ ...event, id: copied.id, name: `${event.name}（複製）`, is_published: 0, lifecycle_status: 'draft', version: 1, total_active: 0, pending_count: 0 }, ...current])
      notifyToast('複製した下書きを追加しました')
      await loadFolders()
    } catch { if (activeAccountRef.current === accountId) setDuplicateError('複製できませんでした。一覧を読み直してお試しください。') }
    finally { duplicateLock.current = false; setDuplicatingId(null) }
  }

  const folderMove = useFolderMove({
    accountId: selectedAccountId, canEdit: canEdit, items: items, folders,
    move: (item, folderId) => moveEventToFolder(item.id, selectedAccountId!, item.version, folderId),
    onChanged: async () => { await refresh(); await loadFolders() },
  })

  const rowMenuItems = (e: EventListItem): ActionMenuItem[] => [
    { id: 'detail', label: "イベントの設定を見る", onSelect: () => detailGuard.protect(() => router.push(`/events/edit?id=${e.id}`)) },
    { id: 'applicants', label: '申込者を見る', onSelect: () => detailGuard.protect(() => router.push(`/events/bookings?id=${e.id}`)) },
    { id: 'change', label: '日時・定員を変更する', onSelect: () => detailGuard.protect(() => router.push(`/events/change-review?id=${e.id}`)) },
    { id: 'preview', label: 'プレビュー', onSelect: () => detailGuard.protect(() => router.push(`/events/preview?id=${e.id}`)) },
    ...(canEdit ? [{ id: 'duplicate', label: '複製する', disabled: duplicatingId !== null, onSelect: () => detailGuard.protect(() => { void duplicateEvent(e) }) }, { id: 'move', label: 'フォルダへ移す', onSelect: () => detailGuard.protect(() => folderMove.open(e)) }, { id: 'delete-event', label: '削除する', tone: 'danger' as const, dividerBefore: true, onSelect: () => detailGuard.protect(() => requestDelete(e)) }] : []),
  ]

  const folderDotOf = (folderId: string | null | undefined) => {
    const folder = folderId ? folders.find((f) => f.id === folderId) : undefined
    return folder ? { name: folder.name, color: folder.color } : null
  }

  const activeIndex = items.findIndex((e) => e.id === activeId)
  const active = activeIndex >= 0 ? items[activeIndex] : null
  const openDetail = (id: string) => withViewTransition(() => setActiveId(activeId === id ? null : id))
  const closeDetail = () => withViewTransition(() => setActiveId(null))
  const goDetail = (direction: -1 | 1) => {
    const next = items[activeIndex + direction]
    if (next) withViewTransition(() => setActiveId(next.id))
  }

  const dataReady = Boolean(selectedAccountId) && loadStatus === 'ready'
  const filterActive = Boolean(query.trim() || filter !== 'all' || folderFilter)
  const pageCount = Math.max(1, Math.ceil(listTotal / perPage))
  const current = Math.min(page, pageCount)
  const kpiDetail = (ready: string) => (!selectedAccountId ? 'アカウントを選択' : loadStatus === 'loading' ? emptyValue('unknown') : loadStatus === 'ready' ? ready : '読み込めませんでした')

  const kpis = [
    {
      key: 'upcoming', title: 'これからの回', icon: CalendarClock, value: dataReady ? kpi.upcoming_slots : null, unit: '回',
      detail: kpiDetail(kpi.nearest_upcoming_starts_at ? `いちばん近い回 ${jstDay(kpi.nearest_upcoming_starts_at)}` : '予定されている回はありません'),
    },
    {
      key: 'active', title: '申込', icon: Users, value: dataReady ? kpi.upcoming_active : null, unit: '人',
      detail: kpiDetail( '今後の回への申込'),
    },
    {
      key: 'nearly-full', title: 'あと少しで満席', icon: Hourglass, value: dataReady ? kpi.nearly_full : null, unit: '回',
      detail: kpiDetail(kpi.nearly_full > 0 ? '残り 1〜3 席' : '該当する回はありません'),
    },
    {
      key: 'low', title: '申し込みが少ない', icon: TrendingDown, value: dataReady ? kpi.low_applications : null, unit: '回',
      detail: kpiDetail( '声をかけると埋まります'),
    },
  ]

  const createButton = (
    <PermissionGatedButton allowed={canEdit} variant="primary" href="/events/new" className="v8-folder-create w-full">
      <Plus size={16} aria-hidden="true" />イベントを作る
    </PermissionGatedButton>
  )

  const folderRows = managedFolderNavRows('event', folders, { allId: '', unfiledId: UNFILED })

  const folderPanel = (
    <ManagedFolderPanel
      kind="event"
      accountId={selectedAccountId ?? null}
      folders={folders}
      onChanged={loadFolders}
      canManage={canEdit && Boolean(selectedAccountId)}
      itemLabel="イベント"
      activeId={folderFilter}
      onSelect={setFolderFilter}
      allId=""
      unfiledId={UNFILED}
      allCount={loadStatus === 'ready' && !folderFilter ? listTotal : null}
      unfiledCount={unfiledCount}
      onAddStart={closeDetail}
      placeholder="例：教室"
      createAction={createButton}
      reserveCreateSpace={false}
    >
      {foldersError ? (
        <Notice tone="danger" className={styles.folderNoteNoticePlacement} >フォルダを読み込めませんでした。
          <Button variant="text" size="inline" data-notice-inline-action type="button" onClick={() => void loadFolders()}>もう一度</Button></Notice>
      ) : null}
    </ManagedFolderPanel>
  )

  const savedValue = filter === 'full' ? 'full' : ''
  const toolbar = (
    <>

      <ListToolbar
        search={{
          placeholder: 'イベント名で探す',
          label: 'イベント名で探す',
          width: 258,
          value: query,
          onChange: (value) => setQuery(clampSearchQuery(value)),
          maxLength: SEARCH_QUERY_MAX_LENGTH,
        }}
        filters={(
          <SegmentedControl
            aria-label="状態で絞り込む"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'すべて' },
              { value: 'open', label: '公開中のみ' },
              { value: 'pending', label: '承認待ちあり', count: pendingTotal !== null && pendingTotal > 0 ? pendingTotal : undefined },
            ]}
          />
        )}
        trailing={(
          <>
            <div className={styles.savedBox}>
              <SaveErrorField names={["savedValue","filter","saved_value"]}><Select
                aria-label="よく使う絞り込み"
                icon={<Bookmark aria-hidden="true" />}
                size="full"
                value={savedValue}
                options={SAVED_OPTIONS}
                onChange={(value) => {
                  if (value === 'full') {
                    setFilter('full')
                  } else {
                    if (filter === 'full') setFilter('all')
                  }
                }}
              /></SaveErrorField>
            </div>
            <SaveErrorField names={["sort"]}><Select aria-label="並び順" size="content" value={sort} options={[{ value: 'soon', label: '開催日順' }, { value: 'name', label: 'イベント名順' }]} onChange={(value) => setSort(value === 'name' ? 'name' : 'soon')} /></SaveErrorField>
            <div className={styles.perPageBox}>
              <SaveErrorField names={["perPage","per_page"]}><Select
                aria-label="表示件数"
                size="page-size"
                value={String(perPage)}
                options={PAGE_SIZES.map((size) => ({ value: String(size), label: `${size} 件表示` }))}
                onChange={(value) => setPerPage(Number(value))}
              /></SaveErrorField>
            </div>
          </>
        )}
      />
    </>
  )

  const tableHead = (
    <>
      <colgroup>
        <col />
        <col className={styles.colWhen} />
        <col className={styles.colSeats} />
        <col className={styles.colPending} />
        <col className={styles.colState} />
        <col className={styles.colMenu} />
      </colgroup>
      <thead>
        <TableHeadRow>
          <Th className={styles.headName}>{folderMove.pageCheckbox}<span className={styles.headNameText}>イベント名（場所）</span></Th>
          <Th>開催日時</Th>
          <Th align="right">予約／定員</Th>
          <Th align="right">承認待ち</Th>
          <Th>
            <span className={styles.headWithTip}>
              状態
              <HelpTip label="状態の見方の説明" placement="above">
                下書き・公開中・一時停止・終了・中止は保存した状態です。満席と申し込みが少ないは、その都度数えた目印で、状態ではありません。
              </HelpTip>
            </span>
          </Th>
          <Th aria-label="操作" />
        </TableHeadRow>
      </thead>
    </>
  )

  const stateCard = (icon: ReactNode, title: string, desc: string, action?: ReactNode, error = false) => (
    <ListState kind={error ? 'error' : 'empty'} title={title} description={desc} icon={icon} action={<>{action}</>} />
  )

  let listBody: ReactNode
  if (!selectedAccountId) {
    listBody = stateCard(<CalendarX size={20} aria-hidden="true" />, 'LINE公式アカウントを選んでください', '上のアカウント切替から、イベントを受け付ける公式アカウントを選びます。')
  } else if (loadStatus === 'loading') {
    listBody = (
      <div className={styles.tableBox} aria-busy="true">
        <span className="sr-only">イベントの一覧を読み込んでいます</span>
        <DelayedSkeleton
          loading
          skeleton={(
            <DataTable presentation="event-list">
              {tableHead}
              <tbody aria-hidden="true">
                {[0, 1, 2, 3].map((index) => (
                  <Tr key={index}>
                    <Td><Skeleton className={styles.skeletonName} /></Td>
                    <Td><Skeleton className={styles.skeletonShort} /></Td>
                    <Td><Skeleton className={styles.skeletonShort} /></Td>
                    <Td><Skeleton className={styles.skeletonShort} /></Td>
                    <Td><Skeleton className={styles.skeletonShort} /></Td>
                    <Td />
                  </Tr>
                ))}
              </tbody>
            </DataTable>
          )}
        />
      </div>
    )
  } else if (loadStatus === 'forbidden') {
    listBody = stateCard(<TriangleAlert size={20} aria-hidden="true" />, 'イベントを見る権限がありません', '選んでいるアカウントでは見られません。管理者に権限を確かめてください。', <Button onClick={() => refresh()} busyLabel="読み込み中…">もう一度読み込む</Button>, true)
  } else if (loadStatus === 'error') {
    listBody = stateCard(
      <TriangleAlert size={20} aria-hidden="true" />,
      'イベントを読み込めませんでした',
      '登録したイベントは消えていません。もう一度読み込んでも直らない場合はエラー報告へ。',
      <Button onClick={() => refresh()} busyLabel="処理中…">もう一度読み込む</Button>,
      true,
    )
  } else if (items.length === 0) {
    /* 修正案 D-2：空の一覧。 */
    listBody = (
      <EmptyList
        icon={<CalendarClock aria-hidden="true" />}
        title="まだイベントがありません"
        description="教室・体験会・相談会など、回ごとに定員のあるイベントの申込を受け付けます。"
        create={{ label: '最初のイベントを作る', href: '/events/new' }}
        canCreate={canEdit}
        filtered={filterActive}
        onClearFilters={() => { setQuery(''); setFilter('all'); setFolderFilter('') }}
      />
    )
  } else {
    listBody = (
      <div className={styles.tableBox}>
        <DataTable presentation="event-list">
          {tableHead}
          <tbody>
            {items.map((e) => {
              const state = eventRowState(e)
              const menuItems = rowMenuItems(e)
              const low = state === 'open' && isLowApplication(e)
              const slot = displaySlot(e)
              const when = whenText(slot.startsAt)
              return (
                <Tr key={e.id} data-row-id={e.id} selected={folderMove.isSelected(e.id) || highlightedId === e.id} detailKey="event" onOpen={() => openDetail(e.id)}>
                  <NameCell selection={folderMove.checkbox(e)} name={(
                      <ContextMenu label={`「${e.name}」の操作`} items={toContextMenuItems(menuItems)}>
                          <RowNameLink
                            href={`/events/edit?id=${encodeURIComponent(e.id)}`}
                            title={`${e.name}の詳細を見る`}
                            aria-label={`「${e.name}」の詳細を見る`}
                          >
                            {e.name}
                          </RowNameLink>
                      </ContextMenu>
                    )} folder={folderDotOf(e.folderId)}
                  />
                  <Td>
                    <span className={styles.whenMain} title={when}>{when}</span>
                    <span className={styles.whenSub}>{slot.label ?? emptyValue('unknown')}</span>
                  </Td>
                  <Td align="right" className={styles.num}>{`${e.total_active} / ${e.total_capacity ?? emptyValue('unknown')}`}</Td>
                  <Td align="right" className={styles.num}>
                    {e.pending_count > 0 ? (
                      <Link href={`/events/bookings?id=${e.id}`} className={styles.pendingLink}>{e.pending_count}</Link>
                    ) : <EmptyCell />}
                  </Td>
                  <Td>
                    <span className={styles.stateLine}>
                      {low ? <StatusBadge tone="warning">申し込みが少ない</StatusBadge>
                        : state === 'open' && (e.total_capacity ?? 0) - e.total_active > 0 && (e.total_capacity ?? 0) - e.total_active <= 3
                          ? <StatusBadge tone="warning">あと少しで満席</StatusBadge>
                          : <StatusBadge tone={ state === 'open' ? 'success'
                            : state === 'full' ? 'danger'
                              : 'neutral'}>{STATE_LABEL[state]}</StatusBadge>}
                      {e.visible_tag_id ? (
                        <TagPill name={e.visible_tag_name ?? '消えたタグ'} size="sm" />
                      ) : null}
                    </span>
                  </Td>
                  <Td className={styles.menuCell}>
                    <span className={styles.menuBox}>
                      <RowMenu
                        label={`${e.name}の操作`}
                        items={menuItems}
                        open={openMenuId === e.id}
                        onOpenChange={(next) => setOpenMenuId(next ? e.id : null)}
                      />
                    </span>
                  </Td>
                </Tr>
              )
            })}
          </tbody>
        </DataTable>
      </div>
    )
  }

  const pager = !dataReady || items.length === 0 ? null : (
    <div className={styles.pagerBlock}>

        <Pagination
          page={current}
          pageCount={pageCount}
          onPageChange={setPage}
          ariaLabel="イベントのページ送り"
          summary={<ListRange bare className={styles.pagerCount} total={listTotal} first={(current - 1) * perPage + 1} last={Math.min(current * perPage, listTotal)} />}
        />
    </div>
  )

  const overlays = (
    <>
      {detailGuard.dialog}
      {folderMove.overlays}
      <DetailPanel
        open={active !== null}
        busy={detailGuard.busy}
        title={active?.name ?? ''}
        description={active ? `${whenText(displaySlot(active).startsAt)}${active.venue_name ? `・${active.venue_name}` : ''}` : undefined}
        onClose={closeDetail}
        hasPrev={activeIndex > 0}
        hasNext={activeIndex >= 0 && activeIndex < items.length - 1}
        onPrev={activeIndex > 0 ? () => goDetail(-1) : undefined}
        onNext={activeIndex >= 0 && activeIndex < items.length - 1 ? () => goDetail(1) : undefined}
        actions={{permissionNeed: "manager", primary: (active ? <Button variant="primary" href={`/events/edit?id=${active.id}`}>中身を見る</Button> : null),
    menuItems: [...(active ? [{ id: 'body-1', label: "プレビュー", onSelect: () => detailGuard.protect(() => router.push(`/events/preview?id=${active.id}`)) }] : []), ...(active ? [{ allowed: canEdit, id: 'detail-0', label: "削除する", onSelect: () => detailGuard.protect(() => { closeDetail(); requestDelete(active) }), tone: 'danger' as const }] : [])], secondary: (active ? <Button variant="secondary" onClick={() => detailGuard.protect(() => router.push(`/events/bookings?id=${active.id}`))}>申込者を見る</Button> : null) }}
       status={active ? <StatusBadge tone={eventRowState(active) === 'open' ? 'success' : 'neutral'}>{STATE_LABEL[eventRowState(active)]}</StatusBadge> : null}>
<DetailContent>
        {active ? (
          <div className={styles.panelBody}>
            <DetailField label="イベント名"> <DetailInlineEdit {...detailGuard.editor} need="manager" allowed={canEdit} value={active.name} label="イベント名" onSave={(next) => renameEvent(active, next)} /> </DetailField>

            <DetailField label="予約・承認待ち"> {`予約 ${active.total_active} / ${active.total_capacity ?? emptyValue('unknown')}　承認待ち ${active.pending_count > 0 ? active.pending_count : emptyValue('unknown')}`} </DetailField>

            {!canEdit ? <p className={styles.folderNote}>名前の変更・削除は、オーナーか管理者だけができます。</p> : null}
          </div>
        ) : null}

</DetailContent>
</DetailPanel>
      <ConfirmDialog
        open={deleteTarget !== null}
        destructive
        title={`「${deleteTarget?.event.name ?? ''}」を削除しますか？`}
        description="このイベントは一覧から外れ、公開中の予約URLは受け付けを止めます。いまある枠も使えなくなります。これまでの申込の記録は残ります。この操作は元に戻せません。"
        confirmLabel="削除する"
        busy={deleteBusy}
        error={deleteError}
        onConfirm={() => confirmDeleteEvent()}
        onCancel={() => {
          if (deleteBusy) return
          setDeleteError('')
          setDeleteTarget(null)
        }}
      >
        {deleteTarget ? <OperationTargetSummary showAccountCount accounts={eventOperationAccounts(deleteTarget.event, deleteTarget.accountId)} /> : null}
      </ConfirmDialog>
    </>
  )

  return (
    <ListPage
      skeleton
      boardId="e2ekFu"
      headingSize="regular"
      title="イベント予約"
      layout="event-list"
      help={<>
        教室・体験会・相談会など、回ごとに定員のあるイベントの申込を受けます。
        {dataReady && kpi.nearest_low_starts_at ? <p>申し込みが少ないのは{jstDay(kpi.nearest_low_starts_at)}の回。あと{daysUntilIso(kpi.nearest_low_starts_at) ?? emptyValue('unknown')}日です。</p> : null}
      </>}
      explanation="定員に達すると、お客さまの画面では自動で「満席」になります。キャンセルが出たら、キャンセル待ちの人に自動で順番が回ります。"
      folderWidth={200}

      tabs={!canEdit ? (
        <div className={styles.viewerBand}><ReadOnlyNotice role="status">{VIEWER_NOTE}</ReadOnlyNotice></div>
      ) : undefined}
      stats={(
        <KpiBand data-design="KPIs">
          {kpis.map((item) => (
            <KpiCard
              key={item.key}
              presentation="band"
              title={item.title}
              icon={<item.icon size={16} aria-hidden="true" />}
              value={item.value}
              unit={item.value == null ? '' : item.unit}
              detail={item.detail}
            />
          ))}
        </KpiBand>
      )}
      folders={folderPanel}
      folderNav={{ rows: folderRows, activeId: folderFilter, onSelect: setFolderFilter, createAction: createButton }}
      toolbar={<>{duplicateError ? <Notice tone="danger">{duplicateError}</Notice> : null}{toolbar}</>}
      pagination={pager}
      overlays={overlays}
    >
      {listBody}
    </ListPage>
  )
}
