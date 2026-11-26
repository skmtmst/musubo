// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import ChatsPage from './page'

const fixture = vi.hoisted(() => ({ params: new URLSearchParams(), chatQueries: [] as URLSearchParams[] }))

vi.mock('next/link', () => ({ default: () => null }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => fixture.params,
  usePathname: () => '/chats',
  useRouter: () => ({ push() {}, replace() {} }),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: 'account-a',
    selectedAccount: { emailInboxEnabled: true },
    loading: false,
  }),
}))

const response = (data: unknown) => new Response(JSON.stringify(data), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
})

let root: Root
let host: HTMLDivElement

async function eventually(check: () => void, timeout = 1000) {
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

beforeEach(() => {
  fixture.params = new URLSearchParams()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem() {},
    removeItem() {},
  })
  fixture.chatQueries = []
  vi.stubGlobal('fetch', (input: string | URL) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/chats') {
      fixture.chatQueries.push(url.searchParams)
      // 既定の口は「未読が先・新しい順」、sort=latest は新しい順だけで返す。画面はこの順のまま混ぜる。
      const rows = [
        {
          id: 'chat-unread-old', friendId: 'friend-unread-old', friendName: 'LINE未読古', operatorId: null,
          status: 'resolved', isUnread: true, lastMessageAt: '2026-08-30T00:00:00.000Z',
          lastMessageContent: '古いが未読', lastMessageType: 'text', lastMessageDirection: 'incoming',
        },
        {
          id: 'chat-new', friendId: 'friend-new', friendName: 'LINE新', operatorId: null,
          status: 'resolved', isUnread: false, lastMessageAt: '2026-09-03T00:00:00.000Z',
          lastMessageContent: '最新', lastMessageType: 'text', lastMessageDirection: 'incoming',
        },
        {
          id: 'chat-old', friendId: 'friend-old', friendName: 'LINE古', operatorId: null,
          status: 'resolved', isUnread: false, lastMessageAt: '2026-09-01T00:00:00.000Z',
          lastMessageContent: '最古', lastMessageType: 'text', lastMessageDirection: 'incoming',
        },
      ]
      const data = url.searchParams.get('sort') === 'latest'
        ? [...rows].sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
        : rows
      return response({ success: true, data })
    }
    if (url.pathname === '/api/support/inbox') {
      return response({ success: true, data: {
        // メールの口は並びの指定を持たず、未読が先で返す。
        items: [{
          id: 'email:unread-old', threadId: 'thread-unread-old', customerName: 'メール未読古',
          customerIdentifier: 'old@example.test', subject: '古い未読', preview: '古い未読',
          status: 'resolved', assignedStaffId: null, isUnread: true,
          lastIncomingAt: '2026-08-29T00:00:00.000Z', lastMessageAt: '2026-08-29T00:00:00.000Z',
        }, {
          id: 'email:middle', threadId: 'thread-middle', customerName: 'メール中',
          customerIdentifier: 'middle@example.test', subject: '中間', preview: '中間',
          status: 'resolved', assignedStaffId: null, isUnread: false,
          lastIncomingAt: '2026-09-02T00:00:00.000Z', lastMessageAt: '2026-09-02T00:00:00.000Z',
        }],
        summary: { total: 2 },
      } })
    }
    if (url.pathname === '/api/operators') return response({ success: true, data: [] })
    if (url.pathname === '/api/chats/stats') {
      return response({ success: true, data: {
        total: 3, unread: 0, assigneeUnread: [], waiting: 0, waitingOverAnHour: 0,
      } })
    }
    return response({ success: true, data: [] })
  })

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

async function renderList() {
  await act(async () => root.render(<ChatsPage />))
  await eventually(() => {
    expect(host.textContent).toContain('LINE新')
    expect(host.textContent).toContain('メール中')
    expect(host.textContent).toContain('LINE古')
    expect(host.textContent).toContain('LINE未読古')
    expect(host.textContent).toContain('メール未読古')
  })
  return host.querySelector<HTMLElement>('[data-inbox-v4="conversation-list"]')!
}

const order = (list: HTMLElement) => {
  const rendered = list.textContent ?? ''
  return ['LINE未読古', 'メール未読古', 'LINE新', 'メール中', 'LINE古'].sort((a, b) => rendered.indexOf(a) - rendered.indexOf(b))
}

test('受信箱を開いたまま時間が進むと時刻だけを更新し、復帰時も現在に追いつく', async () => {
  let now = Date.parse('2026-09-03T00:00:30Z')
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
  try {
    const list = await renderList()
    const lineRow = list.querySelector('#chat-row-name-chat-new')?.closest('button')
    if (!lineRow) throw new Error('LINEのトーク行が見つかりません')
    expect(lineRow.textContent).toContain('たった今')
    const calls = fixture.chatQueries.length
    now += 60_000
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(lineRow.textContent).toContain('1分前')
    expect(lineRow.querySelector('[title*="1分前"]')).toBeTruthy()
    expect(fixture.chatQueries).toHaveLength(calls)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    now += 120_000
    await act(async () => { vi.advanceTimersByTime(120_000) })
    expect(lineRow.textContent).toContain('1分前')
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(lineRow.textContent).toContain('3分前')
    now = Date.parse('2026-09-02T00:00:30Z')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    const emailName = [...list.querySelectorAll('p')].find(element => element.textContent === 'メール中')!
    const emailRow = emailName.closest('button')!
    expect(emailRow.textContent).toContain('たった今')
    now += 60_000
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(emailRow.textContent).toContain('1分前')
    expect(fixture.chatQueries).toHaveLength(calls)
  } finally {
    if (visibility) Object.defineProperty(document, 'visibilityState', visibility)
    else Reflect.deleteProperty(document, 'visibilityState')
    vi.useRealTimers()
  }
})

test('時計の更新前に新着が届いて再描画される時は現在の時刻で表示する', async () => {
  let now = Date.parse('2026-09-02T23:59:30Z')
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const list = await renderList()
  const lineRow = list.querySelector('#chat-row-name-chat-new')?.closest('button')
  if (!lineRow) throw new Error('LINEのトーク行が見つかりません')
  expect(lineRow.textContent).not.toContain('たった今')
  now += 35_000
  await act(async () => root.render(<ChatsPage />))
  expect(lineRow.textContent).toContain('たった今')
})

test('既定は未読が先・新しい順で、LINEとメールを統合する。口へは並びを送らない', async () => {
  const list = await renderList()
  // 並びの1段は無い。選んだ並びは題の横の印の吹き出しで分かる。
  expect(list.querySelector('[data-inbox-sort="choice"]')).toBeNull()
  const control = document.querySelector<HTMLButtonElement>('button[aria-label="並び順"]')
  expect(control?.getAttribute('title')).toBe('並び順：未読が先・新しい順')
  // 古いが未読の行が、新しい既読より先に来る。既読同士は新しい順。
  expect(order(list)).toEqual(['LINE未読古', 'メール未読古', 'LINE新', 'メール中', 'LINE古'])
  expect(fixture.chatQueries.every((query) => !query.has('sort'))).toBe(true)
})

test('「新しい順」を選ぶと URL の ?sort=latest に残す（ほかの指定は残す）', async () => {
  fixture.params = new URLSearchParams('from=dashboard')
  const replace = vi.spyOn(window.history, 'replaceState')
  const list = await renderList()
  const control = document.querySelector<HTMLButtonElement>('button[aria-label="並び順"]')!
  await act(async () => { control.click() })
  const option = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === '新しい順')
  expect(option).toBeTruthy()
  await act(async () => { option!.click() })
  const url = String(replace.mock.calls.at(-1)?.[2] ?? '')
  expect(new URL(url, 'http://localhost').searchParams.get('sort')).toBe('latest')
  expect(new URL(url, 'http://localhost').searchParams.get('from')).toBe('dashboard')
})

test('?sort=latest では未読を先にせず、LINEとメールを時刻だけで混ぜる。口へ sort=latest を送る', async () => {
  fixture.params = new URLSearchParams('sort=latest')
  const list = await renderList()
  expect(document.querySelector('button[aria-label="並び順"]')?.getAttribute('title')).toBe('並び順：新しい順')
  expect(order(list)).toEqual(['LINE新', 'メール中', 'LINE古', 'LINE未読古', 'メール未読古'])
  expect(fixture.chatQueries.length).toBeGreaterThan(0)
  expect(fixture.chatQueries.every((query) => query.get('sort') === 'latest' && !query.has('beforeUnread'))).toBe(true)
})

test('メニューの選んだ並びに ✓ と選択中の印が付く', async () => {
  await renderList()
  const control = document.querySelector<HTMLButtonElement>('button[aria-label="並び順"]')!
  await act(async () => { control.click() })
  const current = document.querySelector<HTMLElement>('[role="menuitem"][aria-label="未読が先・新しい順（選択中）"]')
  expect(current?.textContent).toContain('✓')
  expect(document.querySelector('[role="menuitem"][aria-label="新しい順"]')).not.toBeNull()
})
