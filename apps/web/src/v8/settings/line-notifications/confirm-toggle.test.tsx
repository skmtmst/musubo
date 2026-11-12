// @vitest-environment happy-dom
/* 一覧の確認と、取消・失敗・成功の送信境界を実際の窓で確かめる。 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})
const fx = vi.hoisted(() => ({ account: 'account-a' }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/line-notifications',
}))
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => React.createElement('a', { href }, children) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fx.account, selectedAccount: { id: fx.account, name: fx.account } }) }))
vi.mock('@/components/shell/page-chrome', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/shell/page-chrome')>()
  return { ...actual, usePageTitle: () => undefined, usePageCrumbs: () => undefined }
})
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => 'owner' }
})

import Screen from './screen'
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
const setting = (label: string) => ({
  eventType: 'ec.order.confirmed', label, isEnabled: true, title: `${label}の見出し`, introText: '', outroText: '', category: 'order',
  buttonLabel: '', buttonUrl: '', imageUrl: '', displayOrder: 1, fixedFields: [], fixedPreview: '', updatedAt: '2026-10-01T00:00:00Z',
})


test('一覧のスイッチは確認前と取消で送信0、失敗は窓を残し、同じ内容を一度だけ再試行して成功した時だけ閉じる', async () => {
  fx.account = 'account-a'
  vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'lh_csrf' ? 'fixture-csrf' : null, setItem: () => undefined, removeItem: () => undefined })
  const definition = { id: 'definition-1', lineAccountId: fx.account, key: 'order', name: '注文', category: 'order',
    sourceEventType: 'ec.order.confirmed', status: 'published', draft: { title: '注文の見出し' },
    currentVersionId: 'version-1', currentVersionNumber: 1, transactionalOnly: true, version: 1, updatedAt: '2026-10-01T00:00:00Z' }
  const writes: Array<{ path: string; body: unknown }> = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (init?.method && init.method !== 'GET') {
      writes.push({ path: url.pathname, body: JSON.parse(String(init.body)) })
      if (writes.length === 1) return new Response(JSON.stringify({ success: false, error: '操作を受け付けられませんでした。' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      return json({ success: true, data: { ...definition, status: 'stopped', version: 2 } })
    }
    if (url.pathname === '/api/ec-commerce/settings') return json({ success: true, data: [setting('注文')] })
    if (url.pathname === '/api/line-notifications/customer-definitions') return json({ success: true, data: [definition] })
    if (url.pathname === '/api/ec-commerce/overview') return json({ success: true, data: { total: 0, processed: 0, identityPending: 0, failed: 0, skipped: 0, last24h: 0, lastReceivedAt: null, byType: [], subscriptions: 0 } })
    if (url.pathname.includes('/operator-rules')) return json({ success: true, data: { items: [], summary: { total: 0, published: 0, stopped: 0, missingRecipients: 0, recipients: 0, acceptedToday: 0, excludedToday: 0 } } })
    return json({ success: true, data: [] })
  })
  render(<Screen />)
  const toggle = await screen.findByRole('switch', { name: '注文のお知らせを出す・止める' })
  fireEvent.click(toggle)
  const cancelled = await screen.findByRole('dialog', { name: '「注文」のお知らせを止めますか？' })
  expect(writes).toHaveLength(0)
  fireEvent.click(within(cancelled).getByRole('button', { name: 'キャンセル' }))
  expect(writes).toHaveLength(0)
  fireEvent.click(toggle)
  const dialog = await screen.findByRole('dialog', { name: '「注文」のお知らせを止めますか？' })
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'お知らせを止める' })) })
  expect((await within(dialog).findByRole('alert')).textContent).toBeTruthy()
  expect(screen.getByRole('dialog', { name: '「注文」のお知らせを止めますか？' })).toBe(dialog)
  expect(writes).toHaveLength(1)
  await act(async () => { const retry = within(dialog).getByRole('button', { name: 'もう一度' }); fireEvent.click(retry); fireEvent.click(retry) })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(writes).toEqual([
    { path: '/api/line-notifications/customer-definitions/definition-1/stop', body: { lineAccountId: 'account-a', expectedVersion: 1 } },
    { path: '/api/line-notifications/customer-definitions/definition-1/stop', body: { lineAccountId: 'account-a', expectedVersion: 1 } },
  ])
})

test('テスト送信は窓に表示した宛先IDを固定して送る', async () => {
  fx.account = 'account-a'
  const writes: unknown[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (init?.method === 'POST' && url.pathname === '/api/ec-commerce/test-send') {
      writes.push(JSON.parse(String(init.body)))
      return json({ success: true, data: { sent: 1 } })
    }
    if (url.pathname === '/api/account-settings/test-recipients') return json({ success: true, confirmationRevision: 2, data: [{ id: 'friend-1', displayName: '受信者', pictureUrl: null }] })
    if (url.pathname === '/api/ec-commerce/settings') return json({ success: true, data: [setting('注文')] })
    if (url.pathname === '/api/line-notifications/customer-definitions') return json({ success: true, data: [] })
    if (url.pathname === '/api/ec-commerce/overview') return json({ success: true, data: { total: 0, processed: 0, identityPending: 0, failed: 0, skipped: 0, last24h: 0, lastReceivedAt: null, byType: [], subscriptions: 0 } })
    if (url.pathname.includes('/operator-rules')) return json({ success: true, data: { items: [], summary: { total: 0, published: 0, stopped: 0, missingRecipients: 0, recipients: 0, acceptedToday: 0, excludedToday: 0 } } })
    return json({ success: true, data: [] })
  })
  render(<Screen />)
  fireEvent.click(await screen.findByRole('button', { name: '注文の見出しの内容を編集' }))
  fireEvent.click(await screen.findByRole('button', { name: 'テスト受信者に送る' }))
  const dialog = await screen.findByRole('dialog', { name: 'テスト受信者に送信しますか？' })
  expect(await within(dialog).findByText(/受信者（1名）/)).toBeTruthy()
  expect(writes).toHaveLength(0)
  fireEvent.click(within(dialog).getByRole('button', { name: 'テスト受信者 1名へ送信' }))
  await waitFor(() => expect(writes).toHaveLength(1))
  expect(writes[0]).toMatchObject({ expectedRecipientIds: ['friend-1'], expectedConfirmationRevision: 2 })
})
