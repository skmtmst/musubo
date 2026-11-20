// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GettingStartedStarter } from '@/lib/api'

/*
 * 初期セットが入っていない時の帯（SPEC-11 1-3）。判定は Worker の starter.applied だけ。
 * ［入れ直す］は今の版で入れ直しの口を呼び、閲覧のみの人には出さない。
 */
const fx = vi.hoisted(() => ({
  role: 'owner' as string,
  starter: null as GettingStartedStarter | null,
  ensure: vi.fn(),
  startReload: vi.fn(),
  setupReload: vi.fn(),
  /* ガイドは未開始。ここは差し込みの再試行を見る所なので、案内は何も出さない形で渡す。 */
  guide: {
    phase: 'idle' as const, stepKey: null, procedureIndex: 1, anchor: null, pausedAnchor: null,
    start: vi.fn(), pause: vi.fn(), resume: vi.fn(), reset: vi.fn(), advanceProcedure: vi.fn(),
  },
}))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('') }))
vi.mock('@/components/shared/list-navigation', async original => ({ ...(await original<object>()), useListNavigationRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ refreshAccounts: vi.fn(), selectedAccountId: 'A', selectedAccount: null, loading: false }) }))
vi.mock('@/lib/staff-role', async original => ({ ...(await original<object>()), useStaffRole: () => fx.role, useStaffIdentity: () => null }))
vi.mock('./first-steps', async original => ({
  ...await original<typeof import('./first-steps')>(),
  useFirstSteps: () => ({ error: null, summary: null, folded: false, toggle: vi.fn(), reload: fx.startReload, steps: [], firstRun: null, starter: fx.starter, arrived: false, guide: fx.guide }),
  FirstStepsCard: () => null,
}))
vi.mock('@/v8/onboarding/public/use-style-setup/index', () => ({
  useStyleSetup: () => ({ data: { state: { style: 'restaurant', styleSelected: true, version: 7, answers: {} }, warnings: [], items: [] }, error: null, reload: fx.setupReload }),
}))
vi.mock('@/lib/api/helpers/styles', async original => {
  const actual = await original<typeof import('@/lib/api/helpers/styles')>()
  return { ...actual, styleApi: { ...actual.styleApi, ensureStarterItems: fx.ensure } }
})
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, dashboard: { ...actual.api.dashboard, comparisons: vi.fn(async () => ({ success: false, error: 'off' })) } } }
})
vi.mock('./use-dashboard', async original => ({
  ...(await original<object>()),
  useDashboard: () => ({
    bodyRef: { current: null }, supplementGate: false, selectedAccountId: 'A', selectedAccount: null,
    period: 'today', selectPeriod: vi.fn(), editorOpen: false, openEditor: vi.fn(), closeEditor: vi.fn(),
    data: null, displayedPeriod: 'today', periodNotice: '', loading: false, error: '', load: vi.fn(),
    preferences: { main: [], right: [] }, preferenceVersion: 0, preferenceSaving: false, preferenceSaveError: null,
    visibleToday: [], visibleRight: [],
    handleShipmentSummary: vi.fn(), handleInboxSummary: vi.fn(), shipmentSummary: null, shipmentState: 'ready',
    pendingPhotos: 0, pendingPhotosState: 'ready', bookings: [], bookingsFailed: false, todayActiveBookings: null,
    displayedBookings: [], todayBookings: [], upcomingBookings: [], supplementLoading: false, supplementLoadedAt: null,
    healthFailed: false, healthIssueCount: 0, displayedHealthRisk: 'normal', displayedTwoFactor: null, supportMarkAutoOnInbound: null,
    sectionAvailable: () => true, activeFriends: 0, lineUnread: 0, mailUnread: 0, pendingTotal: 0, pendingDetailState: 'ready',
    pendingOldest: null, notifications: [], notificationFailed: false, staffName: null, today: '2026-10-26', reference: null,
  }),
}))
import { ApiError } from '@/lib/api'
import DashboardV8 from './dashboard'

const retryButton = () => screen.queryByRole('button', { name: '入れ直す' })

beforeEach(() => {
  fx.role = 'owner'
  fx.starter = { applied: false, count: 0, missing: 4 }
  fx.ensure.mockReset()
  fx.startReload.mockReset()
  fx.setupReload.mockReset()
})
afterEach(cleanup)

describe('初期セットが入っていない時の［入れ直す］', () => {
  it('入っていない時だけ帯を出し、押すと今の版で入れ直しの口を呼んで読み直す', async () => {
    fx.ensure.mockResolvedValue({ success: true, data: { inserted: [{ key: 'welcome', kind: 'template' }, { key: 'menu', kind: 'rich_menu' }], skipped: [], existing: 0, starterSet: { id: 's', version: 1 } } })
    render(<DashboardV8 />)
    expect(screen.getByText('初期セットに準備待ちがあります')).toBeTruthy()
    expect(screen.getByText(/4 件を準備できます/)).toBeTruthy()
    fireEvent.click(retryButton()!)
    await waitFor(() => expect(fx.ensure).toHaveBeenCalledWith('A', 7))
    await screen.findByText('初期セットを 2 件入れました。送る物は止めた状態で入っています。')
    expect(fx.startReload).toHaveBeenCalledTimes(1)
    expect(fx.setupReload).toHaveBeenCalledTimes(1)
    expect(retryButton()).toBeNull()
  })

  it('入っている時・入れる物が無い時は出さない', () => {
    fx.starter = { applied: true, count: 6, missing: 0 }
    const { rerender } = render(<DashboardV8 />)
    expect(screen.queryByText('初期セットに準備待ちがあります')).toBeNull()
    fx.starter = { applied: false, count: 0, missing: 0 }
    rerender(<DashboardV8 />)
    expect(screen.queryByText('初期セットに準備待ちがあります')).toBeNull()
  })

  it('閲覧のみの人には帯も［入れ直す］も出さない', () => {
    fx.role = 'viewer'
    render(<DashboardV8 />)
    expect(retryButton()).toBeNull()
    expect(screen.queryByText('初期セットに準備待ちがあります')).toBeNull()
  })

  it('入れる数を数えられない時は押せる形にせず、理由を言う', () => {
    fx.starter = { applied: false, count: 0, missing: null }
    render(<DashboardV8 />)
    expect(screen.getByText('初期セットに準備待ちがあります')).toBeTruthy()
    expect(retryButton()).toBeNull()
    expect(screen.getByText(/ここでは入れ直せません/)).toBeTruthy()
  })

  it('ほかの人が先にスタイルを変えていた時は、入ったとは言わずに読み直す', async () => {
    fx.ensure.mockRejectedValue(new ApiError(409, 'version_conflict', 'version_conflict'))
    render(<DashboardV8 />)
    fireEvent.click(retryButton()!)
    await screen.findByText('ほかの人が先にスタイルを変えました。読み直したので、もう一度お試しください。')
    expect(screen.queryByText(/件入れました/)).toBeNull()
    expect(fx.startReload).toHaveBeenCalledTimes(1)
  })
})
