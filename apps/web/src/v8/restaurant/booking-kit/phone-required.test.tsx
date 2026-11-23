// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import PhoneReservation from '../reservations/phone'
import PhoneReservationDrawer from '../front-desk/phone-drawer'
import { tables } from './test-data'

const api = vi.hoisted(() => ({ openingHours: vi.fn(), reservationsDay: vi.fn(), customerSearch: vi.fn(), customerHistory: vi.fn(), createReservation: vi.fn() }))
vi.mock('@/lib/api', async original => { const actual = await original<typeof import('@/lib/api')>(); return { ...actual, api: { ...actual.api, accountSettings: { ...actual.api.accountSettings, getAllergyOptions: vi.fn(async () => ({success:true,data:{version:1,options:['卵','乳']}})) } } } })
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: api }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-1' }) }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/restaurant-test/reservations', useSearchParams: () => new URLSearchParams() }))

type Entry = 'page' | 'drawer'
const onSave = vi.fn()
function open(entry: Entry) {
  if (entry === 'drawer') render(<PhoneReservationDrawer staffRole="owner" storeName="人工店舗" open accountId="account-1" storeId="store-1" tables={tables} onClose={vi.fn()} onSaved={vi.fn()} />)
  else {
    render(<PhoneReservation accountStyle="restaurant" staffRole="owner" storeId="store-1" storeName="模擬店舗" tables={tables} menuItems={[]} busy={false} preset={{ date: new Date('2026-10-11T00:00:00+09:00') }} onBack={vi.fn()} onSave={onSave} />)
    fireEvent.click(screen.getByRole('button', { name: 'LINE 未連携の電話番号' }))
  }
}
const submit = (entry: Entry) => screen.getByRole('button', { name: entry === 'drawer' ? '予約を入れる' : '台帳に入れる' }) as HTMLButtonElement
async function complete(entry: Entry) {
  fireEvent.change(screen.getByRole('textbox', { name: 'お名前' }), { target: { value: '模擬の予約者' } })
  if (entry === 'drawer') fireEvent.click(screen.getByRole('button', { name: /明日/ }))
  fireEvent.click(await screen.findByRole('button', { name: '19:00' }))
  await waitFor(() => expect(submit(entry).disabled).toBe(false))
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T12:00:00+09:00'))
  api.openingHours.mockResolvedValue({ data: { hours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, periods: [{ opensAt: '17:00', closesAt: '23:00' }] })) } })
  api.reservationsDay.mockResolvedValue({ data: { reservations: [] } })
  api.customerSearch.mockResolvedValue({ data: [] })
  api.customerHistory.mockResolvedValue({ data: { visitCount: 0, visits: [] } })
  api.createReservation.mockResolvedValue({ data: { lineNotice: { sent: false } } })
  onSave.mockResolvedValue(false)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks() })

it.each<Entry>(['page', 'drawer'])('%s: 空欄では主ボタンを止め、不足した必須だけを1つの理由で伝える', async entry => {
  open(entry)
  expect(submit(entry).disabled).toBe(true)
  const reason = submit(entry).getAttribute('aria-description')
  expect(reason).toBe('お名前・時刻を入れてください。')
  expect(screen.getAllByText(reason!)).toHaveLength(1)
  expect(submit(entry).hasAttribute('data-permission-locked')).toBe(false)
  fireEvent.click(submit(entry))
  expect(api.createReservation).not.toHaveBeenCalled()
  expect(onSave).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole('textbox', { name: 'お名前' }), { target: { value: '　 ' } })
  expect(submit(entry).getAttribute('aria-description')).toBe(reason)
})

it.each<Entry>(['page', 'drawer'])('%s: 既存の必須が揃うと理由が消え、任意の電話番号が空でも従来の内容で保存できる', async entry => {
  open(entry); await complete(entry)
  expect(submit(entry).getAttribute('aria-description')).toBeNull()
  expect(screen.queryByText('お名前・時刻を入れてください。')).toBeNull()
  fireEvent.click(submit(entry))
  await waitFor(() => expect(entry === 'drawer' ? api.createReservation : onSave).toHaveBeenCalledOnce())
  const body = entry === 'drawer' ? api.createReservation.mock.calls[0][1] : onSave.mock.calls[0][0]
  expect(body).toMatchObject({ source: 'phone', storeId: 'store-1', customerName: '模擬の予約者', customerPhone: null, lineUid: null, guestCount: 2, notifyLine: false })
})

it.each<Entry>(['page', 'drawer'])('%s: 非空の不正な電話番号は既存の欄検証で断り、入力を残す', async entry => {
  open(entry); await complete(entry)
  const phone = screen.getByRole('textbox', { name: '電話番号' }) as HTMLInputElement
  fireEvent.change(phone, { target: { value: 'abc' } })
  expect(submit(entry).disabled).toBe(false)
  fireEvent.click(submit(entry))
  expect(await screen.findByText('電話番号は0から始まる10〜11桁の数字で入れてください。')).toBeTruthy()
  expect(phone.value).toBe('abc')
  expect((screen.getByRole('textbox', { name: 'お名前' }) as HTMLInputElement).value).toBe('模擬の予約者')
  expect(api.createReservation).not.toHaveBeenCalled()
  expect(onSave).not.toHaveBeenCalled()
  await waitFor(() => expect(document.activeElement).toBe(phone))
})

it('通常画面: LINEの人を選ばない場合と仮押さえの必須を区別する', async () => {
  open('page')
  fireEvent.click(screen.getByRole('button', { name: 'LINE の友だち' }))
  expect(submit('page').getAttribute('aria-description')).toBe('お客さま・時刻を入れてください。')
  fireEvent.click(screen.getByRole('radio', { name: /枠だけ押さえる/ }))
  expect(screen.getByRole('button', { name: '枠を押さえる' }).getAttribute('aria-description')).toBe('時刻を入れてください。')
  fireEvent.click(await screen.findByRole('button', { name: '19:00' }))
  const hold = screen.getByRole('button', { name: '枠を押さえる' }) as HTMLButtonElement
  await waitFor(() => expect(hold.disabled).toBe(false))
  fireEvent.change(screen.getByLabelText('仮押さえの期限（分）'), { target: { value: '' } })
  expect(hold.disabled).toBe(true)
  expect(hold.getAttribute('aria-description')).toBe('仮押さえの期限を入れてください。')
  fireEvent.change(screen.getByLabelText('仮押さえの期限（分）'), { target: { value: '-1' } })
  expect(hold.disabled).toBe(false)
  fireEvent.click(hold)
  expect(await screen.findByText('期限は1〜120分で入れてください。')).toBeTruthy()
  expect(onSave).not.toHaveBeenCalled()
})

it('右窓: 日付や時刻が未選択になると不足した項目を理由に出す', async () => {
  open('drawer'); await complete('drawer')
  fireEvent.click(screen.getByRole('button', { name: '19:00' }))
  expect(submit('drawer').disabled).toBe(true)
  expect(submit('drawer').getAttribute('aria-description')).toBe('時刻を入れてください。')
  fireEvent.click(screen.getByRole('button', { name: '日付を選ぶ' }))
  expect(submit('drawer').getAttribute('aria-description')).toBe('日付・時刻を入れてください。')
  expect(api.createReservation).not.toHaveBeenCalled()
})

it('通常画面: 人数の空と非空の不正値を分け、日付を消すと不足案内へ戻す', async () => {
  open('page'); await complete('page')
  const count = screen.getByLabelText('人数') as HTMLInputElement
  fireEvent.change(count, { target: { value: '' } })
  expect(submit('page').disabled).toBe(true)
  expect(submit('page').getAttribute('aria-description')).toBe('人数を入れてください。')
  fireEvent.change(count, { target: { value: '-1' } })
  expect(submit('page').disabled).toBe(false)
  fireEvent.click(submit('page'))
  expect(await screen.findByText('人数は1〜100で入れてください。')).toBeTruthy()
  expect(count.value).toBe('-1')
  expect(onSave).not.toHaveBeenCalled()
  fireEvent.change(count, { target: { value: '2' } })
  fireEvent.click(screen.getByRole('button', { name: '日付を消す' }))
  expect(submit('page').disabled).toBe(true)
  expect(submit('page').getAttribute('aria-description')).toBe('日付・時刻を入れてください。')
  expect(onSave).not.toHaveBeenCalled()
})
