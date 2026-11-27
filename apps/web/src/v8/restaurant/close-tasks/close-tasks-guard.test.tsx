// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const routerPush = vi.hoisted(() => vi.fn())
const fetchApi = vi.hoisted(() => vi.fn())
const fx = vi.hoisted(() => ({
  role: 'owner',
  listStores: vi.fn(),
  storeContext: vi.fn(),
  channelCloseTasks: vi.fn(),
  mediaLinks: vi.fn(),
  completeChannelCloseTask: vi.fn(),
}))

vi.mock('@/lib/api', async (original) => ({ ...await original<typeof import('@/lib/api')>(), fetchApi }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: fx }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'acct-1', accounts: [] }) }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/restaurant-test/close-tasks',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => fx.role, canManageRole: () => fx.role === 'owner' }))
vi.mock('@/components/shared/toast', () => ({ notifySaved: vi.fn(), notifyToast: vi.fn(), notifyError: vi.fn() }))

import CloseTasksPage from './close-tasks'

beforeEach(() => {
  vi.clearAllMocks()
  fx.role = 'owner'
  window.history.replaceState({}, '', '/restaurant-test/close-tasks')
  fx.listStores.mockResolvedValue({ data: { stores: [{ id: 'store-1', line_account_id: 'acct-1', status: 'active' }] } })
  fx.storeContext.mockResolvedValue({ data: { selectedStore: { id: 'store-1' } } })
  fetchApi.mockResolvedValue({
    success: true,
    data: [{ code: 'tabelog', name: '食べログ', receiveMethod: 'scrape', adminUrl: 'javascript:alert(1)' }],
  })
  fx.mediaLinks.mockResolvedValue({ data: [] })
  fx.channelCloseTasks.mockResolvedValue({
    data: [
      {
        id: 'task-jst',
        slotId: 'slot-jst',
        startsAt: '2026-11-27T16:30:00Z',
        channel: 'tabelog',
        status: 'close',
        reason: 'full',
        remainingSeats: 0,
      },
      {
        id: 'task-2',
        slotId: 'slot-2',
        startsAt: '2026-11-28T10:00:00Z',
        channel: 'hotpepper',
        status: 'close',
        reason: 'low_seats',
        remainingSeats: 2,
      },
    ],
  })
})

afterEach(cleanup)

describe('CloseTasksPage 日本時間リンク・URL安全化・多重実行防止', () => {
  it('UTCで前日になる深夜枠でも予約台帳リンクを日本時間の日付にする', async () => {
    render(<CloseTasksPage />)
    await screen.findByText('11/28（土）01:30')

    // 危険な javascript: 管理画面 URL はリンクとして描画しない
    expect(screen.queryByRole('link', { name: '管理画面を開く' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '11/28（土）01:30の操作' }))
    const ledgerItem = await screen.findByRole('menuitem', { name: '予約台帳でこの日を見る' })
    expect(ledgerItem.getAttribute('href')).toBe('/restaurant-test/reservations?date=2026-11-28')
  })

  it('1件を閉じている間は別行の閉じた操作を同時送信できない', async () => {
    let resolveFirst: (() => void) | null = null
    fx.completeChannelCloseTask.mockImplementation(
      () => new Promise<void>((resolve) => { resolveFirst = resolve }),
    )

    render(<CloseTasksPage />)
    const firstBtn = await screen.findByRole('button', { name: '食べログの枠を閉じた' }) as HTMLButtonElement
    const secondBtn = screen.getByRole('button', { name: 'hotpepperの枠を閉じた' }) as HTMLButtonElement

    fireEvent.click(firstBtn)
    await waitFor(() => expect(fx.completeChannelCloseTask).toHaveBeenCalledTimes(1))
    expect(secondBtn.disabled).toBe(true)

    fireEvent.click(secondBtn)
    expect(fx.completeChannelCloseTask).toHaveBeenCalledTimes(1)

    resolveFirst?.()
    await waitFor(() => expect(secondBtn.disabled).toBe(false))
  })
})
