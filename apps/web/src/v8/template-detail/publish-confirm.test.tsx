// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ publish: vi.fn(), get: vi.fn(async () => ({ success:true, data:{ id:'t-2',name:'流れの型',messageType:'text',messageContent:'本文',accountId:'acc-1',folderId:null,category:'',publishedVersion:1,draftRevision:2,usedBy:null,hasDraft:true } })), versions:vi.fn(async()=>({success:true,data:[]})), list:vi.fn(async()=>({success:true,data:[]})), folders:vi.fn(async()=>({success:true,data:[]})) }))
vi.mock('next/navigation', () => ({ useRouter:()=>({push:vi.fn(),replace:vi.fn(),refresh:vi.fn(),prefetch:vi.fn()}), useSearchParams:()=>new URLSearchParams('id=t-2'), usePathname:()=>'/templates/detail' }))
vi.mock('next/link', () => ({ default:({children,href}:{children:React.ReactNode;href:string})=><a href={href}>{children}</a> }))
vi.mock('@/contexts/account-context',()=>({useAccount:()=>({accounts:[{id:'acc-1',name:'確認用'}],selectedAccountId:'acc-1',loading:false})}))
vi.mock('@/lib/use-feature-access',()=>({useFeatureAccess:()=>true}))
vi.mock('@/components/shell/page-chrome',()=>({usePageTitle:()=>{},usePageCrumbs:()=>{}}))
vi.mock('@/lib/api',async original=>{const actual=await original<typeof import('@/lib/api')>();return {...actual,api:{...actual.api,templates:{...actual.api.templates,get:mocks.get,versions:mocks.versions,list:mocks.list,publish:mocks.publish},folders:{...actual.api.folders,list:mocks.folders}}}})
import TemplateDetail from './detail'
afterEach(()=>{cleanup();vi.clearAllMocks()})

it('テンプレート詳細の公開確認を閉じた後は古い確定で公開しない',async()=>{
 render(<TemplateDetail />)
 await screen.findByText('流れの型')
 fireEvent.click(screen.getAllByRole('button',{name:'公開する'})[0])
 const dialog=within(await screen.findByRole('dialog'))
 const button=dialog.getByRole('button',{name:'公開する'})
 const key=Object.keys(button).find(item=>item.startsWith('__reactProps$'))!
 const held=(button as unknown as Record<string,{onClick:(e:unknown)=>unknown}>)[key].onClick
 fireEvent.click(dialog.getByRole('button',{name:'キャンセル'}))
 await act(async()=>{await held({defaultPrevented:false,preventDefault(){},stopPropagation(){},currentTarget:button,target:button})})
 expect(mocks.publish).not.toHaveBeenCalled()
})

it('公開競合の読み直しで版が変わったら同じ確認から再公開しない',async()=>{
 const {ApiError}=await import('@/lib/api')
 mocks.publish.mockRejectedValueOnce(new ApiError(409,'変更されました'))
 render(<TemplateDetail />)
 await screen.findByText('流れの型')
 fireEvent.click(screen.getAllByRole('button',{name:'公開する'})[0])
 const dialog=within(await screen.findByRole('dialog'))
 const button=dialog.getByRole('button',{name:'公開する'})
 const key=Object.keys(button).find(item=>item.startsWith('__reactProps$'))!
 const held=(button as unknown as Record<string,{onClick:(e:unknown)=>unknown}>)[key].onClick
 mocks.get.mockResolvedValueOnce({success:true,data:{id:'t-2',name:'流れの型',messageType:'text',messageContent:'変更された本文',accountId:'acc-1',folderId:null,category:'',publishedVersion:2,draftRevision:3,usedBy:null,hasDraft:true}})
 await act(async()=>{fireEvent.click(button)})
 await screen.findByText(/ほかの人が先に公開・編集しました/)
 expect((dialog.getByRole('button',{name:'公開する'}) as HTMLButtonElement).disabled).toBe(true)
 await act(async()=>{await held({defaultPrevented:false,preventDefault(){},stopPropagation(){},currentTarget:button,target:button})})
 expect(mocks.publish).toHaveBeenCalledTimes(1)
})
