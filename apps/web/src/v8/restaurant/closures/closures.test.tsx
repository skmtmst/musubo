// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 日付の見本を作る前に日本時間で固定し、待ち合わせのタイマーは動かす。
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T12:00:00+09:00'))
})

const fixture = vi.hoisted(() => ({
  snapshot: vi.fn(), closures: vi.fn(), openingHours: vi.fn(), channelCloseTasks: vi.fn(), mediaLinks: vi.fn(),
  previewClosure: vi.fn(), createClosure: vi.fn(), updateClosure: vi.fn(), deleteClosure: vi.fn(), completeChannelCloseTask: vi.fn(),
  inventoryDay: vi.fn(), closureContactStatus: vi.fn(),
}))
const google = vi.hoisted(() => ({ profile: vi.fn(), proposeClosureHours: vi.fn() }))
const role = vi.hoisted(() => ({ value: 'owner' as string | null, account: 'account-1' }))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push() {}, replace() {}, prefetch() {} }), usePathname: () => '/restaurant-test/inventory', useSearchParams: () => new URLSearchParams() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: role.account, accounts: [] }) }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: fixture }))
vi.mock('@/lib/restaurant-google-api', () => ({ restaurantGoogleApi: google }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => role.value, canManageRole: (r: string | null) => r === 'owner' || r === 'admin' }))

import { ApiError } from '@/lib/api'
import InventoryPage from '../inventory/inventory'
import { snapshotOf } from '../booking-kit/test-data'
import { inputError, monthWeeks, overlapMessage, overlapping, statusLine, tasksFor, todayIn } from './format'

const today = todayIn('Asia/Tokyo')
const month = today.slice(0, 7)
const day = (d: number) => `${month}-${String(d).padStart(2, '0')}`
const lastDay = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()
/* 今日より後の日（月末に近い日に回しても今月の中に収まる日）。 */
const future = Math.min(lastDay, Number(today.slice(8)) + 1)

const closure = (id: string, d: number, over: Record<string, unknown> = {}) => ({
  id, storeId: 'store-1', startDate: day(d), endDate: day(d), allDay: true, startTime: null, endTime: null, kind: 'temporary_closed',
  memo: '設備点検のため', tableIds: [], createdBy: null, createdByName: null, createdAt: '', updatedAt: '', version: 3, ...over,
})
const hours = Array.from({ length: 7 }, (_, weekday) => ({ weekday, periods: weekday === 1 ? [] : [{ opensAt: '17:00', closesAt: '22:00' }] }))
const task = (id: string, channel: string, status: string) => ({
  id, storeId: 'store-1', slotId: null, startsAt: `${day(future)}T00:00:00.000Z`, channel, status, reason: 'closure', remainingSeats: null,
  recipientIds: [], createdAt: '', updatedAt: '', closureId: 'cl-1', closureVersion: 3, closureKind: 'temporary_closed',
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T12:00:00+09:00'))
  role.value = 'owner'
  role.account = 'account-1'
  window.history.replaceState(null, '', '/restaurant-test/inventory?tab=closures')
  fixture.snapshot.mockResolvedValue({ data: snapshotOf() })
  fixture.closures.mockResolvedValue({ data: [closure('cl-1', future), closure('cl-2', future, { kind: 'private_event', allDay: false, startTime: '18:00', endTime: '22:00', tableIds: ['pa', 't1'], memo: '会社の宴会' })] })
  fixture.openingHours.mockResolvedValue({ data: { storeId: 'store-1', hours, version: 1 } })
  fixture.channelCloseTasks.mockResolvedValue({ data: [task('k1', 'hotpepper', 'close'), task('k2', 'tabelog', 'close')] })
  fixture.mediaLinks.mockResolvedValue({ data: [
    { code: 'hotpepper', name: 'ホットペッパー', acceptsReservations: 1, pageUrl: null, loginUrl: 'https://cms.example.jp/', closeOnBooking: 1, version: 1 },
    { code: 'tabelog', name: '食べログ', acceptsReservations: 1, pageUrl: null, loginUrl: null, closeOnBooking: 1, version: 1 },
  ] })
  fixture.previewClosure.mockResolvedValue({ data: { reservations: [
    { id: 'r1', startsAt: `${day(future)}T03:00:00.000Z`, endsAt: `${day(future)}T05:00:00.000Z`, guestCount: 2, customerName: '見本 143', source: 'line', tableId: 't1', friendId: 'friend-9', isLineFriend: true },
    { id: 'r2', startsAt: `${day(future)}T10:00:00.000Z`, endsAt: `${day(future)}T12:00:00.000Z`, guestCount: 4, customerName: '見本 121', source: 'hotpepper', tableId: 't4', friendId: null, isLineFriend: false },
  ], waitlistCount: 0, conflicts: [], confirmationSnapshot: 'preview-token' } })
  fixture.createClosure.mockImplementation(async (_a: string, body: Record<string, unknown>) => ({ data: { closure: { ...closure('cl-new', future), ...body, id: 'cl-new', version: 1 }, reservations: [{}, {}], waitlistCount: 0, conflicts: [], confirmationSnapshot: 'preview-token' } }))
  fixture.deleteClosure.mockResolvedValue({ data: { id: 'cl-1', version: 4, archived: true } })
  fixture.completeChannelCloseTask.mockResolvedValue({ success: true })
  fixture.closureContactStatus.mockImplementation(async (_a: string, id: string) => ({ data: id === 'cl-1'
    ? { contactedCount: 1, reservations: [{ id: 'r1' }, { id: 'r2' }], waitlistCount: 0, conflicts: [] }
    : { contactedCount: 0, reservations: [], waitlistCount: 0, conflicts: [], confirmationSnapshot: 'preview-token' } }))
  google.profile.mockResolvedValue({ profile: { specialHours: [] } })
  google.proposeClosureHours.mockResolvedValue({ success: true, change: {} })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); window.history.replaceState(null, '', '/') })

describe('UVnvR 休業日・貸切', () => {
  it('?tab=closures で開き、頭の説明・カレンダーの札・定休・右の列・上の知らせを出す', async () => {
    render(<InventoryPage />)
    const card = await waitFor(() => {
      const found = document.querySelector('[data-closure-card="cl-1"]')
      if (!found) throw new Error('まだ')
      return found as HTMLElement
    })
    const board = document.querySelector('[data-design-node="UVnvR"]')!
    fireEvent.click(screen.getByRole('button', { name: '予約枠・在庫の説明' }))
    expect(screen.getByText('渋谷店・1つの時間帯の総数 20席（有効な卓 5 卓）')).toBeTruthy()
    expect(board.textContent).not.toContain('検証環境専用')
    const toggle = within(screen.getByRole('group', { name: '予約枠・在庫の切り替え' })).getByRole('button', { name: '休業日・貸切' })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('[data-closure-card="cl-1"]')).toBe(card)
    expect(card.textContent).toContain('終日・全卓')
    expect(card.textContent).toContain('他サイト 未対応 2')
    /* 連絡済みは contact-status の数（休業を作った後に担当者が LINE で送った予約）。 */
    await waitFor(() => expect(card.textContent).toContain('予約 2 件・連絡済み 1 件・他サイト 未対応 2'))
    expect(fixture.closureContactStatus).toHaveBeenCalledWith('account-1', 'cl-1')
    expect(document.querySelector('[data-closure-card="cl-2"]')!.textContent).toContain('18:00〜22:00・個室A・T1')
    expect(screen.getAllByText('定休').length).toBeGreaterThan(1)
    const band = document.querySelector('[data-closure-band]') as HTMLElement
    expect(band.textContent).toContain('他の予約サイトの枠を閉じてください（未対応 2 件）')
    expect(band.textContent).toContain('ホットペッパー・食べログの')
    expect(within(band).getByRole('link', { name: 'ホットペッパーの管理画面を開く' }).getAttribute('href')).toBe('https://cms.example.jp/')
    fireEvent.click(within(band).getByRole('button', { name: 'ホットペッパーの枠を閉じた' }))
    await waitFor(() => expect(fixture.completeChannelCloseTask).toHaveBeenCalledWith('account-1', 'k1'))
  })

  it('右上のボタンで足す窓を開き、preview の重なる予約と「LINE で連絡する」（受信箱のその友だち）を出して保存する', async () => {
    render(<InventoryPage />)
    fireEvent.click(await screen.findByRole('button', { name: /臨時休業・貸切を足す/ }))
    const dialog = await waitFor(() => {
      const found = document.querySelector('[data-design-node="nVvXy"]')
      if (!found) throw new Error('まだ')
      return found as HTMLElement
    })
    await within(dialog).findByText(/予約が 2 件あります（保存しても取り消しません）/)
    expect(fixture.previewClosure).toHaveBeenCalledWith('account-1', expect.objectContaining({ storeId: 'store-1', allDay: true, kind: 'temporary_closed', tableIds: [] }))
    expect(within(dialog).getByRole('link', { name: 'LINE で連絡する' }).getAttribute('href')).toBe('/chats?friend=friend-9')
    expect(dialog.textContent).toContain('ホットペッパー・食べログに「閉じる知らせ」を出す')
    fireEvent.click(within(dialog).getByRole('radio', { name: '卓を選ぶ（貸切の一部など）' }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '個室A（8席）' }))
    await within(dialog).findByText(/予約が 2 件あります/ )
    fireEvent.click(within(dialog).getByRole('button', { name: 'この日を閉じる' }))
    await waitFor(() => expect(fixture.createClosure).toHaveBeenCalledWith('account-1', expect.objectContaining({ storeId: 'store-1', startDate: today, tableIds: ['pa'], expectedSnapshot: 'preview-token' })))
    /* 卓を選んだ記録は Google の案を作らない（店全体の休みになるため）。 */
    expect(google.proposeClosureHours).not.toHaveBeenCalled()
  })

  it('重なる予約を確認できない場合は保存しない', async () => {
    fixture.previewClosure.mockRejectedValue(new Error('offline'))
    render(<InventoryPage />)
    fireEvent.click(await screen.findByRole('button', { name: /臨時休業・貸切を足す/ }))
    const dialog = await waitFor(() => document.querySelector('[data-design-node="nVvXy"]') as HTMLElement)
    await waitFor(() => expect(fixture.previewClosure).toHaveBeenCalled())
    fireEvent.click(within(dialog).getByRole('button', { name: 'この日を閉じる' }))
    expect(await within(dialog).findByText('予約を確認できませんでした。読み直してからもう一度お試しください。')).not.toBeNull()
    expect(fixture.createClosure).not.toHaveBeenCalled()
  })

  it('全卓の臨時休業は Google の案も作る。ほかの記録と重なる（409）ときは窓の中に文を出す', async () => {
    render(<InventoryPage />)
    fireEvent.click(await screen.findByRole('button', { name: /臨時休業・貸切を足す/ }))
    const dialog = await waitFor(() => document.querySelector('[data-design-node="nVvXy"]') as HTMLElement)
    await within(dialog).findByText(/予約が 2 件あります/)
    fireEvent.click(within(dialog).getByRole('button', { name: 'この日を閉じる' }))
    await waitFor(() => expect(google.proposeClosureHours).toHaveBeenCalledWith('account-1', 'cl-new', 1, false))

    fixture.createClosure.mockRejectedValueOnce(new ApiError(409, '重なっています', 'closure_overlap', {
      conflicts: [closure('cl-x', future, { name: '会社の宴会', kind: 'private_event', allDay: false, startTime: '18:00', endTime: '22:00' })],
    }))
    fireEvent.click(await screen.findByRole('button', { name: /臨時休業・貸切を足す/ }))
    const again = await waitFor(() => document.querySelector('[data-design-node="nVvXy"]') as HTMLElement)
    await within(again).findByText(/予約が 2 件あります/)
    fireEvent.click(within(again).getByRole('button', { name: 'この日を閉じる' }))
    /* 409 の data から相手の名前と日付を出す。 */
    expect(await within(again).findByText(/の貸切「会社の宴会」と重なっています。日付か卓を変えてください。/)).not.toBeNull()
  })

  it('変える窓は自分を除いて preview を呼び、電話番号・連絡済みを preview から出す。閉じる知らせは外せる', async () => {
    fixture.previewClosure.mockResolvedValue({ data: { contactedCount: 1, reservations: [
      { id: 'r1', startsAt: `${day(future)}T03:00:00.000Z`, endsAt: `${day(future)}T05:00:00.000Z`, guestCount: 2, customerName: '見本 143', customerPhone: null, contacted: true, source: 'line', tableId: 't1', friendId: 'friend-9', isLineFriend: true },
      { id: 'r2', startsAt: `${day(future)}T10:00:00.000Z`, endsAt: `${day(future)}T12:00:00.000Z`, guestCount: 4, customerName: '見本 121', customerPhone: '03-0000-5678', contacted: false, source: 'hotpepper', tableId: 't4', friendId: null, isLineFriend: false },
    ], waitlistCount: 0, conflicts: [], confirmationSnapshot: 'preview-token' } })
    fixture.updateClosure.mockImplementation(async (_a: string, id: string, body: Record<string, unknown>) => ({ data: { closure: { ...closure(id, future), ...body, version: 4 }, reservations: [], contactedCount: 0, waitlistCount: 0, conflicts: [] } }))
    render(<InventoryPage />)
    await waitFor(() => expect(document.querySelector('[data-closure-card="cl-1"]')).not.toBeNull())
    const card = document.querySelector('[data-closure-card="cl-1"]') as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: /の操作$/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '変える' }))
    const dialog = await waitFor(() => document.querySelector('[data-design-node="nVvXy"]') as HTMLElement)
    await within(dialog).findByText(/予約が 2 件あります（保存しても取り消しません・連絡済み 1 件）/)
    expect(fixture.previewClosure).toHaveBeenCalledWith('account-1', expect.objectContaining({ excludeId: 'cl-1' }))
    expect(within(dialog).getByRole('link', { name: /電話で連絡（03-0000-5678）/ })).not.toBeNull()
    expect(within(dialog).getByRole('link', { name: '連絡済み（会話を見る）' }).getAttribute('href')).toBe('/chats?friend=friend-9')
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /「閉じる知らせ」を出す/ }))
    await within(dialog).findByText(/予約が 2 件あります/)
    fireEvent.click(within(dialog).getByRole('button', { name: '変更を保存' }))
    await waitFor(() => expect(fixture.updateClosure).toHaveBeenCalledWith('account-1', 'cl-1', expect.objectContaining({ notifyMedia: false, expectedVersion: 3, expectedSnapshot: 'preview-token' })))
  })

  it('「…」の「消して開ける」は確かめてから版つきで消す', async () => {
    render(<InventoryPage />)
    await waitFor(() => expect(document.querySelector('[data-closure-card="cl-1"]')).not.toBeNull())
    const card = document.querySelector('[data-closure-card="cl-1"]') as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: /の操作$/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '消して開ける' }))
    const confirm = (await screen.findByText(/の臨時休業を消しますか/)).closest('[role="alertdialog"]') as HTMLElement
    expect(confirm.textContent).toContain('「もう開けてよい」の知らせを出します')
    expect(confirm.textContent).toContain('LINEアカウント')
    expect(confirm.textContent).toContain('渋谷店')
    expect(confirm.textContent).toContain('環境')
    fireEvent.click(within(confirm).getByRole('button', { name: '消して開ける' }))
    await waitFor(() => expect(fixture.deleteClosure).toHaveBeenCalledWith('account-1', 'cl-1', 3))
  })

  it('削除の確認中にアカウントが変わったら古い確認から消せない', async () => {
    const view = render(<InventoryPage />)
    await waitFor(() => expect(document.querySelector('[data-closure-card="cl-1"]')).not.toBeNull())
    fireEvent.click(within(document.querySelector('[data-closure-card="cl-1"]') as HTMLElement).getByRole('button', { name: /の操作$/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '消して開ける' }))
    const confirm = (await screen.findByText(/の臨時休業を消しますか/)).closest('[role="alertdialog"]') as HTMLElement
    role.account = 'account-2'
    view.rerender(<InventoryPage />)
    fireEvent.click(within(confirm).getByRole('button', { name: '消して開ける' }))
    expect(fixture.deleteClosure).not.toHaveBeenCalled()
  })

  it('閲覧のみ（viewer）には足す・日を押す・変える・消す・［閉じた］・Google の案を置かない', async () => {
    role.value = 'viewer'
    render(<InventoryPage />)
    await waitFor(() => expect(document.querySelector('[data-closure-card="cl-1"]')).not.toBeNull())
    expect(screen.queryByRole('button', { name: /臨時休業・貸切を足す/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /を閉じる$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /枠を閉じた$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /案を作る$/ })).toBeNull()
    const card = document.querySelector('[data-closure-card="cl-1"]') as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: /の操作$/ }))
    expect(await screen.findByRole('menuitem', { name: '予約台帳でこの日を見る' })).not.toBeNull()
    expect(screen.queryByRole('menuitem', { name: '変える' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: '消して開ける' })).toBeNull()
  })
})

describe('休業日・貸切の数え方', () => {
  it('月の升は日曜はじまりで、前後を空ける', () => {
    const weeks = monthWeeks('2026-10')
    expect(weeks[0]).toEqual([null, null, null, null, '2026-10-01', '2026-10-02', '2026-10-03'])
    expect(weeks.at(-1)).toEqual(['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31'])
  })

  it('重なる予約は店舗の時刻で比べ、取消と選んでいない卓の予約は数えない', () => {
    const r = (id: string, startsAt: string, endsAt: string, over: Record<string, unknown> = {}) => ({ id, starts_at: startsAt, ends_at: endsAt, status: 'confirmed', table_id: 't1', ...over }) as never
    const rows = [
      r('a', '2026-10-20T09:00:00.000Z', '2026-10-20T11:00:00.000Z'), // 18:00 JST
      r('b', '2026-10-20T02:00:00.000Z', '2026-10-20T04:00:00.000Z'), // 11:00 JST（時間帯の外）
      r('c', '2026-10-20T10:00:00.000Z', '2026-10-20T12:00:00.000Z', { status: 'cancelled' }),
      r('d', '2026-10-20T10:00:00.000Z', '2026-10-20T12:00:00.000Z', { table_id: 't4' }),
      r('e', '2026-10-20T10:00:00.000Z', '2026-10-20T12:00:00.000Z', { table_id: null }),
    ]
    const input = { startDate: '2026-10-20', endDate: '2026-10-20', allDay: false, startTime: '18:00', endTime: '22:00', tableIds: ['t1'] }
    expect(overlapping(input, rows, 'Asia/Tokyo').map((x: { id: string }) => x.id)).toEqual(['a', 'e'])
    expect(overlapping({ ...input, allDay: true, tableIds: [] }, rows, 'Asia/Tokyo').map((x: { id: string }) => x.id)).toEqual(['b', 'a', 'd', 'e'])
  })

  it('他サイトの状態：未対応があれば未対応、全部閉じたら n/m。件数が分からなければ予約は書かない', () => {
    const t = (status: string) => ({ reason: 'closure', closureId: 'x', status }) as never
    expect(statusLine(2, tasksFor({ id: 'x' }, [t('close'), t('done')]))).toBe('予約 2 件・他サイト 未対応 1')
    expect(statusLine(0, tasksFor({ id: 'x' }, [t('done'), t('done')]))).toBe('予約 0 件・他サイト 閉じた 2/2')
    expect(statusLine(null, tasksFor({ id: 'x' }, []))).toBe('')
    expect(statusLine(2, tasksFor({ id: 'x' }, []), 1)).toBe('予約 2 件・連絡済み 1 件')
    expect(statusLine(0, tasksFor({ id: 'x' }, []), 0)).toBe('予約 0 件')
  })

  it('重なりの文：相手の種類・名前・日付・時刻。相手が分からなければ一般の文', () => {
    const c = { name: '会社の宴会', kind: 'private_event' as const, startDate: '2026-10-24', endDate: '2026-10-24', allDay: false, startTime: '18:00', endTime: '22:00' }
    expect(overlapMessage([c])).toBe('10月24日（土） 18:00〜22:00の貸切「会社の宴会」と重なっています。日付か卓を変えてください。')
    expect(overlapMessage([{ ...c, name: '臨時休業', kind: 'temporary_closed', allDay: true }, c])).toBe('10月24日（土）の臨時休業（ほか 1 件）と重なっています。日付か卓を変えてください。')
    expect(overlapMessage([])).toBe('同じ日・同じ卓に、ほかの休業・貸切があります。日付か卓を変えてください。')
  })

  it('入力の誤り：過去の日・おわりが前・時間帯の逆を止める', () => {
    const base = { storeId: 's', startDate: '2026-10-20', endDate: '2026-10-20', allDay: true, startTime: null, endTime: null, kind: 'other' as const }
    expect(inputError(base, '2026-10-07')).toBe('')
    expect(inputError({ ...base, startDate: '2026-10-01' }, '2026-10-07')).toContain('今日より前')
    expect(inputError({ ...base, endDate: '2026-10-19' }, '2026-10-07')).toContain('おわりの日')
    expect(inputError({ ...base, allDay: false, startTime: '22:00', endTime: '18:00' }, '2026-10-07')).toContain('始まりより後')
  })
})

it.each(['tasks','media'])('closure auxiliary %s failure is visible and retryable',async(kind)=>{
 const call=kind==='tasks'?fixture.channelCloseTasks:fixture.mediaLinks
 call.mockRejectedValueOnce(new Error('人工取得失敗'))
 render(<InventoryPage />)
 const error=await screen.findByText(kind==='tasks'?'枠を閉じる知らせを読み込めませんでした':'予約サイトを読み込めませんでした')
 fireEvent.click(error.closest('[data-list-state="error"]')!.querySelector('button')!)
 await waitFor(()=>expect(screen.queryByText(kind==='tasks'?'枠を閉じる知らせを読み込めませんでした':'予約サイトを読み込めませんでした')).toBeNull())
})
