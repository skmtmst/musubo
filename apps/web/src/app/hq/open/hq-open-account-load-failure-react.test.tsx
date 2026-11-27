// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }))
const accountStore = vi.hoisted(() => ({ setSelectedAccountId: vi.fn() }))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
}))
vi.mock('next/navigation', () => ({
  useRouter: () => router,
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => accountStore,
}))

import HqOpenPage from './page'

/**
 * R608: `/hq/open?target=tags` で `GET /api/line-accounts` が 403 のとき、
 * 503 と同じ「時間をおいて再試行」だけを出してはいけない。
 * 403 は権限不足と管理者への相談を明示し、再読み込みを次の行動に出さない。
 * 503 は通信失敗と再試行のままにする。fetch を固定応答にして本物の
 * fetchApi→ApiError→画面の分岐まで見る（`@/lib/api` は触らない）。
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let lineAccountsHandler: () => Response

const originalFetch = globalThis.fetch

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function successResponse() {
  return jsonResponse({
    success: true,
    data: [
      {
        id: 'acc-1',
        name: 'テスト店舗',
        displayName: 'テスト店舗',
        basicId: '@test',
        isActive: true,
        pictureUrl: null,
        iconUrl: null,
        connection: { status: 'ok' },
      },
    ],
  }, 200)
}

beforeEach(() => {
  router.push.mockClear()
  router.replace.mockClear()
  accountStore.setSelectedAccountId.mockClear()
  lineAccountsHandler = () => successResponse()
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/client-errors')) return jsonResponse({ success: true }, 200)
    if (url.includes('/api/line-accounts')) return lineAccountsHandler()
    return jsonResponse({ success: false, error: 'not found' }, 404)
  }) as typeof fetch
  window.history.replaceState(null, '', '/hq/open?target=tags')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  globalThis.fetch = originalFetch
})

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
}

async function renderPage() {
  await act(async () => { root.render(<HqOpenPage />) })
  await settle()
  await settle()
}

describe('hq/open のアカウント読み込み失敗の案内', () => {
  it('403は権限不足と管理者への相談を出し、再読み込みを出さない', async () => {
    lineAccountsHandler = () => jsonResponse({ success: false, error: 'Forbidden' }, 403)
    await renderPage()
    expect(host.textContent).toContain('権限')
    expect(host.textContent).toMatch(/オーナー|管理者/)
    expect(host.textContent).not.toContain('時間をおいて')
    const retry = host.querySelector('button')
    expect(retry).toBeNull()
  })

  it('503は通信失敗と再試行を出し、再読み込みで復帰できる', async () => {
    lineAccountsHandler = () => jsonResponse({ success: false, error: 'Bad Gateway' }, 503)
    await renderPage()
    expect(host.textContent).toContain('時間をおいて')
    const retry = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === '再読み込み')
    expect(retry).toBeDefined()
    lineAccountsHandler = () => successResponse()
    await act(async () => { retry!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await settle()
    await settle()
    expect(host.textContent).toContain('テスト店舗')
  })

  it('正常時は一覧を出し、不正targetは/hqへ戻す', async () => {
    await renderPage()
    expect(host.textContent).toContain('テスト店舗')
    expect(host.textContent).toContain('このアカウントを選択する')
  })

  it('0件は新規登録の導線を出す', async () => {
    lineAccountsHandler = () => jsonResponse({ success: true, data: [] }, 200)
    await renderPage()
    expect(host.textContent).toContain('まだアカウントがありません')
    const create = host.querySelector('a[href="/accounts/new"]')
    expect(create?.textContent).toMatch(/^＋ ?LINEアカウントを登録する$/)
    expect(host.querySelector('a[href*="restaurant-test/stores/new"]')).toBeNull()
  })

  it('アカウントを選ぶと選択を覚え、識別子を住所に付けずに行き先の画面へ移る', async () => {
    await renderPage()
    const select = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'このアカウントを選択する')
    await act(async () => { select!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(accountStore.setSelectedAccountId).toHaveBeenCalledWith('acc-1')
    expect(router.push).toHaveBeenCalledWith('/tags')
    expect(router.replace).not.toHaveBeenCalled()
  })

  it('不正なtargetは/hqへ戻る', async () => {
    window.history.replaceState(null, '', '/hq/open?target=//evil.example.com')
    await renderPage()
    expect(router.replace).toHaveBeenCalledWith('/hq')
  })
})
