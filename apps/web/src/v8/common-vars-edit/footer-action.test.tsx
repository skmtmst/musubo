// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ role: 'owner' as 'owner' | 'viewer', account: 'a', impact: vi.fn(), remove: vi.fn(), setStatus: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams('id=var-1') }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: state.account, loading: false }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => state.role }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    folders: { ...actual.api.folders, list: async () => ({ success: true, data: [] }) },
    commonVars: { ...actual.api.commonVars,
      detail: async () => ({ success: true, data: { id: 'var-1', name: '営業時間', key: 'hours', type: 'text', value: '10時', memo: '', status: 'active', validFrom: null, validUntil: null, version: 1, usages: [], history: [], usageCount: 0, usagePage: { total: 0, shown: 0 } } }),
      schedules: async () => ({ success: true, data: [] }), deleteImpact: state.impact, delete: state.remove, setStatus: state.setStatus,
    },
  } }
})
import Editor from './edit'

beforeEach(() => {
  state.role = 'owner'
  state.account = 'a'
  state.impact.mockReset().mockResolvedValue({ success: true, data: {
    variable: { id: 'var-1', name: '営業時間', varKey: 'hours' }, total: 0, blockingTotal: 0,
    historicalTotal: 0, unscopedFormTotal: 0, canDelete: true, byKind: {}, items: [],
    unavailableReferences: [], checkedAt: '2026-10-14T00:00:00+09:00', recommendedAction: 'delete',
  } })
  state.remove.mockReset()
  state.setStatus.mockReset().mockResolvedValue({ success: true })
})
afterEach(cleanup)

it('下帯の削除入口は赤い文字で、押すと使用先を確認し、取消では削除しない', async () => {
  render(<Editor />)
  const trigger = await screen.findByRole('button', { name: '削除する', exact: true })
  expect(trigger.getAttribute('data-variant')).toBe('text')
  expect(trigger.className).toContain('textDanger')
  expect(trigger.querySelector('svg')).toBeNull()
  expect(trigger.closest('[data-shared-part="sticky-bar"]')).not.toBeNull()
  fireEvent.click(trigger)
  const dialog = await screen.findByRole('alertdialog')
  expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
  expect(within(dialog).getByText('環境')).toBeTruthy()
  await within(dialog).findByText('使っている設定はありません。')
  expect(state.impact).toHaveBeenCalledWith('var-1', 'a')
  expect(within(dialog).queryByRole('button', { name: '削除する', exact: true })).toBeNull()
  fireEvent.change(within(dialog).getByRole('textbox', { name: /消した理由/ }), { target: { value: '店舗情報の変更のため' } })
  const confirm = within(dialog).getByRole('button', { name: '削除する', exact: true })
  expect(confirm.getAttribute('data-variant')).toBe('danger')
  expect(confirm.className).toContain('standard')
  expect(confirm.querySelector('svg')).toBeNull()
  expect(state.remove).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: '閉じる', exact: true }))
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  expect(state.remove).not.toHaveBeenCalled()
})

it('閲覧のみの人には、下帯の削除入口を出さない', async () => {
  state.role = 'viewer'
  render(<Editor />)
  await screen.findByRole('heading', { name: '営業時間', exact: true })
  expect(screen.queryByRole('button', { name: '削除する', exact: true })).toBeNull()
  expect(state.impact).not.toHaveBeenCalled()
  expect(state.remove).not.toHaveBeenCalled()
})

it('状態変更の確認に対象アカウントと環境を表示する', async () => {
  render(<Editor />)
  fireEvent.click(await screen.findByRole('button', { name: '止める', exact: true }))
  const dialog = await screen.findByRole('dialog', { name: '「営業時間」を止める' })
  expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
  expect(within(dialog).getByText('環境')).toBeTruthy()
})

it('状態変更の理由は必須と表示し、空欄では送信しない', async () => {
  render(<Editor />)
  fireEvent.click(await screen.findByRole('button', { name: '止める', exact: true }))
  const dialog = await screen.findByRole('dialog', { name: '「営業時間」を止める' })
  expect(within(dialog).getByText('必須', { exact: true })).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: '止める', exact: true }))
  expect(await within(dialog).findByText('変える理由を入力してください')).toBeTruthy()
  expect(state.setStatus).not.toHaveBeenCalled()
})

it('理由を入力した状態変更は対象アカウントへ一度だけ送る', async () => {
  render(<Editor />)
  fireEvent.click(await screen.findByRole('button', { name: '止める', exact: true }))
  const dialog = await screen.findByRole('dialog', { name: '「営業時間」を止める' })
  fireEvent.change(within(dialog).getByPlaceholderText('例：キャンペーンが終わったため'), { target: { value: '整理のため' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '止める', exact: true }))
  await waitFor(() => expect(state.setStatus).toHaveBeenCalledWith('var-1', 'a', { to: 'stopped', changeReason: '整理のため', expectedVersion: 1 }))
  expect(state.setStatus).toHaveBeenCalledTimes(1)
})

it('切り替えて戻した後に古い状態変更の確定は送らない', async () => {
  const view = render(<Editor />)
  fireEvent.click(await screen.findByRole('button', { name: '止める', exact: true }))
  const dialog = await screen.findByRole('dialog', { name: '「営業時間」を止める' })
  fireEvent.change(within(dialog).getByPlaceholderText('例：キャンペーンが終わったため'), { target: { value: '整理のため' } })
  const target = within(dialog).getByRole('button', { name: '止める', exact: true })
  const key = Object.keys(target).find(item => item.startsWith('__reactProps$'))!
  const handler = (target as unknown as Record<string, { onClick: (event: unknown) => unknown }>)[key].onClick
  state.account = 'b'; view.rerender(<Editor />)
  state.account = 'a'; view.rerender(<Editor />)
  await handler({ defaultPrevented: false, preventDefault() {}, stopPropagation() {}, currentTarget: target, target })
  expect(state.setStatus).not.toHaveBeenCalled()
})

it('確認と理由がそろったら対象アカウントで一度だけ削除する', async () => {
  state.remove.mockResolvedValue({ success: true })
  render(<Editor />)
  fireEvent.click(await screen.findByRole('button', { name: '削除する', exact: true }))
  const dialog = await screen.findByRole('alertdialog')
  await within(dialog).findByText('使っている設定はありません。')
  fireEvent.change(within(dialog).getByRole('textbox', { name: /消した理由/ }), { target: { value: '整理のため' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '削除する', exact: true }))
  await waitFor(() => expect(state.remove).toHaveBeenCalledWith('var-1', 'a', '整理のため'))
  expect(state.remove).toHaveBeenCalledTimes(1)
  expect(screen.queryByText(/LINEアカウントが切り替わりました/)).toBeNull()
})

it('アカウントを切り替えて戻しても古い削除確定は送らない', async () => {
  const view = render(<Editor />)
  fireEvent.click(await screen.findByRole('button', { name: '削除する', exact: true }))
  const dialog = await screen.findByRole('alertdialog')
  await within(dialog).findByText('使っている設定はありません。')
  fireEvent.change(within(dialog).getByRole('textbox', { name: /消した理由/ }), { target: { value: '整理のため' } })
  const target = within(dialog).getByRole('button', { name: '削除する', exact: true })
  const key = Object.keys(target).find(item => item.startsWith('__reactProps$'))!
  const handler = (target as unknown as Record<string, { onClick: (event: unknown) => unknown }>)[key].onClick
  state.account = 'b'; view.rerender(<Editor />)
  state.account = 'a'; view.rerender(<Editor />)
  await handler({ defaultPrevented: false, preventDefault() {}, stopPropagation() {}, currentTarget: target, target })
  expect(state.remove).not.toHaveBeenCalled()
})
