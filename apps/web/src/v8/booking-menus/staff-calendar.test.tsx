// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

/* 担当スタッフのつなぐ先（B7・uRd8A・GcYWx）：読み込み・書き込みは別々に保存、書き込みのオフは確かめの窓を通す。閲覧のみは押せるものを置かない。 */

const net = vi.hoisted(() => ({ getSwitches: vi.fn(), saveSwitches: vi.fn(), getStaffUrl: vi.fn(), saveStaffUrl: vi.fn() }))
vi.mock('@/lib/api/helpers/gap1', async (load) => {
  const actual = await load<typeof import('@/lib/api/helpers/gap1')>()
  return { ...actual, bookingCalendarApi: { ...actual.bookingCalendarApi, ...net } }
})
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/booking/menus', useSearchParams: () => new URLSearchParams() }))

const { StaffCalendarPanel } = await import('./staff-calendar')
const person = { id: 'bs-1', name: '見本 110', display_name: '佐々木', role: 'トリマー' } as never
const SWITCH = { readEnabled: true, writeEnabled: true, version: 3, connected: true, futureEventCount: 12 }

beforeEach(() => {
  net.getSwitches.mockResolvedValue({ success: true, data: SWITCH })
  net.saveSwitches.mockImplementation(async (_id, input) => ({ success: true, data: { ...SWITCH, ...input, version: 4 } }))
  net.getStaffUrl.mockResolvedValue({ success: true, data: { url: 'https://meet.google.com/abc', version: 1 } })
  net.saveStaffUrl.mockResolvedValue({ success: true, data: { url: 'https://meet.google.com/xyz', version: 2 } })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('書き込みをオフにするときは確かめの窓で「先の予定を消す」を選び、confirmed と removeFutureEvents を版つきで送る', async () => {
  render(<StaffCalendarPanel accountId="acc-1" person={person} menuCount={4} canEdit onClose={() => undefined} />)
  fireEvent.click(await screen.findByRole('switch', { name: 'Google カレンダーの書き込み' }))
  expect(net.saveSwitches).not.toHaveBeenCalled()
  fireEvent.click(await screen.findByRole('radio', { name: /これから先の予約の予定を消す（12 件）/ }))
  fireEvent.click(screen.getByRole('button', { name: '書き込みをオフにする' }))
  await waitFor(() => expect(net.saveSwitches).toHaveBeenCalledWith('acc-1', { readEnabled: true, writeEnabled: false, expectedVersion: 3, confirmed: true, removeFutureEvents: true }, 'bs-1'))
})

it('読み込みは確かめなしで、そのスタッフの切り替えとして保存する', async () => {
  render(<StaffCalendarPanel accountId="acc-1" person={person} menuCount={4} canEdit onClose={() => undefined} />)
  fireEvent.click(await screen.findByRole('switch', { name: 'Google カレンダーの読み込み' }))
  await waitFor(() => expect(net.saveSwitches).toHaveBeenCalledWith('acc-1', { readEnabled: false, writeEnabled: true, expectedVersion: 3 }, 'bs-1'))
})

it('閲覧のみは切り替え・つなぐ・URL の入力を置かず、文字で出す', async () => {
  render(<StaffCalendarPanel accountId="acc-1" person={person} menuCount={4} canEdit={false} onClose={() => undefined} />)
  expect(await screen.findByText('https://meet.google.com/abc')).toBeTruthy()
  expect(screen.queryByRole('switch')).toBeNull()
  // 隠さず灰色＋理由。出ているなら押せない。
  for (const el of screen.queryAllByRole('button', { name: 'つなぐ' })) expect(((el: HTMLElement) => el.getAttribute('aria-disabled') === 'true' || (el as HTMLButtonElement).disabled)(el)).toBe(true)
  expect(screen.queryByRole('textbox')).toBeNull()
})

it('固定の会議URLの保存が欄の理由を返したら、入力を残してその欄に表示する', async () => {
  net.saveStaffUrl.mockRejectedValue({ status: 422, fields: { url: 'この会議のURLは使えません' } })
  render(<StaffCalendarPanel accountId="acc-1" person={person} menuCount={4} canEdit onClose={() => undefined} />)
  const field = await screen.findByRole('textbox', { name: '固定の会議の URL' })
  fireEvent.change(field, { target: { value: 'https://meet.google.com/changed' } })
  fireEvent.click(screen.getByRole('button', { name: '保存する' }))
  expect(await screen.findByText('この会議のURLは使えません')).toBeTruthy()
  expect(field.getAttribute('aria-invalid')).toBe('true')
  expect((field as HTMLInputElement).value).toBe('https://meet.google.com/changed')
})

it('会議URLの保存は下の操作帯に置き、まとまりの読み上げ名も保つ', async () => {
  render(<StaffCalendarPanel accountId="acc-1" person={person} menuCount={4} canEdit onClose={() => undefined} />)
  const field = await screen.findByRole('textbox', { name: '固定の会議の URL' })
  expect(screen.getByRole('region', { name: 'カレンダー' })).toBeTruthy()
  expect(screen.getByRole('region', { name: '会議の URL' })).toBeTruthy()
  fireEvent.change(field, { target: { value: 'https://meet.example.invalid/new' } })
  const save = screen.getByRole('button', { name: '保存する' })
  expect(save.closest('footer')?.querySelector('[data-detail-actions]')).toBeTruthy()
  expect(document.querySelector('[data-detail-content] [data-variant="primary"]')).toBeNull()
  fireEvent.click(save)
  await waitFor(() => expect(net.saveStaffUrl).toHaveBeenCalledWith('acc-1', 'bs-1', 'https://meet.example.invalid/new', 1))
})
it('会議URLを読めないときは無いと見せず、その部分を読み直せる', async () => {
  net.getStaffUrl.mockRejectedValueOnce(new Error('offline'))
  render(<StaffCalendarPanel accountId="acc-1" person={person} menuCount={4} canEdit={false} onClose={() => undefined} />)
  expect(await screen.findByText('会議の URL を読み込めませんでした。')).toBeTruthy()
  expect(screen.queryByText('固定の URL はありません')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '会議URLを読み直す' }))
  expect(await screen.findByText('https://meet.google.com/abc')).toBeTruthy()
  expect(net.getSwitches).toHaveBeenCalledTimes(2)
  expect(net.getStaffUrl).toHaveBeenCalledTimes(2)
})
it('店全体の設定を読み直しても会議URLの入力は残る', async () => {
  net.getSwitches.mockImplementation(async (_account, staff) => {
    if (!staff && net.getSwitches.mock.calls.filter(call => !call[1]).length === 1) throw new Error('offline')
    return { success: true, data: SWITCH }
  })
  render(<StaffCalendarPanel accountId="acc-1" person={person} menuCount={4} canEdit onClose={() => undefined} />)
  const field = await screen.findByRole<HTMLInputElement>('textbox', { name: '固定の会議の URL' })
  expect(screen.getByText('店全体の設定を読み込めませんでした。')).toBeTruthy()
  fireEvent.change(field, { target: { value: 'https://meet.google.com/edited' } })
  fireEvent.click(screen.getByRole('button', { name: '店全体の設定を読み直す' }))
  await waitFor(() => expect(screen.queryByText('店全体の設定を読み込めませんでした。')).toBeNull())
  expect(field.value).toBe('https://meet.google.com/edited')
  expect(net.getStaffUrl).toHaveBeenCalledTimes(1)
})
it('担当者切替後に前の会議URLの応答を出さない', async () => {
  let resolveOld!: (value: unknown) => void
  net.getStaffUrl.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    .mockResolvedValueOnce({ success: true, data: { url: 'https://meet.google.com/new', version: 2 } })
  const nextPerson = { id: 'bs-2', name: '別の担当者' } as never
  const view = render(<StaffCalendarPanel accountId="acc-1" person={person} menuCount={4} canEdit onClose={() => undefined} />)
  view.rerender(<StaffCalendarPanel accountId="acc-1" person={nextPerson} menuCount={4} canEdit onClose={() => undefined} />)
  const field = await screen.findByRole<HTMLInputElement>('textbox', { name: '固定の会議の URL' })
  expect(field.value).toBe('https://meet.google.com/new')
  await act(async () => { resolveOld({ success: true, data: { url: 'https://meet.google.com/old', version: 1 } }) })
  expect(field.value).toBe('https://meet.google.com/new')
})
it('閲覧の権限がない設定は権限不足を知らせ、読み直しを勧めない', async () => {
  const { ApiError } = await import('@/lib/api')
  net.getSwitches.mockImplementation(async (_account, staff) => {
    if (!staff) throw new ApiError(403, 'forbidden')
    return { success: true, data: SWITCH }
  })
  net.getStaffUrl.mockRejectedValue(new ApiError(403, 'forbidden'))
  render(<StaffCalendarPanel accountId="acc-1" person={person} menuCount={4} canEdit={false} onClose={() => undefined} />)
  expect(await screen.findByText('店全体の設定を見る権限がありません。')).toBeTruthy()
  expect(screen.getByText('会議の URL を見る権限がありません。')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '店全体の設定を読み直す' })).toBeNull()
  expect(screen.queryByRole('button', { name: '会議URLを読み直す' })).toBeNull()
  expect(screen.queryByText('固定の URL はありません')).toBeNull()
})
