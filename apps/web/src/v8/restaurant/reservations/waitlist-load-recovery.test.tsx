// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const fx = vi.hoisted(() => ({
  listSeatWaitlist: vi.fn(),
  cancelSeatWaitlist: vi.fn(),
}))

vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: fx }))

import { ApiError } from '@/lib/api'
import SeatWaitlistDialog from './waitlist'

const entry = {
  id: 'wait-1',
  customer_name: '田中 太郎',
  status: 'waiting',
  starts_at: '2026-10-20T10:00:00+09:00',
  guest_count: 2,
  confirmation_revision: 1,
}

beforeEach(() => {
  vi.resetAllMocks()
  document.documentElement.dataset.theme = 'v8'
})

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.theme
})

describe('席のキャンセル待ちダイアログ：初期読み込み失敗の重複表示解消と再試行ガード', () => {
  it('初回読み込み失敗時は単一のエラー表示にまとめ、403は権限案内を示し、再読み込み連打による重複送信を防ぐ', async () => {
    let resolveRetry!: (value: unknown) => void
    fx.listSeatWaitlist
      .mockRejectedValueOnce(new ApiError(403, 'forbidden'))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve }))

    render(<SeatWaitlistDialog accountId="acc-1" storeId="store-1" onClose={() => {}} />)

    const dialog = await screen.findByRole('dialog', { name: 'キャンセル待ち' })
    await within(dialog).findByText('キャンセル待ちを読み込めませんでした')
    expect(within(dialog).getByText(/オーナーか管理者に頼んでください/)).toBeTruthy()
    // 初期失敗で上段の赤帯（Notice）と下段の ListState が二重に出ないこと
    expect(within(dialog).queryByText('キャンセル待ちを読み込めませんでした。')).toBeNull()

    const retryButton = within(dialog).getByRole('button', { name: 'もう一度読み込む' }) as HTMLButtonElement
    fireEvent.click(retryButton)
    expect(retryButton.disabled).toBe(true)
    fireEvent.click(retryButton)
    expect(fx.listSeatWaitlist).toHaveBeenCalledTimes(2)

    resolveRetry({ data: { waitlist: [entry] } })
    await waitFor(() => expect(within(dialog).getByText(/田中 太郎/)).toBeTruthy())
    expect(within(dialog).queryByText('キャンセル待ちを読み込めませんでした')).toBeNull()
  })
})
