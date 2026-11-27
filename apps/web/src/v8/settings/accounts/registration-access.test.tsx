// @vitest-environment happy-dom
/* 登録・接続確認はオーナーと管理者。スタッフ・閲覧のみは理由付きで入口を止め、直アクセスも拒否する。 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  role: { value: 'owner' as string | null },
  list: vi.fn(), archive: vi.fn(), restore: vi.fn(),
}))

vi.mock('@/lib/staff-role', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/staff-role')>()),
  useStaffRole: () => fixture.role.value,
}))

vi.mock('@/components/shell/page-chrome', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/shell/page-chrome')>()),
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'acc-1', selectedAccount: null, accounts: [] }),
}))

vi.mock('@/lib/use-running-version', () => ({
  useRunningVersion: () => ({ detail: { deploy_env: 'staging' }, statusText: '稼働版を確認' }),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/accounts',
  useSearchParams: () => new URLSearchParams(),
}))

// 一覧の取得だけ差し替える。スタイルの入口など他の口は本物のまま（部分差し替え）。
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, lineAccounts: { ...actual.api.lineAccounts, list: fixture.list, archive: fixture.archive, restore: fixture.restore } } }
})

vi.mock('@/lib/api/helpers/styles', () => ({ styleApi: { get: vi.fn(async () => ({ success: true, data: { style: 'standard', styleSelected: true } })) } }))

import AccountsV8 from './accounts'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot, rememberSessionSnapshot } from '@/lib/session-snapshot'

beforeEach(() => {
  vi.clearAllMocks()
  fixture.role.value = 'owner'
  fixture.list.mockResolvedValue({ success: true, data: [] })
  fixture.archive.mockResolvedValue({ success: true, data: {} })
  fixture.restore.mockResolvedValue({ success: true, data: {} })
  // スタイルの入口など本物のままの口が外へ出ていかないようにする（試験は網を使わない）。
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"success":true,"data":null}', {
    status: 200, headers: { 'content-type': 'application/json' },
  })))
})
afterEach(() => { cleanup(); forgetStaffIdentity(); forgetSessionSnapshot(); vi.unstubAllGlobals() })

const MANAGER_ONLY = 'LINEアカウントの登録はオーナーか管理者ができます'

async function open() {
  verifiedStaffRole(fixture.role.value)
  const view = render(<AccountsV8 />)
  await act(async () => {})
  return view
}

describe('一覧の登録権限', () => {
  it.each(['staff', 'viewer'])('%s には登録の入口を灰色で出し、頼む先を書く', async (role) => {
    fixture.role.value = role
    await open()
    expect(screen.queryByRole('link', { name: /LINEアカウントを登録/ })).toBeNull()
    for (const button of screen.getAllByRole('button', { name: /LINEアカウントを登録/ })) {
      expect(button.getAttribute('aria-disabled')).toBe('true')
      expect((button as HTMLButtonElement).disabled).toBe(false)
      expect(button.hasAttribute('data-permission-locked')).toBe(true)
    }
    expect(screen.getByText('送受信に使うアカウントの登録はオーナーか管理者ができます。オーナーか管理者に頼んでください。')).toBeTruthy()
  })

  it('管理者から並び順と親子は取り上げない（account.metadata.edit）', async () => {
    fixture.role.value = 'admin'
    await open()
    expect(screen.getByRole('button', { name: /並び順と親子を変更する/ })).toBeTruthy()
  })

  it.each(['staff', 'viewer'])('1件も無いときも %s には頼む先を出す', async (role) => {
    fixture.role.value = role
    await open()
    expect(screen.getByText('送受信に使うアカウントの登録はオーナーか管理者ができます。オーナーか管理者に頼んでください。')).toBeTruthy()
  })

  it.each(['owner', 'admin'])('%s は空の一覧から登録を開始できる', async (role) => {
    fixture.role.value = role
    await open()
    expect(screen.getAllByRole('link', { name: /LINEアカウントを登録/ }).length).toBe(2)
    expect(screen.queryByText(MANAGER_ONLY)).toBeNull()
  })
})


it('本人未知は理由も帯も出さず普通にdisabled、判明したviewerは帯1つと理由を出す', async () => {
  fixture.role.value = null
  const view = await open()
  expect(view.container.querySelector('[data-read-only-notice]')).toBeNull()
  expect(view.container.querySelector('[data-permission-locked]')).toBeNull()
  for (const name of [/LINEアカウントを登録/, /並び順と親子を変更する/]) {
    for (const button of screen.getAllByRole('button', { name })) {
      expect((button as HTMLButtonElement).disabled).toBe(true)
      fireEvent.click(button)
    }
  }
  expect(screen.queryByRole('dialog')).toBeNull()
  fixture.role.value = 'viewer'
  verifiedStaffRole('viewer')
  view.rerender(<AccountsV8 />)
  expect(view.container.querySelectorAll('[data-read-only-notice]')).toHaveLength(1)
  expect(view.container.querySelector('[data-read-only-notice]')?.closest('header')).toBeNull()
  const slot = view.container.querySelector('[data-read-only-notice]')?.closest('[data-template-region="notice"]')
  expect(slot?.parentElement?.getAttribute('data-template-region')).toBe('settings-flow')
  expect(slot?.parentElement?.previousElementSibling?.getAttribute('data-template-region')).toBe('heading')
  expect(screen.getAllByRole('button', { name: /LINEアカウントを登録/ })[0].getAttribute('aria-disabled')).toBe('true')
})

it('ownerの閲覧代理への切替は書込入口を止め、書込代理では元へ戻る', async () => {
  const view = await open()
  const snapshot = (mode: 'read' | 'write') => ({ impersonation: { id: 'proxy', tenantId: 'tenant', mode, piiRevealed: false, startedAt: '' }, unfamiliarAt: null, stepUpMethod: 'none' as const })
  expect(screen.getAllByRole('link', { name: /LINEアカウントを登録/ })).toHaveLength(2)
  await act(async () => { rememberSessionSnapshot(snapshot('read')) })
  expect(view.container.querySelectorAll('[data-read-only-notice]')).toHaveLength(1)
  expect(view.container.querySelector('[data-read-only-notice]')?.closest('header')).toBeNull()
  const proxySlot = view.container.querySelector('[data-read-only-notice]')?.closest('[data-template-region="notice"]')
  expect(proxySlot?.parentElement?.getAttribute('data-template-region')).toBe('settings-flow')
  expect(proxySlot?.parentElement?.previousElementSibling?.getAttribute('data-template-region')).toBe('heading')
  expect(screen.queryByRole('link', { name: /LINEアカウントを登録/ })).toBeNull()
  const order = screen.getByRole('button', { name: /並び順と親子を変更する/ })
  expect(order.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(order)
  expect(screen.queryByRole('dialog')).toBeNull()
  const style = screen.getByRole('button', { name: 'スタイルを変更する' })
  expect(style.getAttribute('aria-disabled')).toBe('true')
  expect(style.getAttribute('href')).toBeNull()
  fireEvent.click(style)
  await act(async () => { rememberSessionSnapshot(snapshot('write')) })
  expect(view.container.querySelectorAll('[data-read-only-notice]')).toHaveLength(0)
  expect(screen.getAllByRole('link', { name: /LINEアカウントを登録/ })).toHaveLength(2)
})

it('閲覧代理でも詳細と確かめ直しを残し、引き継ぎとアーカイブを止める', async () => {
  fixture.list.mockResolvedValue({ success: true, data: [{ id: 'acc-1', name: '本店', channelId: '1', isActive: true, archivedAt: null }] })
  rememberSessionSnapshot({ impersonation: { id: 'proxy', tenantId: 'tenant', mode: 'read', piiRevealed: false, startedAt: '' }, unfamiliarAt: null, stepUpMethod: 'none' })
  await open()
  fireEvent.click(screen.getByRole('button', { name: '本店の操作' }))
  const detail = screen.getByRole('menuitem', { name: '詳細' })
  expect(detail.getAttribute('href')).toBe('/accounts/detail?id=acc-1')
  for (const name of ['引き継ぎ', 'アーカイブ']) {
    const item = screen.getByRole('menuitem', { name })
    expect(item.getAttribute('aria-disabled')).toBe('true')
    expect(item.getAttribute('href')).toBeNull()
    fireEvent.click(item)
  }
  expect(screen.queryByRole('dialog')).toBeNull()
  const before = fixture.list.mock.calls.length
  fireEvent.click(screen.getByRole('menuitem', { name: '接続をもう一度確かめる' }))
  await act(async () => {})
  expect(fixture.list.mock.calls.length).toBe(before + 1)
  expect(fixture.list).toHaveBeenLastCalledWith(true)
  const writes = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([, init]) => init?.method && !['GET', 'HEAD', 'OPTIONS'].includes(init.method))
  expect(writes).toHaveLength(0)
})


it.each(['owner', 'admin'])('%sの通常アーカイブは1回、開いた窓を閲覧代理に切り替えたら保存0', async role => {
  fixture.role.value = role
  fixture.list.mockResolvedValue({ success: true, data: [{ id: 'acc-1', name: '本店', channelId: '1', isActive: false, archivedAt: null }] })
  await open()
  fireEvent.click(screen.getByRole('button', { name: '本店の操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'アーカイブ' }))
  fireEvent.click(screen.getByRole('button', { name: 'アーカイブする', exact: true }))
  await act(async () => {})
  expect(fixture.archive).toHaveBeenCalledTimes(1)
  expect(fixture.archive).toHaveBeenCalledWith('acc-1', undefined, undefined)
  fireEvent.click(screen.getByRole('button', { name: '本店の操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'アーカイブ' }))
  const confirm = screen.getByRole('button', { name: 'アーカイブする', exact: true })
  await act(async () => { rememberSessionSnapshot({ impersonation: { id: 'proxy', tenantId: 'tenant', mode: 'read', piiRevealed: false, startedAt: '' }, unfamiliarAt: null, stepUpMethod: 'none' }) })
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(confirm)
  await act(async () => {})
  expect(fixture.archive).toHaveBeenCalledTimes(1)
  expect(fixture.restore).not.toHaveBeenCalled()
})

it('アーカイブ前に、選択中ではなく操作するアカウントと環境を表示する', async () => {
  fixture.list.mockResolvedValue({ success: true, data: [{ id: 'acc-2', name: '対象の店', channelId: '2', isActive: false, archivedAt: null }] })
  await open()
  fireEvent.click(screen.getByRole('button', { name: '対象の店の操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'アーカイブ' }))
  const dialog = within(screen.getByRole('alertdialog'))
  expect(dialog.getByText('LINEアカウント')).toBeTruthy()
  expect(dialog.getByText('対象の店')).toBeTruthy()
  expect(dialog.getByText('環境')).toBeTruthy()
  expect(dialog.getByText('検証環境')).toBeTruthy()
  expect(fixture.archive).not.toHaveBeenCalled()
})
