import { jstCalendar as japanCalendar } from '@/lib/jst-datetime'
/*
 * 予約台帳（l9NlC0・Z3FoM・・xzCK6）の表示の形。今の画面
 * （app/restaurant-test/v8/reservations.tsx・reservation-phone.tsx）から写し、絵の書き方に合わせた。
 */
import { formatDate, formatYmd } from '@/lib/format'
import type { RestaurantReservation, RestaurantTable } from '@/lib/restaurant-test-api'

export type LedgerView = 'today' | 'week' | 'month' | 'list'

export const INACTIVE_STATUSES = ['cancelled', 'no_show']

export const SOURCE_LABEL: Record<string, string> = {
  restaurant_board: 'レストランボード', reszaiko: 'RESZAIKO', hotpepper: 'Hot Pepper',
  tabelog: '食べログ', gurunavi: 'ぐるなび', ikyu: '一休', retty: 'Retty',
  line: 'LINE', phone: '電話', manual: '手動', google_business_profile: 'Google',
}

/** 予約元の色の組。LINE・レストランボード＝緑、予約媒体＝赤、電話・手動＝灰。 */
export function sourceKind(source: string): 'line' | 'media' | 'phone' {
  if (source === 'line' || source === 'restaurant_board') return 'line'
  if (source === 'phone' || source === 'manual') return 'phone'
  return 'media'
}

export function sourceName(source: string): string {
  return SOURCE_LABEL[source] ?? source
}

/** 押さえ（期限付きの仮押さえ）か。 */
export function isHold(item: RestaurantReservation): boolean {
  return item.status === 'pending' && Boolean(item.hold_expires_at)
}

/** 「秋の鹿肉コース」→「秋の鹿肉」（箱と次の予約は短く）。 */
export function shortCourse(name: string | null): string {
  if (!name) return '席のみ'
  return name.replace(/コース$/, '')
}

export function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export function toYmd(day: Date): string {
  return formatYmd(day)
}

export function hm(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(date.getTime())) return '—'
  return formatDate(date,{style:'time'})
}

const WEEKDAY = ['日', '月', '火', '水', '木', '金', '土']

/** 日本時間の暦日だけを計算する。端末の時間帯や夏時間を使わない。 */
function civilDay(day: Date): Date {
  return new Date(`${toYmd(day)}T00:00:00Z`)
}

export function addDays(day: Date, offset: number): Date {
  const date = civilDay(day)
  date.setUTCDate(date.getUTCDate() + offset)
  return new Date(`${date.toISOString().slice(0, 10)}T00:00:00+09:00`)
}

/** 「10月2日（金）」 */
export function dayTitle(day: Date): string {
  const date = civilDay(day)
  return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日（${WEEKDAY[date.getUTCDay()]}）`
}

/** 「10月2日」 */
export function dayShort(day: Date): string {
  const date = civilDay(day)
  return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日`
}

/** 年をまたぐ予約も区別できる、日本時間の日時。 */
export function mdhm(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const civil = civilDay(date)
  return `${civil.getUTCFullYear()}/${pad2(civil.getUTCMonth() + 1)}/${pad2(civil.getUTCDate())} ${hm(date)}`
}

/** 予約台帳と詳細で同じ日付表記を使う。 */
export function mdWeek(day: Date): string {
  return dayTitle(day)
}

/** 電話番号は真ん中を伏せる（「090-****-1234」）。 */
export { maskPhone } from '@line-crm/shared'

export function dayRange(day: Date): { from: string; to: string } {
  return { from: new Date(`${toYmd(day)}T00:00:00+09:00`).toISOString(), to: addDays(day, 1).toISOString() }
}

export function monthRange(day: Date): { from: string; to: string } {
  const date = civilDay(day)
  const first = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1))
  const midnight = (date: Date) => new Date(`${date.toISOString().slice(0, 10)}T00:00:00+09:00`).toISOString()
  return { from: midnight(first), to: midnight(next) }
}

export function weekRange(day: Date): { from: string; to: string } {
  const start = addDays(day, -((civilDay(day).getUTCDay() + 6) % 7))
  return { from: start.toISOString(), to: addDays(start, 7).toISOString() }
}

export function sameDay(a: Date, b: Date): boolean {
  return toYmd(a) === toYmd(b)
}

/** 卓の並び：座席・卓管理のフロアの並び（行→列）。 */
export function floorOrder(a: RestaurantTable, b: RestaurantTable): number {
  return a.floor_y - b.floor_y || a.floor_x - b.floor_x || a.code.localeCompare(b.code, 'ja', { numeric: true })
}

export function minutesOf(value: string): number {
  const date = new Date(value)
  const jst=japanCalendar(date)
  return jst.getUTCHours() * 60 + jst.getUTCMinutes()
}

export function slotLabel(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${pad2(minutes % 60)}`
}
