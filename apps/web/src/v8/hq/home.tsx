'use client'

import { tokenExpiryBadge, tokenExpirySummary } from '@/lib/line-account-state'

import { KpiValueMotionProvider } from '@/components/shared/kpi-value-motion'
import { jstDate } from '@/lib/jst-datetime'
import { DataTable, Tr, Th, Td, PersonCell, TableHeadRow } from '@/components/shared/table';
import { useListUrlValue } from '@/components/shared/list-url-state';
import Link from 'next/link';
import { Folder as FolderIcon, Inbox, LayoutGrid, List, LogIn, Pencil, Plus, RotateCcw, Settings, MessageCircle } from 'lucide-react';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { OverlayDepthContext } from '@/components/shared/overlay-utils'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation';
import { ListPage, ListPageCards } from '@/components/templates';
import Card from '@/components/shared/card';
import { ListToolbarFrame, ListToolbarRow, ListToolbarEnd } from '@/components/shared/list-toolbar';
import KpiBand from '@/components/shared/kpi-band';
import KpiCard from '@/components/shared/kpi-card';
import Button, { AccountActionButton } from '@/components/shared/button';
import Avatar from '@/components/shared/avatar';
import { RowMenu } from '@/components/shared/row-actions';
import { FolderDot, FolderDotName, folderDisplayColor } from '@/components/shared/folder-dot';
import EmptyList from '@/components/shared/empty-list';
import ConfirmDialog from '@/components/shared/confirm-dialog';
import OperationTargetSummary from '@/components/shared/operation-target-summary';
import FolderPanel, { type FolderPanelRow } from '@/components/shared/folder-panel';
import ListState from '@/components/shared/list-state';
import Notice from '@/components/shared/notice';
import Pagination from '@/components/shared/pagination';
import SearchField from '@/components/shared/search-field';
import SegmentedControl from '@/components/shared/segmented';
import Select from '@/components/shared/select';
import FolderEditorDialog from '@/components/shared/folder-editor-dialog';
import { describeApiFailure, classifyApiFailure, loadFailureNotice } from '@/components/shared/api-error-message';
import { usePageTitle } from '@/components/shell/page-chrome';
import AccountEditModal from '@/components/accounts/account-edit-modal';
import PlatformNotices from '@/components/hq/platform-notices';
import { accountIconUrl } from '@/components/hq/account-list';
import { api, ApiError, bookingApi, fetchApi } from '@/lib/api';
import { FOLDER_SELECT_COLORS, type Folder } from '@line-crm/shared';
import { resolveStoreReturnPath } from '@/lib/hq-navigation';
import { formatNumber } from '@/lib/format';
import { useStaffRole, canManageRole } from '@/lib/staff-role';
import { readSessionSnapshot } from '@/lib/session-snapshot';
import { useAccount, type AccountWithStats } from '@/contexts/account-context';
import { AccountArchiveDialogV8, AccountRestoreDialogV8, AccountSettingsDialogV8 } from './account-dialogs';
import { connectionNoticeLine } from './connection-reasons';
import styles from './home.module.css';
import { DEFAULT_TAG_FOLDER_COLOR } from '@/v8/tags/public/folder-colors/index'
import StatusBadge from '@/components/shared/status-badge';
import IconLabel from '@/components/shared/icon-label';
import TagPill from '@/components/shared/tag-pill';
import TagOverflow from '@/components/shared/tag-overflow';
import TruncatedText from '@/components/shared/truncated-text';
import { emptyValue } from '@/components/shared/empty-value';
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors';
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import { type StatusFilter, type View, UNFILED, ALL, STATUS_FILTERS, SORT_OPTIONS, PAGE_SIZES, isArchived, matchesStatus, statusOf, accountMeta } from "./home-gap-parts"
function accountFriendCount(account: AccountWithStats) {
  const count = account.stats?.friendCount
  return typeof count !== 'number' || (isArchived(account) && count === 0) ? emptyValue('unknown') : formatNumber(count)
}

export default function HqHomeV8() {
  const saveErrors = useSaveFormErrors()
  // 左のメニューと同じ名前を見出しにする（バナー生成・課金プランなどと同じ書き方）。
  usePageTitle('アカウント')
  const router = useRouter()
  const role = useStaffRole()
  /*
   * 運営が「閲覧のみ」で代理ログインしているあいだは、役割がオーナーでも変える口を出さない。
   * サーバも書き込みを断る。決まり：閲覧のみには押せないボタンを置かず隠す（2026-10-06）。
   */
  const readOnlyImpersonation = readSessionSnapshot()?.impersonation?.mode === 'read'
  const canManage = !readOnlyImpersonation && (canManageRole(role))
  const manageLockReason = usePermissionLockReason(canManage, 'tenantWide')
  const isOwner = !readOnlyImpersonation && role === 'owner'
  const restoreLockReason = usePermissionLockReason(isOwner, 'owner')
  const restoreOwnerRef = useRef(isOwner)
  restoreOwnerRef.current = isOwner
  const { accounts: shellAccounts, setSelectedAccountId, refreshAccounts } = useAccount()
  const [snapshotAccounts, setAccounts] = useState<AccountWithStats[]>([])
  // 統括カードは独自に一覧を持つため、共通ヘッダーが取得した最新の
  // LINE公式アカウント画像もカード・表へ反映する。
  const accounts = useMemo(() => {
    const pictures = new Map(shellAccounts.map((account) => [account.id, account.pictureUrl ?? null]))
    return snapshotAccounts.map((account) => {
      if (!pictures.has(account.id)) return account
      const pictureUrl = pictures.get(account.id) ?? null
      return account.pictureUrl === pictureUrl ? account : { ...account, pictureUrl }
    })
  }, [shellAccounts, snapshotAccounts])
  const currentAccounts = useMemo(() => accounts.filter((account) => !isArchived(account)), [accounts])
  const [tenantName, setTenantName] = useState('')
  const [loading, setLoading] = useState(true)
  // M021：捕まえた失敗を持ち、共通部品へ渡す（403 は権限の案内になる）。
  const [loadError, setLoadError] = useState<unknown>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [attentionCounts, setAttentionCounts] = useState<Record<string, number> | null>(null)
  const [attentionTotals, setAttentionTotals] = useState<Record<string, number> | null>(null)
  const [attentionKey, setAttentionKey] = useState(0)
  const [attentionError, setAttentionError] = useState<unknown>(null)
  const [attentionRefreshing, setAttentionRefreshing] = useState(false)
  const attentionEpoch = useRef(0)
  const [editingAccount, setEditingAccount] = useState<AccountWithStats | null>(null)
  const [settingsAccount, setSettingsAccount] = useState<AccountWithStats | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<{ account: AccountWithStats; mode: 'archive' | 'restore' } | null>(null)
  const [checkingConnections, setCheckingConnections] = useState(false)
  const [connectionProgress, setConnectionProgress] = useState('')
  const connectionUpdateInFlight = useRef(false)
  const [connectionResult, setConnectionResult] = useState<{ tone: 'success' | 'danger'; message: string; needsReload: boolean } | null>(null)

  const [query, setQuery] = useListUrlValue('q', '')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [folder, setFolder] = useState<string>(ALL)
  const [view, setView] = useListUrlValue<View>('view', 'cards')
  const [sort, setSort] = useListUrlValue('sort', 'friends')
  const [size, setSize] = useState(20)
  const [page, setPage] = useListUrlValue('page', 1)
  const [folders, setFolders] = useState<(Folder & { itemCount?: number })[]>([])
  /* フォルダの追加・名前と色を変える窓（同じ窓。editing があれば変える）。 */
  const [folderDialog, setFolderDialog] = useState<{ editing: Folder | null } | null>(null)
  const [folderName, setFolderName] = useState('')
  const [folderColor, setFolderColor] = useState<string | null>(null)
  const [deleteFolder, setDeleteFolder] = useState<(Folder & { itemCount?: number }) | null>(null)
  const folderDeleteTicket = useRef<object | null>(null)
  const renderedFolderDeleteTicket = folderDeleteTicket.current
  const folderDeleteLock = useRef(false)
  const [folderError, setFolderError] = useState('')
  const [folderNameError, setFolderNameError] = useState('')
  const [folderSaving, setFolderSaving] = useState(false)
  const depth = useContext(OverlayDepthContext)
  const folderGuard = useUnsavedGuard({
    dirty: folderDialog !== null && (folderName !== (folderDialog.editing?.name ?? '') || folderColor !== (folderDialog.editing ? folderDisplayColor(folderDialog.editing) : DEFAULT_TAG_FOLDER_COLOR) || folderSaving),
    busy: folderDialog !== null && folderSaving,
    onDiscard: () => setFolderDialog(null),
  })

  const load = useCallback(async () => {
    setLoadError(null)
    const accountResponse = await api.lineAccounts.list()
    if (!accountResponse.success) throw new Error(accountResponse.error)
    setAccounts(accountResponse.data as AccountWithStats[])
  }, [])

  const loadFolders = useCallback(async () => {
    try {
      const res = await api.lineAccountFolders.list()
      if (res.success && Array.isArray(res.data?.folders)) {
        setFolders([...res.data.folders].sort((a, b) => a.displayOrder - b.displayOrder))
      }
    } catch (saveFailure) {
      saveErrors.capture(saveFailure)
      // フォルダが読めなくても一覧は出す
    }
  }, [saveErrors])

  useEffect(() => {
    let cancelled = false
    void load()
      .catch((caught: unknown) => { if (!cancelled) setLoadError(caught) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [load, reloadKey])

  useEffect(() => {
    let cancelled = false
    const epoch = attentionEpoch.current
    setAttentionCounts(null)
    setAttentionTotals(null)
    setAttentionError(null)
    void import('@/lib/api/helpers/styles').then(({ hqStyleApi }) => hqStyleApi.attention(attentionKey || reloadKey ? { cache: 'reload' } : undefined)).then((result) => {
      if (cancelled || epoch !== attentionEpoch.current) return
      if (!result.success) { setAttentionError(new Error('attention failed')); return }
      const counts: Record<string, number> = {}
      const totals: Record<string, number> = {}
      for (const item of result.data.items) {
        const value = item.counts.connections
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) counts[item.accountId] = value
        const parts = [item.counts.unhandledChats, item.counts.pendingBookings, item.counts.unpaid, item.counts.connections, item.counts.stoppedDeliveries]
        if (parts.every(part => typeof part === 'number' && Number.isFinite(part) && part >= 0)) totals[item.accountId] = parts.reduce((sum, part) => sum + part, 0)
      }
      setAttentionCounts(counts)
      setAttentionTotals(totals)
    }).catch((error: unknown) => { if (!cancelled && epoch === attentionEpoch.current) setAttentionError(error ?? new Error('attention failed')) })
    return () => { cancelled = true }
  }, [reloadKey, attentionKey])

  useEffect(() => {
    void loadFolders()
    let cancelled = false
    void api.tenants.me().then((res) => {
      if (!cancelled && res.success) setTenantName(res.data.name ?? '')
    }).catch(() => {})
    return () => { cancelled = true }
  }, [loadFolders])

  /*
   * WEB215：保存のあとの読み直しが失敗しても、黙って捨てない（保存そのものは済んでいる）。
   * 読み直せなかったことを知らせ、もう一度読み直せるようにする。
   */
  const [reloadFailed, setReloadFailed] = useState(false)
  const reloadAfterSave = async () => {
    setReloadFailed(false)
    attentionEpoch.current += 1
    setAttentionCounts(null)
    setAttentionTotals(null)
    setAttentionError(null)
    setAttentionRefreshing(true)
    try {
      await Promise.all([load(), refreshAccounts(), loadFolders()])
    } catch (saveFailure) {
      saveErrors.capture(saveFailure)
      setReloadFailed(true)
    } finally {
      setAttentionRefreshing(false)
      setAttentionKey(key => key + 1)
    }
  }

  const reloadConnections = async () => {
    if (connectionUpdateInFlight.current) return
    connectionUpdateInFlight.current = true
    setCheckingConnections(true)
    attentionEpoch.current += 1
    setAttentionCounts(null)
    setAttentionTotals(null)
    setAttentionError(null)
    setAttentionRefreshing(true)
    try {
      await Promise.all([load(), refreshAccounts()])
      setConnectionResult(null)
    } catch (saveFailure) {
      saveErrors.capture(saveFailure)
    } finally {
      setAttentionRefreshing(false)
      setAttentionKey(key => key + 1)
      connectionUpdateInFlight.current = false
      setCheckingConnections(false)
    }
  }

  const refreshConnectionInfo = async (target?: AccountWithStats) => {
    if (!canManage || connectionUpdateInFlight.current || (target && isArchived(target))) return
    const targets = target ? [target] : accounts.filter(account => !isArchived(account))
    if (targets.length === 0) return
    connectionUpdateInFlight.current = true
    setCheckingConnections(true)
    attentionEpoch.current += 1
    setAttentionCounts(null)
    setAttentionTotals(null)
    setAttentionError(null)
    setAttentionRefreshing(true)
    setConnectionResult(null)
    let succeeded = 0
    const failed: string[] = []
    for (const [index, account] of targets.entries()) {
      setConnectionProgress(`接続情報を更新中（${index + 1}/${targets.length}）`)
      const expectedRevision = account.revision
      if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
        failed.push(account.displayName || account.name)
        continue
      }
      try {
        const response = await fetchApi<{ success: boolean; error?: string }>(`/api/line-accounts/${encodeURIComponent(account.id)}/connection-checks`, {
          method: 'POST',
          headers: { 'Idempotency-Key': `hq-check-${account.id}-${crypto.randomUUID()}` },
          body: JSON.stringify({ expectedRevision }),
        })
        if (!response.success) throw new Error(response.error || '接続情報を更新できませんでした')
        succeeded += 1
      } catch (saveFailure) {
        saveErrors.capture(saveFailure)
        failed.push(account.displayName || account.name)
      }
    }
    let message = failed.length > 0
      ? `${failed.join('、')}の接続情報を更新できませんでした。${formatNumber(succeeded)} 件を更新しました。`
      : `${formatNumber(succeeded)} 件のLINE IDと接続状態を更新しました。`
    let needsReload = false
    try {
      await Promise.all([load(), refreshAccounts()])
    } catch (saveFailure) {
      saveErrors.capture(saveFailure)
      needsReload = true
      message += ' 一覧を再読み込みできませんでした。もう一度読み込んでください。'
    } finally {
      setAttentionRefreshing(false)
      setAttentionKey(key => key + 1)
      setConnectionResult({ tone: failed.length > 0 || needsReload ? 'danger' : 'success', message, needsReload })
      setConnectionProgress('')
      connectionUpdateInFlight.current = false
      setCheckingConnections(false)
    }
  }

  const [enteringAccountId, setEnteringAccountId] = useState<string | null>(null)
  const login = async (accountId: string) => {
    if (enteringAccountId) return
    setEnteringAccountId(accountId)
    try {
      // 保存済みの引き継ぎ状態を毎回確認する。未完了・確認失敗時に店舗へ入れない。
      const response = await api.lineAccounts.followerImportState(accountId)
      if (!response.success) throw new Error(response.error || '引き継ぎの状態を確認できませんでした')
      if (response.data.phase === 'importing_ids' || response.data.phase === 'hydrating_profiles') {
        router.push(`/accounts/new/handover?accountId=${encodeURIComponent(accountId)}`)
        return
      }
    } catch (failure) {
      saveErrors.capture(failure)
      router.push(`/accounts/new/handover?accountId=${encodeURIComponent(accountId)}`)
      return
    } finally {
      setEnteringAccountId(null)
    }
    setSelectedAccountId(accountId)
    // 店舗未選択ゲートから来たときは、元いた画面へ戻す（`return` はアプリ内の店舗画面パスだけ：NEXT-07）。
    const back = resolveStoreReturnPath(new URLSearchParams(window.location.search).get('return'))
    router.push(back ?? '/')
  }

  const accountsReadable = !loading && !loadError
  const totals = useMemo(() => currentAccounts.reduce<{ friends: number | null; messages: number | null; warnings: number; unconfirmed: number }>((sum, account) => ({
    friends: sum.friends !== null && typeof account.stats?.friendCount === 'number' ? sum.friends + account.stats.friendCount : null,
    messages: sum.messages !== null && typeof account.stats?.messagesThisMonth === 'number' ? sum.messages + account.stats.messagesThisMonth : null,
    warnings: sum.warnings + (statusOf(account).tone === 'warn' ? 1 : 0),
    unconfirmed: sum.unconfirmed + (statusOf(account).label === '未確認' ? 1 : 0),
  }), { friends: 0, messages: 0, warnings: 0, unconfirmed: 0 }), [currentAccounts])

  const connectionUnconfirmed = attentionCounts ? currentAccounts.filter(account => {
    const state = statusOf(account).label
    return state !== '停止中' && (state === '未確認' || attentionCounts[account.id] === undefined)
  }).length : 0
  const knownConnectionTotal = attentionCounts
    ? currentAccounts.reduce((sum, account) => sum + (attentionCounts[account.id] ?? 0), 0) : null
  const connectionTotal = knownConnectionTotal === 0 && connectionUnconfirmed > 0 ? null : knownConnectionTotal
  const connectionDetail = loadError || attentionError ? '読み込めませんでした'
    : connectionUnconfirmed ? `${knownConnectionTotal ? 'ほかに' : ''}未確認 ${formatNumber(connectionUnconfirmed)} 件`
      : connectionTotal === null ? '接続の問題を確認できません' : null

  /* 所属は1つ。アーカイブを除く同じ一覧で、すべて・フォルダ・未分類を数える。 */
  const folderOf = useCallback((account: AccountWithStats) => (account as { folderId?: string | null }).folderId ?? null, [])
  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const account of currentAccounts) {
      const id = folderOf(account)
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    return counts
  }, [currentAccounts, folderOf])
  const localUnfiled = useMemo(() => currentAccounts.filter((account) => !folderOf(account)).length, [currentAccounts, folderOf])

  const filtered = useMemo(() => {
    const words = query.trim().toLocaleLowerCase()
    const list = accounts.filter((account) => {
      if (!matchesStatus(account, status)) return false
      if (folder === UNFILED && folderOf(account)) return false
      if (folder !== ALL && folder !== UNFILED && folderOf(account) !== folder) return false
      if (!words) return true
      const hay = [account.name, account.displayName, account.basicId, account.channelId, folders.find((item) => item.id === folderOf(account))?.name]
      return hay.some((text) => text?.toLocaleLowerCase().includes(words))
    })
    return [...list].sort((a, b) =>
      sort === 'name'
        ? (a.displayName || a.name).localeCompare(b.displayName || b.name, 'ja')
        : sort === 'display'
          ? a.displayOrder - b.displayOrder
          : (b.stats?.friendCount ?? 0) - (a.stats?.friendCount ?? 0),
    )
  }, [accounts, status, folder, folderOf, folders, query, sort])

  const pageCount = Math.max(1, Math.ceil(filtered.length / size))
  const current = Math.min(page, pageCount)
  const shown = filtered.slice((current - 1) * size, current * size)
  /* ★V8 oFq4S：表の「接続」（お支払いのつなぎ：つながっている／試験モード／つなぐ前）。表の行だけ、店ごとに読む。 */
  const [payState, setPayState] = useState<Record<string, 'live' | 'test' | 'none' | 'unknown'>>({})
  const shownIds = shown.map((account) => account.id).join(',')
  useEffect(() => {
    if (view !== 'table' || !shownIds) return
    let alive = true
    void Promise.allSettled(shownIds.split(',').map((id) => bookingApi.getPaymentConfig(id).then((response) => [id, response.data] as const))).then((results) => {
      if (!alive) return
      const next: Record<string, 'live' | 'test' | 'none' | 'unknown'> = {}
      results.forEach((result, index) => {
        const id = shownIds.split(',')[index]
        next[id] = result.status === 'fulfilled' ? (result.value[1].keyConfigured ? (result.value[1].testMode ? 'test' : 'live') : 'none') : 'unknown'
      })
      setPayState((current) => ({ ...current, ...next }))
    })
    return () => { alive = false }
  }, [view, shownIds])
  const resetPage = () => setPage(1)
  const statusCount = (filter: StatusFilter) => accounts.filter((account) => matchesStatus(account, filter)).length
  const nameOf = (id: string | null | undefined) => {
    if (!id) return null
    const found = accounts.find((account) => account.id === id)
    return found ? (found.displayName || found.name) : null
  }

  const openFolderDialog = (editing: Folder | null) => {
    setFolderName(editing?.name ?? '')
    setFolderNameError('')
    setFolderColor(editing ? folderDisplayColor(editing) : DEFAULT_TAG_FOLDER_COLOR)
    setFolderError('')
    setFolderDialog({ editing })
  }

  const folderUnchanged = Boolean(folderDialog?.editing && folderName.trim() === folderDialog.editing.name.trim() && folderColor === folderDisplayColor(folderDialog.editing))

  /* フォルダを足す／名前と色を変える（API-17：POST・PATCH /api/line-account-folders）。 */
  const saveFolder = async () => {
    const name = folderName.trim()
    if (!name || folderSaving || !folderDialog || folderUnchanged) return
    setFolderSaving(true)
    setFolderError('')
    try {
      const color = folderColor
      const res = folderDialog.editing
        ? await api.lineAccountFolders.update(folderDialog.editing.id, { name, color })
        : await api.lineAccountFolders.create({ name, color })
      if (!res.success) throw new Error(res.error)
      setFolderDialog(null)
      await loadFolders()
      void reloadAfterSave()
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409 && caught.message === '同じ名前のフォルダがあります') {
        setFolderNameError('同じ名前のフォルダがあります')
      } else {
        const fieldFailure = saveErrors.capture(caught)
        if (!fieldFailure) setFolderError(describeApiFailure(caught, '保存', { scope: 'hq' }))
      }
    } finally {
      setFolderSaving(false)
    }
  }

  /* 並べ替える：隣と表示順を入れ替える。 */
  const moveFolder = async (index: number, delta: -1 | 1) => {
    const a = folders[index]
    const b = folders[index + delta]
    if (!a || !b || folderSaving) return
    setFolderSaving(true)
    try {
      await api.lineAccountFolders.update(a.id, { displayOrder: b.displayOrder === a.displayOrder ? index + delta : b.displayOrder })
      await api.lineAccountFolders.update(b.id, { displayOrder: b.displayOrder === a.displayOrder ? index : a.displayOrder })
    } catch (saveFailure) {
      saveErrors.capture(saveFailure)
      // 並びが変わらなかったときは読み直した結果を見せる
    } finally {
      setFolderSaving(false)
      await loadFolders()
    }
  }

  /* 消す：中のアカウントは消えず未分類へ（API-17 の DELETE）。 */
  const removeFolder = async (target: Folder) => {
    if (!renderedFolderDeleteTicket || renderedFolderDeleteTicket !== folderDeleteTicket.current || folderDeleteLock.current) return
    folderDeleteLock.current = true
    setFolderSaving(true)
    setFolderError('')
    try {
      const response = await api.lineAccountFolders.remove(target.id)
      if (!response.success) throw new Error(response.error)
      if (renderedFolderDeleteTicket !== folderDeleteTicket.current) return
      folderDeleteTicket.current = null
      setDeleteFolder(null)
      if (folder === target.id) setFolder(ALL)
      await loadFolders()
      void reloadAfterSave()
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409 && caught.message === '同じ名前のフォルダがあります') {
        setFolderNameError('同じ名前のフォルダがあります')
      } else {
        const fieldFailure = saveErrors.capture(caught)
        if (!fieldFailure) setFolderError(describeApiFailure(caught, '保存', { scope: 'hq' }))
      }
    } finally {
      folderDeleteLock.current = false
      setFolderSaving(false)
    }
  }

  const folderRows: FolderPanelRow[] = [
    { kind: 'all' as const, id: ALL, label: 'すべて', count: accountsReadable ? currentAccounts.length : null, icon: <Inbox size={16} aria-hidden="true" /> },
    ...folders.map((f, index) => ({
      kind: 'folder' as const,
      id: f.id,
      label: f.name,
      count: accountsReadable ? (folderCounts.get(f.id) ?? 0) : null,
      color: f.color,
      icon: <FolderDot folder={{ name: f.name, color: f.color }} />,
      onEdit: canManage ? () => openFolderDialog(f) : undefined,
      onMoveUp: canManage && index > 0 ? () => void moveFolder(index, -1) : undefined,
      onMoveDown: canManage && index < folders.length - 1 ? () => void moveFolder(index, 1) : undefined,
      onDelete: canManage ? () => { folderDeleteTicket.current = {}; setFolderError(''); setDeleteFolder(f) } : undefined,
    })),
    { kind: 'unfiled' as const, id: UNFILED, label: '未分類', count: accountsReadable ? localUnfiled : null },
  ]

  const createAccount = canManage ? (
    <Button href="/accounts/new" variant="primary">
      <Plus aria-hidden="true" className={styles.buttonIcon} />アカウントを登録
    </Button>
  ) : null
  const selectFolder = (id: string) => { setFolder(id); resetPage() }
  const folderColumn = (
    <div className={styles.folderBox}>
      <FolderPanel
        reserveCreateSpace={canManage}
        createAction={createAccount}
        heading="フォルダ"
        rows={folderRows}
        activeId={folder}
        onSelect={selectFolder}
        onAddFolder={canManage ? () => openFolderDialog(null) : undefined}
        addFolderLabel="フォルダを追加"
      >
      </FolderPanel>
    </div>
  )

  const openRestore = (account: AccountWithStats) => {
    if (!restoreOwnerRef.current) return
    setArchiveTarget({ account, mode: 'restore' })
  }

  const cardActions = (account: AccountWithStats) => (
    <div className={styles.cardButtons}>
      {isArchived(account) ? <>
        {/* アーカイブは登録内容の編集と戻すだけ（本線 375cc79e30 の決定）。 */}
        <Button className={styles.grow} onClick={() => setEditingAccount(account)}>
          <Pencil aria-hidden="true" className={styles.buttonIcon} />登録内容を編集
        </Button>
        {canManage ? <AccountActionButton action="restore" lockedReason={restoreLockReason} disabled={!isOwner} onClick={() => openRestore(account)} /> : null}
      </> : <>
        <AccountActionButton action="enter" className={styles.grow} onClick={() => login(account.id)} aria-label={`${account.displayName || account.name} へ入る`} />
        {canManage ? <AccountActionButton action="settings" onClick={() => setSettingsAccount(account)} aria-label={`${account.displayName || account.name} の設定`} /> : null}
      </>}
    </div>
  )

  /* ★V8 oFq4S：表の行末は「…」1つ（行の操作は中に）。 */
  const tableMenu = (account: AccountWithStats) => {
    const name = account.displayName || account.name
    const items = isArchived(account)
      ? [
          { id: 'edit-registration', label: '登録内容を編集', onSelect: () => setEditingAccount(account) },
          ...(canManage ? [{ id: 'restore', label: '戻す', lockedReason: restoreLockReason, disabled: !isOwner, onSelect: () => openRestore(account) }] : []),
        ]
      : [
          ...(isOwner ? [{ id: 'billing', label: 'お支払いの設定を開く', onSelect: () => router.push('/hq/billing') }] : []),
          { id: 'login', label: 'このアカウントに切り替える', onSelect: () => login(account.id) },
          ...(canManage ? [{ id: 'settings', label: '設定', onSelect: () => setSettingsAccount(account) }] : []),
        ]
    return <RowMenu label={`${name}の操作`} items={items} />
  }

  const folderDotOf = (account: AccountWithStats) => {
    const id = folderOf(account)
    const found = id ? folders.find((item) => item.id === id) ?? (account as { folder?: Folder | null }).folder ?? null : null
    return found ? { name: found.name, color: found.color } : null
  }


  const toolbar = <>
      <PlatformNotices />
      <KpiBand className={styles.full} data-design="KPIs">
        <KpiCard title="アカウント" value={accountsReadable ? currentAccounts.length : null} loading={loading} unit="件" detail={loadError ? '読み込めませんでした' : null} />
        <KpiCard title="友だち合計" value={accountsReadable ? totals.friends : null} loading={loading} unit="人" detail={loadError ? '読み込めませんでした' : totals.friends === null ? '件数は分かりません' : null} help="アーカイブを除くアカウントの合計" />
        <KpiCard title="今月の配信" value={accountsReadable ? totals.messages : null} loading={loading} unit="通" detail={loadError ? '読み込めませんでした' : totals.messages === null ? '件数は分かりません' : null} />
        <KpiCard title="接続に問題" value={accountsReadable ? connectionTotal : null} loading={loading} unit="件" detail={connectionDetail} valueTone={connectionTotal !== null && connectionTotal > 0 ? 'warning' : 'default'} actionPlacement="value-row" action={{ label: '対応が要るものへ', href: '/hq/attention?kind=connections' }} />
      </KpiBand>

      {accountsReadable && accounts.length > 0 ? <ListToolbarFrame layout="stacked">
        <ListToolbarRow><div className={styles.searchBox}>
          <SearchField
            aria-label="名前・LINE ID・フォルダで探す"
            placeholder="名前・LINE ID・フォルダで探す"
            value={query}
            onChange={(value) => { setQuery(value); resetPage() }}
            onClear={() => { setQuery(''); resetPage() }}
          />
        </div></ListToolbarRow>
        <ListToolbarRow>
          <SegmentedControl<StatusFilter>
            aria-label="状態で絞り込む"
            className={styles.statusSwitch}
            value={status}
            onChange={(next) => { setStatus(next); resetPage() }}
            options={STATUS_FILTERS.map((item) => ({ value: item.value, label: item.label, count: statusCount(item.value) }))}
          />
          <ListToolbarEnd>
          {canManage ? <Button type="button" variant="text" onClick={() => void refreshConnectionInfo()} disabled={checkingConnections || accounts.every(isArchived)}>全部を更新</Button> : null}
          <SaveErrorField names={["view"]}><SegmentedControl<View>
            aria-label="表示の切り替え"
            value={view}
            onChange={setView}
            options={[{ value: 'cards', label: <LayoutGrid className={styles.buttonIcon} aria-hidden="true" />, ariaLabel: 'カード' }, { value: 'table', label: <List className={styles.buttonIcon} aria-hidden="true" />, ariaLabel: '表' }]}
          /></SaveErrorField>
          <SaveErrorField names={["sort"]}><Select label="並び" aria-label="アカウントの並び順" value={sort} size="content" onChange={(value) => { setSort(value); resetPage() }} options={SORT_OPTIONS} /></SaveErrorField>
          <SaveErrorField names={["size"]}><Select
            aria-label="アカウントの表示件数"
            value={String(size)}
            width={110}
            onChange={(value) => { setSize(Number(value)); resetPage() }}
            options={PAGE_SIZES.map((value) => ({ value: String(value), label: `${value} 件表示` }))}
          /></SaveErrorField>
          </ListToolbarEnd>
        </ListToolbarRow>
        {tokenExpirySummary(filtered) ? <ListToolbarRow><Notice tone="warn" compact message={`表示中のLINE接続の期限（接続に問題とは別の数え方）：${tokenExpirySummary(filtered)}`} /></ListToolbarRow> : null}
      </ListToolbarFrame> : null}
  </>

  const body = loadError ? (
    <Notice
      tone="danger"
      message={loadFailureNotice(loadError, '統括のアカウント情報', 'hq')}
      action={classifyApiFailure(loadError) === 'forbidden' ? undefined : (
        <Button type="button" onClick={() => { setLoading(true); setReloadKey((key) => key + 1) }}>もう一度読み込む</Button>
      )}
    />
  ) : loading ? (
    <ListState permissionScope="hq" kind="loading" loadingShape={view === 'cards' ? 'cards' : 'list'} title="アカウントを読み込んでいます" />
  ) : accounts.length === 0 ? (
    <EmptyList
      icon={<MessageCircle aria-hidden="true" />}
      title="まだ LINE 公式アカウントがありません"
      description="アカウントを登録すると、ここから各アカウントの管理画面に入れます。"
      create={{ label: '最初のアカウントを登録する', href: '/accounts/new' }}
      canCreate={canManage}
    />
  ) : (
    <>
      {view === 'table' && attentionError ? <Notice tone="danger" message={`対応件数：${loadFailureNotice(attentionError, '対応件数', 'hq')}`} action={classifyApiFailure(attentionError) === 'forbidden' ? undefined : <Button type="button" disabled={attentionRefreshing} onClick={() => setAttentionKey(key => key + 1)}>もう一度読み込む</Button>} /> : null}
      {connectionProgress ? <p className={styles.progress} role="status">{connectionProgress}</p> : null}
      {connectionResult ? <Notice tone={connectionResult.tone} message={connectionResult.message}
        action={connectionResult.needsReload ? <Button type="button" onClick={() => void reloadConnections()} disabled={checkingConnections}>もう一度読み込む</Button> : undefined}
      /> : null}
      {reloadFailed ? (
        <Notice
          tone="warn"
          message="保存はできましたが、一覧を読み直せませんでした。"
          action={<Button type="button" onClick={() => reloadAfterSave()} busyLabel="処理中…">もう一度読み込む</Button>}
        />
      ) : null}

      {shown.length === 0 ? (
        <EmptyList
          icon={<MessageCircle aria-hidden="true" />}
          title="まだ LINE 公式アカウントがありません"
          description=""
          filtered
          onClearFilters={() => { setQuery(''); setStatus(STATUS_FILTERS[0].value); setFolder(ALL); resetPage() }}
          filteredDescription="検索の言葉や絞り込みを外すと、すべて出ます"
        />
      ) : view === 'cards' ? (
        <ListPageCards inset="parent" narrowColumns={2}>
          {shown.map((account) => {
            const state = statusOf(account)
            const warned = state.tone === 'warn'
            const name = account.displayName || account.name
            const nameCharacters = Array.from(name)
            const namePrefix = nameCharacters.slice(0, -6).join('')
            const nameSuffix = nameCharacters.slice(-6).join('')
            return (
              <Card key={account.id} as="article" layout="vertical" padding="default" gap="var(--polish-space-field)" aria-label={name} actions={cardActions(account)}>
                <div className={styles.cardHead}>
                  <Avatar name={name} src={accountIconUrl(account)} size={40} shape="rounded" alt={name} style={{ width: 'var(--tpl-hq-logo)', height: 'var(--tpl-hq-logo)' }} />
                  <div className={styles.cardName}>
                    {/* 絵 `JKjsE`：名前の前に左の列（フォルダ）の色の丸。未分類は色の無い輪。 */}
                    <p className={styles.name} title={name}>
                      <FolderDotName folder={folderDotOf(account)}>{nameCharacters.length > 6 ? <span className={styles.middleName} title={name}><span className="sr-only">{name}</span><span aria-hidden="true" className={styles.middleNamePrefix}>{namePrefix}</span><span aria-hidden="true" data-hq-name-suffix="">{nameSuffix}</span></span> : <span title={name}>{name}</span>}</FolderDotName>
                    </p>
                    {/* B-31：名前の下は1行で省略し、全文は title。 */}
                    <TruncatedText className={styles.meta} value={accountMeta(account, nameOf((account as { parentLineAccountId?: string | null }).parentLineAccountId))} />
                  </div>
                  <StatusBadge tone={state.tone === 'ok' ? 'success' : state.tone === 'warn' ? 'caution' : 'neutral'}>{state.label}</StatusBadge>
                </div>
                <TagOverflow label={`${name}の分類`}>
                  {folderDotOf(account) ? <IconLabel icon={FolderIcon} aria-label={`フォルダ：${folderDotOf(account)!.name}`}>{folderDotOf(account)!.name}</IconLabel> : null}
                  {(account.tags ?? []).filter((tag, index, tags) => tag.name.trim() !== folderDotOf(account)?.name.trim() && tags.findIndex(other => other.name.trim() === tag.name.trim()) === index).map(tag => <TagPill key={tag.id} name={tag.name} color={tag.color} />)}
                </TagOverflow>
                <dl className={styles.stats}>
                  <div className={styles.stat}>
                    <dt>友だち</dt>
                    <dd>{accountFriendCount(account)}</dd>
                  </div>
                  <div className={styles.stat}>
                    <dt>今月の配信</dt>
                    <dd>{typeof account.stats?.messagesThisMonth === 'number' ? `${formatNumber(account.stats.messagesThisMonth)} 通` : emptyValue('unknown')}</dd>
                  </div>
                </dl>
                {(() => {
                  const notice = connectionNoticeLine(account, warned)
                  return notice ? <Notice tone="warn" compact title={notice.title || undefined} message={notice.text}
                    action={<Button variant="text" size="inline" data-notice-inline-action type="button" lockedReason={manageLockReason} onClick={() => void refreshConnectionInfo(account)} disabled={!canManage || checkingConnections}>更新する</Button>}
                  /> : null
                })()}
              </Card>
            )
          })}
        </ListPageCards>
      ) : (
        <DataTable aria-label="アカウントの一覧" columnWeights={[3, 1.25, 1.5, 1, 1, 1.25, 0.5]}>
          <thead><TableHeadRow>
            <Th>アカウント</Th>
            <Th>LINE接続</Th>
            <Th>お支払い</Th>
            <Th>対応が要る</Th>
            <Th>友だち</Th>
            <Th>今月の配信</Th>
            <Th className="sr-only">操作</Th>
          </TableHeadRow></thead><tbody>
          {shown.map((account) => {
            const state = statusOf(account)
            const name = account.displayName || account.name
            return (
              <Tr key={account.id}>
                <PersonCell avatarName={name} avatarSrc={accountIconUrl(account)} avatarShape="rounded" avatarAlt={name} avatarSize={32} nameTitle={[name, state.label, accountMeta(account, nameOf((account as { parentLineAccountId?: string | null }).parentLineAccountId))].filter(Boolean).join(' / ')} name={
                  <span className={styles.cardName}>
                    <FolderDotName folder={folderDotOf(account)}>
                      <TruncatedText className={styles.name} value={String(name ?? '')} />
                    </FolderDotName>
                    <TruncatedText className={styles.meta} value={accountMeta(account, nameOf((account as { parentLineAccountId?: string | null }).parentLineAccountId))} />
                  </span>
                } />
                <Td><StatusBadge tone={state.tone === 'ok' ? 'success' : state.tone === 'warn' ? 'caution' : 'neutral'}>{state.label}</StatusBadge>
                  {(() => {
                    const badge = tokenExpiryBadge(account)
                    return badge ? <StatusBadge tone={account.tokenExpiry?.status === 'expired' ? 'danger' : 'caution'} title={badge.title}>{badge.text}</StatusBadge> : null
                  })()}
                </Td>
                <Td>{(() => {
                  const pay = payState[account.id]
                  if (!pay || pay === 'unknown') return emptyValue('unknown')
                  return <StatusBadge tone={pay === 'live' ? 'success' : pay === 'test' ? 'warning' : 'neutral'}>{pay === 'live' ? 'つながっている' : pay === 'test' ? '試験モード' : 'つなぐ前'}</StatusBadge>
                })()}</Td>
                <Td>{attentionTotals?.[account.id] !== undefined ? `${formatNumber(attentionTotals[account.id])} 件` : emptyValue('unknown')}</Td>
                <Td>{accountFriendCount(account)}</Td>
                <Td>{typeof account.stats?.messagesThisMonth === 'number' ? formatNumber(account.stats.messagesThisMonth) : emptyValue('unknown')}</Td>
                <Td>{tableMenu(account)}</Td>
              </Tr>
            )
          })}
        </tbody></DataTable>
      )}

      <div className={styles.footer}>
        <span className={styles.range}>
          {filtered.length === 0 ? '0件' : `${formatNumber(filtered.length)} 件中 ${formatNumber((current - 1) * size + 1)}〜${formatNumber((current - 1) * size + shown.length)} 件`}
        </span>
        <p className={styles.footNote}>{`${view === 'cards' ? 'カードの「設定」' : '行の「…」'}から、フォルダの移動・名前を変えられます`}</p>
        {pageCount > 1 ? <Pagination page={current} pageCount={pageCount} onPageChange={setPage} ariaLabel="アカウントのページ送り" /> : null}
      </div>
    </>
  )

  return (
    <KpiValueMotionProvider scope={`hq-accounts:${jstDate().slice(0, 7)}`}>
    <SaveErrorScope errors={saveErrors}><ListPage
      tableInset={view === 'table'}
      boardId="JKjsE"
      title="統括のアカウント"
      help={<>{`${tenantName || 'この統括'}に属する LINE 公式アカウントです。ここから各アカウントへ入れます。`}{`${view === 'cards' ? 'カードの「設定」' : '行の「…」'}から、フォルダの移動・名前を変えられます。アーカイブしたアカウントは「登録内容を編集」と「戻す」だけです（「戻す」を使えるのはオーナーだけです。本人確認のあと、アカウントは「停止中」になります）。`}</>}

      folders={folderColumn}
      folderInset toolbar={toolbar} toolbarSpacing="stats" toolbarRowGap="card"
      folderWidth={200}
      folderNav={{ rows: folderRows, activeId: folder, onSelect: selectFolder, createAction: createAccount, label: 'フォルダ' }}
    >
      <div className={styles.body}>
        {body}
      </div>

      {settingsAccount ? (
        <AccountSettingsDialogV8
          account={settingsAccount}
          archived={isArchived(settingsAccount)}
          onClose={() => setSettingsAccount(null)}
          onSaved={() => { setSettingsAccount(null); void reloadAfterSave() }}
          onArchive={() => {
            setArchiveTarget({ account: settingsAccount, mode: isArchived(settingsAccount) ? 'restore' : 'archive' })
            setSettingsAccount(null)
          }}
          onEditRegistration={() => { setEditingAccount(settingsAccount); setSettingsAccount(null) }}
          canCreateFolder={canManage}
          onFolderCreated={() => void loadFolders()}
        />
      ) : null}
      {archiveTarget?.mode === 'archive' ? (
        <AccountArchiveDialogV8 account={archiveTarget.account} onClose={() => setArchiveTarget(null)} onDone={() => { setArchiveTarget(null); void reloadAfterSave() }} />
      ) : null}
      {archiveTarget?.mode === 'restore' ? (
        <AccountRestoreDialogV8 account={archiveTarget.account} onClose={() => setArchiveTarget(null)} onDone={() => { setArchiveTarget(null); void reloadAfterSave() }} />
      ) : null}
      {editingAccount ? (
        <AccountEditModal
          accountId={editingAccount.id}
          initialName={editingAccount.name}
          initialChannelId={editingAccount.channelId}
          initialLoginChannelId={editingAccount.loginChannelId ?? null}
          initialLiffId={editingAccount.liffId ?? null}
          initialOgSiteName={editingAccount.ogSiteName ?? null}
          initialOgDefaultDescription={editingAccount.ogDefaultDescription ?? null}
          initialOgDefaultImageUrl={editingAccount.ogDefaultImageUrl ?? null}
          initialFriendCapacity={editingAccount.friendCapacity ?? null}
          initialCapacityWarnAt={editingAccount.capacityWarnAt ?? null}
          initialIconUrl={editingAccount.iconUrl ?? null}
          onClose={() => setEditingAccount(null)}
          onSaved={() => { void reloadAfterSave() }}
        />
      ) : null}

      <FolderEditorDialog
        open={folderDialog !== null}
        title={folderDialog?.editing ? 'フォルダの名前と色を変える' : 'フォルダを追加'}
        description="アカウントは1つのフォルダに入ります。"
        name={folderName} nameError={folderNameError} onNameChange={(value) => { setFolderName(value); setFolderNameError('') }} nameId="hq-account-folder-name" nameLabel="フォルダの名前"
        color={folderColor} onColorChange={setFolderColor} colors={FOLDER_SELECT_COLORS}
        placeholder="例：渋谷エリア" maxLength={100}
        onCancel={() => { if (!folderSaving) setFolderDialog(null) }}
        designNode="JKjsE" busy={folderSaving} disabled={folderSaving} error={folderError || undefined}
        confirmLabel={folderDialog?.editing ? '保存する' : '追加する'} cancelLabel="やめる"
        confirmDisabled={folderUnchanged}
        onConfirm={() => saveFolder()}
      >{folderUnchanged ? <Notice tone="info" compact>名前か色を変えると保存できます。</Notice> : null}</FolderEditorDialog>

      <OverlayDepthContext.Provider value={depth + 2}><UnsavedLeaveDialog open={folderGuard.leaveTarget !== null} busy={folderSaving} onConfirm={folderGuard.confirmLeave} onCancel={folderGuard.cancelLeave} /></OverlayDepthContext.Provider>

      {deleteFolder ? (
        <ConfirmDialog
          open
          title={`フォルダ「${deleteFolder.name}」を消しますか？`}
          description={`中のアカウント${typeof deleteFolder.itemCount === 'number' ? ` ${formatNumber(deleteFolder.itemCount)} 件` : ''}は消えずに「未分類」へ移ります。消したフォルダは元に戻せません。`}
          confirmLabel="フォルダを消す"
          cancelLabel="キャンセル"
          destructive
          busy={folderSaving}
          error={folderError || undefined}
          onConfirm={() => removeFolder(deleteFolder)}
          onCancel={() => { if (!folderSaving && !folderDeleteLock.current) { folderDeleteTicket.current = null; setDeleteFolder(null) } }}
        ><OperationTargetSummary accounts={[]} externalTarget={{ label: '対象アカウント', name: '未分類へ移るアカウントの名前を確認できません' }} /></ConfirmDialog>
      ) : null}
    </ListPage></SaveErrorScope>
    </KpiValueMotionProvider>
  )
}
