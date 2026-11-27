// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeliveryOrdersData } from '@/lib/restaurant-delivery-api'
import OrdersBoard from './orders'

afterEach(cleanup)

const SAMPLE_DATA: DeliveryOrdersData = {
  tab: 'new',
  tabCounts: { new: 1, cooking: 0, handed_over: 0, all: 1 },
  services: [
    {
      service: 'demaecan',
      label: '出前館',
      connectionStatus: 'connected',
      intakeStatus: 'stopped',
      stopUntil: 'invalid-date',
      todayCount: -3,
      todayAmount: 0,
    },
  ],
  kpis: {
    todayCount: 1,
    todayCountDelta: 0,
    handedOverCount: 0,
    todaySales: 1200,
    todaySalesDeltaPercent: 0,
    averageAmount: 1200,
    urgentCount: 0,
    averagePrepMinutes: 10,
    averagePrepMinutesDelta: 0,
  },
  orders: [
    {
      id: 'ord-1',
      orderNumber: '1001',
      service: 'demaecan',
      serviceLabel: '出前館',
      itemSummary: '唐揚げ弁当',
      totalAmount: 1200,
      receivedAt: '2026-10-09T03:00:00Z',
      urgency: 'normal',
      urgencyReason: '',
      status: 'new',
      statusLabel: '新着',
    },
  ],
}

describe('restaurant/delivery/orders のページ範囲・停止時刻・負件数ガード', () => {
  it('page=0 や perPage=0 でも空表や負の範囲を出さず 1ページ目を表示する', () => {
    const { container } = render(
      <OrdersBoard
        data={SAMPLE_DATA}
        uberConnectionStatus={null}
        page={0}
        perPage={0}
        busyOrderId={null}
        busyService={null}
        canManage={false}
        uberOrderActionsEnabled={false}
        nowMs={Date.parse('2026-10-09T03:10:00Z')}
        selected={[]}
        bulkBusy={false}
        onToggleSelect={vi.fn()}
        onToggleSelectAll={vi.fn()}
        onBulkAccept={vi.fn()}
        onTab={vi.fn()}
        onOpenHistory={vi.fn()}
        onOpenOrder={vi.fn()}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onReady={vi.fn()}
        onHandOver={vi.fn()}
        onStopService={vi.fn()}
        onResumeService={vi.fn()}
        onPage={vi.fn()}
        onPerPage={vi.fn()}
      />,
    )

    const text = container.textContent ?? ''
    expect(text).toContain('#1001')
    expect(text).toContain('1件中 1〜1件を表示')
    expect(text).not.toContain('-3件')
    expect(container.querySelector('[title*="— まで停止"]')).toBeNull()
  })
})
