import { formatDay } from '@/lib/format'
type TimeInterval = { start: string; end: string }
type BusinessHoursDay = { weekday: number; intervals: TimeInterval[] }

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']

export function shortTime(value: string): string {
  if (typeof value !== 'string') return ''
  return value.replace(/^0/, '')
}

function validIntervals(intervals: TimeInterval[] | null | undefined): TimeInterval[] {
  if (!Array.isArray(intervals)) return []
  return intervals.filter(
    (interval): interval is TimeInterval =>
      Boolean(interval) &&
      typeof interval === 'object' &&
      typeof interval.start === 'string' &&
      typeof interval.end === 'string',
  )
}

export function openHours(intervals: TimeInterval[]): string {
  const valid = validIntervals(intervals)
  if (valid.length === 0) return '—'
  return `${shortTime(valid[0].start)} 〜 ${shortTime(valid[valid.length - 1].end)}`
}

export function breakHours(intervals: TimeInterval[]): string {
  const valid = validIntervals(intervals)
  if (valid.length < 2) return valid.length === 0 ? '—' : 'なし'
  return valid.slice(0, -1).map((interval, index) => (
    `${shortTime(interval.end)} 〜 ${shortTime(valid[index + 1].start)}`
  )).join(' / ')
}

export function shortDate(value: string): string {
  if (typeof value !== 'string') return ''
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(value)
  return match ? `${Number(match[1])}/${Number(match[2])}` : value
}

export function businessHourSummary(
  businessHours: BusinessHoursDay[] | null | undefined,
): { value: string; detail: string } {
  if (!Array.isArray(businessHours) || businessHours.length === 0) {
    return { value: '—', detail: '受付枠で曜日ごとに確認' }
  }
  const spans = businessHours.flatMap((day) => {
    if (!day || typeof day !== 'object') return []
    const valid = validIntervals(day.intervals)
    if (valid.length === 0) return []
    const last = valid.at(-1)
    if (!last) return []
    return [`${shortTime(valid[0].start)}〜${shortTime(last.end)}`]
  })
  const counts = new Map<string, number>()
  for (const span of spans) counts.set(span, (counts.get(span) ?? 0) + 1)
  const value = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '—'
  const seenDays = new Set<number>()
  const detail = businessHours
    .filter((day) => Boolean(day) && typeof day === 'object' && validIntervals(day.intervals).length > 0)
    .map((day) => {
      if (!Number.isInteger(day.weekday) || day.weekday < 0 || day.weekday > 6 || seenDays.has(day.weekday)) {
        return ''
      }
      seenDays.add(day.weekday)
      return WEEKDAYS[day.weekday] ?? ''
    })
    .filter(Boolean)
    .join('・')
  return { value, detail }
}

export function bookingWindowEnd(days: number, now = new Date()): string {
  if (typeof days !== 'number' || !Number.isFinite(days)) return '—'
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return '—'
  const date = new Date(now.getTime() + Math.max(0, days) * 86_400_000)
  if (!Number.isFinite(date.getTime())) return '—'
  // (a): 受付期間の終わりの日は判定（空き計算の最終日＝今日＋日数）と同じにする。
  // 1を引くと表示だけ1日短くなり、判定で取れる最終日と食い違う。
  return formatDay(date)
}

/**
 * 分の期限を、時間・日の単位へ読み替える（監査6 #710）。
 * 例: 90 → 1時間30分前、1440 → 24時間前、2880 → 2日前。
 * 60分未満は分のままが一番読みやすいので読み替えを返さない。
 */
export function minutesBeforeLabel(minutes: number): string | null {
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 60) return null
  if (minutes % 1440 === 0 && minutes > 1440) return `${minutes / 1440}日前`
  if (minutes % 60 === 0) return `${minutes / 60}時間前`
  return `${Math.floor(minutes / 60)}時間${minutes % 60}分前`
}
