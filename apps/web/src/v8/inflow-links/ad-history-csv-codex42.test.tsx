// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import AdHistoryV8 from './ad-history'
const fixture=vi.hoisted(()=>({model:{selectedAccountId:'sample',platforms:[],logs:[],total:0,loading:true,failed:false,reload:vi.fn(),sentCount:0,pendingCount:0,failedCount:0}}))
vi.mock('./ad-shared',async original=>({...await original<typeof import('./ad-shared')>(),useAdLogs:()=>fixture.model}))
vi.mock('next/navigation',()=>({usePathname:()=>'/inflow-links',useRouter:()=>({push:vi.fn(),replace:vi.fn()}),useSearchParams:()=>new URLSearchParams()}))
vi.mock('@/components/shell/page-chrome',()=>({usePageTitle:()=>{},usePageCrumbs:()=>{}}))
vi.mock('@/lib/staff-role',async original=>({...await original<typeof import('@/lib/staff-role')>(),useStaffRole:()=> 'owner'}))
afterEach(cleanup)
it('読込中・失敗・空の履歴を区別して書き出しを止める',()=>{
 const {rerender}=render(<AdHistoryV8 />)
 const button=screen.getByRole('button',{name:'CSVで書き出す'}) as HTMLButtonElement
 expect(button.disabled).toBe(true);expect(screen.getByText('送信履歴を読み込んでいます。')).toBeTruthy()
 fixture.model.loading=false;fixture.model.failed=true;rerender(<AdHistoryV8 />)
 expect(button.disabled).toBe(true);expect(screen.getByText('送信履歴を読み直してください。')).toBeTruthy();fireEvent.click(button)
 fixture.model.failed=false;rerender(<AdHistoryV8 />)
 expect(button.disabled).toBe(true);expect(screen.getByText('書き出す送信履歴がありません。')).toBeTruthy()
})
it('前回の履歴が残っていても読込中と失敗中は書き出さない',()=>{
 fixture.model.logs=[{id:'sample',status:'pending',eventName:'見本',createdAt:'2026-11-01T00:00:00Z'}] as never[]
 fixture.model.loading=true;fixture.model.failed=false
 const {rerender}=render(<AdHistoryV8 />)
 const button=screen.getByRole('button',{name:'CSVで書き出す'}) as HTMLButtonElement
 expect(button.disabled).toBe(true)
 fixture.model.loading=false;fixture.model.failed=true;rerender(<AdHistoryV8 />)
 expect(button.disabled).toBe(true)
 fixture.model.failed=false;rerender(<AdHistoryV8 />)
 expect(button.disabled).toBe(false)
})
