'use client'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { responseApiError } from '@/lib/api'

import StatusBadge from '@/components/shared/status-badge'
import { mileageStatusTone } from './parts'

import { jstDateOffset } from '@/lib/jst-datetime'
import { useListUrlValue } from '@/components/shared/list-url-state'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { ArrowDown, ArrowUp, Bookmark, CircleDot, Clock3, Coins, Download, Gift, ListOrdered, Plus, Wallet } from 'lucide-react'
import { useAccount } from '@/contexts/account-context'
import { adminSessionHeaders } from '@/lib/admin-session'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { api, type MileageAdminHistory, type MileageEarningRuleTestResult, type MileageEarningRuleV6, type MileageEarningRulesV6Overview } from '@/lib/api'
import { RowMenu } from '@/components/shared/row-actions'
import Button from '@/components/shared/button'
import EmptyList from '@/components/shared/empty-list'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Dialog from '@/components/shared/dialog'
import FilterChip from '@/components/shared/filter-chip'
import ManagedFolderPanel from '@/components/shared/managed-folder-panel'
import IconButton from '@/components/shared/icon-button'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import ListState from '@/components/shared/list-state'
import ListToolbar, { ListToolbarFrame, ListToolbarOptional } from '@/components/shared/list-toolbar'
import Notice from '@/components/shared/notice'
import Pagination from '@/components/shared/pagination'
import SearchField from '@/components/shared/search-field'
import Select from '@/components/shared/select'
import { DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table'
import { FolderDotName } from '@/components/shared/folder-dot'
import { ListPagePagination } from '@/components/templates'
import { describeMileageCsvExportFailure, formatMileageDate, formatMileageMonthDay, formatMileageNumber, isMileageFriendsV6Overview, ruleEventLabel } from './display'
import { MILEAGE_TABLE_LAYOUT, MileageFrame, useMileageShell } from './frame'
import { notifyToast } from '@/components/shared/toast'
import styles from './mileage.module.css'
import TruncatedText from '@/components/shared/truncated-text'
import { csvFileName } from '@/lib/csv-file-name'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { PAGE_SIZE_SELECT_OPTIONS } from '@/components/shared/page-size-select'

/*
 * ★V8 マイル「たまる決めごと」（板 ・1152 ・閲覧のみ 、
 * 状態は見本帳 ）。
 *
 * app/mileage/v8-earning-rules-tab.tsx から動きを写し、見た目を一覧の型
 * （ListPage）で組み直した。データの口・操作は今と同じ（編集・テスト・
 * 止める／再開・公開・複製・削除・並び順の保存・CSV）。
 *
 * フォルダの列に割り当てる API は無いので、きっかけの種類で分けた
 * 見え方の切り替えとして持つ（保存はしない）。
 */

const EVENT_LABELS: Record<string, string> = {
  friend_added: '友だち追加',
  message_received: 'メッセージ',
  link_clicked: 'リンククリック',
  broadcast_link_clicked: '配信リンククリック',
  form_submitted: 'フォーム',
  booking_created: '予約',
  affiliate_conversion_approved: '紹介成果',
  webinar_watch_5m: 'ウェビナー',
  webinar_watch_15m: 'ウェビナー',
  webinar_completed: 'ウェビナー完了',
  webinar_cta_clicked: 'ウェビナーの案内ボタン',
  instagram_dm_received: 'Instagram DM',
  instagram_comment_created: 'Instagramコメント',
  instagram_story_mentioned: 'ストーリーズ',
  instagram_line_returned: 'LINE帰還',
  inflow_return: 'LINE帰還',
  friend_registered: '友だち登録',
  friend_following_7d: '継続7日',
  friend_following_30d: '継続30日',
  friend_following_90d: '継続90日',
  friend_following_180d: '継続180日',
  friend_following_365d: '継続1年',
  purchase_completed: '購入完了',
}

/* フォルダの列の分け方（きっかけの種類。保存はしない）。 */
const FOLDER_PURCHASE = new Set(['purchase_completed'])
const FOLDER_REACTION = new Set([
  'link_clicked', 'broadcast_link_clicked', 'message_received', 'form_submitted',
  'webinar_watch_5m', 'webinar_watch_15m', 'webinar_completed', 'webinar_cta_clicked',
  'instagram_dm_received', 'instagram_comment_created', 'instagram_story_mentioned',
])
const FOLDER_REFERRAL = new Set([
  'friend_added', 'friend_registered', 'affiliate_conversion_approved',
  'inflow_return', 'instagram_line_returned',
])

type FolderKey = 'all' | 'purchase' | 'reaction' | 'referral' | 'other'

function folderOf(rule: MileageEarningRuleV6): Exclude<FolderKey, 'all'> {
  const event = rule.draft.eventType
  if (FOLDER_PURCHASE.has(event)) return 'purchase'
  if (FOLDER_REACTION.has(event)) return 'reaction'
  if (FOLDER_REFERRAL.has(event)) return 'referral'
  return 'other'
}

/*
 * きっかけの分け方（購入・配信の反応・紹介・そのほか）。決めごとの種類から決まる固定の分け方で、
 * 作ったフォルダではないので、左のフォルダの列ではなく上の絞り込みに置く（ 2026-10-09）。
 */
const FOLDERS: Array<{ key: FolderKey; label: string }> = [
  { key: 'all', label: 'きっかけ：すべて' },
  { key: 'purchase', label: '購入' },
  { key: 'reaction', label: '配信の反応' },
  { key: 'referral', label: '紹介' },
  { key: 'other', label: 'そのほか' },
]

function isOverview(value: unknown): value is MileageEarningRulesV6Overview {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<MileageEarningRulesV6Overview>
  return Array.isArray(candidate.items)
    && !!candidate.pagination
    && typeof candidate.pagination.total === 'number'
    && typeof candidate.unassignedLegacyCount === 'number'
}

function dateOnlyDaysAgo(days: number) {
  return jstDateOffset(-days)
}

function grantedMiles30d(rule: MileageEarningRuleV6) {
  return rule.metrics30d.grantedMiles
}

/* 有効期間・失効の1行（板：1年・12/31）。 */
function validityText(rule: MileageEarningRuleV6): { miles: string; rule: string } {
  const days = rule.draft.expiresAfterDays
  const span = days == null ? '失効なし' : days >= 365 && days % 365 === 0
    ? `${days / 365}年`
    : `${formatMileageNumber(days)}日`
  const until = rule.draft.validUntil ? formatMileageMonthDay(rule.draft.validUntil) : '期限なし'
  return { miles: `マイル：${span}`, rule: `ルール：${until}` }
}

type SortKey = 'order' | 'granted' | 'name' | 'amount'

const PRESETS: Array<{ value: string; label: string; active: boolean; pending: boolean; stopped: boolean; sort: SortKey }> = [
  { value: 'default', label: 'よく使う絞り込み', active: false, pending: false, stopped: false, sort: 'order' },
  { value: 'active-granted', label: '動いている・付いたマイルが多い順', active: true, pending: false, stopped: false, sort: 'granted' },
  { value: 'active-name', label: '動いている・名前順', active: true, pending: false, stopped: false, sort: 'name' },
  { value: 'stopped', label: '止めているのみ', active: false, pending: false, stopped: true, sort: 'order' },
  { value: 'pending', label: '確定待ちありのみ', active: false, pending: true, stopped: false, sort: 'order' },
]

const PAGE_SIZE_OPTIONS = PAGE_SIZE_SELECT_OPTIONS

export default function EarningRulesTab() {
  const saveErrors = useSaveFormErrors()
  const router = useRouter()
  const { readonly: roleReadonly, narrow, setCount, balanceSource } = useMileageShell()
  const readonly = roleReadonly || balanceSource === 'ec'
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const accountScope = useRef({ id: selectedAccountId, generation: 0 })
  if (accountScope.current.id !== selectedAccountId) accountScope.current = { id: selectedAccountId, generation: accountScope.current.generation + 1 }
  const loadedAccountScope = useRef(-1)
  const readonlyRef = useRef(readonly)
  readonlyRef.current = readonly
  const [publishAccount, setPublishAccount] = useState<{ id: string; generation: number } | null>(null)
  const latestAccountRef = useRef(selectedAccountId)
  useEffect(() => {
    latestAccountRef.current = selectedAccountId
  }, [selectedAccountId])
  const generationRef = useRef(0)
  const [rules, setRules] = useState<MileageEarningRuleV6[]>([])
  const [grantedMiles, setGrantedMiles] = useState<number | null>(null)
  const [grantedCount, setGrantedCount] = useState<number | null>(null)
  const [spentMiles, setSpentMiles] = useState<number | null>(null)
  const [spentCount, setSpentCount] = useState<number | null>(null)
  const [balanceTotal, setBalanceTotal] = useState<number | null>(null)
  const [ecBalanceSource, setEcBalanceSource] = useState(false)
  const [friendTotal, setFriendTotal] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [searchInput, setSearchInput] = useListUrlValue('q', '')
  const [search, setSearch] = useListUrlValue('q', '')
  const [folder, setFolder] = useListUrlValue<FolderKey>('folder', 'all')
  const [activeOnly, setActiveOnly] = useListUrlValue('activeOnly', false)
  const [pendingOnly, setPendingOnly] = useListUrlValue('pendingOnly', false)
  const [stoppedOnly, setStoppedOnly] = useListUrlValue('stoppedOnly', false)
  const [sort, setSort] = useListUrlValue<SortKey>('sort', 'order')
  const [pageSize, setPageSize] = useListUrlValue('pageSize', 20)
  const [page, setPage] = useListUrlValue('page', 1)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [viewTarget, setViewTarget] = useState<MileageEarningRuleV6 | null>(null)
  const [averageDenominator, setAverageDenominator] = useState<number | null>(null)
  useEffect(() => { setViewTarget(null); setAverageDenominator(null) }, [selectedAccountId])
  const [savingId, setSavingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const [menuNotice, setMenuNotice] = useState('')
  const [publishTarget, setPublishTarget] = useState<MileageEarningRuleV6 | null>(null)
  const [publishError, setPublishError] = useState('')
  useEffect(() => { setPublishTarget(null); setPublishAccount(null) }, [selectedAccountId])
  const [deleteTarget, setDeleteTarget] = useState<MileageEarningRuleV6 | null>(null)
  const [deleteAccount, setDeleteAccount] = useState<{ id: string; generation: number } | null>(null)
  useEffect(() => { setDeleteTarget(null); setDeleteAccount(null) }, [selectedAccountId])
  const [deleteError, setDeleteError] = useState('')
  const [testTarget, setTestTarget] = useState<MileageEarningRuleV6 | null>(null)
  const [testResult, setTestResult] = useState<MileageEarningRuleTestResult | null>(null)
  const [testBusy, setTestBusy] = useState(false)
  const [testError, setTestError] = useState('')
  const [ruleOrder, setRuleOrder] = useState<string[]>([])
  const [orderDirty, setOrderDirty] = useState(false)
  const [savingOrder, setSavingOrder] = useState(false)
  const [exporting, setExporting] = useState(false)
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({ dirty: orderDirty, busy: savingOrder })

  const load = useCallback(async () => {
    const scopeGeneration = accountScope.current.generation
    const accountAtRequest = selectedAccountId
    const generation = ++generationRef.current
    const isStale = () =>
      generation !== generationRef.current || accountAtRequest !== latestAccountRef.current || scopeGeneration !== accountScope.current.generation
    if (!accountAtRequest) {
      setRules([])
      setLoading(false)
      return
    }
    setLoading(true)
    setLoadError(false)
    try {
      const [res, historyRes, friendsRes] = await Promise.all([
        api.mileage.earningRulesV6({ accountId: accountAtRequest, limit: 100, offset: 0 }),
        api.mileage.history({
          accountId: accountAtRequest,
          from: dateOnlyDaysAgo(29),
          to: dateOnlyDaysAgo(0),
          limit: 1,
          offset: 0,
        }),
        api.mileage.friendsV6({ accountId: accountAtRequest, limit: 1, offset: 0 }),
      ])
      if (isStale()) return
      if (!res.success || !isOverview(res.data)) throw new Error('invalid_mileage_rules')
      if (!historyRes.success || !friendsRes.success || !isMileageFriendsV6Overview(friendsRes.data)) {
        throw new Error('invalid_mileage_rule_summary')
      }
      const items = [...res.data.items]
      const total = res.data.pagination.total
      while (items.length < total) {
        const next = await api.mileage.earningRulesV6({ accountId: accountAtRequest, limit: 100, offset: items.length })
        if (isStale()) return
        if (!next.success || !isOverview(next.data)) throw new Error('invalid_mileage_rules')
        if (next.data.items.length === 0) break
        items.push(...next.data.items)
      }
      if (isStale()) return
      const byType = (historyRes.data as MileageAdminHistory).summary.byType
      const grant = byType.find((item) => item.entryType === 'grant')
      const spend = byType.find((item) => item.entryType === 'spend')
      loadedAccountScope.current = scopeGeneration
      setRules(items)
      setGrantedMiles(grant?.amount ?? 0)
      setGrantedCount(grant?.count ?? 0)
      setSpentMiles(spend?.amount ?? 0)
      setSpentCount(spend?.count ?? 0)
      setEcBalanceSource(friendsRes.data.balanceSource === 'ec')
      setBalanceTotal(friendsRes.data.balanceSource === 'ec' && !friendsRes.data.ecKnownCount ? null : friendsRes.data.summary.available)
      setAverageDenominator(friendsRes.data.summary.withBalanceCount)
      setFriendTotal(friendsRes.data.summary.totalMembers)
      setRuleOrder(items.map((rule) => rule.id))
      setOrderDirty(false)
      setPage(1)
    } catch {
      if (isStale()) return
      loadedAccountScope.current = -1
      setRules([])
      setLoadError(true)
    } finally {
      if (!isStale()) setLoading(false)
    }
  }, [selectedAccountId, saveErrors])

  useEffect(() => {
    if (accountLoading) return
    void load()
  }, [accountLoading, load])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(1)
      setSearch(searchInput.trim())
    }, 0)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  /* タブの名の横の件数。読み直し中・失敗時は消す。 */
  useEffect(() => {
    if (loading) return
    setCount('earning-rules', loadError ? null : formatMileageNumber(rules.length))
  }, [loading, loadError, setCount, rules.length])

  const resetPage = (change: () => void) => {
    setPage(1)
    change()
  }

  const exportCsv = useCallback(async () => {
    if (!selectedAccountId || exporting) return
    setExporting(true)
    setActionError('')
    let exportStatus: number | null = null
    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/api/mileage/rules/export?accountId=${encodeURIComponent(selectedAccountId)}`,
        { credentials: 'include', headers: adminSessionHeaders() },
      )
      if (!res.ok) {
        exportStatus = res.status
        throw responseApiError(res, await res.text())
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = csvFileName("マイルの獲得ルール")
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setActionError(describeMileageCsvExportFailure(exportStatus)) }
    } finally {
      setExporting(false)
    }
  }, [exporting, selectedAccountId, saveErrors])

  const activeRules = useMemo(() => rules.filter((rule) => rule.published.status === 'published'), [rules])
  const pendingRules = useMemo(() => rules.filter((rule) => rule.draft.initialStatus === 'pending'), [rules])
  const folderCounts = useMemo(() => {
    const counts = new Map<FolderKey, number>()
    counts.set('all', rules.length)
    for (const item of FOLDERS) {
      if (item.key === 'all') continue
      counts.set(item.key, rules.filter((rule) => folderOf(rule) === item.key).length)
    }
    return counts
  }, [rules])

  const shown = useMemo(() => {
    const keyword = search.trim()
    const filtered = rules.filter((rule) => {
      if (folder !== 'all' && folderOf(rule) !== folder) return false
      if (activeOnly && rule.published.status !== 'published') return false
      if (stoppedOnly && rule.published.status === 'published') return false
      if (pendingOnly && rule.draft.initialStatus !== 'pending') return false
      if (keyword && !rule.draft.name.includes(keyword)) return false
      return true
    })
    const order = new Map(ruleOrder.map((id, index) => [id, index]))
    return [...filtered].sort((a, b) => {
      if (sort === 'granted') return grantedMiles30d(b) - grantedMiles30d(a)
      if (sort === 'name') return a.draft.name.localeCompare(b.draft.name, 'ja')
      if (sort === 'amount') return b.draft.amount - a.draft.amount
      return (order.get(a.id) ?? a.draft.sortOrder) - (order.get(b.id) ?? b.draft.sortOrder)
    })
  }, [activeOnly, folder, pendingOnly, stoppedOnly, ruleOrder, rules, search, sort])

  const pageCount = Math.max(1, Math.ceil(shown.length / pageSize))
  const visible = shown.slice((page - 1) * pageSize, page * pageSize)
  const presetValue = PRESETS.find((p) =>
    p.active === activeOnly && p.pending === pendingOnly && p.stopped === stoppedOnly && p.sort === sort)?.value ?? 'custom'
  const canMove = !readonly && folder === 'all' && !activeOnly && !pendingOnly && !stoppedOnly && !search.trim() && sort === 'order'

  const moveRule = (id: string, direction: -1 | 1) => {
    if (!canMove) return
    setRuleOrder((current) => {
      const index = current.indexOf(id)
      const target = index + direction
      if (index < 0 || target < 0 || target >= current.length) return current
      const next = [...current]
      const tmp = next[index]
      next[index] = next[target]
      next[target] = tmp
      return next
    })
    setOrderDirty(true)
  }

  const saveOrder = async () => {
    if (!selectedAccountId || savingOrder || !orderDirty) return
    setSavingOrder(true)
    try {
      const response = await api.mileage.saveEarningRulesOrder({ accountId: selectedAccountId, ids: ruleOrder })
      if (!response.success) throw new Error(response.error)
      await load()
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setActionError('並び順を保存できませんでした。最新の状態を読み直してから、もう一度お試しください。') }
      await load().catch(() => {})
    } finally {
      setSavingOrder(false)
    }
  }

  /*
   * 止める・再開する（行の「…」から）。押した瞬間に状態の札を変え、裏で保存する（触り心地 5 回目）。
   * 公開内容・版は変わらないので、成功しても一覧を読み直さない。失敗したら元に戻してトーストで知らせる。
   */
  const toggleRule = async (rule: MileageEarningRuleV6) => {
    if (readonly) return
    const before = rule.published.status
    const next = before === 'published' ? 'stopped' : 'published'
    const setStatus = (status: MileageEarningRuleV6['published']['status']) => setRules((current) => current.map((item) => (
      item.id === rule.id ? { ...item, published: { ...item.published, status } } : item
    )))
    setSavingId(rule.id)
    setActionError('')
    setStatus(next)
    try {
      const res = await api.mileage.updateRule(rule.id, { isActive: next === 'published' })
      if (!res.success) throw new Error(res.error)
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure);

      setStatus(before)
      { if (!fieldFailure)
      notifyToast(`「${rule.draft.name}」を${next === 'published' ? '再開' : '停止'}できませんでした。元に戻しました。`, {
        tone: 'error',
        actionLabel: 'もう一度',
        onAction: () => { void toggleRule({ ...rule, published: { ...rule.published, status: before } }) },
      }) }
    } finally {
      setSavingId(null)
    }
  }

  const deleteRule = async (rule: MileageEarningRuleV6) => {
    if (readonly || savingId !== null) return
    setSavingId(rule.id)
    setDeleteError('')
    try {
      const res = await api.mileage.deleteRule(rule.id)
      if (!res.success) throw new Error(res.error)
      setDeleteTarget(null)
      await load()
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)
      setDeleteError(describeApiFailure(caught, '削除')) }
    } finally {
      setSavingId(null)
    }
  }

  const publishRule = async (rule: MileageEarningRuleV6) => {
    if (readonly || !selectedAccountId || savingId !== null) return
    setSavingId(rule.id)
    setPublishError('')
    try {
      const res = await api.mileage.publishEarningRule(rule.id, {
        accountId: selectedAccountId,
        expectedVersion: rule.draftVersion,
        idempotencyKey: crypto.randomUUID(),
      })
      if (!res.success) throw new Error(res.error)
      setPublishTarget(null)
      await load()
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setPublishError('公開できませんでした。下書きを読み直して内容を確かめてから、もう一度お試しください。') }
    } finally {
      setSavingId(null)
    }
  }

  /* 行の「…」の「複製」。止めた状態で写しを1つ作る（公開はしない）。 */
  const duplicateRule = async (rule: MileageEarningRuleV6) => {
    if (readonly || !selectedAccountId || savingId !== null) return
    setSavingId(rule.id)
    setActionError('')
    setMenuNotice('')
    try {
      const name = `${rule.draft.name} のコピー`
      const created = await api.mileage.createRule({
        name,
        eventType: rule.draft.eventType,
        source: rule.draft.source,
        amount: rule.draft.amount,
        initialStatus: rule.draft.initialStatus,
        lineAccountId: selectedAccountId,
        conditions: {},
        validFrom: rule.draft.validFrom,
        validUntil: rule.draft.validUntil,
        isActive: false,
      })
      if (!created.success) throw new Error(created.error)
      const drafted = await api.mileage.saveEarningRuleDraft(created.data.id, {
        accountId: selectedAccountId,
        expectedVersion: 0,
        draft: { ...rule.draft, name },
      })
      if (!drafted.success) throw new Error(drafted.error)
      setMenuNotice(`「${name}」を止めた状態で作りました。`)
      await load()
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setActionError('複製できませんでした。もう一度お試しください。') }
    } finally {
      setSavingId(null)
    }
  }

  const runTest = async (rule: MileageEarningRuleV6) => {
    if (readonly || !selectedAccountId || testBusy) return
    setTestTarget(rule)
    setTestResult(null)
    setTestError('')
    setTestBusy(true)
    try {
      const response = await api.mileage.testEarningRule(selectedAccountId, rule.draft)
      if (!response.success) throw new Error(response.error)
      setTestResult(response.data)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)
      setTestError(describeApiFailure(caught, '送信')) }
    } finally {
      setTestBusy(false)
    }
  }

  const resetAll = () => {
    setSearchInput('')
    setSearch('')
    setFolder('all')
    setActiveOnly(false)
    setPendingOnly(false)
    setStoppedOnly(false)
    setSort('order')
    setPage(1)
  }

  const ready = !loading && !loadError
  const dash = (text: string) => (ready ? text : emptyValue('unknown'))

  /* ===== 数の帯（4マス） ===== */
  const stats = (
    <KpiBand>
      <KpiCard
        presentation="band"
        title="たまる決めごと"
        icon={<ListOrdered size={16} aria-hidden="true" />}
        value={ready ? rules.length : null}
        unit="件"
        detail={dash(`動いている ${formatMileageNumber(activeRules.length)}・止めている ${formatMileageNumber(rules.length - activeRules.length)}`)}
      />
      <KpiCard
        presentation="band"
        title="直近30日 付けたマイル"
        icon={<Coins size={16} aria-hidden="true" />}
        value={ready ? grantedMiles ?? 0 : null}
        unit=""
        detail={dash(`${formatMileageNumber(grantedCount ?? 0)} 件`)}
      />
      <KpiCard
        presentation="band"
        title="直近30日 使われたマイル"
        icon={<Gift size={16} aria-hidden="true" />}
        value={ready ? Math.abs(spentMiles ?? 0) : null}
        unit=""
        detail={dash(`交換 ${formatMileageNumber(spentCount ?? 0)} 件`)}
      />
      <KpiCard
        presentation="band"
        title="残高の合計"
        icon={<Wallet size={16} aria-hidden="true" />}
        value={ready ? balanceTotal : null}
        unit=""
        detail={<span title={ready && averageDenominator !== null && balanceTotal !== null ? averageDenominator > 0 ? `残高0の人は除き、マイルを持っている${formatMileageNumber(averageDenominator)}人で割った平均：${formatMileageNumber(balanceTotal / averageDenominator)}マイル` : '残高がある人がいないため計算していません' : undefined}>{ecBalanceSource ? 'ECと同期' : dash(`友だち ${formatMileageNumber(friendTotal ?? 0)} 人`)}</span>}
      />
    </KpiBand>
  )

  /* 主ボタンは素の Button で渡し、題の右の自動整列（副→主）に載せる。 */
  const createButton = (full: boolean) => (
    readonly ? null : (
      <Button variant="primary" className={full ? 'v8-folder-create w-full' : undefined} href="/mileage/earning-rules/new">
        <Plus size={16} aria-hidden="true" /> 決めごとを作る
      </Button>
    )
  )

  /*
   * 左のフォルダの列は共通の ManagedFolderPanel。決めごとをフォルダへ入れる受け口（folder_id）がまだ無いので
   * 「すべて」だけを出す。受け口ができたら kind="mileage_rule" を渡すだけで、追加・「…」・未分類が出る。
   */
  const folderPanel = (
    <ManagedFolderPanel
      kind={null}
      folders={[]}
      onChanged={() => undefined}
      canManage={!readonly}
      createAction={createButton(true)}
      reserveCreateSpace={false}
      itemLabel="決めごと"
      activeId="all"
      onSelect={() => undefined}
      allCount={folderCounts.get('all') ?? null}
    />
  )

  /* きっかけで絞る（固定の分け方）。件数も添える。 */
  const folderSelect = (
    <div className={styles.narrowFolder}>
      <SaveErrorField names={["folder"]}><Select
        aria-label="きっかけ"
        label="きっかけ"
        value={folder}
        options={FOLDERS.map((item) => ({ value: item.key, label: item.key === 'all' ? item.label : `${item.label} ${formatMileageNumber(folderCounts.get(item.key) ?? 0)}` }))}
        onChange={(value) => resetPage(() => setFolder(value as FolderKey))}
      /></SaveErrorField>
    </div>
  )

  const searchBox = (
    <SearchField
      aria-label="決めごとの名前で探す"
      placeholder="決めごとの名前で探す"
      value={searchInput}
      onChange={setSearchInput}
      onClear={() => { setSearchInput(''); setSearch(''); setPage(1) }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          setPage(1)
          setSearch(searchInput.trim())
        }
      }}
    />
  )

  const filterChips = (
    <div role="group" aria-label="状態で絞り込む" className={styles.chipGroup}>
      <FilterChip
        selected={activeOnly}
        icon={<CircleDot size={16} aria-hidden="true" />}
        onChange={(selected) => resetPage(() => {
          setActiveOnly(selected)
          if (selected) setStoppedOnly(false)
        })}
      >
        {`動いている ${formatMileageNumber(activeRules.length)}`}
      </FilterChip>
      <FilterChip
        selected={pendingOnly}
        icon={<Clock3 size={16} aria-hidden="true" />}
        onChange={(selected) => resetPage(() => setPendingOnly(selected))}
      >
        {`確定待ちあり ${formatMileageNumber(pendingRules.length)}`}
      </FilterChip>
      {orderDirty && !readonly ? (
        <Button onClick={() => void saveOrder()} disabled={savingOrder} busy={savingOrder} busyLabel="保存しています">
          並び順を保存する
        </Button>
      ) : null}
    </div>
  )

  const savedBox = (
    <ListToolbarOptional compact label="保存した絞り込み">

      <SaveErrorField names={["presetValue","page","preset_value"]}><Select size="content"
        icon={<Bookmark size={16} aria-hidden="true" />}
        aria-label="よく使う絞り込み"
        value={presetValue}
        options={[
          ...PRESETS.map((p) => ({ value: p.value, label: p.label })),
          ...(presetValue === 'custom' ? [{ value: 'custom', label: 'いまの絞り込み' }] : []),
        ]}
        onChange={(value) => {
          const preset = PRESETS.find((p) => p.value === value)
          if (!preset) return
          setPage(1)
          setActiveOnly(preset.active)
          setPendingOnly(preset.pending)
          setStoppedOnly(preset.stopped)
          setSort(preset.sort)
        }}
      /></SaveErrorField>
    </ListToolbarOptional>
  )

  const perPageBox = (
    <div data-per-page-select>
      <SaveErrorField names={["pageSize","page","page_size"]}><Select
        aria-label="1ページに出す件数"
        size="page-size"
        value={String(pageSize)}
        onChange={(value) => { setPage(1); setPageSize(Number(value)) }}
        options={PAGE_SIZE_OPTIONS}
      /></SaveErrorField>
    </div>
  )

  const notices = (
    <>

      {actionError ? <div className={styles.fullRow}><Notice tone="danger" message={actionError} /></div> : null}
      {menuNotice ? <div className={styles.fullRow}><Notice tone="success" message={menuNotice} /></div> : null}
      {orderDirty && !readonly ? (
        <div className={styles.fullRow}>
          <Notice tone="warn" message={`並び順を変えています。保存するまでこの画面の並びは仮のままです。${savingOrder ? '保存しています…' : ''}`} />
        </div>
      ) : null}
    </>
  )

  /* 作成・フォルダは型の畳む口、検索・条件は共通の道具へ渡す。 */
  const toolbar = (
    <ListToolbarFrame>
      {notices}
      <ListToolbar
        searchSlot={narrow ? searchBox : undefined}
        search={narrow ? undefined : {
          placeholder: '決めごとの名前で探す',
          value: searchInput,
          width: 240,
          onChange: (value) => {
            setSearchInput(value)
            if (!value) { setSearch(''); setPage(1) }
          },
        }}
        filters={<><ListToolbarOptional compact label="きっかけ">{folderSelect}</ListToolbarOptional>{filterChips}</>}
        trailing={<>{savedBox}{perPageBox}</>}
      />
    </ListToolbarFrame>
  )

  const rowMenu = (rule: MileageEarningRuleV6) => {
    const active = rule.published.status === 'published'
    return (
      <div className={styles.menuBox}>
        <RowMenu
          label={`${rule.draft.name}の操作`}
          open={menuId === rule.id}
          onOpenChange={(next) => setMenuId(next ? rule.id : null)}
          items={[
            {
              id: 'view',
              label: rule.publishedVersion == null ? '下書きの内容を見る' : '公開版の中身を見る',
              onSelect: () => setViewTarget(rule),
            },
            /* 閲覧のみの人には、変える操作を出さない（押せない形で残さない）。 */
            ...(readonly ? [] : [
              {
                id: 'edit',
                label: '編集',
                external: false,
                href: `/mileage/earning-rules/edit?id=${encodeURIComponent(rule.id)}`, onSelect: () => router.push(`/mileage/earning-rules/edit?id=${encodeURIComponent(rule.id)}`),
              },
              {
                id: 'test',
                label: 'この内容をテスト',
                disabled: testBusy,
                disabledReason: 'テストを実行しています',
                onSelect: () => void runTest(rule),
              },
              {
                id: 'toggle',
                label: active ? '止める' : '再開する',
                disabled: savingId === rule.id,
                disabledReason: '反映しています',
                onSelect: () => void toggleRule(rule),
              },
              {
                id: 'publish',
                label: '公開して反映',
                disabled: savingId !== null,
                disabledReason: '別の決めごとを反映しています',
                onSelect: () => { if (!selectedAccountId || loadedAccountScope.current !== accountScope.current.generation) return; setPublishError(''); setPublishAccount({ id: selectedAccountId, generation: accountScope.current.generation }); setPublishTarget(rule) },
              },
              {
                id: 'duplicate',
                label: '複製',
                disabled: savingId !== null,
                disabledReason: 'ほかの操作を反映しています',
                onSelect: () => void duplicateRule(rule),
              },
            ]),
            {
              id: 'history',
              label: 'この決めごとの履歴を見る',
              onSelect: () => router.push('/mileage?tab=history'),
            },
            ...(rule.publishedVersion == null && !readonly ? [{
              id: 'delete',
              label: 'この決めごとを削除する',
              tone: 'danger' as const,
              dividerBefore: true,
              disabled: savingId !== null,
              disabledReason: 'ほかの操作を反映しています',
              onSelect: () => { if (!selectedAccountId || loadedAccountScope.current !== accountScope.current.generation) return; setDeleteError(''); setDeleteAccount({ id: selectedAccountId, generation: accountScope.current.generation }); setDeleteTarget(rule) },
            }] : []),
          ]}
        />
      </div>
    )
  }

  /* 表：絵の列の並び（見出し 13/20・行 9/20・欄の間16・行 56）。1152 も同じ列（先頭の列が縮む）。 */
  const table = (
    <div className={styles.tableWrap}>
      <DataTable columnLayout={MILEAGE_TABLE_LAYOUT} columnSizing="content">
        <thead>
          <TableHeadRow data-table-layout="columns">
            <Th grow>何をしてくれたら</Th>
            <Th collapseAt="narrow" className={styles.colEvent}>対象の行動</Th>
            <Th align="right" className={styles.colMiles}>たまるマイル</Th>
            <Th collapseAt="narrow" className={styles.colValidity}>有効期間・失効</Th>
            <Th align="right" className={styles.colRecent}>この30日</Th>
            <Th className={styles.colState}>状態</Th>
            <Th className={styles.colOps}>操作</Th>
          </TableHeadRow>
        </thead>
        <tbody>
          {visible.map((rule) => {
            const active = rule.published.status === 'published'
            const orderIndex = ruleOrder.indexOf(rule.id)
            const validity = validityText(rule)
            return (
              <Tr key={rule.id} data-table-layout="columns" data-row-id={rule.id}>
                <Td grow>
                  <div className={styles.rowNameLine}>
                    <FolderDotName folder={null}>
                      <span  ><TruncatedText value={String(rule.draft.name ?? '')} /></span>
                    </FolderDotName>
                  </div>

                </Td>
                <Td collapseAt="narrow" className={styles.colEvent}>
                  <span className={styles.cellMain}>{ruleEventLabel(rule.draft.eventType, EVENT_LABELS)}</span>
                  <span className={styles.cellSub}>{rule.draft.initialStatus === 'pending' ? '確定待ち' : 'すぐ使える'}</span>
                </Td>
                <Td align="right" className={styles.colMiles}><span className={styles.cellMain}>{formatMileageNumber(rule.draft.amount)}</span></Td>
                <Td collapseAt="narrow" className={styles.colValidity}><span className={styles.cellMain} title={validity.miles}>{validity.miles}</span><span className={styles.cellSub} title={validity.rule}>{validity.rule}</span></Td>
                <Td align="right" className={styles.colRecent} data-list-number="">
                  <span className={styles.cellMain}>{formatMileageNumber(grantedMiles30d(rule))}</span>
                  <span className={styles.cellSub}>{`対象外 ${formatMileageNumber(rule.metrics30d.excluded)} 回`}</span>
                </Td>
                <Td className={styles.colState}>
                  <StatusBadge tone={mileageStatusTone(active ? 'active' : 'neutral')}>{active ? '動いています' : '止めています'}</StatusBadge>
                </Td>
                <Td className={styles.colOps}>
                  <span className={styles.rowActions}>
                    {readonly ? null : <>
                      <IconButton
                        aria-label={`${rule.draft.name}を上へ`}
                        title="上へ"
                        disabled={!canMove || orderIndex <= 0}
                        onClick={() => moveRule(rule.id, -1)}
                      >
                        <ArrowUp size={16} aria-hidden="true" />
                      </IconButton>
                      <IconButton
                        aria-label={`${rule.draft.name}を下へ`}
                        title="下へ"
                        disabled={!canMove || orderIndex < 0 || orderIndex >= ruleOrder.length - 1}
                        onClick={() => moveRule(rule.id, 1)}
                      >
                        <ArrowDown size={16} aria-hidden="true" />
                      </IconButton>
                    </>}
                    {rowMenu(rule)}
                  </span>
                </Td>
              </Tr>
            )
          })}
        </tbody>
      </DataTable>
    </div>
  )

  const body = loading ? (
    <ListState kind="loading" title="たまる決めごとを読み込んでいます" />
  ) : loadError ? (
    <ListState kind="error"
      title="たまる決めごとを読み込めませんでした"
      description="数の帯は「—」にしています。道具はそのまま使えます。"
      onRetry={() => void load()}
    />
  ) : visible.length === 0 ? (
    /* 修正案 D-2：空の一覧。 */
    <EmptyList
      icon={<Coins aria-hidden="true" />}
      title="まだたまる決めごとがありません"
      description="どの行動で何マイル付けるかを決めて、友だちにマイルをためます。"
      create={{ label: '最初の決めごとを作る', href: '/mileage/earning-rules/new' }}
      canCreate={!readonly}
      filtered={rules.length > 0}
      onClearFilters={resetAll}
      filteredDescription="名前の検索や絞り込みを外すと、すべて出ます"
    />
  ) : (
    <>
      {table}
    </>
  )

  const pager = ready && visible.length > 0 ? (
    <ListPagePagination>
      <Pagination page={page} pageCount={pageCount} onPageChange={setPage} range={{ total: shown.length, first: (page - 1) * pageSize + 1, last: Math.min(page * pageSize, shown.length) }} />
    </ListPagePagination>
  ) : undefined

  return (
    <SaveErrorScope errors={saveErrors}><MileageFrame
      help={readonly ? '行の「…」から この決めごとの履歴を見る。' : '行の「…」から 編集・止める・複製・この決めごとの履歴を見る。'}
      explanation="決めごとを変えると、変えたあとの行動から新しい数で付きます。前に付いたマイルは変わりません。"
      actions={
        <Button onClick={() => void exportCsv()} disabled={exporting || rules.length === 0}>
          <Download size={16} aria-hidden="true" /> CSVで書き出す
        </Button>
      }
      stats={stats}
      folders={folderPanel}
      folderNav={{ rows: [{ id: 'all', label: 'すべて' }], activeId: 'all', onSelect: () => undefined, createAction: readonly ? undefined : createButton(false) }}
      toolbar={toolbar}
      pagination={pager}
      overlays={<>
        <Dialog
          open={viewTarget !== null}
          title={viewTarget?.publishedVersion == null ? '下書きの内容' : '公開版の中身'}
          onCancel={() => setViewTarget(null)}
        >
          {viewTarget ? <>
            <p>{viewTarget.publishedVersion == null
              ? `${viewTarget.draft.name}・${ruleEventLabel(viewTarget.draft.eventType, EVENT_LABELS)}・${formatMileageNumber(viewTarget.draft.amount)}マイル`
              : `${viewTarget.published.name}・${ruleEventLabel(viewTarget.published.eventType, EVENT_LABELS)}・${formatMileageNumber(viewTarget.published.amount)}マイル`}</p>
            <p>{viewTarget.publishedVersion == null
              ? `下書き 第${viewTarget.draftVersion}版・${formatMileageDate(viewTarget.draftUpdatedAt)} に保存・まだ公開版はありません`
              : `公開中の第${viewTarget.publishedVersion}版・${formatMileageDate(viewTarget.published.updatedAt)} に反映`}</p>
            <p>{viewTarget.draft.targetConditions
              ? `利用対象：条件 ${viewTarget.draft.targetConditions.rules.length + (viewTarget.draft.targetConditions.groups?.reduce((sum, group) => sum + group.rules.length, 0) ?? 0)}件・下書き 第${viewTarget.draftVersion}版`
              : `利用対象：すべての友だち・下書き 第${viewTarget.draftVersion}版`}</p>
          </> : null}
        </Dialog>
        <ConfirmDialog
          open={publishTarget !== null && publishAccount?.generation === accountScope.current.generation}
          title={publishTarget ? `「${publishTarget.draft.name}」の下書きを公開して反映しますか？` : '下書きを公開して反映しますか？'}
          description="公開後に受け付けたイベントから新しい内容になります。公開前に受け付けた分と、すでについたマイルは変わりません。取り消せません。"
          confirmLabel="公開して反映"
          destructive
          busy={publishTarget !== null && savingId === publishTarget.id}
          error={publishError || undefined}
          onCancel={() => { if (savingId === null) setPublishTarget(null) }}
          onConfirm={() => { if (publishTarget && publishAccount?.generation === accountScope.current.generation && !readonlyRef.current) void publishRule(publishTarget) }}
        >
          {publishAccount ? <OperationTargetSummary accounts={[{ id: publishAccount.id }]} /> : null}
        </ConfirmDialog>
        <ConfirmDialog
          open={deleteTarget !== null && deleteAccount?.generation === accountScope.current.generation}
          title={deleteTarget ? `「${deleteTarget.draft.name}」を削除しますか？` : '決めごとを削除しますか？'}
          description="まだ公開していない決めごとの下書きごと消えます。取り消せません。すでに動いている決めごとは、削除ではなく停止を選んでください。"
          confirmLabel="削除する"
          destructive
          busy={deleteTarget !== null && savingId === deleteTarget.id}
          error={deleteError || undefined}
          onCancel={() => { if (savingId === null) setDeleteTarget(null) }}
          onConfirm={() => { if (deleteTarget && deleteAccount?.generation === accountScope.current.generation && !readonlyRef.current) void deleteRule(deleteTarget) }}
        >{deleteAccount ? <OperationTargetSummary accounts={[{ id: deleteAccount.id }]} /> : null}</ConfirmDialog>
        <Dialog
          open={testTarget !== null}
          title={testTarget ? `「${testTarget.draft.name}」をテスト` : '決めごとをテスト'}
          description="この30日の記録に当てはめて、何人に・合計いくら付きそうかを見ます。実際には付与されず、履歴も増えません。"
          confirmLabel="閉じる"
          onConfirm={() => setTestTarget(null)}
          onCancel={() => setTestTarget(null)}
          busy={testBusy}
        >
          {testError ? (
            <Notice tone="danger" message={testError} />
          ) : testResult ? (
            <dl className={styles.testList}>
              <div><dt>条件に合う行動</dt><dd>{formatMileageNumber(testResult.matchedEvents)} 回</dd></div>
              <div><dt>対象になる友だち</dt><dd>{formatMileageNumber(testResult.matchedFriends)} 人</dd></div>
              <div><dt>付与見込みの合計</dt><dd>{formatMileageNumber(testResult.estimatedTotalMiles)} マイル</dd></div>
              <div><dt>1人あたり最大</dt><dd>{formatMileageNumber(testResult.maxPerFriend)} マイル</dd></div>
              <div><dt>付いた直後の状態</dt><dd>{testResult.initialStatus === 'pending' ? '確定待ち' : 'すぐ使える'}</dd></div>
              <div><dt>失効の例</dt><dd>{testResult.expirationExampleAt ? formatMileageDate(testResult.expirationExampleAt) : '失効なし'}</dd></div>
              {testResult.overlappingRuleNames.length > 0 ? (
                <div><dt>同じきっかけの決めごと</dt><dd>{testResult.overlappingRuleNames.join('、')}</dd></div>
              ) : null}
            </dl>
          ) : (
            <ListState kind="loading" title="テストしています" description="実際の付与は行いません。" />
          )}
        </Dialog>
        <UnsavedLeaveDialog
          open={leaveTarget !== null}
          subject="たまる決めごとの並び順への変更"
          busy={savingOrder}
          onConfirm={confirmLeave}
          onCancel={cancelLeave}
        />
      </>}
    >
      {body}
    </MileageFrame></SaveErrorScope>
  )
}
