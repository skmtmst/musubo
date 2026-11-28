import { knownValue } from '@/lib/known-value'
/*
 * 臨時休業・貸切（提案 E-10 ・）の表示の形と数え方。画面から切り離して試験する。
 *
 * 日付は店舗の暦日（YYYY-MM-DD）のまま扱う。時刻の重なりだけ、店舗のタイムゾーンで UTC に直して比べる。
 */
import { formatDate as polishFormatDate } from '@/lib/format'
import type { RestaurantClosure, RestaurantClosureInput, RestaurantClosureKind } from '@line-crm/shared'
import type { RestaurantChannelCloseTask } from '@line-crm/shared'
import type { RestaurantReservation, RestaurantTable } from '@/lib/restaurant-test-api'
import { joinTableCodes } from '@/v8/restaurant/inventory/public/format/index'

const WEEKDAY = ['日', '月', '火', '水', '木', '金', '土']

export const KIND_LABEL: Record<RestaurantClosureKind, string> = {
  temporary_closed: '臨時休業',
  private_event: '貸切',
  maintenance: '設備点検',
  other: 'その他',
}

export const KIND_ORDER: RestaurantClosureKind[] = ['temporary_closed', 'private_event', 'maintenance', 'other']

/** カレンダーの色。貸切だけ琥珀、ほか（臨時休業・設備点検・その他）は店を閉じる日なので桃。 */
export function kindTone(kind: RestaurantClosureKind): 'closed' | 'private' {
  return kind === 'private_event' ? 'private' : 'closed'
}

export function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export function ymd(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** 店舗のタイムゾーンでの今日（YYYY-MM-DD）。 */
export function todayIn(timezone: string | null | undefined, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'Asia/Tokyo' }).format(now)
}

function parse(value: string): { y: number; m: number; d: number } {
  const [y, m, d] = value.split('-').map(Number)
  return { y, m, d }
}

export function addDays(value: string, days: number): string {
  const { y, m, d } = parse(value)
  return ymd(new Date(y, m - 1, d + days))
}

export function weekdayOf(value: string): number {
  const { y, m, d } = parse(value)
  return new Date(y, m - 1, d).getDay()
}

/** 「10月20日（火）」 */
export function dayTitle(value: string): string {
  return polishFormatDate(value, { style: 'day' })
}

/** 「10月20日」 */
export function dayShort(value: string): string {
  return polishFormatDate(value, { style: 'day' })
}

/** 1日なら「10月20日（火）」、期間なら「10月20日（火）〜22日（木）」（月をまたぐと月も書く）。 */
export function rangeTitle(closure: Pick<RestaurantClosure, 'startDate' | 'endDate'>): string {
  if (closure.startDate === closure.endDate) return dayTitle(closure.startDate)
  const a = parse(closure.startDate)
  const b = parse(closure.endDate)
  const end = a.m === b.m && a.y === b.y ? `${b.d}日（${WEEKDAY[weekdayOf(closure.endDate)]}）` : dayTitle(closure.endDate)
  return `${dayTitle(closure.startDate)}〜${end}`
}

/** 「2026年10月」 */
export function monthTitle(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return `${y}年${m}月`
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const date = new Date(y, m - 1 + delta, 1)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`
}

/** 月のカレンダー（日曜はじまり）。前後の空きは null。 */
export function monthWeeks(month: string): Array<Array<string | null>> {
  const [y, m] = month.split('-').map(Number)
  const first = new Date(y, m - 1, 1)
  const days = new Date(y, m, 0).getDate()
  const cells: Array<string | null> = Array.from({ length: first.getDay() }, () => null)
  for (let d = 1; d <= days; d += 1) cells.push(`${y}-${pad2(m)}-${pad2(d)}`)
  while (cells.length % 7 !== 0) cells.push(null)
  const weeks: Array<Array<string | null>> = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  return weeks
}

export function covers(closure: Pick<RestaurantClosure, 'startDate' | 'endDate'>, day: string): boolean {
  return closure.startDate <= day && closure.endDate >= day
}

/** 閉じる卓の書き方。空＝全卓。 */
export function tablesText(tableIds: string[], tables: RestaurantTable[]): string {
  if (tableIds.length === 0) return '全卓'
  const picked = tables.filter((t) => tableIds.includes(t.id))
  return picked.length ? joinTableCodes(picked) : `${tableIds.length}卓`
}

export function timeText(closure: Pick<RestaurantClosure, 'allDay' | 'startTime' | 'endTime'>): string {
  return closure.allDay ? '終日' : `${closure.startTime ?? ''}〜${closure.endTime ?? ''}`
}

/** 右の列の2行目「終日・全卓」「18:00〜22:00 ・ 個室A・T1」。 */
export function scopeText(closure: RestaurantClosure, tables: RestaurantTable[]): string {
  return closure.allDay ? `終日・${tablesText(closure.tableIds, tables)}` : `${timeText(closure)}・${tablesText(closure.tableIds, tables)}`
}

/** これから（終わりの日が今日以降）の記録。始まりの順。 */
export function upcoming(closures: RestaurantClosure[], today: string): RestaurantClosure[] {
  return closures
    .filter((c) => c.endDate >= today)
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || (a.startTime ?? '').localeCompare(b.startTime ?? '') || a.id.localeCompare(b.id))
}

/** 曜日ごとの営業時間で、時間帯が1つも無い曜日＝定休。営業時間を読めていないときは無し。 */
export function regularHolidays(hours: Array<{ weekday: number; periods: unknown[] }> | null | undefined): Set<number> {
  const set = new Set<number>()
  if (!hours || hours.length === 0) return set
  for (let weekday = 0; weekday < 7; weekday += 1) {
    const day = hours.find((h) => h.weekday === weekday)
    if (!day || day.periods.length === 0) set.add(weekday)
  }
  return set
}

/** その時刻（タイムゾーンの壁時計）と UTC の差（ミリ秒）。 */
function zoneOffset(utc: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utc))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second')) - utc
}

/** 店舗の暦日と「HH:MM」（24:00 可）を UTC のミリ秒へ。 */
export function civilToUtc(day: string, hm: string, timezone: string): number {
  const { y, m, d } = parse(day)
  const [h, mi] = hm.split(':').map(Number)
  const guess = Date.UTC(y, m - 1, d, h, mi)
  return guess - zoneOffset(guess, timezone)
}

/** 記録が閉じる時間（暦日ごと）。最大 366 日。 */
export function periodsOf(input: Pick<RestaurantClosureInput, 'startDate' | 'endDate' | 'allDay' | 'startTime' | 'endTime'>, timezone: string): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = []
  let day = input.startDate
  for (let i = 0; i < 366 && day <= input.endDate; i += 1) {
    if (input.allDay) out.push({ from: civilToUtc(day, '00:00', timezone), to: civilToUtc(addDays(day, 1), '00:00', timezone) })
    else if (input.startTime && input.endTime) out.push({ from: civilToUtc(day, input.startTime, timezone), to: civilToUtc(day, input.endTime, timezone) })
    day = addDays(day, 1)
  }
  return out
}

const INACTIVE = ['cancelled', 'no_show']

/**
 * 記録と重なる予約（取消・無断キャンセルは除く）。卓を選んだ記録は、その卓の予約と卓未定の予約を数える。
 * preview の口が使えないとき（変える窓・閲覧のみの人の件数）に、台帳の予約から数える。
 */
export function overlapping(input: Pick<RestaurantClosureInput, 'startDate' | 'endDate' | 'allDay' | 'startTime' | 'endTime' | 'tableIds'>, rows: RestaurantReservation[], timezone: string): RestaurantReservation[] {
  const periods = periodsOf(input, timezone)
  const tableIds = input.tableIds ?? []
  return rows
    .filter((r) => !INACTIVE.includes(r.status))
    .filter((r) => tableIds.length === 0 || r.table_id === null || tableIds.includes(r.table_id))
    .filter((r) => {
      const from = Date.parse(r.starts_at)
      const to = Date.parse(r.ends_at)
      return periods.some((p) => from < p.to && to > p.from)
    })
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
}

export type ClosureTasks = { open: RestaurantChannelCloseTask[]; done: number; reopen: number; total: number }

/** 記録ごとの他サイトの知らせ（今の版の閉じる知らせだけ数える）。 */
export function tasksFor(closure: Pick<RestaurantClosure, 'id'>, tasks: RestaurantChannelCloseTask[]): ClosureTasks {
  const own = tasks.filter((t) => t.reason === 'closure' && t.closureId === closure.id && t.status !== 'reopen')
  return {
    open: own.filter((t) => t.status === 'close'),
    done: own.filter((t) => t.status === 'done').length,
    reopen: tasks.filter((t) => t.reason === 'closure' && t.closureId === closure.id && t.status === 'reopen').length,
    total: own.length,
  }
}

/** 右の列の3行目「予約 2件 ・ 他サイト 未対応 2」。件数が分からないとき（null）は予約を書かない。 */
export function statusLine(reservations: number | null, tasks: ClosureTasks, contacted: number | null = null): string {
  const parts: string[] = []
  if (reservations !== null) parts.push(`予約 ${reservations} 件`)
  /* 連絡済み：休業を作った後に担当者が LINE で連絡した予約の数（重なる予約があるときだけ）。 */
  if (reservations !== null && reservations > 0 && contacted !== null) parts.push(`連絡済み ${contacted} 件`)
  if (tasks.total > 0) parts.push(tasks.open.length > 0 ? `他サイト 未対応 ${tasks.open.length}` : `他サイト 閉じた ${tasks.done}/${tasks.total}`)
  return parts.join('・')
}

/** 入力の初めの形。日付は押した日（無ければ今日）。 */
export function emptyInput(storeId: string, day: string): RestaurantClosureInput {
  return { storeId, startDate: day, endDate: day, allDay: true, startTime: null, endTime: null, kind: 'temporary_closed', memo: null, tableIds: [], notifyMedia: true }
}

export function inputOf(closure: RestaurantClosure): RestaurantClosureInput {
  return {
    storeId: closure.storeId, startDate: closure.startDate, endDate: closure.endDate, allDay: closure.allDay,
    startTime: closure.startTime, endTime: closure.endTime, kind: closure.kind, memo: closure.memo, tableIds: [...closure.tableIds],
    notifyMedia: closure.notifyMedia !== false,
  }
}

/** 入力の誤り。無ければ空文字。 */
export function inputError(input: RestaurantClosureInput, today: string): string {
  if (!input.startDate || !input.endDate) return 'はじめの日とおわりの日を選んでください。'
  if (input.startDate < today) return '今日より前の日は閉じられません。'
  if (input.endDate < input.startDate) return 'おわりの日は、はじめの日と同じか後にしてください。'
  if (!input.allDay) {
    if (!input.startTime || !input.endTime) return '閉じる時間帯を選んでください。'
    if (input.endTime <= input.startTime) return '終わりの時刻は、始まりより後にしてください。'
  }
  return ''
}

/** 30分刻みの時刻（00:00〜24:00）。終わりだけ 24:00 を選べる。 */
export function timeOptions(withEnd = false): string[] {
  const out: string[] = []
  for (let m = 0; m < 24 * 60; m += 30) out.push(`${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`)
  if (withEnd) out.push('24:00')
  return out
}

/** 予約の時刻「12:00」（店舗のタイムゾーン）。 */
export function clock(iso: string, timezone: string): string {
  return polishFormatDate(iso, { style: 'time', timeZone: timezone })
}

/** 予約の暦日（店舗のタイムゾーン）。 */
export function dayOfIso(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(iso))
}

export const SOURCE_LABEL: Record<string, string> = {
  line: 'LINE', phone: '電話', walk_in: 'ウォークイン', manual: '店頭', hotpepper: 'ホットペッパー', tabelog: '食べログ',
  gurunavi: 'ぐるなび', retty: 'Retty', ikyu: '一休', restaurant_board: 'レストランボード', google: 'Google',
}

export function sourceLabel(source: string, media: Array<{ code: string; name: string }> = []): string {
  return knownValue(SOURCE_LABEL, source, media.find((m) => m.code === source)?.name ?? source)
}

/**
 * ほかの休業・貸切と重なる（409 `closure_overlap`）ときの文。口が返す相手の記録（名前・日付・時刻）を書く。
 * 相手が分からないときは、相手を書かない文にする。
 */
export function overlapMessage(conflicts: ReadonlyArray<Pick<RestaurantClosure, 'name' | 'kind' | 'startDate' | 'endDate' | 'allDay' | 'startTime' | 'endTime'>>): string {
  const tail = '日付か卓を変えてください。'
  if (conflicts.length === 0) return `同じ日・同じ卓に、ほかの休業・貸切があります。${tail}`
  const first = conflicts[0]
  const when = first.allDay || !first.startTime || !first.endTime ? rangeTitle(first) : `${rangeTitle(first)} ${first.startTime}〜${first.endTime}`
  const name = first.name && first.name !== KIND_LABEL[first.kind] ? `${KIND_LABEL[first.kind]}「${first.name}」` : KIND_LABEL[first.kind]
  const more = conflicts.length > 1 ? `ほか ${conflicts.length - 1} 件` : ''
  return `${when}の${name}${more ? `（${more}）` : ''}と重なっています。${tail}`
}

/** ApiError の data から、重なる相手の記録を取り出す（形が違えば空）。 */
export function conflictsOf(data: unknown): RestaurantClosure[] {
  if (!data || typeof data !== 'object') return []
  const list = (data as { conflicts?: unknown }).conflicts
  return Array.isArray(list) ? list.filter((c): c is RestaurantClosure => !!c && typeof c === 'object' && typeof (c as RestaurantClosure).startDate === 'string') : []
}
