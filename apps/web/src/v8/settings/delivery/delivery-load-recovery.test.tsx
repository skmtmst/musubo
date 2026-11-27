// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetSessionSnapshot } from '@/lib/session-snapshot'

const fixture = vi.hoisted(() => ({
  connection: vi.fn(),
}))

vi.mock('@/lib/staff-role', () => ({
  useStaffRole: () => 'owner',
  canManageRole: (role: string | null) => role === 'owner' || role === 'admin',
}))
vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'acc-1', accounts: [] }),
}))
vi.mock('@/lib/restaurant-delivery-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/restaurant-delivery-api')>('@/lib/restaurant-delivery-api')
  return {
    ...actual,
    restaurantDeliveryApi: {
      ...actual.restaurantDeliveryApi,
      ubereatsConnection: fixture.connection,
    },
  }
})

import DeliverySettingsPage from './delivery'

const CONNECTED_RESPONSE = {
  success: true,
  store: { id: 'store-1', name: '本店' },
  oauthConfigured: true,
  connection: {
    status: 'connected',
    version: 5,
    storeName: '渋谷店',
    connectedAt: '2026-10-13T02:30:00.000Z',
    provisionedAt: null,
    checkedAt: '2026-10-13T03:00:00.000Z',
    lastError: null,
  },
}

beforeEach(() => {
  vi.resetAllMocks()
  verifiedStaffRole('owner')
  forgetSessionSnapshot()
})

afterEach(() => {
  cleanup()
  verifiedStaffRole(null)
  forgetSessionSnapshot()
})

describe('設定 › デリバリー連携：接続状態の読み込み失敗とその場再読み込み', () => {
  it('読み込み失敗を危険トーンの帯と再読み込みボタンで知らせ、連打で重複送信せず回復できる', async () => {
    let resolveRetry: ((value: typeof CONNECTED_RESPONSE) => void) | null = null
    fixture.connection
      .mockRejectedValueOnce(new Error('通信エラー'))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve }))

    render(<DeliverySettingsPage />)

    const uberCard = screen.getByRole('region', { name: 'Uber Eats' })
    const note = await within(uberCard).findByText(/いまの接続の状態を読み取れませんでした/)
    const notice = note.closest('[data-design-part="notice"]')
    expect(notice?.getAttribute('role')).toBe('alert')

    const retryButton = within(uberCard).getByRole('button', { name: 'もう一度読み込む' })
    fireEvent.click(retryButton)
    fireEvent.click(retryButton)
    expect(fixture.connection).toHaveBeenCalledTimes(2)

    resolveRetry!(CONNECTED_RESPONSE)
    expect(await within(uberCard).findByText('渋谷店')).toBeTruthy()
    expect(within(uberCard).queryByRole('button', { name: 'もう一度読み込む' })).toBeNull()
  })
})
