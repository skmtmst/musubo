// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ snapshot: vi.fn(), createMenu: vi.fn(), updateMenu: vi.fn() }))

vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-1', accounts: [] }) }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: fixture }))

import { api, ApiError } from '@/lib/api'
import MenuV8 from '@/v8/restaurant/menu/menu'
import MenuEditV8 from '@/v8/restaurant/menu/edit'
const nav = vi.hoisted(() => ({ params: new URLSearchParams('id=m1') }))
vi.mock('next/navigation',async()=> ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(), useSearchParams: () => nav.params }))
vi.mock('@/components/shell/page-chrome',async()=> (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/lib/staff-role',()=>({useStaffRole:()=> 'owner',canManageRole:()=>true}))

const store = { id: 'store-1', organization_id: 'org-1', name: '渋谷店', code: 'SHIBUYA', area: null, capacity: 26, timezone: 'Asia/Tokyo', status: 'active', line_status: 'connected', google_status: 'unconfigured', line_account_id: 'account-1', line_account_name: '渋谷' }
const data = {
  organization: { id: 'org-1', account_id: 'account-1', tenant_id: null, tenant_name: null, name: 'テスト組織', status: 'active' },
  stores: [store],
  memberships: [],
  tables: [],
  menuItems: [
    { id: 'm1', store_id: 'store-1', kind: 'course', name: '秋の鹿肉コース', price: 8800, tax_mode: 'tax_included', allergens_json: '["小麦","乳"]', service_periods_json: '["dinner"]', duration_minutes: 120, status: 'active', confirmation_revision: 1 },
    { id: 'm2', store_id: 'store-1', kind: 'a_la_carte', name: '鹿肉のロースト', price: 2400, tax_mode: 'tax_included', allergens_json: '[]', service_periods_json: '["lunch","dinner"]', duration_minutes: null, status: 'active', confirmation_revision: 1 },
    { id: 'm3', store_id: 'store-1', kind: 'course', name: '夏の冷製コース', price: 6600, tax_mode: 'tax_included', allergens_json: '["小麦"]', service_periods_json: '["dinner"]', duration_minutes: 120, status: 'archived', confirmation_revision: 1 },
  ],
  reservations: [], reservationTotal: 0, inventory: [],
  approvals: [{ id: 'a1', store_id: 'store-1', kind: 'menu_change', title: '価格改定', status: 'pending', requested_by: null, review_comment: null, payload_json: null }],
  connectors: [], reviews: [], posts: [], lineFlows: [],
}

beforeEach(() => {
  fixture.snapshot.mockResolvedValue({ data })
  fixture.createMenu.mockResolvedValue({ success: true })
  fixture.updateMenu.mockResolvedValue({ success: true })
})
afterEach(() => { cleanup(); nav.params = new URLSearchParams('id=m1'); vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers() })

/*
 * ★V8-B メニュー管理（板 ）の契約。
 * 数5・決まりの帯・一覧の表（行末は「…」・アーカイブだけ再開）が出て、
 * 操作が今の口へ届くことを固定する。
 */
describe('MJoJR メニュー管理のV8', () => {
  it('数5と決まりの帯・一覧が出る', async () => {
    render(<MenuV8 />)
    await screen.findByText('メニュー一覧')
    const board = document.querySelector('[data-design-node="MJoJR"]')!
    for (const label of ['全メニュー', 'コース', '単品', '開始待ち', 'アレルギー登録']) {
      expect(board.textContent).toContain(label)
    }
    expect(board.textContent).not.toContain('要承認')
    expect(board.textContent).not.toContain('参照中のメニューは削除できません')
    fireEvent.click(screen.getByRole('button', { name: 'メニュー一覧の説明' }))
    expect(await screen.findByText(/参照中のメニューは削除できません/)).toBeTruthy()
    expect(board.textContent).toContain('秋の鹿肉コース')
    expect(board.textContent).toContain('ランチ・ディナー')
  })

  it('アーカイブだけ再開ボタンが出る', async () => {
    render(<MenuV8 />)
    await screen.findByText('メニュー一覧')
    expect(screen.getAllByRole('button', { name: '再開' })).toHaveLength(1)
  })

  it('変更のない編集は保存せず理由を知らせる', async () => {
    render(<MenuEditV8 />)
    await screen.findByDisplayValue('秋の鹿肉コース')
    const save = screen.getByRole('button', { name: '保存する' })
    expect(save.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('変更していません')).toBeTruthy()
    fireEvent.click(save)
    expect(fixture.updateMenu).not.toHaveBeenCalled()
  })

  it('編集ページ（mauOC）で変えた名前が今の口へ届く', async () => {
    render(<MenuEditV8 />)
    fireEvent.change(await screen.findByDisplayValue('秋の鹿肉コース'), { target: { value: '冬の鹿肉コース' } })
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    await waitFor(() => expect(fixture.updateMenu).toHaveBeenCalledWith('account-1', 'm1', expect.objectContaining({ name: '冬の鹿肉コース', expectedVersion: 1 })))
  })

  it('コースの所要時間を編集して保存する', async () => {
    render(<MenuEditV8 />)
    const duration = await screen.findByRole('button', { name: '所要時間' })
    expect(duration.textContent).toContain('2時間（120分）')
    fireEvent.click(duration)
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('button', { name: '1時間30分（90分）' }))
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    await waitFor(() => expect(fixture.updateMenu).toHaveBeenCalledWith('account-1', 'm1', expect.objectContaining({ durationMinutes: 90 })))
  })

  it('新規コースの所要時間は選んだ値を保存する', async () => {
    nav.params = new URLSearchParams('store=store-1')
    try {
      render(<MenuEditV8 />)
      const duration = await screen.findByRole('button', { name: '所要時間' })
      expect(duration.textContent).toContain('所要時間を選ぶ')
      expect(screen.getByRole('button', { name: '提供時間', exact: true }).textContent).toContain('提供時間帯を選ぶ')
      fireEvent.change(screen.getByLabelText('メニュー名'), { target: { value: '新コース' } })
      fireEvent.change(screen.getByLabelText('価格（税込）'), { target: { value: '5000' } })
      fireEvent.click(screen.getByRole('button', { name: '保存して追加する' }))
      expect(screen.getByText('所要時間を入力してください。')).toBeTruthy()
      expect(fixture.createMenu).not.toHaveBeenCalled()
      expect((screen.getByLabelText('メニュー名') as HTMLInputElement).value).toBe('新コース')
      fireEvent.click(duration)
      fireEvent.click(within(screen.getByRole('listbox')).getByRole('button', { name: '2時間30分（150分）' }))
      fireEvent.click(screen.getByRole('button', { name: '保存して追加する' }))
      await waitFor(() => expect(fixture.createMenu).toHaveBeenCalledWith('account-1', expect.objectContaining({ durationMinutes: 150, servicePeriods: [] })))
    } finally { nav.params = new URLSearchParams('id=m1') }
  })

  it('単品メニューの説明と店舗の登録画像を保存する', async () => {
    nav.params = new URLSearchParams('id=m2')
    vi.spyOn(api.media, 'list').mockResolvedValue({ success:true, data:{ items:[{id:'media-test',filename:'架空.png',lineAccountId:'account-1',kind:'image'}], total:1, limit:20, offset:0 } } as never)
    render(<MenuEditV8 />)
    fireEvent.change(await screen.findByLabelText('メニューの説明'), { target: { value: '季節の説明' } })
    fireEvent.click(screen.getByRole('button', { name: '登録メディアから選択する' }))
    fireEvent.click(await screen.findByRole('option', { name: /架空.png/ }))
    expect(screen.getByText('選択中の画像名を確認しています')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    await waitFor(() => expect(fixture.updateMenu).toHaveBeenCalledWith('account-1','m2',expect.objectContaining({ description:'季節の説明', imageMediaId:'media-test', expectedVersion: 1 })))
  })

  it('単品メニューの画像を読めない場合は選び直しを案内する', async () => {
    nav.params = new URLSearchParams('id=m2')
    fixture.snapshot.mockResolvedValue({ data: { ...data, menuItems: data.menuItems.map(item => item.id === 'm2' ? { ...item, image_media_id: 'missing-image' } : item) } })
    vi.spyOn(api.media, 'detail').mockResolvedValue({ success:true, data:{ item:{ filename:'missing.png' } } } as never)
    render(<MenuEditV8 />)
    const image = await screen.findByAltText('選択したメニューの画像')
    fireEvent.error(image)
    expect(await screen.findByText('画像を読めません。登録メディアから選び直してください。')).toBeTruthy()
    expect(screen.queryByText(/選択中：/)).toBeNull()
    expect(screen.queryByAltText('選択したメニューの画像')).toBeNull()
  })

  it('コースの既存画像を読めない場合は外し、店舗の登録写真を選び直せる', async () => {
    fixture.snapshot.mockResolvedValue({ data: { ...data, menuItems: data.menuItems.map(item =>
      item.id === 'm1' ? { ...item, image_media_id: 'missing-image' } : item) } })
    vi.spyOn(api.folders, 'list').mockResolvedValue({ success: true, data: [] })
    vi.spyOn(api.media, 'list').mockResolvedValue({ success: true, data: {
      items: [
        { id: 'media-test', filename: '料理.png', lineAccountId: 'account-1', kind: 'image' },
        { id: 'media-other', filename: '別の店舗.png', lineAccountId: 'account-2', kind: 'image' },
      ], total: 2, limit: 20, offset: 0,
    } } as never)
    render(<MenuEditV8 />)
    fireEvent.click(await screen.findByRole('button', { name: '写真 1 の表示範囲を調整' }))
    const adjustment = screen.getByRole('dialog', { name: '写真の表示範囲を調整' })
    fireEvent.error(within(adjustment).getByAltText('写真 1 の表示見本'))
    expect(within(adjustment).getByText('画像なし')).toBeTruthy()
    fireEvent.click(within(adjustment).getByRole('button', { name: 'キャンセル' }))
    const warning = '画像を読めません。読めない写真を外し、登録メディアから選び直してください。'
    expect(screen.getByText(warning)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '写真 1 の表示範囲を調整' }))
    fireEvent.click(screen.getByRole('button', { name: '写真を外す' }))
    expect(screen.queryByText(warning)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '写真を追加' }))
    const gallery = within(screen.getByRole('dialog', { name: 'コースの写真を選ぶ' }))
    const photo = await gallery.findByRole('checkbox', { name: '料理.png' })
    expect(gallery.queryByRole('checkbox', { name: '別の店舗.png' })).toBeNull()
    fireEvent.click(photo)
    expect(photo.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(gallery.getByRole('button', { name: '1枚を追加' }))
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    await waitFor(() => expect(fixture.updateMenu).toHaveBeenCalledExactlyOnceWith('account-1', 'm1',
      expect.objectContaining({ photos: [{ mediaId: 'media-test', x: 50, y: 50 }], expectedVersion: 1 })))
  })

  it('画像が利用できず保存に失敗したら画像欄に選び直しを案内する', async () => {
    fixture.updateMenu.mockRejectedValueOnce(new ApiError(400, '画像を選び直してください', 'MENU_IMAGE_UNAVAILABLE'))
    render(<MenuEditV8 />)
    fireEvent.change(await screen.findByDisplayValue('秋の鹿肉コース'), { target:{value:'変更した名前'} })
    fireEvent.click(screen.getByRole('button', { name:'保存する' }))
    expect(await screen.findByText('選択した画像を利用できません。登録メディアから選び直してください。')).toBeTruthy()
    expect(screen.getByDisplayValue('変更した名前')).toBeTruthy()
  })

  it('必須項目がない時は保存できない理由を表示する', async () => {
    nav.params = new URLSearchParams('store=store-1')
    try {
      render(<MenuEditV8 />)
      expect(await screen.findByText('名前と値段を入力してください。')).toBeTruthy()
      expect((screen.getByRole('button', { name:'保存して追加する' }) as HTMLButtonElement).disabled).toBe(true)
    } finally { nav.params = new URLSearchParams('id=m1') }
  })

  it('変更は窓（NkmwU）ではなく 1 枚の編集ページ（板 mauOC）', async () => {
    render(<MenuEditV8 />)
    await screen.findByDisplayValue('秋の鹿肉コース')
    expect(document.querySelector('[data-design-node="mauOC"]')).not.toBeNull()
    expect(document.querySelector('[data-design-node="NkmwU"]')).toBeNull()
  })

  it('停止の確認に板 MV5Os の印が付く', async () => {
    render(<MenuV8 />)
    await screen.findByText('メニュー一覧')
    const row = screen.getByText('秋の鹿肉コース').closest('tr')!
    fireEvent.click(within(row).getByRole('button', { name: /その他操作|操作/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: '停止' }))
    expect(document.querySelector('[data-design-node="MV5Os"]')).not.toBeNull()
  })
})

it('申請中と承認済み開始待ちの新価格を現行価格と併記する',async()=>{
 fixture.snapshot.mockResolvedValue({data:{...data,menuItems:data.menuItems.map((m,i)=>i===0?{...m,pendingPrice:9900,priceChangeStatus:'approved',pendingEffectiveAt:'2099-10-10T00:00:00Z'}:m)}})
 render(<MenuV8 />)
 const row = (await screen.findByText('秋の鹿肉コース')).closest('tr')!
 expect(within(row).getByText('開始待ち')).not.toBeNull()
 expect(screen.getByText('¥8,800')).not.toBeNull()
 expect(screen.getByTitle(/^新価格 ¥9,900/)).not.toBeNull()
})
it.each(['2026-10-11T15:09:00Z','2026-10-11T23:59:00Z'])('日本時間00:09・08:59でも価格変更の開始日時を添えて確認後に保存する（%s）',async(now)=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(now))
 render(<MenuEditV8 />)
 fireEvent.change(await screen.findByLabelText('価格（税込）'),{target:{value:'9900'}})
 fireEvent.click(screen.getByLabelText('新しい価格の開始日時'))
 const picker=screen.getByRole('dialog',{name:'日時を選ぶ'})
 fireEvent.click(screen.getByRole('button',{name:'次の月'}))
 const next=new Date();next.setDate(1);next.setMonth(next.getMonth()+1)
 fireEvent.click(screen.getAllByRole('button').find(b=>(b.getAttribute('aria-label')??'').startsWith(`${next.getFullYear()}年${next.getMonth()+1}月10日`))!)
 fireEvent.click(screen.getByRole('button',{name:'確定'}))
 const ymd=`${next.getFullYear()}-${String(next.getMonth()+1).padStart(2,'0')}-10`
 expect(screen.queryByRole('button',{name:'保存して申請する'})).toBeNull()
 fireEvent.click(screen.getByRole('button',{name:'保存する'}))
 const confirm=screen.getByRole('dialog',{name:'価格変更を確定しますか？'})
 expect(fixture.updateMenu).not.toHaveBeenCalled()
 fireEvent.click(within(confirm).getByRole('button',{name:'確定して保存する'}))
 await waitFor(()=>expect(fixture.updateMenu).toHaveBeenCalledWith('account-1','m1',expect.objectContaining({price:9900,effectiveAt:new Date(`${ymd}T10:00:00+09:00`).toISOString()})))
})
