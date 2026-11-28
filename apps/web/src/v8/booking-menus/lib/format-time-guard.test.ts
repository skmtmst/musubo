import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bookingWindowEnd, breakHours, businessHourSummary, minutesBeforeLabel, openHours } from './format-time'

describe('booking-menus/lib/format-time の異常値・欠損保護', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('minutesBeforeLabel は小数の分を読み替えず null を返す', () => {
    expect(minutesBeforeLabel(90)).toBe('1時間30分前')
    expect(minutesBeforeLabel(90.5)).toBeNull()
    expect(minutesBeforeLabel(Number.NaN)).toBeNull()
    expect(minutesBeforeLabel(Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('businessHourSummary・openHours・breakHours は壊れた配列要素や重複曜日で落ちず整形する', () => {
    expect(openHours([null as unknown as { start: string; end: string }, { start: '09:00', end: '18:00' }])).toBe('9:00 〜 18:00')
    expect(breakHours(null as unknown as Array<{ start: string; end: string }>)).toBe('—')
    const summary = businessHourSummary([
      null as unknown as { weekday: number; intervals: Array<{ start: string; end: string }> },
      { weekday: 1, intervals: [{ start: '09:00', end: '18:00' }] },
      { weekday: 1, intervals: [{ start: '10:00', end: '17:00' }] },
      { weekday: 2, intervals: null as unknown as Array<{ start: string; end: string }> },
    ])
    expect(summary.detail).toBe('月')
    expect(bookingWindowEnd(Number.NaN)).toBe('—')
    expect(bookingWindowEnd(3, new Date('invalid'))).toBe('—')
  })
})
