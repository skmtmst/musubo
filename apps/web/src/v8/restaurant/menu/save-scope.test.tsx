// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// 日付の見本を作る前に日本時間で固定し、待ち合わせのタイマーは動かす。
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T12:00:00+09:00'))
})

const fixture = vi.hoisted(() => ({ account: 'account-1', snapshot: vi.fn(), storeContext: vi.fn(), createMenu: vi.fn(), updateMenu: vi.fn() }))
const role = vi.hoisted(() => ({ value: 'owner' as string | null }))
const fetchApi = vi.hoisted(() => vi.fn())

vi.mock('@/components/shared/allergy-field', () => ({ default: () => null }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fixture.account, accounts: [] }) }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: fixture }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => role.value, canManageRole: (r: string | null) => r === 'owner' || r === 'admin' }))
vi.mock('@/lib/api', async (load) => ({ ...(await load<typeof import('@/lib/api')>()), fetchApi }))
const nav = vi.hoisted(() => ({ push: vi.fn(), params: new URLSearchParams() }))
vi.mock('next/navigation', async (load) => ({
  ...(await load<typeof import('next/navigation')>()),
  useRouter: () => ({ push: nav.push, replace: nav.push, back: vi.fn(), prefetch: vi.fn(), refresh: vi.fn(), forward: vi.fn() }),
  useSearchParams: () => nav.params,
  usePathname: () => '/restaurant-test/menu',
}))

import MenuEditPage from './edit'
import { snapshotOf } from '../booking-kit/test-data'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T12:00:00+09:00'))
  role.value = verifiedStaffRole('owner')
  fixture.account = 'account-1'; nav.params = new URLSearchParams()
  fixture.snapshot.mockResolvedValue({ data: snapshotOf() })
  fixture.storeContext.mockResolvedValue({ data: { selectedStore: null } })
  fixture.createMenu.mockResolvedValue({ success: true })
  fixture.updateMenu.mockResolvedValue({ success: true })
  fetchApi.mockResolvedValue({ success: true })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks() })

it('編集前のメニューは保存できず、変更すると保存できる', async () => {
 nav.params = new URLSearchParams('id=m1')
 render(<MenuEditPage />)
 const name = await screen.findByLabelText('メニュー名')
 const save = screen.getByRole('button', { name: /保存する/ }) as HTMLButtonElement
 expect(save.disabled).toBe(true)
 fireEvent.change(name, { target: { value: '新しい名前' } })
 expect(save.disabled).toBe(false)
})

it('新規メニューの見出しに親の名前を重ねない', async () => {
 render(<MenuEditPage />)
 await screen.findByLabelText('メニュー名')
 expect(screen.getByRole('heading', { name: 'コースを追加する' })).toBeTruthy()
})

it('メニューの保存中に店を切り替えても次の店で保存でき、旧応答で次の保存を解放しない', async () => {
 nav.params = new URLSearchParams('id=m1')
 let old!: (value: unknown) => void, fresh!: (value: unknown) => void
 fixture.updateMenu.mockImplementationOnce(() => new Promise(resolve => { old = resolve })).mockImplementationOnce(() => new Promise(resolve => { fresh = resolve }))
 const view = render(<MenuEditPage />)
 fireEvent.change(await screen.findByLabelText('メニュー名'), { target: { value: '前の店の直し' } })
 fireEvent.click(screen.getByRole('button', { name: /保存する/ }))
 await waitFor(() => expect(fixture.updateMenu).toHaveBeenCalledTimes(1))
 fixture.account = 'account-2'; view.rerender(<MenuEditPage />)
 await waitFor(() => expect((screen.getByLabelText('メニュー名') as HTMLInputElement).value).toBe('秋の鹿肉コース'))
 fireEvent.change(screen.getByLabelText('メニュー名'), { target: { value: '次の店の直し' } })
 fireEvent.click(screen.getByRole('button', { name: /保存する/ }))
 await waitFor(() => expect(fixture.updateMenu).toHaveBeenCalledTimes(2))
 await act(async () => { old({ success: true }) })
 expect(view.container.querySelector('button[aria-busy="true"]')).not.toBeNull()
 expect(nav.push).not.toHaveBeenCalled()
 expect((screen.getByLabelText('メニュー名') as HTMLInputElement).value).toBe('次の店の直し')
 expect(fixture.updateMenu.mock.calls.map(call => call[0])).toEqual(['account-1', 'account-2'])
 await act(async () => { fresh({ success: true }) })
 await waitFor(() => expect(nav.push).toHaveBeenCalledTimes(1))
})

it.each(['success', 'failure'])('画面を離れた後の保存の%sで一覧へ移らない', async outcome => {
 nav.params = new URLSearchParams('id=m1')
 let succeed!: (value: unknown) => void, fail!: (error: Error) => void
 fixture.updateMenu.mockImplementationOnce(() => new Promise((resolve, reject) => { succeed = resolve; fail = reject }))
 const view = render(<MenuEditPage />)
 fireEvent.change(await screen.findByLabelText('メニュー名'), { target: { value: '保存途中' } })
 fireEvent.click(screen.getByRole('button', { name: /保存する/ }))
 await waitFor(() => expect(fixture.updateMenu).toHaveBeenCalledTimes(1))
 view.unmount()
 await act(async () => { if (outcome === 'success') succeed({ success: true }); else fail(new Error('old save failed')) })
 expect(nav.push).not.toHaveBeenCalled()
})


async function fillNewMenu() {
 fireEvent.change(await screen.findByLabelText('メニュー名'), { target: { value: '試しのコース' } })
 fireEvent.change(screen.getByLabelText('価格（税込）'), { target: { value: '4200' } })
 fireEvent.click(screen.getByRole('button', { name: '所要時間' }))
 fireEvent.click(within(screen.getByRole('option', { name: '2時間（120分）' })).getByRole('button'))
}
async function choosePublication() {
 fireEvent.click(screen.getByLabelText('保存する状態'))
 fireEvent.click(within(await screen.findByRole('listbox')).getByRole('button', { name: '公開', exact: true }))
}

it('新しいメニューは公開を選ばなければ下書きで保存する', async () => {
 render(<MenuEditPage />)
 await fillNewMenu()
 fireEvent.click(screen.getByRole('button', { name: '保存して追加する' }))
 await waitFor(() => expect(fixture.createMenu).toHaveBeenCalledWith('account-1', expect.objectContaining({ storeId: 'store-1', name: '試しのコース', price: 4200, status: 'draft' })))
 expect(screen.queryByRole('dialog', { name: 'このメニューを公開しますか？' })).toBeNull()
})

it('公開を選んでも確認するまでは送らず、キャンセル後も選択を保つ', async () => {
 render(<MenuEditPage />)
 await fillNewMenu(); await choosePublication()
 fireEvent.click(screen.getByRole('button', { name: '保存して追加する' }))
 const dialog = await screen.findByRole('dialog', { name: 'このメニューを公開しますか？' })
 expect(dialog.textContent).toContain('LINEアカウント')
 expect(dialog.textContent).toContain('店舗')
 expect(dialog.textContent).toContain('渋谷店')
 expect(dialog.textContent).toContain('環境')
 expect(fixture.createMenu).not.toHaveBeenCalled()
 fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
 expect(screen.getByLabelText('保存する状態').textContent).toContain('公開')
 fireEvent.click(screen.getByRole('button', { name: '保存して追加する' }))
 fireEvent.click(within(await screen.findByRole('dialog', { name: 'このメニューを公開しますか？' })).getByRole('button', { name: '公開して追加する' }))
 await waitFor(() => expect(fixture.createMenu).toHaveBeenCalledWith('account-1', expect.objectContaining({ status: 'active' })))
 expect(fixture.createMenu).toHaveBeenCalledTimes(1)
})

it('公開確認中にアカウントを切り替えたら古い確認窓を閉じる', async () => {
 const view = render(<MenuEditPage />)
 await fillNewMenu(); await choosePublication()
 fireEvent.click(screen.getByRole('button', { name: '保存して追加する' }))
 await screen.findByRole('dialog', { name: 'このメニューを公開しますか？' })
 fixture.account = 'account-2'; view.rerender(<MenuEditPage />)
 await waitFor(() => expect(screen.queryByRole('dialog', { name: 'このメニューを公開しますか？' })).toBeNull())
 expect(fixture.createMenu).not.toHaveBeenCalled()
})

it('旧アカウントの遅い取得で新しいメニューを上書きしない', async () => {
 nav.params = new URLSearchParams('id=m1')
 let old!: (value: unknown) => void
 fixture.snapshot.mockImplementationOnce(() => new Promise(resolve => { old = resolve }))
   .mockResolvedValueOnce({ data: snapshotOf({ menuItems: [{ ...snapshotOf().menuItems[0], name: '新しい店のメニュー' }] }) })
 const view = render(<MenuEditPage />)
 fixture.account = 'account-2'; view.rerender(<MenuEditPage />)
 await waitFor(() => expect((screen.getByLabelText('メニュー名') as HTMLInputElement).value).toBe('新しい店のメニュー'))
 await act(async () => { old({ data: snapshotOf() }) })
 expect((screen.getByLabelText('メニュー名') as HTMLInputElement).value).toBe('新しい店のメニュー')
})

it('保存が失敗しても入力と下書きの選択を残す', async () => {
 fixture.createMenu.mockRejectedValueOnce(new Error('temporary failure'))
 render(<MenuEditPage />)
 await fillNewMenu()
 fireEvent.click(screen.getByRole('button', { name: '保存して追加する' }))
 await screen.findByText('保存できませんでした。入力を確かめて、もう一度お試しください。')
 expect((screen.getByLabelText('メニュー名') as HTMLInputElement).value).toBe('試しのコース')
 expect((screen.getByLabelText('価格（税込）') as HTMLInputElement).value).toBe('4200')
 expect(screen.getByLabelText('保存する状態').textContent).toContain('下書き')
 expect(nav.push).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button', { name: '保存して追加する' }))
 await waitFor(() => expect(fixture.createMenu).toHaveBeenCalledTimes(2))
 expect(fixture.createMenu.mock.calls[1][1]).toMatchObject({ status: 'draft' })
})

it('既存のメニューの編集では公開状態を送らない', async () => {
 nav.params = new URLSearchParams('id=m1')
 render(<MenuEditPage />)
 fireEvent.change(await screen.findByLabelText('メニュー名'), { target: { value: '名前だけ変更' } })
 expect(screen.queryByLabelText('保存する状態')).toBeNull()
 fireEvent.click(screen.getByRole('button', { name: '保存する' }))
 await waitFor(() => expect(fixture.updateMenu).toHaveBeenCalledTimes(1))
 expect(fixture.updateMenu.mock.calls[0][2]).not.toHaveProperty('status')
})


it('保存済みの下書きは確認して公開でき、確認を閉じただけでは送らない', async () => {
 nav.params = new URLSearchParams('id=m4')
 render(<MenuEditPage />)
 await screen.findByLabelText('メニュー名')
 await choosePublication()
 fireEvent.click(screen.getByRole('button', { name: '保存する' }))
 const dialog = await screen.findByRole('dialog', { name: 'このメニューを公開しますか？' })
 expect(fixture.updateMenu).not.toHaveBeenCalled()
 fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
 expect(fixture.updateMenu).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button', { name: '保存する' }))
 fireEvent.click(within(await screen.findByRole('dialog', { name: 'このメニューを公開しますか？' })).getByRole('button', { name: '公開して保存する' }))
 await waitFor(() => expect(fixture.updateMenu).toHaveBeenCalledWith('account-1', 'm4', expect.objectContaining({ status: 'active' })))
 expect(fixture.updateMenu).toHaveBeenCalledTimes(1)
})


it('公開が失敗しても確認と入力を残し、同じ公開をやり直せる', async () => {
 fixture.createMenu.mockRejectedValueOnce(new Error('拒否'))
 render(<MenuEditPage />)
 await fillNewMenu()
 fireEvent.change(screen.getByLabelText('メニュー名'), { target: { value: '公開する下書き' } })
 await choosePublication()
 fireEvent.click(screen.getByRole('button', { name: '保存して追加する' }))
 const dialog = await screen.findByRole('dialog', { name: 'このメニューを公開しますか？' })
 fireEvent.click(within(dialog).getByRole('button', { name: '公開して追加する' }))
 await within(dialog).findByRole('alert')
 expect(nav.push).not.toHaveBeenCalled()
 expect((screen.getByLabelText('メニュー名') as HTMLInputElement).value).toBe('公開する下書き')
 fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度' }))
 await waitFor(() => expect(nav.push).toHaveBeenCalledTimes(1))
 expect(fixture.createMenu).toHaveBeenCalledTimes(2)
 expect(fixture.createMenu.mock.calls.every(call => call[1].status === 'active')).toBe(true)
})
