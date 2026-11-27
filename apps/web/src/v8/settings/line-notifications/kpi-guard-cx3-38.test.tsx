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


function setup(counts: unknown, quota: unknown) {
  let calls = 0
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/ec-commerce/settings') return json({ success: true, data: [setting('注文')] })
    if (url.pathname === '/api/line-notifications/customer-definitions') return json({ success: true, data: [] })
    if (url.pathname === '/api/ec-commerce/overview') return json({ success: true, data: { total: 0, processed: 0, identityPending: 0, failed: 0, skipped: 0, last24h: 0, lastReceivedAt: null, byType: [], subscriptions: 0 } })
    if (url.pathname.endsWith('/send-counts')) return json({ success: true, data: Array.isArray(counts) ? counts[Math.min(calls++, counts.length - 1)] : counts })
    if (url.pathname.endsWith('/deliveries')) return json({ success: true, data: { quota } })
    if (url.pathname.includes('/operator-rules')) return json({ success: true, data: { items: [], summary: { total: 0, published: 0, stopped: 0, missingRecipients: 0, recipients: 0, acceptedToday: 0, excludedToday: 0 } } })
    return json({ success: true, data: [] })
  })
}

test('不正な送信件数は失敗として知らせる', async () => {
  setup([{ sentToday: -1, sentLast30d: 2, byEventType: [] }, { sentToday: 1, sentLast30d: 2, byEventType: [] }], null)
  render(<Screen />)
  expect(await screen.findByText('送信件数を読み込めませんでした')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  await waitFor(() => expect(screen.queryByText('送信件数を読み込めませんでした')).toBeNull())
})

test('不正な送信枠は正しい数を出さず確認できないと伝える', async () => {
  setup({ sentToday: 1, sentLast30d: 2, byEventType: [] }, { state: 'available', used: 2, total: -10, remaining: 0 })
  render(<Screen />)
  expect(await screen.findByText('送信枠を確認できません')).toBeTruthy()
  expect(screen.queryByText('2 / -10')).toBeNull()
})
