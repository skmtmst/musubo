// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LedgerMonthNavigation, { monthKey, monthLabel } from './month-navigation'

describe('booking-bookings/month-navigation の実在日付・異常 offset 保護', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('2月31日のような実在しない日付は 3月へ繰り上げず今月へ戻す', () => {
    const todayMonth = monthKey(0)
    expect(monthKey(0, '2026-02-31')).toBe(todayMonth)
    expect(monthKey(Number.NaN, '2026-10-01')).toBe('2026-10')
    expect(monthKey(Number.POSITIVE_INFINITY, '2026-10-01')).toBe('2026-10')
    render(<LedgerMonthNavigation anchor="2026-02-31" onChange={vi.fn()} shareUrl="" historyUrl="" />)
    expect(screen.getByText(monthLabel(todayMonth))).toBeTruthy()
  })

  it('monthLabel は壊れた年月キーで NaN年NaN月 を出さず — を返す', () => {
    expect(monthLabel('2026-05')).toBe('2026年5月')
    expect(monthLabel('invalid')).toBe('—')
    expect(monthLabel('2026-13')).toBe('—')
  })
})
