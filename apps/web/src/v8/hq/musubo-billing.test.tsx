// @vitest-environment happy-dom
import React from 'react'
import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { BillingSummary } from '@/lib/hq-billing'
import MusuboBilling from './musubo-billing'

const base: NonNullable<BillingSummary['newPricing']> = {
  status: 'trialing', billingInterval: 'month', activeLines: [{ id: 'line-1', name: '公式LINE A' }],
  trialLastFreeDate: '2026-12-08', firstChargeDate: '2026-12-09', quoteId: null,
  estimatedPrice: null, contractedCore: null,
}

it('shows the active LINE and the trial date without a made-up charge', () => {
  render(<MusuboBilling pricing={base} invoices={[]} invoiceFailed={false} onRetry={vi.fn()}
    portalAvailable={false} canManagePayment={true} onPortal={vi.fn()} />)
  expect(screen.getByText('公式LINE A')).toBeTruthy()
  expect(screen.getByText('接続するLINEと料金条件が確定すると表示されます。')).toBeTruthy()
  expect(screen.getByText('無料体験中です。無料期間は12月8日までです。')).toBeTruthy()
  expect(screen.queryByText('ライト')).toBeNull()
})

it('shows the fixed eleven-LINE base amount even with one LINE connected', () => {
  render(<MusuboBilling pricing={{ ...base, quoteId: 'quote-fixed',
    contractedCore: { lineCapacity: 11, amountYen: 78_500, interval: 'month' } }}
    invoices={[]} invoiceFailed={false} onRetry={vi.fn()}
    portalAvailable={false} canManagePayment={true} onPortal={vi.fn()} />)
  expect(screen.getByText('¥78,500')).toBeTruthy()
  expect(screen.getByText(/接続数が少なくても無料期間終了後に請求します/)).toBeTruthy()
})
