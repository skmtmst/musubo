// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

import ScenariosPage from './page'

/*
 * V8「サクサク感」C①②・D・E：シナリオ一覧の行パネル。
 * 行を押すと右に詳細パネル（↑↓で次の行）。名前はその場で変えられる。
 * 「開く」は詳細へつながる移り変わりで進む。
 */

const pushes: string[] = []
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push(url: string) { pushes.push(url) }, replace() {}, prefetch() {} }),
  usePathname: () => '/scenarios',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({
  selectedAccountId: 'account-a', selectedAccount: null, loading: false,
}) }))

let root: Root
let host: HTMLDivElement
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' },
})
const row = (id: string, name: string) => ({
  id, name, description: null, triggerType: 'friend_add', triggerTagId: null,
  lineAccountId: 'account-a', isActive: true, deliveryMode: 'relative',
  allowConcurrent: true, displayOrder: 0, folderId: null,
  audienceCondition: null, onCompleteMode: 'pause', onCompleteScenarioId: null,
  createdAt: '2026-09-01', updatedAt: '2026-09-01',
  stepCount: 1, subscriberCount: 3, completedCount: 1,
})
const puts: Array<{ url: string; body: unknown }> = []
const deletes: string[] = []
function handler(url: URL, init?: RequestInit) {
  if (url.pathname === '/api/scenarios/s1/confirmation') return response({ success: true, data: { contentRevision: 1, activeCount: 1, rowIdSum: 1, rowIdSquareSum: 1, totalCount: 1, totalRowIdSum: 1, totalRowIdSquareSum: 1, referrers: [] } })
  if (init?.method === 'DELETE' && url.pathname.startsWith('/api/scenarios/')) {
    deletes.push(url.pathname)
    return response({ success: false, error: 'Internal Server Error' }, 500)
  }
  if (init?.method === 'PUT' && url.pathname.startsWith('/api/scenarios/')) {
    puts.push({ url: url.pathname, body: JSON.parse(String(init.body)) })
    return response({ success: true, data: row('s1', '変えた名前') })
  }
  if (url.pathname === '/api/scenarios') {
    return response({ success: true, data: { items: [row('s1', '一つ目'), row('s2', '二つ目')], total: 2, limit: 50, sort: [] } })
  }
  if (url.pathname.endsWith('/move-referrers')) return response({ success: true, data: { items: [], total: 0 } })
  if (url.pathname === '/api/staff/me') return response({ success: true, data: { role: 'owner' } })
  if (url.pathname === '/api/folders') return response({ success: true, data: [], unfiledCount: 0 })
  if (url.pathname === '/api/list-stats') return response({ success: false, error: 'not needed' })
  return response({ success: true, data: {} })
}
async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}
async function eventually(check: () => void, timeout = 3000) {
  const started = Date.now()
  while (true) {
    try { check(); return } catch (error) {
      if (Date.now() - started >= timeout) throw error
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    }
  }
}
beforeEach(() => {
  window.history.replaceState(null, '', '/scenarios')
  pushes.length = 0
  puts.length = 0
  deletes.length = 0
  document.documentElement.dataset.theme = 'v8'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('fetch', (input: URL | RequestInfo, init?: RequestInit) =>
    Promise.resolve(handler(new URL(String(input)), init)))
})
afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  vi.unstubAllGlobals()
})

async function openFirstRow() {
  await act(async () => { root.render(<ScenariosPage />) })
  await eventually(() => {
    if (!host.textContent?.includes('一つ目')) throw new Error('row not loaded')
  })
  const firstRow = host.querySelector('tbody tr')
  if (!firstRow) throw new Error('no rows')
  await act(async () => {
    firstRow.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await settle()
}

test('行を押すと詳細パネルが開き、次の行へ移れる', async () => {
  await openFirstRow()
  await eventually(() => {
    const panel = document.body.querySelector('[data-design-part="detail-panel"]')
    if (!panel || !panel.textContent?.includes('一つ目')) throw new Error('panel not open')
  })
  const next = document.body.querySelector('button[aria-label="次の行"]') as HTMLButtonElement
  await act(async () => { next.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await eventually(() => {
    const panel = document.body.querySelector('[data-design-part="detail-panel"]')
    if (!panel?.textContent?.includes('二つ目')) throw new Error('did not move')
  })
})

test('パネルの「開く」は詳細へ進む', async () => {
  await openFirstRow()
  await eventually(() => {
    if (!document.body.querySelector('[data-design-part="detail-panel"]')) throw new Error('panel not open')
  })
  const open = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '開く')
  if (!open) throw new Error('no open button')
  await act(async () => { open.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  expect(pushes).toHaveLength(1)
  const destination = new URL(pushes[0], window.location.origin)
  expect(destination.pathname).toBe('/scenarios/detail')
  expect(destination.searchParams.get('id')).toBe('s1')
  expect(destination.searchParams.get('returnTo')).toBe('/scenarios?scenario=s1')
})

test('パネルで名前を変えると保存口へ送る', async () => {
  await openFirstRow()
  await eventually(() => {
    if (!document.body.querySelector('[data-design-part="detail-panel"]')) throw new Error('panel not open')
  })
  const edit = document.body.querySelector('button[aria-label="シナリオ名を変更する"]') as HTMLButtonElement
  if (!edit) throw new Error('no inline edit')
  await act(async () => { edit.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  const input = document.body.querySelector('input[aria-label="シナリオ名"]') as HTMLInputElement
  if (!input) throw new Error('no input')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, '変えた名前')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await eventually(() => {
    if (puts.length === 0) throw new Error('not saved')
  })
  expect(puts[0]).toEqual({ url: '/api/scenarios/s1', body: { name: '変えた名前' } })
})

test('削除に失敗したら確認窓を閉じず、窓の中に失敗を出す', async () => {
  await openFirstRow()
  await eventually(() => {
    if (!document.body.querySelector('[data-design-part="detail-panel"]')) throw new Error('panel not open')
  })
  // 複製・削除はパネル下部の「…」（その他操作メニュー）の中（d84a442f09〜）。
  const more = [...document.body.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '「一つ目」のその他操作')
  if (!more) throw new Error('no more-actions button')
  await act(async () => { more.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  const menuItem = () => [...document.body.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent === '削除する')
  await eventually(() => { if (!menuItem()) throw new Error('menu not open') })
  await act(async () => { menuItem()!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  const dialog = () => [...document.body.querySelectorAll('[role="dialog"], [role="alertdialog"]')]
    .find((node) => node.textContent?.includes('「一つ目」を削除しますか？'))
  await eventually(() => { if (!dialog()) throw new Error('confirm not open') })
  const confirm = [...dialog()!.querySelectorAll('button')].find((b) => b.textContent === '削除する')
  if (!confirm) throw new Error('no confirm button')
  await eventually(() => { if (confirm.disabled) throw new Error('confirmation loading') })
  await act(async () => { confirm.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await eventually(() => {
    if (!dialog()?.textContent?.includes('このシナリオを削除できませんでした。')) throw new Error('error not shown')
  })
  expect(deletes).toEqual(['/api/scenarios/s1'])
  expect(dialog()).toBeTruthy()
})
