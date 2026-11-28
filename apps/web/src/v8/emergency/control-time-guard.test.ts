import { beforeEach, describe, expect, it, vi } from 'vitest'
import { formatMonthDay, stopMinutes } from './control-time'

describe('control-time の JST 統一と SQLite UTC 時刻の保護', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('formatMonthDay は端末タイムゾーンに依存せず日本時間の日付を返す', () => {
    // UTC の月末 16:00 は、日本時間では翌月1日の 1:00
    expect(formatMonthDay('2026-06-30T16:00:00Z')).toBe('7/1')
    expect(formatMonthDay('2026-06-30 16:00:00')).toBe('7/1')
    expect(formatMonthDay('2026-07-01T00:30:00+09:00')).toBe('7/1')
    expect(formatMonthDay(null)).toBe('日時不明')
    expect(formatMonthDay('   ')).toBe('日時不明')
    expect(formatMonthDay('invalid')).toBe('日時不明')
    expect(formatMonthDay(123 as unknown as string)).toBe('日時不明')
  })

  it('stopMinutes はオフセットなし SQLite UTC と ISO UTC が混在しても正しい分数を返す', () => {
    expect(stopMinutes('2026-06-30 16:00:00', '2026-06-30T16:30:00Z')).toBe(30)
    expect(stopMinutes('2026-06-30T16:00:00Z', '2026-06-30 16:45:00')).toBe(45)
    expect(stopMinutes('2026-06-30T16:30:00Z', '2026-06-30T16:00:00Z')).toBeNull()
    expect(stopMinutes(null, '2026-06-30T16:30:00Z')).toBeNull()
    expect(stopMinutes(123 as unknown as string, '2026-06-30T16:30:00Z')).toBeNull()
  })
})
