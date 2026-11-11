// @vitest-environment happy-dom
/*
 * Issue #637（監査 D-3「無名ボタン」29番）の回帰固定。
 *
 * 監査時点の配布物では主要ボタン1件に名前が無かった。現行コードは
 * すべてのボタンが可視テキストか aria-label を持つことを確認済み。
 * このテストは「営業時間タブに無名ボタンが戻らないこと」を固定する。
 */
import React, { act } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { buttonsWithoutAccessibleName } from '@/test-utils/accessible-name'

const fixture = vi.hoisted(() => ({
  selectedAccountId: 'account-a' as string | null,
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  listMenus: vi.fn(),
  listResources: vi.fn(),
  createResource: vi.fn(),
  updateResource: vi.fn(),
  deleteResource: vi.fn(),
  getAvailability: vi.fn(),
  updateException: vi.fn(),
  deleteException: vi.fn(),
  listStaff: vi.fn(),
  checkAvailability: vi.fn(),
}))

vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useSearchParams: () => new URLSearchParams({ tab: 'hours' }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/booking/staff/shifts',
}))
vi.mock('@/components/shell/page-chrome', async () => ({ ...(await import('@/test-utils/page-chrome-mock')).pageChromeMock(), usePageTitle: () => undefined, usePageChrome: () => ({ title: null, fullWidth: false }) }))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: fixture.selectedAccountId,
    selectedAccount: fixture.selectedAccountId ? { id: 'account-a', name: '本店', liffId: 'liff-x' } : null,
  }),
}))
vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number
    constructor(status: number, message?: string) {
      super(message ?? `API error: ${status}`)
      this.status = status
    }
  }
  return {
    ApiError,
    bookingApi: {
      listStaffMenusBulk: async () => ({ staff: [] }),
      listRequests: async () => ({ bookings: [], total: 0 }),
      getSettings: (...a: unknown[]) => fixture.getSettings(...a),
      saveSettings: (...a: unknown[]) => fixture.saveSettings(...a),
      listMenus: (...a: unknown[]) => fixture.listMenus(...a),
      listResources: (...a: unknown[]) => fixture.listResources(...a),
      createResource: (...a: unknown[]) => fixture.createResource(...a),
      updateResource: (...a: unknown[]) => fixture.updateResource(...a),
      deleteResource: (...a: unknown[]) => fixture.deleteResource(...a),
      getAvailability: (...a: unknown[]) => fixture.getAvailability(...a),
      createException: vi.fn(),
      updateException: (...a: unknown[]) => fixture.updateException(...a),
      deleteException: (...a: unknown[]) => fixture.deleteException(...a),
      listMyStaff: vi.fn(async () => ({ staff: [] })),
      listStaff: (...a: unknown[]) => fixture.listStaff(...a),
      checkAvailability: (...a: unknown[]) => fixture.checkAvailability(...a),
    },
  }
})
vi.mock('@/lib/staff-capability', () => ({
  canEditFeature: () => true,
  canViewFeature: () => true,
}))

import { forgetStaffIdentity, rememberStaffIdentity } from '@/lib/staff-identity-state'
import type { StaffMember } from '@line-crm/shared'
import BookingSettingsV8 from '@/v8/booking-menus/settings'

// globals: false のため Testing Library の自動 cleanup は登録されない。
afterEach(async () => {
  await act(async () => cleanup())
})

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Issue #637 /booking/staff/shifts 全ボタンにアクセシブルな名前', () => {
  test('営業時間タブに無名ボタンがない', async () => {
    const stored = new Map<string, string>()
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        clear: () => stored.clear(),
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
        removeItem: (key: string) => stored.delete(key),
      },
    })
    window.localStorage.setItem('lh_staff_role', 'owner')
    forgetStaffIdentity(); rememberStaffIdentity({ role: 'owner' } as StaffMember)
    fixture.getSettings.mockImplementation(async (accountId: string) => ({
      success: true,
      data: {
        id: null, lineAccountId: accountId, organizationName: '本店', version: 0,
        timeZone: 'Asia/Tokyo', bookingWindowDays: 60, cutoffMinutesBefore: 1440,
        cancelDeadlineMinutesBefore: 1440, maxActiveBookingsPerFriend: 1,
        approvalMode: 'automatic', holdMinutes: 15, slotGranularityMinutes: 15,
        menuCount: 1, activeMenuCount: 1, inactiveMenuCount: 0,
        businessHoursConfigured: false,
        businessHours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, intervals: [] })),
        exceptions: [], updatedAt: '2026-09-01T00:00:00+09:00',
      },
    }))
    fixture.listMenus.mockResolvedValue({ menus: [{ id: 'menu-1', name: 'カット', is_active: 1 }] })
    fixture.listResources.mockResolvedValue({ data: { resources: [] } })
    fixture.getAvailability.mockResolvedValue({ by_staff: [] })
    fixture.listStaff.mockResolvedValue({ staff: [] })

    const { container } = render(<BookingSettingsV8 accountId={fixture.selectedAccountId} />)
    // タブと右の写しは別々の動的 import。両方の応答と描画を待つ。
    await screen.findByRole('heading', { name: '営業時間' })
    await screen.findByText('設備はまだありません。')
    await screen.findByText('この期間に空きはありません。')
    const unnamed = buttonsWithoutAccessibleName(container)
    expect(
      unnamed.map((b) => b.outerHTML.slice(0, 160)),
      '無名ボタンが残っている',
    ).toEqual([])
  })
})
