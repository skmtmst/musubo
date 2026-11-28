import { PERMISSION_LOCK_SUMMARY } from '@/components/shared/permission-lock'
// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
/*
 * ★V8 外部連携（src/v8/webhooks）の動きの試験。BEHAVIOR.md の主な動きを守る。
 * 受け取り口を作る窓・閲覧のみで押せない物を置かない・同期の記録の束ね方・
 * やり取りの記録の札と中身の2行・作る画面の既定（選んだものだけ送る）と詳細条件。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

let search = ''
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/webhooks',
  useSearchParams: () => new URLSearchParams(search),
}))
let accountId = 'account-a'
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: accountId, selectedAccount: { id: accountId, name: accountId === 'account-a' ? '本店' : '支店' }, accounts: [{ id: 'account-a', name: '本店' }, { id: 'account-b', name: '支店' }], loading: false }),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
let narrow = false
vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => narrow }))
let role = 'owner'
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => role }
})

import WebhooksIncomingV8 from './incoming'
import WebhooksOutgoingV8 from './outgoing'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'
import WebhooksSamplesV8 from './samples'
import WebhooksInteractionsV8 from './interactions'
import WebhooksCreateV8 from './create'
import { api, ApiError } from '@/lib/api'
import { groupRuns } from './sheets'
import { eventLabel, maskedUrl } from './words'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
const SUMMARY = { total: 2146, outgoing: 1734, incoming: 412, succeeded: 2144, failed: 2, resultUnknown: 0, outgoingFailed: 2, retryable: 2, averageDurationMs: 400 }
const INLET = { id: 'in-1', name: '申込フォーム', sourceType: 'form', hasSecret: true, isActive: true, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }

let root: Root
let host: HTMLDivElement
let posted: Array<{ url: string; body: unknown }> = []

beforeEach(() => {
  accountId = 'account-a'
  role = verifiedStaffRole('owner')
  narrow = false
  search = ''
  posted = []
  document.documentElement.dataset.theme = 'v8'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method && init.method !== 'GET') posted.push({ url, body: init.body ? JSON.parse(String(init.body)) : null })
    if (url.includes('/staff/me')) return json({ success: true, data: { role } })
    if (url.includes('/unmatched')) return json({ success: true, data: [], total: 0 })
    if (/\/api\/webhooks\/incoming\/in-1/.test(url)) {
      return json({ success: true, data: { ...INLET, version: 1, identityMatching: { methods: [{ kind: 'verified_email', path: '$.email' }], onNotFound: 'do_nothing' }, actions: [], actionExecution: { state: 'not_configured', reason: null }, latestSample: null, templateFields: [], pendingUnmatched: 0, previousSecretUsableUntil: null } })
    }
    if (url.includes('/api/webhooks/incoming')) return json({ success: true, data: [INLET] })
    if (url.includes('/api/webhooks/outgoing')) return json({ success: true, data: [] })
    if (url.includes('/interactions')) {
      return json({ success: true, data: { total: 1, page: 1, limit: 20, summary: SUMMARY, items: [{
        id: 'wi-1', direction: 'outgoing', webhookName: '予約台帳', eventType: 'booking_created', triggerSummary: '予約が入った・Masato S.',
        status: 'failed', responseLabel: '500 エラー', responseStatus: 500, attemptCount: 3, durationMs: 30000, failureReason: null,
        failureReasonCode: 'response_5xx', canRetry: true, retryBlockReason: null, autoRetryNextAt: null,
        startedAt: '2026-09-30T00:58:00.000Z', completedAt: null, retryOfId: null,
      }] } })
    }
    if (url.includes('/api/folders')) return json({ success: true, data: [] })
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

async function render(node: React.ReactNode) {
  await act(async () => { root.render(node) })
  await act(async () => {})
  await act(async () => {})
}

const buttons = () => [...document.querySelectorAll('button, a')] as HTMLElement[]

function unmatchedFixture(resolveStatus = 200) {
  const base = globalThis.fetch
  const resolutions: unknown[] = [], limits: string[] = []
  const rows = ['candidate', 'ambiguous', 'unmatched'].map((kind, index) => ({
    id: `unmatched-${index}`, kind, status: 'pending', receivedAt: '2026-10-21T01:02:00Z',
    identityAttempts: [{ kind: 'verified_email', path: '$.email', value: `very-long-incoming-address-${index}@example.invalid` }],
    candidates: kind === 'unmatched' ? [] : [
      { friendId: 'friend-1', displayName: '候補の長い名前その一' },
      ...(kind === 'ambiguous' ? [{ friendId: 'friend-2', displayName: '候補の長い名前その二' }] : []),
    ],
    maskedShape: null, resolvedFriendId: null, resolvedAt: null,
  }))
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/webhooks/unmatched/') && init?.method === 'POST') {
      resolutions.push({ url, body: JSON.parse(String(init.body)) })
      return resolveStatus === 403 ? json({ success: false, error: 'forbidden' }, 403) : json({ success: true, data: { id: 'unmatched-1', status: 'resolved' } })
    }
    if (url.includes('/incoming/in-1/unmatched')) {
      limits.push(new URL(url).searchParams.get('limit') || '')
      return json({ success: true, data: rows, total: 51 })
    }
    const response = await base(input, init)
    if (/\/incoming\/in-1\?/.test(url)) {
      const body = await response.json()
      body.data.pendingUnmatched = 51
      body.data.identityMatching.onNotFound = 'unmatched_box'
      return json(body)
    }
    return response
  })
  return { resolutions, limits }
}

it.each(['toString', 'constructor', '__proto__'])('受け取り口：未知の照合方法 %s を安全に表示する', async kind => {
  const base = globalThis.fetch
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (/\/api\/webhooks\/incoming\/in-1/.test(url) && !url.includes('/unmatched')) {
      return json({ success: true, data: { ...INLET, version: 1, identityMatching: { methods: [{ kind, path: '$.id' }], onNotFound: 'do_nothing' }, actions: [], actionExecution: { state: 'not_configured', reason: null }, latestSample: null, templateFields: [], pendingUnmatched: 0, previousSecretUsableUntil: null } })
    }
    return base(input, init)
  })
  await render(<WebhooksIncomingV8 />)
  await waitFor(() => expect(host.textContent).toContain('決めた値で探す'))
  expect(host.textContent).not.toContain('[native code]')
})
