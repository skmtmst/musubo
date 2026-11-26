// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const list = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ bookingApi: { listRequests: list } }))

import HolidayBookings from './holiday-bookings'

beforeEach(() => {
  list.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('HolidayBookings の失敗時再読み込み', () => {
  it('既存予約の読み込みに失敗しても窓を閉じずにその場でもう一度読み込める', async () => {
    list
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({
        requests: [{ status: 'confirmed', starts_at: '2026-10-26T02:00:00Z' }],
        total: 1,
      })

    render(<HolidayBookings accountId="a" date="2026-10-26" />)

    await screen.findByText('失敗：既存予約を読み込めませんでした')
    const retry = screen.getByRole('button', { name: 'もう一度読み込む' })
    fireEvent.click(retry)

    await screen.findByText(/既存予約：1件/)
    expect(screen.queryByText('失敗：既存予約を読み込めませんでした')).toBeNull()
    expect(list).toHaveBeenCalledTimes(2)
  })
})
