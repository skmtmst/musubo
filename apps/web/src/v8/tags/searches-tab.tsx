'use client'
import { knownValue } from '@/lib/known-value'
import { DetailContent, DetailFields, DetailInlineEdit } from '@/components/shared/detail-content'

import { notifySaved, notifyToast } from '@/components/shared/toast';
import { useListUrlValue } from '@/components/shared/list-url-state';
import { FolderDotName } from '@/components/shared/folder-dot';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Bookmark, CircleDashed, Filter, MousePointerClick, Send } from 'lucide-react';

import { RowNameLink } from '@/components/shared/table';



import Link from '@/components/shared/list-navigation'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation';
import { AlertCircle } from 'lucide-react';
import type { SavedSearch, Tag } from '@line-crm/shared';
import { api, ApiError, type SavedSearchSummary } from '@/lib/api';
import { ListPageBody } from '@/components/templates';
import { type ActionMenuItem } from '@/components/shared/action-menu';
import { RowMenu } from '@/components/shared/row-actions';
import DetailPanel from '@/components/shared/detail-panel';
import { useHeldDetail, useInlineDetailGuard } from '@/components/shared/use-inline-detail-guard'
import ContextMenu, { type ContextMenuItem } from '@/components/shared/context-menu';
import InlineEdit from '@/components/shared/inline-edit'
import { withViewTransition } from '@/components/shared/view-transition';
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Button from '@/components/shared/button'
import Select from '@/components/shared/select'
import StatusBadge from '@/components/shared/status-badge'
import { ListPager } from '@/components/templates/list-page'
import Pagination from '@/components/shared/pagination'
import SearchField from '@/components/shared/search-field'
import KpiCard from '@/components/shared/kpi-card'
import KpiBand from '@/components/shared/kpi-band'
import { DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table';
import { DelayedSkeleton } from '@/components/shared/skeleton';
import PageSizeSelect, { PAGE_SIZES as STANDARD_PAGE_SIZES } from '@/components/shared/page-size-select';
import { mergeVisibleOrder } from '@/components/friend-fields/reorder-utils';
import { splitConditions } from '@/components/friend-fields/saved-search-list';
import type { SavedSearchConditionLabels } from '@/components/friends/saved-search-utils';
import { filterSavedSearches, savedSearchKpiValues, type SavedSearchUsageFilter } from '@/components/friend-fields/saved-search-kpis';
import { formatDay, formatNumber } from '@/lib/format';
import styles from './list.module.css'
import TruncatedText from '@/components/shared/truncated-text'
import { permissionDeniedMessage, describeApiFailure } from '@/components/shared/api-error-message';
import { emptyValue } from '@/components/shared/empty-value';
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors';
import { ListToolbarEnd, ListToolbarSearchSlot } from '@/components/shared/list-toolbar';
import { RefreshCover } from '@/components/shared/refresh-cover'
import { RovingTbody } from '@/components/shared/row-roving'
import { useListSnapshot } from '@/lib/use-list-snapshot'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'

/*
 * ★V8 タグ「保存した検索」タブ（Pencil ）。
 *
 * ここは管理だけ。条件を作るのは友だち一覧の絞り込みで、「この条件を保存」で増える。
 * 動き（読み込み・数の帯・絞り込み・並べ替え・削除・行の詳細パネル・名前のその場の直し・右クリック）は
 * 現役の V8 タブ（src/v8/tags/searches-tab.tsx）から写した。見た目は絵に合わせた：
 * 表は「条件名・内容／該当／共有／使っている所／更新／友だち一覧へ／…」。つまみの列は無く、
 * 並べ替えは行の「…」の「上へ動かす・下へ動かす」（つまみで ↑↓ と同じ口）。
 * 絵の下の段のとおり、行の「…」に「複製して保存」を足した（同じ条件で新しく保存する）。
 */

const PAGE_SIZES = STANDARD_PAGE_SIZES
const MAX_SAVED = 50

/* 使っている所の種類（絵の言葉）。 */
const USAGE_WORDS: Record<string, string> = {
  broadcast: '一斉配信',
  automation: '自動処理',
  scenario: 'シナリオ',
  other: 'そのほか',
}

/** 条件の要約（絵：「タグ「VIP」を含む かつ タグ「未契約」を含む」）。 */
export function conditionSummary(split: { all: string[]; any: string[]; note: string | null }): string {
  const all = split.all.join(' かつ ')
  const any = split.any.join(' または ')
  const main = all && any ? `${all} かつ （${any}）` : all || any || emptyValue('unconfigured')
  return split.note ? `${main}・${split.note}` : main
}

/** 使っている所（1件は「一斉配信「秋の案内」」、複数は「一斉配信 2・自動処理 1」、なしは「なし」）。 */
export function usageSummary(usedIn: SavedSearch['usedIn']): string {
  if (usedIn === undefined) return '—'
  if (usedIn.length === 0) return 'なし'
  if (usedIn.length === 1) return `${knownValue(USAGE_WORDS, usedIn[0].kind, 'そのほか')}「${usedIn[0].name}」`
  const counts = new Map<string, number>()
  for (const usage of usedIn) {
    const word = knownValue(USAGE_WORDS, usage.kind, 'そのほか')
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  return [...counts].map(([word, count]) => `${word} ${count}`).join('・')
}

/** 更新（「Kenta・8月20日」）。 */
function updatedText(search: SavedSearch): string {
  const who = search.updatedBy ?? search.createdBy ?? emptyValue('unknown')
  const day = formatDay(search.updatedAt ?? search.createdAt).replace(/（.）$/, '')
  return `${who}・${day}`
}

export default function SearchesTab({ accountId, canEdit, explanation = false }: { accountId: string | null; canEdit: boolean; explanation?: boolean }) {
  const saveErrors = useSaveFormErrors()
  const router = useRouter()
  const { value: items, setValue: setItems, hasValue: loaded } = useListSnapshot<SavedSearch[]>(accountId ?? '', [])
  const { value: summary, setValue: setSummary } = useListSnapshot<SavedSearchSummary | null>(accountId ?? '', null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [forbidden, setForbidden] = useState(false)
  const [labelsLoading, setLabelsLoading] = useState(false)
  const [labelsFailed, setLabelsFailed] = useState(false)
  // 並び替え・削除・複製の失敗。読み込みの失敗は loadError。
  const [error, setError] = useState('')
  const [retryOrder, setRetryOrder] = useState<SavedSearch[] | null>(null)
  const { value: tags, setValue: setTags } = useListSnapshot<Tag[]>(accountId ?? '', [])
  const { value: conditionLabels, setValue: setConditionLabels } = useListSnapshot<SavedSearchConditionLabels>(accountId ?? '', {})
  const [pendingDelete, setPendingDelete] = useState<SavedSearch | null>(null)
  const deleteTicket = useRef<object | null>(null)
  const renderedDeleteTicket = deleteTicket.current
  const deleteLock = useRef(false)
  const currentAccount = useRef(accountId)
  currentAccount.current = accountId
  const [query, setQuery] = useListUrlValue('q', '')
  const [usageFilter, setUsageFilter] = useListUrlValue<SavedSearchUsageFilter>('usageFilter', 'all')
  const [matchFilter, setMatchFilter] = useListUrlValue<'all' | 'matched' | 'zero' | 'unknown'>('matchFilter', 'all')
  const [pageSize, setPageSize] = useListUrlValue('pageSize', 20)
  const [page, setPage] = useListUrlValue('page', 1)
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  /* 行の詳細パネル。URL に ?search=<id> を残す。 */
  const detailGuard = useInlineDetailGuard('search')
  const { id: activeSearchId, setId: setActiveSearchId } = detailGuard
  const openSearchDetail = (id: string) => withViewTransition(() => setActiveSearchId(current => current === id ? null : id))
  const loadSequence = useRef(0)
  const loadInFlight = useRef(false)
  const labelsSequence = useRef(0)
  const labelsInFlight = useRef(false)

  const fetchLabels = useCallback(async (targetAccountId: string, { userInitiated = false } = {}) => {
    if (userInitiated && labelsInFlight.current) return
    const seq = ++labelsSequence.current
    labelsInFlight.current = true
    setLabelsLoading(true)
    try {
      /* 補助取得（タグ名・マーク名・シナリオ名・項目名）は一覧とは別に待つ（PERF-14）。 */
      const [tagResult, markResult, scenarioResult, fieldResult] = await Promise.allSettled([
        api.tags.list({ accountId: targetAccountId }),
        api.supportMarks.list(targetAccountId, { suppressFeatureDisabledEvent: true }),
        api.scenarios.list({ accountId: targetAccountId }),
        api.friendFields.list(targetAccountId, undefined, { suppressFeatureDisabledEvent: true }),
      ])
      if (seq !== labelsSequence.current || currentAccount.current !== targetAccountId) return
      const isOptionalDisabled = (result: PromiseSettledResult<unknown>) =>
        result.status === 'rejected' && result.reason instanceof ApiError && (result.reason.status === 403 || result.reason.status === 404)
      const ok = (result: PromiseSettledResult<{ success: boolean }>) => result.status === 'fulfilled' && result.value.success
      const anyFailed =
        !ok(tagResult) ||
        (!ok(markResult) && !isOptionalDisabled(markResult)) ||
        !ok(scenarioResult) ||
        (!ok(fieldResult) && !isOptionalDisabled(fieldResult))
      if (tagResult.status === 'fulfilled' && tagResult.value.success) setTags(tagResult.value.data)
      setConditionLabels({
        marks: markResult.status === 'fulfilled' && markResult.value.success
          ? Object.fromEntries(markResult.value.data.map((mark) => [mark.id, mark.name]))
          : {},
        scenarios: scenarioResult.status === 'fulfilled' && scenarioResult.value.success
          ? Object.fromEntries(scenarioResult.value.data.map((scenario) => [scenario.id, scenario.name]))
          : {},
        fields: fieldResult.status === 'fulfilled' && fieldResult.value.success
          ? Object.fromEntries(fieldResult.value.data.map((field) => [field.fieldKey, field.name]))
          : {},
      })
      setLabelsFailed(anyFailed)
    } finally {
      if (seq === labelsSequence.current) {
        labelsInFlight.current = false
        setLabelsLoading(false)
      }
    }
  }, [setTags, setConditionLabels])

  const reloadLabels = useCallback(async () => {
    if (!accountId) return
    await fetchLabels(accountId, { userInitiated: true })
  }, [accountId, fetchLabels])

  const load = useCallback(async ({ userInitiated = false } = {}) => {
    if (userInitiated && loadInFlight.current) return
    const sequence = ++loadSequence.current
    loadInFlight.current = true
    setLoading(true)
    setLoadError('')
    setForbidden(false)
    setLabelsFailed(false)
    if (!accountId) {
      loadInFlight.current = false
      setLoading(false)
      return
    }
    void fetchLabels(accountId)
    try {
      const savedSearches = await api.savedSearches.list(accountId, { limit: MAX_SAVED })
      if (sequence !== loadSequence.current) return
      if (!savedSearches.success) throw new Error('保存した検索を読み込めませんでした')
      setItems(savedSearches.items)
      setSummary(savedSearches.summary)
    } catch (reason) {
      const fieldFailure = saveErrors.capture(reason);

      if (sequence === loadSequence.current) {
        if (reason instanceof ApiError && reason.status === 403) setForbidden(true)
        else { if (!fieldFailure) setLoadError(describeApiFailure(reason, '保存した検索の読み込み')) }
      }
    } finally {
      if (sequence === loadSequence.current) {
        loadInFlight.current = false
        setLoading(false)
      }
    }
  }, [accountId, fetchLabels, saveErrors, setItems, setSummary])
  useEffect(() => { void load() }, [load])

  /* アカウントが変わったら、前のアカウントの削除確認を閉じる。 */
  useEffect(() => {
    deleteTicket.current = null
    setPendingDelete(null)
    setError('')
    setRetryOrder(null)
    setPage(1)
    setOpenMenuId(null)
    return () => {
      labelsSequence.current += 1
      labelsInFlight.current = false
    }
  }, [accountId])

  const confirmRemove = async (search: SavedSearch) => {
    if (!renderedDeleteTicket || renderedDeleteTicket !== deleteTicket.current || deleteLock.current) return false
    deleteLock.current = true
    setError('')
    try {
      if (!accountId || accountId !== currentAccount.current || search.lineAccountId !== accountId) return false
      await api.savedSearches.delete(search.id, accountId)
      if (renderedDeleteTicket !== deleteTicket.current || accountId !== currentAccount.current) return false
      deleteTicket.current = null
      setPendingDelete(null)
      notifyToast(`保存した検索「${search.name}」を削除しました`)
      void load()
      return true
    } catch (reason) {
      if (renderedDeleteTicket !== deleteTicket.current || accountId !== currentAccount.current) return false
      saveErrors.capture(reason)
      setError(describeApiFailure(reason, '削除'))
      return false
    } finally {
      deleteLock.current = false
    }
  }

  /* 複製して保存：同じ条件・共有範囲で、名前に「のコピー」を付けて新しく保存する。 */
  const duplicate = async (search: SavedSearch) => {
    if (!search.lineAccountId) return
    setError('')
    try {
      const res = await api.savedSearches.create({
        name: `${search.name}のコピー`,
        accountId: search.lineAccountId,
        conditions: search.conditions,
        isShared: search.isShared,
      })
      if (!res.success) throw new Error(res.error)
      notifySaved(`「${search.name}のコピー」を保存しました`)
      void load()
    } catch (reason) {
      const fieldFailure = saveErrors.capture(reason)

      { if (!fieldFailure)

      setError(describeApiFailure(reason, '複製')) }
    }
  }

  /* 並び替えは /api/saved-searches/reorder へ1回で渡す（ATTR-02/03）。 */
  const applyOrder = async (next: SavedSearch[]) => {
    if (!accountId) return
    const previous = items
    setItems(next)
    setError('')
    setRetryOrder(null)
    try {
      const res = await api.savedSearches.reorder(accountId, next.map((search) => search.id))
      if (!res.success) throw new Error(res.error)
      void load()
    } catch (reason) {
      const fieldFailure = saveErrors.capture(reason)
      setItems(previous);

      const message = describeApiFailure(reason, '並び順の保存')
      { if (!fieldFailure)

      setError(message) }
      setRetryOrder(next)
      notifyToast(message, { tone: 'error', actionLabel: 'もう一度', onAction: () => { void applyOrder(next) } })
    }
  }

  const ready = Boolean(accountId) && loaded && !loadError && !forbidden
  const kpis = summary ?? savedSearchKpiValues(items, ready)

  const filteredList = filterSavedSearches(items, query, usageFilter).filter((item) => {
    /* 未集計（null）は「0人」にも「1人以上」にも数えない（ATTR-08）。 */
    const count = item.matchCount
    const uncounted = count === null || count === undefined
    if (matchFilter === 'unknown') return uncounted
    if (uncounted) return matchFilter === 'all'
    if (matchFilter === 'all') return true
    return matchFilter === 'zero' ? count === 0 : count > 0
  })
  const pages = Math.max(1, Math.ceil(filteredList.length / pageSize))
  const currentPage = Math.min(page, pages)
  const visible = filteredList.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  const activeSearch = useHeldDetail(items.find((item) => item.id === activeSearchId) ?? null, activeSearchId, detailGuard.holding, accountId)
  const activeSearchIndex = visible.findIndex((item) => item.id === activeSearchId)
  useEffect(() => setPage(1), [query, usageFilter, matchFilter, pageSize])

  /** 1つ上・下へ動かす（見えている並びの中で）。 */
  const moveBy = async (id: string, direction: -1 | 1) => {
    const order = filteredList.map((search) => search.id)
    const from = order.indexOf(id)
    const to = from + direction
    if (from < 0 || to < 0 || to >= order.length) return
    order.splice(to, 0, ...order.splice(from, 1))
    const visibleNext = order.map((i) => items.find((item) => item.id === i)).filter(Boolean) as SavedSearch[]
    await applyOrder(mergeVisibleOrder(items, visibleNext))
  }

  /* 行の「…」と右クリックは同じ中身。閲覧のみは変える操作を出さない（2026-10-06 オーナー）。 */
  const rowMenuItemsRaw = (search: SavedSearch): ActionMenuItem[] => {
    const list: ActionMenuItem[] = []
    const index = filteredList.findIndex((item) => item.id === search.id)
    if (search.lineAccountId) {
      list.push({ id: 'open', label: '友だち一覧へ', external: false, href: `/friends?savedSearch=${search.id}`, onSelect: () => router.push(`/friends?savedSearch=${search.id}`) })
      if (canEdit) {
        list.push({ id: 'edit', label: '編集', external: false, href: `/tags/searches/edit?id=${encodeURIComponent(search.id)}`, onSelect: () => router.push(`/tags/searches/edit?id=${encodeURIComponent(search.id)}`) })
        list.push({
          id: 'duplicate',
          label: '複製して保存',
          disabled: items.length >= MAX_SAVED,
          disabledReason: items.length >= MAX_SAVED ? `保存は最大 ${MAX_SAVED} 件です` : undefined,
          onSelect: () => void duplicate(search),
        })
      }
    }
    if (canEdit) {
      list.push({ id: 'up', label: '上へ動かす', dividerBefore: list.length > 0, disabled: index <= 0, onSelect: () => void moveBy(search.id, -1) })
      list.push({ id: 'down', label: '下へ動かす', disabled: index < 0 || index >= filteredList.length - 1, onSelect: () => void moveBy(search.id, 1) })
      const deleteDisabled = !search.lineAccountId || search.canDelete !== true
      const deleteReason = !search.lineAccountId
        ? '管理者が対象アカウントを割り当てるまで変更できません'
        : search.usedIn === undefined
          ? '使用先を確認できないため削除できません'
          : (search.usedIn?.length ?? 0) > 0
            ? `使用中のため削除できません（${search.usedIn?.length ?? 0} 件）`
            : '削除できるか確認できません'
      list.push({
        id: 'delete',
        label: '削除する',
        tone: 'danger',
        dividerBefore: true,
        disabled: deleteDisabled,
        disabledReason: deleteDisabled ? deleteReason : undefined,
        onSelect: () => { deleteTicket.current = {}; setError(''); setPendingDelete(search) },
      })
    }
    return list
  }
  const rowMenuItems = (search: SavedSearch): ActionMenuItem[] => rowMenuItemsRaw(search).map(item => item.onSelect ? { ...item, onSelect: () => detailGuard.protect(() => { void item.onSelect?.() }) } : item)
  const searchContextItems = (search: SavedSearch): ContextMenuItem[] =>
    rowMenuItems(search).map((item) => ({
      id: item.id,
      label: item.label,
      danger: item.tone === 'danger',
      disabled: item.disabled,
      onSelect: () => item.onSelect?.(),
    }))

  const sharedCount = items.filter((item) => item.isShared).length
  const kpiLoading = Boolean(accountId) && !loaded && !loadError && !forbidden
  const kpiError = Boolean(loadError)
  const kpiUnavailableDetail = forbidden ? '権限がありません' : kpiError ? '読み込めませんでした' : kpiLoading ? '読み込んでいます' : null
  const kpiCards = [
    { title: '保存した条件', icon: Bookmark, value: forbidden || kpiError ? null : kpis.total, unit: '件', detail: kpiUnavailableDetail ?? (ready ? `自分 ${items.length - sharedCount}・共有 ${sharedCount}` : emptyValue('unknown')) },
    { title: '配信で使っている', icon: Send, value: forbidden || kpiError ? null : kpis.usedInBroadcasts, unit: '件', detail: kpiUnavailableDetail ?? '一斉配信・自動処理' },
    { title: '該当なし', icon: CircleDashed, value: forbidden || kpiError ? null : kpis.zeroMatches, unit: '件', detail: kpiUnavailableDetail ?? '条件が古いかも' },
    { title: '今月の利用', icon: MousePointerClick, value: forbidden || kpiError ? null : kpis.callsThisMonth, unit: '回', detail: kpiUnavailableDetail ?? (kpis.callsThisMonth === null ? '利用の記録は未接続' : '友だち一覧で開いた回数') },
  ]

  const filterActive = Boolean(query || usageFilter !== 'all' || matchFilter !== 'all')

  const table = !accountId ? (
    <ListState kind="empty" title="上部でLINE公式アカウントを選んでください"   />
  ) : forbidden ? (
    <ListState kind="error" title="保存した検索を見る権限がありません" description={permissionDeniedMessage('store')}  />
  ) : loadError ? (
    <ListState kind="error" title="保存した検索を読み込めませんでした" description={loadError}  action={<><Button type="button" onClick={() => void load({ userInitiated: true })} disabled={loading} busy={loading} busyLabel="読み込んでいます…">もう一度読み込む</Button></>} />
  ) : ready && items.length === 0 ? (
    <ListState kind="empty" title="まだ保存した検索はありません" description="友だち一覧で条件を絞り、「この条件を保存」を押すとここに追加されます。"  icon={<Filter className={styles.stateIcon} aria-hidden="true" />} action={<>{canEdit ? <Button href="/friends" variant="primary">友だち一覧で条件を作る</Button> : null}</>} />
  ) : ready && visible.length === 0 ? (
    <ListState kind="empty" title="条件に合うものはありません" description="検索や絞り込みを外すと、すべて出ます"  action={<>{filterActive ? <Button type="button" onClick={() => { setQuery(''); setUsageFilter('all'); setMatchFilter('all') }}>条件を外す</Button> : null}</>} />
  ) : (
    <DelayedSkeleton loading={!loaded} skeleton={<div className={styles.skeleton} aria-busy="true" />}>
      <DataTable className={styles.table}>
        <thead>
          <TableHeadRow>
            <Th className={styles.searchColName}>条件名・内容</Th><Th className={styles.searchColStatus}>状態</Th>
            <Th className={styles.searchColCount}>該当</Th>
            <Th className={styles.searchColShare}>共有</Th>
            <Th className={styles.searchColUsage}>使っている所</Th>
            <Th className={styles.searchColUpdated}>更新</Th>
            <Th className={styles.searchColOpen}><span className="sr-only">友だち一覧へ</span></Th>
            <Th className={styles.colMenu}><span className="sr-only">操作</span></Th>
          </TableHeadRow>
        </thead>
        <RovingTbody reorderKey={visible.map(row => row.id).join(',')} reorderScope={JSON.stringify([accountId, query, usageFilter, matchFilter, currentPage, pageSize])}>
          {visible.map((search) => {
            const summaryText = conditionSummary(splitConditions(search.conditions, tags, conditionLabels))
            const editHref = search.lineAccountId && canEdit ? `/tags/searches/edit?id=${encodeURIComponent(search.id)}` : null
            const usage = usageSummary(search.usedIn)
            return (
              <Tr
                interactive
                key={search.id}
                data-reorder-id={search.id}
                className={`${styles.row} ${styles.searchRow}`}
                tabIndex={0}
                detailKey="search" onOpen={() => openSearchDetail(search.id)}
                 data-row-id={search.id}
              >
                <Td className={styles.searchColName}><FolderDotName>
                  <ContextMenu label={`保存した検索「${search.name}」の操作`} items={searchContextItems(search)}>
                    <div className={styles.nameRow}>
                      {editHref ? (
                        <RowNameLink href={editHref} className={`${styles.name} ${styles.nameLink}`}  onClick={(event) => event.stopPropagation()}>
                          <TruncatedText value={String(search.name ?? '')} />
                        </RowNameLink>
                      ) : (
                        <span className={styles.name} ><TruncatedText value={String(search.name ?? '')} /></span>
                      )}
                    </div>

                  </ContextMenu>
                </FolderDotName></Td>
                <Td className={styles.searchColStatus}>{!search.lineAccountId ? (
                        <StatusBadge tone="warning" size="annotation" dot={false} title="対象アカウント未割り当て">未割り当て</StatusBadge>
                      ) : <StatusBadge tone="neutral" size="annotation" dot={false}>割り当て済み</StatusBadge>}</Td>
                <Td className={styles.searchColCount}>
                  <span className={styles.cellText} title={search.matchCountError ?? undefined}>
                    {search.matchCount !== null && search.matchCount !== undefined ? `${formatNumber(search.matchCount)}人` : emptyValue('unknown')}
                  </span>
                </Td>
                <Td className={styles.searchColShare}><span className={styles.cellText}>{search.isShared ? '全員' : '自分だけ'}</span></Td>
                <Td className={styles.searchColUsage}><span className={styles.cellText} title={usage}>{usage}</span></Td>
                <Td className={styles.searchColUpdated}><span className={styles.cellText} title={updatedText(search)}>{updatedText(search)}</span></Td>
                <Td className={styles.searchColOpen}>
                  {search.lineAccountId ? (
                    <Button href={`/friends?savedSearch=${search.id}`} aria-label={`「${search.name}」で友だち一覧を開く`}>
                      友だち一覧へ<ArrowRight size={16} aria-hidden="true" />
                    </Button>
                  ) : null}
                </Td>
                <Td className={styles.colMenu}>
                  <span className={styles.menuAnchor}>
                    <RowMenu
                      size="row"
                      label={`保存した検索「${search.name}」の操作`}
                      items={rowMenuItems(search)}
                      open={openMenuId === search.id}
                      onOpenChange={(next) => setOpenMenuId(next ? search.id : null)}
                    />
                  </span>
                </Td>
              </Tr>
            )
          })}
        </RovingTbody>
      </DataTable>


    </DelayedSkeleton>
  )

  return (
    <SaveErrorScope errors={saveErrors}><>
      <KpiBand data-design="KPIs" className={styles.kpis}>
        {kpiCards.map((kpi) => (
          <KpiCard
            key={kpi.title}
            presentation="band"
            title={kpi.title}
            icon={<kpi.icon size={16} aria-hidden="true" />}
            value={kpi.value}
            unit={kpi.value == null ? '' : kpi.unit}
            detail={kpi.detail}
            loading={kpiLoading}
          />
        ))}
      </KpiBand>

      <ListPageBody
        skeleton
        explanation={explanation ? '友だち一覧で絞り込みを作り「この条件を保存」で保存します。配信や自動処理の宛先にも使えます。' : undefined}
        listHelp={canEdit ? `保存は最大 ${MAX_SAVED} 件。行の「…」に：編集・複製して保存・削除。` : `保存は最大 ${MAX_SAVED} 件。`}
        toolbar={<>
          <ListToolbarSearchSlot>
            <SearchField aria-label="条件名で探す" placeholder="条件名で探す" value={query} onChange={setQuery} onClear={() => setQuery('')} />
          </ListToolbarSearchSlot>
          <SaveErrorField names={["usageFilter","usage_filter"]}><Select
            value={usageFilter}
            width={170}
            onChange={(value) => setUsageFilter(value as SavedSearchUsageFilter)}
            aria-label="使っている所で絞り込む"
            options={[
              { value: 'all', label: '使っている所：すべて' },
              { value: 'used', label: '使っている所：あり' },
              { value: 'unused', label: '使っている所：なし' },
            ]}
          /></SaveErrorField>
          <SaveErrorField names={["matchFilter","match_filter"]}><Select
            value={matchFilter}
            width={145}
            onChange={(value) => setMatchFilter(value as typeof matchFilter)}
            aria-label="該当人数で絞り込む"
            options={[
              { value: 'all', label: '該当人数：すべて' },
              { value: 'matched', label: '該当人数：1人以上' },
              { value: 'zero', label: '該当人数：0人' },
              { value: 'unknown', label: '該当人数：未集計' },
            ]}
          /></SaveErrorField>
          <ListToolbarEnd><PageSizeSelect value={pageSize} onChange={(value) => setPageSize(value || 20)} options={PAGE_SIZES} label={null} /></ListToolbarEnd>
        </>}
        listHelpPlacement="end"
        pagination={ready && visible.length > 0 ? (
          <ListPager>
            <Pagination page={currentPage} pageCount={pages} onPageChange={setPage} ariaLabel="保存した検索のページ送り"
              range={{ total: filteredList.length, first: (currentPage - 1) * pageSize + 1, last: Math.min(currentPage * pageSize, filteredList.length) }} />
          </ListPager>
        ) : undefined}
      >
        {ready && labelsFailed ? (
          <Notice
            tone="warn"
            action={
              <Button variant="secondary" type="button" onClick={() => void reloadLabels()} disabled={labelsLoading} busy={labelsLoading} busyLabel="読み込んでいます…">
                条件名を読み直す
              </Button>
            }
          >
            条件に使うタグやシナリオなどの名前の一部を読み込めませんでした。一覧の確認や操作は続けられます。
          </Notice>
        ) : null}
        {error ? (
          <Notice tone="danger" >{error}{retryOrder ? (
              <Button variant="text" size="inline" data-notice-inline-action type="button" onClick={() => { const next = retryOrder; setRetryOrder(null); if (next) void applyOrder(next) }}>再試行</Button>
            ) : (
              <Button variant="text" size="inline" data-notice-inline-action type="button" onClick={() => { setError(''); void load() }}>状態を確認する</Button>
            )}</Notice>
        ) : null}
        <RefreshCover refreshing={loading && loaded}>{table}</RefreshCover>
      </ListPageBody>

      {/* 行の詳細パネル。名前はその場で直せる。 */}
      {detailGuard.dialog}
      <DetailPanel
        open={activeSearch !== null}
        busy={detailGuard.busy}
        title={activeSearch?.name ?? ''}
        description={activeSearch ? `${activeSearch.isShared ? '全員' : '自分だけ'}・第${activeSearch.revision ?? 1}版` : undefined}
        onClose={() => setActiveSearchId(null)}
        hasPrev={activeSearchIndex > 0}
        hasNext={activeSearchIndex >= 0 && activeSearchIndex < visible.length - 1}
        onPrev={activeSearchIndex > 0 ? () => setActiveSearchId(visible[activeSearchIndex - 1].id) : undefined}
        onNext={activeSearchIndex >= 0 && activeSearchIndex < visible.length - 1 ? () => setActiveSearchId(visible[activeSearchIndex + 1].id) : undefined}
        actions={{ primary: (activeSearch?.lineAccountId ? <Button variant="primary" href={`/friends?savedSearch=${activeSearch.id}`}>友だち一覧へ</Button> : null),
    secondary: (activeSearch?.lineAccountId ? <Button variant="secondary" href={`/tags/searches/edit?id=${encodeURIComponent(activeSearch.id)}`}>編集する</Button> : null),
    menuItems: [], secondaryAllowed: canEdit }}
      >
<DetailContent>
        {activeSearch ? (
          <DetailFields>
            <div>
              <dt>検索名</dt>
              <dd>
                <DetailInlineEdit {...detailGuard.editor} allowed={canEdit}
                    label="検索名"
                    value={activeSearch.name}
                    maxLength={60}
                    disabled={!activeSearch.lineAccountId}
                    onSave={async (next) => {
                      if (!activeSearch.lineAccountId) throw new Error('no account')
                      const res = await api.savedSearches.update(activeSearch.id, activeSearch.lineAccountId, { name: next })
                      if (!res.success) throw new Error(res.error)
                      void load()
                    }}
                  />
              </dd>
            </div>
            <div><dt>条件</dt><dd>{conditionSummary(splitConditions(activeSearch.conditions, tags, conditionLabels))}</dd></div>
            <div>
              <dt>該当</dt>
              <dd>
                {activeSearch.lineAccountId && activeSearch.matchCount !== null && activeSearch.matchCount !== undefined ? (
                  <Link href={`/friends?savedSearch=${activeSearch.id}`} className={styles.countLink}>{`${formatNumber(activeSearch.matchCount)}人`}</Link>
                ) : emptyValue('unknown')}
              </dd>
            </div>
            <div><dt>使っている所</dt><dd>{usageSummary(activeSearch.usedIn)}</dd></div>
            <div><dt>更新</dt><dd>{updatedText(activeSearch)}</dd></div>
          </DetailFields>
        ) : null}

</DetailContent>
</DetailPanel>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`保存した検索「${pendingDelete?.name ?? ''}」を削除しますか？`}
        description="この操作は元に戻せません。使用中の検索は削除できません。"
        confirmLabel="削除する"
        destructive
        onCancel={() => { if (!deleteLock.current) { deleteTicket.current = null; setPendingDelete(null) } }}
        error={error || undefined} onSuccess={() => { deleteTicket.current = null; setPendingDelete(null) }} onConfirm={() => pendingDelete ? confirmRemove(pendingDelete) : false}
      >{pendingDelete ? <OperationTargetSummary accounts={[{ id: pendingDelete.lineAccountId ?? '' }]} /> : null}</ConfirmDialog>
    </></SaveErrorScope>
  )
}
