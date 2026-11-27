// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'

const fixture = vi.hoisted(() => ({
  snapshot: vi.fn(),
  inventoryDay: vi.fn(),
  openingHours: vi.fn(),
  listIntakeAddresses: vi.fn(),
  closures: vi.fn(),
  channelCloseTasks: vi.fn(),
  listStores: vi.fn(),
  storeContext: vi.fn(),
  mediaLinks: vi.fn(),
}))

vi.mock('@/lib/api/helpers/reservation-board', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api/helpers/reservation-board')>()
  return { ...original, reservationBoardApi: { ...original.reservationBoardApi, floors: vi.fn(async () => ({ success: true, data: [] })) } }
})
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
  usePathname: () => '/restaurant-test/inventory',
  useSearchParams: () => new URLSearchParams(window.location.search),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-1', accounts: [] }) }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: fixture }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner', canManageRole: () => true }))
vi.mock('@/lib/api', async (load) => ({ ...(await load<typeof import('@/lib/api')>()), fetchApi: vi.fn(async () => ({ success: true, data: [] })) }))

import InventoryPage from './inventory'
import { snapshotOf } from '../booking-kit/test-data'

beforeEach(() => {
  verifiedStaffRole('owner')
  fixture.inventoryDay.mockResolvedValue({ data: [], allocation: null })
  fixture.openingHours.mockResolvedValue({ data: { storeId: 'store-1', hours: [], version: 1 } })
  fixture.listIntakeAddresses.mockResolvedValue({ data: [] })
  fixture.closures.mockResolvedValue({ data: [] })
  fixture.channelCloseTasks.mockResolvedValue({ data: [] })
  fixture.listStores.mockResolvedValue({ data: { stores: [] } })
  fixture.storeContext.mockResolvedValue({ data: {} })
  fixture.mediaLinks.mockResolvedValue({ data: [] })
})

afterEach(() => {
  cleanup()
  verifiedStaffRole(null)
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/')
})

describe('InventoryPage 休業日総席数の不正値防御とルールタブ未選択案内', () => {
  it('有効卓に不正な定員が混ざると総席数を NaN や確定値にせず確認できませんと表示する', async () => {
    window.history.replaceState(null, '', '/restaurant-test/inventory?tab=closures')
    const snap = snapshotOf()
    fixture.snapshot.mockResolvedValue({
      data: {
        ...snap,
        tables: [
          { ...snap.tables[0], store_id: 'store-1', is_active: true, max_capacity: 4 },
          { ...snap.tables[1], store_id: 'store-1', is_active: true, max_capacity: Number.NaN },
        ],
      },
    })

    render(<InventoryPage />)
    const helpBtn = await screen.findByRole('button', { name: /予約枠・在庫の説明/ })
    expect(helpBtn).toBeTruthy()
    expect(document.body.textContent).not.toContain('NaN席')
    expect(document.body.textContent).not.toContain('総数 4席')
    // HelpTip の中身を開くか title/DOM で確認
    fireEvent.click(helpBtn)
    expect(await screen.findByText(/1つの時間帯の総数 確認できません（有効な卓 2 卓）/)).toBeTruthy()
  })

  it('店舗未選択の自動で合わせるルールタブで休業日ではなくルール向けの案内を出す', async () => {
    window.history.replaceState(null, '', '/restaurant-test/inventory?tab=rules')
    fixture.snapshot.mockResolvedValue({
      data: { ...snapshotOf(), stores: [] },
    })

    render(<InventoryPage />)
    expect(await screen.findByText('自動で合わせるルールを見たい店舗を選んでください。')).toBeTruthy()
    expect(screen.queryByText('休業日・貸切を見たい店舗を選んでください。')).toBeNull()
  })
})
