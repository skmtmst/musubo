import type { AbMetric, AbSettings, AbUndecided } from './api'

/* G1 A/B テストの決まり（要件 G1 §2-2）。画面から切り離した計算だけを置く。 */

export const AB_MIN_TOTAL = 2000
export const AB_RATIOS: AbSettings['testRatioPct'][] = [10, 20, 30, 50]
export const AB_DECIDE_HOURS = [1, 2, 4, 8, 24]
export const AB_DEFAULT: AbSettings = { testRatioPct: 20, metric: 'click', decideAfterMinutes: 240, undecidedPolicy: 'stop' }

export const METRIC_WORD: Record<AbMetric, string> = { click: 'クリック', booking: '予約', purchase: '購入' }
export const UNDECIDED_WORD: Record<AbUndecided, string> = { stop: '止めて知らせる', send_a: 'A 案を送る' }

/** 試す人数と残り（1 案 = 割合の半分。50% は全員を半分ずつで残り無し）。 */
export function splitAudience(total: number, ratioPct: number): { a: number; b: number; rest: number } {
  const each = Math.floor((total * ratioPct) / 100 / 2)
  const rest = ratioPct >= 50 ? 0 : Math.max(0, total - each * 2)
  return { a: ratioPct >= 50 ? Math.ceil(total / 2) : each, b: ratioPct >= 50 ? Math.floor(total / 2) : each, rest }
}

/** 使えない理由（使えるなら null）。全員への配信・人数が足りない（AB-08・AB-09）。 */
export function abBlockedReason(targetAll: boolean, total: number | null, allowSmall = false): 'all' | 'few' | null {
  if (targetAll) return 'all'
  if (!allowSmall && total !== null && total < AB_MIN_TOTAL) return 'few'
  return null
}

/** 「14:00」の形。日本時間。 */
export function hm(date: Date): string {
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)
}

/** 「11/21（土）14:00」の形。日本時間。 */
export function mdwhm(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const md = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short' }).formatToParts(date)
  const get = (type: string) => md.find((part) => part.type === type)?.value ?? ''
  return `${get('month')}/${get('day')}（${get('weekday')}）${hm(date)}`
}

/** 決める時刻（送り始め＋決めるまでの時間）。 */
export function decideTime(start: Date, minutes: number): Date {
  return new Date(start.getTime() + minutes * 60_000)
}
