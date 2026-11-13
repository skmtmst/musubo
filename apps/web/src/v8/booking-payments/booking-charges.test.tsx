// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const requests = vi.hoisted(() => ({ charges: vi.fn(), card: vi.fn(), charge: vi.fn(), waive: vi.fn() }))
vi.mock('@/lib/api/helpers/gap1', () => ({ bookingCancellationApi: requests }))
vi.mock('@/lib/api/helpers/booking-advanced', () => ({ bookingAdvancedApi: { card: requests.card } }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
import { BookingChargesSection } from './booking-charges'
const props = { accountId: 'a', bookingId: 'b', customerName: '確認用', bookingLabel: '予約', price: 1000, canCharge: true, canRefund: true }
const data = (testMode: boolean) => ({ success: true, data: { testMode, charges: [{ id: 'charge', kind: 'no_show_fee', status: 'pending', amount: 1000, version: 2, reason: null }], quote: { text: '確認用の決まり' } } })
beforeEach(() => {
  Object.values(requests).forEach((request) => request.mockReset())
  requests.charges.mockResolvedValue(data(true))
  requests.card.mockResolvedValue({ success: true, data: { brand: 'VISA', last4: '4242', registeredAt: null } })
})
afterEach(cleanup)

it('カード取得失敗を未登録にせず、その場の再取得だけで復旧する', async () => {
  requests.card.mockRejectedValueOnce(new Error('offline'))
  render(<BookingChargesSection {...props} />)
  await screen.findByText('カード情報を読み込めませんでした')
  expect(screen.queryByText('カード：未登録')).toBeNull()
  expect((screen.getByRole('button', { name: 'キャンセル料を請求する' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  await screen.findByText(/VISA •••• 4242/)
  expect(requests.charges).toHaveBeenCalledTimes(1)
  expect(requests.charge).not.toHaveBeenCalled()
})

it('試験でない請求は共通の準備中を出し、請求の口を呼ばない', async () => {
  requests.charges.mockResolvedValue(data(false))
  render(<BookingChargesSection {...props} />)
  await screen.findByText(/VISA •••• 4242/)
  await waitFor(() => expect((screen.getByRole('button', { name: 'キャンセル料を請求する' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル料を請求する' }))
  await screen.findByRole('dialog', { name: '現在準備中です' })
  expect(screen.queryByRole('dialog', { name: 'キャンセル料を請求しますか？' })).toBeNull()
  expect(requests.charge).not.toHaveBeenCalled()
})

it('請求しない確認に対象・アカウント・環境を表示する', async () => {
  render(<BookingChargesSection {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: '請求しない（理由を書く）' }))
  const dialog = await screen.findByRole('dialog', { name: 'キャンセル料を請求しませんか？' })
  expect(dialog.textContent).toContain('確認用')
  expect(dialog.textContent).toContain('LINEアカウント')
  expect(dialog.textContent).toContain('環境')
})

it('請求する権限が消えた後は古い確認から請求しない決定を送らない', async () => {
  const view = render(<BookingChargesSection {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: '請求しない（理由を書く）' }))
  const dialog = await screen.findByRole('dialog', { name: 'キャンセル料を請求しませんか？' })
  fireEvent.change(within(dialog).getByLabelText('請求しない理由'), { target: { value: '店の都合のため' } })
  view.rerender(<BookingChargesSection {...props} canCharge={false} />)
  const old = screen.queryByRole('dialog', { name: 'キャンセル料を請求しませんか？' })
  if (old) fireEvent.click(within(old).getByRole('button', { name: '請求しない' }))
  expect(requests.waive).not.toHaveBeenCalled()
})

it('確認した請求の版とアカウントで請求しないと記録する', async () => {
  requests.waive.mockResolvedValue({ success: true, data: {} })
  render(<BookingChargesSection {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: '請求しない（理由を書く）' }))
  const dialog = await screen.findByRole('dialog', { name: 'キャンセル料を請求しませんか？' })
  fireEvent.change(within(dialog).getByLabelText('請求しない理由'), { target: { value: '店の都合のため' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '請求しない' }))
  await waitFor(() => expect(requests.waive).toHaveBeenCalledWith('a', 'charge', '店の都合のため', 2))
})

it('権限を戻しても前の請求しない確認を復活させない', async () => {
  const view = render(<BookingChargesSection {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: '請求しない（理由を書く）' }))
  await screen.findByRole('dialog', { name: 'キャンセル料を請求しませんか？' })
  view.rerender(<BookingChargesSection {...props} canCharge={false} />)
  view.rerender(<BookingChargesSection {...props} />)
  expect(screen.queryByRole('dialog', { name: 'キャンセル料を請求しませんか？' })).toBeNull()
})
