// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'

const api = vi.hoisted(() => ({ snapshot: vi.fn(), createTable: vi.fn(), updateTable: vi.fn(), updateReservation: vi.fn(), saveTableLayout: vi.fn() }))
const role = vi.hoisted(() => ({ value: 'owner' as string | null }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push() {}, replace() {}, back() {} }), usePathname: () => '/restaurant-test/tables', useSearchParams: () => new URLSearchParams() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-1', accounts: [] }) }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: api }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => role.value, canManageRole: (value: string | null) => value === 'owner' || value === 'admin' }))
vi.mock('@/lib/api/helpers/reservation-board', () => ({ reservationBoardApi: { floors: vi.fn().mockResolvedValue({ success: true, data: [{id:'floor-store-1',storeId:'store-1',name:'1階',width:500,height:500,version:1,outline:[],fixtures:[],tables:[]}] }),saveFloor:vi.fn() } }))

import TablesPage from './tables'
import { snapshotOf } from '../booking-kit/test-data'
const minReason = '最小人数は1以上の整数にしてください。'
const maxReason = '最大人数は最小人数以上の整数にしてください。'
const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const submit = () => fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^(卓を作る|変更を保存)$/ }))
const invalid = (label: string) => screen.getByLabelText(label).getAttribute('aria-invalid') === 'true'
async function openNew() {
  render(<TablesPage />)
  await screen.findByText('卓一覧')
  fireEvent.click(await screen.findByRole('button', { name: /卓を作る/ }))
  change('卓番', 'T5'); change('表示名', '窓側')
}
function ApiReasons({ fields }: { fields: Record<string, string> }) {
  const errors = useSaveFormErrors()
  return <SaveErrorScope errors={errors}><button onClick={() => errors.capture({ status: 422, fields })}>APIの理由を受ける</button><TablesPage /></SaveErrorScope>
}
beforeEach(() => {
  role.value = 'owner'
  api.snapshot.mockResolvedValue({ data: snapshotOf() })
  for (const fn of [api.createTable, api.updateTable, api.updateReservation, api.saveTableLayout]) fn.mockResolvedValue({ success: true })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('卓の人数の理由', () => {
  it.each([['最小人数', '1'], ['最大人数', '6']])('%sを直すと表示済みの相関理由を消す', async (label, value) => {
    await openNew(); change('最小人数', '5'); submit()
    expect(screen.queryByText(maxReason)).not.toBeNull(); expect(invalid('最大人数')).toBe(true)
    change(label, value)
    expect(screen.queryByText(maxReason)).toBeNull(); expect(invalid('最大人数')).toBe(false)
    expect(api.createTable).not.toHaveBeenCalled()
  })
  it('最小人数の整数エラーも有効な値に直すと消す', async () => {
    await openNew(); change('最小人数', '0'); submit(); expect(screen.queryByText(minReason)).not.toBeNull()
    change('最小人数', '1'); expect(screen.queryByText(minReason)).toBeNull(); expect(invalid('最小人数')).toBe(false)
  })
  it.each([['最小人数', '3'], ['最大人数', '4']])('%sを直してもまだ大小が逆なら理由を保つ', async (label, value) => {
    await openNew(); change('最小人数', '5'); submit(); change(label, value)
    expect(screen.queryByText(maxReason)).not.toBeNull(); expect(invalid('最大人数')).toBe(true)
    expect(api.createTable).not.toHaveBeenCalled()
  })
  it.each(['', '0', '1.5'])('表示済みの最小人数の理由は不正な値「%s」で残る', async value => {
    await openNew(); change('最小人数', '-1'); submit(); change('最小人数', value)
    expect(screen.queryByText(minReason)).not.toBeNull(); expect(invalid('最小人数')).toBe(true)
    expect(api.createTable).not.toHaveBeenCalled()
  })
  it.each(['', '0', '1.5'])('表示済みの最大人数の理由は不正な値「%s」で残る', async value => {
    await openNew(); change('最大人数', '-1'); submit(); change('最大人数', value)
    expect(screen.queryByText(maxReason)).not.toBeNull(); expect(invalid('最大人数')).toBe(true)
    expect(api.createTable).not.toHaveBeenCalled()
  })
  it('未送信の入力では人数の理由を先出ししない', async () => {
    await openNew(); change('最小人数', '5'); change('最大人数', '0')
    expect(screen.queryByText(minReason)).toBeNull(); expect(screen.queryByText(maxReason)).toBeNull()
    expect(invalid('最小人数')).toBe(false); expect(invalid('最大人数')).toBe(false)
  })
  it('片方だけ理由があるとき変更で別欄の赤を新しく出さない', async () => {
    await openNew(); change('最大人数', '0'); submit(); expect(screen.queryByText(maxReason)).not.toBeNull()
    change('最小人数', '0')
    expect(screen.queryByText(minReason)).toBeNull(); expect(invalid('最小人数')).toBe(false)
    expect(screen.queryByText(maxReason)).not.toBeNull()
  })
  it('人数を直しても卓番と表示名のローカル理由を消さない', async () => {
    await openNew(); change('卓番', ''); change('表示名', ''); change('最小人数', '5'); submit()
    change('最小人数', '1')
    expect(screen.queryByText('卓番を入れてください。')).not.toBeNull(); expect(screen.queryByText('表示名を入れてください。')).not.toBeNull()
    expect(invalid('卓番')).toBe(true); expect(invalid('表示名')).toBe(true)
    expect(api.createTable).not.toHaveBeenCalled()
  })
  it.each([['maxCapacity', '最小人数', '5', maxReason], ['minCapacity', '最大人数', '6', minReason]])('APIの明示した%sの理由は他方の修正で消さない', async (field, label, value, reason) => {
    render(<ApiReasons fields={{ [field]: reason, label: 'APIで表示名を確認してください。' }} />)
    await screen.findByText('卓一覧'); fireEvent.click(await screen.findByRole('button', { name: /卓を作る/ }))
    fireEvent.click(screen.getByText('APIの理由を受ける'))
    expect(screen.queryAllByText(reason)).toHaveLength(1); change(label, value)
    expect(screen.queryAllByText(reason)).toHaveLength(1); expect(screen.getByText('APIで表示名を確認してください。')).toBeTruthy()
    expect(invalid(field === 'maxCapacity' ? '最大人数' : '最小人数')).toBe(true)
  })
  it('修正後の追加は最新の人数と既存の送信項目で1回だけ行う', async () => {
    await openNew(); change('最小人数', '5'); submit(); change('最大人数', '6'); submit()
    await waitFor(() => expect(api.createTable).toHaveBeenCalledTimes(1))
    expect(api.createTable).toHaveBeenCalledWith('account-1', expect.objectContaining({ storeId: 'store-1', floorId: 'floor-store-1', expectedTargetVersion: 1, expectedVersion: 1, code: 'T5', label: '窓側', seatType: 'table', minCapacity: 5, maxCapacity: 6, floorX: 30, floorY: 168, width: 80, height: 80, joinGroup: null, shape: 'rectangle', smokingPolicy: 'non_smoking', shoesAllowed: true, visibleOnMap: true }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
  it('新規を閉じ直すと初期人数と理由なしへ戻る', async () => {
    await openNew(); change('最小人数', '5'); submit()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'キャンセル' }))
    fireEvent.click(screen.getByRole('button', { name: /卓を作る/ }))
    expect(screen.getByLabelText('最小人数')).toHaveProperty('value', '1'); expect(screen.getByLabelText('最大人数')).toHaveProperty('value', '2')
    expect(screen.queryByText(maxReason)).toBeNull(); expect(api.createTable).not.toHaveBeenCalled()
  })
  it('既存の卓も人数修正後に版と配置を保って1回だけ更新する', async () => {
    render(<TablesPage />); await screen.findByText('T3 · 窓側4人卓')
    fireEvent.click(screen.getByRole('button', { name: 'T3・窓側4人卓のその他操作' })); fireEvent.click(screen.getByRole('menuitem', { name: '変更' }))
    change('最小人数', '8'); submit(); expect(screen.queryByText(maxReason)).not.toBeNull(); change('最大人数', '9'); submit()
    await waitFor(() => expect(api.updateTable).toHaveBeenCalledTimes(1))
    expect(api.updateTable).toHaveBeenCalledWith('account-1', 't3', expect.objectContaining({ minCapacity: 8, maxCapacity: 9, code: 'T3', label: '窓側4人卓', expectedVersion: 1, floorX: 2, floorY: 0 }))
    expect(api.createTable).not.toHaveBeenCalled()
  })
  it.each(['staff', null])('権限%sでは作成も変更も行わない', async value => {
    role.value = value; render(<TablesPage />); await screen.findByText('卓一覧')
    const create = screen.queryByRole('button', { name: /卓を作る/ }); if (create) expect(create).toHaveProperty('disabled', true)
    expect(screen.queryByRole('dialog')).toBeNull(); expect(api.createTable).not.toHaveBeenCalled(); expect(api.updateTable).not.toHaveBeenCalled()
  })
})
