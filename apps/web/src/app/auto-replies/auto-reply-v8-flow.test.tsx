import { getPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
/**
 * V8 自動応答の通し試験（見た目のみ）。
 * 流れ：作る→有効にする→止める→再開する。
 * 各段で「押せる・窓の開閉・保存後の知らせ・一覧の変化」を確かめる。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const navState = vi.hoisted(() => ({ query: '', pushes: [] as string[], replaces: [] as string[] }))
const pushMock = vi.hoisted(() => vi.fn((url: string) => { navState.pushes.push(url) }))
const replaceMock = vi.hoisted(() => vi.fn((url: string) => {
  navState.replaces.push(url)
  navState.query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : ''
}))

const listReplies = vi.hoisted(() => vi.fn())
const stopReply = vi.hoisted(() => vi.fn())
const updateReply = vi.hoisted(() => vi.fn())
const summaryReplies = vi.hoisted(() => vi.fn())
const listTemplates = vi.hoisted(() => vi.fn())
const listFolders = vi.hoisted(() => vi.fn())
const staffMe = vi.hoisted(() => vi.fn())
const createDraft = vi.hoisted(() => vi.fn())
const saveDraft = vi.hoisted(() => vi.fn())
const validateDraft = vi.hoisted(() => vi.fn())
const testDraft = vi.hoisted(() => vi.fn())
const publishDraft = vi.hoisted(() => vi.fn())
const conflicts = vi.hoisted(() => vi.fn())
const listFriends = vi.hoisted(() => vi.fn())
const getDraft = vi.hoisted(() => vi.fn())
const getLive = vi.hoisted(() => vi.fn())
const savedBody = vi.hoisted(() => ({ body: null as Record<string, unknown> | null }))

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
    replace: replaceMock,
    refresh: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  }),
  useSearchParams: () => new URLSearchParams(navState.query),
}))

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
    }
  },
  describeSaveFailure: (caught: unknown) =>
    caught instanceof Error ? caught.message : '保存できませんでした',
  api: {
    autoReplies: {
      list: listReplies,
      stop: stopReply,
      update: updateReply,
      summary: summaryReplies,
      createDraft,
      saveDraft,
      validateDraft,
      testDraft,
      publishDraft,
      conflicts,
      getDraft,
      get: getLive,
    },
    templates: { list: listTemplates },
    folders: { list: listFolders },
    friends: { list: listFriends },
    staff: { me: staffMe },
  },
}))

const accountState = vi.hoisted(() => ({
  selectedAccountId: 'account-a',
  accounts: [{ id: 'account-a', name: '本店' }],
  loading: false,
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => accountState,
}))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))

vi.mock('@/components/auto-replies/inline-action-list', () => ({
  default: () => null,
  useActionOptions: () => ({ tags: [], fields: [], marks: [], scenarios: [], vars: [] }),
}))
// 手順③の処理の行（V8）も、今までの処理の並びと同じく通しの試験では空にする（中身は部品の試験で見る）。
vi.mock('@/components/auto-replies/inline-action-rows-v8', () => ({ default: () => null, actionRowTitle: () => '' }))
vi.mock('@/components/shared/condition-builder', () => ({ default: () => null }))
vi.mock('@/components/shared/image-uploader', () => ({ default: () => null }))

import AutoRepliesPage from './page'
import AutoReplyEditPage from './edit/page'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

const draftRule = {
  id: 'ar-1',
  name: '流れの型',
  keyword: '予約',
  matchType: 'contains',
  keywords: null,
  respondToAll: false,
  isActive: true,
  confirmationRevision: 1,
  lifecycleStatus: 'published',
  hits: { period: 3, total: 10 },
  responseContent: 'ご予約を承ります',
  keywordMatchMode: 'any',
  activeFrom: null,
  activeUntil: null,
  responseWeekdays: null,
  responseHolidayRule: null,
  cooldownMinutes: null,
  skipWhenOperatorActive: false,
  priority: 10,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
}

let rules: Array<typeof draftRule>

function renderNode(node: React.ReactNode) {
  act(() => {
    root.render(<>{node}<ToastHost /></>)
  })
}

async function flush() {
  for (let i = 0; i < 8; i++) {
    await act(async () => { await Promise.resolve() })
  }
}

function openRowMenu() {
  const menuButton = host.querySelector('button[title="自動応答「流れの型」の操作"]') as HTMLButtonElement
  expect(menuButton, '行の「…」ボタンが見つかりません').toBeTruthy()
  act(() => { menuButton.click() })
  const menu = document.querySelector('[role="menu"]')
  expect(menu, '操作メニューが開きません').toBeTruthy()
  // 板 ：行の「…」を開いた印
  expect(host.querySelector('[data-design-node="IIesG"]'), 'IIesG の印がありません').toBeTruthy()
  return menu as HTMLElement
}

beforeEach(() => {
  const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } }
  if (!g.crypto) g.crypto = {}
  if (!g.crypto.randomUUID) g.crypto.randomUUID = () => 'test-uuid-1'
  document.documentElement.dataset.theme = 'v8'
  rules = [{ ...draftRule }]
  listReplies.mockImplementation(async () => ({ success: true, data: rules }))
  stopReply.mockImplementation(async (id: string) => {
    rules = rules.map((r) => (r.id === id ? { ...r, isActive: false } : r))
    return { success: true, data: null }
  })
  updateReply.mockImplementation(async (id: string) => {
    rules = rules.map((r) => (r.id === id ? { ...r, isActive: true } : r))
    return { success: true, data: null }
  })
  summaryReplies.mockImplementation(async () => ({ success: true, data: { conflictCount: 0 } }))
  listTemplates.mockImplementation(async () => ({ success: true, data: [] }))
  listFolders.mockImplementation(async () => ({ success: true, data: [], unfiledCount: 0 }))
  staffMe.mockImplementation(async () => ({ success: true, data: { role: 'owner' } }))
  createDraft.mockImplementation(async (body: Record<string, unknown>) => {
    savedBody.body = body
    return {
      success: true,
      data: {
        autoReplyId: 'ar-new',
        versionId: 'v1',
        versionNumber: 1,
        status: 'draft',
        settings: { lineAccountId: 'account-a' },
        lastTestStatus: null,
        lastTestedAt: null,
        publishedAt: null,
      },
    }
  })
  saveDraft.mockImplementation(async (id: string, body: Record<string, unknown>) => {
    savedBody.body = body
    return {
      success: true,
      data: {
        autoReplyId: 'ar-new',
        versionId: 'v2',
        versionNumber: 2,
        status: 'draft',
        settings: { lineAccountId: 'account-a' },
        lastTestStatus: null,
        lastTestedAt: null,
        publishedAt: null,
      },
    }
  })
  getDraft.mockImplementation(async () => ({
    success: true,
    data: {
      autoReplyId: 'ar-new',
      versionId: 'v2',
      versionNumber: 2,
      status: 'draft',
      settings: savedBody.body ?? { lineAccountId: 'account-a' },
      lastTestStatus: null,
      lastTestedAt: null,
      publishedAt: null,
      matchedLast28Days: null,
    },
  }))
  getLive.mockImplementation(async () => ({
    success: true,
    data: { isActive: false, lifecycleStatus: 'draft' },
  }))
  validateDraft.mockImplementation(async () => ({ success: true, data: { errors: [], conflicts: [] } }))
  testDraft.mockImplementation(async () => ({
    success: true,
    data: { draftWon: true, winner: null, candidates: [], staleTest: false },
  }))
  publishDraft.mockImplementation(async () => ({ success: true, data: { versionNumber: 1 } }))
  conflicts.mockImplementation(async () => ({ success: true, data: { conflicts: [] } }))
  listFriends.mockImplementation(async () => ({
    success: true,
    data: { items: [{ id: 'f-1', displayName: '試す友だち' }], total: 1 },
  }))
  navState.query = ''
  navState.pushes.length = 0
  navState.replaces.length = 0
  savedBody.body = null
  pushMock.mockClear()
  replaceMock.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  clearToastsForTest()
  delete document.documentElement.dataset.theme
  vi.clearAllMocks()
})

describe('V8 自動応答の通し：作る→止める→再開する', () => {
  it('「＋ ルールを作る」で作成へ進む', async () => {
    renderNode(<AutoRepliesPage />)
    await flush()
    const creates = screen.getAllByRole('button', { name: '＋ ルールを作る' })
    expect(screen.getByText('流れの型').closest('[data-template-region="content"]')?.closest('[data-page-template="list"]')).toBeTruthy()
    expect(creates.length).toBeGreaterThan(0)
    // 絵  の「＋ ルールを作る ▾」は、くわしく作る／かんたんに作るを選ぶ窓を開く。
    act(() => { creates[0].click() })
    expect(pushMock).not.toHaveBeenCalled()
    fireEvent.click(within(document.querySelector('[role="menu"]') as HTMLElement).getByText('くわしく作る'))
    expect(pushMock).toHaveBeenCalledWith('/auto-replies/edit')
  })

  it('止める窓は開いて閉じる・止めると知らせと札が変わる', async () => {
    renderNode(<AutoRepliesPage />)
    await flush()

    // 窓を開いて閉じる。
    openRowMenu()
    fireEvent.click(within(document.querySelector('[role="menu"]') as HTMLElement).getByText('止める'))
    const stopDialog = await screen.findByRole('dialog')
    // 絵  の題は「「〇〇」を止める」。
    expect(stopDialog.textContent).toMatch(/^「.+」を止める/)
    fireEvent.click(within(stopDialog).getByRole('button', { name: 'キャンセル' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(stopReply).not.toHaveBeenCalled()

    // 止めるを実行する。
    openRowMenu()
    fireEvent.click(within(document.querySelector('[role="menu"]') as HTMLElement).getByText('止める'))
    const stopDialog2 = await screen.findByRole('dialog')
    expect(stopDialog2.textContent).toMatch(/^「.+」を止める/)
    fireEvent.click(within(stopDialog2).getByRole('button', { name: '止める' }))
    await waitFor(() => expect(stopReply).toHaveBeenCalledTimes(1))
    await screen.findByText('自動応答を停止しました')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // 読み直すと行の札が「停止中」になる。
    const stoppedRow = screen.getByText('流れの型').closest('tr') as HTMLElement
    await waitFor(() => expect(within(stoppedRow).queryByText('停止中')).toBeTruthy())
  })

  it('再開すると知らせと札が戻る', async () => {
    rules = [{ ...draftRule, isActive: false, lifecycleStatus: 'published' }]
    renderNode(<AutoRepliesPage />)
    await flush()
    await screen.findByText('停止中')

    openRowMenu()
    fireEvent.click(within(document.querySelector('[role="menu"]') as HTMLElement).getByText('再開する'))
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(updateReply).toHaveBeenCalledTimes(1))
    await screen.findByText('自動応答を再開しました')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const resumedRow = screen.getByText('流れの型').closest('tr') as HTMLElement
    await waitFor(() => expect(within(resumedRow).queryByText('有効')).toBeTruthy())
  })
})

describe('V8 自動応答の通し：作って有効にする', () => {
  async function goStep(step: string) {
    navState.query = step.includes('?') ? step.slice(step.indexOf('?') + 1) : step
    renderNode(<AutoReplyEditPage />)
    await flush()
  }

  it('入力不足は該当欄へ移り、理由を一度だけ出して保存を止める', async () => {
    const scroll = vi.fn()
    const originalScroll = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = scroll
    try {
      await goStep('step=trigger')
      fireEvent.click(screen.getByRole('button', { name: /^次へ：/ }))
      const keywordInput = screen.getByLabelText('反応する言葉を足す')
      expect(keywordInput.closest('[data-template-region="content"]')?.closest('[data-page-template="create"]')).toBeTruthy()
      await waitFor(() => expect(document.activeElement).toBe(keywordInput))
      expect(keywordInput.getAttribute('aria-invalid')).toBe('true')
      expect(screen.getAllByText('反応する言葉を入れてください')).toHaveLength(1)
      expect(scroll).toHaveBeenLastCalledWith({ block: 'center' })
      expect(replaceMock).not.toHaveBeenCalled()
      expect(createDraft).not.toHaveBeenCalled()

      fireEvent.change(keywordInput, { target: { value: '予約変更' } })
      fireEvent.keyDown(keywordInput, { key: 'Enter' })
      fireEvent.click(screen.getByRole('button', { name: /^次へ：/ }))
      await goStep(navState.replaces[navState.replaces.length - 1])
      fireEvent.click(screen.getByRole('button', { name: /^次へ：/ }))
      const contentInput = host.querySelector('#wiz-content') as HTMLTextAreaElement
      await waitFor(() => expect(document.activeElement).toBe(contentInput))
      expect(contentInput.getAttribute('aria-invalid')).toBe('true')
      expect(screen.getAllByText('返す内容を入力してください')).toHaveLength(1)
      expect(createDraft).not.toHaveBeenCalled()

      fireEvent.change(contentInput, { target: { value: '変更を承りました' } })
      expect(screen.queryByText('返す内容を入力してください')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: /^次へ：/ }))
      await waitFor(() => expect(createDraft).toHaveBeenCalledTimes(1))
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScroll
    }
  })

  it('別の手順から保存しても入力を残して最初の不足欄へ移る', async () => {
    await goStep('step=basic')
    fireEvent.change(host.querySelector('#wiz-name') as HTMLInputElement, { target: { value: '入力を残すルール' } })
    fireEvent.click(getPageAction({ name: '下書きとして保存' }))
    expect(replaceMock).toHaveBeenLastCalledWith('/auto-replies/edit?step=trigger')
    expect(createDraft).not.toHaveBeenCalled()
    await goStep(navState.replaces[navState.replaces.length - 1])
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('反応する言葉を足す')))
    expect(screen.getAllByText('反応する言葉を入れてください')).toHaveLength(1)
    await goStep('step=basic')
    expect((host.querySelector('#wiz-name') as HTMLInputElement).value).toBe('入力を残すルール')
  })

  it('基本→条件→返し→順番→確認→有効にする・知らせと完了が出る', async () => {
    await goStep('step=basic')

    // 手順1：名前を入れて次へ。
    const nameInput = host.querySelector('#wiz-name') as HTMLInputElement
    expect(nameInput, 'ルール名の入力が見つかりません').toBeTruthy()
    fireEvent.change(nameInput, { target: { value: '流れの型2' } })
    fireEvent.click(screen.getByRole('button', { name: /^次へ：/ }))
    expect(replaceMock).toHaveBeenLastCalledWith(expect.stringContaining('step=trigger'))
    await goStep(navState.replaces[navState.replaces.length - 1])

    // 手順2：反応する言葉を入れて次へ。
    const keywordInput = screen.getByLabelText('反応する言葉を足す')
    fireEvent.change(keywordInput, { target: { value: '予約変更' } })
    fireEvent.keyDown(keywordInput, { key: 'Enter' })
    // 右の列の試しの文・スマホにも同じ言葉が出るので、反応する言葉の並びの中で探す。
    await within(screen.getByRole('group', { name: '反応する言葉' })).findByText('予約変更')
    fireEvent.click(screen.getByRole('button', { name: /^次へ：/ }))
    await goStep(navState.replaces[navState.replaces.length - 1])

    // 手順3：返す文を入れて次へ（ここで初めて下書きが作られる）。
    const contentInput = host.querySelector('#wiz-content') as HTMLTextAreaElement
    expect(contentInput, '返す文の入力が見つかりません').toBeTruthy()
    fireEvent.change(contentInput, { target: { value: '変更を承りました' } })
    fireEvent.click(screen.getByRole('button', { name: /^次へ：/ }))
    await waitFor(() => expect(createDraft).toHaveBeenCalledTimes(1))
    await screen.findByText('下書きを保存しました')
    await goStep(navState.replaces[navState.replaces.length - 1])

    // 手順4：試す（このルールが返す）→次へ。
    // 保存後の読み直しでも手順が保たれる（URL に id が残る）。
    expect(navState.replaces[navState.replaces.length - 1]).toContain('id=ar-new')
    const testMessage = host.querySelector('#wiz-test-message') as HTMLInputElement
    expect(testMessage, '試す文の入力が見つかりません').toBeTruthy()
    fireEvent.change(testMessage, { target: { value: '予約変更したいです' } })
    fireEvent.click(screen.getByRole('button', { name: '試す' }))
    await waitFor(() => expect(testDraft).toHaveBeenCalledTimes(1))
    await screen.findByText('このルールが返します。')
    fireEvent.click(screen.getByRole('button', { name: /^次へ：/ }))
    // 取得は遷移先のeffectに一本化し、同じ版を一度だけ確かめる。
    await goStep(navState.replaces[navState.replaces.length - 1])
    await waitFor(() => expect(validateDraft).toHaveBeenCalledTimes(1))

    // 手順5：有効にする→知らせと完了・一覧への戻り口。
    const enableButton = screen.getByRole('button', { name: '有効にする' })
    expect(enableButton.hasAttribute('disabled'), '有効にするが押せません').toBe(false)
    fireEvent.click(enableButton)
    await waitFor(() => expect(publishDraft).toHaveBeenCalledTimes(1))
    // 完了の見出しと知らせの両方に出る。
    await waitFor(() => expect(screen.getAllByText('「流れの型2」を有効にしました')).toHaveLength(2))
    await screen.findByText('一覧へ戻る')
  })
})
