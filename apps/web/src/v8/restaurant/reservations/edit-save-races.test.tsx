// @vitest-environment happy-dom

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  snapshot: vi.fn(), reservationsDay: vi.fn(), updateReservation: vi.fn(), createReservation: vi.fn(), holdReservation: vi.fn(),
  floors: vi.fn(), importReservation: vi.fn(), openingHours: vi.fn(), customerSearch: vi.fn(), customerHistory: vi.fn(),
}))
const stores = vi.hoisted(() => ({ select: null as ((id: string) => void) | null }))
vi.mock('@/components/shared/entity-select', async importOriginal => {
  const original = await importOriginal<typeof import('@/components/shared/entity-select')>()
  const react = await import('react')
  return { ...original, default: (props: React.ComponentProps<typeof original.default>) => { if (props['aria-label'] === '店舗') stores.select = props.onChange as (id: string) => void; return react.createElement(original.default, props) } }
})
const account = vi.hoisted(() => ({ value: 'account-1' }))
const list = vi.hoisted(() => ({ edit: null as ((id: string) => void) | null }))
vi.mock('./list', async importOriginal => {
  const original = await importOriginal<typeof import('./list')>()
  const react = await import('react')
  return { ...original, default: (props: React.ComponentProps<typeof original.default>) => { list.edit = props.onEdit; return react.createElement(original.default, props) } }
})
const editor = vi.hoisted(() => ({ current: null as React.ComponentProps<typeof import('./dialogs').EditReservationDialog> | null }))
const cancellation = vi.hoisted(() => ({ current: null as React.ComponentProps<typeof import('./dialogs').CancelReservationDialog> | null }))
vi.mock('./dialogs', async importOriginal => {
  const original = await importOriginal<typeof import('./dialogs')>()
  const react = await import('react')
  return { ...original, EditReservationDialog: (props: React.ComponentProps<typeof original.EditReservationDialog>) => { editor.current = props; return react.createElement(original.EditReservationDialog, props) }, CancelReservationDialog: (props: React.ComponentProps<typeof original.CancelReservationDialog>) => { cancellation.current = props; return react.createElement(original.CancelReservationDialog, props) } }
})
const role = vi.hoisted(() => ({ value: 'owner' as string | null }))

vi.mock('@/lib/api/helpers/reservation-board',async importOriginal=>{const original=await importOriginal<typeof import('@/lib/api/helpers/reservation-board')>();return {...original,reservationBoardApi:{...original.reservationBoardApi,floors:fixture.floors}}})
vi.mock('next/navigation', () => ({ useRouter: () => ({ push() {}, replace() {}, prefetch() {} }), usePathname: () => '/restaurant-test/reservations', useSearchParams: () => new URLSearchParams() }))
vi.mock('@/contexts/account-context', async importOriginal => ({ ...await importOriginal<typeof import('@/contexts/account-context')>(), useAccount: () => ({ selectedAccountId: account.value, accounts: [] }) }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: fixture }))
vi.mock('@/lib/staff-role', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/staff-role')>(), useStaffRole: () => role.value, canManageRole: (r: string | null) => r === 'owner' || r === 'admin' }))

import ReservationsPage from './reservations'
import { useStaffIdentity } from '@/lib/staff-role'
// 実アプリの外枠と同じく、編集窓を閉じても本人確認の購読を維持する。
function TestPage() { useStaffIdentity(); return <ReservationsPage /> }
import { ApiError } from '@/lib/api'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetSessionSnapshot } from '@/lib/session-snapshot'
import { at, reservation, snapshotOf, store } from '../booking-kit/test-data'

/* 今日：佐藤（LINE・T1）・山田（食べログ・承認待ち・T3・乳）・押さえ（T4）。 */
const reservationsToday = () => [
  reservation('r1', { customer_name: '見本 114', source: 'line', starts_at: at(0, 18), ends_at: at(0, 20), table_id: 't1' }),
  reservation('r2', { customer_name: '見本 141', source: 'tabelog', status: 'pending', allergy_note: '乳', guest_count: 4, starts_at: at(0, 18, 30), ends_at: at(0, 20, 30), table_id: 't3', course_name: 'おまかせコース' }),
  reservation('r3', { customer_name: '押さえ', source: 'phone', status: 'pending', hold_expires_at: at(0, 23), note: '電話のお客さま用', guest_count: 4, starts_at: at(0, 20), ends_at: at(0, 21, 30), table_id: 't4' }),
]

let today: ReturnType<typeof reservationsToday>

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T12:00:00+09:00'))
  today = reservationsToday()
  account.value = 'account-1'
  editor.current = null
  role.value = verifiedStaffRole('owner')
  fixture.floors.mockResolvedValue({success:true,data:[]})
  fixture.snapshot.mockResolvedValue({ success: true, data: snapshotOf({ stores: [store, { ...store, id: 'store-2', name: '別の店' }], reservations: today, reservationTotal: 3 }) })
  fixture.reservationsDay.mockResolvedValue({ data: { date: '', reservations: today } })
  fixture.openingHours.mockResolvedValue({ data: { storeId: 'store-1', hours: null, version: 1, updatedBy: null, updatedAt: null } })
  for (const fn of [fixture.updateReservation, fixture.importReservation]) fn.mockResolvedValue({ success: true })
  fixture.createReservation.mockResolvedValue({ success: true, data: { id: 'new', tableId: 't2', lineNotice: { sent: true, reason: null } } })
  fixture.customerSearch.mockResolvedValue({ data: [] })
  fixture.customerHistory.mockResolvedValue({ data: { visitCount: 0, visits: [] } })
})
afterEach(() => { cleanup(); verifiedStaffRole(null); forgetSessionSnapshot(); vi.useRealTimers(); vi.clearAllMocks() })



function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
async function openEdit() {
  const view = render(<TestPage />)
  await screen.findByText('見本 141')
  fireEvent.click(screen.getByRole('button', { name: '一覧', exact: true }))
  await changeTarget('見本 114')
  fireEvent.change(screen.getByLabelText('人数'), { target: { value: '9' } })
  return view
}
async function changeTarget(name: string) {
  const row = screen.getByRole('button', { name, exact: true }).closest('tr')!
  fireEvent.click(within(row).getByRole('button', { name: `${name}のその他操作` }))
  fireEvent.click(screen.getByRole('menuitem', { name: '変更', exact: true }))
  await waitFor(() => expect(editor.current?.reservation?.customer_name).toBe(name))
}
const submit = () => fireEvent.click(screen.getByRole('button', { name: '保存する' }))
it('アカウントAからBへ切り替えた描画で編集を閉じ、Aへ戻っても復活しない', async () => {
  const view = await openEdit()
  account.value = 'account-2'
  view.rerender(<TestPage />)
  expect(screen.queryByRole('dialog')).toBeNull()
  account.value = 'account-1'
  view.rerender(<TestPage />)
  expect(screen.queryByRole('dialog')).toBeNull()
})
it('取消の窓はアカウントを変えた後に復活せず、古い確定口は使えない', async () => {
  const view = await openEdit()
  await act(async () => { editor.current!.onCancelReservation('r1') })
  const oldConfirm = cancellation.current!.onConfirm
  expect(cancellation.current?.reservation?.id).toBe('r1')
  account.value = 'account-2'
  view.rerender(<TestPage />)
  expect(cancellation.current?.reservation).toBeNull()
  account.value = 'account-1'
  view.rerender(<TestPage />)
  expect(cancellation.current?.reservation).toBeNull()
  await act(async () => { await oldConfirm('r1') })
  expect(fixture.updateReservation).not.toHaveBeenCalled()
})
it('店舗を切り替えると編集を閉じ、元の店へ戻っても復活しない', async () => {
  await openEdit()
  await act(async () => { stores.select!('store-2') })
  expect(screen.queryByRole('dialog')).toBeNull()
  await act(async () => { stores.select!('store-1') })
  expect(screen.queryByRole('dialog')).toBeNull()
})
it('別の予約を開いた後の古い保存口からは書き込まない', async () => {
  await openEdit()
  const old = editor.current!.onSave
  await act(async () => { editor.current!.onClose(); list.edit!('r2') })
  await act(async () => { await old({ guestCount: 9 }) })
  expect(fixture.updateReservation).not.toHaveBeenCalled()
  expect((screen.getByLabelText('人数') as HTMLInputElement).value).toBe('4')
})
it.each(['成功', '入力失敗', '通信失敗'] as const)('古い%s応答は切替後の編集へ理由や入力を渡さない', async outcome => {
  const pending = deferred<{ success: boolean }>()
  fixture.updateReservation.mockReturnValueOnce(pending.promise)
  const view = await openEdit()
  await act(async () => { submit() })
  account.value = 'account-2'
  view.rerender(<TestPage />)
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  // 外からのアカウント切替に伴う再取得を待ち、別の予約を開く。
  await screen.findByRole('button', { name: '見本 141', exact: true })
  await act(async () => { list.edit!('r2') })
  const reopened = screen.getByRole('dialog')
  const reads = fixture.snapshot.mock.calls.length
  await act(async () => { if (outcome === '成功') pending.resolve({ success: true }); else pending.reject(outcome === '入力失敗' ? new ApiError(409, '古い入力の理由', 'availability_conflict') : new ApiError(500)); await pending.promise.catch(() => {}) })
  expect(screen.queryByRole('dialog')).toBe(reopened)
  expect((within(reopened).getByLabelText('人数') as HTMLInputElement).value).toBe('4')
  expect(screen.queryByText('古い入力の理由', { exact: false })).toBeNull()
  expect(document.querySelectorAll('[data-design-part=notice]')).toHaveLength(0)
  expect(fixture.snapshot).toHaveBeenCalledTimes(reads)
})
it('成功後の読み直し待ちで別予約を開いても古い完了が新しい窓を閉じない', async () => {
  const reload = deferred<{ success: boolean; data: ReturnType<typeof snapshotOf> }>()
  await openEdit()
  fixture.snapshot.mockReturnValueOnce(reload.promise)
  const readsBefore = fixture.snapshot.mock.calls.length
  await act(async () => { submit() })
  await waitFor(() => expect(fixture.snapshot).toHaveBeenCalledTimes(readsBefore + 1))
  // busyの間の通常操作は無効。外側からの対象変更を、実ページのcallbackで再現する。
  await act(async () => { editor.current!.onClose() })
  // 通常の押し口のbusy制限は維持し、実一覧のcallbackを直接呼んで遅い応答の境界を観測する。
  await act(async () => { list.edit!('r2') })
  const reopened = screen.getByRole('dialog')
  await act(async () => { reload.resolve({ success: true, data: snapshotOf({ stores: [store, { ...store, id: 'store-2', name: '別の店' }], reservations: today, reservationTotal: 3 }) }); await reload.promise })
  expect(screen.queryByRole('dialog')).toBe(reopened)
  expect((within(reopened).getByLabelText('人数') as HTMLInputElement).value).toBe('4')
})
