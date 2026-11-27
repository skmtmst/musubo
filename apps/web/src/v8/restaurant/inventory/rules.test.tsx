// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import RulesBoard from './rules'

const api = vi.hoisted(() => ({ inventoryRules: vi.fn(), inventoryRuleState: vi.fn(), saveInventoryRules: vi.fn() }))
const role = vi.hoisted(() => ({ value: 'owner' as string | null }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => role.value }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: api }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
const initial = { storeId: 'store', threshold: 2, stopLine: false, stopSameDay: false, notify: true, version: 0 }
const emptyState = { stopped: [], stoppedTotal: 0, history: [], historyTotal: 0 }
const props = { accountId: 'account', storeId: 'store', today: '2026-11-01', timezone: 'Asia/Tokyo', canEdit: true }
const threshold = () => screen.getByRole('spinbutton', { name: '残り席がこの数以下で止める' }) as HTMLInputElement
async function edit() {
  await screen.findByRole('spinbutton')
  fireEvent.change(threshold(), { target: { value: '4' } })
  fireEvent.click(screen.getByRole('switch', { name: 'LINEの受付を自動で止める' }))
}
async function confirmSave() {
  fireEvent.click(screen.getByRole('button', { name: 'ルールを保存する' }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: '保存する' }))
}
it('保存確認で対象のアカウント・店舗・環境を示す', async () => {
  render(<RulesBoard {...props} />); await edit()
  fireEvent.click(screen.getByRole('button', { name: 'ルールを保存する' }))
  const dialog = await screen.findByRole('dialog', { name: '自動調整のルールを保存しますか？' })
  expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
  expect(within(dialog).getByText('店舗')).toBeTruthy()
  expect(within(dialog).getByText('環境')).toBeTruthy()
})
beforeEach(() => {
  role.value = verifiedStaffRole('owner')
  api.inventoryRules.mockResolvedValue({ data: initial })
  api.inventoryRuleState.mockResolvedValue({ data: initial, state: emptyState })
  api.saveInventoryRules.mockResolvedValue({ data: { ...initial, threshold: 4, stopLine: true, version: 1 } })
})
afterEach(() => { cleanup(); vi.resetAllMocks() })

it('変更前は保存できない理由を表示し、変更後は確認に進める', async () => {
  render(<RulesBoard {...props} />)
  await screen.findByRole('spinbutton')
  expect(screen.getByText('変更すると保存できます。')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'ルールを保存する' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(threshold(), { target: { value: '4' } })
  expect(screen.queryByText('変更すると保存できます。')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'ルールを保存する' }))
  expect(await screen.findByRole('dialog', { name: '自動調整のルールを保存しますか？' })).toBeTruthy()
})

it('未設定の両停止はオフのまま読み、保存前に確認し、読み込んだ版で一度だけ保存する', async () => {
  render(<RulesBoard {...props} />)
  await screen.findByRole('spinbutton')
  expect(screen.getByRole('switch', { name: 'LINEの受付を自動で止める' }).getAttribute('aria-checked')).toBe('false')
  expect(screen.getByRole('switch', { name: '当日受付を自動で止める' }).getAttribute('aria-checked')).toBe('false')
  expect(api.saveInventoryRules).not.toHaveBeenCalled()
  await edit()
  fireEvent.click(screen.getByRole('button', { name: 'ルールを保存する' }))
  expect(api.saveInventoryRules).not.toHaveBeenCalled()
  const confirm = within(await screen.findByRole('dialog')).getByRole('button', { name: '保存する' })
  fireEvent.click(confirm); fireEvent.click(confirm)
  await waitFor(() => expect(api.saveInventoryRules).toHaveBeenCalledTimes(1))
  expect(api.saveInventoryRules).toHaveBeenCalledWith('account', { storeId: 'store', threshold: 4, stopLine: true, stopSameDay: false, notify: true, expectedVersion: 0 })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  fireEvent.change(threshold(), { target: { value: '5' } })
  await confirmSave()
  expect(api.saveInventoryRules).toHaveBeenLastCalledWith('account', expect.objectContaining({ expectedVersion: 1 }))
})
it('閲覧のみは状態を読み、保存ボタンを理由付きで残して送信しない', async () => {
  role.value = verifiedStaffRole('viewer')
  api.inventoryRules.mockResolvedValue({ data: { ...initial, stopLine: true } })
  render(<RulesBoard {...props} canEdit={false} />)
  await screen.findByText('2席')
  expect(screen.getAllByText('有効')).toHaveLength(2)
  expect(screen.getByText(/閲覧のみで見ています/)).toBeTruthy()
  expect(screen.queryByRole('switch')).toBeNull()
  expect(screen.queryByRole('spinbutton')).toBeNull()
  const save = screen.getByRole('button', { name: 'ルールを保存する' }) as HTMLButtonElement
  expect(save.getAttribute('aria-disabled')).toBe('true')
  expect(save.disabled).toBe(false)
  expect(save.tabIndex).toBe(0)
  fireEvent.click(save)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(api.saveInventoryRules).not.toHaveBeenCalled()
})
it('本人未確認のルールは権限の帯を出さず、保存も始めない', async () => {
  role.value = verifiedStaffRole(null)
  render(<RulesBoard {...props} canEdit={false} />)
  await screen.findByText('停止中の枠・戻った記録')
  expect(document.querySelector('[data-read-only-notice]')).toBeNull()
  const save = screen.getByRole('button', { name: 'ルールを保存する' }) as HTMLButtonElement
  expect(save.disabled).toBe(true)
  fireEvent.click(save)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(api.saveInventoryRules).not.toHaveBeenCalled()
})
it('設定の取得失敗をオフと見なさず、再読込してから編集する', async () => {
  api.inventoryRules.mockRejectedValueOnce(new ApiError(503, 'unavailable'))
  render(<RulesBoard {...props} />)
  await screen.findByRole('button', { name: 'もう一度読み込む' })
  expect(screen.queryByRole('switch')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  await screen.findByRole('spinbutton')
  expect(api.saveInventoryRules).not.toHaveBeenCalled()
})
it('保存失敗でも入力を残し、再取得しても失敗理由を消さない', async () => {
  api.saveInventoryRules.mockRejectedValueOnce(new ApiError(503, 'unavailable'))
  render(<RulesBoard {...props} />); await edit(); await confirmSave()
  const failed = screen.getByRole('dialog', { name: '自動調整のルールを保存しますか？' })
  expect(await within(failed).findByRole('alert')).toBeTruthy()
  fireEvent.click(within(failed).getByRole('button', { name: /キャンセル|戻って直す/ }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(threshold().value).toBe('4')
  const alert = screen.getByRole('alert').textContent
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  await waitFor(() => expect(api.inventoryRuleState).toHaveBeenCalledTimes(2))
  expect(screen.getByRole('alert').textContent).toBe(alert)
  expect(threshold().value).toBe('4')
  await confirmSave()
  expect(api.saveInventoryRules).toHaveBeenCalledTimes(2)
})
it('409は下書きを保って最新と比較し、明示した読込でだけ置き換える', async () => {
  api.saveInventoryRules.mockRejectedValueOnce(new ApiError(409, 'conflict'))
  render(<RulesBoard {...props} />); await edit(); await confirmSave()
  await screen.findByText('ほかの担当者が先にルールを保存しました')
  expect(threshold().value).toBe('4')
  api.inventoryRules.mockResolvedValue({ data: { ...initial, threshold: 6, version: 2 } })
  const failed = screen.getByRole('dialog', { name: '自動調整のルールを保存しますか？' })
  expect(within(failed).getByRole('button', { name: 'もう一度' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(within(failed).getByRole('button', { name: 'キャンセル' }))
  fireEvent.click(screen.getByRole('button', { name: '違いを比べる' }))
  const dialog = await screen.findByRole('dialog')
  expect(await within(dialog).findByText(/入力 4席 ／ 最新 6席/)).toBeTruthy()
  expect(threshold().value).toBe('4')
  fireEvent.click(within(dialog).getByRole('button', { name: '最新を読み込んで続ける' }))
  await waitFor(() => expect(threshold().value).toBe('6'))
})
it.each([
  ['threshold', 'spinbutton', '残り席がこの数以下で止める'],
  ['stopLine', 'switch', 'LINEの受付を自動で止める'],
  ['stopSameDay', 'switch', '当日受付を自動で止める'],
  ['notify', 'switch', '担当にLINEで知らせる'],
])('保存時の%sの理由をその欄へ返し、打ち直すと解除して再保存できる', async (key, role, name) => {
  api.saveInventoryRules.mockRejectedValueOnce(new ApiError(422, '入力を確認してください', undefined, undefined, undefined, undefined, { [key]: 'この設定を確認してください' }))
  render(<RulesBoard {...props} />); await edit(); await confirmSave()
  await screen.findByText('この設定を確認してください')
  const failed = screen.getByRole('dialog', { name: '自動調整のルールを保存しますか？' })
  expect(within(failed).getByRole('alert').textContent).toContain('この設定を確認してください')
  const retry = within(failed).getByRole('button', { name: 'もう一度' })
  expect(retry.hasAttribute('disabled')).toBe(true)
  fireEvent.click(retry); expect(api.saveInventoryRules).toHaveBeenCalledTimes(1)
  fireEvent.click(within(failed).getByRole('button', { name: /キャンセル|戻って直す/ }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(threshold().value).toBe('4')
  const control = screen.getByRole(role, { name })
  expect(control.getAttribute('aria-invalid')).toBe('true')
  if (role === 'spinbutton') fireEvent.change(control, { target: { value: '5' } })
  else fireEvent.click(control)
  await waitFor(() => expect(screen.queryByText('この設定を確認してください')).toBeNull())
  await confirmSave()
  await waitFor(() => expect(api.saveInventoryRules).toHaveBeenCalledTimes(2))
})
it('空・小数・上限超えのしきい値を保存しない', async () => {
  render(<RulesBoard {...props} />); await screen.findByRole('spinbutton')
  expect(screen.queryByText('0〜10000')).toBeNull()
  expect(screen.queryByText('0〜10,000 の数で入れてください')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '残り席がこの数以下で止めるの説明' }))
  expect(await screen.findByText('0〜10,000 席の範囲で整数を入れます。')).toBeTruthy()
  for (const value of ['', '1.5', '10001', '-1']) {
    fireEvent.change(threshold(), { target: { value } })
    expect(await screen.findByText('0〜10,000 の数で入れてください')).toBeTruthy()
    expect(threshold().getAttribute('aria-invalid')).toBe('true')
    fireEvent.submit(screen.getByRole('form', { name: '自動で合わせるルール' }))
    expect(api.saveInventoryRules).not.toHaveBeenCalled()
  }
  for (const value of ['0', '10000']) {
    fireEvent.change(threshold(), { target: { value } })
    expect(screen.queryByText('0〜10,000 の数で入れてください')).toBeNull()
    expect(threshold().getAttribute('aria-invalid')).not.toBe('true')
  }
})
it('停止理由・元値・復元の記録を表示し、状態の再取得失敗を0件と表示しない', async () => {
  api.inventoryRuleState.mockResolvedValue({ data: initial, state: {
    stopped: [{ slotId: 'slot', startsAt: '2026-11-01T03:00:00Z', lineOriginal: 2, sameDayOriginal: 1, remainingSeats: 1, threshold: 2 }], stoppedTotal: 1,
    history: [{ id: 1, startsAt: '2026-11-01T03:00:00Z', beforeLine: 0, afterLine: 2, beforeSameDay: 0, afterSameDay: 1, cause: 'reservation', createdAt: '2026-10-20T03:00:00Z' }], historyTotal: 101,
  } })
  render(<RulesBoard {...props} />)
  expect(await screen.findByText('残り1席・基準2席以下')).toBeTruthy()
  expect(screen.getByText('復元')).toBeTruthy()
  expect(screen.getByText('予約の変更')).toBeTruthy()
  expect(screen.getByText('101件（直近1件）')).toBeTruthy()
  api.inventoryRuleState.mockRejectedValueOnce(new ApiError(503, 'unavailable'))
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  await screen.findByText('読み込みに失敗しました。時間をおいて、もう一度お試しください。')
  expect(screen.queryByText('この日に自動停止している枠はありません')).toBeNull()
})
it('入力途中のタブ移動は確認し、取消で下書きを維持する', async () => {
  render(<RulesBoard {...props} />); await edit()
  const { requestUnsavedAction } = await import('@/lib/unsaved-action')
  const leave = vi.fn()
  requestUnsavedAction(leave)
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: '編集を続ける' }))
  expect(leave).not.toHaveBeenCalled()
  expect(threshold().value).toBe('4')
})
it('店舗切替後に届いた前の店舗の設定と停止状態を採用しない', async () => {
  let finishRules!: (value: { data: typeof initial }) => void
  let finishState!: (value: { data: typeof initial; state: typeof emptyState }) => void
  api.inventoryRules.mockReturnValueOnce(new Promise(resolve => { finishRules = resolve }))
  api.inventoryRuleState.mockReturnValueOnce(new Promise(resolve => { finishState = resolve }))
  const view = render(<RulesBoard key="old" {...props} />)
  view.rerender(<RulesBoard key="new" {...props} accountId="new-account" storeId="new-store" />)
  await screen.findByRole('spinbutton')
  await act(async () => {
    finishRules({ data: { ...initial, threshold: 999 } })
    finishState({ data: initial, state: emptyState })
  })
  expect(threshold().value).toBe('2')
  expect(api.inventoryRuleState).toHaveBeenLastCalledWith('new-account', 'new-store', '2026-11-01')
})
it('保存確認中に閲覧のみになったら保存を実行しない', async () => {
  const view = render(<RulesBoard {...props} />); await edit()
  fireEvent.click(screen.getByRole('button', { name: 'ルールを保存する' }))
  await screen.findByRole('dialog')
  view.rerender(<RulesBoard {...props} canEdit={false} />)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('switch')).toBeNull()
  expect(api.saveInventoryRules).not.toHaveBeenCalled()
})

afterEach(() => { verifiedStaffRole(null) })

it('担当通知はオンを保ち、お客さまには届かないことを確かめられる',async()=>{
 render(<RulesBoard {...props}/>);await screen.findByRole('spinbutton')
 expect(screen.getByRole('switch',{name:'担当にLINEで知らせる'}).getAttribute('aria-checked')).toBe('true')
 expect(await screen.findByText(/お客さまには届きません/)).toBeTruthy()
 expect(api.saveInventoryRules).not.toHaveBeenCalled()
})

it('閲覧のみでも担当通知の届け先の説明を出す',async()=>{
 role.value=verifiedStaffRole('viewer')
 render(<RulesBoard {...props} canEdit={false}/>);await screen.findByText('2席')
 expect(screen.getByText('お客さまには届きません。')).toBeTruthy()
 expect(api.saveInventoryRules).not.toHaveBeenCalled()
})
