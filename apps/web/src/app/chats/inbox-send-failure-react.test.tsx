// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ChatsPage from './page'
import { setTextControlValue } from '@/test-utils/text-control'

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

let sendKeys: Array<string | null> = []
let requests: Array<{ url: string; path: string; method: string }> = []

let sendResponse: () => Response = () => json({
  success: true,
  data: { sent: true, messageId: 'm-1', sentByStaffName: '自分', revision: 2 },
})

function responseFor(url: URL, init?: RequestInit): Response {
  requests.push({ url: url.href, path: url.pathname, method: init?.method ?? 'GET' })
  if (url.pathname === '/api/chats/friend-a/send' && init?.method === 'POST') {
    sendKeys.push(new Headers(init.headers).get('Idempotency-Key'))
    return sendResponse()
  }
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
      id: 'friend-a', displayName: '失敗確認', pictureUrl: null, isFollowing: true,
      metadata: {}, lineAccountId: 'account-a', realName: null, systemDisplayName: null,
      refCode: null, createdAt: '2026-09-01T00:00:00.000Z', tags: [],
      formSubmissions: [], support: null,
    } })
  }
  if (url.pathname === '/api/chats/friend-a') {
    return json({ success: true, data: {
      id: 'friend-a', friendId: 'friend-a', friendName: '失敗確認',
      friendRealName: null, friendPictureUrl: null, isAttention: false,
      operatorId: null, status: 'unread', notes: null, revision: 1,
      lastMessageAt: '2026-09-16T01:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z',
      messages: [], hasMoreMessages: false,
    } })
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

describe('N-028/N-029 受信箱送信の失敗理由', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    sendKeys = []
    requests = []
    fixture.params = new URLSearchParams('friend=friend-a')
    sendResponse = () => json({
      success: true,
      data: { sent: true, messageId: 'm-1', sentByStaffName: '自分', revision: 2 },
    })
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
    vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) =>
      Promise.resolve(responseFor(new URL(String(input), 'http://localhost'), init)))
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

  async function typeAndSend(text: string) {
    // 返信欄は差し込みを札で見せる欄。textarea と同じく value と input で書ける。
    const textarea = host.querySelector<HTMLElement>('[aria-label="メッセージを入力"]')!
    expect(textarea).not.toBeNull()
    await act(async () => { setTextControlValue(textarea, text) })
    const button = Array.from(host.querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === '送信する')!
    await act(async () => { button.click() })
  }

  it('画面の手動返信は受信箱の口へ1回送り、Proxyへ送らない', async () => {
    await act(async () => root.render(<ChatsPage />))
    await eventually(() => expect(host.querySelector('[aria-label="メッセージを入力"]')).not.toBeNull())
    requests = []
    await typeAndSend('こんにちは')
    expect(requests.filter(request => request.method === 'POST' && request.path.includes('/send')).map(request => request.path)).toEqual(['/api/chats/friend-a/send'])
    expect(requests.some(request => /line-proxy|\/v2\/bot\/message\/push/.test(request.url))).toBe(false)
  })

  it('429は送信制限と待機時間を入力欄の近くへ出し、入力を残す', async () => {
    sendResponse = () => json({
      success: false,
      code: 'LINE_RATE_LIMITED',
      data: { retryable: true, nextRetryAt: new Date(Date.now() + 7 * 60_000).toISOString() },
    }, 429)
    await act(async () => root.render(<ChatsPage />))
    await eventually(() =>
      expect(host.querySelector('[aria-label="メッセージを入力"]')).not.toBeNull())

    await typeAndSend('制限に当たる文')

    await eventually(() => {
      expect(host.textContent).toContain('送信制限')
      expect(host.textContent).toContain('分後')
    })
    const textarea = host.querySelector('[aria-label="メッセージを入力"]') as HTMLElement & { value: string }
    expect(textarea.value).toBe('制限に当たる文')
    expect(textarea.closest('[data-inbox-v4="composer"]')?.textContent).toContain('送信制限')
  })

  it('失敗した同じ本文の再送には同じ鍵を使い、成功した後の送信は新しい鍵にする', async () => {
    sendResponse = () => json({ success: false, code: 'LINE_RATE_LIMITED' }, 429)
    await act(async () => root.render(<ChatsPage />))
    await eventually(() => expect(host.querySelector('[aria-label="メッセージを入力"]')).not.toBeNull())
    await typeAndSend('再送する文')
    expect(sendKeys).toHaveLength(1)
    expect(sendKeys[0]).toBeTruthy()
    sendResponse = () => json({ success: true, data: { sent: true, sentByStaffName: '自分', revision: 2 } })
    await typeAndSend('再送する文')
    expect(sendKeys).toEqual([sendKeys[0], sendKeys[0]])
    expect(host.querySelector('[data-inbox-v4="composer"]')?.textContent).not.toContain('送信制限')
    await typeAndSend('再送する文')
    expect(sendKeys).toHaveLength(3)
    expect(sendKeys[2]).not.toBe(sendKeys[0])
  })

  it('送達不明は二重送信を止める案内を出す', async () => {
    sendResponse = () => json({
      success: false,
      code: 'OUTBOUND_CONFIRMATION_FAILED',
      data: { retryable: false, nextRetryAt: null },
    }, 503)
    await act(async () => root.render(<ChatsPage />))
    await eventually(() =>
      expect(host.querySelector('[aria-label="メッセージを入力"]')).not.toBeNull())

    await typeAndSend('届いたか不明な文')

    await eventually(() => expect(host.textContent).toContain('自動再送'))
  })

  it('差し込みが入らず送信口が止めたときは送らず、記号を出さずに直し方を出し、入力を残す', async () => {
    sendResponse = () => json({
      success: false,
      error: '差し込みを解決できません: {{var.guest_count}}',
      code: 'UNRESOLVED_TEMPLATE_VARIABLES',
      data: { variables: ['var.guest_count'] },
    }, 400)
    await act(async () => root.render(<ChatsPage />))
    await eventually(() => expect(host.querySelector('[aria-label="メッセージを入力"]')).not.toBeNull())
    await typeAndSend('{{var.guest_count}}名でお待ちしています')
    await eventually(() => expect(host.textContent).toContain('入らないため、送りませんでした'))
    const composer = host.querySelector('[data-inbox-v4="composer"]')!
    // 口が返した差し込みの名前を、返信欄と同じ札の名前（人数）で言う。名前の無い一般の文にしない。
    const failure = composer.querySelector('[role="alert"]')!
    expect(failure.textContent).toContain('「人数」が入らないため、送りませんでした。その部分を書き換えるか消してから、送り直してください。')
    expect(failure.textContent).not.toContain('差し込みの値が入らないため')
    expect(composer.textContent).not.toContain('{{')
    expect(composer.querySelector('[data-token="{{var.guest_count}}"]')?.textContent).toBe('人数')
    expect((host.querySelector('[aria-label="メッセージを入力"]') as HTMLElement & { value: string }).value).toBe('{{var.guest_count}}名でお待ちしています')
  })

  it('リビジョン競合の409は従来どおり読み直しを促す', async () => {
    sendResponse = () => json({ success: false, error: 'revision conflict' }, 409)
    await act(async () => root.render(<ChatsPage />))
    await eventually(() =>
      expect(host.querySelector('[aria-label="メッセージを入力"]')).not.toBeNull())

    await typeAndSend('競合する文')

    await eventually(() => expect(host.textContent).toContain('読み直してください'))
  })
})
