// @vitest-environment happy-dom
/*
 * ★V8-B  注文の状況の引き出し：読む口・4つの段・失敗したものだけ理由と「もう一度やる」・権限なし。
 */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ orderDetail: vi.fn() }))
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, api: { ecCommerce: { orderDetail: fixture.orderDetail } } }
})
import { ApiError } from '@/lib/api'
import OrderDrawer from './order-drawer'

const action = (status: string, retryAvailable: boolean) => ({
  id: `action-${status}`, eventId: 'e', eventType: 'ec.order.confirmed', actionType: 'line_notification', ruleVersion: 'v', status,
  attemptCount: 1, maxAttempts: 3, errorCode: null, errorMessage: status === 'succeeded' ? null : 'LINEが送信を受け付けませんでした', lastAttemptedAt: null,
  nextRetryAt: null, version: 1, receivedAt: '2026-10-01T12:02:00.000Z', orderNumber: 'A-1', customerName: '見本 16', retryAvailable, failureKind: null, attempts: [],
})
const detail = (failed: boolean) => ({
  order: { id: 'order-1', lineAccountId: 'account-1', externalOrderId: 'x', orderNumber: 'A-1', customerId: 'c', friendId: 'friend-1', customerName: '見本 16', status: 'current', providerStatus: 'confirmed', currency: 'JPY', totalAmount: 7540, refundedAmount: 0, orderedAt: '2026-10-01T12:02:00.000Z', detailUrl: null, version: 1, orderLines: [{ id: 'l', productId: 'p', productName: '鹿肉ドライ 1kg', quantity: 1, unitAmount: 7540, lineAmount: 7540, productUrl: null }] },
  events: [{ id: 'e', externalEventId: 'x', eventType: 'ec.order.confirmed', status: failed ? 'failed' : 'processed', failureKind: null, receivedAt: '2026-10-01T12:02:00.000Z', processedAt: null, actions: [action(failed ? 'retryable_failed' : 'succeeded', failed)], dispatches: [], deliveries: [] }],
  followUps: [{ id: 'f', campaignKey: 'k', campaignLabel: '口コミのお願い', scheduledAt: '2026-10-12T01:00:00.000Z', status: 'pending', attempts: 0, sentAt: null, reason: null, failureKind: null }],
  outcomes: { conversions: [], mileage: [{ id: 'm', entryType: 'earn', amount: 75, status: 'confirmed', reason: '商品を買った', occurredAt: '2026-10-01T12:03:00.000Z' }], scores: [] },
})

beforeEach(() => { fixture.orderDetail.mockResolvedValue({ success: true, data: detail(false) }) })
afterEach(() => { cleanup(); vi.resetAllMocks() })

it('注文1件の口を読み、4つの段を時刻つきの行で出す', async () => {
  render(<OrderDrawer orderId="order-1" accountId="account-1" onClose={() => undefined} onRetryAction={async () => undefined} retryingId={null} />)
  expect(await screen.findByRole('heading', { name: '注文 A-1' })).toBeTruthy()
  expect(fixture.orderDetail).toHaveBeenCalledWith('order-1', 'account-1')
  for (const title of ['注文の内容', 'この注文に届いた出来事', '成果・マイル・スコア', '発送後に届く案内']) expect(screen.getByRole('heading', { name: title })).toBeTruthy()
  expect(screen.getByText('鹿肉ドライ 1kg ×1')).toBeTruthy()
  expect(screen.getByText('マイル +75')).toBeTruthy()
  // 絵 ：日付だけを短く出し、時刻つきの全文は乗せたときに見せる。
  expect(screen.getByText('10/12 予定')).toBeTruthy()
  expect(screen.getByTitle('10月12日 10:00 予定')).toBeTruthy()
  // 済んだ出来事は1行だけ（理由もやり直しも出さない）
  expect(screen.queryByRole('button', { name: 'もう一度やる' })).toBeNull()
  expect(screen.queryByText(/処理済み/)).toBeNull()
})

it('失敗した出来事だけ理由と「もう一度やる」を出し、押すと戻して読み直す', async () => {
  fixture.orderDetail.mockResolvedValue({ success: true, data: detail(true) })
  const onRetry = vi.fn(async () => undefined)
  render(<OrderDrawer orderId="order-1" accountId="account-1" onClose={() => undefined} onRetryAction={onRetry} retryingId={null} />)
  expect(await screen.findByText(/LINEが送信を受け付けませんでした/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'もう一度やる' }))
  await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(fixture.orderDetail).toHaveBeenCalledTimes(2))
})

it('見る権限がないときは、失敗とは分けて伝える', async () => {
  fixture.orderDetail.mockRejectedValue(new ApiError(403, 'forbidden'))
  render(<OrderDrawer orderId="order-1" accountId="account-1" onClose={() => undefined} onRetryAction={async () => undefined} retryingId={null} />)
  expect(await screen.findByText('この注文の状況を見る権限がありません')).toBeTruthy()
})

it('WEB193：やり直しの間に別の注文へ移ったら、前の注文を読み直して上書きしない', async () => {
  const b = detail(false)
  b.order = { ...b.order, id: 'order-2', orderNumber: 'B-2' }
  fixture.orderDetail.mockImplementation(async (orderId: string) => ({ success: true, data: orderId === 'order-2' ? b : detail(true) }))
  let finishRetry: () => void = () => undefined
  const onRetry = vi.fn(() => new Promise<void>((resolve) => { finishRetry = resolve }))
  const view = render(<OrderDrawer orderId="order-1" accountId="account-1" onClose={() => undefined} onRetryAction={onRetry} retryingId={null} />)
  expect(await screen.findByText(/LINEが送信を受け付けませんでした/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'もう一度やる' }))
  view.rerender(<OrderDrawer orderId="order-2" accountId="account-1" onClose={() => undefined} onRetryAction={onRetry} retryingId={null} />)
  expect(await screen.findByRole('heading', { name: '注文 B-2' })).toBeTruthy()
  finishRetry()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(screen.getByRole('heading', { name: '注文 B-2' })).toBeTruthy()
  expect(fixture.orderDetail.mock.calls.filter(([id]) => id === 'order-1')).toHaveLength(1)
})

it('閲覧のみでは失敗理由を読めるが、もう一度やる操作は隠す', async () => {
  fixture.orderDetail.mockResolvedValue({ success: true, data: detail(true) })
  render(<OrderDrawer orderId="order-1" accountId="account-1" onClose={() => undefined} onRetryAction={async () => undefined} retryingId={null} canEdit={false} />)
  expect(await screen.findByText(/LINEが送信を受け付けませんでした/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'もう一度やる' })).toBeNull()
})
