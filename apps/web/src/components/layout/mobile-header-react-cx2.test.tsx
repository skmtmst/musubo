// @vitest-environment happy-dom
import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
import type { AccountStyle, StaffMember } from '@line-crm/shared'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MENU_SECTIONS } from '@/lib/menu'

const fixture = vi.hoisted(() => ({
  chromeTitle: null as string | null,
  visibility: vi.fn(),
  get: vi.fn(),
  unansweredCount: vi.fn(),
  accountId: 'account-1',
  pathname: '/',
  style: 'restaurant' as AccountStyle,
}))

const localStorageValues = new Map<string, string>()
const testLocalStorage = {
  getItem: (key: string) => localStorageValues.get(key) ?? null,
  setItem: (key: string, value: string) => { localStorageValues.set(key, String(value)) },
  removeItem: (key: string) => { localStorageValues.delete(key) },
  clear: () => { localStorageValues.clear() },
}
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: testLocalStorage })
Object.defineProperty(window, 'localStorage', { configurable: true, value: testLocalStorage })

vi.mock('next/navigation', () => ({ usePathname: () => fixture.pathname }))
vi.mock('next/link', async () => {
  const React = await import('react')
  return { default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => React.createElement('a', { href, ...props }, children) }
})
vi.mock('@/components/shell/page-chrome', async original => ({ ...await original<typeof import('@/components/shell/page-chrome')>(), usePageChrome: () => ({ title: fixture.chromeTitle }) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fixture.accountId }) }))
vi.mock('@/lib/use-brand', () => ({ useBrand: () => ({ name: '会社', iconUrl: null }) }))
vi.mock('@/components/layout/sidebar-identity', () => ({ default: () => <div>identity</div> }))
vi.mock('@/components/layout/sidebar-version', () => ({ default: () => <div>version</div> }))
vi.mock('@/components/hq/account-menu', () => ({ default: () => <div>hq</div>, SidebarAccountMenu: ({ hq }: { hq: boolean }) => <div data-testid="sidebar-account">{hq ? 'me-hq' : 'me-store'}</div> }))
vi.mock('@/lib/api', () => ({
  api: {
    featureSettings: {
      visibility: fixture.visibility,
      get: fixture.get,
    },
    inbox: { unanswered: { count: fixture.unansweredCount } },
    nenMembers: { overview: vi.fn(async () => ({ success: true, data: { pendingPhotos: 0 } })) },
    health: { summary: vi.fn(async () => ({ success: true, data: { warningCount: 0, dangerCount: 0 } })) },
  },
}))

vi.mock('@/hooks/use-account-style', () => ({ useAccountStyle: () => ({ data: { style: fixture.style }, status: 'ready', error: null, reload: vi.fn() }) }))
import Sidebar, { clearSidebarCountCache } from './sidebar'
import { clearFeatureVisibilityCache } from '@/lib/feature-visibility-cache'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 全部の任意機能を on にした応答（組の出方だけを見るため）。 */
const ALL_FEATURES_ON: Record<string, boolean> = Object.fromEntries(
  MENU_SECTIONS.flatMap((section) => section.items)
    .map((item) => item.featureKey)
    .filter((key): key is string => Boolean(key))
    .map((key) => [key, true]),
)
ALL_FEATURES_ON.specialized_ec_commerce = true

/** : 設定は下の歯車から開く。定義は設定内のナビゲーションに残す。 */

async function renderSidebar(props: { friendAttributesV2Mode?: boolean } = {}) {
  const view = render(<Sidebar {...props} />)
  await waitFor(() => expect(fixture.visibility).toHaveBeenCalled())
  await act(async () => { await Promise.resolve() })
  return view
}

beforeEach(() => {
  forgetStaffIdentity()
  clearFeatureVisibilityCache()
  clearSidebarCountCache()
  fixture.pathname = '/'
  fixture.chromeTitle = null
  fixture.visibility.mockResolvedValue({ success: true, data: { features: ALL_FEATURES_ON } })
  fixture.get.mockResolvedValue({ success: true, data: { features: ALL_FEATURES_ON, sidebarOrder: null, sidebarItemOrder: null, specializedFeatureKeys: [] } })
  fixture.unansweredCount.mockResolvedValue({ success: true, data: { total: 0, byAccount: [] } })
  window.localStorage.clear()
  window.localStorage.setItem('lh_staff_role', 'owner')
  rememberStaffIdentity({ role: 'owner' } as StaffMember)
})
afterEach(() => { cleanup(); delete document.documentElement.dataset.theme })
it('画面から渡された現在地をスマホの見出しと全文表示に使う', async () => {
  fixture.chromeTitle = '夏の新しい商品のお知らせ'
  await renderSidebar()
  const title = screen.getByRole('heading', { level: 1, name: '夏の新しい商品のお知らせ' })
  expect(title.getAttribute('title')).toBe('夏の新しい商品のお知らせ')
})
it('画面からの題名が無ければ経路に合う既定の題を表示する', async () => {
  await renderSidebar()
  const title = screen.getByRole('heading', { level: 1, name: 'ダッシュボード' })
  expect(title.getAttribute('title')).toBe('ダッシュボード')
})
