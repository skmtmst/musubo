// @vitest-environment happy-dom
import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
import type { StaffMember } from '@line-crm/shared'

import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * 使い方のスタイルを読み直せず、同じアカウントで前に読めたスタイルで出している時（stale）の 1 行（R10）。
 * 左メニューが出す。本文が同じ 1 行を出す画面（ホーム・予約台帳・見本のリッチメニュー）では出さない。
 */

const localStorageValues = new Map<string, string>()
const testLocalStorage = {
  getItem: (key: string) => localStorageValues.get(key) ?? null,
  setItem: (key: string, value: string) => { localStorageValues.set(key, String(value)) },
  removeItem: (key: string) => { localStorageValues.delete(key) },
  clear: () => { localStorageValues.clear() },
}
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: testLocalStorage })
Object.defineProperty(window, 'localStorage', { configurable: true, value: testLocalStorage })

const fixture = vi.hoisted(() => ({
  accountId: 'account-a',
  pathname: '/notifications',
  visibilityFails: false,
  reload: vi.fn(),
  styleOf: (accountId: string | null | undefined): { data: { style: string } | null; error: unknown; stale: boolean; status: string } =>
    ({ data: accountId ? { style: 'restaurant' } : null, error: null, stale: false, status: accountId ? 'ready' : 'idle' }),
}))

vi.mock('next/navigation', () => ({ usePathname: () => fixture.pathname }))
vi.mock('next/link', async () => {
  const React = await import('react')
  return { default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => React.createElement('a', { href, ...props }, children) }
})
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fixture.accountId }) }))
vi.mock('@/lib/use-brand', () => ({ useBrand: () => ({ name: '会社', iconUrl: null }) }))
vi.mock('@/components/layout/sidebar-identity', () => ({ default: () => <div>identity</div> }))
vi.mock('@/components/hq/account-menu', () => ({ default: () => <div>hq</div>, SidebarAccountMenu: () => <div>me-store</div> }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return {
    api: {
      featureSettings: actual.api.featureSettings,
      inbox: { unanswered: { count: vi.fn(async () => ({ success: true, data: { total: 0 } })) } },
      nenMembers: { overview: vi.fn(async () => ({ success: true, data: { pendingPhotos: 0 } })) },
      health: { summary: vi.fn(async () => ({ success: true, data: { warningCount: 0, dangerCount: 0 } })) },
    },
  }
})
vi.mock('@/hooks/use-account-style', async original => ({
  ...await original<typeof import('@/hooks/use-account-style')>(),
  useAccountStyle: (accountId: string | null | undefined) => ({ ...fixture.styleOf(accountId), reload: fixture.reload }),
}))

import Sidebar from './sidebar'
import StaleStyleNotice from '@/components/shared/stale-style-notice'
import { STALE_STYLE_TEXT } from '@/hooks/use-account-style'
import { clearFeatureVisibilityCache } from '@/lib/feature-visibility-cache'
import { clearFeatureSettingsCache } from '@/lib/feature-settings-cache'

// 左メニューは PC の帯と、閉じている間は触れない（inert）スマホの引き出しに同じ中身を描く。数えるのは見えている側だけ。
const visible = () => [...document.querySelectorAll('[data-stale-style-notice]')].filter(node => !node.closest('#mobile-menu'))
const staleNotices = visible
const desktop = () => within(document.querySelector('aside:not(#mobile-menu)') as HTMLElement)
const staleFor = (staleAccount: string) => (accountId: string | null | undefined) =>
  ({ data: accountId ? { style: 'restaurant' } : null, error: null, stale: accountId === staleAccount, status: accountId ? 'ready' : 'idle' })

describe('左メニューの stale の 1 行（ID125・R10）', () => {
  beforeEach(() => {
    forgetStaffIdentity()
    clearFeatureVisibilityCache()
    clearFeatureSettingsCache()
    fixture.accountId = 'account-a'
    fixture.pathname = '/notifications'
    fixture.visibilityFails = false
    fixture.reload.mockReset()
    fixture.styleOf = staleFor('account-a')
    window.localStorage.clear()
    window.localStorage.setItem('lh_csrf', 'fixture-session')
    window.localStorage.setItem('lh_staff_role', 'owner')
    rememberStaffIdentity({ role: 'owner' } as StaffMember)
    // 読むのは機能の表示可否だけ。書き込みの口は無い。
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method && init.method !== 'GET') throw new Error(`書き込みは試験の外: ${init.method} ${input}`)
      const url = new URL(input)
      if (url.pathname === '/api/settings/features/visibility') {
        return fixture.visibilityFails
          ? new Response(JSON.stringify({ success: false, error: 'x' }), { status: 500 })
          : new Response(JSON.stringify({ success: true, data: { features: { broadcasts: true } } }))
      }
      return new Response(JSON.stringify({ success: true, data: {} }))
    }))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('stale なら 1 行と「読み直す」を 1 つ出し、押すとスタイルだけを 1 回読み直す', async () => {
    render(<Sidebar />)
    await waitFor(() => expect(staleNotices()).toHaveLength(1))
    expect(staleNotices()[0]!.textContent).toContain(`${STALE_STYLE_TEXT}。前に読めた表示で出しています。`)
    expect(staleNotices()[0]!.parentElement?.parentElement).toBe(desktop().getByRole('navigation'))
    expect(staleNotices()[0]!.parentElement?.className).toBe('')
    const retry = desktop().getAllByRole('button', { name: '読み直す' })
    expect(retry).toHaveLength(1)
    fireEvent.click(retry[0]!)
    expect(fixture.reload).toHaveBeenCalledTimes(1)
    // 初回の失敗（unknown）の案内は出さない。メニューは前に読めたスタイルのまま出る。
    expect(desktop().queryByText('使い方のスタイルを読み込めませんでした。')).toBeNull()
    expect(desktop().getAllByRole('link').length).toBeGreaterThan(0)
  })

  it('初回で分からない（error）時は今の案内と「もう一度」のままで、stale の 1 行は出さない', async () => {
    fixture.styleOf = (accountId) => ({ data: null, error: accountId ? new Error('x') : null, stale: false, status: accountId ? 'error' : 'idle' })
    render(<Sidebar />)
    await waitFor(() => expect(desktop().getByText('使い方のスタイルを読み込めませんでした。')).toBeTruthy())
    expect(desktop().getByText('使い方のスタイルを読み込めませんでした。').closest('[data-design-part="notice"]')?.parentElement).toBe(desktop().getByRole('navigation'))
    expect(desktop().getAllByRole('button', { name: 'もう一度' })).toHaveLength(1)
    expect(staleNotices()).toHaveLength(0)
    expect(desktop().queryByRole('button', { name: '読み直す' })).toBeNull()
  })

  it('本文が同じ 1 行を出している画面では、左メニューは 2 つ目を出さない', async () => {
    fixture.pathname = '/'
    const view = render(<><Sidebar /><main><StaleStyleNotice onRetry={fixture.reload} /></main></>)
    await waitFor(() => expect(desktop().getAllByRole('link').length).toBeGreaterThan(0))
    expect(staleNotices()).toHaveLength(1)
    expect(staleNotices()[0]!.closest('main')).not.toBeNull()
    // 本文の 1 行が消えたら（別の画面へ）、左メニューが出す。
    view.rerender(<><Sidebar /><main /></>)
    await waitFor(() => expect(staleNotices()).toHaveLength(1))
    expect(staleNotices()[0]!.closest('main')).toBeNull()
  })

  it('機能設定の失敗は別の案内として残し、stale の 1 行は 1 つだけ', async () => {
    fixture.visibilityFails = true
    render(<Sidebar />)
    await waitFor(() => expect(desktop().getByText('機能設定を読み込めませんでした。')).toBeTruthy())
    expect(staleNotices()).toHaveLength(1)
    expect(desktop().getAllByRole('button', { name: '読み直す' })).toHaveLength(1)
  })

  it('A が stale のまま B へ切り替えると、A の 1 行を出さない', async () => {
    const view = render(<Sidebar />)
    await waitFor(() => expect(staleNotices()).toHaveLength(1))
    fixture.accountId = 'account-b'
    view.rerender(<Sidebar />)
    await waitFor(() => expect(staleNotices()).toHaveLength(0))
  })
})
