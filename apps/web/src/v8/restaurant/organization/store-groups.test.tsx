// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RestaurantStore, RestaurantStoreGroup } from '@/lib/restaurant-test-api'
import { ApiError } from '@/lib/api/transport/errors'

const api = vi.hoisted(() => ({ storeGroups: vi.fn(), updateStoreGroupMember: vi.fn(), saved: vi.fn() }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: api }))
vi.mock('@/components/shared/toast', () => ({ notifySaved: api.saved, notifyToast: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
import StoreGroups from './store-groups'

const stores = [{ id: 'a', name: '試験店A', line_account_id: 'line-a', line_account_name: '本店' }, { id: 'b', name: '試験店B' }] as RestaurantStore[]
const group: RestaurantStoreGroup = { id: 'group', organization_id: 'org', name: '試験の組', members: [
  { group_id: 'group', store_id: 'a', referral_enabled: 0, max_distance: 3, version: 7 },
  { group_id: 'group', store_id: 'b', referral_enabled: 1, max_distance: 8, version: 2 },
] }
beforeEach(() => {
  api.storeGroups.mockResolvedValue({ data: [group] })
  api.updateStoreGroupMember.mockResolvedValue({ data: { updated: true } })
})
afterEach(() => { cleanup(); vi.resetAllMocks() })
const show = () => render(<StoreGroups accountId="account" stores={stores} readOnly={false} />)
async function edit() {
  fireEvent.click(await screen.findByRole('button', { name: '試験店Aの案内設定のその他操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '編集する' }))
  return screen.getByRole('dialog')
}
async function changeAndConfirm() {
  const dialog = await edit()
  fireEvent.click(within(dialog).getByRole('switch'))
  fireEvent.change(within(dialog).getByRole('spinbutton'), { target: { value: '0' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '保存する' }))
  expect(api.updateStoreGroupMember).not.toHaveBeenCalled()
  return screen.getByRole('dialog')
}

it('確認して店舗1件だけ更新し、保存中の二重押しを止めて読み直す', async () => {
  let finish!: (value: unknown) => void
  api.updateStoreGroupMember.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  show()
  const confirm = await changeAndConfirm()
  expect(confirm.textContent).toContain('ほかの店舗の設定は変わりません')
  const save = within(confirm).getByRole('button', { name: '保存する' })
  fireEvent.click(save); fireEvent.click(save)
  expect(api.updateStoreGroupMember).toHaveBeenCalledTimes(1)
  expect(api.updateStoreGroupMember).toHaveBeenCalledWith('account', 'group', 'a', { referralEnabled: true, maxDistance: 0, expectedVersion: 7 })
  expect(within(confirm).getByRole('button', { name: 'キャンセル' }).hasAttribute('disabled')).toBe(true)
  await act(async () => finish({ data: { updated: true } }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(api.storeGroups).toHaveBeenCalledTimes(2)
  expect(api.saved).toHaveBeenCalledWith('試験店Aの案内設定を保存しました。')
  const b = screen.getByText('試験店B').closest('[role="row"]')!
  expect(b.textContent).toContain('8km まで')
})

it('確認窓に変更する店のアカウント・環境を示す', async () => {
  show()
  const confirm = await changeAndConfirm()
  expect(confirm.textContent).toContain('LINEアカウント')
  expect(confirm.textContent).toContain('本店')
  expect(confirm.textContent).toContain('環境')
})

it('版が違えば古い確認で再送せず、読み直せる', async () => {
  api.updateStoreGroupMember.mockRejectedValueOnce(new ApiError(409, 'version_conflict'))
  show()
  const confirm = await changeAndConfirm()
  fireEvent.click(within(confirm).getByRole('button', { name: '保存する' }))
  expect((await within(confirm).findByRole('alert')).textContent).toContain('読み直してから')
  const staleSave = within(confirm).queryByRole('button', { name: '保存する' })
  expect(!staleSave || staleSave.hasAttribute('disabled')).toBe(true)
  fireEvent.click(within(confirm).getByRole('button', { name: '読み直す' }))
  await waitFor(() => expect(api.storeGroups).toHaveBeenCalledTimes(2))
  expect(api.updateStoreGroupMember).toHaveBeenCalledTimes(1)
})

it('アカウントを変更して戻しても古い確認から保存しない', async () => {
  const view = show()
  await changeAndConfirm()
  view.rerender(<StoreGroups accountId="other" stores={stores} readOnly={false} />)
  view.rerender(<StoreGroups accountId="account" stores={stores} readOnly={false} />)
  expect(screen.queryByRole('dialog', { name: '試験店Aの案内設定を変えますか？' })).toBeNull()
  expect(api.updateStoreGroupMember).not.toHaveBeenCalled()
})

it('店舗のLINEアカウントを変更して戻しても古い確認を復活させない', async () => {
  const view = show()
  await changeAndConfirm()
  const changed = [{ ...stores[0], line_account_id: 'line-other' }, stores[1]]
  view.rerender(<StoreGroups accountId="account" stores={changed} readOnly={false} />)
  view.rerender(<StoreGroups accountId="account" stores={stores} readOnly={false} />)
  expect(screen.queryByRole('dialog', { name: '試験店Aの案内設定を変えますか？' })).toBeNull()
  expect(api.updateStoreGroupMember).not.toHaveBeenCalled()
})

it('更新失敗は入力を残し、同じ店舗だけ再試行する', async () => {
  api.updateStoreGroupMember.mockRejectedValueOnce(new Error('failed'))
  show()
  fireEvent.click(within(await changeAndConfirm()).getByRole('button', { name: '保存する' }))
  const failed = await screen.findByRole('dialog')
  expect((await within(failed).findByRole('alert')).textContent).toMatch(/入力は残っています/)
  fireEvent.click(within(failed).getByRole('button', { name: 'キャンセル' }))
  expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('0')
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
  expect(api.saved).not.toHaveBeenCalled()
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '保存する' }))
  const retry = await screen.findByRole('dialog', { name: '試験店Aの案内設定を変えますか？' })
  const retrySave = within(retry).getByRole('button', { name: '保存する' })
  fireEvent.click(retrySave); fireEvent.click(retrySave)
  await waitFor(() => expect(api.updateStoreGroupMember).toHaveBeenCalledTimes(2))
})

it.each(['', '-1', '1001'])('距離%sは保存できず、APIへ送らない', async value => {
  show(); const dialog = await edit()
  fireEvent.change(within(dialog).getByRole('spinbutton'), { target: { value } })
  expect(within(dialog).getByRole('button', { name: '保存する' }).hasAttribute('disabled')).toBe(true)
  expect(within(dialog).getByRole('alert').textContent).toContain('0〜1000')
  expect(api.updateStoreGroupMember).not.toHaveBeenCalled()
})

it('閲覧のみは距離と状態を読み、編集の操作は出さない', async () => {
  render(<StoreGroups accountId="account" stores={stores} readOnly />)
  await screen.findByText('試験店A')
  expect(screen.getByText('3km まで')).toBeTruthy()
  expect(screen.getByText('停止中')).toBeTruthy()
  expect(screen.queryByText('paused')).toBeNull()
  expect(screen.queryByRole('button', { name: /のその他操作/ })).toBeNull()
})

it('取得失敗と空を分け、読み直せる', async () => {
  api.storeGroups.mockRejectedValueOnce(new Error('failed')).mockResolvedValue({ data: [] })
  show()
  fireEvent.click(await screen.findByRole('button', { name: 'もう一度読み込む' }))
  await screen.findByText('店の組：なし')
  expect(api.storeGroups).toHaveBeenCalledTimes(2)
})

it('アカウント切替後に古い読取りが戻っても混ぜない', async () => {
  let old!: (value: unknown) => void
  api.storeGroups.mockImplementationOnce(() => new Promise(resolve => { old = resolve })).mockResolvedValue({ data: [] })
  const view = show()
  view.rerender(<StoreGroups accountId="next" stores={stores} readOnly={false} />)
  await screen.findByText('店の組：なし')
  await act(async () => old({ data: [group] }))
  expect(screen.queryByText('試験店A')).toBeNull()
  expect(api.storeGroups).toHaveBeenLastCalledWith('next')
})

it('保存成功後の取得失敗を保存失敗に変えず、再保存せず読み直せる', async () => {
  api.storeGroups.mockResolvedValueOnce({ data: [group] }).mockRejectedValueOnce(new Error('read failed')).mockResolvedValue({ data: [] })
  show()
  fireEvent.click(within(await changeAndConfirm()).getByRole('button', { name: '保存する' }))
  fireEvent.click(await screen.findByRole('button', { name: 'もう一度読み込む' }))
  await screen.findByText('店の組：なし')
  expect(api.updateStoreGroupMember).toHaveBeenCalledTimes(1)
  expect(api.saved).toHaveBeenCalledTimes(1)
  expect(screen.queryByText(/保存できませんでした/)).toBeNull()
})


it('保存口の距離の理由を欄に返し、入力を直すと消す', async () => {
  api.updateStoreGroupMember.mockRejectedValueOnce({ status: 422, fields: { maxDistance: 'この距離では案内できません' } })
  show()
  fireEvent.click(within(await changeAndConfirm()).getByRole('button', { name: '保存する' }))
  const failed = await screen.findByRole('dialog')
  expect((await within(failed).findByRole('alert')).textContent).toContain('この距離では案内できません')
  const retry = within(failed).getByRole('button', { name: 'もう一度' })
  expect(retry.hasAttribute('disabled')).toBe(true)
  fireEvent.click(retry); expect(api.updateStoreGroupMember).toHaveBeenCalledTimes(1)
  fireEvent.click(within(failed).getByRole('button', { name: '戻って直す' }))
  await screen.findByText('この距離では案内できません')
  const input = screen.getByRole('spinbutton') as HTMLInputElement
  expect(input.getAttribute('aria-invalid')).toBe('true')
  expect(input.value).toBe('0')
  expect(api.updateStoreGroupMember).toHaveBeenCalledTimes(1)
  fireEvent.change(input, { target: { value: '1' } })
  await waitFor(() => expect(screen.queryByText('この距離では案内できません')).toBeNull())
})
