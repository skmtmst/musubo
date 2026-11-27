// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ loading: false, error: '概要を読み込めませんでした', data: null as unknown, unavailable: '' as string, load: vi.fn() }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), usePathname: () => '/', useRouter: () => ({ replace() {}, push() {} }) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ refreshAccounts: vi.fn(), selectedAccountId: 'A', selectedAccount: null, loading: false }) }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner', useStaffIdentity: () => null }))
vi.mock('@/v8/onboarding/public/use-style-setup/index', () => ({ useStyleSetup: () => ({ data: null, status: 'ready', error: null, reload: vi.fn() }) }))
vi.mock('@/v8/onboarding/public/setup-wizard/index', () => ({ useSetupWizard: () => ({ qrRequested: false, dialog: null }) }))
vi.mock('./first-steps', async original => ({ ...await original<typeof import('./first-steps')>(), useFirstSteps: () => ({ summary: null, status: 'ready', steps: [], starter: null, error: null, guide: { loading: false, phase: 'done' } }) }))
vi.mock('./first-run-popup', async original => ({ ...await original<typeof import('./first-run-popup')>(), useFirstRunPopup: () => ({ open: false, close() {} }) }))
vi.mock('./starter-retry', async original => ({ ...await original<typeof import('./starter-retry')>(), useStarterRetryResult: () => ({ inserted: null, record() {}, clear() {} }) }))
vi.mock('./use-dashboard', async original => ({ ...await original<typeof import('./use-dashboard')>(), useDashboard: () => ({
  bodyRef: { current: null }, supplementGate: false, selectedAccountId: 'A', selectedAccount: null,
  period: 'today', selectPeriod: vi.fn(), editorOpen: false, openEditor: vi.fn(), closeEditor: vi.fn(),
  data: fixture.data, displayedPeriod: 'today', periodNotice: '', loading: fixture.loading, error: fixture.error, load: fixture.load,
  preferences: { main: [{ id: 'friend-trend', visible: true }], right: [] }, preferenceVersion: 0, preferenceSaving: false, preferenceSaveError: null,
  visibleToday: [], visibleRight: [{ id: 'friend-status' }, { id: 'monthly-delivery' }, { id: 'recent-results' }],
  handleShipmentSummary: vi.fn(), handleInboxSummary: vi.fn(), shipmentSummary: null, shipmentState: 'ready',
  pendingPhotos: 0, pendingPhotosState: 'ready', bookings: [], bookingsFailed: false, todayActiveBookings: null,
  displayedBookings: [], todayBookings: [], upcomingBookings: [], supplementLoading: false, supplementLoadedAt: null,
  healthFailed: false, healthIssueCount: 0, displayedHealthRisk: 'normal', displayedTwoFactor: null, supportMarkAutoOnInbound: null,
  sectionAvailable: (key: string) => key !== fixture.unavailable, activeFriends: 0, lineUnread: 0, mailUnread: 0, pendingTotal: 0, pendingDetailState: 'ready',
  pendingOldest: null, notifications: [], notificationFailed: false, staffName: null, today: '2026-10-28', reference: null,
}) }))
import DashboardV8 from './dashboard'
beforeEach(() => { fixture.loading = false; fixture.error = '概要を読み込めませんでした'; fixture.data = null; fixture.unavailable = ''; fixture.load.mockReset(); document.documentElement.dataset.theme = 'v8'; vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false }), { headers: { 'Content-Type': 'application/json' } }))) })
afterEach(() => { cleanup(); delete document.documentElement.dataset.theme; vi.unstubAllGlobals() })

it('概要の取得が失敗したら各段を失敗表示にして読み直せる', () => {
  render(<DashboardV8 />)
  expect(screen.getByText('友だちの状態')).toBeTruthy()
  expect(screen.getAllByText('今月の配信').length).toBeGreaterThan(0)
  expect(screen.getByText('最近の成果')).toBeTruthy()
  expect(screen.getByText('友だち数の推移')).toBeTruthy()
  expect(screen.getAllByText('データを読み込めませんでした')).toHaveLength(4)
  expect(screen.queryByLabelText('友だちの状態を読み込んでいます')).toBeNull()
  fireEvent.click(screen.getAllByRole('button', { name: 'もう一度読み込む' })[1])
  expect(fixture.load).toHaveBeenCalledTimes(1)
})
it('読み込み中は失敗と表示しない', () => {
  fixture.loading = true; fixture.error = '前回のエラー'
  render(<DashboardV8 />)
  expect(screen.queryByText('データを読み込めませんでした')).toBeNull()
  expect(screen.getByLabelText('友だちの状態を読み込んでいます')).toBeTruthy()
})
it('まだ結果もエラーもないときは失敗と表示しない', () => {
  fixture.error = ''
  render(<DashboardV8 />)
  expect(screen.queryByText('データを読み込めませんでした')).toBeNull()
  expect(screen.getByLabelText('友だちの状態を読み込んでいます')).toBeTruthy()
})
it('前回のデータが残るときは全体を取得失敗にしない', () => {
  fixture.data = { friends: { total: 3, active: 3, blockedByThem: 0, hiddenByUs: 0, blockedBoth: 0 }, delivery: { push: 2, reply: 1 }, conversions: { byPoint: [], total: 0 }, trend: [], sections: {} }
  render(<DashboardV8 />)
  expect(screen.getByText('友だち総数')).toBeTruthy()
  expect(screen.getByText('プッシュ数')).toBeTruthy()
  expect(screen.queryByText('データを読み込めませんでした')).toBeNull()
})
it('概要の一部だけ読めないときは、その段だけ読み直しを出す', () => {
  fixture.error = ''
  fixture.unavailable = 'friends'
  fixture.data = { friends: { total: 3, active: 3, blockedByThem: 0, hiddenByUs: 0, blockedBoth: 0 }, delivery: { push: 2, reply: 1 }, conversions: { byPoint: [], total: 0 }, trend: [], sections: {} }
  render(<DashboardV8 />)
  expect(screen.getAllByText('データを読み込めませんでした')).toHaveLength(1)
  expect(screen.getByText('プッシュ数')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  expect(fixture.load).toHaveBeenCalledTimes(1)
})
