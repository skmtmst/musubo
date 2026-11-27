// @vitest-environment happy-dom
import { StrictMode, useEffect, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../api'
import { loadLineAccounts } from '../line-accounts-cache'
import { forgetStaffIdentity } from '../staff-identity-state'
import { clearCommonCaches } from '../common-caches'
import { useInboxStats } from '../../v8/inbox-chat/use-inbox-stats'
import MediaList from '../../v8/contents/list'
import Accounts from '../../v8/settings/accounts/accounts'
import Staff from '../../v8/settings/staff/staff'
import Friends from '../../v8/friends/list/list'
import Broadcasts from '../../v8/broadcasts/list'
import { useAccountStyle } from '../../hooks/use-account-style'
import { UNANSWERED_REFRESH_EVENT } from '../events'

const fixture = vi.hoisted(() => ({ path: '/friends' }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => fixture.path,
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', selectedAccount: null, accounts: [], loading: false, refreshAccounts: vi.fn() }),
}))
vi.mock('@/components/shell/page-chrome', async original => ({
  ...await original<typeof import('@/components/shell/page-chrome')>(),
  usePageTitle: () => undefined, usePageCrumbs: () => undefined,
}))

const calls: string[] = []
const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }))
const count = (path: string) => calls.filter(url => new URL(url).pathname === path).length
const counts = { total: 21, byKind: { image: 8, video: 5, audio: 4, file: 4 }, unused: 3, archived: 2 }
const settle = async () => {
  for (let i = 0; i < 16; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

/** 実際の外枠と同じ共通読取口を先に使い、画面固有の読取と合わせて通信を数える。 */
function Frame({ children }: { children: ReactNode }) {
  useEffect(() => { void loadLineAccounts(); void api.staff.me() }, [])
  return children
}

beforeEach(() => {
  clearCommonCaches()
  calls.length = 0
  localStorage.clear()
  sessionStorage.clear()
  localStorage.setItem('lh_csrf', 'fixture-session')
  localStorage.setItem('lh_selected_account', 'account-a')
  forgetStaffIdentity()
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    calls.push(input)
    const path = new URL(input).pathname
    if (path === '/api/staff/me') return json({ id: 'staff-a', role: 'owner', accountScope: 'all' })
    if (path === '/api/line-accounts') return json([])
    if (path === '/api/staff') return json([])
    if (path === '/api/auth/two-factor/policy') return json({ required: false })
    if (path === '/api/auth/two-factor/self') return json({ staffId: 'staff-a', enabled: false })
    if (path === '/api/auth/sessions') return json({ sessions: [] })
    if (path === '/api/auth/trusted-logins') return json([])
    if (path === '/api/access/users') return json({ items: [], pagination: { total: 0 }, summary: { active: 0, suspended: 0, mfaEnabled: 0, invited: 0 } })
    if (path === '/api/access/roles') return json({ items: [] })
    if (path === '/api/media') return json({ items: [], total: 21, limit: 20, offset: 0 })
    if (path === '/api/media/counts') return json(counts)
    if (path === '/api/media/quota') return json({ usageBytes: 1, reservedBytes: 0, limitBytes: 100, remainingBytes: 99, usageRate: 0.01, state: 'normal' })
    if (path === '/api/file-scans/health') return json({ stopped: false })
    if (path === '/api/friends') return json({ items: [], total: 0, nextCursor: null })
    if (path === '/api/broadcasts') return json([])
    if (path === '/api/scenarios') return json({ items: [], total: 0 })
    if (path === '/api/chats/stats') return json({ assigneeUnread: [] })
    if (path === '/api/chats/quick-counts') return json({ all: 20, reply: 3, overdue: 1 })
    if (path === '/api/settings/features/visibility') return json({ features: {} })
    if (path === '/api/dashboard/style') return json({ style: 'ec' })
    if (path === '/api/dashboard/overview') return json({ delivery: { quotaLimit: 5000, quotaUsed: 0 } })
    if (path === '/api/friends/stats') return json({ total: 0, active: 0, blocked: 0, newToday: 0 })
    if (['/api/tags', '/api/scenarios', '/api/folders', '/api/operators', '/api/support-marks', '/api/friend-fields', '/api/broadcasts/saved-views', '/api/line-account-folders'].includes(path)) return json([])
    throw new Error(`Missing fixture: ${path}`)
  }))
})
afterEach(() => {
  if (process.env.API_READ_COUNTS_REPORT) {
    const byPath: Record<string, number> = {}
    for (const url of calls) { const path = new URL(url).pathname; byPath[path] = (byPath[path] ?? 0) + 1 }
    console.info('API_READ_COUNTS', JSON.stringify({ route: fixture.path, total: calls.length, byPath }))
  }
  cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})

it.each([[false, 'unread', 4], [true, 'unread', 4], [false, 'all', 5], [true, 'all', 5]] as const)('受信箱の各条件を1本に保つ（StrictMode=%s・状態=%s・本数=%s）', async (strict, statusFilter, expected) => {
  fixture.path = statusFilter === 'all' ? '/chats' : '/chats?status=unread'
  function InboxCounts() {
    const stats = useInboxStats({ selectedAccountId: 'account-a', statusFilter, debouncedNameQuery: '', assigneeFilter: 'all', unreadOnly: false, channel: 'line' })
    return <div>{stats.quickCountsNow?.all}</div>
  }
  const contents = <Frame><InboxCounts /></Frame>
  render(strict ? <StrictMode>{contents}</StrictMode> : contents)
  await settle()
  expect(screen.getByText('20')).toBeTruthy()
  expect(count('/api/chats/quick-counts')).toBe(expected)
  const statuses = calls.filter(url => new URL(url).pathname === '/api/chats/quick-counts').map(url => new URL(url).searchParams.get('status'))
  expect(new Set(statuses)).toEqual(new Set(statusFilter === 'all'
    ? ['in_progress', 'on_hold', 'resolved', 'unread', null]
    : ['in_progress', 'on_hold', 'resolved', 'unread']))
  expect(count('/api/staff/me')).toBe(1)
})

it('登録メディアは一覧1本と件数一括1本。容量も1本にし、同じ表示で増やさない', async () => {
  fixture.path = '/contents'
  window.history.replaceState(null, '', '/contents')
  render(<Frame><MediaList /></Frame>)
  await settle()
  expect(screen.getByText('登録メディア')).toBeTruthy()
  expect(count('/api/media')).toBe(1)
  expect(count('/api/media/counts')).toBe(1)
  expect(count('/api/media/quota')).toBe(1)
  expect(count('/api/staff/me')).toBe(1)
  // 種別・未使用・保管済みの実値と容量を、一覧の部分件数で置き換えない。
  expect(screen.getByText('画像 8')).toBeTruthy()
  expect(screen.getByText('どこでも使っていない 3')).toBeTruthy()
  expect(screen.getByRole('heading', { name: '登録メディア一覧', exact: true })).toBeTruthy()
  expect(screen.getByRole('button', { name: /^すべて\s*21$/ })).toBeTruthy()
  expect(document.body.textContent).toContain('登録メディア21件')
  expect(document.body.textContent).toContain('アーカイブ2件')
  expect(document.body.textContent).toContain('100 B')
})

it('受信箱の再確認は、進行中の古い集計を共有せず取り直し、遅い旧応答も表示しない', async () => {
  fixture.path = '/chats-refresh'
  const pending: Array<(response: Response) => void> = []
  let fresh = false
  const original = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (new URL(String(input)).pathname === '/api/chats/quick-counts' && !fresh) {
      calls.push(String(input))
      return new Promise<Response>(resolve => { pending.push(resolve) })
    }
    return original(input, init)
  })
  function InboxCounts() {
    const stats = useInboxStats({ selectedAccountId: 'account-a', statusFilter: 'unread', debouncedNameQuery: '', assigneeFilter: 'all', unreadOnly: false, channel: 'line' })
    return <div>{stats.quickCountsNow?.all}</div>
  }
  render(<Frame><InboxCounts /></Frame>)
  await settle()
  expect(pending).toHaveLength(4)
  fresh = true
  act(() => window.dispatchEvent(new Event(UNANSWERED_REFRESH_EVENT)))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 130)) })
  await settle()
  expect(count('/api/chats/quick-counts')).toBe(8)
  expect(screen.getByText('20')).toBeTruthy()
  await act(async () => { pending.forEach(finish => finish(json({ all: 999, reply: 99, overdue: 99 }))) })
  expect(screen.getByText('20')).toBeTruthy()
  expect(screen.queryByText('999')).toBeNull()
})

it.each([
  ['/accounts', Accounts, '/api/line-accounts'],
  ['/staff', Staff, '/api/staff'],
  ['/friends', Friends, '/api/friends'],
  ['/broadcasts', Broadcasts, '/api/broadcasts'],
] as const)('%s の初回表示で主要な読取と本人・共通一覧をそれぞれ1本に保つ', async (path, Component, resource) => {
  fixture.path = path
  window.history.replaceState(null, '', path)
  const view = render(<Frame><Component /></Frame>)
  await settle()
  expect(count(resource)).toBe(1)
  expect(count('/api/line-accounts')).toBe(1)
  expect(count('/api/staff/me')).toBe(1)
  expect(view.container.textContent).not.toContain('読み込めませんでした')
})

it('共通の読み直しフックへつないだボタンは、30秒以内でも必ず通信する', async () => {
  fixture.path = '/style-reload'
  function StyleProbe() {
    const { data, reload } = useAccountStyle('account-a')
    return <><span>{data?.style}</span><button onClick={reload}>すべて読み直す</button></>
  }
  render(<StyleProbe />)
  await settle()
  expect(screen.getByText('ec')).toBeTruthy()
  expect(count('/api/dashboard/style')).toBe(1)
  fireEvent.click(screen.getByRole('button', { name: 'すべて読み直す' }))
  await settle()
  expect(count('/api/dashboard/style')).toBe(2)
})
