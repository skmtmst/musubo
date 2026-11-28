// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: 'acc-1',
    selectedAccount: { id: 'acc-1', name: '店舗A' },
    loading: false,
  }),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(window.location.search),
  usePathname: () => '/rich-menus/edit',
}))

import RichMenuCreateV8 from './create'
import { getPageAction } from '@/test-utils/page-action'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const makeArea = (id: string, label: string, x: number) => ({
  id,
  boundsX: x,
  boundsY: 0,
  boundsWidth: 833,
  boundsHeight: 843,
  actionType: 'uri' as const,
  actionData: { uri: 'https://nen.example/' },
  intent: 'url' as const,
  label,
  tagIds: [],
  scoreChange: null,
  templateId: null,
  formId: null,
  trackedLinkId: null,
})

const makePage = (id: string, orderIndex: number, name: string) => ({
  id,
  orderIndex,
  name,
  aliasId: `alias-${id}`,
  lineRichmenuId: null,
  imageR2Key: null,
  imageContentType: null,
  areas: [makeArea(`a-${id}`, '予約する', 0)],
})

const VALID_GROUP = {
  id: 'rmg-x',
  accountId: 'acc-1',
  name: '通常メニュー',
  chatBarText: 'メニュー',
  size: 'large',
  isDefaultForAll: true,
  status: 'draft',
  targetingPriority: 1,
  targetingEnabled: false,
  targetingCondition: null,
  folderId: null,
  displayOrder: 1,
  version: 1,
  publishingGeneration: 0,
  defaultPageId: 'p-1',
  pages: [makePage('p-1', 0, 'トップ')],
}

let host: HTMLDivElement
let root: Root
let groupBody: unknown = VALID_GROUP
const writes: Array<{ method: string; path: string }> = []
let getCount = 0

function stubFetch() {
  writes.length = 0
  getCount = 0
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    const parsed = new URL(String(url), 'http://localhost')
    const method = (init?.method ?? 'GET').toUpperCase()
    if (parsed.pathname === '/api/staff/me') {
      return { ok: true, status: 200, json: async () => ({ success: true, data: { id: 'owner-1', role: 'owner' } }) }
    }
    if (parsed.pathname === '/api/rich-menu-groups/rmg-x' && method === 'PATCH') {
      writes.push({ method, path: parsed.pathname })
      return { ok: true, status: 200, json: async () => ({ success: true, data: VALID_GROUP }) }
    }
    if (parsed.pathname === '/api/rich-menu-groups' && method === 'POST') {
      writes.push({ method, path: parsed.pathname })
      return { ok: true, status: 200, json: async () => ({ success: true, data: VALID_GROUP }) }
    }
    if (parsed.pathname === '/api/rich-menu-groups/rmg-x' && method === 'GET') {
      getCount += 1
      return { ok: true, status: 200, json: async () => ({ success: true, data: groupBody }) }
    }
    if (parsed.pathname === '/api/rich-menu-groups') {
      return { ok: true, status: 200, json: async () => ({ success: true, data: { items: [], total: 0, page: 1, limit: 200 } }) }
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) }
  }))
}

async function settle() {
  for (let i = 0; i < 12; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

async function openEdit() {
  window.history.replaceState(null, '', '/rich-menus/edit?id=rmg-x')
  await act(async () => {
    root.render(<RichMenuCreateV8 editGroupId="rmg-x" />)
  })
  await settle()
}

beforeEach(() => {
  groupBody = VALID_GROUP
  stubFetch()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

describe('rich-menus/new/create-hydration の既存メニュー破損データガード', () => {
  it.each([
    ['未知のサイズ', { ...VALID_GROUP, size: 'huge' }],
    ['ページが空配列', { ...VALID_GROUP, pages: [] }],
    ['ページ数が上限超え（4ページ）', { ...VALID_GROUP, pages: [makePage('p-1', 0, '1'), makePage('p-2', 1, '2'), makePage('p-3', 2, '3'), makePage('p-4', 3, '4')] }],
    ['面の配列が欠損', { ...VALID_GROUP, pages: [{ ...makePage('p-1', 0, 'トップ'), areas: null }] }],
  ])('%sのデータは既定値へ置き換えず読み込み失敗を表示し、編集・保存をさせない', async (_label, malformed) => {
    groupBody = malformed
    await openEdit()

    expect(host.textContent).toContain('リッチメニューを読み込めませんでした')
    expect(screen.getByRole('button', { name: 'もう一度読み込む' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '下書きを保存' })).toBeNull()
    expect(writes).toEqual([])

    // 再読み込みで正しいデータが返れば、そのまま編集画面を開ける
    groupBody = VALID_GROUP
    const beforeRetry = getCount
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    })
    await settle()

    expect(getCount).toBeGreaterThan(beforeRetry)
    expect(host.textContent).not.toContain('リッチメニューを読み込めませんでした')
    const nameInput = document.getElementById('rm-name') as HTMLInputElement | null
    expect(nameInput?.value).toBe('通常メニュー')
    expect(getPageAction({ name: '下書きを保存', exact: true })).toBeTruthy()
  })

  it('正しい既存メニューデータは前どおり編集画面が開き、下書きを保存できる', async () => {
    groupBody = VALID_GROUP
    await openEdit()

    expect(host.textContent).not.toContain('リッチメニューを読み込めませんでした')
    const nameInput = document.getElementById('rm-name') as HTMLInputElement | null
    expect(nameInput?.value).toBe('通常メニュー')

    await act(async () => {
      fireEvent.click(getPageAction({ name: '下書きを保存', exact: true }))
    })
    await settle()

    expect(writes).toEqual([{ method: 'PATCH', path: '/api/rich-menu-groups/rmg-x' }])
  })
})
