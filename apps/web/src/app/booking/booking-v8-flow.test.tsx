// @vitest-environment happy-dom
/**
 * V8 予約の通し試験（見た目のみ）。
 * 流れ：受付枠を作る→予約を受ける（承認）→取り消す（キャンセル）。
 * 各段で「押せる・窓の開閉・保存後の知らせ・状態の変化」を確かめる。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const searchQuery = vi.hoisted(() => ({ value: 'tab=hours' }))

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  }),
  usePathname: () => '/booking/menus',
  useSearchParams: () => new URLSearchParams(searchQuery.value),
}))

const accountState = vi.hoisted(() => ({
  selectedAccountId: 'account-a',
  selectedAccount: { id: 'account-a', name: '本店' },
  accounts: [{ id: 'account-a', name: '本店' }],
  loading: false,
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => accountState,
}))

vi.mock('@/lib/staff-capability', () => ({
  isOwnerOrAdmin: () => true,
  canManageRole: () => true,
  canEditFeature: () => true,
}))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))

const store = vi.hoisted(() => ({
  status: 'requested' as string,
  settingsVersion: 0,
}))

const getBooking = vi.hoisted(() => vi.fn())
const decideRequest = vi.hoisted(() => vi.fn())
const getSettings = vi.hoisted(() => vi.fn())
const saveSettings = vi.hoisted(() => vi.fn())

const bookingDetail = (status: string) => ({
  id: 'bk-1',
  menuId: 'menu-1',
  menuName: 'カット',
  staffId: 'staff-1',
  staffName: '担当',
  status,
  price: 3000,
  internalNote: '',
  customerNote: null,
  startsAt: '2026-10-10T01:00:00Z',
  endsAt: '2026-10-10T02:00:00Z',
  requestedAt: '2026-10-01T01:00:00Z',
  source: 'liff',
  customer: {
    displayName: '試す客',
    isLineLinked: false,
    friendId: null,
    phone: null,
    bookingCustomerId: null,
    petName: null,
    tags: [],
    mileageBalance: null,
  },
  previousHandover: null,
  previousHandoverBooking: null,
  notificationPolicy: { send_line_confirmation: false, day_before: false, hours_before: false },
  history: [],
  historyTotal: 0,
  operations: [],
  reminders: [],
  auditLogs: [],
  auditLogTotal: 0,
  lockVersion: 1,
})

const settingsData = () => ({
  id: null,
  lineAccountId: 'account-a',
  organizationName: '本店',
  version: store.settingsVersion,
  timeZone: 'Asia/Tokyo',
  bookingWindowDays: 30,
  cutoffMinutesBefore: 60,
  cancelDeadlineMinutesBefore: 60,
  maxActiveBookingsPerFriend: 3,
  approvalMode: 'manual',
  holdMinutes: 10,
  slotGranularityMinutes: 30,
  liffDateView: 'list',
  reminderDayBeforeTime: null,
  reminderHoursBefore: 2,
  menuCount: 0,
  activeMenuCount: 0,
  inactiveMenuCount: 0,
  businessHoursConfigured: false,
  businessHours: [],
  exceptions: [],
  updatedAt: '2026-10-03T00:00:00.000Z',
})

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
    }
  },
  api: {
    staff: { me: vi.fn(async () => ({ success: true, data: { role: 'owner' } })) },
  },
  bookingApi: {
    getBooking,
    decideRequest,
    getAuditLogs: vi.fn(async () => ({ audit_logs: [] })),
    listMenus: vi.fn(async () => ({ menus: [] })),
    listMenuStaff: vi.fn(async () => ({ staff: [] })),
    listStaff: vi.fn(async () => ({ staff: [] })),
    getSettings,
    saveSettings,
    getAvailabilityRules: vi.fn(async () => ({ rules: [] })),
    getGoogleCalendar: vi.fn(async () => ({ connected: false })),
    listRequests: vi.fn(async () => ({ items: [], total: 0 })),
    listResources: vi.fn(async () => ({ success: true, data: { resources: [] } })),
  },
}))

import BookingSettingsV8 from '@/v8/booking-menus/settings'
import BookingDetailPage from './bookings/detail/page'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

function renderNode(node: React.ReactNode) {
  act(() => {
    root.render(<>{node}<ToastHost /></>)
  })
}

async function flush() {
  for (let i = 0; i < 10; i++) {
    await act(async () => { await Promise.resolve() })
  }
}

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  store.status = 'requested'
  store.settingsVersion = 0
  getBooking.mockImplementation(async () => ({ booking: bookingDetail(store.status) }))
  decideRequest.mockImplementation(async (_account: string, _id: string, action: string) => {
    if (action === 'approve') store.status = 'confirmed'
    if (action === 'cancel') store.status = 'cancelled'
    return { status: store.status }
  })
  getSettings.mockImplementation(async () => ({ success: true, data: settingsData() }))
  saveSettings.mockImplementation(async () => {
    store.settingsVersion += 1
    return { success: true, data: settingsData() }
  })
  searchQuery.value = 'tab=hours'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  clearToastsForTest()
  delete document.documentElement.dataset.theme
  vi.clearAllMocks()
})

describe('V8 予約の通し：受付枠を作る', () => {
  it('月曜を開けて受付枠を作る→知らせが出る', async () => {
    renderNode(<BookingSettingsV8 accountId="account-a" />)
    await flush()

    const capacityHelp = (await screen.findByText('「同時」は1時間に受けられる数ではなく、同じ時間に重ねられる予約の数です。')).closest('[role="note"]')
    expect(capacityHelp).not.toBeNull()
    expect(capacityHelp?.querySelector('[data-notice-dot]')).not.toBeNull()

    // 月曜を開ける（09:00–18:00が入る）と書きかけになり保存帯が出る。
    fireEvent.click(await screen.findByRole('switch', { name: '月曜日を開ける' }))
    const saveButton = await screen.findByRole('button', { name: '受付枠を作る' })
    fireEvent.click(saveButton)
    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1))
    await screen.findByText('受付時間を保存しました。')
  })
})

describe('V8 予約の通し：受ける→取り消す', () => {
  it('承認の窓は開いて閉じる・承認すると知らせと状態が変わる', async () => {
    searchQuery.value = 'id=bk-1'
    renderNode(<BookingDetailPage />)
    await flush()

    fireEvent.click(await screen.findByRole('button', { name: '承認する' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('「承認」')
    fireEvent.click(within(dialog).getByRole('button', { name: '戻る' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(decideRequest).not.toHaveBeenCalled()

    fireEvent.click(await screen.findByRole('button', { name: '承認する' }))
    const dialog2 = await screen.findByRole('dialog')
    fireEvent.click(within(dialog2).getByRole('button', { name: '承認' }))
    await waitFor(() => expect(decideRequest).toHaveBeenCalledTimes(1))
    await screen.findByText('予約を確定しました')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // 読み直すと状態が「確定」になる。
    await waitFor(() => expect(screen.getAllByText('確定').length).toBeGreaterThan(0))
  })

  it('キャンセルすると知らせと状態が変わる', async () => {
    store.status = 'confirmed'
    searchQuery.value = 'id=bk-1'
    renderNode(<BookingDetailPage />)
    await flush()

    // 確定ずみには赤文字のボタン「キャンセル」がある（destructive の窓）。
    await waitFor(() => {
      const found = [...host.querySelectorAll('button')].find(
        (b) => b.textContent === 'キャンセル' && b.className.includes('text-danger'),
      )
      expect(found, '赤文字のキャンセルボタンが見つかりません').toBeTruthy()
    })
    const decideCancel = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'キャンセル' && b.className.includes('text-danger'),
    ) as HTMLButtonElement
    fireEvent.click(decideCancel)
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('「キャンセル」')
    // 決定窓には「やめる（キャンセル）」と「決める（キャンセル）」が並ぶ。決める方を押す。
    const dialogCancels = within(dialog).getAllByRole('button', { name: 'キャンセル' })
    const confirmCancel = dialogCancels.find((b) => !b.className.includes('_secondary_')) ?? dialogCancels[dialogCancels.length - 1]
    fireEvent.click(confirmCancel)
    await waitFor(() => expect(decideRequest).toHaveBeenCalledTimes(1))
    await screen.findByText('予約をキャンセルしました')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await waitFor(() => expect(screen.getAllByText('キャンセル').length).toBeGreaterThan(0))
  })
})
