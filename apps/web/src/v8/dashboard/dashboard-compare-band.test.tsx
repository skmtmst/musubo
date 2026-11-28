// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardComparisons } from '@line-crm/shared'

/*
 * ダッシュボードの数の帯に、比べる値を組み込んだ形。
 * 比べられる「今日の予約」だけに札を出し、受信・写真審査・出荷は比べない。
 */
const fx = vi.hoisted(() => ({ comparisons: vi.fn(), data: null as unknown, todayActive: 12 as number | null }))
/* ガイドは未開始。ここは数の帯を見る所なので、案内は何も出さない形で渡す。 */
const IDLE_GUIDE = vi.hoisted(() => ({
  phase: 'idle' as const, stepKey: null, procedureIndex: 1, anchor: null, pausedAnchor: null,
  start: vi.fn(), pause: vi.fn(), resume: vi.fn(), reset: vi.fn(), advanceProcedure: vi.fn(),
}))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('') }))
vi.mock('@/components/shared/list-navigation', async original => ({ ...(await original<object>()), useListNavigationRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ refreshAccounts: vi.fn(), selectedAccountId: 'A', selectedAccount: null, loading: false }) }))
vi.mock('@/lib/staff-role', async original => ({ ...(await original<object>()), useStaffRole: () => 'owner', useStaffIdentity: () => null }))
vi.mock('./first-steps', async original => ({ ...await original<typeof import('./first-steps')>(), useFirstSteps: () => ({ error: null, summary: null, steps: [], folded: false, toggle: vi.fn(), reload: vi.fn(), guide: IDLE_GUIDE }), FirstStepsCard: () => null }))
vi.mock('@/v8/onboarding/public/use-style-setup/index', () => ({ useStyleSetup: () => ({ data: null, error: null, reload: vi.fn() }) }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, dashboard: { ...actual.api.dashboard, comparisons: fx.comparisons } } }
})
vi.mock('./use-dashboard', async original => ({
  ...(await original<object>()),
  useDashboard: () => ({
    bodyRef: { current: null }, supplementGate: false, selectedAccountId: 'A', selectedAccount: null,
    period: 'today', selectPeriod: vi.fn(), editorOpen: false, openEditor: vi.fn(), closeEditor: vi.fn(),
    data: fx.data, displayedPeriod: 'today', periodNotice: '', loading: false, error: '', load: vi.fn(),
    preferences: { main: [], right: [] }, preferenceVersion: 0, preferenceSaving: false, preferenceSaveError: null,
    visibleToday: [{ id: 'today-inbox' }, { id: 'today-photo-review' }, { id: 'today-bookings' }, { id: 'today-shipments' }], visibleRight: [],
    handleShipmentSummary: vi.fn(), handleInboxSummary: vi.fn(), shipmentSummary: { today: 1, soon: 2 }, shipmentState: 'ready',
    pendingPhotos: 3, pendingPhotosState: 'ready', bookings: [], bookingsFailed: false, todayActiveBookings: fx.todayActive,
    displayedBookings: [], todayBookings: [], upcomingBookings: [], supplementLoading: false, supplementLoadedAt: null,
    healthFailed: false, healthIssueCount: 0, displayedHealthRisk: 'normal', displayedTwoFactor: null, supportMarkAutoOnInbound: null,
    sectionAvailable: () => true, activeFriends: 140, lineUnread: 1, mailUnread: 0, pendingTotal: 1, pendingDetailState: 'ready',
    pendingOldest: 5, notifications: [], notificationFailed: false, staffName: null, today: '2026-10-25', reference: null,
  }),
}))
import DashboardV8 from './dashboard'

const overview = { generatedAt: '2026-10-25T08:51:00Z', asOf: '2026-10-25T08:50:00Z', freshness: 'fresh' }
const comparisons = (todayBookings: DashboardComparisons['comparisons']['todayBookings']): DashboardComparisons => ({
  generatedAt: '2026-10-25T17:51:00+09:00',
  comparisons: { todayBookings, activeFriends: null, deliveryFailures: null, monthlySent: null, monthlyBroadcasts: null },
  skipped: todayBookings ? {} : { todayBookings: 'no_previous_record' },
})
const booking = { current: 12, previous: 10, better: 'high' as const, basis: 'same_weekday_last_week' as const, asOf: '2026-10-25T17:51:00+09:00', previousFrom: '2026-10-18T00:00:00+09:00', previousTo: '2026-10-19T00:00:00+09:00' }
const band = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-design="TodayTasks"]')!
const cell = (container: HTMLElement, title: string) => [...band(container).children].find((child) => child.querySelector('[data-kpi-label]')?.getAttribute('title') === title) as HTMLElement

beforeEach(() => { fx.data = overview; fx.todayActive = 12; fx.comparisons.mockReset() })
afterEach(cleanup)

describe('数の帯の前週比', () => {
  it('今日の予約だけに「2 件 先週比」の札。帯の上に時点と比べる基準の1行', async () => {
    fx.comparisons.mockResolvedValue({ success: true, data: comparisons(booking) })
    const { container } = render(<DashboardV8 />)
    await waitFor(() => expect(cell(container, '今日の予約').querySelector('[data-kpi-delta]')).not.toBeNull())
    expect(cell(container, '今日の予約').querySelector<HTMLElement>('[data-kpi-delta]')?.dataset.kpiDelta).toBe('good')
    expect(cell(container, '今日の予約').textContent).toContain('2 件 先週比')
    expect(band(container).querySelectorAll('[data-kpi-delta]')).toHaveLength(1)
    expect(container.textContent).toContain('10月25日 17:51 時点・先週の同じ曜日と比べています')
    expect(container.querySelector('[data-design="TodayTasks"]')?.previousElementSibling?.querySelector('p')?.textContent).toBe('10月25日 17:51 時点・先週の同じ曜日と比べています')
  })

  it('先週の記録が無い時は札を出さず、基準の言葉も出さない（0 として比べない）', async () => {
    fx.comparisons.mockResolvedValue({ success: true, data: comparisons(null) })
    const { container } = render(<DashboardV8 />)
    await waitFor(() => expect(fx.comparisons).toHaveBeenCalledWith('A'))
    await waitFor(() => expect(container.textContent).toContain('10月25日 17:51 時点'))
    expect(band(container).querySelector('[data-kpi-delta]')).toBeNull()
    expect(band(container).textContent).not.toContain('先週比')
    expect(container.textContent).not.toContain('先週の同じ曜日と比べています')
  })

  it('帯の数（12 件）と比べる値の今の数が違う時は、矛盾して見えるので札も基準の言葉も出さない', async () => {
    fx.todayActive = 10
    fx.comparisons.mockResolvedValue({ success: true, data: comparisons(booking) })
    const { container } = render(<DashboardV8 />)
    await waitFor(() => expect(fx.comparisons).toHaveBeenCalledWith('A'))
    await waitFor(() => expect(container.textContent).toContain('10月25日 17:51 時点'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(band(container).querySelector('[data-kpi-delta]')).toBeNull()
    expect(container.textContent).not.toContain('先週の同じ曜日と比べています')
  })

  it('概要が読めるまで比べる値を読まない', async () => {
    fx.data = null
    fx.comparisons.mockResolvedValue({ success: true, data: comparisons(booking) })
    render(<DashboardV8 />)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fx.comparisons).not.toHaveBeenCalled()
  })
})
