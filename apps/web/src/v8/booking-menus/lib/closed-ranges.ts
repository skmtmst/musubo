/*
 * 休業日（範囲の休み）の日付の扱い（監査 WEB056）。
 *
 * 範囲を日ごとに広げて最大31日で打ち切ると、それより長い休み（年末年始・改装など）の
 * 32日目から先が、カレンダーの印からも「入っている予約」の数からも落ちる。
 * 日付は広げずに、範囲そのもので「その日が休みか」を調べる。
 */
import type { BookingException } from '@/lib/api'

export interface ClosedRange {
  from: string
  to: string
  item: BookingException
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const check = new Date(Date.UTC(y, m - 1, d))
  return check.getUTCFullYear() === y && check.getUTCMonth() + 1 === m && check.getUTCDate() === d
}

/** 休み（kind=closed）の範囲。日付の無いものは除く。from>to は from だけの1日に寄せる。 */
export function closedRanges(exceptions: BookingException[]): ClosedRange[] {
  if (!Array.isArray(exceptions)) return []
  const ranges: ClosedRange[] = []
  for (const item of exceptions) {
    if (!item || typeof item !== 'object' || item.kind !== 'closed') continue
    const fromCandidate = item.dateFrom || item.date || ''
    if (!isValidIsoDate(fromCandidate)) continue
    const rawTo = item.dateTo || item.date || fromCandidate
    const to = isValidIsoDate(rawTo) && rawTo >= fromCandidate ? rawTo : fromCandidate
    ranges.push({ from: fromCandidate, to, item })
  }
  return ranges.sort((a, b) => a.from.localeCompare(b.from))
}

/** その日（YYYY-MM-DD）を休みにしている例外。無ければ undefined。 */
export function closedOn(ranges: ClosedRange[], day: string): BookingException | undefined {
  if (!Array.isArray(ranges) || !isValidIsoDate(day)) return undefined
  return ranges.find(
    (range) =>
      Boolean(range) &&
      isValidIsoDate(range.from) &&
      isValidIsoDate(range.to) &&
      range.from <= day &&
      day <= range.to,
  )?.item
}

/** すべての休みを覆う最初の日と最後の日。休みが無ければ null。 */
export function closedSpan(ranges: ClosedRange[]): { from: string; to: string } | null {
  if (!Array.isArray(ranges)) return null
  let from: string | null = null
  let to: string | null = null
  for (const range of ranges) {
    if (!range || !isValidIsoDate(range.from) || !isValidIsoDate(range.to)) continue
    if (from === null || range.from < from) from = range.from
    if (to === null || range.to > to) to = range.to
  }
  return from !== null && to !== null ? { from, to } : null
}
