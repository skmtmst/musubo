// @vitest-environment happy-dom
import React from 'react'
import { readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { StaffMember } from '@/lib/api'
import { forgetStaffIdentity, rememberStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot } from '@/lib/session-snapshot'
import { HQ_MENU_SECTIONS, MENU_SECTIONS } from '@/lib/menu'
import { SCOPE_ITEMS } from '@line-crm/shared'
import { PERMISSION_LABELS } from '@/v8/settings/staff/permission-labels'
import routes from '@/test-utils/view-permission-route-cases.json'
import unlistedRoutes from '@/test-utils/view-permission-unlisted-cases.json'

const nav = vi.hoisted(() => ({ path: '/', me: vi.fn() }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(), usePathname: () => nav.path, useSearchParams: () => new URLSearchParams() }))
vi.mock('@/lib/api', () => ({ api: { staff: { me: nav.me } } }))
const { pass } = await vi.hoisted(async () => {
  const { createElement } = await import('react')
  return { pass: (name: string) => ({ default: ({ children }: { children: React.ReactNode }) => createElement('div', { 'data-delegated': name }, children) }) }
})
vi.mock('./auth-guard', () => ({ ...pass('session'), useOnboardingAccess: () => false }))
vi.mock('./root-landing-gate', () => pass('landing'))
vi.mock('./store-selection-gate', () => pass('store'))
vi.mock('./feature-disabled-gate', () => pass('feature'))
vi.mock('./ops/ops-shell', () => pass('ops-shell'))
vi.mock('./mobile/mobile-shell', () => pass('mobile-shell'))
vi.mock('@/contexts/account-context', () => ({ AccountProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('./shell/app-top-bar', () => ({ default: () => null }))
vi.mock('./layout/sidebar', () => ({ default: () => null }))
vi.mock('./layout/settings-inner-nav', () => ({ default: () => null, isSettingsAreaPath: () => false }))
vi.mock('./session-lost-notice', () => ({ default: () => null }))
vi.mock('./ops/impersonation-notice', () => ({ default: () => null }))
vi.mock('./unfamiliar-login-notice', () => ({ default: () => null }))
vi.mock('./shared/command-palette', () => ({ default: () => null }))
vi.mock('./shared/hover-prefetch', () => ({ default: () => null }))
vi.mock('./shared/row-entrance-settle', () => ({ default: () => null }))
vi.mock('./hq/platform-notices', () => ({ default: () => null }))
import AppShell from './app-shell'
import { menuItemForPath } from './view-permission-gate'

afterEach(() => { cleanup(); forgetStaffIdentity(); forgetSessionSnapshot(); localStorage.clear() })

it('画面の入口を漏らさず、権限表の期待へ登録している', () => {
  const root = resolve(process.cwd(), 'src/app')
  const actual: string[] = []
  function walk(dir: string) {
    for (const file of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, file.name)
      if (file.isDirectory()) walk(path)
      else if (/^page\.(tsx?|jsx?)$/.test(file.name)) actual.push('/' + relative(root, dir).split('/').filter(part => part && !part.startsWith('(') && !part.startsWith('@')).join('/'))
    }
  }
  walk(root)
  expect(actual.sort()).toEqual(routes.map(row => row.route).sort())
  expect(new Set(actual).size).toBe(routes.length)
})

const keys = [...new Set([...MENU_SECTIONS, ...HQ_MENU_SECTIONS].flatMap(section => section.items.map(item => item.permissionKey ?? item.href)))]
const actors = ['staff-none', 'staff-view', 'staff-edit', 'viewer-staff', 'viewer-owner', 'owner', 'admin'] as const
const cases = routes.flatMap(row => actors.map(actor => ({ ...row, actor })))

it.each(cases)('$actor が $route を開くと明示した許可・拒否になる', ({ route, boundary, expected, actor }) => {
  nav.path = route
  nav.me.mockResolvedValue({ success: false, error: 'unavailable' })
  const role = actor === 'owner' || actor === 'viewer-owner' ? 'owner' : actor === 'admin' ? 'admin' : 'staff'
  const identity = { role, accountScope: 'all', readOnly: actor.startsWith('viewer-'), permissionKeys: actor === 'staff-edit' ? keys : [], permissionViewKeys: actor === 'staff-none' ? [] : keys } as StaffMember
  rememberStaffIdentity(identity)
  const mounted = vi.fn()
  function Probe() { React.useEffect(mounted, []); return <p>門の内側</p> }
  const view = render(<AppShell><Probe /></AppShell>)
  if (expected[actor]) {
    expect(screen.getByText('門の内側')).toBeTruthy()
    expect(mounted).toHaveBeenCalledTimes(1)
  } else {
    expect(screen.queryByText('門の内側')).toBeNull()
    expect(mounted).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-target-missing="forbidden"]')).not.toBeNull()
  }
  // 専用の外枠は今回の門を通らない。そちらの最終的な認可を許可したという意味ではない。
  if (boundary === 'ops-shell' || boundary === 'mobile-shell') expect(view.container.querySelector(`[data-delegated="${boundary}"]`)).not.toBeNull()
})

// 全入口の「全部・無し」と別に、非メニュー口のキーの対応を1本ずつ見張る。
const singleKeys = [...new Set([...SCOPE_ITEMS.flatMap(item => item.keys), ...Object.keys(PERMISSION_LABELS), ...keys, 'unknown.permission'])]
it('メニューに所属しない入口を鍵1本の対照へ漏らさず登録している', () => {
  const unlisted = routes.filter(row => row.boundary === null && menuItemForPath(row.route) === null)
  expect(unlisted.map(row => row.route).sort()).toEqual(unlistedRoutes.map(row => row.route).sort())
  expect(new Set(unlistedRoutes.map(row => row.route)).size).toBe(unlistedRoutes.length)
})
it('メニューから消えた付与可能キーも対照に含む', () => {
  expect(singleKeys).toContain('/health')
  expect(singleKeys).toContain('/line-notifications')
  expect(singleKeys).toContain('access.user.view')
})
const keyCases = unlistedRoutes.flatMap(row => singleKeys.flatMap(key => (['view', 'edit', 'read-only'] as const).map(mode => ({ ...row, key, mode }))))
it.each(keyCases)('$route は $mode の鍵 $key だけを持つ担当者へ明示どおり判定する', ({ route, policy, requiredKey, key, mode }) => {
  nav.path = route
  nav.me.mockResolvedValue({ success: false, error: 'unavailable' })
  rememberStaffIdentity({ role: 'staff', accountScope: 'all', readOnly: mode === 'read-only', permissionKeys: mode === 'edit' ? [key] : [], permissionViewKeys: mode === 'edit' ? [] : [key] } as StaffMember)
  const creating = /\/(?:new|create)(?:\/|$)/.test(route)
  const granted = policy === 'self' || policy === 'redirect' || (policy === 'key' && key === requiredKey && (!creating || mode === 'edit'))
  const expected = granted && !(creating && mode === 'read-only')
  const mounted = vi.fn()
  function Probe() { React.useEffect(mounted, []); return <p>鍵を1本だけ持つ担当者の中身</p> }
  const view = render(<AppShell><Probe /></AppShell>)
  if (expected) {
    expect(screen.getByText('鍵を1本だけ持つ担当者の中身')).toBeTruthy()
    expect(mounted).toHaveBeenCalledTimes(1)
  } else {
    expect(screen.queryByText('鍵を1本だけ持つ担当者の中身')).toBeNull()
    expect(mounted).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-target-missing="forbidden"]')).not.toBeNull()
  }
})
