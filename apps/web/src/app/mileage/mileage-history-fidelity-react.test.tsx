// @vitest-environment happy-dom
/*
 * 増やす・減らす（板 ）。絵の骨組み（`design/v8/html/.html`）にそろえる。
 * 頭の CSV の空け・日時の短さ（9/30 14:12）・付けたの帯に補足を付けない
 * ことをここで留める。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountProvider } from '@/contexts/account-context'
import { MileageShell } from '@/v8/mileage/frame'
import V8HistoryTab from '@/v8/mileage/history'

vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams('tab=history'),
  usePathname: () => '/mileage',
}))

function stubFetch() {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    if (url.includes('/api/mileage/history')) {
      return new Response(JSON.stringify({
        success: true,
        data: {
          items: [{
            id: 'entry-1',
            primaryFriendId: 'friend-1',
            displayName: 'Demo Person',
            pictureUrl: null,
            entryType: 'grant',
            status: 'available',
            amount: 128,
            reason: '商品を買った',
            source: 'rule',
            hasSourceEvent: true,
            sourceReferenceId: 'order-10482',
            ruleName: null,
            mode: 'automatic',
            executedByStaffName: null,
            lineAccountName: '然 本店',
            balanceAfter: 2340,
            occurredAt: '2026-09-30T05:12:00.000Z',
          }],
          pagination: { total: 1245, limit: 20, offset: 0 },
          summary: {
            from: '2026-09-01',
            to: '2026-09-30',
            byType: [
              { entryType: 'grant', count: 1206, amount: 40800 },
              { entryType: 'spend', count: 36, amount: -33100 },
              { entryType: 'reversal', count: 3, amount: -300 },
            ],
          },
        },
      }), { status: 200 })
    }
    if (url.includes('/api/staff/me')) {
      return new Response(JSON.stringify({ success: true, data: { id: 'owner-1', role: 'owner' } }), { status: 200 })
    }
    if (url.includes('/api/line-accounts')) {
      return new Response(JSON.stringify({
        success: true,
        data: [{ id: 'account-1', channelId: 'channel-1', name: '公式A', isActive: true, country: null, role: null, displayOrder: 0 }],
      }), { status: 200 })
    }
    return new Response(JSON.stringify({ success: true, data: {} }), { status: 200 })
  }) as typeof globalThis.fetch
}

let container: HTMLDivElement
let root: Root
const originalFetch = globalThis.fetch

function installWebStorage(): void {
  const make = () => {
    const data = new Map<string, string>()
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, String(value)) },
      removeItem: (key: string) => { data.delete(key) },
      clear: () => { data.clear() },
      key: (index: number) => [...data.keys()][index] ?? null,
      get length() { return data.size },
    }
  }
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    const holder = globalThis as unknown as Record<string, unknown>
    if (!holder[name]) {
      Object.defineProperty(globalThis, name, { value: make(), configurable: true })
    }
  }
}

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  installWebStorage()
  globalThis.localStorage.setItem('lh_selected_account', 'account-1')
  document.documentElement.dataset.theme = 'v8'
  stubFetch()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  document.body.innerHTML = ''
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

async function waitForRows(): Promise<void> {
  await act(async () => {
    root.render(
      <AccountProvider>
        <MileageShell.Provider value={{ tab: 'history', readonly: false, narrow: false, counts: {}, setCount: () => {} }}><V8HistoryTab /></MileageShell.Provider>
      </AccountProvider>,
    )
  })
  for (let i = 0; i < 60; i += 1) {
    await act(async () => { await Promise.resolve() })
    if (container.querySelector('tbody tr')) return
  }
  throw new Error('履歴の表が出ませんでした')
}

describe('履歴の絵合わせ（板 `oRbJi`）', () => {
  it('名前と記録日時を別の列で確認できる（日本時間）', async () => {
    await waitForRows()
    expect(container.querySelector('tbody span[title]')?.getAttribute('title')).toBe('Demo Person')
    expect(container.querySelector('tbody time')?.textContent).toBe('09/30 14:12')
    expect(container.querySelector('tbody time')?.closest('td')).not.toBe(container.querySelector('tbody span[title]')?.closest('td'))
  })

  it('付けたの帯に補足は付けない', async () => {
    await waitForRows()
    const body = container.textContent ?? ''
    expect(body).toContain('付けた')
    expect(body).not.toContain('この期間に付けた合計')
  })

  it('頭に CSVで書き出すと増やす・減らすが出る', async () => {
    await waitForRows()
    const text = container.textContent ?? ''
    expect(text).toContain('CSVで書き出す')
    expect(text).toContain('増やす・減らす')
  })
})
