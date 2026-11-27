// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ condition: {} as unknown }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'demo' }) }))
vi.mock('@/components/automations/use-common-action-permission', () => ({ useCanManageCommonActions: () => true }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, automations: { ...actual.api.automations, list: async () => ({success:true,data:[]}), draftResources: async () => ({success:true,data:{tags:[{id:'t1',name:'見本のタグ'}],scenarios:[{id:'s1',name:'見本のシナリオ'}],commonActions:[]}}), getDraft: async () => ({success:true,data:{id:'demo',draftVersionId:'v1',name:'見本のルール',description:null,eventType:'friend_add',triggerConfig:{},conditions:fixture.condition,actions:[{id:'step1',type:'add_tag',params:{tagId:'t1'},onFailure:'stop'}]}}) } } }
})
import { NewAutomationV8 } from './create'
beforeEach(() => { window.sessionStorage.clear(); window.history.replaceState(null, '', '/automations/new?draft=demo') })
afterEach(() => { cleanup(); vi.clearAllMocks() })
const action = () => screen.getByRole('button', { name:'つくって動かす' }) as HTMLButtonElement
it.each([
  {operator:'AND',rules:[{type:'scenario_state',value:{scenarioId:'s1',state:'future'}}],groups:[]},
  {operator:'AND',rules:[{type:'reaction_state',value:'constructor'}],groups:[]},
  {operator:'AND',rules:[{type:'future_rule',value:'x'}],groups:[]},
  {operator:'AND',rules:[{type:'is_following',value:'future'}],groups:[]},
  {operator:'AND',rules:[],groups:[{operator:'OR',rules:[{type:'reaction_state',value:'future'}],groups:[]}]},
  {operator:'AND',rules:[],groups:[{operator:'FUTURE',rules:[{type:'is_following',value:true}],groups:[]}]},
  {operator:'AND',rules:[{type:'friend_field',value:{fieldId:'f1',op:'future',text:'x'}}],groups:[]},
])('確認できない条件では公開を止め、理由を表示する %#', async condition => {
  fixture.condition = condition
  render(<NewAutomationV8 />)
  await screen.findByDisplayValue('見本のルール')
  expect(action().disabled).toBe(true)
  expect(screen.getAllByText('確認できない条件があります。条件を選び直してから公開してください。').length).toBeGreaterThan(0)
  fireEvent.click(action())
  expect(screen.queryByRole('dialog', {name:'この内容で動かし始めますか'})).toBeNull()
})
it('既知の条件では公開の確認窓へ進み、対象を確かめられる', async () => {
  fixture.condition = {operator:'AND',rules:[{type:'scenario_state',value:{scenarioId:'s1',state:'subscribed'}}],groups:[]}
  render(<NewAutomationV8 />)
  await screen.findByDisplayValue('見本のルール')
  expect(action().disabled).toBe(false)
  fireEvent.click(action())
  const dialog = await screen.findByRole('dialog', {name:'この内容で動かし始めますか'})
  expect(dialog.textContent).toContain('見本のシナリオ')
  expect(dialog.textContent).toContain('購読中')
})
it('条件を選び直すと公開でき、確認窓に選んだ状態が出る', async () => {
  fixture.condition = {operator:'AND',rules:[{type:'scenario_state',value:{scenarioId:'s1',state:'future'}}],groups:[]}
  render(<NewAutomationV8 />)
  await screen.findByDisplayValue('見本のルール')
  expect(action().disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', {name:'動かす相手を変える'}))
  fireEvent.click(screen.getByRole('button', {name:'シナリオの状態'}))
  fireEvent.click(within(screen.getByRole('option', {name:'を購読中の人'})).getByRole('button'))
  fireEvent.click(screen.getByRole('button', {name:'この条件にする'}))
  expect(action().disabled).toBe(false)
  fireEvent.click(action())
  const dialog = await screen.findByRole('dialog', {name:'この内容で動かし始めますか'})
  expect(dialog.textContent).toContain('購読中')
})
