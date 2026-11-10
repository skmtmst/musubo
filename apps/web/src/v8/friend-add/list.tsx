'use client'

import { isSaveConflict } from '@/components/shared/save-conflict'

import { describeApiFailure } from '@/components/shared/api-error-message'
import SharedStatusPill from '@/components/shared/status-pill'
import { RowNameLink } from '@/components/shared/table';
import { useListUrlValue, writeListUrlParam } from '@/components/shared/list-url-state';
import { useSamePageUrl } from '@/lib/use-same-page-url';
import { DelayedSkeleton, Skeleton } from '@/components/shared/skeleton';
import { Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { OverlayDepthContext } from '@/components/shared/overlay-utils'
import type { ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { Activity, Archive, Copy, CircleCheck, CircleHelp, FilePen, Lock, MessageSquareMore, Pause, Pencil, Plus, Send, UserPlus } from 'lucide-react';
import Link from '@/components/shared/list-navigation'

import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation';

import type { FriendAddRule, FriendAddRuleKind, FriendAddRuleListData, FriendAddRuleStatus } from '@/lib/api';
import { api } from '@/lib/api';
import { useAccount } from '@/contexts/account-context';
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome';
import { ListPage } from '@/components/templates';
import { useStaffRole, canManageRole } from '@/lib/staff-role';
import { useNarrowViewport } from '@/lib/use-narrow-viewport';
import { formatNumber } from '@/lib/format';
import Button from '@/components/shared/button'
import EmptyList from '@/components/shared/empty-list'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Notice from '@/components/shared/notice'
import ListState from '@/components/shared/list-state'
import AccountRequiredState from '@/components/shared/account-required-state'
import FolderEditorDialog from '@/components/shared/folder-editor-dialog'
import { FOLDER_SELECT_COLORS, type FriendAddRuleFolder } from '@line-crm/shared';
import FolderPanel, { FolderPanelNote } from '@/components/shared/folder-panel';
import { FolderDotName, folderDisplayColor } from '@/components/shared/folder-dot';
import SearchField from '@/components/shared/search-field'
import SegmentedControl from '@/components/shared/segmented'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import { Tabs } from '@/components/shared/tabs';
import { DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table';
import { type ActionMenuItem } from '@/components/shared/action-menu';
import { notifyToast } from '@/components/shared/toast';
import { RowMenu } from '@/components/shared/row-actions';
import { CursorPagination } from '@/components/shared/pagination'
import PageSizeSelect from '@/components/shared/page-size-select'
import ReorderHandle from '@/components/shared/reorder-handle'
import { useFlipRows, useLiveReorder } from '@/lib/use-live-reorder';
import { describeFriendAddFailure } from './failure';
import { useCursorStack } from './use-cursor-stack';
import styles from './list.module.css'
import TruncatedText from '@/components/shared/truncated-text'
import { emptyValue } from '@/components/shared/empty-value';
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors';
import ListToolbar from '@/components/shared/list-toolbar';
import ReadOnlyNotice from '@/components/shared/read-only-notice'

/*
 * ★V8 友だち追加時の配信の一覧（Pencil：一覧 ・閲覧のみ ・1152 ・
 * 受け皿の「…」・受け皿は止められない ・状態 ）。
 *
 * 型（ListPage）に、閲覧のみの帯＋区分のタブ・数の帯・左のフォルダの列（上に「初回案内を作る」）・
 * 案内の帯・道具の段・表（順・設定・最初に送るもの・状態・直近7日・…）を渡す。
 * 受け皿（経路が分からなかった人）はいちばん下に固定で鍵の印・薄い地。
 *
 * データの口・保存の口・権限・失敗の扱いは app/friend-add-settings/list-v8.tsx と同じ
 * （BEHAVIOR.md）。違うのは見せ方だけ。
 */

const KIND_LABELS: Record<FriendAddRuleKind, string> = {
  first_time: 'はじめて友だち追加した人',
  returning: '以前からの友だち・ブロック解除した人',
}

/** 未分類の印。サーバでは '__uncategorized' を使う。 */
const UNFILED = '__uncategorized'
const READONLY_REASON = 'この操作にはオーナーか管理者の権限が要ります'
const SINK_NOTE = '基本の追加URL・素のQR・検索など｜いちばん最後に動く・消せない'
const ORDER_NOTE = '順番は上から見て、最初に当てはまった1つだけが動きます。行の左のつまみで入れ替えます。'
const ROUTE_NOTICE = '経路が分かるのは「流入リンク」から来た人だけです。素のQR・検索から来た人には、いちばん下の「経路が分からなかった人」が動きます。'

/* 状態の札には印を付ける（選んでいないときも意味が読める）。 */
const STATUS_CHIPS: Array<{ key: FriendAddRuleStatus; label: string; icon: typeof CircleCheck }> = [
  { key: 'published', label: '有効', icon: CircleCheck },
  { key: 'draft', label: '下書き', icon: FilePen },
  { key: 'stopped', label: '停止中', icon: Pause },
  { key: 'archived', label: '保管', icon: FilePen },
]

function countText(value: number | null | undefined, unit: string) {
  return value === null || value === undefined ? emptyValue('unknown') : `${formatNumber(value)}${unit}`
}

function successRate(delivered: number | null, failed: number | null) {
  if (delivered === null || failed === null || delivered + failed === 0) return '成功率 —'
  return `成功率 ${((delivered / (delivered + failed)) * 100).toFixed(1)}%`
}

/** 「最初に送るもの」の主行（テキスト／テンプレート／回答フォーム／シナリオ）。 */
export function firstSendLabel(rule: FriendAddRule) {
  if (rule.friendKind === 'returning' && rule.definition.returningMode === 'none') {
    return '配信なし（あわせて行うことだけ）'
  }
  switch (rule.definition.messageType) {
    case 'template': return 'テンプレート'
    case 'form': return '回答フォーム'
    case 'scenario': return 'シナリオ'
    default: return rule.definition.messageText ? 'テキスト' : '未取得'
  }
}

/** 操作の名前（「タグ「新規友だち」を付ける」→「タグ「新規友だち」」）。 */
function actionName(label: string) {
  const match = label.match(/^(.*?「[^」]*」)/)
  return match ? match[1] : label
}

/**
 * 「最初に送るもの」の副行。シナリオ・タグなどを1行にまとめる（行の高さを絵の 62 に保つ）。
 * シナリオ開始の操作はシナリオ名で出すので actions 側からは外す。
 */
export function actionLine(rule: FriendAddRule) {
  const parts: string[] = []
  if (rule.definition.messageType !== 'scenario' && rule.scenarioName) {
    parts.push(`＋シナリオ「${rule.scenarioName}」`)
  }
  for (const action of rule.definition.actions) {
    if (action.type === 'start_scenario' && rule.scenarioName && action.targetId === rule.definition.scenarioId) continue
    if (action.label) parts.push(`＋${actionName(action.label)}`)
  }
  return parts.join(' ')
}

function statusLabel(rule: FriendAddRule) {
  if (rule.isFallback) return '常に有効'
  switch (rule.status) {
    case 'published': return '有効'
    case 'draft': return '下書き'
    case 'stopped': return '停止中'
    default: return 'アーカイブ'
  }
}

function statusTone(rule: FriendAddRule) {
  if (rule.isFallback) return 'always'
  return rule.status === 'published' ? 'active' : 'neutral'
}

function StatusPill({ rule }: { rule: FriendAddRule }) {
  return (
    <SharedStatusPill tone={statusTone(rule) === 'neutral' ? 'neutral' : 'success'}>{statusLabel(rule)}</SharedStatusPill>
  )
}

function TableHead() {
  return (
    <thead>
      <TableHeadRow className={styles.headRow} data-table-layout="columns">
        <Th className={styles.colOrder}>順</Th>
        <Th className={styles.colName}>設定（対象の流入リンク）</Th>
        <Th className={styles.colSend}>最初に送るもの</Th>
        <Th className={styles.colStatus}>状態</Th>
        <Th className={styles.colRecent}>直近7日</Th>
        <Th className={styles.colMenu}><span className="sr-only">操作</span></Th>
      </TableHeadRow>
    </thead>
  )
}

export default function FriendAddListV8() {
  // useSearchParams は Suspense の中でしか使えない（静的書き出しのため）。
  return (
    <Suspense fallback={<ListState kind="loading" />}>
      <FriendAddList />
    </Suspense>
  )
}

function FriendAddList() {
  const saveErrors = useSaveFormErrors()
  usePageTitle('友だち追加時の配信')
  usePageCrumbs([{ label: 'ホーム', href: '/' }])
  const router = useRouter()
  const samePageUrl = useSamePageUrl()
  const narrow = useNarrowViewport()
  const { selectedAccountId, accounts, loading: accountLoading } = useAccount()
  // 閲覧のみ：押せない形にする（隠さない）。
  const role = useStaffRole()
  const canEdit = canManageRole(role)
  const searchParams = useSearchParams()
  const kind: FriendAddRuleKind = searchParams.get('kind') === 'returning' ? 'returning' : 'first_time'
  const requestedDeleteId = searchParams.get('delete')

  const accountScope = useRef({ id: selectedAccountId, generation: 0 })
  if (accountScope.current.id !== selectedAccountId) accountScope.current = { id: selectedAccountId, generation: accountScope.current.generation + 1 }
  const loadedScope = useRef(-1)
  const canEditRef = useRef(canEdit)
  canEditRef.current = canEdit
  const [deleteScope, setDeleteScope] = useState<{ id: string; name?: string; generation: number; ticket: object } | null>(null)
  const deleteTicket = useRef<object | null>(null)
  const deleteLock = useRef(false)
  useEffect(() => () => { deleteTicket.current = null }, [])
  const [deleteConflict, setDeleteConflict] = useState(false)
  const [data, setData] = useState<FriendAddRuleListData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [errorStatus, setErrorStatus] = useState<number | null>(null)
  const [search, setSearch] = useListUrlValue('q', '')
  const [appliedSearch, setAppliedSearch] = useState('')
  const [statusFilter, setStatusFilter] = useListUrlValue<FriendAddRuleStatus | ''>('statusFilter', searchParams.get('status') === 'draft' ? 'draft' : '')
  const [folder, setFolder] = useListUrlValue<string | null>('folder', null)
  const [perPage, setPerPage] = useListUrlValue('perPage', 20)
  const { cursor, page, canPrev, reset: resetCursor, goPrev, goNext } = useCursorStack()
  const [folderDialogOpen, setFolderDialogOpen] = useState(false)
  const [folderName, setFolderName] = useState('')
  const [folderColor, setFolderColor] = useState<string | null>(FOLDER_SELECT_COLORS[0].value)
  const [editingFolder, setEditingFolder] = useState<FriendAddRuleFolder | null>(null)
  const [folderError, setFolderError] = useState('')
  const [folderBusy, setFolderBusy] = useState(false)
  const depth = useContext(OverlayDepthContext)
  const closeFolder = () => { setFolderDialogOpen(false); setFolderName(''); setEditingFolder(null) }
  const folderGuard = useUnsavedGuard({
    dirty: folderDialogOpen && (folderName !== (editingFolder?.name ?? '') || folderColor !== (editingFolder ? folderDisplayColor(editingFolder) : FOLDER_SELECT_COLORS[0].value) || folderBusy),
    busy: folderDialogOpen && folderBusy,
    onDiscard: closeFolder,
  })
  const folderKey = useRef(crypto.randomUUID())
  const requestSequence = useRef(0)

  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const [highlightedId, setHighlightedId] = useState<string | null>(searchParams.get('highlight'))
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null)
  const duplicateKeys = useRef(new Map<string, string>())
  const [restoringId, setRestoringId] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const [moveNotice, setMoveNotice] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)

  /* 窓の状態。 */
  const [stopTarget, setStopTarget] = useState<FriendAddRule | null>(null)
  const [stopScope, setStopScope] = useState<{ id: string; name?: string; generation: number } | null>(null)
  const [stopBusy, setStopBusy] = useState(false)
  const [stopError, setStopError] = useState('')
  const [fallbackStop, setFallbackStop] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<FriendAddRule | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  const load = useCallback(async () => {
    const requestId = ++requestSequence.current
    const generation = accountScope.current.generation
    if (!selectedAccountId) {
      setData(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    setErrorStatus(null)
    try {
      const response = await api.friendAddRules.list(selectedAccountId, kind, {
        cursor: cursor ?? undefined,
        limit: perPage,
        q: appliedSearch.trim() || undefined,
        folder: folder ?? undefined,
        status: statusFilter || undefined,
        highlightId: statusFilter === 'draft' ? highlightedId ?? undefined : undefined,
      })
      if (requestId !== requestSequence.current || generation !== accountScope.current.generation) return
      if (!response.success) {
        setError(response.error)
        setErrorStatus(null)
        setData(null)
        return
      }
      loadedScope.current = generation
      setData(response.data)
    } catch (caught) {
      if (requestId !== requestSequence.current || generation !== accountScope.current.generation) return
      const fieldFailure = saveErrors.capture(caught)
      // 権限・対象なし・重複を「通信を確認して」にまとめない。
      const failure = describeFriendAddFailure(caught, '友だち追加時の配信', 'load')
      { if (!fieldFailure)


      setError(failure.message) }
      setErrorStatus(failure.status)
      setData(null)
    } finally {
      if (requestId === requestSequence.current && generation === accountScope.current.generation) setLoading(false)
    }
  }, [appliedSearch, cursor, folder, kind, perPage, selectedAccountId, statusFilter, highlightedId])

  useEffect(() => { void load() }, [load])

  useEffect(() => { resetCursor() }, [selectedAccountId, kind, resetCursor])

  // 検索の入力は少し待ってから、巻き戻しと一緒に1回だけサーバへ送る。
  useEffect(() => {
    const timer = setTimeout(() => {
      setAppliedSearch(search)
      resetCursor()
    }, 0)
    return () => clearTimeout(timer)
  }, [search, resetCursor])

  useEffect(() => { setDeleteTarget(null); setDeleteScope(null); setStopTarget(null); setStopScope(null); setStopBusy(false); setStopError('') }, [selectedAccountId])
  const openDeleteTarget = (item: FriendAddRule) => {
    if (!selectedAccountId || item.accountId !== selectedAccountId || loadedScope.current !== accountScope.current.generation || !canEditRef.current) return
    const ticket = {}; deleteTicket.current = ticket; setDeleteConflict(false)
    setDeleteScope({ id: item.accountId, name: accounts.find(account => account.id === item.accountId)?.name, generation: accountScope.current.generation, ticket })
    setDeleteTarget(item)
  }

  // `?delete=<id>` で開いたときは、その設定の削除の確かめを出す（管理画面 と同じ口）。
  useEffect(() => {
    if (!requestedDeleteId || !data) return
    const found = data.items.find((item) => item.id === requestedDeleteId && !item.isFallback)
    if (found) openDeleteTarget(found)
  }, [data, requestedDeleteId, selectedAccountId, canEdit])

  const clearHighlight = () => {
    setHighlightedId(null)
    writeListUrlParam('highlight', '')
  }
  const selectFolder = (next: string | null) => {
    clearHighlight()
    setFolder(next)
    resetCursor()
  }
  const selectStatus = (next: FriendAddRuleStatus | '') => {
    // 複製直後だけ先頭に出す。利用者が絞り直したら通常の一覧へ戻す。
    clearHighlight()
    setStatusFilter(next)
    resetCursor()
  }
  const changePerPage = (next: number) => {
    clearHighlight()
    setPerPage(next)
    resetCursor()
  }

  /*
   * 行の名前の前の丸は、左のフォルダの列と同じフォルダを名前で引く（設定はフォルダを名前で持つ）。
   * フォルダの候補から色を引く。色なしは薄い灰、フォルダなしは未分類の輪。
   */
  const folderDotOf = (name: string | null | undefined) => (name ? { name, color: data?.options.folders.find((folder) => folder.name === name)?.color } : null)

  /* フォルダ欄の件数はサーバの全ページ合計 (folderCounts)。 */
  const folders = useMemo(() => {
    const counts = new Map<string | null, number>()
    for (const entry of data?.folderCounts ?? []) counts.set(entry.name, entry.count)
    const rows: Array<{ id?: string; key: string; name: string; count: number; color?: string | null }> = []
    for (const option of data?.options.folders ?? []) {
      rows.push({ id: option.id, key: option.name, name: option.name, color: option.color, count: counts.get(option.name) ?? 0 })
    }
    const uncategorized = counts.get(null) ?? 0
    if (uncategorized > 0 || !rows.some((row) => row.name === '未分類')) {
      rows.push({ key: UNFILED, name: '未分類', count: uncategorized })
    }
    return rows
  }, [data])

  const createFolder = async () => {
    if (!selectedAccountId || folderBusy) return
    const name = folderName.trim()
    if (!name) return
    setFolderBusy(true)
    setFolderError('')
    try {
      const response = editingFolder
        ? await api.friendAddRules.updateFolder(selectedAccountId, editingFolder.id, { name, color: folderColor })
        : await api.friendAddRules.createFolder(selectedAccountId, name, folderKey.current, folderColor)
      if (!response.success) {
        setFolderError(response.error)
        return
      }
      if (editingFolder && folder === editingFolder.name) setFolder(name)
      setEditingFolder(null)
      folderKey.current = crypto.randomUUID()
      setFolderName('')
      setFolderDialogOpen(false)
      await load()
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)
      setFolderError(describeFriendAddFailure(caught, 'フォルダ', 'create').message) }
    } finally {
      setFolderBusy(false)
    }
  }

  const items = useMemo(() => data?.items ?? [], [data])
  const regularItems = useMemo(() => items.filter((rule) => !rule.isFallback), [items])
  const sinkRule = useMemo(() => items.find((rule) => rule.isFallback) ?? null, [items])
  const filterActive = Boolean(appliedSearch.trim() || folder || statusFilter)

  /*
   * 並べ替えが書けるのは「その区分の受け皿以外を全部見せている」ときだけ。
   * 絞り込み中や2ページ目以降では一部の順だけを書けないため、サーバは
   * 全件一致しか受け付けない（PATCH /api/friend-add-rules/reorder）。
   */
  const listComplete = Boolean(data) && !filterActive && !data?.nextCursor && !canPrev
  const reorderReason = !canEdit
    ? READONLY_REASON
    : filterActive
      ? '条件を外すと並び替えられます'
      : !listComplete
        ? '一覧を全部読み込んでから並び替えられます'
        : undefined
  const canReorder = canEdit && listComplete

  const runReorder = async (order: string[]) => {
    if (!selectedAccountId) return
    setActionError('')
    try {
      const res = await api.friendAddRules.reorder(selectedAccountId, kind, order)
      if (!res.success) throw new Error(res.error)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)
      setActionError(
        describeApiFailure(caught, '並び替えの保存'),
      ) }
    } finally {
      void load()
    }
  }

  /* 動かしている間、置き場所を入れ替えて見せ、ほかの行は滑らかに場所を空ける（自動応答と同じ動き）。 */
  const liveOrder = useLiveReorder(regularItems, (rule) => rule.id, dragId)
  const bodyRef = useRef<HTMLTableSectionElement>(null)
  useFlipRows(bodyRef, liveOrder.shown.map((rule) => rule.id).join(','))

  const dropOn = (targetId: string) => {
    const from = dragId
    setDragId(null)
    if (!from || from === targetId || !canReorder) return
    const order = regularItems.map((rule) => rule.id)
    const fromIdx = order.indexOf(from)
    const toIdx = order.indexOf(targetId)
    if (fromIdx < 0 || toIdx < 0) return
    order.splice(toIdx, 0, ...order.splice(fromIdx, 1))
    void runReorder(order)
  }

  const keyboardMove = (id: string, direction: -1 | 1) => {
    if (!canReorder) return
    const order = regularItems.map((rule) => rule.id)
    const fromIdx = order.indexOf(id)
    const toIdx = fromIdx + direction
    const name = regularItems.find((rule) => rule.id === id)?.name ?? 'この設定'
    if (fromIdx < 0) return
    if (toIdx < 0 || toIdx >= order.length) {
      setMoveNotice(`「${name}」は${direction < 0 ? '先頭' : '末尾'}にあるため、これ以上動かせません`)
      return
    }
    order.splice(toIdx, 0, ...order.splice(fromIdx, 1))
    setMoveNotice(`「${name}」を${direction < 0 ? '上' : '下'}へ移動しました。${toIdx + 1}番目です`)
    void runReorder(order)
  }

  /* ===== 一時停止 ===== */
  const runStop = async () => {
    if (!stopScope || stopScope.generation !== accountScope.current.generation || !canEditRef.current || !stopTarget || stopBusy) return
    const generation = stopScope.generation
    setStopBusy(true)
    setStopError('')
    try {
      const response = await api.friendAddRules.stop(stopScope.id, stopTarget.id, stopTarget.version)
      if (generation !== accountScope.current.generation) return
      if (!response.success) {
        setStopError('止められませんでした。状態を読み直してから、もう一度お試しください。')
        void load()
        return
      }
      setStopTarget(null)
      await load()
    } catch (saveFailure) {
      if (generation !== accountScope.current.generation) return
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setStopError('止められませんでした。状態を読み直してから、もう一度お試しください。') }
    } finally {
      if (generation === accountScope.current.generation) setStopBusy(false)
    }
  }

  /* ===== 削除 ===== */
  const closeDelete = () => {
    if (deleteBusy) return
    deleteTicket.current = null; setDeleteTarget(null)
    setDeleteConflict(false); setDeleteError('')
    if (requestedDeleteId) samePageUrl.replace(`/friend-add-settings?kind=${kind}`)
  }
  const runDelete = async () => {
    if (!deleteScope || deleteScope.ticket !== deleteTicket.current || deleteScope.generation !== accountScope.current.generation || !canEditRef.current || !deleteTarget || deleteTarget.status === 'archived' || !Number.isSafeInteger(deleteTarget.version) || deleteTarget.version < 1 || deleteConflict || deleteBusy || deleteLock.current) return
    const current = () => deleteScope.ticket === deleteTicket.current && deleteScope.generation === accountScope.current.generation && canEditRef.current
    deleteLock.current = true; setDeleteBusy(true)
    setDeleteError('')
    try {
      const response = await api.friendAddRules.archive(deleteScope.id, deleteTarget.id, { version: deleteTarget.version, status: deleteTarget.status })
      if (!current()) return
      if (!response.success) {
        setDeleteError('保管できませんでした。設定を確認してください。')
        return
      }
      deleteTicket.current = null; setDeleteTarget(null)
      if (requestedDeleteId) samePageUrl.replace(`/friend-add-settings?kind=${kind}`)
      await load()
    } catch (caught) {
      if (!current()) return
      if (isSaveConflict(caught)) { setDeleteConflict(true); setDeleteError('ほかの人が設定を変えました。読み直してから、もう一度選んでください。'); return }
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)
      setDeleteError(describeFriendAddFailure(caught, '設定', 'delete').message.replaceAll('削除', '保管')) }
    } finally {
      deleteLock.current = false; setDeleteBusy(false)
    }
  }

  const restore = async (rule: FriendAddRule) => {
    if (!selectedAccountId || !canEdit || restoringId) return
    setRestoringId(rule.id); setActionError('')
    try {
      const response = await api.friendAddRules.restore(selectedAccountId, rule.id, rule.version)
      if (!response.success) throw new Error(response.error)
      notifyToast('保管から下書きへ戻しました。配信は再開していません。'); await load()
    } catch { setActionError('保管から戻せませんでした。一覧を読み直してお試しください。') }
    finally { setRestoringId(null) }
  }
  const duplicate = async (rule: FriendAddRule) => {
    if (!selectedAccountId || !canEdit || duplicatingId) return
    setDuplicatingId(rule.id); setActionError('')
    if (!duplicateKeys.current.has(rule.id)) duplicateKeys.current.set(rule.id, crypto.randomUUID())
    try {
      const response = await api.friendAddRules.duplicate(selectedAccountId, rule.id, rule.version, duplicateKeys.current.get(rule.id)!)
      if (!response.success) throw new Error(response.error)
      duplicateKeys.current.delete(rule.id); setHighlightedId(response.data.id)
      setStatusFilter('draft'); setSearch(''); setAppliedSearch(''); setFolder(null); resetCursor()
      notifyToast('複製した下書きを追加しました')
    } catch { setActionError('複製できませんでした。一覧を読み直してお試しください。') }
    finally { setDuplicatingId(null) }
  }

  /* ===== 行の「…」 ===== */
  const editHref = (id: string) => `/friend-add-settings?view=edit&id=${encodeURIComponent(id)}`
  const runsHref = (id: string) => `/friend-add-settings/runs?rule_id=${encodeURIComponent(id)}`
  const testHref = (id: string) => `/friend-add-settings?view=edit&id=${encodeURIComponent(id)}&step=preview`
  /* 閲覧のみの人には変える操作を出さない（見るだけの「実行結果を見る」は残す）。 */
  const locked = (item: ActionMenuItem): ActionMenuItem[] => (canEdit ? [item] : [])

  const rowMenuItems = (rule: FriendAddRule): ActionMenuItem[] => rule.status === 'archived' ? [
    ...locked({ id: 'restore', label: '保管から戻す', icon: <Archive size={16} />, disabled: restoringId !== null, onSelect: () => void restore(rule) }),
    { id: 'runs', label: '実行結果を見る', icon: <Activity size={16} />, onSelect: () => router.push(runsHref(rule.id)) },
  ] : [
    ...locked({ id: 'duplicate', label: '複製する', icon: <Copy size={16} />, disabled: duplicatingId !== null, onSelect: () => void duplicate(rule) }),
    ...locked({ id: 'edit', label: '編集する', icon: <Pencil size={16} />, onSelect: () => router.push(editHref(rule.id)) }),
    { id: 'runs', label: '実行結果を見る', icon: <Activity size={16} />, onSelect: () => router.push(runsHref(rule.id)) },
    ...locked({ id: 'test', label: 'テストを送る', icon: <Send size={16} />, onSelect: () => router.push(testHref(rule.id)) }),
    ...(rule.isFallback
      ? locked({ id: 'stop-fallback', label: '止められない理由を見る', icon: <Pause size={16} />, onSelect: () => setFallbackStop(true) })
      : [
          ...(rule.status === 'published'
            ? locked({
                id: 'stop',
                label: '止める',
                icon: <Pause size={16} />,
                onSelect: () => {
                  if (!selectedAccountId || rule.accountId !== selectedAccountId || loadedScope.current !== accountScope.current.generation) return
                  setStopError('')
                  setStopScope({ id: rule.accountId, name: accounts.find(account => account.id === rule.accountId)?.name, generation: accountScope.current.generation })
                  setStopTarget(rule)
                },
              })
            : rule.status === 'draft'
              ? locked({
                  id: 'publish',
                  label: '最終確認・有効化へ進む',
                  icon: <CircleCheck size={16} />,
                  onSelect: () => router.push(`/friend-add-settings/publish?id=${encodeURIComponent(rule.id)}`),
                })
              : []),
          ...locked({
            id: 'delete',
            label: '保管する',
            icon: <Archive size={16} />,
            tone: 'danger' as const,
            dividerBefore: true,
            onSelect: () => {
              setDeleteError('')
              openDeleteTarget(rule)
            },
          }),
        ]),
  ]

  /* ===== 数の帯の4つ ===== */
  const summary = data?.summary
  const kpis = [
    {
      key: 'rules', icon: MessageSquareMore, title: '初回案内', value: error ? null : summary?.rules ?? null, unit: '件',
      detail: summary ? `有効 ${countText(summary.active, '件')}（共通は別）` : error ? '読み込めませんでした' : loading ? '読み込んでいます' : emptyValue('unknown'),
      help: '設定数には共通の案内を含みます。有効の内訳は共通の案内を除きます。右の3つ（直近7日）とは期間がちがいます。',
    },
    {
      key: 'adds', icon: UserPlus, title: '直近7日の友だち追加', value: error ? null : summary?.recentAdds ?? null, unit: '人',
      detail: `経路が取れた ${countText(summary?.captured ?? null, '人')}`,
      help: '直近7日に友だち追加された人数と、そのうち流入リンクが分かった人数です。',
    },
    {
      key: 'sent', icon: Send, title: '直近7日の送信', value: error ? null : summary?.delivered ?? null, unit: '通',
      detail: successRate(summary?.delivered ?? null, summary?.failed ?? null),
      help: '直近7日に実際に送った通数です。送信履歴の累計配信と同じ数え方です。',
    },
    {
      key: 'unknown', icon: CircleHelp, title: narrow ? '経路が不明' : '経路が分からなかった人', value: error ? null : summary?.unknownRoute ?? null, unit: '人',
      /* 1152 では2行に折れる。行の高さを絵の18にそろえる（帯の高さを134に保つ）。 */
      detail: <span className={styles.kpiDetail}>共通の案内が動いた</span>,
      action: { label: '流入リンクを見る', href: '/inflow-links' },
    },
  ]

  /* ===== 道具 ===== */
  /* 閲覧のみの人には、作る・追加・編集・削除の操作を置かない（押せない形でも出さない。オーナー 2026-10-06）。 */
  const folderRows = [
    { kind: 'all' as const, id: '', label: 'すべて', count: data?.total ?? items.length },
    ...folders.map((entry) => ({ kind: entry.key === UNFILED ? 'unfiled' as const : 'folder' as const, id: entry.key, label: entry.name, color: entry.color, count: entry.count,
      onEdit: canEdit && entry.id && entry.key !== UNFILED ? () => { setFolderName(entry.name); setFolderColor(folderDisplayColor(entry)); setEditingFolder({ id: entry.id!, name: entry.name, color: entry.color }); setFolderError(''); setFolderDialogOpen(true) } : undefined })),
  ]
  const createButton = canEdit ? (
    <Button variant="primary" href="/friend-add-settings?view=new" className={styles.createButton}>
      <Plus size={16} aria-hidden="true" />初回案内を作る
    </Button>
  ) : null
  const searchBox = (
    <div className={styles.searchBox}>
      <SearchField
        value={search}
        onChange={next => { clearHighlight(); setSearch(next) }}
        onClear={() => { clearHighlight(); setSearch('') }}
        placeholder={narrow ? '設定名で探す' : '設定名・流入リンクで探す'}
        aria-label="設定名・流入リンクで探す"
      />
    </div>
  )
  const statusChips = (
    <SegmentedControl
      aria-label="状態で絞り込む"
      value={statusFilter}
      onChange={selectStatus}
      options={[
        { value: '', label: 'すべて' },
        ...STATUS_CHIPS.map((chip) => ({ value: chip.key, label: chip.label })),
      ]}
    />
  )
  const perPageBox = <PageSizeSelect value={perPage} onChange={changePerPage} options={[10, 20, 50]} label={null} />
  const notice = (
    null
  )
  const errorBand = actionError ? (
    <Notice tone="danger" >{actionError}<Button onClick={() => load()} busyLabel="処理中…">もう一度読み込む</Button></Notice>
  ) : null
  // 作る・フォルダは ListPage.folderNav だけが持つ。検索・状態・件数は共通の役目へ。
  const toolbar = <>
    {errorBand}
    <ListToolbar searchSlot={searchBox} filters={statusChips} trailing={perPageBox} />
  </>

  /* ===== 表の行 ===== */
  const menuCell = (rule: FriendAddRule) => {
    const label = `設定「${rule.name}」の操作`
    return (
      <Td className={styles.colMenu}>
        <div className={styles.menuBox} data-design-node={rule.isFallback && openMenuId === rule.id ? 'C0lfUP' : undefined}>
          <RowMenu
            label={label}
            appearance="box"
            size="row"
            note={rule.isFallback && canEdit ? 'この設定は消せません（いちばん最後の受け皿）' : undefined}
            items={rowMenuItems(rule).map((item) => ({ ...item, onSelect: () => { setOpenMenuId(null); item.onSelect?.() } }))}
            open={openMenuId === rule.id}
            onOpenChange={(next) => setOpenMenuId(next ? rule.id : null)}
          />
        </div>
      </Td>
    )
  }

  const sendCell = (rule: FriendAddRule) => {
    const line = actionLine(rule)
    return (
      <Td className={styles.colSend}>
        <span className={styles.sendMain}>{firstSendLabel(rule)}</span>
        {line ? <span className={styles.sendSub} title={line}>{line}</span> : null}
      </Td>
    )
  }

  let listBody: ReactNode
  if (accountLoading || (loading && items.length === 0 && !error)) {
    /*
     * 初回の読み込みにも骨組みを出す（動きの点検 15 番）。0.3 秒以内に届けば出さない。
     * 読み上げには「読み込んでいます」を残す。
     */
    listBody = (
      <div role="status" aria-busy="true" className={styles.loadingRows}>
        <span className="sr-only">友だち追加時の配信を読み込んでいます</span>
        <DelayedSkeleton
          loading
          skeleton={
            <div aria-hidden="true">
              {[0, 1, 2, 3, 4].map((row) => (
                <div key={row} className={styles.loadingRow}>
                  <Skeleton height={12} width="36%" />
                  <Skeleton height={10} width="22%" />
                </div>
              ))}
            </div>
          }
        />
      </div>
    )
  } else if (!selectedAccountId) {
    listBody = <AccountRequiredState hasAccounts={accounts.length > 0} />
  } else if (error) {
    /* 状態の板：読めないときも道具はそのまま。数の帯は「—」。 */
    listBody = (
      <ListState kind="error" title="設定を読み込めませんでした" description={errorStatus === 403 ? error : '数の帯は「—」、道具はそのまま使えます。条件を変えてから試し直せます。'}  action={<><Button onClick={() => load()} busyLabel="処理中…">もう一度読み込む</Button></>} />
    )
  } else if (items.length === 0) {
    /* 修正案 D-2：空の一覧。 */
    listBody = (
      <EmptyList
        icon={<UserPlus aria-hidden="true" />}
        title="まだ友だち追加時の配信がありません"
        description="友だちになった直後のあいさつを、流入経路ごとに分けて送ります。"
        create={{ label: '最初の配信を作る', href: '/friend-add-settings?view=new' }}
        canCreate={canEdit}
        filtered={filterActive}
        onClearFilters={() => {
          clearHighlight()
          setSearch('')
          setAppliedSearch('')
          setStatusFilter('')
          setFolder(null)
          resetCursor()
        }}
        filteredDescription="「有効」「下書き」「停止中」や検索を外すと、すべて出ます"
      />
    )
  } else {
    listBody = (
      <>
        {/* キーボードで動かした結果を読み上げる。画面には出さない。 */}
        <span className="sr-only" role="status" aria-live="polite">{moveNotice}</span>
        <div className={styles.tableWrap}>
          <DataTable className={styles.table}>
            <TableHead />
            <tbody ref={bodyRef}>
              {liveOrder.shown.map((rule, index) => (
                <Tr
                  key={rule.id}
                  selected={highlightedId === rule.id}
                  className={styles.row}
                  data-table-layout="columns"
                  data-row-id={rule.id}
                  data-reorder-id={rule.id}
                  onDragEnter={() => liveOrder.enter(rule.id)}
                  onDragOver={dragId ? (event) => event.preventDefault() : undefined}
                  onDrop={dragId ? () => dropOn(liveOrder.dropTarget(rule.id)) : undefined}
                 href={editHref(rule.id)}>
                  <Td
                    className={styles.colOrder}
                    draggable={canReorder}
                    onDragStart={() => setDragId(rule.id)}
                    onDragEnd={() => setDragId(null)}
                    title={canReorder ? '上下に動かして並び替え' : reorderReason}
                  >
                    <span className={styles.orderBox}>
                      <ReorderHandle
                        label={rule.name}
                        disabledReason={canReorder ? null : reorderReason ?? READONLY_REASON}
                        onMove={(direction) => keyboardMove(rule.id, direction)}
                      >
                        <span aria-hidden="true" className={styles.grip}>⠿</span>
                      </ReorderHandle>
                      <span className={styles.orderNum}>{rule.priority}</span>
                    </span>
                  </Td>
                  <Td className={styles.colName}>
                    <FolderDotName folder={folderDotOf(rule.folderName)}>
                      <RowNameLink href={editHref(rule.id)} title={rule.name} className={styles.name}><TruncatedText value={String(rule.name ?? '')} /></RowNameLink>
                    </FolderDotName>

                  </Td>
                  {sendCell(rule)}
                  <Td className={styles.colStatus}><StatusPill rule={rule} /></Td>
                  <Td className={styles.colRecent}>
                    <span className={styles.num}>{rule.status === 'draft' ? emptyValue('unknown') : countText(rule.matchedLast7Days, '人')}</span>
                  </Td>
                  {menuCell(rule)}
                </Tr>
              ))}
              {sinkRule ? (
                <Tr key={sinkRule.id} className={`${styles.row} ${styles.sinkRow}`} data-table-layout="columns" data-row-id={sinkRule.id} href={editHref(sinkRule.id)}>
                  <Td className={styles.colOrder}>
                    <span className={styles.orderBox} title="いちばん最後に動く・動かせない">
                      <Lock size={16} aria-hidden="true" className={styles.lock} />
                    </span>
                  </Td>
                  <Td className={styles.colName}>
                    <FolderDotName folder={folderDotOf(sinkRule.folderName)}>
                      <RowNameLink href={editHref(sinkRule.id)}  className={styles.name}><TruncatedText value={String(sinkRule.name ?? '')} /></RowNameLink>
                    </FolderDotName>

                  </Td>
                  {sendCell(sinkRule)}
                  <Td className={styles.colStatus}><StatusPill rule={sinkRule} /></Td>
                  <Td className={styles.colRecent}><span className={styles.num}>{countText(sinkRule.matchedLast7Days, '人')}</span></Td>
                  {menuCell(sinkRule)}
                </Tr>
              ) : null}
            </tbody>
          </DataTable>
        </div>
      </>
    )
  }

  const pager = data && !error ? <CursorPagination page={page} pageSize={perPage} shown={items.length} total={data.total}
    hasNext={Boolean(data.nextCursor)} disabled={loading} onPrevious={goPrev} onNext={() => goNext(data.nextCursor)} /> : null

  return (
    <SaveErrorScope errors={saveErrors}><ListPage
      skeleton
      heightMode="content"
      toolbarSpacing="section"
      help={<>{"友だち追加されたときに、来た経路（流入リンク）ごとに初回の案内を送り、タグ付けやシナリオを始めます。"}{ORDER_NOTE}{kpis.map(kpi => kpi.help ? <p key={kpi.key}>{kpi.title}：{kpi.help}</p> : null)}</>}
      explanation="経路が分かるのは「流入リンク」から来た人だけです。素のQR・検索から来た人には、いちばん下の「経路が分からなかった人」が動きます。"
      boardId={canEdit ? 'MRhef' : 'LEwkJ'}
      headingSize="regular"
      title="友だち追加時の配信"

      actions={
        <Button href="/friend-add-settings/runs">
          <Activity size={16} aria-hidden="true" />実行結果を見る
        </Button>
      }
      tabs={<>
        {/* 役割が取れるまで（null）は閲覧のみの帯を出さない。出してから消すと一覧が 48px 跳ねていた（動きの点検 8 番）。 */}
        {role !== null && !canEdit ? (
          <div className={styles.viewerBand}><ReadOnlyNotice role="status"></ReadOnlyNotice></div>
        ) : null}
        <div className={styles.kindTabs} data-design="KindTabs">
          <Tabs
            className={styles.kindList}
            label="配信の種類"
            items={(Object.keys(KIND_LABELS) as FriendAddRuleKind[]).map((tab) => ({
              label: KIND_LABELS[tab],
              current: kind === tab,
              onClick: () => {
                resetCursor()
                samePageUrl.replace(`/friend-add-settings?kind=${tab}`)
              },
            }))}
          />
        </div>
      </>}
      stats={
        <KpiBand data-design="KPIs">
          {kpis.map((kpi) => (
            <KpiCard
              key={kpi.key}
              presentation="band"
              title={kpi.title}
              icon={<kpi.icon size={16} aria-hidden="true" />}
              value={kpi.value}
              unit={kpi.value === null ? '' : kpi.unit}
              detail={kpi.detail}
              help={kpi.help}
              action={kpi.action}
            />
          ))}
        </KpiBand>
      }
      folders={<>
        <FolderPanel
          createAction={createButton}
          readOnly={!canEdit}
          reserveCreateSpace={canEdit}
          activeId={folder ?? ''}
          onSelect={(id) => selectFolder(id || null)}
          onAddFolder={canEdit ? () => { setFolderName(''); setFolderColor(FOLDER_SELECT_COLORS[0].value); setEditingFolder(null); setFolderError(''); setFolderDialogOpen(true) } : undefined}
          addFolderLabel="フォルダを追加"
          addFolderDisabled={folderBusy}
          rows={folderRows}
        >
          <FolderPanelNote>フォルダを消しても、中の設定は未分類に残ります</FolderPanelNote>
        </FolderPanel>
      </>}
      folderNav={{ rows: folderRows, activeId: folder ?? '', onSelect: (id) => selectFolder(id || null), createAction: createButton ?? undefined }}
      toolbar={toolbar}
      pagination={pager}
      overlays={<>
        {/* 受け皿を止められない案内（cFo2p）。 */}
        <ConfirmDialog
          open={fallbackStop}
          designNode="cFo2p"
          designLayout="stacked"
          designTop={280}
          designFooterGap={18}
          titleIcon={false}
          title="「経路が分からなかった人」は止められません"
          description="いちばん最後の受け皿なので、止めると誰にも案内が届かなくなります。届く中身を変えたいときは、この設定を編集してください。止めたいときは、先に別の受け皿を有効にしてください。"
          confirmLabel="受け皿の中身を直す"
          onConfirm={() => {
            setFallbackStop(false)
            if (sinkRule) router.push(editHref(sinkRule.id))
          }}
          onCancel={() => setFallbackStop(false)}
        >
          <Notice tone="warn" appearance="soft" message={`直近7日では ${countText(sinkRule?.matchedLast7Days, '人')} がこの設定で案内を受け取っています。`} />
        </ConfirmDialog>
        {/* 通常の設定の一時停止の確かめ。 */}
        <ConfirmDialog
          open={stopTarget !== null && stopScope?.generation === accountScope.current.generation}
          title={stopTarget ? `「${stopTarget.name}」を止める` : ''}
          description="止めると、この流入リンクから来た人にはいちばん下の「経路が分からなかった人」の案内が動きます。"
          confirmLabel="止める"
          busy={stopBusy}
          error={stopError}
          onConfirm={() => runStop()}
          onCancel={() => {
            if (stopBusy) return
            setStopTarget(null)
            setStopError('')
          }}
        >
          {stopScope ? <OperationTargetSummary accounts={[{ id: stopScope.id, name: stopScope.name }]} /> : null}
        </ConfirmDialog>
        {/* 削除の確かめ（v7 と同じ文）。受け皿には削除を出さない。 */}
        <ConfirmDialog
          open={deleteTarget !== null && deleteScope?.generation === accountScope.current.generation}
          designNode="Q3qP1r"
          title={deleteTarget ? `「${deleteTarget.name}」を保管しますか？` : ''}
          description="保管すると、このリンクから追加された人には「経路が分からなかった人」の共通あいさつが動きます。過去の実行履歴は監査記録として残り、保管から戻すと、下書きとして再び編集できます。"
          confirmLabel="保管する"
          destructive
          busy={deleteBusy}
          error={deleteError}
          confirmDisabled={deleteConflict}
          confirmDisabledReason="読み直してから、もう一度選んでください。"
          onConfirm={() => runDelete()}
          onCancel={closeDelete}
        >
          {deleteScope ? <OperationTargetSummary accounts={[{ id: deleteScope.id, name: deleteScope.name }]} /> : null}
          {deleteConflict ? <Button onClick={() => { closeDelete(); void load() }}>読み直す</Button> : null}
        </ConfirmDialog>
        <FolderEditorDialog open={folderDialogOpen} title={editingFolder ? 'フォルダを直す' : 'フォルダを追加'}
          description="設定を分けてしまう箱です。"
          name={folderName} onNameChange={setFolderName} color={folderColor} onColorChange={setFolderColor} maxLength={50}
          confirmLabel={editingFolder ? '保存する' : '追加する'} busy={folderBusy} error={folderError || undefined}
          onCancel={closeFolder}
          onConfirm={() => createFolder()} />
        <OverlayDepthContext.Provider value={depth + 2}><UnsavedLeaveDialog open={folderGuard.leaveTarget !== null} busy={folderBusy} onConfirm={folderGuard.confirmLeave} onCancel={folderGuard.cancelLeave} /></OverlayDepthContext.Provider>
      </>}
    >
      {listBody}
    </ListPage></SaveErrorScope>
  )
}
