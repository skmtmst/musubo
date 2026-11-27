// @vitest-environment happy-dom
/*
 * V8 ウェビナー一覧の契約を、描いて押して確かめる。
 * 並び・件数・よく使う絞り込み・フォルダ（数・追加・名前・削除・未分類）は口へ渡し、
 * 選んだアカウントだけを読み、頁ごとに取り、器の違う返事や失敗を空と混ぜない。
 * アーカイブの失敗は対象を失わず同じ窓で伝える。
 * 検索の束ね・古い応答・空と失敗の分け方・アーカイブの確定は webinar-list-behavior.test.tsx が見る。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FOLDER_SELECT_COLORS } from '@line-crm/shared'
import { ApiError, type WebinarListItem, type WebinarListParams } from '@/lib/api'
import WebinarList from './page'

const heldInlineAction = vi.hoisted(() => ({ hold: false, run: null as null | (() => void) }))
vi.mock('@/components/shared/use-inline-detail-guard', async importOriginal => {
  const actual = await importOriginal<typeof import('@/components/shared/use-inline-detail-guard')>()
  return { ...actual, useInlineDetailGuard: (key: string) => {
    const guard = actual.useInlineDetailGuard(key)
    return { ...guard, protect: (action: () => void) => { if (heldInlineAction.hold) { heldInlineAction.run = action; return } return guard.protect(action) } }
  } }
})

const mocks = vi.hoisted(() => ({
  accountId: 'account-1' as string | null,
  accounts: [{ id: 'account-1' }, { id: 'account-2' }] as Array<{ id: string }>,
  grand: 5,
  list: vi.fn(), folders: vi.fn(), overview: vi.fn(), archive: vi.fn(), update: vi.fn(),
  createFolder: vi.fn(), updateFolder: vi.fn(), deleteFolder: vi.fn(),
}))
vi.mock('@/lib/api', async (original) => ({
  ...await original<typeof import('@/lib/api')>(),
  webinarApi: {
    list: mocks.list, folders: mocks.folders, overview: mocks.overview, archive: mocks.archive, update: mocks.update,
    createFolder: mocks.createFolder, updateFolder: mocks.updateFolder, deleteFolder: mocks.deleteFolder,
  },
}))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: mocks.accountId, accounts: mocks.accounts, loading: false }) }))
vi.mock('@/lib/staff-role', async (original) => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))

function webinar(overrides: Partial<WebinarListItem> = {}): WebinarListItem {
  return {
    id: 'webinar-1', accountId: 'account-1', title: '入門ウェビナー', slug: 'intro', status: 'draft',
    videoPrefix: null, durationSeconds: 1800, schedule: [], cta: null, tagOnAttend: null, tagOnCtaClick: null,
    folderId: null, folderName: null, registrationCount: 12, viewerCount: 8,
    createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-08T00:00:00Z', ...overrides,
  }
}
const folder = (overrides: Record<string, unknown> = {}) => ({
  id: 'folder-a', kind: 'webinar', accountId: 'account-1', name: 'セミナー', parentId: null, displayOrder: 0, count: 2, color: '#2f6fde', createdAt: '', updatedAt: '', ...overrides,
})
const response = (items: WebinarListItem[], total = items.length) => ({ data: { items, total, limit: 20, sort: [] } })
const pageCalls = () => mocks.list.mock.calls.filter(([, params]: [string, WebinarListParams]) => params.limit !== 1)
const lastPageCall = () => pageCalls().at(-1)

async function start() {
  const view = render(<WebinarList />)
  await screen.findByRole('link', { name: '「入門ウェビナー」の詳細を見る' })
  return view
}
async function choose(selectLabel: string, optionLabel: string) {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: selectLabel })) })
  const option = screen.getAllByRole('option').find((element) => element.textContent?.trim() === optionLabel)
  if (!option) throw new Error(`option not found: ${optionLabel}`)
  await act(async () => { fireEvent.click(option.querySelector('button') ?? option) })
}
function folderRow(label: string) {
  return screen.getAllByRole('button').find((button) => button.getAttribute('data-folder-select') !== null && button.getAttribute('title') === label)!
}

beforeEach(() => {
  heldInlineAction.hold = false
  heldInlineAction.run = null
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/webinars')
  window.dispatchEvent(new PopStateEvent('popstate'))
  document.documentElement.dataset.theme = 'v8'
  mocks.accountId = 'account-1'
  mocks.grand = 5
  mocks.list.mockImplementation(async (_account: string, params: WebinarListParams) => params.limit === 1 ? response([], mocks.grand) : response([webinar()]))
  mocks.folders.mockResolvedValue({ success: true, data: [folder()] })
  mocks.overview.mockResolvedValue({ data: null })
  mocks.archive.mockResolvedValue({ data: { success: true } })
  mocks.createFolder.mockResolvedValue({ success: true, data: folder({ id: 'folder-new', name: '商品説明' }) })
  mocks.updateFolder.mockResolvedValue({ success: true, data: folder() })
  mocks.deleteFolder.mockResolvedValue({ success: true })
})
afterEach(() => { cleanup() })

describe('並び・件数・よく使う絞り込みは口へ渡す', () => {
  it('並びは更新順・作成順・名前順だけで、選ぶと 1 頁目から取り直す', async () => {
    const view = await start()
    expect(view.container.textContent).not.toContain('表示件数の切り替えは準備中です')
    expect(view.container.textContent).not.toContain('保存した条件は準備中です')
    expect(view.container.textContent).not.toContain('保存した条件')
    expect(lastPageCall()).toEqual(['account-1', expect.objectContaining({ sort: 'updated', page: 1, limit: 20 })])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '並び' })) })
    expect(screen.getAllByRole('option').map((option) => option.textContent?.trim())).toEqual(['更新順', '作成順', '名前順'])
    await act(async () => { fireEvent.click(screen.getAllByRole('option')[2].querySelector('button') ?? screen.getAllByRole('option')[2]) })
    await waitFor(() => expect(lastPageCall()).toEqual(['account-1', expect.objectContaining({ sort: 'name', page: 1 })]))
  })

  it('表示件数を変えると、その件数で取り直す', async () => {
    await start()
    await choose('表示件数', '50件表示')
    await waitFor(() => expect(lastPageCall()).toEqual(['account-1', expect.objectContaining({ limit: 50, page: 1 })]))
  })

  it('公開中のみ・下書きのみは、取った頁を絞り直さず状態を口へ渡す', async () => {
    await start()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'よく使う絞り込み' })) })
    expect(screen.getAllByRole('option').map(option => option.textContent?.trim())).toEqual(['よく使う絞り込み', '公開中のみ', '下書きのみ', 'アーカイブ済み'])
    await act(async () => { fireEvent.click(screen.getAllByRole('option')[1].querySelector('button') ?? screen.getAllByRole('option')[1]) })
    await waitFor(() => expect(lastPageCall()).toEqual(['account-1', expect.objectContaining({ status: 'active' })]))
    expect(await screen.findByRole('link', { name: '「入門ウェビナー」の詳細を見る' })).toBeTruthy()
    await choose('よく使う絞り込み', '下書きのみ')
    await waitFor(() => expect(lastPageCall()).toEqual(['account-1', expect.objectContaining({ status: 'draft' })]))
  })
})

describe('フォルダ', () => {
  it('選んだアカウントのフォルダと数を出し、未分類は全体から引いた数を出す', async () => {
    mocks.grand = 5
    await start()
    expect(mocks.folders).toHaveBeenCalledWith('account-1')
    expect(document.body.textContent).not.toContain('フォルダ名と件数は一覧APIへの接続後に表示します。')
    await waitFor(() => expect(folderRow('セミナー').textContent).toContain('2'))
    await waitFor(() => expect(folderRow('未分類').textContent).toContain('3'))
    expect(folderRow('すべて').textContent).toContain('5')
    expect([...document.querySelectorAll('[data-folder-select]')].map(node => node.getAttribute('title'))).toEqual(['すべて', 'セミナー', '未分類'])
  })

  it('フォルダが空なら固定のフォルダを足さない', async () => {
    mocks.folders.mockResolvedValue({ success: true, data: [] })
    await start()
    await waitFor(() => expect([...document.querySelectorAll('[data-folder-select]')].map(node => node.getAttribute('title'))).toEqual(['すべて', '未分類']))
  })

  it('フォルダや未分類を選ぶと、その絞りで口から取り直す', async () => {
    await start()
    await act(async () => { fireEvent.click(folderRow('セミナー')) })
    await waitFor(() => expect(lastPageCall()).toEqual(['account-1', expect.objectContaining({ folder: 'folder-a', page: 1 })]))
    await act(async () => { fireEvent.click(folderRow('未分類')) })
    await waitFor(() => expect(lastPageCall()).toEqual(['account-1', expect.objectContaining({ folder: '__unfiled__' })]))
  })

  it('フォルダを追加すると、名前と色を選んだアカウントへ保存して読み直す', async () => {
    await start()
    const reads = mocks.folders.mock.calls.length
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'フォルダを追加' })) })
    const dialog = screen.getByRole('dialog')
    fireEvent.change(dialog.querySelector('[data-folder-name-color] input')!, { target: { value: '  商品説明 ' } })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: /追加する/ })) })
    expect(mocks.createFolder).toHaveBeenCalledWith('account-1', { name: '商品説明', color: FOLDER_SELECT_COLORS[0].value })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(mocks.folders.mock.calls.length).toBeGreaterThan(reads)
  })

  it('選んだフォルダの名前を変えると、そのフォルダへ保存する', async () => {
    await start()
    await act(async () => { fireEvent.click(folderRow('セミナー')) })
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'フォルダ「セミナー」の操作' })[0]) })
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: /名前を変更する/ })) })
    const dialog = screen.getByRole('dialog')
    fireEvent.change(dialog.querySelector('[data-folder-name-color] input')!, { target: { value: '説明会' } })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: /保存する/ })) })
    expect(mocks.updateFolder).toHaveBeenCalledWith('account-1', 'folder-a', { name: '説明会', color: '#2f6fde' })
    expect(mocks.createFolder).not.toHaveBeenCalled()
  })

  it('未保存確認の間にアカウントが往復した古い削除操作は開かない', async () => {
    const view = await start()
    await waitFor(() => expect(folderRow('セミナー')).toBeTruthy())
    await act(async () => { fireEvent.click(folderRow('セミナー')) })
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'フォルダ「セミナー」の操作' })[0]) })
    heldInlineAction.hold = true
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: /消す/ })) })
    expect(heldInlineAction.run).toBeTypeOf('function')
    mocks.accountId = 'account-2'; view.rerender(<WebinarList />)
    mocks.accountId = 'account-1'; view.rerender(<WebinarList />)
    await act(async () => { heldInlineAction.run!() })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(mocks.deleteFolder).not.toHaveBeenCalled()
  })

  it('折りたたんだフォルダ欄でも選択したフォルダを操作できる', async () => {
    const view = await start()
    await waitFor(() => expect(folderRow('セミナー')).toBeTruthy())
    await act(async () => { fireEvent.click(folderRow('セミナー')) })
    expect(view.container.querySelectorAll('[aria-label="フォルダ「セミナー」の操作"]')).toHaveLength(2)
  })

  it('フォルダ削除は対象と環境を表示し、アカウント切替後は確定できない', async () => {
    const view = await start()
    await waitFor(() => expect(folderRow('セミナー')).toBeTruthy())
    await act(async () => { fireEvent.click(folderRow('セミナー')) })
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'フォルダ「セミナー」の操作' })[0]) })
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: /消す/ })) })
    const dialog = screen.getByRole('alertdialog')
    expect(dialog.textContent).toContain('LINEアカウント')
    expect(dialog.textContent).toContain('環境')
    mocks.accountId = 'account-2'
    view.rerender(<WebinarList />)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(mocks.deleteFolder).not.toHaveBeenCalled()
  })

  it('フォルダ削除の確認中にアカウントを替えると窓が閉じる', async () => {
    const view = await start()
    await waitFor(() => expect(folderRow('セミナー')).toBeTruthy())
    await act(async () => { fireEvent.click(folderRow('セミナー')) })
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'フォルダ「セミナー」の操作' })[0]) })
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: /消す/ })) })
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    mocks.accountId = 'account-2'
    view.rerender(<WebinarList />)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(mocks.deleteFolder).not.toHaveBeenCalled()
  })

  it('選んだフォルダを消すと確かめてから消し、一覧とフォルダを読み直す', async () => {
    await start()
    await act(async () => { fireEvent.click(folderRow('セミナー')) })
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'フォルダ「セミナー」の操作' })[0]) })
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: /消す/ })) })
    const dialog = screen.getByRole('alertdialog')
    expect(dialog.textContent).toContain('いまこのフォルダに入っているのは2 件です')
    expect(mocks.deleteFolder).not.toHaveBeenCalled()
    const pages = pageCalls().length
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: /削除する/ })) })
    expect(mocks.deleteFolder).toHaveBeenCalledWith('account-1', 'folder-a')
    await waitFor(() => expect(pageCalls().length).toBeGreaterThan(pages))
    await waitFor(() => expect(lastPageCall()).toEqual(['account-1', expect.objectContaining({ folder: undefined })]))
  })
})

describe('アカウント', () => {
  it('アカウントを選んでいないときは取りに行かず、選ぶよう案内する', async () => {
    mocks.accountId = null
    render(<WebinarList />)
    await screen.findByText('上のバーでLINE公式アカウントを選んでください')
    expect(mocks.list).not.toHaveBeenCalled()
    expect(mocks.folders).not.toHaveBeenCalled()
  })

  it('アカウントを替えたら前のアカウントの行とフォルダを出さず、新しいアカウントで読む', async () => {
    const view = await start()
    const next = { list: Promise.withResolvers<ReturnType<typeof response>>(), folders: Promise.withResolvers<unknown>() }
    mocks.list.mockImplementation((account: string, params: WebinarListParams) => account === 'account-2' && params.limit !== 1 ? next.list.promise : Promise.resolve(response([], 0)))
    mocks.folders.mockImplementation((account: string) => account === 'account-2' ? next.folders.promise : Promise.resolve({ success: true, data: [folder()] }))
    mocks.accountId = 'account-2'
    view.rerender(<WebinarList />)
    await waitFor(() => expect(lastPageCall()?.[0]).toBe('account-2'))
    expect(screen.queryByRole('link', { name: '「入門ウェビナー」の詳細を見る' })).toBeNull()
    expect(screen.queryByTitle('セミナー')).toBeNull()
    await act(async () => {
      next.list.resolve(response([webinar({ id: 'w-2', accountId: 'account-2', title: '別店のウェビナー' })]))
      next.folders.resolve({ success: true, data: [] })
    })
    await screen.findByRole('link', { name: '「別店のウェビナー」の詳細を見る' })
    expect(mocks.folders).toHaveBeenLastCalledWith('account-2')
  })

  it('アカウントを替えた後に前のフォルダの返事が遅れて届いても、混ぜない', async () => {
    const late = Promise.withResolvers<unknown>()
    mocks.folders.mockImplementation((account: string) => account === 'account-1' ? late.promise : Promise.resolve({ success: true, data: [folder({ id: 'folder-b', name: '別店フォルダ', accountId: 'account-2' })] }))
    const view = await start()
    mocks.accountId = 'account-2'
    view.rerender(<WebinarList />)
    await screen.findByTitle('別店フォルダ')
    await act(async () => { late.resolve({ success: true, data: [folder()] }) })
    expect(screen.queryByTitle('セミナー')).toBeNull()
    expect(screen.getByTitle('別店フォルダ')).toBeTruthy()
  })
})

describe('頁と読めなかったとき', () => {
  it('全件と頁数を出し、次の頁は口から 2 頁目を取る', async () => {
    mocks.list.mockImplementation(async (_account: string, params: WebinarListParams) => params.limit === 1 ? response([], 45) : response([params.page === 2 ? webinar({ id: 'w-21', title: '21件目' }) : webinar()], 45))
    await start()
    const pager = screen.getByRole('navigation', { name: 'ウェビナー一覧のページ送り' })
    expect(pager.textContent).toContain('45')
    expect(within(pager).getByRole('button', { name: '3ページ目へ' })).toBeTruthy()
    expect(within(pager).queryByRole('button', { name: '4ページ目へ' })).toBeNull()
    await act(async () => { fireEvent.click(within(pager).getByRole('button', { name: '次のページ' })) })
    await waitFor(() => expect(lastPageCall()).toEqual(['account-1', expect.objectContaining({ page: 2, limit: 20 })]))
    expect(await screen.findByRole('link', { name: '「21件目」の詳細を見る' })).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/ほかに\s*\d+\s*件あります/)
  })

  it('頁の器で来なかった返事は空の一覧にせず、読めなかったと出す', async () => {
    mocks.list.mockImplementation(async (_account: string, params: WebinarListParams) => params.limit === 1 ? response([], 5) : { data: { items: null, total: 0 } })
    const view = render(<WebinarList />)
    await waitFor(() => expect(view.container.querySelector('[data-list-state="error"]')).not.toBeNull())
    expect(within(view.container.querySelector('[data-list-state="error"]') as HTMLElement).getByRole('button', { name: 'もう一度読み込む' })).toBeTruthy()
    expect(view.container.querySelector('[data-empty-list]')).toBeNull()
    expect(screen.queryByRole('navigation', { name: 'ウェビナー一覧のページ送り' })).toBeNull()
  })

  it('通信の失敗は、通信を確かめて読み直すよう言い、生の理由を出さない', async () => {
    mocks.list.mockImplementation(async (_account: string, params: WebinarListParams) => {
      if (params.limit === 1) return response([], 5)
      throw new Error('fetch failed: secret-host')
    })
    const view = render(<WebinarList />)
    await screen.findByText('通信状態を確認して、もう一度読み込んでください。')
    expect(view.container.textContent).not.toContain('secret-host')
  })
})

describe('集計の帯', () => {
  const overview = (registrations: number) => ({
    data: {
      state: 'complete', registrationMode: 'people',
      metrics: { registrations: { value: registrations, state: 'available', reason: null } },
    },
  })
  const band = () => document.querySelector('[data-template-region="stats"]')?.textContent ?? document.body.textContent ?? ''

  it('集計が読めないときは帯を空と言わず、その場で読み直せる', async () => {
    mocks.overview.mockRejectedValueOnce(new ApiError(500, 'boom'))
    await start()
    await screen.findByText('集計を表示できませんでした。')
    mocks.overview.mockResolvedValue(overview(248))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '集計を読み直す' })) })
    await waitFor(() => expect(band()).toContain('248'))
    expect(mocks.overview).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('集計を表示できませんでした。')).toBeNull()
  })

  it('アカウントを替えたら、前のアカウントの集計を出さない', async () => {
    mocks.overview.mockImplementation(async (account: string) => account === 'account-1' ? overview(248) : new Promise(() => {}))
    const view = await start()
    await waitFor(() => expect(band()).toContain('248'))
    mocks.accountId = 'account-2'
    view.rerender(<WebinarList />)
    await waitFor(() => expect(mocks.overview).toHaveBeenLastCalledWith('account-2'))
    expect(band()).not.toContain('248')
  })

  it('アカウントを替えた後に前の集計が遅れて届いても、混ぜない', async () => {
    const late = Promise.withResolvers<unknown>()
    mocks.overview.mockImplementation((account: string) => account === 'account-1' ? late.promise : Promise.resolve(overview(31)))
    const view = await start()
    mocks.accountId = 'account-2'
    view.rerender(<WebinarList />)
    await waitFor(() => expect(band()).toContain('31'))
    await act(async () => { late.resolve(overview(248)) })
    expect(band()).not.toContain('248')
    expect(band()).toContain('31')
  })
})

it('一覧を見る権限が無いときは、通信の失敗と言わず権限の案内にする', async () => {
  mocks.list.mockImplementation(async (_account: string, params: WebinarListParams) => {
    if (params.limit === 1) return response([], 5)
    throw new ApiError(403, 'forbidden')
  })
  const view = render(<WebinarList />)
  await screen.findByText('ウェビナーを見る権限がありません')
  expect(view.container.querySelector('[data-list-state="forbidden"]')).not.toBeNull()
  expect(view.container.querySelector('[data-list-state="error"]')).toBeNull()
  expect(view.container.textContent).not.toContain('通信状態を確認して')
})

describe('アーカイブの失敗', () => {
  async function openArchive() {
    await start()
    fireEvent.click(screen.getByRole('button', { name: 'ウェビナー「入門ウェビナー」の操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'アーカイブする' }))
    return screen.getByRole('dialog')
  }

  it('失敗しても対象を失わず、同じ窓で理由を出してやり直せる', async () => {
    mocks.archive.mockRejectedValueOnce(new ApiError(500, 'boom'))
    const dialog = await openArchive()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'アーカイブする' })) })
    await screen.findByText('アーカイブできませんでした。状態を読み直して、もう一度お試しください。')
    expect(screen.getByRole('dialog').textContent).toContain('入門ウェビナー')
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'アーカイブする' })) })
    expect(mocks.archive).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('公開中で断られたら、先に公開を止めるよう言う', async () => {
    mocks.archive.mockRejectedValueOnce(new ApiError(409, 'conflict'))
    const dialog = await openArchive()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'アーカイブする' })) })
    await screen.findByText('公開中のウェビナーは、先に公開を停止してください。')
  })

  it('処理中はキャンセルで閉じない', async () => {
    const pending = Promise.withResolvers<unknown>()
    mocks.archive.mockReturnValueOnce(pending.promise)
    const dialog = await openArchive()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'アーカイブする' })) })
    const cancel = within(screen.getByRole('dialog')).queryByRole('button', { name: 'キャンセル' })
    if (cancel) await act(async () => { fireEvent.click(cancel) })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog').textContent).toContain('入門ウェビナー')
    await act(async () => { pending.resolve({ data: { success: true } }) })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

it('アーカイブの口は消さずに POST で送る', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  const calls: Array<{ url: string; method: string | undefined }> = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method })
    return new Response(JSON.stringify({ data: webinar({ status: 'archived' }) }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  try {
    await actual.webinarApi.archive('webinar-1')
  } finally {
    vi.unstubAllGlobals()
  }
  expect(calls).toHaveLength(1)
  expect(calls[0].method).toBe('POST')
  expect(new URL(calls[0].url).pathname).toBe('/api/webinars/webinar-1/archive')
})
it('ウェビナーのフォルダ名を編集中は画面移動前に確認する', async () => {
  await start()
  fireEvent.click(screen.getByRole('button', { name: 'フォルダを追加' }))
  const dialog = screen.getByRole('dialog')
  fireEvent.change(dialog.querySelector('[data-folder-name-color] input')!, { target: { value: '商品説明' } })
  const link = document.createElement('a')
  link.href = '/events'
  link.textContent = 'イベントへ'
  document.body.append(link)
  fireEvent.click(link)
  expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
  link.remove()
})
it('フォルダをキャンセルして破棄を選んだら確認は一度で閉じる', async () => {
  await start()
  fireEvent.click(screen.getByRole('button', { name: 'フォルダを追加' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'フォルダ名' }), { target: { value: '商品説明' } })
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  const confirm = screen.getByRole('dialog', { name: '入力を破棄しますか？' })
  fireEvent.click(within(confirm).getByRole('button', { name: '破棄する' }))
  expect(screen.queryByRole('dialog', { name: '保存していない変更があります' })).toBeNull()
  expect(screen.queryByRole('dialog', { name: 'フォルダを追加する' })).toBeNull()
})
