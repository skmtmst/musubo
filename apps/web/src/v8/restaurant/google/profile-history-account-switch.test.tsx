// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import { HistoryScreen } from './profile-history'

const mocks = vi.hoisted(() => ({ history: vi.fn() }))
vi.mock('@/lib/restaurant-google-api', () => ({ restaurantGoogleApi: mocks }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())

const makeData = (id: string, summary: string) => ({
  changes: [
    {
      id,
      changeId: `change-${id}`,
      kind: 'profile',
      summary,
      staffName: '担当者',
      status: 'applied' as const,
      error: null,
      createdAt: '2026-11-27T01:00:00Z',
    },
  ],
  total: 1,
  page: 1,
  perPage: 20,
  counts: { all: 1, hours: 0, profile: 1, review_reply: 0 },
})

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Google 変更履歴のアカウント切替時の表示クリア', () => {
  it('アカウントを切り替えた直後に取得が失敗しても、前のアカウントの表や CSV 出力を残さない', async () => {
    const go = vi.fn()
    mocks.history
      .mockResolvedValueOnce(makeData('rec-a', 'A店舗の店名を変更'))
      .mockRejectedValueOnce(new ApiError(500, '履歴の取得に失敗しました'))
      .mockResolvedValueOnce(makeData('rec-b', 'B店舗の営業時間を変更'))

    const { rerender } = render(<HistoryScreen accountId="account-a" go={go} />)

    expect(await screen.findByText('A店舗の店名を変更')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'CSVで書き出す' })).toHaveProperty('disabled', false)

    rerender(<HistoryScreen accountId="account-b" go={go} />)

    expect(await screen.findByText('変更履歴を読み込めませんでした')).toBeTruthy()
    expect(screen.queryByText('A店舗の店名を変更')).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByRole('button', { name: 'CSVで書き出す' })).toHaveProperty('disabled', true)

    fireEvent.click(screen.getByRole('button', { name: /もう一度/ }))
    expect(await screen.findByText('B店舗の営業時間を変更')).toBeTruthy()
    expect(screen.queryByText('A店舗の店名を変更')).toBeNull()
    await waitFor(() => expect(mocks.history).toHaveBeenLastCalledWith('account-b', expect.any(Object)))
  })
})
