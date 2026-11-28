// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

/* コース・クラスのお支払い：版つきで保存し、古い版（409）は共通の帯と比べる窓で選んでもらう。 */

const net = vi.hoisted(() => ({
  courseMode: vi.fn(), saveCourseMode: vi.fn(), eventMode: vi.fn(), saveEventMode: vi.fn(), eventPrice: vi.fn(), saveEventPrice: vi.fn(),
}))
vi.mock('@/lib/api', async (load) => {
  const actual = await load<typeof import('@/lib/api')>()
  return { ...actual, bookingApi: { ...actual.bookingApi, getPaymentConfig: async () => ({ success: true, data: { mode: 'onsite', provider: 'onsite', holdMinutes: 10, keyConfigured: true, testMode: true } }) } }
})
vi.mock('@/lib/api/helpers/booking-payment-admin', async (load) => {
  const actual = await load<typeof import('@/lib/api/helpers/booking-payment-admin')>()
  return {
    ...actual,
    bookingPaymentAdminApi: {
      ...actual.bookingPaymentAdminApi,
      connection: async () => ({ success: true, data: { connected: true, testMode: true, accountIdTail: null, connectedAt: null, dashboardUrl: null } }),
      ...net,
    },
  }
})

const { ApiError } = await import('@/lib/api')
const { MenuPaymentCard, PaymentConflictError, useMenuPayment } = await import('./menu-payment')

let saveRef: ((id?: string) => Promise<void>) | null = null
function Course() {
  const state = useMenuPayment('course', 'acc-1', 'c1')
  saveRef = state.save
  return <MenuPaymentCard state={state} name="course" price={8800} />
}
function ClassPrice() {
  const state = useMenuPayment('event', 'acc-1', 'e1')
  saveRef = state.save
  return <MenuPaymentCard state={state} name="event" price={null} priceField />
}

beforeEach(() => {
  net.courseMode.mockResolvedValue({ success: true, data: { mode: null, version: 3 } })
  net.saveCourseMode.mockResolvedValue({ success: true, data: { mode: 'online', version: 4 } })
  net.eventMode.mockResolvedValue({ success: true, data: { mode: null, version: 1 } })
  net.eventPrice.mockResolvedValue({ success: true, data: { unitPrice: 2200, version: 5 } })
  net.saveEventPrice.mockResolvedValue({ success: true, data: { unitPrice: 2500, version: 6 } })
})
afterEach(() => { cleanup(); vi.clearAllMocks(); saveRef = null })

it('コースは読んだ版を添えて保存する', async () => {
  render(<Course />)
  fireEvent.click(await screen.findByRole('radio', { name: /このメニューだけ変更する/ }))
  await act(async () => { await saveRef?.() })
  expect(net.saveCourseMode).toHaveBeenCalledWith('acc-1', 'c1', 'online', 3)
})

it('版が古い（409）ときは入力を残し、共通の帯から最新と比べられる', async () => {
  net.saveCourseMode.mockRejectedValueOnce(new ApiError(409, 'conflict', 'version_conflict'))
  render(<Course />)
  fireEvent.click(await screen.findByRole('radio', { name: /このメニューだけ変更する/ }))
  let thrown: unknown = null
  await act(async () => { try { await saveRef?.() } catch (cause) { thrown = cause } })
  expect(thrown).toBeInstanceOf(PaymentConflictError)
  expect(await screen.findByText(/ほかの人が先に/)).toBeTruthy()
  expect((screen.getByRole('radio', { name: /このメニューだけ変更する/ }) as HTMLInputElement).checked).toBe(true)
  net.courseMode.mockResolvedValueOnce({ success: true, data: { mode: 'onsite', version: 4 } })
  fireEvent.click(screen.getByRole('button', { name: /違いを比べる/ }))
  expect(await screen.findByText(/お支払い：あなた「オンラインで先払い」／最新「お店で払う」/)).toBeTruthy()
})

it('クラスの 1 回の値段は単価の口へ版つきで送る', async () => {
  render(<ClassPrice />)
  const field = await screen.findByLabelText('1回の値段')
  fireEvent.change(field, { target: { value: '2500' } })
  await act(async () => { await saveRef?.() })
  await waitFor(() => expect(net.saveEventPrice).toHaveBeenCalledWith('acc-1', 'e1', 2500, 5))
  expect(net.saveEventMode).not.toHaveBeenCalled()
})
