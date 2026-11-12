'use client'

import { useFolderMove } from '@/components/shared/use-folder-move'
import { RowNameLink, ActionCell, DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table'
import { moveOutgoingWebhookToFolder } from '@/lib/move-to-folder'
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { OverlayDepthContext } from '@/components/shared/overlay-utils'
import { useListScrollMemory, useListUrlState, useOnAccountSwitch } from '@/components/shared/list-url-state'
import Link, { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { Bookmark, LayoutTemplate, Pause, Play, Plus, Send } from 'lucide-react'
import type { Folder } from '@line-crm/shared'
import { api, ApiError, type OutgoingWebhookOverview } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { useNarrowViewport } from '@/lib/use-narrow-viewport'
import { formatNumber } from '@/lib/format'
import { ListPage, ListPagePagination } from '@/components/templates'
import ListToolbar, { ListToolbarFrame, ListToolbarRow, ListToolbarSearchSlot, ListToolbarEnd } from '@/components/shared/list-toolbar'
import SearchField from '@/components/shared/search-field'
import Button from '@/components/shared/button'
import StatusBadge from '@/components/shared/status-badge'
import { TextField } from '@/components/shared/text-field'
import { RowMenu } from '@/components/shared/row-actions'
import EmptyList from '@/components/shared/empty-list'
import Notice from '@/components/shared/notice'
import ListState from '@/components/shared/list-state'
import AccountRequiredState from '@/components/shared/account-required-state'
import Select from '@/components/shared/select'
import SegmentedControl from '@/components/shared/segmented'
import PageSizeSelect from '@/components/shared/page-size-select'
import Pagination from '@/components/shared/pagination'
import ManagedFolderPanel, { folderDotFor, managedFolderOptions } from '@/components/shared/managed-folder-panel'
import { FolderDotName } from '@/components/shared/folder-dot'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Dialog from '@/components/shared/dialog'
import { type ActionMenuItem } from '@/components/shared/action-menu'
import ContextMenu from '@/components/shared/context-menu'
import { DelayedSkeleton, Skeleton } from '@/components/shared/skeleton'
import { notifyToast } from '@/components/shared/toast'
import { describeApiFailure, permissionDeniedMessage } from '@/components/shared/api-error-message'
import StepUpPrompt, { isStepUpRequired, type StepUpRequest } from '@/components/step-up-prompt'
import {
  MANAGE_REASON,
  ViewerBand,
  WEBHOOKS_DESCRIPTION,
  WebhookBand,
  WebhookTabs,
  overviewBandCells,
  useWebhookOverview,
} from './shell'
import { MIN_SECRET_LENGTH, generateSecret } from './secret'
import { eventLabel, isHttpsUrl, maskedUrl, payloadLabel, shortDateTime, urlHost } from './words'
import { useWebhookWriteAccess, canManageWebhooksNow, captureWebhookWriteAccess } from './write-access'
import styles from './outgoing.module.css'
import TruncatedText from '@/components/shared/truncated-text'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'

/*
 * ★V8 外部連携「こちらから送る」の一覧（Pencil ・1152 ・
 * 閲覧のみ ・状態 ）。
 *
 * 型（ListPage）に、タブ・数の帯・左のフォルダの列（上に「送り先を作る」）・
 * 案内の帯・道具の段・表をはめる。データの口は 管理画面 と同じ（一覧・集計・
 * 動かす/止める・試し送信・合言葉の作り直し・削除）。
 *
 * 絵と今の作りが合わない所は BEHAVIOR.md に書いた
 * （「先月より」の集計が無い・複製の口が無い など）。
 */

type SavedFilter = '' | 'active' | 'paused' | 'failed'
type SortKey = 'volume' | 'name'

/** 未分類を表す印。空文字は「すべて」なので別の値にする。 */
const UNFILED = '__unfiled__'

function matchesQuery(item: OutgoingWebhookOverview, query: string): boolean {
  // 管理画面 と同じ探し方：名前・URL・出来事の種類（大文字小文字を区別しない）。
  const q = query.trim().toLocaleLowerCase('ja-JP')
  if (!q) return true
  return [item.name, item.url, ...item.eventTypes].some((value) => value.toLocaleLowerCase('ja-JP').includes(q))
}

function isFailing(item: OutgoingWebhookOverview): boolean {
  const pending = item.deliverySummary.lastResult?.status === 'pending'
  return !pending && (item.deliverySummary.lastResult?.status === 'failed' || item.deliverySummary.failed > 0)
}

export default function WebhooksOutgoingV8() {
  const saveErrors = useSaveFormErrors()
  usePageTitle('外部連携')
  usePageCrumbs([{ label: 'ホーム', href: '/' }])
  const router = useRouter()
  const { selectedAccountId, accounts } = useAccount()
  const accountRef = useRef(selectedAccountId)
  accountRef.current = selectedAccountId
  // 同じ店へ戻った場合も、切替前の要求は別の世代として扱う。
  const accountScopeRef = useRef({ accountId: selectedAccountId })
  if (accountScopeRef.current.accountId !== selectedAccountId) accountScopeRef.current = { accountId: selectedAccountId }
  const narrow = useNarrowViewport()
  const management = useWebhookWriteAccess()
  const ownership = useWebhookWriteAccess(true)
  const canManage = management.allowed
  const canTest = canManage

  const overview = useWebhookOverview()
  const { outgoing, outgoingStatus, summary, loadedAccountId, reload } = overview

  const [folders, setFolders] = useState<Folder[]>([])
  /*
   * 検索語・フォルダ・絞り込み・並び順・件数・ページは URL に置く（動きの点検 5 番）。
   * 送り先を開いて「戻る」と同じ一覧に戻る。絞り込みを変えたらページは 1 へ
   * （同じ書き込みの中で戻す。効果で戻すと、来た瞬間に URL から戻したページまで消える）。
   * 並びの部品は絵に無い。つなぎ先は名前で探すことが多いので、既定は名前順（送った回数順は「よく使う絞り込み」から）。
   */
  const [view, setView] = useListUrlState({ q: '', folder: '', view: '', sort: 'name', size: '20', page: '1' })
  const query = view.q
  const folderFilter = view.folder
  const chip: SavedFilter = (['', 'active', 'paused', 'failed'] as const).includes(view.view as SavedFilter) ? view.view as SavedFilter : ''
  const sortKey: SortKey = view.sort === 'volume' ? 'volume' : 'name'
  const pageSize = [10, 20, 50].includes(Number(view.size)) ? Number(view.size) : 20
  const page = Math.max(1, Number.parseInt(view.page, 10) || 1)
  const setPage = useCallback((next: number) => setView({ page: String(next) }), [setView])
  const setQuery = useCallback((next: string) => setView({ q: next, page: '1' }), [setView])
  const setFolderFilter = useCallback((next: string) => setView({ folder: next, page: '1' }), [setView])
  const setChip = useCallback((next: SavedFilter) => setView({ view: next, page: '1' }), [setView])
  const setSortKey = useCallback((next: SortKey) => setView({ sort: next, page: '1' }), [setView])
  const setPageSize = useCallback((next: number) => setView({ size: String(next), page: '1' }), [setView])
  const [menuId, setMenuId] = useState<string | null>(null)
  /* 右クリックされた行（「設定」と同じ中身を押した位置に出す。右クリックだけの操作は置かない）。 */
  const [ctxId, setCtxId] = useState<string | null>(null)
  const [error, setError] = useState('')

  const [optimisticActive, setOptimisticActive] = useState<Record<string, boolean>>({})
  const togglingRef = useRef<Set<string>>(new Set())
  const [togglingIds, setTogglingIds] = useState<string[]>([])

  const [testTarget, setTestTarget] = useState<{ item: OutgoingWebhookOverview; accountId: string; scope: object } | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testNotice, setTestNotice] = useState<string | null>(null)

  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string; confirmationRevision?: number; accountId: string; scope: object } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  const [rotateTarget, setRotateTarget] = useState<{ id: string; name: string; confirmationRevision?: number; activate: boolean; accountId: string; scope: object } | null>(null)
  const [rotateSecret, setRotateSecret] = useState('')
  const [rotateError, setRotateError] = useState('')
  const [rotating, setRotating] = useState(false)
  const [stepUp, setStepUp] = useState<StepUpRequest | null>(null)
  const depth = useContext(OverlayDepthContext)
  const guard = useUnsavedGuard({
    dirty: rotateTarget !== null && (Boolean(rotateSecret) || rotating),
    busy: rotateTarget !== null && rotating,
    onDiscard: () => { setRotateTarget(null); setRotateSecret(''); setStepUp(null) },
  })

  /* フォルダの箱（kind=webhook）。送り先をフォルダへ入れる口はまだ無い（BEHAVIOR.md）。 */
  const loadFolders = async () => {
    try {
      const res = await api.folders.list('webhook', selectedAccountId ?? undefined)
      if (res.success) setFolders(res.data)
    } catch (saveFailure) {
      saveErrors.capture(saveFailure)
      // 箱が取れなくても一覧は出す。
    }
  }
  useEffect(() => { void loadFolders() }, [selectedAccountId]) // eslint-disable-line react-hooks/exhaustive-deps

  const displayed = useMemo(() => outgoing.map((item) => (
    optimisticActive[item.id] === undefined ? item : { ...item, isActive: optimisticActive[item.id] }
  )), [outgoing, optimisticActive])

  const ready = outgoingStatus === 'ready' && Boolean(selectedAccountId)
  const activeCount = displayed.filter((item) => item.isActive).length
  const pausedCount = displayed.length - activeCount

  const filtered = useMemo(() => {
    const rows = displayed.filter((item) => {
      if (!matchesQuery(item, query)) return false
      // 左のフォルダの列で絞る（未分類はフォルダに入っていない送り先）。
      if (folderFilter === UNFILED ? Boolean(item.folderId) : folderFilter !== '' && item.folderId !== folderFilter) return false
      if (chip === 'active') return item.isActive
      if (chip === 'paused') return !item.isActive
      if (chip === 'failed') return item.deliverySummary.failed > 0
      return true
    })
    return [...rows].sort((a, b) => (sortKey === 'name'
      ? a.name.localeCompare(b.name, 'ja-JP')
      : b.deliverySummary.total - a.deliverySummary.total))
  }, [displayed, query, folderFilter, chip, sortKey])

  // アカウントを替えたらページは 1 へ（来た瞬間は URL のまま）。
  useOnAccountSwitch(selectedAccountId, () => {
    setPage(1)
    setTestTarget(null)
    setTestingId(null)
    setTestNotice(null)
    setDeleting(false)
    setRotating(false)
    setOptimisticActive({})
    togglingRef.current.clear()
    setTogglingIds([])
    setMenuId(null)
    setCtxId(null)
  })
  useListScrollMemory(ready)
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const currentPage = Math.min(page, pageCount)
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  const filterActive = Boolean(query || folderFilter || chip)
  const clearFilters = () => {
    setView({ q: '', folder: '', view: '', page: '1' })
  }

  /* ===== 動かす・止める（押した瞬間に札を変え、裏で保存する） ===== */
  const handleToggle = async (item: OutgoingWebhookOverview, currentActive: boolean) => {
    if (!canManageWebhooksNow()) { setError(management.reason ?? '担当者の確認が終わるまでお待ちください。'); return }
    const accountId = selectedAccountId
    const scope = accountScopeRef.current
    const isCurrent = () => accountScopeRef.current === scope
    if (!accountId || accountRef.current !== accountId || loadedAccountId !== accountId) {
      setError('LINEアカウントの一覧を読み直してください')
      return
    }
    if (togglingRef.current.has(item.id)) {
      notifyToast(`「${item.name}」：いま切り替えを送っています。返事が来るまでお待ちください。`)
      return
    }
    togglingRef.current.add(item.id)
    setTogglingIds((current) => [...current, item.id])
    setOptimisticActive((current) => ({ ...current, [item.id]: !currentActive }))
    const clear = () => setOptimisticActive((current) => {
      const next = { ...current }
      delete next[item.id]
      return next
    })
    const fail = (message: string) => {
      clear()
      notifyToast(message, { tone: 'error', actionLabel: 'もう一度', onAction: () => { if (isCurrent()) void handleToggle(item, currentActive) } })
    }
    try {
      const res = await api.webhooks.outgoing.update(item.id, accountId, { isActive: !currentActive })
      if (!isCurrent()) return
      if (!res.success) {
        fail(`「${item.name}」は切り替えできませんでした。状態は変わっていません。確かめてから、もう一度お試しください。`)
        return
      }
      await reload()
      if (!isCurrent()) return
      clear()
      notifyToast(`「${item.name}」を${!currentActive ? '動かしました' : '止めました'}。`, {
        actionLabel: '元に戻す',
        onAction: () => { if (isCurrent()) void handleToggle(item, !currentActive) },
      })
    } catch (caught) {
      if (!isCurrent()) return
      saveErrors.capture(caught);

      const forbidden = caught instanceof ApiError && caught.status === 403
      if (!forbidden) await reload().catch(() => {});

      if (!isCurrent())

 return
      fail(forbidden
        ? permissionDeniedMessage('store')
        : `「${item.name}」は切り替えの応答を受け取れませんでした。一覧の表示を確かめてください。変わっている可能性があります。`)
    } finally {
      if (isCurrent()) {
        togglingRef.current.delete(item.id)
        setTogglingIds((current) => current.filter((id) => id !== item.id))
      }
    }
  }

  /* ===== 試しに送る ===== */
  const runTest = async (item: OutgoingWebhookOverview, accountId: string, scope: object) => {
    if (!accountId || accountRef.current !== accountId || loadedAccountId !== accountId || accountScopeRef.current !== scope || testingId !== null || !Number.isSafeInteger(item.version) || (item.version ?? 0) < 1) return
    if (!Number.isSafeInteger(item.confirmationRevision) || (item.confirmationRevision ?? 0) < 1) { setTestNotice(`「${item.name}」への試し送信に失敗しました。「やり取りの記録」タブで詳しく確認できます。`); return false }
    setTestingId(item.id)
    setTestNotice(null)
    try {
      const response = await api.webhooks.outgoing.test(item.id, accountId, item.version!, item.confirmationRevision!)
      if (accountRef.current !== accountId || accountScopeRef.current !== scope) return
      if (!response.success) throw new Error(response.error)
      if (response.data.delivered) {
        const status = response.data.responseStatus
        notifyToast(`「${item.name}」への試し送信が届きました${status === null ? '' : `(相手の応答 ${status})`}。`)
      } else {
        const status = response.success ? response.data.responseStatus : null
        setTestNotice(`「${item.name}」への試し送信は届きませんでした${status === null ? '' : `(相手の応答 ${status})`}。「やり取りの記録」タブで詳しく確認できます。`)
      }
      return true
    } catch (saveFailure) {
      if (accountRef.current !== accountId || accountScopeRef.current !== scope) return
      const fieldFailure = saveErrors.capture(saveFailure)
      { if (!fieldFailure)
      setTestNotice(`「${item.name}」への試し送信に失敗しました。「やり取りの記録」タブで詳しく確認できます。`) }
      return false
    } finally {
      if (accountScopeRef.current === scope) setTestingId(null)
    }
  }

  /* ===== 削除 ===== */
  const askDelete = (item: OutgoingWebhookOverview) => {
    if (!canManageWebhooksNow(true)) return
    const accountId = selectedAccountId
    if (!accountId || accountRef.current !== accountId || loadedAccountId !== accountId) {
      setError('LINEアカウントの一覧を読み直してください')
      return
    }
    setDeleteError('')
    setDeleteTarget({ id: item.id, name: item.name, confirmationRevision: item.confirmationRevision, accountId, scope: accountScopeRef.current })
  }
  const runDelete = async () => {
    if (!canManageWebhooksNow(true)) { setDeleteError(ownership.reason ?? '担当者の確認が終わるまでお待ちください。'); return }
    if (!deleteTarget || deleting) return
    if (!deleteTarget.confirmationRevision) { setDeleteError('この送り先を削除できませんでした。状態を読み直してから、もう一度お試しください。'); return }
    const accountId = deleteTarget.accountId
    if (accountId !== selectedAccountId || loadedAccountId !== accountId || deleteTarget.scope !== accountScopeRef.current) {
      setDeleteError('LINEアカウントが切り替わりました。削除する送り先を選び直してください。')
      return
    }
    setDeleting(true)
    setDeleteError('')
    try {
      const res = await api.webhooks.outgoing.delete(deleteTarget.id, accountId, deleteTarget.confirmationRevision)
      if (!res.success) throw new Error(res.error)
      if (accountRef.current !== accountId || accountScopeRef.current !== deleteTarget.scope) return
      setDeleteTarget(null)
      await reload()
    } catch (caught) {
      if (accountRef.current !== accountId || accountScopeRef.current !== deleteTarget.scope) return
      const fieldFailure = saveErrors.capture(caught);

      const forbidden = caught instanceof ApiError && caught.status === 403
      { if (!fieldFailure)
      setDeleteError(forbidden
        ? permissionDeniedMessage('store')
        : 'この送り先を削除できませんでした。状態を読み直してから、もう一度お試しください。') }
    } finally {
      if (accountScopeRef.current === deleteTarget.scope) setDeleting(false)
    }
  }

  /* ===== 合言葉（秘密の鍵）を作り直す ===== */
  const runRotate = async (stepUpToken?: string) => {
    if (!canManageWebhooksNow(true)) { setRotateError(ownership.reason ?? '担当者の確認が終わるまでお待ちください。'); return }
    const canContinue = captureWebhookWriteAccess(true)
    if (rotating) return
    setRotateError('')
    const accountId = selectedAccountId
    if (!rotateTarget) return
    if (!rotateTarget.confirmationRevision) { setRotateError('LINEアカウントの一覧を読み直してください'); return }
    if (!accountId || accountRef.current !== accountId || loadedAccountId !== accountId || rotateTarget.accountId !== accountId || rotateTarget.scope !== accountScopeRef.current) {
      setRotateTarget(null)
      setRotateSecret('')
      setError('LINEアカウントが切り替わりました。対象を選び直してください。')
      return
    }
    if (rotateSecret.length < MIN_SECRET_LENGTH) {
      setRotateError(`合言葉は${MIN_SECRET_LENGTH}文字以上にしてください`)
      return
    }
    setRotating(true)
    try {
      const res = await api.webhooks.outgoing.update(
        rotateTarget.id, accountId,
        { secret: rotateSecret, isActive: rotateTarget.activate || undefined, expectedConfirmationRevision: rotateTarget.confirmationRevision },
        stepUpToken,
      )
      if (accountRef.current !== accountId || accountScopeRef.current !== rotateTarget.scope) return
      if (!res.success) {
        setRotateError(res.error)
        return
      }
      setRotateTarget(null)
      setRotateSecret('')
      void reload()
    } catch (caught) {
      if (accountRef.current !== accountId || accountScopeRef.current !== rotateTarget.scope) return
      const fieldFailure = saveErrors.capture(caught);

      if (!stepUpToken && isStepUpRequired(caught)) {
        setStepUp({ purpose: 'webhook.secret', action: 'シークレットを更新する', retry: async (token) => { if (canContinue() && accountRef.current === accountId && accountScopeRef.current === rotateTarget.scope) return runRotate(token); setRotateError('権限やLINEアカウントが変わったため中止しました。') } });

        return
      }
      if (accountRef.current !== accountId) return
      { if (!fieldFailure)
      setRotateError(describeApiFailure(caught, 'シークレットの更新', {
        scope: 'store',
      })) }
    } finally {
      if (accountScopeRef.current === rotateTarget.scope) setRotating(false)
    }
  }

  const folderMove = useFolderMove({
    accountId: selectedAccountId, canEdit: canManage, items: visible, folders,
    permission: { canWriteNow: canManageWebhooksNow, lockedReason: management.reason },
    move: (item, folderId) => moveOutgoingWebhookToFolder(item.id, selectedAccountId!, folderId),
    onChanged: async () => { await reload(); await loadFolders() },
  })

  /* ===== 行の「設定」（操作の一覧） ===== */
  const menuItemsFor = (item: OutgoingWebhookOverview): ActionMenuItem[] => {
    const canActivate = item.hasSecret && isHttpsUrl(item.url)
    const items: ActionMenuItem[] = []
    {
      items.push({ id: 'move', label: 'フォルダへ移す', onSelect: () => folderMove.open(item) })
      items.push({ id: 'edit', label: '直す', onSelect: () => { setMenuId(null); router.push(`/webhooks/edit?id=${item.id}`) } })
      items.push({
        id: 'toggle',
        label: item.isActive ? '止める' : '動かす',
        icon: item.isActive ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />,
        disabled: !item.isActive && !canActivate,
        disabledReason: !item.isActive && !canActivate ? 'URLと合言葉を確かめてください' : undefined,
        onSelect: () => { setMenuId(null); void handleToggle(item, item.isActive) },
      })
      items.push({
        id: 'secret',
        label: '鍵を作り直す',
        onSelect: () => {
          setMenuId(null)
          setRotateError('')
          setRotateSecret('')
          setRotateTarget({ id: item.id, name: item.name, confirmationRevision: item.confirmationRevision, activate: isHttpsUrl(item.url) && !item.hasSecret, accountId: selectedAccountId ?? '', scope: accountScopeRef.current })
        },
      })
    }
    if (canTest) items.push({
      id: 'test',
      label: '試しに送る',
      disabled: !item.isActive,
      disabledReason: !item.isActive ? '止めている送り先には試し送信できません' : undefined,
      onSelect: () => { setMenuId(null); setTestNotice(''); if (selectedAccountId && loadedAccountId === selectedAccountId) setTestTarget({ item, accountId: selectedAccountId, scope: accountScopeRef.current }) },
    })
    {
      items.push({ id: 'delete', label: '削除する', tone: 'danger', dividerBefore: true, onSelect: () => { setMenuId(null); askDelete(item) } })
    }
    return items.map(item => {
      const access = item.id === 'secret' || item.id === 'delete' ? ownership : management
      return { ...item, disabled: item.disabled || (!access.allowed && !access.reason), lockedReason: access.reason }
    })
  }

  /* ===== フォルダの列 ===== */
  /* 件数は読み込んだ送り先（全件）から数える。 */
  const folderCountOf = (folder: Folder) => (ready ? displayed.filter((item) => item.folderId === folder.id).length : null)
  const folderSelect = (
    <SaveErrorField names={["folderFilter","folder_filter"]}><Select
      narrowFolderPicker aria-label="フォルダ"
      value={folderFilter}
      onChange={(value) => setFolderFilter(value)}
      options={managedFolderOptions('webhook', folders, { allId: '', unfiledId: UNFILED })}
    /></SaveErrorField>
  )
  /* 作れない人には押せない［送り先を作る］を薄く置き、乗せると理由を出す。 */
  const createButton = <Button variant="primary" lockedReason={management.reason} {...(canManage ? { href: '/webhooks/new' } : { disabled: true })}><Plus size={16} aria-hidden="true" />送り先を作る</Button>

  /* ===== 道具の段 ===== */
  const chips = (
    <SegmentedControl
      aria-label="状態で絞り込む"
      value={chip}
      onChange={setChip}
      options={[
        { value: '', label: 'すべて' },
        { value: 'active', label: '動いている', count: ready ? activeCount : undefined },
        { value: 'paused', label: '止めている', count: ready ? pausedCount : undefined },
      ]}
    />
  )
  /* 絵に並びの部品は無い。並びは「よく使う絞り込み」の中で選ぶ（機能は残す）。 */
  const savedBox = (
      <SaveErrorField names={["chip","sortKey","sort_key"]}><Select size="content" icon={<Bookmark size={16} aria-hidden="true" />} showChevron={false}
        aria-label="よく使う絞り込み"
        value={chip}
        onChange={(value) => {
          if (value === 'sort-volume') setSortKey('volume')
          else if (value === 'sort-name') setSortKey('name')
          else setChip(value as SavedFilter)
        }}
        options={[
          { value: '', label: 'よく使う絞り込み' },
          { value: 'active', label: '動いているのみ' },
          { value: 'paused', label: '止めているのみ' },
          { value: 'failed', label: '失敗あり' },
          { value: sortKey === 'volume' ? 'sort-name' : 'sort-volume', label: sortKey === 'volume' ? '名前順に並べる' : '送った回数が多い順に並べる' },
        ]}
      /></SaveErrorField>
  )
  const perPage = <PageSizeSelect value={pageSize} onChange={setPageSize} options={[10, 20, 50]} label={null} />
  const notice = (
    null
  )
  const searchBox = (
    <SearchField
      value={query}
      onChange={(value) => setQuery(value)}
      onClear={() => setQuery('')}
      placeholder="つなぎ先で探す"
      aria-label="つなぎ先で探す"
    />
  )
  /* 1152 の板：案内の帯 → 1段目「作る・フォルダ・探す」→ 2段目「札 … よく使う絞り込み・件数」。 */

  const wideToolbar = (
    <>

      <ListToolbar
        search={{ placeholder: 'つなぎ先で探す', label: 'つなぎ先で探す', width: 240, value: query, onChange: setQuery }}
        filters={chips}
        trailing={<>{savedBox}{perPage}</>}
      />
    </>
  )

  /* ===== 表 ===== */
  let listBody
  if (outgoingStatus === 'loading' && selectedAccountId) {
    listBody = (
      <div aria-busy="true" aria-label="送り先を読み込んでいます">
        <DelayedSkeleton
          loading
          skeleton={(
            <div aria-hidden="true">
              {[0, 1, 2, 3].map((row) => (
                <div key={row} className={styles.skeletonRow}>
                  <Skeleton className={styles.skeletonDot} />
                  <Skeleton className={styles.skeletonBar} />
                  <Skeleton className={styles.skeletonBar} />
                  <Skeleton className={styles.skeletonBar} />
                  <Skeleton className={styles.skeletonBar} />
                </div>
              ))}
            </div>
          )}
        />
      </div>
    )
  } else if (!selectedAccountId) {
    listBody = <AccountRequiredState hasAccounts={accounts.length > 0} />
  } else if (outgoingStatus === 'error') {
    listBody = (
      <ListState
        kind="error"
        title="送り先を読み込めませんでした"
        description="登録内容は消えていません。通信の状態を確認して、もう一度お試しください。"
        onRetry={() => void reload()}
      />
    )
  } else if (visible.length === 0) {
    /* 修正案 D-2：空の一覧。 */
    listBody = (
      <EmptyList
        icon={<Send aria-hidden="true" />}
        title="まだ送り先がありません"
        description="友だちの動きを、ほかのシステムへ自動で知らせます。"
        create={{ label: '最初の送り先を作る', href: '/webhooks/new' }}
        canCreate={canManage}
        lockedReason={management.reason ?? null}
        filtered={displayed.length > 0}
        onClearFilters={filterActive ? clearFilters : undefined}
        filteredDescription="検索や絞り込みを外すと、すべて出ます"
      />
    )
  } else {
    listBody = (
      <>
        <ContextMenu
          label="送り先の操作"
          items={(() => {
            const target = visible.find((item) => item.id === ctxId) ?? visible[0]
            return target ? menuItemsFor(target).map((menuItem) => ({
              id: menuItem.id,
              label: menuItem.label,
              danger: menuItem.tone === 'danger',
              disabled: menuItem.disabled,
              onSelect: () => menuItem.onSelect?.(),
            })) : []
          })()}
          shouldOpen={(event) => {
            const row = (event.target as HTMLElement).closest('tr[data-row-id]')
            if (!row) return false
            setCtxId(row.getAttribute('data-row-id'))
            return true
          }}
        >
        <div className={styles.tableWrap}>
          <DataTable columnSizing="content" columnLayout={{ headHeight: 'var(--tpl-wh-head-h)', rowHeight: 'var(--tpl-list-row-h)', gap: 'var(--tpl-wh-col-gap)', padding: '0 var(--tpl-list-inset)', numberInset: 'var(--tpl-wh-num-pad-end)' }}>
            <thead>
              {narrow ? (
                /* 1152 の絵 ：送り先・今月送った・状態・操作の4列。 */
                <TableHeadRow data-table-layout="columns">
                  <Th grow inset="var(--tpl-folder-dot-indent)" className={styles.colName}>{folderMove.pageCheckbox}送り先（送るタイミング → URL）</Th>
                  <Th className={styles.colMonth}>今月送った</Th>
                  <Th className={styles.colStateNarrow}>状態</Th>
                  <Th className={styles.colOpsNarrow}>操作</Th>
                </TableHeadRow>
              ) : (
              <TableHeadRow data-table-layout="columns">
                <Th grow className={styles.colName}>{folderMove.pageCheckbox}つなぎ先</Th>
                <Th className={styles.colWhen}>いつ送るか</Th>
                <Th className={styles.colPayload}>送るもの</Th>
                <Th align="right" className={styles.colCount}>この30日</Th>
                <Th className={styles.colState}>ようす</Th>
                <Th className={styles.colOps}>操作</Th>
              </TableHeadRow>
              )}
            </thead>
            <tbody>
              {visible.map((item) => {
                const toggling = togglingIds.includes(item.id)
                const failing = isFailing(item)
                const completedAt = item.deliverySummary.lastResult?.completedAt
                const when = eventLabel(item.eventTypes)
                const payload = payloadLabel(item.eventTypes)
                const menuItems = menuItemsFor(item)
                const tone = toggling ? 'neutral' : failing ? 'danger' : item.isActive ? 'active' : 'neutral'
                const stateWord = toggling ? '切り替え中' : failing ? '失敗あり' : item.isActive ? '有効' : '停止中'
                const nameNode = (
                  <FolderDotName folder={folderDotFor(folders, item.folderId)}>{folderMove.checkbox(item)}
                    {canManage ? (
                      <RowNameLink href={`/webhooks/edit?id=${item.id}`} className={styles.name} ><TruncatedText value={String(item.name ?? '')} /></RowNameLink>
                    ) : (
                      <TruncatedText value={String(item.name ?? '')} />
                    )}
                  </FolderDotName>
                )
                if (narrow) {
                  const target = `${when} → ${urlHost(item.url)}`
                  const countSub = item.deliverySummary.failed > 0
                    ? `失敗 ${formatNumber(item.deliverySummary.failed)}`
                    : completedAt ? `最後 ${shortDateTime(completedAt)}` : null
                  return (
                    <Tr key={item.id} data-table-layout="columns" data-row-id={item.id}>
                      <Td grow className={styles.colName}>{nameNode}</Td>
                      <Td className={styles.colMonth}>
                        <span className={styles.num}>{`${formatNumber(item.deliverySummary.total)} 回`}</span>
                        {countSub ? <span className={styles.numSub}>{countSub}</span> : null}
                      </Td>
                      <Td className={styles.colStateNarrow}>
                        <StatusBadge tone={tone === 'active' ? 'success' : tone}>{stateWord}</StatusBadge>
                      </Td>
                      <ActionCell>
                        {/* 狭い幅は「…」だけ（中身を見る・やり直すも中に入れる。絵 AsfFB の下の説明のとおり）。 */}
                        <div className={styles.opsBox}>
                          <RowMenu
                            label={`「${item.name}」の操作`}
                            title="操作"
                            open={menuId === item.id}
                            onOpenChange={(next) => setMenuId(next ? item.id : null)}
                            items={[
                              { id: 'view', label: "送信の記録を見る", onSelect: () => { setMenuId(null); router.replace('/webhooks?tab=interactions') } },
                              ...(item.deliverySummary.canRetry && canManage
                                ? [{ id: 'retry', label: '失敗をやり直す', onSelect: () => { setMenuId(null); router.replace('/webhooks?tab=interactions') } }]
                                : []),
                              ...menuItems,
                            ]}
                            note={canManage ? undefined : MANAGE_REASON}
                          />
                        </div>
                      </ActionCell>
                    </Tr>
                  )
                }
                return (
                  <Tr selected={folderMove.isSelected(item.id)} key={item.id} data-table-layout="columns" data-row-id={item.id} href={`/webhooks/edit?id=${item.id}`}>
                    <Td grow className={styles.colName}>
                      {/* 名前の前に左の列と同じフォルダの色の丸（未分類は色の無い輪）。 */}
                      <FolderDotName folder={folderDotFor(folders, item.folderId)}>{folderMove.checkbox(item)}
                        {canManage ? (
                          <RowNameLink href={`/webhooks/edit?id=${item.id}`} className={styles.name} ><TruncatedText value={String(item.name ?? '')} /></RowNameLink>
                        ) : (
                          <TruncatedText value={String(item.name ?? '')} />
                        )}
                      </FolderDotName>

                    </Td>
                    <Td className={styles.colWhen}><TruncatedText value={when} /></Td>
                    <Td className={styles.colPayload}><TruncatedText value={payload} /></Td>
                    <Td align="right" className={styles.colCount}>
                      <span className={styles.num}>{formatNumber(item.deliverySummary.total)} 回</span>
                      <span className={styles.numSub}>
                        {item.deliverySummary.failed > 0
                          ? `失敗 ${formatNumber(item.deliverySummary.failed)} 回`
                          : `送信中 ${formatNumber(item.deliverySummary.pending)} 回`}
                      </span>
                    </Td>
                    <Td className={styles.colState}>
                      <StatusBadge tone={tone === 'active' ? 'success' : tone}>{stateWord}</StatusBadge>
                      {completedAt
                        ? <span className={styles.sub}>最終 {shortDateTime(completedAt)}</span>
                        : item.isActive && !toggling ? <span className={styles.sub}>まだ送っていません</span> : null}
                    </Td>
                    <ActionCell className={styles.colOps}>
                      {/* 行の右端は「…」だけ（B-253）。中身を見る・やり直すも中に入れる。見るだけの担当者にも出す。 */}
                      <div className={styles.opsBox}>
                        <RowMenu
                          label={`「${item.name}」の操作`}
                          title="操作"
                          open={menuId === item.id}
                          onOpenChange={(next) => setMenuId(next ? item.id : null)}
                          items={[
                            { id: 'view', label: '送信の記録を見る', onSelect: () => { setMenuId(null); router.replace('/webhooks?tab=interactions') } },
                            ...(item.deliverySummary.canRetry && canManage
                              ? [{ id: 'retry', label: '失敗をやり直す', onSelect: () => { setMenuId(null); router.replace('/webhooks?tab=interactions') } }]
                              : []),
                            ...menuItems,
                          ]}
                          note={canManage ? undefined : MANAGE_REASON}
                        />
                      </div>
                    </ActionCell>
                  </Tr>
                )
              })}
            </tbody>
          </DataTable>
        </div>
        </ContextMenu>
      </>
    )
  }

  const pager = ready && visible.length > 0 ? (
    <ListPagePagination>
      <Pagination page={currentPage} pageCount={pageCount} onPageChange={setPage} ariaLabel="送り先一覧のページ送り" range={{ total: filtered.length, first: (currentPage - 1) * pageSize + 1, last: (currentPage - 1) * pageSize + visible.length }} />
    </ListPagePagination>
  ) : null

  return (
    <SaveErrorScope errors={saveErrors}><ListPage
      skeleton
      help={<>{WEBHOOKS_DESCRIPTION}{narrow
          ? '行の「…」から 中身を見る・試しに送る・失敗をやり直す・鍵を作り直す・止める・削除。'
          : '行の「…」から 送信の記録を見る・直す・止める・鍵を作り直す・試しに送る・失敗をやり直す・削除。'}</>}
      explanation="友だちの動きを、決めたタイミングでほかのシステムへ送ります。送るときは秘密の鍵を付けます。鍵は「…」から作り直せます。"
      boardId={narrow ? 'AsfFB' : 'ZSbFY'}
      headingSize="regular"
      title="外部連携"

      actions={<Button lockedReason={management.reason} {...(canManage ? { href: "/webhooks?tab=notify" } : { disabled: true })}><LayoutTemplate size={16} aria-hidden="true" />見本から作る</Button>}
      tabs={<WebhookTabs active="outgoing" outgoingCount={overview.outgoingCount} incomingCount={overview.incomingCount} />}
      stats={<>
        {management.known && !canManage ? <ViewerBand /> : null}
        <WebhookBand
          cells={overviewBandCells({
            outgoing: ready ? displayed : null,
            incomingCount: overview.incomingCount,
            summary,
          })}
        />
      </>}
      folders={<>
        {createButton}
        <ManagedFolderPanel
          kind="webhook"
          accountId={selectedAccountId}
          folders={folders}
          onChanged={loadFolders}
          canManage={canManage}
          itemLabel="送り先"
          activeId={folderFilter}
          onSelect={setFolderFilter}
          allId=""
          unfiledId={UNFILED}
          allCount={ready ? displayed.length : null}
          unfiledCount={ready ? displayed.filter((item) => !item.folderId).length : null}
          countOf={folderCountOf}
          placeholder="例：顧客・会員"
        />
      </>}
      collapsedFolders={<>{createButton}{folderSelect}</>}
      toolbar={wideToolbar}
      pagination={pager}
      overlays={<>
        {folderMove.overlays}
        <ConfirmDialog
          open={testTarget !== null && testTarget.scope === accountScopeRef.current}
          title="試し送信をします"
          description={testTarget ? `「${testTarget.item.name}」へ、試し用のデータを1回だけ送ります。実際の連携先へ届きます。` : ''}
          confirmLabel="この送り先へ送る"
          cancelLabel="キャンセル"
          busy={testingId !== null}
          error={testNotice || undefined} onSuccess={() => setTestTarget(null)} onConfirm={() => testTarget ? runTest(testTarget.item, testTarget.accountId, testTarget.scope) : undefined}
          onCancel={() => setTestTarget(null)}
        >
          {testTarget ? (
            <><OperationTargetSummary accounts={[{ id: testTarget.accountId }]} /><div className={styles.urlBox}>
              <p className={styles.urlLabel}>送り先のURL</p>
              <code className={styles.urlValue}>{testTarget.item.url}</code>
            </div></>
          ) : null}
        </ConfirmDialog>
        <ConfirmDialog
          open={deleteTarget !== null}
          title={`送り先「${deleteTarget?.name ?? ''}」を削除しますか？`}
          description="この宛先への送信が止まり、これから起きる出来事は通知されなくなります。すでに送った記録は残ります。この操作は取り消せません。"
          confirmLabel="削除する"
          confirmDisabled={!ownership.allowed}
          confirmLockedReason={ownership.reason}
          destructive
          busy={deleting}
          error={deleteError || undefined}
          onConfirm={() => runDelete()}
          onCancel={() => {
            if (deleting) return
            setDeleteTarget(null)
            setDeleteError('')
          }}
        >
          {deleteTarget ? <OperationTargetSummary accounts={[{ id: deleteTarget.accountId }]} /> : null}
        </ConfirmDialog>
        <Dialog
          open={rotateTarget !== null}
          busy={rotating}
          title={rotateTarget ? `「${rotateTarget.name}」の鍵を${rotateTarget.activate ? '設定して動かす' : '作り直す'}` : ''}
          description="新しい鍵（合言葉）を設定します。保存したあとは二度と全部は表示されません。前の鍵は24時間だけ使えるので、相手側の切り替え中も送信は止まりません。"
          error={rotateError || undefined}
          onCancel={() => { setRotateTarget(null); setRotateSecret('') }}
          onConfirm={() => runRotate()}
          confirmLabel="保存する"
          confirmDisabled={!ownership.allowed}
          confirmLockedReason={ownership.reason}
        >
          {rotateTarget ? <OperationTargetSummary accounts={[{ id: rotateTarget.accountId }]} /> : null}
          <div className={styles.secretRow}>
            <SaveErrorField names={["rotateSecret","secret","rotate_secret"]}><TextField
              value={rotateSecret}
              onChange={(event) => setRotateSecret(event.target.value)}
              placeholder="ランダムな英数字32文字以上"
              aria-label="新しい鍵"
              minLength={MIN_SECRET_LENGTH}
              autoFocus
            /></SaveErrorField>
            <Button type="button" onClick={() => setRotateSecret(generateSecret())}>自動生成</Button>
          </div>
        </Dialog>
        <OverlayDepthContext.Provider value={depth + 2}><UnsavedLeaveDialog open={guard.leaveTarget !== null} busy={rotating} onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} /></OverlayDepthContext.Provider>
        {stepUp ? <StepUpPrompt request={stepUp} onDone={() => setStepUp(null)} onClose={() => setStepUp(null)} /> : null}
      </>}
    >
      {error ? <div className={styles.errorRow}><Notice tone="danger" message={error} onClose={() => setError('')} /></div> : null}
      {testNotice ? <div className={styles.errorRow}><Notice tone="danger" message={testNotice} onClose={() => setTestNotice(null)} /></div> : null}
      {listBody}
    </ListPage></SaveErrorScope>
  )
}
