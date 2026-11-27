// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BookingMenu } from '@/lib/api'
import {
  addonCandidates,
  CustomerBookingCard,
  readCustomerBooking,
  recurringError,
  useMenuCustomerBooking,
} from './customer-booking'

function makeMenu(over: Record<string, unknown> = {}): BookingMenu {
  return {
    id: 'm1',
    name: 'カット',
    category_label: null,
    description: null,
    duration_minutes: 60,
    base_price: 3000,
    price_mode: 'fixed',
    concurrent_capacity: 1,
    buffer_after_minutes: 0,
    booking_window_days: null,
    cutoff_hours_before: null,
    cancel_deadline_hours_before: null,
    intake_question: null,
    auto_tag_id: null,
    is_active: 1,
    sort_order: 1,
    version: 1,
    ...over,
  } as BookingMenu
}

beforeEach(() => {
  vi.resetAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('booking-menus/customer-booking ガード', () => {
  it('繰り返しを不正な値にした後にオフへ戻しても、API 契約に合う有効値で送り保存後に未保存が残らない', () => {
    const { result } = renderHook(() => useMenuCustomerBooking(true))
    act(() => {
      result.current.load(
        makeMenu({
          customer_recurring_enabled: 1,
          recurring_freqs_json: '["weekly"]',
          recurring_max_count: 6,
        }),
      )
    })
    act(() => {
      result.current.setRecurring({ freqs: [], maxCount: '99' })
    })
    expect(result.current.error).toBe('選べる間隔を1つ以上選んでください。')
    act(() => {
      result.current.setRecurring({ enabled: false })
    })
    expect(result.current.error).toBeNull()
    expect(result.current.body()).toEqual({
      recurring: { enabled: false, freqs: ['weekly'], maxCount: 6 },
    })
    act(() => {
      result.current.markSaved()
    })
    expect(result.current.dirty).toBe(false)
    expect(result.current.body()).toEqual({})
  })

  it('追加専用に切り替えたら隠れた繰り返し入力の不備で保存を止めず、addonOnly だけを送る', () => {
    const { result } = renderHook(() => useMenuCustomerBooking(true))
    act(() => {
      result.current.setRecurring({ enabled: true, freqs: [], maxCount: '99' })
      result.current.setMaxPartySize(3)
    })
    expect(result.current.error).not.toBeNull()
    act(() => {
      result.current.setAddonOnly(true)
    })
    expect(result.current.error).toBeNull()
    expect(result.current.body()).toEqual({ addonOnly: true })
  })

  it('非整数・範囲外の保存値や NaN/Infinity を安全に正規化し、候補や表示に壊れた数値を出さない', () => {
    expect(recurringError({ enabled: true, freqs: ['weekly'], maxCount: '1e1' })).not.toBeNull()
    expect(recurringError({ enabled: true, freqs: ['weekly'], maxCount: '2.0' })).not.toBeNull()

    const loaded = readCustomerBooking(
      makeMenu({
        customer_recurring_enabled: 1,
        recurring_freqs_json: '["weekly","weekly"]',
        recurring_max_count: Number.NaN,
        max_party_size: 2.5,
        addon_menu_ids_json: '["spa","spa"]',
      }),
    )
    expect(loaded.recurring).toEqual({ enabled: true, freqs: ['weekly'], maxCount: '12' })
    expect(loaded.maxPartySize).toBe(1)
    expect(loaded.addonMenuIds).toEqual(['spa'])

    const { result } = renderHook(() => useMenuCustomerBooking(true))
    act(() => {
      result.current.setMaxPartySize(Number.NaN)
      result.current.setMaxPartySize(99)
    })
    expect(result.current.values.maxPartySize).toBe(1)

    const menus = [
      makeMenu({ id: 'inf', name: '壊れた料金', base_price: Number.POSITIVE_INFINITY, duration_minutes: 30 }),
      makeMenu({ id: 'spa', name: 'ヘッドスパ', base_price: 1500, duration_minutes: Number.NaN }),
    ]
    expect(addonCandidates(menus, 'm1').map((item) => item.id)).toEqual(['spa'])

    function Harness() {
      const state = useMenuCustomerBooking(false)
      return <CustomerBookingCard state={state} menus={menus} selfId="m1" readOnly={false} />
    }
    render(<Harness />)
    expect(screen.queryByText(/NaN/)).toBeNull()
  })
})
