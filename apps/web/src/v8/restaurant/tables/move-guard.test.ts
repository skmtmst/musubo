import { describe, expect, it } from 'vitest'
import type { RestaurantReservation, RestaurantTable } from '@/lib/restaurant-test-api'
import { at, reservation, tables } from '../booking-kit/test-data'
import { pickMoveTarget, reservationLine } from './move'

describe('restaurant/tables/move の不正人数・空名前ガード', () => {
  it('pickMoveTarget は人数が0以下や非有限の予約を誤って別卓へ移さない', () => {
    const withZeroMin: RestaurantTable[] = [
      { ...(tables[0] as unknown as RestaurantTable), id: 't-zero', min_capacity: 0, max_capacity: 4, is_active: true },
      ...(tables as unknown as RestaurantTable[]),
    ]
    for (const guestCount of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      const bad = reservation('bad', { guest_count: guestCount, starts_at: at(1, 18), ends_at: at(1, 20) }) as unknown as RestaurantReservation
      expect(pickMoveTarget(bad, withZeroMin, [])).toBeNull()
    }

    const ok = reservation('ok', { guest_count: 2, starts_at: at(1, 18), ends_at: at(1, 20) }) as unknown as RestaurantReservation
    expect(pickMoveTarget(ok, tables as unknown as RestaurantTable[], [])?.id).toBe('t1')
  })

  it('reservationLine は空の顧客名や非有限・0以下の人数でも NaN や余分な空白を出さない', () => {
    const bad = {
      starts_at: '2026-10-09T10:00:00.000Z',
      customer_name: '   ',
      guest_count: Number.NaN,
    } as RestaurantReservation
    expect(reservationLine(bad, 'Asia/Tokyo')).toBe('10月9日 19:00 お名前未登録 人数を確認できません')

    const zeroGuests = {
      starts_at: '2026-10-09T10:00:00.000Z',
      customer_name: ' 予約の見本 ',
      guest_count: 0,
    } as RestaurantReservation
    expect(reservationLine(zeroGuests, 'Asia/Tokyo')).toBe('10月9日 19:00 予約の見本 人数を確認できません')

    const valid = {
      starts_at: '2026-10-09T10:00:00.000Z',
      customer_name: '予約の見本',
      guest_count: 4,
    } as RestaurantReservation
    expect(reservationLine(valid, 'Asia/Tokyo')).toBe('10月9日 19:00 予約の見本 4 名')
  })
})
