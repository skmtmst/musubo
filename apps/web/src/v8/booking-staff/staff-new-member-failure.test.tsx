// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StaffMember } from '@line-crm/shared'
import { forgetStaffIdentity, rememberStaffIdentity } from '@/lib/staff-identity-state'

const fixture = vi.hoisted(() => ({
  accountId: 'account-a' as string | null,
  staffList: vi.fn(),
  listMenus: vi.fn(),
  listStaff: vi.fn(),
}))

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: fixture.accountId, selectedAccount: null }),
}))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      staff: {
        ...actual.api.staff,
        me: async () => ({ success: true, data: { role: 'owner' } }),
        list: () => fixture.staffList(),
      },
    },
    bookingApi: {
      ...actual.bookingApi,
      listMenus: (...args: unknown[]) => fixture.listMenus(...args),
      listStaff: (...args: unknown[]) => fixture.listStaff(...args),
    },
  }
})

import StaffNewV8 from './staff-new'

const memStorage = vi.hoisted(() => {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key) },
    setItem: (key: string, value: string) => { values.set(key, String(value)) },
  }
})
vi.stubGlobal('localStorage', memStorage)

const ACTIVE_MEMBER = { id: 'member-1', name: '山田 太郎', email: 'yamada@example.com', isActive: true }

beforeEach(() => {
  fixture.accountId = 'account-a'
  forgetStaffIdentity()
  rememberStaffIdentity({ role: 'owner' } as StaffMember)
  memStorage.setItem('lh_staff_role', 'owner')
  fixture.staffList.mockReset()
  fixture.listMenus.mockReset().mockResolvedValue({
    menus: [{ id: 'menu-1', name: 'カット', duration_minutes: 60, base_price: 8000, price_mode: 'fixed', is_active: 1 }],
  })
  fixture.listStaff.mockReset().mockResolvedValue({ staff: [] })
})

afterEach(() => {
  cleanup()
  memStorage.clear()
})

describe('StaffNewV8 のログインユーザー取得失敗（success: false）と未選択状態', () => {
  it('api.staff.list が success: false を返したときに空選択にせず、エラー表示からその場で再読み込みできる', async () => {
    fixture.staffList
      .mockResolvedValueOnce({ success: false, error: 'upstream error' })
      .mockResolvedValueOnce({ success: true, data: [ACTIVE_MEMBER] })

    render(<StaffNewV8 />)

    await screen.findByText('ログインユーザーを読み込めませんでした')
    expect(screen.queryByRole('button', { name: 'ログインユーザーとの紐づけ' })).toBeNull()

    const nameInput = screen.getByRole('textbox', { name: 'スタッフ名（管理画面での呼び名）' }) as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: '鈴木' } })

    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))

    fireEvent.click(await screen.findByRole('button', { name: 'ログインユーザーとの紐づけ' }))
    await screen.findByText('山田 太郎（yamada@example.com）')
    expect(screen.queryByText('ログインユーザーを読み込めませんでした')).toBeNull()
    expect(nameInput.value).toBe('鈴木')
    expect(fixture.staffList).toHaveBeenCalledTimes(2)
  })

  it('アカウント未選択のときは右の見本が読み込み中のまま固まらない', async () => {
    fixture.accountId = null
    fixture.staffList.mockResolvedValue({ success: true, data: [] })

    render(<StaffNewV8 />)
    await screen.findByText('ログインユーザーとのひも付け')

    const phone = screen.getByRole('region', { name: 'お客さまの予約画面の見本' })
    expect(within(phone).queryByText(/読み込んでいます/)).toBeNull()
  })
})
