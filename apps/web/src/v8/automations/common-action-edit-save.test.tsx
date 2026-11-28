// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'

const fixture = vi.hoisted(() => ({ update: vi.fn(), push: vi.fn(), account: 'account-a' }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: fixture.push, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }), usePathname: () => '/common-actions/edit', useSearchParams: () => new URLSearchParams('id=ca-1') }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fixture.account, loading: false }) }))
vi.mock('@/components/automations/use-common-action-permission', () => ({ useCanManageCommonActions: () => true }))
vi.mock('@/components/automations/common-action-editor', () => ({ default: () => null }))
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, commonActions: { ...actual.api.commonActions,
    get: vi.fn().mockResolvedValue({ success: true, data: { id: 'ca-1', name: '見本', description: '', currentDraftVersionId: 'v1', versions: [{ id: 'v1', draftRevision: 3, actions: [{ id: 'a1', type: 'add_tag', params: { tagId: 't1' }, onFailure: 'stop' }] }] } }),
    resources: vi.fn().mockResolvedValue({ success: true, data: { tags: [], scenarios: [], templates: [], webhooks: [], richMenus: [], commonActions: [] } }),
    updateDraft: fixture.update,
  } } }
})
import CommonActionEdit from './common-action-edit'
beforeEach(() => { fixture.update.mockReset(); fixture.push.mockReset(); fixture.account = 'account-a' })
afterEach(() => { cleanup(); clearToastsForTest() })

it('下書きを保存できたら完了を知らせて版の画面へ進む', async () => {
  fixture.update.mockResolvedValueOnce({ success: true, data: { updated: true } })
  render(<><CommonActionEdit /><ToastHost /></>)
  await screen.findByDisplayValue('見本')
  fireEvent.change(screen.getByDisplayValue('見本'), { target: { value: '見本を修正' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '下書きを保存する' })) })
  expect(await screen.findByText('共通アクションの下書きを保存しました。')).toBeTruthy()
  expect(fixture.push).toHaveBeenCalledWith('/common-actions/versions?id=ca-1')
})

it('保存に失敗した場合は完了を知らせず画面に残る', async () => {
  fixture.update.mockResolvedValueOnce({ success: false, error: '保存できませんでした' })
  render(<><CommonActionEdit /><ToastHost /></>)
  await screen.findByDisplayValue('見本')
  fireEvent.change(screen.getByDisplayValue('見本'), { target: { value: '見本を修正' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '下書きを保存する' })) })
  await waitFor(() => expect(fixture.update).toHaveBeenCalledOnce())
  expect(screen.queryByText('共通アクションの下書きを保存しました。')).toBeNull()
  expect(fixture.push).not.toHaveBeenCalled()
  expect(screen.getByDisplayValue('見本を修正')).toBeTruthy()
})

it('アカウント切替後は前の保存結果で知らせたり移動したりしない', async () => {
  let complete!: (value: unknown) => void
  fixture.update.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
  const view = render(<><CommonActionEdit /><ToastHost /></>)
  await screen.findByDisplayValue('見本')
  fireEvent.change(screen.getByDisplayValue('見本'), { target: { value: '見本を修正' } })
  fireEvent.click(screen.getByRole('button', { name: '下書きを保存する' }))
  expect(fixture.update).toHaveBeenCalledOnce()
  fixture.account = 'account-b'
  view.rerender(<><CommonActionEdit /><ToastHost /></>)
  await act(async () => { complete({ success: true, data: { updated: true } }) })
  expect(screen.queryByText('共通アクションの下書きを保存しました。')).toBeNull()
  expect(fixture.push).not.toHaveBeenCalled()
})
