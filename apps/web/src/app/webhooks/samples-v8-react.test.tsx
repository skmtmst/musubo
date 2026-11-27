// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

import WebhooksPage from './page'

/*
 * ★V8-B 外部連携の見本（板 ）の契約。
 * `<html data-theme="v8">` の下でだけ新しい見本タブに切り替わり、
 * 節の名付けがタブ名（こちらで受け取る・こちらから送る）とそろい、
 * 受け取る5＋送る4の見本カードが出ることを実DOMで固定する。
 * 互換経路では従来の見本タブが出ることも固定する。
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
  usePathname: () => '/webhooks',
  useSearchParams: () => new URLSearchParams([['tab', 'notify']]),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({
  selectedAccountId: 'account-a',
  selectedAccount: { name: 'NEN-TEST' },
  accounts: [],
  loading: false,
}) }))

let root: Root
let host: HTMLDivElement

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
    if (url.includes('/api/webhooks/outgoing')) return json({ success: true, data: [] })
    if (url.includes('/api/webhooks/incoming')) return json({ success: true, data: [] })
    if (url.includes('/api/webhooks/interactions')) {
      return json({ success: true, data: { summary: {
        total: 0, outgoing: 0, incoming: 0, succeeded: 0,
        failed: 0, resultUnknown: 0, outgoingFailed: 0, retryable: 0, averageDurationMs: null,
      } } })
    }
    if (url.includes('/api/staff/me')) return json({ success: true, data: { role: 'owner' } })
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

test('v8 では SAUCs の見本カードがタブ名とそろって出る', async () => {
  document.documentElement.dataset.theme = 'v8'
  await renderPage()
  const board = host.querySelector('[data-design-node="SAUCs"]')
  expect(board).not.toBeNull()
  expect(board?.textContent).toContain('こちらで受け取る（どこから来るか）')
  expect(board?.textContent).not.toContain('受け取る見本')
  expect(board?.textContent).toContain('こちらから送る（いつ・何を送るか）')
  expect(board?.textContent).not.toContain('送る見本')
  expect(board?.textContent).toContain('LINE公式アカウント')
  expect(board?.textContent).toContain('決済サービス')
  expect(board?.textContent).toContain('友だちが追加されたとき')
  expect(board?.textContent).toContain('注文が確定したとき')
  expect(board?.textContent).toContain('friend_add')
  expect(board?.textContent).not.toContain('見本に書いたことだけを送ります')
  const help = host.querySelector<HTMLButtonElement>('button[aria-label="外部連携の説明"]')
  expect(help).not.toBeNull()
  act(() => { help!.click() })
  expect(board?.textContent).toContain('見本に書いたことだけを送ります')
  act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
  expect(board?.textContent).not.toContain('見本に書いたことだけを送ります')
})

test('旧テーマ属性でも現役の見本タブが出て SAUCs が出る', async () => {
  await renderPage()
  expect(host.querySelector('[data-design-node="SAUCs"]')).not.toBeNull()
  expect(host.textContent).toContain('こちらで受け取る')
})

test('受け取る見本と送る見本は、それぞれの内容を選んだ作成先へ進む', async () => {
  document.documentElement.dataset.theme = 'v8'
  await renderPage()
  const board = host.querySelector('[data-design-node="SAUCs"]')!
  const incoming = [
    ['LINE公式アカウント', 'line'], ['予約サービス', 'booking'], ['アンケートツール', 'form'], ['ECサイト', 'ec'], ['決済サービス', 'payment'],
  ]
  const outgoing = [
    ['友だちが追加されたとき', 'friend_add'], ['フォームが送られたとき', 'form_submitted'], ['予約が入ったとき', 'booking_created'], ['注文が確定したとき', 'ec.order.confirmed'],
  ]
  for (const [name, source] of incoming) {
    const card = [...board.querySelectorAll('li')].find(item => item.textContent?.includes(name))!
    expect(card).toBeTruthy()
    expect(card.querySelector('a')?.getAttribute('href')).toBe(`/webhooks?tab=incoming&source=${source}`)
  }
  const booking = [...board.querySelectorAll('li')].find(item => item.textContent?.includes('予約サービス'))!
  expect(booking.textContent).toContain('予約の確定・変更・取り消しを受け取ります')
  for (const [name, event] of outgoing) {
    const card = [...board.querySelectorAll('li')].find(item => item.textContent?.includes(name))!
    expect(card).toBeTruthy()
    expect(card.textContent).toContain(event)
    expect(card.querySelector('a')?.getAttribute('href')).toBe(`/webhooks/new?event=${event}`)
  }
})
