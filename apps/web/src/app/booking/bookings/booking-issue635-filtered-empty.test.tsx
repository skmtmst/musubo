// @vitest-environment happy-dom
/*
 * #635: 予約管理の一覧で、存在しない言葉・条件に合わない絞り込みで0件に
 * なったとき、件数が減るだけでなく「条件に合う予約はありません」と
 * 次にやること（絞り込み解除）を出す。
 *
 * 監査5b_31: 一覧タブの空表示は「該当する予約はありません」の一文だけで、
 * 「まだ予約が無い」と「絞り込みで0件」の言い分けも解除導線も無かった。
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const fixture = vi.hoisted(() => ({
  staffMe: vi.fn(),
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
  // 一覧タブを最初から開いた状態にする（?view=list と同じ）。
  useSearchParams: () => new URLSearchParams('view=list'),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: 'account-a',
    selectedAccount: { id: 'account-a', name: 'テスト店', liffId: 'liff-a' },
  }),
}))

vi.mock('@/lib/api', async () => ({
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
  total: 0, requested: 0, monthTotal: 0, monthConfirmed: 0,
  monthCancelled: 0, lastMonthTotal: 0, todayTotal: 0, weekTotal: 0,
  byMenu: [] as Array<{ name: string; total: number }>,
}

const menu = { id: 'menu-1', name: 'カット', is_active: 1, duration_minutes: 30 }
const staff = { id: 'staff-1', display_name: '山田', is_active: 1 }

beforeEach(() => {
  vi.clearAllMocks()
  // R317: 台帳は同じタブの保存へ条件を残す。新しいタブ相当の前提にする。
  window.sessionStorage.clear()
  fixture.staffMe.mockResolvedValue({ success: false })
  fixture.listRequests.mockResolvedValue({ requests: [], total: 0 })
  fixture.requestsSummary.mockResolvedValue(summary)
  fixture.listMenus.mockResolvedValue({ menus: [menu] })
  fixture.listStaff.mockResolvedValue({ staff: [staff] })
  fixture.availabilityBatch.mockResolvedValue({ by_menu: [] })
})

afterEach(cleanup)

const bookingRows = [
  { id: 'b-line', starts_at: '2026-10-15T01:00:00Z', ends_at: '2026-10-15T02:00:00Z', status: 'confirmed', friend_id: 'friend-1', friend_name: 'LINEの人', booking_customer_id: null, menu_name: 'カット', staff_name: '山田', staff_id: 'staff-1', requested_at: '2026-10-14T00:00:00Z', decided_at: null, customer_note: null, internal_note: null, price_at_booking: 5000, external_event_id: null, source: 'liff' },
  { id: 'b-phone', starts_at: '2026-10-15T03:00:00Z', ends_at: '2026-10-15T04:00:00Z', status: 'confirmed', friend_id: null, friend_name: '電話の人', booking_customer_id: null, menu_name: 'カット', staff_name: '佐藤', staff_id: 'staff-2', requested_at: '2026-10-14T00:00:00Z', decided_at: null, customer_note: null, internal_note: null, price_at_booking: 5000, external_event_id: null, source: 'phone' },
  { id: 'b-other', starts_at: '2026-10-15T05:00:00Z', ends_at: '2026-10-15T06:00:00Z', status: 'confirmed', friend_id: null, friend_name: '店頭の人', booking_customer_id: null, menu_name: 'カット', staff_name: '山田', staff_id: 'staff-1', requested_at: '2026-10-14T00:00:00Z', decided_at: null, customer_note: null, internal_note: null, price_at_booking: 5000, external_event_id: null, source: 'counter' },
]

async function chooseSelect(label: string, option: string) {
  fireEvent.click(screen.getByLabelText(label))
  const choice = await screen.findByRole('option', { name: option })
  fireEvent.click(within(choice).getByRole('button'))
}

async function chooseEntitySelect(label: string, option: string) {
  fireEvent.click(screen.getByLabelText(label))
  fireEvent.click(await screen.findByRole('radio', { name: option }))
  fireEvent.click(screen.getByRole('button', { name: '選択する' }))
}

describe('#635 予約管理一覧の絞り込み0件', () => {
  it('予約そのものが無いときは「まだ予約はありません」を出す', async () => {
    render(<BookingsPage />)

    await waitFor(() => expect(screen.getByText('まだ予約はありません')).toBeTruthy())
    expect(screen.queryByText('条件に合う予約はありません')).toBeNull()
  })

  it('存在しない言葉で検索すると、0件の言い方と解除導線を出す', async () => {
    render(<BookingsPage />)
    await waitFor(() => expect(screen.getByText('まだ予約はありません')).toBeTruthy())

    const input = screen.getByLabelText('お客さま名で検索') as HTMLInputElement
    fireEvent.change(input, { target: { value: '存在しない言葉xyz' } })

    await waitFor(() => expect(screen.getByText('条件に合う予約はありません')).toBeTruthy())
    expect(screen.getByText('検索語や絞り込みを変えてください。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '絞り込みを解除' })).toBeTruthy()
    expect(screen.queryByText('まだ予約はありません')).toBeNull()
  })

  it('予約元で絞ると件数が変わり、担当と両方で絞ると0件の言い方と解除導線を出す', async () => {
    fixture.listRequests.mockImplementation(async (_accountId: string, _tab: string, options: { staffId?: string }) => {
      const rows = options?.staffId ? bookingRows.filter((row) => row.staff_id === options.staffId) : bookingRows
      return { requests: rows, total: rows.length }
    })
    fixture.requestsSummary.mockResolvedValue({ ...summary, total: 3, monthTotal: 3 })
    render(<BookingsPage />)
    await waitFor(() => expect(screen.getByText('LINEの人')).toBeTruthy())
    expect(screen.getByText('電話の人')).toBeTruthy()
    expect(screen.getByText('店頭の人')).toBeTruthy()
    expect(screen.getByLabelText('予約元で絞り込む').textContent).toContain('予約元：すべて')

    await chooseSelect('予約元で絞り込む', '電話')
    expect(screen.getByLabelText('予約元で絞り込む').textContent).toContain('予約元：電話')
    await waitFor(() => expect(screen.getByText('電話の人')).toBeTruthy())
    expect(screen.queryByText('LINEの人')).toBeNull()
    expect(screen.queryByText('店頭の人')).toBeNull()
    expect(screen.getByText(/1件中 1〜1件/)).toBeTruthy()

    await chooseSelect('予約元で絞り込む', 'その他')
    await waitFor(() => expect(screen.getByText('店頭の人')).toBeTruthy())
    expect(screen.queryByText('電話の人')).toBeNull()

    await chooseEntitySelect('担当で絞り込む', '山田')
    await waitFor(() => expect(screen.getByText('店頭の人')).toBeTruthy())

    await chooseSelect('予約元で絞り込む', '電話')
    await waitFor(() => expect(screen.getByText('条件に合う予約はありません')).toBeTruthy())
    expect(screen.getByRole('button', { name: '絞り込みを解除' })).toBeTruthy()
  })

  it('「絞り込みを解除」で検索語と状態を外して全件へ戻す', async () => {
    render(<BookingsPage />)
    await waitFor(() => expect(screen.getByText('まだ予約はありません')).toBeTruthy())

    const input = screen.getByLabelText('お客さま名で検索') as HTMLInputElement
    fireEvent.change(input, { target: { value: '存在しない言葉xyz' } })
    await waitFor(() => expect(screen.getByText('条件に合う予約はありません')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: '絞り込みを解除' }))

    // 検索欄が空に戻り、条件なし（query 無し・全件タブ）で取り直す。
    await waitFor(() => expect(input.value).toBe(''))
    await waitFor(() => {
      const last = fixture.listRequests.mock.calls.at(-1)
      expect(last?.[1]).toBe('all')
      expect(last?.[2]?.query).toBeUndefined()
    })
    await waitFor(() => expect(screen.getByText('まだ予約はありません')).toBeTruthy())
  })
})
