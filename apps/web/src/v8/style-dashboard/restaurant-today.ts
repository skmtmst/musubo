import { formatDate, formatNumber } from '@/lib/format'
import type { StyleAlert, StyleKpi, StyleRow, StyleToday } from './model'
import type { RestaurantReservation, RestaurantTable } from '@/lib/restaurant-test-api'
import { isWalkIn } from '@/v8/restaurant/front-desk/public/walk-in/index'
import { sourceName } from '@/v8/restaurant/reservations/public/format/index'
import { canMarkVisited, groupCloseTasks, openItems, reasonText, slotTitle, summarizeToday, visitState } from '@/v8/restaurant/dashboard/public/summarize/index'
import type { StoreToday } from '@/v8/restaurant/dashboard/public/use-store-today/index'

/*
 * 飲食の業種ダッシュボードの中身を、今ある飲食の口（今日の予約・卓・枠を閉じる知らせ）から組み立てる。
 * 業種ダッシュボードの口（API 組4）が無い・読めないときに使う。
 * 口が出す物（支払いの札・前との比べ・無断キャンセル率・新着予約・右の列）は、ここでは出せないので空にする。
 */

function hm(iso: string): string {
  return formatDate(iso, { style: 'time' })
}

export function restaurantRow(r: RestaurantReservation): StyleRow {
  const state = visitState(r)
  const visited = ['visited', 'seated'].includes(r.status) && !r.departed_at
  return {
    id: r.id,
    reservationId: r.id,
    time: hm(r.starts_at),
    name: r.customer_name,
    sub: isWalkIn(r) ? 'ウォークイン' : sourceName(r.source),
    people: r.guest_count,
    seat: r.table_label ?? '—',
    course: r.course_name ?? '席のみ',
    courseNote: '—',
    state: { label: state.label, tone: state.tone },
    action: canMarkVisited(r) ? 'visit' : visited ? 'undo' : null,
  }
}

export function restaurantAlert(d: Pick<StoreToday, 'closeTasks' | 'media'>): StyleAlert | null {
  const groups = groupCloseTasks(d.closeTasks ?? [], d.media ?? [])
  const pending = groups.filter((g) => g.state === 'open' || g.state === 'partly')
  const first = pending[0]
  if (!first) return null
  const item = openItems(first)[0]
  const medium = item ? d.media?.find((m) => m.code === item.channel) : undefined
  return {
    id: 'close-tasks',
    title: `他の予約サイトの枠を閉じてください（未対応 ${formatNumber(pending.length)}件）`,
    detail: `${slotTitle(first.startsAt)} の枠が${reasonText(first)} → ${openItems(first).map((i) => i.name).join('・')}の枠を閉じてください`,
    actions: [
      ...(medium?.adminUrl ? [{ id: 'open-admin', label: '媒体の管理画面を開く', icon: 'external' as const, href: medium.adminUrl }] : []),
      ...(item ? [{ id: 'close', label: '閉じた', icon: 'check' as const, taskId: item.id }] : []),
    ],
  }
}

export function restaurantToday(d: StoreToday, tables: RestaurantTable[], now: number): StyleToday | null {
  if (!d.today) return null
  const summary = summarizeToday(d.today, tables, now)
  const rows = d.today.filter((r) => r.status !== 'cancelled').sort((a, b) => a.starts_at.localeCompare(b.starts_at)).map(restaurantRow)
  const waiting = d.today.filter((r) => r.status === 'pending').length
  const breakdown = [['LINE', summary.line], ['電話', summary.phone], ['他', summary.walkIn + summary.media]] as const
  const kpis: StyleKpi[] = [
    { id: 'today', title: '今日の予約', value: summary.groups, unit: summary.guests === null ? '組・人数を確認できません' : `組・${summary.guests}人`, detail: breakdown.filter(([, n]) => n > 0).map(([l, n]) => `${l} ${n}`).join('・') || 'まだ予約はありません', link: { label: '一覧', href: '/restaurant-test/reservations' }, help: '取消・無断・押さえを除く今日の予約です。来店日で数えます。' },
    { id: 'waiting', title: '対応待ち', value: waiting, unit: '件', detail: `承認 ${waiting}`, link: { label: '内訳', href: '/restaurant-test/reservations' }, help: '承認待ちなど、お店が何かする必要がある予約の数です。' },
    { id: 'free', title: '空席（いま）', value: summary.freeTables, unit: '卓', detail: `全 ${summary.totalTables} 卓`, link: { label: '座席表', href: '/restaurant-test/tables' }, help: '動いている卓のうち、いま予約が重なっていない卓の数です。' },
    { id: 'noshow', title: '無断キャンセル率', value: null, unit: '%', detail: '過去30日', link: null, help: '無断キャンセル ÷（予約 − 取消 − 押さえ）。過去30日に始まった予約で数えます。' },
    { id: 'new', title: '新着予約', value: null, unit: '件', detail: '今日入った予約', link: null, help: '予約が入った日で数えます。来店日で数えるほかの数とは別です。' },
  ]
  return {
    style: 'restaurant',
    asOf: (d.updatedAt ?? new Date()).toISOString(),
    staff: tables.map((t) => ({ id: t.id, name: t.code })),
    kpis,
    alert: restaurantAlert(d),
    rows,
    rowsNote: `${formatNumber(rows.length)}件中 1〜${formatNumber(rows.length)}件`,
    side: [],
  }
}
