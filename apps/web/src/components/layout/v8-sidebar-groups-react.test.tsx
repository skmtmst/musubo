// @vitest-environment happy-dom
import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
import type { AccountStyle, StaffMember } from '@line-crm/shared'
/*
 * ★V8（夕44-A・部品 T7XSI6）：左メニューの組の開閉と「設定」の入口。
 *
 *   - メイン・配信・コンテンツ・予約は開いた形、ほかは見出しだけ
 *   - 畳んだ組は見出しだけ残る（組が丸ごと消えない）
 *   - 押すと開き、開いた状態はブラウザが覚える（lh-sidebar-groups）
 *   - いまいる画面の組は常に開く
 *   - 左メニューのいちばん下に「設定」（オーナー・管理者だけ）
 *   - 互換経路では開閉も歯車も出さず、V2 モードの組隠しも v8 では効かない
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { act, useInsertionEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MENU_SECTIONS, SCREEN_MENU_OWNER } from '@/lib/menu'
import { UNANSWERED_REFRESH_EVENT } from '@/lib/events'

const fixture = vi.hoisted(() => ({
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
import Sidebar, { clearSidebarCountCache, isHqShellPath } from './sidebar'
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
const VISIBLE_GROUP_LABELS = ['メイン', '予約・来店', '店舗運営', '配信', 'コンテンツ', '成果と分析', '自動化', '専用機能']

async function renderSidebar(props: { friendAttributesV2Mode?: boolean } = {}) {
  const view = render(<Sidebar {...props} />)
  await waitFor(() => expect(fixture.visibility).toHaveBeenCalled())
  await act(async () => { await Promise.resolve() })
  return view
}

describe('★V8 左メニューの組の開閉と「設定」の入口', () => {
  beforeEach(() => {
    forgetStaffIdentity()
    clearFeatureVisibilityCache()
    fixture.visibility.mockReset()
    fixture.get.mockReset()
    fixture.unansweredCount.mockReset()
    fixture.unansweredCount.mockResolvedValue({ success: true, data: { total: 0, byAccount: [] } })
    fixture.accountId = 'account-1'
    clearSidebarCountCache()
    fixture.pathname = '/'
    fixture.style = 'restaurant'
    fixture.visibility.mockResolvedValue({ success: true, data: { features: ALL_FEATURES_ON } })
    fixture.get.mockResolvedValue({
      success: true,
      data: { features: ALL_FEATURES_ON, sidebarOrder: null, sidebarItemOrder: null, specializedFeatureKeys: [] },
    })
    document.documentElement.dataset.theme = 'v8'
    window.localStorage.clear()
    window.localStorage.setItem('lh_staff_role', 'owner')
    rememberStaffIdentity({ role: 'owner' } as StaffMember)
    /*
     * 画面幅 1280 未満では畳んだ形で開く既定がある（テスト環境の幅は
     * happy-dom の小さい値）。組の出し分けを見るので、ここでは
     * 「広げた」に固定する。
     */
    window.localStorage.setItem('lh-sidebar-collapsed', '0')
  })

  afterEach(() => {
    cleanup()
    window.history.replaceState({}, '', '/')
    vi.unstubAllEnvs()
    delete document.documentElement.dataset.theme
  })

  it('全部の組の見出しが出る（畳んだ組も見出しだけ残る＝組が丸ごと消えない）', async () => {
    const view = await renderSidebar()
    for (const label of VISIBLE_GROUP_LABELS) {
      expect(view.getAllByRole('button', { name: label }).length, `組「${label}」の見出しが無い`).toBeGreaterThan(0)
    }
    expect(view.queryAllByRole('button', { name: '設定', exact: true })).toHaveLength(0)
  })

  it('履歴が挿入エフェクト中に変わっても、警告を出さず所属を更新する', async () => {
    fixture.pathname = '/accounts'
    window.history.replaceState({}, '', '/accounts')
    const view = await renderSidebar()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    function Navigate() {
      useInsertionEffect(() => { window.history.replaceState({}, '', '/accounts?tab=migration') }, [])
      return null
    }
    try {
      render(<Navigate />)
      await waitFor(() => expect(view.container.querySelector('aside[data-design-node="J33xq"] a[href="/friends"]')?.getAttribute('aria-current')).toBe('page'))
      expect(errors.mock.calls.flat().join(' ')).not.toContain('useInsertionEffect must not schedule updates')
    } finally {
      errors.mockRestore()
    }
  })

  it('受信箱の札は全アカウント合計でなく選択中のアカウントの要返信件数を出す', async () => {
    fixture.unansweredCount.mockResolvedValue({
      success: true,
      data: { total: 3, byAccount: [{ accountId: 'other', accountName: '他店', count: 3 }] },
    })
    const view = await renderSidebar()
    const desktop = view.container.querySelector('aside[data-design-node="J33xq"]')!
    const inbox = () => desktop.querySelector('a[href="/chats"]')!
    await waitFor(() => expect(fixture.unansweredCount).toHaveBeenCalled())
    expect(inbox().getAttribute('data-rail-count')).toBeNull()

    fixture.unansweredCount.mockResolvedValue({
      success: true,
      data: { total: 5, byAccount: [
        { accountId: 'account-1', accountName: 'THE SHED', count: 2 },
        { accountId: 'other', accountName: '他店', count: 3 },
      ] },
    })
    await act(async () => { window.dispatchEvent(new Event(UNANSWERED_REFRESH_EVENT)) })
    await waitFor(() => expect(inbox().getAttribute('data-rail-count')).toBe('2'))

    fixture.accountId = 'other'
    view.rerender(<Sidebar />)
    await waitFor(() => expect(inbox().getAttribute('data-rail-count')).toBe('3'))
  })

  it('新規店舗の空の専用目録では「専用機能」の組を出さない', async () => {
    fixture.visibility.mockResolvedValue({
      success: true,
      data: { features: {
        ...ALL_FEATURES_ON,
        nen_campaigns: false,
        photo_review: false,
        specialized_ec_commerce: false,
      } },
    })
    const view = await renderSidebar()
    await waitFor(() => expect(view.queryAllByRole('button', { name: '専用機能' })).toHaveLength(0))
    expect(view.getAllByRole('button', { name: '配信' }).length).toBeGreaterThan(0)
  })

  it('お気に入りが空なら見出しを隠し、登録すると元の組にも残す。個別オフも反映する', async () => {
    vi.stubEnv('NEXT_PUBLIC_GOOGLE_BUSINESS_ENABLED', 'true')
    fixture.visibility.mockResolvedValue({ success: true, data: {
      features: ALL_FEATURES_ON,
      favoriteItemIds: ['restaurant-reservations', 'restaurant-google'],
      restaurantHiddenItemIds: ['restaurant-tables'],
    } })
    const view = await renderSidebar()
    const desktop = view.container.querySelector('aside[data-design-node="J33xq"]')!
    const headings = [...desktop.querySelectorAll('nav button[aria-expanded]')].map((button) => button.textContent?.trim())
    expect(headings[0]).toBe('お気に入り')
    expect(headings[1]).toBe('メイン')
    expect(desktop.querySelectorAll('a[href="/restaurant-test/reservations"]')).toHaveLength(2)
    expect(desktop.querySelectorAll('a[href="/restaurant-test/google"]')).toHaveLength(2)
    expect(desktop.querySelectorAll('a[href="/restaurant-test/tables"]')).toHaveLength(0)
    expect(desktop.textContent).not.toContain('★')
  })

  it('お気に入りがない飲食店には見出しを出さない', async () => {
    const view = await renderSidebar()
    expect(view.queryAllByRole('button', { name: 'お気に入り' })).toHaveLength(0)
  })

  it('主要4組ははじめから開き、ほかの組は見出しだけ', async () => {
    const view = await renderSidebar()
    // 開く：メイン・配信・コンテンツ・予約
    expect(view.getAllByRole('link', { name: 'ダッシュボード' }).length).toBeGreaterThan(0)
    expect(view.getAllByRole('link', { name: '一斉配信' }).length).toBeGreaterThan(0)
    expect(view.getAllByRole('link', { name: 'テンプレート' }).length).toBeGreaterThan(0)
    expect(view.getAllByRole('link', { name: 'イベント予約' }).length).toBeGreaterThan(0)
    // 畳む：成果と分析・自動化・専用機能・設定
    expect(view.queryAllByRole('link', { name: '分析' })).toHaveLength(0)
    expect(view.queryAllByRole('link', { name: 'オートメーション' })).toHaveLength(0)
    expect(view.queryAllByRole('link', { name: '会員' })).toHaveLength(0)
    expect(view.queryAllByRole('link', { name: '機能設定' })).toHaveLength(0)
  })

  it('畳んだ組の見出しを押すと開き、開いた状態を覚える', async () => {
    const view = await renderSidebar()
    const toggle = view.getAllByRole('button', { name: '自動化' })[0]!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { toggle.click() })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(view.getAllByRole('link', { name: 'オートメーション' }).length).toBeGreaterThan(0)
    expect(window.localStorage.getItem('lh-sidebar-groups')).toContain('"automation":true')
  })

  it('開閉は項目を包みに残して高さで動かす。畳んだ包みは押せず読み上げない（触り心地 5 回目）', async () => {
    const view = await renderSidebar()
    const toggle = view.getAllByRole('button', { name: '自動化' })[0]!
    const box = toggle.parentElement!.querySelector('[data-group-open]')!
    expect(box.getAttribute('data-group-open')).toBe('false')
    expect(box.hasAttribute('inert')).toBe(true)
    expect(box.getAttribute('aria-hidden')).toBe('true')
    await act(async () => { toggle.click() })
    expect(box.isConnected).toBe(true)
    expect(box.getAttribute('data-group-open')).toBe('true')
    expect(box.hasAttribute('inert')).toBe(false)
    expect(box.hasAttribute('aria-hidden')).toBe(false)
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'sidebar.module.css'), 'utf8')
    // 動きは「動きを減らす」設定では付けない
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{\s*:root \.sectionItems \{\s*transition:\s*grid-template-rows var\(--motion-base\)/)
    expect(css).toMatch(/\.sectionItemsClosed \{\s*grid-template-rows: 0fr;/)
  })

  it('いまいる画面の組は、畳まれていても開いてその項目を選ばれた形にする', async () => {
    fixture.pathname = '/analytics'
    const view = await renderSidebar()
    // 成果と分析は既定で畳むが、/analytics が中にあるので開く
    expect(view.getAllByRole('link', { name: '分析' }).length).toBeGreaterThan(0)
  })

  it.each([...new Set([...MENU_SECTIONS.flatMap(section => section.items).filter(item => !item.staffOnly).map(item => item.href), ...Object.keys(SCREEN_MENU_OWNER), '/nen-members/detail'])])('%s を開くと選択が1つで、その組が開く', async (href) => {
    vi.stubEnv('NEXT_PUBLIC_RESTAURANT_TEST_ENABLED', 'true')
    vi.stubEnv('NEXT_PUBLIC_GOOGLE_BUSINESS_ENABLED', 'true')
    fixture.get.mockResolvedValue({ success: true, data: { features: ALL_FEATURES_ON, sidebarOrder: null, sidebarItemOrder: null, specializedFeatureKeys: Object.keys(ALL_FEATURES_ON) } })
    fixture.style = href.startsWith('/booking/') ? 'salon' : 'restaurant'
    fixture.pathname = href.split('?')[0]
    window.history.replaceState({}, '', href)
    window.localStorage.setItem('lh-sidebar-groups', JSON.stringify(Object.fromEntries(MENU_SECTIONS.map(section => [section.id, false]))))
    const view = await renderSidebar()
    const desktop = view.container.querySelector('aside[data-design-node="J33xq"]')!
    const selected = desktop.querySelectorAll('a[aria-current="page"]')
    expect(selected.length, href).toBe(1)
    expect(selected[0].closest('[aria-hidden="true"], [inert]')).toBeNull()
    window.history.replaceState({}, '', '/')
  })

  it('統合された成果画面への入口と設定はそれぞれ1つにまとめる', async () => {
    fixture.pathname = '/conversions'
    const view = await renderSidebar()
    const desktop = view.container.querySelector('aside[data-design-node="J33xq"]')!
    const links = [...desktop.querySelectorAll('a')]
    expect(links.filter(link => link.textContent?.trim() === '成果とアフィリエイト')).toHaveLength(1)
    expect(links.filter(link => link.textContent?.trim() === 'コンバージョン')).toHaveLength(0)
    expect(links.filter(link => link.getAttribute('href') === '/settings/customer-look')).toHaveLength(1)
    expect(links.filter(link => link.getAttribute('aria-current') === 'page')[0]?.textContent).toBe('成果とアフィリエイト')
  })

  it('いちばん下に「設定」が出るのはオーナー・管理者だけ' , async () => {
    const view = await renderSidebar()
    const gear = view.getAllByRole('link', { name: '設定' })
    expect(gear.length).toBeGreaterThan(0)
    expect(gear[0]!.getAttribute('href')).toBe('/settings/customer-look')
    cleanup()

    window.localStorage.setItem('lh_staff_role', 'staff')

    rememberStaffIdentity({ role: 'staff' } as StaffMember)
    const staffView = await renderSidebar()
    expect(staffView.queryAllByRole('link', { name: '設定' })).toHaveLength(0)
  })

  it.each(['owner', 'admin'] as const)('設定の段を外しても%sの歯車と設定内の現在地を保つ', async (role) => {
    rememberStaffIdentity({ role } as StaffMember)
    // 保存していた組の開閉も、重複した入口を復活させない。
    window.localStorage.setItem('lh-sidebar-groups', JSON.stringify({ settings: true }))
    for (const pathname of ['/settings/customer-look', '/settings', '/emergency']) {
      rememberStaffIdentity({ role } as StaffMember)
      fixture.pathname = pathname
      const view = await renderSidebar()
      expect(view.queryAllByRole('button', { name: '設定', exact: true })).toHaveLength(0)
      expect(view.queryAllByRole('link', { name: '機能設定', exact: true })).toHaveLength(0)
      const gear = view.getAllByRole('link', { name: '設定', exact: true })[0]!
      expect(gear.getAttribute('href')).toBe('/settings/customer-look')
      expect(gear.className).toMatch(/active/)
      cleanup()
    }
  })

  it('★V8 店の画面の左下に自分のメニュー（店の形）を出す（オーナー 2026-10-07）', async () => {
    const view = await renderSidebar()
    expect(view.getAllByText('me-store').length).toBeGreaterThan(0)
    expect(view.queryAllByText('me-hq')).toHaveLength(0)
  })

  it('V2 のタグモードでも、v8 では組を丸ごと隠さない', async () => {
    const view = await renderSidebar({ friendAttributesV2Mode: true })
    for (const label of ['自動化', '予約・来店']) {
      expect(view.getAllByRole('button', { name: label }).length, `組「${label}」が消えている`).toBeGreaterThan(0)
    }
    expect(view.queryAllByRole('button', { name: '設定', exact: true })).toHaveLength(0)
    expect(view.getAllByRole('link', { name: '設定', exact: true }).length).toBeGreaterThan(0)
  })

  it('旧テーマ指定でも組を開閉でき、設定と自分の入口を出す', async () => {
    document.documentElement.dataset.theme = 'v7'
    const view = await renderSidebar()
    const automation = view.getAllByRole('button', { name: '自動化' })[0]!
    expect(automation.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { automation.click() })
    expect(view.getAllByRole('link', { name: 'オートメーション' }).length).toBeGreaterThan(0)
    expect(view.queryAllByRole('button', { name: '設定', exact: true })).toHaveLength(0)
    expect(view.getAllByRole('link', { name: '設定' }).length).toBeGreaterThan(0)
    expect(view.getAllByTestId('sidebar-account').length).toBeGreaterThan(0)
  })

  it('旧テーマとV2指定でも組を丸ごと隠さない', async () => {
    document.documentElement.dataset.theme = 'v7'
    const view = await renderSidebar({ friendAttributesV2Mode: true })
    expect(view.getAllByRole('button', { name: '自動化' }).length).toBeGreaterThan(0)
    expect(view.getAllByRole('button', { name: '予約・来店' }).length).toBeGreaterThan(0)
  })
})

describe('★V8 統括の左メニュー（絵 V8-B/JKjsE・オーナー 2026-10-07）', () => {
  beforeEach(() => {
    clearFeatureVisibilityCache()
    fixture.visibility.mockReset()
    fixture.get.mockReset()
    fixture.visibility.mockResolvedValue({ success: true, data: { features: ALL_FEATURES_ON } })
    fixture.get.mockResolvedValue({ success: true, data: { features: ALL_FEATURES_ON, sidebarOrder: null, sidebarItemOrder: null, specializedFeatureKeys: [] } })
    fixture.pathname = '/hq'
    window.localStorage.clear()
    window.localStorage.setItem('lh_staff_role', 'owner')
    rememberStaffIdentity({ role: 'owner' } as StaffMember)
    window.localStorage.setItem('lh-sidebar-collapsed', '0')
  })

  afterEach(() => {
    cleanup()
    window.history.replaceState({}, '', '/')
    vi.unstubAllEnvs()
    delete document.documentElement.dataset.theme
  })

  async function renderHq() {
    const view = render(<Sidebar />)
    await act(async () => { await Promise.resolve() })
    return view
  }

  it('V8 は「統括」の組の見出し・左下の「統括の設定」と版。左下のアカウントの行は出さない', async () => {
    document.documentElement.dataset.theme = 'v8'
    const view = await renderHq()
    expect(view.getAllByRole('button', { name: '統括' }).length).toBeGreaterThan(0)
    const settings = view.getAllByRole('link', { name: '統括の設定' })
    expect(settings.length).toBeGreaterThan(0)
    expect(settings[0].getAttribute('href')).toBe('/hq/settings')
    expect(view.getAllByText('version').length).toBeGreaterThan(0)
    expect(view.getAllByText('identity').length).toBeGreaterThan(0)
    expect(view.queryAllByText('hq')).toHaveLength(0)
    // ★V8 左下の自分とメニュー（オーナー 2026-10-07）：統括でも左下に出す（統括の形で）。
    expect(view.getAllByText('me-hq').length).toBeGreaterThan(0)
    expect(view.queryAllByText('me-store')).toHaveLength(0)
  })

  it('V8 の統括の設定の中（メンバーなど）では「統括の設定」が選ばれた形、アカウントの画面では選ばれない', async () => {
    document.documentElement.dataset.theme = 'v8'
    fixture.pathname = '/hq/members'
    const members = await renderHq()
    expect(members.getAllByRole('link', { name: '統括の設定' })[0].className).toMatch(/active/)
    cleanup()
    fixture.pathname = '/hq'
    const home = await renderHq()
    expect(home.getAllByRole('link', { name: '統括の設定' })[0].className).not.toMatch(/active/)
  })

  it('旧テーマ指定でも統括の見出し・設定・版と自分の入口を出す', async () => {
    document.documentElement.dataset.theme = 'v7'
    const view = await renderHq()
    expect(view.getAllByRole('button', { name: '統括' }).length).toBeGreaterThan(0)
    expect(view.getAllByRole('link', { name: '統括の設定' }).length).toBeGreaterThan(0)
    expect(view.getAllByText('version').length).toBeGreaterThan(0)
    expect(view.queryAllByText('hq')).toHaveLength(0)
    expect(view.getAllByTestId('sidebar-account').length).toBeGreaterThan(0)
  })
})

describe('統括の左メニューを出す住所', () => {
  it('/hq の下と LINEアカウントの登録は統括、ほかの /accounts は店舗', () => {
    expect(isHqShellPath('/hq')).toBe(true)
    expect(isHqShellPath('/hq/templates')).toBe(true)
    expect(isHqShellPath('/accounts/new')).toBe(true)
    expect(isHqShellPath('/restaurant-test/stores/new')).toBe(true)
    expect(isHqShellPath('/restaurant-test/terms')).toBe(true)
    expect(isHqShellPath('/restaurant-test/stores')).toBe(false)
    expect(isHqShellPath('/accounts')).toBe(false)
    expect(isHqShellPath('/hqx')).toBe(false)
    expect(isHqShellPath(null)).toBe(false)
  })
})


describe("本番の入口", () => {
  afterEach(() => vi.unstubAllEnvs())
  it('Google の入口を残し、デリバリー受注は本番で案内表示だけにする', async () => {
    vi.stubEnv('NEXT_PUBLIC_GOOGLE_BUSINESS_ENABLED', 'true')
    vi.stubEnv('NEXT_PUBLIC_RESTAURANT_TEST_ENABLED', 'false')
    fixture.pathname = '/restaurant-test/google'
    clearFeatureVisibilityCache()
    rememberStaffIdentity({ role: 'owner' } as StaffMember)
    fixture.visibility.mockResolvedValue({ success: true, data: { features: { ...ALL_FEATURES_ON, restaurant_test: false } } })
    fixture.get.mockResolvedValue({ success: true, data: { sidebarOrder: [], sidebarItemOrder: {} } })
    const view = await renderSidebar()
    expect(view.getAllByRole('link', { name: 'Googleビジネス' })[0].getAttribute('href')).toBe('/restaurant-test/google')
    const delivery = view.getAllByRole('link', { name: /デリバリー受注/ })[0]
    expect(fireEvent.click(delivery)).toBe(false)
    expect(view.queryByRole('dialog')).toBeNull()
  })
})
