import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BookingMenu } from '@/lib/api'
import { addDaysStr, sortedMenus } from './shared'

describe('booking-menus/tabs/shared の日付加算とメニュー並び替え保護', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('addDaysStr は不正日付や非有限日数で RangeError を投げず安全に返す', () => {
    expect(addDaysStr('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDaysStr('2026-02-31', 1)).toBe('')
    expect(addDaysStr('invalid', 1)).toBe('')
    expect(addDaysStr('2026-10-31', Number.NaN)).toBe('2026-10-31')
    expect(addDaysStr('2026-10-31', Number.POSITIVE_INFINITY)).toBe('2026-10-31')
  })

  it('sortedMenus は null 要素・NaN の sort_order・欠損 id があっても落ちずに並べる', () => {
    const sorted = sortedMenus([
      null as unknown as BookingMenu,
      { id: 'nan', sort_order: Number.NaN } as BookingMenu,
      { id: undefined as unknown as string, sort_order: 1 } as BookingMenu,
      { id: 'a', sort_order: 1 } as BookingMenu,
    ])
    expect(sorted.map((m) => m.id ?? '')).toEqual(['', 'a', 'nan'])
    expect(sortedMenus(null as unknown as BookingMenu[])).toEqual([])
  })
})
