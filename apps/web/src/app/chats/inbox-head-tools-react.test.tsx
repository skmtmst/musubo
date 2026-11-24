// @vitest-environment happy-dom
/*
 * 受信箱の頭の3つの印（F12）と保存した検索の入口（ID33）。
 * - 3つの印は並びのまま、印の下に字を出す（吹き出し＝title も残す）
 * - 絞り込み中だけ保存した検索の肩に小さな点
 * - 保存の入口は1つ：開くと上に保存したもの、下に「今の条件を保存する」
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ChatsPage from './page'

const fixture = vi.hoisted(() => ({
  params: new URLSearchParams(),
  attention: false,
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

function responseFor(url: URL): Response {
  if (url.pathname === '/api/chats') return json({ success: true, data: fixture.attention ? [
    { id: 'chat-a', friendId: 'friend-a', friendName: '注目の会話', isAttention: true, isUnread: false, status: 'resolved', lastMessageAt: null },
    { id: 'chat-b', friendId: 'friend-b', friendName: '通常の会話', isAttention: false, isUnread: false, status: 'resolved', lastMessageAt: null },
  ] : [] })
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
  if (url.pathname === '/api/inbox/saved-views' && url.searchParams.get('lineAccountId')) {
    return json({ success: true, data: [
      { id: 'view-1', name: '未対応だけ', conditions: {}, createdBy: null, isShared: false },
    ] })
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

function typeSearch(host: HTMLElement, value: string) {
  const input = host.querySelector<HTMLInputElement>('input[aria-label="名前・メールアドレス・内容で検索"]')!
  expect(input).not.toBeNull()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('頭の3つの印と保存した検索', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    fixture.params = new URLSearchParams()
    fixture.attention = false
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

  it('保存した検索は Escape と外側クリックで閉じ、再び開ける', async () => {
    await act(async () => root.render(<ChatsPage />))
    const button = host.querySelector('button[aria-label="保存した検索"]') as HTMLButtonElement
    await act(async () => button.click())
    expect(button.getAttribute('aria-expanded')).toBe('true')
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(button.getAttribute('aria-expanded')).toBe('false')
    await act(async () => button.click())
    expect(button.getAttribute('aria-expanded')).toBe('true')
    await act(async () => document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  it('保存した検索内の操作メニューは親を閉じずに操作できる', async () => {
    await act(async () => root.render(<ChatsPage />))
    const button = host.querySelector('button[aria-label="保存した検索"]') as HTMLButtonElement
    await act(async () => button.click())
    await eventually(() => expect(document.body.textContent).toContain('未対応だけ'))
    const menuButton = document.querySelector('button[aria-label="未対応だけの操作"]') as HTMLButtonElement
    await act(async () => menuButton.click())
    await eventually(() => expect(document.querySelector('[data-menu-portal]')).not.toBeNull())
    const portal = document.querySelector('[data-menu-portal]')!
    await act(async () => portal.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
    expect(button.getAttribute('aria-expanded')).toBe('true')
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(button.getAttribute('aria-expanded')).toBe('true')
  })

  it('3つの印は字なしのアイコンだけで吹き出しが付く（F12・オーナー指摘）', async () => {
    await act(async () => root.render(<ChatsPage />))
    for (const label of ['絞り込み', '保存した検索', '対応ルール']) {
      const button = host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null
      expect(button).not.toBeNull()
      // 見える字は無い（アイコンだけ）。名前は読み上げ名と吹き出しで出す。
      expect(button!.textContent).toBe('')
      expect(button!.getAttribute('title')).toBe(label)
    }
  })

  it('絞り込み中だけ保存した検索に点が付く（ID33）', async () => {
    await act(async () => root.render(<ChatsPage />))
    const button = () => host.querySelector('button[aria-label^="保存した検索"]') as HTMLButtonElement
    const dots = () => [...button().querySelectorAll(':scope > span')].filter((span) => span.textContent === '')
    await eventually(() => expect(button()).not.toBeNull())
    expect(dots()).toHaveLength(0)
    expect(button().getAttribute('aria-label')).toBe('保存した検索')
    await act(async () => { typeSearch(host, '山田') })
    await eventually(() => expect(dots()).toHaveLength(1))
    // 点は目で見る印。読み上げには名前で絞り込み中を伝える。
    expect(button().getAttribute('aria-label')).toBe('保存した検索（絞り込み中）')
    await act(async () => { typeSearch(host, '') })
    await eventually(() => expect(dots()).toHaveLength(0))
  })

  it('注目の会話だけ行の右に星を表示し、行の説明でも注目と伝える', async () => {
    fixture.attention = true
    await act(async () => root.render(<ChatsPage />))
    await eventually(() => expect(host.querySelector('#chat-row-attention-chat-a')).not.toBeNull())
    const star = host.querySelector('#chat-row-attention-chat-a')!
    expect(star.getAttribute('aria-label')).toBe('注目')
    const row = star.closest('button')!
    expect(row.getAttribute('aria-describedby')?.split(' ')).toContain(star.id)
    expect(star.textContent).toBe('注目')
    expect(host.querySelector('#chat-row-attention-chat-b')).toBeNull()
  })

  it('保存の入口は1つで、上に保存したもの・下に今の条件の保存（ID33）', async () => {
    await act(async () => root.render(<ChatsPage />))
    const button = host.querySelector('button[aria-label="保存した検索"]') as HTMLButtonElement
    await eventually(() => expect(button).not.toBeNull())
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await eventually(() => expect(document.body.textContent).toContain('未対応だけ'))
    const save = [...document.body.querySelectorAll('button')].find((item) => item.textContent === '今の条件を保存する')
    expect(save).not.toBeUndefined()
    // 古い2つ目の入口の字は残らない。
    expect(host.textContent).not.toContain('現在の条件を保存する')
  })
})
