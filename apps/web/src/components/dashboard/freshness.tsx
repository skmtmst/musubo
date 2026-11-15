import type { DashboardOverview } from '@/lib/api'
import { formatDay, formatTime } from '@/lib/format'

type Freshness = NonNullable<DashboardOverview['freshness']>
type Reason = NonNullable<DashboardOverview['sections']>[keyof NonNullable<DashboardOverview['sections']>]['reason']

function dashboardFreshnessReasonText(reason: Reason): string | null {
  if (reason === 'source_failed') return '集計元の取得に失敗'
  if (reason === 'fetch_failed') return '外部サービスの取得に失敗'
  if (reason === 'not_connected') return 'LINE未接続'
  if (reason === 'not_loaded') return '未取得'
  if (reason === 'not_applicable') return '対象外'
  return null
}

/** JSTで「その日」を比べるためのキー。閲覧端末のタイムゾーンに左右されない。 */
function jstDayKey(date: Date): string {
  return formatDay(date)
}

export function formatDashboardAsOf(asOf: string | null | undefined, now: Date = new Date()): string | null {
  if (!asOf) return null
  // APIが返すtimezone無しD1時刻は、server側と同じ既存契約に従ってJSTとして扱う。
  // Z / offset 付きの値は絶対時刻なので、その指定をそのまま維持する。
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(asOf)
    ? `${asOf.replace(' ', 'T')}+09:00`
    : asOf
  const date = new Date(normalized)
  if (Number.isNaN(date.getTime())) return null
  const time = formatTime(date)
  /*
   * 日付が今日と違うときは日付を添える（DASH-16）。
   * 時刻だけだと、前日・数日前に取れた値を「今日の更新」と読み違える。
   */
  if (jstDayKey(date) !== jstDayKey(now)) {
    const day = formatDay(date)
    return `${day} ${time}`
  }
  return time
}

export function dashboardFreshnessText(
  freshness: Freshness,
  asOf: string | null | undefined,
  reason?: Reason,
  now: Date = new Date(),
): string {
  const time = formatDashboardAsOf(asOf, now)
  const reasonText = dashboardFreshnessReasonText(reason)
  if (freshness === 'unavailable') return reasonText ? `取得失敗・${reasonText}` : '取得失敗'
  if (freshness === 'partial') {
    const label = time ? `一部取得・更新 ${time}` : '一部取得'
    return reasonText ? `${label}・${reasonText}` : label
  }
  if (!time) return '更新時刻未取得'
  if (freshness === 'stale') return `最終更新 ${time}・要確認`
  if (freshness === 'delayed') return `更新 ${time}・遅延`
  return `更新 ${time}`
}

/**
 * セクション・カードの対象期間ラベル（IDEA-01）。
 * 数字がいつの範囲かをカード見出しの脇へ小さく出すための辞書。
 */
export function dashboardPeriodLabel(
  period: 'today' | 'last7' | 'last28' | 'last30' | 'latest' | 'last7-fixed' | 'this-month' | string | null | undefined,
): string | null {
  switch (period) {
    case 'today': return '今日'
    case 'last7': return '過去7日'
    case 'last28': return '過去28日'
    case 'last30': return '過去30日'
    case 'last90': return '過去90日'
    case 'custom': return '指定した期間'
    case 'latest': return '現在'
    case 'last7-fixed': return '直近7日'
    case 'this-month': return '今月'
    default: return null
  }
}

/**
 * 画面側で取得した時刻の表示（JST・時:分）。
 * サーバーの asOf を持たない補助取得（予約・受信箱・出荷）の「更新 HH:MM」に使う。
 */
export function dashboardLocalUpdatedAt(at: Date | null | undefined): string | null {
  if (!at || Number.isNaN(at.getTime())) return null
  return `更新 ${formatTime(at)}`
}

export default function DashboardFreshness({
  freshness,
  asOf,
  reason,
}: {
  freshness: Freshness | undefined
  asOf: string | null | undefined
  reason?: Reason
}) {
  if (!freshness) return null
  return (
    <span className={freshness === 'unavailable'
      ? 'text-danger shrink-0 text-xs font-medium'
      : freshness === 'partial' || freshness === 'stale' || freshness === 'delayed'
        ? 'text-warning shrink-0 text-xs font-medium'
        : 'text-ink-faint shrink-0 text-xs font-medium'}>
      {dashboardFreshnessText(freshness, asOf, reason)}
    </span>
  )
}
