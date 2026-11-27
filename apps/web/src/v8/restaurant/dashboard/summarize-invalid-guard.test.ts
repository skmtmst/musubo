import { describe, expect, it } from 'vitest'
import type { RestaurantReservation, RestaurantTable } from '@/lib/restaurant-test-api'
import { reservation, tables } from '../booking-kit/test-data'
import { reasonText, slotTitle, summarizeToday } from './summarize'

const makeRow = (id: string, over: Record<string, unknown>) =>
  reservation(id, { starts_at: '2026-10-10T18:00:00+09:00', ends_at: '2026-10-10T20:00:00+09:00', ...over }) as unknown as RestaurantReservation

describe('restaurant/dashboard/summarize の不正日時・不正人数ガード', () => {
  it('読めない開始時刻や非有限の人数が混ざってもピーク時刻や人数合計に NaN を出さない', () => {
    const rows = [
      makeRow('bad-time', { source: 'line', guest_count: 4, starts_at: 'not-a-date', ends_at: 'not-a-date' }),
      makeRow('bad-guests', { source: 'phone', guest_count: Number.NaN, starts_at: '2026-10-10T19:00:00+09:00' }),
      makeRow('ok', { source: 'line', guest_count: 3, starts_at: '2026-10-10T19:00:00+09:00' }),
    ]
    const brokenTables = [
      ...(tables as unknown as RestaurantTable[]),
      { ...(tables[0] as unknown as RestaurantTable), id: 'bad-cap', seat_type: 'counter', max_capacity: Number.NaN, is_active: true },
    ]
    const summary = summarizeToday(rows, brokenTables, Date.parse('2026-10-10T12:00:00+09:00'))

    expect(summary.guests).toBe(7)
    expect(summary.peak).toEqual({ label: '19:00', guests: 3 })
    expect(Number.isFinite(summary.counterSeats)).toBe(true)
  })

  it('slotTitle と reasonText は読めない日時・非有限の残り席数で NaN や undefined を出さない', () => {
    expect(slotTitle('invalid-iso')).toBe('日時を確認できません')
    expect(slotTitle('')).toBe('日時を確認できません')
    expect(slotTitle('2026-10-10T10:00:00Z')).toBe('10/10（土）19:00')

    expect(reasonText({ reason: 'limited', remainingSeats: Number.NaN })).toBe('LINE・電話で予約が入りました')
    expect(reasonText({ reason: 'limited', remainingSeats: Number.POSITIVE_INFINITY })).toBe('LINE・電話で予約が入りました')
    expect(reasonText({ reason: 'limited', remainingSeats: 2 })).toBe('残り 2席になりました')
  })
})
