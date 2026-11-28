// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
import type { StaffMember } from '@line-crm/shared'
import { MENU_SECTIONS } from '@/lib/menu'

const fixture = vi.hoisted(() => ({ path: '/accounts', visibility: vi.fn(), get: vi.fn(), count: vi.fn() }))
vi.mock('next/navigation', () => ({ usePathname: () => fixture.path }))
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => <a href={href} {...props}>{children}</a> }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-1' }) }))
vi.mock('@/lib/use-brand', () => ({ useBrand: () => ({ name: 'お店', iconUrl: null }) }))
vi.mock('@/components/layout/sidebar-identity', () => ({ default: () => null }))
vi.mock('@/components/layout/sidebar-version', () => ({ default: () => null }))
vi.mock('@/components/hq/account-menu', () => ({ SidebarAccountMenu: () => null }))
vi.mock('@/hooks/use-account-style', () => ({ useAccountStyle: () => ({ data: { style: 'restaurant' }, status: 'ready', error: null, reload: vi.fn() }) }))
vi.mock('@/lib/api', () => ({ api: { featureSettings: { visibility: fixture.visibility, get: fixture.get }, inbox: { unanswered: { count: fixture.count } }, nenMembers: { overview: vi.fn(async () => ({ success: true, data: { pendingPhotos: 0 } })) }, health: { summary: vi.fn(async () => ({ success: true, data: { warningCount: 0, dangerCount: 0 } })) } } }))
import Sidebar, { clearSidebarCountCache } from '@/components/layout/sidebar'
import { clearFeatureVisibilityCache } from '@/lib/feature-visibility-cache'

const features = Object.fromEntries(MENU_SECTIONS.flatMap(section => section.items).map(item => item.featureKey).filter(Boolean).map(key => [key!, true]))
beforeEach(() => {
  forgetStaffIdentity()
  clearFeatureVisibilityCache()
  clearSidebarCountCache()
  fixture.path = '/accounts'
  fixture.visibility.mockReset().mockResolvedValue({ success: true, data: { features } })
  fixture.get.mockReset().mockResolvedValue({ success: true, data: { features, sidebarOrder: null, sidebarItemOrder: null, specializedFeatureKeys: [] } })
  fixture.count.mockReset().mockResolvedValue({ success: true, data: { total: 0, byAccount: [] } })
  document.documentElement.dataset.theme = 'v8'
  localStorage.clear()
  localStorage.setItem('lh-sidebar-collapsed', '0')
  rememberStaffIdentity({ role: 'owner' } as StaffMember)
})
afterEach(() => { cleanup(); window.history.replaceState({}, '', '/'); delete document.documentElement.dataset.theme })

it('UID移行では URL に属するアカウントでなく友だちのメニューを選ぶ', async () => {
  window.history.replaceState({}, '', '/accounts?tab=migration')
  const view = render(<Sidebar />)
  await waitFor(() => expect(view.container.querySelector('aside[data-design-node="J33xq"] a[href="/friends"]')?.getAttribute('aria-current')).toBe('page'))
  expect(view.container.querySelector('aside[data-design-node="J33xq"] a[href="/accounts"]')?.getAttribute('aria-current')).not.toBe('page')
})

it('通常のアカウント画面を友だちに誤って割り当てない', async () => {
  window.history.replaceState({}, '', '/accounts')
  const view = render(<Sidebar />)
  await waitFor(() => expect(fixture.visibility).toHaveBeenCalled())
  expect(view.container.querySelector('aside[data-design-node="J33xq"] a[href="/friends"]')?.getAttribute('aria-current')).not.toBe('page')
})
