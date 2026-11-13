// @vitest-environment happy-dom
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ read:vi.fn(), save:vi.fn(), postal:vi.fn(), name:vi.fn(), role:'owner' as string|null, nameSave:vi.fn() }))
vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => ({
  ...(await importOriginal()), api:{tenants:{companyContact:mocks.read,saveCompanyContact:mocks.save,me:mocks.name,updateName:mocks.nameSave},postalCode:{search:mocks.postal}},
}))
vi.mock('@/lib/staff-role', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/staff-role')>(),useStaffRole:()=>mocks.role}))
vi.mock('@/components/shell/page-chrome', () => ({usePageCrumbs:()=>{},usePageTitle:()=>{}}))
vi.mock('next/navigation', () => ({useRouter:()=>({push:vi.fn(),replace:vi.fn()}),usePathname:()=>'/hq/settings',useSearchParams:()=>new URLSearchParams()}))
vi.mock('next/link', () => ({default:({children,href,...props}: React.AnchorHTMLAttributes<HTMLAnchorElement>)=><a href={href} {...props}>{children}</a>}))

import CompanyContactCard from './company-contact'
import HqSettingsV8 from './settings'

const values = {legalCompanyName:'株式会社テスト',postalCode:'1500001',address:'東京都渋谷区神宮前1-2-3',building:null,
  phone:'03-0000-5678',contactName:'見本 141',contactEmail:'yamada@example.com',invoiceAddressee:null}
const field = (label: string) => screen.getByLabelText(new RegExp(`^${label.replace(/[（ ）]/g,'\\$&')}`)) as HTMLInputElement
const submit = () => fireEvent.submit(screen.getByRole('form',{name:'会社と連絡先'}))
const loaded = () => waitFor(()=>expect(field('会社名（正式）').value).toBe(values.legalCompanyName))
const renderCard = async (canEdit=true) => {render(<><CompanyContactCard canEdit={canEdit}/><ToastHost /></>);await loaded()}

beforeEach(()=>{clearToastsForTest();
  vi.resetAllMocks();mocks.role='owner'
  mocks.read.mockResolvedValue({success:true,data:{...values,revision:4}})
  mocks.save.mockResolvedValue({success:true,data:{...values,revision:5}})
  mocks.name.mockResolvedValue({success:true,data:{name:'統括の名前'}})
  mocks.nameSave.mockResolvedValue({success:true,data:{name:'新しい統括名'}})
})
afterEach(cleanup)

it('統括の情報は変更前も保存の場所と押せない理由が分かり、変更後に保存できる', async () => {
  render(<HqSettingsV8 />)
  await loaded()
  const save = screen.getByRole('button', { name: '保存する' }) as HTMLButtonElement
  expect(save.disabled).toBe(true)
  expect(screen.getAllByText('変更していません').length).toBeGreaterThan(0)
  fireEvent.change(field('会社名（正式）'), { target: { value: '新しい会社名' } })
  await waitFor(() => expect(save.disabled).toBe(false))
})

describe('会社と連絡先の画面の動き',()=>{
  it('郵便番号と電話は文字数でなく入力形式の見本で案内する',async()=>{
    await renderCard()
    expect(field('郵便番号').placeholder).toBe('例：123-4567')
    expect(field('電話番号').placeholder).toBe('例：03-0000-5678')
  })

  it('編集した8欄と読み込んだ版を保存し、返された値と新しい版を次の保存に使う',async()=>{
    await renderCard()
    fireEvent.change(field('会社名（正式）'),{target:{value:'  新しい正式名  '}})
    fireEvent.change(field('建物名・部屋番号'),{target:{value:'ビル5階'}})
    fireEvent.change(field('請求書の宛名'),{target:{value:'経理部'}})
    mocks.save.mockResolvedValueOnce({success:true,data:{...values,legalCompanyName:'新しい正式名',building:'ビル5階',invoiceAddressee:'経理部',revision:5}})
    submit()
    await waitFor(()=>expect(screen.getByRole('status').textContent).toContain('会社と連絡先を保存しました。'))
    expect(mocks.save).toHaveBeenCalledWith({...values,phone:'0300005678',legalCompanyName:'新しい正式名',building:'ビル5階',invoiceAddressee:'経理部',expectedRevision:4})
    expect(field('会社名（正式）').value).toBe('新しい正式名')
    fireEvent.change(field('担当者名'),{target:{value:'次の担当者'}})
    submit()
    await waitFor(()=>expect(mocks.save).toHaveBeenCalledTimes(2))
    expect(mocks.save.mock.calls[1][0].expectedRevision).toBe(5)
  })
  it.each(['０９０－００００－５６７８','090 0000 5678'])('電話の入力%sは数字だけで保存する',async phone=>{
    await renderCard()
    fireEvent.change(field('電話番号'),{target:{value:phone}})
    submit()
    await waitFor(()=>expect(mocks.save).toHaveBeenCalledTimes(1))
    expect(mocks.save).toHaveBeenCalledWith({...values,phone:'09000005678',expectedRevision:4})
  })
  it('国内番号にならない電話は入力を残し、保存しない',async()=>{
    await renderCard()
    fireEvent.change(field('電話番号'),{target:{value:'123'}})
    submit()
    await waitFor(()=>expect(field('電話番号').getAttribute('aria-invalid')).toBe('true'))
    expect(field('電話番号').value).toBe('123')
    expect(document.activeElement).toBe(field('電話番号'))
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it.each(['ネットワークに接続できません','ほかの人が変更しました。入力を控えて、最新版を読み直してください。','この操作には管理者権限が必要です'])('保存失敗：%sでも入力と版を残す',async error=>{
    await renderCard()
    fireEvent.change(field('担当者名'),{target:{value:'保存前の入力'}})
    mocks.save.mockRejectedValueOnce(new Error(error))
    submit()
    await waitFor(()=>expect(screen.getByRole('alert')).toBeTruthy())
    expect(field('担当者名').value).toBe('保存前の入力')
    expect(mocks.read).toHaveBeenCalledTimes(1)
    submit()
    await waitFor(()=>expect(mocks.save).toHaveBeenCalledTimes(2))
    expect(mocks.save.mock.calls[1][0]).toEqual(mocks.save.mock.calls[0][0])
  })
  it('読み込み失敗は保存を止め、再取得が成功するまで空欄で上書きしない',async()=>{
    mocks.read.mockRejectedValueOnce(new Error('読み込めませんでした'))
    render(<CompanyContactCard canEdit/> )
    await waitFor(()=>expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.queryByRole('button',{name:'会社と連絡先を保存する'})).toBeNull()
    submit();expect(mocks.save).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button',{name:'もう一度読み込む'}))
    await loaded()
    expect(screen.queryByRole('button',{name:'会社と連絡先を保存する'})).toBeNull()
    submit();expect(mocks.save).not.toHaveBeenCalled()
  })
  it.each(['会社名（正式）','郵便番号','住所','電話番号','担当者名','担当者のメール'])('必須の%sが空なら送信しない',async label=>{
    await renderCard();fireEvent.change(field(label),{target:{value:' '}});submit()
    await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('入力してください'))
    expect(mocks.save).not.toHaveBeenCalled()
    expect(field(label).getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(field(label))
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })
  it('二重保存を防ぎ、通信中に入力を変更させない',async()=>{
    let finish!: (value:unknown)=>void
    mocks.save.mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
    await renderCard();fireEvent.change(field('担当者名'),{target:{value:'保存中の担当'}});submit()
    await waitFor(()=>expect(field('担当者名').disabled).toBe(true))
    submit();expect(mocks.save).toHaveBeenCalledTimes(1)
    finish({success:true,data:{...values,revision:5}})
    await waitFor(()=>expect(field('担当者名').disabled).toBe(false))
  })
  it.each(['staff','viewer',null])('役割%sには連絡先カードも読み口も出さない',async role=>{
    mocks.role=role;render(<HqSettingsV8/> )
    await waitFor(()=>expect(mocks.name).toHaveBeenCalled())
    expect(screen.queryByRole('form',{name:'会社と連絡先'})).toBeNull()
    expect(screen.queryByRole('button',{name:'会社と連絡先を保存する'})).toBeNull()
    expect(mocks.read).not.toHaveBeenCalled()
  })
  it('閲覧のみには保存・検索ボタンを隠す',async()=>{
    await renderCard(false)
    expect(screen.queryByRole('button')).toBeNull()
    expect(field('担当者名').readOnly).toBe(true)
  })
  it('既存の郵便番号の口へ問い合わせ、空の住所に単一候補を入れる',async()=>{
    mocks.read.mockResolvedValue({success:true,data:{...values,address:null,revision:4}})
    mocks.postal.mockResolvedValue({success:true,data:{status:'matched',candidates:[{prefecture:'東京都',city:'渋谷区',town:'神宮前'}],readiness:{fullDataset:true}}})
    await renderCard();fireEvent.click(screen.getByRole('button',{name:'住所を探す'}))
    await waitFor(()=>expect(field('住所').value).toBe('東京都渋谷区神宮前'))
    expect(mocks.postal).toHaveBeenCalledWith('1500001')
  })
  it('手入力の住所は検索だけでは上書きせず、選んだ候補だけを入れる',async()=>{
    mocks.postal.mockResolvedValue({success:true,data:{status:'multiple',candidates:[{prefecture:'東京都',city:'千代田区',town:'千代田'},
      {prefecture:'東京都',city:'千代田区',town:'皇居外苑'}],readiness:{fullDataset:true}}})
    await renderCard();fireEvent.click(screen.getByRole('button',{name:'住所を探す'}))
    const choice=await screen.findByRole('button',{name:'東京都千代田区皇居外苑'})
    expect(field('住所').value).toBe(values.address)
    fireEvent.click(choice);expect(field('住所').value).toBe('東京都千代田区皇居外苑')
  })
  it.each(['郵便番号','住所'])('検索中に%sを変えると古い応答を捨てる',async label=>{
    let finish!:(value:unknown)=>void
    mocks.postal.mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
    await renderCard();fireEvent.click(screen.getByRole('button',{name:'住所を探す'}))
    fireEvent.change(field(label),{target:{value:'変更した入力'}})
    finish({success:true,data:{candidates:[{prefecture:'東京都',city:'千代田区',town:'千代田'}],readiness:{fullDataset:true}}})
    await waitFor(()=>expect((screen.getByRole('button',{name:'住所を探す'}) as HTMLButtonElement).disabled).toBe(false))
    expect(field(label).value).toBe('変更した入力')
    expect(screen.queryByRole('button',{name:'東京都千代田区千代田'})).toBeNull()
  })
  it('郵便番号データ未登録・検索失敗でも住所を保持して保存できる',async()=>{
    mocks.postal.mockResolvedValueOnce({success:true,data:{candidates:[],readiness:{fullDataset:false}}})
    await renderCard();fireEvent.click(screen.getByRole('button',{name:'住所を探す'}))
    await waitFor(()=>expect(screen.getByText(/全データが未登録/).textContent).toContain('全データが未登録'))
    expect(field('住所').value).toBe(values.address)
    mocks.postal.mockRejectedValueOnce(new Error('検索失敗'))
    fireEvent.click(screen.getByRole('button',{name:'住所を探す'}))
    await waitFor(()=>expect(screen.queryByText(/全データが未登録/)).toBeNull())
    expect(field('住所').value).toBe(values.address)
    fireEvent.change(field('担当者名'),{target:{value:'新しい担当'}})
    submit();await waitFor(()=>expect(mocks.save).toHaveBeenCalledTimes(1))
  })
})


it('統括の2つの設定は1本の帯で操作し、取消で両方を元へ戻す', async () => {
  render(<HqSettingsV8 />)
  await loaded()
  await waitFor(() => expect(field('統括名').value).toBe('統括の名前'))
  expect(field('統括名').closest('[data-form-requirement]')?.getAttribute('data-form-requirement')).toBe('required')
  expect((screen.getByRole('button', { name: '保存する' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(field('統括名'), { target: { value: '新しい統括名' } })
  fireEvent.change(field('担当者名'), { target: { value: '別の担当' } })
  expect(screen.getAllByRole('button', { name: '保存する' })).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: '変更を取り消す' }))
  expect(screen.queryByRole('button', { name: '保存せずに移る' })).toBeNull()
  await waitFor(() => expect((screen.getByRole('button', { name: '保存する' }) as HTMLButtonElement).disabled).toBe(true))
  expect(field('統括名').value).toBe('統括の名前')
  expect(field('担当者名').value).toBe(values.contactName)
  expect(mocks.save).not.toHaveBeenCalled()
  expect(mocks.nameSave).not.toHaveBeenCalled()
})
it('統括名の保存後に会社の保存が失敗しても、未保存の入力を残して会社だけやり直す', async () => {
  render(<><HqSettingsV8 /><ToastHost /></>)
  await loaded()
  await waitFor(() => expect(field('統括名').value).toBe('統括の名前'))
  fireEvent.change(field('統括名'), { target: { value: '新しい統括名' } })
  fireEvent.change(field('担当者名'), { target: { value: '未保存の担当' } })
  mocks.save.mockRejectedValueOnce(new Error('通信できませんでした'))
  fireEvent.click(screen.getByRole('button', { name: '保存する' }))
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
  expect(mocks.nameSave).toHaveBeenCalledOnce()
  expect(field('統括名').value).toBe('新しい統括名')
  expect(field('担当者名').value).toBe('未保存の担当')
  fireEvent.click(screen.getByRole('button', { name: '保存する' }))
  await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2))
  expect(mocks.nameSave).toHaveBeenCalledOnce()
  await waitFor(() => expect((screen.getByRole('button', { name: '保存する' }) as HTMLButtonElement).disabled).toBe(true))
})


it('統括名の保存を待つ間は、会社の入力と住所検索も動かさない', async () => {
  let finish!: (value: unknown) => void
  mocks.nameSave.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  render(<HqSettingsV8 />)
  await loaded()
  await waitFor(() => expect(field('統括名').value).toBe('統括の名前'))
  fireEvent.change(field('統括名'), { target: { value: '新しい統括名' } })
  const save = screen.getByRole('button', { name: '保存する' })
  fireEvent.click(save)
  await waitFor(() => expect((screen.getByRole('button', { name: '住所を探す' }) as HTMLButtonElement).disabled).toBe(true))
  expect(field('担当者名').disabled).toBe(true)
  expect(field('統括名').disabled).toBe(true)
  fireEvent.click(save)
  expect(mocks.nameSave).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: '住所を探す' }))
  expect(mocks.postal).not.toHaveBeenCalled()
  finish({ success: true, data: { name: '新しい統括名' } })
  await waitFor(() => expect((screen.getByRole('button', { name: '住所を探す' }) as HTMLButtonElement).disabled).toBe(false))
  expect(mocks.save).not.toHaveBeenCalled()
})


it.each(['', '   ', 'あ'.repeat(101)])('統括名の入力不備 %j は保存せず、ロック解除後に焦点を戻す', async value => {
  render(<HqSettingsV8 />)
  await loaded()
  await waitFor(() => expect(field('統括名').value).toBe('統括の名前'))
  const name = field('統括名')
  fireEvent.change(name, { target: { value } })
  const save = screen.getByRole('button', { name: '保存する' })
  save.focus()
  fireEvent.click(save)
  await screen.findByText(value.trim().length > 100 ? '統括名は100文字以内で入力してください。' : '統括名を入力してください。')
  await waitFor(() => {
    expect(name.disabled).toBe(false)
    expect(document.activeElement).toBe(name)
  })
  expect(name.getAttribute('aria-invalid')).toBe('true')
  expect(name.getAttribute('aria-required')).toBe('true')
  expect(mocks.nameSave).not.toHaveBeenCalled()
  expect(mocks.save).not.toHaveBeenCalled()
  // 同じ入力不備を続けて確かめたときも、新しい要求として1回だけ戻す。
  save.focus()
  fireEvent.click(save)
  await waitFor(() => expect(document.activeElement).toBe(name))
  expect(mocks.nameSave).not.toHaveBeenCalled()
  expect(mocks.save).not.toHaveBeenCalled()
})

it.each(['viewer', null])('権限が%sへ変わって戻っても古い入力不備へ焦点を奪われない', async role => {
  const tree = () => <><button type="button">焦点の基準</button><HqSettingsV8 /></>
  const view = render(tree())
  await loaded()
  await waitFor(() => expect(field('統括名').value).toBe('統括の名前'))
  fireEvent.change(field('統括名'), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: '保存する' }))
  await waitFor(() => expect(document.activeElement).toBe(field('統括名')))
  mocks.role = role
  view.rerender(tree())
  await waitFor(() => expect(screen.queryByRole('textbox', { name: /^統括名/ })).toBeNull())
  const sentinel = screen.getByRole('button', { name: '焦点の基準' })
  sentinel.focus()
  mocks.role = 'owner'
  view.rerender(tree())
  await waitFor(() => expect(field('統括名').disabled).toBe(false))
  expect(screen.getByText('統括名を入力してください。')).toBeTruthy()
  expect(document.activeElement).toBe(sentinel)
  expect(mocks.nameSave).not.toHaveBeenCalled()
  expect(mocks.save).not.toHaveBeenCalled()
})

it('統括名が未取得の間は送信しても保存や焦点の移動を始めない', async () => {
  let finish!: (value: unknown) => void
  mocks.name.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  render(<><button type="button">焦点の基準</button><HqSettingsV8 /></>)
  await loaded()
  const sentinel = screen.getByRole('button', { name: '焦点の基準' })
  sentinel.focus()
  const name = field('統括名')
  expect(name.disabled).toBe(true)
  fireEvent.submit(name.closest('form')!)
  expect(mocks.nameSave).not.toHaveBeenCalled()
  expect(mocks.save).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(sentinel)
  finish({ success: true, data: { name: '統括の名前' } })
  await waitFor(() => expect(name.disabled).toBe(false))
  expect(document.activeElement).toBe(sentinel)
})
