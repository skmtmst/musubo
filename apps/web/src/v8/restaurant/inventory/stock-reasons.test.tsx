// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { PERMISSION_LOCK_REASON } from '@/components/shared/permission-lock'
import { ApiError } from '@/lib/api'
import { snapshotOf } from '../booking-kit/test-data'
import type { RestaurantV8Context } from '../booking-kit/public/shell'
import StockBoard from './stock'
import InventoryPage from './inventory'

const state = vi.hoisted(() => ({ account: 'account-1', role: 'owner' as string | null }))
const api = vi.hoisted(() => ({ snapshot: vi.fn(), openingHours: vi.fn(), inventoryDay: vi.fn(), saveOpeningHours: vi.fn(), saveInventoryAllocation: vi.fn(), generateInventory: vi.fn(), updateInventory: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push() {}, replace() {}, prefetch() {} }), usePathname: () => '/restaurant-test/inventory', useSearchParams: () => new URLSearchParams() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: state.account, accounts: [] }) }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => state.role, canManageRole: (role: string | null) => role === 'owner' || role === 'admin' }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: api }))
vi.mock('@/lib/api', async (load) => ({ ...(await load<typeof import('@/lib/api')>()), fetchApi: vi.fn(async () => ({ success: true, data: [] })) }))

const missingHours = '開ける時間を設定して保存してください。'
const noTables = '有効な卓がありません。座席・卓管理で卓を有効にしてください。'
const week = () => Array.from({ length: 7 }, (_, weekday) => ({ weekday, periods: [] }))
const hours = (version = 0) => ({ data: { storeId: 'store-1', hours: version ? week() : null, version } })
const pending = <T,>() => { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const allocation = { id: 'slot-1', store_id: 'store-1', starts_at: '2026-11-01T10:00:00Z', slot_minutes: 30, total_capacity: 20, ota_capacity: 1, line_capacity: 0, walk_in_capacity: 0, reserved_count: 0, version: 1 }
function context(stopped = false): RestaurantV8Context {
  const data = snapshotOf()
  if (stopped) data.tables = data.tables.map(table => ({ ...table, is_active: 0 }))
  return { data, store: data.stores[0], selectedStoreId: 'store-1', tableDefinition: { accountId: state.account, snapshot: data }, busy: false, mutate: vi.fn(async (action) => { await action(); return true }), reload: vi.fn(async () => {}) }
}
const draw = (ctx = context()) => <StockBoard ctx={ctx} canEdit={state.role === 'owner' || state.role === 'admin'} tabs={null} />
const generate = () => screen.getByRole('button', { name: 'この日の枠を作る' }) as HTMLButtonElement
beforeEach(() => {
  state.account = 'account-1'; state.role = verifiedStaffRole('owner')
  api.inventoryDay.mockResolvedValue({ data: [] }); api.openingHours.mockResolvedValue(hours())
  api.snapshot.mockResolvedValue({ data: snapshotOf() })
  api.generateInventory.mockResolvedValue({ success: true }); api.saveOpeningHours.mockResolvedValue(hours(1))
  api.saveInventoryAllocation.mockResolvedValue({ success: true })
})
afterEach(() => { cleanup(); vi.resetAllMocks(); verifiedStaffRole(null) })

describe('在庫を直すための案内', () => {
  it('未保存の時間を取得できた時だけ理由と開ける時間への入口を出し、書き込まない', async () => {
    render(draw())
    await screen.findByText(missingHours)
    expect(screen.getAllByText(missingHours)).toHaveLength(1)
    expect(generate().disabled).toBe(true)
    expect(generate().getAttribute('aria-description')).toBe(missingHours)
    expect(screen.getByRole('link', { name: '開ける時間を設定する' }).getAttribute('href')).toBe('#rs-hours-title')
    fireEvent.click(generate())
    expect(api.generateInventory).not.toHaveBeenCalled()
    expect(api.openingHours).toHaveBeenCalledTimes(1)
  })

  it('時間を入力しただけでは未保存の理由を消さず、保存後だけ生成できる', async () => {
    render(draw())
    await screen.findByText(missingHours)
    fireEvent.click(screen.getByRole('switch', { name: '月曜日に予約を受ける' }))
    expect(screen.getAllByText(missingHours)).toHaveLength(1)
    expect(generate().disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /受付時間と配分を保存/ }))
    await waitFor(() => expect(screen.queryByText(missingHours)).toBeNull())
    expect(api.saveOpeningHours).toHaveBeenCalledWith('account-1', expect.objectContaining({ storeId: 'store-1', expectedVersion: 0 }))
    await waitFor(() => expect(generate().disabled).toBe(false))
  })

  it('保存済みで全曜日が休みでも既存の生成可否と送る値を変えない', async () => {
    api.openingHours.mockResolvedValue(hours(3))
    render(draw())
    await screen.findByRole('switch', { name: '月曜日に予約を受ける' })
    expect(generate().disabled).toBe(false)
    expect(screen.queryByText(missingHours)).toBeNull()
    fireEvent.click(generate())
    await waitFor(() => expect(api.generateInventory).toHaveBeenCalledWith('account-1', expect.objectContaining({ storeId: 'store-1', expectedHoursVersion: 3, otaCapacity: 0, lineCapacity: 0, walkInCapacity: 0 })))
  })

  it.each(['pending', 'failed'] as const)('%sの時間を未保存と断定しない', async (mode) => {
    const request = pending<ReturnType<typeof hours>>()
    api.openingHours.mockReturnValue(request.promise)
    render(draw())
    await screen.findByText('この日の時間帯がありません')
    expect(screen.queryByText(missingHours)).toBeNull()
    if (mode === 'failed') {
      await act(async () => request.reject(new Error('fixture failure')))
      await screen.findByText('開ける時間を読み込めませんでした。再読込してください。')
      expect(screen.queryByText(missingHours)).toBeNull()
    }
  })

  it('同じ画面でaccountをA→B→Aに戻しても古いAの成功を使わず、既存の値反映は保つ', async () => {
    const old = pending<ReturnType<typeof hours>>(), current = pending<ReturnType<typeof hours>>()
    api.openingHours.mockReturnValueOnce(old.promise).mockResolvedValueOnce(hours(2)).mockReturnValueOnce(current.promise)
    const ctx = context(); const view = render(draw(ctx))
    await waitFor(() => expect(api.openingHours).toHaveBeenCalledTimes(1))
    state.account = 'account-2'; view.rerender(draw(ctx))
    await waitFor(() => expect(api.openingHours).toHaveBeenCalledTimes(2))
    state.account = 'account-1'; view.rerender(draw(ctx))
    await waitFor(() => expect(api.openingHours).toHaveBeenCalledTimes(3))
    await act(async () => old.resolve(hours()))
    expect(screen.queryByText(missingHours)).toBeNull()
    // 説明だけに判定を足す。旧応答でversion0が入る本線の動きは変えない。
    expect(generate().disabled).toBe(true)
    await act(async () => current.resolve(hours()))
    expect(screen.getAllByText(missingHours)).toHaveLength(1)
  })

  it('店を切り替えた後の古い成功と失敗から理由を出さない', async () => {
    const old = pending<ReturnType<typeof hours>>(), current = pending<ReturnType<typeof hours>>()
    api.openingHours.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const ctx = context(); const view = render(draw(ctx))
    await waitFor(() => expect(api.openingHours).toHaveBeenCalledTimes(1))
    const other = { ...ctx, store: { ...ctx.store!, id: 'store-2' }, selectedStoreId: 'store-2' }
    view.rerender(draw(other))
    await waitFor(() => expect(api.openingHours).toHaveBeenCalledTimes(2))
    await act(async () => old.resolve(hours()))
    expect(screen.queryByText(missingHours)).toBeNull()
    await act(async () => current.reject(new Error('fixture failure')))
    expect(screen.queryByText(missingHours)).toBeNull()
  })

  it('同accountの再取得後に古い成功が戻っても説明を復活させず、既存data反映は変えない', async () => {
    const old = pending<ReturnType<typeof hours>>()
    api.inventoryDay.mockResolvedValue({ data: [allocation] })
    api.openingHours.mockReturnValueOnce(old.promise).mockResolvedValueOnce(hours(2)).mockResolvedValueOnce(hours(2))
    api.saveInventoryAllocation.mockRejectedValueOnce(new ApiError(409, 'fixture conflict'))
    const ctx = context()
    ctx.mutate = vi.fn(async action => { try { await action(); return true } catch { return false } })
    render(draw(ctx))
    await screen.findByText('19:00 の卓')
    fireEvent.change(screen.getByRole('spinbutton', { name: '予約サイト' }), { target: { value: '7' } })
    fireEvent.click(screen.getByRole('button', { name: /受付時間と配分を保存/ }))
    await screen.findByText(/予約枠・在庫を保存しました/)
    fireEvent.click(screen.getByRole('button', { name: '最新を読み込んで続ける' }))
    await waitFor(() => expect(api.openingHours).toHaveBeenCalledTimes(3))
    await act(async () => old.resolve(hours()))
    expect(screen.queryByText(missingHours)).toBeNull()
    expect((screen.getByRole('button', { name: '時間帯ごとの在庫のその他操作' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('要求した店と異なる成功応答を未保存と断定しない', async () => {
    api.openingHours.mockResolvedValue({ data: { ...hours().data, storeId: 'other-store' } })
    render(draw())
    await screen.findByRole('switch', { name: '月曜日に予約を受ける' })
    expect(screen.queryByText(missingHours)).toBeNull()
    expect(generate().disabled).toBe(true)
  })

  it('既存行の生成操作にも理由を出し、元の無効条件で要求を止める', async () => {
    api.inventoryDay.mockResolvedValue({ data: [allocation] })
    render(draw())
    await screen.findByText('19:00 の卓')
    const item = screen.getByRole('button', { name: '時間帯ごとの在庫のその他操作' }) as HTMLButtonElement
    expect(item.disabled).toBe(true)
    expect(item.getAttribute('aria-description')).toBe(missingHours)
    expect(screen.getAllByText(missingHours)).toHaveLength(1)
    fireEvent.click(item)
    expect(api.generateInventory).not.toHaveBeenCalled()
  })

  it('確認できた有効卓0の理由を既存の座席・卓の入口へ添え、総数と保存可否を変えない', async () => {
    api.openingHours.mockResolvedValue(hours(3)); api.inventoryDay.mockResolvedValue({ data: [allocation] })
    render(draw(context(true)))
    await screen.findByText(noTables)
    expect(screen.getAllByText(noTables)).toHaveLength(1)
    expect(screen.getByRole('link', { name: '座席・卓管理で変える →' }).getAttribute('href')).toBe('/restaurant-test/tables')
    expect(screen.getByText('1つの時間帯の総数 0席')).not.toBeNull()
    expect((screen.getByRole('button', { name: /受付時間と配分を保存/ }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('spinbutton', { name: '予約サイト' }) as HTMLInputElement).value).toBe('1')
  })

  it('有効卓が1つ残る時とsnapshotの取得元が未確認の時は卓0と断定しない', async () => {
    const ctx = context(true); ctx.data.tables[0].is_active = 1
    const view = render(draw(ctx)); await screen.findByText('この日の時間帯がありません')
    expect(screen.queryByText(noTables)).toBeNull()
    const stopped = context(true); stopped.tableDefinition = undefined
    view.rerender(draw(stopped))
    expect(screen.queryByText(noTables)).toBeNull()
    stopped.tableDefinition = { accountId: 'account-2', snapshot: stopped.data }; view.rerender(draw(stopped))
    expect(screen.queryByText(noTables)).toBeNull()
    stopped.tableDefinition = { accountId: state.account, snapshot: snapshotOf() }; view.rerender(draw(stopped))
    expect(screen.queryByText(noTables)).toBeNull()
  })

  it('本物の親画面の確認済みsnapshotからも卓0の理由を出す', async () => {
    const ctx = context(true); api.snapshot.mockResolvedValue({ data: ctx.data })
    render(<InventoryPage />)
    await screen.findByText(noTables)
    expect(api.snapshot).toHaveBeenCalledTimes(1)
    expect(api.saveInventoryAllocation).not.toHaveBeenCalled()
    expect(api.generateInventory).not.toHaveBeenCalled()
  })

  it.each(['viewer', null] as const)('%sでは状態理由を重ねず既存の権限表示を保つ', async (value) => {
    state.role = verifiedStaffRole(value)
    render(draw(context(true)))
    await screen.findByText('この日の時間帯がありません')
    await screen.findByRole('switch', { name: '月曜日に予約を受ける' })
    expect(screen.queryByText(missingHours)).toBeNull()
    expect(screen.queryByText(noTables)).toBeNull()
    if (value === 'viewer') expect(generate().getAttribute('data-permission-locked')).toBe('')
    if (value === 'viewer') expect(screen.getAllByText(PERMISSION_LOCK_REASON.viewer).length).toBeGreaterThan(0)
    fireEvent.click(generate())
    expect(api.generateInventory).not.toHaveBeenCalled()
  })
})
