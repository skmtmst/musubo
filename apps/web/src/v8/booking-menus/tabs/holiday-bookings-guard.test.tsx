// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listRequests = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ bookingApi: { listRequests } }))

import HolidayBookings from './holiday-bookings'

describe('HolidayBookings の実在しない日付と SQLite UTC 保護', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('2026-02-31 のような実在しない日付では API を呼ばず何も表示しない', () => {
    const { container } = render(<HolidayBookings accountId="a" date="2026-02-31" />)
    expect(container.innerHTML).toBe('')
    expect(listRequests).not.toHaveBeenCalled()
  })

  it('オフセットなし SQLite UTC の予約開始時刻を日本時間の日付として正しく数える', async () => {
    // 2026-10-25 15:00 UTC は日本時間で 2026-10-26 00:00
    listRequests.mockResolvedValueOnce({
      requests: [{ status: 'confirmed', starts_at: '2026-10-25 15:00:00' }],
      total: 1,
    })
    render(<HolidayBookings accountId="a" date="2026-10-26" />)
    expect(await screen.findByText(/既存予約：1件/)).toBeTruthy()
  })
})
