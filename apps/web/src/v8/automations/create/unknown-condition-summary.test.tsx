// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ condition: {} as unknown }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'demo' }) }))
vi.mock('@/components/automations/use-common-action-permission', () => ({ useCanManageCommonActions: () => true }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, automations: { ...actual.api.automations, list: async () => ({success:true,data:[]}), draftResources: async () => ({success:true,data:{tags:[],scenarios:[{id:'s1',name:'見本のシナリオ'}],commonActions:[]}}), getDraft: async () => ({success:true,data:{id:'demo',draftVersionId:'v1',name:'見本のルール',description:null,eventType:'friend_add',triggerConfig:{},conditions:fixture.condition,actions:[]}}) } } }
})
import { NewAutomationV8 } from './create'
beforeEach(() => { window.sessionStorage.clear(); window.history.replaceState(null, '', '/automations/new?draft=demo') })
afterEach(() => { cleanup(); vi.clearAllMocks() })
it.each(['constructor', '__proto__', 'future'])('未知のシナリオ状態 %s を購読中と決めつけない', async state => {
  fixture.condition = { operator:'AND',rules:[{type:'scenario_state',value:{scenarioId:'s1',state}}],groups:[] }
  render(<NewAutomationV8 />)
  expect((await screen.findAllByText(/購読状態が不明/)).length).toBeGreaterThan(0)
})
it.each(['toString', 'constructor', '__proto__', 'future'])('未知の反応状態 %s を画面に表示する', async value => {
  fixture.condition = { operator:'AND',rules:[{type:'reaction_state',value}],groups:[] }
  render(<NewAutomationV8 />)
  expect((await screen.findAllByText(/反応状態を確認できない人/)).length).toBeGreaterThan(0)
})
