import { describe, expect, it } from 'vitest'
import type { RestaurantTable } from '@/lib/restaurant-test-api'
import { tables } from '../booking-kit/test-data'
import { freeTables, openTimes, slotLabel, tableNote } from './slots'

describe('restaurant/front-desk/slots の不正営業時間・不正数値ガード', () => {
  it('openTimes は壊れた営業時刻を 00:00 に丸めて予約枠を作らない', () => {
    const day = '2026-10-11'
    const now = new Date('2026-10-10T12:00:00+09:00')
    const malformed = [
      { weekday: 0, periods: [{ opensAt: '', closesAt: '22:00' }, { opensAt: 'bad', closesAt: '22:00' }, { opensAt: '25:00', closesAt: '26:00' }] },
    ]
    expect(openTimes(day, malformed, now)).toEqual([])

    const mixed = [
      { weekday: 0, periods: [{ opensAt: '', closesAt: '22:00' }, { opensAt: '18:00', closesAt: '21:00' }] },
    ]
    expect(openTimes(day, mixed, now)).toEqual(['18:00', '18:30', '19:00'])
  })

  it('slotLabel・freeTables・tableNote は非有限や0以下の値で壊れた文字や誤候補を出さない', () => {
    expect(slotLabel(Number.NaN)).toBe('—')
    expect(slotLabel(-30)).toBe('—')
    expect(slotLabel(18 * 60 + 30)).toBe('18:30')

    const withZeroMin: RestaurantTable[] = [
      { ...(tables[0] as unknown as RestaurantTable), id: 'z', min_capacity: 0, max_capacity: 4, is_active: true },
    ]
    const validStart = Date.parse('2026-10-10T19:00:00+09:00')
    expect(freeTables(withZeroMin, 0, validStart, [])).toEqual([])
    expect(freeTables(withZeroMin, Number.NaN, validStart, [])).toEqual([])
    expect(freeTables(withZeroMin, 2, Number.NaN, [])).toEqual([])

    const brokenTable = { ...(tables[0] as unknown as RestaurantTable), code: 'T1', label: '   ', max_capacity: Number.NaN, seat_type: 'table' as const }
    expect(tableNote(brokenTable)).toBe('座席')
    const trimmedLabel = { ...(tables[0] as unknown as RestaurantTable), code: 'T1', label: '  ', max_capacity: 4, seat_type: 'table' as const }
    expect(tableNote(trimmedLabel)).toBe('4名席')
  })
})
