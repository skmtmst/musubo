import { ApiError, type BookingSettings } from '@/lib/api'
import { permissionDeniedMessage, describeApiFailure, japaneseDetailOf } from '@/components/shared/api-error-message'
import { DAYS, type BusinessHoursDay } from './shared'
export function initialBusinessHours(settings: BookingSettings): BusinessHoursDay[] {
  const list = Array.isArray(settings?.businessHours) ? settings.businessHours : []
  return DAYS.map(({ weekday }) => {
    const rawIntervals = list.find((day) => day && day.weekday === weekday)?.intervals
    const intervals = Array.isArray(rawIntervals)
      ? rawIntervals
          .filter((interval): interval is BusinessHoursDay['intervals'][number] => Boolean(interval) && typeof interval === 'object')
          .map((interval) => ({ ...interval, capacity: interval.capacity ?? 1 }))
      : []
    return { weekday, intervals }
  })
}

// 管理画面 /booking/staff/shifts の BusinessHoursEditor と同じ検査。
/** 営業時間の誤りと、その欄（曜日・何区間目・どの欄）。欄が無い誤りは場所なし。 */
export type HoursProblem = { message: string; at?: { weekday: number; index: number; parts: Array<'start' | 'end' | 'capacity'> } }

function parseStrictCapacity(raw: unknown): number {
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string' && raw.trim() !== '') return Number(raw)
  return Number.NaN
}

export function validateBusinessHours(days: BusinessHoursDay[]): HoursProblem | null {
  if (!Array.isArray(days)) return { message: '営業時間の入力を確認できませんでした。' }
  const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/
  for (const day of days) {
    if (!day || !Array.isArray(day.intervals)) return { message: '営業時間の入力を確認できませんでした。' }
    if (day.intervals.length > 8) return { message: '1曜日の営業時間は8区間までです。' }
    const at = (interval: BusinessHoursDay['intervals'][number], parts: Array<'start' | 'end' | 'capacity'>) => ({ weekday: day.weekday, index: day.intervals.indexOf(interval), parts })
    for (const interval of day.intervals) {
      if (
        !interval ||
        typeof interval.start !== 'string' ||
        typeof interval.end !== 'string' ||
        !timePattern.test(interval.start) ||
        !timePattern.test(interval.end) ||
        interval.start >= interval.end
      ) {
        return { message: '営業時間は日ごとに分けて入力してください。終了は同じ日の開始より後にし、24:00は使えません。', at: at(interval, ['start', 'end']) }
      }
      const capacity = parseStrictCapacity(interval.capacity)
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1000) {
        return { message: '同時に受け付ける数は1〜1000件で入力してください。', at: at(interval, ['capacity']) }
      }
    }
    const sorted = [...day.intervals].sort((a, b) => a.start.localeCompare(b.start))
    for (let index = 1; index < sorted.length; index += 1) {
      if (sorted[index - 1].end > sorted[index].start) {
        return { message: '同じ曜日の営業時間は重ならないように入力してください。', at: at(sorted[index], ['start']) }
      }
    }
  }
  return null
}

export function businessHoursSaveError(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return 'ほかの担当者が先に保存しました。最新の内容を読み直してから、もう一度変更してください。'
  }
  if (error instanceof ApiError && error.status === 400) return japaneseDetailOf(error) || describeApiFailure(error, '入力内容の確認')
  return '営業時間を保存できませんでした。入力内容を確かめて、もう一度お試しください。'
}

export function resourceSaveError(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return 'ほかの担当者が先にこの設備を変更しました。読み直してからもう一度お試しください。'
  }
  if (error instanceof ApiError && error.status === 403) {
    return permissionDeniedMessage('store')
  }
  return '設備を保存できませんでした。入力内容を確かめて、もう一度お試しください。'
}
