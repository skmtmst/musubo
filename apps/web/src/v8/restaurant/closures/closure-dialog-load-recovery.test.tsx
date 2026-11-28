// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  previewClosure: vi.fn(),
  createClosure: vi.fn(),
  updateClosure: vi.fn(),
}))

vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: fixture }))
vi.mock('@/lib/restaurant-google-api', () => ({ restaurantGoogleApi: { proposeClosureHours: vi.fn() } }))

import ClosureDialog from './closure-dialog'

const TABLES = [
  { id: 't1', store_id: 'store-1', code: 'T1', max_capacity: 4, is_active: 1, min_capacity: 1, table_type: 'table', sort_order: 1 },
] as unknown as import('@/lib/restaurant-test-api').RestaurantTable[]

beforeEach(() => {
  vi.resetAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('臨時休業・貸切ダイアログ：重なる予約の確認失敗とその場再読み込み', () => {
  it('予約確認の取得失敗時に「予約はありません」と偽らずエラー通知を出し、再読み込みの連打を防ぎつつ回復できる', async () => {
    let resolveRetry: ((value: unknown) => void) | null = null
    fixture.previewClosure
      .mockRejectedValueOnce(new Error('予約確認エラー'))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve }))

    render(
      <ClosureDialog
        target={{ mode: 'add', day: '2026-10-20' }}
        accountId="acc-1"
        storeId="store-1"
        timezone="Asia/Tokyo"
        today="2026-10-10"
        tables={TABLES}
        reservations={[]}
        media={[]}
        canGoogle={false}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    )

    const dialog = await screen.findByRole('dialog', { name: '臨時休業・貸切を足す' })
    expect(await within(dialog).findByText(/重なる予約を確認できませんでした/, {}, { timeout: 2000 })).toBeTruthy()
    expect(within(dialog).queryByText('この日の予約はありません。')).toBeNull()

    const retryButton = within(dialog).getByRole('button', { name: 'もう一度読み込む' })
    fireEvent.click(retryButton)
    fireEvent.click(retryButton)
    await waitFor(() => expect(fixture.previewClosure).toHaveBeenCalledTimes(2))

    resolveRetry!({
      data: {
        reservations: [],
        waitlistCount: 0,
        contactedCount: 0,
        conflicts: [],
        confirmationSnapshot: 'snap-ok',
      },
    })

    expect(await within(dialog).findByText('この日の予約はありません。')).toBeTruthy()
    expect(within(dialog).queryByText(/重なる予約を確認できませんでした/)).toBeNull()
  })
})
