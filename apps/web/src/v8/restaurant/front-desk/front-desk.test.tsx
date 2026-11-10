// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 日付の見本を作る前に日本時間で固定し、待ち合わせのタイマーは動かす。
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T12:00:00+09:00'))
})

const api = vi.hoisted(() => ({
  createReservation: vi.fn(), postSeatVisitMark: vi.fn(), reservationsDay: vi.fn(), openingHours: vi.fn(), customerSearch: vi.fn(),
}))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: api }))

import type { RestaurantReservation, RestaurantTable } from '@/lib/restaurant-test-api'
import { reservation, tables } from '../booking-kit/test-data'
import PhoneReservationDrawer from './phone-drawer'
import WalkInDialog, { nextFreeAt } from './walk-in-dialog'
import { freeTables, openTimes, toYmd } from './slots'
import { WALK_IN_NOTE, isWalkIn, seatWalkIn } from './walk-in'

const T = tables as unknown as RestaurantTable[]
const today = (hour: number, minute = 0) => new Date(`${toYmd(new Date())}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+09:00`)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T12:00:00+09:00'))
  api.createReservation.mockResolvedValue({ success: true, data: { id: 'new-1', tableId: 't1', lineNotice: { sent: true, reason: null } } })
  api.postSeatVisitMark.mockResolvedValue({ success: true, data: { status: 'seated' } })
  api.reservationsDay.mockResolvedValue({ success: true, data: { date: '', reservations: [] } })
  api.openingHours.mockResolvedValue({ success: true, data: { hours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, periods: [{ opensAt: '17:00', closesAt: '23:00' }] })) } })
  api.customerSearch.mockResolvedValue({ success: true, data: [{ name: '見本 183', phone: '090-0000-5678', lineUid: 'U-1' }] })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks() })

describe('空いている時刻・卓の決まり', () => {
  it('人数が入る空いた卓を、余る席が少ない順に出す（重なる予約・停止中の卓は除く）', () => {
    const start = today(19).getTime()
    const rows = [reservation('r', { table_id: 't1', starts_at: today(18).toISOString(), ends_at: today(20).toISOString() })] as unknown as RestaurantReservation[]
    expect(freeTables(T, 2, start, rows).map((t) => t.code)).toEqual(['T2', 'T3', 'T4'])
    expect(freeTables(T, 6, start, rows).map((t) => t.code)).toEqual(['個室A'])
    /* 取消の予約と期限が過ぎた押さえは卓をふさがない。 */
    const gone = [
      reservation('c', { table_id: 't2', status: 'cancelled', starts_at: today(18).toISOString(), ends_at: today(20).toISOString() }),
      reservation('h', { table_id: 't3', status: 'pending', hold_expires_at: today(10).toISOString(), starts_at: today(18).toISOString(), ends_at: today(20).toISOString() }),
    ] as unknown as RestaurantReservation[]
    expect(freeTables(T, 2, start, gone, today(12).getTime()).map((t) => t.code)).toEqual(['T1', 'T2', 'T3', 'T4'])
  })

  it('開ける時間が読めないときは予約時刻を出さない', () => {
    const day = toYmd(new Date())
    expect(openTimes(day, null, today(18, 10))).toEqual([])
    expect(openTimes('2099-01-01', null, today(18))).toEqual([])
  })

  it('満席のとき、人数が入る卓がいちばん早く空く時刻を出す', () => {
    const now = today(19).getTime()
    const rows = [
      reservation('a', { table_id: 'pa', starts_at: today(18).toISOString(), ends_at: today(20, 30).toISOString() }),
    ] as unknown as RestaurantReservation[]
    expect(nextFreeAt(T, 6, rows, now)).toBe(today(20, 30).getTime())
  })
})

describe('ウォークイン（E-3）', () => {
  it('入れる口は1か所：手動予約の口でその場の時刻の予約を作り、来店の印を付ける', async () => {
    const now = today(18, 12)
    const result = await seatWalkIn('acc', { storeId: 's', guestCount: 2, tableId: 't1', now })
    expect(api.createReservation).toHaveBeenCalledWith('acc', expect.objectContaining({
      storeId: 's', source: 'manual', guestCount: 2, tableId: 't1', note: WALK_IN_NOTE, startsAt: now.toISOString(), notifyLine: false,
    }))
    expect(api.postSeatVisitMark).toHaveBeenCalledWith('acc', 'new-1', expect.objectContaining({ kind: 'visited',expectedVersion:1,requestId:expect.any(String) }))
    expect(result).toEqual({ id: 'new-1', seated: true })
    expect(isWalkIn({ source: 'manual', note: WALK_IN_NOTE })).toBe(true)
    expect(isWalkIn({ source: 'phone', note: WALK_IN_NOTE })).toBe(false)
  })

  it('来店の印が付かなくても予約は残り、画面に知らせる', async () => {
    api.postSeatVisitMark.mockRejectedValueOnce(new Error('409'))
    expect(await seatWalkIn('acc', { storeId: 's', guestCount: 2, tableId: 't1' })).toEqual({ id: 'new-1', seated: false })
  })

  it('人数の −/＋ で座れる卓を絞り直し、［入店にする］の2手で入る', async () => {
    const onSaved = vi.fn()
    render(<WalkInDialog open accountId="acc" storeId="store-1" tables={T} onClose={() => {}} onSaved={onSaved} />)
    await screen.findByText('T1')
    expect(document.querySelector('[data-design-node="nNujj"]')).not.toBeNull()
    for (let i = 0; i < 4; i += 1) fireEvent.click(screen.getByRole('button', { name: '人数を増やす' }))
    await waitFor(() => expect(screen.queryByText('T1')).toBeNull())
    expect(screen.getByText('個室A')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /入店にする/ }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ seated: true }))
    expect(api.createReservation).toHaveBeenCalledWith('acc', expect.objectContaining({ guestCount: 6, tableId: 'pa' }))
  })
})

describe('電話予約（E-2）', () => {
  it('電話番号で友だちを探し、押すと名前が入り、時刻を選んで source=phone で保存する（LINE で確認を送る）', async () => {
    const onSaved = vi.fn()
    render(<PhoneReservationDrawer staffRole="owner" storeName="人工店舗" open accountId="acc" storeId="store-1" tables={T} onClose={() => {}} onSaved={onSaved} />)
    const changeTable = screen.getByRole('button', { name: '変える' }) as HTMLButtonElement
    expect(changeTable.disabled).toBe(true)
    expect(changeTable.title).toBe('空いている時刻を選ぶと卓を変えられます')
    fireEvent.change(screen.getByRole('textbox', { name: '電話番号' }), { target: { value: '090-0000-5678' } })
    fireEvent.click(await screen.findByRole('button', { name: /見本 183/ }))
    expect((screen.getByRole('textbox', { name: 'お名前' }) as HTMLInputElement).value).toBe('見本 183')
    fireEvent.click(screen.getByText(/明日/))
    fireEvent.click(await screen.findByRole('button', { name: '19:00' }))
    expect((screen.getByRole('button', { name: '変える' }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByRole('switch', { name: 'LINE で確認を送る' })).not.toBeNull()
    fireEvent.click(screen.getByRole('switch', { name: 'LINE で確認を送る' }))
    fireEvent.click(screen.getByRole('button', { name: /予約を入れる/ }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ lineFailed: false }))
    expect(api.createReservation).toHaveBeenCalledWith('acc', expect.objectContaining({
      source: 'phone', customerName: '見本 183', customerPhone: '09000005678', lineUid: 'U-1', guestCount: 2, tableId: 't1', notifyLine: true,
    }))
  })

  it('お名前も時刻も無い間は保存を止め、欄を離れた時の2つの理由も保つ', async () => {
    render(<PhoneReservationDrawer staffRole="owner" storeName="人工店舗" open accountId="acc" storeId="store-1" tables={T} onClose={() => {}} onSaved={vi.fn()} />)
    fireEvent.click(screen.getByText(/明日/))
    const time = await screen.findByRole('button', { name: '19:00' })
    const submit = screen.getByRole('button', { name: /予約を入れる/ }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    expect(submit.getAttribute('aria-description')).toBe('お名前・時刻を入れてください。')
    fireEvent.click(submit)
    expect(api.createReservation).not.toHaveBeenCalled()
    const name = screen.getByRole('textbox', { name: 'お名前' })
    fireEvent.blur(name)
    fireEvent.blur(time)
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(document.getElementById('e2-name-error')?.textContent).toBe('お名前を入れてください。')
    expect(document.getElementById('e2-time-error')?.textContent).toBe('時刻を選んでください。')
  })

  it('友だちでないときは「LINE で確認を送る」を出さず、送らない', async () => {
    api.customerSearch.mockResolvedValue({ success: true, data: [] })
    render(<PhoneReservationDrawer staffRole="owner" storeName="人工店舗" open accountId="acc" storeId="store-1" tables={T} onClose={() => {}} onSaved={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'お名前' }), { target: { value: '田中' } })
    fireEvent.click(screen.getByText(/明日/))
    fireEvent.click(await screen.findByRole('button', { name: '19:00' }))
    expect(screen.queryByRole('switch', { name: 'LINE で確認を送る' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /予約を入れる/ }))
    await waitFor(() => expect(api.createReservation).toHaveBeenCalledWith('acc', expect.objectContaining({ lineUid: null, notifyLine: false })))
  })
})

// 日本の00:09をUTCの端末で再現する。昨日を選ばず、今日の過ぎた時刻だけ除く。
it('UTCの端末でも日付と受け付ける時刻を日本時間で選ぶ', () => {
  const previous = process.env.TZ
  process.env.TZ = 'UTC'
  try {
    const now = new Date('2026-10-10T15:09:00Z')
    expect(toYmd(now)).toBe('2026-10-11')
    expect(openTimes('2026-10-11', [{ weekday: 0, periods: [{ opensAt: '00:00', closesAt: '03:00' }] }] as Parameters<typeof openTimes>[1], now)).toEqual(['00:30', '01:00'])
    expect(openTimes('2026-10-12', [{ weekday: 1, periods: [{ opensAt: '00:00', closesAt: '03:00' }] }] as Parameters<typeof openTimes>[1], now)).toEqual(['00:00', '00:30', '01:00'])
  } finally {
    if(previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})

it('顧客へのLINEは引き出しでも既定オフで、選び直しや再開で同意を引き継がない', async () => {
 const props={open:true,accountId:'acc',storeId:'store-1',tables:T,onClose:vi.fn(),onSaved:vi.fn()}
 const view=render(<PhoneReservationDrawer staffRole="owner" storeName="人工店舗" {...props}/>)
 fireEvent.change(screen.getByRole('textbox',{name:'電話番号'}),{target:{value:'09000005678'}})
 fireEvent.click(await screen.findByRole('button',{name:/見本 183/}))
 const toggle=()=>screen.getByRole('switch',{name:'LINE で確認を送る'})
 expect(toggle().getAttribute('aria-checked')).toBe('false')
 fireEvent.click(toggle());expect(toggle().getAttribute('aria-checked')).toBe('true')
 fireEvent.click(screen.getByRole('button',{name:/見本 183/}))
 expect(screen.queryByRole('switch',{name:'LINE で確認を送る'})).toBeNull()
 fireEvent.click(screen.getByRole('button',{name:/見本 183/}))
 expect(toggle().getAttribute('aria-checked')).toBe('false')
 fireEvent.click(toggle())
 view.rerender(<PhoneReservationDrawer staffRole="owner" storeName="人工店舗" {...props} open={false}/>);view.rerender(<PhoneReservationDrawer staffRole="owner" storeName="人工店舗" {...props}/>)
 fireEvent.change(screen.getByRole('textbox',{name:'電話番号'}),{target:{value:'09000005678'}})
 fireEvent.click(await screen.findByRole('button',{name:/見本 183/}))
 expect(toggle().getAttribute('aria-checked')).toBe('false')
 fireEvent.click(screen.getByText(/明日/));fireEvent.click(await screen.findByRole('button',{name:'19:00'}))
 fireEvent.click(screen.getByRole('button',{name:/予約を入れる/}))
 await waitFor(()=>expect(api.createReservation).toHaveBeenCalledWith('acc',expect.objectContaining({notifyLine:false,lineUid:'U-1'})))
})

it.each([{accountId:'other',storeId:'store-1'},{accountId:'acc',storeId:'other'}])('引き出しの顧客へのLINE同意を別の文脈へ引き継がず、戻しても復活させない %o',async(next)=>{
 const props={open:true,accountId:'acc',storeId:'store-1',tables:T,onClose:vi.fn(),onSaved:vi.fn()}
 const view=render(<PhoneReservationDrawer staffRole="owner" storeName="人工店舗" {...props}/>)
 fireEvent.change(screen.getByRole('textbox',{name:'電話番号'}),{target:{value:'09000005678'}})
 fireEvent.click(await screen.findByRole('button',{name:/見本 183/}))
 const toggle=()=>screen.getByRole('switch',{name:'LINE で確認を送る'})
 fireEvent.click(toggle());expect(toggle().getAttribute('aria-checked')).toBe('true')
 view.rerender(<PhoneReservationDrawer staffRole="owner" storeName="人工店舗" {...props} {...next}/>);expect(toggle().getAttribute('aria-checked')).toBe('false')
 view.rerender(<PhoneReservationDrawer staffRole="owner" storeName="人工店舗" {...props}/>);expect(toggle().getAttribute('aria-checked')).toBe('false')
 expect(api.createReservation).not.toHaveBeenCalled()
})
