import { jstCalendar as japanCalendar } from '@/lib/jst-datetime'
/**
 * 毎週の曜日と対象の友だちの持ち方（R21・R22）。
 *
 * 画面（`page.tsx`）と試験の両方から使う純粋関数だけを置く。
 * 保存・通信・表示は持たない。
 */
/**
 * 毎週の曜日（0=日〜6=土）の札。G-1：数字を打たせず7つの札から選ぶ。
 * 並びは月始まり（月〜日）で、値は JS の曜日番号のまま持つ。
 */
export const WEEKDAY_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 1, label: '月' },
  { value: 2, label: '火' },
  { value: 3, label: '水' },
  { value: 4, label: '木' },
  { value: 5, label: '金' },
  { value: 6, label: '土' },
  { value: 0, label: '日' },
]

/** 曜日番号（0=日）→ 1文字の名前。 */
export const WEEKDAY_SHORT: ReadonlyArray<string> = ['日', '月', '火', '水', '木', '金', '土']

/** 対象の友だちは1回の保存で100人まで（Worker の検証と同じ上限）。 */
export const FRIEND_SELECT_LIMIT = 100

/**
 * 画面の曜日の持ち方を、保存で送る形へ直す（R21）。
 *
 * **空の要素を数字にしない。** 以前は `String(...).split(',').map(Number)` で
 * `"1,3,"` を `[1,3,0]`（`Number("") === 0`）へ変え、日曜にも動く下書きを
 * 保存できていた。空文字は数値化の前に捨て、0〜6の整数だけを小さい順に
 * 並べる。古い控えの文字列（`"1,3"`）も同じ結果になる。
 */
export const normalizeWeekdays = (value: unknown): number[] => {
  const items: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : typeof value === 'number'
        ? [value]
        : []
  const days: number[] = []
  for (const item of items) {
    if (typeof item === 'number') {
      if (Number.isInteger(item) && item >= 0 && item <= 6) days.push(item)
      continue
    }
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (!/^\d+$/.test(text)) continue
    const day = Number(text)
    if (Number.isInteger(day) && day >= 0 && day <= 6) days.push(day)
  }
  return [...new Set(days)].sort((a, b) => a - b)
}

/**
 * 対象の友だちの持ち方を、保存で送る形へ直す（R22）。
 * 空の要素は捨て、重複は1つにし、上限100人で切る。
 */
export const normalizeFriendIds = (value: unknown): string[] => {
  const items: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : []
  const ids: string[] = []
  for (const item of items) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids.slice(0, FRIEND_SELECT_LIMIT)
}

const FORBIDDEN_NAME_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** 画面に置いた友だちの名前の一覧。保存には送らない（表示専用）。 */
export const friendNamesOf = (triggerConfig: Record<string, unknown>): Record<string, string> => {
  if (!triggerConfig || typeof triggerConfig !== 'object' || Array.isArray(triggerConfig)) return {}
  const names = triggerConfig.friendNames
  if (names === null || typeof names !== 'object' || Array.isArray(names)) return {}
  const entries = Object.entries(names as Record<string, unknown>)
    .filter((entry): entry is [string, string] => !FORBIDDEN_NAME_KEYS.has(entry[0]) && typeof entry[1] === 'string')
  return Object.fromEntries(entries)
}

/** 曜日番号の並びを「月・水」のような人の言葉へ直す。 */
export const weekdayNames = (days: ReadonlyArray<number>): string =>
  normalizeWeekdays(days).map((day) => WEEKDAY_SHORT[day] ?? '').filter(Boolean).join('・')

/**
 * 毎週の次に動く日時を「9/28（月）9:00」の形で返す（日本時間）。
 * 曜日か時刻が決まっていなければ null（確かめの文を出さない）。
 */
export const nextWeeklyRunText = (days: ReadonlyArray<number>, time: string): string | null => {
  if (!Array.isArray(days) || typeof time !== 'string') return null
  const validDays = normalizeWeekdays(days)
  if (validDays.length === 0) return null
  const matched = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time)
  if (!matched) return null
  const hour = Number(matched[1])
  const minute = Number(matched[2])
  const now = Date.now()
  // 日本時間の今日の0時（UTCの軸で計算する）。
  const jstNow = japanCalendar(new Date(now))
  const jstMidnight = Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate())
  for (let offset = 0; offset < 8; offset += 1) {
    const candidate = new Date(jstMidnight + offset * 24 * 60 * 60 * 1000 + (hour * 60 + minute) * 60 * 1000)
    if (candidate.getTime() <= now + 9 * 60 * 60 * 1000) continue
    if (!validDays.includes(candidate.getUTCDay())) continue
    return `${candidate.getUTCMonth() + 1}/${candidate.getUTCDate()}（${WEEKDAY_SHORT[candidate.getUTCDay()]}）${hour}:${String(minute).padStart(2, '0')}`
  }
  return null
}
