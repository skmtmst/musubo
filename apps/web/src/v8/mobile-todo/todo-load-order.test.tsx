// @vitest-environment happy-dom
/*
 * 電話の画面の「対応」（/m/todo）。
 * - 返事を待っているトーク（受信箱の未対応）と、まだ読んでいないエラーのお知らせをカード 1 列で出す。
 * - 受信箱を見る権限が無い人にはトークの段を出さない（口も呼ばない）。
 * - /m に当たる画面が無いお知らせは PC の画面で開く。押すと既読を付ける。
 * - 段ごとの失敗は 0 件と分けて出す。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  canView: true,
  chatStatus: 200,
  accountId: 'account-a',
  calls: [] as string[],
}))

vi.mock('next/link', () => ({
  default: ({ href, children, onClick, ...props }: { href: string; children: React.ReactNode; onClick?: () => void }) => (
    <a href={href} onClick={(event) => { event.preventDefault(); onClick?.() }} {...props}>{children}</a>
  ),
}))
vi.mock('next/navigation', () => ({
  usePathname: () => '/m/todo',
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }),
}))
vi.mock('@/components/auth-guard', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('@/contexts/account-context', () => ({
  AccountProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAccount: () => ({
    accounts: [{ id: 'account-a', name: '店A', displayName: '店A', iconUrl: null, pictureUrl: null, basicId: null }],
    selectedAccountId: fixture.accountId,
    setSelectedAccountId() {},
    loading: false,
  }),
}))
vi.mock('@/lib/staff-role', async (original) => ({
  ...(await original<typeof import('@/lib/staff-role')>()),
  useStaffRole: () => 'staff',
}))
vi.mock('@/lib/staff-capability', () => ({
  canViewFeature: () => fixture.canView,
  canEditFeature: () => fixture.canView,
}))

import MobileShell from '@/components/mobile/mobile-shell'
import MobileTodoScreen from './todo-screen'

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

const notices = [
  { id: 'n-1', eventType: 'broadcast_failed', category: 'error', title: '配信が止まりました', body: '5 件に届きませんでした', metadata: null, isRead: false, createdAt: '2026-10-26T01:00:00.000Z' },
  { id: 'n-2', eventType: 'broadcast_failed', category: 'error', title: '既に読んだエラー', body: '', metadata: null, isRead: true, createdAt: '2026-10-25T01:00:00.000Z' },
]

function responseFor(url: URL, init?: RequestInit): Response {
  fixture.calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`)
  if (url.pathname === '/api/chats') {
    return fixture.chatStatus === 200
      ? json({ success: true, data: [{ id: 'friend-a', friendId: 'friend-a', friendName: '山田', status: 'unread', isUnread: true, lastMessageAt: '2026-10-26T01:00:00.000Z', lastMessageContent: '予約できますか', lastMessageType: 'text', lastMessageDirection: 'incoming' }] })
      : json({ success: false, error: 'boom' }, fixture.chatStatus)
  }
  if (url.pathname === '/api/notifications/center') return json({ success: true, data: { items: notices, counts: { all: 2, error: 2, update: 0, unread: 1 }, unreadCount: 1 } })
  if (url.pathname === '/api/inbox/unanswered/count') return json({ success: true, data: { total: 1, byAccount: [] } })
  if (url.pathname === '/api/auth/session') return json({ success: true, data: { impersonation: null } })
  return json({ success: true, data: null })
}

async function eventually(check: () => void, timeout = 2_000): Promise<void> {
  const started = Date.now()
  while (true) {
    try { check(); return } catch (error) {
      if (Date.now() - started >= timeout) throw error
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    }
  }
}

describe('電話の画面の対応', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    Object.assign(fixture, { canView: true, chatStatus: 200, accountId: 'account-a', calls: [] })
    vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} })
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem() {}, removeItem() {} })
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => responseFor(new URL(String(input), 'http://localhost'), init))
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const show = async () => { await act(async () => root.render(<MobileShell><MobileTodoScreen /></MobileShell>)) }

  it('返事を待っているトークと、まだ読んでいないエラーだけをカードで出す', async () => {
    await show()
    await eventually(() => expect(host.querySelector('a[href="/m/chats?friend=friend-a"]')).not.toBeNull())
    expect(fixture.calls.some((call) => call.startsWith('GET /api/chats?') && call.includes('status=unread') && call.includes('lineAccountId=account-a'))).toBe(true)
    expect(host.textContent).toContain('配信が止まりました')
    expect(host.textContent).not.toContain('既に読んだエラー')
  })

  it('/m に無い行き先のお知らせは PC の画面で開き、押すと既読を付ける', async () => {
    await show()
    const card = await (async () => {
      await eventually(() => expect(host.querySelector('a[aria-label="配信が止まりました（PC の画面で開く）"]')).not.toBeNull())
      return host.querySelector<HTMLAnchorElement>('a[aria-label="配信が止まりました（PC の画面で開く）"]')!
    })()
    expect(card.getAttribute('href')?.startsWith('/m')).toBe(false)
    expect(card.textContent).toContain('PC の画面で開く')
    await act(async () => { card.click() })
    await eventually(() => expect(fixture.calls).toContain('POST /api/notifications/center/n-1/read'))
  })

  it('受信箱を見る権限が無い人にはトークの段を出さず、口も呼ばない', async () => {
    fixture.canView = false
    await show()
    await eventually(() => expect(host.textContent).toContain('配信が止まりました'))
    expect(host.textContent).not.toContain('返事を待っているトーク')
    expect(fixture.calls.some((call) => call.startsWith('GET /api/chats?'))).toBe(false)
  })

  it('トークが読めない時は 0 件と言わず、失敗ともう一度試すを出す', async () => {
    fixture.chatStatus = 500
    await show()
    await eventually(() => expect(host.textContent).toContain('トークを読み込めませんでした'))
    expect(host.textContent).not.toContain('返事を待っているトークはありません')
  })

  it('お知らせの読み込みが長くてもトークを先に表示する', async () => {
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/notifications/center') return new Promise<Response>(() => {})
      return responseFor(url, init)
    })
    await show()
    await eventually(() => expect(host.querySelector('a[href="/m/chats?friend=friend-a"]')).not.toBeNull())
    expect(host.querySelector('[aria-label="お知らせを読み込んでいます"]')).not.toBeNull()
  })

  it('トークの読み込みが長くてもお知らせを先に表示する', async () => {
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/chats') return new Promise<Response>(() => {})
      return responseFor(url, init)
    })
    await show()
    await eventually(() => expect(host.textContent).toContain('配信が止まりました'))
    expect(host.querySelector('[aria-label="トークを読み込んでいます"]')).not.toBeNull()
  })

  it('店をAからBへ切り替えてAに戻した後、古いAの結果を表示しない', async () => {
    let resolveOld!: (response: Response) => void
    let firstA = true
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/chats' && url.searchParams.get('lineAccountId') === 'account-a' && firstA) {
        firstA = false
        return new Promise<Response>((resolve) => { resolveOld = resolve })
      }
      return responseFor(url, init)
    })
    await show()
    fixture.accountId = 'account-b'
    await show()
    fixture.accountId = 'account-a'
    await show()
    await eventually(() => expect(host.textContent).toContain('山田'))
    await act(async () => { resolveOld(json({ success: true, data: [{ id: 'old', friendId: 'old', friendName: '古い結果', status: 'unread', isUnread: true, lastMessageAt: '2026-10-26T01:00:00.000Z', lastMessageContent: '古い', lastMessageType: 'text', lastMessageDirection: 'incoming' }] })) })
    expect(host.textContent).toContain('山田')
    expect(host.textContent).not.toContain('古い結果')
  })
})
