// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeliveryOrderDetailData } from '@/lib/restaurant-delivery-api'
import { CancelOrderDialog, OrderDetailDialog } from './order-detail'

describe('OrderDetailDialog / CancelOrderDialog 原型名・異常数量・送信中理由選択防御', () => {
  afterEach(() => {
    cleanup()
  })

  it('OrderDetailDialog で service/status/urgency に原型名・未知値や負数/NaN数量が来ても安全に表示する', () => {
    const detail = {
      order: {
        id: 'ord-1',
        version: 1,
        service: 'toString',
        serviceLabel: '',
        orderNumber: '1234',
        status: 'constructor',
        statusLabel: '状態不明',
        totalAmount: 1500,
        itemCount: 1,
        itemSummary: '弁当',
        urgency: 'toString',
        urgencyReason: 'テスト理由',
        receivedAt: '2026-11-28T01:00:00Z',
        wantedAt: '2026-11-28T01:20:00Z',
        pickupMethod: '店頭受け取り',
        acceptedAt: null,
        readyAt: null,
        handedOverAt: null,
        canceledAt: null,
        customerNote: null,
      },
      items: [
        { name: '唐揚げ弁当', quantity: Number.NaN, amount: 1500, note: null },
        { name: '味噌汁', quantity: -2, amount: 200, note: null },
      ],
    } as unknown as DeliveryOrderDetailData

    const { container } = render(
      <OrderDetailDialog
        open
        loading={false}
        error={null}
        detail={detail}
        busy={false}
        canManage
        uberOrderActionsEnabled={false}
        onClose={vi.fn()}
        onRetry={vi.fn()}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onReady={vi.fn()}
        onHandOver={vi.fn()}
        onCancelOrder={vi.fn()}
      />,
    )

    expect(screen.getByText('#1234')).toBeTruthy()
    expect(screen.getByText('唐揚げ弁当')).toBeTruthy()
    expect(container.textContent).not.toContain('function toString')
    expect(container.textContent).not.toContain('×NaN')
    expect(container.textContent).not.toContain('×-2')
    expect(screen.getAllByText('×—')).toHaveLength(2)
  })

  it('CancelOrderDialog の送信中（busy）はキャンセル理由の選択も無効化される', () => {
    render(
      <CancelOrderDialog
        open
        accountId="acc-1"
        store={{ id: 'store-1', name: '本店' }}
        orderNumber="1234"
        serviceLabel="出前館"
        totalAmount={1500}
        reasonCode="out_of_stock"
        busy
        error={null}
        onReasonChange={vi.fn()}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )

    const reasonBtn = screen.getByRole('button', { name: 'キャンセルの理由' }) as HTMLButtonElement
    expect(reasonBtn.disabled).toBe(true)
  })
})
