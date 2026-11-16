// @vitest-environment happy-dom
/*
 * タグ一覧（I1E7Bt）を描いて押す。
 * 取れていない値を「手動」や0で埋めない・整理候補と未使用はサーバーの理由だけで数える・
 * 「よく使う」の4つがどれも絞り込みに効く・件数の刻みとページ送り・並び替えのつまみ。
 */
import React, { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tag, TagGroup } from '@line-crm/shared'

vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

const net = vi.hoisted(() => ({ list: vi.fn(), groups: vi.fn(), restore: vi.fn(), stats: vi.fn() }))
const viewport = vi.hoisted(() => ({ narrow: false }))
vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => viewport.narrow }))
vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      tags: { ...actual.api.tags, list: net.list, restore: net.restore },
      tagGroups: { ...actual.api.tagGroups, list: net.groups },
      listStats: { ...actual.api.listStats, get: net.stats },
      featureSettings: { ...actual.api.featureSettings, visibility: vi.fn(async () => ({ success: true as const, data: { features: { friend_fields: true, support_marks: true, saved_searches: true } } })) },
    },
  }
})
vi.mock('@/lib/staff-role', async (original) => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))

import { flushListUrlState } from '@/components/shared/list-url-state'
import TagsList from './list'

const THIS_MONTH = new Date().toISOString()
function tag(overrides: Partial<Tag>): Tag {
  return { id: 't', name: 't', color: '#3B82F6', groupId: null, friendCount: 1, createdAt: '2026-01-13T00:00:00.000Z', lineAccountId: 'account-a', status: 'active', cleanupReasons: [], ...overrides } as Tag
}
const ITEMS: Tag[] = [
  tag({ id: 'manual', name: '手で付ける', assignSource: 'manual', usedIn: { broadcasts: 2, forms: 0, scenarios: 0, autoReplies: 0, savedSearches: 0 } as Tag['usedIn'] }),
  tag({ id: 'unknown', name: '付け方が不明', assignSource: undefined, otherActionCount: 2, cleanupReasons: ['unused', 'duplicate_name'] as Tag['cleanupReasons'] }),
  tag({ id: 'auto', name: 'EC連携', assignSource: 'ec', mileageReward: 10, createdAt: THIS_MONTH, cleanupReasons: ['duplicate_name'] as Tag['cleanupReasons'] }),
  tag({ id: 'unused', name: '誰にも付いていない', friendCount: 0, otherActionCount: 0, cleanupReasons: ['unused'] as Tag['cleanupReasons'] }),
]
const GROUPS: TagGroup[] = []

const column = (name: string) => [...document.querySelectorAll('table thead th')].findIndex((th) => th.textContent?.trim() === name)
const cell = (id: string, name: string) => document.querySelector(`table tbody tr[data-row-id="${id}"]`)!.querySelectorAll('td')[column(name)]!.textContent?.trim()
const rowIds = () => [...document.querySelectorAll('table tbody tr[data-row-id]')].map((row) => row.getAttribute('data-row-id'))
const kpi = (title: string) => within(document.querySelector<HTMLElement>('[data-design="KPIs"]')!).getByText(title).closest('[data-kpi-card], article, section, div')!.parentElement!.textContent ?? ''

beforeEach(() => {
  window.history.replaceState(null, '', '/tags')
  flushListUrlState()
  viewport.narrow = false
  net.stats.mockResolvedValue({ success: false, error: 'unused' })
  net.list.mockResolvedValue({ success: true, data: ITEMS })
  net.groups.mockResolvedValue({ success: true, data: GROUPS })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function chooseQuick(name: string) {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^よく使う絞り込み/ })) })
  await act(async () => { fireEvent.click(await screen.findByRole('menuitem', { name, exact: true })) })
}

describe('タグ一覧の値', () => {
  it('保管から戻す窓に対象を出し、切替後の古い確認を断る', async () => {
    const items = [tag({ id: 'archived', name: '保管済みタグ', status: 'archived' }), ITEMS[0]!]
    const view = render(<TagsList accountId="account-a" fixture={{ items, groups: GROUPS }} />)
    fireEvent.click(screen.getByRole('button', { name: /保管/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'タグ「保管済みタグ」の操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '保管から戻す' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
    expect(within(dialog).getByText('環境')).toBeTruthy()
    const button = within(dialog).getByRole('button', { name: '保管から戻す' })
    const key = Object.keys(button).find(k => k.startsWith('__reactProps$'))!
    const old = (button as unknown as Record<string, { onClick: () => void }>)[key].onClick
    view.rerender(<TagsList accountId="account-b" fixture={{ items, groups: GROUPS }} />)
    view.rerender(<TagsList accountId="account-a" fixture={{ items, groups: GROUPS }} />)
    old()
    expect(net.restore).not.toHaveBeenCalled()
  })
  it('戻す確認と同じアカウントを送る', async () => {
    const items = [tag({ id: 'archived', name: '保管済みタグ', status: 'archived' }), ITEMS[0]!]
    net.restore.mockResolvedValue({ success: false, error: 'test' })
    render(<TagsList accountId="account-a" fixture={{ items, groups: GROUPS }} />)
    fireEvent.click(screen.getByRole('button', { name: /保管/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'タグ「保管済みタグ」の操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '保管から戻す' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '保管から戻す' }))
    expect(net.restore).toHaveBeenCalledWith('archived', 'account-a', 1)
  })
  it('件数つきで今のアカウントの一覧を読む', async () => {
    render(<TagsList accountId="account-a" />)
    await screen.findAllByText('手で付ける')
    expect(net.list).toHaveBeenCalledWith({ withCounts: true, accountId: 'account-a' })
    expect(net.stats).toHaveBeenCalledWith('account-a')
  })

  it('サーバーの総数は数の帯に出さない', async () => {
    net.stats.mockResolvedValue({ success: true, data: { tags: { total: 99, taggedFriends: 3, assignedThisMonth: 5 } } })
    render(<TagsList accountId="account-a" />)
    await waitFor(() => expect(kpi('付けている友だち')).toContain('3人'))
    expect(document.querySelector('[data-design="KPIs"]')!.textContent).not.toContain('99件')
  })

  it('付け方が分からないタグを「手動」と埋めず「—」、使用先が無ければ「なし」、連動の他は0件を出さない', () => {
    render(<TagsList accountId="account-a" fixture={{ items: ITEMS, groups: GROUPS }} />)
    expect(cell('manual', '付け方')).toBe('手動')
    expect(cell('unknown', '付け方')).toBe('—')
    expect(cell('manual', '使っている所')).toBe('配信2')
    expect(cell('unknown', '使っている所')).toBe('なし')
    expect(cell('unknown', '連動')).toBe('他2')
    expect(cell('unused', '連動')).not.toContain('他0')
  })

  it('未使用と整理の候補はサーバーの理由だけを数え、両方に当たっても1つと数える', () => {
    render(<TagsList accountId="account-a" fixture={{ items: ITEMS, groups: GROUPS }} />)
    expect(kpi('未使用')).toContain('2件')
    expect(kpi('未使用')).not.toContain('4件')
    expect(kpi('整理の候補')).toContain('3件')
  })

  it('理由を1件でも読めていなければ、少ない数を出さず「—」にする', () => {
    const items = [...ITEMS.slice(0, 3), { ...ITEMS[3], cleanupReasons: undefined } as Tag]
    render(<TagsList accountId="account-a" fixture={{ items, groups: GROUPS }} />)
    expect(kpi('未使用')).toContain('—')
    expect(kpi('未使用')).not.toMatch(/\d件/)
    expect(kpi('整理の候補')).toContain('—')
    expect(kpi('整理の候補')).not.toMatch(/\d件/)
  })
})

describe('よく使う絞り込み', () => {
  it.each([
    ['未使用のタグ', ['unknown', 'unused']],
    ['今月増えたタグ', ['auto']],
    ['自動付与あり', ['auto']],
    ['連動あり', ['unknown', 'auto']],
  ])('「%s」を選ぶと一覧が絞られる', async (name, ids) => {
    render(<TagsList accountId="account-a" fixture={{ items: ITEMS, groups: GROUPS }} />)
    expect(rowIds()).toHaveLength(4)
    await chooseQuick(name)
    await waitFor(() => expect(rowIds()).toEqual(ids))
  })
})

describe('件数とページ送り・並び替え', () => {
  it('表示件数は10・20・30・40・50件から選べ、ページ送りは共通の部品で出す', async () => {
    const items = Array.from({ length: 21 }, (_, index) => ({ ...ITEMS[0], id: `page-${index}`, name: `ページ確認${index}` }))
    render(<TagsList accountId="account-a" fixture={{ items, groups: GROUPS }} />)
    fireEvent.click(screen.getByRole('button', { name: '表示件数' }))
    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getAllByRole('option').map((option) => option.textContent?.trim())).toEqual(['10件表示', '20件表示', '30件表示', '40件表示', '50件表示'])
    expect(screen.getByRole('navigation', { name: 'タグのページ送り' })).toBeTruthy()
  })

  it('行ごとに上下キーで動かせる並び替えのつまみを常に出す', () => {
    render(<TagsList accountId="account-a" fixture={{ items: ITEMS, groups: GROUPS }} />)
    for (const item of ITEMS) expect(screen.getAllByRole('button', { name: `${item.name}を並び替え。上下キーで移動` }).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: '並び替えを終了' })).toBeNull()
  })

  it.each([false, true])('保管表示=%sのフォルダ件数を行と同じ状態で数える', onlyArchived => {
    if (onlyArchived) { window.history.replaceState(null, '', '/tags?archived=1'); flushListUrlState() }
    const items = [
      { ...ITEMS[0], groupId: 'g' }, ...ITEMS.slice(1),
      tag({ id: 'stored-g', status: 'archived', groupId: 'g' }),
      tag({ id: 'stored-none', status: 'archived', groupId: null }),
    ]
    const groups = [{ id: 'g', name: '店頭' }] as TagGroup[]
    render(<TagsList accountId="account-a" fixture={{ items, groups }} />)
    const labels = [...document.querySelectorAll('[data-folder-select]')].map(el => el.textContent?.replace(/\s/g, ''))
    expect(labels).toEqual(onlyArchived ? ['すべて2', '店頭1', '未分類1'] : ['すべて4', '店頭1', '未分類3'])
    expect(rowIds()).toEqual(onlyArchived ? ['stored-g', 'stored-none'] : ['manual', 'unknown', 'auto', 'unused'])
    expect(document.querySelector('[data-pagination-summary]')?.textContent?.trim()).toMatch(onlyArchived ? /^2件中/ : /^4件中/)
  })
})


it('狭い幅のフォルダの選択欄に件数を重ねない', () => {
  viewport.narrow = true
  try {
    render(<TagsList accountId="account-a" fixture={{ items: ITEMS, groups: GROUPS }} />)
    expect(screen.getByRole('button', { name: 'フォルダ' }).textContent).toContain('フォルダ：すべて')
    expect(screen.getByRole('button', { name: 'フォルダ' }).textContent).not.toMatch(/\d+件/)
  } finally { viewport.narrow = false }
})
