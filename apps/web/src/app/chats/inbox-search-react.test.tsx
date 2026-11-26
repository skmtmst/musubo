// @vitest-environment happy-dom
/* 受信箱の会話の中を探す（2026-10-07 オーナー採用）と、読み上げの全件数。 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ChatsPage from './page'

const fixture = vi.hoisted(() => ({
  params: new URLSearchParams('friend=friend-a'),
}))

vi.mock('next/link', () => ({ default: () => null }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => fixture.params,
  usePathname: () => '/chats',
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: 'account-a',
    selectedAccount: null,
    loading: false,
  }),
}))

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

const calls: URL[] = []
const msg = (id: string, content: string, at: string) => ({
  id, direction: 'incoming', messageType: 'text', content, isUnsent: false, source: 'user', originKind: null,
  sentByStaffId: null, sentByStaffName: null, scenarioName: null, quoted: null, createdAt: at,
})
const detail = () => ({
  id: 'friend-a', friendId: 'friend-a', friendName: '探す確認', friendRealName: null, friendPictureUrl: null,
  isAttention: false, operatorId: null, status: 'unread', notes: null, revision: 1,
  lastMessageAt: '2026-09-16T01:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z', total: 1500,
})

function responseFor(url: URL): Response {
  if (url.pathname === '/api/chats') return json({ success: true, data: [] })
  if (url.pathname === '/api/chats/stats') {
    return json({ success: true, data: {
      total: 0, unread: 0, inProgress: 0, onHold: 0, resolved: 0,
      oldestUnansweredMinutes: null, assigneeUnread: [],
    } })
  }
  if (url.pathname === '/api/support/inbox') {
    return json({ success: true, data: { items: [], summary: { total: 0 } } })
  }
  if (url.pathname === '/api/operators') return json({ success: true, data: [] })
  if (url.pathname === '/api/inbox/saved-views') return json({ success: true, data: [] })
  if (url.pathname === '/api/friends/friend-a') {
    return json({ success: true, data: {
      id: 'friend-a', displayName: '探す確認', pictureUrl: null, isFollowing: true,
      metadata: {}, lineAccountId: 'account-a', realName: null, systemDisplayName: null,
      refCode: null, createdAt: '2026-09-01T00:00:00.000Z', tags: [],
      formSubmissions: [], support: null,
    } })
  }
  if (url.pathname === '/api/chats/friend-a/messages/search') {
    calls.push(url)
    return json({ success: true, data: {
      total: 2,
      hits: [
        { id: 'old-1', at: '2026-08-01T00:00:00.000Z', excerpt: '定期便', before: null, after: null, cursor: { at: '2026-08-01T00:00:00.000Z', id: 'old-1' } },
        { id: 'new-2', at: '2026-09-16T01:00:00.000Z', excerpt: '定期便', before: null, after: null, cursor: { at: '2026-09-16T01:00:00.000Z', id: 'new-2' } },
      ],
      nextOffset: null,
    } })
  }
  if (url.pathname === '/api/chats/friend-a' && url.searchParams.get('beforeAt')) {
    calls.push(url)
    return json({ success: true, data: { ...detail(), messages: [msg('old-1', '昔の定期便のこと', '2026-08-01T00:00:00.000Z'), msg('old-2', 'ほかの話', '2026-08-02T00:00:00.000Z')], hasMoreMessages: false } })
  }
  if (url.pathname === '/api/chats/friend-a') {
    return json({ success: true, data: { ...detail(), messages: [msg('new-1', 'こんにちは', '2026-09-16T00:00:00.000Z'), msg('new-2', '定期便を追加したい', '2026-09-16T01:00:00.000Z')], hasMoreMessages: true } })
  }
  if (url.pathname.endsWith('/mileage')) {
    return json({ success: true, data: {
      summary: { programId: 'p', programName: 'マイル', available: 0, pending: 0, lifetimeEarned: 0, spent: 0 },
      history: [],
    } })
  }
  if (url.pathname.endsWith('/rich-menu')) {
    return json({ success: true, data: { id: null, name: null, isDefault: false } })
  }
  if (url.pathname.endsWith('/read')) return json({ success: true, data: { isUnread: false } })
  return json({ success: true, data: [] })
}

async function eventually(check: () => void, timeout = 1_500): Promise<void> {
  const started = Date.now()
  while (true) {
    try {
      check()
      return
    } catch (error) {
      if (Date.now() - started >= timeout) throw error
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    }
  }
}

describe('会話の中を探す（V8 M0393 段13・枠 v7GV2）', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    calls.length = 0
    fixture.params = new URLSearchParams('friend=friend-a')
    document.documentElement.dataset.theme = 'v8'
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
    vi.stubGlobal('fetch', (input: string | URL) => responseFor(new URL(String(input), 'http://localhost')))
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    delete document.documentElement.dataset.theme
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('読み上げの全件数は口の total（前がまだあっても -1 にしない）', async () => {
    await act(async () => root.render(<ChatsPage />))
    await eventually(() => expect(host.textContent).toContain('定期便を追加したい'))
    const rows = host.querySelectorAll('[role="article"]')
    expect(rows[rows.length - 1].getAttribute('aria-setsize')).toBe('1500')
    expect(rows[rows.length - 1].getAttribute('aria-posinset')).toBe('1500')
    expect(rows[0].getAttribute('aria-posinset')).toBe('1499')
  })

  it('上のバーの虫眼鏡を押すと検索の帯が開き、開いている間は押した状態になる', async () => {
    await act(async () => root.render(<ChatsPage />))
    await eventually(() => expect(host.textContent).toContain('定期便を追加したい'))
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="会話の中を探す"]')!
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('[role="search"]')).toBeNull()
    await act(async () => { button.click() })
    expect(host.querySelector('input[type="search"][aria-label="会話の中を探す"]')).not.toBeNull()
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="会話の中を探す"]')?.getAttribute('aria-expanded')).toBe('true')
  })

  it('⌘F で帯を出し、読み込んでいない昔の当たりまで読み足して太い枠で示す', async () => {
    await act(async () => root.render(<ChatsPage />))
    await eventually(() => expect(host.textContent).toContain('定期便を追加したい'))
    expect(host.querySelector('[role="search"]')).toBeNull()

    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true })) })
    const input = host.querySelector<HTMLInputElement>('input[type="search"][aria-label="会話の中を探す"]')!
    expect(input).not.toBeNull()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, '定期便')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // いちばん新しい当たり（読み込み済み）。古い当たりは薄い枠にならない（まだ無い）
    await eventually(() => expect(host.querySelector('[role="status"]')?.textContent).toBe('2 件中 2 件目'))
    await eventually(() => expect(host.querySelector('[data-search-hit="current"]')?.textContent).toContain('定期便を追加したい'))

    // Enter で古い方へ：old-1 は読み込んでいないので、最古の1件から 1,000 件ずつ読み足す
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await eventually(() => expect(host.querySelector('[data-search-hit="current"]')?.textContent).toContain('昔の定期便のこと'))
    const fill = calls.find((u) => u.pathname === '/api/chats/friend-a' && u.searchParams.get('beforeAt'))!
    expect(fill.searchParams.get('beforeId')).toBe('new-1')
    expect(fill.searchParams.get('limit')).toBe('1000')
    expect(host.querySelector('[data-search-hit="other"]')?.textContent).toContain('定期便を追加したい')
    expect(host.querySelector('[role="status"]')?.textContent).toBe('2 件中 1 件目')
    // 読み足した分は新しい方とつながったまま（4件・前はもう無い）
    expect(host.querySelector('[role="feed"]')?.getAttribute('data-loaded')).toBe('4')

    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(host.querySelector('[role="search"]')).toBeNull()
    expect(host.querySelector('[data-search-hit]')).toBeNull()
  })

})
