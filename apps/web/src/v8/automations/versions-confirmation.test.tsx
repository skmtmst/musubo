// @vitest-environment happy-dom
import React from 'react'
import { render, screen, fireEvent, within, cleanup, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ account: 'account-1', update: vi.fn() }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(), useSearchParams: () => new URLSearchParams('id=action-1') }))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: state.account, accounts: [{ id: 'account-1', name: '本店' }], loading: false }) }))
vi.mock('./shell', () => ({ useAutomationManage: () => true }))
vi.mock('@/lib/use-manual-href', () => ({ useManualHref: () => null }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  const detail = { id: 'action-1', name: 'テストアクション', status: 'active', currentDraftVersionId: null, currentPublishedVersionId: 'v1', versions: [{ id: 'v1', versionNumber: 1, status: 'published', actions: [], draftRevision: 1, publishedAt: '2026-01-01' }], bindings: [{ id: 'binding-1', confirmationRevision: 7, consumerType: 'scenario', consumerId: 'sc1', consumerPath: '人工シナリオ', versionId: 'v0', versionNumber: 0, latestVersionNumber: 1, hasNewerVersion: true, runningCount: 0, waitingCount: 0, olderRunningCount: 0, olderWaitingCount: 0 }] }
  return { ...actual, api: { ...actual.api, commonActions: { ...actual.api.commonActions, get: vi.fn(async () => ({ success: true, data: detail })), list: vi.fn(async () => ({ success: true, data: [] })), updateBinding: state.update } } }
})
import Versions from './versions'
beforeEach(() => { state.account = 'account-1'; state.update.mockReset().mockResolvedValue({ success: true, data: {} }) })
afterEach(cleanup)
it('閉じた利用先の版切替確認から更新しない', async () => {
  render(<Versions />)
  fireEvent.click(await screen.findByRole('button', { name: '第1版へ更新する' }))
  const dialog = screen.getByRole('dialog', { name: 'この利用先を第1版へ更新しますか' })
  const button = within(dialog).getByRole('button', { name: '第1版へ更新' })
  const key = Object.keys(button).find(k => k.startsWith('__reactProps$'))!
  const oldClick = (button as unknown as Record<string, { onClick: (event: unknown) => void }>)[key].onClick
  fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
  fireEvent.click(screen.getByRole('button', { name: '第1版へ更新する' }))
  oldClick({ defaultPrevented: false, preventDefault() {}, stopPropagation() {}, currentTarget: button, target: button })
  expect(state.update).not.toHaveBeenCalled()
  const fresh = screen.getByRole('dialog', { name: 'この利用先を第1版へ更新しますか' })
  fireEvent.click(within(fresh).getByRole('button', { name: '第1版へ更新' }))
  await waitFor(() => expect(state.update).toHaveBeenCalledExactlyOnceWith('action-1', 'account-1', { bindingId: 'binding-1', versionId: 'v1', expectedVersionId: 'v0', expectedConfirmationRevision: 7 }))
})
