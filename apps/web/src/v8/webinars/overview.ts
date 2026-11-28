import { Video, Users, CalendarClock, MousePointerClick } from 'lucide-react'
import type { WebinarOverview, WebinarOverviewMetric } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import { emptyValue } from '@/components/shared/empty-value'

export function metricValue(metric: WebinarOverviewMetric | undefined): number | null {
  return metric?.state === 'available' && typeof metric.value === 'number' && Number.isFinite(metric.value) && metric.value >= 0 ? metric.value : null
}

/** 同じ理由は一度だけ、別の理由は指標名と合わせて既存の補足へ出す。 */
function metricReasons(pairs: Array<[string, WebinarOverviewMetric | undefined]>): string {
  const filled = pairs.filter(([, metric]) => metricValue(metric) === null).map(([label, metric]) => [label, metric?.reason ?? '取得できていません'] as const)
  const reasons = [...new Set(filled.map(([, reason]) => reason))]
  const sentence = (text: string) => /[。！？.!?]$/.test(text) ? text : `${text}。`
  return reasons.length === 1 ? sentence(reasons[0]) : filled.map(([label, reason]) => `${label}: ${sentence(reason)}`).join('\n')
}

/*
 * 数の帯の4つ。口にある数だけ（無い数は「—」。0 にしない）。
 * 補足の行も口にある数だけで書く（先月比・フォーム送信は口に無い）。
 */
export function kpiCells(overview: WebinarOverview | null) {
  const m = overview?.metrics
  const active = metricValue(m?.activeWebinars)
  const bookings = metricValue(m?.registrationBookings)
  const rate = metricValue(m?.viewRate)
  const people = metricValue(m?.ctaUniquePeople)
  return [
    {
      key: 'webinars', title: 'ウェビナー', icon: Video, value: metricValue(m?.webinars), unit: '件',
      detail: active === null ? emptyValue('unknown') : `公開中 ${formatNumber(active)}件`, help: `登録済みの件数です。${metricReasons([['ウェビナー数', m?.webinars], ['公開中の数', m?.activeWebinars]])}`,
    },
    {
      key: 'registrations', title: '申込', icon: Users, value: metricValue(m?.registrations), unit: '人',
      detail: bookings === null ? emptyValue('unknown') : `延べ予約 ${formatNumber(bookings)}件`, help: `全期間の申込人数です。同じ人の複数予約は1人に数えます。${metricReasons([['申込人数', m?.registrations], ['延べ予約', m?.registrationBookings]])}`,
    },
    {
      key: 'viewers', title: '視聴', icon: CalendarClock, value: metricValue(m?.viewers), unit: '人',
      detail: rate === null ? emptyValue('unknown') : `申込の ${Math.round(rate * 1000) / 10}%`, help: `視聴開始の人数です。視聴完了は一覧の集計では出していません。${metricReasons([['視聴人数', m?.viewers], ['視聴率', m?.viewRate]])}`,
    },
    {
      key: 'cta', title: '案内ボタンを押した数', icon: MousePointerClick, value: metricValue(m?.ctaTotalClicks), unit: '回',
      detail: people === null ? emptyValue('unknown') : `押した人 ${formatNumber(people)}人`, help: `全期間に案内ボタンが押された延べ回数です。${metricReasons([['案内ボタンを押した数', m?.ctaTotalClicks], ['案内ボタンを押した人', m?.ctaUniquePeople]])}`,
    },
  ]
}
