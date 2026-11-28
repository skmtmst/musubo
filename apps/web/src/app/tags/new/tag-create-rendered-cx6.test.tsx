// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({ create: vi.fn(), definition: vi.fn(), push: vi.fn(), query: '' }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: fx.push, replace: vi.fn() }), useSearchParams: () => new URLSearchParams(fx.query), usePathname: () => '/tags/new' }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-a' }) }))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'admin', canManageRole: () => true }))
vi.mock('@/lib/use-unsaved-guard', () => ({ useUnsavedGuard: () => ({ disarm: vi.fn(), dialogOpen: false }) }))
vi.mock('@/lib/unsaved-leave-dialog', () => ({ UnsavedLeaveDialog: () => null }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    tags: { ...actual.api.tags, list: vi.fn().mockResolvedValue({ success: true, data: [] }), definition: fx.definition, createDefinition: fx.create },
    tagGroups: { ...actual.api.tagGroups, list: vi.fn().mockResolvedValue({ success: true, data: [{ id: 'folder-1', name: '会員', accountId: 'account-a' }] }) },
  } }
})
import Page from './page'

beforeEach(() => {
  fx.query = ''
  fx.create.mockResolvedValue({ success: true, data: { tag: { id: 'new-tag' } } })
  fx.definition.mockResolvedValue({ success: true, data: {
    tag: { id: 'source', name: '既存タグ', groupId: 'folder-1', isStarred: true, linkedEnabled: true, mileageReward: 20, referralMileageReward: 30, linkedActions: [] },
    automation: { actions: [{ id: 'action-1', type: 'send_message', params: { content: '登録ありがとう', delayMinutes: 0 } }] },
  } })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('画面から長すぎる名前と使えない文字を知らせ、保存しない', async () => {
  render(<Page />)
  const input = await screen.findByLabelText('タグ名')
  expect(document.querySelector('[data-template-region="create-flow"]')).toBeTruthy()
  expect(screen.getByRole('complementary', { name: '設定内容を見る' })).toBeTruthy()
  fireEvent.change(input, { target: { value: 'あ'.repeat(81) } })
  fireEvent.click(screen.getByRole('button', { name: 'タグを作る', exact: true }))
  expect(screen.getByText('タグ名は80文字までで入力してください')).toBeTruthy()
  expect(fx.create).not.toHaveBeenCalled()
  fireEvent.change(input, { target: { value: '会員\u0007タグ' } })
  fireEvent.click(screen.getByRole('button', { name: 'タグを作る', exact: true }))
  expect(screen.getByText('タグ名に使えない文字が含まれています')).toBeTruthy()
  expect(fx.create).not.toHaveBeenCalled()
})

it('複製したフォルダ・表示設定・マイル・動きを引き継いで保存する', async () => {
  fx.query = 'copy=source'
  render(<Page />)
  const input = await screen.findByLabelText('タグ名') as HTMLInputElement
  await waitFor(() => expect(input.value).toBe('既存タグ のコピー'))
  expect(fx.definition).toHaveBeenCalledWith('source', 'account-a')
  expect(screen.getByRole('switch', { name: '友だち一覧に出す' }).getAttribute('aria-checked')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: 'タグを作る', exact: true }))
  await waitFor(() => expect(fx.create).toHaveBeenCalledWith('account-a', expect.objectContaining({
    name: '既存タグ のコピー', groupId: 'folder-1', isStarred: true, linkedEnabled: true,
    mileage: expect.objectContaining({ self: 20, referrer: 30 }),
    actions: [expect.objectContaining({ id: 'action-1', type: 'send_message', params: { content: '登録ありがとう', delayMinutes: 0 } })],
  })))
  await waitFor(() => expect(fx.push).toHaveBeenCalledWith('/tags?highlight=new-tag'))
})

it('通常作成は未分類と表示オフのまま連動なしで保存する', async () => {
  render(<Page />)
  fireEvent.change(await screen.findByLabelText('タグ名'), { target: { value: '新しいタグ' } })
  expect(screen.getByRole('switch', { name: '友だち一覧に出す' }).getAttribute('aria-checked')).toBe('false')
  fireEvent.click(screen.getByRole('button', { name: 'タグを作る', exact: true }))
  await waitFor(() => expect(fx.create).toHaveBeenCalledWith('account-a', expect.objectContaining({
    name: '新しいタグ', groupId: null, isStarred: false, linkedEnabled: false,
    mileage: expect.objectContaining({ self: 0, referrer: 0 }), actions: [],
  })))
})
