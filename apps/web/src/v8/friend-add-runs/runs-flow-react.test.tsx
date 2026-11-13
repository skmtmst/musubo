// @vitest-environment happy-dom
/*
 * V8 友だち追加時の配信の実行結果の、読み込み・絞り込み・停止・書き出しの動きの試験。
 * - URL の絞り込み（種類・結果・経路・設定・ページ）をそのまま実行結果の口へ渡し、詳細へも引き継ぐ
 * - 札を押すと URL を書き換え、1回だけ読み直す
 * - アカウントを替えたあとに遅れて返った前の応答を出さない
 * - 数の帯・送達不明・最後に送った日時・二重送信を防ぐは口の値から出す
 * - 止めたら記録と設定の状態を読み直す
 * - CSV は今の絞り込みのまま全ページを読み、式として動かない形で書き出す
 */
import React, { act, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

/* 画面の URL。書き換えると useSearchParams が新しい値になる（Next の動きと同じ）。 */
const url = vi.hoisted(() => {
  let search = ''
  let params = new URLSearchParams('')
  const listeners = new Set<() => void>()
  return {
    get: () => params,
    set(next: string) {
      search = next.replace(/^\?/, '')
      params = new URLSearchParams(search)
      window.history.replaceState(null, '', `/friend-add-settings/runs${search ? `?${search}` : ''}`)
      listeners.forEach((listener) => listener())
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
  }
})
const pageTitle = vi.hoisted(() => vi.fn())

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/friend-add-settings/runs',
  useSearchParams: () => useSyncExternalStore(url.subscribe, url.get),
}))

vi.mock('@/lib/use-same-page-url', () => ({
  useSamePageUrl: () => ({ replace: (href: string) => url.set(href), push: (href: string) => url.set(href) }),
}))

const account = vi.hoisted(() => ({ id: 'account-a' }))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: account.id,
    accounts: [{ id: 'account-a', name: '本店' }, { id: 'account-b', name: '2号店' }],
    loading: false,
  }),
}))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: (title: string) => pageTitle(title),
  usePageCrumbs: () => {},
}))

vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => 'owner' }
})

import FriendAddRunsV8 from './runs'
import type { FriendAddRunList } from '@/lib/api'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type RunItem = FriendAddRunList['items'][number]

function run(overrides: Partial<RunItem> = {}): RunItem {
  return {
    id: 'run-ok', receivedAt: '2026-09-07T01:32:00.000Z', processedAt: '2026-09-07T01:32:00.800Z',
    friend: { id: 'friend-1', displayName: '見本 141', redacted: false }, friendKind: 'first_time',
    attribution: { status: 'captured', routeId: 'route-shop', routeName: '店頭QR', reason: null },
    rule: { id: 'rule-shop', name: '店頭QRの初回案内', versionId: 'v1', versionNumber: 1 },
    scenario: null,
    actions: { total: 0, failed: 0 }, deliveryCount: 1, status: 'completed', errorCode: null,
    ...overrides,
  } as RunItem
}

const SUMMARY = {
  recentFriends: 3, recentEvents: 7, cumulativeDeliveries: 12, scenarioStarts: 5,
  averageSendTimeMs: 800, failed: 0, totalRuns: 99, lastDeliveryAt: '2026-08-30T03:04:00.000Z',
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

type Call = { path: string; params: URLSearchParams; method: string }
let calls: Call[] = []
let runsResponder: (params: URLSearchParams) => Promise<Response> | Response
let ruleStatus = 'published'
let ruleName: string | null = '店頭QRの初回案内'
let stopped = false

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  account.id = 'account-a'
  url.set('')
  calls = []
  ruleStatus = 'published'
  ruleName = '店頭QRの初回案内'
  stopped = false
  pageTitle.mockClear()
  runsResponder = () => json({ success: true, data: { items: [run()], total: 1, nextCursor: null, summary: SUMMARY } })
  document.documentElement.dataset.theme = 'v8'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = new URL(String(input))
    const method = init?.method ?? 'GET'
    calls.push({ path: target.pathname, params: target.searchParams, method })
    if (target.pathname === '/api/staff/me') return json({ success: true, data: { role: 'owner' } })
    if (target.pathname === '/api/friend-add-runs') return runsResponder(target.searchParams)
    if (target.pathname === '/api/friend-add-rules/rule-shop/stop' && method === 'POST') {
      stopped = true
      return json({ success: true, data: null })
    }
    if (target.pathname === '/api/friend-add-rules/rule-shop') {
      return json({ success: true, data: { rule: { id: 'rule-shop', accountId: target.searchParams.get('accountId') ?? 'account-a', name: ruleName, status: stopped ? 'paused' : ruleStatus, version: 3, definition: { resendSuppressionHours: 24 } } } })
    }
    return json({ success: true, data: null })
  })
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.theme
})

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  }
}

async function render() {
  await act(async () => { root.render(<FriendAddRunsV8 />) })
  await settle()
}

const runCalls = () => calls.filter((call) => call.path === '/api/friend-add-runs')
const ruleCalls = () => calls.filter((call) => call.path === '/api/friend-add-rules/rule-shop' && call.method === 'GET')
const buttonByText = (text: string) => Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes(text))
const linkByText = (text: string) => Array.from(host.querySelectorAll<HTMLAnchorElement>('a')).find((link) => link.textContent?.includes(text))
const cardRow = (label: string) => Array.from(host.querySelectorAll('div, li, tr'))
  .filter((node) => node.children.length > 0 && node.textContent?.startsWith(label))
  .sort((a, b) => (a.textContent?.length ?? 0) - (b.textContent?.length ?? 0))[0]

describe('実行結果の読み込みと行き先', () => {
  it('題を付け、設定の一覧へ戻る口を置く', async () => {
    await render()
    expect(pageTitle).toHaveBeenCalledWith('実行結果：友だち追加時の配信')
    expect(host.querySelector('a[href="/friend-add-settings"]')).not.toBeNull()
  })

  it('URL の絞り込みとページをそのまま口へ渡し、詳細へのリンクにも引き継ぐ', async () => {
    url.set('kind=returning&status=failed&attribution=captured&rule_id=rule-shop&pages=c1')
    await render()
    const params = runCalls().at(-1)!.params
    expect(params.get('account_id')).toBe('account-a')
    expect(params.get('kind')).toBe('returning')
    expect(params.get('status')).toBe('failed')
    expect(params.get('attribution')).toBe('captured')
    expect(params.get('rule_id')).toBe('rule-shop')
    expect(params.get('cursor')).toBe('c1')
    const detail = new URL(linkByText('見本 141')!.getAttribute('href')!, 'http://localhost')
    expect(detail.pathname).toBe('/friend-add-settings/runs/detail')
    expect(Object.fromEntries(detail.searchParams)).toEqual({
      id: 'run-ok', kind: 'returning', attribution: 'captured', status: 'failed', rule_id: 'rule-shop', pages: 'c1',
    })
  })

  it('絞り込みが「すべて」のときは種類・結果・経路を口へ送らない', async () => {
    await render()
    const params = runCalls().at(-1)!.params
    expect(params.has('kind')).toBe(false)
    expect(params.has('status')).toBe(false)
    expect(params.has('attribution')).toBe(false)
    expect(params.has('rule_id')).toBe(false)
  })

  it('札を押すと URL を書き換え、ページを最初に戻して1回だけ読み直す', async () => {
    url.set('pages=c1')
    runsResponder = () => json({ success: true, data: {
      items: [run({ status: 'failed', errorCode: 'action_failed' })], total: 1, nextCursor: null, summary: { ...SUMMARY, failed: 1 },
    } })
    await render()
    const before = runCalls().length
    await act(async () => { buttonByText('失敗だけ見る')?.click() })
    await settle()
    const after = runCalls().slice(before)
    expect(after).toHaveLength(1)
    expect(after[0].params.get('status')).toBe('failed')
    expect(after[0].params.has('cursor')).toBe(false)
    expect(url.get().get('status')).toBe('failed')
    expect(url.get().has('pages')).toBe(false)
  })

  it('アカウントを替えたあとに遅れて返った前のアカウントの記録を出さない', async () => {
    let releaseOld!: () => void
    runsResponder = (params) => {
      if (params.get('account_id') === 'account-a') {
        return new Promise<Response>((resolve) => {
          releaseOld = () => resolve(json({ success: true, data: { items: [run({ id: 'old', friend: { id: 'f-old', displayName: '前の店の人', redacted: false } })], total: 1, nextCursor: null, summary: SUMMARY } }))
        })
      }
      return json({ success: true, data: { items: [run({ id: 'new', friend: { id: 'f-new', displayName: '今の店の人', redacted: false } })], total: 1, nextCursor: null, summary: SUMMARY } })
    }
    await render()
    expect(host.querySelector('[data-list-state="loading"]')).not.toBeNull()
    account.id = 'account-b'
    await act(async () => { root.render(<FriendAddRunsV8 />) })
    await settle()
    expect(host.textContent).toContain('今の店の人')
    await act(async () => { releaseOld() })
    await settle()
    expect(host.textContent).toContain('今の店の人')
    expect(host.textContent).not.toContain('前の店の人')
  })
})

describe('実行結果の数と状態', () => {
  it('数の帯は口の集計を出し、追加は人数と記録の数を分ける', async () => {
    await render()
    const band = host.textContent ?? ''
    expect(band).toContain('直近28日の友だち追加')
    expect(band).toContain('追加の記録 7件')
    expect(band).toMatch(/送った案内\s*12/)
    expect(band).toMatch(/シナリオを始めた\s*5/)
    expect(band).not.toContain('99')
    // 受信から処理までの秒は行ごとに出す。
    expect(host.textContent).toContain('0.8秒')
  })

  it('最後に送ったは集計の送信日時を日付つきで持ち、表の先頭行の処理時刻を使わない', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-28T00:00:00Z'))
    await render()
    const last = cardRow('最後に送った')
    const stamp = last?.querySelector('[title]')
    expect(stamp?.getAttribute('title')).toBe('8月30日 12:04')
    expect(stamp?.getAttribute('title')).not.toMatch(/9.*7/)
  })

  it('送達不明は再送待ちと言い分け、自動では送り直さないと書く', async () => {
    runsResponder = () => json({ success: true, data: {
      items: [run({ status: 'partial_failed', errorCode: 'delivery_unknown', deliveryCount: 0 })], total: 1, nextCursor: null, summary: SUMMARY,
    } })
    await render()
    const row = linkByText('見本 141')!.closest('tr')!
    expect(row.textContent).toContain('送達不明')
    expect(row.textContent).not.toContain('再送待ち')
    expect(row.textContent).toContain('自動では送り直しません')
  })

  it('二重送信を防ぐは設定の今の状態から出し、止まっている設定は止める口を押せない', async () => {
    ruleStatus = 'paused'
    await render()
    expect(ruleCalls().length).toBeGreaterThan(0)
    expect(cardRow('二重送信を防ぐ')?.textContent).toContain('有効')
    expect((buttonByText('一時停止する') as HTMLButtonElement).disabled).toBe(true)
  })

  it('止めたら記録と設定の状態を読み直し、止める口を押せなくする', async () => {
    await render()
    const runsBefore = runCalls().length
    const rulesBefore = ruleCalls().length
    await act(async () => { buttonByText('一時停止する')?.click() })
    await act(async () => { buttonByText('止める')?.click() })
    await settle()
    expect(stopped).toBe(true)
    expect(runCalls().length).toBe(runsBefore + 1)
    // 版を読む1回と、止めたあとの読み直し1回。
    expect(ruleCalls().length).toBe(rulesBefore + 2)
    expect(host.textContent).toContain('配信を止めました。')
    expect((buttonByText('一時停止する') as HTMLButtonElement).disabled).toBe(true)
  })


  it('複数ルールの結果では止めるルール名を確認に示す', async () => {
    runsResponder = () => json({ success: true, data: { items: [run(), run({ id: 'run-other', rule: { id: 'rule-other', name: '別の案内', versionId: 'v2', versionNumber: 1 } })], total: 2, nextCursor: null, summary: SUMMARY } })
    await render()
    await act(async () => { buttonByText('一時停止する')?.click() })
    const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]')!
    expect(dialog.textContent).toContain('店頭QRの初回案内')
    expect(dialog.textContent).not.toContain('別の案内')
  })
  it('停止対象のルール名を取得できない時は確認を開始しない', async () => {
    ruleName = null
    await render()
    const button = buttonByText('一時停止する') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title).toContain('ルール名')
    expect(stopped).toBe(false)
  })


  it('確認後にルール名が変わったら停止せず読み直しを案内する', async () => {
    await render()
    await act(async () => { buttonByText('一時停止する')?.click() })
    ruleName = '変更後の案内'
    await act(async () => { buttonByText('止める')?.click() })
    await settle()
    expect(stopped).toBe(false)
    expect(document.querySelector('[role="dialog"], [role="alertdialog"]')?.textContent).toContain('読み直し')
  })

  it('配信停止の確認に対象アカウントと環境を示す', async () => {
    await render()
    await act(async () => { buttonByText('一時停止する')?.click() })
    const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]')!
    expect(dialog.textContent).toContain('LINEアカウント')
    expect(dialog.textContent).toContain('環境')
  })

  it('アカウントを切り替えて戻しても古い確認から停止しない', async () => {
    await render()
    await act(async () => { buttonByText('一時停止する')?.click() })
    const button = buttonByText('止める')!
    const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
    const handler = (button as unknown as Record<string, { onClick: (event: unknown) => unknown }>)[key].onClick
    account.id = 'account-b'; await render()
    account.id = 'account-a'; await render()
    await act(async () => { await handler({ defaultPrevented: false, preventDefault() {}, stopPropagation() {}, currentTarget: button, target: button }) })
    expect(stopped).toBe(false)
  })

  it('停止前の読み取り中に対象が変わったら停止要求を送らない', async () => {
    await render()
    await act(async () => { buttonByText('一時停止する')?.click() })
    const original = globalThis.fetch
    let resolve!: (value: Response) => void
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const target = new URL(String(input))
      if (target.pathname === '/api/friend-add-rules/rule-shop' && (init?.method ?? 'GET') === 'GET') return new Promise<Response>(done => { resolve = done })
      return original(input, init)
    })
    await act(async () => { buttonByText('止める')?.click() })
    expect(resolve).toBeTypeOf('function')
    account.id = 'account-b'; await render()
    await act(async () => { resolve(json({ success: true, data: { rule: { version: 3 } } })); await Promise.resolve() })
    expect(stopped).toBe(false)
  })
})

describe('CSV の書き出し', () => {
  it('今の絞り込みのまま全ページを読み、式として動かない形で書き出す', async () => {
    url.set('status=failed&rule_id=rule-shop')
    runsResponder = (params) => params.get('limit') === '100'
      ? json({ success: true, data: params.get('cursor') === 'c2'
        ? { items: [run({ id: 'r2', friend: { id: 'f2', displayName: '+81 の人', redacted: false } })], total: 2, nextCursor: null, summary: SUMMARY }
        : { items: [run({ id: 'r1', friend: { id: 'f1', displayName: '=HYPERLINK("x")', redacted: false } })], total: 2, nextCursor: 'c2', summary: SUMMARY } })
      : json({ success: true, data: { items: [run()], total: 1, nextCursor: null, summary: SUMMARY } })
    const blobs: Blob[] = []
    const createObjectURL = vi.fn((blob: Blob) => { blobs.push(blob); return 'blob:csv' })
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: () => {} }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      await render()
      await act(async () => { buttonByText('CSVで書き出す')?.click() })
      await settle()
      const exports = runCalls().filter((call) => call.params.get('limit') === '100')
      expect(exports.map((call) => call.params.get('cursor'))).toEqual([null, 'c2'])
      for (const call of exports) {
        expect(call.params.get('status')).toBe('failed')
        expect(call.params.get('rule_id')).toBe('rule-shop')
      }
      expect(blobs).toHaveLength(1)
      const text = await blobs[0].text()
      expect(text).toContain(`"'=HYPERLINK(""x"")"`)
      expect(text).toContain(`"'+81 の人"`)
      expect(host.textContent).toContain('2 件を書き出しました。')
    } finally {
      click.mockRestore()
    }
  })
})
