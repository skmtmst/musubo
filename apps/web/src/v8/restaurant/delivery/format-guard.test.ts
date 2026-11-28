import { describe, expect, it } from 'vitest'
import { DASH, formatClock, formatElapsed, formatOrderNumber, storeToday } from './format'

describe('restaurant/delivery/format のオフセットなしUTC・異常値・注文番号ガード', () => {
  it('SQLite 形式のオフセットなし UTC 日時を端末の地域に依存せず日本時間で計算・表示する', () => {
    expect(formatClock('2026-10-09 03:02:00')).toBe('12:02')
    const nowMs = Date.parse('2026-10-09T03:20:00Z')
    expect(formatElapsed('2026-10-09 03:02:00', nowMs)).toBe('18分')
  })

  it('nowMs が NaN や Infinity でも落ちず、不明として扱う', () => {
    expect(formatElapsed('2026-10-09T03:02:00Z', Number.NaN)).toBe(DASH)
    expect(formatElapsed('2026-10-09T03:02:00Z', Number.POSITIVE_INFINITY)).toBe(DASH)
    expect(() => storeToday(Number.NaN)).not.toThrow()
    expect(storeToday(Number.NaN)).toBe('')
    expect(storeToday(Date.parse('2026-10-09T15:30:00Z'))).toBe('2026-10-10')
  })

  it('注文番号の重複した # を1つへそろえ、# だけの空番号は — にする', () => {
    expect(formatOrderNumber('##A102')).toBe('#A102')
    expect(formatOrderNumber('#')).toBe(DASH)
    expect(formatOrderNumber('###  ')).toBe(DASH)
    expect(formatOrderNumber('A102')).toBe('#A102')
  })
})
