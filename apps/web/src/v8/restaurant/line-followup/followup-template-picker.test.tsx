// @vitest-environment happy-dom
import React from 'react'
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
const calls=vi.hoisted(()=>({messages:vi.fn(),assets:vi.fn(),get:vi.fn()}))
vi.mock('@/lib/api',()=>({api:{templates:{listPage:calls.messages,get:calls.get},broadcastMessageAssets:{list:calls.assets}}}))
import {FollowupTemplatePicker} from './followup-template-picker'
const column={title:'お席のご案内',actions:[{type:'uri',label:'内容を見る',uri:'https://example.test/menu'}]}
const carousel={id:'carousel',name:'カルーセルの見本',accountId:'account-a',category:'',messageType:'carousel',messageContent:JSON.stringify([column]),publishedVersion:1,publishedAt:'2026-10-31T00:00:00Z'}
const assets=[
 {id:'rich',name:'リッチメッセージの見本',kind:'rich_message',lineAccountId:'account-a',payload:{imageUrl:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',tapAreas:[]}},
 {id:'card',name:'カードタイプの見本',kind:'card_message',lineAccountId:'account-a',payload:{cards:[{title:'お席のご案内',actionLabel:'内容を見る'}]}},
 {id:'coupon',name:'クーポンの見本',kind:'coupon',lineAccountId:'account-a',payload:{couponId:'test-coupon',title:'お会計から100円引き'}},
]
beforeEach(()=>{
 calls.messages.mockResolvedValue({success:true,data:{items:[carousel],total:1}})
 calls.assets.mockResolvedValue({success:true,data:assets})
 calls.get.mockResolvedValue({success:true,data:carousel})
})
afterEach(()=>{cleanup();vi.resetAllMocks()})
it.each([
 ...assets.map(asset=>({name:asset.name,type:asset.kind,expected:asset.payload})),
 {name:carousel.name,type:'carousel',expected:{columnsJson:carousel.messageContent}},
])('$nameを選び、見え方と同じ内容を編集へ渡す',async({name,type,expected})=>{
 const onPick=vi.fn()
 render(<FollowupTemplatePicker accountId="account-a" storeName="試験店" onCancel={()=>{}} onPick={onPick}/>)
 const option=await screen.findByRole('radio',{name})
 expect(screen.queryByRole('tab')).toBeNull()
 fireEvent.click(option)
 expect(screen.getAllByText(type==='carousel'||type==='card_message'?'お席のご案内':name).length).toBeGreaterThan(0)
 fireEvent.click(screen.getByRole('button',{name:'選択する'}))
 await waitFor(()=>expect(onPick).toHaveBeenCalledWith([expect.objectContaining({type,content:expect.objectContaining(expected)})]))
 expect(calls.messages).toHaveBeenCalledWith(expect.objectContaining({accountId:'account-a'}))
})
