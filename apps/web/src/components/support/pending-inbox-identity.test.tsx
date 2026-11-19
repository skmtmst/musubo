// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ staffId: 'staff-a', requests: [] as string[] }))
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, staff: { ...actual.api.staff, me: async () => ({ success: true, data: { id: fixture.staffId, role: 'staff' } }) } },
    fetchApi: async (path: string) => { fixture.requests.push(path); return { success: true, data: { items: [], summary: { total: 30, line: 30, email: 0, emailUnread: 0, oldestWaitMinutes: 1 } } } },
  }
})
import PendingInboxCard from './pending-inbox-card'
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-17T00:00:00.000Z')); fixture.requests = []; fixture.staffId = 'staff-a'; window.localStorage.clear() })
afterEach(() => { cleanup(); vi.useRealTimers() })
it('本人APIのIDごとに保存した件数を復元し、同じ端末の別の担当者へ混ぜない', async () => {
  window.localStorage.setItem('lh_pending_inbox_page_size:staff-a', '10')
  window.localStorage.setItem('lh_pending_inbox_page_size:staff-b', '20')
  render(<PendingInboxCard />)
  await waitFor(() => expect(fixture.requests.some(path => path.includes('limit=10'))).toBe(true))
  cleanup()
  fixture.staffId = 'staff-b'; fixture.requests = []
  render(<PendingInboxCard />)
  await waitFor(() => expect(fixture.requests.some(path => path.includes('limit=20'))).toBe(true))
  expect(fixture.requests.some(path => path.includes('limit=10'))).toBe(false)
})

it('見出しの行の右端に、共通の文字リンクで「受信箱へ」を1つだけ置く', async () => {
  const { container, findByRole } = render(<PendingInboxCard />)
  expect(await findByRole('heading', { name: '対応が必要な受信（全アカウント）' })).toBeTruthy()
  const link = await findByRole('link', { name: '受信箱へ' })
  expect(link.getAttribute('href')).toBe('/chats')
  expect(link.closest('[data-design-node="t0jk8p"]')).not.toBeNull()
  // 共通の TextLink は言葉の後ろに「→」の印を描く（手書きの「→」の文字は使わない）。
  expect(link.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
  expect(link.textContent).toBe('受信箱へ')
  expect(container.textContent).not.toContain('受信箱をすべて見る')
})
