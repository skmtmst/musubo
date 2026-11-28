// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type WebinarListItem, type WebinarListParams } from '@/lib/api'
import WebinarList from './page'

const mocks = vi.hoisted(() => ({ list: vi.fn(), folders: vi.fn(), overview: vi.fn(), archive: vi.fn(), grand: 1 }))
vi.mock('@/lib/api', async (original) => ({ ...await original<typeof import('@/lib/api')>(), webinarApi: mocks }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-1', accounts: [{ id: 'account-1' }], loading: false }) }))
vi.mock('@/lib/staff-role', async (original) => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))

function webinar(overrides: Partial<WebinarListItem> = {}): WebinarListItem {
  return {
    id: 'webinar-1', accountId: 'account-1', title: '入門ウェビナー', slug: 'intro', status: 'draft',
    videoPrefix: null, durationSeconds: 1800, schedule: [], cta: null, tagOnAttend: null, tagOnCtaClick: null,
    folderId: null, folderName: null, registrationCount: 12, viewerCount: 8,
    createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-08T00:00:00Z', ...overrides,
  }
}
const response = (items: WebinarListItem[], total = items.length) => ({ data: { items, total, limit: 20, sort: [] } })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const queryCalls = () => mocks.list.mock.calls.filter(([, params]) => Boolean(params.q))
const row = (name = '入門ウェビナー') => screen.getByRole('link', { name: `「${name}」の詳細を見る` })
async function start() {
  const view = render(<WebinarList />)
  await screen.findByRole('link', { name: '「入門ウェビナー」の詳細を見る' })
  return view
}
async function search(value: string) {
  fireEvent.change(screen.getByRole('searchbox', { name: 'ウェビナー名で探す' }), { target: { value } })
  await waitFor(() => expect(queryCalls().some(([, params]) => params.q === value)).toBe(true))
}
async function openArchive() {
  fireEvent.click(screen.getByRole('button', { name: 'ウェビナー「入門ウェビナー」の操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'アーカイブする' }))
  return screen.getByRole('dialog')
}
beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/webinars')
  window.dispatchEvent(new PopStateEvent('popstate'))
  document.documentElement.dataset.theme = 'v8'
  mocks.grand = 1
  mocks.list.mockImplementation(async (_account, params: WebinarListParams) => params.limit === 1 ? response([], mocks.grand) : response([webinar()]))
  mocks.folders.mockResolvedValue({ success: true, data: [] })
  mocks.overview.mockResolvedValue({ data: null })
  mocks.archive.mockResolvedValue({ data: { success: true } })
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('ウェビナー一覧の検索操作', () => {
  it('入力を連打しても最後の値だけを300ms後にAPIへ渡す', async () => {
    await start()
    vi.useFakeTimers()
    const input = screen.getByRole('searchbox', { name: 'ウェビナー名で探す' })
    for (const value of ['途', '途中']) {
      fireEvent.change(input, { target: { value } })
      await act(async () => { vi.advanceTimersByTime(200) })
    }
    fireEvent.change(input, { target: { value: '最終' } })
    await act(async () => { vi.advanceTimersByTime(299) })
    expect(queryCalls()).toHaveLength(0)
    await act(async () => { vi.advanceTimersByTime(1) })
    expect(queryCalls()).toHaveLength(1)
    expect(queryCalls()[0]).toEqual(['account-1', expect.objectContaining({ q: '最終', page: 1 })])
  })
  it('遅い古い応答が、新しい検索結果を上書きしない', async () => {
    await start()
    const old = deferred<ReturnType<typeof response>>()
    const next = deferred<ReturnType<typeof response>>()
    mocks.list.mockImplementation((_account, params) => params.q === '古い' ? old.promise : params.q === '新しい' ? next.promise : Promise.resolve(response([webinar()])))
    await search('古い'); await search('新しい')
    await act(async () => next.resolve(response([webinar({ id: 'new', title: '新しい結果' })])))
    expect(row('新しい結果')).toBeTruthy()
    await act(async () => old.resolve(response([webinar({ id: 'old', title: '古い結果' })])))
    expect(screen.queryByRole('link', { name: '「古い結果」の詳細を見る' })).toBeNull()
    expect(row('新しい結果')).toBeTruthy()
  })
})
describe('ウェビナー一覧の表示状態と操作', () => {
  it('行のある一覧でも作る操作に古い名前を使わない', async () => {
    await start()
    expect(row()).toBeTruthy()
    expect(screen.queryByText('ウェビナーを作成')).toBeNull()
    expect(screen.queryByText('ウェビナーをつくる')).toBeNull()
    for (const link of screen.getAllByRole('link', { name: 'ウェビナーを作る' })) expect(link.getAttribute('href')).toBe('/webinars/new')
  })
  it('検索中も直前の一覧を残す', async () => {
    await start()
    const pending = deferred<ReturnType<typeof response>>()
    mocks.list.mockReturnValue(pending.promise)
    await search('検索中')
    await screen.findByText('検索中…')
    expect(row()).toBeTruthy()
    expect(screen.queryByText('ウェビナーの一覧を読み込んでいます')).toBeNull()
    await act(async () => pending.resolve(response([webinar()])))
  })
  it('0件を「全体が空」と「検索結果が空」に分けて描く', async () => {
    mocks.grand = 0
    mocks.list.mockImplementation(async (_account, params) => response([], params.limit === 1 ? mocks.grand : 0))
    const view = render(<WebinarList />)
    await screen.findByText('まだウェビナーがありません')
    expect(screen.getByRole('link', { name: '最初のウェビナーを作る' })).toBeTruthy()
    view.unmount(); mocks.grand = 4; render(<WebinarList />)
    await screen.findByText('条件に合うものがありません')
    expect(screen.getByRole('button', { name: '条件を外す' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: '最初のウェビナーを作る' })).toBeNull()
  })
  it('読込・空・失敗は共通の状態表示で、表と二重の面にならない(DETAIL-01)', async () => {
    const pending = deferred<ReturnType<typeof response>>()
    mocks.list.mockReturnValue(pending.promise)
    const view = render(<WebinarList />)
    expect(view.container.querySelector('[aria-busy="true"]')).toBeTruthy()
    expect(view.container.querySelector('[data-row-id]')).toBeNull()
    await act(async () => pending.reject(new ApiError(500, 'failed')))
    await screen.findByText('ウェビナーを読み込めませんでした')
    expect(view.container.querySelectorAll('[data-list-state]')).toHaveLength(1)
    expect(view.container.querySelector('[data-row-id]')).toBeNull()
    mocks.grand = 0; mocks.list.mockResolvedValue(response([]))
    fireEvent.click(within(view.container.querySelector('[data-list-state="error"]') as HTMLElement).getByRole('button', { name: 'もう一度読み込む' }))
    // 全体件数の補助取得も失敗している。未知の件数を0件にしない。
    await screen.findByText('条件に合うものがありません')
    expect(view.container.querySelectorAll('[data-empty-list]')).toHaveLength(1)
    expect(view.container.querySelector('[data-row-id]')).toBeNull()
  })
  it('新規作成の操作名は現在の入口と空の一覧へつながる(DETAIL-02)', async () => {
    mocks.grand = 0; mocks.list.mockResolvedValue(response([])); render(<WebinarList />)
    await screen.findByText('まだウェビナーがありません')
    expect(screen.queryByText('ウェビナーを作成')).toBeNull()
    expect(screen.queryByText('ウェビナーをつくる')).toBeNull()
    const links = screen.getAllByRole('link', { name: 'ウェビナーを作る' })
    expect(links.length).toBeGreaterThan(0)
    for (const link of [...links, screen.getByRole('link', { name: '最初のウェビナーを作る' })]) expect(link.getAttribute('href')).toBe('/webinars/new')
  })
  it('再検索が失敗しても直前の行を残し、再読み込み操作を受け付ける', async () => {
    await start(); mocks.list.mockRejectedValue(new ApiError(500, 'failed')); await search('失敗')
    await screen.findByText('ウェビナーを表示できませんでした')
    expect(row()).toBeTruthy()
    mocks.list.mockResolvedValue(response([webinar({ title: '再取得した結果' })]))
    const notice = screen.getByText('ウェビナーを表示できませんでした').closest('[data-design-part="notice"]') as HTMLElement
    fireEvent.click(within(notice).getByRole('button', { name: 'もう一度読み込む' }))
    await screen.findByRole('link', { name: '「再取得した結果」の詳細を見る' })
    expect(screen.queryByText('ウェビナーを表示できませんでした')).toBeNull()
  })
})
describe('ウェビナーのアーカイブ操作', () => {
  it('公開中は停止への次操作を出し、アーカイブ確定を実行できない', async () => {
    mocks.list.mockResolvedValue(response([webinar({ status: 'active' })])); await start()
    const dialog = await openArchive()
    expect(within(dialog).getByText(/先に公開を停止してから/)).toBeTruthy()
    expect(within(dialog).getByRole('link', { name: '編集画面で公開を停止する' }).getAttribute('href')).toBe('/webinars/edit?id=webinar-1')
    expect(within(dialog).queryByRole('button', { name: 'アーカイブする' })).toBeNull()
    expect(mocks.archive).not.toHaveBeenCalled()
  })
  it('停止中は確認内容を描き、確定操作を実行する', async () => {
    await start(); const dialog = await openArchive()
    expect(within(dialog).getByText(/参加者・視聴の記録・分析はそのまま見られます/)).toBeTruthy()
    expect(mocks.archive).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'アーカイブする' }))
    await waitFor(() => expect(mocks.archive).toHaveBeenCalledWith('webinar-1'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})
