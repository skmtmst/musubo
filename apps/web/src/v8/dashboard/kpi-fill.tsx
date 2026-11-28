'use client'
import { useEffect, useState, type ReactNode } from 'react'
import { CalendarClock, Send, UserPlus } from 'lucide-react'
import { DASHBOARD_COMPARISON_BETTER, type DashboardComparison } from '@line-crm/shared'
import KpiCard from '@/components/shared/kpi-card'
import { STATE_TEXT } from '@/components/shared/not-connected'
import { api, type DashboardOverview, type DashboardUpcomingItem } from '@/lib/api'
import { formatListTimestamp, formatNumber } from '@/lib/format'
import { jstDate, jstDateOffset } from '@/lib/jst-datetime'
import KpiDelta, { type KpiDeltaBasis } from './kpi-delta'

/**
 * 数の帯をいつも4マスにそろえるための数（今日の友だち・今月の配信・次の配信）。
 *
 * 表示を変える（編集）で選んだ数を先に並べ、足りない分だけここから埋める。
 * どれも今ある口で取れる数だけを使い、取れない時は「—」と「読み込めませんでした」。
 */
export type KpiFillId = 'fill-friends' | 'fill-delivery' | 'fill-next-broadcast'

const BAND_CELLS = 4
const NEXT_BROADCAST_DAYS = 31
const ACTIVE_FRIENDS_BASIS: KpiDeltaBasis = { short: '先週比', reading: '先週の同じ曜日の友だちの数' }

/** 選んだマスの数に合わせて、足すマスを決める。予約のマスがある時は「次の配信」を足さない（予約が4枚目）。 */
export function kpiFillIds(chosen: readonly string[]): KpiFillId[] {
  const candidates: KpiFillId[] = ['fill-friends', 'fill-delivery']
  if (!chosen.includes('today-bookings')) candidates.push('fill-next-broadcast')
  return candidates.slice(0, Math.max(0, BAND_CELLS - chosen.length))
}

/** 予約の入った一斉配信のうち一番近い1本。読めない時は failed。 */
export function useNextBroadcast(accountId: string | null, start: boolean) {
  const [state, setState] = useState<{ accountId: string; item: DashboardUpcomingItem | null; failed: boolean } | null>(null)
  useEffect(() => {
    if (!start || !accountId) return
    let cancelled = false
    void api.dashboard.upcoming(accountId, NEXT_BROADCAST_DAYS)
      .then((response) => {
        if (cancelled) return
        if (!response.success) {
          setState({ accountId, item: null, failed: true })
          return
        }
        if (!Array.isArray(response.data?.items) || response.data.items.some((entry) => !entry || typeof entry !== 'object')) throw new Error('invalid upcoming broadcasts')
        const broadcasts = response.data.items.filter((entry) => entry.kind === 'broadcast')
        if (broadcasts.some((entry) => typeof entry.startsAt !== 'string' || !Number.isFinite(Date.parse(entry.startsAt)) || typeof entry.title !== 'string')) throw new Error('invalid upcoming broadcasts')
        const item = broadcasts.sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0] ?? null
        setState({ accountId, item, failed: false })
      })
      .catch(() => { if (!cancelled) setState({ accountId, item: null, failed: true }) })
    return () => { cancelled = true }
  }, [accountId, start])
  return state && state.accountId === accountId ? state : null
}

type FillInput = {
  data: DashboardOverview | null
  overviewFailed: boolean
  trendAvailable: boolean
  today: string
  activeFriendsCompare: DashboardComparison | null
  nextBroadcast: ReturnType<typeof useNextBroadcast>
}

export function kpiFillCell(id: KpiFillId, input: FillInput): ReactNode {
  if (id === 'fill-friends') return <FriendsToday key={id} {...input} />
  if (id === 'fill-delivery') return <DeliveryThisMonth key={id} {...input} />
  return <NextBroadcast key={id} {...input} />
}

function FriendsToday({ data, overviewFailed, trendAvailable, today, activeFriendsCompare }: FillInput) {
  const trend = data?.metrics?.friendTrend === undefined ? data?.trend ?? [] : data.metrics.friendTrend.value ?? []
  const point = data && trendAvailable ? trend.find((item) => item.date === today) ?? null : null
  const failed = overviewFailed || (data !== null && !trendAvailable)
  const blocked = point && !point.estimated ? `ブロック ${formatNumber(point.blocked)} 人` : 'ブロック 未集計'
  return <KpiCard
    presentation="band"
    title="今日の友だち"
    icon={<UserPlus size={16} aria-hidden="true" />}
    value={point ? point.added : null}
    signed
    unit="人"
    help="今日友だちになった人の数です。差の印は、今の友だちの数を先週の同じ曜日と比べています。ブロックは日ごとの記録がある日だけ出します。"
    loading={!data && !overviewFailed}
    delta={point && activeFriendsCompare ? <KpiDelta current={activeFriendsCompare.current} previous={activeFriendsCompare.previous} better={DASHBOARD_COMPARISON_BETTER.activeFriends} unit="人" basis={ACTIVE_FRIENDS_BASIS} /> : null}
    detail={failed ? STATE_TEXT.error : !data ? STATE_TEXT.loading : point ? blocked : '今日の記録はまだありません'}
    sparkline={point ? [...trend].sort((a, b) => a.date.localeCompare(b.date)).map((item) => item.added) : undefined}
  />
}

function DeliveryThisMonth({ data, overviewFailed }: FillInput) {
  const metric = data?.metrics?.monthlyQuota
  const used = metric === undefined ? data?.delivery.quotaUsed ?? null : metric.value?.used ?? null
  const limit = metric === undefined ? data?.delivery.quotaLimit ?? null : metric.value?.limit ?? null
  const unlimited = metric?.value?.unlimited === true
  const notConnected = metric?.state === 'unavailable' && metric.reason === 'not_connected'
  const failed = overviewFailed || (metric?.state === 'unavailable' && !notConnected)
  const rate = used !== null && limit ? Math.max(0, Math.min(100, used / limit * 100)) : null
  const detail = failed ? STATE_TEXT.error
    : notConnected ? 'LINEアカウントが未接続です'
      : !data ? STATE_TEXT.loading
        : unlimited ? '送信枠は上限なし'
          : limit !== null && rate !== null ? `枠 ${formatNumber(limit)} 通のうち ${Math.round(rate)}%` : '送信枠を取れませんでした'
  return <KpiCard
    presentation="band"
    title="今月の配信"
    icon={<Send size={16} aria-hidden="true" />}
    value={failed ? null : used}
    unit="通"
    help="LINE公式アカウントで今月送った数です。送信枠は毎月1日にリセットされ、使い切ると翌月1日まで送れません。"
    loading={!data && !overviewFailed}
    meter={!failed && !unlimited && rate !== null ? { value: rate, label: '送信枠の使った割合', tone: rate >= 90 ? 'danger' : undefined } : undefined}
    badge={rate !== null && rate >= 80 ? '枠が残りわずか' : undefined}
    badgeTone={rate !== null && rate >= 90 ? 'danger' : 'warning'}
    detail={detail}
    action={{ label: '配信へ', href: '/broadcasts' }}
  />
}

function NextBroadcast({ nextBroadcast }: FillInput) {
  const item = nextBroadcast?.item ?? null
  const failed = nextBroadcast?.failed === true
  return <KpiCard
    presentation="band"
    title="次の配信"
    icon={<CalendarClock size={16} aria-hidden="true" />}
    value={null}
    valueText={item ? formatListTimestamp(item.startsAt, { fallback: '—' }) : '—'}
    unit=""
    help={`予約した一斉配信のうち、${NEXT_BROADCAST_DAYS}日以内で一番近い1本です。`}
    loading={nextBroadcast === null}
    badge={item ? soonLabel(item.startsAt) : nextBroadcast && !failed ? 'なし' : undefined}
    badgeTone={item ? 'warning' : 'neutral'}
    detail={failed ? STATE_TEXT.error : item ? `「${item.title}」` : nextBroadcast === null ? STATE_TEXT.loading : '予約した配信はありません'}
    action={{ label: '配信の予定へ', href: '/broadcasts' }}
  />
}

/** 次の配信が今日・明日なら札で知らせる（確かめが要る）。それより先は札を出さない。 */
function soonLabel(startsAt: string, now: Date = new Date()): string | undefined {
  const target = jstDate(new Date(startsAt))
  if (target === jstDate(now)) return '今日'
  if (target === jstDateOffset(1, now)) return '明日'
  return undefined
}
