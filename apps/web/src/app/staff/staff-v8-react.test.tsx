// @vitest-environment happy-dom
/*
 * ログインユーザー V8（板 ・）。
 * V8 では見出し・タブ・板IDを出し、権限なしでは閲覧のみの帯を出す。
 * 役割でできることの欄を出し、テーマ指定なしでもV8に固定する。
 */
import '@/test-utils/staff-location-reset'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import StaffPage from './page'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const net = vi.hoisted(() => ({ role: 'owner' as string, populated: false }))
vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  const summary = {
    active: 1, invited: 0, expiredInvitations: 0, unused90Days: 0,
    mfaEnabled: 1, mfaRate: 100,
    roleCounts: { administrator: 1, operations: 0, reception: 0, view_only: 0, custom: 0 },
  }
  return {
    ...actual,
    api: {
      ...actual.api,
      staff: {
        ...actual.api.staff,
        list: async () => ({ success: true, data: [] }),
        me: async () => ({
          success: true,
          data: { id: 'me', name: '自分', email: 'me@example.com', role: net.role, permissionKeys: [], policyVersion: 1 },
        }),
      },
      lineAccounts: { ...actual.api.lineAccounts, list: async () => ({ success: true, data: [] }) },
      access: {
        ...actual.api.access,
        users: async () => ({ success: true, data: { items: net.populated ? ['administrator', 'operations', 'reception', 'view_only'].map((roleBundle) => ({ id: roleBundle, name: roleBundle, roleBundle, email: `${roleBundle}@***.jp`, status: 'active', accountScope: { type: 'all' }, mfaEnabled: true, lastLoginAt: null })) : [], summary, pagination: { total: net.populated ? 4 : 0 } } }),
        roles: async () => ({ success: true, data: { items: [] } }),
      },
    },
  }
})
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', loading: false }),
}))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  useSearchParams: () => ({ get: () => null }),
  usePathname: () => '/staff',
}))
// ★V8 の画面（src/v8/settings/staff）は設定の中のメニューを板の中に置く。メニューは手元の保存値を読むので、ここでは置き物にする。
vi.mock('@/components/layout/settings-inner-nav', () => ({ default: () => <nav aria-label="設定の中のメニュー" /> }))
vi.mock('next/link', () => ({ default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a> }))

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  net.role = 'owner'; net.populated = false
  document.documentElement.dataset.theme = 'v8'
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); delete document.documentElement.dataset.theme })

async function render() {
  await act(async () => { root.render(<StaffPage />) })
  for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve() })
}

describe('ログインユーザーV8（nku0f・A35Gh）', () => {
  it('管理者はnku0f・本人の二段階認証を出す', async () => {
    await render()
    expect(host.querySelector('[data-design-node~="nku0f"]')).not.toBeNull()
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-template-region=heading] button[aria-expanded]')!.click() })
    expect(host.textContent).toContain('管理画面に入る人と、その人ができることを決めます')
    expect(host.textContent).not.toContain('役割でできること')
    expect(host.querySelector('[aria-label="自分の設定"]')).not.toBeNull()
    expect(host.textContent).toContain('二段階認証')
    expect(host.textContent).not.toContain('閲覧のみで見ています')
  })

  it('権限なしはA35Gh・閲覧のみの帯を出す', async () => {
    net.role = 'viewer'
    await render()
    expect(host.querySelector('[data-design-node~="A35Gh"]')).not.toBeNull()
    expect(host.textContent).toContain('閲覧のみで見ています')
  })

  it('閲覧の表でも役割ごとの色札を出し、役割と日時の意味順を保つ', async () => {
    net.role = 'viewer'; net.populated = true
    await render()
    const table = host.querySelector('[role="table"][aria-label="ユーザーの一覧"]')!
    expect(table).not.toBeNull()
    for (const [role, tone] of [['administrator', 'success'], ['operations', 'info'], ['reception', 'warning'], ['view_only', 'neutral']]) {
      expect(table.querySelector(`[data-role="${role}"]`)?.getAttribute('data-tone')).toBe(tone)
    }
    const heads = [...table.querySelectorAll('[role="columnheader"]')].map(cell => cell.textContent)
    expect(heads.indexOf('権限')).toBeLessThan(heads.indexOf('最終ログイン'))
  })

  it('一覧はユーザー情報・権限・最終ログインの列。行に顔とメール、表の頭に絞り込みを置かない', async () => {
    net.populated = true
    await render()
    const table = host.querySelector('[role="table"][aria-label="ユーザーの一覧"]')!
    expect(table.closest('[data-page-template="settings"]')).toBeTruthy()
    const heads = [...table.querySelectorAll('[role="columnheader"]')].map(cell => cell.textContent)
    expect(heads).not.toContain('担当のLINEアカウント')
    expect(table.textContent).toContain('operations@***.jp')
    expect(host.querySelector('[aria-label="役割で絞り込む"]')).toBeNull()
    expect(host.textContent).not.toContain('最後に入った日が新しい順')
  })

  it('テーマ指定がなくてもV8で開く', async () => {
    delete document.documentElement.dataset.theme
    await render()
    expect(host.querySelector('[data-design-node="e3jz3"]')).toBeNull()
    expect(host.querySelector('[data-design-node="nku0f"]')).not.toBeNull()
  })
})
