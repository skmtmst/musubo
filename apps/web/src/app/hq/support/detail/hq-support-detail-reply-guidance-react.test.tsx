// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import HqSupportDetailPage from './page'

vi.mock('next/link', () => ({ default: ({ children, href, ...rest }: { children: React.ReactNode; href: string } & Record<string, unknown>) => <a href={href} {...rest}>{children}</a> }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(window.location.search),  useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageCrumbs: () => {},  usePageTitle: () => {} }))

/**
 * R609: メール未設定でも返信がそのメールへ届くと案内していた再発防止。
 * 固定の本人情報 `email: null` で開くと送信者のメール欄は「—」なのに、
 * 「返信はこのメールアドレスに届きます」「控えが登録メールに届く」と出ていた。
 * メールがあるときだけメール到着を案内し、無いときは画面での確認方法を示す。
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function buildDetail() {
  return {
    id: 'r1', kind: 'bug', kindLabel: '不具合', subject: 'バナー生成で日本語の文字が崩れることがある', body: '2枚に1枚は誤字になります。',
    lineAccountId: null, attachments: [], status: 'answered', staffName: '見本 141', notified: true, createdAt: '2026-09-15T08:40:00.000+09:00',
    ticketLabel: '#MB-0312', replies: [], stageLabel: '待ち', canFollowUp: true,
    messages: [{ id: 'm1', authorKind: 'ops', authorName: 'musubo 運営 ／ 見本 25', body: '再現を確認しました。', attachments: [], createdAt: '2026-09-15T09:05:00.000+09:00' }],
  }
}

let host: HTMLDivElement
let root: Root
let staffEmail: string | null
let staffReadOnly = false
let posted: Record<string, unknown> | null

beforeEach(() => {
  staffEmail = 'yamada@example.com'
  staffReadOnly = false
  posted = null
  process.env.NEXT_PUBLIC_API_URL = 'https://api.example.test'
  window.history.replaceState(null, '', '/hq/support/detail?id=r1')
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
    if (url.endsWith('/api/hq/support/requests/r1/messages')) {
      posted = JSON.parse(String(init?.body)) as Record<string, unknown>
      return json({ success: true, data: { id: 'm2', stage: 'in_progress', status: 'open' } }, 201)
    }
    if (url.endsWith('/api/hq/support/requests/r1')) return json({ success: true, data: buildDetail() })
    if (url.endsWith('/api/hq/support/requests')) return json({ success: true, data: [buildDetail()] })
    if (url.endsWith('/api/staff/me')) return json({ success: true, data: { id: 's1', name: '見本 141', email: staffEmail, role: 'staff', readOnly: staffReadOnly } })
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

async function typeBody(text: string) {
  const textarea = host.querySelector('textarea') as HTMLTextAreaElement
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

describe('返信先の案内（R609）', () => {
  it('メールがあるときはメール到着を案内する', async () => {
    staffEmail = 'yamada@example.com'
  staffReadOnly = false
    await act(async () => { root.render(<HqSupportDetailPage />) })
    await flush()
    const text = host.textContent ?? ''
    expect(text).toContain('運営から返事が届いています。登録メールにも同じ内容が届きます')
    expect(text).toContain('yamada@example.com')
    expect(text).toContain('送ると運営の対応は「対応中」に戻ります')
    await typeBody('直りました。ありがとうございます。')
    const send = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('送る'))!
    await act(async () => { send.click() })
    await flush()
    expect(posted).toMatchObject({ body: '直りました。ありがとうございます。' })
    expect(host.textContent).toContain('続きを送りました。運営に届き、控えが登録メールアドレスにも届きます。')
  })

  it('メールが無いときはメール到着を案内せず画面での確認を示す', async () => {
    staffEmail = null
    await act(async () => { root.render(<HqSupportDetailPage />) })
    await flush()
    const text = host.textContent ?? ''
    // 送信者のメール欄は「—」のまま。
    expect(text).toContain('メール')
    expect(text).not.toContain('登録メールアドレス')
    expect(text).not.toContain('このメールアドレスに届きます')
    expect(text).toContain('運営から返事が届いています')
    expect(host.querySelector('textarea')).not.toBeNull()
    expect(text).toContain('送ると運営の対応は「対応中」に戻ります')
    await typeBody('追加の情報です。')
    const send = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('送る'))!
    await act(async () => { send.click() })
    await flush()
    expect(posted).toMatchObject({ body: '追加の情報です。' })
    const after = host.textContent ?? ''
    expect(after).toContain('続きを送りました。運営に届きました。返信はこの画面のやり取りに届きます。')
    expect(after).not.toContain('登録メールアドレス')
  })
})

it('閲覧のみはやり取りを読めるが返信欄・送信・添付操作がない', async () => {
  staffReadOnly = true
  await act(async () => { root.render(<HqSupportDetailPage />) })
  await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve() })
  expect(host.textContent).toContain('再現を確認しました。')
  expect(host.textContent).toContain('閲覧のみで見ています')
  expect(host.querySelector('textarea')).toBeNull()
  expect([...host.querySelectorAll('button')].some(b => b.textContent?.trim() === '送る')).toBe(false)
  expect(posted).toBeNull()
})
