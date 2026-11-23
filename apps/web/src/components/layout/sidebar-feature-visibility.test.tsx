// @vitest-environment happy-dom
import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
import type { AccountStyle, StaffMember } from '@line-crm/shared'

import { cleanup, render, waitFor, within } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const localStorageValues = new Map<string, string>()
const testLocalStorage = {
  getItem: (key: string) => localStorageValues.get(key) ?? null,
  setItem: (key: string, value: string) => { localStorageValues.set(key, String(value)) },
  removeItem: (key: string) => { localStorageValues.delete(key) },
  clear: () => { localStorageValues.clear() },
}
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: testLocalStorage,
})
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: testLocalStorage,
})

const fixture = vi.hoisted(() => ({
  visibility: vi.fn(),
  get: vi.fn(),
  accountId: 'account-1',
  style: 'restaurant' as AccountStyle,
}))

vi.mock('next/navigation', () => ({ usePathname: () => '/' }))
vi.mock('next/link', async () => {
  const React = await import('react')
  return { default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => React.createElement('a', { href, ...props }, children) }
})
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fixture.accountId }) }))
vi.mock('@/lib/use-brand', () => ({ useBrand: () => ({ name: '会社', iconUrl: null }) }))
vi.mock('@/components/layout/sidebar-identity', () => ({ default: () => <div>identity</div> }))
vi.mock('@/components/hq/account-menu', () => ({ default: () => <div>hq</div>, SidebarAccountMenu: ({ hq }: { hq: boolean }) => <div data-testid="sidebar-account">{hq ? 'me-hq' : 'me-store'}</div> }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return {
    api: {
      featureSettings: actual.api.featureSettings,
      inbox: { unanswered: { count: vi.fn(async () => ({ success: true, data: { total: 0 } })) } },
      nenMembers: { overview: vi.fn(async () => ({ success: true, data: { pendingPhotos: 0 } })) },
      health: { summary: vi.fn(async () => ({ success: true, data: { warningCount: 0, dangerCount: 0 } })) },
    },
  }
})

vi.mock('@/hooks/use-account-style', async original => ({
  ...await original<typeof import('@/hooks/use-account-style')>(),
  useAccountStyle: () => ({ data: { style: fixture.style }, status: 'ready', error: null, reload: vi.fn() }),
}))
import { accountStyleUpdated } from '@/hooks/use-account-style'
import { MENU_SECTIONS } from '@/lib/menu'
import Sidebar from './sidebar'
import SettingsInnerNav from './settings-inner-nav'
import { clearFeatureVisibilityCache } from '@/lib/feature-visibility-cache'
import { clearFeatureSettingsCache } from '@/lib/feature-settings-cache'

describe('Sidebarのstaff向け機能表示read-model', () => {
  beforeEach(() => {
    forgetStaffIdentity()
    // 表示可否は画面間で共有される（V6R-S0-b）。試験ごとに応答を替えるので毎回捨てる。
    clearFeatureVisibilityCache()
    clearFeatureSettingsCache()
    fixture.accountId = 'account-1'
    fixture.style = 'restaurant'
    window.localStorage.clear()
    window.localStorage.setItem('lh_csrf', 'fixture-session')
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      const response = url.pathname === '/api/settings/features/visibility'
        ? await fixture.visibility(url.searchParams.get('account_id'))
        : url.pathname === '/api/settings/features'
          ? await fixture.get(url.searchParams.get('account_id'))
          : { success: true, data: {} }
      return new Response(JSON.stringify(response))
    }))
    fixture.visibility.mockReset()
    fixture.get.mockReset()
    fixture.visibility.mockResolvedValue({
      success: true,
      data: { features: { scenarios: false, broadcasts: true } },
    })
    fixture.get.mockResolvedValue({
      success: true,
      data: {
        features: { scenarios: true, broadcasts: true },
        sidebarOrder: null,
        sidebarItemOrder: null,
        specializedFeatureKeys: [],
      },
    })
  })

  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('一般staffは最小read-modelだけを使い、offの項目を隠す', async () => {
    window.localStorage.setItem('lh_staff_role', 'staff')
    rememberStaffIdentity({ role: 'staff' } as StaffMember)
    window.localStorage.setItem('lh_staff_permissions', JSON.stringify(['/scenarios', '/broadcasts']))
    expect(window.localStorage.getItem('lh_staff_role')).toBe('staff')
    const view = render(<Sidebar />)

    await waitFor(() => expect(fixture.visibility).toHaveBeenCalledWith('account-1'))
    act(() => window.dispatchEvent(new CustomEvent('line-harness:feature-settings-updated')))
    await waitFor(() => {
      expect(fixture.visibility).toHaveBeenCalledWith('account-1')
      expect(view.queryAllByText('シナリオ配信')).toHaveLength(0)
      expect(view.getAllByText('一斉配信')).not.toHaveLength(0)
    })
    expect(fixture.get).not.toHaveBeenCalled()
  })

  it('multi_store_hierarchy: 設定内でoffと応答欠落では「プール管理」を出さず、onで出す(#860・)', async () => {
    window.localStorage.setItem('lh_staff_role', 'staff')
    rememberStaffIdentity({ role: 'staff' } as StaffMember)
    window.localStorage.setItem('lh_staff_permissions', JSON.stringify(['/broadcasts', '/pools']))
    fixture.visibility.mockResolvedValue({
      success: true,
      data: { features: { multi_store_hierarchy: false, broadcasts: true } },
    })
    const view = render(<><Sidebar /><SettingsInnerNav /></>)
    await waitFor(() => expect(fixture.visibility).toHaveBeenCalledWith('account-1'))
    act(() => window.dispatchEvent(new CustomEvent('line-harness:feature-settings-updated')))
    await waitFor(() => expect(view.getAllByText('一斉配信')).not.toHaveLength(0))
    expect(view.queryAllByText('プール管理')).toHaveLength(0)
    // 必須の基本ナビは機能キーを持たないので残る。
    expect(view.getAllByText('ダッシュボード')).not.toHaveLength(0)
    cleanup()

    rememberStaffIdentity({ role: 'staff' } as StaffMember)
    fixture.visibility.mockResolvedValue({
      success: true,
      data: { features: { broadcasts: true } },
    })
    const missing = render(<><Sidebar /><SettingsInnerNav /></>)
    await waitFor(() => expect(fixture.visibility).toHaveBeenCalledTimes(2))
    act(() => window.dispatchEvent(new CustomEvent('line-harness:feature-settings-updated')))
    await waitFor(() => expect(missing.getAllByText('一斉配信')).not.toHaveLength(0))
    expect(missing.queryAllByText('プール管理')).toHaveLength(0)
    cleanup()

    rememberStaffIdentity({ role: 'staff' } as StaffMember)
    fixture.visibility.mockResolvedValue({
      success: true,
      data: { features: { multi_store_hierarchy: true, broadcasts: true } },
    })
    const enabled = render(<><Sidebar /><SettingsInnerNav /></>)
    await waitFor(() => expect(fixture.visibility).toHaveBeenCalled())
    act(() => window.dispatchEvent(new CustomEvent('line-harness:feature-settings-updated')))
    await waitFor(() => expect(enabled.getAllByText('プール管理')).not.toHaveLength(0))
    expect(within(enabled.container.querySelector('aside')!).queryAllByText('プール管理')).toHaveLength(0)
    expect(enabled.getAllByText('一斉配信')).not.toHaveLength(0)
  })

  it('ownerも表示可否は最小read-modelから読み、管理GETは並び用に追加する', async () => {
    window.localStorage.setItem('lh_staff_role', 'owner')
    rememberStaffIdentity({ role: 'owner' } as StaffMember)
    expect(window.localStorage.getItem('lh_staff_role')).toBe('owner')
    render(<Sidebar />)
    await waitFor(() => expect(fixture.visibility).toHaveBeenCalledWith('account-1'))
    act(() => window.dispatchEvent(new CustomEvent('line-harness:feature-settings-updated')))
    await waitFor(() => {
      expect(fixture.visibility).toHaveBeenCalledWith('account-1')
      expect(fixture.get).toHaveBeenCalledWith('account-1')
    })
  })

  it.each(['owner', 'admin'])('%sは表示可否を待たず並びも読み、並び失敗で表示可否を失わない', async (role) => {
    rememberStaffIdentity({ role } as StaffMember)
    let resolveVisibility: ((value: unknown) => void) | undefined
    fixture.visibility.mockImplementationOnce(() => new Promise(resolve => { resolveVisibility = resolve }))
    fixture.get.mockRejectedValue(new Error('403 Forbidden'))
    const view = render(<Sidebar />)
    await waitFor(() => expect(fixture.visibility).toHaveBeenCalledWith('account-1'))
    await waitFor(() => expect(fixture.get).toHaveBeenCalledWith('account-1'))
    expect(view.queryAllByText('一斉配信')).toHaveLength(0)
    await act(async () => { resolveVisibility?.({ success: true, data: { features: { broadcasts: true } } }) })
    await waitFor(() => expect(view.getAllByText('一斉配信')).not.toHaveLength(0))
    expect(view.queryAllByText('もう一度')).toHaveLength(0)
  })

  it.each([null, 'staff', 'viewer', 'read-only-owner'])('権限%sでは管理GETを先読みしない', async (role) => {
    window.localStorage.setItem('lh_staff_role', 'owner')
    window.localStorage.setItem('lh_staff_permissions', JSON.stringify(['/broadcasts']))
    if (role) rememberStaffIdentity({ role: role === 'read-only-owner' ? 'owner' : role, readOnly: role === 'read-only-owner' } as StaffMember)
    const view = render(<Sidebar />)
    await waitFor(() => expect(view.getAllByText('一斉配信')).not.toHaveLength(0))
    expect(fixture.get).not.toHaveBeenCalled()
  })

  it.each(['account', 'role'])('%s切替後に届いた古い並びを適用しない', async (change) => {
    rememberStaffIdentity({ role: 'owner' } as StaffMember)
    let resolveOld: ((value: unknown) => void) | undefined
    fixture.get.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    const view = render(<Sidebar />)
    await waitFor(() => expect(fixture.get).toHaveBeenCalledWith('account-1'))
    if (change === 'account') {
      fixture.accountId = 'account-current'
      view.rerender(<Sidebar />)
      await waitFor(() => expect(fixture.get).toHaveBeenCalledWith('account-current'))
    } else {
      window.localStorage.setItem('lh_staff_permissions', JSON.stringify(['/broadcasts']))
      act(() => rememberStaffIdentity({ role: 'viewer' } as StaffMember))
    }
    await waitFor(() => expect(view.getAllByText('一斉配信')).not.toHaveLength(0))
    const menus = () => [...view.container.querySelectorAll('nav')].map(nav => nav.textContent)
    const currentMenus = menus()
    await act(async () => { resolveOld?.({ success: true, data: { version: 1, sidebarOrder: ['自動化', 'メイン'], sidebarItemOrder: null } }) })
    expect(menus()).toEqual(currentMenus)
    expect(fixture.get).toHaveBeenCalledTimes(change === 'account' ? 2 : 1)
  })

  it('保存roleがadminでも管理GETが403なら、staff向け表示可否を捨てない', async () => {
    window.localStorage.setItem('lh_staff_role', 'admin')
    rememberStaffIdentity({ role: 'admin' } as StaffMember)
    window.localStorage.setItem('lh_staff_permissions', JSON.stringify(['/scenarios', '/broadcasts']))
    fixture.get.mockRejectedValue(new Error('403 Forbidden'))
    const view = render(<Sidebar />)

    await waitFor(() => expect(fixture.visibility).toHaveBeenCalledWith('account-1'))
    act(() => window.dispatchEvent(new CustomEvent('line-harness:feature-settings-updated')))
    await waitFor(() => {
      expect(fixture.visibility).toHaveBeenCalledWith('account-1')
      expect(fixture.get).toHaveBeenCalledWith('account-1')
      expect(view.queryAllByText('シナリオ配信')).toHaveLength(0)
      expect(view.getAllByText('一斉配信')).not.toHaveLength(0)
    })
  })

  it('管理GETの成功応答が不正でも、取得済みの表示可否を捨てない', async () => {
    rememberStaffIdentity({ role: 'owner' } as StaffMember)
    fixture.get.mockResolvedValue({ success: true })
    const view = render(<Sidebar />)
    await waitFor(() => expect(fixture.get).toHaveBeenCalled())
    await waitFor(() => expect(view.getAllByText('一斉配信')).not.toHaveLength(0))
    expect(view.queryAllByText('もう一度')).toHaveLength(0)
  })

  it.each([
    ['features欠落', { success: true, data: {} }],
    ['featuresが配列', { success: true, data: { features: [] } }],
    ['値がboolean以外', { success: true, data: { features: { scenarios: 'false' } } }],
  ])('古い・不正な応答（%s）では任意機能を出さず、画面全体を落とさない', async (_label, response) => {
    fixture.visibility.mockResolvedValue(response as never)
    const view = render(<Sidebar />)

    await waitFor(() => expect(fixture.visibility).toHaveBeenCalledWith('account-1'))
    await waitFor(() => expect(view.queryAllByText('一斉配信')).toHaveLength(0))
    await waitFor(() => expect(view.getAllByText('もう一度')).not.toHaveLength(0))
    expect(view.getAllByText('ダッシュボード')).not.toHaveLength(0)
  })

  it('loading/error/retryとaccount切替の遅延応答で、未確認・古い任意機能を表示しない', async () => {
    window.localStorage.setItem('lh_staff_role', 'staff')
    rememberStaffIdentity({ role: 'staff' } as StaffMember)
    window.localStorage.setItem('lh_staff_permissions', JSON.stringify(['/broadcasts']))
    fixture.visibility
      .mockRejectedValueOnce(new Error('temporary network error'))
      .mockResolvedValueOnce({ success: true, data: { features: { broadcasts: true } } })
    const view = render(<Sidebar />)

    // 初回の未確認状態も、失敗状態も必須ナビだけを残す。
    expect(view.queryAllByText('一斉配信')).toHaveLength(0)
    expect(view.getAllByText('ダッシュボード')).not.toHaveLength(0)
    await waitFor(() => expect(view.getAllByText('もう一度')).not.toHaveLength(0))
    await act(async () => { view.getAllByText('もう一度')[0]?.click() })
    await waitFor(() => expect(view.getAllByText('一斉配信')).not.toHaveLength(0))

    let resolveOld: ((value: unknown) => void) | undefined
    let resolveCurrent: ((value: unknown) => void) | undefined
    fixture.visibility.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
    fixture.visibility.mockImplementationOnce(() => new Promise((resolve) => { resolveCurrent = resolve }))
    fixture.accountId = 'account-old'
    view.rerender(<Sidebar />)
    await waitFor(() => expect(fixture.visibility).toHaveBeenCalledWith('account-old'))
    expect(view.queryAllByText('一斉配信')).toHaveLength(0)
    fixture.accountId = 'account-current'
    view.rerender(<Sidebar />)
    await waitFor(() => expect(fixture.visibility).toHaveBeenCalledWith('account-current'))
    await act(async () => { resolveCurrent?.({ success: true, data: { features: { broadcasts: true } } }) })
    await waitFor(() => expect(view.getAllByText('一斉配信')).not.toHaveLength(0))
    await act(async () => { resolveOld?.({ success: true, data: { features: { broadcasts: false } } }) })
    expect(view.getAllByText('一斉配信')).not.toHaveLength(0)
  })
  it.each(['owner', 'staff'])('飲食の%sは人用予約を出さず、イベントとスタンプは機能設定に従う', async role => {
    for (const enabled of [true, false]) {
      clearFeatureVisibilityCache(); clearFeatureSettingsCache()
      rememberStaffIdentity({ role } as StaffMember)
      window.localStorage.setItem('lh_staff_permissions', JSON.stringify(['/booking/bookings', '/booking/menus', 'booking.staff.own', '/events', '/visit-stamps', '/restaurant-test/reservations']))
      window.localStorage.setItem('lh-sidebar-groups', JSON.stringify(Object.fromEntries(MENU_SECTIONS.map(section => [section.id, true]))))
      const features = { booking: true, events: enabled, visit_stamps: enabled, restaurant_test: true }
      fixture.visibility.mockResolvedValue({ success: true, data: { features } })
      fixture.get.mockResolvedValue({ success: true, data: { version: 1, features, sidebarOrder: null, sidebarItemOrder: null, specializedFeatureKeys: [] } })
      const view = render(<Sidebar />)
      await waitFor(() => expect(view.container.querySelector('a[href="/restaurant-test/reservations"]')).not.toBeNull())
      for (const href of ['/booking/bookings', '/booking/menus', '/booking/staff/shifts']) expect(view.container.querySelector(`a[href="${href}"]`)).toBeNull()
      await waitFor(() => {
        for (const href of ['/events', '/visit-stamps']) expect(view.container.querySelector(`a[href="${href}"]`) !== null).toBe(enabled)
      })
      view.unmount()
    }
  })

  it('使い方を飲食店に保存したら同じアカウントの機能表示を読み直す', async () => {
    fixture.style = 'salon'
    rememberStaffIdentity({ role: 'owner' } as StaffMember)
    window.localStorage.setItem('lh-sidebar-groups', JSON.stringify(Object.fromEntries(MENU_SECTIONS.map(section => [section.id, true]))))
    fixture.visibility.mockResolvedValue({ success: true, data: { features: { restaurant_test: false } } })
    const view = render(<Sidebar />)
    await waitFor(() => expect(fixture.visibility).toHaveBeenCalledWith('account-1'))
    expect(view.container.querySelector('a[href="/restaurant-test/tables"]')).toBeNull()

    fixture.style = 'restaurant'
    fixture.visibility.mockResolvedValue({ success: true, data: { features: { restaurant_test: true } } })
    act(() => accountStyleUpdated('account-1'))
    await waitFor(() => expect(view.container.querySelector('a[href="/restaurant-test/tables"]')).not.toBeNull())
    expect(fixture.visibility).toHaveBeenCalledTimes(2)
  })

  it('サロンのstaffには許可された人用予約と自分の勤務を残す', async () => {
    fixture.style = 'salon'
    rememberStaffIdentity({ role: 'staff' } as StaffMember)
    window.localStorage.setItem('lh_staff_permissions', JSON.stringify(['/booking/bookings', '/booking/menus', 'booking.staff.own']))
    window.localStorage.setItem('lh-sidebar-groups', JSON.stringify(Object.fromEntries(MENU_SECTIONS.map(section => [section.id, true]))))
    fixture.visibility.mockResolvedValue({ success: true, data: { features: { booking: true, restaurant_test: true } } })
    const view = render(<Sidebar />)
    await waitFor(() => {
      for (const href of ['/booking/bookings', '/booking/menus', '/booking/staff/shifts']) expect(view.container.querySelector(`a[href="${href}"]`)).not.toBeNull()
    })
    expect(view.container.querySelector('a[href="/restaurant-test/reservations"]')).toBeNull()
  })

})
