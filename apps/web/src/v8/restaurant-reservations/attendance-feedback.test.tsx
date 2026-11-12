// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: { customerHistory: vi.fn().mockResolvedValue({ data: { visitCount: 0, visits: [] } }) } }))
const captured = vi.hoisted(() => ({ visit: null as null | (() => void) }))
vi.mock('@/components/shared/button', async original => {
  const actual = await original<typeof import('@/components/shared/button')>()
  return { ...actual, default: (props: React.ComponentProps<typeof actual.default>) => {
    if (props.children === '来店にする') captured.visit = props.onClick as () => void
    return <actual.default {...props} />
  } }
})
import ReservationDetailDialog from './detail-dialog'
import { ApiError } from '@/lib/api'
import { reservation, snapshotOf } from '../restaurant/booking-kit/test-data'
import type { RestaurantReservation } from '@/lib/restaurant-test-api'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'

afterEach(() => { cleanup(); verifiedStaffRole(null); vi.clearAllMocks() })
it('切替前の来店操作は呼び戻されても実行しない', async () => {
  verifiedStaffRole('owner')
  const data = snapshotOf()
  const row = reservation('r1', { arrived_at: null, departed_at: null }) as RestaurantReservation
  const attendance = vi.fn()
  const props = { reservation: row, accountId: 'account-1', tables: data.tables, courses: data.menuItems, busy: false, canWrite: true, onClose: vi.fn(), onCancel: vi.fn(), onRestore: vi.fn(), onEdit: vi.fn(), onAttendance: attendance }
  const view = render(<ReservationDetailDialog {...props} />)
  const previous = captured.visit!
  expect(previous).toBeTypeOf('function')
  view.rerender(<ReservationDetailDialog {...props} reservation={{ ...row, id: 'r2' }} />)
  await act(async () => previous())
  expect(attendance).not.toHaveBeenCalled()
})

it('切替後に前の来店の失敗が届いても状態を更新しない', async () => {
  verifiedStaffRole('owner')
  const data = snapshotOf()
  const row = reservation('r1', { arrived_at: null, departed_at: null }) as RestaurantReservation
  let finish!: (value: { error: Error }) => void
  const attendance = vi.fn(() => new Promise<{ error: Error }>(resolve => { finish = resolve }))
  const props = { reservation: row, accountId: 'account-1', tables: data.tables, courses: data.menuItems, busy: false, canWrite: true, onClose: vi.fn(), onCancel: vi.fn(), onRestore: vi.fn(), onEdit: vi.fn(), onAttendance: attendance }
  const onRender = vi.fn()
  const view = render(<React.Profiler id="detail" onRender={onRender}><ReservationDetailDialog {...props} /></React.Profiler>)
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '来店にする', exact: true }))
  view.rerender(<React.Profiler id="detail" onRender={onRender}><ReservationDetailDialog {...props} reservation={{ ...row, id: 'r2' }} /></React.Profiler>)
  await act(async () => {})
  onRender.mockClear()
  await act(async () => finish({ error: new ApiError(409, '古い予約', 'version_conflict') }))
  expect(onRender).not.toHaveBeenCalled()
  expect(screen.queryByRole('alert')).toBeNull()
})
it('来店の失敗理由を予約の詳細の中に表示する', async () => {
  verifiedStaffRole('owner')
  const data = snapshotOf()
  const row = reservation('r1', { customer_name: '架空のお客さま', arrived_at: null, departed_at: null }) as RestaurantReservation
  const attendance = vi.fn().mockResolvedValue({ error: new ApiError(409, '最新の予約を確認してください。', 'version_conflict') })
  render(<ReservationDetailDialog reservation={row} accountId="account-1" tables={data.tables} courses={data.menuItems} busy={false} canWrite onClose={vi.fn()} onCancel={vi.fn()} onRestore={vi.fn()} onEdit={vi.fn()} onAttendance={attendance} />)
  const dialog = screen.getByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: '来店にする', exact: true }))
  expect(attendance).toHaveBeenCalledOnce()
  expect((await within(dialog).findByRole('alert')).textContent).toContain('ほかの操作で予約が変わりました。読み直してから、もう一度選んでください。')
})

it('詳細を切り替えた後に前の予約の失敗を表示しない', async () => {
  verifiedStaffRole('owner')
  const data = snapshotOf()
  const row = reservation('r1', { customer_name: '架空のお客さま', arrived_at: null, departed_at: null }) as RestaurantReservation
  let finish!: (value: { error: Error }) => void
  const attendance = vi.fn(() => new Promise<{ error: Error }>((resolve) => { finish = resolve }))
  const props = { reservation: row, accountId: 'account-1', tables: data.tables, courses: data.menuItems, busy: false, canWrite: true, onClose: vi.fn(), onCancel: vi.fn(), onRestore: vi.fn(), onEdit: vi.fn(), onAttendance: attendance }
  const view = render(<ReservationDetailDialog {...props} />)
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '来店にする', exact: true }))
  view.rerender(<ReservationDetailDialog {...props} reservation={{ ...row, id: 'r2', customer_name: '別の架空のお客さま' }} />)
  finish({ error: new ApiError(409, '前の予約の失敗です。', 'version_conflict') })
  await Promise.resolve()
  expect(screen.queryByText('前の予約の失敗です。')).toBeNull()
})

it('予約詳細は操作を2ボタンとその他にまとめる', async () => {
  verifiedStaffRole('owner')
  const data = snapshotOf()
  const row = reservation('r1', { customer_name: '架空のお客さま', status: 'confirmed', arrived_at: null, departed_at: null }) as RestaurantReservation
  render(<ReservationDetailDialog reservation={row} accountId="account-1" tables={data.tables} courses={data.menuItems} busy={false} canWrite onClose={vi.fn()} onCancel={vi.fn()} onRestore={vi.fn()} onEdit={vi.fn()} onAttendance={vi.fn()} />)
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).queryByRole('button', { name: '無断にする' })).toBeNull()
  expect(within(dialog).queryByRole('button', { name: '取り消す' })).toBeNull()
  expect(within(dialog).getAllByRole('button', { name: '閉じる' })).toHaveLength(1)
  fireEvent.click(within(dialog).getByRole('button', { name: '架空のお客さまのその他操作' }))
  expect(await screen.findByRole('menuitem', { name: '無断にする' })).toBeTruthy()
  expect(screen.getByRole('menuitem', { name: '取り消す' }).className).toMatch(/danger/)
})

it('競合時は理由と読み直しを示す', async () => {
  verifiedStaffRole('owner')
  const data = snapshotOf()
  const row = reservation('r1', { customer_name: '架空のお客さま', arrived_at: null, departed_at: null }) as RestaurantReservation
  const reload = vi.fn()
  render(<ReservationDetailDialog reservation={row} accountId="account-1" tables={data.tables} courses={data.menuItems} busy={false} canWrite onClose={vi.fn()} onCancel={vi.fn()} onRestore={vi.fn()} onEdit={vi.fn()} onReload={reload} onAttendance={vi.fn().mockResolvedValue({ error: new ApiError(409, '最新の予約を確認してください。', 'version_conflict') })} />)
  const dialog = screen.getByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: '来店にする' }))
  expect((await within(dialog).findByRole('alert')).textContent).toContain('ほかの操作で予約が変わりました。読み直してから、もう一度選んでください。')
  fireEvent.click(within(dialog).getByRole('button', { name: '読み直す' }))
  expect(reload).toHaveBeenCalledOnce()
})

it.each([
  ['confirmed', null, '来店にする', '内容を変える', '無断にする'],
  ['pending', null, '来店にする', '内容を変える', '無断にする'],
  ['visited', null, '退店にする', '内容を変える', '来店を取り消す'],
  ['visited', '2026-10-01T12:00:00Z', null, '内容を変える', '退店を訂正する'],
  ['cancelled', null, null, '予約を有効に戻す', null],
  ['no_show', null, null, '予約を有効に戻す', null],
] as const)('予約状態 %s の操作を維持する', async (status, departed, secondary, primary, menuItem) => {
  verifiedStaffRole('owner')
  const data = snapshotOf()
  const row = reservation('r1', { customer_name: '架空のお客さま', status, departed_at: departed }) as RestaurantReservation
  render(<ReservationDetailDialog reservation={row} accountId="account-1" tables={data.tables} courses={data.menuItems} busy={false} canWrite onClose={vi.fn()} onCancel={vi.fn()} onRestore={vi.fn()} onEdit={vi.fn()} onAttendance={vi.fn()} />)
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByRole('button', { name: primary })).toBeTruthy()
  if (secondary) expect(within(dialog).getByRole('button', { name: secondary })).toBeTruthy()
  else expect(within(dialog).queryByRole('button', { name: /^(来店|退店)にする$/ })).toBeNull()
  if (!menuItem) expect(within(dialog).queryByRole('button', { name: '架空のお客さまのその他操作' })).toBeNull()
  if (menuItem) {
    fireEvent.click(within(dialog).getByRole('button', { name: '架空のお客さまのその他操作' }))
    expect(await screen.findByRole('menuitem', { name: menuItem })).toBeTruthy()
    if (status === 'visited' && departed) expect(screen.queryByRole('menuitem', { name: '来店を取り消す' })).toBeNull()
    if (status === 'visited' && !departed) expect(screen.queryByRole('menuitem', { name: '無断にする' })).toBeNull()
  }
})
