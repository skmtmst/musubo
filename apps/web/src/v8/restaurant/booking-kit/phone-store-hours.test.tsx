// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import PhoneReservation from '../reservations/phone'
import PhoneReservationDrawer from '../front-desk/phone-drawer'
import { ApiError } from '@/lib/api'
import { tables } from './test-data'

const api = vi.hoisted(() => ({ openingHours: vi.fn(), reservationsDay: vi.fn(), customerSearch: vi.fn(), customerHistory: vi.fn(), createReservation: vi.fn() }))
const scope = vi.hoisted(() => ({ account: 'account-a' }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: api }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: scope.account }) }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/restaurant-test/reservations', useSearchParams: () => new URLSearchParams() }))
const hours = (start: string, end: string) => Array.from({length:7}, (_, weekday) => ({weekday, periods:[{opensAt:start,closesAt:end}]}))
const aHours=hours('17:00','23:00'), bHours=hours('12:00','16:00'), cHours=hours('13:00','17:00')
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve=r }); return {promise,resolve} }
const onSave=vi.fn()
type Entry = 'page' | 'drawer'
function node(entry: Entry, account: string, store: string) {
 if (entry==='drawer') return <PhoneReservationDrawer staffRole="owner" storeName="人工店舗" open accountId={account} storeId={store} tables={tables} onClose={vi.fn()} onSaved={vi.fn()} />
 return <PhoneReservation accountStyle="restaurant" staffRole="owner" storeId={store} storeName="人工店舗" tables={tables} menuItems={[]} busy={false} preset={{hold:true,date:new Date('2026-11-03T00:00:00+09:00'),time:''}} onBack={vi.fn()} onSave={onSave} />
}
const slot=(t:string)=>screen.queryByRole('button',{name:t,exact:true})
beforeEach(()=>{scope.account='account-a'; vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-02T12:00:00+09:00')); api.openingHours.mockResolvedValue({data:{hours:aHours}});api.reservationsDay.mockResolvedValue({data:{reservations:[]}});api.customerSearch.mockResolvedValue({data:[]});api.customerHistory.mockResolvedValue({data:{visitCount:0,visits:[]}}); api.createReservation.mockResolvedValue({data:{lineNotice:{sent:false}}});onSave.mockResolvedValue(false)})
afterEach(()=>{cleanup();vi.useRealTimers();vi.resetAllMocks()})
it.each<Entry>(['page','drawer'])('%s 店舗切替後の営業時間待ちでは旧時間を選択・保存できない',async entry=>{
 const slow=deferred<{data:{hours:typeof bHours}}>();api.openingHours.mockImplementation((_account:string,store:string)=>store==='store-a'?Promise.resolve({data:{hours:aHours}}):slow.promise)
 const view=render(node(entry,'account-a','store-a'))
 if(entry==='drawer'){fireEvent.change(screen.getByRole('textbox',{name:'お名前'}),{target:{value:'架空客'}});fireEvent.click(screen.getByRole('button',{name:/明日/}))}
 fireEvent.click(await screen.findByRole('button',{name:'19:00',exact:true}))
 view.rerender(node(entry,'account-a','store-b'))
 await waitFor(()=>expect(api.openingHours).toHaveBeenCalledWith('account-a','store-b',expect.any(String)))
 expect(slot('19:00')).toBeNull()
 if(entry==='page')fireEvent.submit(document.querySelector('form')!)
 else fireEvent.click(screen.getByRole('button',{name:'予約を入れる'}))
 expect(onSave).not.toHaveBeenCalled();expect(api.createReservation).not.toHaveBeenCalled()
 await act(async()=>slow.resolve({data:{hours:bHours}}))
 await waitFor(()=>expect(slot('12:00')).not.toBeNull())
 expect(slot('19:00')).toBeNull()
 if(entry==='page') fireEvent.submit(document.querySelector('form')!)
 else expect((screen.getByRole('button',{name:'予約を入れる'}) as HTMLButtonElement).disabled).toBe(true)
 expect(onSave).not.toHaveBeenCalled();expect(api.createReservation).not.toHaveBeenCalled()
})
it.each<Entry>(['page','drawer'])('%s 遅い旧店舗応答は現在の店舗の営業時間を上書きしない',async entry=>{
 const old=deferred<{data:{hours:typeof bHours}}>();api.openingHours.mockImplementation((_account:string,store:string)=>store==='store-a'?Promise.resolve({data:{hours:aHours}}):store==='store-b'?old.promise:Promise.resolve({data:{hours:cHours}}))
 const view=render(node(entry,'account-a','store-a'))
 if(entry==='drawer')fireEvent.click(screen.getByRole('button',{name:/明日/}))
 await screen.findByRole('button',{name:'19:00',exact:true})
 view.rerender(node(entry,'account-a','store-b'));await waitFor(()=>expect(api.openingHours).toHaveBeenCalledWith('account-a','store-b',expect.any(String)))
 view.rerender(node(entry,'account-a','store-c'));await screen.findByRole('button',{name:'13:00',exact:true})
 await act(async()=>old.resolve({data:{hours:bHours}}))
 expect(slot('13:00')).not.toBeNull();expect(slot('12:00')).toBeNull()
})
it.each<Entry>(['page','drawer'])('%s 同じ店舗IDでアカウントが変わっても旧営業時間を使わない',async entry=>{
 const slow=deferred<{data:{hours:typeof bHours}}>();api.openingHours.mockImplementation((account:string)=>account==='account-a'?Promise.resolve({data:{hours:aHours}}):slow.promise)
 const view=render(node(entry,'account-a','store-a'))
 if(entry==='drawer')fireEvent.click(screen.getByRole('button',{name:/明日/}))
 await screen.findByRole('button',{name:'19:00',exact:true})
 scope.account='account-b';view.rerender(node(entry,'account-b','store-a'))
 await waitFor(()=>expect(api.openingHours).toHaveBeenCalledWith('account-b','store-a',expect.any(String)))
 expect(slot('19:00')).toBeNull()
 await act(async()=>slow.resolve({data:{hours:bHours}}));await screen.findByRole('button',{name:'12:00',exact:true})
})
it.each<Entry>(['page','drawer'])('%s 新店舗の予約一覧が待機中は保存できず、到着後に保存できる',async entry=>{
 const slow=deferred<{data:{reservations:[]}}>();api.reservationsDay.mockImplementation((_account:string,store:string)=>store==='store-b'?slow.promise:Promise.resolve({data:{reservations:[]}}))
 const view=render(node(entry,'account-a','store-a'))
 if(entry==='drawer'){fireEvent.change(screen.getByRole('textbox',{name:'お名前'}),{target:{value:'架空客'}});fireEvent.click(screen.getByRole('button',{name:/明日/}))}
 fireEvent.click(await screen.findByRole('button',{name:'19:00',exact:true}))
 view.rerender(node(entry,'account-a','store-b'));await waitFor(()=>expect(api.reservationsDay).toHaveBeenCalledWith('account-a','store-b',expect.any(String)))
 await screen.findByRole('button',{name:'19:00',exact:true})
 if(entry==='page')fireEvent.submit(document.querySelector('form')!)
 else expect((screen.getByRole('button',{name:'予約を入れる'}) as HTMLButtonElement).disabled).toBe(true)
 expect(onSave).not.toHaveBeenCalled();expect(api.createReservation).not.toHaveBeenCalled()
 await act(async()=>slow.resolve({data:{reservations:[]}}))
 if(entry==='page')fireEvent.submit(document.querySelector('form')!)
 else {await waitFor(()=>expect((screen.getByRole('button',{name:'予約を入れる'}) as HTMLButtonElement).disabled).toBe(false));fireEvent.click(screen.getByRole('button',{name:'予約を入れる'}))}
 await waitFor(()=>expect(entry==='page'?onSave:api.createReservation).toHaveBeenCalledOnce())
})
it.each<Entry>(['page','drawer'])('%s 新店舗の営業時間取得に失敗すると旧時間を復活させない',async entry=>{
 api.openingHours.mockImplementation((_account:string,store:string)=>store==='store-a'?Promise.resolve({data:{hours:aHours}}):Promise.reject(new Error('synthetic')))
 const view=render(node(entry,'account-a','store-a'))
 if(entry==='drawer')fireEvent.click(screen.getByRole('button',{name:/明日/}))
 await screen.findByRole('button',{name:'19:00',exact:true});view.rerender(node(entry,'account-a','store-b'))
 await waitFor(()=>expect(api.openingHours).toHaveBeenCalledWith('account-a','store-b',expect.any(String)))
 expect(slot('19:00')).toBeNull();expect(onSave).not.toHaveBeenCalled();expect(api.createReservation).not.toHaveBeenCalled()
})
it.each<Entry>(['page','drawer'])('%s 未設定は受付を止め設定画面への入口を出す',async entry=>{
 api.openingHours.mockResolvedValue({data:{hours:null,version:0}})
 render(node(entry,'account-a','store-a'))
 await screen.findByText(/営業時間が未設定/)
 expect(screen.getByRole('link',{name:'開ける時間を設定する'}).getAttribute('href')).toBe('/restaurant-test/google?tab=hours')
 if(entry==='page')fireEvent.submit(document.querySelector('form')!)
 else expect((screen.getByRole('button',{name:'予約を入れる'}) as HTMLButtonElement).disabled).toBe(true)
 expect(onSave).not.toHaveBeenCalled();expect(api.createReservation).not.toHaveBeenCalled()
})
it.each<Entry>(['page','drawer'])('%s 営業時間取得失敗を再試行できる',async entry=>{
 if(entry==='drawer')vi.setSystemTime(new Date('2026-11-02T09:00:00+09:00'))
 api.openingHours.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({data:{hours:bHours}})
 render(node(entry,'account-a','store-a'))
 await screen.findByText('営業時間を読み込めませんでした。')
 fireEvent.click(screen.getByRole('button',{name:'営業時間を再読み込み'}))
 await screen.findByRole('button',{name:'12:00',exact:true})
})
it.each<Entry>(['page','drawer'])('%s 休業日の理由と設定への入口を出す',async entry=>{
 api.openingHours.mockResolvedValue({data:{hours:hours('17:00','23:00').map(day=>({...day,periods:[]})),version:1}})
 render(node(entry,'account-a','store-a'))
 if(entry==='drawer')fireEvent.click(screen.getByRole('button',{name:/明日/}))
 expect((await screen.findByRole('link',{name:'開ける時間を確認する'})).getAttribute('href')).toBe('/restaurant-test/google?tab=hours')
})

it.each<Entry>(['page','drawer'])('%s 営業時間の取得失敗から再試行し、旧応答を使わない',async entry=>{
 if(entry==='drawer')vi.setSystemTime(new Date('2026-11-02T09:00:00+09:00'))
 const old=deferred<{data:{hours:typeof aHours}}>()
 api.openingHours.mockReturnValueOnce(old.promise).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({data:{hours:bHours}})
 const view=render(node(entry,'account-a','store-a'))
 view.rerender(node(entry,'account-a','store-b'))
 await screen.findByText('営業時間を読み込めませんでした。')
 fireEvent.click(screen.getByRole('button',{name:'営業時間を再読み込み'}))
 await screen.findByRole('button',{name:'12:00',exact:true})
 await act(async()=>old.resolve({data:{hours:aHours}}))
 expect(slot('19:00')).toBeNull();expect(slot('12:00')).not.toBeNull()
})
it.each<Entry>(['page','drawer'])('%s 予約一覧の取得失敗から再試行できる',async entry=>{
 api.reservationsDay.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({data:{reservations:[]}})
 render(node(entry,'account-a','store-a'))
 await screen.findByText('この日の予約を読み込めませんでした。')
 fireEvent.click(screen.getByRole('button',{name:'予約を再読み込み'}))
 await waitFor(()=>expect(api.reservationsDay).toHaveBeenCalledTimes(2))
 await waitFor(()=>expect(screen.queryByText('この日の予約を読み込めませんでした。')).toBeNull())
})
it('drawer 日付をまたいで再表示すると今日・明日と予約一覧を更新する',async()=>{
 render(node('drawer','account-a','store-a'))
 await waitFor(()=>expect(api.reservationsDay).toHaveBeenCalledWith('account-a','store-a','2026-11-02'))
 vi.setSystemTime(new Date('2026-11-03T00:01:00+09:00'))
 fireEvent.focus(window)
 await waitFor(()=>expect(api.reservationsDay).toHaveBeenCalledWith('account-a','store-a','2026-11-03'))
 expect(screen.getByRole('button',{name:/今日.*11\/03/})).toBeTruthy()
})
it('drawer 日付越えで選んだ時刻を外し、旧日の遅延応答を新日に使わない',async()=>{
 const old=deferred<{data:{reservations:[]}}>(), next=deferred<{data:{reservations:[]}}>()
 api.reservationsDay.mockImplementation((_a:string,_s:string,date:string)=>date==='2026-11-02'?old.promise:next.promise)
 render(node('drawer','account-a','store-a'))
 fireEvent.change(screen.getByRole('textbox',{name:'お名前'}),{target:{value:'架空客'}})
 await screen.findByRole('button',{name:'19:00',exact:true})
 fireEvent.click(screen.getByRole('button',{name:'19:00',exact:true}))
 vi.setSystemTime(new Date('2026-11-03T00:01:00+09:00'));fireEvent.focus(window)
 await waitFor(()=>expect(api.reservationsDay).toHaveBeenCalledWith('account-a','store-a','2026-11-03'))
 await act(async()=>old.resolve({data:{reservations:[]}}))
 expect((screen.getByRole('button',{name:'予約を入れる'}) as HTMLButtonElement).disabled).toBe(true)
 expect(api.createReservation).not.toHaveBeenCalled()
 await act(async()=>next.resolve({data:{reservations:[]}}))
 expect((screen.getByRole('button',{name:'予約を入れる'}) as HTMLButtonElement).disabled).toBe(true)
})
it('drawer 日付越えの再描画前に押しても旧日付を送らない',async()=>{
 vi.setSystemTime(new Date('2026-11-02T18:00:00+09:00'))
 render(node('drawer','account-a','store-a'))
 fireEvent.change(screen.getByRole('textbox',{name:'お名前'}),{target:{value:'架空客'}})
 fireEvent.click(await screen.findByRole('button',{name:'19:00',exact:true}))
 await waitFor(()=>expect((screen.getByRole('button',{name:'予約を入れる'}) as HTMLButtonElement).disabled).toBe(false))
 vi.setSystemTime(new Date('2026-11-03T00:01:00+09:00'))
 fireEvent.click(screen.getByRole('button',{name:'予約を入れる'}))
 expect(api.createReservation).not.toHaveBeenCalled()
 expect(await screen.findByText('日付が変わりました。予約日時を確認してください。')).toBeTruthy()
})
it.each<Entry>(['page','drawer'])('%s 店名付きの案内から対象店舗の設定へ移る', async entry => {
 api.openingHours.mockResolvedValue({data:{hours:null,version:0}})
 if(entry==='page') render(<PhoneReservation storeId="store-b" storeName="二号店" accountStyle="restaurant" staffRole="owner" tables={tables} menuItems={[]} busy={false} preset={{hold:true,date:new Date('2026-11-03T00:00:00+09:00'),time:''}} onBack={vi.fn()} onSave={onSave} />)
 else render(<PhoneReservationDrawer open accountId="account-a" storeId="store-b" storeName="二号店" staffRole="owner" tables={tables} onClose={vi.fn()} onSaved={vi.fn()} />)
 await screen.findByText(/二号店.*営業時間が未設定/)
 expect(screen.getByRole('link',{name:'開ける時間を設定する'}).getAttribute('href')).toBe('/restaurant-test/google?tab=hours')
})
it.each<Entry>(['page','drawer'])('%s staff には設定を依頼する案内を出す', async entry => {
 api.openingHours.mockResolvedValue({data:{hours:null,version:0}})
 if(entry==='page') render(<PhoneReservation storeId="store-b" storeName="二号店" accountStyle="restaurant" staffRole="staff" tables={tables} menuItems={[]} busy={false} preset={{hold:true,date:new Date('2026-11-03T00:00:00+09:00'),time:''}} onBack={vi.fn()} onSave={onSave} />)
 else render(<PhoneReservationDrawer open accountId="account-a" storeId="store-b" storeName="二号店" staffRole="staff" tables={tables} onClose={vi.fn()} onSaved={vi.fn()} />)
 await screen.findByText(/管理者に営業時間の設定を依頼/)
 expect(screen.queryByRole('link',{name:'開ける時間を設定する'})).toBeNull()
})
it.each([['salon','/booking/bookings/new'],['consult','/booking/bookings/new'],['lesson','/events'],['standard',null],['ec',null]] as const)('%s 旧画面では受付を止め適切な入口を案内する', async (style,href) => {
 render(<PhoneReservation storeId="store-b" storeName="二号店" accountStyle={style} staffRole="owner" canUseAlternateBooking tables={tables} menuItems={[]} busy={false} preset={{hold:true,date:new Date('2026-11-03T00:00:00+09:00'),time:''}} onBack={vi.fn()} onSave={onSave} />)
 await screen.findByText(/この画面は飲食店スタイルの古い予約/)
 if(href) expect(screen.getByRole('link',{name:'予約画面へ'}).getAttribute('href')).toBe(href)
 else expect(screen.queryByRole('link',{name:'予約画面へ'})).toBeNull()
 fireEvent.submit(document.querySelector('form')!); expect(onSave).not.toHaveBeenCalled()
})
it('別スタイルの予約権限がない時はリンクを出さない', async () => {
 render(<PhoneReservation storeId="store-b" storeName="二号店" accountStyle="salon" staffRole="staff" canUseAlternateBooking={false} tables={tables} menuItems={[]} busy={false} preset={{hold:true,date:new Date('2026-11-03T00:00:00+09:00'),time:''}} onBack={vi.fn()} onSave={onSave} />)
 await screen.findByText(/この画面は飲食店スタイルの古い予約/)
 expect(screen.queryByRole('link',{name:'予約画面へ'})).toBeNull()
})
it('教室で管理者でなければイベント管理の入口を案内しない', async () => {
 render(<PhoneReservation storeId="store-b" storeName="二号店" accountStyle="lesson" staffRole="staff" tables={tables} menuItems={[]} busy={false} preset={{hold:true,date:new Date('2026-11-03T00:00:00+09:00'),time:''}} onBack={vi.fn()} onSave={onSave} />)
 await screen.findByText(/この画面は飲食店スタイルの古い予約/)
 expect(screen.queryByRole('link',{name:'予約画面へ'})).toBeNull()
})

it('右パネルは保存時のコードを読み、営業時間の設定を案内する', async () => {
 api.createReservation.mockRejectedValueOnce(new ApiError(409, 'synthetic', 'opening_hours_unconfigured'))
 render(node('drawer','account-a','store-a'))
 fireEvent.change(screen.getByRole('textbox',{name:'お名前'}),{target:{value:'架空客'}})
 fireEvent.click(screen.getByRole('button',{name:/明日/}))
 fireEvent.click(await screen.findByRole('button',{name:'19:00',exact:true}))
 const save=screen.getByRole('button',{name:'予約を入れる'}) as HTMLButtonElement
 await waitFor(()=>expect(save.disabled).toBe(false))
 fireEvent.click(save)
 await waitFor(()=>expect(api.createReservation).toHaveBeenCalledOnce())
 expect(await screen.findByText('営業時間が未設定のため予約できません。営業時間を確認してください。')).toBeTruthy()
})

it('入力済みでも他スタイルではボタンとフォームの両方で受付を止める', async () => {
 const page=(style:'restaurant'|'salon') => <PhoneReservation accountStyle={style} staffRole="owner" storeId="store-a" storeName="人工店舗" tables={tables} menuItems={[]} busy={false} preset={{hold:true,date:new Date('2026-11-03T00:00:00+09:00'),time:''}} onBack={vi.fn()} onSave={onSave} />
 const view=render(page('restaurant'))
 fireEvent.click(await screen.findByRole('button',{name:'19:00',exact:true}))
 const save=screen.getByRole('button',{name:'枠を押さえる'}) as HTMLButtonElement
 await waitFor(()=>expect(save.disabled).toBe(false))
 view.rerender(page('salon'))
 expect(save.disabled).toBe(true)
 fireEvent.submit(document.querySelector('form')!)
 expect(onSave).not.toHaveBeenCalled()
})
