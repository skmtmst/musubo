// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({ fetch: vi.fn(), summary: vi.fn() }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/lib/api', async original => ({ ...(await original<typeof import('@/lib/api')>()), fetchApi: fx.fetch }))
import RefOrdersPanel from '@/v8/inflow-links/ref-orders'

const order = { id: 'order-1', orderNumber: '注文-123', status: 'refunded', providerStatus: 'refunded', currency: 'JPY', totalAmount: 2400, refundedAmount: 400, orderedAt: '2026-09-01T12:00:00Z', detailUrl: null, friend: { id: 'friend-1', displayName: '購入 太郎' } }
const result = { refCode: 'shop qr', total: 1, summary: { refunded: 1, cancelled: 0, totalAmount: 2400, refundedAmount: 400 }, items: [order] }
beforeEach(() => {
  window.history.replaceState({}, '', '/inflow-links/detail')
  window.dispatchEvent(new PopStateEvent('popstate'))
  fx.fetch.mockResolvedValue({ success: true, data: result })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })
function draw() { return render(<RefOrdersPanel refCode="shop qr" accountId="account-a" onSummaryChange={fx.summary} />) }

it('注文の読み込み中は0件とせず、取得した件数と明細を同じ応答から出す', async () => {
  let finish!: (value: unknown) => void
  fx.fetch.mockReturnValue(new Promise(resolve => { finish = resolve }))
  draw()
  await waitFor(() => expect(document.querySelector('[data-list-state="loading"]')).toBeTruthy())
  expect(screen.queryByText('計測できる注文はまだありません')).toBeNull()
  expect(fx.summary).not.toHaveBeenCalled()
  const url = new URL(fx.fetch.mock.calls[0][0] as string, 'http://local.test')
  expect(url.pathname).toBe('/api/analytics/ref/shop%20qr/orders')
  expect(url.searchParams.get('lineAccountId')).toBe('account-a')
  expect(url.searchParams.get('limit')).toBe('10')
  await act(async () => finish({ success: true, data: result }))
  expect(await screen.findByText('注文-123')).toBeTruthy()
  expect(screen.getByText(/この経路からの注文/).textContent).toContain('全1 件')
  expect(screen.getByText(/返金済み/).textContent).toContain('400')
  expect(fx.summary).toHaveBeenCalledWith({ total: 1, refunded: 1, cancelled: 0, totalAmount: 2400, refundedAmount: 400 })
})

it('取得失敗は0件と区別し、再読み込みが0件なら空を示す', async () => {
  fx.fetch.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ success: true, data: { ...result, total: 0, items: [] } })
  draw()
  expect(await screen.findByText('注文を読み込めませんでした。再読み込みしてください。')).toBeTruthy()
  expect(document.querySelector('[data-list-state="error"]')).toBeTruthy()
  expect(screen.queryByText('計測できる注文はまだありません')).toBeNull()
  expect(fx.summary).toHaveBeenCalledWith(null)
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  expect(await screen.findByText('計測できる注文はまだありません')).toBeTruthy()
  expect(document.querySelector('[data-list-state="empty"]')).toBeTruthy()
  expect(fx.summary).toHaveBeenLastCalledWith(expect.objectContaining({ total: 0 }))
})

it('帰属する注文と計測できない範囲、二重に数えないことを説明する', async () => {
  draw()
  await screen.findByText('注文-123')
  const description = screen.getByText(/この経路にはじめて来た友だちの注文だけを数えます/)
  expect(description.textContent).toContain('計測できない')
  expect(description.textContent).toContain('二重には数えません')
})
