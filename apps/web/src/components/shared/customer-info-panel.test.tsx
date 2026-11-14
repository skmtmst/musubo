// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { api } from '@/lib/api'
import { BASIC_FRIEND_FIELDS as FIXED_FRIEND_FIELDS, type FriendField } from '@line-crm/shared'
import CustomerInfoPanel from './customer-info-panel'
import { fixedFieldValue } from './fixed-friend-field-values'
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }))
vi.mock('next/link', () => ({default:({children,...props}: React.ComponentProps<'a'>)=><a {...props}>{children}</a>}))
vi.mock('@/lib/api', async original => ({...await original<typeof import('@/lib/api')>(),api:{friendFields:{saveForFriend:vi.fn()}}}))
const fields = FIXED_FRIEND_FIELDS.map((spec,index) => ({
  id:spec.key, name:spec.label, fixedKey:spec.key, type:'text', isPersonal:true, value:spec.key==='birthday'?'2000-01-01':spec.key==='age'?'18':spec.key==='name'?'山田花子':null,
  valueSource:spec.key==='birthday'?{type:'form',id:'form',name:'登録'}:null,
  valueUpdatedAt:'2026-10-08T10:12:00+09:00', displayOrder:index,
})) as FriendField[]
const storage = new Map<string, string>()
beforeEach(() => {
  vi.mocked(api.friendFields.saveForFriend).mockReset()
  storage.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
test('birthday takes priority, fallback age and source match the displayed value',()=>{
  expect(fixedFieldValue(fields,'age',new Date('2026-10-10T00:00:00Z'))).toMatchObject({value:'26',derived:true})
  expect(fixedFieldValue(fields,'age').source).toContain('回答フォーム『登録』から 10/08 10:12')
  expect(fixedFieldValue(fields.filter(f=>f.fixedKey!=='birthday'),'age')).toEqual({value:'18',derived:false,source:'手で入れた',label:'手で入れた'})
})
test('birthday with derived age and allergy, visible basics, shared display preferences persist only after save',()=>{
  const props={friendId:'f',fields,state:'ready' as const,canEdit:true,sections:[{key:'tags',label:'タグ',content:<p>VIP</p>}]}
  const first=render(<CustomerInfoPanel {...props}/>)
  for(const spec of FIXED_FRIEND_FIELDS.filter(f=>f.key!=='age')) expect(screen.getByText(spec.label)).toBeTruthy()
  expect(screen.queryByText('年齢')).toBeNull()
  expect(screen.getByText(/2000年1月1日（\d+歳）/)).toBeTruthy()
  expect(screen.getByRole('button',{name:'編集'})).toBeTruthy()
  fireEvent.click(screen.getByRole('button',{name:'表示項目を編集'}))
  fireEvent.click(screen.getByRole('checkbox',{name:'タグ'}))
  fireEvent.click(screen.getByRole('button',{name:'保存する'}))
  expect(JSON.parse(localStorage.getItem('chat.friendInfoSections.v4')!).hidden).toContain('tags')
  first.unmount()
  render(<CustomerInfoPanel {...props} canEdit/>)
  expect(screen.getByRole('button', {name:'編集'})).toBeTruthy()
  expect(screen.queryByText('VIP')).toBeNull()
})
test('failed fetch is shown with retry instead of unregistered values',()=>{
  const onRetry=vi.fn()
  render(<CustomerInfoPanel friendId="f" fields={[]} state="error" canEdit={false} sections={[]} onRetry={onRetry}/>)
  expect(screen.queryByText('未登録')).toBeNull()
  fireEvent.click(screen.getByRole('button',{name:'もう一度読み込む'}))
  expect(onRetry).toHaveBeenCalledOnce()
})

test('個々の基本欄と追加の節を隠せ、閉じても別画面へ設定を引き継ぐ', () => {
  const props = { friendId: 'f', fields, state: 'ready' as const, canEdit: true, sections: [], extraSections: [{ key: 'forms', label: 'フォーム回答', content: <p>回答履歴</p> }] };
  const first = render(<CustomerInfoPanel {...props} />);
  fireEvent.click(screen.getByRole('button', { name: '表示項目を編集' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'メール' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'フォーム回答' }));
  fireEvent.click(screen.getByRole('button', { name: '保存する' }));
  first.unmount();
  render(<CustomerInfoPanel {...props} />);
  expect(screen.queryByText('メール')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '顧客情報をすべて表示' }));
  expect(screen.queryByText('回答履歴')).toBeNull();
});

test('基本の編集は取消で送らず、失敗では値を保ち、保存した値だけ送る', async () => {
  render(<CustomerInfoPanel friendId="f" fields={fields} state="ready" canEdit sections={[]} />)
  fireEvent.click(screen.getByRole('button',{name:'編集'}))
  fireEvent.change(screen.getByRole('textbox',{name:'名前'}),{target:{value:'変更した名前'}})
  fireEvent.click(screen.getByRole('button',{name:'キャンセル'}))
  fireEvent.click(screen.getByRole('button',{name:'保存せずに移る'}))
  expect(api.friendFields.saveForFriend).not.toHaveBeenCalled()
  expect(screen.getByText('山田花子')).toBeTruthy()
  fireEvent.click(screen.getByRole('button',{name:'編集'}))
  fireEvent.change(screen.getByRole('textbox',{name:'名前'}),{target:{value:'新しい名前'}})
  vi.mocked(api.friendFields.saveForFriend).mockResolvedValueOnce({success:false,error:'保存失敗'} as never)
  fireEvent.click(screen.getByRole('button',{name:'保存する'}))
  await waitFor(()=>expect(screen.getByRole('alert').textContent).toBe('保存できませんでした。時間をおいて、もう一度お試しください。'))
  expect((screen.getByRole('textbox',{name:'名前'}) as HTMLInputElement).value).toBe('新しい名前')
  vi.mocked(api.friendFields.saveForFriend).mockResolvedValueOnce({success:true} as never)
  fireEvent.click(screen.getByRole('button',{name:'保存する'}))
  await waitFor(()=>expect(screen.getByText('新しい名前')).toBeTruthy())
  expect(api.friendFields.saveForFriend).toHaveBeenLastCalledWith('f',{name:'新しい名前'})
})

test('既存の並びを保ち、上下キーの変更を保存する。顧客の値は手元へ保存しない', () => {
  localStorage.setItem('chat.friendInfoSections.v4', JSON.stringify({ order: ['tags', 'support'], hidden: [] }));
  render(<CustomerInfoPanel friendId="f" fields={fields} state="ready" canEdit sections={[
    { key: 'support', label: '対応', content: '対応内容' }, { key: 'tags', label: 'タグ', content: 'タグ内容' },
  ]} />);
  fireEvent.click(screen.getByRole('button', { name: '表示項目を編集' }));
  fireEvent.keyDown(screen.getByRole('button', { name: /対応.*並び/ }), { key: 'ArrowUp' });
  fireEvent.click(screen.getByRole('button', { name: '保存する' }));
  const saved = localStorage.getItem('chat.friendInfoSections.v4')!;
  expect(JSON.parse(saved).order.slice(0,2)).toEqual(['support', 'tags']);
  expect(saved).not.toContain('山田花子');
});

test('閲覧のみでは基本の編集と表示項目の変更を灰色で出し、押しても開かない',()=>{
 render(<CustomerInfoPanel friendId="f" fields={fields} state="ready" canEdit={false} sections={[]}/>);
 for (const name of ['編集','表示項目を編集']) { const el=screen.getByRole('button',{name}); expect(((el: HTMLElement) => el.getAttribute('aria-disabled') === 'true' || (el as HTMLButtonElement).disabled)(el)).toBe(true); fireEvent.click(el) }
 expect(screen.queryByRole('textbox')).toBeNull();
})

test('生年月日が未登録なら回答年齢を表示して編集でき、年齢だけの表示設定も保存できる', async () => {
  const withoutBirthday = fields.map(field => field.fixedKey === 'birthday' ? {...field, value:null} : field)
  render(<CustomerInfoPanel friendId="f" fields={withoutBirthday} state="ready" canEdit sections={[]}/>)
  expect(screen.getByText('年齢')).toBeTruthy()
  expect(screen.getByText('18')).toBeTruthy()
  fireEvent.click(screen.getByRole('button',{name:'編集'}))
  fireEvent.change(screen.getByRole('textbox',{name:'年齢'}),{target:{value:'19'}})
  vi.mocked(api.friendFields.saveForFriend).mockResolvedValueOnce({success:true} as never)
  fireEvent.click(screen.getByRole('button',{name:'保存する'}))
  await waitFor(()=>expect(screen.getByText('19')).toBeTruthy())
  expect(api.friendFields.saveForFriend).toHaveBeenLastCalledWith('f',{age:'19'})
  fireEvent.click(screen.getByRole('button',{name:'表示項目を編集'}))
  fireEvent.click(screen.getByRole('checkbox',{name:'年齢'}))
  fireEvent.click(screen.getByRole('button',{name:'保存する'}))
  expect(screen.queryByText('年齢')).toBeNull()
  expect(JSON.parse(localStorage.getItem('chat.friendInfoSections.v4')!).hidden).toContain('fixed:age')
})

const diningFields: FriendField[] = [
  ...fields,
  { ...fields[0], id: 'anniversary', name: '記念日', fixedKey: 'anniversary', type: 'date', value: '2026-10-10', valueSource: null },
  { ...fields[0], id: 'seat', name: '席の好み', fixedKey: 'seat_preference', value: null, valueSource: null },
]

test('飲食の要点は基本の後に同じ順で並び、空の値とアレルギーの重複を作らない', () => {
  render(<CustomerInfoPanel friendId="f" fields={diningFields} state="ready" canEdit={false} sections={[]} includeDiningFields />)
  const labels = [...document.querySelectorAll('dt')].map(node => node.textContent)
  expect(labels.slice(-3)).toEqual(['アレルギー', '記念日', '席の好み'])
  expect(labels.filter(label => label === 'アレルギー')).toHaveLength(1)
  expect(screen.getByText('2026年10月10日')).toBeTruthy()
  expect(screen.getByText('席の好み').parentElement?.querySelector('dd')?.textContent).toBe('未設定')
  for (const el of screen.queryAllByRole('button', { name: '編集' })) expect(((el: HTMLElement) => el.getAttribute('aria-disabled') === 'true' || (el as HTMLButtonElement).disabled)(el)).toBe(true)
})

test('標準の要点は飲食の値が残っていても基本だけで、飲食への切替と戻しを分ける', () => {
  const props = { friendId: 'f', fields: diningFields, state: 'ready' as const, canEdit: false, sections: [] }
  const view = render(<CustomerInfoPanel {...props} />)
  expect(screen.queryByText('記念日')).toBeNull()
  expect(screen.queryByText('席の好み')).toBeNull()
  view.rerender(<CustomerInfoPanel {...props} includeDiningFields />)
  expect(screen.getByText('記念日')).toBeTruthy()
  view.rerender(<CustomerInfoPanel {...props} includeDiningFields={false} />)
  expect(screen.queryByText('記念日')).toBeNull()
})

test('飲食の値も変更した欄だけ保存し、表示項目の好みで隠せる', async () => {
  render(<CustomerInfoPanel friendId="f" fields={diningFields} state="ready" canEdit sections={[]} includeDiningFields />)
  fireEvent.click(screen.getByRole('button', { name: '編集' }))
  fireEvent.change(screen.getByRole('textbox', { name: '席の好み' }), { target: { value: '窓側' } })
  vi.mocked(api.friendFields.saveForFriend).mockResolvedValueOnce({ success: true } as never)
  fireEvent.click(screen.getByRole('button', { name: '保存する' }))
  await waitFor(() => expect(screen.getByText('窓側')).toBeTruthy())
  expect(api.friendFields.saveForFriend).toHaveBeenLastCalledWith('f', { seat: '窓側' })
  fireEvent.click(screen.getByRole('button', { name: '表示項目を編集' }))
  expect((screen.getByRole('checkbox', { name: '記念日' }) as HTMLInputElement).checked).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: '席の好み' }))
  fireEvent.click(screen.getByRole('button', { name: '保存する' }))
  expect(screen.queryByText('席の好み')).toBeNull()
  expect(JSON.parse(localStorage.getItem('chat.friendInfoSections.v4')!).hidden).toContain('fixed:seat_preference')
})

test('基本の編集は Escape の確認後に破棄し、保存しない', () => {
  render(<CustomerInfoPanel friendId="f" fields={fields} state="ready" canEdit sections={[]} />)
  fireEvent.click(screen.getByRole('button', { name: '編集' }))
  const name = screen.getByRole('textbox', { name: '名前' })
  fireEvent.change(name, { target: { value: '未保存の変更' } })
  fireEvent.keyDown(name, { key: 'Escape' })
  fireEvent.click(screen.getByRole('button', { name: '保存せずに移る' }))
  expect(screen.queryByRole('textbox', { name: '名前' })).toBeNull()
  expect(screen.getByText('山田花子')).toBeTruthy()
  expect(api.friendFields.saveForFriend).not.toHaveBeenCalled()
})

test('変更がなければ確認なしで閉じ、編集ボタンへ焦点を戻す', () => {
  render(<CustomerInfoPanel friendId="f" fields={fields} state="ready" canEdit sections={[]} />)
  fireEvent.click(screen.getByRole('button', { name: '編集' }))
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '名前' }))
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(screen.queryByRole('textbox', { name: '名前' })).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '編集' }))
})

test('顧客情報の窓の中でも Escape は基本の編集だけを閉じる', () => {
  const onKey = vi.fn()
  document.addEventListener('keydown', onKey)
  render(<div role="dialog" aria-label="顧客情報"><CustomerInfoPanel friendId="f" fields={fields} state="ready" canEdit sections={[]} /></div>)
  fireEvent.click(screen.getByRole('button', { name: '編集' }))
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(screen.queryByRole('textbox', { name: '名前' })).toBeNull()
  expect(screen.getByRole('dialog', { name: '顧客情報' })).toBeTruthy()
  expect(onKey).not.toHaveBeenCalled()
  document.removeEventListener('keydown', onKey)
})

test.each(['Escape', 'キャンセル'])('未保存の基本情報を%sで閉じる時は確認し、破棄後に編集ボタンへ戻る', (action) => {
  render(<CustomerInfoPanel friendId="f" fields={fields} state="ready" canEdit sections={[]} />)
  fireEvent.click(screen.getByRole('button', { name: '編集' }))
  const input = screen.getByRole('textbox', { name: '名前' }) as HTMLInputElement
  fireEvent.change(input, { target: { value: '入力途中' } })
  if (action === 'Escape') fireEvent.keyDown(input, { key: 'Escape' })
  else fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  expect(screen.getByText('保存していない変更があります')).toBeTruthy()
  expect(input.value).toBe('入力途中')
  fireEvent.click(screen.getByRole('button', { name: '編集を続ける' }))
  expect(input.value).toBe('入力途中')
  if (action === 'Escape') fireEvent.keyDown(input, { key: 'Escape' })
  else fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  fireEvent.click(screen.getByRole('button', { name: '保存せずに移る' }))
  expect(screen.queryByRole('textbox', { name: '名前' })).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '編集' }))
})
