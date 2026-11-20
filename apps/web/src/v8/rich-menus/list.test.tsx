// @vitest-environment happy-dom
/*
 * V8 リッチメニュー一覧（src/v8）の動きの試験。
 * - 行が出る（順番・状態の札・回数）
 * - 見るだけの人には帯が出て「メニューを作る」が押せない
 * - 消せないメニューの「削除」で「まだ消せません」の窓：
 *   理由は短く1行ずつ・取り下げで外れる2つ（登録中・LINE上に残る）は1行にまとめる・外す操作が右に出る
 */
import React from 'react'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

type ApiResult = { success: boolean; data?: unknown }

const fixture = vi.hoisted(() => ({
  role: 'owner',
  accountId: 'account-a',
  deleteExternal: vi.fn(async (_id: string, _accountId: string) => ({ success: true })),
  deleteImpact: (() => Promise.resolve({ success: false })) as (id: string) => Promise<ApiResult>,
}))

const group = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
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
  ...extra,
})

const items = [
  group('g-default', '通常メニュー', { isDefaultForAll: true, targetingPriority: 0, folderId: 'rmf-normal' }),
  group('g-autumn', '秋のキャンペーン', { status: 'draft', isDefaultForAll: true, publishingAt: '2027-10-05T00:00:00.000+09:00', targetingPriority: 1 }),
]

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccount: { id: fixture.accountId, name: 'A社' } }),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href, ...rest }, children),
}))

vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => undefined, usePageCrumbs: () => undefined }))

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    status = 500
  },
  api: {
    richMenuGroups: {
      listPage: () => Promise.resolve({
        success: true,
        data: {
          items,
          total: items.length,
          limit: 20,
          sort: [],
          facets: { total: items.length, published: 1, targeting: 0, folderCounts: {} },
        },
      }),
      external: () => Promise.resolve({ success: true, data: { currentDefault: null, lineMenus: [{ richMenuId: 'line-only', name: '外部メニュー', areasCount: 1, size: { width: 2500, height: 843 }, adminManaged: false }] } }),
      deleteExternal: (id: string, accountId: string) => fixture.deleteExternal(id, accountId),
      tapStats: () => Promise.resolve({
        success: true,
        data: { from: '2026-09-01', to: '2026-10-01', total: 12, byGroup: [{ groupId: 'g-default', taps: 12 }], byArea: [{ groupId: 'g-default', pageId: 'p1', areaId: 'a1', label: '商品を見る', taps: 12 }] },
      }),
      deleteImpact: (id: string) => fixture.deleteImpact(id),
      imageUrl: (key: string) => `/img/${key}`,
    },
    folders: {
      list: () => Promise.resolve({
        success: true,
        data: [{ id: 'rmf-normal', kind: 'rich_menu', name: '通常', parentId: null, displayOrder: 1, color: '#2f6fde' }],
        unfiledCount: 1,
      }),
    },
    tags: { list: () => Promise.resolve({ success: true, data: [] }) },
    staff: {
      me: () => Promise.resolve({ success: true, data: { id: 's', name: 'S', role: fixture.role, email: null } }),
    },
  },
}))

import RichMenusListV8 from './list'

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  fixture.role = 'owner'
  fixture.accountId = 'account-a'
  fixture.deleteExternal.mockReset().mockResolvedValue({ success: true })
  window.history.replaceState({}, '', '/rich-menus')
  window.dispatchEvent(new PopStateEvent('popstate'))
})

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.theme
})

describe('V8 リッチメニュー一覧', () => {
  test('公開中の数から、統括からの配布との違いを確認できる', async () => {
    const view = render(<RichMenusListV8 />)
    const help = await view.findByRole('button', { name: '公開中の説明' })
    fireEvent.click(help)
    expect(document.getElementById(help.getAttribute('aria-describedby')!)?.textContent).toContain('LINEへの公開は各アカウントで行います')
  })
  async function openExternal(view: ReturnType<typeof render>) {
    await view.findByText('通常メニュー')
    fireEvent.click(view.getByRole('button', { name: /LINE上にあるメニュー/ }))
    await view.findByRole('button', { name: 'LINE上の「外部メニュー」の操作' })
    fireEvent.click(view.getByRole('button', { name: 'LINE上の「外部メニュー」の操作' }))
    fireEvent.click(await view.findByText('LINEから削除する'))
    return view.findByRole('alertdialog')
  }

  test('LINE側だけのメニューは確認後に同じ店のAPIで削除する', async () => {
    const view = render(<RichMenusListV8 />)
    const dialog = await openExternal(view)
    expect(dialog.textContent).toContain('元に戻せません。')
    expect(fixture.deleteExternal).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: '削除する' }))
    await waitFor(() => expect(fixture.deleteExternal).toHaveBeenCalledWith('line-only', 'account-a'))
  })

  test('店切替は外部メニューの削除確認を捨て、新しい店へ削除を送らない', async () => {
    const view = render(<RichMenusListV8 />)
    await openExternal(view)
    fixture.accountId = 'account-b'
    view.rerender(<RichMenusListV8 />)
    await waitFor(() => expect(view.queryByRole('alertdialog')).toBeNull())
    expect(fixture.deleteExternal).not.toHaveBeenCalled()
  })

  test('閲覧だけでは外部メニューの削除操作を出さない', async () => {
    fixture.role = 'staff'
    window.history.replaceState({}, '', '/rich-menus?showExternal=true')
    window.dispatchEvent(new PopStateEvent('popstate'))
    const view = render(<RichMenusListV8 />)
    await view.findByText('選んだメニューの中身')
    await act(async () => {})
    expect(view.queryByRole('button', { name: 'LINE上の「外部メニュー」の操作' })).toBeNull()
    expect(fixture.deleteExternal).not.toHaveBeenCalled()
  })
  test('行に順番・状態の札・今月の回数が出る（集計の無い行は「—」）', async () => {
    const view = render(<RichMenusListV8 />)
    const first = (await view.findByText('通常メニュー')).closest('tr') as HTMLElement
    expect(within(first).getByText('公開中').closest('[aria-hidden="true"]')).toBeNull()
    expect(first.textContent).toContain('12回')
    expect(first.textContent).toContain('（既定）')
    const second = view.getByText('秋のキャンペーン').closest('tr') as HTMLElement
    expect(second.textContent).toContain('予約中2027/10/05')
    expect(second.textContent).toContain('10/05 から既定')
    expect(second.textContent).toContain('—')
    expect(within(second).getByText('予約中').closest('[aria-hidden="true"]')).toBeNull()
    expect(second.closest('[data-column-sizing]')?.getAttribute('data-column-sizing')).toBe('controls')
  })

  test('行の名前の前に、左のフォルダの列と同じ色の丸が付き、未分類にも灰色の丸を出す', async () => {
    const view = render(<RichMenusListV8 />)
    const filedRow = (await view.findByText('通常メニュー')).closest('tr') as HTMLElement
    await waitFor(() => expect(filedRow.querySelector('[data-folder-dot]')?.getAttribute('data-folder-dot')).toBe('filed'))
    expect(filedRow.querySelectorAll('[data-folder-dot]')).toHaveLength(1)
    expect(filedRow.querySelector('[data-folder-dot]')?.getAttribute('aria-label')).toBe('フォルダ：通常')
    const unfiledRow = view.getByText('秋のキャンペーン').closest('tr') as HTMLElement
    expect(unfiledRow.querySelectorAll('[data-folder-dot]')).toHaveLength(1)
    expect(unfiledRow.querySelector('[data-folder-dot]')?.getAttribute('data-folder-dot')).toBe('unfiled')
    expect(unfiledRow.querySelector('[data-folder-dot]')?.getAttribute('aria-label')).toBe('フォルダ：未分類')
  })

  // 2026-10-06 オーナー決定：閲覧のみには押せないボタンを置かずに隠す（帯は出す）。
  test('見るだけの人には閲覧のみの帯が出て、メニューを作るは出さない', async () => {
    fixture.role = 'staff'
    const view = render(<RichMenusListV8 />)
    await view.findByText('この画面を変える権限がありません。変えたい時はオーナーか管理者に頼んでください。')
    const create = view.getAllByRole('button', { name: /メニューを作る/ })
    expect(create.every(button => button.getAttribute('aria-disabled') === 'true')).toBe(true)
    fireEvent.click(create[0])
    expect(view.queryByRole('dialog')).toBeNull()
  })

  test('消せないメニューは「まだ消せません」の窓で、理由を短く・取り下げで外れる2つを1行に並べる', async () => {
    fixture.deleteImpact = (id) => Promise.resolve({
      success: true,
      data: {
        group: { id, accountId: 'account-a', name: '通常メニュー', status: 'published' },
        currentAudience: { value: 1204, state: 'available', reason: null },
        nextDisplay: { guaranteedGroupId: null, reason: 'friend_specific_rules', candidates: [] },
        incomingSwitches: [{ sourceGroupId: 'g-x', sourceGroupName: '会員ランク上位', sourcePageId: 'p', sourcePageName: 'トップ', areaId: 'a', areaLabel: null, targetPageId: 't', targetPageName: 'トップ' }],
        operationalReferences: [],
        lineResources: { pageCount: 1, pagesWithLineRichMenuId: 1, isDefaultForAll: true, publishing: false },
        blockers: ['default_for_all', 'published', 'line_resources', 'incoming_switches'],
        canDelete: false,
        recommendedAction: 'unpublish',
      },
    })
    const view = render(<RichMenusListV8 />)
    await view.findByText('通常メニュー')
    fireEvent.click(view.getByRole('button', { name: 'リッチメニュー「通常メニュー」の操作' }))
    fireEvent.click(await view.findByText('取り下げ・削除する'))
    const dialog = await view.findByRole('alertdialog')
    expect(dialog.textContent).toContain('「通常メニュー」はまだ消せません')
    expect(dialog.textContent).toContain('このメニューを消すと、リッチメニューが出なくなる友だちがいます。先に下の順に外してください。')
    await waitFor(() => expect(dialog.querySelectorAll('li').length).toBe(3))
    const rows = [...dialog.querySelectorAll('li')].map((li) => li.textContent)
    expect(rows).toEqual([
      '1 すべての友だちの既定になっているほかのメニューを既定に',
      '2 LINEに登録されているLINEから取り下げる',
      '3 「会員ランク上位」の切替先になっている切替を外す',
    ])
    // 閉じる操作は右上の×へ統一。
    // 読み込み中に出ていた確認窓は閉じの動き（160ms）のあと外れる。
    await waitFor(() => expect(view.getAllByRole('button', { name: '閉じる' }).length).toBe(1))
  })
})

test('押されたボタンが分かるときは回数を未知の数にせず、予約日は状態の下に出す', async () => {
  const view = render(<RichMenusListV8 />)
  await waitFor(() => {
    const label = [...view.container.querySelectorAll('[data-kpi-label]')].find(el => el.textContent?.includes('いちばん押された'))
    const card = label?.closest('[data-kpi-presentation]')
    expect(card?.querySelector('[data-kpi-text-value]')?.textContent).toBe('商品を見る')
    expect(card?.querySelector('[data-kpi-number]')).toBeNull()
    expect(card?.querySelector('[data-kpi-detail]')?.textContent).toContain('12 回')
  })
  const scheduled = await view.findByText('予約中')
  expect(scheduled.textContent).not.toContain('10/05')
  expect(scheduled.closest('td')?.textContent).toContain('10/05')
})
