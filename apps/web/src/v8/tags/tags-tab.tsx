'use client'
import { knownValue } from '@/lib/known-value'

import PermissionGatedButton from '@/components/shared/permission-gated-button'
import { DetailContent, DetailFields } from '@/components/shared/detail-content'
import { RefreshCover } from '@/components/shared/refresh-cover'
import { useListSnapshot } from '@/lib/use-list-snapshot'

import { useActionError } from '@/lib/use-action-error'

import { FolderDotName, folderDisplayColor } from '@/components/shared/folder-dot';
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { OverlayDepthContext } from '@/components/shared/overlay-utils'
import { InlineDetailHoldingContext } from '@/components/shared/use-inline-detail-guard'
import { useListScrollMemory, useListUrlState, useOnAccountSwitch } from '@/components/shared/list-url-state';
import { Bookmark, Check, CircleDashed, FolderOpen, GripVertical, Inbox, Plus, Sparkles, Tag as TagIcon, Users } from 'lucide-react';
import Link from '@/components/shared/list-navigation'
import { RowNameLink } from '@/components/shared/table';
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation';

import type { Tag, TagGroup } from '@line-crm/shared';
import { api, ApiError, type ListStats } from '@/lib/api';
import { useRowLeaving } from '@/lib/use-row-leaving';
import { RovingTbody } from '@/components/shared/row-roving';
import { ListPageBody } from '@/components/templates';
import { TAG_FOLDER_COLORS, DEFAULT_TAG_FOLDER_COLOR } from './folder-colors';
import FolderEditorDialog from '@/components/shared/folder-editor-dialog'
import { FolderManagementDialog } from '@/components/shared/managed-folder-panel'
import FolderPanel, { FolderPanelNote, type FolderPanelRow } from '@/components/shared/folder-panel';
import ActionMenu, { type ActionMenuItem } from '@/components/shared/action-menu';
import StatusBadge from '@/components/shared/status-badge'
import FilterChip from '@/components/shared/filter-chip'
import { RowMenu } from '@/components/shared/row-actions';
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Dialog from '@/components/shared/dialog'
import DetailPanel, { useDetailPanelUrl } from '@/components/shared/detail-panel';
import ContextMenu, { type ContextMenuItem } from '@/components/shared/context-menu';
import { withViewTransition } from '@/components/shared/view-transition';
import { notifyToast } from '@/components/shared/toast';
import { japaneseDetailOf, describeApiFailure } from '@/components/shared/api-error-message';
import Button from '@/components/shared/button'
import EmptyList from '@/components/shared/empty-list'
import Select from '@/components/shared/select'
import Pagination from '@/components/shared/pagination'
import SearchField from '@/components/shared/search-field'
import KpiCard from '@/components/shared/kpi-card'
import KpiBand from '@/components/shared/kpi-band'
import { DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table';
import TagPill from '@/components/shared/tag-pill'
import PageSizeSelect from '@/components/shared/page-size-select';
import ReorderHandle from '@/components/shared/reorder-handle'
import { useLiveReorder } from '@/lib/use-live-reorder';
import { mergeVisibleOrder } from '@/components/friend-fields/reorder-utils';
import TagCsvImportDialog from '@/components/friend-fields/tag-csv-import-dialog'
import { isCurrentTagListRequest, type TagListRequestKey } from '@/components/friend-fields/tag-list-state';
import { DeleteTagDialog, QUICK_FILTERS, UNGROUPED, cleanupKnown, formatDate, hasLinkedActions, isThisMonth, isUnused, usageLabel } from '@/components/friend-fields/tags-page-v4';
import styles from './list.module.css'
import { ListToolbarFrame, ListToolbarRow, ListToolbarSearchSlot } from '@/components/shared/list-toolbar';
import { ListPager } from '@/components/templates/list-page';
import { emptyValue } from '@/components/shared/empty-value';
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors';
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'

/*
 * ★V8 タグ「タグ」タブ（Pencil ・1152 ・閲覧のみ 、
 * フォルダ窓 、状態の板 ）。
 *
 * 動き（読み込み・数の帯・絞り込み・並べ替え・フォルダへ移す・フォルダの
 * 追加/直す/並べ替え/削除・保管・CSV・行の詳細パネル・右クリック）は
 * 現役の V8 タブ（src/v8/tags/tags-tab.tsx）から写した。数え方・判定は共通の同じ関数
 * （components/friend-fields/tags-page-v4）を使う。見た目だけを型と絵に合わせた。
 */

/** 付け方の呼び名（「EC 連携・LINE ログイン・EC 購入・誕生日のきまり」）。 */
const SOURCE_LABELS: Record<NonNullable<Tag['assignSource']>, string> = {
  ec: 'EC 連携',
  line_login: 'LINE ログイン',
  form: '回答フォーム',
  ec_purchase: 'EC 購入',
  manual: '手動',
  birthday: '誕生日のきまり',
}
export const sourceLabel = (tag: Tag): string => (tag.assignSource ? knownValue(SOURCE_LABELS, tag.assignSource, '付け方を確認できません') : emptyValue('unknown'))

type LoadStatus = 'loading' | 'ready' | 'error' | 'forbidden'

import { EXTENDED_PAGE_SIZES as PAGE_SIZES } from '@/components/shared/page-size-options'

/** 連動の文（絵の「本人+10・1.2倍 他1」）。マイル以外の連動は「他N」。0件は「—」。 */
/**
 * 窓なしの保管で、5秒たって送る直前に呼ぶ。影響を読み直し、その間に友だちに付いた・
 * どこかで使われ始めたなら保管せずに失敗を返す（呼び出し側が行を戻して知らせる）。
 * 保管そのものが断られたときも失敗を返す。
 */
export async function archiveIfStillUnused(
  tagId: string,
  accountId: string,
  tagsApi: Pick<typeof api.tags, 'dependencies' | 'archive'> = api.tags,
): Promise<{ success: boolean; error?: string }> {
  const res = await tagsApi.dependencies(tagId, accountId)
  if (!res.success) return { success: false, error: res.error }
  const impact = res.data
  const inUse = impact.friendCount > 0 || impact.references.length > 0 || impact.linkedActions.length > 0
    || impact.pendingRunCount > 0 || impact.blockingReferenceCount > 0 || !impact.canArchive
  if (inUse) return { success: false, error: 'in_use' }
  const archived = await tagsApi.archive(tagId, accountId, { expectedVersion: impact.tag.version, impactRevision: impact.revision }, crypto.randomUUID())
  if (!archived.success) return { success: false, error: archived.error }
  return { success: true }
}

export function tagLinkText(tag: Tag): string {
  const main: string[] = []
  if (tag.mileageReward) main.push(`本人+${tag.mileageReward}`)
  if (tag.referralMileageReward) main.push(`紹介+${tag.referralMileageReward}`)
  if (tag.mileageMultiplierBps) main.push(`${tag.mileageMultiplierBps / 10000}倍`)
  const parts = main.length ? [main.join('・')] : []
  if (tag.otherActionCount) parts.push(`他${tag.otherActionCount}`)
  return parts.length ? parts.join(' ') : emptyValue('unknown')
}

/**
 * タグのフォルダ追加・編集（Pencil ）。タグの分類は `tag_groups` 表なので
 * 共通の FolderAddDialog（folders 表）ではなく、この画面の形を持つ。右のパネルで出す。
 */
function TagFolderDialog({
  group,
  accountId,
  onClose,
  onSaved,
}: {
  group?: TagGroup
  accountId: string | null
  onClose: () => void
  onSaved: () => void
}) {
  const saveErrors = useSaveFormErrors()

  const [name, setName] = useState(group?.name ?? '')
  const [color, setColor] = useState<string | null>(group ? folderDisplayColor(group) : DEFAULT_TAG_FOLDER_COLOR)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const dirty = name !== (group?.name ?? '') || color !== (group ? folderDisplayColor(group) : DEFAULT_TAG_FOLDER_COLOR)
  const guard = useUnsavedGuard({ dirty: dirty || saving, busy: saving, onDiscard: onClose })
  const depth = useContext(OverlayDepthContext)
  const onHoldingChange = useContext(InlineDetailHoldingContext)
  const source = useRef(Symbol('tag-folder'))
  useLayoutEffect(() => { onHoldingChange?.(source.current, dirty || saving) }, [dirty, saving, onHoldingChange])
  useLayoutEffect(() => () => { onHoldingChange?.(source.current, false) }, [onHoldingChange])

  const save = async () => {
    const trimmed = name.trim()
    if (!trimmed || saving) return
    setSaving(true)
    setError('')
    try {
      const res = group
        ? await api.tagGroups.update(group.id, { name: trimmed, color, accountId: group.accountId })
        : await api.tagGroups.create({ name: trimmed, color, accountId })
      if (!res.success) {
        setError(res.error)
        return
      }
      guard.disarm()
      onSaved()
      onClose()
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)


      setError(group ? 'フォルダを直せませんでした' : 'フォルダを追加できませんでした。時間をおいて、もう一度お試しください。') }
    } finally {
      setSaving(false)
    }
  }

  return (
    <SaveErrorScope errors={saveErrors}><FolderEditorDialog open
      title={group ? 'フォルダを直す' : 'フォルダを追加'}
      description="タグを分けてしまう箱です。消しても、入っていたタグは未分類として残ります。"
      name={name} onNameChange={setName} color={color} onColorChange={setColor}
      colors={TAG_FOLDER_COLORS}
      placeholder="例：VIP" busy={saving} error={error || undefined}
      onCancel={onClose} onConfirm={() => void save()} confirmLabel={group ? '保存する' : 'フォルダを作る'}
    /><OverlayDepthContext.Provider value={depth + 2}><UnsavedLeaveDialog open={guard.leaveTarget !== null} busy={saving} onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} /></OverlayDepthContext.Provider></SaveErrorScope>
  )
}

export default function TagsTab({
  accountId,
  fixture,
  canEdit,
  narrow,
  csvOpen,
  onCsvClose,
}: {
  accountId: string | null
  fixture?: { items: Tag[]; groups: TagGroup[] }
  canEdit: boolean
  narrow: boolean
  csvOpen: boolean
  onCsvClose: () => void
}) {
  const saveErrors = useSaveFormErrors()
  const router = useRouter()
  const { value: items, setValue: setItems, hasValue: loaded } = useListSnapshot<Tag[]>(accountId ?? '', fixture?.items ?? [])
  const { value: groups, setValue: setGroups } = useListSnapshot<TagGroup[]>(accountId ?? '', fixture?.groups ?? [])
  const [status, setStatus] = useState<LoadStatus>(fixture ? 'ready' : 'loading')
  // 操作の失敗（並び替え・フォルダ移動）。読み込みの失敗とは別物。
  const { error: actionError, setError: setActionError } = useActionError(accountId ?? '')
  const [stats, setStats] = useState<ListStats | null>(null)
  const [statsFailed, setStatsFailed] = useState(false)
  /*
   * 検索語・フォルダ・絞り込み・件数・ページは URL に置く（動きの点検 5 番）。
   * タグを開いて「戻る」と同じ一覧に戻る。絞り込みを変えたらページは 1 へ
   * （同じ書き込みの中で戻す。効果で戻すと、来た瞬間に URL から戻したページまで消える）。
   */
  const [view, setView] = useListUrlState({ q: '', folder: '', usage: 'all', source: 'all', quick: '', archived: '', size: '20', page: '1' })
  const onlyArchived = view.archived === '1'
  const query = view.q
  const folder = view.folder
  const usageFilter = view.usage
  const sourceFilter = view.source
  const quick = useMemo(() => (view.quick ? view.quick.split(',').filter((key) => key !== 'starred') : []), [view.quick])
  const pageSize = PAGE_SIZES.includes(Number(view.size)) ? Number(view.size) : 20
  const page = Math.max(1, Number.parseInt(view.page, 10) || 1)
  const setQuery = useCallback((next: string) => setView({ q: next, page: '1' }), [setView])
  const setFolder = useCallback((next: string) => setView({ folder: next, page: '1' }), [setView])
  const setUsageFilter = useCallback((next: string) => setView({ usage: next, page: '1' }), [setView])
  const setSourceFilter = useCallback((next: string) => setView({ source: next, page: '1' }), [setView])
  const setQuick = useCallback((update: string[] | ((current: string[]) => string[])) => {
    const next = typeof update === 'function' ? update(quick) : update
    setView({ quick: next.join(','), page: '1' })
  }, [quick, setView])
  const setPageSize = useCallback((next: number) => setView({ size: String(next), page: '1' }), [setView])
  const setPage = useCallback((next: number) => setView({ page: String(next) }), [setView])
  const [quickOpen, setQuickOpen] = useState(false)
  const [dragId, setDragId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Tag | null>(null)
  const [restoreTarget, setRestoreTarget] = useState<Tag | null>(null)
  const restoreAccountVersion = useRef({ accountId, generation: 0 })
  if (restoreAccountVersion.current.accountId !== accountId) restoreAccountVersion.current = { accountId, generation: restoreAccountVersion.current.generation + 1 }
  const restoreScopeRef = useRef<{ accountId: string | null; generation: number } | null>(null)
  const restoreScope = restoreScopeRef.current
  const [restoring, setRestoring] = useState(false)
  const [restoreError, setRestoreError] = useState('')
  const { leavingId, leave } = useRowLeaving()
  const [manageFoldersOpen, setManageFoldersOpen] = useState(false)
  const [folderDialog, setFolderDialog] = useState<'new' | TagGroup | null>(null)
  const [deletingGroup, setDeletingGroup] = useState<TagGroup | null>(null)
  const deleteTicket = useRef<object | null>(null)
  const renderedDeleteTicket = deleteTicket.current
  const deleteLock = useRef(false)
  const currentAccount = useRef(accountId)
  currentAccount.current = accountId
  useEffect(() => { deleteTicket.current = null; setDeletingGroup(null); setManageFoldersOpen(false) }, [accountId])
  const [folderBusy, setFolderBusy] = useState(false)
  const [folderError, setFolderError] = useState('')
  /* 行の「…」メニュー。「フォルダへ移す」はメニューの2段目。 */
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const [menuMoveFor, setMenuMoveFor] = useState<string | null>(null)
  /* 行の詳細パネル。URL に ?tag=<id> を残す。 */
  const [activeTagId, setActiveTagId] = useDetailPanelUrl('tag')
  const openTagDetail = (id: string) => withViewTransition(() => setActiveTagId(activeTagId === id ? null : id))
  const loadRequestRef = useRef<TagListRequestKey>({ accountId, generation: 0 })

  const load = useCallback(async () => {
    if (fixture) return
    const request = { accountId, generation: loadRequestRef.current.generation + 1 }
    loadRequestRef.current = request
    setStatus('loading')
    try {
      const [tags, folders] = await Promise.all([
        api.tags.list({ withCounts: true, accountId }),
        api.tagGroups.list(accountId),
      ])
      if (!isCurrentTagListRequest(loadRequestRef.current, request)) return
      // `success: false` を黙って捨てない。捨てると空の表を「0件」として見せる。
      if (!tags.success) throw new Error(tags.error)
      if (!Array.isArray(tags.data)) throw new Error('タグの応答を確認できません')
      setItems(tags.data)
      if (folders.success && Array.isArray(folders.data)) {
        setGroups(folders.data)
        setFolderError('')
      } else {
        setGroups([])
        setFolderError('フォルダを読み込めませんでした。')
      }
      setStatus('ready')
    } catch (reason) {
      if (!isCurrentTagListRequest(loadRequestRef.current, request)) return
      saveErrors.capture(reason);

      setStatus(reason instanceof ApiError && reason.status === 403 ? 'forbidden' : 'error')
    }
  }, [fixture, accountId, saveErrors, setItems, setGroups])
  useEffect(() => { void load() }, [load])

  /* 数の帯のサーバー側の数。一覧とは別の要求なので、失敗しても一覧は止めない（「—」）。 */
  useEffect(() => {
    if (fixture || !accountId) return
    let cancelled = false
    setStats(null)
    setStatsFailed(false)
    void api.listStats.get(accountId).then((res) => {
      if (cancelled) return
      if (res.success) setStats(res.data)
      else setStatsFailed(true)
    }, () => {
      if (!cancelled) setStatsFailed(true)
    })
    return () => { cancelled = true }
  }, [fixture, accountId])

  /* アカウントを切り替えたら、前のアカウントのフォルダ選択と件数を残さない。 */
  useEffect(() => {
    if (fixture) return
    setGroups([])
    setOpenMenuId(null)
    setMenuMoveFor(null)
  }, [fixture, accountId])

  // アカウントを替えたら、前のアカウントのフォルダとページを残さない（来た瞬間は URL のまま）。
  useOnAccountSwitch(accountId, () => setView({ folder: '', page: '1' }))
  useListScrollMemory(status === 'ready')

  const filtered = useMemo(() => items.filter((tag) => {
    if ((tag.status === 'archived') !== onlyArchived) return false
    if (query && !tag.name.toLowerCase().includes(query.toLowerCase())) return false
    if (folder === UNGROUPED && tag.groupId) return false
    if (folder && folder !== UNGROUPED && tag.groupId !== folder) return false
    const linked = hasLinkedActions(tag)
    const unused = isUnused(tag)
    if (usageFilter === 'linked' && !linked) return false
    if (usageFilter === 'unused' && !unused) return false
    if (sourceFilter !== 'all' && tag.assignSource !== sourceFilter) return false
    for (const key of quick) {
      if (key === 'unused' && !unused) return false
      if (key === 'recent' && !isThisMonth(tag.createdAt)) return false
      if (key === 'auto' && (!tag.assignSource || tag.assignSource === 'manual')) return false
      if (key === 'linked' && !linked) return false
    }
    return true
  }), [items, query, folder, usageFilter, sourceFilter, quick, onlyArchived])
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const currentPage = Math.min(page, pages)
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  /* 動かしている間、置き場所を入れ替えて見せ、ほかの行は滑らかに場所を空ける（自動応答と同じ動き）。 */
  const liveOrder = useLiveReorder(visible, (tag) => tag.id, dragId)
  const activeTag = items.find((tag) => tag.id === activeTagId) ?? null
  const activeTagIndex = visible.findIndex((tag) => tag.id === activeTagId)
  const activeGroup = activeTag ? groups.find((item) => item.id === activeTag.groupId) : undefined

  /** アカウント切替直後の1フレームは「未取得」として扱う（管理画面 と同じ）。 */
  const staleAccount = !fixture && loadRequestRef.current.accountId !== accountId
  const ready = (status === 'ready' || (status === 'loading' && loaded)) && !staleAccount

  /* 整理候補の数。未取得は null（「—」）、取得できて0件は 0。 */
  const cleanupCount = cleanupKnown(items, ready)
    ? items.filter((tag) => (tag.cleanupReasons?.length ?? 0) > 0).length
    : null
  const unusedCount = cleanupKnown(items, ready)
    ? items.filter((tag) => tag.cleanupReasons?.includes('unused')).length
    : null

  /* 並び替え。絞り込み中は見えている行だけを入れ替え、隠れた行の位置を保つ。失敗は元に戻す。 */
  const applyTagOrder = async (order: string[]) => {
    const previous = items
    /* 返事が失敗でも、通信が例外で落ちても、元の順へ戻して「もう一度」を出す。 */
    let message: string | null = null
    try {
      const result = await api.tags.reorder(order)
      if (!result.success) message = `並び順を保存できませんでした（${result.error}）`
    } catch (caught) {
      saveErrors.capture(caught);

      const detail = japaneseDetailOf(caught)
      message = `並び順を保存できませんでした。${detail ? `${detail}。` : ''} 通信を確かめて、もう一度お試しください。`
    }
    if (message !== null) {
      setItems(previous)
      setActionError(message)
      notifyToast(message, {
        tone: 'error',
        actionLabel: 'もう一度',
        onAction: () => { void applyTagOrder(order) },
      })
    } else {
      setItems((current) => mergeVisibleOrder(current, order.map((id) => current.find((tag) => tag.id === id)).filter((tag): tag is Tag => Boolean(tag))))
      setActionError('')
    }
  }

  const move = async (targetId: string) => {
    if (!dragId || dragId === targetId) return setDragId(null)
    const order = filtered.map((tag) => tag.id)
    const from = order.indexOf(dragId); const to = order.indexOf(targetId)
    setDragId(null)
    if (from < 0 || to < 0) return
    order.splice(to, 0, ...order.splice(from, 1))
    const visibleNext = order.map((id) => items.find((tag) => tag.id === id)).filter(Boolean) as Tag[]
    setItems(mergeVisibleOrder(items, visibleNext))
    await applyTagOrder(order)
  }

  /** つまみにフォーカスして ↑/↓。 */
  const keyboardMove = async (id: string, direction: -1 | 1) => {
    const order = filtered.map((tag) => tag.id)
    const from = order.indexOf(id)
    const to = from + direction
    if (from < 0 || to < 0 || to >= order.length) return
    order.splice(to, 0, ...order.splice(from, 1))
    const visibleNext = order.map((tid) => items.find((tag) => tag.id === tid)).filter(Boolean) as Tag[]
    setItems(mergeVisibleOrder(items, visibleNext))
    await applyTagOrder(order)
  }

  /* 「フォルダへ移す」。押した瞬間に移して裏で保存。 */
  const moveTagToGroup = async (tag: Tag, groupId: string | null) => {
    setOpenMenuId(null)
    setMenuMoveFor(null)
    setActionError('')
    const previous = tag.groupId ?? null
    if (previous === groupId) return
    setItems((current) => current.map((item) => item.id === tag.id ? { ...item, groupId } : item))
    try {
      const res = await api.tags.setGroup(tag.id, groupId)
      if (!res.success) throw new Error(res.error)
      const groupName = groupId === null ? '未分類' : groups.find((group) => group.id === groupId)?.name ?? 'フォルダ'
      notifyToast(`「${tag.name}」を${groupName}へ移しました`)
    } catch (reason) {
      const fieldFailure = saveErrors.capture(reason)
      setItems((current) => current.map((item) => item.id === tag.id ? { ...item, groupId: previous } : item));

      const message = describeApiFailure(reason, 'フォルダへの移動')
      { if (!fieldFailure)
      setActionError(message) }
      notifyToast(message, {
        tone: 'error',
        actionLabel: 'もう一度',
        onAction: () => { void moveTagToGroup(tag, groupId) },
      })
      void load()
    }
  }

  /* フォルダの並び順。押した瞬間に並び替え、裏で保存。失敗は戻して「もう一度」。 */
  const moveGroupOrder = async (group: TagGroup, direction: -1 | 1) => {
    const index = groups.findIndex((item) => item.id === group.id)
    const other = groups[index + direction]
    if (!other || folderBusy) return
    const previous = groups
    const next = [...groups]
    next[index] = other
    next[index + direction] = group
    setGroups(next)
    setFolderBusy(true)
    setFolderError('')
    try {
      const [currentResult, otherResult] = await Promise.all([
        api.tagGroups.update(group.id, { sortOrder: index + direction, accountId: group.accountId }),
        api.tagGroups.update(other.id, { sortOrder: index, accountId: other.accountId }),
      ])
      if (!currentResult.success) throw new Error(currentResult.error)
      if (!otherResult.success) throw new Error(otherResult.error)
      void load()
    } catch (reason) {
      const fieldFailure = saveErrors.capture(reason)
      setGroups(previous);

      const message = describeApiFailure(reason, '保存')
      { if (!fieldFailure)
      setFolderError(message) }
      notifyToast(message, {
        tone: 'error',
        actionLabel: 'もう一度',
        onAction: () => { void moveGroupOrder(group, direction) },
      })
    } finally {
      setFolderBusy(false)
    }
  }

  const removeGroup = async () => {
    if (!deletingGroup || folderBusy || !renderedDeleteTicket || renderedDeleteTicket !== deleteTicket.current || deleteLock.current || accountId !== currentAccount.current) return
    const group = deletingGroup
    deleteLock.current = true
    setFolderBusy(true)
    setFolderError('')
    try {
      const result = await api.tagGroups.delete(group.id, group.accountId)
      if (!result.success) throw new Error(result.error)
      if (renderedDeleteTicket !== deleteTicket.current || accountId !== currentAccount.current) return
      deleteTicket.current = null
      if (folder === group.id) setFolder('')
      setDeletingGroup(null)
      void load()
    } catch (reason) {
      if (renderedDeleteTicket !== deleteTicket.current || accountId !== currentAccount.current) return
      const fieldFailure = saveErrors.capture(reason)

      { if (!fieldFailure)
      setFolderError(describeApiFailure(reason, '削除')) }
    } finally {
      deleteLock.current = false
      setFolderBusy(false)
    }
  }

  /** 行の「…」。編集・複製・フォルダへ移す・保管する。 */
  const rowMenuItems = (tag: Tag): ActionMenuItem[] => {
    // 閲覧のみには押せない項目を置かない（2026-10-06 オーナー決定）。この「…」は変える項目だけなので空になる。
    if (!canEdit) return []
    if (menuMoveFor === tag.id) {
      return [
        { id: 'move-back', label: '← 操作にもどる', onSelect: () => setMenuMoveFor(null) },
        { id: 'move-ungrouped', label: '未分類', onSelect: () => void moveTagToGroup(tag, null) },
        ...groups.map((group) => ({
          id: `move-${group.id}`,
          label: group.name,
          onSelect: () => void moveTagToGroup(tag, group.id),
        })),
      ]
    }
    const list: ActionMenuItem[] = [
      { id: 'edit', label: '編集', external: false, href: `/tags/edit?id=${tag.id}`, onSelect: () => router.push(`/tags/edit?id=${tag.id}`) },
      { id: 'copy', label: '複製して作る', external: false, href: `/tags/new?copy=${tag.id}`, onSelect: () => router.push(`/tags/new?copy=${tag.id}`) },
      { id: 'move', label: 'フォルダへ移す', onSelect: () => setMenuMoveFor(tag.id) },
    ]
    if (tag.status === 'archived') return [list[0], { id: 'restore', label: '保管から戻す', disabled: restoring, onSelect: () => { restoreScopeRef.current = { accountId, generation: restoreAccountVersion.current.generation }; setRestoreError(''); setRestoreTarget(tag) } }]
    list.push({
        id: 'archive',
        label: '保管する',
        tone: 'danger',
        dividerBefore: true,
        onSelect: () => requestArchive(tag),
    })
    return list
  }

  const confirmRestore = async () => {
    if (!restoreTarget || !restoreScope?.accountId || restoreScopeRef.current !== restoreScope || restoreScope.generation !== restoreAccountVersion.current.generation || restoring) return
    const tag = restoreTarget
    const account = restoreScope.accountId
    setRestoring(true)
    setRestoreError('')
    try {
      const res = await api.tags.restore(tag.id, account, tag.version ?? 1)
      if (loadRequestRef.current.accountId !== account) return
      if (!res.success) throw new Error(res.error)
      setItems((current) => current.map((item) => item.id === tag.id ? { ...item, status: 'active', version: res.data.version } : item))
      restoreScopeRef.current = null
      setRestoreTarget(null)
      notifyToast(`「${tag.name}」を保管から戻しました`)
      await load()
    } catch (error) {
      if (loadRequestRef.current.accountId === account) setRestoreError(describeApiFailure(error, '保管から戻す操作', { forbidden: 'この操作はオーナーか管理者に頼んでください。' }))
    } finally { setRestoring(false) }
  }
  useEffect(() => { restoreScopeRef.current = null; setRestoreTarget(null); setRestoreError('') }, [accountId])

  /* 削除は、利用状況にかかわらず確認してから実行する。 */
  const requestArchive = (tag: Tag) => { setDeleteTarget(tag) }

  /* 右クリックのメニュー。行の「…」と同じ操作。移し先はそのまま並べる。 */
  const tagContextItems = (tag: Tag): ContextMenuItem[] => {
    const list: ContextMenuItem[] = []
    for (const item of rowMenuItems(tag)) {
      if (item.id === 'move-back') continue
      if (item.id === 'move') {
        list.push({ id: 'move-ungrouped', label: '未分類へ移す', onSelect: () => void moveTagToGroup(tag, null) })
        for (const group of groups) {
          list.push({ id: `move-${group.id}`, label: `「${group.name}」へ移す`, onSelect: () => void moveTagToGroup(tag, group.id) })
        }
        continue
      }
      list.push({ id: item.id, label: item.label, danger: item.tone === 'danger', disabled: item.disabled, onSelect: () => item.onSelect?.() })
    }
    return list
  }

  const folderItems = items.filter(tag => (tag.status === 'archived') === onlyArchived)

  /* フォルダの列。数は一覧と同じ保管状態を数える。 */
  const folderRows: FolderPanelRow[] = [
    { kind: 'all' as const, id: '', label: 'すべて', count: ready ? folderItems.length : null, color: 'var(--color-accent)', icon: <Inbox size={16} aria-hidden="true" /> },
    ...groups.map((group, index) => ({
      kind: 'folder' as const,
      id: group.id,
      label: group.name,
      count: ready ? folderItems.filter((tag) => tag.groupId === group.id).length : null,
      color: group.color,
      onEdit: canEdit ? () => { setManageFoldersOpen(false); setFolderDialog(group) } : undefined,
      onMoveUp: canEdit && index > 0 ? () => void moveGroupOrder(group, -1) : undefined,
      onMoveDown: canEdit && index < groups.length - 1 ? () => void moveGroupOrder(group, 1) : undefined,
      onDelete: canEdit ? () => { deleteTicket.current = {}; setManageFoldersOpen(false); setDeletingGroup(group) } : undefined,
      deleteNote: '削除しても、中のタグは未分類に残ります。',
    })),
    { kind: 'unfiled' as const, id: UNGROUPED, label: '未分類', count: ready ? folderItems.filter((tag) => !tag.groupId).length : null, color: 'var(--color-ink-disabled)', icon: <FolderOpen size={16} aria-hidden="true" /> },
  ]

  const folderSelectOptions = [
    { value: '', label: 'フォルダ：すべて' },
    ...groups.map((group) => ({ value: group.id, label: `フォルダ：${group.name}` })),
    { value: UNGROUPED, label: 'フォルダ：未分類' },
  ]

  const kpis = [
    { title: '未使用', icon: CircleDashed, value: unusedCount, unit: '件', detail: '友だち0人・どこにも使っていない' },
    { title: '付けている友だち', icon: Users, value: statsFailed ? null : stats?.tags.taggedFriends ?? null, unit: '人', detail: '1つ以上付いている' },
    { title: '今月付けた回数', icon: TagIcon, value: statsFailed ? null : stats?.tags.assignedThisMonth ?? null, unit: '回', detail: '手動・自動' },
    { title: '整理の候補', icon: Sparkles, value: cleanupCount, unit: '件', detail: '未使用・名前が重なっている' },
  ]

  const filterActive = Boolean(query || folder || usageFilter !== 'all' || sourceFilter !== 'all' || quick.length || onlyArchived)
  const clearFilters = () => { setView({ q: '', folder: '', usage: 'all', source: 'all', quick: '', archived: '', page: '1' }) }

  const createButton = (wide: boolean) => status === 'forbidden' ? null : (
    <PermissionGatedButton allowed={canEdit} href="/tags/new" variant="primary" className={wide ? styles.createWide : undefined}><Plus size={16} aria-hidden="true" />タグを作る</PermissionGatedButton>
  )

  const search = (
    <ListToolbarSearchSlot>
      <SearchField
        aria-label="タグ名・用途で探す"
        placeholder="タグ名・用途で探す"
        value={query}
        onChange={setQuery}
        onClear={() => setQuery('')}
      />
    </ListToolbarSearchSlot>
  )
  const archiveChip = <FilterChip selected={onlyArchived} onChange={(next) => setView({ archived: next ? '1' : '', page: '1' })}>保管</FilterChip>
  const usageSelect = (
    <SaveErrorField names={["usageFilter","usage_filter"]}><Select
      aria-label="使用状態で絞り込む"
      size="content"
      value={usageFilter}
      onChange={setUsageFilter}
      options={[
        { value: 'all', label: '使用状態：すべて' },
        { value: 'linked', label: '使用状態：連動あり' },
        { value: 'unused', label: '使用状態：未使用' },
      ]}
    /></SaveErrorField>
  )
  const sourceSelect = (
    <SaveErrorField names={["sourceFilter","source_filter"]}><Select
      aria-label="付け方で絞り込む"
      size="content"
      value={sourceFilter}
      onChange={setSourceFilter}
      options={[
        { value: 'all', label: '付け方：すべて' },
        ...Object.entries(SOURCE_LABELS).map(([value, label]) => ({ value, label: `付け方：${label}` })),
      ]}
    /></SaveErrorField>
  )
  /* 「よく使う絞り込み」：重ねて絞れる4つ（星以外の QUICK_FILTERS）。開いたメニューで入れ切り。 */
  const quickItems: ActionMenuItem[] = [
    ...QUICK_FILTERS.filter(([value]) => value !== 'starred').map(([value, label]) => ({
      id: `quick-${value}`,
      label,
      icon: quick.includes(value) ? <Check size={16} aria-hidden="true" /> : <span className={styles.checkSpace} aria-hidden="true" />,
      onSelect: () => setQuick((current) => current.includes(value) ? current.filter((key) => key !== value) : [...current, value]),
    })),
    ...(quick.length ? [{ id: 'quick-clear', label: 'すべて外す', dividerBefore: true, onSelect: () => setQuick([]) }] : []),
  ]
  const quickButton = (
    <span className={styles.menuAnchor}>
      <Button
        type="button"
        variant="secondary"
        aria-haspopup="menu"
        aria-expanded={quickOpen}
        aria-label={quick.length ? `よく使う絞り込み（${quick.length} 件選択中）` : 'よく使う絞り込み'}
        title="よく使う絞り込み"
        data-active={quick.length > 0 || undefined}
        className={styles.quickButton}
        onClick={() => setQuickOpen((open) => !open)}
      >
        <Bookmark size={16} aria-hidden="true" />
        {narrow ? null : <span>よく使う絞り込み</span>}
      </Button>
      <ActionMenu open={quickOpen} onClose={() => setQuickOpen(false)} ariaLabel="よく使う絞り込み" items={quickItems} />
    </span>
  )
  const pageSizeSelect = (
    <PageSizeSelect value={pageSize} onChange={(value) => setPageSize(value || 20)} options={PAGE_SIZES} label={null} />
  )

  const folderNote = (
    <>
      {canEdit ? null : <span className={styles.viewerFolderAddSpace} aria-hidden="true" />}
      <FolderPanelNote>フォルダを消しても、中のタグは未分類に残ります</FolderPanelNote>
      {folderError ? (
        <Notice tone="danger" className={styles.folderNoteNoticePlacement} >{folderError}
          <Button variant="text" size="inline" data-notice-inline-action type="button" onClick={() => void load()}>もう一度</Button></Notice>
      ) : null}
    </>
  )

  const hasStatusColumn = liveOrder.shown.some(tag => tag.status === 'archived' || tag.cleanupReasons?.includes('duplicate_name'))

  const table = status === 'forbidden' ? (
    <ListState kind="error" title="タグを見る権限がありません" description="タグを見るには権限が要ります。オーナーか管理者に追加を依頼してください。"  />
  ) : status === 'error' ? (
    <ListState kind="error" title="タグを読み込めませんでした" description="再読み込みしても直らない場合はエラー報告へ。" data-design-node="U0aKD" action={<><Button type="button" onClick={() => void load()} busyLabel="処理中…">もう一度読み込む</Button></>} />
  ) : ready && visible.length === 0 ? (
    /* 修正案 D-2：空の一覧。 */
    <EmptyList
      data-design-node="U0aKD"
      icon={<TagIcon aria-hidden="true" />}
      title="まだタグがありません"
      description="友だちに目印を付けて、配信の絞り込みや対応の振り分けに使います。"
      create={{ label: '最初のタグを作る', href: '/tags/new' }}
      canCreate={canEdit}
      filtered={items.length > 0}
      onClearFilters={filterActive ? clearFilters : undefined}
      filteredDescription="検索語・フォルダ・絞り込みを外すと、すべて出ます"
    />
  ) : (
    !ready ? <ListState kind="loading" title="タグを読み込んでいます" data-design-node="U0aKD" /> : <>
      <DataTable className={styles.table} data-design="TagTable">
        <thead>
          <TableHeadRow>
            <Th className={styles.colName}>タグ</Th>
            {hasStatusColumn ? <Th>状態</Th> : null}
            <Th className={styles.colCount}>人数</Th>
            <Th className={styles.colSource}>付け方</Th>
            <Th className={styles.colLink}>連動</Th>
            <Th className={styles.colUsage}>使っている所</Th>
            <Th className={styles.colMenu}><span className="sr-only">操作</span></Th>
          </TableHeadRow>
        </thead>
        <RovingTbody reorderScope={JSON.stringify([accountId, view])} reorderKey={liveOrder.shown.map((tag) => tag.id).join(',')}>
          {liveOrder.shown.map((tag) => {
            const group = groups.find((item) => item.id === tag.groupId)
            const editHref = `/tags/edit?id=${tag.id}`
            return (
              <Tr
                interactive
                key={tag.id}
                data-reorder-id={tag.id}
                onDragEnter={() => liveOrder.enter(tag.id)}
                onDragOver={dragId ? (event) => event.preventDefault() : undefined}
                onDrop={dragId ? () => void move(liveOrder.dropTarget(tag.id)) : undefined}
                className={styles.row}
                leaving={leavingId === tag.id}
                tabIndex={0}
                detailKey="tag" onOpen={() => openTagDetail(tag.id)}
                data-row-id={tag.id}
              >
                <Td className={styles.colName} data-list-name-cell>
                  <ContextMenu label={`タグ「${tag.name}」の操作`} items={tagContextItems(tag)}>
                    <div className={styles.nameRow}>
                      <span
                        className={styles.gripBox}
                        draggable={canEdit && tag.status !== 'archived'}
                        onClick={(event) => event.stopPropagation()}
                        onDragStart={() => setDragId(tag.id)}
                        onDragEnd={() => setDragId(null)}
                      >
                        {/* 閲覧のみ：つまみは隠し、幅だけ空けて名前の位置を保つ */}
                        {canEdit && tag.status !== 'archived' ? (
                          <ReorderHandle label={tag.name} onMove={(direction) => void keyboardMove(tag.id, direction)}>
                            <GripVertical className={styles.gripIcon} aria-hidden="true" />
                          </ReorderHandle>
                        ) : (
                          <span className={styles.gripSpace} aria-hidden="true" />
                        )}
                      </span>
                      <FolderDotName folder={group}>
                        {canEdit ? <RowNameLink prefetch={false} href={editHref} title={tag.name} className={styles.name}>{tag.name}</RowNameLink> : <span title={tag.name}>{tag.name}</span>}
                      </FolderDotName>
                      </div>

                  </ContextMenu>
                </Td>
                {hasStatusColumn ? <Td>{tag.status === 'archived' ? <StatusBadge size="annotation" dot={false}>保管済み</StatusBadge> : null}
                      {tag.cleanupReasons?.includes('duplicate_name') ? (
                        <StatusBadge size="annotation" tone="warning" dot={false} title="正規化した名前がほかのタグと重なっています。整理候補です。">名前が重なっている</StatusBadge>
                      ) : null}</Td> : null}
                {/* 人数は、そのタグで絞った友だち一覧へのリンク。 */}
                <Td className={styles.colCount}>
                  <Link prefetch={false} href={`/friends?tag=${encodeURIComponent(tag.id)}`} className={styles.countLink} title={`「${tag.name}」が付いている友だちを見る`}>
                    {tag.friendCount ?? 0} 人
                  </Link>
                </Td>
                <Td className={styles.colSource}><span className={styles.cellText} title={sourceLabel(tag)}>{sourceLabel(tag)}</span></Td>
                <Td className={styles.colLink}><span className={styles.cellText} title={tagLinkText(tag)}>{tagLinkText(tag)}</span></Td>
                <Td className={styles.colUsage}><span className={styles.cellText} title={usageLabel(tag)}>{usageLabel(tag)}</span></Td>
                <Td className={styles.colMenu}>
                  {/* 閲覧のみ：「…」の中は変える項目だけなので、ボタンごと置かない（列の幅は残す） */}
                  {canEdit ? <span className={styles.menuAnchor}>
                    <RowMenu
                      size="row"
                      label={`タグ「${tag.name}」の操作`}
                      items={rowMenuItems(tag)}
                      open={openMenuId === tag.id}
                      onOpenChange={(next) => {
                        setMenuMoveFor(null)
                        setOpenMenuId(next ? tag.id : null)
                      }}
                    />
                  </span> : null}
                </Td>
              </Tr>
            )
          })}
        </RovingTbody>
      </DataTable>

      {/* 件数とページ送り（絵：左に件数・右にページ送り）。表示件数は道具の段の右端。 */}
      <ListPager>
        <Pagination page={currentPage} pageCount={pages} onPageChange={setPage} ariaLabel="タグのページ送り"
          range={{ total: filtered.length, first: (currentPage - 1) * pageSize + 1, last: Math.min(currentPage * pageSize, filtered.length) }} />
      </ListPager>
    </>
  )

  return (
    <SaveErrorScope errors={saveErrors}><>
      <ListPageBody
        tableInset
        skeleton
        stats={
      <KpiBand data-design="KPIs" className={styles.kpis}>
        {kpis.map((kpi) => (
          <KpiCard
            key={kpi.title}
            presentation="band"
            title={kpi.title}
            icon={<kpi.icon size={16} aria-hidden="true" />}
            value={kpi.value}
            unitSpacing="tight"
            unit={kpi.value == null ? '' : kpi.unit}
            detail={kpi.detail}
            loading={status === 'loading' && !ready}
          />
        ))}
      </KpiBand>
        }
        folders={<>
          <FolderPanel
            createAction={createButton(true)}
            reserveCreateSpace={status !== 'forbidden'}
            activeId={folder}
            onSelect={setFolder}
            onAddFolder={canEdit ? () => setFolderDialog('new') : undefined}
            addFolderLabel="フォルダを追加"
            rows={folderRows}
          >
            {folderNote}
          </FolderPanel>
        </>}
        collapsedFolders={<>
          {createButton(false)}
          <SaveErrorField names={["folder"]}><Select narrowFolderPicker aria-label="フォルダ" size="content" value={folder} onChange={(next) => next === '__manage_folders__' ? setManageFoldersOpen(true) : setFolder(next)} options={[...folderSelectOptions, { value: '__manage_folders__', label: 'フォルダを管理' }]} /></SaveErrorField>
        </>}
        toolbar={narrow ? <ListToolbarFrame layout="stacked"><ListToolbarRow>
          {/* 1152（aPeD8）：1段目＝作る・フォルダ・探す・使用状態、2段目＝付け方・よく使う・右端に表示件数。 */}
          {search}
          {usageSelect}
          {archiveChip}
          </ListToolbarRow><ListToolbarRow>
            {sourceSelect}
            {quickButton}
            <span className={styles.toolbarSpacer} />
            {pageSizeSelect}
          </ListToolbarRow>
        </ListToolbarFrame> : <ListToolbarFrame><ListToolbarRow>
          {search}
          {usageSelect}
          {archiveChip}
          {sourceSelect}
          <span className={styles.toolbarSpacer} />
          {quickButton}
          {pageSizeSelect}
        </ListToolbarRow></ListToolbarFrame>}
      >
        {actionError ? (
          <Notice tone="danger" >{actionError}<Button variant="text" size="inline" data-notice-inline-action type="button" onClick={() => { setActionError(''); void load() }}>状態を確認する</Button></Notice>
        ) : null}
        <RefreshCover refreshing={status === 'loading' && loaded}>{table}</RefreshCover>
      </ListPageBody>

      {/* 行の詳細パネル。フォルダの入力中はそちらを出す。 */}
      {folderDialog ? null : (
        <DetailPanel
          open={activeTag !== null}
          title={activeTag?.name ?? ''}
          description={activeTag ? `${activeGroup?.name ?? '未分類'}・${activeTag.friendCount ?? 0} 人` : undefined}
          onClose={() => setActiveTagId(null)}
          hasPrev={activeTagIndex > 0}
          hasNext={activeTagIndex >= 0 && activeTagIndex < visible.length - 1}
          onPrev={activeTagIndex > 0 ? () => setActiveTagId(visible[activeTagIndex - 1].id) : undefined}
          onNext={activeTagIndex >= 0 && activeTagIndex < visible.length - 1 ? () => setActiveTagId(visible[activeTagIndex + 1].id) : undefined}
          actions={{ primary: (activeTag ? <Button variant="primary" href={`/tags/edit?id=${activeTag.id}`}>編集する</Button> : null),
    menuItems: [...(activeTag ? [{ allowed: canEdit, id: 'detail-0', label: "複製して作る", "href": `/tags/new?copy=${activeTag.id}` }] : [])], primaryAllowed: canEdit }}
        >
<DetailContent>
          {activeTag ? (
            <DetailFields>
              <div><dt>フォルダ</dt><dd>{activeGroup?.name ?? '未分類'}</dd></div>
              <div>
                <dt>人数</dt>
                <dd>
                  <Link href={`/friends?tag=${encodeURIComponent(activeTag.id)}`} className={styles.countLink}>
                    {activeTag.friendCount ?? 0} 人
                  </Link>
                </dd>
              </div>
              <div><dt>付け方</dt><dd>{sourceLabel(activeTag)}</dd></div>
              <div><dt>連動</dt><dd>{tagLinkText(activeTag)}</dd></div>
              <div><dt>使っている所</dt><dd>{usageLabel(activeTag)}</dd></div>
              <div><dt>登録日</dt><dd>{formatDate(activeTag.createdAt)}</dd></div>
            </DetailFields>
          ) : null}

</DetailContent>
</DetailPanel>
      )}

      {csvOpen ? <TagCsvImportDialog open onClose={onCsvClose} onCompleted={() => void load()} /> : null}

      <FolderManagementDialog open={manageFoldersOpen} rows={folderRows} activeId={folder} onSelect={setFolder}
        onAdd={canEdit ? () => setFolderDialog('new') : undefined} onClose={() => setManageFoldersOpen(false)}>
        {folderNote}
      </FolderManagementDialog>

      {folderDialog ? (
        <TagFolderDialog
          group={folderDialog === 'new' ? undefined : folderDialog}
          accountId={accountId}
          onClose={() => setFolderDialog(null)}
          onSaved={() => void load()}
        />
      ) : null}

      <ConfirmDialog
        open={deletingGroup !== null}
        title={deletingGroup ? `「${deletingGroup.name}」を削除しますか？` : 'フォルダを削除しますか？'}
        description="削除しても、中のタグは未分類に残ります。この操作は元に戻せません。"
        confirmLabel="フォルダを削除する"
        destructive
        busy={folderBusy}
        error={folderError || undefined}
        onCancel={() => { if (!folderBusy && !deleteLock.current) { deleteTicket.current = null; setDeletingGroup(null) } }}
        onConfirm={() => removeGroup()}
      >{deletingGroup ? <OperationTargetSummary accounts={[{ id: deletingGroup.accountId ?? '' }]} /> : null}</ConfirmDialog>

      <ConfirmDialog open={restoreTarget !== null} title={`「${restoreTarget?.name ?? ''}」を保管から戻しますか？`}
        description="同じタグを通常の一覧へ戻します。保管時に付け替えた友だちは、そのまま残ります。"
        confirmLabel="保管から戻す" busy={restoring} error={restoreError}
        onConfirm={() => void confirmRestore()} onCancel={() => { if (!restoring) { restoreScopeRef.current = null; setRestoreTarget(null) } }}>
        <OperationTargetSummary accounts={[{ id: restoreScope?.accountId ?? '' }]} externalTarget={{ label: '対象件数', name: restoreTarget ? '1件' : null }} />
      </ConfirmDialog>
      {deleteTarget && (
        <DeleteTagDialog
          tag={deleteTarget}
          accountId={accountId}
          onCancel={() => setDeleteTarget(null)}
          onArchived={(result) => {
            const id = deleteTarget?.id
            setDeleteTarget(null)
            if (result) notifyToast(result)
            if (id) leave(id, () => load())
            else void load()
          }}
        />
      )}
    </></SaveErrorScope>
  )
}
