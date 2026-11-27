// @vitest-environment happy-dom
/*
 * ★V8 外部連携の「送る」「受け取る」タブの動き。
 * 削除の確認窓・アカウントを替えたときの古い応答の捨て方・一覧の読み込みの成功と失敗・
 * 試し送信の確認・行の「…」のキーボード操作を、描いた画面と口の呼び出しで確かめる。
 */
import React, { act } from 'react'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/webhooks',
  useSearchParams: () => new URLSearchParams(),
}))
let accountId = 'account-a'
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: accountId, selectedAccount: { id: accountId, name: accountId }, accounts: [{ id: 'account-a', name: '本店' }, { id: 'account-b', name: '支店' }], loading: false }),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/line-accounts-cache', () => ({ loadLineAccounts: vi.fn(async () => ({ success: true, data: [{ id: 'account-a', name: '本店' }, { id: 'account-b', name: '支店' }] })) }))
vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => false }))
let role = verifiedStaffRole('owner')
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => role }
})

import WebhooksIncomingV8 from './incoming'
import WebhooksOutgoingV8 from './outgoing'
import WebhooksInteractionsV8 from './interactions'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
const SUMMARY = { total: 10, outgoing: 8, incoming: 2, succeeded: 10, failed: 0, resultUnknown: 0, outgoingFailed: 0, retryable: 0, averageDurationMs: 400 }
const inlet = (id: string, name: string) => ({ id, name, confirmationRevision: 5, sourceType: 'form', hasSecret: true, isActive: true, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' })
const destination = (id: string, name: string, url = 'https://crm.example.com/line/hook?token=secret-path') => ({
  id, name, url, eventTypes: ['friend_add'], isActive: true, hasSecret: true, folderId: null, version: 3, confirmationRevision: 4,
  deliverySummary: { total: 0, failed: 0, pending: 0, canRetry: false, lastResult: null },
})

type Call = { method: string; url: string; body: unknown }
type Route = (url: string, method: string) => Response | Promise<Response> | undefined

let root: Root
let host: HTMLDivElement
let calls: Call[] = []
let route: Route = () => undefined
let outgoingByAccount: Record<string, unknown[]> = {}
let incomingByAccount: Record<string, unknown[]> = {}

beforeEach(() => {
  accountId = 'account-a'
  role = verifiedStaffRole('owner')
  calls = []
  route = () => undefined
  outgoingByAccount = { 'account-a': [destination('out-1', '顧客台帳')], 'account-b': [destination('out-b', '支店の台帳')] }
  incomingByAccount = { 'account-a': [inlet('in-1', '申込フォーム')], 'account-b': [inlet('in-b', '支店のフォーム')] }
  document.documentElement.dataset.theme = 'v8'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null })
    const routed = route(url, method)
    if (routed) return routed
    const account = new URL(url).searchParams.get('lineAccountId') ?? ''
    if (url.includes('/staff/me')) return json({ success: true, data: { role } })
    if (url.includes('/api/folders')) return json({ success: true, data: [] })
    if (url.includes('/unmatched')) return json({ success: true, data: [], total: 0 })
    if (/\/api\/webhooks\/incoming\/[^/?]+\?/.test(url) && method === 'GET') {
      const id = url.match(/\/incoming\/([^/?]+)/)![1]
      return json({ success: true, data: { ...inlet(id, '申込フォーム'), version: 1, identityMatching: { methods: [{ kind: 'verified_email', path: '$.email' }], onNotFound: 'do_nothing' }, actions: [], actionExecution: { state: 'not_configured', reason: null }, latestSample: null, templateFields: [], pendingUnmatched: 0, previousSecretUsableUntil: null } })
    }
    if (url.includes('/api/webhooks/incoming') && method === 'GET') return json({ success: true, data: incomingByAccount[account] ?? [] })
    if (url.includes('/api/webhooks/outgoing') && method === 'GET') return json({ success: true, data: outgoingByAccount[account] ?? [] })
    if (url.includes('/interactions')) return json({ success: true, data: { total: 0, page: 1, limit: 1, summary: SUMMARY, items: [] } })
    if (method === 'DELETE') return json({ success: true, data: null })
    return json({ success: false, error: 'not found' }, 404)
  })
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  clearToastsForTest()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.documentElement.removeAttribute('data-theme')
})

async function render(node: React.ReactNode) {
  await act(async () => { root.render(node) })
  await act(async () => {})
  await act(async () => {})
}

it('出来事の種類が不正でも記録を開ける', async () => {
  route = (url) => url.includes('/interactions') ? json({ success: true, data: { total: 1, page: 1, limit: 20, summary: SUMMARY, items: [{
    id: 'wi-1', direction: 'outgoing', webhookName: '予約台帳', eventType: null, triggerSummary: '予約が入った', status: 'failed', responseLabel: '失敗', responseStatus: 500, attemptCount: 1, durationMs: 100, failureReason: null, canRetry: false, startedAt: '2026-09-30T00:58:00.000Z', completedAt: null, retryOfId: null,
  }] } }) : undefined
  await render(<WebhooksInteractionsV8 />)
  expect(host.querySelector('[title="予約台帳（出来事を確認できません）"]')).toBeTruthy()
})
it('送る出来事が不正なときは未設定と決めつけない', async () => {
  outgoingByAccount = { 'account-a': [{ ...destination('out-1', '顧客台帳'), eventTypes: [null] }] }
  await render(<WebhooksOutgoingV8 />)
  expect(host.textContent).toContain('出来事を確認できません')
  expect(host.textContent).toContain('送る内容を確認できません')
})
