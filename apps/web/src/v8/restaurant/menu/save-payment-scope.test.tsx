// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// 日付の見本を作る前に日本時間で固定し、待ち合わせのタイマーは動かす。
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T12:00:00+09:00'))
})

const fixture = vi.hoisted(() => ({ account: 'account-1', snapshot: vi.fn(), createMenu: vi.fn(), updateMenu: vi.fn() }))
const role = vi.hoisted(() => ({ value: 'owner' as string | null }))
const fetchApi = vi.hoisted(() => vi.fn())
const payment = vi.hoisted(() => ({ saveCourseMode: vi.fn() }))

vi.mock('@/components/shared/allergy-field', () => ({ default: () => null }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fixture.account, accounts: [] }) }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: fixture }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => role.value, canManageRole: (r: string | null) => r === 'owner' || r === 'admin' }))
vi.mock('@/lib/api', async (load) => {
 const actual = await load<typeof import('@/lib/api')>()
 return { ...actual, fetchApi, bookingApi: { ...actual.bookingApi, getPaymentConfig: async () => ({ success: true, data: { mode: 'onsite', provider: 'onsite', holdMinutes: 10, keyConfigured: true, testMode: true } }) } }
})
vi.mock('@/lib/api/helpers/booking-payment-admin', async load => {
 const actual = await load<typeof import('@/lib/api/helpers/booking-payment-admin')>()
 return { ...actual, bookingPaymentAdminApi: { ...actual.bookingPaymentAdminApi,
  connection: async () => ({ success: true, data: { connected: true } }),
  courseMode: async () => ({ success: true, data: { mode: null, version: 3 } }),
  saveCourseMode: payment.saveCourseMode,
 } }
})
const nav = vi.hoisted(() => ({ push: vi.fn(), params: new URLSearchParams() }))
vi.mock('next/navigation', async (load) => ({
  ...(await load<typeof import('next/navigation')>()),
  useRouter: () => ({ push: nav.push, replace: nav.push, back: vi.fn(), prefetch: vi.fn(), refresh: vi.fn(), forward: vi.fn() }),
  useSearchParams: () => nav.params,
  usePathname: () => '/restaurant-test/menu',
}))

import MenuEditPage from './edit'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'
import { snapshotOf } from '../booking-kit/test-data'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T12:00:00+09:00'))
  role.value = verifiedStaffRole('owner')
  fixture.account = 'account-1'; nav.params = new URLSearchParams()
  fixture.snapshot.mockResolvedValue({ data: snapshotOf() })
  fixture.createMenu.mockResolvedValue({ success: true })
  fixture.updateMenu.mockResolvedValue({ success: true })
  fetchApi.mockResolvedValue({ success: true })
  payment.saveCourseMode.mockResolvedValue({ success: true, data: { mode: 'online', version: 4 } })
})
afterEach(() => { cleanup(); clearToastsForTest(); vi.useRealTimers(); vi.clearAllMocks() })

it('店舗を替えても元のメニューと支払いを全部保存し、新しい保存と画面を動かさない', async () => {
 nav.params = new URLSearchParams('id=m1')
 let old!: (value: unknown) => void, fresh!: (value: unknown) => void
 fixture.updateMenu.mockImplementationOnce(() => new Promise(resolve => { old = resolve })).mockImplementationOnce(() => new Promise(resolve => { fresh = resolve }))
 const view = render(<><MenuEditPage /><ToastHost /></>)
 fireEvent.change(await screen.findByLabelText('メニュー名'), { target: { value: '前の店の名前' } })
 fireEvent.click(await screen.findByRole('radio', { name: /このメニューだけ変える/ }))
 fireEvent.click(screen.getByRole('button', { name: /保存する/ }))
 await waitFor(() => expect(fixture.updateMenu).toHaveBeenCalledTimes(1))
 fixture.account = 'account-2'
 view.rerender(<><MenuEditPage /><ToastHost /></>)
 await waitFor(() => expect((screen.getByLabelText('メニュー名') as HTMLInputElement).value).toBe('秋の鹿肉コース'))
 fireEvent.change(screen.getByLabelText('メニュー名'), { target: { value: '次の店の入力' } })
 fireEvent.click(screen.getByRole('button', { name: /保存する/ }))
 await waitFor(() => expect(fixture.updateMenu).toHaveBeenCalledTimes(2))
 await act(async () => { old({ success: true }) })
 expect(payment.saveCourseMode).toHaveBeenCalledExactlyOnceWith('account-1', 'm1', 'online', 3)
 expect(fixture.updateMenu.mock.calls[0]).toEqual(['account-1', 'm1', expect.objectContaining({ name: '前の店の名前' })])
 expect(nav.push).not.toHaveBeenCalled()
 expect(document.body.textContent).not.toContain('メニューを更新しました。')
 expect(view.container.querySelector('button[aria-busy="true"]')).not.toBeNull()
 expect((screen.getByLabelText('メニュー名') as HTMLInputElement).value).toBe('次の店の入力')
 await act(async () => { fresh({ success: true }) })
 await waitFor(() => expect(nav.push).toHaveBeenCalledExactlyOnceWith('/restaurant-test/menu'))
 expect(payment.saveCourseMode).toHaveBeenCalledTimes(1)
})
