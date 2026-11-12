// @vitest-environment happy-dom
/*
 * V8 リッチメニュー一覧の、消す・取り下げる・取り込む・0件・ページの動きの試験。
 * - 削除の影響は窓を開けてから読み、読めないときは消させない
 * - 遅れて返った影響・取り込みの結果を、いまの窓やアカウントへ映さない
 * - 公開中は取り下げ、下書きは削除へ送る。失敗は窓の中の安全な文にする
 * - 絞り込み0件と、まだ1件も無い0件を言い分ける
 */
import React from 'react'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

type Result = { success: boolean; data?: unknown; error?: string }

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const mocks = vi.hoisted(() => ({
  accountId: 'account-a',
  role: 'owner',
  narrow: false,
  push: vi.fn(),
  listPage: vi.fn(),
  deleteImpact: vi.fn(),
  remove: vi.fn(),
  unpublish: vi.fn(),
  importFromLine: vi.fn(),
  external: vi.fn(),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccount: { id: mocks.accountId, name: '本店' }, selectedAccountId: mocks.accountId, loading: false }),
  useOptionalAccount: () => ({ selectedAccountId: mocks.accountId, loading: false }),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push, replace: () => {}, back: () => {}, refresh: () => {}, prefetch: () => {} }),
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
        external: (...args: unknown[]) => mocks.external(...args),
        tapStats: () => Promise.resolve({ success: true, data: { from: '2026-10-01', to: '2026-11-01', total: 0, byGroup: [], byArea: [] } }),
        deleteImpact: (...args: unknown[]) => mocks.deleteImpact(...args),
        delete: (...args: unknown[]) => mocks.remove(...args),
        unpublish: (...args: unknown[]) => mocks.unpublish(...args),
        importFromLine: (...args: unknown[]) => mocks.importFromLine(...args),
        deleteExternal: () => Promise.resolve({ success: true }),
        imageUrl: (key: string) => `/img/${key}`,
      },
      folders: { list: () => Promise.resolve({ success: true, data: [], unfiledCount: 0 }) },
      tags: { list: () => Promise.resolve({ success: true, data: [] }) },
      staff: { me: () => Promise.resolve({ success: true, data: { id: 'owner-1', name: 'O', role: mocks.role, email: null } }) },
    },
  }
})

import { ApiError } from '@/lib/api'
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
  targetingCondition: null,
  targetingPriority: 0,
  targetingEnabled: false,
  folderId: null,
  displayOrder: 0,
  defaultOpen: false,
  thumbnailR2Key: null,
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...extra,
})

const DRAFT = group('g-draft', '秋の下書き', { targetingPriority: 0 })
const OTHER = group('g-other', '冬の下書き', { targetingPriority: 1 })
const PUBLISHED = group('g-pub', '通常メニュー', { status: 'published', targetingPriority: 2 })

function listResult(items: unknown[], total = items.length): Result {
  return {
    success: true,
    data: { items, total, limit: 20, sort: [], facets: { total, published: 1, targeting: 0, folderCounts: {} } },
  }
}

function impact(groupId: string, extra: Record<string, unknown> = {}) {
  return {
    group: { id: groupId, accountId: 'account-a', name: groupId === 'g-pub' ? '通常メニュー' : 'x', status: groupId === 'g-pub' ? 'published' : 'draft', version:1, publishingGeneration:0 },
    currentAudience: { value: 0, state: 'available', reason: null },
    nextDisplay: { guaranteedGroupId: null, reason: 'no_fallback', candidates: [] },
    incomingSwitches: [],
    operationalReferences: [],
    lineResources: { pageCount: 1, pagesWithLineRichMenuId: 0, isDefaultForAll: false, publishing: false, pages:[{id:'page-1',orderIndex:0,lineRichMenuId:'line-1'}] },
    blockers: [],
    canDelete: true,
    recommendedAction: 'delete',
    ...extra,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function setUrl(search = '') {
  window.history.replaceState({}, '', `/rich-menus${search}`)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  mocks.accountId = 'account-a'
  mocks.role = 'owner'
  mocks.narrow = false
  mocks.push.mockReset()
  mocks.listPage.mockReset().mockResolvedValue(listResult([DRAFT, OTHER, PUBLISHED]))
  mocks.deleteImpact.mockReset().mockImplementation(async (id: string) => ({ success: true, data: impact(id) }))
  mocks.remove.mockReset().mockResolvedValue({ success: true })
  mocks.unpublish.mockReset().mockResolvedValue({ success: true })
  mocks.importFromLine.mockReset().mockResolvedValue({ success: true, data: { id: 'g-new', name: '取り込んだメニュー' } })
  mocks.external.mockReset().mockResolvedValue({
    success: true,
    data: { currentDefault: null, lineMenus: [{ richMenuId: 'line-only', name: '外部メニュー', areasCount: 1, size: { width: 2500, height: 843 }, adminManaged: false }] },
  })
  setUrl()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.theme
})

async function openRowMenu(view: ReturnType<typeof render>, name: string) {
  await view.findByText(name)
  fireEvent.click(view.getByRole('button', { name: `リッチメニュー「${name}」の操作` }))
}

async function openDelete(view: ReturnType<typeof render>, name: string, label = '削除する') {
  await openRowMenu(view, name)
  fireEvent.click(await view.findByRole('menuitem', { name: label }))
}

/** 題に `title` を含む、開いている窓（dialog・alertdialog）を待って返す。 */
function findDialog(title: RegExp): Promise<HTMLElement> {
  return waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')]
      .find((node) => title.test(node.textContent ?? ''))
    if (!found) throw new Error(`窓が開いていません: ${title}`)
    return found
  })
}

function queryDialog(title: RegExp): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')]
    .find((node) => title.test(node.textContent ?? '')) ?? null
}

function deleteDialog(_view: ReturnType<typeof render>, name: string) {
  return findDialog(new RegExp(`「${name}」を削除しますか`))
}

describe('削除の影響の読み込み', () => {
  test('既定の印がある下書きはLINE側の状態を断定せず、削除を止める', async () => {
    mocks.deleteImpact.mockResolvedValue({ success: true, data: impact('g-draft', {
      blockers: ['default_for_all'], canDelete: false, recommendedAction: 'unpublish',
      lineResources: { pageCount: 1, pagesWithLineRichMenuId: 0, isDefaultForAll: true, publishing: false },
    }) })
    const view = render(<RichMenusListV8 />)
    await openDelete(view, '秋の下書き')
    const dialog = await findDialog(/「秋の下書き」はまだ消せません/)
    expect(dialog.textContent).toContain('LINEアカウント')
    expect(dialog.textContent).toContain('環境')
    expect(dialog.textContent).toContain('既定の印があり、LINE側の状態を確認できない')
    expect(dialog.textContent).toContain('削除せずに残しておいて問題ありません。')
    expect(dialog.textContent).not.toContain('出なくなる友だちがいます')
    expect(within(dialog).queryByRole('button', { name: 'ほかのメニューを既定に' })).toBeNull()
    expect(mocks.remove).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }))
    await waitFor(() => expect(queryDialog(/「秋の下書き」はまだ消せません/)).toBeNull())
  })

  test('一覧を出しただけでは影響を読まず、窓を開けたときにそのメニューの影響を読む', async () => {
    const view = render(<RichMenusListV8 />)
    await view.findByText('秋の下書き')
    await act(async () => {})
    expect(mocks.deleteImpact).not.toHaveBeenCalled()
    await openDelete(view, '秋の下書き')
    await waitFor(() => expect(mocks.deleteImpact).toHaveBeenCalledWith('g-draft'))
    expect(mocks.deleteImpact).toHaveBeenCalledTimes(1)
  })

  test('読み込み中は確認中と出し、削除のボタンを出さない', async () => {
    mocks.deleteImpact.mockReturnValue(new Promise(() => {}))
    const view = render(<RichMenusListV8 />)
    await openDelete(view, '秋の下書き')
    const dialog = await deleteDialog(view, '秋の下書き')
    expect(dialog.textContent).toContain('消したときの影響を確認しています…')
    expect(within(dialog).queryByRole('button', { name: '削除する' })).toBeNull()
  })

  test('影響が読めないときは理由を出し、削除のボタンを出さず、削除も送らない', async () => {
    mocks.deleteImpact.mockRejectedValue(new Error('network'))
    const view = render(<RichMenusListV8 />)
    await openDelete(view, '秋の下書き')
    const dialog = await deleteDialog(view, '秋の下書き')
    await within(dialog).findByText(/消したときの影響を確認できませんでした/)
    expect(within(dialog).queryByRole('button', { name: '削除する' })).toBeNull()
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  test('返ってきた影響が別のアカウントのものなら使わず、読めなかった扱いにする', async () => {
    mocks.deleteImpact.mockImplementation(async (id: string) => ({
      success: true,
      data: impact(id, { group: { id, accountId: 'account-b', name: 'x', status: 'draft' } }),
    }))
    const view = render(<RichMenusListV8 />)
    await openDelete(view, '秋の下書き')
    const dialog = await deleteDialog(view, '秋の下書き')
    await within(dialog).findByText(/消したときの影響を確認できませんでした/)
    expect(within(dialog).queryByRole('button', { name: '削除する' })).toBeNull()
  })

  test('表示中が確実に0人なら、出なくなる友だちがいると断定しない', async () => {
    const view = render(<RichMenusListV8 />)
    await openDelete(view, '秋の下書き')
    const dialog = await deleteDialog(view, '秋の下書き')
    await within(dialog).findByText('いま表示している人数：')
    expect(dialog.textContent).toContain('0 人')
    expect(dialog.textContent).not.toContain('出なくなる友だちがいます')
  })

  test('4つの影響を出し、取得できた0件は「ありません」、0人は「0 人」と書く', async () => {
    const view = render(<RichMenusListV8 />)
    await openDelete(view, '秋の下書き')
    const dialog = await deleteDialog(view, '秋の下書き')
    await within(dialog).findByText('いま表示している人数：')
    const text = dialog.textContent ?? ''
    expect(text).toContain('いま表示している人数：0 人')
    expect(text).toContain('次に出るメニュー：')
    expect(text).toContain('切替元：ありません')
    expect(text).toContain('使っている自動処理：ありません')
    fireEvent.click(within(dialog).getByRole('button', { name: '削除する' }))
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('g-draft', 7))
    expect(mocks.unpublish).not.toHaveBeenCalled()
  })

  test('窓を閉じたら影響を捨て、もう一度開いても前の影響を出さない', async () => {
    mocks.deleteImpact.mockResolvedValueOnce({ success: true, data: impact('g-draft', { currentAudience: { value: 7, state: 'available', reason: null } }) })
    const view = render(<RichMenusListV8 />)
    await openDelete(view, '秋の下書き')
    let dialog = await deleteDialog(view, '秋の下書き')
    await within(dialog).findByText(/7 人/)
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    await waitFor(() => expect(view.queryByRole('alertdialog')).toBeNull())
    mocks.deleteImpact.mockReturnValueOnce(new Promise(() => {}))
    await openDelete(view, '秋の下書き')
    dialog = await deleteDialog(view, '秋の下書き')
    expect(dialog.textContent).toContain('消したときの影響を確認しています…')
    expect(dialog.textContent).not.toContain('7 人')
  })

  test('遅れて返った別のメニューの影響を、いま開いている窓に映さない', async () => {
    const first = deferred<Result>()
    const second = deferred<Result>()
    mocks.deleteImpact.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const view = render(<RichMenusListV8 />)
    await openDelete(view, '秋の下書き')
    fireEvent.click(within(await deleteDialog(view, '秋の下書き')).getAllByRole('button', { name: /キャンセル|閉じる/ })[0])
    await waitFor(() => expect(view.queryByRole('alertdialog')).toBeNull())
    await openDelete(view, '冬の下書き')
    const dialog = await deleteDialog(view, '冬の下書き')
    await act(async () => { first.resolve({ success: true, data: impact('g-draft', { currentAudience: { value: 111, state: 'available', reason: null } }) }) })
    expect(dialog.textContent).not.toContain('111 人')
    expect(dialog.textContent).toContain('消したときの影響を確認しています…')
    await act(async () => { second.resolve({ success: true, data: impact('g-other', { currentAudience: { value: 222, state: 'available', reason: null } }) }) })
    await within(dialog).findByText(/222 人/)
  })

  test('同じメニューの窓をもう一度開いたときも、前の読み込みの結果は捨てる', async () => {
    const first = deferred<Result>()
    const second = deferred<Result>()
    mocks.deleteImpact.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const view = render(<RichMenusListV8 />)
    await openDelete(view, '秋の下書き')
    fireEvent.click(within(await deleteDialog(view, '秋の下書き')).getAllByRole('button', { name: /キャンセル|閉じる/ })[0])
    await waitFor(() => expect(view.queryByRole('alertdialog')).toBeNull())
    await openDelete(view, '秋の下書き')
    const dialog = await deleteDialog(view, '秋の下書き')
    await act(async () => { first.resolve({ success: true, data: impact('g-draft', { currentAudience: { value: 111, state: 'available', reason: null } }) }) })
    expect(dialog.textContent).not.toContain('111 人')
    await act(async () => { second.resolve({ success: true, data: impact('g-draft', { currentAudience: { value: 222, state: 'available', reason: null } }) }) })
    await within(dialog).findByText(/222 人/)
  })

  test('読み込み中にアカウントを替えると窓を閉じ、前のアカウントの影響を出さない', async () => {
    const pending = deferred<Result>()
    mocks.deleteImpact.mockReturnValueOnce(pending.promise)
    const view = render(<RichMenusListV8 />)
    await openDelete(view, '秋の下書き')
    await deleteDialog(view, '秋の下書き')
    mocks.accountId = 'account-b'
    view.rerender(<RichMenusListV8 />)
    await waitFor(() => expect(view.queryByRole('alertdialog')).toBeNull())
    await act(async () => { pending.resolve({ success: true, data: impact('g-draft') }) })
    expect(view.queryByRole('alertdialog')).toBeNull()
    expect(mocks.remove).not.toHaveBeenCalled()
  })
})

describe('消す・取り下げる', () => {
  test('ブラウザの確認窓を使わず、画面の窓で確かめてから削除を送る', async () => {
    const confirmSpy = vi.fn(() => true)
    const alertSpy = vi.fn()
    vi.stubGlobal('confirm', confirmSpy)
    vi.stubGlobal('alert', alertSpy)
    const view = render(<RichMenusListV8 />)
    await openDelete(view, '秋の下書き')
    const dialog = await deleteDialog(view, '秋の下書き')
    expect(mocks.remove).not.toHaveBeenCalled()
    fireEvent.click(await within(dialog).findByRole('button', { name: '削除する' }))
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('g-draft', 7))
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(alertSpy).not.toHaveBeenCalled()
  })

  test('別の削除窓を開いた後も古い窓の確定を受け付けない', async () => {
    const view = render(<RichMenusListV8 />)
    await openDelete(view, '秋の下書き')
    const first = await deleteDialog(view, '秋の下書き')
    const button = await within(first).findByRole('button', { name: '削除する' })
    const key = Object.keys(button).find(k => k.startsWith('__reactProps$'))!
    const oldClick = (button as unknown as Record<string, { onClick: (event: unknown) => void }>)[key].onClick
    fireEvent.click(within(first).getByRole('button', { name: 'キャンセル' }))
    await openDelete(view, '冬の下書き')
    const second = await deleteDialog(view, '冬の下書き')
    await within(second).findByRole('button', { name: '削除する' })
    await act(async () => { oldClick({ preventDefault() {}, stopPropagation() {} }) })
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  test('下書きの版が不明なら削除を送らない', async () => {
    mocks.listPage.mockResolvedValue(listResult([{ ...DRAFT, version: undefined }]))
    const view = render(<RichMenusListV8 />)
    await openDelete(view, '秋の下書き')
    const dialog = await deleteDialog(view, '秋の下書き')
    fireEvent.click(await within(dialog).findByRole('button', { name: '削除する' }))
    await waitFor(() => expect(dialog.textContent).toContain('版を確認できません'))
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  test('下書きは消えるもの・残るもの・元に戻せないことを読ませる', async () => {
    const view = render(<RichMenusListV8 />)
    await openDelete(view, '秋の下書き')
    const text = (await deleteDialog(view, '秋の下書き')).textContent ?? ''
    expect(text).toContain('消えるもの：このリッチメニューの設定と画像')
    expect(text).toContain('残るもの：')
    expect(text).toContain('元に戻せません。')
    expect(text).not.toContain('richMenuId')
  })

  test('公開中は削除でなくLINEからの取り下げを送り、残るものと次の手順を言う', async () => {
    const view = render(<RichMenusListV8 />)
    await openDelete(view, '通常メニュー', '取り下げ・削除する')
    const dialog = await deleteDialog(view, '通常メニュー')
    const text = dialog.textContent ?? ''
    expect(text).toContain('LINEアカウント')
    expect(text).toContain('環境')
    expect(text).toContain('取り下げるもの：')
    expect(text).toContain('残るもの：管理画面の設定と、これまでのタップ記録')
    expect(text).toContain('取り下げたあと、管理画面から削除できます。')
    fireEvent.click(within(dialog).getByRole('button', { name: 'LINEから取り下げる' }))
    await waitFor(() => expect(mocks.unpublish).toHaveBeenCalledWith('g-pub',{expectedVersion:1,expectedPublishGeneration:0,expectedIsDefaultForAll:false,expectedPages:[{id:'page-1',orderIndex:0,lineRichMenuId:'line-1'}]}))
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  test('一覧の名前と確認した公開内容が一致しない場合は取り下げない',async()=>{
    mocks.deleteImpact.mockResolvedValue({success:true,data:impact('g-pub',{group:{id:'g-pub',accountId:'account-a',name:'変更後',status:'published',version:2,publishingGeneration:1}})})
    const view=render(<RichMenusListV8 />)
    await openDelete(view,'通常メニュー','取り下げ・削除する')
    const dialog=await deleteDialog(view,'通常メニュー')
    fireEvent.click(within(dialog).getByRole('button',{name:'LINEから取り下げる'}))
    await waitFor(()=>expect(dialog.textContent).toContain('公開内容を確認できません'))
    expect(mocks.unpublish).not.toHaveBeenCalled()
  })

  test('削除が断られたら窓を開いたまま安全な文を出し、二度押しでも1回しか送らない', async () => {
    const answer = deferred<Result>()
    mocks.remove.mockReturnValueOnce(answer.promise)
    const view = render(<RichMenusListV8 />)
    await openDelete(view, '秋の下書き')
    const dialog = await deleteDialog(view, '秋の下書き')
    const button = await within(dialog).findByRole('button', { name: '削除する' })
    fireEvent.click(button)
    fireEvent.click(button)
    await act(async () => { answer.resolve({ success: false, error: 'D1_ERROR: internal' }) })
    expect(mocks.remove).toHaveBeenCalledTimes(1)
    await within(dialog).findByText('リッチメニューを削除できませんでした。状態を確認して、もう一度お試しください。')
    expect(dialog.textContent).not.toContain('D1_ERROR')
    expect(view.getByRole('alertdialog')).toBe(dialog)
  })

  test('409 に入っている最新の影響へ描き直し、消せない窓に切り替える', async () => {
    mocks.remove.mockRejectedValueOnce(new ApiError(409, 'in use', 'RICH_MENU_IN_USE', impact('g-draft', {
      canDelete: false,
      blockers: ['incoming_switches'],
      incomingSwitches: [{ sourceGroupId: 'g-x', sourceGroupName: '会員ランク上位', sourcePageId: 'p', sourcePageName: 'トップ', areaId: 'a', areaLabel: null, targetPageId: 't', targetPageName: 'トップ' }],
    })))
    const view = render(<RichMenusListV8 />)
    await openDelete(view, '秋の下書き')
    fireEvent.click(await within(await deleteDialog(view, '秋の下書き')).findByRole('button', { name: '削除する' }))
    const blocked = await findDialog(/「秋の下書き」はまだ消せません/)
    expect(blocked.textContent).toContain('「会員ランク上位」の切替先になっている')
    expect(mocks.deleteImpact).toHaveBeenCalledTimes(1)
  })

  test('409 の影響が別のメニューのものなら使わず、このメニューの影響を読み直す', async () => {
    mocks.remove.mockRejectedValueOnce(new ApiError(409, 'in use', 'RICH_MENU_IN_USE', impact('g-other', { canDelete: false, blockers: ['published'] })))
    const view = render(<RichMenusListV8 />)
    await openDelete(view, '秋の下書き')
    fireEvent.click(await within(await deleteDialog(view, '秋の下書き')).findByRole('button', { name: '削除する' }))
    await waitFor(() => expect(mocks.deleteImpact).toHaveBeenCalledTimes(2))
    expect(mocks.deleteImpact).toHaveBeenLastCalledWith('g-draft')
    expect(queryDialog(/まだ消せません/)).toBeNull()
  })
})

describe('LINE上のメニューの取り込み', () => {
  async function openImport(view: ReturnType<typeof render>) {
    await view.findByText('秋の下書き')
    fireEvent.click(view.getByRole('button', { name: /LINE上にあるメニュー/ }))
    fireEvent.click(await view.findByRole('button', { name: 'この内容で取り込む' }))
    return findDialog(/「外部メニュー」を管理画面に取り込みますか/)
  }

  test('追加・上書き・LINE側に残るものを確かめてから、同じアカウントへ取り込みを送る', async () => {
    const view = render(<RichMenusListV8 />)
    const dialog = await openImport(view)
    const text = dialog.textContent ?? ''
    expect(text).toContain('管理画面に追加するもの：')
    expect(text).toContain('上書きするもの：ありません。すでに管理中のメニューは重ねて取り込みません。')
    expect(text).toContain('LINE上に残るもの：')
    expect(mocks.importFromLine).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: '管理画面に取り込む' }))
    await waitFor(() => expect(mocks.importFromLine).toHaveBeenCalledWith('line-only', 'account-a'))
    const done = await findDialog(/「取り込んだメニュー」を管理画面に取り込みました/)
    expect(done.textContent).toContain('LINE上の表示は変更していません。管理画面で編集できるようになりました。')
  })

  test('取り込みが断られたら窓を開いたまま安全な文を出す', async () => {
    mocks.importFromLine.mockResolvedValueOnce({ success: false, error: 'LINE API 500 internal' })
    const view = render(<RichMenusListV8 />)
    const dialog = await openImport(view)
    fireEvent.click(within(dialog).getByRole('button', { name: '管理画面に取り込む' }))
    await within(dialog).findByText('LINE上のリッチメニューを取り込めませんでした。LINEの状態を確認して、もう一度お試しください。')
    expect(dialog.textContent).not.toContain('LINE API 500')
    expect(queryDialog(/取り込みました/)).toBeNull()
  })

  test('前のアカウントから遅れて返った取り込み結果を、替えたあとの画面に出さない', async () => {
    const answer = deferred<Result>()
    mocks.importFromLine.mockReturnValueOnce(answer.promise)
    const view = render(<RichMenusListV8 />)
    const dialog = await openImport(view)
    fireEvent.click(within(dialog).getByRole('button', { name: '管理画面に取り込む' }))
    await waitFor(() => expect(mocks.importFromLine).toHaveBeenCalledTimes(1))
    mocks.accountId = 'account-b'
    view.rerender(<RichMenusListV8 />)
    await act(async () => { answer.resolve({ success: true, data: { id: 'g-new', name: '取り込んだメニュー' } }) })
    expect(view.queryByText(/取り込みました/)).toBeNull()
  })
})

describe('0件の出し分けとページ', () => {
  test('絞り込みで0件なら「条件に合うものがありません」と条件を外す口を出し、押すと検索・絞り込み・フォルダを戻す', async () => {
    setUrl('?q=秋&view=published&folder=__unfiled__&page=2')
    mocks.listPage.mockResolvedValue(listResult([]))
    const view = render(<RichMenusListV8 />)
    await view.findByText('条件に合うものがありません')
    expect(view.queryByText('まだリッチメニューがありません')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: '条件を外す' }))
    await waitFor(() => expect(mocks.listPage).toHaveBeenLastCalledWith('account-a', expect.objectContaining({ query: '', filter: '', folderId: '', page: 1 })))
    await waitFor(() => {
      const params = new URLSearchParams(window.location.search)
      expect(params.get('q') ?? '').toBe('')
      expect(params.get('view') ?? '').toBe('')
      expect(params.get('folder') ?? '').toBe('')
    })
  })

  test('何も絞っていない0件は「まだリッチメニューがありません」と作る口を出す', async () => {
    mocks.listPage.mockResolvedValue(listResult([]))
    const view = render(<RichMenusListV8 />)
    await view.findByText('まだリッチメニューがありません')
    expect(view.queryByText('条件に合うものがありません')).toBeNull()
    expect(view.getByRole('button', { name: '最初のリッチメニューを作る' })).toBeTruthy()
  })

  test('画面のページ・件数・絞り込み・並び順をそのまま一覧の口へ渡し、全体の件数でページを出す', async () => {
    setUrl('?page=2&size=10&sort=name&view=draft')
    mocks.listPage.mockResolvedValue(listResult([DRAFT, OTHER], 25))
    const view = render(<RichMenusListV8 />)
    await view.findByText('秋の下書き')
    expect(mocks.listPage).toHaveBeenCalledWith('account-a', expect.objectContaining({ page: 2, limit: 10, sort: 'name', filter: 'draft' }))
    const pager = view.getByRole('navigation', { name: 'リッチメニューのページ送り' })
    expect(pager.textContent).toContain('25')
  })
})

test('行の「…」の「切替のつながりを見る」は、そのメニューのつながりの画面へ進む', async () => {
  const view = render(<RichMenusListV8 />)
  await openRowMenu(view, '通常メニュー')
  fireEvent.click(await view.findByRole('menuitem', { name: '切替のつながりを見る' }))
  expect(mocks.push).toHaveBeenCalledWith('/rich-menus/connections?id=g-pub')
})

describe('板の印とフォルダの列', () => {
  function boardOf(view: ReturnType<typeof render>) {
    return view.container.querySelector('[data-design-node="rZEGN"], [data-design-node="ZoKow"], [data-design-node="Y9ASp"]')?.getAttribute('data-design-node')
  }

  test('広い板は広い板の印を付け、左にフォルダの列を出す', async () => {
    const view = render(<RichMenusListV8 />)
    await view.findByText('秋の下書き')
    await waitFor(() => expect(boardOf(view)).toBe('rZEGN'))
    expect(view.container.querySelector('[data-template-region="folders"]')).not.toBeNull()
  })

  test('閲覧のみの人には閲覧のみの板の印を付ける', async () => {
    mocks.role = 'staff'
    const view = render(<RichMenusListV8 />)
    await view.findByText('秋の下書き')
    await waitFor(() => expect(boardOf(view)).toBe('ZoKow'))
  })

  test('狭い板は狭い板の印を付け、フォルダの列を畳む', async () => {
    mocks.narrow = true
    const view = render(<RichMenusListV8 />)
    await view.findByText('秋の下書き')
    await waitFor(() => expect(boardOf(view)).toBe('Y9ASp'))
    // コンテナ幅の CSS で列を畳み、追加窓を開けるように部品は残す。
    expect(view.container.querySelector('[data-template-region="folders"]')).not.toBeNull()
  })
})


describe('LINE上のメニューの窓', () => {
  test.each(['Escape', '閉じる'])('LINE上のメニューの窓は%sで閉じ、開いた操作に焦点を戻す', async (method) => {
    const view = render(<RichMenusListV8 />)
    await view.findByText('秋の下書き')
    const trigger = view.getByRole('button', { name: /LINE上にあるメニュー/ })
    trigger.focus()
    fireEvent.click(trigger)
    await waitFor(() => expect(view.queryByRole('dialog', { name: 'LINE上にあるメニュー' })).not.toBeNull())
    const dialog = view.getByRole('dialog', { name: 'LINE上にあるメニュー' })
    expect(dialog.getAttribute('data-size')).toBe('wide')
    expect(dialog.closest('[data-viewport-fit]')?.getAttribute('data-viewport-fit')).toBe('true')
    if (method === 'Escape') fireEvent.keyDown(document, { key: 'Escape' })
    else fireEvent.click(within(dialog).getByRole('button', { name: '閉じる', exact: true }))
    await waitFor(() => expect(view.queryByRole('dialog', { name: 'LINE上にあるメニュー' })).toBeNull())
    expect(document.activeElement).toBe(trigger)
    expect(mocks.importFromLine).not.toHaveBeenCalled()
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  test('LINE上のメニューの窓は認証の失敗理由を出し、同じアカウントで読み直せる', async () => {
    mocks.external.mockRejectedValueOnce(new ApiError(500, 'API error: 500', 'INVALID_LINE_ACCESS_TOKEN'))
    const view = render(<RichMenusListV8 />)
    await view.findByText('秋の下書き')
    fireEvent.click(view.getByRole('button', { name: /LINE上にあるメニュー/ }))
    await waitFor(() => expect(view.queryByRole('dialog', { name: 'LINE上にあるメニュー' })).not.toBeNull())
    const dialog = view.getByRole('dialog', { name: 'LINE上にあるメニュー' })
    await within(dialog).findByText('LINE連携の認証情報を確認できません。連携の設定を確認してください。')
    expect(within(dialog).queryByText('管理画面の外のメニューはありません')).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度読み込む', exact: true }))
    expect(await within(dialog).findAllByText('外部メニュー', { exact: true })).toHaveLength(2)
    expect(mocks.external).toHaveBeenLastCalledWith('account-a')
    expect(mocks.external).toHaveBeenCalledTimes(2)
    expect(mocks.importFromLine).not.toHaveBeenCalled()
    expect(mocks.unpublish).not.toHaveBeenCalled()
  })
})


describe('LINE上のメニューの窓の閉鎖境界', () => {
  test('LINE上のメニューの窓はURLから直接開いても、一覧の検索とページを保って閉じる', async () => {
    setUrl('?showExternal=true&q=秋&page=2')
    mocks.listPage.mockResolvedValue(listResult([DRAFT, OTHER, PUBLISHED], 41))
    const view = render(<RichMenusListV8 />)
    await waitFor(() => expect(view.queryByRole('dialog', { name: 'LINE上にあるメニュー' })).not.toBeNull())
    expect(new URLSearchParams(window.location.search).get('page')).toBe('2')
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(view.queryByRole('dialog', { name: 'LINE上にあるメニュー' })).toBeNull())
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('showExternal')).not.toBe('true'))
    const params = new URLSearchParams(window.location.search)
    expect(params.get('q')).toBe('秋')
    expect(params.get('page')).toBe('2')
    expect(view.getByRole('button', { name: /LINE上にあるメニュー/ }).hasAttribute('disabled')).toBe(false)
  })

  test('LINE上のメニューの窓から開いた取り込み確認だけをEscで閉じ、親の操作へ焦点を戻す', async () => {
    const view = render(<RichMenusListV8 />)
    await view.findByText('秋の下書き')
    fireEvent.click(view.getByRole('button', { name: /LINE上にあるメニュー/ }))
    await waitFor(() => expect(view.queryByRole('dialog', { name: 'LINE上にあるメニュー' })).not.toBeNull())
    const outer = view.getByRole('dialog', { name: 'LINE上にあるメニュー' })
    const trigger = await within(outer).findByRole('button', { name: 'この内容で取り込む' })
    trigger.focus()
    fireEvent.click(trigger)
    const child = await findDialog(/「外部メニュー」を管理画面に取り込みますか/)
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(child.isConnected).toBe(false))
    expect(view.getByRole('dialog', { name: 'LINE上にあるメニュー' })).toBe(outer)
    expect(document.activeElement).toBe(trigger)
    expect(mocks.importFromLine).not.toHaveBeenCalled()
  })

  test('LINE上のメニューの窓は取り込み中に親を閉じず、確定は一回だけに保つ', async () => {
    let resolve!: (value: Result) => void
    const pending = new Promise<Result>(done => { resolve = done })
    mocks.importFromLine.mockReturnValueOnce(pending)
    const view = render(<RichMenusListV8 />)
    await view.findByText('秋の下書き')
    fireEvent.click(view.getByRole('button', { name: /LINE上にあるメニュー/ }))
    await waitFor(() => expect(view.queryByRole('dialog', { name: 'LINE上にあるメニュー' })).not.toBeNull())
    const outer = view.getByRole('dialog', { name: 'LINE上にあるメニュー' })
    fireEvent.click(await within(outer).findByRole('button', { name: 'この内容で取り込む' }))
    const child = await findDialog(/「外部メニュー」を管理画面に取り込みますか/)
    fireEvent.click(within(child).getByRole('button', { name: '管理画面に取り込む' }))
    await waitFor(() => expect(mocks.importFromLine).toHaveBeenCalledTimes(1))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(child.isConnected).toBe(true)
    expect(outer.isConnected).toBe(true)
    fireEvent.click(within(outer).getByRole('button', { name: 'リッチメニュー', exact: true }))
    expect(outer.isConnected).toBe(true)
    expect(mocks.importFromLine).toHaveBeenCalledTimes(1)
    expect(within(outer).getByRole('button', { name: '閉じる', exact: true }).hasAttribute('disabled')).toBe(true)
    await act(async () => { resolve({ success: true, data: { id: 'g-new', name: '取り込んだメニュー' } }); await pending })
    await findDialog(/「取り込んだメニュー」を管理画面に取り込みました/)
    expect(mocks.importFromLine).toHaveBeenCalledTimes(1)
  })
})
