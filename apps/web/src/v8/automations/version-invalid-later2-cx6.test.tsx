// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CommonActionStep } from '@/lib/api'
import { versionChangeLines } from './version-diff'

const fixture = vi.hoisted(() => ({ actions: [] as unknown[] }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(), useSearchParams: () => new URLSearchParams('id=action-1') }))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-1', accounts: [{ id: 'account-1', name: '本店' }], loading: false }) }))
vi.mock('./shell', () => ({ useAutomationManage: () => true }))
vi.mock('@/lib/use-manual-href', () => ({ useManualHref: () => null }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, commonActions: { ...actual.api.commonActions,
    get: vi.fn(async () => ({ success: true, data: {
      id: 'action-1', name: 'テストアクション', status: 'active', currentDraftVersionId: null, currentPublishedVersionId: 'v2',
      versions: [
        { id: 'v1', versionNumber: 1, status: 'published', actions: [{ id: 'x', type: 'wait', params: { minutes: 1 }, onFailure: 'stop' }], draftRevision: 1, publishedAt: '2026-01-01' },
        { id: 'v2', versionNumber: 2, status: 'published', actions: fixture.actions, draftRevision: 1, publishedAt: '2026-01-02' },
      ],
      bindings: [{ id: 'b1', confirmationRevision: 1, consumerType: 'scenario', consumerId: 's1', consumerPath: '見本', versionId: 'v1', versionNumber: 1, latestVersionNumber: 2, hasNewerVersion: true, runningCount: 0, waitingCount: 0, olderRunningCount: 0, olderWaitingCount: 0 }],
    } })), list: vi.fn(async () => ({ success: true, data: [] })),
  } } }
})
import Versions from './versions'

beforeEach(() => { fixture.actions = [] })
afterEach(cleanup)

it.each(['typeなし', 'paramsなし', 'paramsが配列', 'idなし'] as const)('%s の版は内容を確認できないと表示する', async (kind) => {
  const action: Record<string, unknown> = { id: 'x', type: 'wait', params: { minutes: 2 }, onFailure: 'stop' }
  if (kind === 'typeなし') delete action.type
  if (kind === 'paramsなし') delete action.params
  if (kind === 'paramsが配列') action.params = []
  if (kind === 'idなし') delete action.id
  fixture.actions = [action]
  render(<Versions />)
  fireEvent.click(await screen.findByRole('button', { name: '第2版へ更新する' }))
  const dialog = screen.getByRole('dialog', { name: 'この利用先を第2版へ更新しますか' })
  expect(within(dialog).getByText('変更内容を読み取れません')).toBeTruthy()
  expect(within(dialog).queryByText('内容の変更はありません')).toBeNull()
})

it('版の処理数が違っても、不正な要素は変更内容を確認できないとする', () => {
  const previous = { versionNumber: 1, actions: [{ id: 'x', type: 'wait', params: {}, onFailure: 'stop' }] as CommonActionStep[] }
  const version = { versionNumber: 2, actions: [{ id: 'x' }, { id: 'y' }] as unknown as CommonActionStep[] }
  expect(versionChangeLines(version, [previous, version])).toEqual(['変更内容を読み取れません'])
})

it('前の版に不正な処理がある場合も変更内容を確認できないとする', () => {
  const previous = { versionNumber: 1, actions: [{ id: 'x', type: 'wait', params: null }] as unknown as CommonActionStep[] }
  const version = { versionNumber: 2, actions: [{ id: 'x', type: 'wait', params: {}, onFailure: 'stop' }] as CommonActionStep[] }
  expect(versionChangeLines(version, [previous, version])).toEqual(['変更内容を読み取れません'])
})
