// @vitest-environment happy-dom
import React from 'react'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { PERMISSION_LOCK_REASON } from '@/components/shared/permission-lock'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

/*
 * G9 AI とつなぐの区画の動き（要件 MCP-01・02・15・18・19）：
 * 作るのはオーナーだけ・管理者は「オーナーだけが作れます」で止めるはできる・閲覧のみは見るだけ・スタッフには出さない・
 * 鍵は 1 回だけで、閉じる前に「鍵はもう見られません」の確かめ。
 */
const role = vi.hoisted(() => ({ value: 'owner' as string | null }))
const apiMock = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), stop: vi.fn(), rotate: vi.fn(), logs: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/mcp-connect/log', useSearchParams: () => new URLSearchParams() }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'acc-1', selectedAccount: { id: 'acc-1', name: '渋谷店' }, accounts: [{ id: 'acc-1', name: '渋谷店' }] }) }))
vi.mock('@/lib/staff-role', () => ({ useStaffIdentity: () => null, useStaffRole: () => role.value }))
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return { ...actual, mcpApi: { ...actual.mcpApi, ...apiMock } }
})
import McpConnectionsSection from './section'
import McpLogV8 from './log'

const CONNECTION = { id: 'mcp-1', name: 'Claude（Kenta）', level: 'draft', accounts: [{ id: 'acc-1', name: '渋谷店' }], keyPrefix: 'mcp_', expiresAt: '2027-01-15T00:00:00.000Z', lastUsedAt: null, status: 'active', previousKeyExpiresAt: null, version: 1 }
const MANY_ACCOUNTS = [{ id: 'acc-1', name: '渋谷店' }, { id: 'acc-2', name: '新宿店' }, { id: 'acc-3', name: '池袋店' }, { id: 'acc-4', name: '品川店' }]

beforeEach(() => {
  vi.clearAllMocks()
  role.value = verifiedStaffRole('owner')
  apiMock.list.mockResolvedValue({ success: true, data: [CONNECTION] })
  apiMock.logs.mockResolvedValue({ success: true, data: { items: [], total: 0, connection: { ...CONNECTION, accounts: MANY_ACCOUNTS } } })
  apiMock.create.mockResolvedValue({ success: true, data: { connection: { ...CONNECTION, id: 'mcp-2', level: 'read' }, url: 'https://api.example.test/mcp/acc', key: 'mcp_live_abcdef1234567890' } })
})
afterEach(cleanup)

async function open() {
  render(<McpConnectionsSection />)
  await act(async () => {})
}

it.each(['止める', '鍵を作り直す'])('接続一覧で%s前に全アカウントと環境を示す', async action => {
  apiMock.list.mockResolvedValueOnce({ success: true, data: [{ ...CONNECTION, accounts: MANY_ACCOUNTS }] })
  await open()
  fireEvent.click(screen.getByRole('button', { name: '「Claude（Kenta）」の操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: action }))
  const dialog = screen.getByRole(action === '止める' ? 'alertdialog' : 'dialog')
  for (const account of MANY_ACCOUNTS) expect(within(dialog).getByText(account.name)).toBeTruthy()
  expect(within(dialog).getByText('LINEアカウント（4件）')).toBeTruthy()
  expect(within(dialog).queryByText('対象アカウント数')).toBeNull()
  if (action === '止める') expect(within(dialog).getByRole('button', { name: '止める' }).querySelector('.lucide-trash-2')).toBeNull()
  expect(within(dialog).getByText('環境')).toBeTruthy()
})

it('操作記録から止める前に全アカウントと環境を示す', async () => {
  render(<McpLogV8 />)
  fireEvent.click(await screen.findByRole('button', { name: 'その他の操作' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'この接続を止める' }))
  const dialog = screen.getByRole('alertdialog')
  for (const account of MANY_ACCOUNTS) expect(within(dialog).getByText(account.name)).toBeTruthy()
  expect(within(dialog).getByText('LINEアカウント（4件）')).toBeTruthy()
  expect(within(dialog).queryByText('対象アカウント数')).toBeNull()
  expect(within(dialog).getByRole('button', { name: '止める' }).querySelector('.lucide-trash-2')).toBeNull()
  expect(within(dialog).getByText('環境')).toBeTruthy()
})

it('操作記録で確認中に接続が切り替わったら古い確認では止めない', async () => {
  apiMock.logs.mockImplementation(async ({ connectionId }: { connectionId?: string }) => ({
    success: true,
    data: { items: [], total: 0, connection: connectionId === 'mcp-2' ? { ...CONNECTION, id: 'mcp-2', name: '別の接続' } : CONNECTION },
  }))
  render(<McpLogV8 />)
  fireEvent.click(await screen.findByRole('button', { name: 'その他の操作' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'この接続を止める' }))
  expect(screen.getByRole('alertdialog').textContent).toContain('Claude（Kenta）')
  await act(async () => {
    window.history.pushState(null, '', '?connection=mcp-2')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  await screen.findByText(/別の接続・/)
  const dialog = screen.queryByRole('alertdialog')
  if (dialog) fireEvent.click(within(dialog).getByRole('button', { name: '止める' }))
  expect(apiMock.stop).not.toHaveBeenCalled()
  window.history.replaceState(null, '', window.location.pathname)
  window.dispatchEvent(new PopStateEvent('popstate'))
})

it('接続切替前の読込が遅れて戻っても、別の接続に表示が戻らない', async () => {
  let finishFirst!: (value: unknown) => void
  const first = new Promise(resolve => { finishFirst = resolve })
  apiMock.logs.mockImplementation(({ connectionId }: { connectionId?: string }) => connectionId === 'mcp-2'
    ? Promise.resolve({ success: true, data: { items: [], total: 0, connection: { ...CONNECTION, id: 'mcp-2', name: '別の接続' } } })
    : first)
  render(<McpLogV8 />)
  await waitFor(() => expect(apiMock.logs).toHaveBeenCalled())
  await act(async () => {
    window.history.pushState(null, '', '?connection=mcp-2')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  await screen.findByText(/別の接続・/)
  await act(async () => { finishFirst({ success: true, data: { items: [], total: 0, connection: CONNECTION } }) })
  expect(screen.queryByText(/Claude（Kenta）・/)).toBeNull()
  expect(screen.getByText(/別の接続・/)).toBeTruthy()
  window.history.replaceState(null, '', window.location.pathname)
  window.dispatchEvent(new PopStateEvent('popstate'))
})

it('6件以上の対象は5件と残数を示し、全名を title に残す', async () => {
  const accounts = [...MANY_ACCOUNTS, { id: 'acc-5', name: '五号店' }, { id: 'acc-6', name: '六号店' }, { id: 'acc-7', name: '七号店' }]
  apiMock.list.mockResolvedValueOnce({ success: true, data: [{ ...CONNECTION, accounts }] })
  await open()
  fireEvent.click(screen.getByRole('button', { name: '「Claude（Kenta）」の操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '鍵を作り直す' }))
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByText('LINEアカウント（7件）')).toBeTruthy()
  expect(within(dialog).getByText('五号店')).toBeTruthy()
  expect(within(dialog).queryByText('六号店')).toBeNull()
  expect(within(dialog).getByText('ほか2件')).toBeTruthy()
  const full = within(dialog).getByTitle(accounts.map(account => account.name).join('、'))
  expect(full).toBeTruthy()
})

it('停止ボタンに削除のゴミ箱を出さない', async () => {
  await open()
  fireEvent.click(screen.getByRole('button', { name: '「Claude（Kenta）」の操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '止める' }))
  expect(within(screen.getByRole('alertdialog')).getByRole('button', { name: '止める' }).querySelector('.lucide-trash-2')).toBeNull()
})

it('対象アカウントが分からない時は選択中のアカウントで補わない', async () => {
  apiMock.list.mockResolvedValueOnce({ success: true, data: [{ ...CONNECTION, accounts: [] }] })
  await open()
  fireEvent.click(screen.getByRole('button', { name: '「Claude（Kenta）」の操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '止める' }))
  const dialog = screen.getByRole('alertdialog')
  expect(within(dialog).getByText('名前を確認できません')).toBeTruthy()
  expect(within(dialog).queryByText('渋谷店')).toBeNull()
})

it('オーナーは接続を作れ、鍵は 1 回だけ出て、閉じる前に確かめる', async () => {
  await open()
  expect(screen.getByText('読む＋下書きを作る')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '接続を作る' }))
  const dialog = screen.getByRole('dialog')
  for (const word of ['読むだけ', '読む＋下書きを作る', '読む＋下書き＋送る依頼']) expect(within(dialog).getByText(word)).toBeTruthy()
  fireEvent.change(within(dialog).getByLabelText(/名前/), { target: { value: 'Claude（Kenta）' } })
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '作る' })) })
  expect(apiMock.create).toHaveBeenCalledWith({ name: 'Claude（Kenta）', level: 'read', accountIds: ['acc-1'], expiresInDays: 90 }, undefined)
  expect(screen.getByText('接続を作りました')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '閉じる' }))
  expect(screen.getByText(/鍵はもう見られません/)).toBeTruthy()
})

it('管理者には作るボタンを灰色とオーナーの理由で残し、止めるはできる', async () => {
  role.value = verifiedStaffRole('admin')
  await open()
  const create = screen.getByRole('button', { name: '接続を作る' })
  expect(create.getAttribute('aria-disabled')).toBe('true')
  fireEvent.focus(create)
  expect(screen.getByRole('tooltip').textContent).toBe(PERMISSION_LOCK_REASON.owner)
  fireEvent.click(create)
  expect(apiMock.create).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '「Claude（Kenta）」の操作' }))
  expect(screen.getByRole('menuitem', { name: '止める' })).toBeTruthy()
  expect(screen.getByRole('menuitem', { name: '鍵を作り直す' }).getAttribute('aria-disabled')).toBe('true')
})

it('閲覧のみは見るだけ（作る・止める・作り直すを出さない）、スタッフには区画を出さない', async () => {
  role.value = verifiedStaffRole('viewer')
  await open()
  expect(screen.getByText('Claude（Kenta）')).toBeTruthy()
  expect(screen.getByRole('button', { name: '接続を作る' }).getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: '「Claude（Kenta）」の操作' }))
  expect(screen.getByRole('menuitem', { name: '止める' }).getAttribute('aria-disabled')).toBe('true')
  cleanup()
  role.value = verifiedStaffRole('staff')
  await open()
  expect(screen.queryByText('AI とつなぐ（MCP）')).toBeNull()
  expect(apiMock.list).toHaveBeenCalledTimes(1)
})
