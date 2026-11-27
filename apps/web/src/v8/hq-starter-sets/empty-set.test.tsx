// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
const net=vi.hoisted(()=>({list:vi.fn(),catalog:vi.fn(),save:vi.fn(),role:'owner',canEdit:true}))
vi.mock('next/navigation',()=>({useRouter:()=>({push(){},replace(){}}),usePathname:()=>'/hq/templates/starter-sets',useSearchParams:()=>new URLSearchParams()}))
vi.mock('next/link',()=>({default:({children,href}: {children:React.ReactNode;href:string})=><a href={href}>{children}</a>}))
vi.mock('@/components/shell/page-chrome',()=>({usePageTitle(){},usePageCrumbs(){}}))
vi.mock('@/contexts/account-context',()=>({useAccount:()=>({accounts:[]})}))
vi.mock('@/lib/staff-role',()=>({useStaffRole:()=>net.role,useTenantWideAccess:()=>net.canEdit}))
vi.mock('@/lib/api/helpers/styles',()=>({hqStyleApi:{listStarterSets:net.list,catalog:net.catalog,saveStarterSet:net.save,defaultStarterSet:async()=>({success:true,data:{definition:{items:[]}}})}}))
import Page from './starter-sets'
beforeEach(()=>{net.role='owner';net.canEdit=true;net.list.mockResolvedValue({success:true,data:[]});net.catalog.mockResolvedValue({success:true,data:[]});net.save.mockReset().mockResolvedValue({success:true,data:{id:'set',version:1}})})
afterEach(cleanup)
it('カタログが空でも10欄と既定オンを示し、空の組を確認して保存する',async()=>{
 render(<Page/>);await screen.findByRole('heading',{name:'飲食店の初期セット'})
 expect(screen.getAllByText('まだありません').length).toBe(10)
 expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
 fireEvent.click(screen.getByRole('button',{name:'変更を保存'}));await screen.findByRole('dialog')
 expect(net.save).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'保存する',exact:true}))
 await waitFor(()=>expect(net.save).toHaveBeenCalledWith('restaurant',expect.objectContaining({autoInsert:true,confirmed:true,definition:{mode:'catalog',items:[],selections:[]}})))
})
it('読み込み失敗を空と混ぜず、再読み込みで戻る',async()=>{
 net.catalog.mockRejectedValueOnce(new Error('failed'))
 render(<Page/>);fireEvent.click(await screen.findByRole('button',{name:'もう一度試す'}));await screen.findByRole('heading',{name:'飲食店の初期セット'})
 expect(net.catalog).toHaveBeenCalledTimes(2)
})
it('未保存の変更はスタイル切替前に確認し、戻ると残る',async()=>{
 render(<Page/>);await screen.findByRole('heading',{name:'飲食店の初期セット'})
 fireEvent.click(screen.getByRole('switch'));fireEvent.click(screen.getByRole('button',{name:'サロン'}))
 await screen.findByRole('dialog');expect(screen.getByRole('heading',{name:'入力を破棄しますか？'})).toBeTruthy()
 fireEvent.click(screen.getAllByRole('button',{name:'キャンセル'}).at(-1)!)
 expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
})
it('保存失敗では選択とトグルを残し、成功の表示にしない',async()=>{
 net.save.mockRejectedValueOnce(new Error('failed'))
 render(<Page/>);await screen.findByRole('heading',{name:'飲食店の初期セット'});fireEvent.click(screen.getByRole('switch'))
 fireEvent.click(screen.getByRole('button',{name:'変更を保存'}));fireEvent.click(await screen.findByRole('button',{name:'保存する',exact:true}))
 await waitFor(()=>expect(net.save).toHaveBeenCalledTimes(1));await waitFor(()=>expect(screen.getByRole('button',{name:'保存する',exact:true}).getAttribute('aria-busy')).not.toBe('true'))
 expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');expect(screen.getByRole('dialog')).toBeTruthy()
})
it('閲覧のみでは操作を残して無効にする',async()=>{
 net.role='viewer';net.canEdit=false;render(<Page/>);await screen.findByRole('heading',{name:'飲食店の初期セット'})
 expect(screen.getByRole('button',{name:'変更を保存'}).getAttribute('aria-disabled')).toBe('true')
 fireEvent.click(screen.getByRole('button',{name:'変更を保存'}));expect(net.save).not.toHaveBeenCalled()
})
it('保存の欄エラーを自動投入の設定へ返し、入力と確認窓を残す',async()=>{
 net.save.mockRejectedValueOnce(new ApiError(422,'入力を確認してください',undefined,undefined,undefined,undefined,{autoInsert:'自動投入の設定を確認してください'}))
 render(<Page/>);await screen.findByRole('heading',{name:'飲食店の初期セット'});fireEvent.click(screen.getByRole('switch'))
 fireEvent.click(screen.getByRole('button',{name:'変更を保存'}));fireEvent.click(await screen.findByRole('button',{name:'保存する',exact:true}))
 await screen.findByText('自動投入の設定を確認してください')
 expect(screen.getByRole('switch').getAttribute('aria-invalid')).toBe('true')
 expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
 expect(screen.getByRole('dialog')).toBeTruthy()
 expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toContain('入力を確認してください')
 expect(net.save).toHaveBeenCalledWith('restaurant',expect.objectContaining({expectedVersion:0,autoInsert:false,confirmed:true}))
})
it.each([422,409])('保存失敗%sでも選んだ版と変更を残し、理由を表示する',async status=>{
 const choice={kind:'rich_menu',templateId:'menu',versionId:'v1'}
 net.list.mockResolvedValue({success:true,data:[{id:'set',style:'restaurant',name:'飲食店',version:7,autoInsert:true,definition:{mode:'catalog',items:[],selections:[choice]}}]})
 net.catalog.mockResolvedValue({success:true,data:[{...choice,name:'選んだメニュー',version:1}]})
 net.save.mockRejectedValueOnce(new ApiError(status,'選んだ版を確認してください',status===409?'version_conflict':undefined,undefined,undefined,undefined,status===422?{'definition.selections.0.versionId':'この版を選び直してください'}:{}))
 render(<Page/>);await screen.findByRole('heading',{name:'飲食店の初期セット'});fireEvent.click(screen.getByRole('switch'))
 fireEvent.click(screen.getByRole('button',{name:'変更を保存'}));await waitFor(()=>expect(net.save).toHaveBeenCalledTimes(1))
 if(status===422){await screen.findByText('この版を選び直してください');expect(screen.getByRole('button',{name:'リッチメニューを選ぶ：変更する'}).getAttribute('aria-invalid')).toBe('true')}
 else await waitFor(()=>expect(screen.getAllByRole('alert').length).toBeGreaterThan(0))
 expect(screen.getByRole('button',{name:'選んだメニュー（版1）の中身を見る'})).toBeTruthy()
 expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
 expect(net.save).toHaveBeenCalledWith('restaurant',expect.objectContaining({expectedVersion:7,definition:{mode:'catalog',items:[],selections:[choice]}}))
})
it('従来の項目を外す保存が競合したときは、中身と確認窓を残す',async()=>{
 const item={key:'welcome',kind:'template',name:'従来のあいさつ',text:'本文'}
 net.list.mockResolvedValue({success:true,data:[{id:'set',style:'restaurant',name:'飲食店',version:8,autoInsert:true,definition:{items:[item]}}]})
 net.save.mockRejectedValueOnce(new ApiError(409,'ほかの人が先に変更しました','version_conflict'))
 render(<Page/>);fireEvent.click(await screen.findByRole('button',{name:'現在の中身を見る'}))
 fireEvent.click(await screen.findByRole('button',{name:'初期セットから外す'}));fireEvent.click(await screen.findByRole('button',{name:'外す',exact:true}))
 await waitFor(()=>expect(net.save).toHaveBeenCalledTimes(1));await waitFor(()=>expect(screen.getAllByRole('alert').length).toBeGreaterThan(0))
 expect(screen.getByRole('heading',{name:'現在の初期セット'})).toBeTruthy()
 expect(screen.getByRole('heading',{name:'初期セットから外しますか？'})).toBeTruthy()
 expect(screen.getByText('従来のあいさつ')).toBeTruthy()
 expect(net.save).toHaveBeenCalledWith('restaurant',expect.objectContaining({expectedVersion:8,definition:{items:[]}}))
})
