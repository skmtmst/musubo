'use client'
import { DetailContent, DetailFields, DetailInlineEdit } from '@/components/shared/detail-content'
import { RefreshCover } from '@/components/shared/refresh-cover'
import { useListSnapshot } from '@/lib/use-list-snapshot'

import { useListUrlValue, useListUrlState } from '@/components/shared/list-url-state';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Archive, CircleDot, Flag, GripVertical, History, Info, Loader, Send, AlertCircle } from 'lucide-react'

import { RowNameLink, DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table'

import Link, { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { api, ApiError, type ListStats, type SupportMarkArchiveImpact, type SupportMarkListItem } from '@/lib/api';
import { createResponseGate } from '@/lib/latest-request';
import { ListPageBody } from '@/components/templates';
import { type ActionMenuItem } from '@/components/shared/action-menu';
import { RowMenu } from '@/components/shared/row-actions';
import DetailPanel from '@/components/shared/detail-panel';
import { useHeldDetail, useInlineDetailGuard } from '@/components/shared/use-inline-detail-guard'
import ContextMenu, { type ContextMenuItem } from '@/components/shared/context-menu';
import InlineEdit from '@/components/shared/inline-edit'
import { withViewTransition } from '@/components/shared/view-transition';
import Button from '@/components/shared/button'
import FilterChip from '@/components/shared/filter-chip'
import StatusBadge from '@/components/shared/status-badge'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { describeApiFailure, permissionDeniedMessage } from '@/components/shared/api-error-message';
import Select from '@/components/shared/select'
import Pagination from '@/components/shared/pagination'
import SearchField from '@/components/shared/search-field'
import KpiCard from '@/components/shared/kpi-card'
import KpiBand from '@/components/shared/kpi-band'
import { DelayedSkeleton } from '@/components/shared/skeleton';
import { STATE_TEXT } from '@/components/shared/not-connected';
import { notifyToast } from '@/components/shared/toast';
import PageSizeSelect, { PAGE_SIZES as STANDARD_PAGE_SIZES } from '@/components/shared/page-size-select';
import ReorderHandle from '@/components/shared/reorder-handle'
import { useFlipRows, useLiveReorder } from '@/lib/use-live-reorder';
import { mergeVisibleOrder, movableIds } from '@/components/friend-fields/reorder-utils';
import { ArchiveMarkDialog, autoRuleLabel, isUsed, usageLabel } from '@/components/friend-fields/mark-list';
import styles from './list.module.css'
import type { AttributeListHost } from './attribute-host';
import { emptyValue } from '@/components/shared/empty-value';
import { SaveErrorField } from '@/components/shared/save-form-errors';
import { ListToolbarEnd, ListToolbarSearchSlot } from '@/components/shared/list-toolbar';
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import { formatNumber } from '@/lib/format'

/*
 * ★V8 タグ「対応マーク」タブ（Pencil ）。
 *
 * 動き（読み込み・数の帯・絞り込み・並べ替え・保管の確認・行の詳細パネル・右クリック・
 * 名前のその場の直し）は現役の V8 タブ（src/v8/tags/marks-tab.tsx）から写した。数え方・判定・
 * 保管の窓は共通のV8部品（components/friend-fields/mark-list）を使う。見た目だけを絵に合わせた：
 * 数の帯は共通の帯（板の端から端）、案内は青い帯、道具の段の右端に表示件数、
 * 表は板の端から端（行の右端は必ず「…」）、表の下に安全確認の段。
 */

type MarkRow = SupportMarkListItem
type LoadStatus = 'loading' | 'ready' | 'error' | 'forbidden'

const PAGE_SIZES = STANDARD_PAGE_SIZES

export default function MarksTab({ accountId, canEdit, host, explanation = false }: { accountId: string | null; canEdit: boolean; host?: AttributeListHost<MarkRow>; explanation?: boolean }) {
  const router = useRouter()
  const { value: items, setValue: setItems, hasValue: loaded } = useListSnapshot<MarkRow[]>(accountId ?? '', [])
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [error, setError] = useState('')
  // 並び替え・保管の失敗は読み込み失敗と別に持つ（ATTR-02）。
  const [actionError, setActionError] = useState('')
  const [retryOrder, setRetryOrder] = useState<MarkRow[] | null>(null)
  const [stats, setStats] = useState<ListStats | null>(null)
  const [statsStatus, setStatsStatus] = useState<LoadStatus>('loading')
  const [view, setView] = useListUrlState({ archived: '' })
  const onlyArchived = !host && view.archived === '1'
  const [restoreTarget, setRestoreTarget] = useState<MarkRow | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [restoreError, setRestoreError] = useState('')
  const [query, setQuery] = useListUrlValue('q', '')
  const [usage, setUsage] = useState<'all' | 'used' | 'unused'>('all')
  const [pageSize, setPageSize] = useListUrlValue('pageSize', 20)
  const [page, setPage] = useListUrlValue('page', 1)
  const [dragId, setDragId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<MarkRow | null>(null)
  const [archiveImpact, setArchiveImpact] = useState<SupportMarkArchiveImpact | null>(null)
  const [replacementMarkId, setReplacementMarkId] = useState('')
  const [impactLoading, setImpactLoading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  /* 行の詳細パネル。URL に ?mark=<id> を残す。 */
  const detailGuard = useInlineDetailGuard('mark')
  const { id: activeMarkId, setId: setActiveMarkId } = detailGuard
  const openMarkDetail = (id: string) => host ? (canEdit ? host.onEdit(id) : undefined) : withViewTransition(() => setActiveMarkId(current => current === id ? null : id))

  /* アカウント切替のあとに届いた古い応答で一覧を上書きしない（ATTR-01）。 */
  const gateRef = useRef(createResponseGate())
  const accountRef = useRef(accountId)
  accountRef.current = accountId
  const archiveScope = useRef<{ accountId: string | null; generation: number }>({ accountId, generation: 0 })
  if (archiveScope.current.accountId !== accountId) archiveScope.current = { accountId, generation: archiveScope.current.generation + 1 }
  const openArchiveGeneration = useRef(-1)
  const restoreScopeRef = useRef<{ accountId: string | null; generation: number } | null>(null)
  const restoreScope = restoreScopeRef.current

  useEffect(() => {
    gateRef.current.invalidate()
    restoreScopeRef.current = null
    setRestoreTarget(null)
    setRestoreError('')
    setPendingDelete(null)
    setDeleting(false)
    setArchiveImpact(null)
    setDragId(null)
    setPage(1)
    setError('')
    setActionError('')
    setRetryOrder(null)
    setDeleteError('')
    setOpenMenuId(null)
  }, [accountId])

  const load = useCallback(async () => {
    if (host) { host.reload(); return }
    const account = accountId
    const token = gateRef.current.begin()
    if (!account) {
      setItems([])
      setStatus('error')
      setError('LINE公式アカウントを選んでください')
      return
    }
    setStatus('loading')
    setError('')
    try {
      const res = await api.supportMarks.list(account, { includeArchived: true })
      if (!gateRef.current.current(token) || accountRef.current !== account) return
      if (!res.success) throw new Error(res.error)
      setItems(res.data)
      setStatus('ready')
    } catch (reason) {
      if (!gateRef.current.current(token) || accountRef.current !== account) return
      setStatus(reason instanceof ApiError && reason.status === 403 ? 'forbidden' : 'error')
    }
  }, [accountId, host, setItems])
  useEffect(() => { if (!host) void load() }, [load, host])
  useEffect(() => { if (host) { setItems(host.items); setStatus(host.status); setError(host.error ?? '') } }, [host])

  /* 帯の人数は受信箱の集計（/api/list-stats）から。一覧とは別の要求。 */
  useEffect(() => {
    if (host) return
    if (!accountId) {
      setStatsStatus('error')
      return
    }
    let cancelled = false
    setStats(null)
    setStatsStatus('loading')
    void api.listStats.get(accountId).then((res) => {
      if (cancelled) return
      if (res.success) { setStats(res.data); setStatsStatus('ready') }
      else { setStats(null); setStatsStatus('error') }
    }, (reason) => {
      if (cancelled) return
      setStats(null)
      setStatsStatus(reason instanceof ApiError && reason.status === 403 ? 'forbidden' : 'error')
    })
    return () => { cancelled = true }
  }, [accountId, host])

  const visible = useMemo(() => items.filter((mark) => {
    if (!host && Boolean(mark.archivedAt) !== onlyArchived) return false
    if (query && !mark.name.toLocaleLowerCase('ja').includes(query.toLocaleLowerCase('ja'))) return false
    if (host && usage !== 'all' && mark.friendCount == null) return false
    if (usage === 'used' && !(host ? mark.friendCount > 0 : isUsed(mark))) return false
    if (usage === 'unused' && (host ? mark.friendCount > 0 : isUsed(mark))) return false
    return true
  }), [items, query, usage, host, onlyArchived])

  const pages = Math.max(1, Math.ceil(visible.length / pageSize))
  const currentPage = Math.min(page, pages)
  const pageItems = visible.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  /* 動かしている間、置き場所を入れ替えて見せ、ほかの行は滑らかに場所を空ける（自動応答と同じ動き）。 */
  const liveOrder = useLiveReorder(pageItems, (mark) => mark.id, dragId)
  const bodyRef = useRef<HTMLTableSectionElement>(null)
  useFlipRows(bodyRef, liveOrder.shown.map((mark) => mark.id).join(','), JSON.stringify([accountId, query, usage, onlyArchived, page, pageSize]))
  const activeMark = useHeldDetail(items.find((mark) => mark.id === activeMarkId) ?? null, activeMarkId, detailGuard.holding, accountId)
  const activeMarkIndex = pageItems.findIndex((mark) => mark.id === activeMarkId)
  useEffect(() => setPage(1), [query, usage, pageSize, onlyArchived])

  /* 並び替え：/api/support-marks/reorder へ「動かせる行だけの新しい順」を1回で渡す。共有マークは位置を保つ。 */
  const applyOrder = async (next: MarkRow[]) => {
    if (host) { await host.onOrder(next.map((item) => item.id)); return }
    if (!accountId) return
    const previous = items
    setItems(next)
    setActionError('')
    setRetryOrder(null)
    try {
      const res = await api.supportMarks.reorder(accountId, movableIds(next, (mark) => !mark.isInherited))
      if (!res.success) throw new Error(res.error)
      await load()
    } catch (reason) {
      setItems(previous)
      const message = describeApiFailure(reason, '並び順の保存')
      setActionError(message)
      setRetryOrder(next)
      notifyToast(message, { tone: 'error', actionLabel: 'もう一度', onAction: () => { void applyOrder(next) } })
    }
  }

  const reorderTo = async (order: string[]) => {
    const visibleNext = order.map((id) => items.find((mark) => mark.id === id)).filter(Boolean) as MarkRow[]
    await applyOrder(mergeVisibleOrder(items, visibleNext, (mark) => mark.isInherited === true))
  }

  const move = async (targetId: string) => {
    if ((!accountId && !host) || !dragId || dragId === targetId) return setDragId(null)
    const dragged = items.find((mark) => mark.id === dragId)
    const target = items.find((mark) => mark.id === targetId)
    if (dragged?.isInherited || target?.isInherited) {
      setDragId(null)
      setActionError('共有マークは、編集してこのアカウント専用にしてから並び替えてください')
      return
    }
    const order = visible.map((mark) => mark.id)
    const from = order.indexOf(dragId)
    const to = order.indexOf(targetId)
    setDragId(null)
    if (from < 0 || to < 0) return
    order.splice(to, 0, ...order.splice(from, 1))
    await reorderTo(order)
  }

  /** つまみにフォーカスして ↑/↓。共有マークに隣接する方向には動かさない（N-049）。 */
  const keyboardMove = async (id: string, direction: -1 | 1) => {
    const order = visible.map((mark) => mark.id)
    const from = order.indexOf(id)
    const to = from + direction
    if (from < 0 || to < 0 || to >= order.length) return
    if (items.find((mark) => mark.id === order[to])?.isInherited) {
      setActionError('共有マークは、編集してこのアカウント専用にしてから並び替えてください')
      return
    }
    order.splice(to, 0, ...order.splice(from, 1))
    await reorderTo(order)
  }

  const openArchive = async (mark: MarkRow) => {
    const account = accountId
    if (!account) return
    openArchiveGeneration.current = archiveScope.current.generation
    const token = gateRef.current.begin()
    setPendingDelete(mark)
    setArchiveImpact(null)
    setReplacementMarkId('')
    setDeleteError('')
    setImpactLoading(true)
    try {
      const res = await api.supportMarks.archiveImpact(mark.id, account)
      if (!gateRef.current.current(token) || accountRef.current !== account) return
      if (!res.success) throw new Error(res.error)
      setArchiveImpact(res.data)
      setReplacementMarkId(res.data.replacementOptions.find((option) => option.isDefault)?.id ?? res.data.replacementOptions[0]?.id ?? '')
    } catch {
      if (gateRef.current.current(token) && accountRef.current === account) {
        setDeleteError('保管の影響を確認できませんでした。画面を閉じて、もう一度お試しください。')
      }
    } finally {
      if (gateRef.current.current(token) && accountRef.current === account) setImpactLoading(false)
    }
  }

  const confirmRemove = async (mark: MarkRow) => {
    // R180: 0人のときは置換先なしで保管する。
    const replacement = (archiveImpact?.friendCount ?? 0) > 0 ? replacementMarkId : (replacementMarkId || null)
    if (!accountId || openArchiveGeneration.current !== archiveScope.current.generation || !archiveImpact || ((archiveImpact.friendCount ?? 0) > 0 && !replacementMarkId) || deleting) return
    const generation = archiveScope.current.generation
    setError('')
    setDeleteError('')
    setDeleting(true)
    try {
      const res = await api.supportMarks.archive(mark.id, accountId, {
        replacementMarkId: replacement,
        impactRevision: archiveImpact.impactRevision,
        expectedVersion: archiveImpact.expectedVersion,
      }, crypto.randomUUID())
      if (generation !== archiveScope.current.generation) return
      if (!res.success) throw new Error(res.error)
      setPendingDelete(null)
      setArchiveImpact(null)
      await load()
    } catch {
      if (generation !== archiveScope.current.generation) return
      setDeleteError('対応マークを保管できませんでした。状態を読み直してから、もう一度お試しください。')
    } finally {
      if (generation === archiveScope.current.generation) setDeleting(false)
    }
  }

  const confirmRestore = async () => {
    if (!restoreTarget || !restoreScope?.accountId || restoreScopeRef.current !== restoreScope || restoreScope.generation !== archiveScope.current.generation || restoring) return
    const mark = restoreTarget
    const account = restoreScope.accountId
    setRestoring(true)
    setRestoreError('')
    try {
      const res = await api.supportMarks.restore(mark.id, account, mark.version ?? 1)
      if (accountRef.current !== account) return
      if (!res.success) throw new Error(res.error)
      restoreScopeRef.current = null
      setRestoreTarget(null)
      notifyToast(`「${mark.name}」を保管から戻しました`)
      await load()
    } catch (error) {
      if (accountRef.current === account) setRestoreError(describeApiFailure(error, '保管から戻す操作', { forbidden: 'この操作はオーナーか管理者に頼んでください。' }))
    } finally { setRestoring(false) }
  }

  /* 行の「…」と右クリックは同じ操作。押せない理由もそのまま渡す。閲覧のみは押せない項目を出さない。 */
  const rowMenuItemsRaw = (mark: MarkRow): ActionMenuItem[] => {
    if (host) return canEdit ? [
      { id: 'edit', label: '編集', onSelect: () => host.onEdit(mark.id) },
      { id: 'distribute', label: '配る', icon: <Send size={16} aria-hidden="true" />, disabled: host.busy, onSelect: () => host.onDistribute(mark.id) },
      { id: 'delete', label: '削除する', tone: 'danger', dividerBefore: true, onSelect: () => host.onRemove(mark.id) },
    ] : []
    if (!canEdit) return [{ id: 'open', label: '詳しく見る', onSelect: () => openMarkDetail(mark.id) }]
    if (mark.archivedAt) return [{ id: 'restore', label: '保管から戻す', disabled: restoring, onSelect: () => { restoreScopeRef.current = { accountId, generation: archiveScope.current.generation }; setRestoreError(''); setRestoreTarget(mark) } }]
    return [
      { id: 'edit', label: '編集', external: false, href: `/tags/marks/edit?id=${encodeURIComponent(mark.id)}`, onSelect: () => router.push(`/tags/marks/edit?id=${encodeURIComponent(mark.id)}`) },
      {
        id: 'archive',
        label: '保管する',
        icon: <Archive size={16} aria-hidden="true" />,
        tone: 'danger',
        dividerBefore: true,
        disabled: mark.isDefault || mark.isInherited,
        disabledReason: mark.isDefault
          ? '初期値のマークは保管できません。先に別のマークを初期値にしてください。'
          : mark.isInherited
            ? '共有マークは編集してこのアカウント専用にしてから保管できます'
            : undefined,
        onSelect: () => void openArchive(mark),
      },
    ]
  }
  const rowMenuItems = (mark: MarkRow): ActionMenuItem[] => rowMenuItemsRaw(mark).map(item => item.onSelect ? { ...item, onSelect: () => detailGuard.protect(() => { void item.onSelect?.() }) } : item)
  const markContextItems = (mark: MarkRow): ContextMenuItem[] =>
    rowMenuItems(mark).map((item) => ({
      id: item.id,
      label: item.label,
      danger: item.tone === 'danger',
      disabled: item.disabled,
      onSelect: () => item.onSelect?.(),
    }))

  /* 帯は4つ。マークの数は一覧そのものから、人数は受信箱の集計から。 */
  const listReady = host ? host.status === 'ready' && status === 'ready' && items === host.items : loaded && (status === 'ready' || status === 'loading')
  const inUseCount = items.filter(isUsed).length
  const statsReason = statsStatus === 'loading' ? STATE_TEXT.loading
    : statsStatus === 'forbidden' ? STATE_TEXT.forbiddenView
      : statsStatus === 'error' ? STATE_TEXT.error
        : null
  const inboxTotal = stats ? stats.marks.unanswered + stats.marks.inProgress + (stats.marks.onHold ?? 0) + stats.marks.resolved : 0
  const kpis = [
    {
      title: 'マーク',
      icon: Flag,
      value: listReady ? items.length : null,
      unit: '種類',
      detail: listReady ? `使っている ${inUseCount}` : (status === 'forbidden' ? STATE_TEXT.forbiddenView : status === 'loading' ? STATE_TEXT.loading : STATE_TEXT.error),
    },
    {
      title: '未対応',
      icon: CircleDot,
      value: stats?.marks.unanswered ?? null,
      unit: '人',
      detail: statsReason ?? (inboxTotal > 0 ? `受信箱の ${Math.round((stats!.marks.unanswered / inboxTotal) * 1000) / 10}%` : '受信箱の —'),
    },
    { title: '対応中', icon: Loader, value: stats?.marks.inProgress ?? null, unit: '人', detail: statsReason ?? '担当が付いている' },
    { title: '過去7日の変更', icon: History, value: stats?.marks.changedLast7 ?? null, unit: '回', detail: statsReason ?? '手動・自動' },
  ]

  const filterActive = Boolean(query || usage !== 'all' || onlyArchived)
  const archivedCount = useMemo(() => items.filter((mark) => Boolean(mark.archivedAt)).length, [items])

  const table = status === 'forbidden' ? (
    <ListState kind="error" title="対応マークを見る権限がありません" description={permissionDeniedMessage('store')}  />
  ) : status === 'error' ? (
    <ListState kind="error" title="対応マークを読み込めませんでした" description={error || '再読み込みしても直らない場合はエラー報告へ。'}  action={<><Button type="button" onClick={() => load()} busyLabel="処理中…">もう一度読み込む</Button></>} />
  ) : listReady && items.length === 0 ? (
    <ListState kind="empty" title="まだ対応マークはありません" description="受信箱で、対応の進み具合を見分ける印です。"  icon={<Flag className={styles.stateIcon} aria-hidden="true" />} action={<>{canEdit ? <Button href={host ? undefined : "/tags/marks/new"} onClick={host?.onCreate} variant="primary">マークを作る</Button> : null}</>} />
  ) : listReady && visible.length === 0 ? (
    <ListState kind="empty" title="条件に合うものはありません" description="検索や絞り込みを外すと、すべて出ます"  action={<>{filterActive ? <Button type="button" onClick={() => { setQuery(''); setUsage('all'); setView({ archived: '' }) }}>条件を外す</Button> : null}</>} />
  ) : (
    <DelayedSkeleton loading={!listReady} skeleton={<div className={styles.skeleton} aria-busy="true" />}>
      <DataTable className={styles.table}>
        <thead>
          <TableHeadRow>
            <Th className={styles.markColGrip}><span className="sr-only">並び替え</span></Th>
            <Th className={styles.markColName}>マーク</Th>
            <Th className={styles.markColCount}>付いている人</Th>
            <Th className={styles.markColDefault}>はじめの値</Th>
            <Th className={styles.markColAuto}>自動で変わる</Th>
            <Th className={styles.markColPlace}>出す場所</Th>
            <Th className={styles.colMenu}><span className="sr-only">操作</span></Th>
          </TableHeadRow>
        </thead>
        <tbody ref={bodyRef}>
          {liveOrder.shown.map((mark) => {
            const editHref = `/tags/marks/edit?id=${encodeURIComponent(mark.id)}`
            const fixed = mark.isInherited || !canEdit || Boolean(mark.archivedAt)
            return (
              <Tr
                interactive
                key={mark.id}
                data-reorder-id={mark.id}
                onDragEnter={() => { if (!mark.isInherited) liveOrder.enter(mark.id) }}
                onDragOver={dragId ? (event) => event.preventDefault() : undefined}
                onDrop={dragId ? () => void move(liveOrder.dropTarget(mark.id)) : undefined}
                className={`${styles.row} ${styles.markRow}`}
                tabIndex={0}
                detailKey="mark" onOpen={() => openMarkDetail(mark.id)}
                 data-row-id={mark.id}
              >
                <Td className={styles.markColGrip}>
                  {canEdit ? (
                    <span
                      className={styles.gripBox}
                      draggable={!fixed}
                      title={mark.isInherited ? '共有マークは編集後に並び替えできます' : undefined}
                      onDragStart={() => setDragId(mark.id)}
                      onDragEnd={() => setDragId(null)}
                    >
                      <ReorderHandle
                        label={mark.name}
                        disabledReason={mark.archivedAt ? '保管から戻すと並び替えできます' : fixed ? '共有マークは編集後に並び替えできます' : null}
                        onMove={(direction) => void keyboardMove(mark.id, direction)}
                      >
                        <GripVertical className={styles.gripIcon} aria-hidden="true" />
                      </ReorderHandle>
                    </span>
                  ) : <span className={styles.gripSpace} aria-hidden="true" />}
                </Td>
                <Td className={styles.markColName}>
                  <ContextMenu label={`対応マーク「${mark.name}」の操作`} items={markContextItems(mark)}>
                    {!canEdit || mark.archivedAt ? <span className={styles.markPill} style={{ '--mark-color': mark.color } as CSSProperties} title={mark.name}>
                      <span className={styles.markPillDot} aria-hidden="true" />
                      <span className={styles.truncate}>{mark.name}</span>
                    </span> : <RowNameLink
                      href={host ? "#" : editHref}
                      title={mark.name}
                      onClick={(event) => { event.stopPropagation(); if (host) { event.preventDefault(); if (canEdit) host.onEdit(mark.id) } }}
                    >
                      {/* 札は文字の幅（絵 vKDj5）。名前のリンクは列いっぱいの塊なので、札は中の span で描く。 */}
                      <span className={styles.markPill} style={{ '--mark-color': mark.color } as CSSProperties}>
                        <span className={styles.markPillDot} aria-hidden="true" />
                        <span className={styles.truncate}>{mark.name}</span>
                      </span>
                    </RowNameLink>}
                  </ContextMenu>
                  {mark.archivedAt ? <StatusBadge size="annotation" dot={false}>保管</StatusBadge> : null}
                </Td>
                <Td className={styles.markColCount}><span className={styles.cellText}>{mark.friendCount == null ? emptyValue('unknown') : `${formatNumber(mark.friendCount)}人`}</span></Td>
                <Td className={styles.markColDefault}><span className={styles.cellText}>{mark.isDefault ? '新規の初期値' : emptyValue('unknown')}</span></Td>
                <Td className={styles.markColAuto}><span className={styles.cellText} title={host ? (mark.autoOnInbound ? '受信時' : emptyValue('unknown')) : autoRuleLabel(mark)}>{host ? (mark.autoOnInbound ? '受信時' : emptyValue('unknown')) : autoRuleLabel(mark)}</span></Td>
                <Td className={styles.markColPlace}><span className={styles.cellText} title={host ? undefined : usageLabel(mark)}>{host ? emptyValue('unknown') : usageLabel(mark)}</span></Td>
                {/* 統括の［配る］は行の「…」の中（B-253：行の右端は「…」1つ）。 */}
                <Td className={styles.colMenu}>
                  <span className={styles.menuAnchor}>
                    {(!host || canEdit) ? <RowMenu
                      size="row"
                      label={`対応マーク「${mark.name}」の操作`}
                      items={rowMenuItems(mark)}
                      open={openMenuId === mark.id}
                      onOpenChange={(next) => setOpenMenuId(next ? mark.id : null)}
                    /> : null}
                  </span>
                </Td>
              </Tr>
            )
          })}
        </tbody>
      </DataTable>

      {/* 表の下の段（安全確認）。 */}
      <section className={styles.safetyNote}>
        <h2 className={styles.safetyNoteTitle}>受信時の自動変更・保留・初期値の安全確認</h2>
        <p className={styles.safetyNoteBody}>「受信時」の自動変更は、返信・保留・担当が決まったものも上書きすることがあります。保留中は自動で変えない設定にしてから使ってください。初期値は新しく友だちになった人に付きます。</p>
      </section>
    </DelayedSkeleton>
  )

  return (
    <>
      {host?.kpis ?? <KpiBand data-design="KPIs" className={styles.kpis}>
        {kpis.map((kpi) => (
          <KpiCard
            key={kpi.title}
            presentation="band"
            title={kpi.title}
            icon={<kpi.icon size={16} aria-hidden="true" />}
            value={kpi.value}
            unit={kpi.value == null ? '' : kpi.unit}
            detail={kpi.detail}
            loading={statsStatus === 'loading'}
          />
        ))}
      </KpiBand>}

      {!explanation ? <div className={styles.infoRow}>
        <p className={styles.readonlyBand}>
          <Info className={styles.readonlyIcon} aria-hidden="true" />
          対応マークは、受信箱で「未対応・対応中・対応済み・保留」を見分ける印です。新しいメッセージが来たら自動で変える、などのきまりを付けられます。
        </p>
      </div> : null}

      <ConfirmDialog open={restoreTarget !== null} title={`「${restoreTarget?.name ?? ''}」を保管から戻しますか？`}
        description="同じ対応マークを通常の一覧へ戻します。初期値や自動変更は再開せず、友だちの付け替えはそのまま残ります。"
        confirmLabel="保管から戻す" busy={restoring} error={restoreError}
        onConfirm={() => void confirmRestore()} onCancel={() => { if (!restoring) { restoreScopeRef.current = null; setRestoreTarget(null) } }}>
        <OperationTargetSummary accounts={[{ id: restoreScope?.accountId ?? '' }]} externalTarget={{ label: '対象件数', name: restoreTarget ? '1件' : null }} />
      </ConfirmDialog>
      <ListPageBody
        pagination={status === 'ready' ? (
          // ページ送りは表の下の安全確認のあと、板の下。
          <Pagination page={currentPage} pageCount={pages} onPageChange={setPage} ariaLabel="対応マークのページ送り"
            range={{ total: visible.length, first: (currentPage - 1) * pageSize + 1, last: Math.min(currentPage * pageSize, visible.length) }} />
        ) : undefined}
        skeleton explanation={explanation ? '対応マークは、受信箱で「未対応・対応中・対応済み・保留」を見分ける印です。新しいメッセージが来たら自動で変える、などのきまりを付けられます。' : undefined}
        toolbar={<>
          <ListToolbarSearchSlot>
            <SearchField
              aria-label="マーク名で探す"
              placeholder="マーク名で探す"
              value={query}
              onChange={setQuery}
              onClear={() => setQuery('')}
            />
          </ListToolbarSearchSlot>
          <SaveErrorField names={["usage"]}><Select
            aria-label="使っているかで絞り込む"
            width={157}
            value={usage}
            onChange={(value) => setUsage(value as typeof usage)}
            options={[
              { value: 'all', label: '使っている：すべて' },
              { value: 'used', label: '使っている：あり' },
              { value: 'unused', label: '使っている：なし' },
            ]}
          /></SaveErrorField>
          {!host ? <FilterChip selected={onlyArchived} icon={<Archive aria-hidden="true" />} count={archivedCount || undefined} onChange={(next) => { setView({ archived: next ? '1' : '' }); setPage(1) }}>保管</FilterChip> : null}
          <ListToolbarEnd>
            <PageSizeSelect value={pageSize} onChange={(value) => setPageSize(value || 20)} options={PAGE_SIZES} label={null} />
          </ListToolbarEnd>
        </>}
      >
        {actionError ? (
          <Notice tone="danger" >{actionError}{retryOrder ? (
              <Button variant="text" size="inline" data-notice-inline-action type="button" onClick={() => { const next = retryOrder; setRetryOrder(null); if (next) void applyOrder(next) }}>再試行</Button>
            ) : (
              <Button variant="text" size="inline" data-notice-inline-action type="button" onClick={() => { setActionError(''); void load() }}>状態を確認する</Button>
            )}</Notice>
        ) : null}
        <RefreshCover refreshing={status === 'loading' && loaded}>{table}</RefreshCover>
      </ListPageBody>

      {/* 行の詳細パネル。名前はその場で直せる。 */}
      {detailGuard.dialog}
      <DetailPanel
        open={!host && activeMark !== null}
        busy={detailGuard.busy}
        title={activeMark?.name ?? ''}
        description={activeMark ? `${formatNumber(activeMark.friendCount)} 人・${autoRuleLabel(activeMark)}` : undefined}
        onClose={() => setActiveMarkId(null)}
        hasPrev={activeMarkIndex > 0}
        hasNext={activeMarkIndex >= 0 && activeMarkIndex < pageItems.length - 1}
        onPrev={activeMarkIndex > 0 ? () => setActiveMarkId(pageItems[activeMarkIndex - 1].id) : undefined}
        onNext={activeMarkIndex >= 0 && activeMarkIndex < pageItems.length - 1 ? () => setActiveMarkId(pageItems[activeMarkIndex + 1].id) : undefined}
        actions={{ primary: (activeMark ? <Button variant="primary" href={`/tags/marks/edit?id=${encodeURIComponent(activeMark.id)}`}>編集する</Button> : null),
    menuItems: [], primaryAllowed: canEdit }}
      >
<DetailContent>
        {activeMark ? (
          <DetailFields>
            <div>
              <dt>マーク名</dt>
              <dd>
                <DetailInlineEdit {...detailGuard.editor} allowed={canEdit}
                    label="マーク名"
                    value={activeMark.name}
                    maxLength={30}
                    disabled={!accountId}
                    onSave={async (next) => {
                      if (!accountId) throw new Error('no account')
                      // R513: 読んだときの版を送る。先に変えていたら409で止める（編集画面と同じ）。
                      const res = await api.supportMarks.update(activeMark.id, accountId, {
                        name: next,
                        ...(typeof activeMark.version === 'number' ? { expectedVersion: activeMark.version } : {}),
                      })
                      if (!res.success) throw new Error(res.error)
                      void load()
                    }}
                  />
              </dd>
            </div>
            <div><dt>付いている人</dt><dd>{`${formatNumber(activeMark.friendCount)}人`}</dd></div>
            <div><dt>はじめの値</dt><dd>{activeMark.isDefault ? '新規の初期値' : emptyValue('unknown')}</dd></div>
            <div><dt>自動で変わる</dt><dd>{autoRuleLabel(activeMark)}</dd></div>
            <div><dt>出す場所</dt><dd>{usageLabel(activeMark)}</dd></div>
          </DetailFields>
        ) : null}

</DetailContent>
</DetailPanel>

      {pendingDelete && openArchiveGeneration.current === archiveScope.current.generation ? (
        <ArchiveMarkDialog
          mark={pendingDelete}
          accountId={accountId}
          impact={archiveImpact}
          replacementMarkId={replacementMarkId}
          loading={impactLoading}
          saving={deleting}
          error={deleteError}
          onReplacement={setReplacementMarkId}
          onCancel={() => { if (!deleting) { setPendingDelete(null); setArchiveImpact(null) } }}
          onConfirm={() => confirmRemove(pendingDelete)}
        />
      ) : null}
    </>
  )
}
