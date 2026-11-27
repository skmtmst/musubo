// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ list: vi.fn(), csv: vi.fn(), push: vi.fn() }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(), useRouter: () => ({ push: fixture.push, replace: vi.fn(), back: vi.fn() }) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-a', loading: false }) }))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/lib/use-manual-href', () => ({ useManualHref: () => null }))
vi.mock('@/v8/automations/shell', async (original) => ({ ...(await original<typeof import('@/v8/automations/shell')>()), useAutomationManage: () => true, useAutomationRunManage: () => ({ canExport: true }), useAutomationTabCounts: () => ({ rules: 0, commonActions: 1, runs: 0 }) }))
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    commonActions: { ...actual.api.commonActions, list: fixture.list, csvUrl: fixture.csv },
    folders: { ...actual.api.folders, list: vi.fn().mockResolvedValue({ success: true, data: [], unfiledCount: 0 }) },
  } }
})
import CommonActions from '@/v8/automations/common-actions'

const item = { id: 'ca-1', name: '来店の案内', description: null, status: 'draft', draftVersion: 1, publishedVersion: null, actionCount: 1, bindingCount: 0, oldVersionBindingCount: 0, executionCountThisMonth: 12, failureCountThisMonth: 2, lastRunAt: null, updatedAt: '2026-10-20T00:00:00Z' }
const summary = { total: 1, published: 0, draft: 1, oldVersion: 0, unused: 1, archived: 0, actions: 1, bindings: 0, outdated: 0, outdatedItems: 0, executions: 12, failures: 2 }

beforeEach(() => {
  window.history.replaceState({}, '', '/common-actions')
  window.dispatchEvent(new PopStateEvent('popstate'))
  fixture.list.mockReset().mockResolvedValue({ success: true, data: [item], summary, pagination: { total: 1 } })
  fixture.csv.mockReset().mockReturnValue('/export.csv')
  fixture.push.mockReset()
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('読み込み・空・失敗を区別する', async () => {
  let finish!: (value: unknown) => void
  fixture.list.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const view = render(<CommonActions />)
  expect(view.container.querySelector('[data-list-state="loading"]')?.getAttribute('aria-label')).toBe('共通アクションを読み込んでいます')
  finish({ success: true, data: [], summary: { ...summary, total: 0 }, pagination: { total: 0 } })
  expect(await screen.findByText('まだ、共通アクションはありません')).toBeTruthy()
  view.unmount()
  fixture.list.mockRejectedValueOnce(new Error('private'))
  const failed = render(<CommonActions />)
  await waitFor(() => expect(failed.container.querySelector('[data-list-state="error"]')).toBeTruthy())
  expect(screen.getByText('共通アクションを読み込めませんでした')).toBeTruthy()
  expect(screen.queryByText('まだ、共通アクションはありません')).toBeNull()
})

it('集計と行の操作、版への行き先を表示する', async () => {
  render(<CommonActions />)
  const name = await screen.findByText('来店の案内')
  const row = name.closest('tr') as HTMLElement
  expect(within(row).getByRole('link', { name: '中身を見る' }).getAttribute('href')).toBe('/common-actions/versions?id=ca-1')
  fireEvent.click(within(row).getByRole('button', { name: /操作/ }))
  expect(await screen.findByRole('menuitem', { name: '版と使われている場所を見る' })).toBeTruthy()
  expect(screen.getByRole('menuitem', { name: '下書きを編集・公開する' })).toBeTruthy()
  expect(screen.getByText('12')).toBeTruthy()
  expect(screen.getByText('2')).toBeTruthy()
})

it('検索と状態の絞り込みをCSVに渡す', async () => {
  render(<CommonActions />)
  await screen.findByText('来店の案内')
  fireEvent.change(screen.getByLabelText('共通アクションを検索'), { target: { value: '来店' } })
  fireEvent.click(screen.getByRole('button', { name: /^下書き/ }))
  await waitFor(() => expect(fixture.csv).toHaveBeenLastCalledWith(expect.objectContaining({ accountId: 'account-a', status: 'draft', query: '来店' })))
  expect(screen.getByRole('link', { name: 'CSVで書き出す' }).getAttribute('href')).toBe('/export.csv')
})
