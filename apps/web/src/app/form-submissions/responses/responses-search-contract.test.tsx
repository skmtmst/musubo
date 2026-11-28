// @vitest-environment happy-dom
/*
 * N-171/N-179: 検索条件が一覧とCSVへ同じ値で渡ることを、本物のReactで動かして見る。
 * 見るのは2つだけ: 検索語を打つと一覧取得に `q` が付くこと、CSV書き出しの
 * 全ページ取得にも同じ `q` が付くこと（付けないと画面と書き出しがずれる）。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchUrls: string[] = []
const fetchApi = vi.hoisted(() => vi.fn())
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner', canManageRole: () => true }))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return { ...actual, fetchApi }
})

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}))

vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams('id=form-1'),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'acc-1', loading: false }),
}))

import FormResponsesPage from './page'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

const formDetail = {
  id: 'form-1',
  name: 'アンケート',
  fields: [{ name: 'q1', label: '質問1' }],
  layout: { version: 2, header: [], sections: [], options: {} },
  submitCount: 3,
}

const submissionsPage = {
  items: [
    { id: 'sub-1', formId: 'form-1', friendId: 'friend-1', friendName: '山田', data: { q1: '駐車場' }, createdAt: '2026-09-01T10:00:00+09:00' },
  ],
  total: 1,
  page: 1,
  limit: 20,
}

function mockResponses() {
  fetchApi.mockImplementation((async (url: string) => {
    fetchUrls.push(url)
    if (url.startsWith('/api/forms/form-1/submissions')) {
      return { success: true, data: submissionsPage }
    }
    return { success: true, data: formDetail }
  }) as typeof fetchApi)
}

function input(): HTMLInputElement {
  const found = host.querySelector('input[aria-label="名前・答えで探す（全件から）"]')
  if (!(found instanceof HTMLInputElement)) throw new Error('search input not found')
  return found
}

function csvButton(): HTMLButtonElement {
  const buttons = [...host.querySelectorAll('button')]
  const found = buttons.find((button) => button.textContent === 'CSVで書き出す')
  if (!(found instanceof HTMLButtonElement)) throw new Error('csv button not found')
  return found
}

async function settle(milliseconds: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds))
  })
}

describe('N-171/N-179 検索条件の一覧・CSV共有', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/form-submissions/responses?id=form-1')
    fetchUrls.length = 0
    fetchApi.mockReset()
    mockResponses()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    host.remove()
    vi.restoreAllMocks()
  })

  it('検索語を打つと一覧取得にqが付き、CSVの全ページ取得にも同じqが付く', async () => {
    // happy-dom がCSVのblobへページ移動すると、URLに残した検索語まで消える。
    // 書き出し要求を確認する間はファイル取得だけを止める。
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await act(async () => {
      root.render(<FormResponsesPage />)
    })
    await settle(50)
    const firstList = fetchUrls.filter((url) => url.includes('/submissions?page=1'))
    expect(firstList.length).toBeGreaterThan(0)
    expect(firstList[0]).not.toContain('q=')

    await act(async () => {
      const field = input()
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      if (!setter) throw new Error('value setter not found')
      setter.call(field, '駐車場')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await settle(450)
    const searched = fetchUrls.filter((url) => url.includes('/submissions') && url.includes('q='))
    expect(searched.length).toBeGreaterThan(0)
    for (const url of searched) {
      expect(url).toContain(`q=${encodeURIComponent('駐車場')}`)
    }

    fetchUrls.length = 0
    await act(async () => {
      csvButton().click()
    })
    await settle(100)
    const exported = fetchUrls.filter((url) => url.includes('/submissions'))
    expect(exported.length).toBeGreaterThan(0)
    for (const url of exported) {
      expect(url).toContain(`q=${encodeURIComponent('駐車場')}`)
    }
  })

  it('選んだ期間の回答をCSVに書き出す', async () => {
    let filename = ''
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { filename = this.download })
    await act(async () => { root.render(<FormResponsesPage />) })
    await settle(50)
    const lastMonth = [...host.querySelectorAll('button')].find((button) => button.textContent === '先月')
    expect(lastMonth).toBeTruthy()
    await act(async () => { lastMonth!.click() })
    await settle(50)
    fetchUrls.length = 0
    await act(async () => { csvButton().click() })
    await settle(50)
    const exported = fetchUrls.filter((url) => url.includes('/submissions'))
    expect(exported.length).toBeGreaterThan(0)
    expect(exported.every((url) => new URL(url, 'http://localhost').searchParams.get('period') === 'last_month')).toBe(true)
    expect(filename).toContain('フォーム回答_先月')
  })

  it('CSVの連打を防ぎ、画面を離れると取得を中止する', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    let resolveExport!: (value: unknown) => void
    let signal: AbortSignal | undefined
    fetchApi.mockImplementation((async (url: string, options?: { signal?: AbortSignal }) => {
      fetchUrls.push(url)
      if (url.includes('/submissions') && url.includes('limit=200')) {
        signal = options?.signal
        return new Promise((resolve) => { resolveExport = resolve })
      }
      if (url.includes('/submissions')) return { success: true, data: submissionsPage }
      return { success: true, data: formDetail }
    }) as typeof fetchApi)
    await act(async () => { root.render(<FormResponsesPage />) })
    await settle(50)
    await act(async () => { const button = csvButton(); button.click(); button.click() })
    expect(fetchUrls.filter((url) => url.includes('/submissions') && url.includes('limit=200'))).toHaveLength(1)
    expect(signal?.aborted).toBe(false)
    await act(async () => root.unmount())
    expect(signal?.aborted).toBe(true)
    await act(async () => { resolveExport({ success: true, data: submissionsPage }) })
    expect(click).not.toHaveBeenCalled()
  })
})

describe('MKQyJ 後処理の札（済み・未完）', () => {
  beforeEach(() => {
    fetchUrls.length = 0
    fetchApi.mockReset()
    fetchApi.mockImplementation((async (url: string) => {
      fetchUrls.push(url)
      if (url.startsWith('/api/forms/form-1/submissions')) {
        return {
          success: true,
          data: {
            items: [
              { id: 'sub-done', formId: 'form-1', friendId: 'friend-1', friendName: '済みさん', data: { q1: 'はい' }, postActions: { state: 'completed', pending: [] }, createdAt: '2026-09-01T10:00:00+09:00' },
              { id: 'sub-open', formId: 'form-1', friendId: 'friend-2', friendName: '未完さん', data: { q1: 'いいえ' }, postActions: { state: 'failed', pending: ['tag'] }, createdAt: '2026-09-02T10:00:00+09:00' },
              { id: 'sub-plain', formId: 'form-1', friendId: 'friend-3', friendName: '記録なしさん', data: { q1: 'どちらでも' }, postActions: null, createdAt: '2026-09-03T10:00:00+09:00' },
            ],
            total: 3,
            page: 1,
            limit: 20,
          },
        }
      }
      return { success: true, data: formDetail }
    }) as typeof fetchApi)
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    host.remove()
    vi.restoreAllMocks()
  })

  it('終わりは済み・未完ありは未完・記録なしは札なし', async () => {
    await act(async () => {
      root.render(<FormResponsesPage />)
    })
    await settle(50)
    await act(async () => {
      ;([...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent?.includes('1件ずつ見る')) as HTMLElement).click()
    })
    expect(host.textContent).toContain('済み')
    expect(host.textContent).toContain('未完')
    expect(host.textContent).not.toContain('後処理に未完があります')
  })
})
