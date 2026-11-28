// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({ list: vi.fn(), tags: vi.fn(), scenarios: vi.fn() }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(), useSearchParams: () => new URLSearchParams(), usePathname: () => '/broadcasts' }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-a', selectedAccount: { id: 'account-a', name: '本店' }, accounts: [{ id: 'account-a', name: '本店' }] }), useOptionalAccount: () => ({ selectedAccountId: 'account-a' }) }))
vi.mock('@/lib/staff-role', async (original) => ({ ...(await original<typeof import('@/lib/staff-role')>()), useStaffRole: () => 'owner' }))
vi.mock('@/components/broadcasts/broadcast-form', () => ({ default: () => null }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    broadcasts: { ...actual.api.broadcasts, list: fx.list, savedViews: { ...actual.api.broadcasts.savedViews, list: vi.fn().mockResolvedValue({ success: true, data: [] }) } },
    folders: { ...actual.api.folders, list: vi.fn().mockResolvedValue({ success: true, data: [], unfiledCount: 0 }) },
    tags: { ...actual.api.tags, list: fx.tags }, scenarios: { ...actual.api.scenarios, list: fx.scenarios },
    dashboard: { ...actual.api.dashboard, overview: vi.fn().mockResolvedValue({ success: true, data: { delivery: { quotaLimit: 100, quotaUsed: 0 } } }) },
  } }
})
import { ApiError } from '@/lib/api'
import { PageChromeProvider } from '@/components/shell/page-chrome'
import Page from './page'

beforeEach(() => {
  fx.list.mockResolvedValue({ success: true, data: [], pagination: { total: 0, limit: 20, cursor: 0, nextCursor: null } })
  fx.tags.mockResolvedValue({ success: true, data: [] })
  fx.scenarios.mockResolvedValue({ success: true, data: [] })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })
function draw() { return render(<PageChromeProvider><Page /></PageChromeProvider>) }

it('403は権限不足を伝え、一般の取得失敗や空一覧と混ぜない', async () => {
  fx.list.mockRejectedValue(new ApiError(403, 'forbidden'))
  draw()
  expect(await screen.findByText('配信を見る権限がありません')).toBeTruthy()
  expect(screen.getByText('配信を見る権限がありません').closest('[data-list-state="error"]')).toBeTruthy()
  expect(screen.queryByText('一斉配信を読み込めませんでした')).toBeNull()
  expect(screen.queryByText('まだ一斉配信がありません')).toBeNull()
  expect(document.title).toContain('一斉配信')
})

it('取得失敗は一覧に一度だけ表示し、読み直すと空の一覧へ戻る', async () => {
  fx.list.mockRejectedValueOnce(new Error('network down'))
  draw()
  expect(await screen.findByText('一斉配信を読み込めませんでした')).toBeTruthy()
  expect(screen.getByText('一斉配信を読み込めませんでした').closest('[data-list-state="error"]')).toBeTruthy()
  expect(screen.getAllByRole('button', { name: 'もう一度読み込む' })).toHaveLength(1)
  expect(screen.queryByText('配信を見る権限がありません')).toBeNull()
  expect(screen.queryByText('まだ一斉配信がありません')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  expect(await screen.findByText('まだ一斉配信がありません')).toBeTruthy()
  expect(document.querySelector('[data-empty-list]')).toBeTruthy()
  expect(fx.list).toHaveBeenCalledTimes(2)
})

it('状態を変えたとき一覧だけを取り直し、タグとシナリオは取り直さない', async () => {
  draw()
  await screen.findByText('まだ一斉配信がありません')
  await waitFor(() => expect(fx.tags).toHaveBeenCalledTimes(1))
  expect(fx.scenarios).toHaveBeenCalledTimes(1)
  fx.list.mockClear()
  fireEvent.click(screen.getByRole('button', { name: '予約中' }))
  await screen.findByText('条件に合うものがありません')
  await waitFor(() => expect(fx.list).toHaveBeenCalled())
  expect(fx.list).toHaveBeenLastCalledWith(expect.objectContaining({ displayStatus: 'scheduled' }))
  expect(fx.tags).toHaveBeenCalledTimes(1)
  expect(fx.scenarios).toHaveBeenCalledTimes(1)
})
