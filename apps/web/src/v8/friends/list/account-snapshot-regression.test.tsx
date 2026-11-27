// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FriendStats } from '@/lib/api'
import { readFriendsListSnapshot, writeFriendsListSnapshot } from './list-state'
const fx=vi.hoisted(()=>({ account:'A', urlFilters: false, stats: null as FriendStats | null }))
vi.mock('next/navigation',()=>({ useRouter:()=>({ push:vi.fn(),replace:vi.fn() }),useSearchParams:()=>new URLSearchParams(fx.urlFilters ? window.location.search : ''),usePathname:()=>'/friends' }))
vi.mock('next/link',()=>({ default:({ children }: { children: React.ReactNode })=><span>{children}</span> }))
vi.mock('@/contexts/account-context',()=>({ useAccount:()=>({ selectedAccountId:fx.account,loading:false }) }))
vi.mock('@/components/shell/page-chrome',()=>({ usePageTitle:vi.fn() }))
vi.mock('@/lib/staff-role',()=>({ useStaffRole:()=> 'owner',canManageRole:()=>true }))
vi.mock('@/lib/use-feature-visibility',()=>({ useFeatureVisibility:()=>({ enabled:()=>false }) }))
vi.mock('@/lib/operators-cache',()=>({ loadOperators:async()=>[] }))
vi.mock('@/lib/api',async original=>{ const actual=await original<typeof import('@/lib/api')>();return { ...actual,api:{ ...actual.api,friends:{ list:async()=>({ success:true,data:{ items:[],total:0 } }) },friendStats:{ get:async()=>fx.stats ? ({ success:true,data:fx.stats }) : ({ success:false }) },tags:{ list:async()=>({ success:true,data:[] }) },scenarios:{ list:async()=>({ success:true,data:[] }) } } } })
import List from './list'
import { flushListUrlState } from '@/components/shared/list-url-state'
beforeEach(() => { fx.urlFilters = false; fx.stats = null; flushListUrlState(); window.history.replaceState(null, '', '/friends') })
afterEach(()=>{ cleanup();window.sessionStorage.clear() })
const snapshot=(name:string)=>({ searchInput:name,searchSubmitted:name,selectedTagId:'',responseFilter:'all' as const,operatorId:'',scenarioId:'',attentionOnly:false,sortMode:'recent' as const,page:1,pageSize:20,advanced:null })
it('A→B→Aの各条件を復元前に上書きしない（WEB184）',async()=>{
  fx.account='A';writeFriendsListSnapshot('A',snapshot('Aの検索'));writeFriendsListSnapshot('B',snapshot('Bの検索'))
  const view=render(<List />);await screen.findByDisplayValue('Aの検索')
  fx.account='B';view.rerender(<List />);await screen.findByDisplayValue('Bの検索')
  expect(readFriendsListSnapshot('B')?.searchSubmitted).toBe('Bの検索')
  fx.account='A';view.rerender(<List />);await screen.findByDisplayValue('Aの検索')
  expect(readFriendsListSnapshot('A')?.searchSubmitted).toBe('Aの検索')
})
it('控えがないアカウントには前の条件を引き継がない（WEB184）',async()=>{
  fx.account='A';writeFriendsListSnapshot('A',snapshot('Aの検索'))
  const view=render(<List />);await screen.findByDisplayValue('Aの検索')
  fx.account='C';view.rerender(<List />)
  await waitFor(()=>expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe(''))
})

it('空の一覧の条件解除はURL由来の点数・宛先・保存した検索も外す', async () => {
  fx.urlFilters = true
  window.history.replaceState(null, '', '/friends?tag=tag-a&q=検索&responseFilter=unhandled&operatorId=staff&scenarioId=scenario&attentionOnly=1&scoreMin=10&scoreMax=20&scoredOnly=1&audienceId=audience&savedSearch=saved')
  fx.account = 'A'
  const view = render(<List />)
  const clear = await screen.findByRole('button', { name: '条件を外す' })
  fireEvent.click(clear)
  flushListUrlState()
  view.rerender(<List />)
  await waitFor(() => expect(screen.getByText('まだ友だちがいません')).toBeTruthy())
  const params = new URLSearchParams(window.location.search)
  for (const key of ['q', 'tag', 'advanced', 'responseFilter', 'operatorId', 'scenarioId', 'attentionOnly', 'scoreMin', 'scoreMax', 'scoredOnly', 'audienceId', 'savedSearch']) expect(params.has(key), key).toBe(false)
})

const statsFixture = (overrides: Partial<FriendStats> = {}): FriendStats => ({
  active: 10, total: 12, activeMonthDelta: 2, blockedByThem: 1, hiddenByUs: 1,
  unanswered: 2, resolved: 3, addedThisMonth: 4, addedLastMonth: 1, ...overrides,
})
const kpiCard = (title: string) => screen.getByText(title, { selector: '[data-kpi-label] span' }).closest<HTMLElement>('[data-kpi-presentation]')!
const deltaSlot = (title: string) => kpiCard(title).querySelector<HTMLElement>('[data-kpi-delta-slot]')

it('増加は緑の札に改善と全角の符号で出し、要確認は今のまま（R1・10-29）', async () => {
  fx.account = 'A'; fx.stats = statsFixture()
  render(<List />)
  await screen.findByText('前月 1人')
  for (const [title, text] of [['有効な友だち', '＋2'], ['今月の追加', '＋3']] as const) {
    const slot = deltaSlot(title)!
    expect(slot.querySelector('svg[data-delta-direction="up"]')).not.toBeNull()
    expect(slot.querySelector('[data-delta-word]')?.textContent).toBe('改善')
    expect(slot.firstElementChild?.querySelector('span')?.textContent).toBe(text)
    expect(slot.textContent).not.toMatch(/[+-]/)
    expect(screen.getByText(text).closest('[aria-hidden="true"]')).toBeNull()
  }
  const attention = deltaSlot('未対応')!
  expect(attention.textContent).toBe('要確認')
  expect(attention.querySelector('.lucide-triangle-alert')).not.toBeNull()
  expect(attention.querySelector('[data-delta-word]')).toBeNull()
  expect(kpiCard('有効な友だち').textContent).toContain('総友だち 12')
})

it('減少は赤の札に悪化と全角の符号で出し、1つの札にまとめる（R1・10-29）', async () => {
  fx.account = 'A'; fx.stats = statsFixture({ activeMonthDelta: -1200, addedThisMonth: 2, addedLastMonth: 5, unanswered: 0 })
  render(<List />)
  await screen.findByText('前月 5人')
  for (const [title, text] of [['有効な友だち', '−1,200'], ['今月の追加', '−3']] as const) {
    const slot = deltaSlot(title)!
    expect(slot.querySelector('svg[data-delta-direction="down"]')).not.toBeNull()
    expect(slot.querySelector('[data-delta-word]')?.textContent).toBe('悪化')
    expect(slot.firstElementChild?.querySelector('span')?.textContent).toBe(text)
    expect(slot.firstElementChild?.textContent).toBe(`${text}悪化`)
    expect(slot.textContent).not.toMatch(/[+-]/)
    expect(slot.querySelector('[data-tone="neutral"]')).toBeNull()
  }
  expect(deltaSlot('未対応')).toBeNull()
})

it.each([null, 0])('比較未取得または実0（%s）は差の印を作らない', async (activeMonthDelta) => {
  fx.account = 'A'; fx.stats = statsFixture({ activeMonthDelta, addedThisMonth: 5, addedLastMonth: 5, unanswered: 0 })
  render(<List />)
  await screen.findByText('前月 5人')
  expect(deltaSlot('有効な友だち')).toBeNull()
  expect(deltaSlot('今月の追加')).toBeNull()
  expect(deltaSlot('未対応')).toBeNull()
})

it('統計が取れないときは差や要確認を捏造しない', async () => {
  fx.account = 'A'; fx.stats = null
  render(<List />)
  await waitFor(() => expect(kpiCard('有効な友だち').textContent).toContain('読み込めませんでした'))
  for (const title of ['有効な友だち', '今月の追加', '未対応']) expect(deltaSlot(title)).toBeNull()
})
