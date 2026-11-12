import { getPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
/**
 * V8 リッチメニューの通し試験（見た目のみ）。
 * 流れ：作る→画像と押す所→保存→既定にする（公開）。
 * 各段で「押せる・保存後の知らせ・一覧の変化」を確かめる。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const pushMock = vi.hoisted(() => vi.fn())

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
    replace: vi.fn(),
    refresh: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  }),
  usePathname: () => '/rich-menus',
  useSearchParams: () => new URLSearchParams(''),
}))

const accountState = vi.hoisted(() => ({
  selectedAccountId: 'account-a',
  selectedAccount: { id: 'account-a', name: '本店' },
  accounts: [{ id: 'account-a', name: '本店' }],
  loading: false,
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => accountState,
}))

vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => ({
  ...await importOriginal(), useStaffRole: () => 'owner',
}))

/*
 * 共通の Select は listbox の部品で、その操作は部品自身の試験が持つ。
 * ここで見たいのは選んだ後の流れなので、素の <select> に置き換える。
 */
vi.mock('@/components/shared/select', () => ({
  default: ({ 'aria-label': label, value, onChange, options }: {
    'aria-label'?: string
    value: string
    onChange: (value: string) => void
    options: Array<{ value: string; label: string }>
  }) => React.createElement(
    'select',
    { 'aria-label': label, value, onChange: (e: { target: { value: string } }) => onChange(e.target.value) },
    options.map((option) => React.createElement('option', { key: option.value, value: option.value }, option.label)),
  ),
}))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))

const store = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  group: null as unknown as Record<string, unknown> | null,
}))

const listPage = vi.hoisted(() => vi.fn())
const createGroup = vi.hoisted(() => vi.fn())
const updateGroup = vi.hoisted(() => vi.fn())
const getGroup = vi.hoisted(() => vi.fn())
const publishGroup = vi.hoisted(() => vi.fn())
const scheduleGroup = vi.hoisted(() => vi.fn())

const okGroup = () => ({
  id: 'grp-new',
  accountId: 'account-a',
  name: '流れのメニュー',
  chatBarText: 'メニュー',
  size: 'large',
  defaultPageId: 'pg-1',
  isDefaultForAll: true,
  status: 'draft',
  targetingCondition: null,
  targetingPriority: 0,
  targetingEnabled: false,
  folderId: null,
  defaultOpen: false,
  version: 1,
  publishingGeneration: 0,
  pages: [{
    id: 'pg-1',
    orderIndex: 0,
    name: 'トップ',
    aliasId: '',
    lineRichmenuId: null,
    imageR2Key: null,
    imageContentType: null,
    areas: [{
      id: 'area-1',
      boundsX: 0,
      boundsY: 0,
      boundsWidth: 1250,
      boundsHeight: 843,
      actionType: 'message',
      actionData: {},
    }],
  }],
})

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
    }
  },
  describeSaveFailure: () => '保存できませんでした。もう一度お試しください。',
  describeApiFailure: (_e: unknown, target: string) => `${target}できませんでした`,
  api: {
    folders: { list: vi.fn(async () => ({ success: true, data: [] })) },
    tags: { list: vi.fn(async () => ({ success: true, data: [] })) },
    templates: { list: vi.fn(async () => ({ success: true, data: [] })) },
    forms: { list: vi.fn(async () => ({ success: true, data: [] })) },
    trackedLinks: { list: vi.fn(async () => ({ success: true, data: [] })) },
    media: { contentUrl: (id: string) => `/media/${id}` },
    staff: { me: vi.fn(async () => ({ success: true, data: { role: 'owner' } })) },
    richMenuGroups: {
      listPage,
      list: vi.fn(async () => ({ success: true, data: [] })),
      tapStats: vi.fn(async () => ({ success: true, data: { byArea: [], byGroup: [], total: 0 } })),
      external: vi.fn(async () => ({ success: true, data: { currentDefault: null, lineMenus: [] } })),
      create: createGroup,
      update: updateGroup,
      get: getGroup,
      publish: publishGroup,
      schedule: scheduleGroup,
      uploadImage: vi.fn(async () => ({ success: true, data: null })),
      audienceSummary: vi.fn(async () => ({
        success: true,
        data: {
          total: { value: 10, state: 'available', reason: null },
          targeted: { value: 10, state: 'available', reason: null },
          excluded: { value: 0, state: 'available', reason: null },
          effective: { value: 10, state: 'available', reason: null },
        },
      })),
      previewTargets: vi.fn(async () => ({ success: true, data: null })),
      prepublishCheck: vi.fn(async () => ({
        success: true,
        data: { selfCheck: { ok: true }, deviceConfirmed: true, deviceConfirmedAt: null, pageCount: 1, maxPages: 6 },
      })),
      validatePublish: vi.fn(async () => ({
        success: true,
        data: { checks: [{ key: 'line', ok: true }, { key: 'self', ok: true }] },
      })),
      confirmDevice: vi.fn(async () => ({ success: true, data: { confirmedAt: null } })),
      imageUrl: (key: string) => `/img/${key}`,
    },
  },
}))

vi.mock('@/components/shared/condition-builder', () => ({ default: () => null }))

import RichMenusPage from './page'
import NewRichMenuPage from './new/page'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

const rowGroup = {
  id: 'g-1',
  name: '通常メニュー',
  status: 'published',
  size: 'large',
  chatBarText: 'メニュー',
  isDefaultForAll: true,
  targetingEnabled: false,
  targetingCondition: null,
  publishingAt: null,
  monthlyStats: { taps: 42, uniqueAudience: { value: 30, state: 'ready' } },
  updatedAt: '2026-09-01T00:00:00.000Z',
  createdAt: '2026-09-01T00:00:00.000Z',
}

function renderNode(node: React.ReactNode) {
  act(() => {
    root.render(<>{node}<ToastHost /></>)
  })
}

async function flush() {
  for (let i = 0; i < 10; i++) {
    await act(async () => { await Promise.resolve() })
  }
}

function setInputValue(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

class MemoryStorage {
  private values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, String(value)) }
}

beforeEach(() => {
  const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } }
  if (!g.crypto) g.crypto = {}
  if (!g.crypto.randomUUID) g.crypto.randomUUID = () => 'test-uuid-1'
  vi.stubGlobal('localStorage', new MemoryStorage())
  document.documentElement.dataset.theme = 'v8'
  store.rows = [{ ...rowGroup }]
  store.group = okGroup()
  listPage.mockImplementation(async () => ({
    success: true,
    data: { items: store.rows, total: store.rows.length, facets: { total: 1, published: 1, targeting: 0, draft: 0, folderCounts: {} } },
  }))
  createGroup.mockImplementation(async () => ({ success: true, data: { id: 'grp-new', pages: [{ id: 'pg-1' }] } }))
  updateGroup.mockImplementation(async (_id, patch) => {
    store.group = { ...store.group as Record<string, unknown>, ...patch }
    return { success: true, data: store.group }
  })
  getGroup.mockImplementation(async () => ({ success: true, data: store.group }))
  publishGroup.mockImplementation(async () => ({ success: true, data: { pages: [] } }))
  pushMock.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  clearToastsForTest()
  delete document.documentElement.dataset.theme
  window.history.replaceState(null, '', '/rich-menus')
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('V8 リッチメニューの通し：作る→押す所→保存→既定', () => {
  it('優先度が全部 0 でも並び順の数字は 1・2・3 と位置で出す', async () => {
    store.rows = [
      { ...rowGroup, id: 'g-1', name: 'メニュー1', targetingPriority: 0 },
      { ...rowGroup, id: 'g-2', name: 'メニュー2', targetingPriority: 0 },
      { ...rowGroup, id: 'g-3', name: 'メニュー3', targetingPriority: 0 },
    ]
    renderNode(<RichMenusPage />)
    await flush()
    const numbers = Array.from(host.querySelectorAll('[data-order-number]')).map((el) => el.textContent)
    expect(numbers).toEqual(['1', '2', '3'])
  })

  it('2ページ目の並び順の数字はページを通して 11・12 と出す', async () => {
    store.rows = Array.from({ length: 12 }, (_, i) => ({ ...rowGroup, id: `g-${i + 1}`, name: `メニュー${i + 1}`, targetingPriority: 0 }))
    listPage.mockImplementation(async (_accountId: string, input: { page?: number; limit?: number }) => {
      const page = input.page ?? 1
      const limit = input.limit ?? 20
      return {
        success: true,
        data: { items: store.rows.slice((page - 1) * limit, page * limit), total: store.rows.length, facets: { total: 12, published: 12, targeting: 0, draft: 0, folderCounts: {} } },
      }
    })
    window.history.replaceState(null, '', '/rich-menus?size=10&page=2')
    renderNode(<RichMenusPage />)
    await flush()
    const numbers = Array.from(host.querySelectorAll('[data-order-number]')).map((el) => el.textContent)
    expect(numbers).toEqual(['11', '12'])
  })

  it('並びが「出す順番」でないときは順番の数字を出さない', async () => {
    store.rows = [
      { ...rowGroup, id: 'g-1', name: 'メニュー1', targetingPriority: 0 },
      { ...rowGroup, id: 'g-2', name: 'メニュー2', targetingPriority: 0 },
    ]
    window.history.replaceState(null, '', '/rich-menus?sort=name')
    renderNode(<RichMenusPage />)
    await flush()
    expect(host.querySelectorAll('[data-order-number]')).toHaveLength(0)
    expect(host.textContent).toContain('—')
  })

  it('一覧の「メニューを作る」は作成へ進む', async () => {
    renderNode(<RichMenusPage />)
    await flush()
    await screen.findByText('通常メニュー')
    const creates = screen.getAllByRole('button', { name: /メニューを作る/ })
    expect(creates.length).toBeGreaterThan(0)
    act(() => { creates[0].click() })
    // 作る口は create せず作成画面へ送るだけ。
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/rich-menus/new'))
  })

  it('形と画像→押す所→保存→公開で既定になる', async () => {
    renderNode(<NewRichMenuPage />)
    await flush()

    // 手順①：名前とトーク下の文言を入れて次へ（下書きが作られる）。
    const nameInput = host.querySelector('#rm-name') as HTMLInputElement
    expect(nameInput, '名前の入力が見つかりません').toBeTruthy()
    await act(async () => { setInputValue(nameInput, '流れのメニュー') })
    const chatbarInput = host.querySelector('#rm-chatbar') as HTMLInputElement
    expect(chatbarInput, 'トーク下の文言の入力が見つかりません').toBeTruthy()
    await act(async () => { setInputValue(chatbarInput, 'メニュー') })
    fireEvent.click(screen.getByRole('button', { name: '次へ：ボタンの動き' }))
    await waitFor(() => expect(createGroup).toHaveBeenCalledTimes(1))
    await screen.findByText('下書きを保存しました')

    // 手順②：面を選んで押す所（URL）を決める。
    const areaRow = await screen.findByRole('button', { name: /未設定/ })
    fireEvent.click(areaRow)
    fireEvent.click(await screen.findByRole('radio', { name: 'URLを開く', exact: true }))
    const urlInput = await screen.findByPlaceholderText('例：https://...')
    fireEvent.change(urlInput, { target: { value: 'https://example.com/menu' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'ボタン名 管理用の呼び名。友だちには表示されません。' }), { target: { value: '予約サイト' } })
    // 動きが付いた印に変わる。
    await waitFor(() => expect(screen.queryByText('未設定')).toBeNull())

    // 保存する（知らせがもう1件積まれる）。
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await waitFor(() => expect(updateGroup).toHaveBeenCalled())
    expect(updateGroup.mock.calls.at(-1)?.[1].pages[0].areas[0].label).toBe('予約サイト')
    await waitFor(() => expect(screen.getAllByText('下書きを保存しました')).toHaveLength(2))

    // 全員への公開を確認するため、表示先を明示して④へ進む。
    fireEvent.click(screen.getByRole('button', { name: '次へ：誰に出すか' }))
    await screen.findByText('誰に出すか')
    fireEvent.click(screen.getByRole('radio', { name: /^すべての友だち/ }))
    fireEvent.click(screen.getByRole('button', { name: '次へ：公開' }))
    await waitFor(() => expect(screen.getAllByText('いつ公開するか').length).toBeGreaterThan(0))

    // LINE の検査と実機確認を通して公開する。
    // 確認の一覧は公開の口の応答を待ってから出る。決め打ちで掴むと、
    // 遅い環境で読み込み中のまま落ちる（#1304 の CI 落ち）。
    const lineCheckName = await screen.findByText('LINE の検査')
    const lineCheckRow = lineCheckName.closest('li') as HTMLElement
    fireEvent.click(within(lineCheckRow).getByRole('button', { name: '見直す' }))
    await waitFor(() => expect(screen.getByText('LINEの受付に通りました。')).toBeTruthy())
    const publishButton = screen.getByRole('button', { name: '公開する' }) as HTMLButtonElement
    await waitFor(() => expect(publishButton.disabled).toBe(false))
    fireEvent.click(publishButton)
    const confirm = await screen.findByRole('dialog', { name: '公開の確認' })
    expect(publishGroup).not.toHaveBeenCalled()
    fireEvent.click(within(confirm).getByRole('button', { name: '公開する' }))
    await waitFor(() => expect(publishGroup).toHaveBeenCalledTimes(1))
    // 全員宛ての公開は既定メニューになる。
    await screen.findByText('すべての友だちの既定メニューになりました')
    await screen.findByText('LINEへの登録が終わりました')
    await waitFor(() => expect(screen.getAllByText('一覧へ戻る').length).toBeGreaterThan(0))
  })
})


it.each(['公開する', '予約する'] as const)('未命名の面は下書きを保存でき、%sでは該当欄へ移りAPIを呼ばない', async (action) => {
  renderNode(<NewRichMenuPage />)
  await flush()
  await act(async () => { setInputValue(host.querySelector('#rm-name') as HTMLInputElement, '未命名の下書き') })
  fireEvent.click(screen.getByRole('button', { name: '次へ：ボタンの動き' }))
  await waitFor(() => expect(createGroup).toHaveBeenCalledTimes(1))
  await screen.findByText('下書きを保存しました')
  fireEvent.click(await screen.findByRole('button', { name: /未設定/ }))
  fireEvent.click(await screen.findByRole('radio', { name: 'URLを開く', exact: true }))
  fireEvent.change(await screen.findByPlaceholderText('例：https://...'), { target: { value: 'https://example.com/menu' } })
  expect((screen.getByRole('textbox', { name: 'ボタン名 管理用の呼び名。友だちには表示されません。' }) as HTMLInputElement).value).toBe('')
  fireEvent.click(getPageAction({ name: '下書きを保存' }))
  await waitFor(() => expect(updateGroup).toHaveBeenCalled())
  expect(updateGroup.mock.calls.at(-1)?.[1].pages[0].areas[0].label).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '次へ：誰に出すか' }))
  await screen.findByText('誰に出すか')
  fireEvent.click(screen.getByRole('button', { name: '次へ：公開' }))
  await waitFor(() => expect(screen.getAllByText('いつ公開するか').length).toBeGreaterThan(0))
  const line = (await screen.findByText('LINE の検査')).closest('li') as HTMLElement
  fireEvent.click(within(line).getByRole('button', { name: '見直す' }))
  await screen.findByText('LINEの受付に通りました。')
  if (action === '予約する') fireEvent.click(screen.getByRole('radio', { name: '日時を決めて公開する キャンペーンの始まりに合わせる' }))
  const submit = screen.getByRole('button', { name: action, exact: true }) as HTMLButtonElement
  await waitFor(() => expect(submit.disabled).toBe(false))
  fireEvent.click(submit)
  const name = await screen.findByRole('textbox', { name: 'ボタン名 管理用の呼び名。友だちには表示されません。 ボタン名（読み上げラベル）を入力してください' }) as HTMLInputElement
  await waitFor(() => expect(name.getAttribute('aria-invalid')).toBe('true'))
  expect(screen.getByText('ボタン名（読み上げラベル）を入力してください')).toBeTruthy()
  expect(screen.getByRole('heading', { name: '面 A「1番目のボタン」の動き' })).toBeTruthy()
  await waitFor(() => expect(document.activeElement).toBe(name))
  expect(publishGroup).not.toHaveBeenCalled()
  expect(scheduleGroup).not.toHaveBeenCalled()
})
