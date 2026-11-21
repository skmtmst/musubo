// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import { reservation } from '../booking-kit/test-data'
import type { ReservationEditSaveResult } from './edit-save-result'
const callbacks = vi.hoisted(() => ({ submit: null as (() => unknown) | null }))
vi.mock('@/v8/restaurant/booking-kit/public/parts/index', async importOriginal => {
  const original = await importOriginal<typeof import('@/v8/restaurant/booking-kit/public/parts/index')>()
  const react = await import('react')
  return { ...original, RsDialog: (props: React.ComponentProps<typeof original.RsDialog>) => { callbacks.submit = props.onSubmit ?? null; return react.createElement(original.RsDialog, props) } }
})
import { EditReservationDialog } from './dialogs'
afterEach(cleanup)
const row = reservation('synthetic', { starts_at: '2026-11-02T09:00:00.000Z', ends_at: '2026-11-02T11:00:00.000Z' })
function props(onSave: (patch: Record<string, unknown>) => Promise<ReservationEditSaveResult>) {
  return { reservation: row, accountId: 'account-1', storeId: 'store', tables: [], courses: [], busy: false, canWrite: true, onClose() {}, onSave, onCancelReservation() {}, onRestore() {} }
}
it('同じ描画の二度の確定でも保存は1回だけ', async () => {
  let release!: (value: ReservationEditSaveResult) => void
  const pending = new Promise<ReservationEditSaveResult>(resolve => { release = resolve })
  const save = vi.fn(() => pending)
  render(<EditReservationDialog {...props(save)} />)
  const callback = callbacks.submit!
  let first: unknown, second: unknown
  await act(async () => { first = callback(); second = callback() })
  try { expect(save).toHaveBeenCalledTimes(1) }
  finally { await act(async () => { release({ saved: false }); await Promise.all([first, second]) }) }
})
it('古い確定口も現在の入力と保存口を読む', async () => {
  const oldSave = vi.fn(async () => ({ saved: true })), latestSave = vi.fn(async () => ({ saved: true }))
  const view = render(<EditReservationDialog {...props(oldSave)} />)
  const old = callbacks.submit!
  fireEvent.change(screen.getByLabelText('人数'), { target: { value: '7' } })
  view.rerender(<EditReservationDialog {...props(latestSave)} />)
  await act(async () => { await old() })
  expect(oldSave).not.toHaveBeenCalled()
  expect(latestSave).toHaveBeenCalledWith(expect.objectContaining({ guestCount: 7, startsAt: row.starts_at, endsAt: row.ends_at }))
})
it.each([{ busy: true, canWrite: true }, { busy: false, canWrite: false }])('古い確定口も現在の処理中・権限を守る %j', async change => {
  const save = vi.fn(async () => ({ saved: true }))
  const view = render(<EditReservationDialog {...props(save)} />)
  const old = callbacks.submit!
  view.rerender(<EditReservationDialog {...props(save)} {...change} />)
  await act(async () => { await old() })
  expect(save).not.toHaveBeenCalled()
})
it('次の保存を始めると前の局所理由を消す', async () => {
  let release!: (value: ReservationEditSaveResult) => void
  const save = vi.fn<ReturnType<typeof props>['onSave']>()
    .mockResolvedValueOnce({ saved: false, inputError: new ApiError(409, '人数を確認してください。', 'availability_conflict') })
    .mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  render(<EditReservationDialog {...props(save)} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存する' })) })
  expect(screen.getByRole('alert').textContent).toContain('人数を確認してください。')
  let second: unknown
  await act(async () => { second = callbacks.submit!() })
  expect(screen.queryByRole('alert')).toBeNull()
  await act(async () => { release({ saved: true }); await second })
})
it('別の版を受け取った後は古い確定口でも上書きしない', async () => {
  const save = vi.fn(async () => ({ saved: true }))
  const view = render(<EditReservationDialog {...props(save)} />)
  const old = callbacks.submit!
  fireEvent.change(screen.getByLabelText('人数'), { target: { value: '7' } })
  view.rerender(<EditReservationDialog {...props(save)} reservation={{ ...row, customer_version: 2, guest_count: 3 }} />)
  expect((screen.getByLabelText('人数') as HTMLInputElement).value).toBe('7')
  expect(screen.getByText(/別の操作で予約が変更されたか/)).toBeTruthy()
  await act(async () => { await old() })
  expect(save).not.toHaveBeenCalled()
})
it('卓の重複を欄に示し空いている卓を選べる', async () => {
  const { restaurantTestApi } = await import('@/lib/restaurant-test-api')
  const { tables } = await import('../booking-kit/test-data')
  const lookup = vi.spyOn(restaurantTestApi, 'seatAvailability').mockResolvedValue({ success: true, data: { storeId: 'store', startsAt: row.starts_at, endsAt: row.ends_at, guestCount: 2, tables: [{ id: tables[1].id, label: tables[1].label, minCapacity: 1, maxCapacity: 4 }] } })
  const save = vi.fn().mockRejectedValueOnce(new ApiError(409, '重複', 'table_conflict')).mockResolvedValue({ saved: true })
  render(<EditReservationDialog {...props(save)} reservation={{ ...row, table_id: tables[0].id }} tables={tables} />)
  await act(async () => { await callbacks.submit!() })
  expect(screen.getByText(`${tables[0].code} はこの時間に別の予約があります`)).toBeTruthy()
  expect(screen.getByLabelText('卓').getAttribute('aria-invalid')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: tables[1].code }))
  await act(async () => { await callbacks.submit!() })
  expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ tableId: tables[1].id }))
  lookup.mockRestore()
})
it('空き卓がないときは案内し、人数を変えると古い案内を消す', async () => {
  const { restaurantTestApi } = await import('@/lib/restaurant-test-api')
  const lookup = vi.spyOn(restaurantTestApi, 'seatAvailability').mockResolvedValue({ success: true, data: { storeId: 'store', startsAt: row.starts_at, endsAt: row.ends_at, guestCount: 2, tables: [] } })
  const save = vi.fn().mockRejectedValue(new ApiError(409, '重複', 'table_conflict'))
  render(<EditReservationDialog {...props(save)} />)
  await act(async () => { await callbacks.submit!() })
  expect(screen.getByRole('dialog').textContent).toContain('この時間に空いている卓はありません')
  fireEvent.change(screen.getByLabelText('人数'), { target: { value: '3' } })
  expect(screen.getByRole('dialog').textContent).not.toContain('この時間に空いている卓はありません')
  lookup.mockRestore()
})

it('保存中に名前を変えても卓の重複を知らせる', async () => {
  const { restaurantTestApi } = await import('@/lib/restaurant-test-api')
  const lookup = vi.spyOn(restaurantTestApi, 'seatAvailability').mockResolvedValue({ success: true, data: { storeId: 'store', startsAt: row.starts_at, endsAt: row.ends_at, guestCount: 2, tables: [] } })
  let reject!: (reason: unknown) => void
  const save = vi.fn(() => new Promise<ReservationEditSaveResult>((_, fail) => { reject = fail }))
  render(<EditReservationDialog {...props(save)} />)
  let pending: unknown
  await act(async () => { pending = callbacks.submit!() })
  fireEvent.change(screen.getByLabelText('お客様名'), { target: { value: '別の名前' } })
  await act(async () => { reject(new ApiError(409, '重複', 'table_conflict')); await pending })
  expect(screen.getByRole('dialog').textContent).toContain('この時間に別の予約があります')
  lookup.mockRestore()
})
it('空き照会の応答が不正なら候補の読み込み失敗を知らせる', async () => {
  const { restaurantTestApi } = await import('@/lib/restaurant-test-api')
  const lookup = vi.spyOn(restaurantTestApi, 'seatAvailability').mockResolvedValue({ success: true } as never)
  const save = vi.fn().mockRejectedValue(new ApiError(409, '重複', 'table_conflict'))
  render(<EditReservationDialog {...props(save)} />)
  await act(async () => { await callbacks.submit!() })
  expect(screen.getByText('空いている卓を読み込めませんでした。もう一度保存してください。')).toBeTruthy()
  lookup.mockRestore()
})
