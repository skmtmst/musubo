// @vitest-environment happy-dom
/*
 * V8 リッチメニュー一覧の、検索・並び替え・複製・失敗の文・板の印の動きの試験。
 * - 検索は「メニュー名・ボタン名」で探し、道具の段は検索→絞り込み→並び順・件数の順
 * - 読み込み・並び替え・削除・取り下げ・LINEからの削除・取り込みの失敗は、内部の文を出さず操作ごとの文にする
 * - 並び替えは隠れている行も含めて1回で送る
 * - 複製は二重に送らず、取り直した一覧で元の行のすぐ下に出す
 * - 板の印（広い・狭い・閲覧のみ）と、狭い板でフォルダの列を畳む
 * - 消せない窓は「閉じる」だけで、外す順の番号つきの並び
 */
import React from 'react'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const mocks = vi.hoisted(() => ({
  role: 'owner',
  narrow: false,
  listPage: vi.fn(),
  reorder: vi.fn(),
  duplicate: vi.fn(),
  deleteImpact: vi.fn(),
  remove: vi.fn(),
  unpublish: vi.fn(),
  deleteExternal: vi.fn(),
  importFromLine: vi.fn(),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccount: { id: 'account-a', name: '本店' }, selectedAccountId: 'account-a', loading: false }),
  useOptionalAccount: () => ({ selectedAccountId: 'account-a', loading: false }),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, refresh: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/rich-menus',
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href, ...rest }, children),
}))

vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => mocks.narrow }))

vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => undefined, usePageCrumbs: () => undefined }))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ApiError: actual.ApiError,
    api: {
      richMenuGroups: {
        listPage: (...args: unknown[]) => mocks.listPage(...args),
        reorderPriorities: (...args: unknown[]) => mocks.reorder(...args),
        duplicate: (...args: unknown[]) => mocks.duplicate(...args),
        external: () => Promise.resolve({
          success: true,
          data: { currentDefault: null, lineMenus: [{ richMenuId: 'line-only', name: '外部メニュー', areasCount: 1, size: { width: 2500, height: 843 }, adminManaged: false }] },
        }),
        tapStats: () => Promise.resolve({ success: true, data: { from: '2026-10-01', to: '2026-11-01', total: 0, byGroup: [], byArea: [] } }),
        deleteImpact: (...args: unknown[]) => mocks.deleteImpact(...args),
        delete: (...args: unknown[]) => mocks.remove(...args),
        unpublish: (...args: unknown[]) => mocks.unpublish(...args),
        deleteExternal: (...args: unknown[]) => mocks.deleteExternal(...args),
        importFromLine: (...args: unknown[]) => mocks.importFromLine(...args),
        imageUrl: (key: string) => `/img/${key}`,
      },
      folders: { list: () => Promise.resolve({ success: true, data: [], unfiledCount: 0 }) },
      tags: { list: () => Promise.resolve({ success: true, data: [] }) },
      staff: { me: () => Promise.resolve({ success: true, data: { id: 'owner-1', name: 'O', role: mocks.role, email: null } }) },
    },
  }
})

import { ApiError } from '@/lib/api'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'
import { richMenuError } from './errors'
import RichMenusListV8 from './list'

const group = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  accountId: 'account-a',
  name,
  chatBarText: 'メニュー',
  size: 'large',
  defaultPageId: null,
  isDefaultForAll: false,
  status: 'draft',
  version: 7,
  publishingAt: null,
  targetingCondition: { operator: 'AND', rules: [] },
  targetingPriority: 0,
  targetingEnabled: true,
  folderId: null,
  displayOrder: 0,
  defaultOpen: false,
  thumbnailR2Key: null,
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...extra,
})

const FIRST = group('g-1', '秋の下書き', { targetingPriority: 0 })
const SECOND = group('g-2', '冬の下書き', { targetingPriority: 1 })
const PUBLISHED = group('g-pub', '通常メニュー', { status: 'published', targetingPriority: 2 })

function listResult(items: unknown[], total = items.length) {
  return {
    success: true,
    data: { items, total, limit: 20, sort: [], facets: { total, published: 1, targeting: total, folderCounts: {} } },
  }
}

function impact(groupId: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    group: { id: groupId, accountId: 'account-a', name: groupId === 'g-pub' ? '通常メニュー' : 'x', status, version:1, publishingGeneration:0 },
    currentAudience: { value: 0, state: 'available', reason: null },
    nextDisplay: { guaranteedGroupId: null, reason: 'no_fallback', candidates: [] },
    incomingSwitches: [],
    operationalReferences: [],
    lineResources: { pageCount: 1, pagesWithLineRichMenuId: 0, isDefaultForAll: false, publishing: false, pages:[{id:'page-1',orderIndex:0,lineRichMenuId:'line-1'}] },
    blockers: [],
    canDelete: true,
    recommendedAction: status === 'published' ? 'unpublish' : 'delete',
    ...extra,
  }
}

const INTERNAL = 'LINE 公式アカウントの状態取得に失敗しました: D1_ERROR no such column'

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  mocks.role = 'owner'
  mocks.narrow = false
  mocks.listPage.mockReset().mockResolvedValue(listResult([FIRST, SECOND, PUBLISHED]))
  mocks.reorder.mockReset().mockResolvedValue({ success: true })
  mocks.duplicate.mockReset()
  mocks.deleteImpact.mockReset().mockImplementation(async (id: string) => ({
    success: true,
    data: impact(id, id === 'g-pub' ? 'published' : 'draft'),
  }))
  mocks.remove.mockReset().mockResolvedValue({ success: true })
  mocks.unpublish.mockReset().mockResolvedValue({ success: true })
  mocks.deleteExternal.mockReset().mockResolvedValue({ success: true })
  mocks.importFromLine.mockReset().mockResolvedValue({ success: true, data: { id: 'g-new', name: '取り込んだメニュー' } })
  window.history.replaceState({}, '', '/rich-menus')
  window.dispatchEvent(new PopStateEvent('popstate'))
})

afterEach(() => {
  cleanup()
  clearToastsForTest()
  delete document.documentElement.dataset.theme
})

function renderList() {
  return render(<><RichMenusListV8 /><ToastHost /></>)
}

async function openRowMenu(view: ReturnType<typeof render>, name: string) {
  await view.findByText(name)
  fireEvent.click(view.getByRole('button', { name: `リッチメニュー「${name}」の操作` }))
}

async function pick(view: ReturnType<typeof render>, name: string, label: string) {
  await openRowMenu(view, name)
  fireEvent.click(await view.findByRole('menuitem', { name: label }))
}

function findDialog(title: RegExp): Promise<HTMLElement> {
  return waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')]
      .find((node) => title.test(node.textContent ?? ''))
    if (!found) throw new Error(`窓が開いていません: ${title}`)
    return found
  })
}

function openDialog(): Promise<HTMLElement> {
  return waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')].at(-1)
    if (!found) throw new Error('窓が開いていません')
    return found
  })
}

const boardOf = (view: ReturnType<typeof render>) =>
  view.container.querySelector('[data-page-template]')?.getAttribute('data-design-node') ?? null

describe('検索と道具の段', () => {
  test('検索は「メニュー名・ボタン名」で探し、入れた言葉を1ページ目から一覧の口へ渡す', async () => {
    const view = renderList()
    await view.findByText('秋の下書き')
    const search = view.getByRole('searchbox', { name: 'メニュー名・ボタン名で探す' }) as HTMLInputElement
    expect(search.placeholder).toBe('メニュー名・ボタン名')
    fireEvent.change(search, { target: { value: 'クーポン' } })
    await waitFor(() => expect(mocks.listPage).toHaveBeenLastCalledWith('account-a', expect.objectContaining({ query: 'クーポン', page: 1 })))
  })

  test('道具の段は検索→絞り込み→並び順→表示件数の順に並ぶ', async () => {
    const view = renderList()
    await view.findByText('秋の下書き')
    const order = [
      view.getByRole('searchbox', { name: 'メニュー名・ボタン名で探す' }),
      view.container.querySelector('[aria-label="絞り込み"]'),
      view.getByRole('button', { name: '並び' }),
      view.getByRole('button', { name: '1ページに出す件数' }),
    ]
    order.forEach((node) => expect(node).not.toBeNull())
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
  })
})

describe('失敗の文', () => {
  test('読み込めないときは内部の文を出さず、読み込めなかったと言う', async () => {
    mocks.listPage.mockRejectedValue(new ApiError(500, INTERNAL))
    const view = renderList()
    await view.findByText('リッチメニューを読み込めませんでした')
    expect(document.body.textContent).not.toContain('D1_ERROR')
    expect(document.body.textContent).not.toContain('状態取得に失敗しました:')
  })

  test('権限が無くて読めないときは、通信の失敗と言わず権限の文にする', async () => {
    mocks.listPage.mockRejectedValue(new ApiError(403, INTERNAL))
    const view = renderList()
    await waitFor(() => expect(document.body.textContent).toMatch(/権限/))
    expect(view.queryByText('リッチメニューを読み込めませんでした')).toBeNull()
    expect(document.body.textContent).not.toContain('D1_ERROR')
  })

  test('並び替えが断られたら「順番を変えられませんでした」と知らせる', async () => {
    mocks.reorder.mockResolvedValue({ success: false, error: INTERNAL })
    const view = renderList()
    await view.findByText('秋の下書き')
    await act(async () => { fireEvent.keyDown(view.getByRole('button', { name: '秋の下書きを並び替え。上下キーで移動' }), { key: 'ArrowDown' }) })
    await view.findByText(/順番を変えられませんでした。通信を確かめて、もう一度お試しください。/)
    expect(document.body.textContent).not.toContain('D1_ERROR')
  })

  test('下書きの削除が競合で断られたら「使用中」と言い、削除の口だけへ送る', async () => {
    mocks.remove.mockRejectedValue(new ApiError(409, INTERNAL))
    const view = renderList()
    await pick(view, '秋の下書き', '削除する')
    const dialog = await openDialog()
    fireEvent.click(await within(dialog).findByRole('button', { name: '削除する' }))
    await waitFor(() => expect(dialog.textContent).toContain(richMenuError(new ApiError(409, 'Conflict'), 'delete')))
    expect(dialog.textContent).toContain('使用中のため削除できませんでした')
    expect(mocks.remove).toHaveBeenCalledWith('g-1', 7)
    expect(mocks.unpublish).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('D1_ERROR')
  })

  test('公開中は取り下げの口へ送り、失敗は取り下げの文にする', async () => {
    mocks.unpublish.mockRejectedValue(new Error(INTERNAL))
    const view = renderList()
    await pick(view, '通常メニュー', '取り下げ・削除する')
    const dialog = await openDialog()
    fireEvent.click(await within(dialog).findByRole('button', { name: /LINEから取り下げる/ }))
    await waitFor(() => expect(dialog.textContent).toContain(richMenuError(new Error('x'), 'unpublish')))
    expect(mocks.unpublish).toHaveBeenCalledWith('g-pub',{expectedVersion:1,expectedPublishGeneration:0,expectedIsDefaultForAll:false,expectedPages:[{id:'page-1',orderIndex:0,lineRichMenuId:'line-1'}]})
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('D1_ERROR')
  })

  test('公開内容が変わった409では確認を閉じ、途中まで進んだ可能性を知らせる',async()=>{
    mocks.unpublish.mockRejectedValue(new ApiError(409,'changed','RICH_MENU_CONFIRMATION_CHANGED',{partial:true}))
    const view=renderList()
    await pick(view,'通常メニュー','取り下げ・削除する')
    const dialog=await openDialog()
    fireEvent.click(await within(dialog).findByRole('button',{name:/LINEから取り下げる/}))
    await waitFor(()=>expect(document.body.textContent).toContain('一部の取り下げが進んだ可能性があります'))
    expect(document.body.contains(dialog)).toBe(false)
    expect(mocks.unpublish).toHaveBeenCalledTimes(1)
  })

  test('LINEに触れる前の409は途中まで進んだと案内しない',async()=>{
    mocks.unpublish.mockRejectedValue(new ApiError(409,'changed','RICH_MENU_CONFIRMATION_CHANGED',{partial:false}))
    const view=renderList()
    await pick(view,'通常メニュー','取り下げ・削除する')
    const dialog=await openDialog()
    fireEvent.click(await within(dialog).findByRole('button',{name:/LINEから取り下げる/}))
    await waitFor(()=>expect(document.body.textContent).toContain('公開内容が変わりました。最新の状態を確認してください。'))
    expect(document.body.textContent).not.toContain('一部の取り下げが進んだ可能性があります')
  })

  test('LINEからの削除と取り込みの失敗は、それぞれの文にする', async () => {
    mocks.deleteExternal.mockRejectedValue(new Error(INTERNAL))
    mocks.importFromLine.mockRejectedValue(new Error(INTERNAL))
    const view = renderList()
    await view.findByText('秋の下書き')
    fireEvent.click(view.getByRole('button', { name: /LINE上にあるメニュー/ }))
    const external = await view.findByRole('button', { name: 'LINE上の「外部メニュー」の操作' })
    fireEvent.click(external)
    fireEvent.click(await view.findByText('LINEから削除する'))
    const removeDialog = await openDialog()
    fireEvent.click(within(removeDialog).getByRole('button', { name: /削除/ }))
    await waitFor(() => expect(removeDialog.textContent).toContain(richMenuError(new Error('x'), 'externalDelete')))
    fireEvent.click(within(removeDialog).getAllByRole('button', { name: /キャンセル|閉じる/ })[0])
    await waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull())

    fireEvent.click(await view.findByRole('button', { name: 'この内容で取り込む' }))
    const importDialog = await findDialog(/管理画面に取り込みますか/)
    fireEvent.click(within(importDialog).getByRole('button', { name: '管理画面に取り込む' }))
    await waitFor(() => expect(importDialog.textContent).toContain(richMenuError(new Error('x'), 'import')))
    expect(importDialog.textContent).toContain('LINE上のリッチメニューを取り込めませんでした。')
    expect(document.body.textContent).not.toContain('D1_ERROR')
  })
})

describe('並び替えと複製', () => {
  test('並び替えは全部の順番を1回で送る（1件ずつ送らない）', async () => {
    const view = renderList()
    await view.findByText('秋の下書き')
    await act(async () => { fireEvent.keyDown(view.getByRole('button', { name: '秋の下書きを並び替え。上下キーで移動' }), { key: 'ArrowDown' }) })
    await waitFor(() => expect(mocks.reorder).toHaveBeenCalledTimes(1))
    expect(mocks.reorder).toHaveBeenCalledWith('account-a', ['g-2', 'g-1', 'g-pub'])
  })

  test('複製は待っている間に押し直しても1回だけ送り、取り直した一覧で元の行のすぐ下に出す', async () => {
    let finish!: (value: unknown) => void
    mocks.duplicate.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const view = renderList()
    await pick(view, '秋の下書き', '複製する')
    await pick(view, '秋の下書き', '複製する')
    expect(mocks.duplicate).toHaveBeenCalledTimes(1)
    expect(mocks.duplicate.mock.calls[0][0]).toBe('g-1')
    const loadsBefore = mocks.listPage.mock.calls.length
    const COPY = group('g-copy', '秋の下書き（コピー）', { targetingPriority: 3 })
    mocks.listPage.mockResolvedValue(listResult([FIRST, SECOND, PUBLISHED, COPY]))
    await act(async () => { finish({ success: true, data: { id: 'g-copy' } }) })
    await view.findByText('秋の下書き（コピー）')
    expect(mocks.listPage.mock.calls.length).toBeGreaterThan(loadsBefore)
    await view.findByText('複製しました')
    const names = [...view.container.querySelectorAll('tbody tr')].map((row) => row.textContent ?? '')
    const source = names.findIndex((text) => text.includes('秋の下書き') && !text.includes('コピー'))
    expect(names[source + 1]).toContain('秋の下書き（コピー）')
  })
})

describe('板の印', () => {
  test('広い板は広い板の印を付け、左にフォルダの列を出す', async () => {
    const view = renderList()
    await view.findByText('秋の下書き')
    await waitFor(() => expect(boardOf(view)).toBe('rZEGN'))
    expect(view.container.querySelector('[data-template-region="folders"]')).not.toBeNull()
  })

  test('閲覧のみの人には閲覧のみの板の印を付ける', async () => {
    mocks.role = 'staff'
    const view = renderList()
    await view.findByText('秋の下書き')
    await waitFor(() => expect(boardOf(view)).toBe('ZoKow'))
  })

  test('狭い板は狭い板の印を付け、フォルダの列を畳む', async () => {
    mocks.narrow = true
    const view = renderList()
    await view.findByText('秋の下書き')
    await waitFor(() => expect(boardOf(view)).toBe('Y9ASp'))
    // 列は共通型のコンテナ幅 CSS が畳み、追加窓の状態を保つため部品は残す。
    expect(view.container.querySelector('[data-template-region="folders"]')).not.toBeNull()
  })

  test('狭い板でも畳んだフォルダ欄から追加の窓を開ける', async () => {
    mocks.narrow = true
    const view = renderList()
    await view.findByText('秋の下書き')
    fireEvent.click(view.getByRole('button', { name: 'フォルダ' }))
    const menu = document.querySelector('[data-select-menu]') as HTMLElement
    fireEvent.click(within(menu).getByRole('button', { name: 'フォルダを追加' }))
    expect(await view.findByRole('textbox', { name: 'フォルダ名' })).toBeTruthy()
  })
})

describe('消せない理由の窓', () => {
  test('取消は「閉じる」だけで、外す順を番号つきの並びで出す', async () => {
    mocks.deleteImpact.mockImplementation(async (id: string) => ({
      success: true,
      data: impact(id, 'published', {
        blockers: ['published', 'line_resources'],
        canDelete: false,
        lineResources: { pageCount: 1, pagesWithLineRichMenuId: 1, isDefaultForAll: false, publishing: false },
      }),
    }))
    const view = renderList()
    await pick(view, '通常メニュー', '取り下げ・削除する')
    const dialog = await findDialog(/「通常メニュー」はまだ消せません/)
    await waitFor(() => expect(dialog.querySelectorAll('ol > li').length).toBeGreaterThan(0))
    expect(within(dialog).queryByRole('button', { name: 'キャンセル' })).toBeNull()
    expect(within(dialog).getAllByRole('button', { name: '閉じる' }).length).toBeGreaterThan(0)
  })
})
