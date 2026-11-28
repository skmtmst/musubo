// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BookingAvailabilitySlot, BookingMenu, BookingStaff } from '@/lib/api'
import { LiffPhoneDatetimeStep, LiffPhoneMenuStep, LiffPhoneStaffStep } from './liff-phone'

describe('LiffPhone プレビューガード', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('スタッフ読み込み失敗・読み込み中に「担当できるスタッフはまだいません」を誤併記せず、display_name 欠損や不正料金・所要時間でも壊れない', () => {
    const badMenu = {
      id: 'm-1',
      name: 'カット',
      category_label: null,
      description: null,
      duration_minutes: Number.NaN,
      base_price: Number.NaN,
      price_mode: 'fixed',
      sort_order: 1,
      is_active: 1,
      auto_tag_id: null,
    } as unknown as BookingMenu

    const { rerender } = render(
      <LiffPhoneStaffStep menu={badMenu} staff={[]} designationFree={false} status="error" />,
    )
    expect(screen.getByText('読み込めませんでした。')).toBeTruthy()
    expect(screen.queryByText('担当できるスタッフはまだいません。')).toBeNull()
    expect(screen.queryByText(/NaN/)).toBeNull()

    const staffWithMissingDisplay = [{
      id: 's-1',
      name: '山田',
      display_name: null,
      role: 'スタイリスト',
      nomination_fee: Number.NaN,
      is_active: 1,
      sort_order: 1,
    }] as unknown as BookingStaff[]

    rerender(
      <LiffPhoneStaffStep menu={badMenu} staff={staffWithMissingDisplay} designationFree={false} status="ready" />,
    )
    expect(screen.getByText('山田')).toBeTruthy()
    expect(screen.queryByText(/NaN/)).toBeNull()

    rerender(<LiffPhoneMenuStep menus={[badMenu]} status="ready" />)
    expect(screen.queryByText(/NaN/)).toBeNull()
  })

  it('不正な日付を含む空き枠でも RangeError で落ちず、読み込み中・失敗時は「満」と断定しない', () => {
    const badSlots = [
      {
        date: 'not-a-date',
        start: '10:00',
        end: '10:30',
        timeZone: 'Asia/Tokyo',
        startUtc: 'invalid',
        endUtc: 'invalid',
        capacity: 1,
        remaining: 1,
        state: 'available',
      },
    ] as unknown as BookingAvailabilitySlot[]

    const { rerender } = render(
      <LiffPhoneDatetimeStep
        menu={null}
        staffName={null}
        slots={badSlots}
        closedDates={[]}
        closedWeekdays={[]}
        view="list"
        status="ready"
      />,
    )
    expect(screen.getByText('この期間に空きはありません。')).toBeTruthy()
    expect(screen.queryByText(/NaN/)).toBeNull()

    rerender(
      <LiffPhoneDatetimeStep
        menu={null}
        staffName={null}
        slots={[]}
        closedDates={[]}
        closedWeekdays={[]}
        view="list"
        status="error"
      />,
    )
    expect(screen.getByText('空きを読み込めませんでした。')).toBeTruthy()
    expect(screen.queryAllByText('満')).toHaveLength(0)
  })
})
