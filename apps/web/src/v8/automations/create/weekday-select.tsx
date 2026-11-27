'use client'

import FilterChip from '@/components/shared/filter-chip'
import { RequiredBadge } from '@/components/shared/form-controls'
import {
  WEEKDAY_OPTIONS,
  nextWeeklyRunText,
  normalizeWeekdays,
  weekdayNames,
} from './trigger-helpers'

/**
 * 動かす曜日の札（R21・設計G-1）。
 *
 * 数字を打たせず、月〜日の7つの札から選ぶ。選んだ札は共通の FilterChip の
 * 「有効状態」（濃い緑）で出し、押す・Tab＋Space で切り替える。
 * 1つも選ばないと保存できない。下には人の言葉の確かめを出す。
 */
export function WeekdaySelect({
  value,
  time,
  onChange,
  error,
}: {
  value: ReadonlyArray<number>
  time: string
  onChange: (days: number[]) => void
  error?: string
}) {
  const days = normalizeWeekdays(Array.isArray(value) ? value : [])
  const trimmedTime = typeof time === 'string' ? time.trim() : ''
  const next = nextWeeklyRunText(days, trimmedTime)
  const names = weekdayNames(days)
  const toggle = (day: number) => {
    onChange(days.includes(day) ? days.filter((item) => item !== day) : [...days, day].sort((a, b) => a - b))
  }
  return (
    <div>
      <p id="au-weekdays-label" className="text-xs font-medium text-ink">
        動かす曜日<RequiredBadge />
      </p>
      <div id="au-weekday-first" tabIndex={-1} role="group" aria-labelledby="au-weekdays-label" aria-describedby={error ? 'au-weekdays-error' : undefined} aria-invalid={Boolean(error) || undefined} className={`mt-2 flex flex-wrap gap-2${error ? ' rounded-control border border-danger' : ''}`}>
        {WEEKDAY_OPTIONS.map((option) => (
          <FilterChip
            key={option.value}
            selected={days.includes(option.value)}
            onChange={() => toggle(option.value)}
            title={`${option.label}曜日に動かす`}
          >
            {option.label}
          </FilterChip>
        ))}
      </div>
      {error ? <p id="au-weekdays-error" className="mt-2 text-xs text-danger" role="alert">{error}</p> : null}
      {!error ? <p className="mt-2 text-xs text-ink-secondary" role="status">
        {days.length === 0
          ? '曜日を1つ以上選んでください。'
          : `毎週 ${names} の ${trimmedTime || '時刻未定'}（日本時間）に動きます。${next ? `次は ${next}` : '時刻を選ぶと次の日時が分かります。'}`}
      </p> : null}
    </div>
  )
}
