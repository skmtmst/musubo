// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

import FriendAddRunsPage from './page'

/*
 * ★V8 友だち追加時の配信の実行結果（板 ）の契約。
 * `<html data-theme="v8">` の下でだけ新しい実行結果に切り替わり、
 * 数の帯・失敗の帯・表・下の2枚が出ることを実DOMで固定する。
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
  usePathname: () => '/friend-add-settings/runs',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({
  selectedAccountId: 'account-a',
  selectedAccount: null,
  loading: false,
  accounts: [{ id: 'account-a' }],
}) }))
vi.mock('@/lib/staff-role', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/staff-role')>()
  return { ...original, useStaffRole: () => 'admin' }
})

let root: Root
let host: HTMLDivElement
const response = (data: unknown, status = 200) => new Response(
  JSON.stringify(data),
  { status, headers: { 'Content-Type': 'application/json' } },
)

const runsData = {
  items: [
    {
      id: 'run-ok',
      receivedAt: '2026-09-07T10:14:01',
      processedAt: '2026-09-07T10:14:02',
      friend: { id: 'friend-1', displayName: '見本 141', redacted: false },
      friendKind: 'first_time',
      attribution: { status: 'unavailable', routeId: null, routeName: null, reason: null },
      rule: { id: 'rule-fallback', name: '経路が分からなかった人', versionId: 'v1', versionNumber: 1 },
      scenario: { id: 'scenario-common', name: '共通のあいさつ', enrollmentId: 'en-1', started: true },
      actions: { total: 2, failed: 0 },
      deliveryCount: 1,
      status: 'completed',
      errorCode: null,
    },
    {
      id: 'run-failed',
      receivedAt: '2026-09-07T10:14:01',
      processedAt: '2026-09-07T10:14:03',
      friend: { id: 'friend-2', displayName: '見本 122', redacted: false },
      friendKind: 'first_time',
      attribution: { status: 'unavailable', routeId: null, routeName: null, reason: null },
      rule: { id: 'rule-fallback', name: '経路が分からなかった人', versionId: 'v1', versionNumber: 1 },
      scenario: { id: 'scenario-common', name: '共通のあいさつ', enrollmentId: null, started: false },
      actions: { total: 3, failed: 1 },
      deliveryCount: 1,
      status: 'failed',
      errorCode: 'action_failed',
    },
  ],
  total: 2,
  nextCursor: null,
  summary: {
    recentFriends: 214,
    recentEvents: 214,
    cumulativeDeliveries: 1842,
    scenarioStarts: 198,
    averageSendTimeMs: 600,
    failed: 1,
    lastDeliveryAt: '2026-09-07T10:32:00',
    staffHandoffs: { value: null, state: 'unavailable', reason: null },
  },
}

function base(url: URL) {
  if (url.pathname === '/api/staff/me') return response({ success: true, data: { role: 'admin' } })
  if (url.pathname === '/api/friend-add-runs') return response({ success: true, data: runsData })
  return response({ success: true, data: {} })
}

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}
async function eventually(check: () => void, timeout = 5000) {
  const started = Date.now()
  while (true) {
    try { check(); return } catch (error) {
      if (Date.now() - started >= timeout) throw error
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    }
  }
}

beforeEach(() => {
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
    return base(url)
  }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.documentElement.removeAttribute('data-theme')
  vi.unstubAllGlobals()
})

test('v8 の実行結果は板 REIxB・数の帯・失敗の帯・表・下の2枚が出る', async () => {
  document.documentElement.dataset.theme = 'v8'
  await act(async () => root.render(<FriendAddRunsPage />))
  await settle()
  await eventually(() => {
    expect(host.querySelector('[data-design-node="REIxB"]')).toBeTruthy()
  })
  expect(host.textContent).toContain('実行結果：友だち追加時の配信')
  expect(host.textContent).toContain('失敗した処理が')
  expect(host.textContent).toContain('見本 141')
  expect(host.textContent).toContain('経路ごとの内訳')
  expect(host.textContent).toContain('二重送信を防ぐ・知らせ')
  const help = host.querySelector('button[aria-label="実行結果：友だち追加時の配信の説明"]')
  expect(help).toBeTruthy()
  await act(async () => (help as HTMLButtonElement).click())
  await eventually(() => expect(document.body.textContent).toContain('だれが・どの経路から来て・何を送ったか、失敗した処理を見ます。'))
})

test('実行結果は取得した総数・実際の表示範囲を共通件数へ渡し、次のカーソルへ進む', async () => {
  document.documentElement.dataset.theme = 'v8'
  const calls: URL[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.pathname !== '/api/friend-add-runs') return base(url)
    calls.push(url)
    return response({ success: true, data: { ...runsData, total: 214, nextCursor: url.searchParams.get('cursor') ? null : 'page-2' } })
  }))
  await act(async () => root.render(<FriendAddRunsPage />))
  await eventually(() => expect(host.querySelector('[data-pagination] > span')?.textContent).toBe('214件中 1〜2件（全11ページ）'))
  expect(host.querySelectorAll('[data-list-person-cell]')).toHaveLength(2)
  expect(host.querySelector('[data-list-person-cell] a')?.getAttribute('href')).toContain('run-ok')
  await act(async () => (host.querySelector('button[aria-label="次のページ"]') as HTMLButtonElement).click())
  await eventually(() => expect(host.querySelector('[data-pagination] > span')?.textContent).toBe('214件中 21〜22件（全11ページ）'))
  expect(calls.some(url => url.searchParams.get('cursor') === 'page-2')).toBe(true)
  expect(host.querySelector('button[aria-label="次のページ"]')?.hasAttribute('disabled')).toBe(true)
})

test('四つの集計に項目別の印を表示する', async () => {
  await act(async () => root.render(<FriendAddRunsPage />))
  await eventually(() => expect(host.querySelectorAll('[data-kpi-label]')).toHaveLength(4))
  const icons = Array.from(host.querySelectorAll('[data-kpi-label]')).map(label => label.querySelector('[data-kpi-icon] svg'))
  expect(icons.every(Boolean)).toBe(true)
  expect(new Set(icons.map(icon => icon?.getAttribute('class'))).size).toBe(4)
})
