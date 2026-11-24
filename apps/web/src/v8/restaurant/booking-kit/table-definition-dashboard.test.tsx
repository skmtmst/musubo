// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import StyleDashboard from '@/v8/style-dashboard/style-dashboard'
import { snapshotOf, store, tables } from './test-data'
import type { RestaurantSnapshot } from '@/lib/restaurant-test-api'
const api = vi.hoisted(() => ({ openingHours: vi.fn(), reservationsDay: vi.fn(), createReservation: vi.fn(), snapshot: vi.fn() }))
const state = vi.hoisted(() => ({ data: null as RestaurantSnapshot | null, entry: 'walk-in' as 'phone' | 'walk-in' }))
/* 初回ポップアップ（枠02/02b）はガイド案内中に重ねないので、止まっている状態を渡す。 */
const IDLE_GUIDE = vi.hoisted(() => ({
  phase: 'idle' as const, stepKey: null, procedureIndex: 1, anchor: null, pausedAnchor: null,
  start: vi.fn(), pause: vi.fn(), resume: vi.fn(), reset: vi.fn(), advanceProcedure: vi.fn(),
}))
vi.mock('@/lib/api/helpers/reservation-board', () => ({ reservationBoardApi: { floors: vi.fn(async () => ({ data: [] })) } }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: api }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/restaurant-test/dashboard', useSearchParams: () => new URLSearchParams() }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/v8/onboarding/public/use-style-setup/index', () => ({ useStyleSetup: () => ({ status: 'success' }) }))
vi.mock('@/v8/onboarding/public/setup-wizard/index', () => ({ useSetupWizard: () => ({}) }))
vi.mock('@/v8/dashboard/public/first-steps/index', async original => ({ ...(await original<typeof import('@/v8/dashboard/public/first-steps/index')>()), useFirstSteps: () => ({ status: 'success', guide: IDLE_GUIDE }) }))
vi.mock('@/v8/events', () => ({ useEventAbsence: () => ({ allowed: false }) }))
vi.mock('@/v8/style-dashboard/use-style-dashboard', async () => {
  const { useState } = await import('react'); const { STYLE_CONFIG } = await import('@/v8/style-dashboard/config')
  return { useStyleDashboard: () => {
    const [phoneOpen, setPhoneOpen] = useState(state.entry === 'phone'); const [walkInOpen, setWalkInOpen] = useState(false)
    return { cfg: STYLE_CONFIG.restaurant, router: { push: vi.fn() }, tab: 'main', range: 'today', view: 'calendar', date: '2026-10-10', staff: 'all', compare: 'previous', role: 'owner', canWrite: true, accountId: 'account-1', search: '', failed: true, busy: '', today: null, preparing: {}, defaultMetrics: [],
      store: { accountId: 'account-1', snapshot: state.data!, loading: false, error: null, store: state.data!.stores[0], tableDefinition: { accountId: 'account-1', snapshot: state.data! } }, tables: state.data!.tables,
      phoneOpen, setPhoneOpen, walkInOpen, setWalkInOpen }
  } }
})
afterEach(() => { cleanup(); vi.useRealTimers() })
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-10T12:00:00+09:00'))
  state.data = snapshotOf({ tables: tables.filter(t => t.is_active).map(t => ({ ...t, max_capacity: Math.min(t.max_capacity, 6) })), stores: [store] }) as RestaurantSnapshot
  api.openingHours.mockResolvedValue({ data: { hours: Array.from({length:7}, (_, weekday) => ({weekday, periods:[{opensAt:'17:00',closesAt:'23:00'}]})) } }); api.reservationsDay.mockResolvedValue({ data: { reservations: [] } })
})
it.each(['phone', 'walk-in'] as const)('業種ダッシュボードの親から %s へ取得情報を渡し、追加取得・保存せず理由を出す', async entry => {
  state.entry = entry
  render(<StyleDashboard style="restaurant" />)
  if (entry === 'phone') await screen.findByRole('button', { name: '19:00' })
  else { fireEvent.click(screen.getByRole('button', { name: 'ウォークイン' })); await screen.findByText('T1') }
  for (let i = 0; i < 5; i++) fireEvent.click(screen.getByRole('button', { name: '人数を増やす' }))
  expect(await screen.findAllByText('結合を含め最大6名のため、7名は入れません。')).toHaveLength(1)
  expect(api.snapshot).not.toHaveBeenCalled(); expect(api.createReservation).not.toHaveBeenCalled()
})
