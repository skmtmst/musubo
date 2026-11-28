// @vitest-environment happy-dom
import React from 'react'
import {act,cleanup,render,screen} from '@testing-library/react'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
const net=vi.hoisted(()=>({role:'owner' as string | null,account:'a',query:'id=r&done=1',test:vi.fn(),validate:vi.fn(),conflicts:vi.fn()}))
vi.mock('next/navigation',()=>({useRouter:()=>({replace:vi.fn(),push:vi.fn()}),useSearchParams:()=>new URLSearchParams(net.query)}))
vi.mock('@/contexts/account-context',()=>({useAccount:()=>({selectedAccountId:net.account,accounts:[]})}))
vi.mock('@/components/shell/page-chrome',()=>({usePageTitle:()=>{},usePageCrumbs:()=>{}}))
vi.mock('@/lib/staff-role',async importOriginal=>({...await importOriginal<typeof import('@/lib/staff-role')>(),useStaffRole:()=> net.role,canManageRole:(role:string|null)=>role==='owner'||role==='admin'}))
vi.mock('@/lib/api',async importOriginal=> {const actual=await importOriginal<typeof import('@/lib/api')>();return {...actual,api:{staff:{me:async()=>({success:true,data:{id:'self',role:net.role??'viewer',name:'担当'}})},friendAddRules:{get:async()=>({success:true,data:{rule:{id:'r',name:'案内',status:'stopped',friendKind:'first_time',priority:1,routeNames:[],definition:{routeIds:[],actions:[],messageType:'text',messageText:'案内'}},options:{routes:[],scenarios:[],tags:[]}}}),validate:net.validate,conflicts:net.conflicts,test:net.test}}}})
import Page from './publish'
beforeEach(()=>{net.role='owner';net.account='a';net.query='id=r&done=1';net.test.mockReset();net.validate.mockReset().mockResolvedValue({success:true,data:{canPublish:true,checks:[],estimatedAudienceCount:1}});net.conflicts.mockReset().mockResolvedValue({success:true,data:{rules:[],conflicts:[]}})})
afterEach(cleanup)
it('WEB154: doneのURLでも停止中を有効化完了と表示しない',async()=>{
 const view=render(<Page/>);await act(async()=>{})
 expect(view.container.querySelector('[data-design-node="e0FD1J"]')).toBeNull()
 expect(view.container.textContent).toContain('停止中')
 expect(screen.getByRole('list',{name:'設定済みの内容'}).textContent).toContain('案内')
 expect(screen.getByRole('button',{name:'初回案内を変更する'})).toBeTruthy()
})
it('WEB156: テスト待ちで切り替えても新しいアカウントを処理中にしない',async()=>{
 net.query='id=r';let resolve!: (value:unknown)=>void
 net.test.mockImplementation(()=>new Promise(done=>{resolve=done}))
 const view=render(<Page/>);await act(async()=>{})
 await act(async()=>screen.getByRole('button',{name:'テストする（送らずに判定）'}).click())
 net.account='b';view.rerender(<Page/>);await act(async()=>{})
 expect(screen.getByRole<HTMLButtonElement>('button',{name:'テストする（送らずに判定）'}).disabled).toBe(false)
 await act(async()=>resolve({success:true,data:{matched:true}}))
 expect(view.container.textContent).not.toContain('テストが完了')
})

it('重なり取得のsuccess:falseを重なりなしとして公開確認に進めない',async()=>{
 net.query='id=r';net.conflicts.mockResolvedValue({success:false,error:'fixture failure'})
 const view=render(<Page/>);await act(async()=>{})
 expect(view.container.textContent).toContain('読み込めませんでした')
 expect(screen.queryByRole('button',{name:'テストする（送らずに判定）'})).toBeNull()
})

for (const role of [null, 'viewer']) it(`権限${role}では有効化・テスト・宛先を選ぶ操作を隠し、戻る道を残す`,async()=>{
 net.role=role;net.query='id=r';net.validate.mockRejectedValue(new Error('403 validation forbidden'));net.conflicts.mockRejectedValue(new Error('403 conflicts forbidden'));render(<Page/>);await act(async()=>{})
 expect(screen.getByRole('link',{name:'一覧へ戻る'})).toBeTruthy()
 for (const name of ['有効にする','テストする（送らずに判定）','テストの送り先']) expect(screen.queryByRole('button',{name,exact:true})).toBeNull()
 expect(net.test).not.toHaveBeenCalled()
 expect(net.validate).not.toHaveBeenCalled()
 expect(net.conflicts).not.toHaveBeenCalled()
 expect(screen.getByText('有効にする前の確認は、編集できる人が行います。')).toBeTruthy()
})

it('確認行のテストするは編集へ移らず、同じ条件で実際のテストを呼ぶ',async()=>{
 net.query='id=r';net.test.mockResolvedValue({success:true,data:{matched:true}})
 render(<Page/>);await act(async()=>{})
 await act(async()=>screen.getByRole('button',{name:'テストする',exact:true}).click())
 expect(net.test).toHaveBeenCalledWith('a','r',{routeId:null,expectedAt:null,friendId:null})
})
it('固定の自己宛先は文字で表示し、選ぶ操作を置かず明示したときだけ判定する',async()=>{
 net.query='id=r';net.test.mockResolvedValue({success:true,data:{matched:true}})
 render(<Page/>);await act(async()=>{})
 expect(screen.getByText('送り先：担当（自分）',{exact:true})).toBeTruthy()
 expect(screen.queryByRole('button',{name:'テストの送り先',exact:true})).toBeNull()
 expect(net.test).not.toHaveBeenCalled()
 await act(async()=>screen.getByRole('button',{name:'テストする（送らずに判定）',exact:true}).click())
 expect(net.test).toHaveBeenCalledWith('a','r',{routeId:null,expectedAt:null,friendId:null})
})
