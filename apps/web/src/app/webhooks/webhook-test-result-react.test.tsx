import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

import WebhooksPage from './page'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'
import type { OutgoingWebhookOverview } from '@/lib/api'

/*
 * ★V8 外部連携の一覧（板 ・状態 ・閲覧のみ ）の契約。
 * `<html data-theme="v8">` の下でだけ新しい一覧（src/v8/webhooks/outgoing）に
 * 切り替わり、見本が決めた帯・表・札が出ることを実DOMで固定する。
 * 閲覧のみには押せない作るボタンを置かない（2026-10-06 オーナー決定）。
 * 互換経路では従来の一覧が出ることも固定する。
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
  usePathname: () => '/webhooks',
  useSearchParams: () => new URLSearchParams([['tab', 'outgoing']]),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({
  selectedAccountId: 'account-a', selectedAccount: null, accounts: [], loading: false,
}) }))

// 1440 の板で見る。狭い幅の板は道具の段の並びだけが違う。
vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => false }))

let staffRole = 'owner'
vi.mock('@/lib/staff-role', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/staff-role')>()
  return { ...original, useStaffRole: () => staffRole }
})

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement

function outgoing(overrides: Partial<OutgoingWebhookOverview> = {}): OutgoingWebhookOverview {
  return {
    id: 'wh-1',
    version: 1, confirmationRevision: 1,
    name: '顧客台帳（CRM）',
    url: 'https://crm.example.com/line/hook',
    eventTypes: ['friend.added'],
    hasSecret: true,
    isActive: true,
    createdAt: '2026-06-02T00:00:00.000Z',
    updatedAt: '2026-09-30T10:12:00.000Z',
    deliverySummary: {
      periodDays: 30,
      total: 1204,
      succeeded: 1204,
      failed: 0,
      pending: 0,
      successRate: 1,
      lastResult: { status: 'succeeded', responseStatus: 200, completedAt: '2026-09-30T10:12:00.000Z', failureReason: null },
      canRetry: false,
    },
    ...overrides,
  }
}

let outgoingItems: OutgoingWebhookOverview[] = [outgoing()]
let folderItems: unknown[] = []

const json = (data: unknown, status = 200) => new Response(
  JSON.stringify(data),
  { status, headers: { 'Content-Type': 'application/json' } },
)

beforeEach(() => {
  outgoingItems = [outgoing()]
  folderItems = []
  staffRole = verifiedStaffRole('owner')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/staff/me') || url.includes('/staff/me')) {
      return json({ success: true, data: { role: staffRole } })
    }
    if (url.includes('/api/folders')) {
      return json({ success: true, data: folderItems })
    }
    if (url.includes('/incoming')) return json({ success: true, data: [] })
    if (url.includes('/api/webhooks/outgoing')) {
      return json({ success: true, data: outgoingItems })
    }
    if (url.includes('/interactions')) {
      return json({ success: true, data: { summary: {
        total: 2146, outgoing: 1734, incoming: 412, succeeded: 2144,
        failed: 2, resultUnknown: 0, outgoingFailed: 2, retryable: 2, averageDurationMs: 400,
      } } })
    }
    return json({ success: false, error: 'not found' }, 404)
  })
})

afterEach(() => {
  verifiedStaffRole(null)
  clearToastsForTest()
  act(() => { root.unmount() })
  host.remove()
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('data-theme')
})

async function renderPage() {
  await act(async () => {
    root.render(<><WebhooksPage /><ToastHost /></>)
  })
  await act(async () => {})
}


async function startTest() {
  document.documentElement.dataset.theme = 'v8'
  await renderPage()
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="「顧客台帳（CRM）」の操作"]')!
  expect(trigger).toBeTruthy()
  await act(async () => { trigger.click() })
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(e => e.textContent?.trim() === '試しに送る')!
  expect(item).toBeTruthy()
  await act(async () => { item.click() })
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog?.textContent).toContain('試し送信をします')
  const confirm = [...dialog.querySelectorAll('button')].find(e => e.textContent?.trim() === 'この送り先へ送る')!
  expect(confirm).toBeTruthy()
  await act(async () => { confirm.click() })
  for (let i = 0; i < 30; i++) await act(async () => { await Promise.resolve() })
}

for (const [delivered, expected] of [[true, '試し送信が届きました'], [false, '試し送信は届きませんでした']] as const) {
  test(`試し送信の届いた結果 ${delivered} を示す`, async () => {
    const original = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/webhooks/outgoing/wh-1/test')) return json({ success: true, data: { delivered, responseStatus: 200 } })
      return original(input, init)
    })
    await startTest()
    expect(document.body.textContent).toContain(expected)
    if (!delivered) expect(document.body.textContent).toContain('「やり取りの記録」タブで詳しく確認できます')
  })
}

test('送信処理の失敗は記録への案内を出して閉じられる', async () => {
  const original = globalThis.fetch
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/api/webhooks/outgoing/wh-1/test')) return json({ success: false, error: 'private error' }, 500)
    return original(input, init)
  })
  await startTest()
  expect(document.body.textContent).toContain('試し送信に失敗しました')
  expect(document.body.textContent).toContain('「やり取りの記録」タブで詳しく確認できます')
  expect(document.body.textContent).not.toContain('private error')
  const notice = [...document.querySelectorAll<HTMLElement>('[role="alert"]')].find(e => e.textContent?.includes('試し送信に失敗しました'))!
  expect(notice).toBeTruthy()
  const close = notice.querySelector<HTMLButtonElement>('button[aria-label]')!
  expect(close).toBeTruthy()
  await act(async () => { close.click() })
  expect(document.body.textContent).not.toContain('試し送信に失敗しました')
})
