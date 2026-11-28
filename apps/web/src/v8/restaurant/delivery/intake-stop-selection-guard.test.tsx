// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import type { DeliveryOrdersData, DeliveryService, DeliveryServiceState } from '@/lib/restaurant-delivery-api'

const fixture = vi.hoisted(() => ({
  orders: vi.fn(),
  order: vi.fn(),
  accept: vi.fn(),
  ready: vi.fn(),
  handOver: vi.fn(),
  reject: vi.fn(),
  cancel: vi.fn(),
  history: vi.fn(),
  historyCsv: vi.fn(),
  menuItems: vi.fn(),
  bulkSoldOut: vi.fn(),
  stopIntake: vi.fn(),
  resumeIntake: vi.fn(),
  snapshot: vi.fn(),
  ubereatsConnection: vi.fn(),
}))

vi.mock('@/lib/restaurant-delivery-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/restaurant-delivery-api')>()
  return {
    ...actual,
    restaurantDeliveryApi: {
      ubereatsConnection: fixture.ubereatsConnection,
      orders: fixture.orders,
      order: fixture.order,
      accept: fixture.accept,
      ready: fixture.ready,
      handOver: fixture.handOver,
      reject: fixture.reject,
      cancel: fixture.cancel,
      history: fixture.history,
      historyCsv: fixture.historyCsv,
      menuItems: fixture.menuItems,
      bulkSoldOut: fixture.bulkSoldOut,
      stopIntake: fixture.stopIntake,
      resumeIntake: fixture.resumeIntake,
    },
  }
})

vi.mock('@/lib/restaurant-test-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/restaurant-test-api')>()
  return { ...actual, restaurantTestApi: { snapshot: fixture.snapshot } }
})

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: 'account-1',
    setSelectedAccountId: vi.fn(),
    accounts: [],
    loading: false,
  }),
}))

vi.mock('@/lib/staff-role', () => ({
  useStaffRole: () => verifiedStaffRole('owner'),
  useStaffIdentityLoad: () => ({ failed: false }),
  canManageRole: (role: string | null) => role === 'owner' || role === 'admin',
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
  usePathname: () => '/restaurant-test/delivery',
  useSearchParams: () => new URLSearchParams(''),
}))

import DeliveryPage from './delivery'
import { intakeStopSelection } from './intake-stop-selection'

function openState(service: DeliveryService, label: string): DeliveryServiceState {
  return {
    service,
    label,
    connectionStatus: 'connected',
    version: 1,
    target: `target-${service}`,
    intakeStatus: 'open',
    stopUntil: null,
    todayCount: 1,
    todayAmount: 1500,
  }
}

function ordersPayload(services: DeliveryServiceState[]): DeliveryOrdersData {
  return {
    success: true,
    store: { id: 'store-1', name: '本店' },
    services,
    kpis: {
      todayCount: 2,
      todayCountDelta: 0,
      handedOverCount: 1,
      todaySales: 3000,
      todaySalesDeltaPercent: 0,
      averageAmount: 1500,
      urgentCount: 0,
      averagePrepMinutes: 10,
      averagePrepMinutesDelta: 0,
    },
    tab: 'new',
    tabCounts: { all: 2, new: 0, cooking: 0, handed_over: 1 },
    orders: [],
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  fixture.ubereatsConnection.mockResolvedValue({ connection: { status: 'connected', lastError: null } })
  fixture.snapshot.mockResolvedValue({ data: { stores: [{ id: 'store-1', name: '本店' }] } })
  fixture.stopIntake.mockResolvedValue({ stopped: ['demaecan'], failed: [] })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('restaurant/delivery/intake-stop-selection の選択整合ガード', () => {
  it('重複は1つにまとめつつ、一覧から消えたサービスは黙って外さずに残す', () => {
    const out = intakeStopSelection(
      [openState('demaecan', '出前館')],
      ['demaecan', 'demaecan', 'rocketnow'],
      '30m',
    )
    expect(out).toEqual({ services: ['demaecan', 'rocketnow'], preset: '30m', problem: null })
  })

  it('実画面で選んだ媒体が更新後の一覧から消えた時は部分送信せず全体を止めて理由を出す', async () => {
    const both = [openState('demaecan', '出前館'), openState('rocketnow', 'ロケットナウ')]
    const demaecanOnly = [openState('demaecan', '出前館')]
    fixture.orders
      .mockResolvedValueOnce(ordersPayload(both))
      .mockResolvedValue(ordersPayload(demaecanOnly))

    render(<DeliveryPage />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    fireEvent.click(screen.getByText('受付をまとめて止める'))
    const dialog = within(screen.getByRole('alertdialog', { name: '受付を一括停止しますか？' }))
    fireEvent.click(dialog.getByRole('checkbox', { name: /出前館の受付を止める/ }))
    fireEvent.click(dialog.getByRole('checkbox', { name: /ロケットナウの受付を止める/ }))
    fireEvent.click(dialog.getByRole('button', { name: '60分', exact: true }))

    // 30秒の自動再取得でロケットナウが一覧から消えた状態にする
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })

    await act(async () => {
      fireEvent.click(dialog.getByRole('button', { name: '止める' }))
      await Promise.resolve()
    })

    expect(fixture.stopIntake).not.toHaveBeenCalled()
    expect(dialog.getByText('サービスの状態を読み直してから操作してください。')).toBeTruthy()
  })
})
