import { jstCalendar as japanCalendar } from '@/lib/jst-datetime'
/*
 * 「今日のお店」（E-1）と「枠を閉じる知らせ」（E-5）の数え方。画面から切り離して試験する。
 */
import type { RestaurantChannelCloseTask } from '@line-crm/shared'
import type { RestaurantReservation, RestaurantTable } from '@/lib/restaurant-test-api'
import { isWalkIn } from '@/v8/restaurant/front-desk/public/walk-in/index'
import { pad2, tableBusy } from '@/v8/restaurant/front-desk/public/slots/index'
import type { StoreMedium } from './use-store-today'

const INACTIVE = ['cancelled', 'no_show']

/** 予約の口は owner・admin・staff に開いている。それ以外（閲覧のみ）には押すボタンを置かない。 */
export function canWriteRole(role: string | null): boolean {
  return role === 'owner' || role === 'admin' || role === 'staff'
}

export type TodaySummary = {
  /** 取消・無断・押さえを除いた今日の予約の組数。 */
  groups: number
  /** その人数の合計。人数が不明な予約が混ざるときは確定値にせず null。 */
  guests: number | null
  line: number
  phone: number
  walkIn: number
  media: number
  /** いちばん人が多い時（00分の1時間ごと）。予約が無い、または時刻・人数が不明な予約が混ざるときは null。 */
  peak: { label: string; guests: number } | null
  /** いま空いている卓（動いている卓のうち、いま予約が重なっていない卓）。 */
  freeTables: number
  totalTables: number
  /** カウンター席数の合計。席数が不明な卓が混ざるときは確定値にせず null。 */
  counterSeats: number | null
}

function isHold(r: RestaurantReservation): boolean {
  return r.status === 'pending' && Boolean(r.hold_expires_at)
}

export function liveReservations(rows: RestaurantReservation[]): RestaurantReservation[] {
  return rows.filter((r) => !INACTIVE.includes(r.status) && !isHold(r))
}

function isValidCount(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

function parseStartsAt(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const iso = /Z$|[+-]\d{2}:?\d{2}$/i.test(value) ? value : `${value.replace(' ', 'T')}Z`
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? parsed : null
}

export function summarizeToday(rows: RestaurantReservation[], tables: RestaurantTable[], now: number): TodaySummary {
  const live = liveReservations(rows)
  const walkIn = live.filter(isWalkIn).length
  const line = live.filter((r) => r.source === 'line').length
  const phone = live.filter((r) => r.source === 'phone' || (r.source === 'manual' && !isWalkIn(r))).length
  const guestsKnown = live.every((r) => isValidCount(r.guest_count))
  const byHour = new Map<number, number>()
  let timesKnown = true
  for (const r of live) {
    // 表の時刻（lib/format）と同じく、時差の無い文字は UTC として読む。ブラウザの時計で読むと日本では 9 時間ずれる。
    const parsed = parseStartsAt(r.starts_at)
    if (parsed === null) {
      timesKnown = false
      continue
    }
    if (guestsKnown) {
      const hour = japanCalendar(new Date(parsed)).getUTCHours()
      byHour.set(hour, (byHour.get(hour) ?? 0) + Math.trunc(r.guest_count))
    }
  }
  let peak: TodaySummary['peak'] = null
  if (guestsKnown && timesKnown) {
    for (const [hour, guests] of [...byHour.entries()].sort((a, b) => a[0] - b[0])) {
      if (!peak || guests > peak.guests) peak = { label: `${pad2(hour)}:00`, guests }
    }
  }
  const active = tables.filter((t) => t.is_active)
  const counters = active.filter((t) => t.seat_type === 'counter')
  const counterSeatsKnown = counters.every((t) => isValidCount(t.max_capacity))
  return {
    groups: live.length,
    guests: guestsKnown ? live.reduce((sum, r) => sum + Math.trunc(r.guest_count), 0) : null,
    line,
    phone,
    walkIn,
    media: live.length - line - phone - walkIn,
    peak,
    freeTables: active.filter((t) => !tableBusy(t.id, now, now + 1, rows, now)).length,
    totalTables: active.length,
    counterSeats: counterSeatsKnown ? counters.reduce((sum, t) => sum + Math.trunc(t.max_capacity), 0) : null,
  }
}

/** 予約の状態の札：来店済み・予約中・取消・無断キャンセル。 */
export function visitState(r: RestaurantReservation): { label: string; tone: 'success' | 'info' | 'neutral' | 'danger' | 'warning' } {
  if (r.departed_at) return {label:'退店済み',tone:'neutral'}
  if (r.status === 'seated' || r.status === 'visited') return { label: '来店済み', tone: 'success' }
  if (r.status === 'cancelled') return { label: '取消', tone: 'neutral' }
  if (r.status === 'no_show') return { label: '無断キャンセル', tone: 'danger' }
  if (isHold(r)) return { label: '押さえ', tone: 'neutral' }
  if (r.status === 'pending') return { label: '承認待ち', tone: 'warning' }
  return { label: '予約中', tone: 'info' }
}

/** 来店の印を付けられるか（口と同じ：承認待ち・予約確定だけ）。 */
export function canMarkVisited(r: RestaurantReservation): boolean {
  return (r.status === 'pending' || r.status === 'confirmed') && !isHold(r)
}

export type CloseGroupState = 'open' | 'partly' | 'reopen' | 'done'

export type CloseGroup = {
  /** まとめる鍵。在庫の枠があれば枠、無ければ予約（媒体リンクの知らせ）・臨時休業ごと。 */
  slotId: string
  startsAt: string
  reason: RestaurantChannelCloseTask['reason']
  /** 残りの席。予約・臨時休業から出た知らせは席数を持たない（null）。 */
  remainingSeats: number | null
  state: CloseGroupState
  items: Array<{ id: string; channel: string; name: string; status: RestaurantChannelCloseTask['status'] }>
}

/** 知らせをまとめる鍵。枠が無い知らせ（予約・臨時休業から出たもの）は予約・休業と時刻でまとめる。 */
export function closeGroupKey(task: Pick<RestaurantChannelCloseTask, 'slotId' | 'reservationId' | 'closureId' | 'startsAt'>): string {
  if (task.slotId) return task.slotId
  if (task.reservationId) return `reservation:${task.reservationId}:${task.startsAt}`
  if (task.closureId) return `closure:${task.closureId}:${task.startsAt}`
  return `at:${task.startsAt}`
}

/**
 * 知らせは「枠（時刻）×媒体」で1件。画面は枠ごとに1行へまとめ、媒体は札で並べる。
 * 状態：全部まだ＝open、一部閉じた＝partly、席が戻った＝reopen、全部閉じた＝done。
 */
export function groupCloseTasks(tasks: RestaurantChannelCloseTask[], media: StoreMedium[]): CloseGroup[] {
  const nameOf = (code: string) => media.find((m) => m.code === code)?.name ?? code
  /* 同じ枠の媒体は、媒体の一覧（予約サイト・グルメ媒体）と同じ並び。一覧に無い媒体は後ろ。 */
  const orderOf = (code: string) => { const index = media.findIndex((m) => m.code === code); return index < 0 ? media.length : index }
  const groups = new Map<string, CloseGroup>()
  for (const task of [...tasks].sort((a, b) => a.startsAt.localeCompare(b.startsAt) || orderOf(a.channel) - orderOf(b.channel) || a.channel.localeCompare(b.channel))) {
    const key = closeGroupKey(task)
    const group: CloseGroup = groups.get(key) ?? {
      slotId: key, startsAt: task.startsAt, reason: task.reason, remainingSeats: task.remainingSeats, state: 'open', items: [],
    }
    group.items.push({ id: task.id, channel: task.channel, name: nameOf(task.channel), status: task.status })
    groups.set(key, group)
  }
  for (const group of groups.values()) {
    const statuses = group.items.map((item) => item.status)
    group.state = statuses.some((s) => s === 'reopen') ? 'reopen'
      : statuses.every((s) => s === 'done') ? 'done'
        : statuses.some((s) => s === 'done') ? 'partly'
          : 'open'
  }
  return [...groups.values()]
}

/** まだ閉じていない媒体（［閉じた］を押す相手）。 */
export function openItems(group: CloseGroup): CloseGroup['items'] {
  return group.items.filter((item) => item.status === 'close')
}

/** 枠の日時「1/13（火）19:00」。読めない日時は未確定として出す。 */
export function slotTitle(iso: string): string {
  const parsed = Date.parse(iso)
  if (!Number.isFinite(parsed)) return '日時を確認できません'
  const day = japanCalendar(new Date(parsed))
  const week = '日月火水木金土'[day.getUTCDay()]
  return `${day.getUTCMonth() + 1}/${day.getUTCDate()}（${week}）${pad2(day.getUTCHours())}:${pad2(day.getUTCMinutes())}`
}

export function reasonText(group: Pick<CloseGroup, 'reason' | 'remainingSeats'>): string {
  if (group.reason === 'full') return '満席になりました'
  if (group.reason === 'table_conflict') return '卓が重なる予約が届きました'
  if (group.reason === 'closure') return '臨時休業・貸切で閉じました'
  if (group.remainingSeats === null) return 'LINE・電話で予約が入りました'
  if (!Number.isFinite(group.remainingSeats)) return '残り席数を確認できません'
  return `残り ${Math.max(0, Math.trunc(group.remainingSeats))}席になりました`
}
