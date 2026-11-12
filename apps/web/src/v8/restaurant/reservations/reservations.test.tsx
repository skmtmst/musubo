// @vitest-environment happy-dom

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  snapshot: vi.fn(), reservationsDay: vi.fn(), updateReservation: vi.fn(), createReservation: vi.fn(), holdReservation: vi.fn(),
  floors: vi.fn(), importReservation: vi.fn(), openingHours: vi.fn(), customerSearch: vi.fn(), customerHistory: vi.fn(),
  attendance: vi.fn(),
}))
const role = vi.hoisted(() => ({ value: 'owner' as string | null }))
const detailAttendance = vi.hoisted(() => ({ current: null as null | ((id: string, action: 'visited') => unknown), close: null as null | (() => void) }))
const mutationEntry = vi.hoisted(() => ({ enabled: false, called: vi.fn() }))
const notifications = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api/helpers/reservation-board',async importOriginal=>{const original=await importOriginal<typeof import('@/lib/api/helpers/reservation-board')>();return {...original,reservationBoardApi:{...original.reservationBoardApi,floors:fixture.floors}}})
vi.mock('next/navigation', () => ({ useRouter: () => ({ push() {}, replace() {}, prefetch() {} }), usePathname: () => '/restaurant-test/reservations', useSearchParams: () => new URLSearchParams() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-1', accounts: [] }) }))
vi.mock('@/hooks/use-account-style', () => ({ useAccountStyle: () => ({ data: { style: 'restaurant' }, stale: false }) }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: fixture }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => role.value, canManageRole: (r: string | null) => r === 'owner' || r === 'admin' }))
vi.mock('@/v8/restaurant-reservations/index', async original => {
  const actual = await original<typeof import('@/v8/restaurant-reservations/index')>()
  return { ...actual, ReservationDetailDialog: (props: React.ComponentProps<typeof actual.ReservationDetailDialog>) => {
    if (props.reservation?.id === 'r1' && props.onAttendance) { detailAttendance.current = props.onAttendance; detailAttendance.close = props.onClose }
    return <actual.ReservationDetailDialog {...props} />
  } }
})
vi.mock('@/components/shared/toast', async original => {
  const actual = await original<typeof import('@/components/shared/toast')>()
  return { ...actual, notifyToast: (...args: Parameters<typeof actual.notifyToast>) => { notifications(...args); return actual.notifyToast(...args) } }
})
vi.mock('@/v8/restaurant/booking-kit/public/shell/index', async original => {
  const actual = await original<typeof import('@/v8/restaurant/booking-kit/public/shell/index')>()
  return { ...actual, RestaurantShell: (props: React.ComponentProps<typeof actual.RestaurantShell>) => {
    if (!mutationEntry.enabled || !props.children) return <actual.RestaurantShell {...props} />
    const children = props.children
    return <actual.RestaurantShell {...props}>{ctx => children({ ...ctx, mutate: (...args) => { mutationEntry.called(); return ctx.mutate(...args) } })}</actual.RestaurantShell>
  } }
})

import ReservationsPage from './reservations'
import { ApiError } from '@/lib/api'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetSessionSnapshot } from '@/lib/session-snapshot'
import { PERMISSION_LOCK_REASON } from '@/components/shared/permission-lock'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'
import { at, reservation, snapshotOf, tables } from '../booking-kit/test-data'

/* 今日：佐藤（LINE・T1）・山田（食べログ・承認待ち・T3・乳）・押さえ（T4）。 */
const reservationsToday = () => [
  reservation('r1', { customer_name: '見本 114', source: 'line', starts_at: at(0, 18), ends_at: at(0, 20), table_id: 't1' }),
  reservation('r2', { customer_name: '見本 141', source: 'tabelog', status: 'pending', allergy_note: '乳', guest_count: 4, starts_at: at(0, 18, 30), ends_at: at(0, 20, 30), table_id: 't3', course_name: 'おまかせコース' }),
  reservation('r3', { customer_name: '押さえ', source: 'phone', status: 'pending', hold_expires_at: at(0, 23), note: '電話のお客さま用', guest_count: 4, starts_at: at(0, 20), ends_at: at(0, 21, 30), table_id: 't4' }),
]

let today: ReturnType<typeof reservationsToday>

beforeEach(() => {
  detailAttendance.current = null
  detailAttendance.close = null
  notifications.mockClear()
  mutationEntry.enabled = false
  mutationEntry.called.mockClear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T12:00:00+09:00'))
  today = reservationsToday()
  role.value = verifiedStaffRole('owner')
  fixture.floors.mockResolvedValue({success:true,data:[]})
  fixture.snapshot.mockResolvedValue({ success: true, data: snapshotOf({ reservations: today, reservationTotal: 3 }) })
  fixture.reservationsDay.mockResolvedValue({ data: { date: '', reservations: today } })
  fixture.openingHours.mockResolvedValue({ data: { storeId: 'store-1', hours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, periods: [{ opensAt: '17:00', closesAt: '23:00' }] })), version: 1, updatedBy: null, updatedAt: null } })
  for (const fn of [fixture.updateReservation, fixture.importReservation]) fn.mockResolvedValue({ success: true })
  fixture.attendance.mockResolvedValue({ success: true, data: { stamp: { status: 'pending_or_unavailable', count: 0 } } })
  fixture.createReservation.mockResolvedValue({ success: true, data: { id: 'new', tableId: 't2', lineNotice: { sent: true, reason: null } } })
  fixture.customerSearch.mockResolvedValue({ data: [] })
  fixture.customerHistory.mockResolvedValue({ data: { visitCount: 0, visits: [] } })
})
afterEach(() => { cleanup(); clearToastsForTest(); verifiedStaffRole(null); forgetSessionSnapshot(); vi.useRealTimers(); vi.clearAllMocks() })

describe('l9NlC0 予約台帳（今日・時間×卓）', () => {
  it('今日のこれからの予約を現在進行中と誤表示しない', async () => {
    render(<ReservationsPage />)
    await screen.findByText('見本 141')
    const heading = screen.getByRole('heading', { name: '次の予約' })
    expect(heading.parentElement?.textContent).toContain('今日これからの予約')
    expect(heading.parentElement?.textContent).not.toContain('いま')
  })

  it('その日が臨時休業・貸切なら、帯と「休業日・貸切を見る」を出す（予約は取り消さない）', async () => {
    fixture.reservationsDay.mockResolvedValue({ data: { date: '', reservations: today, closures: [
      { id: 'cl-1', storeId: 'store-1', startDate: '2026-10-20', endDate: '2026-10-20', allDay: false, startTime: '18:00', endTime: '22:00', kind: 'private_event', memo: null, tableIds: ['pa', 't1'], createdBy: null, createdByName: null, createdAt: '', updatedAt: '', version: 1 },
    ] } })
    render(<ReservationsPage />)
    await screen.findByText('見本 141')
    const icons = document.querySelectorAll('[data-kpi-icon] svg')
    expect(icons).toHaveLength(4)
    for (const icon of icons) expect(icon.classList.contains('lucide-inbox')).toBe(true)
    expect(screen.getByRole('button', { name: /電話の予約を入れる/ }).querySelector('svg')?.classList.contains('lucide-phone')).toBe(true)
    const band = await waitFor(() => {
      const found = document.querySelector('[data-closure-day]')
      if (!found) throw new Error('まだ')
      return found as HTMLElement
    })
    expect(band.textContent).toContain('貸切（18:00〜22:00・個室A・T1）です。閉じた時間帯は LINE からの予約を受け付けません。入っている予約は取り消していません。')
    expect(within(band).getByRole('link', { name: '休業日・貸切へ' }).getAttribute('href')).toBe('/restaurant-test/inventory?tab=closures')
    expect(screen.getByText('見本 114')).not.toBeNull()
  })

  it('数4・時間×卓の箱（予約元・アレルギー・承認待ち・押さえ）・右の4枚が出る', async () => {
    render(<ReservationsPage />)
    await screen.findByText('見本 141')
    const board = document.querySelector('[data-design-node="l9NlC0"]')!
    expect(board.textContent).toContain('今日の予約')
    expect(screen.getByText('⚠ 乳')).not.toBeNull()
    expect(within(board as HTMLElement).getAllByText('承認待ち', { selector: 'span' }).length).toBeGreaterThan(0)
    expect(screen.getAllByText('仮押さえ', { selector: 'span' }).length).toBeGreaterThan(0)
    const hold = screen.getByRole('button', { name: /^押さえ / })
    expect(hold.getAttribute('data-booking-state')).toBe('hold')
    expect(hold.textContent).toMatch(/\d{2}:\d{2}〜\d{2}:\d{2}/)
    expect(screen.getByText('個室B は停止中のため出していません')).not.toBeNull()
    expect(board.textContent).toContain('・承認待ちが 1 件（見本さん・食べログ）')
    for (const title of ['次の予約', 'つながる先']) expect(screen.getByRole('heading', { name: title })).not.toBeNull()
  })

  it('箱を押すと予約の詳細（AjZhH）が開き、「内容を変える」から変更の窓へ。保存は今の口へ届く', async () => {
    render(<ReservationsPage />)
    fireEvent.click(await screen.findByRole('button', { name: /^見本 114 2名/ }))
    fireEvent.click(await screen.findByRole('button', { name: '内容を変える' }))
    fireEvent.change(screen.getByLabelText('お客様名'), { target: { value: '見本 116' } })
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    await waitFor(() => expect(fixture.updateReservation).toHaveBeenCalledWith('account-1', 'r1', expect.objectContaining({ customerName: '見本 116', tableId: 't1' })))
  })

  it('押さえの箱からは解除ができる（取消として送る）', async () => {
    render(<ReservationsPage />)
    fireEvent.click(await screen.findByRole('button', { name: /^押さえ / }))
    fireEvent.click(screen.getByRole('button', { name: '押さえを解除' }))
    fireEvent.click(screen.getByRole('button', { name: '解除する' }))
    await waitFor(() => expect(fixture.updateReservation).toHaveBeenCalledWith('account-1', 'r3', { status: 'cancelled', expectedVersion: 1 }))
  })

  it('一覧（Z3FoM）は予約タイムラインの表と変更・取消が出る', async () => {
    render(<ReservationsPage />)
    await screen.findByText('見本 141')
    fireEvent.click(screen.getByRole('button', { name: '一覧' }))
    await screen.findByRole('heading',{name:'予約の詳細'})
    expect(document.querySelector('[data-design-node="Z3FoM"]')).not.toBeNull()
    // 絵 Z3FoM：一覧でも頭の右に「枠を押さえる」「電話の予約を入れる」を置く。
    expect(screen.getByRole('button', { name: /枠を押さえる/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /電話の予約を入れる/ })).toBeTruthy()
    const row = screen.getByRole('button',{name:'見本 114'}).closest('tr')!
    fireEvent.click(within(row).getByRole('button',{name:'見本 114のその他操作'}));fireEvent.click(screen.getByRole('menuitem',{name:'取消'}))
    expect(fixture.updateReservation).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'キャンセル' }))
    expect(fixture.updateReservation).not.toHaveBeenCalled()
    fireEvent.click(within(row).getByRole('button',{name:'見本 114のその他操作'}));fireEvent.click(screen.getByRole('menuitem',{name:'取消'}))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取り消す' }))
    await waitFor(() => expect(fixture.updateReservation).toHaveBeenCalledWith('account-1', 'r1', { status: 'cancelled', expectedVersion: 1 }))
  })

  it('電話の予約を入れる（rm92Y）で台帳に入れると createReservation へ送る', async () => {
    render(<ReservationsPage />)
    await screen.findByText('見本 141')
    fireEvent.click(screen.getByRole('button', { name: /電話の予約を入れる/ }))
    await screen.findByText('何を入れますか', { selector: 'h2' })
    expect(document.querySelector('[data-design-node="rm92Y"]')).not.toBeNull()
    expect(screen.getByRole('button', { name: '予約内容と卓を見る' })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'LINE 未連携の電話番号' }))
    fireEvent.change(screen.getByLabelText('お名前'), { target: { value: '見本 184' } })
    fireEvent.change(screen.getByLabelText('電話番号'), { target: { value: '090-0000-1111' } })
    fireEvent.click(screen.getByRole('button', { name: '17:00' }))
    fireEvent.click(await screen.findByRole('button', { name: /台帳に入れる/ }))
    await waitFor(() => expect(fixture.createReservation).toHaveBeenCalledWith('account-1', expect.objectContaining({ customerName: '見本 184', customerPhone: '09000001111', guestCount: 2, source: 'phone', kind: 'customer', startsAt: '2026-10-10T08:00:00.000Z', endsAt: '2026-10-10T10:00:00.000Z' })))
  })

  it('電話予約の保存成功後は再読込を待たず台帳に戻り、更新中を知らせる', async () => {
    render(<ReservationsPage />)
    await screen.findByText('見本 141')
    let finish!: (value: unknown) => void
    fixture.createReservation.mockImplementationOnce(async () => {
      fixture.snapshot.mockImplementation(() => new Promise(resolve => { finish = resolve }))
      return { success: true, data: { id: 'new', tableId: 't2', lineNotice: { sent: true, reason: null } } }
    })
    fireEvent.click(screen.getByRole('button', { name: /電話の予約を入れる/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'LINE 未連携の電話番号' }))
    fireEvent.change(screen.getByLabelText('お名前'), { target: { value: '架空 太郎' } })
    fireEvent.change(screen.getByLabelText('電話番号'), { target: { value: '09000001111' } })
    fireEvent.click(await screen.findByRole('button', { name: '17:00' }))
    fireEvent.click(screen.getByRole('button', { name: /台帳に入れる/ }))
    await waitFor(() => expect(fixture.createReservation).toHaveBeenCalledOnce())
    expect(await screen.findByRole('button', { name: '電話の予約を入れる', exact: true }, { timeout: 500 })).toBeTruthy()
    expect(screen.getByText(/最新の表示を読み込んでいます/)).toBeTruthy()
    await act(async () => { finish({ data: snapshotOf({ reservations: reservationsToday(), reservationTotal: 3 }) }) })
    await waitFor(() => expect(screen.queryByText(/最新の表示を読み込んでいます/)).toBeNull())
  })

  it('電話予約が保存済みで再読込に失敗したら、台帳で再取得失敗を知らせる', async () => {
    render(<ReservationsPage />)
    await screen.findByText('見本 141')
    fixture.createReservation.mockImplementationOnce(async () => {
      fixture.snapshot.mockRejectedValue(new Error('offline'))
      return { success: true, data: { id: 'new', tableId: 't2', lineNotice: { sent: true, reason: null } } }
    })
    fireEvent.click(screen.getByRole('button', { name: /電話の予約を入れる/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'LINE 未連携の電話番号' }))
    fireEvent.change(screen.getByLabelText('お名前'), { target: { value: '架空 太郎' } })
    fireEvent.change(screen.getByLabelText('電話番号'), { target: { value: '09000001111' } })
    fireEvent.click(await screen.findByRole('button', { name: '17:00' }))
    fireEvent.click(screen.getByRole('button', { name: /台帳に入れる/ }))
    expect(await screen.findByText(/保存しましたが、最新の表示を読み込めませんでした/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '電話の予約を入れる', exact: true })).toBeTruthy()
    expect(fixture.createReservation).toHaveBeenCalledOnce()
  })

  it('電話予約の保存時に営業時間未設定のコードを受け取ると設定を案内する', async () => {
    fixture.createReservation.mockRejectedValueOnce(new ApiError(409, 'synthetic', 'opening_hours_unconfigured'))
    render(<ReservationsPage />)
    await screen.findByText('見本 141')
    fireEvent.click(screen.getByRole('button', { name: /電話の予約を入れる/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'LINE 未連携の電話番号' }))
    fireEvent.change(screen.getByLabelText('お名前'), { target: { value: '見本 184' } })
    fireEvent.change(screen.getByLabelText('電話番号'), { target: { value: '090-0000-1111' } })
    fireEvent.click(await screen.findByRole('button', { name: '17:00' }))
    fireEvent.click(screen.getByRole('button', { name: /台帳に入れる/ }))
    await waitFor(() => expect(fixture.createReservation).toHaveBeenCalledOnce())
    expect(await screen.findByText('営業時間が未設定のため予約できません。営業時間を確認してください。')).toBeTruthy()
  })

  it('一覧の行メニューから直接変更し、詳細への入口と版つき保存を保つ', async () => {
    render(<ReservationsPage />)
    await screen.findByText('見本 141')
    fireEvent.click(screen.getByRole('button', { name: '一覧' }))
    const row = (await screen.findByRole('button', { name: '見本 114' })).closest('tr')!
    expect(within(row).getAllByRole('button')).toHaveLength(2)
    fireEvent.click(within(row).getByRole('button', { name: '見本 114のその他操作' }))
    expect(screen.getByRole('menuitem', { name: '詳細を見る' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '取消' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: '変更', exact: true }))
    expect(fixture.updateReservation).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('お客様名'), { target: { value: '見本 116' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存する' }))
    await waitFor(() => expect(fixture.updateReservation).toHaveBeenCalledWith('account-1', 'r1', expect.objectContaining({ customerName: '見本 116', expectedVersion: 1 })))
  })

  it('取消した行はメニューから復活し、取消操作を同時に出さない', async () => {
    today[0].status = 'cancelled'
    fixture.snapshot.mockResolvedValue({ success: true, data: snapshotOf({ reservations: today, reservationTotal: 3 }) })
    render(<ReservationsPage />)
    await screen.findByText('見本 141')
    fireEvent.click(screen.getByRole('button', { name: '一覧' }))
    const row = (await screen.findByRole('button', { name: '見本 114' })).closest('tr')!
    fireEvent.click(within(row).getByRole('button', { name: '見本 114のその他操作' }))
    expect(screen.queryByRole('menuitem', { name: '取消' })).toBeNull()
    expect(fixture.updateReservation).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('menuitem', { name: '予約を有効に戻す' }))
    await waitFor(() => expect(fixture.updateReservation).toHaveBeenCalledWith('account-1', 'r1', { status: 'confirmed', expectedVersion: 1 }))
  })

  it('無断の行の復活は予約の復旧を行う', async () => {
    today[0].status = 'no_show'
    fixture.snapshot.mockResolvedValue({ success: true, data: snapshotOf({ reservations: today, reservationTotal: 3 }) })
    render(<ReservationsPage />)
    await screen.findByText('見本 141')
    fireEvent.click(screen.getByRole('button', { name: '一覧' }))
    const row = (await screen.findByRole('button', { name: '見本 114' })).closest('tr')!
    fireEvent.click(within(row).getByRole('button', { name: '見本 114のその他操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '予約を有効に戻す' }))
    await waitFor(() => expect(fixture.updateReservation).toHaveBeenCalledWith('account-1', 'r1', { status: 'confirmed', expectedVersion: 1 }))
  })

  it('閲覧者の一覧は予約を読めても行の変更メニューを出さない', async () => {
    role.value = verifiedStaffRole('viewer')
    render(<ReservationsPage />)
    await screen.findByText('見本 141')
    fireEvent.click(screen.getByRole('button', { name: '一覧' }))
    const row = (await screen.findByRole('button', { name: '見本 114' })).closest('tr')!
    expect(within(row).queryByRole('button', { name: '見本 114のその他操作' })).toBeNull()
    expect(within(row).getAllByRole('button')).toHaveLength(1)
    expect(fixture.updateReservation).not.toHaveBeenCalled()
  })
  it('電話予約の入力不足はボタンで止め、フォームを直接送っても欄へ移動して保存しない', async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
    render(<ReservationsPage />)
    await screen.findByText('見本 141')
    fireEvent.click(screen.getByRole('button', { name: /電話の予約を入れる/ }))
    const submit = await screen.findByRole('button', { name: /台帳に入れる/ })
    expect(submit.hasAttribute('disabled')).toBe(true)
    expect(submit.getAttribute('aria-description')).toContain('お客さま')
    fireEvent.click(submit)
    const search = screen.getByRole('searchbox', { name: '名前・電話番号で探す' })
    expect(fixture.createReservation).not.toHaveBeenCalled()
    fireEvent.submit(search.closest('form')!)
    await waitFor(() => expect(search.getAttribute('aria-invalid')).toBe('true'))
    await waitFor(() => expect(document.activeElement).toBe(search))
    expect(scroll).toHaveBeenCalledWith({ block: 'center' })
    expect(screen.getByText('名前・電話番号で探して、お客さまを選んでください。').closest('[data-design-part="notice"]')).toBeNull()
    expect(fixture.createReservation).not.toHaveBeenCalled()
    scroll.mockRestore()
  })

  it('変更でお客様名が空なら、欄を赤くしてフォーカスを移し、予約を更新しない', async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
    render(<ReservationsPage />)
    fireEvent.click(await screen.findByRole('button', { name: /^見本 114 2名/ }))
    fireEvent.click(await screen.findByRole('button', { name: '内容を変える' }))
    const name = screen.getByLabelText('お客様名')
    fireEvent.change(name, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    await waitFor(() => expect(name.getAttribute('aria-invalid')).toBe('true'))
    await waitFor(() => expect(document.activeElement).toBe(name))
    expect(fixture.updateReservation).not.toHaveBeenCalled()
    expect(screen.getByText('お客様名を入れてください。')).not.toBeNull()
    scroll.mockRestore()
  })
})


describe('日本時間の今日（端末の時間帯とは別）', () => {
  it.each([
    ['2026-10-11T00:09:00+09:00', true],
    ['2026-10-11T23:59:00+09:00', false],
    ['2026-10-11T09:00:00+09:00', true],
  ] as const)('日本時間のその日の予約を読み、過ぎた予約は「次」に出さない（%s）', async (instant, hasNext) => {
    vi.setSystemTime(new Date(instant))
    today = reservationsToday()
    fixture.snapshot.mockResolvedValue({ success: true, data: snapshotOf({ reservations: today, reservationTotal: 3 }) })
    fixture.reservationsDay.mockResolvedValue({ data: { date: '2026-10-11', reservations: today } })
    render(<ReservationsPage />)
    await screen.findByRole('button', { name: /^見本 114 2名/ })
    expect(fixture.reservationsDay).toHaveBeenCalledWith('account-1', 'store-1', '2026-10-11')
    expect(screen.getByRole('heading', { name: '10月11日（日）' })).not.toBeNull()
    expect(Boolean(screen.queryByRole('button', { name: '詳細を見る' }))).toBe(hasNext)
    fireEvent.click(screen.getByRole('button', { name: '次の日' }))
    await waitFor(() => expect(fixture.reservationsDay).toHaveBeenCalledWith('account-1', 'store-1', '2026-10-12'))
    fireEvent.click(screen.getByRole('button', { name: '前の日' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: '10月11日（日）' })).not.toBeNull())
  })
})

 it('OP-R01 日別取得失敗は空の予約台帳にせず、再試行で予約を戻す',async()=>{
  fixture.reservationsDay.mockRejectedValueOnce(new Error('synthetic day failure')).mockResolvedValue({data:{reservations:today,closures:[]}})
  render(<ReservationsPage/>)
  const alert=(await screen.findByText('予約を読み込めませんでした')).closest('[data-list-state="error"]') as HTMLElement
  expect(alert.textContent).toContain('読み込めませんでした')
  expect(screen.queryByText('予約がありません')).toBeNull()
  expect(document.querySelector('[data-design-node="l9NlC0"] [data-list-state="empty"]')).toBeNull()
  fireEvent.click(within(alert).getByRole('button',{name:/もう一度/}))
  await screen.findByText('見本 141')
  expect(fixture.reservationsDay).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('alert')).toBeNull()
 })


describe('予約台帳の初期状態', () => {
  const emptyStore = (noTables = true) => {
    fixture.snapshot.mockResolvedValue({success:true,data:snapshotOf({...(noTables ? {tables:[]} : {}),reservations:[],reservationTotal:0})})
    fixture.reservationsDay.mockResolvedValue({data:{reservations:[],closures:[]}})
  }
  it('卓がない店は盤の中に設定の理由と座席・卓管理への行き先を出す', async () => {
    emptyStore()
    render(<ReservationsPage />)
    const title = await screen.findByText('卓がまだ設定されていません')
    expect(title.closest('[data-reservation-board]')).toBeTruthy()
    expect(screen.getByRole('link',{name:'座席・卓を設定する'}).getAttribute('href')).toBe('/restaurant-test/tables')
    expect(screen.getByText(/先に座席・卓を登録してください/)).toBeTruthy()
    expect(document.querySelector('[data-booking-add]')).toBeNull()
  })
  it.each(['viewer','staff'])('%s は卓の設定操作を残し、権限理由を出して移動を止める', async value => {
    emptyStore()
    role.value=verifiedStaffRole(value)
    render(<ReservationsPage />)
    await screen.findByText('卓がまだ設定されていません')
    const action=screen.getByRole('button',{name:'座席・卓を設定する'})
    expect(action.getAttribute('aria-disabled')).toBe('true')
    fireEvent.focus(action)
    expect(await screen.findByRole('tooltip')).toHaveProperty('textContent',value==='viewer' ? PERMISSION_LOCK_REASON.viewer : PERMISSION_LOCK_REASON.manager)
  })
  it('卓があれば予約0件でも空きマスから選んだ卓と時刻で電話予約へ進む', async () => {
    emptyStore(false)
    render(<ReservationsPage />)
    const slot=await screen.findByRole('button',{name:'T2 2名 18:00に予約を入れる'})
    fireEvent.focus(slot)
    fireEvent.click(slot)
    await screen.findByText('何を入れますか',{selector:'h2'})
    expect(screen.getByRole('button',{name:'18:00',exact:true}).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button',{name:/T2/}).getAttribute('aria-pressed')).toBe('true')
    expect(fixture.createReservation).not.toHaveBeenCalled()
  })
  it('月と一覧の見方でも卓の設定案内を出す', async () => {
    emptyStore()
    render(<ReservationsPage />)
    await screen.findByText('卓がまだ設定されていません')
    fireEvent.click(screen.getByRole('button',{name:'月',exact:true}))
    expect(await screen.findByText('卓がまだ設定されていません')).toBeTruthy()
    fireEvent.click(screen.getByRole('button',{name:'一覧',exact:true}))
    expect(await screen.findByText('卓がまだ設定されていません')).toBeTruthy()
  })
  it('座席表で予約0件の理由を出し、卓の図も保つ', async () => {
    emptyStore(false)
    fixture.floors.mockResolvedValue({data:[{id:'f1',storeId:'store-1',name:'1階',width:660,height:420,outline:[],fixtures:[],tables:[],version:1}]})
    render(<ReservationsPage />)
    fireEvent.click(await screen.findByRole('button',{name:'座席表',exact:true}))
    expect(await screen.findByText('予約はまだありません')).toBeTruthy()
    expect(screen.getByRole('group',{name:'1階の座席表'})).toBeTruthy()
  })
  it('月の見出しと曜日を表示し、前後の月を選ぶとその月を読み込む', async () => {
    render(<ReservationsPage />)
    fireEvent.click(await screen.findByRole('button', { name: '月', exact: true }))
    expect(await screen.findByText('2026年10月')).toBeTruthy()
    for (const weekday of ['日', '月', '火', '水', '木', '金', '土']) expect(within(screen.getByLabelText('曜日')).getByText(weekday, { exact: true })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '前の月' }))
    expect(await screen.findByText('2026年9月')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '次の月' }))
    expect(await screen.findByText('2026年10月')).toBeTruthy()
    await waitFor(() => expect(fixture.snapshot.mock.calls.some((call) => JSON.stringify(call).includes('2026-09'))).toBe(true))
  })

  it('月の予約0件は案内から電話予約へ進める', async () => {
    emptyStore(false)
    render(<ReservationsPage />)
    fireEvent.click(await screen.findByRole('button',{name:'月',exact:true}))
    const empty=await screen.findByText('予約はまだありません')
    fireEvent.click(within(empty.closest('[data-list-state]') as HTMLElement).getByRole('button',{name:'電話の予約を入れる'}))
    expect(await screen.findByText('何を入れますか',{selector:'h2'})).toBeTruthy()
  })
  it('一覧の読込失敗は卓なしの案内に置き換えない', async () => {
    fixture.snapshot.mockRejectedValue(new Error('synthetic snapshot failure'))
    render(<ReservationsPage />)
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0)
    expect(screen.queryByText('卓がまだ設定されていません')).toBeNull()
  })
  it('座席表が読めない場合は予約0件と区別し、再読込できる', async () => {
    emptyStore(false)
    fixture.floors.mockRejectedValueOnce(new Error('synthetic floor failure')).mockResolvedValue({data:[]})
    render(<ReservationsPage />)
    const title=await screen.findByText('座席表を読み込めませんでした')
    fireEvent.click(within(title.closest('[role="alert"]') as HTMLElement).getByRole('button',{name:/もう一度/}))
    await waitFor(()=>expect(screen.queryByText('座席表を読み込めませんでした')).toBeNull())
    expect(fixture.floors).toHaveBeenCalledTimes(2)
  })
})


it('共通タブを外し、reservationsの画面内操作を保つ', async () => {
  render(<ReservationsPage />)
  await screen.findByText('見本 141')
  expect(screen.queryByRole('tablist', {name:'店の中の画面'})).toBeNull()
})


it('電話予約の作成でも共通タブを出さず、戻る操作を保つ', async () => {
  render(<ReservationsPage />)
  await screen.findByText('見本 141')
  fireEvent.click(screen.getByRole('button',{name:/電話の予約を入れる/}))
  await screen.findByText('何を入れますか',{selector:'h2'})
  expect(screen.queryByRole('tablist',{name:'店の中の画面'})).toBeNull()
  expect(screen.getByRole('button',{name:'キャンセル',exact:true})).toBeTruthy()
})


it('停止中の卓しかない空の台帳は有効化の案内を出す', async () => {
  const empty=snapshotOf({reservations:[],reservationTotal:0})
  empty.tables=empty.tables.map(table=>({...table,is_active:0}))
  fixture.snapshot.mockResolvedValue({data:empty})
  fixture.reservationsDay.mockResolvedValue({data:{reservations:[],closures:[]}})
  render(<ReservationsPage />)
  expect(await screen.findByText('利用できる卓がありません')).toBeTruthy()
  expect(screen.getByRole('link',{name:'座席・卓を設定する'})).toBeTruthy()
})

it('卓がない店の既存予約は一覧への操作から確認できる', async () => {
  fixture.snapshot.mockResolvedValue({data:snapshotOf({tables:[],reservations:today,reservationTotal:today.length})})
  render(<ReservationsPage />)
  fireEvent.click(await screen.findByRole('button',{name:'一覧で予約を見る'}))
  expect(await screen.findByRole('button',{name:'見本 141',exact:true})).toBeTruthy()
})


it('一覧ですべての期間・状態が空なら新しい予約の案内を出す', async () => {
  fixture.snapshot.mockResolvedValue({data:snapshotOf({reservations:[],reservationTotal:0})})
  fixture.reservationsDay.mockResolvedValue({data:{reservations:[],closures:[]}})
  render(<ReservationsPage />)
  fireEvent.click(await screen.findByRole('button',{name:'一覧',exact:true}))
  fireEvent.click(await screen.findByRole('button',{name:'期間',exact:true}))
  fireEvent.click(within(await screen.findByRole('option',{name:'すべての期間',exact:true})).getByRole('button'))
  expect(await screen.findByText('予約はまだありません')).toBeTruthy()
})


it('座席表が読めなくても時間と一覧の取得済み予約は残す', async () => {
  fixture.floors.mockRejectedValue(new Error('synthetic floor failure'))
  render(<ReservationsPage />)
  expect(await screen.findByText('座席表を読み込めませんでした')).toBeTruthy()
  expect(await screen.findByText('見本 141')).toBeTruthy()
  fireEvent.click(screen.getByRole('button',{name:'一覧',exact:true}))
  expect(await screen.findByRole('button',{name:'見本 141',exact:true})).toBeTruthy()
  expect(await screen.findByText('座席表を読み込めませんでした')).toBeTruthy()
})

it('通常取得の卓定義を電話画面へ渡し、人数が全卓と結合の最大を超える理由を出す（追加取得なし）', async () => {
  const configured = tables.filter(table => table.is_active).map(table => ({ ...table, max_capacity: Math.min(table.max_capacity, 6) }))
  fixture.snapshot.mockResolvedValue({ data: snapshotOf({ tables: configured, reservations: [], reservationTotal: 0 }) })
  fixture.reservationsDay.mockResolvedValue({ data: { reservations: [], closures: [] } })
  render(<ReservationsPage />)
  fireEvent.click(await screen.findByRole('button', { name: '電話の予約を入れる' }))
  fireEvent.change(screen.getByLabelText('人数'), { target: { value: '7' } })
  expect(await screen.findAllByText('結合を含め最大6名のため、7名は入れません。')).toHaveLength(1)
  expect(fixture.snapshot).toHaveBeenCalledTimes(1)
  expect(fixture.createReservation).not.toHaveBeenCalled()
})

it('来店の競合は詳細の中に示してから予約を読み直す', async () => {
  fixture.attendance.mockRejectedValueOnce(new ApiError(409, '最新の予約を確認してください。', 'version_conflict'))
  render(<ReservationsPage />)
  fireEvent.click(await screen.findByRole('button', { name: /^見本 114 2名/ }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: '来店にする', exact: true }))
  expect((await within(dialog).findByRole('alert')).textContent).toContain('ほかの操作で予約が変わりました。読み直してから、もう一度選んでください。')
  await waitFor(() => expect(fixture.snapshot.mock.calls.length).toBeGreaterThan(1))
  const beforeSnapshot = fixture.snapshot.mock.calls.length
  const beforeDay = fixture.reservationsDay.mock.calls.length
  fireEvent.click(within(dialog).getByRole('button', { name: '読み直す' }))
  await waitFor(() => expect(fixture.snapshot.mock.calls.length).toBeGreaterThan(beforeSnapshot))
  await waitFor(() => expect(fixture.reservationsDay.mock.calls.length).toBeGreaterThan(beforeDay))
})

it('現在の詳細と違う予約IDの来店を受け付けない', async () => {
  render(<ReservationsPage />)
  fireEvent.click(await screen.findByRole('button', { name: /^見本 114 2名/ }))
  await screen.findByRole('dialog')
  expect(detailAttendance.current).toBeTypeOf('function')
  await act(async () => { await detailAttendance.current!('r2', 'visited') })
  expect(fixture.attendance).not.toHaveBeenCalled()
})

it('別の予約へ切り替えた後に古い来店操作を受け付けない', async () => {
  mutationEntry.enabled = true
  render(<ReservationsPage />)
  fireEvent.click(await screen.findByRole('button', { name: /^見本 114 2名/ }))
  const dialog = await screen.findByRole('dialog')
  const previous = detailAttendance.current!
  expect(previous).toBeTypeOf('function')
  fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }))
  fireEvent.click(await screen.findByRole('button', { name: /^見本 141 4名/ }))
  await screen.findByRole('dialog')
  await act(async () => { await previous('r1', 'visited') })
  expect(fixture.attendance).not.toHaveBeenCalled()
  expect(mutationEntry.called).not.toHaveBeenCalled()
})

it('詳細を閉じただけなら来店の成功とスタンプを通知する', async () => {
  let finish!: (result: unknown) => void
  fixture.attendance.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  render(<ReservationsPage />)
  fireEvent.click(await screen.findByRole('button', { name: /^見本 114 2名/ }))
  await screen.findByRole('dialog')
  act(() => { void detailAttendance.current!('r1', 'visited') })
  await waitFor(() => expect(fixture.attendance).toHaveBeenCalledOnce())
  act(() => detailAttendance.close!())
  notifications.mockClear()
  await act(async () => { finish({ success: true, data: { stamp: { status: 'recorded', count: 3 } } }) })
  expect(notifications).toHaveBeenCalledWith(expect.stringContaining('来店スタンプ 3 個を確認しました。'), undefined)
})

it('来店が保存され再読込に失敗したら窓の中で知らせ、二重操作を防ぐ', async () => {
  fixture.attendance.mockResolvedValueOnce({ success: true, data: { stamp: { status: 'recorded', count: 2 } } })
  render(<ReservationsPage />)
  fireEvent.click(await screen.findByRole('button', { name: /^見本 114 2名/ }))
  const dialog = await screen.findByRole('dialog')
  fixture.snapshot.mockRejectedValue(new Error('offline'))
  fireEvent.click(within(dialog).getByRole('button', { name: '来店にする', exact: true }))
  expect((await within(dialog).findByRole('alert')).textContent).toContain('保存しましたが、最新の予約を読み込めませんでした')
  expect(await within(dialog).findByText(/来店スタンプ 2 個を確認しました。/)).toBeTruthy()
  expect(fixture.attendance).toHaveBeenCalledTimes(1)
  expect((within(dialog).getByRole('button', { name: '来店にする', exact: true }) as HTMLButtonElement).disabled).toBe(true)
})

it('来店処理中に詳細を閉じても、完了とスタンプを通知する', async () => {
  let finish!: (value: unknown) => void
  fixture.attendance.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  render(<><ReservationsPage /><ToastHost /></>)
  fireEvent.click(await screen.findByRole('button', { name: /^見本 114 2名/ }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: '来店にする', exact: true }))
  fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }))
  await act(async () => { finish({ success: true, data: { stamp: { status: 'recorded', count: 2 } } }) })
  expect(await screen.findByText(/来店スタンプ 2 個を確認しました。/)).toBeTruthy()
})

it('来店処理中に一覧の詳細を閉じた後の競合はトーストで知らせる', async () => {
  let fail!: (error: Error) => void
  fixture.attendance.mockReturnValueOnce(new Promise((_, reject) => { fail = reject }))
  render(<><ReservationsPage /><ToastHost /></>)
  fireEvent.click(await screen.findByRole('button', { name: '一覧', exact: true }))
  fireEvent.click(await screen.findByRole('button', { name: '来店にする', exact: true }))
  fireEvent.click(screen.getByRole('button', { name: '予約の詳細を閉じる' }))
  await act(async () => { fail(new ApiError(409, '最新の予約を確認してください。', 'version_conflict')) })
  await waitFor(() => expect(within(screen.getByRole('status', { name: '知らせ' })).getByText('ほかの操作で予約が変わりました。読み直してから、もう一度選んでください。')).toBeTruthy())
})

it('処理中に別の予約を開いて閉じた後は、前の予約の完了を通知しない', async () => {
  let finish!: (value: unknown) => void
  fixture.attendance.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  render(<><ReservationsPage /><ToastHost /></>)
  fireEvent.click(await screen.findByRole('button', { name: /^見本 114 2名/ }))
  let dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: '来店にする', exact: true }))
  fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }))
  fireEvent.click(await screen.findByRole('button', { name: /^見本 141 4名/ }))
  dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }))
  await act(async () => { finish({ success: true, data: { stamp: { status: 'recorded', count: 2 } } }) })
  expect(screen.queryByText(/来店スタンプ 2 個を確認しました。/)).toBeNull()
})

it('来店の保存と読み直しが終わった後、結果を窓の中で示す', async () => {
  render(<ReservationsPage />)
  fireEvent.click(await screen.findByRole('button', { name: /^見本 114 2名/ }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: '来店にする', exact: true }))
  expect(await within(dialog).findByText(/来店にしました。/)).toBeTruthy()
  expect(fixture.snapshot.mock.calls.length).toBeGreaterThan(1)
})

it('来店の処理が終わるまで窓の中に処理中を示す', async () => {
  let finish!: (value: unknown) => void
  fixture.attendance.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  render(<ReservationsPage />)
  fireEvent.click(await screen.findByRole('button', { name: /^見本 114 2名/ }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: '来店にする', exact: true }))
  expect(await within(dialog).findByText('予約を反映しています。完了するまでお待ちください。')).toBeTruthy()
  expect(within(dialog).queryByText(/来店にしました。/)).toBeNull()
  await act(async () => { finish({ data: { stamp: { status: 'recorded', count: 2 } } }) })
  expect(await within(dialog).findByText(/来店スタンプ 2 個を確認しました。/)).toBeTruthy()
})
