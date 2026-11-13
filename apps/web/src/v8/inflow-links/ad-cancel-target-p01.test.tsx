// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const state=vi.hoisted(()=>({ account:'a', cancel:vi.fn(), captured:null as null | (()=>void) }))
vi.mock('@/components/shared/row-actions',async original=>{const actual=await original<typeof import('@/components/shared/row-actions')>();return {...actual,RowMenu:(props:React.ComponentProps<typeof actual.RowMenu>)=>{const action=props.items.find(item=>item.id==='cancel')?.onSelect;if(action) state.captured=action;return <actual.RowMenu {...props}/>}}})
vi.mock('@/lib/line-accounts-cache',()=>({loadLineAccounts:async()=>({success:true,data:[{id:'a',name:'店A'},{id:'b',name:'店B'}]})}))
vi.mock('next/navigation',()=>({useRouter:()=>({push:vi.fn(),replace:vi.fn()}),usePathname:()=>'/inflow-links/ads',useSearchParams:()=>new URLSearchParams()}))
vi.mock('@/contexts/account-context',()=>({useAccount:()=>({selectedAccountId:state.account,loading:false})}))
vi.mock('@/components/shell/page-chrome',()=>({usePageTitle:()=>{},usePageCrumbs:()=>{}}))
vi.mock('@/lib/staff-role',async original=>({...await original<typeof import('@/lib/staff-role')>(),useStaffRole:()=> 'owner'}))
vi.mock('@/lib/api',async original=>{const actual=await original<typeof import('@/lib/api')>();return {...actual,api:{...actual.api,
 adPlatforms:{...actual.api.adPlatforms,list:async()=>({success:true,data:[]})},
 entryRoutes:{...actual.api.entryRoutes,list:async()=>({success:true,data:[]})},
 adCosts:{...actual.api.adCosts,list:async()=>({success:true,data:{rows:[],platforms:[],manualEntries:[{id:'cost1',lineAccountId:'b',sourceLabel:'広告A',day:'2026-10-01',amountMinor:500,currency:'JPY',entryRouteId:null,cancelledAt:null,cancelReason:null,createdAt:'2026-10-01T00:00:00Z'}]}}),cancel:state.cancel}
}}})
import AdsV8 from './ads'
afterEach(()=>{cleanup();state.account='a';state.captured=null;state.cancel.mockReset()})
it('広告費の取消窓に記録の所属と環境を示し、切替後の古い確認を断る',async()=>{
 const view=render(<AdsV8 />)
 fireEvent.click(await screen.findByRole('button',{name:/広告Aの操作/}))
 fireEvent.click(await screen.findByRole('menuitem',{name:'取り消す'}))
 const dialog=await screen.findByRole('dialog')
 expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
 expect(await within(dialog).findByText('店B')).toBeTruthy()
 expect(within(dialog).queryByText('店A')).toBeNull()
 expect(within(dialog).getByText('環境')).toBeTruthy()
 fireEvent.change(within(dialog).getByRole('textbox'),{target:{value:'金額誤り'}})
 const button=within(dialog).getByRole('button',{name:'取り消す'})
 const key=Object.keys(button).find(k=>k.startsWith('__reactProps$'))!
 const old=(button as unknown as Record<string,{onClick:()=>void}>)[key].onClick
 state.account='b';view.rerender(<AdsV8 />)
 state.account='a';view.rerender(<AdsV8 />)
 await act(async()=>old())
 expect(state.cancel).not.toHaveBeenCalled()
})
it('アカウント切替で古い取消を選んだ時は理由を示す',async()=>{
 const view=render(<AdsV8 />)
 await screen.findByRole('button',{name:/広告Aの操作/})
 const old=state.captured
 expect(old).toBeTruthy()
 state.account='b';view.rerender(<AdsV8 />)
 await act(async()=>{old!()})
 expect(screen.getByText('アカウントが変わりました。費用を選び直してください。')).toBeTruthy()
 expect(screen.queryByRole('dialog')).toBeNull()
 expect(state.cancel).not.toHaveBeenCalled()
})
it('切替先の読み込み後も古い行の操作は開かない',async()=>{
 const view=render(<AdsV8 />)
 await screen.findByRole('button',{name:/広告Aの操作/})
 const old=state.captured
 expect(old).toBeTruthy()
 state.account='b';view.rerender(<AdsV8 />)
 await screen.findByRole('button',{name:/広告Aの操作/})
 await act(async()=>{old!()})
 expect(screen.queryByRole('dialog')).toBeNull()
 expect(screen.getByText('アカウントが変わりました。費用を選び直してください。')).toBeTruthy()
 expect(state.cancel).not.toHaveBeenCalled()
})
it('確認した広告費の記録だけを取り消す',async()=>{
 state.cancel.mockResolvedValue({success:false,error:'test'})
 render(<AdsV8 />)
 fireEvent.click(await screen.findByRole('button',{name:/広告Aの操作/}))
 fireEvent.click(await screen.findByRole('menuitem',{name:'取り消す'}))
 const dialog=await screen.findByRole('dialog')
 fireEvent.change(within(dialog).getByRole('textbox'),{target:{value:'金額誤り'}})
 fireEvent.click(within(dialog).getByRole('button',{name:'取り消す'}))
 expect(state.cancel).toHaveBeenCalledWith('cost1','金額誤り')
})
