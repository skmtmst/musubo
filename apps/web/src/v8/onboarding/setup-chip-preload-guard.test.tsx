// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type { StaffMember } from '@line-crm/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SetupChip } from '@/components/shell/setup-chip'
import { clearApiReadCache } from '@/lib/api/transport/read-cache'
import { clearCommonCaches } from '@/lib/common-caches'
import { markLineAccountEntryReady, resolveLineAccountEntry } from '@/lib/line-account-entry'
import { forgetStaffIdentity, rememberStaffIdentity } from '@/lib/staff-identity-state'
import { GuideHost } from './guide-host'
import { clearPreloadedStyleSetupEvidence } from './style-setup-progress'

const nav = vi.hoisted(() => ({
  pathname: '/events',
  search: '',
  accountId: 'acc-1' as string | null,
  push: vi.fn(),
  replace: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
}))

vi.mock('@/contexts/account-context', () => ({
  useOptionalAccount: () => ({
    selectedAccountId: nav.accountId,
    accounts: nav.accountId ? [{ id: nav.accountId }] : [],
    loading: false,
    error: null,
    refreshing: false,
    refreshAccounts: vi.fn(),
    selectAccount: vi.fn(),
  }),
}))

function staffMember(overrides: Partial<StaffMember> = {}): StaffMember {
  return {
    id: 'staff-owner',
    tenantId: 'tenant-1',
    email: 'owner@example.com',
    displayName: 'Owner',
    role: 'owner',
    accountScope: 'all',
    ...overrides,
  } as StaffMember
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function gettingStartedPayload(todoCount: number) {
  return {
    success: true,
    data: {
      dismissed: false,
      firstRun: null,
      starter: null,
      steps: [
        { key: 'featureSet', state: 'done', href: '/settings/features', reason: null },
        { key: 'attributes', state: todoCount >= 1 ? 'todo' : 'done', href: '/tags', reason: null },
        { key: 'friendAdd', state: todoCount >= 2 ? 'todo' : 'done', href: '/friends/add', reason: null },
        { key: 'scenario', state: 'done', href: '/scenarios', reason: null },
        { key: 'firstMessage', state: 'done', href: '/chats', reason: null },
      ],
    },
  }
}

const releaseFns: Array<() => void> = []
const originalFetch = globalThis.fetch
const originalRestaurantEnv = process.env.NEXT_PUBLIC_RESTAURANT_TEST_ENABLED

beforeEach(() => {
  nav.pathname = '/events'
  nav.search = ''
  nav.accountId = 'acc-1'
  nav.push.mockReset()
  nav.replace.mockReset()
  process.env.NEXT_PUBLIC_RESTAURANT_TEST_ENABLED = 'true'
  window.localStorage.clear()
  window.sessionStorage.clear()
  clearCommonCaches()
  clearApiReadCache()
  clearPreloadedStyleSetupEvidence()
  forgetStaffIdentity()
})

afterEach(() => {
  cleanup()
  while (releaseFns.length > 0) releaseFns.pop()?.()
  clearCommonCaches()
  clearApiReadCache()
  clearPreloadedStyleSetupEvidence()
  forgetStaffIdentity()
  window.localStorage.clear()
  window.sessionStorage.clear()
  globalThis.fetch = originalFetch
  process.env.NEXT_PUBLIC_RESTAURANT_TEST_ENABLED = originalRestaurantEnv
})

describe('開店準備の札の先読み境界と自動報告の抑止', () => {
  it('先読みが入室確認完了より先に終わっても未確認の間と引き継ぎ遷移時は札を出さず、入室許可後に表示する', async () => {
    rememberStaffIdentity(staffMember())
    window.localStorage.setItem('musubo:account-style:acc-1', JSON.stringify({ style: 'standard', styleSelected: true }))
    const seenPaths: string[] = []
    let resolveEntry!: (res: Response) => void

    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://127.0.0.1:8788')
      const fullPath = `${url.pathname}${url.search}`
      seenPaths.push(fullPath)
      if (url.pathname === '/api/line-accounts/acc-1/follower-import') {
        return new Promise<Response>(resolve => { resolveEntry = resolve })
      }
      if (url.pathname === '/api/dashboard/style') {
        return Promise.resolve(jsonResponse({ success: true, data: { style: 'standard', styleSelected: true } }))
      }
      if (url.pathname === '/api/getting-started') {
        return Promise.resolve(jsonResponse(gettingStartedPayload(2)))
      }
      if (url.pathname === '/api/restaurant-test/google/connection') {
        return Promise.resolve(jsonResponse({
          success: true,
          store: { id: 's-1', name: 'Store 1', lineAccountId: 'acc-1' },
          connection: { status: 'connected', locationName: 'accounts/1/locations/1' },
        }))
      }
      if (url.pathname === '/api/restaurant-test/google/profile') {
        return Promise.resolve(jsonResponse({
          success: true,
          store: { id: 's-1', name: 'Store 1', lineAccountId: 'acc-1' },
          closed: false,
          profile: { regularHours: { MONDAY: [{ open: '09:00', close: '18:00' }] } },
        }))
      }
      return Promise.resolve(jsonResponse({ success: true, data: {} }))
    }) as typeof fetch

    const entryCheck = resolveLineAccountEntry('acc-1')
    const view = render(
      <GuideHost>
        <SetupChip />
      </GuideHost>,
    )

    await waitFor(() => {
      expect(seenPaths.some(p => p.startsWith('/api/getting-started'))).toBe(true)
      expect(seenPaths.some(p => p.startsWith('/api/restaurant-test/google/profile'))).toBe(true)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    view.rerender(
      <GuideHost>
        <SetupChip />
      </GuideHost>,
    )
    expect(document.querySelector('[data-setup-chip]')).toBeNull()
    expect(screen.queryByText(/開店準備/)).toBeNull()

    await act(async () => {
      resolveEntry(jsonResponse({ success: true, data: { destination: 'handover', canResume: false } }))
      const result = await entryCheck
      expect(result.destination).toBe('handover')
    })
    view.rerender(
      <GuideHost>
        <SetupChip />
      </GuideHost>,
    )
    expect(document.querySelector('[data-setup-chip]')).toBeNull()

    const gettingStartedCallsBeforeReady = seenPaths.filter(p => p.startsWith('/api/getting-started')).length
    act(() => {
      releaseFns.push(markLineAccountEntryReady('acc-1'))
    })
    await waitFor(() => expect(document.querySelector('[data-setup-chip="open"]')).toBeTruthy())
    expect(seenPaths.filter(p => p.startsWith('/api/getting-started')).length).toBe(gettingStartedCallsBeforeReady)
  })

  it('アカウント切替・担当者切替・ログアウトの直後は未確認アカウントの札を表示しない', async () => {
    rememberStaffIdentity(staffMember({ id: 'staff-1' }))
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://127.0.0.1:8788')
      const headerAccount = new Headers(init?.headers).get('X-Line-Account-Id')
      const accountId = url.searchParams.get('account_id') ?? url.searchParams.get('line_account_id') ?? headerAccount ?? 'acc-1'
      if (url.pathname === '/api/dashboard/style') {
        return Promise.resolve(jsonResponse({ success: true, data: { style: 'standard', styleSelected: true } }))
      }
      if (url.pathname === '/api/getting-started') {
        return Promise.resolve(jsonResponse(gettingStartedPayload(accountId === 'acc-1' ? 1 : 2)))
      }
      if (url.pathname === '/api/restaurant-test/google/connection') {
        return Promise.resolve(jsonResponse({
          success: true,
          store: { id: 's-1', name: 'Store', lineAccountId: accountId },
          connection: { status: 'disconnected', locationName: null },
        }))
      }
      if (url.pathname === '/api/restaurant-test/google/profile') {
        return Promise.resolve(jsonResponse({ message: 'not connected' }, 404))
      }
      return Promise.resolve(jsonResponse({ success: true, data: {} }))
    }) as typeof fetch

    releaseFns.push(markLineAccountEntryReady('acc-1'))
    const view = render(
      <GuideHost>
        <SetupChip />
      </GuideHost>,
    )
    await waitFor(() => expect(screen.getByText(/開店準備/)).toBeTruthy())

    nav.accountId = 'acc-2'
    view.rerender(
      <GuideHost>
        <SetupChip />
      </GuideHost>,
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    view.rerender(
      <GuideHost>
        <SetupChip />
      </GuideHost>,
    )
    expect(document.querySelector('[data-setup-chip]')).toBeNull()

    act(() => {
      releaseFns.push(markLineAccountEntryReady('acc-2'))
    })
    await waitFor(() => expect(document.querySelector('[data-setup-chip="open"]')).toBeTruthy())

    act(() => {
      rememberStaffIdentity(staffMember({ id: 'staff-2' }))
    })
    await waitFor(() => expect(document.querySelector('[data-setup-chip="open"]')).toBeTruthy())

    act(() => {
      forgetStaffIdentity()
      clearCommonCaches()
    })
    expect(document.querySelector('[data-setup-chip]')).toBeNull()
  })

  it('閲覧専用と統括・引き継ぎ画面では先読みせず、業種が分かる時だけ該当APIを先読みする', async () => {
    const requested: string[] = []
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://127.0.0.1:8788')
      requested.push(url.pathname)
      if (url.pathname === '/api/dashboard/style') {
        return new Promise<Response>(() => {})
      }
      return Promise.resolve(jsonResponse({ success: true, data: { items: [], stores: [], selectedStore: null } }))
    }) as typeof fetch

    rememberStaffIdentity(staffMember({ role: 'viewer', readOnly: true }))
    const viewerView = render(
      <GuideHost>
        <SetupChip />
      </GuideHost>,
    )
    await act(async () => { await Promise.resolve() })
    expect(requested).toEqual([])
    expect(document.querySelector('[data-setup-chip]')).toBeNull()
    viewerView.unmount()

    for (const pathname of ['/hq', '/hq/attention', '/accounts/new', '/accounts/new/handover', '/restaurant-test/stores/new', '/login']) {
      rememberStaffIdentity(staffMember({ role: 'owner' }))
      nav.pathname = pathname
      const hqView = render(
        <GuideHost>
          <SetupChip />
        </GuideHost>,
      )
      await act(async () => { await Promise.resolve() })
      expect(requested).toEqual([])
      expect(document.querySelector('[data-setup-chip]')).toBeNull()
      hqView.unmount()
    }

    rememberStaffIdentity(staffMember({ role: 'owner' }))
    nav.pathname = '/events'
    nav.accountId = 'acc-unknown'
    const unknownStyleView = render(
      <GuideHost>
        <SetupChip />
      </GuideHost>,
    )
    await waitFor(() => expect(requested).toContain('/api/getting-started'))
    expect(requested).not.toContain('/api/restaurant-test/google/connection')
    expect(requested).not.toContain('/api/restaurant-test/stores')
    unknownStyleView.unmount()

    requested.length = 0
    rememberStaffIdentity(staffMember({ role: 'owner' }))
    nav.accountId = 'acc-rest'
    window.localStorage.setItem('musubo:account-style:acc-rest', JSON.stringify({ style: 'restaurant', styleSelected: true }))
    const restaurantView = render(
      <GuideHost>
        <SetupChip />
      </GuideHost>,
    )
    await waitFor(() => expect(requested).toContain('/api/restaurant-test/stores'))
    expect(requested).toContain('/api/restaurant-test/store-context')
    expect(requested).not.toContain('/api/restaurant-test/google/connection')
    expect(requested).not.toContain('/api/restaurant-test/google/profile')
    restaurantView.unmount()

    requested.length = 0
    rememberStaffIdentity(staffMember({ role: 'owner' }))
    nav.accountId = 'acc-std'
    window.localStorage.setItem('musubo:account-style:acc-std', JSON.stringify({ style: 'standard', styleSelected: true }))
    const standardView = render(
      <GuideHost>
        <SetupChip />
      </GuideHost>,
    )
    await waitFor(() => expect(requested).toContain('/api/restaurant-test/google/connection'))
    expect(requested).not.toContain('/api/restaurant-test/stores')
    expect(requested).not.toContain('/api/restaurant-test/store-context')
    standardView.unmount()
  })

  it('同じ500応答が連続しても自動エラー報告は1回に抑え、正常応答を挟んだ後の再発だけ再送する', async () => {
    rememberStaffIdentity(staffMember())
    window.localStorage.setItem('musubo:account-style:acc-1', JSON.stringify({ style: 'standard', styleSelected: true }))
    releaseFns.push(markLineAccountEntryReady('acc-1'))

    let profileStatus = 500
    let profileCalls = 0
    let errorReportCalls = 0

    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://127.0.0.1:8788')
      if (url.pathname === '/api/client-errors') {
        errorReportCalls += 1
        return Promise.resolve(jsonResponse({ success: true }))
      }
      if (url.pathname === '/api/dashboard/style') {
        return Promise.resolve(jsonResponse({ success: true, data: { style: 'standard', styleSelected: true } }))
      }
      if (url.pathname === '/api/getting-started') {
        return Promise.resolve(jsonResponse(gettingStartedPayload(1)))
      }
      if (url.pathname === '/api/restaurant-test/google/connection') {
        return Promise.resolve(jsonResponse({
          success: true,
          store: { id: 's-1', name: 'Store 1', lineAccountId: 'acc-1' },
          connection: { status: 'connected', locationName: 'accounts/1/locations/1' },
        }))
      }
      if (url.pathname === '/api/restaurant-test/google/profile') {
        profileCalls += 1
        if (profileStatus >= 500) {
          return Promise.resolve(jsonResponse({ success: false, error: 'upstream_failure' }, profileStatus))
        }
        return Promise.resolve(jsonResponse({
          success: true,
          store: { id: 's-1', name: 'Store 1', lineAccountId: 'acc-1' },
          closed: false,
          profile: { regularHours: { MONDAY: [{ open: '09:00', close: '18:00' }] } },
        }))
      }
      return Promise.resolve(jsonResponse({ success: true, data: {} }))
    }) as typeof fetch

    render(
      <GuideHost>
        <SetupChip />
      </GuideHost>,
    )
    await waitFor(() => expect(profileCalls).toBe(1))
    await waitFor(() => expect(errorReportCalls).toBe(1))

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await waitFor(() => expect(profileCalls).toBe(2))
    await act(async () => { await Promise.resolve() })
    expect(errorReportCalls).toBe(1)

    profileStatus = 200
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await waitFor(() => expect(profileCalls).toBe(3))
    expect(errorReportCalls).toBe(1)

    profileStatus = 500
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await waitFor(() => expect(profileCalls).toBe(4))
    await waitFor(() => expect(errorReportCalls).toBe(2))
  })
})
