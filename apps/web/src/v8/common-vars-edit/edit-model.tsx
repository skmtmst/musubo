'use client'

import { jstCalendar as japanCalendar } from '@/lib/jst-datetime'
import { requiredText } from '@/lib/form-requirement'
import { formatDate as polishFormatDate } from '@/lib/format'
import { jstDate } from '@/lib/jst-datetime'


export const b244Requirements = {
  changeReason: requiredText("変える理由を入力してください"),
  draft_date: requiredText("開始日を入れてください"),
}

/** 履歴の日時（ISO）を日本時間の「9/01 10:00」の形にする。 */
export function historyStamp(value: string): string {
  return polishFormatDate(value, { style: 'list', fallback: '—' })
}

/** 「いま」より前は予約できない。入れた瞬間に当たって、予約に見えない。 */
export function jstNowLocalInput(): { date: string; time: string } {
  const now = new Date()
  const jst = japanCalendar(now).toISOString()
  return { date: jstDate(now), time: jst.slice(11, 16) }
}

function parseUtcTimestamp(value: string | null | undefined): Date | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const normalized =
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(trimmed) && !/Z$|[+-]\d{2}:?\d{2}$/i.test(trimmed)
      ? `${trimmed.replace(' ', 'T')}Z`
      : trimmed
  const parsed = new Date(normalized)
  return Number.isFinite(parsed.getTime()) ? parsed : null
}

export function utcToJstLocalInput(value: string | null): string {
  const parsed = parseUtcTimestamp(value)
  if (!parsed) return ''
  const jst = japanCalendar(parsed)
  const year = jst.getUTCFullYear()
  if (year < 1 || year > 9999) return ''
  const pad2 = (n: number) => String(n).padStart(2, '0')
  return `${String(year).padStart(4, '0')}-${pad2(jst.getUTCMonth() + 1)}-${pad2(jst.getUTCDate())}T${pad2(jst.getUTCHours())}:${pad2(jst.getUTCMinutes())}`
}

/** 競合の帯の時刻。「14:02」の形（板 ）。 */
export function formatHourMinute(value: string): string | null {
  const parsed = parseUtcTimestamp(value)
  if (!parsed) return null
  const jst = japanCalendar(parsed)
  return `${String(jst.getUTCHours()).padStart(2, '0')}:${String(jst.getUTCMinutes()).padStart(2, '0')}`
}


/** 札の色。配信予約中は金、止めた・下書きは灰、期限切れは黄。 */
export function usageTone(status: string): 'warning' | 'neutral' | 'info' {
  if (typeof status !== 'string') return 'info'
  if (/配信予約中|配信中/.test(status)) return 'warning'
  if (/停止中|止めた|下書き/.test(status)) return 'neutral'
  return 'info'
}
