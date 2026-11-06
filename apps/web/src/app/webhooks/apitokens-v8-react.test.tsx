// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

import WebhooksPage from './page'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'

/*
 * ★V8-B 外部連携の API 接続（板 ）の契約。
 * `<html data-theme="v8">` の下でだけ新しい鍵タブに切り替わり、
 * 見本が決めた表・札・操作が出ることを実DOMで固定する。
 * 互換経路では従来の鍵タブが出ることも固定する。
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
  usePathname: () => '/webhooks',
  useSearchParams: () => new URLSearchParams([['tab', 'api-tokens']]),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({
  selectedAccountId: 'account-a', selectedAccount: null, accounts: [], loading: false,
}) }))

let root: Root
let host: HTMLDivElement
let staffRole = 'owner'
let writes: string[] = []

const token = {
  id: 'tok-1',
  name: '予約システム連携',
  tokenPrefix: 'mhk_abc',
  scopes: ['tags:read', 'tags:write'],
  createdBy: null,
  lastUsedAt: '2026-09-30T10:02:00.000Z',
  rotatedFromId: null,
  createdAt: '2026-06-02T00:00:00.000Z',
  revokedAt: null,
}

const revokedToken = {
  id: 'tok-2',
  name: '旧ポイント連携',
  tokenPrefix: 'mhk_old',
  scopes: ['tags:write'],
  createdBy: null,
  lastUsedAt: '2025-08-31T12:00:00.000Z',
  rotatedFromId: null,
  createdAt: '2025-11-10T00:00:00.000Z',
  revokedAt: '2025-09-01T00:00:00.000Z',
}

const json = (data: unknown, status = 200) => new Response(
  JSON.stringify(data),
  { status, headers: { 'Content-Type': 'application/json' } },
)

beforeEach(() => {
  staffRole = 'owner'
  writes = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    if (method !== 'GET') writes.push(`${method} ${url}`)
    if (url.includes('/api/staff/me') || url.includes('/staff/me')) {
      return json({ success: true, data: { role: staffRole } })
    }
    if (url.includes('/api/webhooks/outgoing')) return json({ success: true, data: [] })
    if (url.includes('/incoming')) return json({ success: true, data: [] })
    if (url.includes('/interactions')) {
      return json({ success: true, data: { summary: {
        total: 0, outgoing: 0, incoming: 0, succeeded: 0,
        failed: 0, resultUnknown: 0, outgoingFailed: 0, retryable: 0, averageDurationMs: null,
      } } })
    }
    if (url.includes('/reactivate')) return json({ success: true, data: { ...revokedToken, revokedAt: null } })
    if (url.includes('/api-tokens')) return json({ success: true, data: [token, revokedToken] })
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

test('v8 では ralAc の鍵の表（札・行の右端の「…」）が出る', async () => {
  document.documentElement.dataset.theme = 'v8'
  await renderPage()
  const board = host.querySelector('[data-design-node="ralAc"]')
  expect(board).not.toBeNull()
  expect(board?.textContent).toContain('予約システム連携')
  const row = board?.querySelector('[data-row-id="tok-1"]')
  expect(row).not.toBeNull()
  expect(within(row as HTMLElement).getByText('使っている')).toBeTruthy()
  // 行の右端は「…」1つ。入れ替えるはその中。
  expect(board?.querySelector('button[aria-label="「予約システム連携」の操作"]')).not.toBeNull()
  // 板  の作るボタンの文言（本人確認の用途名ではなく表のボタンの文言で見る）。
  expect(board?.textContent).toContain('鍵を発行する')
  expect(board?.textContent).toContain('外の仕組みに書き写してから閉じてください')
})

test('担当者は鍵の一覧を読み、発行はオーナーの理由付きで止める', async () => {
  staffRole = 'staff'
  await renderPage()
  await waitFor(() => expect(host.textContent).toContain('予約システム連携'))
  const issue = screen.getByRole('button', { name: /API 接続の鍵を発行する/ })
  expect(issue.getAttribute('aria-disabled')).toBe('true')
  expect(issue.hasAttribute('href')).toBe(false)
  expect(document.getElementById(issue.getAttribute('aria-describedby') ?? '')?.textContent).toBe('この操作はオーナーだけができます。')
  await act(async () => { issue.focus() })
  expect(screen.getByRole('tooltip').textContent).toBe('この操作はオーナーだけができます。')
  await act(async () => { issue.click() })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(writes).toEqual([])
  expect(screen.queryByText(/鍵は発行したときに1回だけ表示されます/)).toBeNull()
})

test('旧テーマ属性でも現役の鍵タブが出て ralAc が出る', async () => {
  await renderPage()
  const board = host.querySelector('[data-design-node="ralAc"]')
  expect(board).not.toBeNull()
  expect(board?.querySelector('[aria-label="外部連携の数の帯"]')).toBeNull()
  const row = board?.querySelector('[data-row-id="tok-1"]')
  expect(row).not.toBeNull()
  expect(within(row as HTMLElement).getByText('予約システム連携')).toBeTruthy()
  expect(within(row as HTMLElement).getByText('使っている')).toBeTruthy()
})

test('v8 で行を右クリックすると「…」と同じ止めるが出る', async () => {
  document.documentElement.dataset.theme = 'v8'
  await renderPage()
  const board = host.querySelector('[data-design-node="ralAc"]')!
  // 2026-10-07：入口は src/v8/webhooks/api-tokens.tsx（行は表の tr ではなく行の箱）。
  const row = board.querySelector('[data-ctx-row]') as HTMLElement
  await act(async () => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 320, clientY: 180 }))
  })
  const menu = document.querySelector('[role="menu"]')
  expect(menu?.getAttribute('aria-label')).toBe('鍵の操作')
  expect(document.querySelector('[data-context-menu]')?.getAttribute('style')).toContain('left: 320px')
  expect(menu?.textContent).toContain('止める')
  // 右クリックから「止める」を押すと止める確認の窓が開く。
  const stopItem = [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === '止める') as HTMLElement
  await act(async () => { stopItem.click() })
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(document.body.textContent).toContain('鍵を止めますか')
})

test('v8 の読み込み中は鍵の表の形の骨組みが出て「読み込み中」の文字は無い', async () => {
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
    const board = host.querySelector('[data-design-node="ralAc"]')
    expect(board?.querySelector('[aria-label="鍵を読み込んでいます"]')).not.toBeNull()
    expect(board?.querySelectorAll('[data-skeleton]').length).toBeGreaterThan(0)
    expect(board?.textContent).not.toContain('読み込み中')
  } finally {
    vi.useRealTimers()
  }
})

test('鍵の入れ替えの競合理由は一覧を取り直したあとも残る', async () => {
  document.documentElement.dataset.theme = 'v8'
  const originalFetch = globalThis.fetch
  let refreshed = 0
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api-tokens/') && url.includes('/rotate')) {
      return json({ success: false, error: 'fixture conflict', code: 'TOKEN_ROTATE_CONFLICT' }, 409)
    }
    if (url.includes('/api-tokens')) refreshed++
    return originalFetch(input, init)
  })
  await renderPage()
  const row = host.querySelector('[data-row-id="tok-1"]')!
  fireEvent.click(within(row as HTMLElement).getByRole('button', {name:'「予約システム連携」の操作'}))
  fireEvent.click(await screen.findByRole('menuitem', {name:'入れ替える'}))
  const confirm = await screen.findByRole('dialog', {name:'「予約システム連携」の鍵を入れ替えますか？'})
  fireEvent.click(within(confirm).getByRole('button', {name:'入れ替える'}))
  await waitFor(() => expect(refreshed).toBe(2))
  await waitFor(() => expect(host.textContent).toContain('ほかの操作が先にこの鍵を更新しました'))
})

test('鍵の表は名前とできることで残りの幅を分け合い、日付と状態は中身の幅', async () => {
  await renderPage()
  const table = host.querySelector('[aria-label="API 接続の鍵"]')!
  const heads = [...table.querySelectorAll('thead th')]
  expect(heads[0].textContent).toContain('名前')
  expect(heads[1].textContent).toContain('できること')
  // 残りの幅は名前：できること＝2：1で分け合う（見出しと本文で同じ値）。
  expect(heads[0].getAttribute('data-cell-weight')).toBe('2')
  expect(heads[1].getAttribute('data-cell-weight')).toBe('1')
  const cells = [...table.querySelector('tbody tr')!.children]
  expect(cells[0].getAttribute('data-cell-weight')).toBe('2')
  expect(cells[1].getAttribute('data-cell-weight')).toBe('1')
  // 日付と状態は中身の幅のまま（割合を指定しない）。
  for (const cell of [heads[2], heads[3], heads[4], cells[2], cells[3], cells[4]]) {
    expect(cell.getAttribute('data-cell-weight')).toBeNull()
  }
})

test.each(['入れ替える', '止める'])('鍵を%s確認する窓に対象アカウントと環境を示す', async (action) => {
  await renderPage()
  const row = host.querySelector('[data-row-id="tok-1"]') as HTMLElement
  fireEvent.click(within(row).getByRole('button', { name: '「予約システム連携」の操作' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: action }))
  const dialog = await screen.findByRole(action === '止める' ? 'alertdialog' : 'dialog', { name: new RegExp(`鍵を${action === '止める' ? '止め' : '入れ替え'}ますか`) })
  expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
  expect(within(dialog).getByText('環境')).toBeTruthy()
})
