import { jstCalendar } from '@/lib/jst-datetime'

function parseUtcTimestamp(value: string | null | undefined): number {
  if (typeof value !== 'string') return Number.NaN
  const trimmed = value.trim()
  if (!trimmed) return Number.NaN
  // SQLite のオフセットなし時刻は UTC として扱い、端末のタイムゾーンに左右されないようにする（lib/format.ts と整合）。
  const normalized =
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(trimmed) && !/Z$|[+-]\d{2}:?\d{2}$/i.test(trimmed)
      ? `${trimmed.replace(' ', 'T')}Z`
      : trimmed
  return Date.parse(normalized)
}

export function formatMonthDay(value: string | null): string {
  const epoch = parseUtcTimestamp(value)
  if (!Number.isFinite(epoch)) return '日時不明'
  const jst = jstCalendar(new Date(epoch))
  return `${jst.getUTCMonth() + 1}/${jst.getUTCDate()}`
}

export function stopMinutes(start: string | null, end: string | null): number | null {
  const startMs = parseUtcTimestamp(start)
  const endMs = parseUtcTimestamp(end)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null
  const diff = Math.round((endMs - startMs) / 60_000)
  return Number.isFinite(diff) && diff >= 0 ? diff : null
}
