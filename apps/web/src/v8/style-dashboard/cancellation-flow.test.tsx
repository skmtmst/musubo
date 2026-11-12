// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { StyleRow } from './model'

const f = vi.hoisted(() => ({ account: 'A', store: 'store-a', role: 'admin', save: vi.fn(), decide: vi.fn(), toast: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/', useSearchParams: () => new URLSearchParams() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: f.account }) }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => f.role }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/v8/restaurant/dashboard/public/use-store-today/index', () => ({ useStoreToday: () => ({ store: { id: f.store } }) }))
vi.mock('@/components/shared/preparing-dialog', async importOriginal => ({ ...await importOriginal<typeof import('@/components/shared/preparing-dialog')>(), PREPARING_TITLE: 'preparing', usePreparingDialog: () => ({ open: vi.fn(), dialog: null }) }))
vi.mock('@/lib/api/helpers/styles', () => ({ styleApi: { summary: vi.fn().mockRejectedValue(new Error('unavailable')), schedule: vi.fn().mockRejectedValue(new Error('unavailable')), saveBooking: f.save } }))
vi.mock('@/components/shared/toast', () => ({ notifyToast: f.toast }))
vi.mock('@/lib/api', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/api')>(), bookingApi: { getPaymentConfig: vi.fn().mockResolvedValue({ data: {} }), decideRequest: f.decide }, eventsApi: {} }))
import { useStyleDashboard } from './use-style-dashboard'
const row: StyleRow = { id: 'booking:real-id', time: '10:00', name: '予約者', booking: { id: 'real-id', kind: 'booking', version: 1, updatedAt: null, price: 0, partySize: 1, startsAt: '2026-11-02T10:00:00+09:00' } }
const input = { reason: '店舗都合', refund: 'none' as const, notify: false }
beforeEach(() => { f.account = 'A'; f.store = 'store-a'; f.role = 'admin'; f.save.mockReset(); f.decide.mockReset(); f.toast.mockReset() })
afterEach(cleanup)
it('閉じた取消確認は、同じ予約で開き直しても確定に使えない', async () => {
  f.save.mockResolvedValue({ success: true }); f.decide.mockResolvedValue({ status: 'cancelled' })
  const view = renderHook(() => useStyleDashboard('salon'))
  act(() => view.result.current.setCancelRow(row))
  const oldConfirm = view.result.current.confirmCancel
  const oldClose = view.result.current.setCancelRow
  act(() => view.result.current.setCancelRow(null))
  act(() => view.result.current.setCancelRow(row))
  act(() => oldClose(null))
  expect(view.result.current.cancelRow).toBe(row)
  await act(async () => { await oldConfirm(row, input) })
  expect(f.save).not.toHaveBeenCalled()
  expect(f.decide).not.toHaveBeenCalled()
  await act(async () => { await view.result.current.confirmCancel(row, input) })
  expect(f.decide).toHaveBeenCalledTimes(1)
})
it('店舗が変わると、前の店舗で開いた取消確認を表示しない', async () => {
  const view = renderHook(() => useStyleDashboard('restaurant'))
  act(() => view.result.current.setCancelRow(row))
  expect(view.result.current.cancelRow).toBe(row)
  f.store = 'store-b'; view.rerender()
  expect(view.result.current.cancelRow).toBeNull()
})
it('権限が変わると取消確認が失効し、権限が戻っても古い確認を使えない', async () => {
  const view = renderHook(() => useStyleDashboard('salon'))
  act(() => view.result.current.setCancelRow(row))
  const oldConfirm = view.result.current.confirmCancel
  f.role = 'viewer'; view.rerender()
  expect(view.result.current.cancelRow).toBeNull()
  f.role = 'admin'; view.rerender()
  expect(view.result.current.cancelRow).toBeNull()
  await act(async () => { await oldConfirm(row, input) })
  expect(f.save).not.toHaveBeenCalled()
  expect(f.decide).not.toHaveBeenCalled()
})
it('理由の保存中にアカウントを切り替えても、元の対象の取消を最後まで送る', async () => {
  let finish!: () => void
  f.save.mockReturnValue(new Promise(resolve => { finish = () => resolve({ success: true }) }))
  f.decide.mockResolvedValue({ status: 'cancelled' })
  const view = renderHook(() => useStyleDashboard('salon'))
  act(() => view.result.current.setCancelRow(row))
  let operation!: Promise<void>
  act(() => { operation = view.result.current.confirmCancel(row, input) })
  f.account = 'B'; view.rerender()
  await act(async () => { finish(); await operation })
  expect(f.decide).toHaveBeenCalledWith('A', 'real-id', 'cancel')
  expect(f.save).toHaveBeenCalledWith('A', 'real-id', { expectedVersion: 1, cancellationReason: '店舗都合' })
})
it('理由の保存後に取消の結果を確認できない時は、対象切替後でも知らせる', async () => {
  f.save.mockResolvedValue({ success: true })
  let fail!: () => void
  f.decide.mockReturnValue(new Promise((_, reject) => { fail = () => reject(new Error('network')) }))
  const view = renderHook(() => useStyleDashboard('salon'))
  act(() => view.result.current.setCancelRow(row))
  let operation!: Promise<void>
  act(() => { operation = view.result.current.confirmCancel(row, input) })
  await waitFor(() => expect(f.decide).toHaveBeenCalledTimes(1))
  f.account = 'B'; view.rerender()
  await act(async () => { fail(); await operation })
  await waitFor(() => expect(f.toast).toHaveBeenCalledWith(expect.stringContaining('理由は保存されましたが、取消の結果を確認できません'), { tone: 'error' }))
})
