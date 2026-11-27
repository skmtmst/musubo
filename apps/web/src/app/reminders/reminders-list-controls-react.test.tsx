// @vitest-environment happy-dom
/*
 * N-072: 一覧の「表示件数」「並び順」が実クエリへつながっていること、
 * 実データに対応しない「基準日」の入力欄がもう置かれていないことを、
 * 実マウントで確かめる。
 *
 * 直す前: 件数は「20件表示」だけの飾り、並び順は「次の送信が近い順」だけの
 * 飾り（サーバーの並びは display_order 固定）、基準日は2026-08-01〜09-30の
 * 固定値を見せるだけの入力欄だった。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchApi = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return { ...actual, fetchApi }
})

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(''),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', loading: false }),
}))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))

/*
 * 共通の Select は listbox の部品で、その操作は部品自身の試験が持つ。
 * ここで見たいのは選んだ後の一覧の判断なので、素の <select> に置き換える。
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

vi.mock('@/components/shared/list-kpis', () => ({
  default: () => null,
}))

import RemindersPage from './page'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
const calls: string[] = []

function reminder(id: string, name: string) {
  return {
    id, name, description: null, isActive: true, folderId: null,
    lifecycleStatus: 'published', stepCount: 1, displayOrder: 0,
    plannedDeliveries: null, lastSentAt: null,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  }
}

function listCalls() {
  return calls.filter((url) => url.startsWith('/api/reminders?'))
}

beforeEach(() => {
  calls.length = 0
  fetchApi.mockImplementation(async (url: string) => {
    calls.push(url)
    if (url.startsWith('/api/folders')) {
      return { success: true, data: [], unfiledCount: 0 }
    }
    return { success: true, data: { items: [reminder('r-1', '予約前のお知らせ')], total: 1, limit: 20, sort: [] } }
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function flush() {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

function changeSelect(label: string, value: string) {
  const select = host.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement | null
  expect(select, `${label} のプルダウンが見つかりません`).toBeTruthy()
  act(() => {
    select!.value = value
    select!.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('一覧の操作が実クエリへつながる (N-072)', () => {
  it('表示件数を変えると limit を変えて取り直す', async () => {
    await act(async () => { root.render(<RemindersPage />) })
    await flush()
    expect(listCalls().at(-1)).toContain('limit=20')

    changeSelect('表示件数', '50')
    await flush()

    const latest = listCalls().at(-1) ?? ''
    expect(latest).toContain('limit=50')
    expect(latest).toContain('page=1')
  })

  it('次の送信が近い順で開き、並び順を変えると sort を変えて取り直す', async () => {
    await act(async () => { root.render(<RemindersPage />) })
    await flush()
    expect(listCalls().at(-1)).toContain('sort=next')

    changeSelect('並び', 'created')
    await flush()

    const latest = listCalls().at(-1) ?? ''
    expect(latest).toContain('sort=created')
    expect(latest).toContain('page=1')
  })

  it('状態は「すべて」と4つのすべる切り替え（apLqS）', async () => {
    await act(async () => { root.render(<RemindersPage />) })
    await flush()
    const control = host.querySelector('[data-segmented-control][aria-label="状態で絞り込む"]')
    expect(control).toBeTruthy()
    const names = [...control!.querySelectorAll('button')].map((button) => button.textContent?.trim())
    expect(names).toEqual(['すべて', '有効', '下書き', '停止中', '失敗あり'])
  })

  it('実データに対応しない「基準日」の日付入力は置かない', async () => {
    await act(async () => { root.render(<RemindersPage />) })
    await flush()
    expect(host.querySelectorAll('input[type="date"]').length).toBe(0)
  })

  it('検索語は q パラメータで送る（「名前・内容で探す」の約束どおり）', async () => {
    await act(async () => { root.render(<RemindersPage />) })
    await flush()

    const input = host.querySelector('input[aria-label="名前・内容で探す"]') as HTMLInputElement
    expect(input).toBeTruthy()
    // 制御コンポーネントは React の値トラッカーを迂回して入れないと
    // onChange が走らない。prototype の setter 経由で入れる。
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, '持ち物')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    // useDeferredValue が追いつくまで描画を進める。
    for (let i = 0; i < 20; i++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
      if ((listCalls().at(-1) ?? '').includes(`q=${encodeURIComponent('持ち物')}`)) break
    }
    expect(listCalls().at(-1) ?? '').toContain('q=' + encodeURIComponent('持ち物'))
  })
})

describe('一覧もフォルダも失敗したら読み直しは1枚だけ', () => {
  it('フォルダ欄の小さい読み直しは出さず、一覧の失敗の1枚だけ出す', async () => {
    fetchApi.mockImplementation(async (url: string) => {
      calls.push(url)
      if (url.startsWith('/api/folders')) return { success: false, error: '失敗' }
      if (url.startsWith('/api/reminders?')) return { success: false, error: '失敗' }
      return { success: true, data: { items: [], total: 0, limit: 20, sort: [] } }
    })
    await act(async () => { root.render(<RemindersPage />) })
    for (let i = 0; i < 30; i++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
      if (host.textContent?.includes('読み込めませんでした')) break
    }
    expect(host.textContent ?? '').toContain('リマインダを読み込めませんでした')
    // 一覧本体も失敗しているときは一覧の1枚へまとめ、フォルダ欄は出さない。
    expect(host.textContent ?? '').not.toContain('フォルダを読み込めませんでした')
    const fullRetries = Array.from(host.querySelectorAll('button'))
      .filter((button) => button.textContent?.trim() === 'もう一度試す')
    expect(fullRetries).toHaveLength(1)
  })
})

it('一覧を読み込めないとき空と誤認させず、もう一度試すと復帰する', async () => {
  let fail = true
  fetchApi.mockImplementation(async (url: string) => {
    calls.push(url)
    if (url.startsWith('/api/folders')) return { success: true, data: [], unfiledCount: 0 }
    if (url.startsWith('/api/reminders?') && fail) return { success: false, error: '失敗' }
    return { success: true, data: { items: [reminder('r-1', '予約前のお知らせ')], total: 1, limit: 20, sort: [] } }
  })
  await act(async () => { root.render(<RemindersPage />) })
  for (let i = 0; i < 30 && !host.textContent?.includes('リマインダを読み込めませんでした'); i++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  }
  expect(host.textContent).toContain('リマインダを読み込めませんでした')
  expect(host.textContent).not.toContain('まだリマインダがありません')
  const retry = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === 'もう一度試す')!
  expect(retry).toBeTruthy()
  const before = listCalls().length
  fail = false
  await act(async () => { retry.click() })
  for (let i = 0; i < 30 && !host.textContent?.includes('予約前のお知らせ'); i++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  }
  expect(listCalls().length).toBeGreaterThan(before)
  expect(host.textContent).toContain('予約前のお知らせ')
  expect(host.textContent).not.toContain('リマインダを読み込めませんでした')
})
