// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

import FriendAddRunDetailPage from './page'

/*
 * ★V8 友だち追加時の配信の実行の詳細（板 ）の契約。
 * `<html data-theme="v8">` の下でだけ新しい詳細に切り替わり、
 * 失敗の帯・行ったこと・右の「この追加について」が出ることを
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
  usePathname: () => '/friend-add-settings/runs/detail',
  useSearchParams: () => new URLSearchParams('id=run-failed'),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({
  selectedAccountId: 'account-a',
  selectedAccount: null,
  loading: false,
  accounts: [{ id: 'account-a' }],
}) }))

let root: Root
let host: HTMLDivElement
const response = (data: unknown, status = 200) => new Response(
  JSON.stringify(data),
  { status, headers: { 'Content-Type': 'application/json' } },
)

const runDetail = {
  id: 'fa-7f3a11111111c21',
  receivedAt: '2026-09-07T10:14:01',
  processedAt: '2026-09-07T10:14:02',
  friend: { id: 'friend-1', displayName: '見本 141', redacted: false },
  friendKind: 'first_time',
  attribution: { status: 'unavailable', routeId: null, routeName: null, reason: null },
  rule: {
    id: 'rule-fallback',
    name: '経路が分からなかった人',
    versionId: 'v1',
    versionNumber: 1,
    definition: { messageType: 'text', messageText: '友だち追加ありがとうございます。' },
  },
  actionRuns: [
    {
      id: 'ar-1',
      stableId: 's-1',
      type: 'tag',
      status: 'completed',
      attemptCount: 1,
      nextRetryAt: null,
      errorCode: null,
      startedAt: '2026-09-07T10:14:02',
      completedAt: '2026-09-07T10:14:02',
      updatedAt: '2026-09-07T10:14:02',
    },
    {
      id: 'ar-2',
      stableId: 's-2',
      type: 'scenario',
      status: 'failed',
      attemptCount: 1,
      nextRetryAt: null,
      errorCode: 'action_failed',
      startedAt: '2026-09-07T10:14:02',
      completedAt: null,
      updatedAt: '2026-09-07T10:14:02',
    },
  ],
  status: 'failed',
  errorCode: 'action_failed',
}

function base(url: URL) {
  if (url.pathname === '/api/staff/me') return response({ success: true, data: { role: 'admin' } })
  if (url.pathname === '/api/friend-add-runs/run-failed') return response({ success: true, data: runDetail })
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

test('v8 の実行の詳細は板 N43uVX・失敗の帯・行ったこと・右の列が出る', async () => {
  document.documentElement.dataset.theme = 'v8'
  await act(async () => root.render(<FriendAddRunDetailPage />))
  await settle()
  await eventually(() => {
    expect(host.querySelector('[data-design-node="N43uVX"]')).toBeTruthy()
  })
  expect(host.textContent).toContain('見本 141さんの友だち追加')
  expect(host.textContent).toContain('つ目の処理を完了できませんでした')
  expect(host.textContent).toContain('失敗した処理をもう一度')
  expect(host.textContent).toContain('行ったこと')
  expect(host.textContent).toContain('この追加について')
  expect(host.textContent).toContain('トークを開く')
  expect(host.textContent).toContain('設定を開く')
})
