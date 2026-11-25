// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatsPage from './page'

/**
 * 受信箱の★（注目切替）の競合を本物のReactで動かす試験(N-040 #808)。
 *
 * 本物の `ChatsPage` を mount し、通信(fetch)・アカウント文脈・
 * ルーティングだけを差し替える。確認するのは次の3点。
 * 1. 友だちの現行改訂値（updatedAt）を付けて送る。
 * 2. 409でも再送・上書きしない（PUTは1回だけ）。
 * 3. 読み直し可能な説明が出て、★表示が元に戻る。
 */

const fixture = vi.hoisted(() => ({
  accountId: 'account-a' as string,
  params: new URLSearchParams(),
}))

const net = vi.hoisted(() => ({
  calls: [] as string[],
  stamp: 'STAMP-1',
  putStatus: 200 as number,
  malformedEmails: false,
}))

vi.mock('next/link', () => ({ default: () => null }))

vi.mock('next/navigation', () => ({
  useSearchParams: () => fixture.params,
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/chats',
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: fixture.accountId, selectedAccount: { emailInboxEnabled: true }, loading: false }),
}))

function installFetch() {
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : String(input)
    const url = new URL(raw, 'https://example.com')
    const path = `${url.pathname}${url.search}`
    net.calls.push(`${(init?.method ?? 'GET').toUpperCase()} ${path}`)
    if (url.pathname === '/api/staff/me') {
      return new Response(JSON.stringify({ success: true, data: { id: 'owner', role: 'owner', name: '試験の担当者' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (path.includes('/api/friends/') && path.includes('/mileage')) {
      return new Response(JSON.stringify({ success: true, data: {
        summary: { programId: 'p', programName: '試験マイル', available: 0, pending: 0, lifetimeEarned: 0, spent: 0 },
        history: [], insights: null, selfInsights: null,
      } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (path.startsWith('/api/friends/friend-a/metadata')) {
      const body = net.putStatus === 200
        ? { success: true, data: { id: 'friend-a', updatedAt: 'STAMP-2' } }
        : { success: false, code: 'METADATA_CONFLICT', error: 'ほかの変更が先に保存されました' }
      return new Response(JSON.stringify(body), { status: net.putStatus, headers: { 'Content-Type': 'application/json' } })
    }
    if (path.startsWith('/api/support/inbox')) {
      return new Response(JSON.stringify({ success: true, data: net.malformedEmails ? null : { items: [], summary: { total: 0 } } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.pathname === '/api/friends/friend-a/fields') {
      return new Response(JSON.stringify({ success: true, data: { items: [], hiddenPersonalCount: 0 } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (path.startsWith('/api/friends/friend-a')) {
      return new Response(JSON.stringify({ success: true, data: {
        id: 'friend-a', displayName: 'A社 太郎', pictureUrl: null, isFollowing: true,
        metadata: {}, lineAccountId: 'account-a', refCode: null,
        createdAt: '2026-09-01T00:00:00.000Z', updatedAt: net.stamp, tags: [],
      } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (path.startsWith('/api/chats/stats')) {
      return new Response(JSON.stringify({ success: true, data: {
        total: 0, unread: 0, inProgress: 0, onHold: 0, resolved: 0,
        oldestUnansweredMinutes: null, assigneeUnread: [],
      } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (path.startsWith('/api/chats?')) {
      return new Response(JSON.stringify({ success: true, data: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (path.includes('/mileage')) {
      const body = path.includes('/api/friends/')
        ? { success: true, data: {
          summary: { programId: 'p', programName: '試験マイル', available: 0, pending: 0, lifetimeEarned: 0, spent: 0 },
          history: [], insights: null, selfInsights: null,
        } }
        : { success: true, data: {
          summary: { programId: 'p', programName: '試験マイル', available: 0, pending: 0, lifetimeEarned: 0, spent: 0 }, history: [],
        } }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (path.startsWith('/api/operators')) {
      return new Response(JSON.stringify({ success: true, data: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (path.startsWith('/api/chats/friend-a')) {
      return new Response(JSON.stringify({ success: true, data: {
        id: 'friend-a', friendId: 'friend-a', friendName: 'A社 太郎', friendRealName: null,
        friendPictureUrl: null, operatorId: null, status: 'unread', notes: null, revision: 1,
        isAttention: false, lastMessageAt: '2026-09-09T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z',
        messages: [], hasMoreMessages: false,
      } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  })
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  fixture.accountId = 'account-a'
  fixture.params = new URLSearchParams('friend=friend-a')
  net.calls.length = 0
  net.stamp = 'STAMP-1'
  net.putStatus = 200
  net.malformedEmails = false
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  installFetch()
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function render() {
  await act(async () => { root.render(<ChatsPage />) })
}

async function flush() {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  }
}

function starButton(): HTMLButtonElement | null {
  const buttons = Array.from(host.querySelectorAll('button'))
  return (buttons.find((b) => b.getAttribute('aria-label') === '注目にする' || b.getAttribute('aria-label') === '注目から外す') ?? null) as HTMLButtonElement | null
}

describe('注目切替の競合(N-040 #808)', () => {
  it('改訂値を付けて送り、成功したら★が付く', async () => {
    await render()
    await flush()
    const button = starButton()
    expect(button?.getAttribute('aria-label')).toBe('注目にする')
    await act(async () => { button?.click() })
    await flush()
    const puts = net.calls.filter((c) => c.startsWith('PUT /api/friends/friend-a/metadata'))
    expect(puts).toHaveLength(1)
    expect(puts[0]).toContain('expectedUpdatedAt=STAMP-1')
    expect(starButton()?.getAttribute('aria-label')).toBe('注目から外す')
  })

  it('409でも再送せず、説明を出して★を戻す', async () => {
    net.putStatus = 409
    await render()
    await flush()
    const button = starButton()
    expect(button?.getAttribute('aria-label')).toBe('注目にする')
    await act(async () => { button?.click() })
    await flush()
    const puts = net.calls.filter((c) => c.startsWith('PUT /api/friends/friend-a/metadata'))
    expect(puts).toHaveLength(1)
    expect(host.textContent).toContain('ほかの変更が先に保存されました')
    expect(starButton()?.getAttribute('aria-label')).toBe('注目にする')
  })
  it('メールの成功応答に一覧が無いときも、LINEの会話と失敗の案内を保つ', async () => {
    net.malformedEmails = true
    await render()
    await flush()
    expect(host.textContent).toContain('メールを読み込めませんでした。')
    expect(starButton()?.getAttribute('aria-label')).toBe('注目にする')
    expect(host.querySelector('[aria-label="メッセージを入力"]')).not.toBeNull()
  })

})
