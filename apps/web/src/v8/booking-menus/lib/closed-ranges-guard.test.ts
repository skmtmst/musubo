import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BookingException } from '@/lib/api'
import { closedOn, closedRanges, closedSpan } from './closed-ranges'

const makeClosed = (id: string, dateFrom: string, dateTo?: string): BookingException =>
  ({ id, kind: 'closed', date: dateFrom, dateFrom, dateTo: dateTo ?? dateFrom }) as BookingException

describe('booking-menus/lib/closed-ranges の不正日付・壊れた範囲の保護', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('壊れた dateTo で未来すべてが休業扱いにならず、実在しない日付を除外する', () => {
    const ranges = closedRanges([
      null as unknown as BookingException,
      makeClosed('bad-from', '2026-02-31', '2026-03-02'),
      makeClosed('bad-to', '2026-05-01', 'invalid-date'),
    ])
    expect(ranges).toHaveLength(1)
    expect(ranges[0].from).toBe('2026-05-01')
    expect(ranges[0].to).toBe('2026-05-01')
    expect(closedOn(ranges, '2026-05-01')?.id).toBe('bad-to')
    expect(closedOn(ranges, '2026-05-02')).toBeUndefined()
    expect(closedOn(ranges, 'not-a-date')).toBeUndefined()
    expect(closedSpan(ranges)).toEqual({ from: '2026-05-01', to: '2026-05-01' })
  })
})
