import { displayRange } from '@/lib/display-range'
import { HOURS_SERVICE_LABELS, hoursWeekday, effectiveOpeningDate, type HoursWorkspace, type HoursServiceKind, type HoursService, type OpeningPeriod } from '@line-crm/shared'
import type { GoogleProfileData } from '@/lib/restaurant-google-api'
import { WEEKDAY_JA } from './format'

export function hoursText(periods: OpeningPeriod[], closed = '休業'): string {
  return periods.length ? periods.map(p => displayRange(p.open, p.close === '00:00' ? '翌0:00' : p.close < p.open ? `翌${p.close}` : p.close)).join(' / ') : closed
}
export function hoursHolidayRangeNote(start: string, end: string): string {
  const from = `${Number(start.slice(5, 7))}/${Number(start.slice(8))}`
  const to = start.slice(0, 7) === end.slice(0, 7) ? String(Number(end.slice(8))) : `${Number(end.slice(5, 7))}/${Number(end.slice(8))}`
  return `${displayRange(from, to)}の連休`
}
export function dateLabel(date: string, today: string, holiday = false): string {
  const [year, month, day] = date.split('-').map(Number)
  return `${String(year) !== today.slice(0, 4) ? `${year}/` : ''}${month}/${day}（${WEEKDAY_JA[hoursWeekday(date)]}${holiday ? '・祝' : ''}）`
}
export function serviceKind(id: string, label = ''): HoursServiceKind {
  const s = `${id} ${label}`.toLowerCase().replace(/[_ -]/g, '')
  if (/lunch|ランチ/.test(s)) return 'lunch'
  if (/dinner|ディナー/.test(s)) return 'dinner'
  if (/takeout|pickup|テイクアウト|持ち帰り/.test(s)) return 'takeout'
  if (/happy|ハッピー/.test(s)) return 'happy_hour'
  if (/cafe|coffee|カフェ/.test(s)) return 'cafe'
  return 'other'
}
export function googleTypeFor(kind: HoursServiceKind, types: Array<{ id: string; label: string }>): string | null {
  return types.find(t => serviceKind(t.id, t.label) === kind && kind !== 'other')?.id ?? null
}
export function importServices(data: GoogleProfileData): HoursService[] {
  return (data.profile.moreHours ?? []).map(h => {
    const type = data.profile.moreHoursTypes?.find(t => t.id === h.hoursTypeId)
    const kind = serviceKind(h.hoursTypeId, type?.label)
    const weekdays = (Object.keys(h.weekly) as Array<keyof typeof h.weekly>).filter(d => h.weekly[d].length)
    return { id: h.hoursTypeId, kind, label: type?.label ?? HOURS_SERVICE_LABELS[kind], googleTypeId: h.hoursTypeId, sameWeekdays: false, weekdays, periods: h.weekly[weekdays[0]] ?? [], orderDeadline: '', menu: '' }
  })
}
export function workspaceDay(date: string, data: GoogleProfileData, workspace: HoursWorkspace, holidays: Array<{ date: string }>) {
  const weekly = workspace.draft.weekly ?? data.profile.regularHours
  const draft = workspace.draft.days.find(d => d.date === date)
  const special = [...data.profile.specialHours.filter(s => (s.date !== date || !draft?.remove) && !((workspace.draft.holidayChanged || workspace.draft.weekly) && workspace.holidayManagedDates?.includes(s.date))), ...workspace.draft.days.filter(d => !d.remove)]
  if (draft && !draft.remove) return draft
  return effectiveOpeningDate(date, weekly, special, workspace.holiday, holidays.some(h => h.date === date))
}
export function hasHoursDraft(w: HoursWorkspace): boolean {
  return Boolean(w.draft.weekly || w.draft.days.length || w.draft.holidayChanged || w.draft.serviceIds.length || w.draft.reviewIds.length)
}

export function hoursHistoryStamp(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat('ja-JP', { month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZone }).format(new Date(value));
}

export function hoursLongDateLabel(date:string, holiday=false):string {
 return `${Number(date.slice(5,7))}月${Number(date.slice(8))}日（${WEEKDAY_JA[hoursWeekday(date)]}${holiday?'・祝':''}）`;
}
