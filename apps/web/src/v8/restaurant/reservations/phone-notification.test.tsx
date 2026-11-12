// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import PhoneReservation from './phone'
import { tables } from '../booking-kit/test-data'
const api = vi.hoisted(() => ({ openingHours: vi.fn(), reservationsDay: vi.fn(), customerSearch: vi.fn(), customerHistory: vi.fn() }))
const account = vi.hoisted(() => ({ selectedAccountId: 'account-1', accounts: [] }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: api }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => account }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/restaurant-test/reservations', useSearchParams: () => new URLSearchParams() }))
const person = { name: '予約の本人', phone: '09000005678', lineUid: 'U-one' }
const props = { storeId: 'store-1', storeName: 'お店', tables, menuItems: [], busy: false, preset: { date: new Date('2026-11-02T00:00:00+09:00'), time: '19:00' }, onBack: vi.fn(), onSave: vi.fn() }
const notice = () => screen.getByRole('checkbox', { name: /予約を受け付けたことを、いますぐ LINE に送る/ }) as HTMLInputElement
async function choose(name = person.name) {
  fireEvent.change(screen.getByRole('searchbox', { name: '名前・電話番号で探す' }), { target: { value: name } })
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(name + '（') }))
}
async function save() {
  await waitFor(() => expect((screen.getByRole('button', { name: '台帳に入れる' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '台帳に入れる' }))
  await waitFor(() => expect(props.onSave).toHaveBeenCalled())
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-02T12:00:00+09:00'))
  account.selectedAccountId = 'account-1'
  props.onSave.mockResolvedValue(false)
  api.openingHours.mockResolvedValue({ data: { hours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, periods: [{ opensAt: '17:00', closesAt: '23:00' }] })) } })
  api.reservationsDay.mockResolvedValue({ data: { reservations: [] } })
  api.customerSearch.mockResolvedValue({ data: [person] })
  api.customerHistory.mockResolvedValue({ data: { visitCount: 0, visits: [] } })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks() })
it('顧客へのLINEは未選択では出さず、友だちを選んでも既定オフで保存する', async () => {
  render(<PhoneReservation accountStyle="restaurant" staffRole="owner" {...props} />)
  expect(screen.queryByRole('checkbox')).toBeNull()
  await choose(); expect(notice().checked).toBe(false)
  await save(); expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({ lineUid: 'U-one', notifyLine: false }))
})
it('顧客へのLINEは本人を選び明示的にオンにした時だけ送る', async () => {
  render(<PhoneReservation accountStyle="restaurant" staffRole="owner" {...props} />); await choose()
  expect(notice().checked).toBe(false); fireEvent.click(notice()); await save()
  expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({ lineUid: 'U-one', notifyLine: true }))
  expect(notice().checked).toBe(true)
})
it('顧客へのLINEは未連携の電話番号では出さず、送信もfalseにする', async () => {
  render(<PhoneReservation accountStyle="restaurant" staffRole="owner" {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'LINE 未連携の電話番号' }))
  fireEvent.change(screen.getByLabelText('お名前'), { target: { value: '電話の本人' } })
  fireEvent.change(screen.getByLabelText('電話番号'), { target: { value: '09000005678' } })
  expect(screen.queryByRole('checkbox')).toBeNull(); await save()
  expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({ lineUid: null, notifyLine: false }))
})
it('顧客へのLINEの同意を別の本人へ引き継がない', async () => {
  render(<PhoneReservation accountStyle="restaurant" staffRole="owner" {...props} />); await choose(); if (!notice().checked) fireEvent.click(notice())
  api.customerSearch.mockResolvedValue({ data: [{ ...person, name: '別の本人', lineUid: 'U-two' }] })
  await choose('別の本人'); expect(notice().checked).toBe(false); await save()
  expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({ lineUid: 'U-two', notifyLine: false }))
})
it('顧客へのLINEの同意を押さえとの切替で解除する', async () => {
  render(<PhoneReservation accountStyle="restaurant" staffRole="owner" {...props} />); await choose(); if (!notice().checked) fireEvent.click(notice())
  fireEvent.click(screen.getByRole('radio', { name: /枠だけ押さえる/ }))
  expect(screen.queryByRole('checkbox')).toBeNull()
  fireEvent.click(screen.getByRole('radio', { name: /お客さまの予約を入れる/ }))
  expect(notice().checked).toBe(false)
})
it.each([{account:'account-2',store:'store-1'},{account:'account-1',store:'store-2'}])('顧客へのLINEの同意を別の店舗やアカウントへ引き継がない %o', async ({account:nextAccount,store}) => {
  const view = render(<PhoneReservation accountStyle="restaurant" staffRole="owner" {...props} />); await choose(); if (!notice().checked) fireEvent.click(notice())
  account.selectedAccountId = nextAccount
  view.rerender(<PhoneReservation accountStyle="restaurant" staffRole="owner" {...props} storeId={store} />)
  expect(notice().checked).toBe(false); await save()
  expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({ storeId: store, notifyLine: false }))
})

it('顧客へのLINEの同意を電話番号への切替と同じ本人の選び直しでも解除する',async()=>{
 render(<PhoneReservation accountStyle="restaurant" staffRole="owner" {...props}/>);await choose();fireEvent.click(notice())
 fireEvent.click(screen.getByRole('button',{name:'LINE 未連携の電話番号'}))
 expect(screen.queryByRole('checkbox')).toBeNull()
 fireEvent.click(screen.getByRole('button',{name:'LINE の友だち'}))
 await choose();expect(notice().checked).toBe(false)
})
it('検索した人がLINE未連携なら顧客へのLINE操作を出さずfalseで保存する',async()=>{
 api.customerSearch.mockResolvedValue({data:[{...person,lineUid:''}]})
 render(<PhoneReservation accountStyle="restaurant" staffRole="owner" {...props}/>);await choose()
 expect(screen.queryByRole('checkbox')).toBeNull();await save()
 expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({lineUid:null,notifyLine:false}))
})
