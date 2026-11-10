// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import PhoneReservation from './phone'
import { tables } from '../booking-kit/test-data'

const api = vi.hoisted(() => ({ openingHours: vi.fn(), reservationsDay: vi.fn(), customerSearch: vi.fn(), customerHistory: vi.fn() }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: api }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-1' }) }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/restaurant-test/reservations', useSearchParams: () => new URLSearchParams() }))
const hours = Array.from({ length: 7 }, (_, weekday) => ({ weekday, periods: [{ opensAt: '17:00', closesAt: '23:00' }] }))
const onSave = vi.fn()
function open(time = '', day = '2026-11-02') {
  render(<PhoneReservation accountStyle="restaurant" staffRole="owner" storeId="store-1" storeName="模擬店舗" tables={tables} menuItems={[]} busy={false} preset={{ hold: true, date: new Date(`${day}T00:00:00+09:00`), time }} onBack={vi.fn()} onSave={onSave} />)
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-02T18:15:00+09:00'))
  api.openingHours.mockResolvedValue({ data: { hours } })
  api.reservationsDay.mockResolvedValue({ data: { reservations: [] } })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks() })

it.each(['2026-11-02T18:15:00+09:00', '2026-11-02T18:00:00+09:00'])('R1-11: %sで過去・同時刻を出さず、次の30分枠を出す', async now => {
  vi.setSystemTime(new Date(now))
  open()
  await screen.findByRole('button', { name: '18:30', exact: true })
  expect(api.openingHours).toHaveBeenCalledWith('account-1', 'store-1', '2026-11-02')
  for (const time of ['17:00', '17:30', '18:00']) expect(screen.queryByRole('button', { name: time, exact: true })).toBeNull()
})
it('R1-11: JSTで翌日なら営業時間の先頭から出す', async () => {
  vi.setSystemTime(new Date('2026-11-02T23:45:00Z'))
  open('', '2026-11-03')
  await screen.findByRole('button', { name: '17:00', exact: true })
})
it.each(['closed', 'null', 'undefined', 'loading', 'failed'])('R1-12: %sでは代替の17〜21時を出さない', async mode => {
  if (mode === 'loading') api.openingHours.mockReturnValue(new Promise(() => {}))
  else if (mode === 'failed') api.openingHours.mockRejectedValue(new Error('mock failure'))
  else api.openingHours.mockResolvedValue({ data: { hours: mode === 'closed' ? hours.map(day => ({ ...day, periods: [] })) : mode === 'null' ? null : undefined } })
  open()
  await waitFor(() => expect(api.openingHours).toHaveBeenCalled())
  if (mode === 'closed') await screen.findByRole('link', { name: '開ける時間を確認する' });
  if (mode === 'null') await screen.findByText(/営業時間が未設定/);
  if (mode === 'failed' || mode === 'undefined') await screen.findByText('営業時間を読み込めませんでした。')
  for (const time of ['17:00', '18:30', '21:00']) expect(screen.queryByRole('button', { name: time, exact: true })).toBeNull()
})
it.each(['past', 'closed', 'null'])('R1-31: %sの候補外のプリセット時刻は確定できない', async mode => {
  if (mode !== 'past') api.openingHours.mockResolvedValue({ data: { hours: mode === 'closed' ? [] : null } })
  open(mode === 'past' ? '17:00' : '19:00')
  await waitFor(() => expect(api.openingHours).toHaveBeenCalled())
  fireEvent.submit(document.querySelector('form')!)
  expect(await screen.findByText('空いている時間を選んでください。')).toBeTruthy()
  expect(onSave).not.toHaveBeenCalled()
})
it('R1-11: 開いたまま時刻が過ぎた候補は確定できない', async () => {
  vi.setSystemTime(new Date('2026-11-02T18:00:00+09:00'))
  open('19:00')
  await screen.findByRole('button', { name: '19:00', exact: true })
  vi.setSystemTime(new Date('2026-11-02T19:15:00+09:00'))
  fireEvent.submit(document.querySelector('form')!)
  expect(await screen.findByText('空いている時間を選んでください。')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '19:00', exact: true })).toBeNull()
  expect(onSave).not.toHaveBeenCalled()
})
it('R1-11: 過去日付のプリセット時刻は確定できない', async () => {
  vi.setSystemTime(new Date('2026-11-02T18:00:00+09:00'))
  onSave.mockClear()
  open('19:00', '2026-11-01')
  await waitFor(() => expect(api.openingHours).toHaveBeenCalled())
  fireEvent.click(document.querySelector('#rs-phone-date')!)
  expect(screen.getByRole('button', { name: '2026年11月1日（日）' }).getAttribute('aria-disabled')).toBe('true')
  fireEvent.submit(document.querySelector('form')!)
  expect(await screen.findByText('過去の日付は選べません。')).toBeTruthy()
  expect(onSave).not.toHaveBeenCalled()
})
it('営業時間内の将来時刻は確定できる', async () => {
  open('19:00')
  await screen.findByRole('button', { name: '19:00', exact: true })
  fireEvent.submit(document.querySelector('form')!)
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ startsAt: '2026-11-02T10:00:00.000Z' })))
})
