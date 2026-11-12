// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BookingRequest } from '@/lib/api'
import type { BookingLedgerModel } from './use-booking-ledger'
import Page from './page'

const m = vi.hoisted(() => ({ latest: null as unknown as BookingLedgerModel, realView: false, style: 'standard' as 'standard' | 'consult' | 'lesson', account: 'A', liff: 'liff-a', query: 'view=list&status=confirmed', confirmation: undefined as undefined | (() => void), list: vi.fn(), summary: vi.fn(), menus: vi.fn(), staff: vi.fn(), me: vi.fn(), decide: vi.fn(), csv: vi.fn(), get: vi.fn(), replace: vi.fn() }))
vi.mock('@/components/shared/confirm-dialog', async original => {
  const actual = await original<typeof import('@/components/shared/confirm-dialog')>()
  return { ...actual, default: (props: React.ComponentProps<typeof actual.default>) => {
    if (props.open && typeof props.title === 'string' && props.title.includes('この予約を')) m.confirmation = props.onConfirm as () => void
    return <actual.default {...props} />
  } }
})
vi.mock('@/hooks/use-account-style', () => ({ useAccountStyle: () => ({ data: { style: m.style }, error: null, reload: vi.fn() }) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: m.account, selectedAccount: { id: m.account, name: m.account, liffId: m.liff } }) }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(), useSearchParams: () => new URLSearchParams(m.query), useRouter: () => ({ replace: m.replace, push: vi.fn() }) }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, staff: { me: m.me } }, bookingApi: { ...actual.bookingApi, ...(await import('@/test-utils/booking-visit-api-mock')).bookingVisitApiMock(), listRequests: m.list, requestsSummary: m.summary, listMenus: m.menus, listStaff: m.staff, decideRequest: m.decide, downloadLedgerCsv: m.csv, getBooking: m.get, getBreaks: async () => ({ breaks: [] }), getAvailabilityBatch: async () => ({ by_menu: [] }) } }
})
vi.mock('@/lib/api/helpers/booking-advanced', () => ({ bookingAdvancedApi: { card: async () => ({ success: true, data: null }), group: async () => ({ success: true, data: null }) } }))
vi.mock('@/lib/api/helpers/gap1', () => ({ bookingCancellationApi: { charges: async () => ({ success: true, data: { charges: [], quote: { eligible: false }, testMode: true } }) } }))
vi.mock('./ledger-screen', async original => {
  const Actual = (await original<typeof import('./ledger-screen')>()).default
  return { default: ({ model }: { model: BookingLedgerModel }) => { m.latest = model; return m.realView ? <Actual model={model} /> : null } }
})
function mountController() {
  const view = render(<Page />)
  return { result: { get current() { return m.latest } }, rerender: () => view.rerender(<Page />) }
}
const counts = { total: 51, requested: 1, monthTotal: 1, monthConfirmed: 1, monthCancelled: 0, lastMonthTotal: 0, todayTotal: 1, weekTotal: 1, byMenu: [] }
const row = (id: string): BookingRequest => ({ id, starts_at: '2026-10-18T01:00:00Z', ends_at: '2026-10-18T02:00:00Z', status: 'confirmed', friend_id: null, friend_name: id, booking_customer_id: null, menu_name: 'カット', staff_name: '担当', staff_id: 'staff', requested_at: '2026-10-17T00:00:00Z', decided_at: null, customer_note: null, internal_note: null, price_at_booking: 5000, external_event_id: null, source: 'phone' })
const defer = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
beforeEach(() => {
  vi.resetAllMocks(); m.confirmation = undefined; m.realView = false; m.style = 'standard'; window.sessionStorage.clear(); window.history.replaceState(null, '', '/booking/bookings'); m.account = 'A'; m.liff = 'liff-a'; m.query = 'view=list&status=confirmed'
  m.me.mockResolvedValue({ success: true, data: { role: 'owner', permissionKeys: [] } })
  m.list.mockResolvedValue({ requests: [row('current')], total: 51 }); m.summary.mockResolvedValue(counts)
  m.menus.mockResolvedValue({ menus: [] }); m.staff.mockResolvedValue({ staff: [] }); m.csv.mockResolvedValue(undefined)
  m.get.mockResolvedValue({ booking: null }); m.decide.mockResolvedValue({})
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
it('予約の取消確認では戻る操作と取消の確定を区別する', async () => {
  m.realView = true
  const h = mountController()
  await waitFor(() => expect(h.result.current.loading).toBe(false))
  act(() => h.result.current.handleDecide('current', 'cancel'))
  const dialog = await screen.findByRole('alertdialog')
  const labels = Array.from(dialog.querySelectorAll('button')).map(button => button.textContent?.trim())
  expect(labels).toEqual(expect.arrayContaining(['戻る', 'キャンセル']))
  expect(labels.filter(label => label === 'キャンセル')).toHaveLength(1)
})
it.each([['consult', '相談者'], ['lesson', '会員']] as const)('%sでは検索と予約詳細も同じ業種の人の呼び方を使う', async (style, person) => {
  m.realView = true; m.style = style
  render(<Page />)
  const cell = await screen.findByText('current')
  expect(screen.getByPlaceholderText(`${person}名で検索`)).toBeTruthy()
  fireEvent.click(cell.closest('tr')!)
  await screen.findByRole('dialog')
  expect(screen.getByText(`${person}からのご希望`)).toBeTruthy()
  expect(m.list).toHaveBeenCalledWith('A', 'confirmed', expect.anything())
})
it('ページ分だけ取得して総数でページを決め、予約元は画面側で当て、CSVにも同じ絞り込みを渡す', async () => {
  const h = mountController()
  await waitFor(() => expect(h.result.current.total).toBe(51))
  expect(h.result.current.pageCount).toBe(3)
  act(() => { h.result.current.setStaffFilter('staff-2'); h.result.current.setSourceFilter('phone'); h.result.current.setQuery('花子') })
  await waitFor(() => expect(m.list).toHaveBeenLastCalledWith('A', 'confirmed', expect.objectContaining({ staffId: 'staff-2', query: '花子', limit: 20, offset: 0 })))
  expect(m.list.mock.calls.at(-1)?.[2]?.source).toBeUndefined()
  act(() => h.result.current.setPage(2))
  await waitFor(() => expect(m.list).toHaveBeenLastCalledWith('A', 'confirmed', expect.objectContaining({ limit: 20, offset: 20 })))
  await act(async () => h.result.current.downloadLedgerCsv())
  expect(m.csv).toHaveBeenCalledWith('A', expect.objectContaining({ status: 'confirmed', staffId: 'staff-2', source: 'phone', query: '花子' }))
  act(() => h.result.current.setQuery('次'))
  await waitFor(() => expect(h.result.current.page).toBe(1))
})
it('アカウント切替前の一覧・集計・候補の遅い返事を新しい店へ出さない', async () => {
  const oldList = defer<{ requests: BookingRequest[]; total: number }>(); const oldSummary = defer<typeof counts>()
  m.list.mockImplementation((account: string) => account === 'A' ? oldList.promise : Promise.resolve({ requests: [row('Bの予約')], total: 1 }))
  m.summary.mockImplementation((account: string) => account === 'A' ? oldSummary.promise : Promise.resolve({ ...counts, total: 1 }))
  const h = mountController()
  act(() => h.result.current.handleDecide('old', 'cancel'))
  m.account = 'B'; h.rerender()
  await waitFor(() => expect(h.result.current.items[0]?.id).toBe('Bの予約'))
  await act(async () => { oldList.resolve({ requests: [row('Aの予約')], total: 99 }); oldSummary.resolve({ ...counts, total: 99 }) })
  expect(h.result.current.total).toBe(1)
  expect(h.result.current.summary.total).toBe(1)
  expect(h.result.current.decideTarget).toBeNull()
  expect(h.result.current.loading).toBe(false)
  expect(h.result.current.items.map(x => x.id)).toEqual(['Bの予約'])
})
it('Aの確定処理が切替後に戻ってもBを消さず、Aの再取得を始めない', async () => {
  const done = defer<object>(); m.decide.mockReturnValue(done.promise)
  const h = mountController()
  await waitFor(() => expect(h.result.current.loading).toBe(false))
  let pending!: Promise<void>
  act(() => { pending = h.result.current.runDecide('old', 'cancel') })
  m.account = 'B'; h.rerender()
  await waitFor(() => expect(m.list).toHaveBeenLastCalledWith('B', 'confirmed', expect.anything()))
  const reads = m.list.mock.calls.length
  await act(async () => { done.resolve({}); await pending })
  expect(m.decide).toHaveBeenCalledWith('A', 'old', 'cancel')
  expect(m.list).toHaveBeenCalledTimes(reads)
  expect(h.result.current.items[0]?.id).toBe('current')
})
it('予約の確認を閉じて開き直すと古い確定は使えない', async () => {
  m.realView = true
  const h = mountController()
  await waitFor(() => expect(h.result.current.loading).toBe(false))
  act(() => h.result.current.handleDecide('current', 'cancel'))
  await waitFor(() => expect(m.confirmation).toBeTypeOf('function'))
  const oldConfirm = m.confirmation!
  act(() => h.result.current.setDecideTarget(null))
  act(() => h.result.current.handleDecide('current', 'cancel'))
  await act(async () => { oldConfirm(); await Promise.resolve() })
  expect(m.decide).not.toHaveBeenCalled()
  await act(async () => { m.confirmation!(); await Promise.resolve() })
  expect(m.decide).toHaveBeenCalledTimes(1)
})

it('アカウントを切り替えて戻しても以前の予約確認は使えない', async () => {
  m.realView = true
  const h = mountController()
  await waitFor(() => expect(h.result.current.loading).toBe(false))
  act(() => h.result.current.handleDecide('current', 'cancel'))
  await waitFor(() => expect(m.confirmation).toBeTypeOf('function'))
  const oldConfirm = m.confirmation!
  m.account = 'B'; h.rerender()
  m.account = 'A'; h.rerender()
  await act(async () => { oldConfirm(); await Promise.resolve() })
  expect(m.decide).not.toHaveBeenCalled()
})

it('操作中にアカウントを切り替えて戻しても古い応答で現在の確認を閉じない', async () => {
  const done = defer<object>(); m.decide.mockReturnValue(done.promise)
  const h = mountController()
  await waitFor(() => expect(h.result.current.loading).toBe(false))
  let pending!: Promise<void>
  act(() => { pending = h.result.current.runDecide('old', 'cancel') })
  m.account = 'B'; h.rerender()
  m.account = 'A'; h.rerender()
  await waitFor(() => expect(h.result.current.loading).toBe(false))
  act(() => h.result.current.handleDecide('new', 'complete'))
  const reads = m.list.mock.calls.length
  await act(async () => { done.resolve({}); await pending })
  expect(h.result.current.decideTarget?.id).toBe('new')
  expect(m.list).toHaveBeenCalledTimes(reads)
})

it('権限を取得する前と閲覧のみには状態変更を出さず、未連携の行に会話を出さない', async () => {
  const role = defer<object>(); m.me.mockReturnValue(role.promise)
  const h = mountController()
  expect(h.result.current.canOperate).toBe(false)
  expect(h.result.current.bookingContextItems(row('phone')).map(x => x.id)).toEqual(['open'])
  await act(async () => role.resolve({ success: true, data: { role: 'viewer', permissionKeys: [] } }))
  expect(h.result.current.canOperate).toBe(false)
  expect(h.result.current.bookingContextItems(row('phone')).map(x => x.id)).toEqual(['open'])
})
it('履歴URLは対象のLIFFと履歴指定を含み、コピー失敗と未設定を区別する', async () => {
  const writeText = vi.fn().mockRejectedValue(new Error('clipboard denied'))
  vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as unknown as Clipboard)
  const h = mountController()
  expect(new URL(h.result.current.historyUrl!).searchParams.get('liffId')).toBe('liff-a')
  expect(new URL(h.result.current.historyUrl!).searchParams.get('view')).toBe('history')
  await act(async () => h.result.current.copyUrl(h.result.current.historyUrl))
  expect(h.result.current.copyFailedUrl).toBe(h.result.current.historyUrl)
  m.liff = ''; h.rerender()
  expect(h.result.current.historyUrl).toBeNull()
  vi.restoreAllMocks()
})
it('実物の一覧行から同じ予約の詳細パネルを開き、詳細ページへ進める', async () => {
  m.realView = true; render(<Page />)
  const cell = await screen.findByText('current')
  fireEvent.click(cell.closest('tr')!)
  const dialog = await screen.findByRole('dialog')
  expect(dialog.textContent).toContain('current')
  expect(screen.getByRole('link', { name: /予約の詳細ページを開く/ }).getAttribute('href')).toContain('id=current')
  expect(m.replace.mock.calls.some(([url]) => String(url).includes('booking=current'))).toBe(true)
})
it('カレンダーの先頭ページ取得中に別店へ替えたら後続ページを要求しない', async () => {
  m.query = 'view=day'
  const old = defer<{ requests: BookingRequest[]; total: number }>()
  m.list.mockImplementation((account: string, _status: string, options: { limit: number }) => account === 'A' && options.limit === 100 ? old.promise : Promise.resolve({ requests: [], total: 0 }))
  const h = mountController()
  await waitFor(() => expect(m.list.mock.calls.some(c => c[0] === 'A' && c[2].limit === 100)).toBe(true))
  m.account = 'B'; h.rerender()
  await waitFor(() => expect(h.result.current.calendarStatus).toBe('ready'))
  await act(async () => old.resolve({ requests: Array.from({ length: 100 }, (_, i) => row(`A-${i}`)), total: 200 }))
  expect(m.list.mock.calls.filter(c => c[0] === 'A' && c[2].offset > 0)).toHaveLength(0)
  expect(h.result.current.calendarItems).toEqual([])
})
it('閲覧のみの一覧・詳細パネルには作成と状態変更の操作を出さない', async () => {
  m.me.mockResolvedValue({ success: true, data: { role: 'viewer', permissionKeys: [] } })
  m.realView = true; render(<Page />)
  fireEvent.click((await screen.findByText('current')).closest('tr')!)
  await screen.findByRole('dialog')
  expect(screen.queryByRole('link', { name: '電話の予約を入れる' })).toBeNull()
  expect(screen.queryByRole('button', { name: '来店にする' })).toBeNull()
  expect(screen.queryByRole('button', { name: '予約を取り消す' })).toBeNull()
  expect(m.decide).not.toHaveBeenCalled()
})
