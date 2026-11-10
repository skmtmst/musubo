import { PERMISSION_LOCK_REASON, PERMISSION_LOCK_SUMMARY } from '@/components/shared/permission-lock'
// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 日付の見本を作る前に日本時間で固定し、待ち合わせのタイマーは動かす。
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T12:00:00+09:00'))
})

const fixture = vi.hoisted(() => ({
  snapshot: vi.fn(), inventoryDay: vi.fn(), openingHours: vi.fn(), saveOpeningHours: vi.fn(), saveInventoryAllocation: vi.fn(),
  updateInventory: vi.fn(), generateInventory: vi.fn(), listIntakeAddresses: vi.fn(), issueIntakeAddress: vi.fn(),
}))
const fetchApi = vi.hoisted(() => vi.fn())
const role = vi.hoisted(() => ({ value: 'owner' as string | null }))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push() {}, replace() {}, prefetch() {} }), usePathname: () => '/restaurant-test/inventory', useSearchParams: () => new URLSearchParams(window.location.search) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-1', accounts: [] }) }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: fixture }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => role.value, canManageRole: (r: string | null) => r === 'owner' || r === 'admin' }))
vi.mock('@/lib/api', async (load) => ({ ...(await load<typeof import('@/lib/api')>()), fetchApi }))

import { ApiError } from '@/lib/api'
import InventoryPage from './inventory'
import { joinTableCodes } from './format'
import { snapshotOf, tables } from '../booking-kit/test-data'

const at = (dayOffset: number, hour: number, minute = 0) => {
  const today = new Date()
  today.setDate(today.getDate() + dayOffset)
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(today)
  return new Date(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+09:00`).toISOString()
}

const slot = (id: string, hour: number, occupied: string[], seats: number, over: Record<string, unknown> = {}) => ({
  id, store_id: 'store-1', starts_at: at(0, hour), slot_minutes: 30, total_capacity: 20, ota_capacity: 8, line_capacity: 6, walk_in_capacity: 6,
  reserved_count: seats, occupied_seats: seats, occupiedTableIds: occupied, freeSeats: 20 - seats, version: 3, updated_by_name: '見本 30', updated_at: at(0, 14, 2), ...over,
})
const days = [slot('s17', 17, ['pa'], 8), slot('s19', 19, ['pa', 't1', 't2', 't3', 't4'], 18, { ota_capacity: 6, line_capacity: 4, walk_in_capacity: 4 })]
const hours = Array.from({ length: 7 }, (_, weekday) => ({ weekday, periods: weekday === 1 ? [] : [{ opensAt: '17:00', closesAt: '22:00' }] }))
const channels = [
  { id: 'hp', code: 'hotpepper', name: 'Hot Pepper グルメ', todayCount: 9, lastReceivedAt: at(0, 18, 42), unreadableCount: 0, receiveMethod: 'email_forward', status: 'receiving', daysWithoutReceipt: 0 },
  { id: 'rt', code: 'retty', name: 'Retty', todayCount: 0, lastReceivedAt: at(-7, 12), unreadableCount: 0, receiveMethod: 'email_forward', status: 'not_receiving', daysWithoutReceipt: 7 },
  { id: 'manual', code: 'manual', name: '電話・LINE・店頭', todayCount: 4, lastReceivedAt: at(0, 17, 30), unreadableCount: 0, receiveMethod: 'manual', status: 'receiving', daysWithoutReceipt: 0 },
]

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T12:00:00+09:00'))
  role.value = verifiedStaffRole('owner')
  fixture.snapshot.mockResolvedValue({ data: snapshotOf() })
  fixture.inventoryDay.mockResolvedValue({ data: days })
  fixture.openingHours.mockResolvedValue({ data: { storeId: 'store-1', hours, version: 4, updatedBy: 'mem-2', updatedAt: at(0, 14, 2) } })
  fixture.saveOpeningHours.mockResolvedValue({ success: true, data: { version: 5 } })
  fixture.saveInventoryAllocation.mockResolvedValue({ success: true, data: { updated: 2 } })
  fixture.updateInventory.mockResolvedValue({ success: true })
  fixture.listIntakeAddresses.mockResolvedValue({ data: [{ id: 'ia', storeId: 'store-1', localPart: 'r', address: 'r-1@in.example.jp', status: 'active', createdAt: '', revokedAt: null }] })
  fetchApi.mockImplementation(async (path: string) => (path.includes('/channels')
    ? { success: true, data: channels }
    : { success: true, data: [{ id: 'mail-1', storeId: 'store-1', receivedAt: at(0, 18, 20), status: 'quarantined', reason: '人数の欄が読めませんでした', mediaCode: 'tabelog', mediaName: '食べログ' }], total: 1 }))
})
afterEach(() => { delete document.documentElement.dataset.theme; cleanup(); vi.useRealTimers(); vi.clearAllMocks(); window.history.replaceState(null, '', '/') })

describe('Y8SjT2 予約枠・在庫', () => {
  it('卓と時間帯がないとき右の欄にも次の操作を案内する', async () => {
    fixture.snapshot.mockResolvedValue({ data: snapshotOf({ tables: [] }) })
    fixture.inventoryDay.mockResolvedValue({ data: [] })
    render(<InventoryPage />)
    await screen.findByText('この日の時間帯がありません')
    expect(screen.getByText('卓がありません。座席・卓管理で追加してください。')).not.toBeNull()
    expect(screen.getByText('卓を追加すると、ここに空きと利用状況が出ます。')).not.toBeNull()
    expect(screen.getByRole('link', { name: '座席・卓管理を開く' }).getAttribute('href')).toContain('/restaurant-test/tables')
  })

  it('配分・在庫の表・いちばん混む時間の卓と「行を押したとき」の箱・開ける時間が出る', async () => {
    render(<InventoryPage />)
    await screen.findByText('19:00 の卓')
    const board = document.querySelector('[data-design-node="Y8SjT2"]')!
    expect(board.textContent).toContain('1つの時間帯の総数 20席')
    expect(board.textContent).toContain('個室A・T1〜T4')
    expect(board.textContent).toContain('行を押したとき：19:00 の配分だけ直す')
    expect(board.textContent).toContain('休み（定休日）・お客さまの画面に出ません')
  })

  it('変更前の配分と開ける時間は保存できず、変更後は保存できる', async () => {
    render(<InventoryPage />)
    await screen.findByText('19:00 の卓')
    const save = screen.getByRole('button', { name: /受付時間と配分を保存/ }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByRole('spinbutton', { name: '予約サイト' }), { target: { value: '7' } })
    expect(save.disabled).toBe(false)
  })

  it('下の帯の保存は、配分（全部の時間帯）と開ける時間を今の口へ送る', async () => {
    render(<InventoryPage />)
    await screen.findByText('19:00 の卓')
    fireEvent.change(screen.getByRole('spinbutton', { name: '予約サイト' }), { target: { value: '7' } })
    fireEvent.click(screen.getByRole('button', { name: /受付時間と配分を保存/ }))
    await waitFor(() => expect(fixture.saveOpeningHours).toHaveBeenCalled())
    expect(fixture.saveInventoryAllocation).toHaveBeenCalledWith('account-1', expect.objectContaining({ storeId: 'store-1', otaCapacity: 7, slots: [{ id: 's17', expectedVersion: 3 }, { id: 's19', expectedVersion: 3 }] }))
    expect(fixture.saveOpeningHours).toHaveBeenCalledWith('account-1', expect.objectContaining({ storeId: 'store-1', expectedVersion: 4 }))
  })

  it('ほかの担当者が先に保存していたら（409）競合の帯を出し、上の帯は重ねない', async () => {
    fixture.saveInventoryAllocation.mockRejectedValue(new ApiError(409, 'conflict'))
    render(<InventoryPage />)
    await screen.findByText('19:00 の卓')
    fireEvent.change(screen.getByRole('spinbutton', { name: '予約サイト' }), { target: { value: '7' } })
    fireEvent.click(screen.getByRole('button', { name: /受付時間と配分を保存/ }))
    const band = await screen.findByRole('alert')
    expect(band.textContent).toContain('見本さんが 14:02 に予約枠・在庫を保存しました')
    expect(screen.getByRole('button', { name: /比べてから保存/ })).not.toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByText('行を押したとき：19:00 の配分だけ直す')).toBeNull()
  })

  it('残りが少ない時間帯は、媒体を閉じる知らせ（Yyw6i）でメール転送の媒体だけに印を付けられる', async () => {
    render(<InventoryPage />)
    await screen.findByText('19:00 の卓')
    fireEvent.click(screen.getByRole('button', { name: '媒体の受付を閉じる' }))
    const dialog = document.querySelector('[data-design-node="Yyw6i"]') as HTMLElement
    expect(dialog.textContent).toContain('19:00 が残り 2 席になりました')
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(1)
    const record = within(dialog).getByRole('button', { name: '閉じたものを記録する' }) as HTMLButtonElement
    expect(record.disabled).toBe(true)
    expect(record.title).toContain('チェック')
    fireEvent.click(within(dialog).getByRole('checkbox'))
    expect(record.disabled).toBe(false)
    fireEvent.click(record)
    expect(document.querySelector('[data-design-node="Yyw6i"]')).toBeNull()
  })

  it('予約経路の連携（hQQlt）は媒体ごとの受け取りと読めなかったものを出す', async () => {
    render(<InventoryPage />)
    await screen.findByText('19:00 の卓')
    fireEvent.click(screen.getByRole('button', { name: '予約経路の連携' }))
    await screen.findByText('Hot Pepper グルメ')
    expect(screen.getByText('7日届いていない')).not.toBeNull()
    expect(screen.getByText('読めなかったもの')).not.toBeNull()
    expect(screen.getByDisplayValue('r-1@in.example.jp')).not.toBeNull()
  })

  it('読めなかった予約の空入力は欄で知らせ、最初の欄へ移動して取り込まない', async () => {
    render(<InventoryPage />)
    await screen.findByText('19:00 の卓')
    fireEvent.click(screen.getByRole('button', { name: '予約経路の連携' }))
    fireEvent.click(await screen.findByRole('button', { name: '手で直して取り込む' }))
    fireEvent.click(screen.getByRole('button', { name: '台帳へ取り込む' }))
    const name = screen.getByLabelText('お客さまのお名前')
    await waitFor(() => expect(document.activeElement).toBe(name))
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('お客さまのお名前を入れてください。')).not.toBeNull()
    expect(fetchApi.mock.calls.some(([path, options]) => path.includes('/manual-import') && options?.method === 'POST')).toBe(false)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it.each(['staff', 'viewer'] as const)('%sには変更ボタンを理由付きで残し、クリック・キーでも保存を始めない', async (value) => {
    role.value = verifiedStaffRole(value)
    render(<InventoryPage />)
    await screen.findByText('19:00 の卓')
    const reason = value === 'viewer' ? PERMISSION_LOCK_REASON.viewer : PERMISSION_LOCK_REASON.feature
    for (const [name, savedValue] of [
      ['予約サイト', '8'], ['LINE 専用', '6'], ['当日（ウォークイン）', '6'],
      ['19:00の予約サイト', '6'], ['19:00のLINE', '4'], ['19:00の当日', '4'],
    ]) {
      const input = screen.getByRole('spinbutton', { name }) as HTMLInputElement
      expect(input.value).toBe(savedValue)
      expect(input.disabled).toBe(true)
      expect(input.readOnly).toBe(true)
      fireEvent.change(input, { target: { value: '999' } })
      expect(input.value).toBe(savedValue)
    }
    const controls = [
      ...screen.getAllByRole('switch'),
      screen.getByRole('button', { name: /受付時間と配分を保存/ }),
      screen.getAllByRole('button', { name: '＋ 時間帯を足す' })[0],
      screen.getByRole('button', { name: '火曜日の1つ目の時間帯を外す' }),
      screen.getByRole('button', { name: 'この時間帯だけ保存' }),
      screen.getByRole('button', { name: '媒体の受付を閉じる' }),
    ]
    expect(screen.getAllByRole('switch')).toHaveLength(7)
    expect(screen.getByRole('switch', { name: '月曜日に予約を受ける' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('switch', { name: '火曜日に予約を受ける' }).getAttribute('aria-checked')).toBe('true')
    for (const control of controls) {
      expect(control.getAttribute('aria-disabled')).toBe('true')
      expect((control as HTMLButtonElement).disabled).toBe(false)
      expect(control.tabIndex).toBe(0)
      const description = control.getAttribute('aria-describedby')
      expect(description && document.getElementById(description)?.textContent).toBe(reason)
      expect(fireEvent.keyDown(control, { key: 'Enter' })).toBe(false)
      expect(fireEvent.keyDown(control, { key: ' ' })).toBe(false)
      fireEvent.click(control)
    }
    expect(screen.getByRole('switch', { name: '月曜日に予約を受ける' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('switch', { name: '火曜日に予約を受ける' }).getAttribute('aria-checked')).toBe('true')
    expect(fixture.saveOpeningHours).not.toHaveBeenCalled()
    expect(fixture.saveInventoryAllocation).not.toHaveBeenCalled()
    expect(fixture.updateInventory).not.toHaveBeenCalled()
    expect(fixture.generateInventory).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('status').textContent).toContain(value === 'viewer' ? '閲覧のみで見ています。' : PERMISSION_LOCK_SUMMARY.feature)
  })

  it('本人が未確認なら理由を断定せず変更操作を止める', async () => {
    role.value = verifiedStaffRole(null)
    render(<InventoryPage />)
    await screen.findByText('19:00 の卓')
    const save = screen.getByRole('button', { name: /受付時間と配分を保存/ }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(save.hasAttribute('data-permission-locked')).toBe(false)
    for (const control of screen.getAllByRole('switch')) {
      expect((control as HTMLButtonElement).disabled).toBe(true)
      expect(control.hasAttribute('data-permission-locked')).toBe(false)
      fireEvent.click(control)
    }
    expect(screen.getByRole('switch', { name: '月曜日に予約を受ける' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByText(/閲覧のみで見ています/)).toBeNull()
    fireEvent.click(save)
    expect(fixture.saveOpeningHours).not.toHaveBeenCalled()
    expect(fixture.saveInventoryAllocation).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '予約経路の連携' }))
    const issue = await screen.findByRole('button', { name: '発行する' }) as HTMLButtonElement
    expect(document.querySelector('[data-read-only-notice]')).toBeNull()
    expect(issue.disabled).toBe(true)
    fireEvent.click(issue)
    expect(fixture.issueIntakeAddress).not.toHaveBeenCalled()
  })

  it('閲覧のみの予約経路は発行操作を残して止め、管理者限定の取得も始めない', async () => {
    role.value = verifiedStaffRole('viewer')
    render(<InventoryPage />)
    await screen.findByText('19:00 の卓')
    fireEvent.click(screen.getByRole('button', { name: '予約経路の連携' }))
    const issue = await screen.findByRole('button', { name: '発行する' })
    expect(issue.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(issue)
    expect(fixture.issueIntakeAddress).not.toHaveBeenCalled()
    expect(fixture.listIntakeAddresses).not.toHaveBeenCalled()
    expect(fetchApi.mock.calls.some(([path]) => path.includes('/inbound-emails'))).toBe(false)
  })

  it('埋まっている卓は個室→テーブル→カウンターの順、3つ以上の連番は「〜」で縮める', () => {
    const pick = (codes: string[]) => tables.filter((t) => codes.includes(t.code))
    expect(joinTableCodes(pick(['T1', 'T3', 'T4', '個室A']))).toBe('個室A・T1・T3・T4')
    expect(joinTableCodes(pick(['T1', 'T2', 'T3', 'T4', '個室A']))).toBe('個室A・T1〜T4')
  })
})

it('OP-R04 未保存の配分があるタブの移動は確認し、取り消すと入力を残す',async()=>{
 document.documentElement.dataset.theme='v8'
 render(<InventoryPage/>)
 const input=await screen.findByRole('spinbutton',{name:'予約サイト'})
 fireEvent.change(input,{target:{value:'7'}})
 fireEvent.click(screen.getByRole('button',{name:'予約経路の連携'}))
 const dialog=await screen.findByRole('dialog',{name:'保存していない変更があります'})
 expect((input as HTMLInputElement).value).toBe('7')
 fireEvent.click(within(dialog).getByRole('button',{name:'編集を続ける'}))
 expect((input as HTMLInputElement).value).toBe('7')
 fireEvent.click(screen.getByRole('button',{name:'予約経路の連携'}))
 fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'保存せずに移る'}))
 await screen.findByText('Hot Pepper グルメ')
 expect(fixture.saveInventoryAllocation).not.toHaveBeenCalled()
 delete document.documentElement.dataset.theme
})

it('inventory channel read failure does not become no channels',async()=>{
 fetchApi.mockRejectedValueOnce(new Error('人工取得失敗'))
 render(<InventoryPage />)
 const error=await screen.findByText('予約サイトを読み込めませんでした')
 fireEvent.click(error.closest('[data-list-state="error"]')!.querySelector('button')!)
 await waitFor(()=>expect(screen.queryByText('予約サイトを読み込めませんでした')).toBeNull())
})

afterEach(() => { verifiedStaffRole(null) })

describe('予約枠・在庫の切り替え', () => {
  it('共通タブを外し、画面内の切り替えと座席・卓管理への行き先を保つ', async () => {
    render(<InventoryPage />)
    await screen.findByText('19:00 の卓')
    expect(screen.queryByRole('tablist', {name:'店の中の画面'})).toBeNull()
    expect(screen.getByRole('link',{name:'座席・卓管理で変える →'}).getAttribute('href')).toBe('/restaurant-test/tables')
    // 席・枠の配分や予約経路などの切り替えは残す。
    const inner = screen.getByRole('group', { name: '予約枠・在庫の切り替え' })
    expect(within(inner).getAllByRole('button')).toHaveLength(4)
  })
})

it('指定された店舗が先頭でなくても、その店舗の営業時間だけを開く', async () => {
  window.history.replaceState(null, '', '/restaurant-test/inventory?storeId=store-2#rs-hours-title')
  fixture.snapshot.mockResolvedValue({ data: snapshotOf({ stores: [{...snapshotOf().stores[0], id:'store-1',name:'先頭店'}, {...snapshotOf().stores[0], id:'store-2',name:'対象店'}] }) })
  render(<InventoryPage />)
  await waitFor(() => expect(fixture.openingHours).toHaveBeenCalledWith('account-1','store-2'))
  expect(fixture.openingHours).not.toHaveBeenCalledWith('account-1','store-1')
})
it('指定店が見つからなければ別の店を開かない', async () => {
  window.history.replaceState(null, '', '/restaurant-test/inventory?storeId=unknown#rs-hours-title')
  render(<InventoryPage />)
  await screen.findByText('指定された店舗を確認できません')
  expect(fixture.openingHours).not.toHaveBeenCalled()
})

it('営業時間への案内は対象へ一度移動し、店の指定を残して目印を消す', async () => {
  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
  window.history.replaceState(null, '', '/restaurant-test/inventory?storeId=store-1#rs-hours-title')
  render(<InventoryPage />)
  await waitFor(() => expect(scroll).toHaveBeenCalledWith({ block: 'start' }))
  expect(window.location.search).toBe('?storeId=store-1')
  expect(window.location.hash).toBe('')
  scroll.mockRestore()
})
