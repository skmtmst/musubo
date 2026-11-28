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

it('詳細の不正な応答は見つからないと決めつけず、読み直せる', async () => {
 mocks.get.mockResolvedValueOnce({ success: true, data: {} } as never)
 render(<TemplateDetail />)
 await screen.findByText('テンプレートを読み込めませんでした')
 expect(screen.queryByText('このテンプレートは見つかりません')).toBeNull()
 fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
 expect(await screen.findByText('流れの型')).toBeTruthy()
})
it('版の履歴が不正でも詳細を残し、読み直せる', async () => {
 mocks.versions.mockResolvedValueOnce({ success: true, data: {} } as never).mockResolvedValue({ success: true, data: [] })
 render(<TemplateDetail />)
 await screen.findByText('流れの型')
 await screen.findByText('版の履歴を読み込めませんでした。もう一度お試しください。')
 fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
 await screen.findByText('流れの型')
 expect(screen.queryByText('版の履歴を読み込めませんでした。もう一度お試しください。')).toBeNull()
})
it('実際の 404 は従来どおり見つからないと表示する', async () => {
 const { ApiError } = await import('@/lib/api')
 mocks.get.mockRejectedValueOnce(new ApiError(404, 'not found'))
 render(<TemplateDetail />)
 expect(await screen.findByText('このテンプレートは見つかりません')).toBeTruthy()
})
