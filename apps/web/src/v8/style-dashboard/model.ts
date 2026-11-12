import type { BookingState } from '@/components/shared/booking-state'
/*
 * 業種ダッシュボード（XBkC2）の画面の形。口（API 組4 `lib/api-styles.ts` の styleApi）の生の値を
 * `adapter.ts` がこの形へ組み立てる。数・率・通貨・状態の書き方はここから先で決める（口は生の数だけ返す）。
 */
export type { AccountStyle as UsageStyle, IndustryStyle } from '@line-crm/shared'
import type { IndustryStyle } from '@line-crm/shared'
export type DashboardRange = 'today' | 'week' | 'month'
export type Tone = 'neutral' | 'info' | 'warning' | 'success' | 'danger'

export interface StyleKpi {
  metricId?: string
  id: string
  title: string
  value: number | null
  /** 「¥32,400」のように整形済みで出す値。 */
  valueText?: string
  unit: string
  delta?: { text: string; tone: 'up' | 'down' | 'attention' } | null
  detail: string
  link?: { label: string; href: string } | null
  help: string
}

export interface StyleAlertAction { id: string; label: string; icon?: 'external' | 'check' | 'refresh' | 'link' | 'people'; href?: string; taskId?: string }
export interface StyleAlert { id: string; title: string; detail: string; actions: StyleAlertAction[] }

export interface StyleBadge { label: string; tone: Tone }

export interface StyleRow {
  id: string
  /** 飲食の予約の ID（来店の印などの本物の口に渡す）。 */
  reservationId?: string
  time: string
  endTime?: string
  name: string
  sub?: string
  people?: number
  seat?: string
  course?: string
  courseNote?: string
  meet?: StyleBadge
  staff?: string
  pay?: StyleBadge
  state?: StyleBadge
  /** 行の右の操作。visit＝来店（ボタン）・undo＝取り消す（文字）・meet＝Meet に入る・place＝場所を開く・done＝済み（文字）。 */
  action?: 'visit' | 'undo' | 'meet' | 'place' | 'done' | 'approve' | 'result' | null
  /** 開始の時刻を過ぎたか。［無断にする］［欠席にする］はこの時だけ出す。 */
  past?: boolean
  /** 取り消せる（取消・無断・期限切れでない）予約か。 */
  live?: boolean
  /** 口の予約（版・種類・料金。変える操作に渡す）。 */
  booking?: { id: string; friendId?: string | null; storeId?: string | null; kind: string; version: number | null; updatedAt: string | null; price: number; partySize: number; startsAt: string; meetingUrl?: string | null }
  actionHref?: string
  /** 教室：予約／定員・待ち・空き。 */
  booked?: number
  capacity?: number
  waiting?: number
  vacancy?: '×' | '△' | '○'
  /** 教室：この回の残りの席（上限なしは null で来ない）。 */
  remaining?: number
  highlight?: boolean
}

export interface StyleBoardColumn { id: string; name: string; initial: string; tone: 'green' | 'purple' | 'blue' | 'amber'; count: number; next: string; off?: boolean }
export interface StyleBoardEntry {
  id: string
  columnId: string
  start: string
  end: string
  name: string
  menu: string
  state: 'done' | 'active' | 'booked' | 'pending' | 'off' | 'attention' | 'no_show' | 'warning'
  stateLabel: string
  source?: string
  nominated?: boolean
  unpaid?: boolean
  selected?: boolean
}
export interface StyleBoard {
  from: string
  to: string
  now?: string
  next?: string
  columns: StyleBoardColumn[]
  entries: StyleBoardEntry[]
  free: { columnId: string; start: string }[]
}

export interface StyleSideRow { label: string; value: string; tone?: 'danger' }
export interface StyleSideCard {
  id: string
  title: string
  help?: string
  link?: { label: string; href: string } | null
  rows: StyleSideRow[]
  action?: { label: string; icon?: 'send' | 'line' } | null
  more?: { label: string; href: string } | null
}

export interface StyleWeekDay { date: string; label: string; sub: string; closed?: boolean; today?: boolean }
export interface StyleWeek {
  title: string
  from: string
  to: string
  days: StyleWeekDay[]
  entries: { id: string; day: string; start: string; end: string; title: string; name: string; state?: BookingState; source?: string }[]
  free: { day: string; start: string; end: string; bookingDay?: string; bookingStart?: string }[]
}
export interface StyleMonthDay { date: string; day: string; inMonth: boolean; closed?: boolean; groups?: number; people?: number; empty?: boolean; mark?: StyleBadge | null; today?: boolean; selected?: boolean }
export interface StyleMonth {
  title: string
  days: StyleMonthDay[]
  selected: { title: string; total: string; rows: { time: string; name: string; sub: string; state: StyleBadge }[]; moreLabel: string }
}

export interface StyleRoster {
  rowId: string
  head: string
  title: string
  pay: StyleBadge
  meta: string
  members: { name: string; sub: string; pay: StyleBadge; attend: 'done' | 'absent' | 'button' | 'cancel' | 'unavailable'; bookingId?: string; eventId?: string; startsAt?: string; canReportAbsence?: boolean }[]
  /** 回が始まったか（［欠席］はこの後だけ）。 */
  started?: boolean
  more: string
  payLinkCount: number
}

export interface StyleToday {
  style: IndustryStyle
  asOf: string
  hoursLabel?: string | null
  staff: { id: string; name: string }[]
  kpis: StyleKpi[]
  alert?: StyleAlert | null
  rows: StyleRow[]
  /** 会員予約の実集計。クラスの行数から予約数を推測しない。 */
  bookingCount?: number | null
  rowsNote: string
  board?: StyleBoard | null
  week?: StyleWeek | null
  month?: StyleMonth | null
  roster?: StyleRoster | null
  side: StyleSideCard[]
}

export interface StyleAnalyticsCell { text: string; note?: string; badge?: StyleBadge }
export interface StyleAnalytics {
  tabs: { id: string; label: string }[]
  tab: string
  cards: { id: string; title: string; valueText: string; unit?: string; delta?: { text: string; tone: 'up' | 'down' } | null; help: string }[]
  chart: { title: string; help: string; ticks: string[]; axis: string[]; points: { label: string; now: number | null; prev: number | null; previousLabel?: string }[]; max: number; emptyMessage?: string } | null
  table: { title: string; help: string; link?: { label: string; href: string } | null; columns: { label: string; align?: 'right' }[]; rows: { id: string; name: string; sub: string; cells: StyleAnalyticsCell[] }[]; note?: string } | null
  availability?: { kind: 'forbidden' | 'unavailable' | 'unmeasured'; description: string }
  side: (StyleSideCard & { bars?: { label: string; value: string; ratio: number }[]; split?: { ratio: number }; note?: string })[]
}

export interface StyleLayoutItem { id: string; label: string; on: boolean; locked?: boolean }
/** ［表示を変える］の中身。口の cards（id・visible、配列の順が上から下）と版を画面の言葉で持つ。 */
export interface StyleLayout { base: string; changed: number; version: number; cards: StyleLayoutItem[]; metricIds?: string[]; metricsCustomized?: boolean }

export interface StyleClosureInput {
  date: string
  allDay: boolean
  from?: string
  to?: string
  target: 'store' | 'staff' | 'seat'
  ids: string[]
  reason: string
  expectedSnapshot?: string
}
