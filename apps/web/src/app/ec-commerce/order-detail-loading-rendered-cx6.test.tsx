// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'



vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      ecCommerce: {
        ...actual.api.ecCommerce,
        orderDetail: vi.fn(),
      },
    },
  }
})

import { api, type EcOrderDetail } from '@/lib/api'
import OrderDetailDrawer from '@/v8/settings/ec-commerce/order-drawer'

const mockOrderDetail = api.ecCommerce.orderDetail as unknown as ReturnType<typeof vi.fn>

function fixture(): EcOrderDetail {
  return {
    order: {
      id: 'order-1',
      lineAccountId: 'account-1',
      externalOrderId: '9001',
      orderNumber: 'NEN-1001',
      customerId: 'customer-1',
      friendId: null,
      customerName: null,
      status: 'current',
      providerStatus: '新規受付',
      currency: 'JPY',
      totalAmount: 2860,
      refundedAmount: null,
      orderedAt: '2026-09-16T00:00:00.000Z',
      detailUrl: 'https://ec.example/admin/order/9001',
      version: 1,
      orderLines: [{ productName: '鹿肉ミンチ', quantity: 2, unitAmount: 1430, imageUrl: null, detailUrl: null }],
    },
    events: [{
      id: 'ev-1',
      externalEventId: 'ext-1',
      eventType: 'ec.order.confirmed',
      status: 'identity_pending',
      failureKind: 'unlinked',
      receivedAt: '2026-09-16T00:00:00.000Z',
      processedAt: null,
      actions: [{
        id: 'act-1', eventId: 'ev-1', eventType: 'ec.order.confirmed',
        actionType: 'ec_process_event', ruleVersion: 'v1', status: 'skipped',
        attemptCount: 1, maxAttempts: 3,
        errorCode: 'line_identity_unmatched', errorMessage: 'LINEの友だちが見つかりません',
        lastAttemptedAt: '2026-09-16T00:01:00.000Z', nextRetryAt: null, version: 1,
        receivedAt: '2026-09-16T00:00:00.000Z', orderNumber: 'NEN-1001',
        customerName: null, friendId: null, retryAvailable: false,
        failureKind: 'unlinked',
        attempts: [{ attemptNumber: 1, triggerKind: 'automatic', toStatus: 'skipped', errorCode: 'line_identity_unmatched', errorMessage: 'LINEの友だちが見つかりません', createdAt: '2026-09-16T00:01:00.000Z' }],
      }],
      dispatches: [{ subscriber: 'v6', status: 'sent', attemptCount: 1, updatedAt: '2026-09-16T00:01:00.000Z', failureKind: null }],
      deliveries: [],
    }],
    followUps: [],
    outcomes: { conversions: [], mileage: [], scores: [] },
  }
}

let container: HTMLDivElement
let root: Root

function render(props: Partial<React.ComponentProps<typeof OrderDetailDrawer>> = {}) {
  act(() => {
    root.render(
      <OrderDetailDrawer
        orderId="order-1"
        accountId="account-1"
        onClose={() => undefined}
        onRetryAction={async () => undefined}
        retryingId={null}
        {...props}
      />,
    )
  })
}

beforeAll(() => {
  // happy-dom + React19: act 環境フラグ。
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  vi.clearAllMocks()
  document.documentElement.dataset.theme = 'v8'
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mockOrderDetail.mockResolvedValue({ success: true, data: fixture() })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete document.documentElement.dataset.theme
  document.body.innerHTML = ''
})

async function settle() {
  await act(async () => { await Promise.resolve() })
}

it.each(['success', 'failure'] as const)('読み込み中は内容を出さず、遅い旧注文の%sを捨てる', async (outcome) => {
  let finish!: (value: unknown) => void
  let reject!: (error: Error) => void
  mockOrderDetail.mockReturnValueOnce(new Promise((resolve, fail) => { finish = resolve; reject = fail }))
  const newer = fixture()
  newer.order.orderNumber = '新しい注文'
  mockOrderDetail.mockResolvedValueOnce({ success: true, data: newer })
  render()
  await settle()
  expect(document.querySelector('[data-list-state="loading"]')?.getAttribute('aria-label')).toBe('注文の状況を読み込んでいます')
  expect(document.body.textContent).not.toContain('NEN-1001')
  render({ orderId: 'order-2', accountId: 'account-2' })
  await settle()
  expect(mockOrderDetail).toHaveBeenCalledWith('order-2', 'account-2')
  expect(document.body.textContent).toContain('新しい注文')
  await act(async () => { if (outcome === 'success') finish({ success: true, data: fixture() }); else reject(new Error('old failure')) })
  await settle()
  expect(document.body.textContent).toContain('新しい注文')
  expect(document.body.textContent).not.toContain('注文 NEN-1001')
  expect(document.body.textContent).not.toContain('注文の状況を読み込めませんでした')
})
