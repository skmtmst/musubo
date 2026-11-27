// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import KpiCard from '@/components/shared/kpi-card'
import type { RestaurantReservation, RestaurantTable } from '@/lib/restaurant-test-api'
import { restaurantToday } from '@/v8/style-dashboard/restaurant-today'
import { reservation, tables } from '../booking-kit/test-data'
import { reasonText, slotTitle, summarizeToday } from './summarize'

afterEach(cleanup)

const makeRow = (id: string, over: Record<string, unknown>) =>
  reservation(id, { starts_at: '2026-10-10T18:00:00+09:00', ends_at: '2026-10-10T20:00:00+09:00', ...over }) as unknown as RestaurantReservation

describe('restaurant/dashboard/summarize の未確定集計・不正日時ガード', () => {
  it('不明な人数・読めない開始時刻・不明なカウンター席数が混ざったときは 0 で補わず未確定（null）にする', () => {
    const now = Date.parse('2026-10-10T12:00:00+09:00')
    const validTables = tables as unknown as RestaurantTable[]

    // 人数不明が混ざる場合：合計人数・ピークを少ない確定値にしない
    const withUnknownGuests = summarizeToday(
      [
        makeRow('ok', { source: 'line', guest_count: 4, starts_at: '2026-10-10T19:00:00+09:00' }),
        makeRow('bad-guests', { source: 'phone', guest_count: Number.NaN, starts_at: '2026-10-10T18:00:00+09:00' }),
      ],
      validTables,
      now,
    )
    expect(withUnknownGuests.groups).toBe(2)
    expect(withUnknownGuests.guests).toBeNull()
    expect(withUnknownGuests.peak).toBeNull()

    // 開始時刻が読めない予約が混ざる場合：黙って外して別時刻をピークにしない
    const withUnknownTime = summarizeToday(
      [
        makeRow('ok', { source: 'line', guest_count: 3, starts_at: '2026-10-10T19:00:00+09:00' }),
        makeRow('bad-time', { source: 'phone', guest_count: 6, starts_at: 'not-a-date', ends_at: 'not-a-date' }),
      ],
      validTables,
      now,
    )
    expect(withUnknownTime.guests).toBe(9)
    expect(withUnknownTime.peak).toBeNull()

    // カウンター卓の定員が不明な場合：0席として少ない合計を出さない
    const brokenTables: RestaurantTable[] = [
      ...validTables,
      { ...validTables[0], id: 'bad-cap', seat_type: 'counter', max_capacity: Number.NaN, is_active: true },
    ]
    const withUnknownCap = summarizeToday(
      [makeRow('ok', { source: 'line', guest_count: 3, starts_at: '2026-10-10T19:00:00+09:00' })],
      brokenTables,
      now,
    )
    expect(withUnknownCap.counterSeats).toBeNull()
  })

  it('画面のKPI表示で不明な人数が混ざったときに少ない確定人数や NaN を出さず未確定と表示する', () => {
    const now = Date.parse('2026-10-10T12:00:00+09:00')
    const todayRows = [
      makeRow('ok', { source: 'line', guest_count: 4, starts_at: '2026-10-10T19:00:00+09:00' }),
      makeRow('bad-guests', { source: 'phone', guest_count: Number.NaN, starts_at: '2026-10-10T18:00:00+09:00' }),
    ]
    const model = restaurantToday(
      { today: todayRows, closeTasks: [], media: [], updatedAt: new Date(now) } as unknown as Parameters<typeof restaurantToday>[0],
      tables as unknown as RestaurantTable[],
      now,
    )!
    const todayKpi = model.kpis.find((kpi) => kpi.id === 'today')!
    render(<KpiCard presentation="band" title={todayKpi.title} value={todayKpi.value} unit={todayKpi.unit} detail={todayKpi.detail} />)

    expect(screen.getByText('組・人数を確認できません')).toBeTruthy()
    expect(screen.queryByText(/組・4人/)).toBeNull()
    expect(screen.queryByText(/NaN/)).toBeNull()
  })

  it('slotTitle と reasonText は読めない日時・非有限の残り席数で未確定の案内を返す', () => {
    expect(slotTitle('invalid-iso')).toBe('日時を確認できません')
    expect(slotTitle('')).toBe('日時を確認できません')
    expect(slotTitle('2026-10-10T10:00:00Z')).toBe('10/10（土）19:00')

    expect(reasonText({ reason: 'limited', remainingSeats: Number.NaN })).toBe('残り席数を確認できません')
    expect(reasonText({ reason: 'limited', remainingSeats: Number.POSITIVE_INFINITY })).toBe('残り席数を確認できません')
    expect(reasonText({ reason: 'limited', remainingSeats: null })).toBe('LINE・電話で予約が入りました')
    expect(reasonText({ reason: 'limited', remainingSeats: 2 })).toBe('残り 2席になりました')
  })
})
