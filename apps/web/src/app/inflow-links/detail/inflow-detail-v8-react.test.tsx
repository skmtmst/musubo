// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

// apiクライアントは起動時にAPI URLを要求する。実通信はfetch差替で止める。
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

import InflowLinkDetailPage from './page'

/*
 * ★V8-B 流入と計測の詳細（Pencil ）の契約。
 * テーマを選ぶことなく現役V8を出し、
 * 見本が決めた見出し・数の帯・その後・友だちの表・つながる先・
 * QR の欄が出ることを実DOMで固定する。
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
  usePathname: () => '/inflow-links/detail',
  useSearchParams: () => new URLSearchParams('id=er-summer-ig'),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({
  selectedAccountId: 'account-a', selectedAccount: null, loading: false,
}) }))

let staffRole = 'admin'
vi.mock('@/lib/staff-role', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/staff-role')>()
  return { ...original, useStaffRole: () => staffRole }
})

let root: Root
let host: HTMLDivElement
const response = (data: unknown, status = 200) => new Response(
  JSON.stringify(data),
  { status, headers: { 'Content-Type': 'application/json' } },
)

const route = {
  id: 'er-summer-ig',
  refCode: 'summer-ig',
  genre: 'SNS',
  name: '夏のInstagram投稿',
  poolId: null,
  tagId: 'tag-instagram',
  scenarioId: null,
  introTemplateId: null,
  redirectUrl: null,
  isActive: true,
  lineAccountId: 'account-a',
  createdAt: '2026-09-12T10:00:00+09:00',
}

function handler(url: URL) {
  if (url.pathname === '/api/entry-routes') return response({ success: true, data: [route] })
  if (url.pathname === '/api/entry-routes/er-summer-ig') return response({ success: true, data: route })
  if (url.pathname === '/api/entry-routes/er-summer-ig/funnel') {
    return response({
      success: true,
      data: { click_count: 880, friend_add_count: 31, form_submission_count: 12, cv_count: 4 },
    })
  }
  if (url.pathname === '/api/analytics/ref/summer-ig') {
    return response({
      success: true,
      data: {
        friends: [
          {
            id: 'f-kenta',
            displayName: 'Demo Person',
            trackedAt: new Date().toISOString(),
            currentStatus: '友だち',
            conversion: '購入 ¥4,800',
          },
          {
            id: 'f-blocked',
            displayName: 'ブロック太郎',
            trackedAt: null,
            currentStatus: 'ブロック中',
            conversion: null,
          },
        ],
      },
    })
  }
  if (url.pathname === '/api/analytics/ref/summer-ig/orders') {
    return response({
      success: true,
      data: {
        refCode: 'summer-ig',
        total: 4,
        summary: { refunded: 0, cancelled: 0, totalAmount: 19200, refundedAmount: null },
        items: [],
      },
    })
  }
  if (url.pathname === '/api/staff/me') return response({ success: true, data: { role: 'admin' } })
  if (url.pathname === '/api/tags') {
    return response({ success: true, data: [{ id: 'tag-instagram', name: 'Instagram', color: '#06c755' }] })
  }
  if (url.pathname === '/api/scenarios') {
    return response({ success: true, data: { items: [], total: 0, limit: 200, sort: [] } })
  }
  if (url.pathname === '/api/message-templates') return response({ success: true, data: [] })
  return response({ success: false, error: 'not mocked', data: null })
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
  staffRole = 'admin'
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    return handler(url)
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

test('v8 の下では Pencil Q5le3 の詳細に切り替わる', async () => {
  document.documentElement.dataset.theme = 'v8'
  await act(async () => root.render(<InflowLinkDetailPage />))
  await settle()
  await eventually(() => {
    expect(host.querySelector('[data-design-node="Q5le3"]')).toBeTruthy()
  })
  expect(host.textContent).toContain('夏のInstagram投稿')
  // ★V8 は src/v8/inflow-links/detail.tsx（絵どおり「QR コード」「URL を」の間に空白）。
  expect(host.textContent).toContain('QR コードを表示')
  expect(host.textContent).toContain('URL をコピー')
  expect(host.textContent).toContain('リンクを編集')
  // 数の帯
  expect(host.textContent).toContain('今月 友だちになった')
  expect(host.textContent).toContain('成果（コンバージョン）')
  // その後と友だちの表
  expect(host.textContent).toContain('その後（この経路から来た人）')
  expect(host.textContent).toContain('注文を見る')
  expect(host.textContent).toContain('Demo Person')
  expect(host.textContent).toContain('ブロック')
  // 下の2枚
  expect(host.textContent).toContain('この経路のつながる先')
  expect(host.textContent).toContain('QR コードを保存')
  // 青い帯の操作
  expect(host.textContent).toContain('することを変える')
})
