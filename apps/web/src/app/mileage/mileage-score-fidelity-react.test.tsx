// @vitest-environment happy-dom
/*
 * 行動スコア（板 ）。絵の骨組み（`design/v8/html/.html`）にそろえる。
 * 帯の札（高い・ふつう・低い）・変化のひく符号（−8）・最後の反応の1行
 * （9/30 商品を買った）・脚注の空けと補足をここで留める。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountProvider } from '@/contexts/account-context'
import { MileageShell } from '@/v8/mileage/frame'
import V8ScoreTab from '@/v8/mileage/score'

vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams('tab=score'),
  usePathname: () => '/mileage',
}))

const scoreRuleItem = {
  id: 'score-rule-1',
  name: '購入した',
  eventType: 'purchase_completed',
  source: null,
  operation: 'delta',
  value: 30,
  frequency: { kind: 'per_day', limit: 1 },
  sameSourceEventOnce: true,
  validFrom: null,
  validUntil: null,
  enabled: true,
}

function stubFetch() {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    if (url.includes('/api/action-scores/friends')) {
      return new Response(JSON.stringify({
        success: true,
        data: {
          summary: { scoredFriends: 4, high: 1, normal: 2, low: 1, decreased30d: 1, highMin: 30, normalMin: 10 },
          items: [
            {
              friendId: 'friend-1',
              displayName: 'Demo Person',
              pictureUrl: null,
              currentScore: 82,
              band: 'high',
              change30d: 12,
              lastReason: '商品を買った',
              lastChangedAt: '2026-09-30T10:00:00+09:00',
            },
            {
              friendId: 'friend-2',
              displayName: '見本 15',
              pictureUrl: null,
              currentScore: 35,
              band: 'low',
              change30d: -8,
              lastReason: 'フォームに答えた',
              lastChangedAt: '2026-09-20T10:00:00+09:00',
            },
          ],
          pagination: { total: 4, limit: 20, offset: 0 },
        },
      }), { status: 200 })
    }
    if (url.includes('/api/action-scores/rules')) {
      const version = {
        id: 'v-3', versionNumber: 3, status: 'published', createdAt: '2026-09-12T00:00:00Z',
        publishedAt: '2026-09-12T00:00:00Z', rules: [scoreRuleItem],
        bands: { min: 0, max: 100, normalMin: 10, highMin: 30 },
      }
      return new Response(JSON.stringify({
        success: true,
        data: {
          configured: true, status: 'published',
          currentDraftVersionId: 'v-3', currentPublishedVersionId: 'v-3',
          editableVersion: { ...version, status: 'draft' }, publishedVersion: version,
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
        <MileageShell.Provider value={{ tab: 'score', readonly: false, narrow: false, counts: {}, setCount: () => {} }}><V8ScoreTab /></MileageShell.Provider>
      </AccountProvider>,
    )
  })
  for (let i = 0; i < 60; i += 1) {
    await act(async () => { await Promise.resolve() })
    if (container.querySelector('tbody tr')) return
  }
  throw new Error('スコアの表が出ませんでした')
}

describe('スコアの絵合わせ（板 `IRPw8`）', () => {
  it('帯の札は短く出す（高い・低い）', async () => {
    await waitForRows()
    /* 数の帯の題（点が高い・中くらい）は別物。行の中だけ見る。 */
    const rows = [...container.querySelectorAll('tbody tr')].map((row) => row.textContent ?? '').join('\n')
    expect(rows).toContain('高い')
    expect(rows).toContain('低い')
    expect(rows).not.toContain('点が高い')
    expect(rows).not.toContain('中くらい')
    expect(container.querySelector('tbody [data-tone="success"]')?.textContent).toBe('高い')
    expect(container.querySelector('tbody [data-tone="warning"]')?.textContent).toBe('低い')
  })

  it('変化のひく符号は − で、最後の反応は日付と1行にする', async () => {
    await waitForRows()
    const body = container.textContent ?? ''
    expect(body).toContain('−8')
    expect(body).toContain('9/30 商品を買った')
  })

  it('画面の説明から補足を開閉できる', async () => {
    await waitForRows()
    const toggle = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.getAttribute('aria-label') === 'この画面の説明')!
    await act(async () => { toggle.click() })
    expect(container.querySelector('[data-screen-explanation]')?.textContent).toContain('下書きの変更は、公開するまで使われません。')
    await act(async () => { toggle.click() })
    expect(container.querySelector('[data-screen-explanation]')).toBeNull()
  })
})
