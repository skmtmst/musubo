// @vitest-environment happy-dom
// 時間帯の表示は端末の時計に従う。板どおりの JST で固定する。
process.env.TZ = 'Asia/Tokyo'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ snapshot: vi.fn(), updateInventory: vi.fn(), inventoryDay: vi.fn(), openingHours: vi.fn(), saveOpeningHours: vi.fn(), generateInventory: vi.fn(), saveInventoryAllocation: vi.fn() }))

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
      return {...r,occupied_seats:occupiedSeats,occupiedTableIds:occupied,freeSeats:10-occupiedSeats}
    }) }
  })
  fixture.openingHours.mockResolvedValue({data:{storeId:'store-1',hours:Array.from({length:7},(_,weekday)=>({weekday,periods:[]})),version:1,updatedBy:null,updatedAt:null}})
  fixture.saveOpeningHours.mockResolvedValue({success:true,data:{version:2}})
  fixture.generateInventory.mockResolvedValue({success:true,data:{generated:10}})
  fixture.saveInventoryAllocation.mockResolvedValue({success:true,data:{updated:2}})
  fixture.updateInventory.mockResolvedValue({ success: true })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

/*
 * ★V8-B 予約枠・在庫（板 `Y8SjT2`・競合 ）の契約。
 * 配分・卓の埋まりぐあい・在庫の表・行の箱・固定帯が出て、
 * 操作が今の口へ届くこと、競合の帯が出ることを固定する。
 */
describe('Y8SjT2 予約枠・在庫のV8', () => {
  it('配分と在庫の表・卓・固定帯が出る', async () => {
    render(<InventoryV8 />)
    await screen.findByText('席と枠の配分（卓とつながる）')
    const board = document.querySelector('[data-design-node="Y8SjT2"]')!
    expect(board.textContent).toContain('1つの時間帯の総数 10席')
    expect(board.textContent).toContain('個室B は停止中のため除く')
    expect(board.textContent).toContain('時間帯ごとの在庫')
    expect(board.textContent).toContain('個室A')
    expect(board.textContent).toContain('受付時間と配分を保存')
  })

  it('行を押すとその時間帯の箱が出て保存が今の口へ届く', async () => {
    render(<InventoryV8 />)
    await screen.findByText('席と枠の配分（卓とつながる）')
    fireEvent.click(await screen.findByRole('button', { name: '17:00' }))
    expect(screen.getByText('行を押したとき：17:00 の配分だけ直す')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'この時間帯だけ保存' }))
    await waitFor(() => expect(fixture.updateInventory).toHaveBeenCalledWith('account-1', 's1', expect.objectContaining({ otaCapacity: 3 })))
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
    await screen.findByText('席と枠の配分（卓とつながる）')
    fireEvent.click(await screen.findByRole('button', { name: '媒体の受付を閉じる' }))
    expect(document.querySelector('[data-design-node="Yyw6i"]')).not.toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: /Hot Pepper .*を閉じた/ }))
    fireEvent.click(screen.getByRole('button', { name: '閉じたものを記録する' }))
    expect(screen.queryByRole('button', { name: '媒体の受付を閉じる' })).toBeNull()
  })

  it('競合（409）のとき黄色の帯と比べる窓が出る', async () => {
    fixture.saveInventoryAllocation.mockRejectedValueOnce(new ApiError(409, '競合しました', 'conflict'))
    render(<InventoryV8 />)
    await screen.findByText('席と枠の配分（卓とつながる）')
    fireEvent.change(await screen.findByRole('spinbutton', { name: '予約サイト' }), { target: { value: '2' } })
    await waitFor(()=>expect(screen.getByRole('button',{name:'受付時間と配分を保存'}).hasAttribute('disabled')).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: '受付時間と配分を保存' }))
    expect((await screen.findByRole('alert')).textContent).toContain('予約枠・在庫を保存しました')
    fireEvent.click(screen.getByRole('button', { name: /比べてから保存/ }))
    expect(screen.getByRole('dialog', { name: '保存しようとした内容と最新の内容' })).not.toBeNull()
  })
})

it('週の営業時間を保存し、その版を使って30分刻みの枠を作る', async () => {
  fixture.saveOpeningHours.mockImplementation(async()=>{fixture.openingHours.mockResolvedValue({data:{storeId:'store-1',hours:Array.from({length:7},(_,weekday)=>({weekday,periods:[]})),version:2,updatedBy:null,updatedAt:null}});return {success:true,data:{version:2}}})
  render(<InventoryV8 />)
  fireEvent.click(await screen.findByRole('switch', { name: '月曜日に予約を受ける' }))
  await waitFor(()=>expect(screen.getByRole('button',{name:/受付時間と配分を保存/}).hasAttribute('disabled')).toBe(false))
  fireEvent.click(screen.getByRole('button',{name:/受付時間と配分を保存/}))
  await waitFor(()=>expect(fixture.saveOpeningHours).toHaveBeenCalledWith('account-1',expect.objectContaining({expectedVersion:1,hours:expect.any(Array)})))
  await waitFor(()=>expect(screen.getByRole('button',{name:'時間帯ごとの在庫のその他操作'}).hasAttribute('disabled')).toBe(false))
  fireEvent.click(screen.getByRole('button',{name:'時間帯ごとの在庫のその他操作'}))
  fireEvent.click(screen.getByRole('menuitem',{name:'この日の枠を作る'}))
  await waitFor(()=>expect(fixture.generateInventory).toHaveBeenCalledWith('account-1',expect.objectContaining({expectedHoursVersion:2})))
})
it('全時間帯の配分は各枠の版を添えて一回で保存する', async () => {
  render(<InventoryV8 />)
  await screen.findByRole('button', { name: '19:00' })
  fireEvent.change(await screen.findByRole('spinbutton', { name: '予約サイト' }), { target: { value: '2' } })
  await waitFor(()=>expect(screen.getByRole('button',{name:'受付時間と配分を保存'}).hasAttribute('disabled')).toBe(false))
  fireEvent.click(screen.getByRole('button',{name:'受付時間と配分を保存'}))
  await waitFor(()=>expect(fixture.saveInventoryAllocation).toHaveBeenCalledWith('account-1',expect.objectContaining({slots:[{id:'s1',expectedVersion:1},{id:'s2',expectedVersion:1}]})))
})
