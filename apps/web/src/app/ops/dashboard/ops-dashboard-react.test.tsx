// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import OpsDashboardPage from './page'
import { OPS_READONLY_LOCK_REASON } from '../../../v8/ops/use-ops-read-only'
import { contractDetail, deltaLabel, minutesLabel, revenueDetail, revenueSourceLabel } from '../../../v8/ops/dashboard/format'
import { formatBytes, formatYen, formatYenShort, niceCeiling } from '@/components/ops/ops-charts'

vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))
// 最初の10分の段は口も試験も別（v8/ops/first-run.test.tsx）。ここではダッシュボード本体の口だけを見る。
vi.mock('@/v8/ops/dashboard/first-run', () => ({ default: () => null }))

/** 現役V8でAPIの数・要対応・使用量と詳細情報、同期・再取得を守る。 */

const payload = {
  period: 'month', periodLabel: '今月', pricing: 'stripe_actual', lastSyncedAt: '2026-09-25T03:00:00.000+09:00',
  plans: [{ key: 'light', label: 'ライト', monthlyYen: 9800 }],
  kpis: { revenueThisMonth: 398_000, revenueDelta: 59_600, refundsThisMonth: 0, contractMonthlyTotal: 412_300, filledByListPriceCount: 1, active: 12, byPlan: { light: 4, standard: 6, pro: 2 }, trialing: 3, newInPeriod: 2, newTrialsInPeriod: 2, churnInPeriod: 0, churnRate: 0 },
  revenueByMonth: [4, 5, 6, 7, 8, 9].map((m, i) => ({ month: `2026-0${m}`, label: `${m}月`, yen: 3_000_000 + i * 200_000, current: i === 5 })),
  planShare: { total: 15, rows: [
    { key: 'light', label: 'ライト', count: 4, percent: 27 }, { key: 'standard', label: 'スタンダード', count: 6, percent: 40 },
    { key: 'pro', label: 'プロ', count: 2, percent: 13 }, { key: 'trial', label: 'トライアル', count: 3, percent: 20 },
  ] },
  alerts: { pastDue: 1, trialEndingSoon: 1, lineTokenExpiring: 3, unansweredTickets: 3 },
  tickets: { newCount: 3, inProgressCount: 2, avgFirstReplyMinutes: 84, closedInPeriod: 18 },
  lineRegistration: { registered: 21, total: 24, unregisteredCount: 3 },
  usage: [
    { tenantId: 't1', tenantName: 'カフェ ムスビ', planKey: 'light', planLabel: 'ライト', messages: 4820, bannerUnits: 46, mediaBytes: 1.8 * 1024 ** 3, limits: { messages: 5000, images: 50, mediaBytes: 5 * 1024 ** 3 }, usageRate: 96 },
  ],
  generatedAt: '2026-09-17T10:00:00.000+09:00',
}

let host: HTMLDivElement
let root: Root
let urls: string[]
let requests: Array<{ url: string; init?: RequestInit }>

/** V8は未登録者の概要も先に読む。各APIにその口の応答を返す。 */
function stubDashboardFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await handler(input, init)
    if (!response.ok || !String(input).includes('line-unregistered')) return response
    return new Response(JSON.stringify({ success: true, data: { registered: 21, total: 24, people: [] } }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  }))
}

beforeEach(() => {
  urls = []
  requests = []
  process.env.NEXT_PUBLIC_API_URL = 'https://api.example.test'
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    urls.push(url)
    requests.push({ url, init })
    const body = url.endsWith('/api/ops/me')
      ? { success: true, data: { id: 'staff-1', name: '運営', email: 'ops@example.test', readOnly: false, totpEnabled: true, lineLinked: true, legacy: false, impersonation: null } }
      : url.endsWith('/api/ops/billing/sync')
        ? { success: true, data: { tenants: 2, imported: 7, failed: 1, completed: false, since: '2025-09-27T00:00:00.000Z', syncedAt: null } }
        : url.includes('line-unregistered')
          ? { success: true, data: { registered: 21, total: 24, people: [{ staffId: 's1', name: '見本 148', tenantName: 'カフェ ムスビ', hasEmail: true }] } }
          : { success: true, data: { ...payload, periodLabel: url.includes('prev_month') ? '先月' : '今月' } }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

async function flush() {
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve() })
}

describe('表記の決まり', () => {
  it('前月比・所要時間・目盛り・容量', () => {
    expect(deltaLabel(59_600)).toBe('前月比 ＋¥59,600')
    expect(deltaLabel(-9_800)).toBe('前月比 −¥9,800')
    expect(deltaLabel(0)).toBe('前月比 ±¥0')
    expect(revenueDetail(59_600, 0)).toBe('前月比 ＋¥59,600・返金 ¥0')
    expect(contractDetail(12, { light: 4, standard: 6, pro: 2 }, 1)).toBe('12件（ライト4・スタンダード6・プロ2）・定価で補い 1件')
    expect(revenueSourceLabel('list_price', null)).toBe('定価で数えています')
    expect(minutesLabel(84)).toBe('1時間24分')
    expect(formatYenShort(4_500_000)).toBe('¥450万')
    expect(formatYenShort(0)).toBe('¥0')
    // 数字でない値が来ても「¥NaN」を出さず「—」にする（金額は formatYen の1か所で守る）。
    expect(formatYen(398_000)).toBe('¥398,000')
    expect(formatYen(Number.NaN)).toBe('—')
    expect(formatYen(undefined as unknown as number)).toBe('—')
    expect(formatYenShort(Number.NaN)).toBe('—')
    expect(niceCeiling(3_980_000)).toBe(4_000_000)
    expect(niceCeiling(0)).toBe(100_000)
    expect(formatBytes(1.8 * 1024 ** 3)).toBe('1.8GB')
  })
})

describe('画面', () => {
  it('数値カード・グラフ・要対応・チケット・使用量が出る', async () => {
    await act(async () => { root.render(<OpsDashboardPage />) })
    await flush()
    await act(async () => { (host.querySelector('button[aria-label="ダッシュボードの説明"]') as HTMLButtonElement).click() })
    const text = document.body.textContent ?? ''
    const details = Array.from(host.querySelectorAll('[title]')).map(item => item.getAttribute('title')).join(' ')
    expect(text).toContain('契約先の売上・使用量・お問い合わせ')
    expect(text).toContain('¥398,000')
    expect(details).toContain('前月比 ＋¥59,600')
    expect(details).toContain('返金 ¥0')
    expect(text).toContain('¥412,300')
    expect(details).toContain('12件（ライト4・スタンダード6・プロ2）・定価で補い 1件')
    expect(details).toContain('解約率 0.0%')
    expect(text).toContain('月ごとの売上')
    expect(host.querySelector('[aria-label="月ごとの売上"]')?.textContent).toContain('9月')
    // m22d: プラン別の行は割合だけにする。件数は「契約中の月額合計」の
    // カードに集約する（同じ「1件」「2件」が4回出るため）。
    expect(details).toContain('27%')
    expect(text).not.toContain('4件 ・ 27%')
    expect(text).toContain('トライアルは入れない')
    expect(text).toContain('決済が失敗している契約先')
    expect(text).toContain('LINEのトークン期限が近い店舗')
    await act(async () => { (host.querySelector('button[aria-label="お問い合わせの集計の説明"]') as HTMLButtonElement).click() })
    expect(document.body.textContent).toContain('1時間24分')
    expect(details).toContain('契約者専用LINEの登録 21人 / 24人')
    expect(text).toContain('未登録の3 人を見る')
    expect(details).toContain('4,820 / 5,000')
    expect(details).toContain('1.8GB / 5.0GB')
    expect(text).toContain('96%')
    expect(text).toContain('Stripe の入金実績（最後に取り込んだ日時 9月25日 03:00）')
    expect(text.toLowerCase()).not.toContain(['m', 'r', 'r'].join(''))
    expect(host.querySelector('[data-design-node="CyW0E"]')).not.toBeNull()
    expect(host.querySelector('[data-design-node="Xvofy"]')).toBeNull()
  })

  it('書き込み権限がある運営マスターには Stripe 同期ボタンを出す', async () => {
    await act(async () => { root.render(<OpsDashboardPage />) })
    await flush()
    const button = Array.from(host.querySelectorAll('button')).find((item) => item.textContent?.includes('Stripe と同期'))
    expect(button).toBeTruthy()
    expect(button?.disabled).toBe(false)
  })

  it('閲覧のみの運営メンバーには Stripe 同期ボタンを押せない形＋理由で出し、押しても口を呼ばない', async () => {
    stubDashboardFetch(async (input: RequestInfo | URL) => {
      const url = String(input)
      requests.push({ url })
      const body = url.endsWith('/api/ops/me')
        ? { success: true, data: { id: 'staff-2', name: '閲覧担当', email: null, readOnly: true, totpEnabled: true, lineLinked: false, legacy: false, impersonation: null } }
        : { success: true, data: payload }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    await act(async () => { root.render(<OpsDashboardPage />) })
    await flush()
    const button = Array.from(host.querySelectorAll('button')).find((item) => item.textContent?.includes('Stripe と同期')) as HTMLButtonElement
    expect(button).toBeTruthy()
    expect(host.textContent).toContain(OPS_READONLY_LOCK_REASON)
    await act(async () => { button.click(); await Promise.resolve() })
    await flush()
    expect(requests.some((item) => item.url.endsWith('/api/ops/billing/sync'))).toBe(false)
  })

  it('同期中はボタンを無効にし、12か月同期の完了後に結果を出してダッシュボードを読み直す', async () => {
    let finishSync: ((response: Response) => void) | undefined
    const deferredSync = new Promise<Response>((resolve) => { finishSync = resolve })
    stubDashboardFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, init })
      if (url.endsWith('/api/ops/me')) {
        return new Response(JSON.stringify({ success: true, data: { id: 'staff-1', name: '運営', email: null, readOnly: false, totpEnabled: true, lineLinked: false, legacy: false, impersonation: null } }), { status: 200 })
      }
      if (url.endsWith('/api/ops/billing/sync')) return deferredSync
      return new Response(JSON.stringify({ success: true, data: payload }), { status: 200 })
    })
    await act(async () => { root.render(<OpsDashboardPage />) })
    await flush()
    const dashboardCallsBefore = requests.filter((item) => item.url.includes('/api/ops/dashboard') && !item.url.includes('line-unregistered')).length
    const button = Array.from(host.querySelectorAll('button')).find((item) => item.textContent?.includes('Stripe と同期')) as HTMLButtonElement
    await act(async () => { button.click(); await Promise.resolve() })
    expect(button.disabled).toBe(true)
    const syncRequest = requests.find((item) => item.url.endsWith('/api/ops/billing/sync'))
    expect(syncRequest?.init?.method).toBe('POST')
    expect(syncRequest?.init?.body).toBe(JSON.stringify({ months: 12 }))
    finishSync!(new Response(JSON.stringify({ success: true, data: { tenants: 2, imported: 7, failed: 1, completed: false, since: '2025-09-27T00:00:00.000Z', syncedAt: null } }), { status: 200 }))
    await flush()
    expect(button.disabled).toBe(false)
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Stripe から 7 件取り込みました（失敗 1 件）')
    const dashboardCallsAfter = requests.filter((item) => item.url.includes('/api/ops/dashboard') && !item.url.includes('line-unregistered')).length
    expect(dashboardCallsAfter).toBeGreaterThan(dashboardCallsBefore)
  })

  it('同期に失敗したら理由を alert で出す', async () => {
    stubDashboardFetch(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/ops/me')) {
        return new Response(JSON.stringify({ success: true, data: { id: 'staff-1', name: '運営', email: null, readOnly: false, totpEnabled: true, lineLinked: false, legacy: false, impersonation: null } }), { status: 200 })
      }
      if (url.endsWith('/api/ops/billing/sync')) {
        return new Response(JSON.stringify({ success: false, error: 'Stripe の接続設定がまだありません' }), { status: 503 })
      }
      return new Response(JSON.stringify({ success: true, data: payload }), { status: 200 })
    })
    await act(async () => { root.render(<OpsDashboardPage />) })
    await flush()
    const button = Array.from(host.querySelectorAll('button')).find((item) => item.textContent?.includes('Stripe と同期')) as HTMLButtonElement
    await act(async () => { button.click() })
    await flush()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('失敗：Stripe の接続設定がまだありません')
    expect(button.disabled).toBe(false)
  })

  it('Stripe未設定時は定価の注記を同じ場所に出す', async () => {
    stubDashboardFetch(async () => new Response(JSON.stringify({
      success: true,
      data: { ...payload, pricing: 'list_price', lastSyncedAt: null },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    await act(async () => { root.render(<OpsDashboardPage />) })
    await flush()
    expect(host.querySelector('[aria-label="月ごとの売上"]')?.textContent).toContain('定価で数えています')
  })

  it('期間を先月に切り替えると period 付きで読み直す。未登録の人の一覧は名前と契約先を出す', async () => {
    await act(async () => { root.render(<OpsDashboardPage />) })
    await flush()
    const prev = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('先月'))
    await act(async () => { prev!.click() })
    await flush()
    expect(urls.some((u) => u.includes('/api/ops/dashboard?period=prev_month'))).toBe(true)
    expect(prev?.getAttribute('aria-pressed')).toBe('true')
    const guide = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('人を見る'))
    await act(async () => { guide!.click() })
    await flush()
    expect(document.body.textContent).toContain('見本 148')
    expect(urls.some((u) => u.endsWith('/api/ops/dashboard/line-unregistered'))).toBe(true)
  })

  it('上限に近い契約先の見出しは切れない短い言葉で、全文は乗せると分かる', async () => {
    await act(async () => { root.render(<OpsDashboardPage />) })
    await flush()
    const headers = Array.from(host.querySelectorAll('[role="columnheader"]'))
    const banner = headers.find((h) => h.textContent === 'バナー')
    const media = headers.find((h) => h.textContent === 'メディア')
    expect(banner?.getAttribute('title')).toBe('バナー生成')
    expect(media?.getAttribute('title')).toBe('メディア容量')
    expect(host.textContent).not.toContain('バナー生成')
    expect(host.textContent).not.toContain('メディア容量')
  })

  it('#1058: 読み込みに失敗したらエラーと再読み込みを1枚だけ出し、各セクションは読み込み中のままにしない', async () => {
    let fail = true
    stubDashboardFetch(async () => (
      fail
        ? new Response(JSON.stringify({ error: 'server' }), { status: 500 })
        : new Response(JSON.stringify({ success: true, data: payload }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    ))
    await act(async () => { root.render(<OpsDashboardPage />) })
    await flush()
    // エラー表示は1枚だけ。読み込み中や空の案内は残らない。
    expect(host.querySelectorAll('[data-list-state="error"]')).toHaveLength(1)
    expect(host.querySelectorAll('[data-list-state="loading"]')).toHaveLength(0)
    expect(host.querySelectorAll('[data-list-state="empty"]')).toHaveLength(0)
    expect(host.textContent).toContain('ダッシュボードを読み込めませんでした')
    // 再読み込みで復帰する。
    fail = false
    const retry = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('もう一度読み込む'))
    expect(retry).toBeTruthy()
    await act(async () => { retry!.click() })
    await flush()
    expect(host.textContent).toContain('¥398,000')
    expect(host.querySelector('[data-list-state="error"]')).toBeNull()
  })

  it('#1058: 未登録の人の一覧が読めないときは、ダイアログにエラーと再読み込みを出す', async () => {
    let fail = true
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('line-unregistered') && fail) {
        return new Response(JSON.stringify({ error: 'server' }), { status: 500 })
      }
      const body = url.includes('line-unregistered')
        ? { success: true, data: { registered: 21, total: 24, people: [{ staffId: 's1', name: '見本 148', tenantName: 'カフェ ムスビ', hasEmail: true }] } }
        : { success: true, data: payload }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    await act(async () => { root.render(<OpsDashboardPage />) })
    await flush()
    const guide = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('人を見る'))
    await act(async () => { guide!.click() })
    await flush()
    // ダイアログは「読み込んでいます」のままにせず、エラーと再読み込みを出す。
    expect(document.body.textContent).toContain('未登録の人を読み込めませんでした')
    const retry = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('もう一度読み込む'))
    expect(retry).toBeTruthy()
    fail = false
    await act(async () => { retry!.click() })
    await flush()
    expect(document.body.textContent).toContain('見本 148')
  })
})
