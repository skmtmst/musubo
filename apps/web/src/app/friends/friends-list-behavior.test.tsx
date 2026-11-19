// @vitest-environment happy-dom
/*
 * 友だち一覧（V8）の読み込み・絞り込み・引き継ぎを、描いて押して確かめる。
 *
 * - URL の点数の帯・配信対象で開いた 0 件は「条件に合う人がいない」と言う
 * - 読込失敗を 0 件と見せず、件数・CSV を止め、もう一度読める
 * - 範囲外ページの補正は応答が届いてからだけ行う（A03-01）
 * - ［未対応］［注目のみ］の札は押すと選ばれ、一覧の取り方が変わる
 * - 絞り込み条件を配信作成へ渡す（ID の一覧は渡さない）。配信できる人だけに出す（IDEA-03）
 * - 一覧の状態をアカウント別に控えて戻す。URL で指定した絞り込みは控えで上書きしない
 * - 詳細条件の並び順・表示件数を一覧へ反映し、開き直すとその値から始まる（FRIEND-04）
 * - 数の帯は取り損ねを出して取り直せる（FRIEND-08）
 * - 行の対応状況「保留」と、最終接触は受信・送信の新しい方（FRIEND-06/07）
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({ role: 'owner' as string | null, list: vi.fn(), stats: vi.fn() }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
  usePathname: () => '/friends',
}))
vi.mock('next/link', () => ({ default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a> }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'A', loading: false }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: vi.fn() }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => fx.role }))
vi.mock('@/lib/use-feature-visibility', () => ({ useFeatureVisibility: () => ({ enabled: () => false }) }))
vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => false }))
vi.mock('@/lib/operators-cache', () => ({ loadOperators: async () => ({ success: true, data: [] }) }))
// 選ぶ欄の部品は自分の試験が持つ。ここで見たいのは選んだ値が一覧の取り方へ届くことなので素の select にする。
vi.mock('@/components/shared/select', () => ({
  default: ({ options, value, onChange, 'aria-label': label }: { options: { value: string; label: string }[]; value: string; onChange: (value: string) => void; 'aria-label'?: string }) => (
    <select aria-label={label} value={value} onChange={event => onChange(event.target.value)}>
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  ),
}))
vi.mock('@/components/shared/entity-select', () => import('@/test-utils/entity-select-mock'))
vi.mock('@/lib/api/helpers/gap3', async original => ({
  ...await original<typeof import('@/lib/api/helpers/gap3')>(),
  memberRanksApi: { program: async () => ({ success: false, error: 'off' }), friend: async () => ({ success: false, error: 'off' }) },
}))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      friends: { ...actual.api.friends, list: fx.list },
      friendStats: { get: fx.stats },
      tags: { list: async () => ({ success: true, data: [] }) },
      scenarios: { list: async () => ({ success: true, data: [] }) },
    },
  }
})

import List from '@/v8/friends/list/list'
import { flushListUrlState } from '@/components/shared/list-url-state'
import { readFriendsListSnapshot, writeFriendsListSnapshot } from '@/v8/friends/list/list-state'
import { monthDay } from '@/v8/friends/list/words'

type Row = { id: string; displayName: string; [key: string]: unknown }
const row = (id: string, extra: Record<string, unknown> = {}): Row => ({ id, displayName: id, tags: [], metadata: {}, createdAt: '2026-10-01T00:00:00Z', updatedAt: 'v1', isFollowing: true, ...extra })
const answer = (items: Row[], total = items.length) => ({ success: true, data: { items, total } })
const listParams = () => fx.list.mock.calls.map(call => call[0] as Record<string, unknown>)

function at(url: string) {
  window.history.replaceState(null, '', url)
}

async function openListMenu() {
  fireEvent.click(screen.getByRole('button', { name: '一覧のほかの操作' }))
  return within(await screen.findByRole('menu', { name: '一覧のほかの操作' }))
}

async function openAdvancedConditions() {
  fireEvent.click(screen.getByRole('button', { name: /^絞り込み(?:\s+\d+)?$/ }))
  const filters = await screen.findByRole('dialog', { name: '絞り込み', exact: true })
  fireEvent.click(within(filters).getByRole('button', { name: '詳細条件', exact: true }))
  return screen.findByRole('dialog', { name: '絞り込み条件を設定' })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-18T00:00:00.000Z'))
  flushListUrlState()
  at('/friends')
  sessionStorage.clear()
  fx.role = 'owner'
  fx.list.mockReset().mockResolvedValue(answer([row('山田さん')]))
  fx.stats.mockReset().mockResolvedValue({ success: false, error: 'down' })
})

afterEach(() => {
  cleanup()
  flushListUrlState()
  sessionStorage.clear()
  vi.useRealTimers()
})

describe('URLから来る絞り込みの0件', () => {
  it.each([
    ['点数の帯', '/friends?scoreMin=10'],
    ['配信対象', '/friends?audienceId=aud-1'],
  ])('%sで開いて0件なら、絞り込んだ結果だと言う', async (_label, url) => {
    at(url)
    fx.list.mockResolvedValue(answer([]))
    render(<List />)
    expect(await screen.findByText('条件に合う友だちが見つかりません')).toBeTruthy()
    expect(screen.queryByText('まだ友だちがいません')).toBeNull()
  })

  it('何も絞り込まずに0件なら、まだ友だちがいないと言う', async () => {
    fx.list.mockResolvedValue(answer([]))
    render(<List />)
    expect(await screen.findByText('まだ友だちがいません')).toBeTruthy()
  })

  it('本当に空の時だけ、友だち追加のURLを作る口を出す（58）', async () => {
    fx.list.mockResolvedValue(answer([]))
    render(<List />)
    expect(await screen.findByText('まだ友だちがいません')).toBeTruthy()
    const action = screen.getByRole('link', { name: '友だち追加の URL を作る' })
    expect(action.getAttribute('href')).toBe('/inflow-links')
    expect(screen.queryByRole('button', { name: '条件を外す' })).toBeNull()
  })
})

describe('友だち一覧の読込状態', () => {
  it('失敗の返事の内部文を利用者に出さない', async () => {
    fx.list.mockResolvedValueOnce({ success: false, error: 'private backend detail' })
    render(<List />)
    expect(await screen.findByText('友だちを読み込めませんでした')).toBeTruthy()
    expect(document.body.textContent).not.toContain('private backend detail')
    expect(screen.queryByText('まだ友だちがいません')).toBeNull()
  })
  it('読込失敗を0件として出さず、件数とCSVを止め、もう一度読める', async () => {
    fx.list.mockRejectedValueOnce(new Error('down')).mockResolvedValue(answer([row('戻った人')]))
    render(<List />)
    expect(await screen.findByText('友だちを読み込めませんでした')).toBeTruthy()
    expect(screen.queryByText('まだ友だちがいません')).toBeNull()
    expect(screen.queryByText('0件')).toBeNull()
    const failedMenu = await openListMenu()
    expect(failedMenu.getByRole<HTMLButtonElement>('menuitem', { name: /^表示中をCSVで書き出す/ }).disabled).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    fireEvent.click(within(screen.getByText('友だちを読み込めませんでした').closest('td')!).getByRole('button', { name: 'もう一度読み込む' }))
    expect(await screen.findByText('戻った人')).toBeTruthy()
    expect(fx.list).toHaveBeenCalledTimes(2)
    expect(screen.getByText('1件')).toBeTruthy()
    const readyMenu = await openListMenu()
    expect(readyMenu.getByRole<HTMLButtonElement>('menuitem', { name: '表示中をCSVで書き出す' }).disabled).toBe(false)
  })
})

describe('ページ範囲の補正（A03-01）', () => {
  it('取得中には補正せず、届いた総数で範囲外なら最後のページへ戻す', async () => {
    let finishSecond!: (value: ReturnType<typeof answer>) => void
    fx.list
      .mockResolvedValueOnce(answer([row('1ページ目の人')], 100))
      .mockImplementationOnce(() => new Promise(resolve => { finishSecond = resolve }))
      .mockResolvedValueOnce(answer([], 25))
      .mockResolvedValue(answer([row('2ページ目の人')], 25))
    render(<List />)
    await screen.findByText('1ページ目の人')
    fireEvent.click(screen.getByRole('button', { name: '次のページ' }))
    await waitFor(() => expect(listParams().map(params => params.offset)).toEqual(['0', '20']))
    // 取得中は総数が分からない。ここで補正すると 1 ページ目へ勝手に戻る。
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    expect(listParams().map(params => params.offset)).toEqual(['0', '20'])
    await act(async () => finishSecond(answer([row('2ページ目の前の人')], 100)))
    fireEvent.click(screen.getByRole('button', { name: '次のページ' }))
    // 3 ページ目の応答で総数が 25 人に減っていたら、最後の 2 ページ目へ戻して読み直す。
    expect(await screen.findByText('2ページ目の人')).toBeTruthy()
    expect(listParams().map(params => params.offset)).toEqual(['0', '20', '40', '20'])
  })
})

describe('すばやく絞り込む札', () => {
  it('［未対応］［注目のみ］は押すと選ばれ、一覧をその条件で取り直す', async () => {
    render(<List />)
    await screen.findByText('山田さん')
    const chips = within(screen.getByRole('group', { name: 'すばやく絞り込む' }))
    const unhandled = chips.getByRole('button', { name: /未対応/ })
    expect(unhandled.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(unhandled)
    await waitFor(() => expect(listParams().at(-1)).toMatchObject({ handled: 'unhandled' }))
    expect(chips.getByRole('button', { name: /未対応/ }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(chips.getByRole('button', { name: /注目のみ/ }))
    await waitFor(() => expect(listParams().at(-1)).toMatchObject({ handled: 'unhandled', metadata: { __attention: '1' } }))
    expect(chips.getByRole('button', { name: /注目のみ/ }).getAttribute('aria-pressed')).toBe('true')
  })
})

describe('一覧 → 配信作成の条件引き継ぎ', () => {
  const handoff = () => screen.queryByRole<HTMLAnchorElement>('menuitem', { name: 'この条件で配信を作る' })

  it('絞り込み条件をJSONにして配信作成へ渡し、表示中の友だちIDは渡さない', async () => {
    at('/friends?tag=tag-1')
    render(<List />)
    await screen.findByText('山田さん')
    await openListMenu()
    const href = handoff()?.getAttribute('href') ?? ''
    expect(href.startsWith('/broadcasts/new?condition=')).toBe(true)
    const condition = JSON.parse(decodeURIComponent(href.slice('/broadcasts/new?condition='.length)))
    expect(condition).toEqual({ operator: 'AND', rules: [{ type: 'tag_exists', value: 'tag-1' }] })
    expect(href).not.toContain('山田さん')
  })

  it.each(['staff', 'viewer'])('%sには配信の入口を出さない（一括操作と同じ線引き）', async role => {
    fx.role = role
    at('/friends?tag=tag-1')
    render(<List />)
    await screen.findByText('山田さん')
    const menu = await openListMenu()
    expect(menu.getByRole('menuitem', { name: /^表示中をCSVで書き出す/ })).toBeTruthy()
    expect(menu.queryByRole('menuitem', { name: /配信/ })).toBeNull()
    expect(document.querySelector('a[href^="/broadcasts/new?condition="]')).toBeNull()
  })
})

describe('一覧状態の保存・復元', () => {
  const snapshot = {
    searchInput: '控えの語', searchSubmitted: '控えの語', selectedTagId: '', responseFilter: 'all' as const, operatorId: '', scenarioId: '',
    attentionOnly: false, sortMode: 'oldest' as const, page: 2, pageSize: 50, advanced: null,
  }

  it('控えを戻してから読み、既定の条件で二重に読まない', async () => {
    writeFriendsListSnapshot('A', snapshot)
    fx.list.mockResolvedValue(answer([row('控えの人')], 120))
    render(<List />)
    await screen.findByText('控えの人')
    expect(listParams()).toHaveLength(1)
    expect(listParams()[0]).toMatchObject({ search: '控えの語', sort: 'oldest', limit: 50 })
  })

  it('絞り込みをアカウント別に控える', async () => {
    render(<List />)
    await screen.findByText('山田さん')
    fireEvent.click(within(screen.getByRole('group', { name: 'すばやく絞り込む' })).getByRole('button', { name: /未対応/ }))
    await waitFor(() => expect(readFriendsListSnapshot('A')?.responseFilter).toBe('unhandled'))
    expect(readFriendsListSnapshot('B')).toBeNull()
  })

  it.each([
    ['点数の帯', '/friends?scoreMin=10', { scoreMin: 10 }],
    ['対象者', '/friends?audienceId=aud-1', { audienceId: 'aud-1' }],
  ])('URLで%sを指定して開いたときは控えで上書きしない', async (_label, url, expected) => {
    writeFriendsListSnapshot('A', snapshot)
    at(url)
    render(<List />)
    await screen.findByText('山田さん')
    for (const params of listParams()) {
      expect(params).toMatchObject(expected)
      expect(params.search).toBeUndefined()
    }
  })
})

describe('詳細条件の並び順・表示件数（FRIEND-04/32）', () => {
  it('適用すると一覧の並び順・件数が変わり、開き直すとその値から始まる', async () => {
    render(<List />)
    await screen.findByText('山田さん')
    const dialog = await openAdvancedConditions()
    fireEvent.change(within(dialog).getByRole('combobox', { name: '並び順' }), { target: { value: 'oldest' } })
    fireEvent.change(within(dialog).getByRole('combobox', { name: '表示件数' }), { target: { value: '50' } })
    const apply = within(dialog).getAllByRole('button').find(button => /この条件で表示|人を表示/.test(button.textContent ?? ''))!
    await act(async () => { fireEvent.click(apply) })
    await waitFor(() => expect(listParams().at(-1)).toMatchObject({ sort: 'oldest', limit: 50 }))

    const reopened = await openAdvancedConditions()
    expect(within(reopened).getByRole<HTMLSelectElement>('combobox', { name: '並び順' }).value).toBe('oldest')
    expect(within(reopened).getByRole<HTMLSelectElement>('combobox', { name: '表示件数' }).value).toBe('50')
  })
})

describe('数の帯（FRIEND-08）', () => {
  it('取り損ねは「読み込めませんでした」と出し、取り直すと人数が出る', async () => {
    fx.stats.mockRejectedValueOnce(new Error('down')).mockResolvedValue({
      success: true,
      data: { total: 12, active: 10, blockedByThem: 1, hiddenByUs: 1, unanswered: 3, resolved: 7, addedThisMonth: 4, addedLastMonth: 2, activeMonthDelta: 0 },
    })
    render(<List />)
    await waitFor(() => expect(screen.getAllByText('読み込めませんでした').length).toBeGreaterThan(0))
    const retry = screen.getAllByRole('button').find(button => /もう一度|再読み込み|再試行/.test(button.textContent ?? '') && button.closest('[data-design="V8FriendKpis"]'))!
    fireEvent.click(retry)
    await waitFor(() => expect(document.body.textContent).toContain('総友だち 12'))
    expect(screen.queryByText('読み込めませんでした')).toBeNull()
    expect(fx.stats).toHaveBeenCalledTimes(2)
  })
})

describe('一覧行の対応状況と最終接触（FRIEND-06/07）', () => {
  it('保留は「保留」、最終接触は受信・送信の新しい方を出す', async () => {
    fx.list.mockResolvedValue(answer([
      row('返信が新しい人', { chatStatus: 'on_hold', latestIncomingMessage: { content: 'こんにちは', messageType: 'text', createdAt: '2026-09-01T10:00:00+09:00' }, latestOutgoingAt: '2026-09-20T10:00:00+09:00' }),
      row('受信が新しい人', { chatStatus: 'unread', latestIncomingMessage: { content: 'まだですか', messageType: 'text', createdAt: '2026-09-25T10:00:00+09:00' }, latestOutgoingAt: '2026-09-02T10:00:00+09:00' }),
    ]))
    render(<List />)
    const replied = (await screen.findByText('返信が新しい人')).closest('tr')!
    const received = screen.getByText('受信が新しい人').closest('tr')!
    expect(within(replied).getByText('保留')).toBeTruthy()
    expect(within(replied).getByText(monthDay('2026-09-20T10:00:00+09:00'))).toBeTruthy()
    expect(within(received).getByText('未対応')).toBeTruthy()
    expect(within(received).getByText(monthDay('2026-09-25T10:00:00+09:00'))).toBeTruthy()
    expect(within(replied).queryByText(monthDay('2026-09-01T10:00:00+09:00'))).toBeNull()
  })
})
