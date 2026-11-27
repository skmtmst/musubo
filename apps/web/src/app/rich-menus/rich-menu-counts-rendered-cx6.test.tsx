// @vitest-environment happy-dom

import React from 'react'
import { cleanup, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

type ApiResult = { success: boolean; data?: unknown }

const fixture = vi.hoisted(() => ({
  selectedAccount: { id: 'account-a', name: 'A社' } as { id: string; name: string } | null,
  listPage: (..._args: unknown[]): Promise<ApiResult> => Promise.resolve({ success: true }),
  tapStats: (): Promise<ApiResult> => Promise.resolve({ success: true }),
}))

const groupItem = (id: string, name: string, monthlyStats?: { taps: number }) => ({
  id,
  accountId: 'account-a',
  name,
  chatBarText: 'メニュー',
  size: 'large',
  defaultPageId: null,
  isDefaultForAll: false,
  status: 'published',
  publishingAt: null,
  targetingCondition: null,
  targetingPriority: 0,
  targetingEnabled: false,
  folderId: null,
  displayOrder: 0,
  defaultOpen: false,
  thumbnailR2Key: null,
  updatedAt: '2026-09-20T00:00:00.000Z',
  ...(monthlyStats ? { monthlyStats: { from: '2026-09-01', to: '2026-10-01', taps: monthlyStats.taps, uniqueAudience: { value: null, state: 'none' } } } : {}),
})

const listResult = (items: unknown[]): ApiResult => ({
  success: true,
  data: {
    items,
    total: items.length,
    limit: 20,
    sort: [{ field: 'targeting_priority', direction: 'asc' }],
    facets: { total: items.length, published: items.length, targeting: 0, folderCounts: {} },
  },
})

const tapResult = (byGroup: { groupId: string; taps: number }[]): ApiResult => ({
  success: true,
  data: {
    from: '2026-09-01T00:00:00.000Z',
    to: '2026-10-01T00:00:00.000Z',
    total: byGroup.reduce((sum, row) => sum + row.taps, 0),
    byGroup,
    byArea: [],
  },
})

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccount: fixture.selectedAccount }),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => undefined, usePageCrumbs: () => undefined }))

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    status = 500
  },
  api: {
    richMenuGroups: {
      listPage: (...args: unknown[]) => fixture.listPage(...args),
      external: () => Promise.resolve({ success: true, data: { currentDefault: null, lineMenus: [] } }),
      tapStats: () => fixture.tapStats(),
    },
    folders: {
      list: () => Promise.resolve({ success: true, data: [], unfiledCount: 0 }),
    },
    // V8 一覧は役割をサーバ（/api/staff/me）から読む。
    staff: {
      me: () => Promise.resolve({ success: true, data: { id: 'staff-a', name: 'A', role: 'owner', email: null } }),
    },
    tags: {
      list: () => Promise.resolve({ success: true, data: [] }),
    },
  },
}))

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  window.history.replaceState({}, '', '/rich-menus')
  window.dispatchEvent(new PopStateEvent('popstate'))
  fixture.selectedAccount = { id: 'account-a', name: 'A社' }
})

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.theme
})

async function renderV8List() {
  const { default: RichMenusListPage } = await import('./page')
  return render(<RichMenusListPage />)
}

test('実数と記録開始後の人数を同じ行に表示する', async () => {
  const group = { ...groupItem('g1', '試験メニュー'), monthlyStats: { taps: 1234, uniqueAudience: { value: 567, state: 'partial' } } }
  fixture.listPage = () => Promise.resolve(listResult([group]))
  fixture.tapStats = () => Promise.resolve(tapResult([]))
  const rendered = await renderV8List()
  const name = await rendered.findByText('試験メニュー')
  const row = name.closest('tr') as HTMLElement
  expect(within(row).getByText('1,234回')).toBeTruthy()
  expect(within(row).getByTitle('のべ567 人（記録開始後）')).toBeTruthy()
})

test('取得失敗時は公開中と出し分けを0件とも件数確定とも見せない', async () => {
  fixture.listPage = () => Promise.reject(new Error('list failed'))
  fixture.tapStats = () => Promise.resolve(tapResult([]))
  const rendered = await renderV8List()
  const cards = rendered.container.querySelector<HTMLElement>('[data-design="KPIs"]')!
  await within(cards).findAllByText('一覧を読み込めませんでした')
  for (const label of ['公開中', '出し分け']) {
    const card = within(cards).getByText(label).closest('[data-kpi-presentation]') as HTMLElement
    expect(within(card).queryByText('0')).toBeNull()
    expect(card.querySelector('[data-kpi-unit]')).toBeNull()
    expect(within(card).getByText('一覧を読み込めませんでした')).toBeTruthy()
  }
})

test('初期状態は出す順番の先頭20件を取得する', async () => {
  const listPage = vi.fn(async (..._args: unknown[]) => listResult([groupItem('g1', '試験メニュー')]))
  fixture.listPage = listPage
  fixture.tapStats = () => Promise.resolve(tapResult([]))
  const rendered = await renderV8List()
  await rendered.findByText('試験メニュー')
  expect(listPage).toHaveBeenNthCalledWith(1, 'account-a', expect.objectContaining({ page: 1, limit: 20, sort: 'priority' }))
})
