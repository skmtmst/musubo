import { expectPermissionLocked } from '@/test-utils/permission-locked-control'
// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

import MediaLibraryPage from './page'

// happy-dom では import.meta.url が file 形にならないため、作業場所からの相対で読む。
const PAGE = readFileSync('src/app/contents/page.tsx', 'utf8')

/*
 * ★V8 登録メディア一覧（板 ）の契約。
 * V8一覧の入口で、
 * 数の帯・フォルダの列・道具の段・札の格子・表示範囲とページ送りが出ること、
 * staff では閲覧のみの帯が出て管理操作が押せない形になることを実DOMで固定する。
 * 帯の数は API の実値だけ（見本の数を直書きしない）。
 */
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: 'account-a', selectedAccount: null, loading: false,
  }),
}))

let staffRole: 'admin' | 'staff' = 'admin'
let readOnly = false

const mediaItems = [
  {
    id: 'media-photo',
    lineAccountId: 'account-a',
    folderId: 'mf-photo',
    filename: '秋の新商品.jpg',
    kind: 'image',
    mimeType: 'image/jpeg',
    sizeBytes: 1200000,
    width: 1200,
    height: 800,
    durationMs: null,
    usageCount: 2,
    archivedAt: null,
    archiveReason: null,
    url: 'https://example.test/photo.jpg',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
  },
  {
    id: 'media-movie',
    lineAccountId: 'account-a',
    folderId: null,
    filename: '使い方ガイド.mp4',
    kind: 'video',
    mimeType: 'video/mp4',
    sizeBytes: 38000000,
    width: null,
    height: null,
    durationMs: 60000,
    usageCount: 1,
    archivedAt: null,
    archiveReason: null,
    url: 'https://example.test/movie.mp4',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
  },
  {
    id: 'media-doc',
    lineAccountId: 'account-a',
    folderId: null,
    filename: 'メニュー表.pdf',
    kind: 'file',
    mimeType: 'application/pdf',
    sizeBytes: 2100000,
    width: null,
    height: null,
    durationMs: null,
    usageCount: 0,
    archivedAt: null,
    archiveReason: null,
    url: 'https://example.test/doc.pdf',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
  },
]

const response = (data: unknown, status = 200) => new Response(
  JSON.stringify(data),
  { status, headers: { 'Content-Type': 'application/json' } },
)

let root: Root | null = null
let host: HTMLDivElement | null = null

/* happy-dom に localStorage が無いときの小さな代替。役割の読み書きだけに使う。 */
function ensureStorage() {
  if (typeof window.localStorage !== 'undefined' && window.localStorage !== null) return
  const store = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => { store.set(key, String(value)) },
      removeItem: (key: string) => { store.delete(key) },
      clear: () => { store.clear() },
    },
  })
}

beforeEach(() => {
  ensureStorage()
  staffRole = 'admin'
  readOnly = false
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/staff/me')) {
      return response({ success: true, data: { id: 'staff-1', role: staffRole, readOnly } })
    }
    if (url.includes('/api/media/quota')) {
      return response({
        success: true,
        data: {
          usageBytes: 3200000000,
          reservedBytes: 0,
          limitBytes: 10000000000,
          remainingBytes: 6800000000,
          usageRate: 0.32,
          state: 'normal',
        },
      })
    }
    if (url.includes('/api/media?') || url.endsWith('/api/media')) {
      const query = new URL(url, 'http://worker.test').searchParams
      let filtered = [...mediaItems]
      const kind = query.get('kind')
      if (kind) filtered = filtered.filter((item) => item.kind === kind)
      if (query.get('unusedOnly') === '1') filtered = filtered.filter((item) => item.usageCount === 0)
      if (query.get('archived') === 'only') filtered = filtered.filter((item) => item.archivedAt != null)
      else filtered = filtered.filter((item) => item.archivedAt == null)
      const limit = Number(query.get('limit') ?? '20')
      const offset = Number(query.get('offset') ?? '0')
      return response({ success: true, data: { items: filtered.slice(offset, offset + limit), total: filtered.length, limit, offset } })
    }
    if (url.includes('/api/folders')) {
      return response({
        success: true,
        data: [{ id: 'mf-photo', kind: 'media', name: '01_商品写真', parentId: null, displayOrder: 0, color: '#2f6fde', itemCount: 1 }],
        unfiledCount: 2,
      })
    }
    return response({ success: false, error: 'not mocked' }, 500)
  }))
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  host?.remove()
  root = null
  host = null
  document.documentElement.removeAttribute('data-theme')
  window.localStorage.clear()
  vi.unstubAllGlobals()
})

async function renderPage() {
  await act(async () => {
    root?.render(<MediaLibraryPage />)
  })
  await act(async () => {
    await Promise.resolve()
  })
}

describe('V8 登録メディア一覧（O7hUt7）の切り替え', () => {
  test('閲覧専用は登録を理由付きで拒否し、一覧と表示切替を保つ', async () => {
    readOnly = true
    await renderPage()
    expect(host?.textContent).toContain('秋の新商品.jpg')
    expect(host?.querySelector('[data-page-template="list"] [data-template-region="content"]')?.textContent).toContain('秋の新商品.jpg')
    expect(host?.textContent).toContain('閲覧のみで見ています')
    const create = [...host!.querySelectorAll('button')].filter(button => button.textContent?.includes('メディアを登録する'))
    expect(create.length).toBeGreaterThan(0)
    for (const button of create) await expectPermissionLocked(button)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(host!.querySelector('[aria-label="一覧で並べる"]')).not.toBeNull()
    const pager = host!.querySelector('[data-list-pager]')!
    expect(pager.textContent).not.toContain('管理者だけ')
    expect(pager.querySelector('nav')).toBeNull()
    expect(pager.textContent).toContain('3件中 1〜3件')
  })
  test('共通の表示切替から一覧へ移り、戻してもメディアと登録操作を保つ', async () => {
    await renderPage()
    const list=host!.querySelector<HTMLButtonElement>('button[aria-label="一覧で並べる"]')!
    const grid=host!.querySelector<HTMLButtonElement>('button[aria-label="格子で並べる"]')!
    expect(grid.getAttribute('aria-pressed')).toBe('true')
    await act(async()=>{list.click()})
    expect(list.getAttribute('aria-pressed')).toBe('true')
    expect(grid.getAttribute('aria-pressed')).toBe('false')
    expect(host!.textContent).toContain('秋の新商品.jpg')
    expect(host!.textContent).toContain('メディアを登録する')
    await act(async()=>{grid.click()})
    expect(grid.getAttribute('aria-pressed')).toBe('true')
    expect(host!.textContent).toContain('メニュー表.pdf')
  })

  test('共通の表示件数から10・20・50件を選べる', async () => {
    await renderPage()
    const trigger = host!.querySelector<HTMLButtonElement>('button[aria-label="表示件数"]')!
    expect(trigger).not.toBeNull()
    await act(async () => { trigger.click() })
    expect([...document.querySelectorAll('[role="listbox"] [role="option"]')].map(option => option.textContent?.trim())).toEqual(['10件表示', '20件表示', '50件表示'])
    for (const size of [10, 50, 20]) {
      if (size !== 10) await act(async () => { trigger.click() })
      const option = [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')].find(row => row.textContent?.trim() === `${size}件表示`)!
      await act(async () => { option.querySelector('button')!.click() })
      expect(trigger.textContent).toContain(`${size}件表示`)
    }
    expect(host!.textContent).toContain('秋の新商品.jpg')
  })

  test("v8 では新しい一覧が出て、既存の見た目は出ない", async () => {
    document.documentElement.dataset.theme = 'v8'
    await renderPage()
    expect(host?.querySelector('[data-design-node="O7hUt7"]')).not.toBeNull()
    expect(host?.querySelector('[data-design-node="g89Tc"]')).toBeNull()
    expect(host?.textContent).toContain('登録メディア一覧')
    expect(host?.textContent).toContain('どこでも使っていない')
    expect(host?.textContent).toContain('使っている容量')
    expect(host?.textContent).toContain('アーカイブ')
    expect(host?.textContent).toContain('秋の新商品.jpg')
    expect(host?.textContent).toContain('20件表示')
  })

  test('staff では閲覧のみの帯が出て、管理操作の札は出ない', async () => {
    staffRole = 'staff'
    document.documentElement.dataset.theme = 'v8'
    await renderPage()
    expect(host?.textContent).toContain('閲覧のみで見ています')
    // 登録と取得は staff も使えるので押せるままにする。
    const registerButton = Array.from(host?.querySelectorAll('button') ?? [])
      .find((button) => button.textContent?.includes('メディアを登録する'))
    expect(registerButton?.hasAttribute('disabled')).toBe(false)
    // 選ぶ札（まとめて削除の口）は管理者だけ。
    expect(host?.textContent).not.toContain('すべてのメディアを選択')
  })

  test('札の名前の前に、左のフォルダの列と同じ色の丸が付く（未分類は輪）。閲覧のみでも出す', async () => {
    staffRole = 'staff'
    document.documentElement.dataset.theme = 'v8'
    await renderPage()
    // 左のフォルダの列（nav）にも色の丸がある（fcolall）。ここでは一覧の札の丸だけを数える。
    const dots = [...(host?.querySelectorAll('[data-design-node="O7hUt7"] [data-folder-dot]') ?? [])].filter((dot) => !dot.closest('nav'))
    expect(dots).toHaveLength(mediaItems.length)
    expect(dots.map((dot) => dot.getAttribute('aria-label'))).toEqual(['フォルダ：01_商品写真', 'フォルダ：未分類', 'フォルダ：未分類'])
    expect(dots[0].getAttribute('data-folder-dot')).toBe('filed')
    expect(dots[1].getAttribute('data-folder-dot')).toBe('unfiled')
  })

  test('入口はV8一覧を描く', async () => {
    document.documentElement.dataset.theme = 'v8'
    await renderPage()
    expect(host?.querySelector('[data-design-node="g89Tc"]')).toBeNull()
    expect(host?.querySelector('[data-design-node="O7hUt7"]')).not.toBeNull()
  })
})

/*
 * 数の帯・道具の段・札の中身・「…」の操作・ページ送りは src/v8/contents/list-view.test.tsx が
 * 画面を描いて守る。ここには入口の禁止の見張りだけを残す。
 */
describe('V8 登録メディア一覧（O7hUt7）の入口', () => {
  test('旧テーマの分岐と旧い板を持たない', () => {
    expect(PAGE).not.toContain('useAdminTheme')
    expect(PAGE).not.toContain('data-design-node="g89Tc"')
  })
})
