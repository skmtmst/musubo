import { PERMISSION_LOCK_SUMMARY } from '@/components/shared/permission-lock'
// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 日付の見本を作る前に日本時間で固定し、待ち合わせのタイマーは動かす。
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T12:00:00+09:00'))
})

const fixture = vi.hoisted(() => ({ snapshot: vi.fn(), createMenu: vi.fn(), updateMenu: vi.fn() }))
const role = vi.hoisted(() => ({ value: 'owner' as string | null }))
const fetchApi = vi.hoisted(() => vi.fn())

const account = vi.hoisted(() => ({ id: 'account-1' }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: account.id, accounts: [] }) }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: fixture }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => role.value, canManageRole: (r: string | null) => r === 'owner' || r === 'admin' }))
vi.mock('@/lib/api', async (load) => ({ ...(await load<typeof import('@/lib/api')>()), fetchApi }))
const nav = vi.hoisted(() => ({ push: vi.fn(), params: new URLSearchParams() }))
const chromeTitle = vi.hoisted(() => vi.fn())
vi.mock('@/components/shell/page-chrome', async load => ({ ...(await load<typeof import('@/components/shell/page-chrome')>()), usePageTitle: chromeTitle }))
vi.mock('next/navigation', async (load) => ({
  ...(await load<typeof import('next/navigation')>()),
  useRouter: () => ({ push: nav.push, replace: nav.push, back: vi.fn(), prefetch: vi.fn(), refresh: vi.fn(), forward: vi.fn() }),
  useSearchParams: () => nav.params,
  usePathname: () => '/restaurant-test/menu',
}))

import { ApiError } from '@/lib/api/transport/errors'
import MenuPage from './menu'
import MenuEditPage from './edit'
import { snapshotOf } from '../booking-kit/test-data'

beforeEach(() => {
  account.id = 'account-1'
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T12:00:00+09:00'))
  role.value = verifiedStaffRole('owner')
  nav.params = new URLSearchParams()
  fixture.snapshot.mockResolvedValue({ data: snapshotOf() })
  fixture.createMenu.mockResolvedValue({ success: true })
  fixture.updateMenu.mockResolvedValue({ success: true })
  fetchApi.mockResolvedValue({ success: true })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks() })

const openMenu = (name: string) => fireEvent.click(screen.getByRole('button', { name: `メニュー「${name}」の操作` }))

/* ★V8 メニュー管理（板 ・停止 ・追加と変更 ）の動き。 */
describe('MJoJR メニュー管理', () => {
  it('閲覧のみでは操作できると案内せずメニューの確認を案内する', async () => {
    role.value = verifiedStaffRole('viewer')
    render(<MenuPage />)
    await screen.findByText('メニュー一覧')
    fireEvent.click(screen.getByRole('button', { name: 'メニュー一覧の説明' }))
    expect(await screen.findByText('メニューの内容と価格を確認できます。')).toBeTruthy()
    expect(screen.queryByText(/「…」から変更・停止・再開・削除ができます/)).toBeNull()
  })
  it('数5・一覧が出て、アーカイブだけ再開が出る（「…」の決まりは題の？へ）', async () => {
    render(<MenuPage />)
    await screen.findByText('メニュー一覧')
    const board = document.querySelector('[data-design-node="MJoJR"]')!
    for (const label of ['全メニュー', 'コース', '単品', '開始待ち', 'アレルギー登録']) expect(board.textContent).toContain(label)
    expect(board.textContent).not.toContain('要承認')
    expect(board.textContent).not.toContain('「…」の中身')
    fireEvent.click(screen.getByRole('button', { name: 'メニュー一覧の説明' }))
    expect(await screen.findByText(/参照中のメニューは削除できません/)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '再開' })).toHaveLength(1)
  })

  it('「…」の変更と名前は、前の窓ではなく 1 枚の編集ページ（mauOC）へ進む', async () => {
    render(<MenuPage />)
    await screen.findByText('メニュー一覧')
    openMenu('秋の鹿肉コース')
    fireEvent.click(screen.getByRole('menuitem', { name: '変更' }))
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/restaurant-test/menu/edit?id=m1'))
    expect(document.querySelector('[data-design-node="NkmwU"]')).toBeNull()
  })

  it('停止は確認の窓（MV5Os）を通って保管にする', async () => {
    render(<MenuPage />)
    await screen.findByText('メニュー一覧')
    openMenu('秋の鹿肉コース')
    fireEvent.click(screen.getByRole('menuitem', { name: '停止' }))
    const dialog = document.querySelector('[data-design-node="MV5Os"]') as HTMLElement
    expect(dialog).not.toBeNull()
    expect(dialog.textContent).toContain('LINEアカウント')
    expect(dialog.textContent).toContain('店舗')
    expect(dialog.textContent).toContain('渋谷店')
    expect(dialog.textContent).toContain('環境')
    fireEvent.click(within(dialog).getByRole('button', { name: '停止する' }))
    await waitFor(() => expect(fixture.updateMenu).toHaveBeenCalledWith('account-1', 'm1', { status: 'archived', expectedVersion: 1 }))
  })

  it.each(['停止', '再開'] as const)('%s に失敗したら保存失敗を知らせる', async (operation) => {
    fixture.updateMenu.mockRejectedValueOnce(new Error('network'))
    render(<MenuPage />)
    await screen.findByText('メニュー一覧')
    if (operation === '停止') {
      openMenu('秋の鹿肉コース')
      fireEvent.click(screen.getByRole('menuitem', { name: '停止' }))
      fireEvent.click(screen.getByRole('button', { name: '停止する' }))
    } else {
      fireEvent.click(screen.getByRole('button', { name: '再開', exact: true }))
    }
    expect((await screen.findAllByText('保存に失敗しました。時間をおいて、もう一度お試しください。')).length).toBeGreaterThan(0)
    expect(fixture.updateMenu).toHaveBeenCalledTimes(1)
  })

  it('停止の競合後は最新の内容で確認窓を作り直す', async () => {
    const latest = snapshotOf()
    latest.menuItems = latest.menuItems.map(item => item.id === 'm1' ? {...item, name:'更新後のコース', confirmation_revision:2} : item)
    fixture.snapshot.mockResolvedValueOnce({data:snapshotOf()}).mockResolvedValue({data:latest})
    fixture.updateMenu.mockRejectedValueOnce(new ApiError(409, '変更されました', 'menu_confirmation_conflict')).mockResolvedValue({success:true})
    render(<MenuPage />)
    await screen.findByText('メニュー一覧')
    openMenu('秋の鹿肉コース')
    fireEvent.click(screen.getByRole('menuitem', {name:'停止'}))
    fireEvent.click(screen.getByRole('button', {name:'停止する'}))
    expect(await screen.findByText('内容が変わりました。最新の内容を確認してください。')).toBeTruthy()
    const dialog = screen.getByRole('dialog', {name:'このメニューを停止しますか？'})
    expect(dialog.textContent).toContain('更新後のコース')
    fireEvent.click(within(dialog).getByRole('button', {name:'停止する'}))
    await waitFor(() => expect(fixture.updateMenu).toHaveBeenLastCalledWith('account-1', 'm1', {status:'archived',expectedVersion:2}))
  })

  it('アカウント切替後の取得中は前の一覧から削除を開けない', async () => {
    let finish!: (value: unknown) => void
    fixture.snapshot.mockResolvedValueOnce({ data: snapshotOf() }).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const view = render(<MenuPage />)
    await screen.findByText('メニュー一覧')
    account.id = 'account-2'; view.rerender(<MenuPage />)
    await waitFor(() => expect(fixture.snapshot.mock.calls.some(([id]) => id === 'account-2')).toBe(true))
    openMenu('春の下書きコース')
    fireEvent.click(screen.getByRole('menuitem', { name: '削除' }))
    expect(screen.queryByRole('dialog', { name: 'このメニューを削除しますか？' })).toBeNull()
    expect(fetchApi).not.toHaveBeenCalledWith(expect.stringContaining('/api/restaurant-test/menus/m4'), expect.anything())
    await act(async () => { finish({ data: snapshotOf() }) })
    openMenu('春の下書きコース')
    fireEvent.click(screen.getByRole('menuitem', { name: '削除' }))
    expect(screen.getByRole('dialog', { name: 'このメニューを削除しますか？' })).toBeTruthy()
  })

  it('公開中と下書きのメニューに削除があり、確認して DELETE の口へ届く', async () => {
    render(<MenuPage />)
    await screen.findByText('メニュー一覧')
    openMenu('秋の鹿肉コース')
    expect(screen.getByRole('menuitem', { name: '削除' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    openMenu('春の下書きコース')
    fireEvent.click(screen.getByRole('menuitem', { name: '削除' }))
    expect(screen.getByRole('dialog', { name: 'このメニューを削除しますか？' }).textContent).toContain('環境')
    fireEvent.click(screen.getByRole('button', { name: '削除する' }))
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith('/api/restaurant-test/menus/m4?account_id=account-1', { method: 'DELETE', body: JSON.stringify({ expectedVersion: 1 }) }))
  })

  it('削除の競合後は最新の名前と版で確認窓を開き直す', async () => {
    const latest = snapshotOf()
    latest.menuItems = latest.menuItems.map(item => item.id === 'm4' ? {...item, name:'変更後の下書き', confirmation_revision:2} : item)
    fixture.snapshot.mockResolvedValueOnce({data:snapshotOf()}).mockResolvedValue({data:latest})
    fetchApi.mockRejectedValueOnce(new ApiError(409, '変更されました', 'menu_confirmation_conflict')).mockResolvedValue({success:true})
    render(<MenuPage />)
    await screen.findByText('メニュー一覧')
    openMenu('春の下書きコース')
    fireEvent.click(screen.getByRole('menuitem', {name:'削除'}))
    fireEvent.click(screen.getByRole('button', {name:'削除する'}))
    expect(await screen.findByText('内容が変わりました。最新の内容を確認してください。')).toBeTruthy()
    const dialog = screen.getByRole('dialog', {name:'このメニューを削除しますか？'})
    expect(dialog.textContent).toContain('変更後の下書き')
    fireEvent.click(within(dialog).getByRole('button', {name:'削除する'}))
    await waitFor(() => expect(fetchApi).toHaveBeenLastCalledWith('/api/restaurant-test/menus/m4?account_id=account-1', {method:'DELETE',body:JSON.stringify({expectedVersion:2})}))
  })

  it('参照中のメニューは確認窓に理由を出して残す', async () => {
    fetchApi.mockRejectedValueOnce(new ApiError(409, '予約で使われているメニューは削除できません。停止してください', 'resource_in_use'))
    render(<MenuPage />)
    await screen.findByText('メニュー一覧')
    openMenu('秋の鹿肉コース')
    fireEvent.click(screen.getByRole('menuitem', { name: '削除' }))
    expect(screen.getAllByText('秋の鹿肉コース').length).toBeGreaterThan(0)
    expect(screen.getByText(/元に戻せません/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '削除する' }))
    expect(await screen.findByText(/予約で使われているメニューは削除できません/)).toBeTruthy()
  })

  it('メニューを作るは選んでいる店舗で編集ページを開く', async () => {
    render(<MenuPage />)
    await screen.findByText('メニュー一覧')
    fireEvent.click(screen.getByRole('button', { name: /メニューを作る/ }))
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/restaurant-test/menu/edit?store=store-1'))
  })

  it('以前の価格申請が残る品目には確認口を残す', async () => {
    const data = snapshotOf()
    data.menuItems[0].pendingPrice = 9900
    data.menuItems[0].priceChangeStatus = 'pending'
    fixture.snapshot.mockResolvedValueOnce({ data })
    render(<MenuPage />)
    fireEvent.click(await screen.findByRole('button', { name: '以前の申請を確認する' }))
    expect(nav.push).toHaveBeenCalledWith('/restaurant-test/approvals')
  })

  it('閲覧のみ（staff）には追加・「…」・再開を置かない', async () => {
    role.value = verifiedStaffRole('staff')
    render(<MenuPage />)
    await screen.findByText('メニュー一覧')
    expect(screen.getByText(PERMISSION_LOCK_SUMMARY.feature)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /メニューを作る/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /の操作$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: '再開' })).toBeNull()
  })
})

describe('mauOC コースの編集ページ', () => {
  it('メニュー編集の読み込み中は追加の題にせず、読めた名前へ替える', async () => {
    let resolveSnapshot!: (value: unknown) => void
    fixture.snapshot.mockImplementation(() => new Promise(resolve => { resolveSnapshot = resolve }))
    nav.params = new URLSearchParams('id=m1')
    render(<MenuEditPage />)
    expect(chromeTitle).toHaveBeenLastCalledWith('メニューを編集')
    expect(chromeTitle).not.toHaveBeenCalledWith('コースを追加する')
    resolveSnapshot({ data: snapshotOf() })
    await screen.findByLabelText('メニュー名')
    expect(chromeTitle).toHaveBeenLastCalledWith('秋の鹿肉コース')
  })

  it('新規は取得中も取得後も追加の題を保つ', async () => {
    let resolveSnapshot!: (value: unknown) => void
    fixture.snapshot.mockImplementation(() => new Promise(resolve => { resolveSnapshot = resolve }))
    nav.params = new URLSearchParams('store=store-1')
    render(<MenuEditPage />)
    expect(chromeTitle).toHaveBeenLastCalledWith('コースを追加する')
    resolveSnapshot({ data: snapshotOf() })
    await screen.findByLabelText('メニュー名')
    expect(chromeTitle).toHaveBeenLastCalledWith('コースを追加する')
  })

  it('編集IDを替えると、次の取得中に前の名前と入力を残さない', async () => {
    nav.params = new URLSearchParams('id=m1')
    const view = render(<MenuEditPage />)
    await screen.findByDisplayValue('秋の鹿肉コース')
    let resolveSnapshot!: (value: unknown) => void
    fixture.snapshot.mockImplementation(() => new Promise(resolve => { resolveSnapshot = resolve }))
    nav.params = new URLSearchParams('id=m2')
    view.rerender(<MenuEditPage />)
    expect(chromeTitle).toHaveBeenLastCalledWith('メニューを編集')
    expect(screen.queryByDisplayValue('秋の鹿肉コース')).toBeNull()
    const next = snapshotOf()
    next.menuItems = [{ ...next.menuItems[0], id: 'm2', name: '冬のコース' }]
    resolveSnapshot({ data: next })
    await screen.findByDisplayValue('冬のコース')
    expect(chromeTitle).toHaveBeenLastCalledWith('冬のコース')
  })

  it('店舗を替えたら同じIDでも前の名前を残さない', async () => {
    nav.params = new URLSearchParams('id=m1')
    const view = render(<MenuEditPage />)
    await screen.findByDisplayValue('秋の鹿肉コース')
    let resolveSnapshot!: (value: unknown) => void
    fixture.snapshot.mockImplementation(() => new Promise(resolve => { resolveSnapshot = resolve }))
    account.id = 'account-2'
    view.rerender(<MenuEditPage />)
    expect(chromeTitle).toHaveBeenLastCalledWith('メニューを編集')
    expect(screen.queryByDisplayValue('秋の鹿肉コース')).toBeNull()
    const next = snapshotOf()
    next.menuItems = [{ ...next.menuItems[0], name: '二号店のコース' }]
    resolveSnapshot({ data: next })
    await screen.findByDisplayValue('二号店のコース')
    expect(fixture.snapshot).toHaveBeenLastCalledWith('account-2')
  })

  it('対象IDが同じ内部の指定では入力を作り直さない', async () => {
    nav.params = new URLSearchParams('id=m1')
    const view = render(<MenuEditPage />)
    fireEvent.change(await screen.findByLabelText('メニュー名'), { target: { value: '編集中のコース' } })
    nav.params = new URLSearchParams('id=m1&tab=payment')
    view.rerender(<MenuEditPage />)
    expect(screen.getByDisplayValue('編集中のコース')).toBeTruthy()
    expect(fixture.snapshot).toHaveBeenCalledTimes(1)
  })

  it('変更して保存すると、今の口（updateMenu）へ届き一覧へ戻る', async () => {
    nav.params = new URLSearchParams('id=m1')
    render(<MenuEditPage />)
    const name = await screen.findByLabelText('メニュー名')
    fireEvent.change(name, { target: { value: '冬の鹿肉コース' } })
    fireEvent.click(screen.getByRole('button', { name: /保存する/ }))
    await waitFor(() => expect(fixture.updateMenu).toHaveBeenCalledWith('account-1', 'm1', expect.objectContaining({ name: '冬の鹿肉コース', servicePeriods: ['dinner'] })))
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/restaurant-test/menu'))
  })

  it('版が変わっても入力を残し、操作で最新を読み直す', async () => {
    nav.params = new URLSearchParams('id=m1')
    const latest = snapshotOf()
    latest.menuItems = latest.menuItems.map(item => item.id === 'm1' ? {...item, name:'別の担当が変更', confirmation_revision:2} : item)
    fixture.snapshot.mockResolvedValueOnce({data:snapshotOf()}).mockResolvedValue({data:latest})
    fixture.updateMenu.mockRejectedValueOnce(new ApiError(409, '変更されました', 'menu_confirmation_conflict'))
    render(<MenuEditPage />)
    fireEvent.change(await screen.findByLabelText('メニュー名'), {target:{value:'確認した変更'}})
    fireEvent.click(screen.getByRole('button', {name:/保存する/}))
    expect(await screen.findByText(/ほかの人が変更しました。最新を読み込むと入力は消えます/)).toBeTruthy()
    expect((screen.getByLabelText('メニュー名') as HTMLInputElement).value).toBe('確認した変更')
    fireEvent.click(screen.getByRole('button', {name:'最新を読み込む'}))
    await waitFor(() => expect((screen.getByLabelText('メニュー名') as HTMLInputElement).value).toBe('別の担当が変更'))
    expect(fixture.updateMenu.mock.calls[0][2]).toEqual(expect.objectContaining({expectedVersion:1}))
    expect(nav.push).not.toHaveBeenCalled()
  })

  it('価格を変えると確認を経て、開始日時を添えて確定する', async () => {
    nav.params = new URLSearchParams('id=m1')
    render(<MenuEditPage />)
    fireEvent.change(await screen.findByLabelText('価格（税込）'), { target: { value: '9900' } })
    const next = new Date()
    next.setDate(1)
    next.setMonth(next.getMonth() + 1)
    const ymd = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-10`
    fireEvent.click(screen.getByLabelText('新しい価格の開始日時'))
    const picker = screen.getByRole('dialog', { name: '日時を選ぶ' })
    fireEvent.click(screen.getByRole('button', { name: '次の月' }))
    fireEvent.click(screen.getAllByRole('button').find((b) => (b.getAttribute('aria-label') ?? '').startsWith(`${next.getFullYear()}年${next.getMonth() + 1}月10日`))!)
    fireEvent.click(screen.getByRole('button',{name:'確定'}))
    fireEvent.click(screen.getByRole('button', { name: /保存する/ }))
    expect(fixture.updateMenu).not.toHaveBeenCalled()
    expect(screen.getByText('価格変更を確定しますか？')).toBeTruthy()
    expect(screen.getByRole('dialog', { name: '価格変更を確定しますか？' }).textContent).toContain('環境')
    fireEvent.click(screen.getByRole('button', { name: '確定して保存する' }))
    await waitFor(() => expect(fixture.updateMenu).toHaveBeenCalledWith('account-1', 'm1', expect.objectContaining({ price: 9900, effectiveAt: new Date(`${ymd}T10:00:00+09:00`).toISOString() })))
  })

  it('追加は店舗を添えて createMenu へ送る', async () => {
    nav.params = new URLSearchParams('store=store-1')
    render(<MenuEditPage />)
    fireEvent.change(await screen.findByLabelText('メニュー名'), { target: { value: '冬のコース' } })
    fireEvent.change(screen.getByLabelText('価格（税込）'), { target: { value: '7000' } })
    fireEvent.click(screen.getByRole('button', { name: /保存して追加する/ }))
    await waitFor(() => expect(fixture.createMenu).toHaveBeenCalledWith('account-1', expect.objectContaining({ storeId: 'store-1', name: '冬のコース', price: 7000 })))
  })

  it('保存に失敗したら入力を残して知らせ、一覧へ戻らない', async () => {
    nav.params = new URLSearchParams('id=m1')
    fixture.updateMenu.mockRejectedValueOnce(new Error('network'))
    render(<MenuEditPage />)
    fireEvent.change(await screen.findByLabelText('メニュー名'), { target: { value: '冬の鹿肉コース' } })
    fireEvent.click(screen.getByRole('button', { name: /保存する/ }))
    expect(await screen.findByText(/保存できませんでした/)).toBeTruthy()
    expect((screen.getByLabelText('メニュー名') as HTMLInputElement).value).toBe('冬の鹿肉コース')
    expect(nav.push).not.toHaveBeenCalled()
  })

  it('公開中と下書きの［削除する］から確認して DELETE の口へ届く', async () => {
    nav.params = new URLSearchParams('id=m1')
    const { unmount } = render(<MenuEditPage />)
    await screen.findByLabelText('メニュー名')
    expect(screen.getByRole('button', { name: '削除する' })).toBeTruthy()
    unmount()
    nav.params = new URLSearchParams('id=m4')
    render(<MenuEditPage />)
    await screen.findByLabelText('メニュー名')
    fireEvent.click(screen.getByRole('button', { name: '削除する' }))
    expect(screen.getByRole('alertdialog', { name: /削除しますか/ }).textContent).toContain('環境')
    const confirm = await screen.findAllByRole('button', { name: '削除する' })
    fireEvent.click(confirm[confirm.length - 1])
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith('/api/restaurant-test/menus/m4?account_id=account-1', { method: 'DELETE', body: JSON.stringify({ expectedVersion: 1 }) }))
  })

  it('閲覧のみでも提供時間と所要時間を読み、保存はできない', async () => {
    role.value = verifiedStaffRole('staff')
    nav.params = new URLSearchParams('id=m1')
    render(<MenuEditPage />)
    expect(await screen.findByText('メニューの内容')).toBeTruthy()
    expect(screen.getByText('所要時間')).toBeTruthy()
    expect(screen.getByText('アレルギー')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /保存/ })).toBeNull()
    expect(screen.queryByLabelText('メニュー名')).toBeNull()
    expect(fixture.updateMenu).not.toHaveBeenCalled()
  })

  it('閲覧では現在の価格と変更予定の価格を別々に読む', async () => {
    role.value = verifiedStaffRole('staff')
    const data = snapshotOf()
    data.menuItems[0] = { ...data.menuItems[0], price: 1200, pendingPrice: 2500 }
    fixture.snapshot.mockResolvedValue({ data })
    nav.params = new URLSearchParams(`id=${data.menuItems[0].id}`)
    render(<MenuEditPage />)
    expect(await screen.findByText('¥1,200')).toBeTruthy()
    expect(screen.getByText('変更予定の価格')).toBeTruthy()
    expect(screen.getByText('¥2,500')).toBeTruthy()
  })

  it('R11: 帯は4枚まで、5つ目のアレルギー登録は帯の下の1行', async () => {
    render(<MenuPage />)
    await screen.findByText('メニュー一覧')
    const strip = document.querySelector('[data-kpi-strip]')!
    expect(Array.from(strip.querySelectorAll('[data-kpi-label]')).map((n) => n.getAttribute('title'))).toEqual(['全メニュー', 'コース', '単品', '開始待ち'])
    // 5つ目は帯の外の1行に項目名と値を残す。
    const line = strip.nextElementSibling!
    expect(line.tagName).toBe('P')
    expect(line.textContent).toContain('アレルギー登録')
    expect(line.textContent).toContain('2 件')
  })
})

afterEach(() => { verifiedStaffRole(null) })

describe('価格変更の開始待ちとメニューの停止状態', () => {
  const queuedPrice = { price: 8800, status: 'active', pendingPrice: 9900, pendingEffectiveAt: '2099-01-01T00:00:00Z', priceChangeStatus: 'approved' }
  const scheduledCount = () => document.querySelector('[data-kpi-label][title="開始待ち"]')?.closest('[data-kpi-presentation]')?.querySelector('[data-kpi-number]')?.textContent
  const menuRow = (name: string) => screen.getByRole('row', { name: new RegExp(name) })

  it.each([['archived', '停止中'], ['paused', '停止中'], ['draft', '下書き']])('%sは未来の価格があっても%sを優先する', async (status, label) => {
    const data = snapshotOf()
    data.menuItems = [{ ...data.menuItems[0], ...queuedPrice, status }]
    fixture.snapshot.mockResolvedValue({ data })
    render(<MenuPage />)
    await screen.findByText('メニュー一覧')
    expect(within(menuRow('秋の鹿肉コース')).getByText(label)).toBeTruthy()
    expect(within(menuRow('秋の鹿肉コース')).queryByText('開始待ち')).toBeNull()
    expect(scheduledCount()).toBe('0')
  })

  it('開始待ちは公開中の未来の価格だけを数え、停止と下書きを含めない', async () => {
    const data = snapshotOf()
    data.menuItems = data.menuItems.map((item, index) => ({ ...item, ...queuedPrice, status: ['active', 'paused', 'archived', 'draft'][index] }))
    fixture.snapshot.mockResolvedValue({ data })
    render(<MenuPage />)
    await screen.findByText('メニュー一覧')
    expect(scheduledCount()).toBe('1')
    expect(within(menuRow('秋の鹿肉コース')).getByText('開始待ち')).toBeTruthy()
  })

  it('公開中の新価格0円も開始待ちとして残し、元の価格を上書きしない', async () => {
    const data = snapshotOf()
    data.menuItems = [{ ...data.menuItems[0], ...queuedPrice, pendingPrice: 0 }]
    fixture.snapshot.mockResolvedValue({ data })
    render(<MenuPage />)
    await screen.findByText('メニュー一覧')
    expect(within(menuRow('秋の鹿肉コース')).getByText('開始待ち')).toBeTruthy()
    expect(within(menuRow('秋の鹿肉コース')).getByText('¥8,800')).toBeTruthy()
    expect(screen.getByTitle(/新価格 ¥0/)).toBeTruthy()
    expect(scheduledCount()).toBe('1')
  })

  it('公開中の以前の価格申請は申請中と確認口を残し、開始待ちには含めない', async () => {
    const data = snapshotOf()
    data.menuItems = [{ ...data.menuItems[0], ...queuedPrice, priceChangeStatus: 'pending' }]
    fixture.snapshot.mockResolvedValue({ data })
    render(<MenuPage />)
    await screen.findByText('メニュー一覧')
    expect(within(menuRow('秋の鹿肉コース')).getByText('申請中')).toBeTruthy()
    expect(screen.getByRole('button', { name: '以前の申請を確認する' })).toBeTruthy()
    expect(scheduledCount()).toBe('0')
  })

  it('停止と再開の既存送信を保ち、再取得した状態に札と件数を合わせる', async () => {
    const data = snapshotOf()
    data.menuItems = [{ ...data.menuItems[0], ...queuedPrice }]
    fixture.snapshot.mockResolvedValue({ data })
    render(<MenuPage />)
    await screen.findByText('メニュー一覧')
    expect(scheduledCount()).toBe('1')
    fixture.snapshot.mockResolvedValue({ data: { ...data, menuItems: data.menuItems.map(item => ({ ...item, status: 'archived' })) } })
    openMenu('秋の鹿肉コース')
    fireEvent.click(screen.getByRole('menuitem', { name: '停止' }))
    fireEvent.click(screen.getByRole('button', { name: '停止する' }))
    await waitFor(() => expect(fixture.updateMenu).toHaveBeenCalledWith('account-1', 'm1', { status: 'archived', expectedVersion: 1 }))
    await waitFor(() => expect(within(menuRow('秋の鹿肉コース')).getByText('停止中')).toBeTruthy())
    expect(scheduledCount()).toBe('0')
    fixture.snapshot.mockResolvedValue({ data })
    fireEvent.click(within(menuRow('秋の鹿肉コース')).getByRole('button', { name: '再開', exact: true }))
    await waitFor(() => expect(fixture.updateMenu).toHaveBeenCalledWith('account-1', 'm1', { status: 'active', expectedVersion: 1 }))
    await waitFor(() => expect(within(menuRow('秋の鹿肉コース')).getByText('開始待ち')).toBeTruthy())
    expect(scheduledCount()).toBe('1')
  })
})


it('停止した旧申請は停止の札と0件を示し、申請を確認する入口を残す', async () => {
  const data = snapshotOf()
  data.menuItems = [{ ...data.menuItems[0], price: 8800, status: 'archived', pendingPrice: 9900, priceChangeStatus: 'pending' }]
  fixture.snapshot.mockResolvedValue({ data })
  render(<MenuPage />)
  await screen.findByText('メニュー一覧')
  const row = screen.getByRole('row', { name: /秋の鹿肉コース/ })
  expect(within(row).getByText('停止中')).toBeTruthy()
  expect(within(row).queryByText('申請中')).toBeNull()
  expect(screen.getByRole('button', { name: '以前の申請を確認する' })).toBeTruthy()
  const card = document.querySelector('[data-kpi-label][title="開始待ち"]')?.closest('[data-kpi-presentation]')
  expect(card?.querySelector('[data-kpi-number]')?.textContent).toBe('0')
})

it('変更額が無い承認済みの記録だけでは開始待ちとせず有効のまま表示する', async () => {
  const data = snapshotOf()
  data.menuItems = [{ ...data.menuItems[0], price: 8800, status: 'active', pendingPrice: null, priceChangeStatus: 'approved' }]
  fixture.snapshot.mockResolvedValue({ data })
  render(<MenuPage />)
  await screen.findByText('メニュー一覧')
  const row = screen.getByRole('row', { name: /秋の鹿肉コース/ })
  expect(within(row).getByText('有効')).toBeTruthy()
  expect(within(row).queryByText('開始待ち')).toBeNull()
  const card = document.querySelector('[data-kpi-label][title="開始待ち"]')?.closest('[data-kpi-presentation]')
  expect(card?.querySelector('[data-kpi-number]')?.textContent).toBe('0')
})


it('変更予定の価格と日時を一覧に表示する', async () => {
  const data = snapshotOf()
  data.menuItems = [{ ...data.menuItems[0], pendingPrice: 9900, pendingEffectiveAt: '2099-01-01T00:00:00Z', priceChangeStatus: 'approved' }]
  fixture.snapshot.mockResolvedValue({ data })
  render(<MenuPage />)
  const row = await screen.findByRole('row', { name: /秋の鹿肉コース/ })
  expect(within(row).getByText(/変更後 ¥9,900/)).toBeTruthy()
  expect(within(row).getByText(/2099/)).toBeTruthy()
})

it('変更できない所要時間は押せない入力として表示する', async () => {
  nav.params = new URLSearchParams('id=m1')
  render(<MenuEditPage />)
  const duration = await screen.findByRole('textbox', { name: '時間' }) as HTMLInputElement
  expect(duration.disabled).toBe(true)
})
