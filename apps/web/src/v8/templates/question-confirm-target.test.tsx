// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ account: 'account-a', get: vi.fn(), update: vi.fn(), publish: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }), useSearchParams: () => new URLSearchParams('id=question-1') }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: state.account, accounts: [], loading: false }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/use-feature-access', () => ({ useFeatureAccess: () => true }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))
vi.mock('@/lib/api', async original => {
 const actual = await original<typeof import('@/lib/api')>()
 return { ...actual, api: { ...actual.api, templates: { ...actual.api.templates, get: state.get, update: state.update, publish: state.publish }, folders: { ...actual.api.folders, list: async () => ({ success: true, data: [] }) }, tags: { ...actual.api.tags, list: async () => ({ success: true, data: [] }) }, scenarios: { ...actual.api.scenarios, list: async () => ({ success: true, data: [] }) } } }
})
import QuestionNewV8 from './question-new'
beforeEach(() => { state.account='account-a'; state.get.mockResolvedValue({ success: true, data: { name: '質問', accountId: 'account-a', question: { text: 'よろしいですか', tapMode: 'single', choices: [{ key: 'yes', label: 'はい', behavior: 'none' }] }, usedBy: { scenarios: [{ id: 'scenario' }] }, publishedVersion: 1, draftRevision: 1 } }) })
afterEach(() => { cleanup(); vi.resetAllMocks() })
async function open() { fireEvent.click(await screen.findByRole('button', { name: '保存して公開' })); return screen.findByRole('dialog', { name: 'この質問を公開しますか？' }) }
it('公開の確認に対象を表示する', async () => {
 render(<QuestionNewV8 />)
 const dialog = await open()
 expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
 expect(within(dialog).getByText('環境')).toBeTruthy()
})
it('共通の質問はすべてのLINEアカウントと表示する', async () => {
 state.get.mockResolvedValue({ success: true, data: { name: '質問', accountId: null, question: { text: 'よろしいですか', tapMode: 'single', choices: [{ key: 'yes', label: 'はい', behavior: 'none' }] }, usedBy: { scenarios: [{ id: 'scenario' }] }, publishedVersion: 1, draftRevision: 1 } })
 render(<QuestionNewV8 />)
 expect(within(await open()).getByText('すべてのLINEアカウント')).toBeTruthy()
})
it('所属の項目が欠けた質問は共通と断定しない', async () => {
 state.get.mockResolvedValue({ success: true, data: { name: '質問', question: { text: 'よろしいですか', tapMode: 'single', choices: [{ key: 'yes', label: 'はい', behavior: 'none' }] }, usedBy: { scenarios: [{ id: 'scenario' }] }, publishedVersion: 1, draftRevision: 1 } })
 render(<QuestionNewV8 />)
 const dialog = await open()
 expect(within(dialog).queryByText('すべてのLINEアカウント')).toBeNull()
 expect(within(dialog).getByText('名前を確認できません')).toBeTruthy()
})
it('アカウントを切り替えて戻した古い確認では公開しない', async () => {
 const view = render(<QuestionNewV8 />)
 const dialog = await open()
 const button = within(dialog).getByRole('button', { name: '公開する' })
 const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
 const handler = (button as unknown as Record<string, { onClick: (event: unknown) => unknown }>)[key].onClick
 state.account='account-b'; view.rerender(<QuestionNewV8 />)
 state.account='account-a'; view.rerender(<QuestionNewV8 />)
 await act(async () => { await handler({ defaultPrevented: false, preventDefault() {}, stopPropagation() {}, currentTarget: button, target: button }) })
 expect(state.update).not.toHaveBeenCalled()
})
it('取得した質問のアカウントが選択中と異なる場合は公開できない', async () => {
 state.get.mockResolvedValue({ success: true, data: { name: '質問', accountId: 'other-account', question: { text: 'よろしいですか', tapMode: 'single', choices: [{ key: 'yes', label: 'はい', behavior: 'none' }] }, usedBy: { scenarios: [{ id: 'scenario' }] }, publishedVersion: 1, draftRevision: 1 } })
 render(<QuestionNewV8 />)
 const button = await screen.findByRole('button', { name: '保存して公開' })
 expect(button.hasAttribute('disabled')).toBe(true)
 fireEvent.click(button)
 expect(state.update).not.toHaveBeenCalled()
})
it('質問公開の窓を閉じた後は古い確定から公開しない', async () => {
 render(<QuestionNewV8 />)
 const dialog = within(await open())
 const button = dialog.getByRole('button', { name:'公開する' })
 const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
 const held = (button as unknown as Record<string,{onClick:(e:unknown)=>unknown}>)[key].onClick
 fireEvent.click(dialog.getByRole('button', { name:'キャンセル' }))
 await act(async () => { await held({defaultPrevented:false,preventDefault(){},stopPropagation(){},currentTarget:button,target:button}) })
 expect(state.update).not.toHaveBeenCalled()
})
it('質問公開には確認時の版を付ける', async () => {
 state.update.mockResolvedValue({ success:true, data:{ publishedVersion:1, draftRevision:2 } })
 state.publish.mockResolvedValue({ success:true, data:{} })
 render(<QuestionNewV8 />)
 const dialog=within(await open())
 await act(async () => { fireEvent.click(dialog.getByRole('button',{name:'公開する'})) })
 expect(state.update).toHaveBeenCalledWith('question-1',expect.objectContaining({expectedVersion:1,expectedDraftRevision:1}))
 expect(state.publish).toHaveBeenCalledWith('question-1',{expectedVersion:1,expectedDraftRevision:2})
})
it('質問の内容を変えて戻しても古い公開確認を使わない', async () => {
 render(<QuestionNewV8 />)
 const field=await screen.findByPlaceholderText('例：継続の意思をうかがう')
 const dialog=within(await open())
 const button=dialog.getByRole('button',{name:'公開する'})
 const key=Object.keys(button).find(item=>item.startsWith('__reactProps$'))!
 const held=(button as unknown as Record<string,{onClick:(e:unknown)=>unknown}>)[key].onClick
 fireEvent.change(field,{target:{value:'別の質問'}})
 fireEvent.change(field,{target:{value:'質問'}})
 await act(async()=>{await held({defaultPrevented:false,preventDefault(){},stopPropagation(){},currentTarget:button,target:button})})
 expect(state.update).not.toHaveBeenCalled()
})
it('公開失敗後は最新の対象と版を読み直してから確認し直す', async () => {
 state.update.mockResolvedValueOnce({ success:true, data:{ id:'question-1', publishedVersion:1, draftRevision:2 } }).mockResolvedValueOnce({ success:true, data:{ id:'question-1', publishedVersion:1, draftRevision:3 } })
 state.publish.mockResolvedValueOnce({ success:false, error:'公開できませんでした' }).mockResolvedValueOnce({ success:true, data:{} })
 render(<QuestionNewV8 />)
 const dialog=within(await open())
 state.get.mockResolvedValueOnce({ success:true, data:{ name:'質問', accountId:'account-a', question:{text:'よろしいですか',tapMode:'single',choices:[{key:'yes',label:'はい',behavior:'none'}]}, usedBy:{scenarios:[{id:'scenario'}]},publishedVersion:1,draftRevision:2 } })
 await act(async()=>{fireEvent.click(dialog.getByRole('button',{name:'公開する'}))})
 expect(state.get).toHaveBeenCalledTimes(2)
 const again=within(await open())
 await act(async()=>{fireEvent.click(again.getByRole('button',{name:'公開する'}))})
 expect(state.update).toHaveBeenLastCalledWith('question-1',expect.objectContaining({expectedVersion:1,expectedDraftRevision:2}))
 expect(state.publish).toHaveBeenLastCalledWith('question-1',{expectedVersion:1,expectedDraftRevision:3})
})
it('公開失敗後に最新を読めなければ古い版で再試行しない', async () => {
 state.update.mockResolvedValue({ success:true, data:{ id:'question-1', publishedVersion:1, draftRevision:2 } })
 state.publish.mockResolvedValue({ success:false, error:'公開できませんでした' })
 render(<QuestionNewV8 />)
 const dialog=within(await open())
 state.get.mockRejectedValueOnce(new Error('offline'))
 await act(async()=>{fireEvent.click(dialog.getByRole('button',{name:'公開する'}))})
 expect(await screen.findByText(/最新の質問を読み直せませんでした/)).toBeTruthy()
 fireEvent.click(screen.getByRole('button',{name:'保存して公開'}))
 expect(state.update).toHaveBeenCalledTimes(1)
 expect(state.publish).toHaveBeenCalledTimes(1)
})
it('保存後の応答で版が同じでも、公開失敗後は最新を読み直す', async () => {
 state.update.mockResolvedValue({ success:true, data:{ id:'question-1', publishedVersion:1, draftRevision:1 } })
 state.publish.mockResolvedValue({ success:false, error:'公開できませんでした' })
 render(<QuestionNewV8 />)
 const dialog=within(await open())
 await act(async()=>{fireEvent.click(dialog.getByRole('button',{name:'公開する'}))})
 expect(state.get).toHaveBeenCalledTimes(2)
})
