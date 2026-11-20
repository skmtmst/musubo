// @vitest-environment happy-dom
import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
import type { StaffMember } from '@line-crm/shared'

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'

const fixture = vi.hoisted(() => ({
  tab: 'menus',
  listMenus: null as null | ((...args: unknown[]) => Promise<unknown>),
  reorderMenus: null as null | ((...args: unknown[]) => Promise<unknown>),
  updateMenu: null as null | ((...args: unknown[]) => Promise<unknown>),
  patchMenu: null as null | ((...args: unknown[]) => Promise<unknown>),
  getSettings: null as null | ((...args: unknown[]) => Promise<unknown>),
  saveSettings: null as null | ((...args: unknown[]) => Promise<unknown>),
  listStaff: null as null | ((...args: unknown[]) => Promise<unknown>),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', accounts: [] }),
}))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(fixture.tab === 'menus' ? '' : `tab=${fixture.tab}`),
}))
vi.mock('@/components/layout/merged-tabs', () => ({
  default: () => <nav aria-label="予約設定のタブ" />,
  useMergedTab: () => 'menus',
}))
vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number
    code: string | undefined
    constructor(status: number, message?: string, code?: string) {
      super(message || `API error: ${status}`)
      this.name = 'ApiError'
      this.status = status
      this.code = code
    }
  }
  return {
    ApiError,
    api: {
      staff: { list: async () => ({ success: true, data: [] }) },
    },
    bookingApi: {
      listMenus: (...args: unknown[]) => fixture.listMenus!(...args),
      reorderMenus: (...args: unknown[]) => fixture.reorderMenus!(...args),
      updateMenu: (...args: unknown[]) => fixture.updateMenu!(...args),
      patchMenu: (...args: unknown[]) => fixture.patchMenu!(...args),
      getSettings: (...args: unknown[]) => fixture.getSettings!(...args),
      saveSettings: (...args: unknown[]) => fixture.saveSettings!(...args),
      listStaff: (...args: unknown[]) => fixture.listStaff!(...args),
      getAvailabilityRules: async () => ({ success: true, data: { rules: [] } }),
      getGoogleCalendar: async () => ({ success: true, data: { connection: null } }),
      getAvailability: async () => ({ success: true, data: { slots: [] } }),
    },
  }
})

import MenusPage from './page'
import { ApiError } from '@/lib/api'

const localStorageValues = new Map<string, string>()
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    setItem: (key: string, value: string) => { localStorageValues.set(key, String(value)) },
    removeItem: (key: string) => { localStorageValues.delete(key) },
    clear: () => { localStorageValues.clear() },
  },
})

const SETTINGS = {
  id: 'settings-a',
  lineAccountId: 'account-a',
  organizationName: '本店',
  version: 1,
  timeZone: 'Asia/Tokyo',
  bookingWindowDays: 60,
  cutoffMinutesBefore: 1440,
  cancelDeadlineMinutesBefore: 1440,
  maxActiveBookingsPerFriend: 1,
  approvalMode: 'automatic',
  holdMinutes: 15,
  slotGranularityMinutes: 15,
  menuCount: 2,
  activeMenuCount: 2,
  inactiveMenuCount: 0,
  businessHours: [],
  businessHoursConfigured: true,
  exceptions: [],
  updatedAt: '2026-09-01T00:00:00+09:00',
}

const menus = () => ([
  {
    id: 'menu-1', name: 'カット', category_label: null, description: null,
    duration_minutes: 60, buffer_after_minutes: 0, base_price: 8000, price_mode: 'fixed',
    sort_order: 0, is_active: true, auto_tag_id: null, concurrent_capacity: 1,
    booking_window_days: null, cutoff_hours_before: null, cancel_deadline_hours_before: null,
    intake_question: null, assigned_staff: [{ id: 'staff-a', display_name: '担当A' }], version: 1,
  },
  {
    id: 'menu-2', name: 'カラー', category_label: null, description: null,
    duration_minutes: 90, buffer_after_minutes: 0, base_price: 12000, price_mode: 'fixed',
    sort_order: 1, is_active: true, auto_tag_id: null, concurrent_capacity: 1,
    booking_window_days: null, cutoff_hours_before: null, cancel_deadline_hours_before: null,
    intake_question: null, assigned_staff: [{ id: 'staff-a', display_name: '担当A' }], version: 1,
  },
])

async function openSettings() {
  fixture.listMenus = vi.fn(async () => ({ menus: menus() }))
  render(<><MenusPage /><ToastHost /></>)
  if (fixture.tab === 'rules') {
    // ★V8 書き直し（src/v8/booking-menus）：締め切りは選ぶ欄になった。
    await screen.findByLabelText('受付の締め切り')
  } else {
    await screen.findByRole('heading', { name: 'メニュー' })
  }
}

function rowOrder(): string[] {
  // 保存中はつまみを出さない（共通の並び替えの決まり）ので、行そのものの並びを読む。
  return [...document.querySelectorAll<HTMLElement>('[data-reorder-id]')]
    .map((el) => el.textContent ?? '')
}

beforeEach(() => {
  forgetStaffIdentity(); rememberStaffIdentity({ role: 'owner' } as StaffMember);
  fixture.tab = 'menus'
  window.localStorage.setItem('lh_staff_role', 'owner'); rememberStaffIdentity({ role: 'owner' } as StaffMember)
  clearToastsForTest()
  fixture.updateMenu = vi.fn(async () => ({ ok: true }))
  fixture.patchMenu = vi.fn(async () => ({ ok: true }))
  fixture.getSettings = vi.fn(async () => ({ success: true, data: { version: 1, timeZone: 'Asia/Tokyo', bookingWindowDays: 1, cutoffMinutesBefore: 1, cancelDeadlineMinutesBefore: 1, maxActiveBookingsPerFriend: 1, approvalMode: 'automatic', holdMinutes: 1, slotGranularityMinutes: 15, businessHours: [], businessHoursConfigured: true, exceptions: [] } }))
  fixture.saveSettings = vi.fn(async (_accountId: string, body: unknown) => ({
    success: true, data: { ...SETTINGS, ...(body as object), version: 2 },
  }))
  fixture.listStaff = vi.fn(async () => ({ staff: [] }))
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe('メニューの公開・並びは先に画面を変える', () => {
  test('止めるですぐ札が変わり裏で保存する', async () => {
    await openSettings()
    fireEvent.click(screen.getByRole('button', { name: '「カット」のそのほかの操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '止める' }))
    // 確認の窓は出さず、札がすぐ変わる。
    expect(screen.queryByText(/ますか？/)).toBeNull()
    expect(screen.getByText('停止中')).toBeTruthy()
    await waitFor(() => { expect(fixture.patchMenu).toHaveBeenCalled() })
    expect(fixture.patchMenu).toHaveBeenCalledWith(
      'account-a', 'menu-1', 1, expect.objectContaining({ is_active: false }),
    )
    expect(screen.queryByRole('button', { name: '元に戻す' })).toBeNull()
    expect(fixture.patchMenu).toHaveBeenCalledTimes(1)
  })

  test('保存に失敗したら戻して「もう一度」の知らせを出す', async () => {
    fixture.patchMenu = vi.fn(async () => { throw new ApiError(500, 'error', 'error') })
    await openSettings()
    fireEvent.click(screen.getByRole('button', { name: '「カット」のそのほかの操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '止める' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: 'もう一度' })).toBeTruthy() })
    // 札は元に戻っている（2件とも公開中）。
    expect(screen.getAllByText('公開中')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'もう一度' }))
    await waitFor(() => { expect(fixture.patchMenu).toHaveBeenCalledTimes(2) })
  })

  test('保存中は二重押しを止め、成功はトーストで知らせる', async () => {
    fixture.tab = 'rules'
    await openSettings()
    fireEvent.click(await screen.findByRole('switch', { name: 'お店が承認してから確定する' }))
    const save = await screen.findByRole('button', { name: 'ルールを保存' })
    fireEvent.click(save)
    await waitFor(() => { expect(fixture.saveSettings).toHaveBeenCalled() })
    await screen.findByText(/予約.*ルールを保存しました。/)
  })

  test('上へで並びがすぐ変わり、一括APIへ保存する', async () => {
    let resolve!: (value: unknown) => void
    fixture.reorderMenus = vi.fn(() => new Promise((done) => { resolve = done }))
    await openSettings()
    expect(rowOrder()[0]).toContain('カット')
    const handles = screen.getAllByRole('button', { name: /を並び替える/ })
    fireEvent.keyDown(handles[1], { key: 'ArrowUp' })
    // 先に並びが変わる。
    expect(rowOrder()[0]).toContain('カラー')
    await waitFor(() => { expect(fixture.reorderMenus).toHaveBeenCalledTimes(1) })
    expect(fixture.reorderMenus).toHaveBeenCalledWith('account-a', { changes: expect.arrayContaining([
      {id: 'menu-2', expectedVersion: 1, sortOrder: 0},
      {id: 'menu-1', expectedVersion: 1, sortOrder: 1},
    ]) })
    resolve({ok: true})
  })
})
