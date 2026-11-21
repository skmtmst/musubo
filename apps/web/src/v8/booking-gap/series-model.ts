import type { RecurrenceFrequency as SeriesFreq, SeriesOccurrence } from '@line-crm/shared'

/** 繰り返しの予約の言葉と並べ方（言葉の表：繰り返す・毎週・隔週・毎月第 N 曜・飛ばす。「シリーズ」「定期」は使わない）。 */
export const FREQ_OPTIONS: { value: SeriesFreq; label: string }[] = [
  { value: 'weekly', label: '毎週' },
  { value: 'biweekly', label: '隔週' },
  { value: 'monthly_nth', label: '毎月' },
]
const WEEK = ['日', '月', '火', '水', '木', '金', '土']
/** Booking slots supply the account's IANA zone; older callers retain the Japan default. */
export function seriesTimeZone(value = 'Asia/Tokyo'): string {
  try { return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone }
  catch { return 'Asia/Tokyo' }
}
function calendar(iso: string, timeZone = 'Asia/Tokyo') {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: seriesTimeZone(timeZone), year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso))
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  return { day: n('day'), month: n('month'), hour: n('hour'), minute: n('minute'),
    weekday: new Date(Date.UTC(n('year'), n('month') - 1, n('day'))).getUTCDay() }
}
export const weekdayOf = (iso: string, timeZone?: string) => calendar(iso, timeZone).weekday
export const timeOf = (iso: string, timeZone?: string) => { const d = calendar(iso, timeZone); return `${d.hour}:${String(d.minute).padStart(2, '0')}` }
export const dayOf = (iso: string, timeZone?: string) => { const d = calendar(iso, timeZone); return `${d.month}/${String(d.day).padStart(2, '0')}` }
export const dayWithWeekday = (iso: string, timeZone?: string) => `${dayOf(iso, timeZone)}（${WEEK[weekdayOf(iso, timeZone)]}）`
export const hm = (iso: string, timeZone?: string) => { const d = calendar(iso, timeZone); return `${String(d.hour).padStart(2, '0')}:${String(d.minute).padStart(2, '0')}` }
export const firstDay = dayOf

/** 「毎週金曜 14:00」「隔週金曜 14:00」「毎月第 N 曜」。 */
export function ruleLabel(freq: SeriesFreq, startsAt: string, timeZone?: string): string {
  const wd = `${WEEK[weekdayOf(startsAt, timeZone)]}曜`
  if (freq === 'monthly_nth') return `毎月第 ${Math.floor((calendar(startsAt, timeZone).day - 1) / 7) + 1} ${wd} ${hm(startsAt, timeZone)}`
  return `${freq === 'weekly' ? '毎週' : '隔週'}${wd} ${hm(startsAt, timeZone)}`
}

export type Pick = 'keep' | 'alternative' | 'skip'
export const initialPick = (o: SeriesOccurrence): Pick => (o.available ? 'keep' : o.alternatives.length > 0 ? 'alternative' : 'skip')
/** 作る件数＝取れた回＋「別の時間」を選んだ回（飛ばす回は数えない）。 */
export function createdCount(list: SeriesOccurrence[], picks: Record<number, Pick>): number {
  return list.filter((o) => (o.available ? true : (picks[o.index] ?? 'skip') === 'alternative' && o.alternatives.length > 0)).length
}

/** 口が返す取れない理由の言葉。知らない理由は「空きがありません」。 */
export function reasonText(reason: string | null): string {
  if (reason === 'calendar_unreadable' || reason === 'calendar_unavailable') return '空きを確かめられません'
  return '空きがありません'
}
