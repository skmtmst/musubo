// @vitest-environment happy-dom
/*
 * 受信箱：会話を開いたら既読。未読の点と太字が消え、既読の口は1回だけ呼ぶ。
 * 既読の口が失敗しても会話は開き、次の読み直しで口の未読へ戻る。
 * LINE で取れない「既読」「届いた」「リアクション」の印は一覧に出さない。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { UNANSWERED_REFRESH_EVENT } from '@/lib/events'
import ChatsPage from './page'

const fixture = vi.hoisted(() => ({
  params: new URLSearchParams(),
  readCalls: [] as string[],
  readStatus: 200,
  listCalls: 0,
  savedRead: false,
  delayRead: false,
  finishRead: null as null | (() => void),
}))

vi.mock('next/link', () => ({ default: () => null }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => fixture.params,
  usePathname: () => '/chats',
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', selectedAccount: null, loading: false }),
}))

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

const chatRow = {
  id: 'friend-a', friendId: 'friend-a', friendName: '未読の人', operatorId: null,
  status: 'unread', isUnread: true, lastMessageAt: '2026-09-16T01:00:00.000Z',
  lastMessageContent: '届きましたか', lastMessageType: 'text', lastMessageDirection: 'incoming',
}

function responseFor(url: URL, init?: RequestInit): Response | Promise<Response> {
  if (url.pathname === '/api/chats') {
    fixture.listCalls += 1
    return json({ success: true, data: [{...chatRow, isUnread: !fixture.savedRead, unreadCount: fixture.savedRead ? 0 : 3}] })
  }
  if (url.pathname === '/api/chats/stats') {
    return json({ success: true, data: { total: 1, unread: 1, inProgress: 0, onHold: 0, resolved: 0, oldestUnansweredMinutes: null, assigneeUnread: [] } })
  }
  if (url.pathname === '/api/support/inbox') return json({ success: true, data: { items: [], summary: { total: 0 } } })
  if (url.pathname === '/api/operators') return json({ success: true, data: [] })
  if (url.pathname === '/api/inbox/saved-views') return json({ success: true, data: [] })
  if (url.pathname === '/api/chats/friend-a/read' && init?.method === 'POST') {
    fixture.readCalls.push(url.pathname)
    if (fixture.readStatus !== 200) return json({ success: false, error: 'boom' }, fixture.readStatus)
    const save = () => { fixture.savedRead = true; return json({ success: true, data: { isUnread: false } }) }
    return fixture.delayRead ? new Promise(resolve => { fixture.finishRead = () => resolve(save()) }) : save()
  }
  if (url.pathname === '/api/chats/friend-a') {
    return json({ success: true, data: {
      id: 'friend-a', friendId: 'friend-a', friendName: '未読の人', friendRealName: null, friendPictureUrl: null,
      isAttention: false, operatorId: null, status: 'unread', notes: null, revision: 1,
      lastMessageAt: '2026-09-16T01:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z', total: 1,
      messages: [{
        id: 'm-1', direction: 'incoming', messageType: 'text', content: '会話の本文です', isUnsent: false, source: 'user',
        originKind: null, sentByStaffId: null, sentByStaffName: null, scenarioName: null, quoted: null, createdAt: '2026-09-16T01:00:00.000Z',
      }],
      hasMoreMessages: false,
    } })
  }
  if (url.pathname === '/api/friends/friend-a') {
    return json({ success: true, data: {
      id: 'friend-a', displayName: '未読の人', pictureUrl: null, isFollowing: true, metadata: {}, lineAccountId: 'account-a',
      realName: null, systemDisplayName: null, refCode: null, createdAt: '2026-09-01T00:00:00.000Z', tags: [], formSubmissions: [], support: null,
    } })
  }
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

describe('受信箱：開いたら既読', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    fixture.params = new URLSearchParams()
    fixture.readCalls = []
    fixture.readStatus = 200
    fixture.listCalls = 0
    fixture.savedRead = false
    fixture.delayRead = false
    fixture.finishRead = null
    document.documentElement.dataset.theme = 'v8'
    vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} })
    vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => responseFor(new URL(String(input), 'http://localhost'), init))
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

  const list = () => host.querySelector<HTMLElement>('[data-inbox-v4="conversation-list"]')!
  const row = () => list().querySelector<HTMLButtonElement>('button[aria-labelledby="chat-row-name-friend-a"]')!
  const unreadDot = () => list().querySelector('#chat-row-unread-friend-a')
  const name = () => list().querySelector('#chat-row-name-friend-a')!

  async function renderUnread() {
    await act(async () => root.render(<ChatsPage />))
    await eventually(() => expect(row()).toBeTruthy())
    expect(unreadDot()).toBeTruthy()
    expect(unreadDot()?.textContent).toBe('3')
    expect(name().className).toContain('font-semibold')
  }

  it('行を押すと未読の点と太字が消え、既読の口を1回だけ呼ぶ', async () => {
    await renderUnread()
    await act(async () => { row().click() })
    await eventually(() => expect(host.textContent).toContain('会話の本文です'))
    expect(unreadDot()).toBeNull()
    expect(name().className).not.toContain('font-semibold')
    await eventually(() => expect(fixture.readCalls).toEqual(['/api/chats/friend-a/read']))
    await act(async () => { window.dispatchEvent(new Event(UNANSWERED_REFRESH_EVENT)) })
    await eventually(() => expect(fixture.listCalls).toBeGreaterThan(1))
    expect(unreadDot()).toBeNull()
  })

  it('既読の保存中に古い一覧が届いても未読へ戻らず、保存後も既読を保つ', async () => {
    fixture.delayRead = true
    await renderUnread()
    await act(async () => { row().click() })
    await eventually(() => expect(fixture.finishRead).toBeTruthy())
    const before = fixture.listCalls
    await act(async () => { window.dispatchEvent(new Event(UNANSWERED_REFRESH_EVENT)) })
    await eventually(() => expect(fixture.listCalls).toBeGreaterThan(before))
    expect(unreadDot()).toBeNull()
    await act(async () => { fixture.finishRead!() })
    await eventually(() => expect(fixture.savedRead).toBe(true))
    await eventually(() => expect(unreadDot()).toBeNull())
  })

  it('既読の口が失敗しても会話は開く。読み直しで口の未読へ戻る', async () => {
    fixture.readStatus = 500
    await renderUnread()
    await act(async () => { row().click() })
    await eventually(() => expect(host.textContent).toContain('会話の本文です'))
    expect(fixture.readCalls).toHaveLength(1)
    // 読み直し（一覧の取り直しの合図）で、口の返す未読のまま戻る。
    const before = fixture.listCalls
    await act(async () => { window.dispatchEvent(new Event(UNANSWERED_REFRESH_EVENT)) })
    await eventually(() => expect(fixture.listCalls).toBeGreaterThan(before), 3_000)
    await eventually(() => expect(unreadDot()).toBeTruthy())
  })

  it('LINE で取れない「既読」「届いた」「リアクション」の印を一覧に出さない', async () => {
    await renderUnread()
    const rowText = row().textContent ?? ''
    expect(rowText).not.toMatch(/既読|届いた|リアクション/)
    expect(list().querySelector('[aria-label*="既読"], [aria-label*="リアクション"], [title*="既読"]')).toBeNull()
  })
})
