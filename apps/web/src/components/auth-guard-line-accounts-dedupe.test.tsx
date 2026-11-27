// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const fixture = vi.hoisted(() => ({ pathname: '/templates' }))
const routerMock = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }))

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  usePathname: () => fixture.pathname,
}))

vi.mock('./hq/platform-notices', () => ({
  default: () => null,
}))

import AuthGuard, { invalidateAuthSessionCheck } from './auth-guard'
import { AccountProvider, useAccount } from '@/contexts/account-context'
import { loadLineAccounts } from '@/lib/line-accounts-cache'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, String(value)) }
}

const ACCOUNT_A = { id: 'acc-a', channelId: 'ch-a', name: '本店A', isActive: true, country: null, role: null, displayOrder: 0 }
const ACCOUNT_B = { id: 'acc-b', channelId: 'ch-b', name: '支店B', isActive: true, country: null, role: null, displayOrder: 1 }
const ACCOUNT_USER2 = { id: 'acc-u2', channelId: 'ch-u2', name: '別ユーザー店', isActive: true, country: null, role: null, displayOrder: 0 }

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function sessionOk(csrfToken: string, name = '担当A') {
  return jsonResponse({
    success: true,
    data: { name, role: 'owner', tenantStatus: 'active', onboarding: null, permissionKeys: [], viewPermissionKeys: [] },
    csrfToken,
  })
}

function AccountsProbe() {
  const { accounts, selectedAccountId, error, loading, setSelectedAccountId, refreshAccounts } = useAccount()
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="error">{error ?? ''}</span>
      <span data-testid="names">{accounts.map((a) => a.name).join(',')}</span>
      <span data-testid="selected">{selectedAccountId ?? ''}</span>
      <button type="button" onClick={() => setSelectedAccountId('acc-b')}>支店Bへ切替</button>
      <button type="button" onClick={() => { void refreshAccounts() }}>もう一度読み込む</button>
    </div>
  )
}

async function eventually(check: () => void, timeout = 1500) {
  const started = Date.now()
  while (true) {
    try { check(); return } catch (error) {
      if (Date.now() - started >= timeout) throw error
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    }
  }
}

let storage: MemoryStorage
let sessionStore: MemoryStorage

beforeEach(() => {
  fixture.pathname = '/templates'
  routerMock.replace.mockReset()
  routerMock.push.mockReset()
  storage = new MemoryStorage()
  sessionStore = new MemoryStorage()
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('sessionStorage', sessionStore)
  invalidateAuthSessionCheck()
})

afterEach(() => {
  cleanup()
  invalidateAuthSessionCheck()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('AuthGuard と AccountProvider の /api/line-accounts 共有', () => {
  it('初回表示（lh_csrf 未保存）で /api/line-accounts を 1 回だけ取得して共有する', async () => {
    const lineAccountsCalls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/api/auth/session') return sessionOk('csrf-cold-1')
      if (url.pathname === '/api/line-accounts') {
        lineAccountsCalls.push(input)
        return jsonResponse({ success: true, data: [ACCOUNT_A, ACCOUNT_B] })
      }
      if (url.pathname === '/api/line-accounts/profile-pictures') return jsonResponse({ success: true, data: [] })
      if (url.pathname === '/api/staff/me') return jsonResponse({ success: true, data: { id: 'staff-1', role: 'owner' } })
      return jsonResponse({ success: true, data: [] })
    }))

    render(
      <AuthGuard>
        <AccountProvider>
          <AccountsProbe />
        </AccountProvider>
      </AuthGuard>,
    )

    await eventually(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false')
      expect(screen.getByTestId('names').textContent).toBe('本店A,支店B')
    })
    expect(lineAccountsCalls).toHaveLength(1)
  })

  it('再読込で /api/auth/session が CSRF を更新しても /api/line-accounts を 1 回で共有する', async () => {
    storage.setItem('lh_csrf', 'csrf-old')
    storage.setItem('lh_selected_account', 'acc-a')
    const lineAccountsCalls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/api/auth/session') return sessionOk('csrf-rotated-2')
      if (url.pathname === '/api/line-accounts') {
        lineAccountsCalls.push(input)
        return jsonResponse({ success: true, data: [ACCOUNT_A, ACCOUNT_B] })
      }
      if (url.pathname === '/api/line-accounts/profile-pictures') return jsonResponse({ success: true, data: [] })
      if (url.pathname === '/api/staff/me') return jsonResponse({ success: true, data: { id: 'staff-1', role: 'owner' } })
      return jsonResponse({ success: true, data: [] })
    }))

    render(
      <AuthGuard>
        <AccountProvider>
          <AccountsProbe />
        </AccountProvider>
      </AuthGuard>,
    )

    await eventually(() => {
      expect(screen.getByTestId('names').textContent).toBe('本店A,支店B')
    })
    expect(storage.getItem('lh_csrf')).toBe('csrf-rotated-2')
    expect(lineAccountsCalls).toHaveLength(1)
  })

  it('アカウントを切り替えた後は古い結果を使い回さず取り直す', async () => {
    let version = 1
    const lineAccountsCalls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/api/auth/session') return sessionOk('csrf-switch-1')
      if (url.pathname === '/api/line-accounts') {
        lineAccountsCalls.push(input)
        const list = version === 1 ? [ACCOUNT_A, ACCOUNT_B] : [ACCOUNT_A, { ...ACCOUNT_B, name: '支店B（更新後）' }]
        return jsonResponse({ success: true, data: list })
      }
      if (url.pathname === '/api/line-accounts/profile-pictures') return jsonResponse({ success: true, data: [] })
      return jsonResponse({ success: true, data: [] })
    }))

    render(
      <AuthGuard>
        <AccountProvider>
          <AccountsProbe />
        </AccountProvider>
      </AuthGuard>,
    )

    await eventually(() => {
      expect(screen.getByTestId('names').textContent).toBe('本店A,支店B')
    })
    expect(lineAccountsCalls).toHaveLength(1)

    version = 2
    fireEvent.click(screen.getByRole('button', { name: '支店Bへ切替' }))
    await eventually(() => {
      expect(screen.getByTestId('selected').textContent).toBe('acc-b')
    })

    const fresh = await loadLineAccounts()
    expect(lineAccountsCalls).toHaveLength(2)
    expect(fresh.data?.map((a) => a.name)).toEqual(['本店A', '支店B（更新後）'])
  })

  it('別ユーザーでログインし直したときは前ユーザーのアカウント一覧を使い回さない', async () => {
    let activeUser: 'user1' | 'user2' = 'user1'
    let lineAccountsCount = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/api/auth/session') {
        return activeUser === 'user1' ? sessionOk('csrf-user-1', '担当1') : sessionOk('csrf-user-2', '担当2')
      }
      if (url.pathname === '/api/line-accounts') {
        lineAccountsCount++
        return jsonResponse({ success: true, data: activeUser === 'user1' ? [ACCOUNT_A] : [ACCOUNT_USER2] })
      }
      if (url.pathname === '/api/line-accounts/profile-pictures') return jsonResponse({ success: true, data: [] })
      return jsonResponse({ success: true, data: [] })
    }))

    const first = render(
      <AuthGuard>
        <AccountProvider>
          <AccountsProbe />
        </AccountProvider>
      </AuthGuard>,
    )

    await eventually(() => {
      expect(screen.getByTestId('names').textContent).toBe('本店A')
    })
    expect(lineAccountsCount).toBe(1)

    // ログアウト・別ユーザーで再ログイン
    first.unmount()
    storage.clear()
    sessionStore.clear()
    invalidateAuthSessionCheck()
    activeUser = 'user2'

    render(
      <AuthGuard>
        <AccountProvider>
          <AccountsProbe />
        </AccountProvider>
      </AuthGuard>,
    )

    await eventually(() => {
      expect(screen.getByTestId('names').textContent).toBe('別ユーザー店')
    })
    expect(lineAccountsCount).toBe(2)
  })

  it('先読みが失敗したときは失敗を保持せず、再読み込みで正しく取り直せる', async () => {
    let failAccounts = true
    let resolveAccounts!: (response: Response) => void
    let lineAccountsCount = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/api/auth/session') return sessionOk('csrf-fail-1')
      if (url.pathname === '/api/line-accounts') {
        lineAccountsCount++
        if (failAccounts) {
          return new Promise<Response>((resolve) => { resolveAccounts = resolve })
        }
        return jsonResponse({ success: true, data: [ACCOUNT_A] })
      }
      if (url.pathname === '/api/line-accounts/profile-pictures') return jsonResponse({ success: true, data: [] })
      return jsonResponse({ success: true, data: [] })
    }))

    render(
      <AuthGuard>
        <AccountProvider>
          <AccountsProbe />
        </AccountProvider>
      </AuthGuard>,
    )

    // 認証確認が先に完了し、AccountProvider が進行中の 1 本目に相乗りする
    await eventually(() => {
      expect(screen.getByTestId('loading').textContent).toBe('true')
    })
    expect(lineAccountsCount).toBe(1)

    // 1 本目が 500 で失敗 -> エラー表示になり、失敗はキャッシュに残らない
    await act(async () => {
      resolveAccounts(jsonResponse({ success: false, error: '一時エラー' }, 500))
    })
    await eventually(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false')
      expect(screen.getByTestId('error').textContent).not.toBe('')
    })

    // 再読み込みで 2 本目を取り直して回復する
    failAccounts = false
    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    await eventually(() => {
      expect(screen.getByTestId('error').textContent).toBe('')
      expect(screen.getByTestId('names').textContent).toBe('本店A')
    })
    expect(lineAccountsCount).toBe(2)
  })
})
