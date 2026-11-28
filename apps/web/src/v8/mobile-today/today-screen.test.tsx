// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ account: 'a', allowed: true, key: null as string | null, style: 'salon', enabled: true, getToday: vi.fn(), listStores: vi.fn(), reservationsDay: vi.fn() }))
vi.mock('@/components/mobile/mobile-screen', () => ({ default: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }))
vi.mock('@/components/mobile/mobile-shell', () => ({ useMobileShell: () => ({ ready: true, canView: (key: string) => fixture.allowed && (!fixture.key || fixture.key === key) }) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fixture.account }) }))
vi.mock('@/lib/api', () => ({ bookingApi: { getToday: fixture.getToday } }))
vi.mock('@/hooks/use-account-style', () => ({ useAccountStyle: () => ({ status: 'ready', data: { style: fixture.style }, reload: vi.fn() }) }))
vi.mock('@/lib/use-feature-visibility', () => ({ useFeatureVisibility: () => ({ status: 'ready', enabled: () => fixture.enabled }) }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: { listStores: fixture.listStores, reservationsDay: fixture.reservationsDay } }))
import MobileTodayScreen from './today-screen'

const row = { kind: 'seat', id: 'r1', starts_at: '2026-11-26T10:00:00Z', status: 'confirmed', customer_name: '見本 太郎', store_name: '本店', guest_count: 2, course_name: 'コース' }
beforeEach(() => { fixture.account = 'a'; fixture.allowed = true; fixture.key = null; fixture.style = 'salon'; fixture.enabled = true; fixture.getToday.mockResolvedValue({ timeline: [row] }) })
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers() })

it('アカウントの今日の席・人を読み取り、金額や更新操作を出さない', async () => {
 render(<MobileTodayScreen />)
 expect(await screen.findByText('見本 太郎')).toBeTruthy()
 expect(fixture.getToday).toHaveBeenCalledWith('a', expect.objectContaining({ mode: 'staff', date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }))
 expect(screen.getByText('本店・2人・コース')).toBeTruthy()
 expect(screen.queryByText(/円/)).toBeNull()
 expect(screen.queryByRole('button', { name: /来店|取消|保存/ })).toBeNull()
})
it('取得失敗を空と区別し、再試行できる', async () => {
 fixture.getToday.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ timeline: [] })
 render(<MobileTodayScreen />)
 await screen.findByText('今日の予約を読み込めませんでした')
 fireEvent.click(screen.getByRole('button', { name: /もう一度/ }))
 await screen.findByText('今日の予約はありません')
})
it('アカウント切替後は遅い結果を表示しない', async () => {
 let complete!: (value: unknown) => void
 fixture.getToday.mockImplementationOnce(() => new Promise(resolve => { complete = resolve })).mockResolvedValueOnce({ timeline: [{ ...row, id: 'r2', customer_name: '次の店' }] })
 const view = render(<MobileTodayScreen />)
 fixture.account = 'b'; view.rerender(<MobileTodayScreen />)
 await screen.findByText('次の店')
 await act(async () => { complete({ timeline: [row] }) })
 expect(screen.queryByText('見本 太郎')).toBeNull()
 expect(screen.getByText('次の店')).toBeTruthy()
})
it('閲覧権限がなければ取得しない', async () => {
 fixture.allowed = false
 render(<MobileTodayScreen />)
 await waitFor(() => expect(fixture.getToday).not.toHaveBeenCalled())
})

it('飲食店は一般予約のAPIを使わず、選択アカウントの店舗だけを読み来店済みを表示する', async () => {
 fixture.style = 'restaurant'
 fixture.listStores.mockResolvedValue({ success: true, data: { stores: [{ id: 's1', name: '本店', line_account_id: 'a', status: 'active' }, { id: 'other', name: '別の店', line_account_id: 'b', status: 'active' }] } })
 fixture.reservationsDay.mockResolvedValue({ success: true, data: { reservations: [{ id: 'r1', starts_at: row.starts_at, customer_name: '来店された方', guest_count: 2, course_name: 'おまかせ', status: 'seated', arrived_at: null, departed_at: null }] } })
 render(<MobileTodayScreen />)
 expect(await screen.findByText('来店された方')).toBeTruthy()
 expect(screen.getByText('来店済み')).toBeTruthy()
 expect(fixture.getToday).not.toHaveBeenCalled()
 expect(fixture.reservationsDay).toHaveBeenCalledTimes(1)
 expect(fixture.reservationsDay).toHaveBeenCalledWith('a', 's1', expect.any(String))
})
it('来店の印がある人の予約を来店済みと表示する', async () => {
 fixture.getToday.mockResolvedValue({ timeline: [{ ...row, kind: 'staff', visit_mark: { kind: 'visited' } }] })
 render(<MobileTodayScreen />)
 expect(await screen.findByText('来店済み')).toBeTruthy()
})
it('日本時間で日付が変わって画面へ戻れば新しい日の予約を読む', async () => {
 vi.useFakeTimers({ toFake: ['Date'] })
 vi.setSystemTime(new Date('2026-11-26T14:59:00Z'))
 render(<MobileTodayScreen />)
 await screen.findByText('見本 太郎')
 expect(fixture.getToday).toHaveBeenCalledWith('a', { date: '2026-11-26', mode: 'staff' })
 vi.setSystemTime(new Date('2026-11-26T15:01:00Z'))
 fireEvent.focus(window)
 await waitFor(() => expect(fixture.getToday).toHaveBeenCalledWith('a', { date: '2026-11-27', mode: 'staff' }))
 vi.useRealTimers()
})
it('一般予約の上限に達したときは全件数に見せず予約台帳へ案内する', async () => {
 fixture.getToday.mockResolvedValue({ timeline: Array.from({ length: 200 }, (_, i) => ({ ...row, id: `r${i}` })) })
 render(<MobileTodayScreen />)
 expect(await screen.findByRole('link', { name: '先頭200件・PC で確認' })).toBeTruthy()
 expect(screen.queryByText('200 件')).toBeNull()
})

it('予約機能が無いアカウントは取得せず利用できないと案内する', () => {
 fixture.enabled = false
 render(<MobileTodayScreen />)
 expect(screen.getByText('このアカウントでは予約機能を利用できません')).toBeTruthy()
 expect(fixture.getToday).not.toHaveBeenCalled()
 expect(fixture.reservationsDay).not.toHaveBeenCalled()
})
it('飲食店の取消を予約の件数から除く', async () => {
 fixture.style = 'restaurant'
 fixture.listStores.mockResolvedValue({ success: true, data: { stores: [{ id: 's1', name: '本店', line_account_id: 'a', status: 'active' }] } })
 fixture.reservationsDay.mockResolvedValue({ success: true, data: { reservations: [{ id: 'cancelled', starts_at: row.starts_at, customer_name: '取消された人', guest_count: 1, status: 'cancelled' }, { id: 'live', starts_at: row.starts_at, customer_name: '予約中の人', guest_count: 2, status: 'confirmed' }] } })
 render(<MobileTodayScreen />)
 expect(await screen.findByText('予約中の人')).toBeTruthy()
 expect(screen.queryByText('取消された人')).toBeNull()
 expect(screen.getByText('1 件')).toBeTruthy()
})
it('選択アカウントに店舗がなければ失敗でなく店舗未登録を表示する', async () => {
 fixture.style = 'restaurant'
 fixture.listStores.mockResolvedValue({ success: true, data: { stores: [] } })
 render(<MobileTodayScreen />)
 expect(await screen.findByText('このアカウントの店舗はまだありません')).toBeTruthy()
 expect(fixture.reservationsDay).not.toHaveBeenCalled()
})

it('飲食店の予約は飲食店の権限だけで読み、一般予約の権限だけなら読まない', async () => {
 fixture.style = 'restaurant'; fixture.key = '/booking/bookings'
 const view = render(<MobileTodayScreen />)
 await waitFor(() => expect(fixture.listStores).not.toHaveBeenCalled())
 expect(fixture.reservationsDay).not.toHaveBeenCalled()
 fixture.key = '/restaurant-test/reservations'
 fixture.listStores.mockResolvedValue({ success: true, data: { stores: [] } })
 view.rerender(<MobileTodayScreen />)
 expect(await screen.findByText('このアカウントの店舗はまだありません')).toBeTruthy()
 expect(fixture.listStores).toHaveBeenCalledWith('a')
})

it('取得中に権限を失うと、遅れて返った予約は表示しない', async () => {
 let complete!: (value: unknown) => void
 fixture.getToday.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
 const view = render(<MobileTodayScreen />)
 await waitFor(() => expect(fixture.getToday).toHaveBeenCalledTimes(1))
 fixture.allowed = false; view.rerender(<MobileTodayScreen />)
 expect(screen.getByText('表示する権限がありません')).toBeTruthy()
 await act(async () => { complete({ timeline: [row] }) })
 expect(screen.queryByText('見本 太郎')).toBeNull()
})

it('店舗の所属が不正なら店舗なしと決めつけず、読み直せる', async () => {
 fixture.style = 'restaurant'
 fixture.listStores.mockResolvedValueOnce({ success: true, data: { stores: [{ id: 's1', name: '本店', status: 'active' }] } }).mockResolvedValueOnce({ success: true, data: { stores: [] } })
 render(<MobileTodayScreen />)
 expect(await screen.findByText('今日の予約を読み込めませんでした')).toBeTruthy()
 expect(screen.queryByText('このアカウントの店舗はまだありません')).toBeNull()
 fireEvent.click(screen.getByRole('button', { name: /もう一度/ }))
 expect(await screen.findByText('このアカウントの店舗はまだありません')).toBeTruthy()
})

it('アカウント未所属の店舗はこれまでどおり対象外にする', async () => {
 fixture.style = 'restaurant'
 fixture.listStores.mockResolvedValue({ success: true, data: { stores: [{ id: 's1', name: '未所属', line_account_id: null, status: 'active' }] } })
 render(<MobileTodayScreen />)
 expect(await screen.findByText('このアカウントの店舗はまだありません')).toBeTruthy()
 expect(fixture.reservationsDay).not.toHaveBeenCalled()
})

it('知らない種類の予約を担当者の予約として表示しない', async () => {
 fixture.getToday.mockResolvedValueOnce({ timeline: [{ ...row, kind: 'unknown' }] }).mockResolvedValueOnce({ timeline: [row] })
 render(<MobileTodayScreen />)
 expect(await screen.findByText('今日の予約を読み込めませんでした')).toBeTruthy()
 expect(screen.queryByText('見本 太郎')).toBeNull()
 fireEvent.click(screen.getByRole('button', { name: /もう一度/ }))
 expect(await screen.findByText('見本 太郎')).toBeTruthy()
})
