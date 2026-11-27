// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BookingAvailabilitySlot, BookingMenu, BookingStaff } from '@/lib/api'
import { PhoneDatetimeStep, PhoneStaffStep, phoneTime, priceLabel } from './phone'

describe('booking-staff/phone ガード', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('不正な料金・所要時間・display_name 欠損で NaN やクラッシュを出さず、読み込み中・失敗時は CTA を無効化する', () => {
    const badMenu = {
      id: 'm-1',
      name: 'カット',
      duration_minutes: Number.NaN,
      base_price: Number.NaN,
      price_mode: 'fixed',
    } as unknown as BookingMenu

    expect(priceLabel(badMenu)).toBe('—')
    expect(phoneTime(null as unknown as string)).toBe('')

    const staff = [{
      id: 's-1',
      name: '高橋',
      display_name: null,
      role: 'スタイリスト',
      nomination_fee: Number.NaN,
      is_active: 1,
      sort_order: 1,
    }] as unknown as BookingStaff[]

    const { rerender } = render(
      <PhoneStaffStep menu={badMenu} staff={staff} designationFree={false} status="loading" />,
    )
    expect(screen.getByText('日時を選ぶ').getAttribute('data-off')).toBe('true')
    expect(screen.queryByText(/NaN/)).toBeNull()

    rerender(<PhoneStaffStep menu={badMenu} staff={staff} designationFree={false} status="ready" />)
    expect(screen.getByText('高橋')).toBeTruthy()
    expect(screen.queryByText(/NaN/)).toBeNull()
  })

  it('不正な日付を含む空き枠でも RangeError で落ちず、空きなし案内へ安全にフォールバックする', () => {
    const badSlots = [{
      date: 'invalid-date',
      start: '10:00',
      end: '10:30',
      timeZone: 'Asia/Tokyo',
      startUtc: 'invalid',
      endUtc: 'invalid',
      capacity: 1,
      remaining: 1,
      state: 'available',
    }] as unknown as BookingAvailabilitySlot[]

    render(
      <PhoneDatetimeStep
        menu={null}
        staffName={null}
        slots={badSlots}
        closedDates={[]}
        closedWeekdays={[]}
        status="ready"
      />,
    )
    expect(screen.getByText('この期間に空きはありません。')).toBeTruthy()
    expect(screen.queryByText(/NaN/)).toBeNull()
  })
})
