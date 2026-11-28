// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'

const fixture = vi.hoisted(() => ({ account: 'account-a', create: vi.fn(), push: vi.fn(), folders: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: fixture.push, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }), usePathname: () => '/webinars/new', useSearchParams: () => new URLSearchParams() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fixture.account, selectedAccount: { id: fixture.account, name: '見本' }, accounts: [], loading: false }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))
vi.mock('@/lib/use-feature-access', () => ({ useFeatureAccess: () => true }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, webinarApi: { ...actual.webinarApi, create: fixture.create, folders: fixture.folders } }
})
import WebinarNew from './new'
beforeEach(() => { fixture.account = 'account-a'; fixture.create.mockReset(); fixture.push.mockReset(); fixture.folders.mockReset().mockResolvedValue({ success: true, data: [] }) })
afterEach(() => { cleanup(); clearToastsForTest() })

it('下書きを保存できたら完了を知らせて一覧へ移る', async () => {
  fixture.create.mockResolvedValueOnce({ data: { id: 'sample-id' } })
  render(<><WebinarNew /><ToastHost /></>)
  fireEvent.change(screen.getByRole('textbox', { name: '名前' }), { target: { value: '見本のウェビナー' } })
  const save = screen.getByRole('button', { name: '下書きを保存' })
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false))
  await act(async () => { fireEvent.click(save) })
  expect(await screen.findByText('ウェビナーの下書きを作成しました。')).toBeTruthy()
  expect(fixture.push).toHaveBeenCalled()
})

it('保存に失敗したら完了を知らせず入力を残す', async () => {
  fixture.create.mockRejectedValueOnce(new Error('save failed'))
  render(<><WebinarNew /><ToastHost /></>)
  fireEvent.change(screen.getByRole('textbox', { name: '名前' }), { target: { value: '見本のウェビナー' } })
  const save = screen.getByRole('button', { name: '下書きを保存' })
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false))
  await act(async () => { fireEvent.click(save) })
  expect(screen.queryByText('ウェビナーの下書きを作成しました。')).toBeNull()
  expect(screen.getByDisplayValue('見本のウェビナー')).toBeTruthy()
  expect(fixture.push).not.toHaveBeenCalled()
})

it('アカウント切替後は古い保存結果で知らせたり移動したりしない', async () => {
  let complete!: (value: unknown) => void
  fixture.create.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  const view = render(<><WebinarNew /><ToastHost /></>)
  fireEvent.change(screen.getByRole('textbox', { name: '名前' }), { target: { value: '見本のウェビナー' } })
  const save = screen.getByRole('button', { name: '下書きを保存' })
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(save)
  fixture.account = 'account-b'
  view.rerender(<><WebinarNew /><ToastHost /></>)
  await act(async () => { complete({ data: { id: 'sample-id' } }) })
  expect(screen.queryByText('ウェビナーの下書きを作成しました。')).toBeNull()
  expect(fixture.push).not.toHaveBeenCalled()
})

it('失敗の応答にIDが含まれていても成功として扱わない', async () => {
  fixture.create.mockResolvedValueOnce({ success: false, data: { id: 'sample-id' } })
  render(<><WebinarNew /><ToastHost /></>)
  fireEvent.change(screen.getByRole('textbox', { name: '名前' }), { target: { value: '見本のウェビナー' } })
  const save = screen.getByRole('button', { name: '下書きを保存' })
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false))
  await act(async () => { fireEvent.click(save) })
  expect(screen.queryByText('ウェビナーの下書きを作成しました。')).toBeNull()
  expect(fixture.push).not.toHaveBeenCalled()
  expect(screen.getByDisplayValue('見本のウェビナー')).toBeTruthy()
})
