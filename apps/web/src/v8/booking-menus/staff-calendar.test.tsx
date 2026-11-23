// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

/* 担当スタッフのつなぐ先（B7・uRd8A・GcYWx）：読み込み・書き込みは別々に保存、書き込みのオフは確かめの窓を通す。閲覧のみは押せるものを置かない。 */

const net = vi.hoisted(() => ({ getSwitches: vi.fn(), saveSwitches: vi.fn(), getStaffUrl: vi.fn(), saveStaffUrl: vi.fn(), connection: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), prefer: vi.fn() }))
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
  net.connection.mockImplementation(async (_id, _staff, provider) => ({ data: { state: provider === 'outlook' ? 'ready' : 'missing', preferred: false, mode: 'configured' } }))
  net.disconnect.mockResolvedValue({ data: { disconnected: true } })
})

it('Outlook の切断は確認してから送る', async () => {
  render(<StaffCalendarPanel accountId="acc-1" person={person} menuCount={4} canEdit onClose={() => undefined} />)
  fireEvent.click(await screen.findByRole('button', { name: '切る' }))
  expect(net.disconnect).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '接続を切る' }))
  await waitFor(() => expect(net.disconnect).toHaveBeenCalledWith('acc-1', 'bs-1', 'outlook'))
})

it('Outlook が読めない理由を表示する', async () => {
  net.getSwitches.mockResolvedValue({ data: { ...SWITCH, health: { error_code: 'outlook_test_staff_required', failed_since: null, last_success_at: null } } })
  render(<StaffCalendarPanel accountId="acc-1" person={person} menuCount={4} canEdit onClose={() => undefined} />)
  expect(await screen.findByText('担当者本人をテスト送信の相手に登録してください。')).toBeTruthy()
})
it('Outlook が切れているときはつなぎ直しを案内する', async () => {
  net.connection.mockImplementation(async (_id, _staff, provider) => ({ data: { state: provider === 'outlook' ? 'unknown' : 'missing', preferred: false, mode: 'configured' } }))
  render(<StaffCalendarPanel accountId="acc-1" person={person} menuCount={4} canEdit onClose={() => undefined} />)
  expect(await screen.findByRole('button', { name: 'つなぎ直す' })).toBeTruthy()
  expect(screen.getByText(/Outlook カレンダーをつなぎ直してください/)).toBeTruthy()
})
it('未接続の会議サービスは理由を示し選択しない', async () => {
  render(<StaffCalendarPanel accountId="acc-1" person={person} menuCount={4} canEdit onClose={() => undefined} />)
  const radio = await screen.findByRole('radio', { name: 'Zoom' })
  expect(radio.getAttribute('aria-disabled')).toBe('true')
  expect(radio.closest('[title]')?.getAttribute('title')).toBe('つなぐと選べます')
  fireEvent.click(radio)
  expect(net.prefer).not.toHaveBeenCalled()
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('書き込みをオフにするときは確かめの窓で「先の予定を消す」を選び、confirmed と removeFutureEvents を版つきで送る', async () => {
  render(<StaffCalendarPanel accountId="acc-1" person={person} menuCount={4} canEdit onClose={() => undefined} />)
  fireEvent.click(await screen.findByRole('switch', { name: 'カレンダーの書き込み' }))
  expect(net.saveSwitches).not.toHaveBeenCalled()
  fireEvent.click(await screen.findByRole('radio', { name: /これから先の予約の予定を消す（12 件）/ }))
  fireEvent.click(screen.getByRole('button', { name: '書き込みをオフにする' }))
  await waitFor(() => expect(net.saveSwitches).toHaveBeenCalledWith('acc-1', { readEnabled: true, writeEnabled: false, expectedVersion: 3, confirmed: true, removeFutureEvents: true }, 'bs-1'))
})

it('読み込みは確かめなしで、そのスタッフの切り替えとして保存する', async () => {
  render(<StaffCalendarPanel accountId="acc-1" person={person} menuCount={4} canEdit onClose={() => undefined} />)
  fireEvent.click(await screen.findByRole('switch', { name: 'カレンダーの読み込み' }))
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
it('接続に失敗した場合は理由を通知し、画面を残す', async () => {
  net.connect.mockRejectedValue(new Error('offline'))
  render(<StaffCalendarPanel accountId="acc-1" person={person} menuCount={4} canEdit onClose={() => undefined} />)
  const buttons = await screen.findAllByRole('button', { name: 'つなぐ' })
  fireEvent.click(buttons[0])
  expect(await screen.findByText('接続を開始できませんでした。もう一度お試しください。')).toBeTruthy()
  expect(screen.getByRole('region', { name: '会議の URL' })).toBeTruthy()
})
it('解除中の再接続は待つ理由を表示する', async () => {
  const { ApiError } = await import('@/lib/api')
  net.connect.mockRejectedValue(new ApiError(409, 'busy', 'meeting_disconnect_in_progress'))
  render(<StaffCalendarPanel accountId="acc-1" person={person} menuCount={4} canEdit onClose={() => undefined} />)
  fireEvent.click((await screen.findAllByRole('button', { name: 'つなぐ' }))[0])
  expect(await screen.findByText('解除の処理中です。少し待ってからつなぎ直してください。')).toBeTruthy()
})

it('別の操作を始めると古いURL欄のエラーを消す', async () => {
  net.saveStaffUrl.mockRejectedValue({ status: 422, fields: { url: 'この会議のURLは使えません' } })
  render(<StaffCalendarPanel accountId="acc-1" person={person} menuCount={4} canEdit onClose={() => undefined} />)
  const field = await screen.findByRole('textbox', { name: '固定の会議の URL' })
  fireEvent.change(field, { target: { value: 'https://meet.example.invalid/new' } })
  fireEvent.click(screen.getByRole('button', { name: '保存する' }))
  expect(await screen.findByText('この会議のURLは使えません')).toBeTruthy()
  fireEvent.click(screen.getByRole('switch', { name: 'カレンダーの読み込み' }))
  await waitFor(() => expect(screen.queryByText('この会議のURLは使えません')).toBeNull())
  expect(net.saveSwitches).toHaveBeenCalled()
})
