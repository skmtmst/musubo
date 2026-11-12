// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import HqSupportDetailPage from './page'

vi.mock('next/link', () => ({ default: ({ children, href, ...rest }: { children: React.ReactNode; href: string } & Record<string, unknown>) => <a href={href} {...rest}>{children}</a> }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(window.location.search),  useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageCrumbs: () => {},  usePageTitle: () => {} }))

/**
 * API の中身が欠けていても問い合わせ詳細の画面全体が落ちないこと。
 * 日時が無いと `shortDateTime` の中の `.replace` が
 * `Cannot read properties of undefined (reading 'replace')` で落ち、
 * 画面全体が「画面を表示できませんでした」になっていた（2026-09-25）。
 * 欠けた値は「—」・空の一覧・読み直しの案内で受け、画面は出す。再発防止。
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = 'https://api.example.test'
  window.history.replaceState(null, '', '/hq/support/detail?id=r9')
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
    // 日時・やり取り・添付・状態が欠けた詳細。
    if (url.endsWith('/api/hq/support/requests/r9')) {
      return json({ success: true, data: { id: 'r9', kind: 'bug', kindLabel: '不具合', subject: '件名だけの問い合わせ', body: '本文だけあります。' } })
    }
    // 履歴の口が配列ではなく頁の器で返る（偽APIの既定）。
    if (url.endsWith('/api/hq/support/requests')) return json({ success: true, data: { items: [], total: 0, page: 1, limit: 20 } })
    if (url.endsWith('/api/staff/me')) return json({ success: true, data: { id: 's1', name: '見本 141', role: 'staff', email: 'yamada@example.com' } })
    if (url.endsWith('/api/tenants/me')) return json({ success: true, data: { name: '株式会社サンプル' } })
    return json({ success: false, error: `unexpected ${url}` }, 404)
  }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

async function flush() {
  for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve() })
}

describe('中身が欠けたお問い合わせ詳細', () => {
  it('落ちずに件名・本文を出し、日時は「—」、履歴は読み直しの案内にする', async () => {
    await act(async () => { root.render(<HqSupportDetailPage />) })
    await flush()
    const text = host.textContent ?? ''
    expect(text).toContain('件名だけの問い合わせ')
    expect(text).toContain('本文だけあります。')
    expect(text).toContain('—')
    expect(text).toContain('これまでの問い合わせを読み込めませんでした。')
    // 画面全体の失敗表示にはしない。
    expect(text).not.toContain('お問い合わせを読み込めませんでした')
    expect(host.querySelector('textarea')).not.toBeNull()
  })
})
