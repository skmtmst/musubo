// @vitest-environment happy-dom
/*
 * ★V8 外部連携「やり取りの記録」の動き。
 * 読み込み中・空・失敗を分けること、期間を書いた補足、結果が分からない失敗を無条件に送り直さないこと、
 * まとめて再試行したあとの残りの知らせ、やり直せる範囲の説明、アカウントを替えたときの古い結果の捨て方を、
 * 描いた画面と口の呼び出しで確かめる。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebhookInteraction } from '@line-crm/shared'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/webhooks',
  useSearchParams: () => new URLSearchParams('tab=interactions'),
}))
let accountId = 'account-a'
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: accountId, selectedAccount: { id: accountId, name: accountId }, accounts: [{ id: 'account-a', name: '本店' }, { id: 'account-b', name: '支店' }], loading: false }),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/line-accounts-cache', () => ({ loadLineAccounts: vi.fn(async () => ({ success: true, data: [{ id: 'account-a', name: '本店' }, { id: 'account-b', name: '支店' }] })) }))
let role = 'owner'
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => role }
})

import WebhooksInteractionsV8 from './interactions'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

function interaction(overrides: Partial<WebhookInteraction> = {}): WebhookInteraction {
  return {
    id: 'wi-1', direction: 'outgoing', webhookName: '予約台帳', eventType: 'booking_created', triggerSummary: '予約が入った・見本',
    status: 'failed', responseLabel: '500 エラー', responseStatus: 500, attemptCount: 1, durationMs: 1200,
    confirmationRevision: 2, webhookRevision: 3, failureReason: null, failureReasonCode: 'response_5xx', canRetry: true, retryBlockReason: null, autoRetryNextAt: null,
    startedAt: '2026-09-30T00:58:00.000Z', completedAt: null, retryOfId: null,
    ...overrides,
  }
}
const SUMMARY = { total: 10, outgoing: 8, incoming: 2, succeeded: 9, failed: 1, resultUnknown: 0, outgoingFailed: 1, retryable: 1, averageDurationMs: 400 }

type Call = { method: string; url: string; body: unknown }
type Route = (url: string, method: string) => Response | Promise<Response> | undefined

let root: Root
let host: HTMLDivElement
let calls: Call[] = []
let route: Route = () => undefined
let items: WebhookInteraction[] = []
let summary: typeof SUMMARY = SUMMARY

beforeEach(() => {
  accountId = 'account-a'
  role = 'owner'
  calls = []
  route = () => undefined
  items = [interaction()]
  summary = SUMMARY
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
    if (url.includes('/staff/me')) return json({ success: true, data: { role } })
    if (url.includes('/api/webhooks/outgoing') || url.includes('/api/webhooks/incoming')) return json({ success: true, data: [] })
    if (url.includes('/api/webhooks/interactions?')) return json({ success: true, data: { total: items.length, page: 1, limit: 20, summary, items } })
    return json({ success: false, error: 'not found' }, 404)
  })
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  clearToastsForTest()
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('data-theme')
})

const screen = () => <><WebhooksInteractionsV8 /><ToastHost /></>
async function render(node: React.ReactNode = screen()) {
  await act(async () => { root.render(node) })
  await act(async () => {})
  await act(async () => {})
}

const buttonByText = (text: string, scope: ParentNode = document) => [...scope.querySelectorAll('button')].find((button) => button.textContent?.trim() === text) as HTMLButtonElement | undefined
const designDialog = () => document.querySelector('[data-design-node="DA0Ag"]') as HTMLElement | null
const confirmBox = () => document.querySelector('[role="dialog"]:not([data-design-part="dialog"] [data-design-node="DA0Ag"])') as HTMLElement | null
const titles = () => [...host.querySelectorAll('[title]')].map((node) => node.getAttribute('title') ?? '')
const retries = () => calls.filter((call) => call.method === 'POST')
const notice = () => [...host.querySelectorAll('[data-design-part="notice"]')].map((node) => node.textContent ?? '').join('\n')

async function openContents(name = '予約台帳') {
  await act(async () => { (host.querySelector(`button[aria-label="「${name}」の操作"]`) as HTMLElement).click() })
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent?.includes('中身を見る')) as HTMLElement
  await act(async () => { item.click() })
  await act(async () => {})
}
it('未対応の状態は処理中と決めつけず、送り直しを出さない', async () => {
  items = [interaction({ status: 'future' as WebhookInteraction['status'] })]
  await render()
  expect(host.textContent).toContain('状態不明')
  expect(host.textContent).not.toContain('処理中')
  await openContents()
  const box = designDialog()!
  expect(box.textContent).toContain('状態を確認できません。')
  expect(buttonByText('届いたか確かめてから送り直す', box)).toBeUndefined()
})
