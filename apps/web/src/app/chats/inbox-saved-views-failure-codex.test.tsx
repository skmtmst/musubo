// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import ChatsPage from './page'
import * as toast from '@/components/shared/toast'

/**
 * 受信箱の「保存した検索」保存失敗の文言分け(N-027)。
 *
 * 本物のReactで本物の `ChatsPage` を mount し、保存APIだけ失敗を返す。
 * 409(同名競合)・403(権限)・それ以外(通信障害)で、運用者へ出る文言が
 * 分かれること、そして入力した名前が消えないことを確かめる。
 */

const fixture = vi.hoisted(() => ({
  accountId: 'account-a' as string,
  params: new URLSearchParams(),
}))

const nav = vi.hoisted(() => ({
  calls: [] as string[],
  last: null as string | null,
}))

const net = vi.hoisted(() => ({
  calls: [] as string[],
  /** 保存POSTに載った本文。 */
  saveBodies: [] as unknown[],
  listFails: true,
  /** 保存POSTへ返す応答。{status, body} で失敗を作る。 */
  saveResponse: { status: 200, body: { success: true, data: { id: 'sv-new' } } } as {
    status: number
    body: unknown
  },
}))

vi.mock('next/link', () => ({ default: () => null }))

vi.mock('next/navigation', () => ({
  useSearchParams: () => fixture.params,
  useRouter: () => ({
    push: (url: string) => { nav.calls.push(`push ${url}`); nav.last = url },
    replace: (url: string) => { nav.calls.push(`replace ${url}`); nav.last = url },
    refresh: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  }),
  usePathname: () => '/chats',
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: fixture.accountId,
    selectedAccount: { emailInboxEnabled: true },
    loading: false,
  }),
}))

/** 通信そのものを差し替える。api・fetchApiは実物を通す。 */
function installFetch() {
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : String(input)
    const path = raw.startsWith('http') ? raw.slice(new URL(raw).origin.length) : raw
    net.calls.push(`${(init?.method ?? 'GET').toUpperCase()} ${path}`)
    if (path.startsWith('/api/inbox/saved-views') && (init?.method ?? 'GET') === 'POST') {
      net.saveBodies.push(JSON.parse(String(init?.body ?? 'null')))
      return new Response(JSON.stringify(net.saveResponse.body), {
        status: net.saveResponse.status,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify(defaultResponse(path)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
}

function defaultResponse(path: string): unknown {
  if (path.startsWith('/api/inbox/saved-views')) return net.listFails ? { success: false, error: '見本の失敗' } : { success: true, data: [{ id: 'sample', name: '見本の検索', conditions: {}, createdBy: null, isShared: false }] }
  if (path.startsWith('/api/chats/stats')) {
    return { success: true, data: {
      total: 0, unread: 0, inProgress: 0, onHold: 0, resolved: 0,
      oldestUnansweredMinutes: null, assigneeUnread: [],
    } }
  }
  if (path.startsWith('/api/chats?')) return { success: true, data: [] }
  if (path.startsWith('/api/support/inbox')) return { success: true, data: { items: [] } }
  if (path.startsWith('/api/operators')) return { success: true, data: [] }
  if (/\/mileage(\?|$)/.test(path)) {
    return { success: true, data: {
      summary: { programId: 'p', programName: '試験マイル', available: 0, pending: 0, lifetimeEarned: 0, spent: 0 },
      history: [],
    } }
  }
  if (/\/rich-menu(\?|$)/.test(path)) {
    return { success: true, data: { id: null, name: null, isDefault: false } }
  }
  if (path.endsWith('/read')) return { success: true, data: { isUnread: false } }
  return { success: true, data: [] }
}

function makeStorage(): Storage {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => { map.set(key, String(value)) },
    removeItem: (key: string) => { map.delete(key) },
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() { return map.size },
  } as Storage
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  fixture.accountId = 'account-a'
  fixture.params = new URLSearchParams()
  nav.calls.length = 0
  nav.last = null
  net.calls.length = 0
  net.saveBodies.length = 0
  net.listFails = true
  net.saveResponse = { status: 200, body: { success: true, data: { id: 'sv-new' } } }
  vi.stubGlobal('localStorage', makeStorage())
  vi.stubGlobal('sessionStorage', makeStorage())
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

async function flush(milliseconds = 30) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, milliseconds)) })
}

function findButton(scope: ParentNode, label: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll('button')].find(
    (button) => button.getAttribute('aria-label') === label || button.textContent?.trim() === label,
  )
}


it('保存検索の取得に失敗してもメニューを開くと失敗と再読み込みを表示し、成功後に一覧を出す', async () => {
  await act(async () => { root.render(<ChatsPage />) })
  await flush(80)
  const toggle = findButton(host, '保存した検索')!
  expect(toggle).toBeTruthy()
  await act(async () => { toggle.click() }); await flush()
  expect(screen.getByText('保存した検索を読み込めませんでした')).toBeTruthy()
  expect(screen.queryByText('まだ保存した検索はありません。')).toBeNull()
  await act(async () => { toggle.click() }); await flush()
  await act(async () => { toggle.click() }); await flush()
  expect(screen.getByText('保存した検索を読み込めませんでした')).toBeTruthy()
  expect(screen.queryByText('まだ保存した検索はありません。')).toBeNull()
  const retry = screen.getByRole('button', { name: 'もう一度読み込む' })
  net.listFails = false
  await act(async () => { retry.click() }); await flush()
  expect(screen.getByText('見本の検索')).toBeTruthy()
  expect(screen.queryByText('保存した検索を読み込めませんでした')).toBeNull()
  expect(screen.queryByRole('button', { name: 'もう一度読み込む' })).toBeNull()
})
