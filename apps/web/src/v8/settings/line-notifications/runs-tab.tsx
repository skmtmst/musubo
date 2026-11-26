'use client'

import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import { canManageRole, isOwnerRole, useStaffRole } from '@/lib/staff-role'
import { LogEntryCopy } from '@/components/shared/log-entry-details'
import { useListUrlValue } from '@/components/shared/list-url-state'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { UserX, CircleX, Mail, RotateCcw, RotateCw } from 'lucide-react'
import {
  filterNotificationRuns,
  loadNotificationRuns,
  resolveNotificationRun,
  retryNotificationRun,
  type NotificationRunEnv,
  type NotificationRunScope,
  type PeriodFilter,
  type RecipientFilter,
  type RunFilter,
  type ScopedLoadState,
  type ScopedNotice,
  type ScopedRetrying,
} from '@/components/line-notifications/notification-run-state'
import { DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table'
import StatusBadge from '@/components/shared/status-badge'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import FilterChip from '@/components/shared/filter-chip'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import Pagination from '@/components/shared/pagination'
import SearchField from '@/components/shared/search-field'
import Select from '@/components/shared/select'
import { api, fetchApi, type EcNotificationRun } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import styles from './screen.module.css'
import { formatDate as polishFormatDate } from '@/lib/format'
import TruncatedText from '@/components/shared/truncated-text'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField } from '@/components/shared/save-form-errors'

/*
 * ★V8 LINE通知 送れなかったもの（板 ）・記録（板 ）。
 *
 * 並び：送れなかったものだけ数のマス4つ → 探す・対象・期間（記録は「クリック記録あり」）・右に再読み込み →
 * 表（日時・お知らせ・対象者・状態・理由・対応・試行・クリック。1行 53）→ 下の1行（送れなかったものは帯）。
 * 試行の履歴・受信箱で連絡・再試行・対応済みは、お知らせの名前を押して開く「記録の詳細」に置く（行は1段のまま）。
 * 読み込み・再試行・対応済みの口と世代の守りは今の部品（components/line-notifications/notification-run-list）の関数を使う。
 */

const PAGE_SIZE = 20

type DeliveryAttempt = {
  number: number
  outcome: 'provider_accepted' | 'retry_wait' | 'failed'
  attemptedAt: string
  providerRequestId: string | null
  errorCode: string | null
  error: string | null
}

type RunItem = EcNotificationRun & {
  resolved?: boolean
  resolvedAt?: string | null
  resolvedBy?: string | null
  attemptHistory?: DeliveryAttempt[]
}

const STATUS: Record<EcNotificationRun['status'], { label: string; tone: 'good' | 'info' | 'muted' | 'danger' }> = {
  pending: { label: '送信処理中', tone: 'info' },
  accepted: { label: 'LINEが受け付けました', tone: 'good' },
  excluded: { label: '送信対象外', tone: 'muted' },
  failed: { label: '送れなかった', tone: 'danger' },
}

function statusView(status: string): { label: string; tone: 'good' | 'info' | 'muted' | 'danger' } {
  return Object.prototype.hasOwnProperty.call(STATUS, status)
    ? STATUS[status as keyof typeof STATUS]
    : { label: '状態不明', tone: 'muted' }
}

/** 「10/1 21:30」。オフセットの無い古い行は既に日本時間として読む（今の部品と同じ決まり）。 */
function shortJst(value: string | null | undefined): string {
  const normalized = value && !/[zZ]|[+-]\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}+09:00` : value
  return polishFormatDate(normalized, { style: 'list', fallback: '—' })
}

function reasonWords(item: RunItem): string {
  const reason = item.reason?.trim() || ''
  if (item.nextRetryAt && !reason.includes('再試行')) return `${reason || '一時的なエラー'} → 次の再試行 ${shortJst(item.nextRetryAt)}`
  return reason || emptyValue('unknown')
}

export default function RunsTab({ lineAccountId, mode }: { lineAccountId: string | null; mode: 'history' | 'failures' }) {
  const [page, setPage] = useListUrlValue('page', 1)
  const currentScopeKey = `${lineAccountId ?? 'none'}:${mode}`
  const [scope, setScope] = useState<NotificationRunScope>(() => ({ key: currentScopeKey, generation: 0 }))
  /* 世代はレンダー中に進める（今の部品と同じ。古い応答を新しい画面へ漏らさない）。 */
  if (scope.key !== currentScopeKey) setScope({ key: currentScopeKey, generation: scope.generation + 1 })
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const generation = scope.generation

  const [loaded, setLoaded] = useState<ScopedLoadState>({ generation: -1, state: 'loading', result: null, total: 0 })
  const [query, setQuery] = useListUrlValue('q', '')
  const [filter, setFilter] = useListUrlValue<RunFilter>('filter', 'all')
  const [recipientFilter, setRecipientFilter] = useListUrlValue<RecipientFilter>('recipientFilter', 'all')
  const [periodFilter, setPeriodFilter] = useListUrlValue<PeriodFilter>('periodFilter', 'all')
  const [retrying, setRetrying] = useState<ScopedRetrying>({ generation: -1, id: null })
  const [notice, setNotice] = useState<ScopedNotice>({ generation: -1, notice: null })
  const [detailId, setDetailId] = useState<string | null>(null)
  /* 再試行はオーナー、対応済みは管理者も可能。操作を残して共通の理由で止める。 */
  const staffRole = useStaffRole()
  const canRetry = isOwnerRole(staffRole)
  const canResolve = canManageRole(staffRole)
  const retryLockReason = usePermissionLockReason(canRetry, 'owner')
  const resolveLockReason = usePermissionLockReason(canResolve, 'manager')
  const requestRef = useRef(0)
  const mutationRef = useRef<{ generation: number; id: string } | null>(null)
  const env = useMemo<NotificationRunEnv>(() => ({
    requestRef,
    mutationRef,
    scopeRef,
    ports: {
      deliveries: api.lineNotifications.deliveries,
      notificationRuns: api.ecCommerce.notificationRuns,
      retryDelivery: api.lineNotifications.retryDelivery,
      resolveDelivery: (id, data) => fetchApi(
        `/api/line-notifications/deliveries/${encodeURIComponent(id)}/retry`,
        { method: 'POST', body: JSON.stringify({ lineAccountId: data.lineAccountId, expectedVersion: data.expectedVersion, action: data.resolved ? 'resolve' : 'reopen' }) },
      ),
    },
    setLoaded,
    setNotice,
    setRetrying,
  }), [])



  useEffect(() => {
    setPage(1); setQuery(''); setFilter('all'); setRecipientFilter('all'); setPeriodFilter('all'); setDetailId(null)
  }, [lineAccountId, mode])

  const load = useCallback(() => loadNotificationRuns(env, { generation, lineAccountId, mode, page }), [env, generation, lineAccountId, mode, page])
  useEffect(() => { void load() }, [load])

  const title = mode === 'failures' ? '送れなかったもの' : 'お知らせの記録'
  const visibleState = loaded.generation === generation ? loaded.state : lineAccountId ? 'loading' : 'ready'
  const result = loaded.generation === generation ? loaded.result : null
  const total = loaded.generation === generation ? loaded.total : 0
  const visibleNotice = notice.generation === generation ? notice.notice : null
  const retryingId = retrying.generation === generation ? retrying.id : null
  const items = useMemo(() => (result?.items ?? []) as RunItem[], [result])
  const summary = result?.summary ?? null
  /* 数のマス。口の集計に内訳が無いので、読み込んだ記録から数える。送れなかった件数だけは口の合計。 */
  const breakdown = useMemo(() => {
    const blocked = items.filter((item) => item.reason?.includes('ブロック')).length
    const planned = items.filter((item) => item.nextRetryAt !== null)
    const next = planned.map((item) => new Date(item.nextRetryAt as string).getTime()).filter(Number.isFinite).sort((a, b) => a - b)[0]
    return { blocked, retry: planned.length, nextRetryAt: next === undefined ? null : new Date(next).toISOString() }
  }, [items])
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const pageScoped = total > items.length
  const kpiNote = (ready: string): string => {
    if (!lineAccountId) return 'LINEアカウントを選ぶと出ます'
    if (visibleState === 'error') return '読み込めませんでした'
    if (visibleState === 'forbidden') return '見る権限がありません'
    return ready
  }
  const kpiValue = (count: number | null): number | null => visibleState === 'ready' ? count : null
  const visibleItems = useMemo(() => filterNotificationRuns(items, { query, status: filter, recipient: recipientFilter, period: periodFilter }) as RunItem[], [filter, items, periodFilter, query, recipientFilter])
  const listState = !lineAccountId ? 'account-required'
    : visibleState === 'ready' && items.length === 0 ? 'empty'
      : visibleState === 'ready' && visibleItems.length === 0 ? 'filtered-empty'
        : visibleState
  const detail = items.find((item) => item.id === detailId) ?? null

  return <>
    {mode === 'failures' ? (
      <KpiBand presentation="band" data-design="KPIs">
        {/*
          * WEB201：期間を口へ送っていないので「この7日」と言わない。ブロック・再試行は読み込んだページから
          * 数えているので、全件より少ないときは「このページの n件から」と書く。
          * WEB202：送れなかった一覧にはメールで届いたもの（受付済み）は出ないので、ここでは数えない。
          */}
        <KpiCard presentation="band" icon={<CircleX size={16} aria-hidden="true" />} title="送れなかった" value={kpiValue(summary?.failed ?? null)} unit="件" detail={kpiNote('記録の合計')} loading={visibleState === 'loading'} />
        <KpiCard presentation="band" icon={<UserX size={16} aria-hidden="true" />} title="ブロック" value={kpiValue(breakdown.blocked)} unit="件" detail={kpiNote(pageScoped ? `このページの${formatNumber(items.length)}件から・対応不要` : '対応不要')} loading={visibleState === 'loading'} />
        <KpiCard presentation="band" icon={<Mail size={16} aria-hidden="true" />} title="メールで送った" value={null} unit="件" detail={kpiNote('お知らせの記録で見られます')} loading={visibleState === 'loading'} />
        <KpiCard presentation="band" icon={<RotateCcw size={16} aria-hidden="true" />} title="再試行の予定" value={kpiValue(breakdown.retry)} unit="件" detail={kpiNote(`${pageScoped ? `このページの${formatNumber(items.length)}件から・` : ''}${breakdown.nextRetryAt ? shortJst(breakdown.nextRetryAt) : '予定なし'}`)} loading={visibleState === 'loading'} />
      </KpiBand>
    ) : null}

    {visibleNotice ? <Notice role={visibleNotice.tone === 'success' ? 'status' : 'alert'} tone={visibleNotice.tone === 'success' ? 'success' : 'danger'}>{visibleNotice.text}</Notice> : null}

    <div className={styles.toolbar}>
      <div className={styles.runSearch}>
        <SearchField aria-label="このページ内で名前・注文番号を探す" placeholder="このページ内で名前・注文番号を探す" value={query} onChange={setQuery} onClear={() => setQuery('')} />
      </div>
      <div className={styles.runRecipient}>
        <SaveErrorField names={["recipientFilter","recipient","recipient_filter"]}><Select aria-label="対象を絞り込み" label="対象" value={recipientFilter} onChange={(value) => setRecipientFilter(value as RecipientFilter)} options={[
          { value: 'all', label: 'すべて' }, { value: 'customer', label: '顧客' }, { value: 'operator', label: '運用者' },
        ]} /></SaveErrorField>
      </div>
      <div className={styles.runPeriod}>
        <SaveErrorField names={["periodFilter","period","period_filter"]}><Select aria-label="期間を絞り込み" label="期間" value={periodFilter} onChange={(value) => setPeriodFilter(value as PeriodFilter)} options={[
          { value: 'all', label: 'すべての期間' }, { value: '24h', label: '24時間以内' }, { value: '7d', label: '7日以内' }, { value: '30d', label: '30日以内' },
        ]} /></SaveErrorField>
      </div>
      {mode === 'history' ? <FilterChip selected={filter === 'clicked'} onChange={() => setFilter(filter === 'clicked' ? 'all' : 'clicked')}>クリック記録あり</FilterChip> : null}
      <span className={styles.runSpacer} />
      <Button onClick={() => load()} busyLabel="処理中…"><RotateCw size={16} aria-hidden="true" />記録を再読み込み</Button>
    </div>

    <section className={styles.table} data-design-node={mode === 'failures' ? 'DrwMm-table' : 'PZBVb-table'} data-list-state={listState} aria-label={title}>
      {!lineAccountId ? <ListState kind="empty" title="LINEアカウントを選択してください" description="上のアカウント切り替えから、確認するLINEアカウントを選んでください。" />
        : visibleState === 'loading' ? <ListState kind="loading" title={`${title}を読み込んでいます`} />
        : visibleState === 'error' ? <ListState kind="error" title={`${title}を表示できませんでした`} description="登録済みの記録は消えていません。時間をおいて読み直してください。" onRetry={() => void load()} />
        : visibleState === 'forbidden' ? <ListState kind="forbidden" onRetry={() => void load()} />
        : items.length === 0 ? <ListState kind="empty" title={mode === 'failures' ? '送れなかったお知らせはありません' : 'お知らせの記録はまだありません'} description={mode === 'failures' ? '現在の表示範囲には、確認が必要な失敗はありません。' : 'ECからのお知らせを処理すると、ここに記録が残ります。'} />
        : visibleItems.length === 0 ? <ListState kind="empty" emptyPreset="filtered" title="条件に合う記録はありません" description="検索語か絞り込みを変えてください。" />
        : <DataTable label="お知らせの記録" grid={{ columns: 'var(--tpl-rest3-run-cols)', compactColumns: 'minmax(0, .8fr) minmax(0, 1fr) minmax(0, .8fr) var(--tpl-an-col-130) minmax(0, 1.5fr) var(--tpl-an-col-88)', padding: 'var(--tpl-rest3-run-row-pad)', headPadding: 'var(--tpl-rest3-op-head-pad)' }}>
          <thead>
            <TableHeadRow>
              <Th>日時</Th>
              <Th>お知らせ</Th>
              <Th>対象者</Th>
              <Th>状態</Th>
              <Th>理由・対応</Th>
              <Th>試行・クリック</Th>
            </TableHeadRow>
          </thead>
          <tbody>
            {visibleItems.map((item) => {
              const status = statusView(item.status)
              const who = item.recipientType === 'customer' ? `顧客${item.orderNumber ? `・${item.orderNumber}` : ''}` : '運用者'
              const reason = reasonWords(item)
              return <Tr key={item.id} data-row-id={item.id}>
                <Td className={`${styles.cell} ${styles.runWhen}`} title={shortJst(item.receivedAt)}><span className={styles.runWhen}>{shortJst(item.receivedAt)}</span></Td>
                <Td className={styles.cell}>
                  <button type="button" className={styles.runOpen} onClick={() => setDetailId(item.id)} title={`${item.notificationName}の記録の詳細を開く`} >{item.notificationName}</button>
                </Td>
                <Td className={styles.runWhoCell}>
                  <TruncatedText className={`${styles.cell} ${styles.runWho}`} value={item.friendName || '名前は未取得'} />
                  <TruncatedText className={`${styles.cell} ${styles.opSub}`} value={who} />
                </Td>
                <Td><StatusBadge tone={status.tone === 'good' ? 'success' : status.tone === 'muted' ? 'neutral' : status.tone}>{status.label}</StatusBadge></Td>
                <Td className={styles.cell} title={reason}>{item.resolved ? `対応済み・${reason}` : reason}</Td>
                <Td className={styles.cell}><TruncatedText value={`${item.attemptCount == null ? emptyValue('unknown') : `${item.attemptCount}回`}・${item.clickedAt ? 'クリックあり' : emptyValue('unknown')}`} /></Td>
              </Tr>
            })}
          </tbody>
        </DataTable>}
    </section>

    {visibleState === 'ready' && items.length > 0 ? (
      <>
        <p className={styles.minor}>{`このページ内の絞り込み：${formatNumber(visibleItems.length)}件（対象 ${formatNumber(items.length)}件）`}</p>
        {mode === 'failures'
          ? <Notice tone="info" icon={null}>個人の既読は見られません。試行回数と次の再試行予定は送信台帳の記録を表示します。検索と絞り込みは表示中のページの中だけに効きます。</Notice>
          : <p className={styles.minor}>表示中の20件を絞り込み</p>}
        <Pagination page={page} pageCount={pageCount} onPageChange={setPage}
          range={{ total, first: (page - 1) * PAGE_SIZE + 1, last: Math.min(page * PAGE_SIZE, total) }} />
      </>
    ) : null}

    <ConfirmDialog
      open={detail !== null}
      title="記録の詳細"
      description={detail ? `${shortJst(detail.receivedAt)}・${detail.notificationName}・${detail.friendName || '名前は未取得'}` : ''}
      cancelLabel="閉じる"
      onCancel={() => setDetailId(null)}
    >
      {detail ? (
        <div className={styles.runDetail}>
          <LogEntryCopy canCopy={canResolve} entry={{ occurredAt: detail.receivedAt, target: detail.friendName || '名前は未取得', status: statusView(detail.status).label, reason: reasonWords(detail) }} />
          <p className={styles.minor}>{`状態：${statusView(detail.status).label}／理由：${reasonWords(detail)}`}</p>
          {detail.resolved ? <p className={styles.minor}>{`対応済み ${shortJst(detail.resolvedAt)}${detail.resolvedBy ? `／${detail.resolvedBy}` : ''}`}</p> : null}
          {(detail.attemptHistory?.length ?? 0) > 0 ? (
            <ul className={styles.runAttempts} aria-label="試行の履歴">
              {detail.attemptHistory!.map((attempt) => (
                <li key={`${detail.id}-${attempt.number}`}>{`${attempt.number} 回目 ${shortJst(attempt.attemptedAt)}／${attempt.outcome === 'provider_accepted' ? 'LINEが受け付けました' : attempt.error || '送信失敗'}`}</li>
              ))}
            </ul>
          ) : <p className={styles.minor}>試行の履歴はまだありません。</p>}
          <div className={styles.inlineRow}>
            {mode === 'failures' && detail.friendId ? <Button href={`/chats?friend=${encodeURIComponent(detail.friendId)}`}>受信箱で連絡</Button> : null}
            {mode === 'failures' && detail.retryAvailable ? (
              <Button disabled={retryingId !== null || !canRetry} lockedReason={retryLockReason} busy={retryingId === detail.id} busyLabel="再試行中" onClick={() => { if (canRetry && !retryLockReason) void retryNotificationRun(env, { generation, lineAccountId, item: detail, reload: load }) }}>送信を再試行する</Button>
            ) : null}
            {mode === 'failures' && (detail.status === 'failed' || detail.status === 'excluded') ? (
              <Button disabled={retryingId !== null || !canResolve} lockedReason={resolveLockReason} busy={retryingId === detail.id} busyLabel="保存中" onClick={() => { if (canResolve && !resolveLockReason) void resolveNotificationRun(env, { generation, lineAccountId, item: detail, resolved: !detail.resolved, reload: load }) }}>
                {detail.resolved ? '未対応に戻す' : '対応済みにする'}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </ConfirmDialog>
  </>
}
