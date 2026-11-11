// @vitest-environment happy-dom
/*
 * 板  運営ダッシュボードの絵合わせ（V8）。
 * - 頭：説明＋今月・先月・今年が右
 * - 数の帯：契約中の月額合計・今月の売上・トライアル中の順と内訳
 * - 要対応：何が・件数の見出しと開くボタン
 * - 上限の表：5列・使用率は％で出す
 * - チケット：3つの数＋すべて見る →／プランの1行／LINE未登録の1行
 * - 解約の札・今月のようす・使用率の列は V8 では出さない
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import OpsDashboardPage from './page'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))
// 最初の10分の段は口も試験も別（v8/ops/first-run.test.tsx）。ここではダッシュボード本体の口だけを見る。
vi.mock('@/v8/ops/dashboard/first-run', () => ({ default: () => null }))

const GB = 1024 ** 3

const payload = {
  period: 'month', periodLabel: '今月', pricing: 'stripe_actual', lastSyncedAt: null,
  plans: [],
  kpis: { revenueThisMonth: 39600, revenueDelta: 0, refundsThisMonth: 0, contractMonthlyTotal: 99400, filledByListPriceCount: 0, active: 3, byPlan: { light: 2, standard: 1, pro: 1 }, trialing: 1, newInPeriod: 0, newTrialsInPeriod: 0, churnInPeriod: 0, churnRate: 0 },
  revenueByMonth: [4, 5, 6, 7, 8, 9, 10].map((m, i) => ({ month: `2026-0${m}`, label: `${m}月`, yen: 20_000 + i * 5_000, current: i === 6 })),
  planShare: { total: 5, rows: [
    { key: 'light', label: 'ライト', count: 2, percent: 40 }, { key: 'standard', label: 'スタンダード', count: 1, percent: 20 },
    { key: 'pro', label: 'プロ', count: 1, percent: 20 }, { key: 'trial', label: 'トライアル', count: 1, percent: 20 },
  ] },
  alerts: { pastDue: 1, trialEndingSoon: 1, lineTokenExpiring: 2, unansweredTickets: 2 },
  tickets: { newCount: 2, inProgressCount: 3, avgFirstReplyMinutes: 144, closedInPeriod: 5 },
  lineRegistration: { registered: 8, total: 10, unregisteredCount: 2 },
  usage: [
    { tenantId: 't1', tenantName: '然-NEN-本部', planKey: 'standard', planLabel: 'スタンダード', messages: 8200, bannerUnits: 73, mediaBytes: 4.1 * GB, limits: { messages: 10000, images: 100, mediaBytes: 10 * GB }, usageRate: 82 },
    { tenantId: 't2', tenantName: 'ペットサロン Mori', planKey: 'pro', planLabel: 'プロ', messages: 6400, bannerUnits: 22, mediaBytes: 5.8 * GB, limits: { messages: 10000, images: 100, mediaBytes: 10 * GB }, usageRate: 64 },
  ],
  generatedAt: '2026-10-04T10:00:00.000+09:00',
}

const people = [
  { staffId: 's1', name: '佐藤', tenantName: '渋谷ドッグカフェ', hasEmail: true },
  { staffId: 's2', name: '鈴木', tenantName: '北の牧場', hasEmail: false },
]

let host: HTMLDivElement
let root: Root

function text(): string {
  return host.textContent ?? ''
}

async function settle(turns = 10) {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => { await Promise.resolve() })
  }
}

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const body = url.endsWith('/api/ops/me')
      ? { success: true, data: { readOnly: false } }
      : url.includes('line-unregistered')
        ? { success: true, data: { registered: 8, total: 10, people } }
        : { success: true, data: payload }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete document.documentElement.dataset.theme
  vi.unstubAllGlobals()
})

describe('CyW0E ダッシュボードの絵合わせ', () => {
  it('頭・数の帯・要対応・表・下の札が絵どおり', async () => {
    await act(async () => { root.render(<OpsDashboardPage />) })
    await settle()
    const body = text()
    // 頭
    // 見出し下の説明は共通の「？」から読む。説明の欠落と開閉の動きを検査する。
    const help = host.querySelector<HTMLButtonElement>('button[aria-label="ダッシュボードの説明"]')!
    expect(help).toBeTruthy()
    expect(help.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { help.click() })
    expect(help.getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelector('[role="note"]')?.textContent).toContain('契約先の売上・使用量・お問い合わせを見て、要対応から片づけます')
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(help.getAttribute('aria-expanded')).toBe('false')
    expect(body).not.toContain('のようす')
    // 数の帯の順と内訳
    const order = ['契約中の月額合計', '今月の売上', 'トライアル中']
    const positions = order.map((t) => body.indexOf(t))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    expect(body).not.toContain('今月の AI 利用')
    const revenueHelp = host.querySelector<HTMLButtonElement>('button[aria-label="今月の売上の説明"]')!
    expect(revenueHelp).toBeTruthy()
    await act(async () => { revenueHelp.click() })
    expect(document.body.textContent).toContain('今月の売上（入金済み）')
    expect(document.body.textContent).toContain('前月比')
    expect(document.body.textContent).toContain('返金')
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(body).toContain('契約中 3・決済失敗 1（トライアルは入れない）')
    expect(body).toContain('決済失敗 1 社')
    expect(body).toContain('期限 3日以内 1')
    expect(body).not.toContain('解約')
    // 要対応
    expect(body).toContain('何が')
    expect(body).toContain('件数')
    // 上限の表は％
    for (const pct of ['82%', '73%', '41%', '64%', '22%', '58%']) {
      expect(body).toContain(pct)
    }
    expect(body).not.toContain('使用率')
    // チケット
    expect(body).toContain('未対応')
    expect(body).toContain('2 件')
    expect(body).toContain('2.4 時間')
    expect(body).toContain('すべて見る →')
    expect(body).not.toContain('クローズ')
    // 下の札
    expect(body).toContain('スタンダード 1・プロ 1・ライト 2・トライアル 1')
    expect(body).toContain('メール未登録 1 人・LINE 未登録 2 人（渋谷ドッグカフェ 1・北の牧場 1）')
  })
})
