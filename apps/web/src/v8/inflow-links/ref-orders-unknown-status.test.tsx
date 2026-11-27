// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ fetchApi: vi.fn() }))
vi.mock('@/lib/api', async (original) => ({ ...await original<typeof import('@/lib/api')>(), fetchApi: fixture.fetchApi }))
vi.mock('@/components/shared/list-url-state', async (original) => ({ ...await original<typeof import('@/components/shared/list-url-state')>(), useListUrlValue: () => [1, vi.fn()] }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
import RefOrdersPanel from './ref-orders'

afterEach(() => { cleanup(); vi.resetAllMocks() })

it('未知の注文状態が継承名でも空欄にせず、既知の状態と返金額も表示する', async () => {
  const order = { providerStatus: '', currency: 'JPY', totalAmount: 1000, refundedAmount: null, orderedAt: '2026-11-01T00:00:00Z', detailUrl: null, friend: { id: 'friend-1', displayName: '見本 1' } }
  fixture.fetchApi.mockResolvedValue({ success: true, data: { refCode: 'sample', total: 2, summary: { refunded: 1, cancelled: 0, totalAmount: 2000, refundedAmount: 200 }, items: [
    { ...order, id: 'unknown', orderNumber: 'sample-1', status: 'constructor' },
    { ...order, id: 'known', orderNumber: 'sample-2', status: 'refunded', refundedAmount: 200 },
  ] } })
  render(<RefOrdersPanel refCode="sample" />)
  expect(await screen.findByText('constructor')).toBeTruthy()
  expect(screen.getByText(/返金済み.*200/)).toBeTruthy()
  expect(screen.getByText('sample-1')).toBeTruthy()
})
