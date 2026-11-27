import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BookingSettings } from '@/lib/api'
import { initialBusinessHours, validateBusinessHours } from './hours-validation'
import type { BusinessHoursDay } from './shared'

describe('booking-menus/tabs/hours-validation の欠損・真偽値混入の保護', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('start/end が欠損していても localeCompare で落ちず入力不備を返す', () => {
    const broken = [
      { weekday: 1, intervals: [{ start: undefined, end: '18:00', capacity: 1 }] },
    ] as unknown as BusinessHoursDay[]
    const problem = validateBusinessHours(broken)
    expect(problem?.message).toContain('営業時間')
    expect(problem?.at).toEqual({ weekday: 1, index: 0, parts: ['start', 'end'] })
  })

  it('capacity に真偽値 true や壊れた businessHours 配列があっても誤って通したり落ちたりしない', () => {
    const boolCap = [
      { weekday: 1, intervals: [{ start: '09:00', end: '18:00', capacity: true }] },
    ] as unknown as BusinessHoursDay[]
    expect(validateBusinessHours(boolCap)?.at).toEqual({ weekday: 1, index: 0, parts: ['capacity'] })

    const initialized = initialBusinessHours({ businessHours: null } as unknown as BookingSettings)
    expect(initialized).toHaveLength(7)
    expect(initialized.every((day) => Array.isArray(day.intervals) && day.intervals.length === 0)).toBe(true)
  })
})
