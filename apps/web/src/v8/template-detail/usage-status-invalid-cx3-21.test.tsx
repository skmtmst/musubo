// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ publish: vi.fn(), get: vi.fn(async () => ({ success:true, data:{ id:'t-2',name:'流れの型',messageType:'text',messageContent:'本文',accountId:'acc-1',folderId:null,category:'',publishedVersion:1,draftRevision:2,usedBy:null as unknown,hasDraft:true } })), versions:vi.fn(async()=>({success:true,data:[]})), list:vi.fn(async()=>({success:true,data:[]})), folders:vi.fn(async()=>({success:true,data:[]})) }))
vi.mock('next/navigation', () => ({ useRouter:()=>({push:vi.fn(),replace:vi.fn(),refresh:vi.fn(),prefetch:vi.fn()}), useSearchParams:()=>new URLSearchParams('id=t-2'), usePathname:()=>'/templates/detail' }))
vi.mock('next/link', () => ({ default:({children,href}:{children:React.ReactNode;href:string})=><a href={href}>{children}</a> }))
vi.mock('@/contexts/account-context',()=>({useAccount:()=>({accounts:[{id:'acc-1',name:'確認用'}],selectedAccountId:'acc-1',loading:false})}))
vi.mock('@/lib/use-feature-access',()=>({useFeatureAccess:()=>true}))
vi.mock('@/components/shell/page-chrome',()=>({usePageTitle:()=>{},usePageCrumbs:()=>{}}))
vi.mock('@/lib/api',async original=>{const actual=await original<typeof import('@/lib/api')>();return {...actual,api:{...actual.api,templates:{...actual.api.templates,get:mocks.get,versions:mocks.versions,list:mocks.list,publish:mocks.publish},folders:{...actual.api.folders,list:mocks.folders}}}})
import TemplateDetail from './detail'
afterEach(()=>{cleanup();vi.clearAllMocks()})

const emptyUsage = { autoReplies: [], automations: [], scenarioSteps: [], reminderSteps: [], richMenuAreas: [], trackedLinks: [] }
function detailWith(usedBy: unknown) {
 return { success: true, data: { id: 't-2', name: '流れの型', messageType: 'text', messageContent: '本文', accountId: 'acc-1', folderId: null, category: '', publishedVersion: 1, draftRevision: 2, usedBy, hasDraft: true } }
}
it('未知の配信状態を下書きと決めつけない', async () => {
 mocks.get.mockResolvedValueOnce(detailWith({ ...emptyUsage, broadcasts: [
  { broadcastId: 'b1', title: '不明な配信', status: 'unexpected', templateVersionNumber: null, referenceMode: 'latest' },
  { broadcastId: 'b2', title: '予約配信', status: 'scheduled', templateVersionNumber: null, referenceMode: 'latest' },
 ] }))
 render(<TemplateDetail />)
 await screen.findByText('不明な配信')
 expect(screen.getByText('状態を確認できません')).toBeTruthy()
 expect(screen.getByText('予約中')).toBeTruthy()
})
it('未知のリマインダ状態をそのまま見せない', async () => {
 mocks.get.mockResolvedValueOnce(detailWith({ ...emptyUsage, reminderEnrollments: [
  { enrollmentId: 'r1', reminderId: 'r', reminderName: '不明な登録', versionNumber: 1, enrollmentStatus: 'unexpected', targetDate: '2026-11-28' },
  { enrollmentId: 'r2', reminderId: 'r', reminderName: '受付中', versionNumber: 1, enrollmentStatus: 'active', targetDate: '2026-11-28' },
 ] }))
 render(<TemplateDetail />)
 await screen.findByText('不明な登録')
 expect(screen.getByText('状態を確認できません')).toBeTruthy()
 expect(screen.getByText('送信待ち')).toBeTruthy()
})
