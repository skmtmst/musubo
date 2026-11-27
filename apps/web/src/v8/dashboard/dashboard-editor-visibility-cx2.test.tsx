// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ role: 'owner' as 'owner' | 'admin' | 'staff' | 'viewer' | null, editorOpen: false, openEditor: vi.fn(), loading: false, error: '概要を読み込めませんでした', data: null as unknown, unavailable: '' as string, load: vi.fn() }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), usePathname: () => '/', useRouter: () => ({ replace() {}, push() {} }) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ refreshAccounts: vi.fn(), selectedAccountId: 'A', selectedAccount: null, loading: false }) }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => fixture.role, useStaffIdentity: () => null }))
vi.mock('@/v8/onboarding/public/use-style-setup/index', () => ({ useStyleSetup: () => ({ data: null, status: 'ready', error: null, reload: vi.fn() }) }))
vi.mock('@/v8/onboarding/public/setup-wizard/index', () => ({ useSetupWizard: () => ({ qrRequested: false, dialog: null }) }))
vi.mock('./first-steps', async original => ({ ...await original<typeof import('./first-steps')>(), useFirstSteps: () => ({ summary: null, status: 'ready', steps: [], starter: null, error: null, guide: { loading: false, phase: 'done' } }) }))
vi.mock('./first-run-popup', async original => ({ ...await original<typeof import('./first-run-popup')>(), useFirstRunPopup: () => ({ open: false, close() {} }) }))
vi.mock('./starter-retry', async original => ({ ...await original<typeof import('./starter-retry')>(), useStarterRetryResult: () => ({ inserted: null, record() {}, clear() {} }) }))
vi.mock('./use-dashboard', async original => ({ ...await original<typeof import('./use-dashboard')>(), useDashboard: () => ({
  bodyRef: { current: null }, supplementGate: false, selectedAccountId: 'A', selectedAccount: null,
  period: 'today', selectPeriod: vi.fn(), editorOpen: fixture.editorOpen, openEditor: fixture.openEditor, closeEditor: vi.fn(),
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
vi.mock('./dashboard-editor', () => ({ default: () => <div role="dialog" aria-label="表示の編集" /> }))
import DashboardV8 from './dashboard'
beforeEach(() => { fixture.role = 'owner'; fixture.editorOpen = false; fixture.openEditor.mockReset(); fixture.loading = false; fixture.error = '概要を読み込めませんでした'; fixture.data = null; fixture.unavailable = ''; fixture.load.mockReset(); document.documentElement.dataset.theme = 'v8'; vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false }), { headers: { 'Content-Type': 'application/json' } }))) })
afterEach(() => { cleanup(); delete document.documentElement.dataset.theme; vi.unstubAllGlobals() })

it.each(['owner', 'admin', 'staff'] as const)('%s は編集ボタンを一つだけ操作できる', (role) => {
  fixture.role = role
  render(<DashboardV8 />)
  const buttons = screen.getAllByRole('button', { name: '表示を変更する' })
  expect(buttons).toHaveLength(1)
  fireEvent.click(buttons[0])
  expect(fixture.openEditor).toHaveBeenCalledTimes(1)
})
it.each(['viewer', null] as const)('%s は編集操作できず、開いている状態でも編集画面が出ない', async (role) => {
  fixture.role = role
  fixture.editorOpen = true
  render(<DashboardV8 />)
  const buttons = screen.getAllByRole('button', { name: '表示を変更する' })
  expect(buttons).toHaveLength(1)
  fireEvent.click(buttons[0])
  expect(fixture.openEditor).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog', { name: '表示の編集' })).toBeNull()
})
it('編集権限があれば編集画面を表示する', async () => {
  fixture.editorOpen = true
  render(<DashboardV8 />)
  expect(await screen.findByRole('dialog', { name: '表示の編集' })).toBeTruthy()
})
