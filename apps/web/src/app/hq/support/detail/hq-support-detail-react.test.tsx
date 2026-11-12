// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import HqSupportDetailPage from './page'

vi.mock('next/link', () => ({ default: ({ children, href, ...rest }: { children: React.ReactNode; href: string } & Record<string, unknown>) => <a href={href} {...rest}>{children}</a> }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(window.location.search),  useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageCrumbs: () => {},  usePageTitle: () => {} }))

/** ★管理画面 36-3-A 統括のお問い合わせの続き。やり取りが左右に並び、続きを送ると API を呼んで読み直す。 */

const detail = {
  id: 'r1', kind: 'bug', kindLabel: '不具合', subject: 'バナー生成で日本語の文字が崩れることがある', body: '2枚に1枚は誤字になります。',
  lineAccountId: null, attachments: [], status: 'answered', staffName: '見本 141', notified: true, createdAt: '2026-09-15T08:40:00.000+09:00',
  ticketLabel: '#MB-0312', replies: [], stageLabel: '待ち', canFollowUp: true,
  messages: [{ id: 'm1', authorKind: 'ops', authorName: 'musubo 運営 ／ 見本 25', body: '再現を確認しました。', attachments: [], createdAt: '2026-09-15T09:05:00.000+09:00' }],
}

let host: HTMLDivElement
let root: Root
let posted: Record<string, unknown> | null

beforeEach(() => {
  posted = null
  process.env.NEXT_PUBLIC_API_URL = 'https://api.example.test'
  window.history.replaceState(null, '', '/hq/support/detail?id=r1')
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
    if (url.endsWith('/api/hq/support/requests/r1/messages')) {
      posted = JSON.parse(String(init?.body)) as Record<string, unknown>
      detail.messages.push({ id: 'm2', authorKind: 'tenant', authorName: '見本 141', body: String(posted.body), attachments: [], createdAt: '2026-09-15T09:30:00.000+09:00' })
      return json({ success: true, data: { id: 'm2', stage: 'in_progress', status: 'open' } }, 201)
    }
    if (url.endsWith('/api/hq/support/requests/r1')) return json({ success: true, data: detail })
    if (url.endsWith('/api/hq/support/requests')) return json({ success: true, data: [detail] })
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

describe('お問い合わせの続き', () => {
  it('番号・件名・やり取り・送信者・一覧が出る', async () => {
    await act(async () => { root.render(<HqSupportDetailPage />) })
    await flush()
    const text = host.textContent ?? ''
    expect(text).toContain('#MB-0312')
    expect(text).toContain('バナー生成で日本語の文字が崩れることがある')
    expect(text).toContain('見本 141')
    expect(text).toContain('musubo 運営 ／ 見本 25')
    expect(text).toContain('再現を確認しました。')
    expect(text).toContain('続きを送る')
    expect(text).toContain('これまでの問い合わせ')
    expect(host.querySelector('textarea')).not.toBeNull()
    expect(host.querySelector('[aria-current="page"]')).not.toBeNull()
  })

  it('本文を入れて送ると API を呼び、やり取りに追加されて案内が出る', async () => {
    await act(async () => { root.render(<HqSupportDetailPage />) })
    await flush()
    const textarea = host.querySelector('textarea') as HTMLTextAreaElement
    const send = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('送る'))!
    expect(send.hasAttribute('disabled')).toBe(true)
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, '直りました。ありがとうございます。')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    expect(send.hasAttribute('disabled')).toBe(false)
    await act(async () => { send.click() })
    await flush()
    expect(posted).toMatchObject({ body: '直りました。ありがとうございます。', attachments: [] })
    expect(host.textContent).toContain('続きを送りました')
    expect(host.textContent).toContain('直りました。ありがとうございます。')
  })
})
