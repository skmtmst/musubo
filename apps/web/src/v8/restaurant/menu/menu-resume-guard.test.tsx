// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { snapshotOf } from '../booking-kit/test-data'

const fixture = vi.hoisted(() => ({
  snapshot: vi.fn(),
  storeContext: vi.fn(),
  createMenu: vi.fn(),
  updateMenu: vi.fn(),
  accountId: 'account-1',
}))
const role = vi.hoisted(() => ({ value: 'owner' as string | null }))
const fetchApi = vi.hoisted(() => vi.fn())
const nav = vi.hoisted(() => ({ push: vi.fn(), params: new URLSearchParams() }))

vi.mock('@/components/shared/allergy-field', () => ({ default: () => null }))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: fixture.accountId, accounts: [] }),
}))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: fixture }))
vi.mock('@/lib/staff-role', () => ({
  useStaffRole: () => role.value,
  canManageRole: (r: string | null) => r === 'owner' || r === 'admin',
}))
vi.mock('@/lib/api', async (load) => ({ ...(await load<typeof import('@/lib/api')>()), fetchApi }))
vi.mock('@/components/shell/page-chrome', async (load) => ({
  ...(await load<typeof import('@/components/shell/page-chrome')>()),
  usePageTitle: vi.fn(),
}))
vi.mock('next/navigation', async (load) => ({
  ...(await load<typeof import('next/navigation')>()),
  useRouter: () => ({ push: nav.push, replace: nav.push, back: vi.fn(), prefetch: vi.fn(), refresh: vi.fn(), forward: vi.fn() }),
  useSearchParams: () => nav.params,
  usePathname: () => '/restaurant-test/menu',
}))

import MenuPage from './menu'

beforeEach(() => {
  vi.clearAllMocks()
  fixture.accountId = 'account-1'
  role.value = verifiedStaffRole('owner')
  nav.params = new URLSearchParams()
  fixture.storeContext.mockResolvedValue({ data: { selectedStore: null } })
  fixture.updateMenu.mockResolvedValue({ success: true })
  fetchApi.mockResolvedValue({ success: true })
})

afterEach(() => {
  cleanup()
})

describe('MenuPage のアカウント切替直後の再開ガード', () => {
  it('別アカウントへ切り替えて読み込みが完了する前は、前のアカウントのメニューを再開できない', async () => {
    let finishSecond!: (value: unknown) => void
    fixture.snapshot
      .mockResolvedValueOnce({ data: snapshotOf() })
      .mockImplementationOnce(() => new Promise((resolve) => { finishSecond = resolve }))

    const view = render(<MenuPage />)
    await screen.findByText('メニュー一覧')
    expect((screen.getByRole('button', { name: '再開' }) as HTMLButtonElement).disabled).toBe(false)

    fixture.accountId = 'account-2'
    view.rerender(<MenuPage />)
    await waitFor(() => expect(fixture.snapshot.mock.calls.some(([id]) => id === 'account-2')).toBe(true))

    const resumeButton = screen.getByRole('button', { name: '再開' }) as HTMLButtonElement
    expect(resumeButton.disabled).toBe(true)
    fireEvent.click(resumeButton)

    // 行の「…」メニューから再開を選んでも前のアカウントのメニューに対して updateMenu を送らない
    const archivedItem = snapshotOf().menuItems.find((item) => item.status === 'archived')!
    fireEvent.click(screen.getByRole('button', { name: `メニュー「${archivedItem.name}」の操作` }))
    fireEvent.click(screen.getByRole('menuitem', { name: '再開' }))

    expect(fixture.updateMenu).not.toHaveBeenCalled()

    await act(async () => { finishSecond({ data: snapshotOf() }) })
    await waitFor(() => expect((screen.getByRole('button', { name: '再開' }) as HTMLButtonElement).disabled).toBe(false))
  })
})
