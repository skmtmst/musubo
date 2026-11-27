'use client'
import { formatYen } from '@line-crm/shared';
import { ACTION_STATUS, FAILURE_KIND_LABEL } from './execution-status'
import { formatDate as polishFormatDate } from '@/lib/format'
import { notifySaved } from '@/components/shared/toast'
import { ListToolbarSort } from '@/components/shared/list-toolbar'
import { useListUrlValue } from '@/components/shared/list-url-state'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { Plug, CircleCheck, Clock, CircleSlash, TriangleAlert } from 'lucide-react'
import { ecEventLabel, type ApiResponse } from '@line-crm/shared'
import Button from '@/components/shared/button'
import type { ActionMenuItem } from '@/components/shared/action-menu'
import { RowMenu } from '@/components/shared/row-actions'
import SegmentedControl from '@/components/shared/segmented'
import HelpTip from '@/components/shared/help-tip'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import TruncatedText from '@/components/shared/truncated-text'
import ListState from '@/components/shared/list-state'
import Pagination from '@/components/shared/pagination'
import SearchField from '@/components/shared/search-field'
import ListRange from '@/components/ui/list-range'
import { useAccount } from '@/contexts/account-context'
import {
  ApiError,
  api,
  fetchApi,
  type EcActionExecution,
  type EcActionExecutionList,
  type EcActionExecutionStatus,
  type EcCommerceOverview,
  type EcOrder,
} from '@/lib/api'
import { formatDateTime, formatNumber } from '@/lib/format'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { SbSettingsScreen } from '../sb-frame/settings-screen'
import EcConnector from './connector'
import EcSubscriptions from './subscriptions'
import { EcAutoLine } from '@/v8/ec-auto-line/index'
import { Tabs } from '@/components/shared/tabs'
import StatusBadge from '@/components/shared/status-badge'
import { DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table'
import OrderDrawer from './order-drawer'
import styles from './screen.module.css'
import { permissionDeniedMessage } from '@/components/shared/api-error-message'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import Notice from '@/components/shared/notice'

/** 出来事ごとの取り込みを表示し、再実行時も版と対象アカウントを保持する。 */

export type EcTabKey = 'events' | 'identity' | 'subscriptions' | 'auto-line' | 'connector'

const TABS: ReadonlyArray<{ key: EcTabKey; label: string; href: string }> = [
  { key: 'events', label: '取り込みの記録', href: '/ec-commerce' },
  { key: 'identity', label: '会員のつき合わせ', href: '/ec-commerce/identity-candidates' },
  { key: 'subscriptions', label: '定期便', href: '/ec-commerce?tab=subscriptions' },
  { key: 'auto-line', label: '自動の LINE', href: '/ec-commerce?tab=auto-line' },
  { key: 'connector', label: 'つなぎ先', href: '/ec-commerce?tab=connector' },
]

/* 「したこと」列。worker が実際に行う処理を運用の言葉で書く（今の画面と同じ）。 */
const ACTION_LABEL: Record<string, string> = {
  'ec.order.confirmed': '注文ありがとうございますを送信',
  'ec.order.payment_received': '定期便のご案内を送信',
  'ec.order.bank_transfer_reminder': '振込期限の案内を送信',
  'ec.order.shipped': 'お荷物を送りましたを送信・発送後の案内を予約',
  'ec.order.cancelled': '注文の取り消しを反映・発送後の案内を停止',
  'ec.order.refunded': '成果を取り消し・マイルを調整・発送後の案内を停止',
  'ec.subscription.upcoming': '次回定期便の案内を送信',
  'ec.subscription.payment_failed': '決済失敗の案内を送信',
  'ec.subscription.card_updated': 'カード変更の結果を送信',
  'ec.subscription.cancelled': '定期便の解約を反映・解約の案内を送信',
  'ec.customer.profile_updated': '会員情報を更新',
}

/* R166: LINE へ何も送らない処理が成功したときは、送ったように見せない。 */
const NON_SENDING_STATUS_LABEL: Record<string, string> = {
  'ec.customer.profile_updated': '更新完了',
  'ec.order.cancelled': '反映完了',
  'ec.order.refunded': '反映完了',
}

function actionStatusLabel(action: { status: EcActionExecutionStatus; eventType: string }): string {
  if (action.status === 'succeeded') return Object.prototype.hasOwnProperty.call(NON_SENDING_STATUS_LABEL, action.eventType) ? NON_SENDING_STATUS_LABEL[action.eventType] : ACTION_STATUS.succeeded.label
  return ACTION_STATUS[action.status].label
}

function actionDone(action: EcActionExecution): string {
  if (action.status === 'retryable_failed' || action.status === 'permanent_failed') {
    return action.errorMessage ?? `${action.attemptCount} 回やり直しました`
  }
  if (action.status === 'skipped') {
    return action.eventType === 'ec.order.shipped' && action.errorCode === 'notification_disabled'
      ? `${action.errorMessage ?? '通知は送りませんでした'}。発送後の案内は予約しました`
      : action.errorMessage ?? '何もしていません'
  }
  return Object.prototype.hasOwnProperty.call(ACTION_LABEL, action.eventType) ? ACTION_LABEL[action.eventType] : `未対応の出来事（${action.eventType}）`
}

/** 一覧の日時（年なし・例 9/30 10:12、日本時間）。壊れた値は「—」。 */
function dateTime(value: string | null): string {
  return polishFormatDate(value, { style: 'list' })
}

/** 補足の日時（年なし・曜日つき）。 */
function longDateTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? emptyValue('unknown') : formatDateTime(date)
}

const ACTION_PAGE_SIZE = 20

type ActionTab = 'all' | 'succeeded' | 'processing' | 'skipped' | 'failed'
type LoadState = 'loading' | 'ready' | 'empty' | 'error' | 'forbidden'
type OverviewWithLatency = EcCommerceOverview & { averageDeliverySeconds: number | null; latencySampleCount: number }
type ImportAction = EcActionExecution & { eventLabel: string; order: EcOrder | null }
type ImportList = Omit<EcActionExecutionList, 'items'> & { items: ImportAction[] }
type ImportRecords = { items: ImportAction[]; summary: EcActionExecutionList['summary'] | null; total: number }
/* 取得した値は「どのLINEアカウントで取ったか」と一体で持つ（#685）。 */
type AccountBound<T> = { accountId: string | null; state: LoadState; data: T }

const EMPTY_RECORDS: ImportRecords = { items: [], summary: null, total: 0 }

function pendingFor<T>(accountId: string | null, data: T): AccountBound<T> {
  return { accountId, state: accountId ? 'loading' : 'empty', data }
}

function boundTo<T>(slot: AccountBound<T>, accountId: string | null, empty: T): AccountBound<T> {
  return slot.accountId === accountId ? slot : pendingFor(accountId, empty)
}

function actionServerFilter(status: ActionTab): { status?: 'succeeded' | 'skipped'; statusGroup?: 'processing' | 'failed' } {
  if (status === 'succeeded' || status === 'skipped') return { status }
  if (status === 'processing' || status === 'failed') return { statusGroup: status }
  return {}
}

function EventsPanel({ accountId, canEdit }: { accountId: string | null; canEdit: boolean }) {
  const [overviewSlot, setOverviewSlot] = useState<AccountBound<OverviewWithLatency | null>>(() => pendingFor(accountId, null))
  const [recordsSlot, setRecordsSlot] = useState<AccountBound<ImportRecords>>(() => pendingFor(accountId, EMPTY_RECORDS))
  const [urlPage, setUrlPage] = useListUrlValue('page', 1)
  const [pageSlot, setPageSlot] = useState<{ accountId: string | null; page: number }>({ accountId, page: 1 })
  const [query, setQuery] = useListUrlValue('q', '')
  const [searchQuery, setSearchQuery] = useListUrlValue('q', '')
  const [status, setStatus] = useListUrlValue<ActionTab>('status', 'all')
  const [sort, setSort] = useListUrlValue<'newest' | 'oldest'>('sort', 'newest')
  const [retryingSlot, setRetryingSlot] = useState<{ accountId: string | null; id: string | null }>({ accountId, id: null })
  const [noticeSlot, setNoticeSlot] = useState<{ accountId: string | null; notice: { tone: 'success' | 'error'; text: string } | null }>({ accountId, notice: null })
  const [detailSlot, setDetailSlot] = useState<{ accountId: string | null; orderId: string | null }>({ accountId, orderId: null })
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const router = useRouter()
  const retryingId = retryingSlot.accountId === accountId ? retryingSlot.id : null
  const detailOrderId = detailSlot.accountId === accountId ? detailSlot.orderId : null
  const overviewLoadSeq = useRef(0)
  const listLoadSeq = useRef(0)
  const currentAccountIdRef = useRef(accountId)
  currentAccountIdRef.current = accountId
  const isFirstQueryEffect = useRef(true)

  const overviewView = boundTo(overviewSlot, accountId, null)
  const recordsView = boundTo(recordsSlot, accountId, EMPTY_RECORDS)
  const overview = overviewView.data
  const overviewState = overviewView.state
  const actions = recordsView.data.items
  const actionSummary = recordsView.data.summary
  const actionTotal = recordsView.data.total
  const listState = recordsView.state
  const page = pageSlot.accountId === accountId ? urlPage : 1
  const notice = noticeSlot.accountId === accountId ? noticeSlot.notice : null
  const setPage = useCallback((next: number) => { setPageSlot({ accountId, page: next }); setUrlPage(next) }, [accountId, setUrlPage])
  const setNotice = useCallback((next: { tone: 'success' | 'error'; text: string } | null) => {
    if (accountId !== currentAccountIdRef.current) return
    setNoticeSlot({ accountId, notice: next })
  }, [accountId])

  const loadOverview = useCallback(async (showLoading = true) => {
    if (accountId !== currentAccountIdRef.current) return
    const seq = overviewLoadSeq.current + 1
    overviewLoadSeq.current = seq
    if (!accountId) {
      setOverviewSlot({ accountId: null, state: 'empty', data: null })
      return
    }
    if (showLoading) setOverviewSlot((prev) => ({ accountId, state: 'loading', data: prev.accountId === accountId ? prev.data : null }))
    try {
      const response = await api.ecCommerce.overview(accountId) as ApiResponse<OverviewWithLatency>
      if (seq !== overviewLoadSeq.current) return
      if (!response.success) throw new Error('invalid_ec_overview')
      const data = response.data
      if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('invalid_ec_overview')
      setOverviewSlot({ accountId, state: 'ready', data })
    } catch (error) {
      if (seq !== overviewLoadSeq.current) return
      setOverviewSlot((prev) => ({
        accountId,
        state: error instanceof ApiError && error.status === 403 ? 'forbidden' : 'error',
        data: prev.accountId === accountId ? prev.data : null,
      }))
    }
  }, [accountId])

  const loadRecords = useCallback(async (showLoading = true) => {
    if (accountId !== currentAccountIdRef.current) return
    const seq = listLoadSeq.current + 1
    listLoadSeq.current = seq
    if (!accountId) {
      setRecordsSlot({ accountId: null, state: 'empty', data: EMPTY_RECORDS })
      return
    }
    if (showLoading) setRecordsSlot((prev) => ({ accountId, state: 'loading', data: prev.accountId === accountId ? prev.data : EMPTY_RECORDS }))
    const params = new URLSearchParams({
      lineAccountId: accountId,
      view: 'actions',
      limit: String(ACTION_PAGE_SIZE),
      offset: String((page - 1) * ACTION_PAGE_SIZE),
      sort,
    })
    const filter = actionServerFilter(status)
    if (filter.status) params.set('status', filter.status)
    if (filter.statusGroup) params.set('statusGroup', filter.statusGroup)
    if (searchQuery) params.set('query', searchQuery)
    try {
      const response = await fetchApi<ApiResponse<ImportList>>(`/api/ec-commerce/events?${params}`)
      if (seq !== listLoadSeq.current) return
      if (!response.success || !Array.isArray(response.data?.items)) throw new Error('invalid_ec_records')
      setRecordsSlot({
        accountId,
        state: response.data.items.length ? 'ready' : 'empty',
        data: { items: response.data.items, summary: response.data.summary, total: response.data.total },
      })
    } catch (error) {
      if (seq !== listLoadSeq.current) return
      setRecordsSlot((prev) => ({
        accountId,
        state: error instanceof ApiError && error.status === 403 ? 'forbidden' : 'error',
        data: prev.accountId === accountId ? prev.data : EMPTY_RECORDS,
      }))
    }
  }, [accountId, page, searchQuery, sort, status])

  useEffect(() => { void loadOverview() }, [loadOverview])
  useEffect(() => { void loadRecords() }, [loadRecords])
  useEffect(() => {
    if (isFirstQueryEffect.current) {
      isFirstQueryEffect.current = false
      return
    }
    const timer = window.setTimeout(() => {
      setPage(1)
      setSearchQuery(query.trim())
    }, 0)
    return () => window.clearTimeout(timer)
  }, [query, setPage])

  const pageCount = Math.max(1, Math.ceil(actionTotal / ACTION_PAGE_SIZE))
  /* R599: 一覧が取れていない間は、一覧由来の状態別件数を出さない（未取得を 0 に見せない）。 */
  const listedSummary = listState === 'ready' || listState === 'empty' ? actionSummary : null
  const processingCount = listedSummary ? listedSummary.pending + listedSummary.processing : undefined
  const failedCount = listedSummary ? listedSummary.retryable_failed + listedSummary.permanent_failed : undefined
  const recordsNarrowing = searchQuery !== '' || status !== 'all'
  const clearRecordFilters = () => {
    setQuery('')
    setSearchQuery('')
    setStatus('all')
    setPage(1)
  }

  const retry = async (action: EcActionExecution) => {
    if (!canEdit || !accountId || !action.retryAvailable) return
    const retryAccountId = accountId
    setRetryingSlot({ accountId: retryAccountId, id: action.id })
    setNotice(null)
    try {
      const response = await api.ecCommerce.retryActionExecution(
        action.id,
        { lineAccountId: retryAccountId, expectedVersion: action.version },
        crypto.randomUUID(),
      )
      if (!response.success) throw new Error('retry_failed')
      notifySaved('失敗した処理だけを、もう一度行う待ち行列へ戻しました。')
      await loadRecords(false)
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) await loadRecords(false)
      setNotice({
        tone: 'error',
        text: error instanceof ApiError && error.status === 409
          ? '別の担当者が先に更新しました。最新の状態を読み直しました。'
          : '処理をもう一度行う準備ができませんでした。時間をおいてやり直してください。',
      })
    } finally {
      setRetryingSlot((prev) => (prev.accountId === retryAccountId && prev.id === action.id ? { accountId: retryAccountId, id: null } : prev))
    }
  }

  const chips: ReadonlyArray<{ value: ActionTab; label: string; count: number | undefined }> = [
    { value: 'all', label: 'すべて', count: overview?.total },
    { value: 'succeeded', label: '処理完了', count: listedSummary?.succeeded },
    { value: 'processing', label: '処理中', count: processingCount },
    { value: 'failed', label: '失敗', count: failedCount },
    { value: 'skipped', label: '送信なし', count: listedSummary?.skipped },
  ]

  const rowMenu = (action: ImportAction): ActionMenuItem[] => {
    const order = action.order
    const friendId = action.friendId ?? order?.friendId ?? null
    return [
      friendId
        ? { id: 'friend', label: "友だちの詳細を見る", onSelect: () => router.push(`/friends/detail?id=${encodeURIComponent(friendId)}`) }
        : { id: 'identity', label: 'つき合わせる', onSelect: () => router.push('/ec-commerce/identity-candidates') },
      ...(order ? [{ id: 'order', label: '注文の状況を見る', onSelect: () => setDetailSlot({ accountId, orderId: order.id }) }] : []),
      ...(canEdit && action.retryAvailable
        ? [{
            id: 'retry',
            label: 'もう一度やる',
            disabled: retryingId === action.id,
            onSelect: () => void retry(action),
          }]
        : []),
    ]
  }

  const kpiDetailMissing = overviewState === 'error' || overviewState === 'forbidden'

  return (
    <>
      <KpiBand presentation="band">
        <KpiCard presentation="band" icon={<CircleCheck size={16} aria-hidden="true" />} title="処理完了" value={listedSummary?.succeeded ?? null} unit="件" detail={null} loading={listState === 'loading'} />
        <KpiCard presentation="band" icon={<Clock size={16} aria-hidden="true" />} title="処理中" value={processingCount ?? null} unit="件" detail={null} loading={listState === 'loading'} />
        <KpiCard presentation="band" icon={<CircleSlash size={16} aria-hidden="true" />} title="送信なし" value={listedSummary?.skipped ?? null} unit="件" detail="送る設定がない" loading={listState === 'loading'} />
        <KpiCard presentation="band" icon={<TriangleAlert size={16} aria-hidden="true" />} title="失敗" value={failedCount ?? null} unit="件" detail={null} valueTone={failedCount ? 'warning' : 'default'} loading={listState === 'loading'} />
      </KpiBand>
      {kpiDetailMissing ? (
        <p className={styles.minor} role="status">
          {overviewState === 'forbidden'
            ? permissionDeniedMessage('store')
            : '集計だけを読み込めませんでした。一覧は取得できた範囲で表示しています。'}
          {overviewState === 'error' ? <Button variant="text" onClick={() => loadOverview(false)} busyLabel="処理中…">集計をもう一度読む</Button> : null}
        </p>
      ) : null}
      {notice ? <Notice tone={notice.tone === "success" ? "success" : "danger"} role={notice.tone === 'success' ? 'status' : 'alert'}>
        {notice.text}
      </Notice> : null}

      <div className={styles.toolbar}>
        <SearchField
          aria-label="取り込みの記録を探す"
          placeholder="取り込みの記録を探す"
          value={query}
          onChange={setQuery}
          className={styles.search}
        />
        <SegmentedControl<ActionTab>
          aria-label="取り込みの状態で絞り込む"
          value={status}
          onChange={(next) => { setPage(1); setStatus(next) }}
          options={chips.map((chip) => ({ value: chip.value, label: chip.label, count: chip.count }))}
        />
        <span className={styles.spacer} />
        <span className={styles.sortBox}>
          <SaveErrorField names={["sort"]}><ListToolbarSort
            aria-label="取り込みの並び順"
            value={sort}
            onChange={(value) => setSort(value as typeof sort)}
            options={[
              { value: 'newest', label: '新しい順' },
              { value: 'oldest', label: '古い順' },
            ]}
          /></SaveErrorField>
        </span>
      </div>

      {listState !== 'ready' ? (
        <ListState
          kind={listState}
          emptyPreset={accountId ? 'readonly' : 'createable'}
          title={listState === 'error'
            ? '取り込みの記録を読み込めませんでした'
            : listState === 'empty' && !accountId
              ? 'LINEアカウントを選択してください'
              : listState === 'empty' && recordsNarrowing
                ? '条件に合うものはありません'
                : undefined}
          description={listState === 'empty' && !accountId
            ? 'LINEアカウントを選ぶ欄で、確認するアカウントを選びます。'
            : listState === 'empty' && recordsNarrowing
              ? '絞り込みや検索を外すと、すべて出ます'
              : undefined}
          action={listState === 'empty' && accountId && recordsNarrowing
            ? <Button type="button" variant="secondary" onClick={clearRecordFilters}>条件を外す</Button>
            : undefined}
          onRetry={listState === 'error' ? () => void loadRecords(false) : undefined}
        />
      ) : (
        <DataTable density="records" columns="var(--tpl-ecc-record-columns)" label="取り込みの記録">
          <thead><TableHeadRow>
              <Th>いつ・何が届いたか</Th>
              <Th>お客さま</Th>
              <Th>中身</Th>
              <Th>したこと</Th>
              <Th>状態</Th>
              <Th><span className={styles.srOnly}>操作</span></Th>
            </TableHeadRow></thead>
          <tbody>
            {actions.map((action) => {
              const order = action.order
              const contents = order?.orderLines.length
                ? order.orderLines.map((line) => `${line.productName} × ${line.quantity}`).join('・')
                : '商品明細は未取得'
              const amount = order?.status === 'refunded' && order.refundedAmount !== null
                ? `−${formatYen(order.refundedAmount)}`
                : order?.totalAmount === null || order?.totalAmount === undefined
                  ? null
                  : `${formatYen(order.totalAmount)}`
              const statusInfo = ACTION_STATUS[action.status]
              const linked = Boolean(action.friendId ?? order?.friendId)
              const label = action.eventLabel || ecEventLabel(action.eventType, action.eventType)
              return (
                <Tr key={action.id} data-row-id={action.id}>
                  <Td><span className={styles.stack}>
                    <span className={styles.main}>{dateTime(action.receivedAt)}</span>
                    <span className={styles.sub} title={action.orderNumber ? `注文 ${action.orderNumber}` : undefined}>{label}</span>
                  </span></Td>
                  <Td><span className={styles.stack}>
                    <span className={styles.main}>{action.customerName ?? '見つかりません'}</span>
                    <span className={styles.sub}>{linked ? 'LINE 連携済み' : 'LINE 未連携'}</span>
                  </span></Td>
                  <Td><span className={styles.text} title={amount ? `${contents}・${amount}` : contents}>
                    {amount ? `${contents}・${amount}` : contents}
                  </span></Td>
                  <Td><TruncatedText value={actionDone(action)} /></Td>
                  <Td><span className={styles.stack}>
                    <StatusBadge tone={statusInfo.tone} size="compact">{actionStatusLabel(action)}</StatusBadge>
                    {action.failureKind && action.status !== 'succeeded'
                      ? <span className={styles.sub}>{FAILURE_KIND_LABEL[action.failureKind]}</span>
                      : null}
                  </span></Td>
                  <Td><span className={styles.menuBox}>
                    <RowMenu
                      label="この行のその他操作"
                      menuLabel="この行の操作"
                      items={rowMenu(action)}
                      open={openMenuId === action.id}
                      onOpenChange={(next) => setOpenMenuId(next ? action.id : null)}
                    />
                  </span></Td>
                </Tr>
              )
            })}
          </tbody>
        </DataTable>
      )}

      <p className={styles.foot}>
        <span>「会員のつき合わせ」で、ネットショップの会員と LINE の友だちを結びつけると、送信なしが減ります。</span>
        <HelpTip label="つき合わせの仕方">
          ECの注文には、LINEの友だちが誰なのかが書かれていません。メールアドレスか電話番号で結びつけています。どちらも一致しなかった注文は「会員のつき合わせ」に並びます。
        </HelpTip>
      </p>
      {listState === 'ready' ? (
        <div className={styles.pager}>
          <span className={styles.minorText}>
            <ListRange label="取り込みの記録" total={actionTotal} first={(page - 1) * ACTION_PAGE_SIZE + 1} last={(page - 1) * ACTION_PAGE_SIZE + actions.length} />
            {` 最後に届いた ${longDateTime(overview?.lastReceivedAt ?? null)}・今日 ${overview ? formatNumber(overview.last24h) : emptyValue('unknown')}件。注文の本文や接続用の秘密値は表示しません。`}
          </span>
          <Pagination page={page} pageCount={pageCount} onPageChange={setPage} />
        </div>
      ) : null}
      {/* ★V8-B nAesv：注文の状況の引き出し（同じ場所の order-drawer.tsx）。 */}
      <OrderDrawer
        orderId={detailOrderId}
        accountId={accountId}
        onClose={() => setDetailSlot({ accountId, orderId: null })}
        onRetryAction={retry}
        retryingId={retryingId}
        canEdit={canEdit}
      />
    </>
  )
}

/** 4つの入口と、各 API が数えた実件数（取得できない数は作らない）。 */
/** EC連携の中の切り替え（取り込みの記録・会員のつき合わせ・定期便・つなぎ先）。会員のつき合わせの画面も使う。 */
export function EcTabsV8({ accountId, active, actions }: { accountId: string | null; active: EcTabKey; actions?: ReactNode }) {
  const [counts, setCounts] = useState<Partial<Record<EcTabKey, number>>>({})
  useEffect(() => {
    let alive = true
    setCounts({})
    if (!accountId) return () => { alive = false }
    Promise.allSettled([
      api.ecCommerce.overview(accountId),
      api.ecCommerce.operationIdentityCandidates({ lineAccountId: accountId, limit: 1 }),
    ]).then(([overview, identities]) => {
      if (!alive) return
      const ov = overview.status === 'fulfilled' && overview.value.success ? overview.value.data : null
      setCounts({
        events: ov?.total,
        identity: identities.status === 'fulfilled' && identities.value.success ? identities.value.data.summary.unmatched : undefined,
        subscriptions: ov?.subscriptions,
      })
    })
    return () => { alive = false }
  }, [accountId])
  return (
    <Tabs size="settings" actions={actions} label="EC連携の中の切り替え" items={TABS.map((tab) => {
      const count = tab.key === 'connector' || tab.key === 'subscriptions' || tab.key === 'auto-line' ? undefined : counts[tab.key]
      return { label: count === undefined ? tab.label : `${tab.label} ${formatNumber(count)}`, href: tab.href, current: active === tab.key }
    })} />
  )
}

export default function EcCommerceScreen({
  tab,
  renderConnector,
}: {
  tab: EcTabKey
  renderConnector?: (accountId: string | null, canEdit: boolean) => ReactNode
}) {
  const { selectedAccountId } = useAccount()
  const staffRole = useStaffRole()
  const canEdit = canManageRole(staffRole)
  const actions = <Button href="/ec-commerce?tab=connector" variant="secondary"><Plug className={styles.btnIcon} aria-hidden="true" />つなぎ先の設定</Button>
  return (
    <SbSettingsScreen
      boardId={tab === 'subscriptions' ? 'wqC8x' : tab === 'connector' ? 'iLJmw' : tab === 'auto-line' ? 'TSRlY' : 'GmVR5'}
      layout="narrow-nav"
      contentLayout="wide"
      title="EC連携"
      help="ネットショップから注文・発送・定期便の出来事を取り込み、LINE の友だちと結びつけます。"
      actions={actions}
    >
      <EcTabsV8 accountId={selectedAccountId} active={tab} />
      {tab === 'events' ? <EventsPanel accountId={selectedAccountId} canEdit={canEdit} /> : null}
      {tab === 'subscriptions' ? <EcSubscriptions accountId={selectedAccountId} canEdit={canEdit} /> : null}
      {tab === 'auto-line' ? <EcAutoLine accountId={selectedAccountId} canEdit={canEdit} /> : null}
      {tab === 'connector' ? (renderConnector ? renderConnector(selectedAccountId, canEdit) : <EcConnector accountId={selectedAccountId} canEdit={canEdit} />) : null}
    </SbSettingsScreen>
  )
}
