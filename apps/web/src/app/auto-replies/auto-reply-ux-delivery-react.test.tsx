// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const listReplies = vi.hoisted(() => vi.fn())
const updateReply = vi.hoisted(() => vi.fn())
const stopReply = vi.hoisted(() => vi.fn())
const listTemplates = vi.hoisted(() => vi.fn())
const summary = vi.hoisted(() => vi.fn())
const listFolders = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      autoReplies: { ...actual.api.autoReplies, list: listReplies, update: updateReply, stop: stopReply, summary },
      templates: { ...actual.api.templates, list: listTemplates },
      folders: { ...actual.api.folders, list: listFolders },
      staff: { ...actual.api.staff, me: async () => ({ success: true, data: { role: 'owner' } }) },
    },
  }
})

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/auto-replies',
  useSearchParams: () => new URLSearchParams(''),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', accounts: [{ id: 'account-a', name: '本店' }], loading: false }),
}))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))

import AutoRepliesPage from './page'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'

function rule(id: string, name: string, isActive: boolean, lifecycleStatus: string) {
  return {
    id, name, keyword: '予約', matchType: 'contains', keywords: null, respondToAll: false,
    isActive, lifecycleStatus, hits: { period: 1, total: 2 },
    responseContent: 'ご予約を承ります', keywordMatchMode: 'any',
    activeFrom: null, activeUntil: null, responseWeekdays: null, responseHolidayRule: null,
    cooldownMinutes: null, skipWhenOperatorActive: false, oncePerFriend: false,
    messageKinds: null, friendConditions: null, folderId: null, priority: id === 'ar-1' ? 1 : 2,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  }
}

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  listReplies.mockImplementation(async () => ({
    success: true,
    data: [rule('ar-1', '止まっている方', false, 'stopped'), rule('ar-2', '動いている方', true, 'published')],
  }))
  listTemplates.mockImplementation(async () => ({ success: true, data: [] }))
  summary.mockImplementation(async () => ({ success: true, data: { conflictCount: 0 } }))
  listFolders.mockImplementation(async () => ({ success: true, data: [], unfiledCount: 0 }))
  updateReply.mockImplementation(async () => ({ success: true, data: {} }))
  stopReply.mockImplementation(async () => ({ success: true, data: {} }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  clearToastsForTest()
  delete document.documentElement.dataset.theme
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

async function eventually(check: () => void, timeout = 5000) {
  const started = Date.now()
  while (true) {
    try { check(); return } catch (error) {
      if (Date.now() - started >= timeout) throw error
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    }
  }
}

function renderPage() {
  act(() => {
    root.render(<><AutoRepliesPage /><ToastHost /></>)
  })
}

test('まとめて再開は確認なしですぐ反映し、元に戻すを出さない', async () => {
  // 裁定 C：5秒待たない。通った変更は口にも残る想定で、読み直しも新しい札を返す。
  const active = new Map([['ar-1', false], ['ar-2', true]])
  listReplies.mockImplementation(async () => ({
    success: true,
    data: [
      rule('ar-1', '止まっている方', active.get('ar-1')!, 'stopped'),
      rule('ar-2', '動いている方', active.get('ar-2')!, 'published'),
    ],
  }))
  updateReply.mockImplementation(async (id: string) => {
    active.set(id, true)
    return { success: true, data: {} }
  })
  stopReply.mockImplementation(async (id: string) => {
    active.set(id, false)
    return { success: true, data: {} }
  })
  renderPage()
  await eventually(() => {
    if (!host.textContent?.includes('止まっている方')) throw new Error('no rows yet')
  })
  const checkbox = host.querySelector('[aria-label="止まっている方を選択"]') as HTMLElement
  expect(checkbox).toBeTruthy()
  await act(async () => { checkbox.click() })
  const bulkResume = [...host.querySelectorAll('button')].find((b) => b.textContent === 'まとめて再開') as HTMLElement
  expect(bulkResume).toBeTruthy()
  await act(async () => { bulkResume.click() })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  // 窓を閉じた瞬間に有効の札へ（裏の保存を待たない）。
  await eventually(() => {
    const pills = [...host.querySelectorAll('span')].filter((s) => s.textContent === '有効')
    if (pills.length < 2) throw new Error('not yet optimistic')
  })
  // 待たずに送られている（取り消し線ではなく送信）。
  await eventually(() => {
    if (updateReply.mock.calls.length < 1) throw new Error('not yet sent')
  })
  expect(updateReply.mock.calls[0][0]).toBe('ar-1')
  expect([...host.querySelectorAll('button')].some((b) => b.textContent === '元に戻す')).toBe(false)
  expect(stopReply).not.toHaveBeenCalled()
})

test('読み込み中は出来上がりと同じ形の骨組みを出す', async () => {
  listReplies.mockImplementation(() => new Promise(() => undefined) as unknown as Promise<never>)
  renderPage()
  await eventually(() => {
    if (!host.querySelector('[aria-busy="true"] [data-skeleton]')) throw new Error('no skeleton yet')
  }, 8000)
})
