// @vitest-environment happy-dom
/*
 * 外枠（app-shell）が、ふつうの画面の本文を統括の境界・閲覧権限・着地点・店舗の選択・機能の停止の5つの門で包み、
 * 共通トップバーを出すこと。統括へ戻る口は左下の自分のメニューが持つ（sidebar-account-menu-react が押して見る）。
 */
import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ pathname: '/friends' }))
vi.mock('next/navigation', () => ({ usePathname: () => fixture.pathname, useRouter: () => ({ push: vi.fn() }) }))
const { gate } = await vi.hoisted(async () => {
  const { createElement } = await import('react')
  return { gate: (name: string) => ({ default: ({ children }: { children: React.ReactNode }) => createElement('div', { 'data-gate': name }, children) }) }
})
vi.mock('./auth-guard', () => ({ ...gate('auth'), useOnboardingAccess: () => false }))
vi.mock('./hq-access-gate', () => gate('hq-access'))
vi.mock('./view-permission-gate', () => gate('view-permission'))
vi.mock('./root-landing-gate', () => gate('root-landing'))
vi.mock('./store-selection-gate', () => gate('store-selection'))
vi.mock('./feature-disabled-gate', () => gate('feature-disabled'))
vi.mock('@/contexts/account-context', () => ({ AccountProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('./shell/app-top-bar', () => ({ default: () => <header data-top-bar="" /> }))
vi.mock('./layout/sidebar', () => ({ default: () => <nav data-sidebar="" /> }))
vi.mock('./session-lost-notice', () => ({ default: () => null }))
vi.mock('./ops/impersonation-notice', () => ({ default: () => null }))
vi.mock('./unfamiliar-login-notice', () => ({ default: () => null }))
vi.mock('./shared/command-palette', () => ({ default: () => null }))
vi.mock('./shared/hover-prefetch', () => ({ default: () => null }))
vi.mock('./shared/row-entrance-settle', () => ({ default: () => null }))
vi.mock('./hq/platform-notices', () => ({ default: () => null }))
vi.mock('./ops/ops-shell', () => ({ default: ({ children }: { children: React.ReactNode }) => <div data-ops-shell="">{children}</div> }))

import AppShell from './app-shell'

afterEach(() => { cleanup(); fixture.pathname = '/friends' })

const chain = (page: Element) => {
  const names: string[] = []
  for (let node = page.parentElement; node; node = node.parentElement) {
    const name = node.getAttribute('data-gate')
    if (name) names.push(name)
  }
  return names
}

describe('外枠の門', () => {
  it.each(['/friends', '/hq'])('%s の本文は統括の境界→閲覧権限→着地点→店舗の選択→機能の停止の順に包まれ、上の帯と左メニューが出る', (pathname) => {
    fixture.pathname = pathname
    const view = render(<AppShell><p data-page="">本文</p></AppShell>)
    const page = view.container.querySelector('[data-page]')!
    expect(chain(page)).toEqual(['feature-disabled', 'store-selection', 'root-landing', 'view-permission', 'hq-access', 'auth'])
    expect(view.container.querySelector('[data-top-bar]')).not.toBeNull()
    expect(view.container.querySelector('[data-sidebar]')).not.toBeNull()
  })

  it.each(['/hq/onboarding/pricing', '/hq/onboarding/card', '/hq/onboarding/quotes'])('%s では接続前の左メニューを表示しない', (pathname) => {
    fixture.pathname = pathname
    const view = render(<AppShell><p data-page="">本文</p></AppShell>)
    expect(view.container.querySelector('[data-sidebar]')).toBeNull()
    expect(view.container.querySelector('img[alt="musubo"]')).not.toBeNull()
    expect(view.container.querySelector('[data-top-bar]')).not.toBeNull()
    expect(chain(view.container.querySelector('[data-page]')!)).toEqual(['feature-disabled', 'store-selection', 'root-landing', 'view-permission', 'hq-access', 'auth'])
  })
})
