// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeliveryHistoryData, DeliveryOrderSummary, DeliveryOrdersData } from '@/lib/restaurant-delivery-api'

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
  role: { value: 'owner' as string | null },
  accountId: { value: 'account-1' as string | null },
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
    selectedAccountId: fixture.accountId.value,
    setSelectedAccountId: vi.fn(),
    accounts: [],
    loading: false,
  }),
}))

vi.mock('@/lib/staff-role', () => ({
  useStaffRole: () => fixture.role.value,
  useStaffIdentityLoad: () => ({ failed: false }),
  canManageRole: (role: string | null) => role === 'owner' || role === 'admin',
}))

vi.mock('next/navigation', async () => {
  const react = await import('react')
  const listeners = new Set<() => void>()
  for (const key of ['pushState', 'replaceState'] as const) {
    const original = window.history[key].bind(window.history)
    window.history[key] = ((...args: Parameters<History['pushState']>) => {
      original(...args)
      for (const listener of [...listeners]) listener()
    }) as History['pushState']
  }
  return {
    useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
    usePathname: () => '/restaurant-test/delivery',
    useSearchParams: () => {
      const search = react.useSyncExternalStore(
        (notify: () => void) => { listeners.add(notify); return () => { listeners.delete(notify) } },
        () => window.location.search,
        () => '',
      )
      return new URLSearchParams(search)
    },
  }
})

import DeliveryPage from './delivery'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function makeOrder(id: string, orderNumber: string): DeliveryOrderSummary {
  return {
    id,
    version: 1,
    service: 'demaecan',
    serviceLabel: '出前館',
    orderNumber,
    status: 'new',
    statusLabel: '新着',
    itemCount: 1,
    itemSummary: '唐揚げ弁当×1',
    totalAmount: 1200,
    receivedAt: '2026-11-28T01:00:00.000Z',
    wantedAt: '2026-11-28T01:20:00.000Z',
    urgency: 'normal',
    urgencyReason: null,
  }
}

function makeOrdersData(orders: DeliveryOrderSummary[] = []): DeliveryOrdersData {
  return {
    success: true,
    store: { id: 'store-1', name: '本店' },
    services: [{
      service: 'demaecan',
      label: '出前館',
      connectionStatus: 'connected',
      version: 1,
      target: 'target-demaecan',
      intakeStatus: 'open',
      stopUntil: null,
      todayCount: orders.length,
      todayAmount: 2400,
    }],
    kpis: {
      todayCount: orders.length,
      todayCountDelta: 0,
      handedOverCount: 0,
      todaySales: 2400,
      todaySalesDeltaPercent: 0,
      averageAmount: 1200,
      urgentCount: 0,
      averagePrepMinutes: 10,
      averagePrepMinutesDelta: 0,
    },
    tab: 'new',
    tabCounts: { all: orders.length, new: orders.length, cooking: 0, handed_over: 0 },
    orders,
  }
}

function makeHistoryData(orderNumber: string): DeliveryHistoryData {
  return {
    success: true,
    store: { id: 'store-1', name: '本店' },
    from: '2026-11-28',
    to: '2026-11-28',
    totals: {
      count: 1,
      sales: 1200,
      canceledCount: 0,
      byService: [{ service: 'demaecan', label: '出前館', count: 1, amount: 1200 }],
    },
    orders: [{
      id: `hist-${orderNumber}`,
      service: 'demaecan',
      serviceLabel: '出前館',
      orderNumber,
      status: 'handed_over',
      statusLabel: '受け渡し済み',
      itemSummary: '唐揚げ弁当×1',
      totalAmount: 1200,
      receivedAt: '2026-11-28T01:00:00.000Z',
      cancelReasonCode: null,
    }],
  }
}

describe('DeliveryPage URL原型防御・履歴競合破棄・CSV/一括受付防御', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    fixture.role.value = 'owner'
    fixture.accountId.value = 'account-1'
    fixture.orders.mockResolvedValue(makeOrdersData())
    fixture.snapshot.mockResolvedValue({ data: { stores: [] } })
    fixture.ubereatsConnection.mockResolvedValue({ connection: { status: 'disconnected' } })
    fixture.history.mockResolvedValue(makeHistoryData('ORD-INIT'))
    fixture.historyCsv.mockResolvedValue({ truncated: false })
    fixture.accept.mockResolvedValue({ order: makeOrder('o1', 'ORD-1') })
    window.history.replaceState(null, '', '/restaurant-test/delivery')
  })

  afterEach(() => {
    cleanup()
  })

  it('?view=toString のような Object 原型名でも落ちずに通常の注文一覧を表示する', async () => {
    window.history.replaceState(null, '', '/restaurant-test/delivery?view=toString')
    render(<DeliveryPage />)
    expect(await screen.findByRole('heading', { name: 'デリバリー受注' })).toBeTruthy()
  })

  it('注文履歴で絞り込みを変えた後に届いた古い応答が新しい一覧を上書きしない', async () => {
    window.history.replaceState(null, '', '/restaurant-test/delivery?view=history')
    const first = deferred<DeliveryHistoryData>()
    const second = deferred<DeliveryHistoryData>()
    fixture.history
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    render(<DeliveryPage />)
    await waitFor(() => expect(fixture.history).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'サービス' }))
    fireEvent.click(await screen.findByRole('button', { name: '出前館' }))
    await waitFor(() => expect(fixture.history).toHaveBeenCalledTimes(2))

    await act(async () => { second.resolve(makeHistoryData('ORD-NEW')) })
    expect(await screen.findByText(/ORD-NEW/)).toBeTruthy()

    await act(async () => { first.resolve(makeHistoryData('ORD-OLD')) })
    expect(screen.queryByText(/ORD-OLD/)).toBeNull()
    expect(screen.getByText(/ORD-NEW/)).toBeTruthy()
  })

  it('CSV保存の連打で二重送信せず、店舗切替後の古い完了通知も別店舗へ出さない', async () => {
    window.history.replaceState(null, '', '/restaurant-test/delivery?view=history')
    const csvReq = deferred<{ truncated: boolean }>()
    fixture.historyCsv.mockReturnValueOnce(csvReq.promise)

    const view = render(<DeliveryPage />)
    expect(await screen.findByText(/ORD-INIT/)).toBeTruthy()

    const csvBtn = screen.getByRole('button', { name: /CSVで書き出す/ })
    fireEvent.click(csvBtn)
    fireEvent.click(csvBtn)
    expect(fixture.historyCsv).toHaveBeenCalledTimes(1)

    fixture.accountId.value = 'account-2'
    view.rerender(<DeliveryPage />)
    await act(async () => { csvReq.resolve({ truncated: false }) })
    expect(screen.queryByText('CSVを保存しました。')).toBeNull()
  })

  it('まとめて受け付けるの途中でアカウントが切り替わったら残りの旧アカウント注文を受け付けない', async () => {
    const orders = [makeOrder('o1', 'ORD-1'), makeOrder('o2', 'ORD-2')]
    fixture.orders.mockResolvedValue(makeOrdersData(orders))
    const firstAccept = deferred<{ order: DeliveryOrderSummary }>()
    fixture.accept.mockReturnValueOnce(firstAccept.promise)

    const view = render(<DeliveryPage />)
    expect(await screen.findByText(/ORD-1/)).toBeTruthy()

    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[0]!)
    const bulkBtn = await screen.findByRole('button', { name: /まとめて受け付ける/ })
    fireEvent.click(bulkBtn)
    fireEvent.click(bulkBtn)
    await waitFor(() => expect(fixture.accept).toHaveBeenCalledTimes(1))

    fixture.accountId.value = 'account-2'
    view.rerender(<DeliveryPage />)
    await act(async () => { firstAccept.resolve({ order: orders[0]! }) })
    expect(fixture.accept).toHaveBeenCalledTimes(1)
  })
})
