// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({
  accountId: 'account-a' as string | null,
  listPage: vi.fn(),
  foldersList: vi.fn(),
  tapStats: vi.fn(),
  tagsList: vi.fn(),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccount: fx.accountId ? { id: fx.accountId, name: fx.accountId } : null,
    selectedAccountId: fx.accountId,
    accounts: [],
    loading: false,
  }),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
  usePathname: () => '/rich-menus',
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href, ...rest }, children),
}))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => undefined,
  usePageCrumbs: () => undefined,
}))

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    status = 500
  },
  api: {
    richMenuGroups: {
      listPage: fx.listPage,
      external: vi.fn().mockResolvedValue({ success: true, data: { currentDefault: null, lineMenus: [] } }),
      tapStats: fx.tapStats,
      deleteImpact: vi.fn().mockResolvedValue({ success: false }),
      imageUrl: (key: string) => `/img/${key}`,
    },
    folders: { list: fx.foldersList },
    tags: { list: fx.tagsList },
    staff: { me: vi.fn().mockResolvedValue({ success: true, data: { id: 's1', name: 'S', role: 'owner', email: null } }) },
  },
}))

import RichMenusListV8 from './list'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function makeGroup(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    accountId: fx.accountId ?? 'account-a',
    name,
    chatBarText: 'メニュー',
    size: 'large',
    defaultPageId: 'p1',
    defaultPageAreaCount: 6,
    pageCount: 1,
    isDefaultForAll: false,
    status: 'published',
    publishingAt: null,
    targetingCondition: null,
    targetingPriority: 0,
    targetingEnabled: false,
    audienceCount: null,
    folderId: null,
    displayOrder: 0,
    defaultOpen: false,
    thumbnailR2Key: null,
    updatedAt: '2026-11-28T00:00:00.000Z',
    ...extra,
  }
}

function makeListResponse(items: ReturnType<typeof makeGroup>[]) {
  return {
    success: true,
    data: {
      items,
      total: items.length,
      limit: 20,
      sort: [],
      facets: { total: items.length, published: items.length, targeting: 0, folderCounts: {} },
    },
  }
}

describe('RichMenusListV8 一覧・フォルダ競合破棄と異常形状・人数防御', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    document.documentElement.dataset.theme = 'v8'
    fx.accountId = 'account-a'
    fx.listPage.mockResolvedValue(makeListResponse([]))
    fx.foldersList.mockResolvedValue({ success: true, data: [] })
    fx.tapStats.mockResolvedValue({ success: true, data: { from: '2026-11-01', to: '2026-11-28', total: 0, byGroup: [], byArea: [] } })
    fx.tagsList.mockResolvedValue({ success: true, data: [] })
    window.history.replaceState({}, '', '/rich-menus')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })

  afterEach(() => {
    cleanup()
    delete document.documentElement.dataset.theme
  })

  it('同一アカウント内で絞り込みを切り替えた後に届いた古い一覧応答で新しい一覧を上書きしない', async () => {
    const first = deferred<ReturnType<typeof makeListResponse>>()
    const second = deferred<ReturnType<typeof makeListResponse>>()
    fx.listPage
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    render(<RichMenusListV8 />)
    await waitFor(() => expect(fx.listPage).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: '公開中' }))
    await waitFor(() => expect(fx.listPage).toHaveBeenCalledTimes(2))

    await act(async () => { second.resolve(makeListResponse([makeGroup('g-new', '新しい公開メニュー')])) })
    expect(await screen.findByText('新しい公開メニュー')).toBeTruthy()

    await act(async () => { first.resolve(makeListResponse([makeGroup('g-old', '古い全件メニュー')])) })
    expect(screen.queryByText('古い全件メニュー')).toBeNull()
    expect(screen.getByText('新しい公開メニュー')).toBeTruthy()
  })

  it('アカウント切替後に前のアカウントのフォルダ応答が遅れて返ってもフォルダ一覧を上書きしない', async () => {
    const firstFolders = deferred<{ success: true; data: unknown[] }>()
    const secondFolders = deferred<{ success: true; data: unknown[] }>()
    fx.foldersList
      .mockReturnValueOnce(firstFolders.promise)
      .mockReturnValueOnce(secondFolders.promise)

    const view = render(<RichMenusListV8 />)
    await waitFor(() => expect(fx.foldersList).toHaveBeenCalledWith('rich_menu', 'account-a'))

    fx.accountId = 'account-b'
    view.rerender(<RichMenusListV8 />)
    await waitFor(() => expect(fx.foldersList).toHaveBeenCalledWith('rich_menu', 'account-b'))

    await act(async () => {
      secondFolders.resolve({
        success: true,
        data: [{ id: 'f-b', kind: 'rich_menu', name: 'B店のフォルダ', parentId: null, displayOrder: 1, color: '#2f6fde' }],
      })
    })
    expect(await screen.findByText('B店のフォルダ')).toBeTruthy()

    await act(async () => {
      firstFolders.resolve({
        success: true,
        data: [{ id: 'f-a', kind: 'rich_menu', name: 'A店の古いフォルダ', parentId: null, displayOrder: 1, color: '#2f6fde' }],
      })
    })
    expect(screen.queryByText('A店の古いフォルダ')).toBeNull()
    expect(screen.getByText('B店のフォルダ')).toBeTruthy()
  })

  it('未知サイズ・異常ボタン数・負数の対象人数を誤表記せず安全に表示する', async () => {
    fx.listPage.mockResolvedValue(makeListResponse([
      makeGroup('g-odd', '異常値メニュー', {
        size: 'extra_large',
        defaultPageAreaCount: Number.POSITIVE_INFINITY,
        pageCount: -2,
        targetingEnabled: true,
        targetingCondition: JSON.stringify({ rules: [] }),
        audienceCount: -5,
      }),
    ]))

    render(<RichMenusListV8 />)
    expect(await screen.findByText('異常値メニュー')).toBeTruthy()
    expect(screen.getByText('サイズ不明')).toBeTruthy()
    expect(screen.getByText('対象の人数は未取得')).toBeTruthy()
    expect(screen.queryByText(/Infinity/)).toBeNull()
    expect(screen.queryByText(/対象 -5 人/)).toBeNull()
  })
})
