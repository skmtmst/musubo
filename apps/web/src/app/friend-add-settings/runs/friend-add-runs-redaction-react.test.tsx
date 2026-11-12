// @vitest-environment happy-dom
vi.mock('@/lib/staff-role', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/staff-role')>()), useStaffRole: () => 'owner' }))
/* eslint-disable @typescript-eslint/no-explicit-any -- ページのread model表示を実DOMで確認するための最小mock */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ redacted: true }))
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a> }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-1', accounts: [{ id: 'account-1' }], loading: false }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => undefined }))
vi.mock('@/components/shared/button', () => ({ default: ({ href, children, ...props }: any) => href ? <a href={href} {...props}>{children}</a> : <button {...props}>{children}</button> }))
vi.mock('@/components/shared/confirm-dialog', () => ({ default: () => null }))
vi.mock('@/components/shared/list-state', () => ({ default: ({ title }: { title: string }) => <div>{title}</div> }))
vi.mock('@/components/shared/select', () => ({ default: () => null }))
vi.mock('@/components/shared/status-badge', () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }))
vi.mock('@/components/shared/kpi-card', () => ({ default: () => null }))
vi.mock('@/components/shared/sticky-bar', () => ({ default: ({ actions }: { actions: React.ReactNode }) => <div>{actions}</div> }))
vi.mock('@/lib/api', () => ({ api: { friendAddRules: {
  runs: vi.fn(async () => ({ success: true, data: {
    items: [{
      id: 'run-1', receivedAt: '2026-09-16T09:00:00+09:00', processedAt: null,
      friend: state.redacted ? { displayName: '顧客名は非表示', redacted: true } : { id: 'friend-1', displayName: '見本 141', redacted: false },
      friendKind: 'first_time', attribution: { status: 'unavailable', routeId: null, routeName: null, reason: null },
      rule: null, scenario: null, actions: { total: 0, failed: 0 }, deliveryCount: 0, status: 'completed', errorCode: null,
    }],
    total: 1, nextCursor: null,
    summary: { recentFriends: 1, recentEvents: 1, cumulativeDeliveries: 0, scenarioStarts: 0, averageSendTimeMs: null, failed: 0, lastDeliveryAt: null, staffHandoffs: { value: null, state: 'unavailable', reason: null } },
  } })),
  get: vi.fn(async () => ({ success: false })), stop: vi.fn(),
} } }))

const { default: FriendAddRunsPage } = await import('./page')
let host: HTMLDivElement
let root: Root

beforeEach(() => {
  state.redacted = true
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
  vi.restoreAllMocks()
})

async function render() {
  await act(async () => {
    root.render(<FriendAddRunsPage />)
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await Promise.resolve()
  })
}

describe('N-106 友だち追加時配信のstaff read model', () => {
  it('マスクされた顧客は名前を表示しても詳細画面へのID導線を作らない', async () => {
    await render()
    expect(host.textContent).toContain('顧客名は非表示')
    expect(host.querySelector('a[href^="/friends/detail"]')).toBeNull()
  })

  it('admin read modelは顧客名を表示し、その追加記録へ進める', async () => {
    state.redacted = false
    await render()
    expect(host.textContent).toContain('見本 141')
    expect(host.querySelector('a[href="/friend-add-settings/runs/detail?id=run-1"]')).not.toBeNull()
  })
})
