// @vitest-environment happy-dom
/*
 * 監査 WEB203：ログインユーザーが200人より多いとき、続きを読み込める。
 */
import React from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

const net = vi.hoisted(() => ({ users: vi.fn() }))
const route = vi.hoisted(() => ({ query: '' }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(route.query),
  usePathname: () => '/staff',
}))
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'acc', loading: false }) }))
vi.mock('@/components/shell/page-chrome', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/shell/page-chrome')>()
  return { ...actual, usePageTitle: () => undefined, usePageCrumbs: () => undefined }
})
const user = vi.hoisted(() => (i: number) => ({
  id: `u${i}`, name: `利用者${i}`, email: null, jobTitle: null, roleBundle: 'staff', featureCount: null, hasFieldMasks: null,
  accountScope: { type: 'all', assignedLineAccountId: null, lineAccountIds: [], includesDescendants: false },
  lastLoginAt: null, lastActionAt: null, mfaEnabled: false, status: 'active', policyVersion: 1, createdAt: '', updatedAt: '',
}))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      staff: { ...actual.api.staff, list: async () => ({ success: true, data: [] }), me: async () => ({ success: true, data: { id: 'me', role: 'owner', name: '自分' } }) },
      lineAccounts: { ...actual.api.lineAccounts, list: async () => ({ success: true, data: [] }) },
      access: {
        ...actual.api.access,
        users: (...args: unknown[]) => net.users(...args),
        roles: async () => ({ success: true, data: { items: [] } }),
      },
    },
  }
})

import StaffV8 from './staff'
afterEach(() => { cleanup(); vi.unstubAllGlobals(); route.query = '' })

test.each([false, true])('招待中が0件のとき未読込の有無 %s を区別する', async partial => {
  net.users.mockResolvedValue({ success: true, data: {
    items: [user(1)], pagination: { total: partial ? 2 : 1, limit: 200, offset: 0 },
    summary: { active: 1, suspended: 0, mfaEnabled: 0, invited: 0 },
  } })
  route.query = 'tab=invited'
  render(<StaffV8 />)
  expect(await screen.findByText(partial ? '読み込んだユーザーに招待中の人はいません。続きを読み込んで確認してください。' : '招待中のユーザーはいません。')).toBeTruthy()
  expect(screen.queryByText('条件に合うログインユーザーはいません。条件を変えてお試しください。')).toBeNull()
})

test('全員より少ないときは「続きを読み込む」で残りを足す', async () => {
  net.users.mockImplementation(async (params: { offset?: number }) => {
    const offset = params.offset ?? 0
    const count = offset === 0 ? 200 : 50
    return {
      success: true,
      data: {
        items: Array.from({ length: count }, (_, i) => user(offset + i)),
        pagination: { total: 250, limit: 200, offset },
        summary: { active: 250, suspended: 0, mfaEnabled: 0, invited: 0 },
      },
    }
  })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
  render(<StaffV8 />)
  const more = await screen.findByRole('button', { name: '続きを読み込む' })
  await act(async () => { more.click() })
  await waitFor(() => expect(net.users).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 200 })))
  await waitFor(() => expect(screen.queryByRole('button', { name: '続きを読み込む' })).toBeNull())
})

test('読み込んだ人数が全員より少ないときは、黙って切らず人数を注記する', async () => {
  net.users.mockResolvedValue({ success: true, data: {
    items: Array.from({ length: 200 }, (_, i) => user(i)),
    pagination: { total: 1250, limit: 200, offset: 0 },
    summary: { active: 1250, suspended: 0, mfaEnabled: 0, invited: 0 },
  } })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
  render(<StaffV8 />)
  await screen.findByRole('button', { name: '続きを読み込む' })
  await waitFor(() => expect(document.body.textContent).toContain('（全1,250 人中200 人まで読み込み）'))
})

test('役割の区別を共通札へ渡し、名前と権限の読み取りを保つ', async () => {
  const roles = ['administrator', 'operations', 'reception', 'view_only', 'custom']
  net.users.mockResolvedValue({ success: true, data: {
    items: roles.map((roleBundle, index) => ({ ...user(index), roleBundle, lastLoginAt: index === 0 ? '2026-09-01T16:30:00.000Z' : null })),
    pagination: { total: roles.length, limit: 200, offset: 0 },
    summary: { active: roles.length, suspended: 0, mfaEnabled: 0, invited: 0 },
  } })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
  render(<StaffV8 />)
  const table = await screen.findByRole('table', { name: 'ユーザーの一覧' })
  expect(screen.getByRole('columnheader', { name: 'ユーザー情報' })).toBeTruthy()
  expect(screen.getByRole('columnheader', { name: '権限' })).toBeTruthy()
  expect(screen.getByRole('columnheader', { name: '最終ログイン' })).toBeTruthy()
  expect(table.textContent).toMatch(/\d{2}\/\d{2}/)
  expect(table.textContent).not.toContain('いま')
  const dated = [...table.querySelectorAll('[role="cell"]')].find(cell => cell.textContent === '09/02')
  expect(dated).toBeTruthy()
  expect(dated?.getAttribute('title')).toBe('9月2日 01:30')
  expect(table.textContent).not.toContain('最後の操作：')
  await waitFor(() => expect(table.querySelectorAll('[data-role]')).toHaveLength(5))
  const badges = [...table.querySelectorAll('[data-role]')].map(badge => [badge.getAttribute('data-role'), badge.getAttribute('data-tone'), badge.textContent])
  expect(badges).toEqual([
    ['administrator', 'success', '管理者'], ['operations', 'info', '運用'],
    ['reception', 'warning', '受付'], ['view_only', 'neutral', '見るだけ'],
    ['custom', 'neutral', '個別設定'],
  ])
})

test('役割と権限では名前と役割を分けて一度ずつ表示し、ユーザー表と操作を残す', async () => {
  route.query = 'tab=roles'
  net.users.mockResolvedValue({ success: true, data: {
    items: [{ ...user(1), name: '架空 花子', roleBundle: 'administrator' }],
    pagination: { total: 1, limit: 200, offset: 0 },
    summary: { active: 1, suspended: 0, mfaEnabled: 0, invited: 0 },
  } })
  render(<StaffV8 />)
  const table = await screen.findByRole('table', { name: '役割と権限の一覧' })
  const row = [...table.querySelectorAll('[role="row"]')].find(node => node.textContent?.includes('架空 花子'))!
  expect(row.textContent?.match(/架空 花子/g)).toHaveLength(1)
  expect(row.textContent?.match(/管理者/g)).toHaveLength(1)
  expect(row.querySelector('button[aria-label="架空 花子の操作"]')).toBeTruthy()
})

test('ユーザーの検索・状態・招待は共通の1行にまとめる', async () => {
  net.users.mockResolvedValue({ success: true, data: { items: [user(1)], pagination: { total: 1, limit: 200, offset: 0 }, summary: { active: 1, suspended: 0, mfaEnabled: 0, invited: 0 } } })
  const { container } = render(<StaffV8 />)
  await screen.findByRole('table', { name: 'ユーザーの一覧' })
  const toolbar = container.querySelector('[data-toolbar-single-row]')!
  expect(toolbar).toBeTruthy()
  expect(toolbar.contains(screen.getByRole('searchbox', { name: '名前・メールで探す' }))).toBe(true)
  expect(toolbar.contains(screen.getByRole('group', { name: '利用状態で絞り込む' }))).toBe(true)
  expect(toolbar.contains(screen.getByRole('link', { name: /招待する/ }))).toBe(true)
})


test('未設定の有効ユーザーに知らせと札を出す', async () => {
  net.users.mockResolvedValue({ success: true, data: {
    items: [user(1), { ...user(2), mfaEnabled: true }, { ...user(3), status: 'suspended' }],
    pagination: { total: 3, limit: 200, offset: 0 },
    summary: { active: 2, suspended: 1, mfaEnabled: 1, invited: 0 },
  } })
  render(<StaffV8 />)
  const table = await screen.findByRole('table', { name: 'ユーザーの一覧' })
  const notice = await screen.findByText(/二段階認証が未設定の人が 1人/)
  expect(notice.textContent).toContain('要確認')
  expect(notice.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  const row = within(table).getByRole('button', { name: '利用者1の中身を見る' }).closest('[role="row"]')!
  expect(within(row as HTMLElement).getByText('二段階認証なし')).toBeTruthy()
  const enabled = within(table).getByRole('button', { name: '利用者2の中身を見る' }).closest('[role="row"]')!
  expect(within(enabled as HTMLElement).queryByText('二段階認証なし')).toBeNull()
})
