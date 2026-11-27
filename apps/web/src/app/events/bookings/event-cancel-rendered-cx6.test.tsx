// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({ account: 'account-a', listBookings: vi.fn(), absence: vi.fn(), getBookingSummary: vi.fn(), getEvent: vi.fn(), listEvents: vi.fn(), listOccurrenceSelector: vi.fn(), getOccurrenceApplicants: vi.fn(), adminCancelBooking: vi.fn() }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(), useSearchParams: () => new URLSearchParams('id=event-1') }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fx.account, accounts: [{ id: 'account-a', name: 'A店', role: 'owner' }, { id: 'account-b', name: 'B店', role: 'owner' }] }) }))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/lib/api/helpers/gap2', () => ({ bookingMakeupApi: { absenceByStore: fx.absence } }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, eventsApi: { ...actual.eventsApi, ...fx }, api: { ...actual.api, staff: { ...actual.api.staff, me: vi.fn().mockResolvedValue({ success: true, data: { id: 'me', role: 'owner', isActive: true } }) } } }
})
import Page from './page'

beforeEach(() => {
  fx.account = 'account-a'
  fx.listBookings.mockResolvedValue({ items: [], total: 0 })
  fx.getBookingSummary.mockResolvedValue({ requested: 0, confirmed: 1, cancelled: 0, totalCapacity: 10 })
  fx.getEvent.mockResolvedValue({ id: 'event-1', name: '相談会', waitlist_enabled: 1 })
  fx.listEvents.mockResolvedValue({ items: [], total: 0 })
  fx.listOccurrenceSelector.mockResolvedValue({ items: [{ id: 'slot-1', starts_at: '2099-06-01T01:00:00.000Z', ends_at: '2099-06-01T02:00:00.000Z', is_active: 1 }] })
  fx.getOccurrenceApplicants.mockResolvedValue({ occurrence: { id: 'slot-1', eventId: 'event-1', startsAt: '2099-06-01T01:00:00.000Z', endsAt: '2099-06-01T02:00:00.000Z', capacity: 5, activeSeats: 1, version: 4 }, summary: { bookingCount: 1, waitingCount: 0, activeSeats: 1 }, snapshotId: 'snapshot-1', snapshotExpiresAt: '2099-06-01T00:15:00.000Z', applicants: [{ source: 'booking', id: 'booking-1', friendId: 'friend-1', displayName: '申込 太郎', pictureUrl: null, status: 'confirmed', partySize: 1, appliedAt: '2099-05-01T01:00:00.000Z', answers: null, firstParticipation: { isFirst: null, attendedCount: null, checkedAt: null }, offeredAt: null, offerExpiresAt: null }] })
  fx.adminCancelBooking.mockResolvedValue({ ok: true })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

async function openCancel() {
  const menu = await waitFor(() => {
    const element = document.querySelector<HTMLButtonElement>('[data-booking-id="booking-1"][data-booking-action="menu"]')
    expect(element).toBeTruthy()
    return element!
  })
  fireEvent.click(menu)
  fireEvent.click(await screen.findByRole('menuitem', { name: 'キャンセルにする' }))
  return screen.findByRole('alertdialog')
}

it('誰の予約かと通知・記録への影響を確認窓に示す', async () => {
  render(<Page />)
  const dialog = await openCancel()
  expect(within(dialog).getByText(/申込 太郎/)).toBeTruthy()
  expect(dialog.textContent).toContain('友だちへLINEでお知らせが届き')
  expect(dialog.textContent).toContain('この操作は元に戻せません。')
  expect(dialog.textContent).toContain('この予約の通知予定も停止し、送信済みの記録は残ります。')
  const submit = within(dialog).getByRole('button', { name: 'キャンセルする' })
  expect(submit.getAttribute('data-variant')).toBe('danger')
  expect(fx.adminCancelBooking).not.toHaveBeenCalled()
})

it('処理中は二重に送らず、失敗を窓に残して再試行できる', async () => {
  let finish!: (value: { ok: boolean }) => void
  fx.adminCancelBooking.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  render(<Page />)
  const dialog = await openCancel()
  const submit = within(dialog).getByRole('button', { name: 'キャンセルする' })
  fireEvent.click(submit)
  fireEvent.click(submit)
  expect(fx.adminCancelBooking).toHaveBeenCalledTimes(1)
  expect(fx.adminCancelBooking).toHaveBeenCalledWith('account-a', 'event-1', 'booking-1')
  expect((submit as HTMLButtonElement).disabled).toBe(true)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.getByRole('alertdialog')).toBeTruthy()
  await act(async () => finish({ ok: false }))
  expect(await within(dialog).findByText(/この予約をキャンセルできませんでした/)).toBeTruthy()
  expect((submit as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(submit)
  await waitFor(() => expect(fx.adminCancelBooking).toHaveBeenCalledTimes(2))
})

it('アカウントを切り替えると古い窓を閉じ、古い応答は新しい処理を終わらせない', async () => {
  let finishA!: (value: { ok: boolean }) => void
  let finishB!: (value: { ok: boolean }) => void
  fx.adminCancelBooking.mockReturnValueOnce(new Promise(resolve => { finishA = resolve })).mockReturnValueOnce(new Promise(resolve => { finishB = resolve }))
  const view = render(<Page />)
  const dialogA = await openCancel()
  fireEvent.click(within(dialogA).getByRole('button', { name: 'キャンセルする' }))
  expect(fx.adminCancelBooking).toHaveBeenCalledWith('account-a', 'event-1', 'booking-1')
  fx.account = 'account-b'
  view.rerender(<Page />)
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  const dialogB = await openCancel()
  const submitB = within(dialogB).getByRole('button', { name: 'キャンセルする' }) as HTMLButtonElement
  fireEvent.click(submitB)
  expect(fx.adminCancelBooking).toHaveBeenCalledWith('account-b', 'event-1', 'booking-1')
  expect(submitB.disabled).toBe(true)
  await act(async () => finishA({ ok: false }))
  expect(screen.getByRole('alertdialog')).toBe(dialogB)
  expect(submitB.disabled).toBe(true)
  expect(within(dialogB).queryByText(/この予約をキャンセルできませんでした/)).toBeNull()
  await act(async () => finishB({ ok: false }))
  expect(await within(dialogB).findByText(/この予約をキャンセルできませんでした/)).toBeTruthy()
  expect(submitB.disabled).toBe(false)
})
