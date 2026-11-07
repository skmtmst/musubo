// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 日付の見本を作る前に日本時間で固定し、待ち合わせのタイマーは動かす。
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T12:00:00+09:00'))
})

const fixture = vi.hoisted(() => ({ snapshot: vi.fn(), createTable: vi.fn(), deleteTable: vi.fn(), updateTable: vi.fn(), updateReservation: vi.fn(), saveTableLayout: vi.fn() }))
const role = vi.hoisted(() => ({ value: 'owner' as string | null }))
const floorApi = vi.hoisted(() => ({ floors: vi.fn() }))
const assignmentApi = vi.hoisted(() => ({ getTables: vi.fn(), saveTables: vi.fn() }))
const location = vi.hoisted(() => ({ query: '' }))
const account = vi.hoisted(() => ({ selectedAccountId: 'account-1' }))

vi.mock('next/navigation',()=>({useRouter:()=>({push(){},replace(){},back(){}}),usePathname:()=>'/restaurant-test/tables',useSearchParams:()=>new URLSearchParams(location.query)}))
vi.mock('@/lib/api/helpers/booking-assignment', () => ({ bookingAssignmentApi: assignmentApi }))
vi.mock('@/lib/api/helpers/reservation-board',()=>({reservationBoardApi:floorApi}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: account.selectedAccountId, accounts: [{ id: 'account-1', name: '本店LINE' }, { id: 'account-2', name: '別店LINE' }] }) }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: fixture }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => role.value, canManageRole: (r: string | null) => r === 'owner' || r === 'admin' }))

import TablesPage from './tables'
import { pickMoveTarget } from './move'
import { ApiError } from '@/lib/api/transport/errors'
import { at, reservation, snapshotOf, store, tables } from '../booking-kit/test-data'
import { pickEntity } from '@/components/shared/entity-picker-test-helpers'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'

/* T3 に先の予約が2件：1件目は T4 が空いている、2件目は同じ時間の T4・個室A が埋まっている（4名は入る卓が無い）。 */
const upcoming = [
  reservation('r1', { customer_name: '山田 花子', guest_count: 4, starts_at: at(1, 19), ends_at: at(1, 21), table_id: 't3' }),
  reservation('r2', { customer_name: '田中 明子', guest_count: 4, starts_at: at(2, 19), ends_at: at(2, 21), table_id: 't3' }),
  reservation('r3', { customer_name: '別の人', guest_count: 4, starts_at: at(2, 19), ends_at: at(2, 21), table_id: 't4' }),
  reservation('r4', { customer_name: '団体', guest_count: 6, starts_at: at(2, 18), ends_at: at(2, 22), table_id: 'pa' }),
]

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T12:00:00+09:00'))
  role.value = 'owner'
  account.selectedAccountId = 'account-1'
  location.query = ''
  const assignment = { method: 'balanced', balancePeriod: 'day', resources: [], version: 4, storageReady: true, effectiveMethod: 'balanced' }
  assignmentApi.getTables.mockResolvedValue({ success: true, data: assignment })
  assignmentApi.saveTables.mockImplementation(async (_account, _store, input) => ({ success: true, data: { ...assignment, ...input, version: 5 } }))
  floorApi.floors.mockResolvedValue({ success: true, data: [{id:'floor-store-1',storeId:'store-1',name:'1階',width:500,height:500,version:1,outline:[],fixtures:[],tables:[]}] })
  fixture.snapshot.mockResolvedValue({ data: snapshotOf({ reservations: upcoming }) })
  for (const fn of [fixture.createTable, fixture.deleteTable, fixture.updateTable, fixture.updateReservation, fixture.saveTableLayout]) fn.mockResolvedValue({ success: true })
})
afterEach(() => { cleanup(); clearToastsForTest(); vi.useRealTimers(); vi.clearAllMocks() })

describe('BERxg 座席・卓管理', () => {
  it('割り当ての最終行は本文、保存操作は別の共通下部領域へ置き、版付き保存を保つ', async () => {
    location.query = 'view=assign'
    const { container } = render(<TablesPage />)
    await waitFor(() => expect(screen.getByRole('radio', { name: /ランダム/ }).hasAttribute('disabled')).toBe(false))
    const frame = container.querySelector('[data-design-node="jmVYJ"]')!
    const body = frame.querySelector(':scope > [data-template-region="body"]')!
    const footer = frame.querySelector(':scope > [data-template-region="footer"]')!
    expect(body.querySelectorAll('tbody > tr')).toHaveLength(tables.filter(table => table.is_active).length)
    expect(body.querySelector('[data-shared-part="sticky-bar"]')).toBeNull()
    const save = screen.getByRole('button', { name: /保存する/ }) as HTMLButtonElement
    expect(footer.contains(save)).toBe(true)
    expect(save.disabled).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: /ランダム/ }))
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => expect(assignmentApi.saveTables).toHaveBeenCalledWith('account-1', 'store-1', expect.objectContaining({ method: 'random', expectedVersion: 4 })))
  })

  it('下部領域の分離後も競合時の入力を保持し、閲覧のみでは保存欄を隠す', async () => {
    location.query = 'view=assign'
    assignmentApi.saveTables.mockRejectedValue({ status: 409 })
    const view = render(<TablesPage />)
    await waitFor(() => expect(screen.getByRole('radio', { name: /ランダム/ }).hasAttribute('disabled')).toBe(false))
    fireEvent.click(screen.getByRole('radio', { name: /ランダム/ }))
    fireEvent.click(screen.getByRole('button', { name: /保存する/ }))
    await screen.findByRole('button', { name: '違いを比べる' })
    expect((screen.getByRole('radio', { name: /ランダム/ }) as HTMLInputElement).checked).toBe(true)
    view.unmount()
    role.value = 'staff'
    const readOnly = render(<TablesPage />)
    await screen.findByText('卓の割り当て方')
    expect(readOnly.container.querySelector('[data-template-region="footer"]')).toBeNull()
    expect(screen.queryByRole('button', { name: /保存する/ })).toBeNull()
    expect(screen.queryByRole('radio')).toBeNull()
  })

  it('最小・最大人数は必須として読み上げ、空欄なら卓を作らない', async () => {
    render(<TablesPage />)
    await screen.findByText('卓一覧')
    fireEvent.click(await screen.findByRole('button', { name: /卓を作る/ }))
    for (const label of ['最小人数', '最大人数']) {
      expect(screen.getByLabelText(label).getAttribute('aria-required')).toBe('true')
    }
    fireEvent.change(screen.getByLabelText('卓番'), { target: { value: 'T5' } })
    fireEvent.change(screen.getByLabelText('表示名'), { target: { value: '窓側' } })
    fireEvent.change(screen.getByLabelText('最小人数'), { target: { value: '' } })
    fireEvent.click(within(screen.getByRole('dialog', { name: '卓を作る' })).getByRole('button', { name: /^卓を作る$/ }))
    expect(await screen.findByText('最小人数は1以上の整数にしてください。')).toBeTruthy()
    expect(fixture.createTable).not.toHaveBeenCalled()
  })

  it('Penの数4・フロアマップ・卓一覧を表示し、古いルールカードを残さない', async () => {
    render(<TablesPage />)
    await screen.findByText('卓一覧')
    const board = document.querySelector('[data-design-node="BERxg"]')!
    const icons = document.querySelectorAll('[data-kpi-icon] svg')
    expect(icons).toHaveLength(4)
    for (const icon of icons) expect(icon.classList.contains('lucide-inbox')).toBe(true)
    for (const label of ['卓数', '受付中の卓', '受付中の定員', '個室', '卓一覧']) expect(board.textContent).toContain(label)
    expect(screen.getByRole('button', { name: '卓の表示' }).textContent).toContain('すべて')
    expect(board.textContent).toContain('受付中')
    expect(screen.queryByText('結合のルール')).toBeNull()
    expect(screen.getByText('T3 · 窓側4人卓')).not.toBeNull()
  })

  it('卓の行にはメニュー1個だけを出し、停止の確認を開くまで更新しない', async () => {
    render(<TablesPage />)
    const name = await screen.findByText('T3 · 窓側4人卓')
    const row = name.closest('li')!
    expect(within(row).getAllByRole('button')).toHaveLength(1)
    fireEvent.click(within(row).getByRole('button', { name: 'T3・窓側4人卓のその他操作' }))
    expect(screen.getByRole('menuitem', { name: '変更' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '停止' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: '再開' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: '停止' }))
    expect(fixture.updateTable).not.toHaveBeenCalled()
    expect(fixture.updateReservation).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル', exact: true }))
    expect(fixture.updateTable).not.toHaveBeenCalled()
    expect(fixture.updateReservation).not.toHaveBeenCalled()
  })

  it('卓を名前と復元不可の確認を経て削除する', async () => {
    render(<TablesPage />)
    const row = (await screen.findByText('T3 · 窓側4人卓')).closest('li')!
    fireEvent.click(within(row).getByRole('button', { name: 'T3・窓側4人卓のその他操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '削除' }))
    expect(screen.getByText('T3・窓側4人卓')).toBeTruthy()
    expect(screen.getByText(/元に戻せません/)).toBeTruthy()
    expect(fixture.deleteTable).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '削除する' }))
    await waitFor(() => expect(fixture.deleteTable).toHaveBeenCalledWith('account-1', 't3'))
  })

  it('卓を削除・停止する前に対象アカウントと店舗を確認できる', async () => {
    render(<TablesPage />)
    const row = (await screen.findByText('T3 · 窓側4人卓')).closest('li')!
    fireEvent.click(within(row).getByRole('button', { name: 'T3・窓側4人卓のその他操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '削除' }))
    let dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('本店LINE')
    expect(dialog.textContent).toContain('渋谷店')
    expect(dialog.textContent).toContain('環境')
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    fireEvent.click(within(row).getByRole('button', { name: 'T3・窓側4人卓のその他操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '停止' }))
    dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('本店LINE')
    expect(dialog.textContent).toContain('渋谷店')
    expect(dialog.textContent).toContain('環境')
  })

  it.each(['削除', '停止'])('アカウントを切り替えて戻した後は卓の%sを確定できない', async (mode) => {
    const view = render(<TablesPage />)
    const row = (await screen.findByText('T3 · 窓側4人卓')).closest('li')!
    fireEvent.click(within(row).getByRole('button', { name: 'T3・窓側4人卓のその他操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: mode }))
    const dialog = screen.getByRole('dialog')
    const button = within(dialog).getByRole('button', { name: mode === '削除' ? '削除する' : '予約を移して止める' })
    const key = Object.keys(button).find(name => name.startsWith('__reactProps$'))!
    const oldClick = (button as unknown as Record<string, { onClick: () => void }>)[key].onClick
    account.selectedAccountId = 'account-2'
    await act(async () => { view.rerender(<TablesPage />) })
    account.selectedAccountId = 'account-1'
    await act(async () => { view.rerender(<TablesPage />) })
    await act(async () => { oldClick() })
    expect(fixture.deleteTable).not.toHaveBeenCalled()
    expect(fixture.updateTable).not.toHaveBeenCalled()
    expect(fixture.updateReservation).not.toHaveBeenCalled()
  })

  it('アカウント切替後の読み込み中は前の一覧から卓を削除できない', async () => {
    const view = render(<TablesPage />)
    const row = (await screen.findByText('T3 · 窓側4人卓')).closest('li')!
    fixture.snapshot.mockImplementationOnce(() => new Promise(() => {}))
    account.selectedAccountId = 'account-2'
    await act(async () => { view.rerender(<TablesPage />) })
    const menu = within(row).getByRole('button', { name: 'T3・窓側4人卓のその他操作' }) as HTMLButtonElement
    fireEvent.click(menu)
    const remove = screen.getByRole('menuitem', { name: '削除' })
    expect(remove.getAttribute('aria-disabled')).toBe('true')
    expect(document.getElementById(remove.getAttribute('aria-describedby')!)?.textContent).toContain('選んだアカウント')
    fireEvent.click(remove)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(fixture.deleteTable).not.toHaveBeenCalled()
  })

  it.each(['削除', '停止'])('卓の%sの窓の再表示では別の確定口を受け付けない', async (mode) => {
    render(<TablesPage />)
    const row = (await screen.findByText('T3 · 窓側4人卓')).closest('li')!
    const open = () => { fireEvent.click(within(row).getByRole('button', { name: 'T3・窓側4人卓のその他操作' })); fireEvent.click(screen.getByRole('menuitem', { name: mode })) }
    open()
    const dialog = screen.getByRole('dialog')
    const button = within(dialog).getByRole('button', { name: mode === '削除' ? '削除する' : '予約を移して止める' })
    const key = Object.keys(button).find(name => name.startsWith('__reactProps$'))!
    const oldClick = (button as unknown as Record<string, { onClick: () => void }>)[key].onClick
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    open()
    await act(async () => { oldClick() })
    expect(fixture.deleteTable).not.toHaveBeenCalled()
    expect(fixture.updateTable).not.toHaveBeenCalled()
    expect(fixture.updateReservation).not.toHaveBeenCalled()
  })

  it.each(['削除', '停止'])('画面終了後は卓の%sを確定できない', async (mode) => {
    const view = render(<TablesPage />)
    const row = (await screen.findByText('T3 · 窓側4人卓')).closest('li')!
    fireEvent.click(within(row).getByRole('button', { name: 'T3・窓側4人卓のその他操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: mode }))
    const button = within(screen.getByRole('dialog')).getByRole('button', { name: mode === '削除' ? '削除する' : '予約を移して止める' })
    const key = Object.keys(button).find(name => name.startsWith('__reactProps$'))!
    const oldClick = (button as unknown as Record<string, { onClick: () => void }>)[key].onClick
    view.unmount()
    await act(async () => { oldClick() })
    expect(fixture.deleteTable).not.toHaveBeenCalled()
    expect(fixture.updateTable).not.toHaveBeenCalled()
    expect(fixture.updateReservation).not.toHaveBeenCalled()
  })

  it('参照中の卓は確認窓に理由を出して残す', async () => {
    fixture.deleteTable.mockRejectedValueOnce(new ApiError(409, '予約で使われている卓は削除できません。停止してください', 'resource_in_use'))
    render(<TablesPage />)
    const row = (await screen.findByText('T3 · 窓側4人卓')).closest('li')!
    fireEvent.click(within(row).getByRole('button', { name: 'T3・窓側4人卓のその他操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '削除' }))
    fireEvent.click(screen.getByRole('button', { name: '削除する' }))
    expect(await screen.findByText(/予約で使われている卓は削除できません/)).toBeTruthy()
    expect(screen.getByText('T3・窓側4人卓')).toBeTruthy()
  })

  it('止めるときは先の予約を出し、入る卓へ移し、入らない予約は未配席にしてから止める', async () => {
    render(<TablesPage />)
    await screen.findByText('卓一覧')
    fireEvent.click(screen.getByRole('button', { name: 'T3・窓側4人卓のその他操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '停止' }))
    const dialog = document.querySelector('[data-design-node="eY9F3"]') as HTMLElement
    expect(dialog.textContent).toContain('これから先の予約が 2 件')
    fireEvent.click(within(dialog).getByRole('button', { name: '予約を移して止める' }))
    await waitFor(() => expect(fixture.updateTable).toHaveBeenCalledWith('account-1', 't3', { isActive: false }))
    expect(fixture.updateReservation).toHaveBeenNthCalledWith(1, 'account-1', 'r1', { tableId: 't4', expectedVersion: 1 })
    expect(fixture.updateReservation).toHaveBeenNthCalledWith(2, 'account-1', 'r2', { tableId: null, expectedVersion: 1 })
  })

  it('予約の移動中にアカウントが切り替わったら次の変更を送らない', async () => {
    let finish!: (value: unknown) => void
    fixture.updateReservation.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const view = render(<><ToastHost /><TablesPage /></>)
    await screen.findByText('卓一覧')
    fireEvent.click(screen.getByRole('button', { name: 'T3・窓側4人卓のその他操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '停止' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '予約を移して止める' }))
    await waitFor(() => expect(fixture.updateReservation).toHaveBeenCalledTimes(1))
    account.selectedAccountId = 'account-2'
    await act(async () => { view.rerender(<><ToastHost /><TablesPage /></>) })
    await act(async () => { finish({ success: true }); await Promise.resolve() })
    expect(fixture.updateReservation).toHaveBeenCalledTimes(1)
    expect(fixture.updateTable).not.toHaveBeenCalled()
    expect(await screen.findByText(/1件の変更を確認/)).toBeTruthy()
  })

  it('途中で移動に失敗したら確認できた件数と再確認の必要を表示する', async () => {
    fixture.updateReservation.mockResolvedValueOnce({ success: true }).mockRejectedValueOnce(new Error('network'))
    render(<TablesPage />)
    await screen.findByText('卓一覧')
    fireEvent.click(screen.getByRole('button', { name: 'T3・窓側4人卓のその他操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '停止' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '予約を移して止める' }))
    expect(await screen.findByText(/1件の変更を確認/)).toBeTruthy()
    expect(screen.getByRole('dialog').textContent).toContain('結果を確認')
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'キャンセル' }).closest('[data-dialog-actions]')).not.toBeNull()
    expect(fixture.updateTable).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '予約を移して止める' }))
    expect(fixture.updateReservation).toHaveBeenCalledTimes(2)
  })

  it('卓の停止結果が不明なら予約の変更件数と確認先を表示する', async () => {
    fixture.updateTable.mockRejectedValueOnce(new Error('network'))
    render(<TablesPage />)
    await screen.findByText('卓一覧')
    fireEvent.click(screen.getByRole('button', { name: 'T3・窓側4人卓のその他操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '停止' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '予約を移して止める' }))
    expect(await screen.findByText(/2件の変更を確認/)).toBeTruthy()
    expect(screen.getByRole('dialog').textContent).toContain('通信中の変更は結果を確認できません')
    expect(screen.getByRole('dialog').textContent).toContain('予約台帳と卓の状態を確認')
  })

  it('卓を作るは窓（ljShF）から createTable へ送る', async () => {
    render(<TablesPage />)
    await screen.findByText('卓一覧')
    fireEvent.click(await screen.findByRole('button', { name: /卓を作る/ }))
    expect(document.querySelector('[data-design-node="ljShF"]')).not.toBeNull()
    fireEvent.change(screen.getByLabelText('卓番'), { target: { value: 'T5' } })
    fireEvent.change(screen.getByLabelText('表示名'), { target: { value: '窓側2人卓' } })
    fireEvent.click(within(screen.getByRole('dialog', { name: '卓を作る' })).getByRole('button', { name: /^卓を作る$/ }))
    await waitFor(() => expect(fixture.createTable).toHaveBeenCalledWith('account-1', expect.objectContaining({ storeId: 'store-1', code: 'T5', label: '窓側2人卓', minCapacity: 1, maxCapacity: 2 })))
  })

  it('店舗の窓は確定してから切り替え、選んだ店舗で卓を作る', async () => {
    fixture.snapshot.mockResolvedValue({ data: snapshotOf({ stores: [store, { ...store, id: 'store-2', name: '新宿店' }] }) })
    render(<TablesPage />)
    await screen.findByText('卓一覧')
    fireEvent.click(screen.getByRole('button', { name: '店舗' }))
    const picker = screen.getByRole('dialog', { name: '店舗を選ぶ' })
    fireEvent.click(within(picker).getByRole('radio', { name: '新宿店' }))
    fireEvent.click(within(picker).getByRole('button', { name: 'キャンセル' }))
    expect(screen.getByRole('button', { name: '店舗' }).parentElement?.textContent).toContain('渋谷店')
    await pickEntity('店舗', '新宿店')
    fireEvent.click(await screen.findByRole('button', { name: /卓を作る/ }))
    fireEvent.change(screen.getByLabelText('卓番'), { target: { value: 'S1' } })
    fireEvent.change(screen.getByLabelText('表示名'), { target: { value: '新宿2人卓' } })
    fireEvent.click(within(screen.getByRole('dialog', { name: '卓を作る' })).getByRole('button', { name: /^卓を作る$/ }))
    await waitFor(() => expect(fixture.createTable).toHaveBeenCalledWith('account-1', expect.objectContaining({ storeId: 'store-2', code: 'S1' })))
  })

  it('階・エリアの窓で選んだ階とその版を卓の保存へ渡す', async () => {
    const floor = { storeId: 'store-1', width: 560, height: 320, outline: [], fixtures: [], tables: [] }
    floorApi.floors.mockResolvedValue({ success: true, data: [
      { ...floor, id: 'floor-1', name: '1階', version: 1 },
      { ...floor, id: 'floor-2', name: '2階', version: 7 },
    ] })
    render(<TablesPage />)
    await screen.findByRole('group', { name: '1階の座席表' })
    fireEvent.click(await screen.findByRole('button', { name: /卓を作る/ }))
    fireEvent.change(screen.getByLabelText('卓番'), { target: { value: 'T5' } })
    fireEvent.change(screen.getByLabelText('表示名'), { target: { value: '2階2人卓' } })
    fireEvent.click(within(screen.getByRole('dialog', { name: '卓を作る' })).getByRole('button', { name: '階・エリア' }))
    const floorPicker = screen.getByRole('dialog', { name: '階・エリアを選ぶ' })
    fireEvent.click(within(floorPicker).getByRole('radio', { name: '2階' }))
    fireEvent.click(within(floorPicker).getByRole('button', { name: '選ぶ' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '卓を作る' })).getByRole('button', { name: /^卓を作る$/ }))
    await waitFor(() => expect(fixture.createTable).toHaveBeenCalledWith('account-1', expect.objectContaining({ floorId: 'floor-2', expectedTargetVersion: 7 })))
    expect(fixture.createTable.mock.calls[0][1]).toMatchObject({floorX:30,floorY:168,width:80,height:80})
  })

  it('作成する数を増やすと卓番と名前を分けて重ならない位置へ作る',async()=>{
    render(<TablesPage />)
    await screen.findByRole('button',{name:'卓を作る'})
    fireEvent.click(screen.getByRole('button',{name:'卓を作る'}))
    fireEvent.change(screen.getByLabelText('卓番'),{target:{value:'T5'}})
    fireEvent.change(screen.getByLabelText('表示名'),{target:{value:'テーブル5'}})
    fireEvent.click(screen.getByRole('button',{name:'作成する数を増やす'}))
    fireEvent.click(screen.getByRole('button',{name:'作成する数を増やす'}))
    fireEvent.click(within(screen.getByRole('dialog',{name:'卓を作る'})).getByRole('button',{name:'3卓を作る'}))
    await waitFor(()=>expect(fixture.createTable).toHaveBeenCalledTimes(3))
    const created=fixture.createTable.mock.calls.map(call=>call[1])
    expect(created.map(item=>item.code)).toEqual(['T5','T5-2','T5-3'])
    expect(created.map(item=>item.label)).toEqual(['テーブル5','テーブル6','テーブル7'])
    expect(new Set(created.map(item=>`${item.floorX},${item.floorY}`)).size).toBe(3)
  })

  it('空の卓番で保存すると欄に理由を出して移動し、APIへ送らない', async () => {
    render(<TablesPage />)
    await screen.findByText('卓一覧')
    fireEvent.click(await screen.findByRole('button', { name: /卓を作る/ }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '卓を作る' })).getByRole('button', { name: /^卓を作る$/ }))
    const code = screen.getByLabelText('卓番')
    await waitFor(() => expect(document.activeElement).toBe(code))
    expect(code.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('卓番を入れてください。')).not.toBeNull()
    expect(fixture.createTable).not.toHaveBeenCalled()
    expect(screen.queryByText('卓を作りました。')).toBeNull()
  })

  it('予約の移動で失敗したときは卓を止めず、確認窓を残す', async () => {
    fixture.updateReservation.mockRejectedValueOnce(new Error('予約を移せませんでした。'))
    render(<TablesPage />)
    await screen.findByText('卓一覧')
    fireEvent.click(screen.getByRole('button', { name: 'T3・窓側4人卓のその他操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '停止' }))
    fireEvent.click(screen.getByRole('button', { name: '予約を移して止める' }))
    await screen.findByText('予約の移動・卓の停止を完了できませんでした。予約台帳と卓の状態を確認してください。')
    expect(fixture.updateTable).not.toHaveBeenCalled()
    expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toContain('予約の移動・卓の停止を完了できませんでした。予約台帳と卓の状態を確認してください。')
    expect(document.querySelector('[data-design-node="eY9F3"]')).not.toBeNull()
  })

  it('閲覧のみ（staff）には追加・変更・停止を置かない', async () => {
    role.value = 'staff'
    render(<TablesPage />)
    await screen.findByText('卓一覧')
    expect(screen.queryByRole('button', { name: /卓を作る/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /のその他操作$/ })).toBeNull()
  })

  it('移す先は人数が入り重ならない卓のうち、余る席がいちばん少ない卓', () => {
    const r = reservation('x', { guest_count: 2, starts_at: at(1, 18), ends_at: at(1, 20), table_id: 't3' })
    expect(pickMoveTarget(r, tables.filter((t) => t.id !== 't3'), [])?.id).toBe('t1')
    expect(pickMoveTarget(r, tables.filter((t) => t.id !== 't3'), [reservation('y', { table_id: 't1', starts_at: at(1, 19), ends_at: at(1, 21) })])?.id).toBe('t2')
  })

  it('86: 2店以上の時は［店舗：…］の選ぶ欄を出し、下線のタブは出さない', async () => {
    fixture.snapshot.mockResolvedValue({ data: snapshotOf({ reservations: upcoming, stores: [{ ...store, id: 'store-2', name: '新宿店' }, store] }) })
    render(<TablesPage />)
    await screen.findByText('卓一覧')
    expect(screen.getByRole('button', { name: '店舗' })).toBeTruthy()
    expect(screen.queryByRole('tablist', { name: '店舗で絞り込む' })).toBeNull()
  })

  it('86: 店が1つしか無い時は選ぶ欄を出さない', async () => {
    render(<TablesPage />)
    await screen.findByText('卓一覧')
    expect(screen.queryByRole('button', { name: /^店舗/ })).toBeNull()
    expect(screen.queryByRole('tablist', { name: '店舗で絞り込む' })).toBeNull()
  })
})


it('共通タブを外し、tablesの画面内操作を保つ', async () => {
  render(<TablesPage />)
  await screen.findByText('卓一覧')
  expect(screen.queryByRole('tablist', {name:'店の中の画面'})).toBeNull()
})

it('長方形は縦長を選べ、最大人数に合わせる椅子のプレビューを示す',async()=>{
 render(<TablesPage />);await screen.findByText('卓一覧')
 fireEvent.click(await screen.findByRole('button',{name:/卓を作る/}))
 const dialog=screen.getByRole('dialog',{name:'卓を作る'})
 fireEvent.change(within(dialog).getByLabelText('卓番'),{target:{value:'T9'}})
 fireEvent.change(within(dialog).getByLabelText('表示名'),{target:{value:'新しい卓'}})
 fireEvent.change(within(dialog).getByLabelText('最大人数'),{target:{value:'6'}})
 fireEvent.click(within(dialog).getByRole('button',{name:'長方形'}))
 fireEvent.click(within(dialog).getByRole('button',{name:'縦長'}))
 expect(dialog.textContent).toContain('椅子6席を自動配置')
 fireEvent.click(within(dialog).getByRole('button',{name:'卓を作る'}))
 await waitFor(()=>expect(fixture.createTable).toHaveBeenCalledWith('account-1',expect.objectContaining({shape:'long',width:64,height:120,maxCapacity:6})))
})

it('卓を作るには古い位置入力とつまんで置くを出さない',async()=>{
 render(<TablesPage />);await screen.findByText('卓一覧')
 fireEvent.click(await screen.findByRole('button',{name:/卓を作る/}))
 const dialog=screen.getByRole('dialog',{name:'卓を作る'})
 expect(within(dialog).queryByLabelText('横の位置')).toBeNull()
 expect(within(dialog).queryByLabelText('縦の位置')).toBeNull()
 expect(within(dialog).queryByText('長い卓')).toBeNull()
})

describe('卓の停止で移す予約と残す来店履歴', () => {
  const arrived = () => [
    reservation('arrived', { table_id: 't3', customer_name: '来店済みの履歴', status: 'visited', starts_at: at(0, 10), ends_at: at(0, 14) }),
    reservation('seated', { table_id: 't3', customer_name: '着席済みの履歴', status: 'seated', starts_at: at(0, 10), ends_at: at(0, 14) }),
    reservation('departed', { table_id: 't3', customer_name: '退店済みの履歴', status: 'visited', departed_at: at(0, 11), starts_at: at(0, 10), ends_at: at(0, 14) }),
    reservation('legacy-departed', { table_id: 't3', customer_name: '退店時刻がある履歴', status: 'confirmed', departed_at: at(0, 11), starts_at: at(0, 10), ends_at: at(0, 14) }),
  ]
  const openStop = async () => {
    render(<TablesPage />)
    await screen.findByText('卓一覧')
    fireEvent.click(screen.getByRole('button', { name: 'T3・窓側4人卓のその他操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '停止' }))
    return screen.getByRole('dialog')
  }

  it.each(['move', 'unassign'])('%sでも来店・退店の履歴を動かさず未完了の先の予約だけを送る', async mode => {
    const future = reservation('future', { table_id: 't3', customer_name: 'これからの予約', guest_count: 4, starts_at: at(1, 19), ends_at: at(1, 21), customer_version: 7 })
    fixture.snapshot.mockResolvedValue({ data: snapshotOf({ reservations: [...arrived(), future] }) })
    const dialog = await openStop()
    expect(dialog.textContent).toContain('これから先の予約が 1 件')
    expect(dialog.textContent).toContain('これからの予約')
    for (const item of arrived()) expect(dialog.textContent).not.toContain(item.customer_name)
    if (mode === 'unassign') {
      fireEvent.click(within(dialog).getByRole('button', { name: 'この予約をどうしますか' }))
      fireEvent.click(within(screen.getByRole('option', { name: '未配席に戻す（予約台帳で割り当てる）' })).getByRole('button'))
    }
    fireEvent.click(within(dialog).getByRole('button', { name: mode === 'move' ? '予約を移して止める' : '未配席に戻して止める' }))
    await waitFor(() => expect(fixture.updateTable).toHaveBeenCalledWith('account-1', 't3', { isActive: false }))
    expect(fixture.updateReservation).toHaveBeenCalledExactlyOnceWith('account-1', 'future', { tableId: mode === 'move' ? 't4' : null, expectedVersion: 7 })
    expect(fixture.updateReservation.mock.invocationCallOrder[0]).toBeLessThan(fixture.updateTable.mock.invocationCallOrder[0])
  })

  it('履歴と終了済みの予約だけなら移動も未配席更新もせず卓だけを止める', async () => {
    const inactive = ['cancelled', 'no_show', 'completed'].map(status => reservation(status, { table_id: 't3', status, starts_at: at(0, 10), ends_at: at(0, 14) }))
    const ended = reservation('ended', { table_id: 't3', status: 'confirmed', starts_at: at(0, 10), ends_at: at(0, 12) })
    fixture.snapshot.mockResolvedValue({ data: snapshotOf({ reservations: [...arrived(), ...inactive, ended] }) })
    const dialog = await openStop()
    expect(dialog.textContent).toContain('これから先の予約はありません')
    expect(within(dialog).queryByRole('button', { name: 'この予約をどうしますか' })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: '止める', exact: true }))
    await waitFor(() => expect(fixture.updateTable).toHaveBeenCalledWith('account-1', 't3', { isActive: false }))
    expect(fixture.updateReservation).not.toHaveBeenCalled()
  })

  it('結合予約の2卓目で停止しても未完了の予約を残し、窓のキャンセルでは送らない', async () => {
    const joined = reservation('joined', { table_id: 't4', table_ids_json: JSON.stringify(['t4', 't3']), customer_name: '結合卓の先の予約', starts_at: at(1, 19), ends_at: at(1, 21) })
    fixture.snapshot.mockResolvedValue({ data: snapshotOf({ reservations: [...arrived(), joined] }) })
    const dialog = await openStop()
    expect(dialog.textContent).toContain('これから先の予約が 1 件')
    expect(dialog.textContent).toContain('結合卓の先の予約')
    expect(dialog.textContent).not.toContain('退店済みの履歴')
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル', exact: true }))
    expect(fixture.updateReservation).not.toHaveBeenCalled()
    expect(fixture.updateTable).not.toHaveBeenCalled()
  })
})

it.each([400, 409, 500])('卓の追加が%sで失敗したら窓の中に理由を出し、入力を残したまま再試行できる', async (status) => {
  fixture.createTable.mockRejectedValueOnce(new ApiError(status)).mockResolvedValueOnce({ success: true })
  render(<TablesPage />)
  fireEvent.click(await screen.findByRole('button', { name: /卓を作る/ }))
  const dialog = document.querySelector('[data-design-node="ljShF"]') as HTMLElement
  fireEvent.change(within(dialog).getByLabelText('卓番'), { target: { value: 'K1' } })
  fireEvent.change(within(dialog).getByLabelText('表示名'), { target: { value: '試験卓' } })
  fireEvent.click(within(dialog).getByRole('button', { name: /^卓を作る$/ }))
  await waitFor(() => expect(within(dialog).getByRole('alert').textContent?.trim()).toBeTruthy())
  expect((within(dialog).getByLabelText('卓番') as HTMLInputElement).value).toBe('K1')
  expect((within(dialog).getByLabelText('表示名') as HTMLInputElement).value).toBe('試験卓')
  fireEvent.click(within(dialog).getByRole('button', { name: /^卓を作る$/ }))
  await waitFor(() => expect(document.querySelector('[data-design-node="ljShF"]')).toBeNull())
  expect(fixture.createTable).toHaveBeenCalledTimes(2)
})

it('停止中の卓は総席数と結合可能な組に含めない', async () => {
  fixture.snapshot.mockResolvedValue({ data: snapshotOf({ tables: tables.map(table => ({ ...table, is_active: 0 })) }) })
  render(<TablesPage />)
  await screen.findByText('卓一覧')
  const value = (label: string) => document.querySelector(`[data-kpi-label][title="${label}"]`)?.closest('[data-kpi-presentation]')?.querySelector('[data-kpi-number]')?.textContent
  expect(value('受付中の定員')).toBe('0')
  expect(value('受付中の卓')).toBe('0')
})

it('稼働中の卓だけを総席数に数える', async () => {
  fixture.snapshot.mockResolvedValue({ data: snapshotOf({ tables }) })
  render(<TablesPage />)
  await screen.findByText('卓一覧')
  const value = document.querySelector('[data-kpi-label][title="受付中の定員"]')?.closest('[data-kpi-presentation]')?.querySelector('[data-kpi-number]')?.textContent
  expect(value).toBe('20')
})

it('最新Penでは旧自動配席の説明カードを表示しない', async () => {
  render(<TablesPage />)
  await screen.findByText('卓一覧')
  expect(screen.queryByText('自動配席ルール')).toBeNull()
  expect(screen.queryByText(/直接来店も同じ候補を使います/)).toBeNull()
})
