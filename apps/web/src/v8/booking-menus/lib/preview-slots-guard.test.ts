import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BookingAvailabilitySlot } from '@/lib/api'
import { mergeStaffSlots } from './preview-slots'

const makeSlot = (date: string, start: string, remaining: number): BookingAvailabilitySlot =>
  ({ date, start, end: start, capacity: 2, remaining, state: remaining > 0 ? 'limited' : 'full' }) as BookingAvailabilitySlot

describe('mergeStaffSlots の不正データ保護', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('壊れた担当配列・枠要素を飛ばして落ちずにまとめる', () => {
    const broken = [
      null,
      { slots: null },
      { slots: [null, { date: '', start: '10:00', remaining: 1 }, { date: '2026-10-02', start: 123, remaining: 1 }] },
      { slots: [makeSlot('2026-10-02', '10:00', 2)] },
    ] as unknown as Array<{ slots?: BookingAvailabilitySlot[] }>

    expect(mergeStaffSlots(null as unknown as Array<{ slots?: BookingAvailabilitySlot[] }>)).toEqual([])
    const merged = mergeStaffSlots(broken)
    expect(merged.map((s) => `${s.date} ${s.start} ${s.remaining}`)).toEqual(['2026-10-02 10:00 2'])
  })

  it('残数が NaN の枠より正常な空き枠を優先し、Infinity で上書きしない', () => {
    const merged = mergeStaffSlots([
      { slots: [makeSlot('2026-10-02', '11:00', Number.NaN), makeSlot('2026-10-02', '12:00', 1)] },
      { slots: [makeSlot('2026-10-02', '11:00', 2), makeSlot('2026-10-02', '12:00', Number.POSITIVE_INFINITY)] },
    ])

    expect(merged.map((s) => `${s.date} ${s.start} ${s.remaining}`)).toEqual([
      '2026-10-02 11:00 2',
      '2026-10-02 12:00 1',
    ])
  })
})
