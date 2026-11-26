'use client'

import { lineAccountConnectionState } from '@/lib/line-account-state'

import Card from '@/components/shared/card'
import { ProgressBar } from '@/components/shared/progress'
import StatusBadge from '@/components/shared/status-badge'
import Link from '@/components/shared/list-navigation'
import { useEffect, useState, type ReactNode } from 'react'
import { Bell, Send, TriangleAlert, UserPlus } from 'lucide-react'
import type { NotificationCenterItem } from '@line-crm/shared'
import { api, fetchApi, type BookingRequest, type DashboardOverview, type DashboardUpcoming, type DeliveryFailureOrigins } from '@/lib/api'
import SectionHeader from './head'
import { DashboardAsideSection } from '@/components/templates/dashboard-page'
import ActivityItem from '@/components/shared/activity-item'
import { DelayedSkeleton, Skeleton } from '@/components/shared/skeleton'
import { STATE_TEXT } from '@/components/shared/not-connected'
import { activeUpcomingBookings } from '@/components/dashboard/side-cards'
import { dashboardFreshnessText, dashboardLocalUpdatedAt } from '@/components/dashboard/freshness'
import { dashboardNotificationDestination } from '@/components/dashboard/notification-summary'
import { formatWaitRough } from '@/lib/format-duration'
import { formatDateTime, formatNumber, formatTime, formatRelative } from '@/lib/format'
import type { HealthRisk } from './use-dashboard'
import type { AccountWithStats } from '@/contexts/account-context'
import { connectionReasonLine } from '@/lib/line-account-connection-reasons'
import { RetryLabel } from '@/components/shared/retry-label'
import styles from './dashboard.module.css'
import TruncatedText from '@/components/shared/truncated-text'
import { emptyValue } from '@/components/shared/empty-value'
import type { DashboardComparison } from '@line-crm/shared'
import KpiDelta from './kpi-delta'

type Section = NonNullable<DashboardOverview['sections']>[keyof NonNullable<DashboardOverview['sections']>]

/** 段の下の「更新 9:30」。取れないときは何も出さない。 */
export function Updated({ children }: { children: ReactNode }) {
  if (!children) return null
  return <p className={styles.updated} title={typeof children === 'string' ? children : undefined}>{children}</p>
}

export function sectionUpdated(section: Section | undefined): string | null {
  if (!section?.freshness) return null
  return dashboardFreshnessText(section.freshness, section.asOf, section.reason)
}

/** 札（共通の状態の札）。既定は要確認の黄。tone で緑・赤も出す。 */
export function Tag({ children, tone = 'warning' }: { children: ReactNode; tone?: 'warning' | 'success' | 'danger' }) {
  return <StatusBadge tone={tone === 'warning' ? 'caution' : tone} size="compact">{children}</StatusBadge>
}

/** 鍵と値の1行。`href` があれば行ごと押せる（その状態で絞った一覧へ）。 */
export function KeyValue({ label, value, tone = 'default', dot, href, title }: {
  label: ReactNode
  value: ReactNode
  tone?: 'default' | 'danger' | 'success' | 'faint'
  dot?: 'success' | 'danger' | 'warning' | 'faint'
  href?: string
  title?: string
}) {
  const body = (
    <>
      {dot
        ? <span className={styles.kvKey}><StatusBadge tone={dot === 'faint' ? 'neutral' : dot === 'warning' ? 'caution' : dot}>{label}</StatusBadge></span>
        : <span className={styles.kvKey} title={typeof label === 'string' ? label : undefined}>{label}</span>}
      <span className={styles.kvValue}>{value}</span>
    </>
  )
  return href
    ? <Link href={href} className={tone === 'danger' ? `${styles.kv} ${styles.kvDanger}` : tone === 'faint' ? `${styles.kv} ${styles.kvFaint}` : styles.kv} title={title}>{body}</Link>
    : <div className={tone === 'danger' ? `${styles.kv} ${styles.kvDanger}` : tone === 'faint' ? `${styles.kv} ${styles.kvFaint}` : styles.kv}>{body}</div>
}

export function Unavailable({ section, onRetry }: { section?: Section; onRetry: () => void }) {
  const partial = section?.status === 'partial'
  return (
    <p className={styles.note}>
      {partial ? `一部のデータを${STATE_TEXT.error}` : `データを${STATE_TEXT.error}`}
      <button type="button" className={styles.inlineButton} onClick={onRetry}><RetryLabel /></button>
    </p>
  )
}

export function Loading({ label }: { label: string }) {
  return (
    <div aria-label={`${label}を${STATE_TEXT.loading}`}>
      <DelayedSkeleton loading skeleton={<div className={styles.skeletonStack}><Skeleton className="block h-5 w-full" /><Skeleton className="block h-5 w-2/3" /></div>} />
    </div>
  )
}

/* ── 右の列：今月の送信枠 ─────────────────────────── */
export function SendQuota({ delivery, metric, section, onRetry, overviewFailed }: {
  delivery: DashboardOverview['delivery'] | null
  /** 概要そのものが取れなかった（骨組みのまま待たせない）。 */
  overviewFailed?: boolean
  metric: NonNullable<DashboardOverview['metrics']>['monthlyQuota'] | undefined
  section?: Section
  onRetry: () => void
}) {
  const used = metric === undefined ? delivery?.quotaUsed ?? null : metric.value?.used ?? null
  const limit = metric === undefined ? delivery?.quotaLimit ?? null : metric.value?.limit ?? null
  const unlimited = metric?.value?.unlimited === true
  const notConnected = metric !== undefined && metric.state === 'unavailable' && metric.reason === 'not_connected'
  const failed = metric !== undefined && metric.state === 'unavailable' && metric.reason !== 'not_connected'
  const loading = metric === undefined && delivery === null
  const remaining = used !== null && limit !== null ? Math.max(0, limit - used) : null
  const rate = remaining !== null && limit ? Math.max(0, Math.min(100, remaining / limit * 100)) : null
  const low = rate !== null && rate <= 10
  const updated = sectionUpdated(section)
  const quotaText = [unlimited ? '契約種別：無制限' : rate === null ? null : `残り ${rate.toFixed(1)}%`, updated].filter(Boolean).join('・')
  const head = (
    <SectionHeader
      title="今月の送信枠"
      help="送信枠は毎月1日にリセットされます。使い切ると翌月1日まで送れません。"
      helpLabel="今月の送信枠の説明"
      href="/accounts"
      linkLabel="配信設定へ"
    />
  )
  if (overviewFailed) return <DashboardAsideSection>{head}<Unavailable onRetry={onRetry} /></DashboardAsideSection>
  return (
    <DashboardAsideSection>
      {head}
      {loading ? <Loading label="送信枠" /> : (
        <p className={styles.quota}>
          {unlimited ? (
            <>
              <span className={styles.quotaPre}>LINE公式 使用</span>
              <span className={styles.quotaNum}>{used === null ? emptyValue('unknown') : formatNumber(used)}</span>
              <span className={styles.quotaPre}>通（上限なし）</span>
            </>
          ) : (
            <>
              <span className={styles.quotaPre}>LINE公式 残り</span>
              <span className={styles.quotaNum}>{remaining === null ? emptyValue('unknown') : formatNumber(remaining)}</span>
              <span className={styles.quotaPre}>{limit === null ? '' : `/ ${formatNumber(limit)}通`}</span>
            </>
          )}
        </p>
      )}
      {unlimited ? null : (
        <ProgressBar appearance="quota" tone={low ? 'danger' : undefined} value={rate ?? 0} label="送信枠の使用率" />
      )}
      {notConnected ? (
        <Updated>LINEアカウントが未接続です</Updated>
      ) : failed ? (
        <>
          <p className={styles.alert}>LINE から送信枠を取れませんでした。LINE アカウントの接続（チャネルのトークン）を確かめてください。</p>
          <button type="button" onClick={onRetry} className={styles.retryDanger}><RetryLabel /></button>
        </>
      ) : (
        <p className={low ? styles.updatedDanger : styles.updated} title={quotaText}>
          {quotaText}
        </p>
      )}
    </DashboardAsideSection>
  )
}

/* ── 右の列：運用アラート ─────────────────────────── */
export function OperationalAlerts({ risk, healthIssues, oldestWaitMinutes, twoFactor, referenceCount, failed, updatedAt }: {
  risk: HealthRisk
  healthIssues: number | null
  oldestWaitMinutes: number | null
  twoFactor: { enabled: number; total: number } | null
  referenceCount?: number
  failed?: boolean
  updatedAt?: Date | null
}) {
  const currentHealthIssue = risk === 'warning' || risk === 'danger'
  const count = referenceCount ?? (risk === null ? null : currentHealthIssue ? Math.max(1, healthIssues ?? 1) : 0)
  const twoFactorText = `・組織全体の二段階認証：${twoFactor === null ? emptyValue('unknown') : `${twoFactor.enabled} / ${formatNumber(twoFactor.total)}人`}`
  return (
    <DashboardAsideSection>
      <SectionHeader title="運用アラート" href="/emergency" linkLabel="運用状態へ" />
      <p className={styles.alertHead}>
        <span className={failed || count === null ? styles.faintStrong : styles.strong}>
          {failed ? '未取得' : count === null ? emptyValue('unknown') : `接続・自動処理 ${formatNumber(count)}件`}
        </span>
        {!failed && count !== null ? <Tag tone={count > 0 ? 'warning' : 'success'}>{count > 0 ? '要確認' : '正常'}</Tag> : null}
      </p>
      <p className={styles.item}>{`・最も古い未対応：${oldestWaitMinutes === null ? emptyValue('unknown') : formatWaitRough(oldestWaitMinutes)}`}</p>
      <p className={styles.item} title={twoFactorText}>{twoFactorText}</p>
      <Updated>{dashboardLocalUpdatedAt(updatedAt)}</Updated>
    </DashboardAsideSection>
  )
}

/* ── 右の列：現在の対応状況 ───────────────────────── */
export function SupportStatus({ inbox, autoOnInbound }: { inbox: DashboardOverview['inbox'] | null; autoOnInbound: boolean | null }) {
  const rows = [
    { label: '未対応', value: inbox?.unanswered ?? null, href: '/chats?status=unread', dot: 'danger' },
    { label: '対応中', value: inbox?.inProgress ?? null, href: '/chats?status=in_progress', dot: 'warning' },
    { label: '保留', value: inbox?.onHold ?? null, href: '/chats?status=on_hold', dot: 'faint' },
    { label: '対応済み', value: inbox?.resolved ?? null, href: '/chats?status=resolved', dot: 'success' },
  ] as const
  const autoText = `メッセージ受信時の自動変更：${autoOnInbound === null ? emptyValue('unknown') : autoOnInbound ? '有効' : '無効'}`
  return (
    <DashboardAsideSection>
      <SectionHeader
        title="現在の対応状況"
        help="現在の件数。選択中のアカウントのLINE（友だち単位）と、すべてのMAIL（メール単位）の合計。受信箱の絞り込みと同じ数。"
        helpLabel="現在の対応状況の説明"
        href="/chats"
        linkLabel="受信箱へ"
      />
      {rows.map((row) => (
        <KeyValue
          key={row.label}
          label={<StatusBadge tone={row.dot === 'faint' ? 'neutral' : row.dot}>{row.label}</StatusBadge>}
          value={row.value === null ? emptyValue('unknown') : `${formatNumber(row.value)} 件`}
          tone={row.label === '未対応' && (row.value ?? 0) > 0 ? 'danger' : 'default'}
          href={row.href}
          title={`${row.label}で絞った受信箱を開く`}
        />
      ))}
      <p className={styles.caption} title={autoText}>{autoText}</p>
    </DashboardAsideSection>
  )
}

/* ── 右の列：接続状態 ─────────────────────────────── */
export type WebhookState = { label: string; reason: { text: string; title: string } | null }

/**
 * LINE Webhook の値。統括のアカウントの接続（connection）と同じ判定・理由の言葉を使う。
 * 「確認中」は確かめるを押して走らせている間だけ（ここでは出さない）。
 */
export function webhookState(account: Pick<AccountWithStats, 'connection' | 'webhook' | 'basicId' | 'channelId' | 'isActive' | 'archivedAt'> | null | undefined): WebhookState {
  const state = lineAccountConnectionState(account ?? {})
  return { label: state.label, reason: state.tone === 'warn' && account ? connectionReasonLine(account as AccountWithStats) : null }
}

/**
 * 友だちの上限のメーター。上限は LINE の決まりではなく、アカウントに店が入れた目安だけを使う。
 * 上限か友だちの数が無いアカウントには出さない（作り物の上限を出さない）。
 */
export function friendCapacityMeter(account: Pick<AccountWithStats, 'friendCapacity' | 'capacityWarnAt' | 'stats'> | null | undefined): { count: number; capacity: number; rate: number; warn: boolean } | null {
  const capacity = account?.friendCapacity
  const count = account?.stats?.friendCount
  if (typeof capacity !== 'number' || !Number.isFinite(capacity) || capacity <= 0 || typeof count !== 'number' || !Number.isFinite(count)) return null
  const warnAt = account?.capacityWarnAt
  return {
    count,
    capacity,
    rate: Math.max(0, Math.min(100, count / capacity * 100)),
    warn: count >= capacity || (typeof warnAt === 'number' && Number.isFinite(warnAt) && count >= warnAt),
  }
}

export function ConnectionStatus({ account, canCheck, onChecked, risk, activeFriends, activeFriendsCompare, healthFailed }: {
  account: AccountWithStats | null | undefined
  /** 確かめるを押せる（オーナー・管理者）。 */
  canCheck: boolean
  /** 確認の後にアカウントの一覧を読み直す。 */
  onChecked: () => Promise<void> | void
  risk: HealthRisk
  activeFriends: number | null
  /** 有効友だちの先週の同じ曜日との比べ。記録が無い時は null（札を出さない）。 */
  activeFriendsCompare?: DashboardComparison | null
  healthFailed?: boolean
}) {
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState('')
  const state = webhookState(account)
  const webhookLabel = checking ? '確認中' : state.label
  const autoLabel = healthFailed ? '未取得' : risk === 'normal' ? '有効' : risk ? '要確認' : '確認中'
  const dotOf = (label: string) => (label === '正常' || label === '有効' ? 'success' : label === '要確認' ? 'danger' : 'faint') as 'success' | 'danger' | 'faint'
  /* Webhook の要確認は黄の丸と理由（統括のアカウントの接続と同じ）。 */
  const webhookDot = webhookLabel === '要確認' ? 'warning' : dotOf(webhookLabel)
  const revision = account?.revision
  const canRun = canCheck && !!account && !account.archivedAt && typeof revision === 'number' && Number.isInteger(revision) && revision >= 1
  const check = async () => {
    if (!account || !canRun || checking) return
    setChecking(true)
    setCheckError('')
    try {
      await fetchApi(`/api/line-accounts/${encodeURIComponent(account.id)}/connection-checks`, {
        method: 'POST',
        headers: { 'Idempotency-Key': `dashboard-check-${account.id}-${crypto.randomUUID()}` },
        body: JSON.stringify({ expectedRevision: revision }),
      })
      await onChecked()
    } catch {
      setCheckError('接続を確かめられませんでした。時間をおいてもう一度押してください。')
    } finally {
      setChecking(false)
    }
  }
  const showCheck = canRun && (state.label !== '正常' || checking)
  const capacity = friendCapacityMeter(account)
  return (
    <DashboardAsideSection>
      <SectionHeader title="接続状態" />
      <div className={styles.kvWithAction}>
        <KeyValue label="LINE Webhook" value={webhookLabel} dot={webhookDot} />
        {showCheck ? (
          <button type="button" className={styles.inlineAction} onClick={() => void check()} disabled={checking} aria-label="LINE Webhook の接続を確かめる">
            確かめる
          </button>
        ) : null}
      </div>
      {state.label === '要確認' && state.reason && !checking ? <p className={`${styles.stale} ${styles.connectionReason}`} title={state.reason.title}>{state.reason.text}</p> : null}
      {checkError ? <p className={styles.alert} role="alert">{checkError}</p> : null}
      {account?.tokenExpiry ? <KeyValue label="トークンの期限" value={account.tokenExpiry.label} /> : null}
      <KeyValue label="自動処理" value={autoLabel} dot={dotOf(autoLabel)} tone={autoLabel === '要確認' ? 'danger' : 'default'} />
      <KeyValue label="有効友だち" value={activeFriends === null ? emptyValue('unknown') : <span className={styles.kvDelta}>
        {activeFriendsCompare ? <KpiDelta current={activeFriendsCompare.current} previous={activeFriendsCompare.previous} better={activeFriendsCompare.better} unit="人" /> : null}
        <span>{`${formatNumber(activeFriends)} 人`}</span>
      </span>} />
      {capacity ? <>
        <KeyValue label="友だちの上限" value={`${formatNumber(capacity.count)} / ${formatNumber(capacity.capacity)} 人`} tone={capacity.warn ? 'danger' : 'default'} />
        <ProgressBar appearance="quota" tone={capacity.warn ? 'danger' : undefined} value={capacity.rate} label={`友だちの上限の使用率 ${Math.round(capacity.rate)}%`} />
      </> : null}
    </DashboardAsideSection>
  )
}

/* ── 右の列：友だちの状態 ─────────────────────────── */
export function FriendStatus({ friends }: { friends: DashboardOverview['friends'] }) {
  const blocked = friends.blockedByThem + friends.hiddenByUs + friends.blockedBoth
  const base = friends.active + blocked
  const rate = base > 0 ? (blocked / base) * 100 : 0
  const breakdown = `相手から ${formatNumber(friends.blockedByThem)} 人・自分から ${formatNumber(friends.hiddenByUs)} 人・相互に ${formatNumber(friends.blockedBoth)} 人`
  return (
    <>
      <SectionHeader title="友だちの状態" note="現在" href="/friends" linkLabel="友だちへ" />
      <KeyValue label="友だち総数" value={`${formatNumber(friends.total)} 人`} />
      <KeyValue label="有効" value={`${formatNumber(friends.active)} 人`} />
      <KeyValue label="ブロック・非表示" value={`${formatNumber(blocked)} 人（${rate.toFixed(1)}%）`} />
      <p className={styles.small} title={breakdown}>{breakdown}</p>
    </>
  )
}

/* ── 段D：今後の予定 ─────────────────────────────── */
const upcomingKindLabel: Record<string, string> = { broadcast: '配信', reminder: 'リマインダ', booking: '予約' }

/** 今日の予定は時刻だけ、違う日は日付を付ける（深夜に見て読み違えない）。 */
function upcomingTime(iso: string, today: string, jstDay: (v: string) => string): string {
  return jstDay(iso) === today ? formatTime(iso) : formatDateTime(iso)
}

export function Upcoming({ accountId, bookings, loading, today, jstDay, startLoad }: {
  accountId: string | null
  /** 本文の段が見えるまで取らない（速さ対応）。 */
  startLoad: boolean
  bookings: BookingRequest[] | null
  loading: boolean
  today: string
  jstDay: (v: string) => string
}) {
  const [upcoming, setUpcoming] = useState<DashboardUpcoming | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!startLoad || !accountId) return
    let cancelled = false
    setUpcoming(null)
    setFailed(false)
    void api.dashboard.upcoming(accountId)
      .then((response) => {
        if (cancelled) return
        if (response.success) setUpcoming(response.data)
        else setFailed(true)
      })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [accountId, startLoad])

  const header = (
    <SectionHeader
      title="今後の予定"
      help="7日分の予約配信・リマインダ・予約です。見るだけで、ここからは変えられません。"
      helpLabel="今後の予定の説明"
      {...(upcoming ? {} : { href: '/booking/bookings?view=list', linkLabel: '予約へ' })}
    />
  )
  if (accountId && !failed && upcoming) {
    return (
      <>
        {header}
        {upcoming.items.length === 0 ? <p className={styles.note}>予定されている配信・予約はありません。</p> : upcoming.items.slice(0, 3).map((item) => (
          <div key={`${item.kind}-${item.id}`} className={styles.plan}>
            <span className={styles.planText}>
              <Link href={item.href} className={styles.planTitle} title={item.title}>{item.title}</Link>
              <span className={styles.planKind} title={upcomingKindLabel[item.kind] ?? '予定'}>{upcomingKindLabel[item.kind] ?? '予定'}</span>
            </span>
            <span className={styles.planTime}>{upcomingTime(item.startsAt, today, jstDay)}</span>
          </div>
        ))}
      </>
    )
  }
  /* 旧Worker（upcoming 未返却）・取得失敗のときは予約だけに戻る（管理画面 と同じ）。 */
  const legacy = bookings ? activeUpcomingBookings(bookings) : []
  const legacyLoading = accountId ? (!failed || loading) && bookings === null : loading
  return (
    <>
      {header}
      {legacyLoading ? <Loading label="今後の予定" /> : bookings === null ? (
        <p className={styles.note}>予定を読み込めませんでした。</p>
      ) : legacy.length === 0 ? (
        <p className={styles.note}>予定されている配信・予約はありません。</p>
      ) : legacy.slice(0, 3).map((booking) => (
        <div key={booking.id} className={styles.plan}>
          <span className={styles.planText}>
            <span className={styles.planTitle} ><TruncatedText value={String(booking.menu_name ?? '')} /></span>
            <span className={styles.planKind} ><TruncatedText value={String(booking.friend_name ?? '名前未設定')} /></span>
          </span>
          <span className={styles.planTime}>{upcomingTime(booking.starts_at, today, jstDay)}</span>
        </div>
      ))}
    </>
  )
}

/* ── 段D：今日の配信の失敗 ───────────────────────── */
export function DeliveryFailures({ accountId, startLoad, compare }: {
  accountId: string | null
  startLoad: boolean
  /** 先週の同じ曜日の同じ時刻までとの比べ。記録が無い時は null（札を出さない）。 */
  compare?: DashboardComparison | null
}) {
  const [origins, setOrigins] = useState<DeliveryFailureOrigins | null>(null)
  const [failed, setFailed] = useState(false)
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null)
  useEffect(() => {
    if (!startLoad || !accountId) return
    let cancelled = false
    setOrigins(null)
    setFailed(false)
    setFetchedAt(null)
    void api.dashboard.deliveryFailureOrigins(accountId)
      .then((response) => {
        if (cancelled) return
        if (response.success) {
          setOrigins(response.data)
          setFetchedAt(new Date())
        } else setFailed(true)
      })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [accountId, startLoad])
  const asOf = origins?.asOf ? formatDateTime(origins.asOf) : null
  return (
    <>
      <SectionHeader
        title="今日の配信の失敗"
        help={asOf
          ? `出どころ：通知の送達台帳・${asOf}時点。同じ失敗は1件として数えています（送り直しは数えません）。`
          : '出どころ：通知の送達台帳。同じ失敗は1件として数えています（送り直しは数えません）。'}
        helpLabel="今日の配信の失敗の説明"
      />
      {origins ? (
        <p className={styles.figure}><span className={styles.bigNum}>{formatNumber(origins.total)}</span><span className={styles.unit}>件</span>{compare && compare.current === origins.total ? <KpiDelta current={compare.current} previous={compare.previous} better={compare.better} unit="件" /> : null}</p>
      ) : failed ? (
        <p className={styles.figure}><span className={styles.bigNum}>{emptyValue('unknown')}</span></p>
      ) : <Loading label="今日の配信の失敗" />}
      <p className={styles.note}>{failed ? '読み込めませんでした。' : '送れなかった理由と送り直しは、配信の詳細で確かめる'}</p>
      <Updated>{dashboardLocalUpdatedAt(fetchedAt)}</Updated>
    </>
  )
}

/* ── 段D：今月の配信 ─────────────────────────────── */
export function MonthlyDelivery({ delivery, section }: { delivery: DashboardOverview['delivery']; section?: Section }) {
  const fig = (label: string, value: number | null) => (
    <div className={styles.fig}>
      <span className={styles.figKey}>{label}</span>
      <span className={styles.figure}><span className={styles.midNum}>{value === null ? emptyValue('unknown') : formatNumber(value)}</span><span className={styles.unitSmall}>通</span></span>
    </div>
  )
  return (
    <>
      <SectionHeader title="今月の配信" href="/analytics?tab=reactions" linkLabel="アクセス解析へ" />
      <div className={styles.figs}>{fig('プッシュ数', delivery.push)}{fig('リプライ数', delivery.reply)}</div>
      <Updated>{sectionUpdated(section)}</Updated>
    </>
  )
}

/* ── 段D：最近の成果 ─────────────────────────────── */
export function RecentResults({ conversions, period, section }: { conversions: DashboardOverview['conversions']; period: string; section?: Section }) {
  return (
    <>
      <SectionHeader title="最近の成果" note={period} href="/conversions" linkLabel="成果へ" />
      {conversions.byPoint.length === 0 ? (
        <p className={styles.noteBody}>この期間の成果はまだありません。成果地点を作ると、ここに件数が出ます。</p>
      ) : (
        <>
          {conversions.byPoint.map((point) => (
            <KeyValue key={point.name} label={point.name} value={`${formatNumber(point.count)} 件`} />
          ))}
          <KeyValue label="合計" value={`${formatNumber(conversions.total)} 件`} />
        </>
      )}
      <Updated>{sectionUpdated(section)}</Updated>
    </>
  )
}

/* ── 数だけの段（編集で出せる追加のカード） ───────── */
export function Metric({ title, period, href, linkLabel, value, unit = '件', detail, help, section, loading }: {
  title: string
  period?: string
  href: string
  linkLabel: string
  value: number | null
  unit?: string
  detail: string
  help?: string
  section?: Section
  loading: boolean
}) {
  return (
    <>
      <SectionHeader title={title} note={period} help={help} helpLabel={help ? `${title}の説明` : undefined} href={href} linkLabel={linkLabel} />
      {loading && value === null ? <Loading label={title} /> : (
        <p className={styles.figure}><span className={styles.bigNum}>{value === null ? emptyValue('unknown') : formatNumber(value)}</span>{value === null ? null : <span className={styles.unit}>{unit}</span>}</p>
      )}
      {detail ? <p className={styles.note}>{detail}</p> : null}
      <Updated>{sectionUpdated(section)}</Updated>
    </>
  )
}

/* ── 段E：最近の動き ─────────────────────────────── */
function activityIcon(item: NotificationCenterItem) {
  if (item.category === 'error') return TriangleAlert
  if (item.eventType.startsWith('broadcast')) return Send
  if (item.eventType.startsWith('friend')) return UserPlus
  return Bell
}

export function RecentActivity({ items, failed }: { items: NotificationCenterItem[] | null; failed: boolean }) {
  const shown = (items ?? []).slice(0, 3)
  return (
    <Card className={styles.activity} aria-label="最近の動き">
      <SectionHeader title="最近の動き" href="/notifications" linkLabel="動きの一覧へ" />
      {items === null ? (
        failed ? <p className={styles.note}>最近の動きを読み込めませんでした。</p> : <Loading label="最近の動き" />
      ) : shown.length === 0 ? (
        <p className={styles.note}>最近の動きはありません。</p>
      ) : shown.map((item, index) => (
        <Link key={item.id} href={dashboardNotificationDestination(item)} className={styles.activityLink}>
          <ActivityItem
            icon={activityIcon(item)}
            title={item.title}
            note={item.body}
            time={formatRelative(item.createdAt)}
            last={index === shown.length - 1}
          />
        </Link>
      ))}
    </Card>
  )
}
