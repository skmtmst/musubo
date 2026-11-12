import { getPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
/*
 * 監査 WEB232：「下書きを保存」で作れたのに止められなかったら、一覧へ移らずに知らせ、
 * もう一度押すと止めるところだけやり直す（同じ送り先をもう1つ作らない）。
 */
import React, { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})
const nav = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/webhooks/new',
  useSearchParams: () => new URLSearchParams(''),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', selectedAccount: { id: 'account-a', name: '本店' }, accounts: [{ id: 'account-a', name: '本店' }], loading: false }),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => false }))
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => 'owner' }
})

import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
beforeEach(() => verifiedStaffRole('owner'))
import WebhooksCreateV8 from './create'
afterEach(() => { cleanup(); vi.unstubAllGlobals(); nav.push.mockReset() })

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

test('止められなかったら知らせて残り、もう一度押すと止めるだけやり直す', async () => {
  const calls: string[] = []
  let savedSecret: string | undefined
  let puts = 0
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (method !== 'GET') calls.push(`${method} ${new URL(url).pathname}`)
    if (method === 'POST' && url.includes('/api/webhooks/outgoing')) {
      savedSecret = JSON.parse(String(init?.body)).secret
      return json({ success: true, data: { id: 'wh-1', secret: 'x' } })
    }
    if (method === 'PUT' && url.includes('/api/webhooks/outgoing/wh-1')) {
      puts += 1
      return puts === 1 ? json({ success: false, error: 'down' }, 500) : json({ success: true, data: { id: 'wh-1' } })
    }
    if (url.includes('/api/staff/me')) return json({ success: true, data: { role: 'owner' } })
    return json({ success: true, data: [] })
  })
  render(<WebhooksCreateV8 />)
  fireEvent.change(document.querySelector('#wh-new-name')!, { target: { value: '予約台帳' } })
  fireEvent.change(document.querySelector('#wh-new-url')!, { target: { value: 'https://example.com/hook' } })
  const secret = document.querySelector('#wh-new-secret') as HTMLInputElement
  expect(secret.readOnly).toBe(true)
  const generatedSecret = secret.value
  fireEvent.click(document.querySelector('input[name="wh-new-mode"][value="all"]')!)
  await act(async () => { getPageAction({ name: '下書きを保存' }).click() })
  await waitFor(() => expect(screen.getByText(/まだ止められていません/)).toBeTruthy())
  expect(nav.push).not.toHaveBeenCalled()
  await act(async () => { getPageAction({ name: '下書きを保存' }).click() })
  await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/webhooks?highlight=wh-1'))
  expect(calls.filter((call) => call.startsWith('POST /api/webhooks/outgoing'))).toHaveLength(1)
  expect(puts).toBe(2)
  expect(savedSecret).toBe(generatedSecret)
})

test('名前とURLが足りないまま保存すると、帯で済ませず欄が赤くなり、1つ目（名前）の欄へ移る', async () => {
  vi.stubGlobal('fetch', async () => json({ success: true, data: [] }))
  render(<WebhooksCreateV8 />)
  fireEvent.change(document.querySelector('#wh-new-url')!, { target: { value: 'http://example.com' } })
  await act(async () => { getPageAction({ name: '下書きを保存' }).click() })
  await act(async () => { await new Promise((r) => requestAnimationFrame(r)) })
  const name = document.querySelector('#wh-new-name') as HTMLInputElement
  expect(name.getAttribute('aria-invalid')).toBe('true')
  expect(document.querySelector('#wh-new-url')?.getAttribute('aria-invalid')).toBe('true')
  expect(screen.getByText('名前を入力してください')).toBeTruthy()
  expect(screen.getByText('URLは https:// で始めてください')).toBeTruthy()
  expect(screen.queryByText(/直す所があります/)).toBeNull()
  expect(document.activeElement).toBe(name)
})

test('欄から離れた時点で、触った欄だけ理由を出し、直すとその場で消す', async () => {
  const sent: string[] = []
  vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') !== 'GET') sent.push(init?.method ?? '')
    return json({ success: true, data: [] })
  })
  render(<WebhooksCreateV8 />)
  const name = document.querySelector('#wh-new-name') as HTMLInputElement
  const url = document.querySelector('#wh-new-url') as HTMLInputElement
  const secret = document.querySelector('#wh-new-secret') as HTMLInputElement
  fireEvent.blur(name)
  expect(name.getAttribute('aria-invalid')).toBe('true')
  expect(screen.getAllByText('名前を入力してください')).toHaveLength(1)
  // まだ触っていない欄は黙っている。
  expect(url.getAttribute('aria-invalid')).not.toBe('true')
  expect(screen.queryByText('URLは https:// で始めてください')).toBeNull()

  fireEvent.change(url, { target: { value: 'http://example.com' } })
  fireEvent.blur(url)
  expect(screen.getByText('URLは https:// で始めてください')).toBeTruthy()
  fireEvent.change(url, { target: { value: 'https://example.com/hook' } })
  expect(screen.queryByText('URLは https:// で始めてください')).toBeNull()

  expect(secret.readOnly).toBe(true)
  fireEvent.blur(secret)
  expect(secret.getAttribute('aria-invalid')).not.toBe('true')

  fireEvent.change(name, { target: { value: '予約台帳' } })
  expect(screen.queryByText('名前を入力してください')).toBeNull()
  expect(name.getAttribute('aria-invalid')).not.toBe('true')
  expect(sent).toEqual([])
})

test('下書きは最初から停止した送り先として作られ、途中で動作しない', async () => {
  const writes: Array<{ method: string; body: Record<string, unknown> }> = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method !== 'GET' && String(input).includes('/api/webhooks/outgoing')) {
      writes.push({ method, body: JSON.parse(String(init?.body)) })
      return json({ success: true, data: { id: 'wh-draft', isActive: false } })
    }
    if (String(input).includes('/api/staff/me')) return json({ success: true, data: { role: 'owner' } })
    return json({ success: true, data: [] })
  })
  render(<WebhooksCreateV8 />)
  fireEvent.change(document.querySelector('#wh-new-name')!, { target: { value: '予約台帳' } })
  fireEvent.change(document.querySelector('#wh-new-url')!, { target: { value: 'https://example.com/hook' } })
  fireEvent.click(document.querySelector('input[name="wh-new-mode"][value="all"]')!)
  await act(async () => { getPageAction({ name: '下書きを保存' }).click() })
  await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/webhooks?highlight=wh-draft'))
  expect(writes).toHaveLength(1)
  expect(writes[0]).toMatchObject({ method: 'POST', body: { isActive: false } })
})
