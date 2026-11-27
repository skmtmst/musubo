// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'

const fx = vi.hoisted(() => ({ account: 'account-a', role: 'owner' as string | null, list: vi.fn(), setStatus: vi.fn() }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(), useSearchParams: () => new URLSearchParams(), usePathname: () => '/automations' }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fx.account, accounts: [{ id: fx.account, name: fx.account === 'account-a' ? 'A店' : 'B店' }], loading: false }) }))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/lib/use-running-version', () => ({ useRunningVersion: () => ({ detail: { deploy_env: 'staging' }, statusText: '稼働版を確認' }) }))
vi.mock('@/lib/line-accounts-cache', () => ({ loadLineAccounts: vi.fn().mockResolvedValue({ success: true, data: [{ id: 'account-a', name: 'A店' }, { id: 'account-b', name: 'B店' }] }) }))
vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => false }))
vi.mock('@/lib/staff-role', async original => ({ ...(await original<typeof import('@/lib/staff-role')>()), useStaffRole: () => fx.role }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    automations: { ...actual.api.automations, list: fx.list, setStatus: fx.setStatus },
    folders: { ...actual.api.folders, list: vi.fn().mockResolvedValue({ success: true, data: [] }) },
  } }
})
import Page from './page'

const item = { id: 'rule-1', name: '問い合わせ通知', description: null, eventType: 'message_received', triggerConfig: {}, conditions: {}, actions: [{ type: 'notify_staff', params: {} }], isActive: true, priority: 1, lineAccountId: 'account-a', status: 'active', versionId: 'v1', version: 1, confirmationRevision: 3, executionCount30d: 4, failureCount30d: 0, lastRunAt: null, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z' }

beforeEach(() => {
  window.history.replaceState({}, '', '/automations')
  window.dispatchEvent(new PopStateEvent('popstate'))
  fx.account = 'account-a'
  fx.role = verifiedStaffRole('owner')
  fx.list.mockResolvedValue({ success: true, data: [item], summary: { active: 1, stopped: 0, executionCount30d: 4, failureCount30d: 0 } })
  fx.setStatus.mockResolvedValue({ success: true, data: item })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

async function choose(label: string, name = '問い合わせ通知') {
  fireEvent.click(await screen.findByRole('button', { name: `ルール「${name}」の操作` }))
  fireEvent.click(await screen.findByRole('menuitem', { name: label }))
}

it('保管は危険操作とし、残る記録と戻せる場所を確認する', async () => {
  render(<Page />)
  await choose('保管する')
  const dialog = await screen.findByRole('alertdialog')
  expect(dialog.textContent).toContain('問い合わせ通知')
  expect(dialog.textContent).toContain('動いた記録と設定は残り、「保管したもの」の絞り込みから戻せます。')
  expect(within(dialog).getByRole('button', { name: '保管する' }).getAttribute('data-variant')).toBe('danger')
  expect(fx.setStatus).not.toHaveBeenCalled()
})

it('保管から戻しても稼働は再開せず、記録と設定が残ると示す', async () => {
  fx.list.mockResolvedValue({ success: true, data: [{ ...item, id: 'archived-1', name: '保管済みの通知', status: 'archived', isActive: false }], summary: { active: 0, stopped: 0, executionCount30d: 4, failureCount30d: 0 } })
  render(<Page />)
  fireEvent.click(await screen.findByRole('button', { name: '保管したもの', exact: true }))
  await choose('保管から戻す', '保管済みの通知')
  const dialog = await screen.findByRole('dialog')
  expect(dialog.textContent).toContain('動いた記録と設定は残り、稼働は再開しません。')
})

it('稼働を止める窓は記録を残すことを示し、失敗後は読み直して再試行できる', async () => {
  let finish!: (value: { success: boolean; error?: string }) => void
  fx.setStatus.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  render(<Page />)
  await choose('止める')
  const dialog = await screen.findByRole('dialog')
  expect(dialog.textContent).toContain('切り替えても、動いた記録は残ります。')
  const submit = within(dialog).getByRole('button', { name: '止める' }) as HTMLButtonElement
  expect(submit.getAttribute('data-variant')).not.toBe('danger')
  const before = fx.list.mock.calls.length
  fireEvent.click(submit)
  fireEvent.click(submit)
  expect(fx.setStatus).toHaveBeenCalledTimes(1)
  expect(fx.setStatus).toHaveBeenCalledWith('rule-1', 'stopped', 3)
  expect(submit.disabled).toBe(true)
  await act(async () => finish({ success: false, error: 'internal error' }))
  expect(await within(dialog).findByText(/稼働を切り替えられませんでした/)).toBeTruthy()
  expect(dialog.textContent).not.toContain('internal error')
  expect(fx.list.mock.calls.length).toBeGreaterThan(before)
  expect(submit.disabled).toBe(false)
  fireEvent.click(submit)
  await waitFor(() => expect(fx.setStatus).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

it('アカウントを往復しても、切替前の確認窓を再表示しない', async () => {
  const view = render(<Page />)
  await choose('止める')
  expect(await screen.findByRole('dialog')).toBeTruthy()
  fx.account = 'account-b'
  view.rerender(<Page />)
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  fx.account = 'account-a'
  view.rerender(<Page />)
  await screen.findByRole('button', { name: 'ルール「問い合わせ通知」の操作' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(fx.setStatus).not.toHaveBeenCalled()
})

it('アカウント切替で前の確認窓を閉じ、古い応答を新しい操作に混ぜない', async () => {
  let finishA!: (value: { success: boolean; error?: string }) => void
  let finishB!: (value: { success: boolean; error?: string }) => void
  fx.setStatus.mockReturnValueOnce(new Promise(resolve => { finishA = resolve })).mockReturnValueOnce(new Promise(resolve => { finishB = resolve }))
  const view = render(<Page />)
  await choose('止める')
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '止める' }))
  fx.account = 'account-b'
  view.rerender(<Page />)
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await choose('止める')
  const dialogB = await screen.findByRole('dialog')
  const submitB = within(dialogB).getByRole('button', { name: '止める' }) as HTMLButtonElement
  fireEvent.click(submitB)
  expect(fx.setStatus).toHaveBeenCalledTimes(2)
  await act(async () => finishA({ success: false, error: 'old error' }))
  expect(screen.getByRole('dialog')).toBe(dialogB)
  expect(submitB.disabled).toBe(true)
  expect(dialogB.textContent).not.toContain('old error')
  await act(async () => finishB({ success: false, error: 'new error' }))
  expect(await within(dialogB).findByText(/稼働を切り替えられませんでした/)).toBeTruthy()
  expect(submitB.disabled).toBe(false)
})
