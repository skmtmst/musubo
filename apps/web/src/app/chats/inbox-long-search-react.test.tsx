// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

// apiクライアントは起動時にAPI URLを要求する。実通信はfetch差替で止める。
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

import ChatsPage from './page'

/*
 * #625: 検索窓に2000文字入れたときの受信箱。
 *
 * D1 の LIKE パターン50バイト制限で一覧口が500になる事故があった。
 * サーバー側は instr に直したが、画面側は次を守る必要がある:
 *   - 長い検索語は上限(200文字)へ切り詰めてサーバーへ渡す
 *     （/api/chats 系は元々サーバー側でも200文字で切り詰める）
 *   - 0件なら「条件に一致する会話がありません」の空状態を出す
 *   - 口が落ちても無限「読み込み中」にせず、失敗行＋再読み込みを出す
 *   - タブ件数は失敗を 0 と読まず「—」のままにする
 */

const fixture = vi.hoisted(() => ({ accountId: 'account-a', params: new URLSearchParams() }))
vi.mock('next/link', () => ({ default: () => null }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => fixture.params,
  usePathname: () => '/chats',
  useRouter: () => ({ push() {}, replace() {} }),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({
  selectedAccountId: fixture.accountId, selectedAccount: { emailInboxEnabled: true }, loading: false,
}) }))

const LONG_QUERY = 'あ'.repeat(2000)
// 画面は検索語を上限200文字へ切り詰めて送る（search-query.ts の契約）。
const CLAMPED_QUERY = LONG_QUERY.slice(0, 200)

let root: Root
let host: HTMLDivElement
let calls: URL[]
let handler: (url: URL) => Promise<Response> | Response
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' },
})
function base(url: URL) {
  if (url.pathname === '/api/chats') return response({ success: true, data: [] })
  if (url.pathname === '/api/support/inbox') return response({ success: true, data: { items: [], summary: { total: 0 } } })
  if (url.pathname === '/api/chats/quick-counts') return response({ success: true, data: {
    all: 3, reply: 2, overdue: 1,
    line: { all: 3, reply: 2, overdue: 1 },
    email: { all: 0, reply: 0, overdue: 0 },
  } })
  if (url.pathname === '/api/operators') return response({ success: true, data: [] })
  if (url.pathname === '/api/chats/stats') return response({ success: true, data: {
    total: 0, unread: 0, assigneeUnread: [], waiting: 0, waitingOverAnHour: 0,
  } })
  return response({ success: true, data: [] })
}
const list = () => host.querySelector<HTMLElement>('[data-inbox-v4="conversation-list"]')!
const searchInput = () => host.querySelector<HTMLInputElement>('input[aria-label="名前・メールアドレス・内容で検索"]')!
async function quickTabCounts() {
  await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="絞り込み"]')!.click() })
  await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="期限で絞り込む"]')!.click() })
  const counts = [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(option => option.textContent?.match(/\((\d+)\)/)?.[1]).filter(Boolean)
  await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="絞り込みを閉じる"]')!.click() })
  return counts
}
async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}
async function eventually(check: () => void, timeout = 1500) {
  const started = Date.now()
  while (true) {
    try { check(); return } catch (error) {
      if (Date.now() - started >= timeout) throw error
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    }
  }
}
async function typeQuery(value: string) {
  const input = searchInput()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
beforeEach(() => {
  calls = []; handler = base
  fixture.accountId = 'account-a'; fixture.params = new URLSearchParams()
  const values = new Map<string, string>()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)) },
    removeItem: (key: string) => { values.delete(key) },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size },
  })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    calls.push(url)
    return handler(url)
  }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

test('2000文字の検索語は上限へ切り詰めてサーバーへ届き、0件なら空状態が出る', async () => {
  await act(async () => root.render(<ChatsPage />))
  await settle()
  await typeQuery(LONG_QUERY)

  // debounce(250ms)のあと、切り詰めた検索語を乗せた一覧取得が出る
  await eventually(() => {
    expect(calls.some((url) => url.pathname === '/api/chats' && url.searchParams.get('q') === CLAMPED_QUERY)).toBe(true)
    expect(calls.some((url) => url.pathname === '/api/support/inbox' && url.searchParams.get('q') === CLAMPED_QUERY)).toBe(true)
  })
  // 0件は障害ではなく空状態。「会話を読み込んでいます...」を残さない。
  await eventually(() => {
    expect(list().querySelector('[data-inbox-list-state="filtered-empty"]')).toBeTruthy()
  })
  expect(list().textContent).toContain('条件に一致する会話がありません')
  expect(list().querySelector('[data-inbox-list-state="loading"]')).toBeNull()
})

test('長い検索語で一覧口が落ちても、失敗行＋再読み込みが出てタブ件数は0にならない', async () => {
  let fail = false
  handler = (url) => {
    const hasQuery = Boolean(url.searchParams.get('q'))
    if (fail && hasQuery && url.pathname === '/api/chats') {
      return response({ success: false, error: 'server exploded' }, 503)
    }
    if (fail && hasQuery && url.pathname === '/api/chats/quick-counts') {
      return response({ success: false, error: 'server exploded' }, 503)
    }
    return base(url)
  }
  await act(async () => root.render(<ChatsPage />))
  await settle()
  // 最初は取れた件数が出ている（0や—ではない）
  expect(await quickTabCounts()).toEqual(['3', '2', '1'])

  fail = true
  await typeQuery(LONG_QUERY)

  // 一覧の失敗は一覧の場所で、再読み込みつきで伝える（N-030）。
  await eventually(() => {
    expect(list().textContent).toContain('LINE の会話を読み込めませんでした。')
  })
  expect(list().querySelector('[data-inbox-list-state="loading"]')).toBeNull()
  // タブ件数は失敗を0件と読ませない。★管理画面（2026-09-24）では「—」も出さず、件数そのものを出さない。
  expect(await quickTabCounts()).toEqual([])

  // 再読み込みで同じ条件（長い検索語のまま）を取り直せる。
  fail = false
  const retry = [...list().querySelectorAll('button')]
    .find((item) => item.textContent?.trim() === 'もう一度読み込む')
  expect(retry).toBeTruthy()
  await act(async () => { retry!.click() })
  await eventually(() => {
    expect(list().querySelector('[data-inbox-list-state="filtered-empty"]')).toBeTruthy()
  })

  // 件数は失敗のまま0にせず「—」。条件を動かすと同じ口で数え直して戻る。
  await typeQuery('')
  let restored: string[] = []
  const started = Date.now()
  while (Date.now() - started < 1500) {
    restored = (await quickTabCounts()) as string[]
    if (restored.join(',') === '3,2,1') break
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  }
  expect(restored).toEqual(['3', '2', '1'])
})

test('過去本文だけで一致したサーバーの検索結果を消さない（WEB282）', async () => {
  handler = url => url.pathname === '/api/chats' && url.searchParams.get('q')
    ? response({ success:true,data:[{ id:'old-hit',friendName:'山本',status:'unread',lastMessageContent:'こんにちは',lastMessageAt:'2026-10-01T00:00:00Z',revision:1 }] }) : base(url)
  await act(async()=>root.render(<ChatsPage />));await settle();await typeQuery('過去の注文')
  await eventually(()=>{ expect(list().textContent).toContain('山本') })
})
