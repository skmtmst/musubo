// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

import WebhooksPage from './page'

/*
 * ★V8-B 外部連携のこちらで受け取る（板 ）の契約。
 * `<html data-theme="v8">` の下でだけ新しい受け取るタブに切り替わり、
 * 見本が決めた受け取り口の列・設定カードが出ることを実DOMで固定する。
 * 互換経路では従来の受け取るタブが出ることも固定する。
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
  usePathname: () => '/webhooks',
  useSearchParams: () => new URLSearchParams([['tab', 'incoming']]),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({
  selectedAccountId: 'account-a', selectedAccount: null, accounts: [], loading: false,
}) }))

let root: Root
let host: HTMLDivElement

const inlet = {
  id: 'in-1',
  name: '申込フォーム',
  sourceType: 'form',
  hasSecret: true,
  isActive: true,
  createdAt: '2026-06-02T00:00:00.000Z',
  updatedAt: '2026-09-30T10:12:00.000Z',
}

const detail = {
  ...inlet,
  version: 1,
  identityMatching: {
    methods: [{ kind: 'verified_email', path: 'email' }],
    onNotFound: 'create_candidate',
  },
  actions: [
    { refKind: 'tag', refId: 'tag-1', refVersionId: null, displayName: 'フォーム申込' },
  ],
  actionExecution: { state: 'connected', reason: null },
  latestSample: null,
  templateFields: [],
  pendingUnmatched: 0,
  previousSecretUsableUntil: null,
}

const json = (data: unknown, status = 200) => new Response(
  JSON.stringify(data),
  { status, headers: { 'Content-Type': 'application/json' } },
)

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/staff/me') || url.includes('/staff/me')) {
      return json({ success: true, data: { role: 'owner' } })
    }
    if (url.includes('/api/webhooks/outgoing')) return json({ success: true, data: [] })
    if (url.includes('/api/webhooks/incoming/in-1?')) {
      return json({ success: true, data: detail })
    }
    if (url.includes('/unmatched')) return json({ success: true, data: [], total: 0 })
    if (url.includes('/api/webhooks/incoming')) return json({ success: true, data: [inlet] })
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
  act(() => { root.unmount() })
  host.remove()
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('data-theme')
})

async function renderPage() {
  await act(async () => {
    root.render(<WebhooksPage />)
  })
  await act(async () => {})
}

test('v8 では gW0F2 の受け取る画面（受け取り口の列・設定カード）が出る', async () => {
  document.documentElement.dataset.theme = 'v8'
  await renderPage()
  const board = host.querySelector('[data-design-node="gW0F2"]')
  expect(board).not.toBeNull()
  expect(board?.textContent).toContain('申込フォーム')
  expect(board?.textContent).toContain('どこから受け取るか')
  expect(board?.textContent).toContain('届いたらすること')
  expect(board?.textContent).toContain('届いたつもりで試す')
})

test('旧テーマ属性でも現役の受け取るタブが出て gW0F2 が出る', async () => {
  await renderPage()
  expect(host.querySelector('[data-design-node="gW0F2"]')).not.toBeNull()
})

test('v8 の動かす切替は押した瞬間に札が変わり、失敗したら戻る', async () => {
  document.documentElement.dataset.theme = 'v8'
  let resolveUpdate: ((response: Response) => void) | null = null
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/staff/me') || url.includes('/staff/me')) {
      return json({ success: true, data: { role: 'owner' } })
    }
    if (url.includes('/api/webhooks/outgoing')) return json({ success: true, data: [] })
    if (url.includes('/api/webhooks/incoming') && init?.method && init.method !== 'GET') {
      return new Promise<Response>((resolve) => { resolveUpdate = resolve })
    }
    if (url.includes('/api/webhooks/incoming/in-1?')) {
      return json({ success: true, data: detail })
    }
    if (url.includes('/unmatched')) return json({ success: true, data: [], total: 0 })
    if (url.includes('/api/webhooks/incoming')) return json({ success: true, data: [inlet] })
    if (url.includes('/interactions')) {
      return json({ success: true, data: { summary: {
        total: 2146, outgoing: 1734, incoming: 412, succeeded: 2144,
        failed: 2, resultUnknown: 0, outgoingFailed: 2, retryable: 2, averageDurationMs: 400,
      } } })
    }
    return json({ success: false, error: 'not found' }, 404)
  })
  await renderPage()
  const board = host.querySelector('[data-design-node="gW0F2"]')!
  // 状態の札は言葉の表どおり「有効／停止中」（「動いています」は使わない）。
  const badgeText = () => Array.from(board.querySelectorAll('[data-design-node="xRvDB"]')).map((el) => el.textContent).join('|')
  expect(badgeText()).toContain('有効')
  expect(board.textContent).not.toContain('動いています')
  const toggle = board.querySelector('[role="switch"]') as HTMLElement
  await act(async () => { toggle.click() })
  // 口の返事を待たずスイッチが変わる（札は切り替え中になる）。
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  expect(board.textContent).toContain('切り替え中')
  await act(async () => { resolveUpdate!(json({ success: false, error: 'boom' })) })
  expect(badgeText()).toContain('有効')
})

test('v8 で↑↓を受け取り口の列で押すと次の受け取り口へ移る', async () => {
  const inlet2 = { ...inlet, id: 'in-2', name: '予約受付' }
  const detail2 = { ...detail, ...inlet2 }
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/staff/me') || url.includes('/staff/me')) {
      return json({ success: true, data: { role: 'owner' } })
    }
    if (url.includes('/api/webhooks/outgoing')) return json({ success: true, data: [] })
    if (url.includes('/api/webhooks/incoming/in-2?')) {
      return json({ success: true, data: detail2 })
    }
    if (url.includes('/api/webhooks/incoming/in-1?')) {
      return json({ success: true, data: detail })
    }
    if (url.includes('/unmatched')) return json({ success: true, data: [], total: 0 })
    if (url.includes('/api/webhooks/incoming')) return json({ success: true, data: [inlet, inlet2] })
    if (url.includes('/interactions')) {
      return json({ success: true, data: { summary: {
        total: 2146, outgoing: 1734, incoming: 412, succeeded: 2144,
        failed: 2, resultUnknown: 0, outgoingFailed: 2, retryable: 2, averageDurationMs: 400,
      } } })
    }
    return json({ success: false, error: 'not found' }, 404)
  })
  document.documentElement.dataset.theme = 'v8'
  await renderPage()
  const board = host.querySelector('[data-design-node="gW0F2"]')!
  // 最初は1件目が選ばれる。
  expect(board.querySelector('h2 button')?.textContent).toContain('申込フォーム')
  const firstRow = board.querySelector('button[aria-label="受け取り口「申込フォーム」を見る"]') as HTMLElement
  await act(async () => {
    firstRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  })
  expect(board.querySelector('h2 button')?.textContent).toContain('予約受付')
  const secondRow = board.querySelector('button[aria-label="受け取り口「予約受付」を見る"]') as HTMLElement
  await act(async () => {
    secondRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  })
  expect(board.querySelector('h2 button')?.textContent).toContain('申込フォーム')
})

test('v8 で受け取り口の名前を押すとその場で書き換えられ保存できる', async () => {
  let savedName: string | null = null
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/staff/me') || url.includes('/staff/me')) {
      return json({ success: true, data: { role: 'owner' } })
    }
    if (url.includes('/api/webhooks/outgoing')) return json({ success: true, data: [] })
    if (url.includes('/api/webhooks/incoming') && init?.method === 'PUT') {
      savedName = (JSON.parse(String(init.body)) as { name?: string }).name ?? null
      return json({ success: true, data: { ...inlet, name: savedName } })
    }
    if (url.includes('/api/webhooks/incoming/in-1?')) {
      return json({ success: true, data: detail })
    }
    if (url.includes('/unmatched')) return json({ success: true, data: [], total: 0 })
    if (url.includes('/api/webhooks/incoming')) {
      return json({ success: true, data: [savedName ? { ...inlet, name: savedName } : inlet] })
    }
    if (url.includes('/interactions')) {
      return json({ success: true, data: { summary: {
        total: 2146, outgoing: 1734, incoming: 412, succeeded: 2144,
        failed: 2, resultUnknown: 0, outgoingFailed: 2, retryable: 2, averageDurationMs: 400,
      } } })
    }
    return json({ success: false, error: 'not found' }, 404)
  })
  document.documentElement.dataset.theme = 'v8'
  await renderPage()
  const board = host.querySelector('[data-design-node="gW0F2"]')!
  const nameButton = board.querySelector('button[aria-label="受け取り口の名前を変更する"]') as HTMLElement
  await act(async () => { nameButton.click() })
  const input = board.querySelector('input[aria-label="受け取り口の名前"]') as HTMLInputElement
  expect(input).not.toBeNull()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, '申込フォーム（新）')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  expect(savedName).toBe('申込フォーム（新）')
})

test('v8 の読み込み中は受け取り口の形の骨組みが出て「読み込み中」の文字は無い', async () => {
  document.documentElement.dataset.theme = 'v8'
  vi.useFakeTimers()
  try {
    vi.stubGlobal('fetch', () => new Promise<Response>(() => {}))
    await act(async () => {
      root.render(<WebhooksPage />)
    })
    await act(async () => {
      vi.advanceTimersByTime(350)
    })
    const board = host.querySelector('[data-design-node="gW0F2"]')
    expect(board?.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(board?.querySelectorAll('[data-skeleton]').length).toBeGreaterThan(0)
    expect(board?.textContent).not.toContain('読み込み中')
  } finally {
    vi.useRealTimers()
  }
})


test('受け取り口は見本を選べ、その他は自由入力した値で作れる', async () => {
  document.documentElement.dataset.theme = 'v8'
  let submitted: Record<string, unknown> | null = null
  const previousFetch = globalThis.fetch
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/api/webhooks/incoming') && init?.method === 'POST') {
      submitted = JSON.parse(String(init.body))
      return json({ success: true, data: { ...inlet, name: '新しい受け取り口', secret: 'a'.repeat(32) } })
    }
    return previousFetch(input, init)
  })
  await renderPage()
  const create = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('受け取り口を作る'))!
  await act(async () => { create.click() })
  const dialog = screen.getByRole('dialog', { name: '受け取る設定を追加' })
  const picker = within(dialog).getByLabelText('どこから来るか')
  await act(async () => { fireEvent.click(picker) })
  for (const label of ['LINE公式アカウント', '予約サービス', 'アンケートツール', 'ECサイト', '決済サービス', 'その他（自分で書く）']) {
    expect(screen.getByRole('option', { name: label })).toBeTruthy()
  }
  await act(async () => { fireEvent.click(within(screen.getByRole('option', { name: 'その他（自分で書く）' })).getByRole('button')) })
  const free = within(dialog).getByLabelText('どこから来るか（自由入力）')
  await act(async () => {
    fireEvent.change(free, { target: { value: '  custom-source  ' } })
    fireEvent.change(within(dialog).getByPlaceholderText('体験申込フォーム（自社サイト）'), { target: { value: '新しい受け取り口' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '作る' }))
  })
  expect(submitted).toMatchObject({ sourceType: 'custom-source', name: '新しい受け取り口' })
  expect(screen.queryByRole('dialog', { name: '受け取る設定を追加' })).toBeNull()
})
