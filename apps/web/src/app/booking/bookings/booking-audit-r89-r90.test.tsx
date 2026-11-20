// @vitest-environment happy-dom
/*
 * 監査 R89・R90（予約一覧）を実描画で固定する。
 * - R89: 承認の後は一覧だけでなく集計・カレンダー・空き枠も読み直す。
 * - R90: 「今月」を押すと今月の初め〜来月の初めで絞り、対象を明示する。
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { BookingRequest } from '@/lib/api'

const fixture = vi.hoisted(() => ({
  staffMe: vi.fn(),
  push: vi.fn(),
  listRequests: vi.fn(),
  requestsSummary: vi.fn(),
  listMenus: vi.fn(),
  listStaff: vi.fn(),
  availabilityBatch: vi.fn(),
  availability: vi.fn(),
  getBooking: vi.fn(),
  decideRequest: vi.fn(),
  downloadLedgerCsv: vi.fn(),
}))

// 業種読取はこの試験の対象外。元の予約状態・権限・再読込の条件を保つ。
vi.mock('@/hooks/use-account-style', () => ({ useAccountStyle: () => ({ data: { style: 'standard' }, error: null, reload: vi.fn() }) }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: fixture.push }),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: 'account-a',
    selectedAccount: { id: 'account-a', name: 'テスト店', liffId: 'liff-a' },
  }),
}))

vi.mock('@/lib/api', async () => ({
  ApiError: class extends Error { constructor(public status: number) { super('API error') } },
  api: {
    staff: { me: fixture.staffMe },
  },
  bookingApi: {
    ...(await import('@/test-utils/booking-visit-api-mock')).bookingVisitApiMock(),
    listRequests: fixture.listRequests,
    requestsSummary: fixture.requestsSummary,
    listMenus: fixture.listMenus,
    listStaff: fixture.listStaff,
    getAvailabilityBatch: fixture.availabilityBatch,
    getAvailability: fixture.availability,
    getBooking: fixture.getBooking,
    decideRequest: fixture.decideRequest,
    downloadLedgerCsv: fixture.downloadLedgerCsv,
  },
}))

import BookingsPage from './page'

const summary = {
  total: 1, requested: 1, monthTotal: 1, monthConfirmed: 0,
  monthCancelled: 0, lastMonthTotal: 0, todayTotal: 0, weekTotal: 0,
  byMenu: [] as Array<{ name: string; total: number }>,
}

// カレンダーの基点（今日・JST）に合わせる。固定日にすると実行日で消える。
const todayJst = new Date(new Date().getTime() + 9 * 3600_000).toISOString().slice(0, 10)

const requestedBooking: BookingRequest = {
  id: 'b-req',
  friend_id: 'f1',
  booking_customer_id: null,
  starts_at: `${todayJst}T10:00:00+09:00`,
  ends_at: `${todayJst}T10:30:00+09:00`,
  status: 'requested',
  customer_note: null,
  internal_note: null,
  price_at_booking: 5000,
  menu_name: 'カット',
  staff_name: '山田',
  friend_name: '花子',
  requested_at: '2026-09-27T00:00:00Z',
  decided_at: null,
  external_event_id: null,
  staff_id: 'staff-1',
  source: 'liff',
}

const menu = { id: 'menu-1', name: 'カット', is_active: 1, duration_minutes: 30 }
const staff = { id: 'staff-1', display_name: '山田', is_active: 1 }

beforeEach(() => {
  vi.clearAllMocks()
  // R317: 台帳は同じタブの保存へ条件を残す。新しいタブ相当の前提にする。
  window.sessionStorage.clear()
  fixture.staffMe.mockResolvedValue({ success: true, data: { role: 'owner' } })
  fixture.listRequests.mockResolvedValue({ requests: [requestedBooking], total: 1 })
  fixture.requestsSummary.mockResolvedValue(summary)
  fixture.listMenus.mockResolvedValue({ menus: [menu] })
  fixture.listStaff.mockResolvedValue({ staff: [staff] })
  fixture.availabilityBatch.mockResolvedValue({ by_menu: [] })
  fixture.getBooking.mockResolvedValue({ booking: null })
  fixture.decideRequest.mockResolvedValue({})
})

afterEach(cleanup)

function monthBounds(): { from: string; to: string } {
  const now = new Date(Date.now() + 9 * 3600_000)
  const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString().slice(0, 7)
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    .toISOString().slice(0, 7)
  return {
    from: new Date(`${thisMonth}-01T00:00:00+09:00`).toISOString(),
    to: new Date(`${nextMonth}-01T00:00:00+09:00`).toISOString(),
  }
}

describe('監査 R90: 今月は今月の予約に絞る', () => {
  it('今月と今日の数の帯には、それぞれ項目の印がある', async () => {
    render(<BookingsPage />)
    fireEvent.click(screen.getByRole('button', { name: /^今月/ }))
    for (const [title, icon] of [['今月の予約', 'calendar'], ['確定', 'calendar-plus'], ['変更依頼', 'circle-alert'], ['キャンセル', 'calendar-x']]) {
      const label = await screen.findByText(title, { selector: '[data-kpi-label] > span' })
      expect(label.closest('[data-kpi-label]')?.querySelectorAll(`[data-kpi-icon] svg.lucide-${icon}`)).toHaveLength(1)
    }
    fireEvent.click(within(screen.getByRole('group', { name: '予約の表示' })).getByRole('button', { name: /^今日/ }))
    for (const [title, icon] of [['今日の予約', 'calendar-days'], ['まだ空いている枠', 'calendar-plus'], ['未承認・要対応', 'circle-alert'], ['キャンセル', 'calendar-x']]) {
      const label = await screen.findByText(title, { selector: '[data-kpi-label] > span' })
      expect(label.closest('[data-kpi-label]')?.querySelectorAll(`[data-kpi-icon] svg.lucide-${icon}`)).toHaveLength(1)
    }
  })
  it('今月の題から一覧とCSVの説明を開ける', async () => {
    render(<BookingsPage />)
    fireEvent.click(screen.getByRole('button', { name: /^今月/ }))
    fireEvent.click(await screen.findByRole('button', { name: '予約管理の説明' }))
    expect(await screen.findByText('予約を探して、行から詳細を見られます。CSVは今の絞り込みで書き出します。')).toBeTruthy()
  })
  it('今月の確定だけに数の説明の印を出し、今日の表示には足さない', async () => {
    render(<BookingsPage />)
    fireEvent.click(screen.getByRole('button', { name: /^今月/ }))
    const help = await screen.findByRole('button', { name: '確定の説明' })
    expect(help.querySelector('span[aria-hidden="true"]')).toBeTruthy()
    fireEvent.click(help)
    expect(await screen.findByText('今月の予約のうち、確定して来店を予定している件数です。')).toBeTruthy()
    fireEvent.click(within(screen.getByRole('group', { name: '予約の表示' })).getByRole('button', { name: /^今日/ }))
    expect(screen.queryByRole('button', { name: '確定の説明' })).toBeNull()
  })
  it('今月タブで一覧の取得に今月の初め〜来月の初めが入る', async () => {
    render(<BookingsPage />)
    fireEvent.click(screen.getByRole('button', { name: /^今月/ }))
    const { from, to } = monthBounds()
    await waitFor(() => {
      const calls = fixture.listRequests.mock.calls as Array<[string, string, Record<string, unknown>]>
      const monthCall = calls.find(([, , params]) => params?.from === from && params?.to === to)
      expect(monthCall).toBeTruthy()
    })
    // 対象の期間と状態を画面に明示する。
    expect(screen.getByRole('status').textContent).toMatch(/今月（\d+年\d+月）の予約を/)
  })
  it('月を進めた一覧とCSVは同じ期間になり、今日で今月へ戻る', async () => {
    fixture.downloadLedgerCsv.mockResolvedValue(undefined)
    render(<BookingsPage />)
    fireEvent.click(screen.getByRole('button', { name: /^今月/ }))
    fireEvent.click(await screen.findByRole('button', { name: '次の月' }))
    const now = new Date(Date.now() + 9 * 3600_000)
    const key = (offset: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)).toISOString().slice(0, 7)
    const expected = {
      from: new Date(`${key(1)}-01T00:00:00+09:00`).toISOString(),
      to: new Date(`${key(2)}-01T00:00:00+09:00`).toISOString(),
    }
    await waitFor(() => expect(fixture.listRequests).toHaveBeenLastCalledWith('account-a', 'requested', expect.objectContaining(expected)))
    fireEvent.click(screen.getByRole('button', { name: 'CSVで書き出す' }))
    await waitFor(() => expect(fixture.downloadLedgerCsv).toHaveBeenCalledWith('account-a', expect.objectContaining(expected)))
    expect(screen.getByRole('status').textContent).toContain('月の予約を')
    expect(JSON.parse(sessionStorage.getItem('booking-ledger-state-v1')!).date).toBe(`${key(1)}-01`)
    fireEvent.click(screen.getByRole('button', { name: '前の月' }))
    await waitFor(() => expect(fixture.listRequests).toHaveBeenLastCalledWith('account-a', 'requested', expect.objectContaining(monthBounds())))
    fireEvent.click(screen.getByRole('button', { name: '次の月' }))
    fireEvent.click(within(document.querySelector('[data-template-region="stats"]') as HTMLElement).getByRole('button', { name: '今日' }))
    await waitFor(() => expect(fixture.listRequests).toHaveBeenLastCalledWith('account-a', 'requested', expect.objectContaining(monthBounds())))
  })
})

describe('タブの数は期間の有効な予約だけ（取消・拒否・期限切れを除く）', () => {
  it('集計のタブ用があれば従来の総数より絞って出す', async () => {
    // 撮影の「今日 6・今週 6・今月 6」と0件のずれ。タブは未絞りの総数ではなく
    // 有効な予約の数を出す。旧Worker（タブ用なし）では従来の数に倒す。
    fixture.requestsSummary.mockResolvedValue({
      ...summary,
      todayTotal: 5, todayTabTotal: 2,
      weekTotal: 6, weekTabTotal: 3,
      monthTotal: 7, monthTabTotal: 4,
    })
    render(<BookingsPage />)
    expect(await screen.findByRole('button', { name: '今日 2' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '今週 3' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '今月 4' })).toBeTruthy()
  })
})

describe('監査 R89: 状態変更の後は集計・カレンダーも更新する', () => {
  it('状態の確定で一覧・集計・カレンダーの取得が走り直す', async () => {
    // 日の表示のまま。カレンダーのマス→詳細→完了の順に押す。
    render(<BookingsPage />)
    const card = await screen.findByRole('button', { name: /カットの詳細/ })
    const listBefore = fixture.listRequests.mock.calls.length
    const summaryBefore = fixture.requestsSummary.mock.calls.length
    fireEvent.click(card)
    const complete = await screen.findByRole('button', { name: '取り消す' })
    fireEvent.click(complete)
    const dialog = await screen.findByRole('alertdialog', {name: 'この予約を「キャンセル」にしますか？'})
    expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
    expect(within(dialog).getByText('環境')).toBeTruthy()
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'キャンセル' }).find((button) => button.getAttribute('data-dialog-action') === 'danger')!)
    await waitFor(() => {
      expect(fixture.decideRequest).toHaveBeenCalledWith('account-a', 'b-req', 'cancel')
    })
    // 一覧・集計・カレンダー（'all'＋期間の取得）の取り直しが走る。
    await waitFor(() => {
      expect(fixture.listRequests.mock.calls.length).toBeGreaterThan(listBefore)
      expect(fixture.requestsSummary.mock.calls.length).toBeGreaterThan(summaryBefore)
      const calls = fixture.listRequests.mock.calls as Array<[string, string, Record<string, unknown>]>
      const calendarReload = calls
        .slice(listBefore)
        .some(([, status, params]) => status === 'all' && typeof params?.from === 'string')
      expect(calendarReload).toBe(true)
    })
  })
})

 describe('WEB295〜297：カレンダー取得の状態と再試行', () => {
   it('WEB295：期間の予約を取得中は予約数を確定しない', async () => {
     fixture.listRequests.mockImplementation(async (_a: string, _s: string, params: Record<string, unknown>) => {
       if (params?.from) return new Promise(() => {})
       return { requests: [], total: 0 }
     })
     render(<BookingsPage />)
     await screen.findAllByRole('button', { name: /今日/ })
     expect(screen.getAllByLabelText('読み込んでいます').length).toBeGreaterThan(0)
   })
   it('WEB296：期間の取得失敗から再試行したら、その期間を読み直す', async () => {
     let rangeCalls = 0
     fixture.listRequests.mockImplementation(async (_a: string, _s: string, params: Record<string, unknown>) => {
       if (_s === 'all' && params?.from && ++rangeCalls === 1) throw new Error('network')
       return { requests: [], total: 0 }
     })
     render(<BookingsPage />)
     await screen.findByText('予約を読み込めませんでした')
     await act(async () => { fireEvent.click(screen.getByRole('button', { name: /もう一度読み込む/ })) })
     await waitFor(() => expect(rangeCalls).toBe(2))
   })
   it('WEB297：一括空き枠の500ではメニュー別要求を増やさない', async () => {
     fixture.availabilityBatch.mockRejectedValueOnce(new Error('network'))
     fixture.availability.mockResolvedValue({ by_staff: [] })
     render(<BookingsPage />)
     await screen.findAllByText(/空き枠を読み込めませんでした/)
     expect(fixture.availability).not.toHaveBeenCalled()
   })
 })


it('予約の一覧は右端のメニューからその人の会話を開く', async () => {
  render(<BookingsPage />)
  fireEvent.click(within(screen.getByRole('group', { name: '予約の表示' })).getByRole('button', { name: '一覧' }))
  const menu = await screen.findByRole('button', { name: '予約「花子」の操作' })
  expect(screen.queryByRole('menuitem', { name: '会話を開く' })).toBeNull()
  fireEvent.click(menu)
  fireEvent.click(await screen.findByRole('menuitem', { name: '会話を開く' }))
  expect(fixture.push).toHaveBeenCalledWith(expect.stringContaining('/chats?friend=f1'))
  expect(fixture.getBooking).not.toHaveBeenCalled()
})
