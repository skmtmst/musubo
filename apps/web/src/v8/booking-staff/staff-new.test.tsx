
import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import StaffNewV8 from './staff-new'
import { pickEntities } from '@/components/shared/entity-picker-test-helpers'
// @vitest-environment happy-dom
/*
 * ★V8 予約スタッフを登録の動き。
 * - メニューのチェックは4つまで並べ、残りは「ほかのメニュー（n）」で開く（絵は1行に4つ）。
 * - 右の見本の「指名なし」は、指名なしの枠に入る担当が1人でもいれば出る。
 */

const fixture = vi.hoisted(() => ({ staff: [] as Array<Record<string, unknown>>, listStaff: vi.fn(), create: vi.fn(), assign: vi.fn(), update: vi.fn() }))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }));

vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-a', selectedAccount: null }) }));

vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => undefined, usePageCrumbs: () => undefined }));


const MENUS = ['カット', 'シャンプー', '爪切り', '歯みがき', '足裏ケア', '毛刈り'].map((name, i) => ({
  id: `m-${i}`, name, duration_minutes: 30, base_price: 1000, price_mode: 'fixed', is_active: 1, sort_order: i,
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: { media: {contentUrl:()=> 'https://fixture.invalid/photo.png',list:async()=>({success:true,data:{items:[{id:'photo',filename:'人工画像',kind:'image',url:'https://fixture.invalid/photo.png',lineAccountId:'account-a'}],total:1}})}, staff: { me: async () => ({ success: true, data: { role: 'owner' } }), list: async () => ({ success: true, data: [] }) } },
    bookingApi: {
      listMenus: async () => ({ menus: MENUS }),
      listStaff: (...args: unknown[]) => fixture.listStaff(...args),
      createStaff: (...args: unknown[]) => fixture.create(...args),
      updateStaff: (...args: unknown[]) => fixture.update(...args),
      putStaffMenus: (...args: unknown[]) => fixture.assign(...args),
    },
  }
});


const memStorage = vi.hoisted(() => {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key) },
    setItem: (key: string, value: string) => { values.set(key, String(value)) },
  }
})
vi.stubGlobal('localStorage', memStorage)

beforeEach(() => {
  fixture.listStaff.mockReset().mockImplementation(async () => ({staff: fixture.staff}))
  memStorage.setItem('lh_staff_role', 'owner')
  fixture.create.mockReset().mockResolvedValue({ id: 'created' })
  fixture.update.mockReset().mockResolvedValue({ ok: true })
  fixture.assign.mockReset()
  fixture.staff = [
    { id: 'bs-1', name: '見本 110', display_name: '佐々木', role: 'トリマー', sort_order: 1, is_designation_optional: 0, is_active: 1 },
  ]
})
afterEach(() => {
  cleanup()
  memStorage.clear()
})

describe('予約スタッフを登録（V8）', () => {
  test('予約メニューは窓の中で全件から探して選べる', async () => {
    render(<StaffNewV8 />)
    fireEvent.click(await screen.findByRole('button', { name: '予約を受けられるメニュー' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getAllByRole('checkbox').filter(item => item.closest('[data-setting-checkbox]') === null)).toHaveLength(6)
    expect(within(dialog).getByRole('checkbox', { name: '足裏ケア' })).toBeTruthy()
  })

  test('指名なしの枠に入る担当がいなければ、見本に「指名なし」を出さない。スイッチを入れると出る', async () => {
    render(<StaffNewV8 />)
    const phone = await screen.findByRole('region', { name: 'お客さまの予約画面の見本' })
    await screen.findByRole('button', { name: '予約を受けられるメニュー' })
    expect(within(phone).queryByText('指名なし')).toBeNull()
    fireEvent.click(screen.getByRole('switch', { name: '「指名なし」の枠にも含める' }))
    expect(within(phone).getByText('指名なし')).toBeTruthy()
  })

  test('登録済みの担当に指名なしの人がいれば、最初から「指名なし」を出す', async () => {
    fixture.staff = [...fixture.staff, { id: 'bs-2', name: '見本 30', display_name: '中川', role: '受付', sort_order: 2, is_designation_optional: 1, is_active: 1 }]
    render(<StaffNewV8 />)
    const phone = await screen.findByRole('region', { name: 'お客さまの予約画面の見本' })
    expect(await within(phone).findByText('指名なし')).toBeTruthy()
  })
})

 test('WEB186：割当の再試行前に直した名前も登録済みスタッフに保存する', async () => {
    fixture.assign.mockRejectedValueOnce(new Error('network')).mockResolvedValue({ ok: true })
    render(<StaffNewV8 />)
    await screen.findByRole('button', { name: '予約を受けられるメニュー' })
    fireEvent.change(screen.getByLabelText('スタッフ名（管理画面での呼び名）'), { target: { value: '田中' } })
    await pickEntities('予約を受けられるメニュー', [ 'カット'])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'スタッフを登録する' })) })
    await screen.findByRole('button', { name: '割当をやり直す' })
    fireEvent.change(screen.getByLabelText('スタッフ名（管理画面での呼び名）'), { target: { value: '見本 170' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '割当をやり直す' })) })
    await waitFor(() => expect(fixture.assign).toHaveBeenCalledTimes(2))
    expect(fixture.create).toHaveBeenCalledTimes(1)
    expect(fixture.update).toHaveBeenCalledWith('account-a', 'created', expect.objectContaining({ name: '見本 170' }))
 })

test('REM3-06 new staff can choose registered media and save its public URL',async()=>{
 render(<StaffNewV8 />)
 await screen.findByRole('button',{name:'予約を受けられるメニュー'})
 fireEvent.change(screen.getByLabelText('スタッフ名（管理画面での呼び名）'),{target:{value:'人工スタッフ'}})
 await pickEntities('予約を受けられるメニュー',['カット'])
 fireEvent.click(screen.getByRole('button',{name:'登録メディアから選ぶ'}))
 fireEvent.click(await screen.findByRole('option',{name:/人工画像/}))
 fireEvent.click(screen.getByRole('button',{name:'スタッフを登録する'}))
 await waitFor(()=>expect(fixture.create).toHaveBeenCalled())
 expect(fixture.create.mock.calls[0][1]).toMatchObject({profile_image_url:'https://fixture.invalid/photo.png'})
})

 test('担当見本の取得失敗は空にせず、読み直して指名なしの担当を復帰する', async () => {
    fixture.staff = [{id:'bs-2',name:'担当',display_name:'担当',role:'受付',sort_order:2,is_designation_optional:1,is_active:1}]
    fixture.listStaff.mockRejectedValueOnce(new Error('fixture failure'))
    render(<StaffNewV8 />)
    const error = await screen.findByText('担当の見本を読み込めませんでした')
    const phone = screen.getByRole('region', {name:'お客さまの予約画面の見本'})
    expect(within(phone).queryByText('指名なし')).toBeNull()
    fireEvent.click(error.closest('[data-list-state="error"]')!.querySelector('button')!)
    expect(await within(phone).findByText('指名なし')).toBeTruthy()
    expect(fixture.listStaff).toHaveBeenCalledTimes(2)
  })

 test('F7: 名前の必須・誤りの接続と見本を閉じた後の入力を保つ', async () => {
    const { container } = render(<StaffNewV8 />)
    await screen.findByRole('button', { name: '予約を受けられるメニュー' })
    const name = screen.getByRole('textbox', { name: 'スタッフ名（管理画面での呼び名）' })
    expect(name.getAttribute('aria-required')).toBe('true')
    fireEvent.blur(name)
    await waitFor(() => expect(name.getAttribute('aria-invalid')).toBe('true'))
    const reason = name.getAttribute('aria-describedby')!.split(' ').map(id => document.getElementById(id)?.textContent).join(' ')
    expect(reason).toContain('スタッフ名')
    fireEvent.change(name, { target: { value: '入力を残す担当者' } })
    await waitFor(() => expect(name.getAttribute('aria-invalid')).not.toBe('true'))
    fireEvent.click(screen.getByRole('button', { name: '予約画面での見え方を見る' }))
    const preview = screen.getByRole('dialog', { name: '予約画面での見え方' })
    expect(within(preview).getByText('入力を残す担当者')).toBeTruthy()
    fireEvent.click(within(preview).getByRole('button', { name: '閉じる' }))
    expect(screen.queryByRole('dialog', { name: '予約画面での見え方' })).toBeNull()
    expect((name as HTMLInputElement).value).toBe('入力を残す担当者')
    const footer = container.querySelector('[data-template-region="footer"]')!
    expect(within(footer as HTMLElement).getByRole('button', { name: 'スタッフを登録する' }).querySelector('svg.lucide-save')).toBeTruthy()
    expect(container.querySelectorAll('[data-form-row="columns"]')).toHaveLength(1)
    expect(screen.queryByRole('checkbox', { name: '店舗の営業時間に合わせる' })).toBeNull()
    expect(screen.queryByRole('button', { name: /予約枠の色/ })).toBeNull()
 })

 test.each([false, true])('F7-D: 既存4人でも編集中の担当を見本で読める（指名なし=%s）', async (designationFree) => {
    fixture.staff = Array.from({ length: 4 }, (_, index) => ({ id: `existing-${index}`, name: `既存担当${index}`, display_name: `既存担当${index}`, role: '担当', sort_order: index, is_designation_optional: 0, is_active: 1 }))
    render(<StaffNewV8 />)
    await screen.findByRole('button', { name: '予約を受けられるメニュー' })
    fireEvent.change(screen.getByRole('textbox', { name: 'スタッフ名（管理画面での呼び名）' }), { target: { value: '新しい担当' } })
    if (designationFree) fireEvent.click(screen.getByRole('switch', { name: '「指名なし」の枠にも含める' }))
    const phone = screen.getByRole('region', { name: 'お客さまの予約画面の見本' })
    expect(within(phone).getByText('新しい担当')).toBeTruthy()
    for (let index = 0; index < 4; index++) expect(within(phone).getByText(`既存担当${index}`)).toBeTruthy()
    expect(within(phone).getAllByText(/既存担当|新しい担当/).map(node => node.textContent)).toEqual(['新しい担当', '既存担当0', '既存担当1', '既存担当2', '既存担当3'])
 })

test('入力中の担当を先頭に示し、既存担当・空欄・非公開も区別する', async () => {
  render(<StaffNewV8 />)
  const phone = await screen.findByRole('region', { name: 'お客さまの予約画面の見本' })
  expect(await within(phone).findByText('佐々木')).toBeTruthy()
  expect(within(phone).getByText('表示名を入れるとここに出ます')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('お客さま向けの表示名（空欄なら上の名前）'), { target: { value: 'はなこ' } })
  expect(within(phone).getByText('入力中・未保存')).toBeTruthy()
  expect(within(phone).getByText('はなこ').compareDocumentPosition(within(phone).getByText('佐々木')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  fireEvent.click(screen.getByRole('switch', { name: '登録したらすぐ予約を受ける' }))
  expect(within(phone).getByText('スタッフ・登録後は非表示')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('お客さま向けの表示名（空欄なら上の名前）'), { target: { value: '' } })
  expect(within(phone).queryByText('入力中・未保存')).toBeNull()
  expect(within(phone).getByText('表示名を入れるとここに出ます')).toBeTruthy()
  expect(fixture.create).not.toHaveBeenCalled()
})

test('指名料（B9）：管理者が入れた額を登録に載せ、右の見本にも「指名料 +¥」で出す', async () => {
  render(<StaffNewV8 />)
  await screen.findByRole('button', { name: '予約を受けられるメニュー' })
  fireEvent.change(screen.getByLabelText('スタッフ名（管理画面での呼び名）'), { target: { value: '田中' } })
  await pickEntities('予約を受けられるメニュー', ['カット'])
  fireEvent.change(await screen.findByLabelText('指名料'), { target: { value: '500' } })
  const phone = screen.getByRole('region', { name: 'お客さまの予約画面の見本' })
  expect(within(phone).getByText(/指名料 \+¥500/)).toBeTruthy()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'スタッフを登録する' })) })
  await waitFor(() => expect(fixture.create).toHaveBeenCalledWith('account-a', expect.objectContaining({ nominationFee: 500 })))
})
