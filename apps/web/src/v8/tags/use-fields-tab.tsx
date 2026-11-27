'use client'

import PermissionGatedButton from '@/components/shared/permission-gated-button'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { useListSnapshot } from '@/lib/use-list-snapshot'
import { useListUrlValue } from '@/components/shared/list-url-state'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ClipboardList, List, Pencil, Plus, Send, Users } from 'lucide-react'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import type { Folder, FriendField, FriendFieldListSummary, FriendFieldType } from '@line-crm/shared'
import { api, ApiError } from '@/lib/api'
import { createResponseGate } from '@/lib/latest-request'
import { useRowLeaving } from '@/lib/use-row-leaving'
import { type FolderPanelRow } from '@/components/shared/folder-panel'
import { type ActionMenuItem } from '@/components/shared/action-menu'
import { useHeldDetail, useInlineDetailGuard } from '@/components/shared/use-inline-detail-guard'
import { type ContextMenuItem } from '@/components/shared/context-menu'
import { withViewTransition } from '@/components/shared/view-transition'
import Button from '@/components/shared/button'
import { STATE_TEXT, notConnectedText } from '@/components/shared/not-connected'
import { notifyToast } from '@/components/shared/toast'
import { useFlipRows, useLiveReorder } from '@/lib/use-live-reorder'
import { mergeVisibleOrder, movableIds } from '../../components/friend-fields/reorder-utils'
import { fieldDeletionBlockedReason, knownUsageCount } from '../../components/friend-fields/field-list'
import styles from './list.module.css'
import type { AttributeListHost } from './attribute-host'
import { LoadStatus, UNFILED } from './fields-list-model'

export function useFieldsTab({ accountId, canEdit, narrow = false, host, explanation = false }: { accountId: string | null; canEdit: boolean; narrow?: boolean; host?: AttributeListHost<FriendField>; explanation?: boolean }) {
  const router = useRouter()
  const { value: items, setValue: setItems, hasValue: loaded } = useListSnapshot<FriendField[]>(accountId ?? '', [])
  const { value: summary, setValue: setSummary } = useListSnapshot<FriendFieldListSummary | null>(accountId ?? '', null)
  const [status, setStatus] = useState<LoadStatus>('loading')
  /* 集計は一覧とは別の要求（片方だけ落ちてももう片方は出す）。 */
  const [statsStatus, setStatsStatus] = useState<LoadStatus>('loading')
  const [error, setError] = useState('')
  // 操作の失敗は読み込みの失敗とは別の状態にする（ATTR-02）。
  const [actionError, setActionError] = useState('')
  const [retryOrder, setRetryOrder] = useState<FriendField[] | null>(null)
  const [query, setQuery] = useListUrlValue('q', '')
  const [type, setType] = useState<'all' | FriendFieldType>('all')
  const [folderFilter, setFolderFilter] = useListUrlValue('folderFilter', '')
  const [pageSize, setPageSize] = useListUrlValue('pageSize', 20)
  const [page, setPage] = useListUrlValue('page', 1)
  const [dragId, setDragId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<FriendField | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const [deleteNeedsReview, setDeleteNeedsReview] = useState(false)
  const editAllowed = useRef(canEdit)
  editAllowed.current = canEdit
  const { leavingId, leave } = useRowLeaving()
  const [folders, setFolders] = useState<Folder[]>([])
  const [folderDialog, setFolderDialog] = useState<'new' | Folder | null>(null)
  const [deletingFolder, setDeletingFolder] = useState<Folder | null>(null)
  const [folderBusy, setFolderBusy] = useState(false)
  const [folderError, setFolderError] = useState('')
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  /* 行の詳細パネル。URL に ?field=<id> を残す。 */
  const detailGuard = useInlineDetailGuard('field')
  const { id: activeFieldId, setId: setActiveFieldId } = detailGuard
  const openFieldDetail = (id: string) => host ? (canEdit ? host.onEdit(id) : undefined) : withViewTransition(() => setActiveFieldId(current => current === id ? null : id))

  /* アカウント切替のあとに届いた古い応答で一覧を上書きしない（ATTR-01）。 */
  const gateRef = useRef(createResponseGate())
  const accountRef = useRef(accountId)
  accountRef.current = accountId

  useEffect(() => {
    gateRef.current.invalidate()
    setPendingDelete(null)
    setDeleteError(''); setDeleteNeedsReview(false)
    setDragId(null)
    setFolderFilter('')
    setPage(1)
    setError('')
    setActionError('')
    setRetryOrder(null)
    setOpenMenuId(null)
  }, [accountId])

  const load = useCallback(async () => {
    if (host) { host.reload(); return }
    const account = accountId
    const token = gateRef.current.begin()
    if (!account) {
      setItems([]); setSummary(null); setStatus('error'); setStatsStatus('error'); setError('LINE公式アカウントを選んでください')
      return
    }
    setStatus('loading'); setStatsStatus('loading'); setError('')
    const stale = () => !gateRef.current.current(token) || accountRef.current !== account
    void api.friendFields.stats(account).then((stats) => {
      if (stale()) return
      if (stats.success) { setSummary(stats.data); setStatsStatus('ready') }
      else { setSummary(null); setStatsStatus('error') }
    }, (reason) => {
      if (stale()) return
      setSummary(null)
      setStatsStatus(reason instanceof ApiError && reason.status === 403 ? 'forbidden' : 'error')
    })
    try {
      const list = await api.friendFields.list(account, { withUsage: true })
      if (stale()) return
      if (!list.success) throw new Error('load failed')
      setItems(list.data); setStatus('ready')
    } catch (reason) {
      if (stale()) return
      const forbidden = reason instanceof ApiError && reason.status === 403
      setItems([])
      setStatus(forbidden ? 'forbidden' : 'error')
      setError(forbidden ? '' : '再読み込みしても直らない場合はエラー報告へ。')
    }
  }, [accountId, host, setItems, setSummary])
  useEffect(() => { if (!host) void load() }, [load, host])
  useEffect(() => { if (host) { setItems(host.items); setStatus(host.status); setError(host.error ?? ''); setFolders(host.folders ?? []); setFolderError(host.foldersFailed ? 'フォルダを読み込めませんでした。' : '') } }, [host])

  /* フォルダは folders 表（kind=friend_field）。件数は一覧の items から数える（同じ母集団）。 */
  const loadFolders = useCallback(async () => {
    if (host) { host.reload(); return }
    if (!accountId) return
    setFolderError('')
    try {
      const res = await api.folders.list('friend_field', accountId)
      if (res.success) setFolders(res.data)
      else setFolderError('フォルダを読み込めませんでした。')
    } catch {
      setFolderError('フォルダを読み込めませんでした。')
    }
  }, [accountId, host])
  useEffect(() => { if (!host) void loadFolders() }, [loadFolders, host])

  const visible = useMemo(() => items.filter((field) => {
    if (query && !field.name.toLocaleLowerCase('ja').includes(query.toLocaleLowerCase('ja'))) return false
    if (type !== 'all' && field.type !== type) return false
    if (folderFilter === UNFILED && field.folderId) return false
    if (folderFilter && folderFilter !== UNFILED && field.folderId !== folderFilter) return false
    return true
  }), [items, query, type, folderFilter])

  const pages = Math.max(1, Math.ceil(visible.length / pageSize))
  const currentPage = Math.min(page, pages)
  const pageItems = visible.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  /* 動かしている間、置き場所を入れ替えて見せ、ほかの行は滑らかに場所を空ける（自動応答と同じ動き）。 */
  const liveOrder = useLiveReorder(pageItems, (field) => field.id, dragId)
  const bodyRef = useRef<HTMLTableSectionElement>(null)
  useFlipRows(bodyRef, liveOrder.shown.map((field) => field.id).join(','), JSON.stringify([accountId, query, type, folderFilter, page, pageSize]))
  const activeField = useHeldDetail(items.find((item) => item.id === activeFieldId) ?? null, activeFieldId, detailGuard.holding, accountId)
  const activeFieldIndex = pageItems.findIndex((item) => item.id === activeFieldId)
  useEffect(() => setPage(1), [query, type, folderFilter, pageSize])
  useEffect(() => {
    if (host && !host.foldersFailed && folderFilter && folderFilter !== UNFILED && !folders.some((folder) => folder.id === folderFilter)) setFolderFilter('')
  }, [host, folders, folderFilter])

  /* 並び替え：/api/friend-fields/reorder へ「動かせる行だけの新しい順」を1回で渡す。共通項目の位置は保つ。 */
  const applyOrder = async (next: FriendField[]) => {
    if (host) { await host.onOrder(next.map((item) => item.id)); return }
    if (!accountId) return
    const previous = items
    setItems(next)
    setActionError('')
    setRetryOrder(null)
    try {
      const res = await api.friendFields.reorder(accountId, movableIds(next, (field) => !field.isInherited))
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
    const visibleNext = order.map((id) => items.find((field) => field.id === id)).filter(Boolean) as FriendField[]
    await applyOrder(mergeVisibleOrder(items, visibleNext, (field) => field.isInherited === true))
  }

  const move = async (targetId: string) => {
    if ((!accountId && !host) || !dragId || dragId === targetId) return setDragId(null)
    const order = visible.map((field) => field.id)
    const from = order.indexOf(dragId); const to = order.indexOf(targetId)
    setDragId(null)
    if (from < 0 || to < 0) return
    order.splice(to, 0, ...order.splice(from, 1))
    await reorderTo(order)
  }

  /** つまみにフォーカスして ↑/↓（N-049）。 */
  const keyboardMove = async (id: string, direction: -1 | 1) => {
    const order = visible.map((field) => field.id)
    const from = order.indexOf(id)
    const to = from + direction
    if (from < 0 || to < 0 || to >= order.length) return
    order.splice(to, 0, ...order.splice(from, 1))
    await reorderTo(order)
  }

  const remove = async (field: FriendField) => {
    if (!accountId || accountRef.current !== accountId || !editAllowed.current || deleteNeedsReview) return
    const blockedReason = fieldDeletionBlockedReason(field)
    if (blockedReason) {
      setActionError(blockedReason); setDeleteError(blockedReason)
      return false
    }
    setActionError(''); setDeleteError('')
    try {
      const response = await api.friendFields.delete(field.id, accountId)
      if (!response.success) throw new Error(response.error || '項目を削除できませんでした。')
      if (accountRef.current !== accountId) return
      leave(field.id, () => load())
      return true
    } catch (reason) {
      if (accountRef.current !== accountId) return
      const message = describeApiFailure(reason, '削除')
      const conflict = reason instanceof ApiError && reason.status === 409
      setActionError(message)
      setDeleteNeedsReview(conflict)
      setDeleteError(conflict ? `${message} この窓を閉じ、最新の使用状況を確かめてください。` : `${message} この項目の削除を完了できませんでした。`)
      return false
    }
  }

  const moveFolderOrder = async (index: number, direction: -1 | 1) => {
    const target = folders[index]
    const neighbor = folders[index + direction]
    if (!target || !neighbor || folderBusy) return
    setFolderBusy(true)
    setFolderError('')
    try {
      const result = await api.folders.swapOrder(target.id, neighbor.id)
      if (!result.success) throw new Error(result.error)
      await loadFolders()
    } catch {
      setFolderError('並び順を変えられませんでした。')
    } finally {
      setFolderBusy(false)
    }
  }

  const removeFolder = async () => {
    if (!deletingFolder || folderBusy) return
    const targetId = deletingFolder.id
    setFolderBusy(true)
    setFolderError('')
    try {
      const res = await api.folders.delete(targetId)
      if (!res.success) throw new Error(res.error)
      setDeletingFolder(null)
      if (folderFilter === targetId) setFolderFilter('')
      await loadFolders()
      /* フォルダを消した項目は未分類に戻るので一覧も読み直す。 */
      await load()
    } catch {
      setFolderError('フォルダを削除できませんでした。時間をおいて、もう一度お試しください。')
    } finally {
      setFolderBusy(false)
    }
  }

  /* 行の「…」と右クリックは同じ中身。統括は配る、店は移行。 */
  const rowMenuItemsRaw = (field: FriendField): ActionMenuItem[] => {
    if (host) return canEdit ? [
      { id: 'edit', label: '編集', onSelect: () => host.onEdit(field.id) },
      { id: 'distribute', label: '配る', icon: <Send size={16} aria-hidden="true" />, disabled: host.busy, onSelect: () => host.onDistribute(field.id) },
      { id: 'delete', label: '削除する', tone: 'danger', dividerBefore: true, onSelect: () => host.onRemove(field.id) },
    ] : []
    if (!canEdit) return [{ id: 'open', label: '詳しく見る', onSelect: () => openFieldDetail(field.id) }]
    const list: ActionMenuItem[] = [
      { id: 'edit', label: '編集', external: false, href: `/tags/fields/edit?id=${encodeURIComponent(field.id)}`, onSelect: () => router.push(`/tags/fields/edit?id=${encodeURIComponent(field.id)}`) },
    ]
    if ((knownUsageCount(field) ?? 0) > 0) {
      list.push({ id: 'migrate', label: '移行（種類を変更する）', external: false, href: `/tags/fields/migrate?id=${encodeURIComponent(field.id)}`, onSelect: () => router.push(`/tags/fields/migrate?id=${encodeURIComponent(field.id)}`) })
    }
    if (!field.isInherited) {
      const blocked = fieldDeletionBlockedReason(field)
      list.push({
        id: 'delete',
        label: '削除する',
        tone: 'danger',
        dividerBefore: true,
        disabled: blocked !== null,
        disabledReason: blocked ?? undefined,
        onSelect: () => { setActionError(''); setDeleteError(''); setDeleteNeedsReview(false); setPendingDelete(field) },
      })
    }
    return list
  }
  const rowMenuItems = (field: FriendField): ActionMenuItem[] => rowMenuItemsRaw(field).map(item => item.onSelect ? { ...item, onSelect: () => detailGuard.protect(() => { void item.onSelect?.() }) } : item)
  const fieldContextItems = (field: FriendField): ContextMenuItem[] =>
    rowMenuItems(field).map((item) => ({
      id: item.id,
      label: item.label,
      danger: item.tone === 'danger',
      disabled: item.disabled,
      onSelect: () => item.onSelect?.(),
    }))

  /* 数の帯（4つ）。 */
  const kpiReason = statsStatus === 'loading' ? STATE_TEXT.loading
    : statsStatus === 'forbidden' ? STATE_TEXT.forbiddenView
      : statsStatus === 'error' ? STATE_TEXT.error
        : null
  const detailOf = (whenAvailable: string): string => kpiReason ?? whenAvailable
  const kpis = [
    { title: '項目', help: '項目へ保存された値が1つ以上ある項目数です。メッセージへの差し込みで使っている数は含みません。', icon: List, value: summary?.total ?? null, unit: '件', detail: detailOf(typeof summary?.inUse === 'number' ? `値の登録あり ${summary.inUse} 件` : '値の登録がある項目数は未集計') },
    { title: '入力済みの友だち', icon: Users, value: summary?.registeredFriends ?? null, unit: '人', detail: detailOf('1つ以上入っている') },
    // 口そのものが無いときは、読込・失敗とは別の言葉にする（管理画面 と同じ）。
    { title: '回答フォームで集める', icon: ClipboardList, value: summary?.formLinks ?? null, unit: '件', detail: kpiReason ?? (summary?.formLinks === null ? notConnectedText('回答フォームの登録先') : '回答で自動で入る') },
    { title: '今月の変更', icon: Pencil, value: summary?.updatedThisMonth ?? null, unit: '件', detail: detailOf('追加・名前の変更') },
  ]

  const folderRows: FolderPanelRow[] = [
    { kind: 'all' as const, id: '', label: 'すべて', count: status === 'ready' ? items.length : null },
    ...folders.map((f, index) => ({
      kind: 'folder' as const,
      id: f.id,
      label: f.name,
      count: status === 'ready' ? items.filter((field) => field.folderId === f.id).length : null,
      color: f.color,
      onEdit: canEdit ? () => detailGuard.protect(() => { if (host) host.onEditFolder?.(f.id); else setFolderDialog(f) }) : undefined,
      onMoveUp: !host && canEdit && index > 0 ? () => detailGuard.protect(() => { void moveFolderOrder(index, -1) }) : undefined,
      onMoveDown: !host && canEdit && index < folders.length - 1 ? () => detailGuard.protect(() => { void moveFolderOrder(index, 1) }) : undefined,
      onDelete: canEdit ? () => detailGuard.protect(() => { if (host) host.onRemoveFolder?.(f.id); else setDeletingFolder(f) }) : undefined,
      deleteNote: '削除しても、中の項目は未分類に残ります。',
    })),
    { kind: 'unfiled' as const, id: UNFILED, label: '未分類', count: status === 'ready' ? items.filter((field) => !field.folderId).length : null },
  ]
  const folderDotOf = (folderId: string | null | undefined) => {
    const folder = folderId ? folders.find((f) => f.id === folderId) : undefined
    return folder ? { name: folder.name, color: folder.color } : null
  }

  const filterActive = Boolean(query || type !== 'all' || folderFilter)

  const createButton = (wide: boolean) => status === 'forbidden' ? null : (
    <PermissionGatedButton allowed={canEdit} need={host ? 'tenantWide' : 'feature'} {...(host ? { onClick: host.onCreate, disabled: host.busy } : { href: '/tags/fields/new' })} variant="primary" className={wide ? styles.createWide : undefined}><Plus size={16} aria-hidden="true" />項目を作る</PermissionGatedButton>
  )

  return { accountId, canEdit, narrow, host, explanation, items, loaded, status, error, actionError, setActionError, retryOrder, setRetryOrder, query, setQuery, type, setType, folderFilter, setFolderFilter, pageSize, setPageSize, page, setPage, dragId, setDragId, pendingDelete, setPendingDelete, deleteError, deleteNeedsReview, leavingId, folders, folderDialog, setFolderDialog, deletingFolder, setDeletingFolder, folderBusy, folderError, openMenuId, setOpenMenuId, setActiveFieldId, openFieldDetail, load, loadFolders, visible, pages, currentPage, pageItems, liveOrder, bodyRef, activeField, activeFieldIndex, applyOrder, move, keyboardMove, remove, removeFolder, rowMenuItems, fieldContextItems, kpis, folderRows, folderDotOf, filterActive, createButton, detailGuard }
}
