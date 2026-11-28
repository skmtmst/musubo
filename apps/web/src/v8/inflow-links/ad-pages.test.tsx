import { PERMISSION_LOCK_SUMMARY } from '@/components/shared/permission-lock'
// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
/*
 * V8 広告とのつなぎ・広告への送信履歴の動きの試験。BEHAVIOR.md の両節を守る。
 * 対応表（F-21）：返している／返していない・結びつけ（PUT・版つき）は owner・admin だけ。
 * 送信履歴（F-22）：断られた1件のやり直し（POST）は owner だけ。押せない人には置かない。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/inflow-links',
  useSearchParams: () => new URLSearchParams('tab=connections'),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', accounts: [{ id: 'account-a', name: '本店' }], loading: false }),
}))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))

const role = vi.hoisted(() => ({ value: 'owner' as string | null }))
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => role.value }
})

import AdConnectionsV8 from './ad-connections'
import AdHistoryV8 from './ad-history'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mapping = (pointId: string, pointName: string, provider: 'google' | 'meta', mode: 'auto' | 'manual' | 'off', eventName: string | null, automaticEventName: string | null) => ({
  pointId, pointName, eventType: 'x', provider, mode, eventName, automaticEventName, googleActionId: null, version: 3,
})
const MAPPINGS = [
  mapping('cp-1', '初回購入', 'google', 'manual', 'purchase_first', 'purchase'),
  mapping('cp-1', '初回購入', 'meta', 'auto', 'Purchase', 'Purchase'),
  mapping('cp-2', '来店予約', 'google', 'off', null, null),
  mapping('cp-2', '来店予約', 'meta', 'off', null, 'Schedule'),
]
const log = (id: string, status: string, adPlatformId: string, eventName: string) => ({
  id, adPlatformId, friendId: 'f', lineAccountId: 'account-a', eventName, clickId: null, clickIdType: 'gclid', status,
  errorMessage: status === 'failed' ? 'クリックの目印の期限（90日）が切れていました' : null, createdAt: '2026-10-01T12:14:00.000Z',
})
const LOGS = [log('l-1', 'pending', 'ad-google', '初回購入'), log('l-2', 'failed', 'ad-meta', '定期便の申し込み')]
const PLATFORMS = [
  { id: 'ad-google', name: 'google', displayName: null, config: {}, isActive: true, verifiedAt: '2026-10-01T00:00:00Z', createdAt: '', updatedAt: '' },
  { id: 'ad-meta', name: 'meta', displayName: null, config: {}, isActive: true, verifiedAt: '2026-10-01T00:00:00Z', createdAt: '', updatedAt: '' },
]

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
const calls: Array<{ method: string; path: string; body: unknown }> = []

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  role.value = verifiedStaffRole('owner')
  calls.length = 0
  document.documentElement.dataset.theme = 'v8'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    if (method !== 'GET') calls.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (method === 'PUT' && url.pathname.startsWith('/api/ad-platforms/mappings/')) return json({ success: true, data: MAPPINGS[3] })
    if (method === 'POST' && url.pathname.endsWith('/retry')) return json({ success: true, data: { logId: 'l-2', outboxId: 'o', providerEventId: 'p', status: 'sent', replayed: false } })
    if (url.pathname === '/api/ad-platforms/mappings') return json({ success: true, data: MAPPINGS })
    if (url.pathname === '/api/ad-platforms/logs') {
      return json({ success: true, data: { items: LOGS, total: LOGS.length, page: 1, limit: 20, summary: { sentLast30Days: 15, pendingLast30Days: 2, failedLast30Days: 1 }, sort: [] } })
    }
    if (url.pathname === '/api/ad-platforms') return json({ success: true, data: PLATFORMS })
    return json({ success: true, data: null })
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.theme
})

async function render(node: React.ReactElement, until: string) {
  await act(async () => { root.render(node) })
  for (let i = 0; i < 60 && !(host.textContent ?? '').includes(until); i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)) })
  }
}
const buttons = (text: string) => [...host.querySelectorAll('button, a')].filter((element) => (element.textContent ?? '').trim() === text) as HTMLElement[]

describe('広告とのつなぎ（FDBsG）', () => {
  it('広告を接続していない場合は自動の候補があっても返していると表示しない', async () => {
    const previousFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === '/api/ad-platforms') return json({ success: true, data: [] })
      return previousFetch(input, init)
    })
    await render(<AdConnectionsV8 />, '初回購入')
    const row = [...host.querySelectorAll('tr, [role="row"]')].find(item => item.textContent?.includes('初回購入'))
    expect(row?.textContent).toContain('返していない')
    expect(row?.textContent).not.toContain('返している')
  })

  it('対応表を成果地点ごとに1行で出し、返している／返していないを札にする', async () => {
    await render(<AdConnectionsV8 />, '来店予約')
    expect(host.querySelector('[data-design-node="FDBsG"]')).not.toBeNull()
    const rows = [...host.querySelectorAll('tr, [role="row"]')].slice(1).map((row) => row.textContent)
    expect(rows[0]).toContain('purchase_first')
    expect(rows[0]).toContain('Purchase')
    expect(rows[0]).toContain('返している')
    expect(rows[1]).toContain('返していない')
    expect(host.querySelector('table[aria-label="成果地点と、広告に返す名前の対応"]')?.parentElement?.getAttribute('data-column-sizing')).toBe('controls')
    // 数の帯は口の30日の集計。
    expect(host.textContent).toContain('15')
  })

  it('結びつけない欄は、自動の名前があるときだけ選ぶ欄にし、選ぶと版つきで保存する', async () => {
    await render(<AdConnectionsV8 />, '来店予約')
    const select = host.querySelector('button[aria-label="来店予約をMeta広告に返す名前"]') as HTMLElement
    expect(select).not.toBeNull()
    // Google は自動の名前が無いので「—」のまま（選ぶ欄を置かない）。
    expect(host.querySelector('[aria-label="来店予約をGoogle広告に返す名前"]')).toBeNull()
    await act(async () => { select.click() })
    const option = [...document.querySelectorAll('[role="option"]')].find((element) => element.textContent?.includes('自動で返す（Schedule）')) as HTMLElement
    await act(async () => { (option.querySelector('button') ?? option).click() })
    for (let i = 0; i < 40 && calls.length === 0; i += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)) })
    }
    expect(calls).toEqual([{ method: 'PUT', path: '/api/ad-platforms/mappings/cp-2', body: { account_id: 'account-a', provider: 'meta', mode: 'auto', expectedVersion: 3 } }])
  })

  it('閲覧のみでは、帯を出し、選ぶ欄を置かない', async () => {
    role.value = verifiedStaffRole('staff')
    await render(<AdConnectionsV8 />, '来店予約')
    expect(host.textContent).toContain(PERMISSION_LOCK_SUMMARY.feature)
    expect(host.querySelector('[aria-label="来店予約をMeta広告に返す名前"]')).toBeNull()
  })
})

describe('広告への送信履歴（p0kA3）', () => {
  it('媒体の絞り込みを選び、同じAPIページからその媒体だけ表示して戻せる', async () => {
    await render(<AdHistoryV8 />, '定期便の申し込み')
    const choose = async (label: string) => {
      await act(async () => { (host.querySelector('button[aria-label="媒体"]') as HTMLElement).click() })
      let option: HTMLElement | undefined
      for (let i = 0; i < 40 && !option; i++) {
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
        option = [...document.querySelectorAll<HTMLInputElement>('[role="dialog"] input[type="radio"]')].find(item => item.getAttribute('aria-label') === label)
      }
      expect(option).toBeDefined()
      const before = host.querySelector('tbody')?.textContent
      await act(async () => { option!.click() })
      expect(host.querySelector('tbody')?.textContent).toBe(before)
      const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(item => item.textContent?.trim() === '選択する')!
      expect(confirm.disabled).toBe(false)
      await act(async () => { confirm.click() })
    }
    await choose('Google広告')
    expect(host.querySelector('tbody')?.textContent).toContain('初回購入')
    expect(host.querySelector('tbody')?.textContent).not.toContain('定期便の申し込み')
    await choose('すべて')
    expect(host.querySelector('tbody')?.textContent).toContain('定期便の申し込み')
    expect(calls).toHaveLength(0)
  })

  it('行に成果・媒体・状態を出し、断られた理由を下の注に出す', async () => {
    await render(<AdHistoryV8 />, '定期便の申し込み')
    expect(host.querySelector('[data-design-node="p0kA3"]')).not.toBeNull()
    expect(host.textContent).toContain('待っている')
    expect(host.textContent).toContain('断られた')
    expect(host.textContent).toContain('Google広告')
    expect(host.textContent).toContain('断られた理由：クリックの目印の期限（90日）が切れていました')
  })

  it('owner は断られた行の「やり直す」でその1件だけ送り直す', async () => {
    await render(<AdHistoryV8 />, '定期便の申し込み')
    expect(buttons('やり直す')).toHaveLength(1)
    await act(async () => { buttons('やり直す')[0]!.click() })
    for (let i = 0; i < 40 && calls.length === 0; i += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)) })
    }
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['POST /api/ad-platforms/logs/l-2/retry'])
  })

  it('owner 以外には押せない「やり直す」を置かない', async () => {
    role.value = verifiedStaffRole('admin')
    await render(<AdHistoryV8 />, '定期便の申し込み')
    expect(buttons('やり直す')).toHaveLength(0)
  })
})

afterEach(() => { verifiedStaffRole(null) })
