// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ list: vi.fn(), folders: vi.fn(), views: vi.fn() }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-a', selectedAccount: { id: 'account-a', name: '本店' }, accounts: [{ id: 'account-a', name: '本店' }] }), useOptionalAccount: () => ({ selectedAccountId: 'account-a' }) }))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/lib/staff-role', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/staff-role')>()), useStaffRole: () => 'owner' }))
vi.mock('@/components/broadcasts/broadcast-form', () => ({ default: () => null }))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    broadcasts: { ...actual.api.broadcasts, list: fixture.list, savedViews: { ...actual.api.broadcasts.savedViews, list: fixture.views } },
    folders: { ...actual.api.folders, list: fixture.folders },
    tags: { ...actual.api.tags, list: vi.fn().mockResolvedValue({ success: true, data: [] }) },
    scenarios: { ...actual.api.scenarios, list: vi.fn().mockResolvedValue({ success: true, data: [] }) },
    dashboard: { ...actual.api.dashboard, overview: vi.fn().mockResolvedValue({ success: true, data: { delivery: { quotaLimit: 100, quotaUsed: 0 } } }) },
  } }
})
import Page from './page'

beforeEach(() => {
  fixture.list.mockResolvedValue({ success: true, data: [], pagination: { total: 0, limit: 20, cursor: 0, nextCursor: null } })
  fixture.folders.mockResolvedValue({ success: true, data: [{ id: 'folder-1', name: '夏の配信', count: 0 }], unfiledCount: 0 })
  fixture.views.mockResolvedValue({ success: true, data: [{ id: 'view-1', name: '夏の予約', filters: { statusFilter: 'scheduled', titleQuery: '夏休み', folderFilter: 'folder-1', dateFrom: '2026-08-01', dateTo: '2026-08-31' }, sortKey: 'newest', pageSize: 20 }] })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('保存した条件で0件なら条件の解除を案内し、全条件を外して空の一覧へ戻る', async () => {
  render(<Page />)
  await screen.findByText('まだ一斉配信がありません')
  expect(screen.getByRole('button', { name: '最初の一斉配信を作る' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '保存した検索' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '夏の予約' }))
  expect(await screen.findByText('条件に合うものがありません')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '最初の一斉配信を作る' })).toBeNull()
  expect((screen.getByRole('searchbox', { name: /探す/ }) as HTMLInputElement).value).toBe('夏休み')
  expect(screen.getByRole('button', { name: '配信日：2026-08-01〜2026-08-31' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '予約中' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('button', { name: '夏の配信' }).getAttribute('aria-current')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: '条件を外す' }))
  await waitFor(() => expect(screen.getByText('まだ一斉配信がありません')).toBeTruthy())
  expect((screen.getByRole('searchbox', { name: /探す/ }) as HTMLInputElement).value).toBe('')
  expect(screen.getByRole('button', { name: '配信日：指定なし' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'すべて', exact: true }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('button', { name: '夏の配信' }).getAttribute('aria-current')).toBeNull()
  expect(screen.getByRole('button', { name: '保存した検索' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '最初の一斉配信を作る' })).toBeTruthy()
})
