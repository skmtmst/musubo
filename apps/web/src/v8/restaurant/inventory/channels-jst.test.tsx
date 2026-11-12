// @vitest-environment happy-dom
import React from 'react'
import {render,screen,fireEvent,cleanup,waitFor,within} from '@testing-library/react'
import {it,expect,vi,afterEach,beforeEach} from 'vitest'
const calls=vi.hoisted(()=>({fetch:vi.fn(), addresses: vi.fn(), issue: vi.fn()}))
vi.mock('next/navigation',()=>({useRouter:()=>({push:vi.fn(),replace:vi.fn()}),useSearchParams:()=>new URLSearchParams()}))
vi.mock('@/lib/api',async(o)=>({...await o<typeof import('@/lib/api')>(),fetchApi:calls.fetch}))
vi.mock('@/lib/restaurant-test-api',()=>({restaurantTestApi:{listIntakeAddresses:calls.addresses,issueIntakeAddress:calls.issue}}))
vi.mock('@/lib/staff-role',()=>({useStaffRole:()=> 'owner'}))
vi.mock('@/components/shared/use-permission-lock-reason',()=>({usePermissionLockReason:()=>undefined}))
vi.mock('@/components/shared/date-time-field',async(o)=>({...await o<typeof import('@/components/shared/date-time-field')>(),default:({onChange,...props}:React.ComponentProps<typeof import('@/components/shared/date-time-field').default>)=><input {...props} onChange={e=>onChange(e.target.value)}/>}))
import ChannelsBoard from './channels'
beforeEach(()=>{calls.addresses.mockReset().mockResolvedValue({data:[]});calls.issue.mockReset()})
afterEach(cleanup)
it('アドレス再発行は対象店と環境を示し、店の切替後に古い確認を使えない',async()=>{
 calls.addresses.mockResolvedValue({data:[{address:'example@example.test'}]})
 calls.fetch.mockImplementation(async(url:string)=>url.includes('inbound-emails')?{data:[],total:0}:{data:[]})
 const view=render(<ChannelsBoard accountId="a" storeId="s" storeName="本店" date="2026-10-20" canEdit />)
 fireEvent.click(await screen.findByRole('button',{name:/発行し直す（旧は/}))
 const dialog=screen.getByRole('dialog',{name:'取り込みアドレスを発行し直しますか？'})
 expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
 expect(within(dialog).getByText('本店')).toBeTruthy()
 expect(within(dialog).getByText('環境')).toBeTruthy()
 view.rerender(<ChannelsBoard accountId="b" storeId="t" storeName="支店" date="2026-10-20" canEdit />)
 expect(screen.queryByRole('dialog',{name:'取り込みアドレスを発行し直しますか？'})).toBeNull()
 expect(calls.issue).not.toHaveBeenCalled()
})
it('アドレスの再発行確認は店を切り替えると閉じる',async()=>{
 calls.addresses.mockResolvedValue({data:[{address:'example@example.test'}]})
 calls.fetch.mockImplementation(async(url:string)=>url.includes('inbound-emails')?{data:[],total:0}:{data:[]})
 const view=render(<ChannelsBoard accountId="a" storeId="s" date="2026-10-20" canEdit />)
 fireEvent.click(await screen.findByRole('button',{name:/発行し直す（旧は/}))
 expect(screen.getByRole('dialog',{name:'取り込みアドレスを発行し直しますか？'})).toBeTruthy()
 view.rerender(<ChannelsBoard accountId="b" storeId="t" date="2026-10-20" canEdit />)
 await screen.findByRole('button',{name:/発行し直す（旧は/})
 expect(screen.queryByRole('dialog',{name:'取り込みアドレスを発行し直しますか？'})).toBeNull()
 expect(calls.issue).not.toHaveBeenCalled()
})
it('OP-R05 manual intake stores Japan local time regardless of device timezone',async()=>{
 calls.fetch.mockImplementation(async(url:string,options?:{method?:string})=>options?.method==='POST'?{success:true}:url.includes('inbound-emails')?{data:[{id:'e',receivedAt:'2026-10-20T01:00:00Z',status:'quarantined'}],total:1}:{data:[]})
 render(<ChannelsBoard accountId="a" storeId="s" date="2026-10-20" canEdit />)
 fireEvent.click(await screen.findByRole('button',{name:'手で直して取り込む'}))
 fireEvent.change(screen.getByLabelText('お客さまのお名前'),{target:{value:'人工客'}})
 fireEvent.change(screen.getByLabelText('来店の日時'),{target:{value:'2026-10-20T10:00'}})
 fireEvent.click(screen.getByRole('button',{name:'台帳へ取り込む'}))
 await waitFor(()=>expect(calls.fetch.mock.calls.some(([,o])=>o?.method==='POST')).toBe(true))
 const body=JSON.parse(calls.fetch.mock.calls.find(([,o])=>o?.method==='POST')![1].body)
 expect(body.startsAt).toBe('2026-10-20T01:00:00.000Z')
})

it('予約経路は状態の色で示し、受け取り方を省略せず示す', async () => {
 const common = {todayCount:0,lastReceivedAt:null,unreadableCount:0,receiveMethod:'email_forward',daysWithoutReceipt:0}
 calls.fetch.mockImplementation(async(url:string)=>url.includes('inbound-emails')?{data:[],total:0}:{data:[
  {...common,id:'active',code:'hotpepper',name:'経路A',status:'receiving'},
  {...common,id:'stopped',code:'retty',name:'経路B',status:'not_receiving',daysWithoutReceipt:7},
  {...common,id:'pending',code:'google',name:'経路C',status:'preparing',daysWithoutReceipt:null},
 ]})
 render(<ChannelsBoard accountId="a" storeId="s" date="2026-10-20" canEdit />)
 const rows = await screen.findAllByRole('row')
 const row = (name:string) => rows.find(item => within(item).queryByText(name))!
 for (const name of ['経路A','経路B','経路C']) expect(row(name).querySelector('[data-source]')).toBeNull()
 expect(within(row('経路C')).getByText('メール転送')).toBeTruthy()
 expect(within(row('経路C')).getByText('未設定').closest('[data-tone]')?.getAttribute('data-tone')).toBe('neutral')
 expect(within(row('経路A')).getByText('届いている').closest('[data-tone]')?.getAttribute('data-tone')).toBe('success')
 expect(within(row('経路B')).getByText('7日届いていない').closest('[data-tone]')?.getAttribute('data-tone')).toBe('warning')
})

it('準備中の直接接続は転送手順でなく準備中の説明を出す', async () => {
 calls.fetch.mockImplementation(async(url:string)=>url.includes('inbound-emails')?{data:[],total:0}:{data:[{id:'direct',code:'direct',name:'直接媒体',todayCount:null,lastReceivedAt:null,unreadableCount:null,receiveMethod:'direct',status:'preparing',daysWithoutReceipt:null}]})
 render(<ChannelsBoard accountId="a" storeId="s" date="2026-10-20" canEdit />)
 fireEvent.click(await screen.findByRole('button',{name:/直接媒体.*操作/}))
 fireEvent.click(await screen.findByRole('menuitem',{name:'直接接続の案内を見る'}))
 expect(screen.getByRole('dialog',{name:'直接接続はまだつなげません'})).toBeTruthy()
 expect(screen.queryByRole('dialog',{name:'転送の設定のしかた'})).toBeNull()
})

it('再発行の窓を閉じた後や店を変えた後は古い確定を使えない',async()=>{
 calls.addresses.mockResolvedValue({data:[{address:'example@example.test'}]})
 calls.fetch.mockImplementation(async(url:string)=>url.includes('inbound-emails')?{data:[],total:0}:{data:[]})
 const view=render(<ChannelsBoard accountId="a" storeId="s" date="2026-10-20" canEdit />)
 fireEvent.click(await screen.findByRole('button',{name:/発行し直す（旧は/}))
 const dialog=screen.getByRole('dialog',{name:'取り込みアドレスを発行し直しますか？'})
 const button=within(dialog).getByRole('button',{name:'発行し直す'})
 const key=Object.keys(button).find(name=>name.startsWith('__reactProps$'))!
 const oldClick=(button as unknown as Record<string,{onClick:(event:unknown)=>void}>)[key].onClick
 view.rerender(<ChannelsBoard accountId="b" storeId="t" date="2026-10-20" canEdit />)
 view.rerender(<ChannelsBoard accountId="a" storeId="s" date="2026-10-20" canEdit />)
 oldClick({defaultPrevented:false,preventDefault(){},stopPropagation(){},currentTarget:button,target:button})
 expect(calls.issue).not.toHaveBeenCalled()
})

it('再発行を閉じた後の古い確定を拒否し、新しい確認は実行できる',async()=>{
 calls.addresses.mockResolvedValue({data:[{address:'example@example.test'}]})
 calls.issue.mockResolvedValue({success:true})
 calls.fetch.mockImplementation(async(url:string)=>url.includes('inbound-emails')?{data:[],total:0}:{data:[]})
 render(<ChannelsBoard accountId="a" storeId="s" date="2026-10-20" canEdit />)
 fireEvent.click(await screen.findByRole('button',{name:/発行し直す（旧は/}))
 let dialog=screen.getByRole('dialog',{name:'取り込みアドレスを発行し直しますか？'})
 const button=within(dialog).getByRole('button',{name:'発行し直す'})
 const key=Object.keys(button).find(name=>name.startsWith('__reactProps$'))!
 const oldClick=(button as unknown as Record<string,{onClick:(event:unknown)=>void}>)[key].onClick
 fireEvent.click(within(dialog).getByRole('button',{name:'キャンセル'}))
 fireEvent.click(screen.getByRole('button',{name:/発行し直す（旧は/}))
 oldClick({defaultPrevented:false,preventDefault(){},stopPropagation(){},currentTarget:button,target:button})
 expect(calls.issue).not.toHaveBeenCalled()
 dialog=screen.getByRole('dialog',{name:'取り込みアドレスを発行し直しますか？'})
 fireEvent.click(within(dialog).getByRole('button',{name:'発行し直す'}))
 expect(calls.issue).toHaveBeenCalledExactlyOnceWith('a','s')
})
