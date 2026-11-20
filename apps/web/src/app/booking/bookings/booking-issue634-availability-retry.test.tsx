// @vitest-environment happy-dom
/*
 * #634: 予約管理の空き枠・一覧の失敗表示から、その場で読み直せる。
 *
 * 監査の実測で、集計・メニュー・担当の取得が失敗すると
 * 「空き枠を読み込めませんでした」の帯が出るが、直す道はページ全体を
 * 開き直す以外に無かった。
 *
 * ここでは実物の BookingsPage を mount し、失敗→「もう一度読み込む」→
 * 同じ取得列がもう一度走って帯が消える、を実DOMで固定する。
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const fixture = vi.hoisted(() => ({
  staffMe: vi.fn(),
  getToday: vi.fn(), postVisitMark: vi.fn(), deleteVisitMark: vi.fn(),
  listRequests: vi.fn(),
  requestsSummary: vi.fn(),
  listMenus: vi.fn(),
  listStaff: vi.fn(),
  availabilityBatch: vi.fn(),
  availability: vi.fn(),
  getBooking: vi.fn(),
  getBreaks: vi.fn(),
  decideRequest: vi.fn(),
  downloadLedgerCsv: vi.fn(),
}))

// 業種読取はこの試験の対象外。元の予約状態・権限・再読込の条件を保つ。
vi.mock('@/hooks/use-account-style', () => ({ useAccountStyle: () => ({ data: { style: 'standard' }, error: null, reload: vi.fn() }) }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: 'account-a',
    selectedAccount: { id: 'account-a', name: 'テスト店', liffId: 'liff-a' },
  }),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  // m23m: 実物の輸出（ApiError・describeSaveFailure など）は残す。
  // 画面が共通の失敗文へ寄ったため、取り替えは口（api・bookingApi）だけにする。
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      staff: { me: fixture.staffMe },
    },
    bookingApi: {
      ...(await import('@/test-utils/booking-visit-api-mock')).bookingVisitApiMock(),
      getToday: fixture.getToday,
      postVisitMark: fixture.postVisitMark,
      deleteVisitMark: fixture.deleteVisitMark,
      listRequests: fixture.listRequests,
      requestsSummary: fixture.requestsSummary,
      listMenus: fixture.listMenus,
      listStaff: fixture.listStaff,
      getAvailabilityBatch: fixture.availabilityBatch,
      getAvailability: fixture.availability,
      getBooking: fixture.getBooking,
      getBreaks: fixture.getBreaks,
      decideRequest: fixture.decideRequest,
      downloadLedgerCsv: fixture.downloadLedgerCsv,
    },
  }
})

import BookingsPage from './page'
import { ApiError } from '@/lib/api'

const summary = {
  total: 0, requested: 0, monthTotal: 0, monthConfirmed: 0,
  monthCancelled: 0, lastMonthTotal: 0, todayTotal: 0, weekTotal: 0,
  byMenu: [] as Array<{ name: string; total: number }>,
}

const menu = { id: 'menu-1', name: 'カット', is_active: 1, duration_minutes: 30 }
const staff = { id: 'staff-1', display_name: '山田', is_active: 1 }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-18T00:00:00.000Z'))
  vi.clearAllMocks()
  // R317: 台帳は同じタブの保存へ条件を残す。新しいタブ相当の前提にする。
  window.sessionStorage.clear()
  // 権限の判定は対象外。閲覧のみの人と同じ扱いで落とす。
  fixture.staffMe.mockResolvedValue({ success: false })
  fixture.listRequests.mockResolvedValue({ requests: [], total: 0 })
  fixture.requestsSummary.mockResolvedValue(summary)
  fixture.listMenus.mockResolvedValue({ menus: [menu] })
  fixture.listStaff.mockResolvedValue({ staff: [staff] })
  fixture.availabilityBatch.mockResolvedValue({ by_menu: [] })
  fixture.getToday.mockResolvedValue({ bookings: [] })
  fixture.getBreaks.mockResolvedValue({ breaks: [] })
})

afterEach(() => { cleanup(); vi.useRealTimers() })

describe('#634 予約管理の空き枠・一覧の再読み込み', () => {
  it('有効なメニューをまとめて空き枠を取得する', async () => {
    fixture.listMenus.mockResolvedValue({ menus: [menu, { ...menu, id: 'menu-2' }, { ...menu, id: 'hidden', is_active: 0 }] })
    render(<BookingsPage />)
    await waitFor(() => expect(fixture.availabilityBatch).toHaveBeenCalled())
    expect(fixture.availabilityBatch).toHaveBeenCalledWith('account-a', expect.objectContaining({ menuIds: ['menu-1', 'menu-2'] }))
    expect(fixture.availability).not.toHaveBeenCalled()
  })

  it('一括口が未対応のときはメニューごとの口へ退く', async () => {
    fixture.listMenus.mockResolvedValue({ menus: [menu, { ...menu, id: 'menu-2' }] })
    fixture.availabilityBatch.mockRejectedValue(new ApiError(404, 'not found'))
    fixture.availability.mockResolvedValue({ by_staff: [] })
    render(<BookingsPage />)
    await waitFor(() => expect(fixture.availability).toHaveBeenCalledTimes(2))
    expect(fixture.availabilityBatch).toHaveBeenCalledTimes(1)
    expect(fixture.availability).toHaveBeenCalledWith('account-a', expect.objectContaining({ menuId: 'menu-1' }))
    expect(fixture.availability).toHaveBeenCalledWith('account-a', expect.objectContaining({ menuId: 'menu-2' }))
  })
  it('集計・メニュー・担当の取得失敗から「もう一度読み込む」で取り直す', async () => {
    fixture.requestsSummary.mockRejectedValueOnce(new Error('down'))
    fixture.listMenus.mockRejectedValueOnce(new Error('down'))
    fixture.listStaff.mockRejectedValueOnce(new Error('down'))

    render(<BookingsPage />)

    // 失敗の帯と、その中の読み直す口が出る。
    await waitFor(() => expect(screen.getByText(/予約の記録だけを表示しています/)).toBeTruthy())
    const retry = screen.getByRole('button', { name: 'もう一度読み込む' })

    fireEvent.click(retry)

    // 同じ取得列がもう一度走り、届けば失敗の帯は消える。
    await waitFor(() => expect(fixture.requestsSummary).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(fixture.listMenus).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText(/予約の記録だけを表示しています/)).toBeNull())
    await waitFor(() => expect(document.querySelector('[data-reservation-board]')).not.toBeNull())
  })

  it('一覧自体の失敗表示にも読み直す口を出す', async () => {
    fixture.listRequests.mockRejectedValueOnce(new Error('一覧down'))

    render(<BookingsPage />)

    // ★管理画面 `x63W5x`：口の生文言は出さず、一覧の場所の失敗の1枚だけ出す。
    await waitFor(() => expect(screen.getByText('予約を読み込めませんでした')).toBeTruthy())
    expect(screen.queryByText('一覧down')).toBeNull()
    expect(screen.queryByText('まだ予約はありません')).toBeNull()
    const retries = screen.getAllByRole('button', { name: 'もう一度読み込む' })
    expect(retries.length).toBeGreaterThan(0)

    const before = fixture.listRequests.mock.calls.length
    fireEvent.click(retries[0])

    // 一覧と、表示中のカレンダー期間の両方を取り直す（WEB296）。
    await waitFor(() => expect(fixture.listRequests.mock.calls.length).toBeGreaterThanOrEqual(before + 2))
    await waitFor(() => expect(screen.queryByText('予約を読み込めませんでした')).toBeNull())
  })
})

// 日の実物の入口から、人の来店印を操作できることを確かめる。
it('日表示の一覧行から来店を付け、予約と印を読み直す', async () => {
  fixture.staffMe.mockResolvedValue({ success: true, data: { role: 'owner', permissionKeys: [] } })
  const row = { id: 'visit-1', starts_at: new Date().toISOString(), ends_at: new Date(Date.now() + 1800000).toISOString(), status: 'confirmed', friend_name: '花子', menu_name: 'カット', staff_name: '山田', staff_id: 'staff-1', source: 'phone', requested_at: new Date().toISOString() }
  fixture.listRequests.mockResolvedValue({ requests: [row], total: 1 })
  fixture.getToday.mockResolvedValue({ bookings: [{ ...row, visit_mark: null }] })
  fixture.postVisitMark.mockImplementation(async () => {
    fixture.getToday.mockResolvedValue({ bookings: [{ ...row, visit_mark: { kind: 'visited', late_minutes: null } }] })
    return { status: 'completed', visit_mark: { kind: 'visited', late_minutes: null } }
  })
  render(<BookingsPage />)
  fireEvent.click(within(await screen.findByRole('group', { name: '予約の軸' })).getByRole('button', { name: '一覧', exact: true }))
  const mark = await screen.findByRole('button', { name: '来店した' })
  await waitFor(() => expect((mark as HTMLButtonElement).disabled).toBe(false))
  const reads = fixture.listRequests.mock.calls.length
  fireEvent.click(mark)
  await waitFor(() => expect(fixture.postVisitMark).toHaveBeenCalledWith('account-a', 'visit-1', { kind: 'visited' }))
  await waitFor(() => expect(fixture.listRequests.mock.calls.length).toBeGreaterThan(reads))
  expect(await screen.findByRole('button', { name: '取り消す' })).toBeTruthy()
  expect(fixture.getToday.mock.calls.length).toBeGreaterThan(1)
})
