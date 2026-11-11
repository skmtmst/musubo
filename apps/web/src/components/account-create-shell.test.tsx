import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import AppShell from './app-shell'

/*
 * LINEアカウントを登録（/accounts/new）の外枠の見張り。
 * 管理画面：外枠の無い専用の全画面（左メニュー・上の帯を出さない）。
 * ★V8（絵 〜・2026-10-07 司令塔）：ほかの画面と同じ外枠（左メニュー・上の帯）で出し、
 * 設定の中のメニューは付けない。どちらも認証と全 gate は保つ。
 */
const route = vi.hoisted(() => ({ pathname: '/accounts/new', theme: 'v7' as 'v7' | 'v8' }))
vi.mock('next/navigation', () => ({
  usePathname: () => route.pathname,
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
}))
vi.mock('./layout/sidebar', () => ({ default: () => <aside data-test="sidebar" /> }))
vi.mock('./layout/settings-inner-nav', () => ({
  default: () => <nav data-test="settings-nav" />,
  isSettingsAreaPath: (pathname: string) => pathname === '/accounts' || pathname.startsWith('/accounts/'),
}))
vi.mock('./shell/app-top-bar', () => ({ default: () => <header data-test="topbar" /> }))
vi.mock('./update/update-banner', () => ({ UpdateBanner: () => null }))
vi.mock('./session-lost-notice', () => ({ default: () => <div data-test="session" /> }))
vi.mock('./auth-guard', () => ({ default: ({ children }: { children: ReactNode }) => <div data-test="auth">{children}</div>, useOnboardingAccess: () => false }))
vi.mock('@/contexts/account-context', () => ({ AccountProvider: ({ children }: { children: ReactNode }) => <div data-test="account">{children}</div> }))
vi.mock('./hq-access-gate', () => ({ default: ({ children }: { children: ReactNode }) => <div data-test="hq-access">{children}</div> }))
vi.mock('./view-permission-gate', () => ({ default: ({ children }: { children: ReactNode }) => <div data-test="permission">{children}</div> }))
vi.mock('./root-landing-gate', () => ({ default: ({ children }: { children: ReactNode }) => <div data-test="root">{children}</div> }))
vi.mock('./store-selection-gate', () => ({ default: ({ children }: { children: ReactNode }) => <div data-test="store">{children}</div> }))
vi.mock('./feature-disabled-gate', () => ({ default: ({ children }: { children: ReactNode }) => <div data-test="feature">{children}</div> }))

const render = (pathname: string, theme: 'v7' | 'v8') => {
  route.pathname = pathname
  route.theme = theme
  return renderToStaticMarkup(<AppShell><p>登録内容</p></AppShell>)
}

describe('登録の画面枠', () => {
  it.each([
    ['/accounts/new', 'v7'], ['/accounts/new', 'v8'], ['/accounts', 'v7'], ['/accounts', 'v8'], ['/hq', 'v8'], ['/accounts/new-other', 'v7'],
  ] as const)('認証と全gateを保持: %s（%s）', (pathname, theme) => {
    const html = render(pathname, theme)
    expect(html).toContain('<div data-test="auth"><div data-test="account">')
    expect(html).toContain('<div data-test="hq-access"><div data-test="permission"><div data-test="root"><div data-test="store"><div data-test="feature"><p>登録内容</p>')
    expect(html).toContain('data-test="session"')
  })

  it('旧テーマ指定でも /accounts/new は現在の外枠だけを出す', () => {
    const html = render('/accounts/new', 'v7')
    expect(html).not.toContain('data-account-create-shell')
    expect(html).toContain('data-test="sidebar"')
    expect(html).toContain('data-test="topbar"')
    expect(html).not.toContain('data-test="settings-nav"')
  })

  it('★V8 の /accounts/new はほかの画面と同じ外枠（左メニュー・上の帯）で、設定の中のメニューは付けない', () => {
    const html = render('/accounts/new', 'v8')
    expect(html).not.toContain('data-account-create-shell')
    expect(html).toContain('data-test="sidebar"')
    expect(html).toContain('data-test="topbar"')
    expect(html).not.toContain('data-test="settings-nav"')
  })

  it('ほかの住所の外枠は変えない（設定の住所には設定の中のメニュー）', () => {
    for (const theme of ['v7', 'v8'] as const) {
      const html = render('/accounts/new-other', theme)
      expect(html).toContain('data-test="sidebar"')
      expect(html).toContain('data-test="topbar"')
    }
    expect(render('/accounts', 'v8')).toContain('data-test="settings-nav"')
  })
})
