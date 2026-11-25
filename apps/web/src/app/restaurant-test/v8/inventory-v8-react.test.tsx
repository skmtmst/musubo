// @vitest-environment happy-dom
// 時間帯の表示は端末の時計に従う。板どおりの JST で固定する。
process.env.TZ = 'Asia/Tokyo'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ snapshot: vi.fn(), inventoryDay: vi.fn(), openingHours: vi.fn(), saveOpeningHours: vi.fn(), generateInventory: vi.fn(), saveScopedInventoryAllocation: vi.fn() }))

vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-1', accounts: [] }) }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: fixture }))

import { ApiError } from '@/lib/api'
import InventoryV8 from '@/v8/restaurant/inventory/inventory'
vi.mock('@/lib/api/helpers/reservation-board', async importOriginal => { const original = await importOriginal<typeof import('@/lib/api/helpers/reservation-board')>(); return { ...original, reservationBoardApi: { ...original.reservationBoardApi, floors: vi.fn(async () => ({ success: true, data: [] })) } } })
vi.mock('next/navigation',async()=> (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/components/shell/page-chrome',async()=> (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/lib/staff-role',()=>({useStaffRole:()=> 'owner',canManageRole:()=>true}))
const fetchApi=vi.hoisted(()=>vi.fn())
vi.mock('@/lib/api',async(load)=>({...await load<typeof import('@/lib/api')>(),fetchApi}))

const store = { id: 'store-1', organization_id: 'org-1', name: '渋谷店', code: 'SHIBUYA', area: null, capacity: 26, timezone: 'Asia/Tokyo', status: 'active', line_status: 'connected', google_status: 'unconfigured', line_account_id: 'account-1', line_account_name: '渋谷' }
const tables = [
  { id: 't1', store_id: 'store-1', code: 'T1', label: '2人卓', seat_type: 'table', min_capacity: 1, max_capacity: 2, floor_x: 0, floor_y: 0, join_group: null, is_active: 1 },
  { id: 'pa', store_id: 'store-1', code: '個室A', label: '個室', seat_type: 'private_room', min_capacity: 4, max_capacity: 8, floor_x: 0, floor_y: 1, join_group: null, is_active: 1 },
  { id: 'pb', store_id: 'store-1', code: '個室B', label: '個室', seat_type: 'private_room', min_capacity: 4, max_capacity: 8, floor_x: 1, floor_y: 1, join_group: null, is_active: 0 },
]
const inventory = [
  { version: 1, id: 's1', store_id: 'store-1', starts_at: '2026-10-02T17:00:00+09:00', slot_minutes: 30, total_capacity: 10, ota_capacity: 3, line_capacity: 2, walk_in_capacity: 2, reserved_count: 3 },
  { version: 1, id: 's2', store_id: 'store-1', starts_at: '2026-10-02T19:00:00+09:00', slot_minutes: 30, total_capacity: 10, ota_capacity: 8, line_capacity: 6, walk_in_capacity: 6, reserved_count: 8 },
]
const reservations = [
  { id: 'r1', store_id: 'store-1', store_name: '渋谷店', source: 'line', external_id: null, customer_name: '佐藤', customer_phone: null, line_uid: null, guest_count: 4, starts_at: '2026-10-02T19:00:00+09:00', ends_at: '2026-10-02T21:00:00+09:00', table_id: 'pa', table_label: '個室A', course_id: null, course_name: null, status: 'confirmed', allergy_note: null, note: null, sync_direction: 'inbound_only' },
]
const data = {
  organization: { id: 'org-1', account_id: 'account-1', tenant_id: null, tenant_name: null, name: 'テスト組織', status: 'active' },
  stores: [store], memberships: [], tables, menuItems: [], reservations, reservationTotal: 1, inventory, approvals: [], connectors: [], reviews: [], posts: [], lineFlows: [],
}

beforeEach(() => {
  fetchApi.mockResolvedValue({success:true,data:[{id:'hp',name:'Hot Pepper',receiveMethod:'email_forward',status:'receiving'}]})
  fixture.snapshot.mockResolvedValue({ data })
  fixture.inventoryDay.mockImplementation(async () => {
    const result = await fixture.snapshot()
    return { data: result.data.inventory.map((r: typeof inventory[number]) => {
      const occupied = result.data.reservations.filter((v: typeof reservations[number]) => Date.parse(v.starts_at) < Date.parse(r.starts_at)+1800000 && Date.parse(v.ends_at)>Date.parse(r.starts_at)).map((v: typeof reservations[number])=>v.table_id)
      const occupiedSeats=tables.filter(t=>occupied.includes(t.id)).reduce((a,t)=>a+t.max_capacity,0)
      return {...r,occupied_seats:occupiedSeats,occupiedTableIds:occupied,freeSeats:10-occupiedSeats,allocationSource:'legacy'}
    }), allocation: { standard: { otaCapacity: 3, lineCapacity: 2, walkInCapacity: 2 }, version: 4, day: null, hoursStatus: 'open' } }
  })
  fixture.openingHours.mockResolvedValue({data:{storeId:'store-1',hours:Array.from({length:7},(_,weekday)=>({weekday,periods:[]})),version:1,updatedBy:null,updatedAt:null}})
  fixture.saveOpeningHours.mockResolvedValue({success:true,data:{version:2}})
  fixture.generateInventory.mockResolvedValue({success:true,data:{generated:10}})
  fixture.saveScopedInventoryAllocation.mockResolvedValue({success:true,data:{version:5}})
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

/*
 * ★V8-B 予約枠・在庫（板 `Y8SjT2`・競合 ）の契約。
 * 基本配分・卓の埋まりぐあい・在庫の表・時間帯の個別配分が出て、
 * 操作が今の口へ届くこと、競合の帯が出ることを固定する。
 */
describe('Y8SjT2 予約枠・在庫のV8', () => {
  it('基本配分と在庫の表、稼働中の卓から計算した総席数が出る', async () => {
    render(<InventoryV8 />)
    await screen.findByRole('button', { name: '基本配分をまとめて変更' })
    const board = document.querySelector('[data-design-node="Y8SjT2"]')!
    expect(board.textContent).toContain('1枠の総数 10席')
    expect(board.textContent).toContain('時間帯ごとの在庫')
    expect(board.textContent).toContain('個室A')
    expect(board.textContent).toContain('基本配分をまとめて変更')
  })

  it('行を押すとその時間帯の箱が出て保存が今の口へ届く', async () => {
    render(<InventoryV8 />)
    await screen.findByText('営業日の基本配分')
    fireEvent.click(await screen.findByRole('button', { name: '17:00' }))
    fireEvent.click(screen.getByRole('button', { name: '17:00の配分を変更' }))
    const dialog = screen.getByRole('dialog', { name: '17:00の配分を変更' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'この時間帯だけ保存' }))
    await waitFor(() => expect(fixture.saveScopedInventoryAllocation).toHaveBeenCalledWith(
      'account-1', { storeId: 'store-1', scope: 'slot', startsAt: inventory[0].starts_at, expectedVersion: 4,
        allocation: { otaCapacity: 3, lineCapacity: 2, walkInCapacity: 2 } },
    ))
  })

  it('残りが少ないと閉じる知らせ（Yyw6i）が出る', async () => {
    fixture.snapshot.mockResolvedValue({
      data: {
        ...data,
        reservations: [
          ...reservations,
          { id: 'r2', store_id: 'store-1', store_name: '渋谷店', source: 'walkin', external_id: null, customer_name: '鈴木', customer_phone: null, line_uid: null, guest_count: 6, starts_at: '2026-10-02T19:00:00+09:00', ends_at: '2026-10-02T21:00:00+09:00', table_id: 't1', table_label: 'T1', course_id: null, course_name: null, status: 'confirmed', allergy_note: null, note: null, sync_direction: 'inbound_only' },
        ],
      },
    })
    render(<InventoryV8 />)
    await screen.findByText('営業日の基本配分')
    fireEvent.click(await screen.findByRole('button', { name: '媒体の受付を閉じる' }))
    expect(document.querySelector('[data-design-node="Yyw6i"]')).not.toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: /Hot Pepper .*を閉じた/ }))
    fireEvent.click(screen.getByRole('button', { name: '閉じたものを記録する' }))
    expect(screen.queryByRole('button', { name: '媒体の受付を閉じる' })).toBeNull()
  })

  it('409のとき基本配分の入力を残して最新の配分へ案内する', async () => {
    fixture.saveScopedInventoryAllocation.mockRejectedValueOnce(new ApiError(409, '競合しました', 'version_conflict'))
    render(<InventoryV8 />)
    fireEvent.click(await screen.findByRole('button', { name: '基本配分をまとめて変更' }))
    const dialog = screen.getByRole('dialog', { name: '営業日の基本配分を変更' })
    const ota = within(dialog).getByRole('spinbutton', { name: '予約サイト（グルメサイト）' }) as HTMLInputElement
    fireEvent.change(ota, { target: { value: '2' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '基本配分を保存' }))
    await within(dialog).findByText(/別の変更が保存されました/)
    expect(ota.value).toBe('2')
    expect(within(dialog).getByRole('button', { name: '最新の配分を確認する' })).not.toBeNull()
  })
})

it('営業時間だけを保存し、日ごとの枠作成を別途求めない', async () => {
  fixture.saveOpeningHours.mockImplementation(async()=>{fixture.openingHours.mockResolvedValue({data:{storeId:'store-1',hours:Array.from({length:7},(_,weekday)=>({weekday,periods:[]})),version:2,updatedBy:null,updatedAt:null}});return {success:true,data:{version:2}}})
  render(<InventoryV8 />)
  fireEvent.click(await screen.findByRole('switch', { name: '月曜日に予約を受ける' }))
  fireEvent.click(await screen.findByRole('button', { name: '開ける時間を保存' }))
  await waitFor(()=>expect(fixture.saveOpeningHours).toHaveBeenCalledWith('account-1',expect.objectContaining({expectedVersion:1,hours:expect.any(Array)})))
  expect(fixture.generateInventory).not.toHaveBeenCalled()
  expect(fixture.saveScopedInventoryAllocation).not.toHaveBeenCalled()
})
it('基本配分は設定全体の版を添えて一回で保存する', async () => {
  render(<InventoryV8 />)
  fireEvent.click(await screen.findByRole('button', { name: '基本配分をまとめて変更' }))
  const dialog = screen.getByRole('dialog', { name: '営業日の基本配分を変更' })
  fireEvent.change(within(dialog).getByRole('spinbutton', { name: '予約サイト（グルメサイト）' }), { target: { value: '2' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '基本配分を保存' }))
  await waitFor(() => expect(fixture.saveScopedInventoryAllocation).toHaveBeenCalledExactlyOnceWith('account-1', {
    storeId: 'store-1', scope: 'standard', expectedVersion: 4, allocation: { otaCapacity: 2, lineCapacity: 2, walkInCapacity: 2 },
  }))
})
