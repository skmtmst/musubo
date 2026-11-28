import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bookingMenuBufferError,
  bookingMenuDurationError,
  bookingMenuError,
  type BookingMenuBaseDraft,
} from './menu-validation'

describe('booking-menus/lib/menu-validation の真偽値・配列・null 混入保護', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('真偽値・配列・null が暗黙の数値変換で検証をすり抜けない', () => {
    expect(bookingMenuDurationError(true)).toContain('所要時間')
    expect(bookingMenuDurationError([60])).toContain('所要時間')
    expect(bookingMenuBufferError(false)).toContain('後の空き時間')
    expect(bookingMenuBufferError(null)).toContain('後の空き時間')
    expect(bookingMenuBufferError('')).toBeNull()
    expect(
      bookingMenuError({
        name: '相談',
        durationMinutes: 60,
        bufferAfterMinutes: 0,
        sortOrder: false,
        assignedStaffCount: 1,
      }),
    ).toContain('並び順')
    expect(
      bookingMenuError({
        name: '相談',
        durationMinutes: 60,
        bufferAfterMinutes: 0,
        sortOrder: 0,
        assignedStaffCount: true,
      }),
    ).toContain('担当できる人')
    expect(bookingMenuError(null as unknown as BookingMenuBaseDraft)).toContain('メニュー名')
  })
})
