// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StaffMember } from '@line-crm/shared'
import { forgetStaffIdentity, rememberStaffIdentity } from '@/lib/staff-identity-state'

const fixture = vi.hoisted(() => ({ pathname: '/', version: vi.fn() }))
vi.mock('next/navigation', () => ({ usePathname: () => fixture.pathname }))
vi.mock('next/link', () => ({ default: ({ children, ...props }: React.ComponentProps<'a'>) => createElement('a', props, children) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: null, loading: false }) }))
vi.mock('@/hooks/use-account-style', () => ({ useAccountStyle: () => ({ data: { style: 'standard' }, status: 'ready' }) }))
vi.mock('@/lib/use-brand', () => ({ useBrand: () => ({ name: 'LINEアカウント', iconUrl: null }) }))
vi.mock('@/components/hq/account-menu', () => ({ SidebarAccountMenu: () => null }))
vi.mock('@/lib/admin-version-cache', () => ({ loadAdminVersionDetail: fixture.version }))
vi.mock('@/components/update/use-update-status', async (original) => ({ ...await original<typeof import('@/components/update/use-update-status')>(), useUpdateStatus: () => ({ kind: 'latest', version: '2.7.0' }) }))
vi.mock('@/lib/api/helpers/styles', () => ({ hqStyleApi: { attention: async () => ({ success: true, data: { items: [] } }) } }))

import Sidebar from './sidebar'
import SuspendedSidebar from './suspended-sidebar'
import OpsBrand from '@/v8/ops/ops-brand'

beforeEach(() => {
  window.localStorage.clear()
  window.localStorage.setItem('lh-sidebar-collapsed', '0')
  rememberStaffIdentity({ role: 'owner' } as StaffMember)
  fixture.pathname = '/'
  fixture.version.mockResolvedValue({ version: '2.7.0', git_commit: 'a1b2c3d4', released_at: '', deploy_env: 'staging' })
})
afterEach(() => { cleanup(); forgetStaffIdentity(); window.localStorage.clear() })

describe('サイドバーの共通ロゴ・設定・版', () => {
  it('旧テーマだけに隠すクラスを戻さない', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'sidebar.tsx'), 'utf8')
    expect(source).not.toContain('v7-only')
  })

  it.each([
    ['店舗', '/', '設定', '/settings/customer-look', '統括の設定'],
    ['統括', '/hq', '統括の設定', '/hq/settings', '設定'],
  ])('%sで同じ公式ロゴと版を出し、対応する設定へ進める', async (_shell, pathname, label, href, otherLabel) => {
    fixture.pathname = pathname
    const view = render(createElement(Sidebar))
    // 非表示のモバイル複製ではなく、常設のサイドバーを検証する。
    const desktop = within(view.container.querySelector('aside:not(#mobile-menu)') as HTMLElement)
    const logo = desktop.getByRole('img', { name: 'musubo' }) as HTMLImageElement
    expect(logo.getAttribute('src')).toBe('/brand/musubo-color-140-1x.png')
    expect(logo.getAttribute('srcset')).toBe('/brand/musubo-color-140-1x.png 1x, /brand/musubo-color-140-2x.png 2x, /brand/musubo-color-140-3x.png 3x')
    expect(logo.closest('[data-design-node="J33xq/V2WbXF"]')).toBeTruthy()
    expect(desktop.queryByText('Shed Products株式会社')).toBeNull()
    expect(desktop.queryByTitle('LINEアカウント')).toBeNull()
    const drawer = within(view.container.querySelector('#mobile-menu') as HTMLElement)
    expect(drawer.getAllByRole('img', { name: 'musubo' })).toHaveLength(1)
    expect((drawer.getByRole('img', { name: 'musubo' }) as HTMLImageElement).getAttribute('src')).toBe('/brand/musubo-color-140-1x.png')
    expect(desktop.getByRole('link', { name: label }).getAttribute('href')).toBe(href)
    expect(desktop.queryByRole('link', { name: otherLabel })).toBeNull()
    // 閉じた状態は版と環境の1行。詳細は共通の浮く面で開いて確かめる。
    fireEvent.click(await desktop.findByRole('button', { name: '2.7.0・検証環境' }))
    expect(await screen.findByText('Ver. 2.7.0（a1b2c3d）')).toBeTruthy()
    expect(screen.getAllByText(/検証環境/).length).toBeGreaterThan(0)
    expect(fixture.version).toHaveBeenCalled()
  })

  it.each([
    ['/', 'サンプルアカウント'],
    ['/hq', 'musubo'],
  ])('%sの見本では見出しを保ち、設定と版の取得を出さない', (pathname, heading) => {
    fixture.pathname = pathname
    const view = render(createElement<NonNullable<Parameters<typeof Sidebar>[0]>>(Sidebar, { preview: true }))
    const desktop = within(view.container.querySelector('aside:not(#mobile-menu)') as HTMLElement)
    if (heading === 'musubo') expect(desktop.getByRole('img', { name: heading })).toBeTruthy()
    else expect(desktop.getByText(heading)).toBeTruthy()
    expect(desktop.queryByRole('link', { name: /^(統括の)?設定$/ })).toBeNull()
    expect(desktop.queryByText(/Ver\./)).toBeNull()
    expect(fixture.version).not.toHaveBeenCalled()
  })

  it('利用停止中のメニューでも同じ公式ロゴを出す', () => {
    const view = render(createElement(SuspendedSidebar))
    const desktop = within(view.container.querySelector('aside') as HTMLElement)
    expect((desktop.getByRole('img', { name: 'musubo' }) as HTMLImageElement).getAttribute('src')).toBe('/brand/musubo-color-140-1x.png')
    expect(desktop.queryByText('musubo 統括コンソール')).toBeNull()
  })

  it('運営メニューでも同じ公式ロゴを出す', () => {
    const view = render(createElement(OpsBrand, { compact: true }))
    expect((within(view.container).getByRole('img', { name: 'musubo' }) as HTMLImageElement).getAttribute('src')).toBe('/brand/musubo-color-140-1x.png')
  })
})
