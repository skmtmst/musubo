// @vitest-environment happy-dom
import React from 'react'
import {afterEach,expect,it,vi} from 'vitest'
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react'
import TodayView from './today'
import {reservation,tables} from '../booking-kit/test-data'
const floor={id:'floor',storeId:'store-1',name:'1階',width:600,height:400,version:1,outline:[],fixtures:[],tables:tables.map((t,i)=>({id:t.id,x:i*90,y:0,width:80,height:64,rotation:0,shape:'rectangle'}))}
vi.mock('@/contexts/account-context',()=>({useAccount:()=>({selectedAccountId:'account-1'})}))
vi.mock('./use-ledger-floor',()=>({useLedgerFloor:()=>({floor,error:null,reload:vi.fn()})}))
const booking=reservation('unassigned',{customer_name:'未配席のお客さま',table_id:null,starts_at:'2026-10-31T12:00:00Z',ends_at:'2026-10-31T14:00:00Z'})
const props={rows:[booking] as never,later:[],tables,day:new Date('2026-10-31T00:00:00+09:00'),isToday:false,busy:false,canWrite:false,source:'all',onSource:vi.fn(),onDay:vi.fn(),onAdd:vi.fn(),onOpen:vi.fn(),onDetail:vi.fn(),onReload:vi.fn(),storeId:'store-1',onView:vi.fn()}
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();vi.clearAllMocks()})
it.each([{list:[]},{list:tables.map(t=>({...t,is_active:0}))}])('卓が未設定・全卓停止でも未配席予約を開ける',({list})=>{
 const open=vi.fn();render(<TodayView {...props} tables={list} onDetail={open}/>)
 const board=document.querySelector('[data-reservation-board]')! as HTMLElement
 const unassigned=within(board).getByRole('region',{name:'未配席の予約'})
 expect(unassigned.previousElementSibling?.textContent).toBe('未配席')
 fireEvent.click(within(unassigned).getByRole('button',{name:'未配席のお客さま・21:00〜23:00・2名'}))
 expect(open).toHaveBeenCalledWith('unassigned')
 expect(screen.queryByText('利用できる卓がありません')).toBeNull()
})
it('時間の卓は卓番の自然順で並び、結合グループが分かる',()=>{
 const list=[{...tables[2],floor_y:0},{...tables[0],floor_y:10},{...tables[1],floor_y:20}]
 const {container}=render(<TodayView {...props} tables={list}/>)
 expect([...container.querySelectorAll('[data-resource-id]')].map(e=>e.getAttribute('data-resource-id'))).toEqual(['t1','t2','t3'])
 expect(container.querySelector('[data-resource-id="t2"]')?.previousElementSibling?.getAttribute('title')).toContain('結合 A')
})
it('座席表でも未配席を残し、使っていない停止卓を描かない',()=>{
 const {container}=render(<TodayView {...props}/>)
 fireEvent.click(screen.getByRole('button',{name:'座席表'}))
 const board=container.querySelector('[data-reservation-board]')! as HTMLElement
 const unassigned=within(board).getByRole('region',{name:'未配席の予約'})
 expect(unassigned.previousElementSibling?.textContent).toBe('未配席')
 fireEvent.click(within(unassigned).getByRole('button',{name:'未配席のお客さま・21:00〜23:00・2名'}))
 expect(props.onDetail).toHaveBeenCalledWith('unassigned')
 expect(within(board).queryByRole('button',{name:/pb/})).toBeNull()
})

it('結合予約の2卓目だけが停止中でも、列と図から外さない',()=>{
 const joined={...booking,table_id:'t1',table_ids_json:JSON.stringify(['t1','t2'])}
 const list=tables.map(t=>({...t,is_active:t.id==='t2'?0:t.is_active}))
 const {container}=render(<TodayView {...props} rows={[joined] as never} tables={list}/>)
 expect(container.querySelector('[data-resource-id="t2"]')).toBeTruthy()
 fireEvent.click(screen.getByRole('button',{name:'座席表'}))
 expect(screen.getByRole('button',{name:/T2.*停止中/})).toBeTruthy()
})
it('21時から23時までの予約は終端まで描き、22時で切らない',()=>{
 const row={...booking,table_id:'t1'}
 const {container}=render(<TodayView {...props} rows={[row] as never}/>)
 const track=container.querySelector('[data-resource-id="t1"]')! as HTMLElement
 const button=within(track).getByRole('button',{name:/未配席のお客さま/})
 const box=button.parentElement!
 expect(button.textContent).toContain('21:00〜23:00')
 expect(screen.getByText('23:00',{exact:true})).toBeTruthy()
 expect(parseFloat(box.style.left)+parseFloat(box.style.width)).toBeCloseTo(100)
})

it.each([10,11])('昼の%d時からの予約でも終端を出し、直前の文字を詰めない',hour=>{
 const row={...booking,table_id:'t1',starts_at:`2026-10-31T${String(hour).padStart(2,'0')}:00:00+09:00`}
 render(<TodayView {...props} rows={[row] as never}/>)
 const ruler=screen.getByRole('group',{name:'時間の目盛り'})
 expect(within(ruler).getByText('23:00')).toBeTruthy()
 expect(within(ruler).getByText(`${hour}:00`)).toBeTruthy()
 expect(within(ruler).queryByText('22:00')).toBeNull()
})

it('当日の数は開始日で数え、退店済みは未配席に数えない',()=>{
 const prior={...booking,id:'prior',starts_at:'2026-10-30T14:00:00Z',ends_at:'2026-10-30T16:00:00Z'}
 const completed={...booking,id:'departed',customer_name:'退店済み',departed_at:'2026-10-31T13:00:00Z'}
 const current={...booking,id:'current',customer_name:'当日の予約'}
 const linked={...booking,id:'linked',customer_name:'結合済み',table_ids_json:JSON.stringify(['t1'])}
 const {container}=render(<TodayView {...props} rows={[prior,completed,current,linked] as never}/>)
 const labels=[...container.querySelectorAll('[data-kpi-label]')]
 const card=(label:string)=>labels.find(node=>node.textContent?.trim()===label)?.closest('[data-kpi-presentation]')
 expect(card('選んだ日の予約')?.textContent).toContain('3件')
 expect(card('今日の予約')).toBeUndefined()
 expect(card('未配席')?.textContent).toContain('1件')
})

it('今日を開いている時は今日の予約と表示する',()=>{
 const {container}=render(<TodayView {...props} isToday />)
 expect([...container.querySelectorAll('[data-kpi-label]')].some(node=>node.textContent?.trim()==='今日の予約')).toBe(true)
})

it('今日の過去のピークは案内せず、これからの空卓を案内する',()=>{
 vi.spyOn(Date,'now').mockReturnValue(new Date('2026-10-31T18:15:00+09:00').getTime())
 const past={...booking,id:'past',guest_count:8,starts_at:'2026-10-31T17:00:00+09:00',ends_at:'2026-10-31T18:00:00+09:00'}
 const future={...booking,id:'future',guest_count:2,starts_at:'2026-10-31T19:00:00+09:00',ends_at:'2026-10-31T20:00:00+09:00'}
 const view=render(<TodayView {...props} isToday rows={[past,future] as never}/> )
 expect(view.container.textContent).not.toContain('17:00 に空いている')
 expect(view.container.textContent).toContain('19:00 に空いている')
})

it('過去の営業日は空卓を案内せず、将来の営業日はその日のピークを案内する',()=>{
 vi.spyOn(Date,'now').mockReturnValue(new Date('2026-10-31T18:15:00+09:00').getTime())
 const view=render(<TodayView {...props}/> )
 expect(view.container.textContent).toContain('21:00 に空いている')
 view.rerender(<TodayView {...props} day={new Date('2026-10-30T00:00:00+09:00')}/> )
 expect(view.container.textContent).not.toMatch(/に空いている/)
})

it('開いたまま時刻が過ぎたら案内も次の時間に更新する',()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-31T18:59:30+09:00'))
 const row={...booking,starts_at:'2026-10-31T19:00:00+09:00',ends_at:'2026-10-31T20:00:00+09:00'}
 const view=render(<TodayView {...props} isToday rows={[row] as never}/> )
 expect(view.container.textContent).toContain('19:00 に空いている')
 act(()=>vi.advanceTimersByTime(31_000))
 expect(view.container.textContent).not.toContain('19:00 に空いている')
 expect(view.container.textContent).toContain('19:30 に空いている')
})

it('卓の表示名と定員を分け、空き枠は1時間の升目全体に重ねて選んだ時刻を渡す',()=>{
 const onAdd=vi.fn()
 const {container}=render(<TodayView {...props} rows={[]} canWrite onAdd={onAdd} tables={[{...tables[0],label:'窓側',max_capacity:2}]}/> )
 const track=container.querySelector('[data-resource-id="t1"]') as HTMLElement
 expect(track.previousElementSibling?.getAttribute('title')).toBe('T1 窓側・2名')
 expect(track.previousElementSibling?.querySelector('.sr-only')?.textContent).toBe('・')
 expect(track.previousElementSibling?.querySelector('small')?.textContent).toBe('2名')
 const slot=within(track).getByRole('button',{name:/T1 2名 17:00に予約を入れる/})
 expect(slot.getAttribute('data-placement')).toBe('timeline')
 expect(parseFloat((slot.parentElement as HTMLElement).style.width)).toBeCloseTo(100/6)
 fireEvent.click(slot)
 expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({tableId:'t1',time:'17:00'}))
})

it('同じ表示名の卓も卓番を先に出して見分けられる',()=>{
 const list=tables.slice(0,2).map(t=>({...t,label:'窓側'}))
 const {container}=render(<TodayView {...props} tables={list}/> )
 for(const table of list){
  const heading=container.querySelector(`[data-resource-id="${table.id}"]`)?.previousElementSibling
  expect(heading?.firstChild?.textContent).toBe(`${table.code} 窓側`)
 }
})

it('カレンダーをキーボードで操作し、確定した日へ切り替える',()=>{
 const onDay=vi.fn()
 render(<TodayView {...props} onDay={onDay}/>)
 const button=screen.getByRole('button',{name:'予約日'})
 fireEvent.click(button)
 const grid=screen.getByRole('grid')
 fireEvent.keyDown(grid,{key:'ArrowRight'})
 fireEvent.keyDown(screen.getByRole('grid'),{key:'Enter'})
 fireEvent.click(screen.getByRole('button',{name:'確定'}))
 expect(onDay).toHaveBeenCalledWith(new Date('2026-11-01T00:00:00+09:00'))
 expect(screen.queryByRole('dialog',{name:'日付を選ぶ'})).toBeNull()
})

it('右欄の各段と全体を開閉し、畳んだ時は正の件数だけ札にする',()=>{
 window.localStorage.clear()
 const row={...booking,status:'pending',allergy_note:'乳'}
 render(<TodayView {...props} rows={[row] as never}/>)
 const side=screen.getByRole('region',{name:'今日の確認'})
 const care=within(side).getByRole('button',{name:'気をつけること'})
 fireEvent.click(care)
 expect(within(side).getByText(/承認待ち 1件・アレルギー 1件/)).toBeTruthy()
 fireEvent.click(within(side).getByRole('button',{name:'今日の確認を畳む'}))
 expect(within(side).getByText('注意 2')).toBeTruthy()
 expect(within(side).getByText('予約 1')).toBeTruthy()
 expect(within(side).queryByRole('button',{name:'気をつけること'})).toBeNull()
 fireEvent.click(within(side).getByRole('button',{name:'今日の確認を開く'}))
 expect(within(side).getByRole('button',{name:'気をつけること'})).toBeTruthy()
})
