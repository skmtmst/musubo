import { STYLE_METRIC_IDS, type StyleSnapshot } from '@line-crm/shared'
import { kpisFor, metricDelta, metricValue } from './adapter'
import type { DashboardRange, IndustryStyle, StyleKpi } from './model'

const LABELS: Record<(typeof STYLE_METRIC_IDS)[number], string> = {
  bookings: '予約', guests: '予約人数', visits: '来店・出席・実施', noShowRate: '無断率', cancelRate: '取消率',
  estimatedRevenue: '見込み売上', nextBookingRate: '次回予約率', secondVisitRate: '2回目の来店率', thirdVisitRate: '3回目の来店率',
  returnRate: '再来率', recall: '呼び戻し待ち', attention: '対応待ち', weekBookings: '今週の予約', resultPending: '結果待ち',
  conversionRate: '成約率', capacity: '定員', freeTables: '空席（いま）', classes: 'クラス', inactiveMembers: '最近来ていない人',
  trialConversion: '体験→入会', attendancePending: '出欠待ち', unseated: '未配席', firstTime: '初めての人', regular: '常連',
  paidAmount: '入金額', pendingCount: '支払い待ち', newBookings: '新着予約', classroomOccupancy: '教室の埋まり',
  onlineOccupancy: 'オンラインの埋まり', unlimitedClasses: '上限なしのクラス', mediaCloseTasks: '媒体の枠を閉じる知らせ', tableUtilization: '卓の稼働率',
}

/** 指標の画面の名前。スタイル体験の見本も同じ名前を使う。 */
export function styleMetricLabel(id: string, style: IndustryStyle) {
  return id === 'visits' ? style === 'consult' ? '実施数' : style === 'lesson' ? '出席数' : '来店数' : Object.hasOwn(LABELS, id) ? LABELS[id as keyof typeof LABELS] : '表示できない項目'
}

export function metricOptions(defaults: StyleKpi[], style: IndustryStyle) {
  const titles = new Map(defaults.map(item => [item.metricId ?? item.id, item.title]))
  return STYLE_METRIC_IDS.map(id => ({ id, label: titles.get(id) ?? styleMetricLabel(id, style) }))
}

/** A saved ordered selection only reads metrics already supplied by the API. */
export function selectedKpis(style: IndustryStyle, snapshot: StyleSnapshot, range: DashboardRange, ids: string[]): StyleKpi[] {
  const defaults = new Map(kpisFor(style, snapshot, range).map(item => [item.metricId ?? item.id, item]))
  return ids.map(id => {
    const existing = defaults.get(id)
    if (existing) return existing
    const metric = Object.hasOwn(snapshot.metrics, id) ? snapshot.metrics[id] : undefined, value = metricValue(metric)
    const label = styleMetricLabel(id, style)
    return {
      id, metricId: id, title: label, value: value.value, valueText: value.valueText, unit: value.unit,
      detail: metric ? value.reason : 'まだ取得できていません',
      help: typeof metric?.formula === 'string' && metric.formula ? metric.formula : 'この項目の集計はまだ取得できていません。',
      delta: metricDelta(metric, snapshot.previous[id], id === 'noShowRate' || id === 'cancelRate'),
    }
  })
}
