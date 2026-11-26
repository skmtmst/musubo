// @vitest-environment happy-dom
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AnalyticsPage from './page'

/**
 * 分析の各見かたを、本物の React と本物の api.ts 経由で描いて確かめる。
 * 差し替えるのは通信（fetch）・タブ・アカウント・リンクだけ。
 *
 * 守ること：
 * - 集計できていない値を 0 と書かない（帯・表・日ごとの図）
 * - 集計待ちの理由を帯と図で二重に出さない
 * - ファネルの判定不能・版ずれ・「止まった人」と「途中の人」を混ぜない
 * - 未取得の言い方・期間とデータ締切・保存の説明・使われ方の欄
 */

const fixture = vi.hoisted(() => ({
  accountId: 'account-a',
  params: { tab: 'friends' } as Record<string, string>,
  role: 'admin',
}))

const net = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; init?: RequestInit }>,
  handler: ((path: string) => Promise.reject(new Error(`未設定: ${path}`))) as
    (path: string, init?: RequestInit) => Promise<unknown>,
}))

vi.mock('next/link', () => ({
  default: ({ children, href, className }: { children?: React.ReactNode; href: string; className?: string }) =>
    React.createElement('a', { href, className }, children),
}))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(), usePathname: () => '/analytics',
  useSearchParams: () => new URLSearchParams(fixture.params),
}))
vi.mock('@/components/layout/merged-tabs', () => ({
  default: () => null,
  useMergedTab: () => fixture.params.tab,
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: fixture.accountId, loading: false }),
}))

function installFetch() {
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : String(input)
    const path = raw.startsWith('http') ? raw.slice(new URL(raw).origin.length) : raw
    net.calls.push({ path, init })
    const body = path.startsWith('/api/staff/me')
      ? { success: true, data: { role: fixture.role } }
      : await net.handler(path, init)
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, String(value)) }
}

type MetricState = 'available' | 'pending' | 'unavailable' | 'insufficient' | 'partial' | 'failed'
const metric = <T,>(value: T | null, state: MetricState = 'available', reason: string | null = null) => ({ value, state, reason })

function envelope(data: unknown) {
  return {
    success: true,
    data: {
      lineAccountId: fixture.accountId,
      timeZone: 'Asia/Tokyo',
      period: { from: '2026-08-11', to: '2026-09-09' },
      dataCutoffAt: '2026-09-09T00:00:00.000Z',
      data,
    },
  }
}

function friendsOverview(overrides: Record<string, unknown> = {}) {
  return envelope({
    state: 'available',
    stateReason: null,
    metrics: {
      added: metric(8), removed: metric(3), net: metric(5),
      currentFriends: metric(120), firstTime: metric(6), returning: metric(2),
    },
    days: [
      { date: '2026-09-08', added: 3, removed: 1, net: 2 },
      { date: '2026-09-09', added: 5, removed: 2, net: 3 },
    ],
    campaigns: [{ id: 'b-1', name: '秋の案内', kind: 'broadcast', occurredAt: '2026-09-08T01:00:00.000Z', date: '2026-09-08' }],
    historyAvailableFrom: null,
    ...overrides,
  })
}

function route(overrides: Record<string, unknown> = {}) {
  return {
    id: 'route-1', refCode: 'ad-a', name: '広告A',
    clicks: metric(40), friendAdds: metric(12), currentFriends: metric(10), reactionPeople: metric(6),
    conversions: { approved: metric(3), pending: metric(1), rejected: metric(2), revenue: metric(30000) },
    adCost: metric(12000), costPerFriend: metric(1000), costPerConversion: metric(4000),
    profitAfterAdCost: metric(18000),
    ...overrides,
  }
}

function routesOverview(routes = [route()]) {
  return envelope({
    attributionModel: 'first_touch',
    attributionLabel: '最初の接点',
    routes,
    searchConsoleHref: 'https://search.google.com/search-console?resource_id=example',
  })
}

function reactionsOverview() {
  return envelope({
    metrics: {
      sent: metric(2), delivered: metric(100), opened: metric(40),
      lineClicked: metric(10), trackedClicks: metric(4), unavailableCampaigns: metric(0),
    },
    campaigns: [
      {
        id: 'b-1', name: '秋の案内', kind: 'broadcast', sentAt: '2026-09-08T01:00:00.000Z',
        targetPeople: metric(100), delivered: metric(98), sentMessages: metric(100), opened: metric(40),
        lineClicked: metric(10), outcomes: metric(2), fetchedAt: null,
      },
      {
        id: 's-1', name: '入会のステップ', kind: 'scenario', sentAt: '2026-09-07T01:00:00.000Z',
        targetPeople: metric(30), delivered: metric(null, 'unavailable', 'シナリオは届いた人数が取れません'),
        sentMessages: metric(42), opened: metric(null, 'insufficient', '20人未満'),
        lineClicked: metric(3), outcomes: metric(0), fetchedAt: null,
      },
    ],
    campaignsTruncation: { limit: 200, broadcast: false, scenario: false },
    trackedClickHours: [{ hour: 9, clicks: 4 }],
    clickDefinition: '中継URLのクリック数',
  })
}

function usageOverview(hoursSaved = metric<number>(null, 'unavailable', '手作業の時間は記録していません')) {
  return envelope({
    state: 'available',
    stateReason: null,
    checkedAt: '2026-09-09T03:00:00.000Z',
    automaticDeletion: false,
    summary: {
      unusedItems: metric(2), brokenReferences: metric(0), automaticRuns: metric(12),
      manualSends: metric(3), estimatedHoursSaved: hoursSaved,
    },
    categories: [
      {
        key: 'templates', label: 'テンプレート', href: '/templates',
        created: metric(5), inUse: metric(3), unused: metric(2), brokenReferences: metric(0),
        lastUsedAt: metric('2026-09-08'),
      },
      {
        key: 'tags', label: 'タグ', href: '/tags',
        created: metric(4), inUse: metric(4), unused: metric(0), brokenReferences: metric(0),
        lastUsedAt: metric<string>(null, 'unavailable', '記録がありません'),
      },
    ],
    features: [],
  })
}

function urlClicksOverview(hasMore: boolean, clickRate = metric(16.9)) {
  return envelope({
    state: 'available', stateReason: null, exposureAvailableFrom: null, hasMore,
    clickRateDefinition: '押した人 ÷ 届いた人',
    links: [{
      trackedLinkId: 'link-1', name: '申込ページ', originalUrl: 'https://example.invalid/apply', shortCode: null,
      isActive: true, actions: { tagName: null, scenarioName: null },
      clicks: metric(20), knownClickPeople: metric(15), deliveredPeople: metric(89), clickRate,
      firstClickedAt: metric('2026-09-01T00:00:00.000Z'), lastClickedAt: metric('2026-09-08T00:00:00.000Z'),
      usageLocations: ['一斉配信「秋の案内」'],
    }],
  })
}

function funnel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'funnel-1', name: '申込導線', windowDays: 14, createdAt: '2026-01-01T00:00:00.000Z', status: 'active',
    currentVersion: { id: 'version-1', versionNumber: 1, createdAt: '2026-01-01T00:00:00.000Z' },
    migrationState: 'ready',
    ...overrides,
  }
}

/** 段2つ。到達の差（10−5＝5）と「止まった人」（2）と「途中の人」（3）をわざとずらす。 */
function funnelRun(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run-1', funnelId: 'funnel-1', versionId: 'version-1', versionNumber: 1,
    lineAccountId: fixture.accountId,
    cohortFrom: '2026-08-10T00:00:00.000Z', cohortTo: '2026-09-09T00:00:00.000Z',
    timeZone: 'Asia/Tokyo', dataCutoffAt: '2026-09-09T00:00:00.000Z',
    state: 'available', stateReason: null,
    groups: [{
      key: 'all', label: '全体', entrants: 10, completed: 5,
      steps: [
        { stepOrder: 1, label: '案内', reached: 10, conversionFromPrevious: 1, droppedAfter: 2, inProgressAfter: 3, averageSecondsFromPrevious: null, medianSecondsFromPrevious: null },
        { stepOrder: 2, label: '申込', reached: 5, conversionFromPrevious: 0.5, droppedAfter: 0, inProgressAfter: 0, averageSecondsFromPrevious: null, medianSecondsFromPrevious: null },
      ],
    }],
    ...overrides,
  }
}

function funnelHandler(run: unknown, rest: (path: string, init?: RequestInit) => unknown = (path) => { throw new Error(`未設定: ${path}`) }, funnels: unknown[] = [funnel()]) {
  return async (path: string, init?: RequestInit) => {
    if (path.startsWith('/api/analytics/funnels?') && init?.method !== 'POST') return { success: true, data: funnels }
    if (path.includes('/runs/latest?')) return run
    return rest(path, init)
  }
}

function savedItem(overrides: Record<string, unknown> = {}, latest: Record<string, unknown> | null = {}) {
  return {
    id: 'saved-1', name: '流入別の成果', kind: 'cross', status: 'active',
    currentVersionNumber: 2, createdBy: 'u-1', createdByName: 'テスト',
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    snapshotCount: 1,
    latestSnapshot: latest === null ? null : {
      id: 'snap-1', state: 'available', periodFrom: '2026-08-25', periodTo: '2026-09-01',
      dataCutoffAt: '2026-09-01T15:00:00.000Z', createdAt: '2026-09-01T15:00:00.000Z',
      definitionStale: false, sourceVersionNumber: 2, sourceCurrentVersionNumber: 2,
      ...latest,
    },
    ...overrides,
  }
}

function savedHandler(items: unknown[], schedules: unknown[] = []) {
  return async (path: string) => {
    if (path.startsWith('/api/analytics/saved/') && path.includes('/snapshots')) return { success: true, data: [] }
    if (path.startsWith('/api/analytics/saved')) return { success: true, data: items }
    if (path.startsWith('/api/analytics/report-schedules')) {
      return { success: true, data: { items: schedules, options: { timeZone: 'Asia/Tokyo', savedAnalyses: [], recipients: [] } } }
    }
    throw new Error(`未設定: ${path}`)
  }
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  fixture.accountId = 'account-a'
  fixture.params = { tab: 'friends' }
  fixture.role = 'admin'
  net.calls.length = 0
  net.handler = (path) => Promise.reject(new Error(`未設定: ${path}`))
  vi.stubGlobal('localStorage', new MemoryStorage())
  vi.stubGlobal('sessionStorage', new MemoryStorage())
  installFetch()
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** 通信の Promise と、その後の描画を落ち着かせる。 */
async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  }
}

async function render(tab: string, params: Record<string, string> = {}) {
  fixture.params = { tab, ...params }
  await act(async () => { root.render(<AnalyticsPage />) })
  await settle()
}

function button(label: string, scope: ParentNode = host): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll('button')).find((item) => item.textContent?.trim() === label)
  if (!found) throw new Error(`「${label}」のボタンが見つかりません: ${host.textContent}`)
  return found as HTMLButtonElement
}

async function click(target: HTMLElement) {
  await act(async () => { target.click() })
  await settle()
}

/** 数の帯の1枚の文字（題の title で探す）。 */
function kpi(title: string): string {
  const label = Array.from(host.querySelectorAll('[data-kpi-label]')).find((item) => item.getAttribute('title') === title)
  if (!label) throw new Error(`数の帯「${title}」が見つかりません`)
  return label.closest('[data-kpi-presentation]')?.textContent ?? ''
}

const count = (text: string, part: string) => text.split(part).length - 1

function captureCsv(): () => Promise<string> {
  let csv: Blob | undefined
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => { csv = blob as Blob; return 'blob:test' })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  return async () => {
    if (!csv) throw new Error('CSV が書き出されていません')
    return csv.text()
  }
}

describe('友だちの増減は、集計できていない値を0と書かない', () => {
  it('集計待ちのときは帯の3枚を「—」にし、理由は帯に1回だけ、図には短い状態と次の更新のめどを出す', async () => {
    net.handler = async (path) => {
      if (path.startsWith('/api/analytics/friends')) {
        return friendsOverview({
          state: 'pending',
          stateReason: '日別集計の初回更新を待っています',
          metrics: {
            added: metric(0, 'pending'), removed: metric(0, 'pending'), net: metric(0, 'pending'),
            currentFriends: metric(120), firstTime: metric(0, 'pending'), returning: metric(0, 'pending'),
          },
          days: [{ date: '2026-09-09', added: 0, removed: 0, net: 0 }],
        })
      }
      if (path.startsWith('/api/analytics/routes')) return routesOverview([])
      throw new Error(`未設定: ${path}`)
    }
    await render('friends')

    // 数の欄は題のすぐ後ろ。集計待ちの 0 を数として出さない。
    for (const title of ['増えた', '減った', '差し引き']) expect(kpi(title).startsWith(`${title}—`)).toBe(true)
    expect(count(host.querySelector('[data-design-part="notice"]')?.textContent ?? '', '日別集計の初回更新を待っています')).toBe(1)
    expect(host.querySelector('button[aria-description="日別集計の初回更新を待っています"]')).toBeTruthy()
    const chart = host.querySelector('[aria-labelledby="friends-daily-title"] [role="status"]')
    expect(chart?.textContent).toContain('集計を待っています')
    expect(chart?.textContent).toContain('日ごとの集計は数分ごとに自動で更新されます')
    // 日ごとの棒も、施策の注（選んだ日の内訳）も並べない。
    expect(host.querySelector('button[aria-label^="9月9日"]')).toBeNull()
    expect(host.textContent).not.toContain('一斉配信「秋の案内」')
  })

  it('理由が無い集計待ちは、帯を出さず図に理由の全文を出す', async () => {
    net.handler = async (path) => {
      if (path.startsWith('/api/analytics/friends')) return friendsOverview({ state: 'pending', stateReason: null })
      if (path.startsWith('/api/analytics/routes')) return routesOverview([])
      throw new Error(`未設定: ${path}`)
    }
    await render('friends')

    const chart = host.querySelector('[aria-labelledby="friends-daily-title"] [role="status"]')
    expect(chart?.textContent).toContain('日ごとの集計がまだありません')
    expect(chart?.textContent).not.toContain('集計を待っています')
  })

  it('減少が取れないときは、差し引きも道連れで出さない', async () => {
    net.handler = async (path) => {
      if (path.startsWith('/api/analytics/friends')) {
        return friendsOverview({
          metrics: {
            added: metric(8), removed: metric(0, 'unavailable', 'ブロックの記録が無い期間です'), net: metric(5),
            currentFriends: metric(120), firstTime: metric(6), returning: metric(2),
          },
        })
      }
      if (path.startsWith('/api/analytics/routes')) return routesOverview([])
      throw new Error(`未設定: ${path}`)
    }
    await render('friends')

    expect(kpi('増えた')).toContain('8')
    expect(kpi('減った')).toContain('—')
    expect(kpi('差し引き')).toContain('—')
    expect(kpi('差し引き')).not.toContain('5')
  })

  it('集計できた日は棒と施策の注を出し、曜日は端末の地域に依らず暦日で決める', async () => {
    const tz = process.env.TZ
    process.env.TZ = 'America/Los_Angeles'
    try {
      net.handler = async (path) => {
        if (path.startsWith('/api/analytics/friends')) return friendsOverview()
        if (path.startsWith('/api/analytics/routes')) return routesOverview([])
        throw new Error(`未設定: ${path}`)
      }
      await render('friends')
      expect(host.querySelector('[aria-labelledby="friends-daily-title"]')?.textContent).toContain('日ごとの増減（この30日）')
      // 2026-09-09 は水曜。日本より遅い地域でも火曜にずれない。
      expect(host.querySelector('button[aria-label="9月9日（水） 増えた5人・減った2人"]')).not.toBeNull()
      expect(host.textContent).toContain('一斉配信「秋の案内」')
    } finally {
      process.env.TZ = tz
    }
  })
})

describe('各見かたは集計期間とデータ締切を出す', () => {
  it.each([
    ['reactions', '/api/analytics/reactions', reactionsOverview],
    ['routes', '/api/analytics/routes', () => routesOverview()],
  ] as const)('%s は道具の段に期間とデータの時点を出す', async (tab, endpoint, load) => {
    net.handler = async (path) => {
      if (path.startsWith(endpoint)) return load()
      throw new Error(`未設定: ${path}`)
    }
    await render(tab)
    expect(host.textContent).toContain('08/11〜09/09・09/09 09:00 までのデータ')
  })

  it('友だちの増減・使われ方・URLクリックは集計期間とデータ締切を出す', async () => {
    net.handler = async (path) => {
      if (path.startsWith('/api/analytics/friends')) return friendsOverview()
      if (path.startsWith('/api/analytics/routes')) return routesOverview([])
      if (path.startsWith('/api/analytics/usage')) return usageOverview()
      if (path.startsWith('/api/settings/features/visibility')) return { success: true, data: { features: {} } }
      if (path.startsWith('/api/analytics/url-clicks')) return urlClicksOverview(false)
      throw new Error(`未設定: ${path}`)
    }
    const periodOf = (text: string | null | undefined) => /集計期間 .+〜.+ ／ データ締切 .+/.test(text ?? '')

    await render('friends')
    await click(host.querySelector('button[aria-label="日ごとの増減の説明"]') as HTMLButtonElement)
    expect(periodOf(document.body.textContent)).toBe(true)

    await render('usage')
    expect(periodOf(host.textContent)).toBe(true)

    await render('url-clicks')
    expect(Array.from(host.querySelectorAll('[title]')).some((item) => periodOf(item.getAttribute('title')))).toBe(true)
  })
})

describe('経路と成果は、未取得を0にせず実測と分ける', () => {
  it('売上が取れない経路は「売上は未取得」、数の帯も売上の式を出さない', async () => {
    net.handler = async (path) => {
      if (path.startsWith('/api/analytics/routes')) {
        return routesOverview([route({
          conversions: { approved: metric(3), pending: metric(1), rejected: metric(2), revenue: metric(null, 'unavailable', '売上の連携がありません') },
          friendAdds: metric<number>(null),
          reactionPeople: metric(0, 'pending', '反応の集計を待っています'),
        })])
      }
      throw new Error(`未設定: ${path}`)
    }
    await render('routes')

    const row = host.querySelector('[aria-label="経路ごとの成果"] tbody tr')
    expect(row?.textContent).toContain('売上は未取得')
    expect(kpi('差し引き')).toContain('売上は未取得です')
    // 値が無い数は「—」。0 に置き換えない。
    expect(row?.querySelectorAll('td')[1]?.textContent).toBe('—')
    // 集計待ちの 0 も実測の 0 と同じに見せない。
    expect(row?.querySelectorAll('td')[2]?.textContent).toBe('—')
    expect(row?.querySelectorAll('td')[2]?.querySelector('[title]')?.getAttribute('title')).toBe('反応の集計を待っています')
  })

  it('取れた売上は「売上 ○円 − 費用」で示し、行には補助の数を添える', async () => {
    net.handler = async (path) => {
      if (path.startsWith('/api/analytics/routes')) return routesOverview()
      throw new Error(`未設定: ${path}`)
    }
    await render('routes')

    expect(kpi('差し引き')).toMatch(/売上 ¥30,000 − 費用/)
    const titles = Array.from(host.querySelectorAll('[aria-label="経路ごとの成果"] tbody td')).map((cell) => cell.getAttribute('title') ?? '')
    expect(titles).toEqual(expect.arrayContaining([
      expect.stringContaining('クリック 40'),
      '現在 10',
      '保留 1・却下 2',
      '友だち1人 ¥1,000・成果1件 ¥4,000',
    ]))
    const consoleLink = Array.from(host.querySelectorAll('a')).find((item) => item.textContent?.includes('Search Console を見る'))
    expect(consoleLink?.getAttribute('href')).toBe('https://search.google.com/search-console?resource_id=example')
  })
})

describe('配信の反応は、シナリオの送信通数を人数と分ける', () => {
  it('シナリオの行は対象の下に通数を出し、到達は「—」、CSVは別の列に通数を入れる', async () => {
    net.handler = async (path) => {
      if (path.startsWith('/api/analytics/reactions')) return reactionsOverview()
      throw new Error(`未設定: ${path}`)
    }
    const csv = captureCsv()
    await render('reactions')

    const rows = Array.from(host.querySelectorAll('[aria-label="配信ごとの反応"] [role="row"][data-h]'))
    const scenario = rows.find((row) => row.textContent?.includes('入会のステップ'))
    const cells = Array.from(scenario?.querySelectorAll('[role="cell"]') ?? [])
    expect(cells[2]?.textContent).toBe('30送信 42 通')
    expect(cells[3]?.textContent).toBe('—')
    expect(host.querySelector('[role="columnheader"][title^="一斉配信で届いた人数です。シナリオは届いた人数が取れないため「—」です"]')).not.toBeNull()
    expect(host.querySelector('#reactions-hours-title')?.textContent).toBe('押された時間帯ごとの回数')

    await click(button('CSVで書き出す', host.querySelector('[aria-label="配信ごとの反応"]')?.parentElement ?? host))
    const lines = (await csv()).replace(/^﻿/, '').split('\n')
    expect(lines[0]).toContain('"送信通数"')
    expect(lines.find((line) => line.includes('入会のステップ'))).toMatch(/"シナリオ","[^"]*","30","","42",/)
  })
})

describe('URLクリック', () => {
  it('APIが16.9と返すクリック率は16.9%と出す（1690%にしない）', async () => {
    net.handler = async (path) => {
      if (path.startsWith('/api/analytics/url-clicks')) return urlClicksOverview(false)
      throw new Error(`未設定: ${path}`)
    }
    await render('url-clicks')
    const row = host.querySelector('[aria-label="URLごとのクリック"] [role="row"][data-h]')
    expect(row?.textContent).toContain('16.9%')
    expect(row?.textContent).not.toContain('1690')
    expect(host.querySelector('input[aria-label="URL・配信名・リンク名で探す"]')).not.toBeNull()
    expect(host.textContent).not.toContain('200件までを表示しています')
  })

  it('200件で切れるときは、探す範囲とCSVの範囲を断る', async () => {
    net.handler = async (path) => {
      if (path.startsWith('/api/analytics/url-clicks')) return urlClicksOverview(true)
      throw new Error(`未設定: ${path}`)
    }
    await render('url-clicks')
    expect(host.textContent).toContain('条件に合うもののうち200件までを表示しています。探す言葉で絞るとこの中だけではなく全体から探します。CSVの書き出しも、表示している範囲だけが入ります。')
  })
})

describe('使われ方', () => {
  function usageHandler(hoursSaved?: ReturnType<typeof metric<number>>) {
    return async (path: string) => {
      if (path.startsWith('/api/analytics/usage')) return usageOverview(hoursSaved)
      if (path.startsWith('/api/settings/features/visibility')) return { success: true, data: { features: {} } }
      throw new Error(`未設定: ${path}`)
    }
  }

  it('帯・注・気づいたこと・最後に確認した時刻を出し、取れない時間は「—」と理由にする', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-28T00:00:00Z'))
    net.handler = usageHandler()
    await render('usage')

    expect(kpi('使っている機能')).toContain('メニューに出している機能のうち')
    expect(kpi('作ったのに使っていない')).toContain('2')
    expect(kpi('自動で動いた回数')).toContain('12')
    expect(kpi('手作業が減った時間')).toContain('—')
    expect(kpi('手作業が減った時間')).toContain('未取得')
    expect(kpi('手作業が減った時間')).not.toContain('1件30秒として試算')
    expect(host.textContent).toContain('項目が多いほど良い、ではありません')
    expect(host.querySelector('#usage-observations-title')?.textContent).toBe('気づいたこと')
    expect(host.textContent).toContain('・テンプレート：2 個は使われていません')
    expect(host.textContent).toContain('利用関係を最後に確認: 9月9日 12:00')
    const rows = Array.from(host.querySelectorAll('[aria-label="機能ごとの使われ方"] tbody tr'))
    expect(rows[0]?.querySelectorAll('td')[4]?.textContent).toBe('09/08')
    expect(rows[1]?.querySelectorAll('td')[4]?.textContent).toBe('—')
  })

  it('メニューに出している機能が読めないときは断り、「もう一度確認」で読み直す', async () => {
    let visibilityOk = false
    net.handler = async (path: string) => {
      if (path.startsWith('/api/analytics/usage')) return usageOverview()
      if (path.startsWith('/api/settings/features/visibility')) {
        if (!visibilityOk) throw new Error('接続できませんでした')
        return { success: true, data: { features: {} } }
      }
      throw new Error(`未設定: ${path}`)
    }
    await render('usage')
    expect(kpi('使っている機能')).toContain('メニューに出している機能を確認できません')
    const before = net.calls.filter((call) => call.path.startsWith('/api/settings/features/visibility')).length

    visibilityOk = true
    const retry = host.querySelector('[role="alert"], [data-tone="danger"]')?.querySelector('button') ?? button('もう一度確認')
    await click(retry as HTMLButtonElement)
    expect(net.calls.filter((call) => call.path.startsWith('/api/settings/features/visibility')).length).toBe(before + 1)
    expect(kpi('使っている機能')).toContain('メニューに出している機能のうち')
  })

  it('取れた時間は「1件30秒として試算」と並べる', async () => {
    net.handler = usageHandler(metric(4))
    await render('usage')
    expect(kpi('手作業が減った時間')).toContain('4')
    expect(kpi('手作業が減った時間')).toContain('1件30秒として試算')
  })
})

describe('保存した分析', () => {
  it('定義と結果を分けて保存していると断り、検索は分析名と作った人で探す', async () => {
    net.handler = savedHandler([savedItem()])
    await render('saved')

    const note = Array.from(host.querySelectorAll('span')).find((item) => item.textContent === '条件の定義と集計結果を分けて保存しています')
    expect(note?.getAttribute('title')).toContain('保存時点の結果は書き換わりません')
    expect(note?.getAttribute('title')).toContain('定期レポートは下の一覧で止めたり変えたりできます')
    expect(host.querySelector('input[aria-label="分析名・作った人で探す"]')).not.toBeNull()
  })

  it('最新の結果の状態は「未取得」と言い、版ずれ（定義が古い）とは別に数える', async () => {
    net.handler = savedHandler([
      savedItem({ id: 'saved-1', name: '秋の分析' }, { state: 'unavailable', definitionStale: false }),
      savedItem({ id: 'saved-2', name: '冬の分析' }, { state: 'failed', definitionStale: false }),
      savedItem({ id: 'saved-3', name: '春の分析' }, { state: 'available', definitionStale: true, sourceVersionNumber: 1, sourceCurrentVersionNumber: 2 }),
    ])
    await render('saved')

    const rowOf = (name: string) => Array.from(host.querySelectorAll('[aria-label="保存した分析"] tbody tr')).find((row) => row.textContent?.includes(name))
    expect(rowOf('秋の分析')?.textContent).toContain('未取得')
    expect(rowOf('冬の分析')?.textContent).toContain('失敗')
    expect(rowOf('春の分析')?.textContent).toContain('更新後未集計')
    // 「定義が古い」は版ずれの1件だけ。未取得・失敗は数えない。
    expect(kpi('定義が古いもの')).toMatch(/1\s*件/)
    expect(kpi('定義が古いもの')).toContain('更新後まだ集計していない')
  })
})

describe('定期レポートの行', () => {
  it('状態を日本語の札で出し、「内容を変える」はそのレポートの編集画面へ進む', async () => {
    const { useRouter } = await import('next/navigation')
    const push = useRouter().push as ReturnType<typeof vi.fn>
    push.mockClear()
    net.handler = savedHandler([savedItem()], [{
      id: 'report-1', lineAccountId: 'account-a', name: '週次まとめ', sections: ['friends'], savedAnalysisIds: ['saved-1'],
      cadence: 'weekly', weekday: 1, monthDay: null, sendTime: '09:00', timeZone: 'Asia/Tokyo', periodDays: 7,
      recipients: [], channels: ['dashboard'], alertRules: [], status: 'active', isOneTime: false,
      nextRunAt: '2026-09-21T00:00:00.000Z', createdBy: 'u-1', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    }])
    await render('saved')

    const row = Array.from(host.querySelectorAll('[aria-label="定期レポート"] tbody tr')).find((item) => item.textContent?.includes('週次まとめ'))
    expect(row?.textContent).toContain('有効')
    await click(host.querySelector('button[aria-label="定期レポート「週次まとめ」の操作"]') as HTMLButtonElement)
    const edit = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((item) => item.textContent?.trim() === '内容を変更する')
    await click(edit as HTMLElement)
    expect(push).toHaveBeenCalledWith(expect.stringContaining('/analytics/reports/new?id=report-1'))
  })
})

describe('ファネルの集計状態', () => {
  it('未取得の結果は人数・割合を出さず、判定不能と理由を出し、対象者を選ばせない', async () => {
    net.handler = funnelHandler({ success: true, data: funnelRun({ state: 'unavailable', stateReason: '記録の取り込みが止まっています' }) })
    const csv = captureCsv()
    await render('funnel')

    expect(host.textContent).toContain('未取得のため、この結果は判定不能です。人数や割合は実測値ではありません。 記録の取り込みが止まっています')
    for (const title of ['入口', '最後まで', 'いちばん落ちる段']) {
      expect(kpi(title)).toContain('判定不能')
      expect(kpi(title)).toContain('—')
    }
    const bars = Array.from(host.querySelectorAll('[role="group"][aria-label="全体の流れ"] button'))
    expect(bars).toHaveLength(2)
    expect(bars.every((bar) => (bar as HTMLButtonElement).disabled)).toBe(true)
    expect(bars[0]?.getAttribute('aria-label')).not.toContain('10')
    expect(host.textContent).toContain('この結果は判定不能のため、対象者は選べません。')
    expect(Array.from(host.querySelectorAll('button')).some((item) => item.textContent?.includes('対象者を開く'))).toBe(false)

    await click(button('CSVで書き出す'))
    const lines = (await csv()).replace(/^﻿/, '').split('\n')
    expect(lines[0]).toBe('"集計状態","未取得（記録の取り込みが止まっています）"')
    expect(lines[1]).toBe('"集計した定義版","1"')
    expect(lines.find((line) => line.startsWith('"案内"'))).toBe('"案内","","","",""')
  })

  it('一部集計は数を出し、少なく数えている可能性を断る', async () => {
    net.handler = funnelHandler({ success: true, data: funnelRun({ state: 'partial', stateReason: null }) })
    await render('funnel')

    expect(kpi('入口')).toContain('10')
    expect(host.textContent).toContain('一部の期間・種類のデータが無いため、実際より少なく数えている可能性があります。')
    expect(host.textContent).not.toContain('判定不能')
  })

  it('「止まった人」は口が数えた人数を使い、まだ途中の人を混ぜない', async () => {
    net.handler = funnelHandler({ success: true, data: funnelRun() })
    await render('funnel')

    // 到達の差（10−5＝5）ではなく、止まった 2人・進行中 3人。
    expect(host.querySelector('button[aria-label="申込 5人・止まった 2人・進行中 3人"]')).not.toBeNull()
    expect(kpi('いちばん落ちる段')).toContain('20')
    expect(host.textContent).toContain('この段で止まった人 2 人')
    await click(button('進行中の人'))
    expect(host.textContent).toContain('この段で進行中の人 3 人')
    expect(host.textContent).toContain('まだ途中の人は完了した人に含めません')
  })

  it('閲覧のみの人には対象者づくりを理由付きで表示し、操作は送らない', async () => {
    fixture.role = 'viewer'
    net.handler = funnelHandler({ success: true, data: funnelRun() })
    await render('funnel')

    expect(host.textContent).toContain('この段で止まった人 2 人')
    for (const label of ['対象者を開く', 'この対象者へ配信を作る']) {
      const control = button(label)
      expect(control.disabled || control.getAttribute('aria-disabled') === 'true').toBe(true)
      await click(control)
    }
    expect(host.textContent).toContain('閲覧のみのため変更できません')
    expect(net.calls.some(call => call.path.includes('/audiences?'))).toBe(false)
  })

  it('結果の定義版といまの定義版がずれていたら、旧版の結果だと断る', async () => {
    net.handler = funnelHandler(
      { success: true, data: funnelRun({ versionNumber: 1 }) },
      undefined,
      [funnel({ currentVersion: { id: 'version-2', versionNumber: 2, createdAt: '2026-02-01T00:00:00.000Z' } })],
    )
    await render('funnel')

    expect(host.textContent).toContain('この結果は定義版1で集計したものです。いまの定義は版2です。')
    expect(host.textContent).toMatch(/集計期間 .+〜.+ ／ データ締切 .+ ／ 集計した定義版 1/)
  })

  it('版が同じなら断りを出さない', async () => {
    net.handler = funnelHandler({ success: true, data: funnelRun({ versionNumber: 1 }) })
    await render('funnel')
    expect(host.textContent).not.toContain('この結果は定義版')
  })

  it('まだ集計していないファネルは案内を出し、「集計する」で集計を送る', async () => {
    net.handler = funnelHandler({ success: false, error: 'Not found' }, async (path) => {
      if (path.includes('/api/analytics/funnels/funnel-1/run?')) return { success: true, data: funnelRun() }
      throw new Error(`未設定: ${path}`)
    })
    await render('funnel')

    expect(host.textContent).toContain('まだ集計していません。')
    await click(button('集計する'))
    expect(net.calls.filter((call) => call.path.includes('/api/analytics/funnels/funnel-1/run?'))).toHaveLength(1)
    expect(host.querySelector('button[aria-label="案内 10人"]')).not.toBeNull()
  })

  it('60秒以内の再集計は運用の言葉で断る', async () => {
    net.handler = funnelHandler({ success: true, data: funnelRun() }, async (path) => {
      if (path.includes('/run?')) return { success: false, error: 'analytics_funnel_too_soon' }
      throw new Error(`未設定: ${path}`)
    })
    await render('funnel')

    await click(button('集計し直す'))
    expect(host.textContent).toContain('さきほど集計したばかりです。少し待ってから押してください')
    expect(host.textContent).not.toContain('analytics_funnel_too_soon')
  })

  it('作る権限がある人は「ファネルを作る」から作る窓を開ける', async () => {
    net.handler = funnelHandler({ success: true, data: funnelRun() }, async (path) => {
      if (path.startsWith('/api/conversions') || path.startsWith('/api/tags') || path.startsWith('/api/forms')) return { success: true, data: [] }
      throw new Error(`未設定: ${path}`)
    })
    await render('funnel')

    await click(button('ファネルを作る'))
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('名前')
  })

  it('作れたが成果地点への利用先記録に失敗したときは、静かに成功にせず断る', async () => {
    net.handler = funnelHandler({ success: false, error: 'Not found' }, async (path, init) => {
      if (path.startsWith('/api/analytics/funnels?') && init?.method === 'POST') {
        return { success: true, data: { funnelId: 'funnel-1', version: { id: 'version-1', versionNumber: 1 }, usageWarnings: ['購入完了'] } }
      }
      if (path.startsWith('/api/conversions')) return { success: true, data: { items: [{ id: 'point-1', name: '購入完了' }] } }
      if (path.startsWith('/api/tags') || path.startsWith('/api/forms')) return { success: true, data: [] }
      throw new Error(`未設定: ${path}`)
    })
    await render('funnel', { conversionPointId: 'point-1', conversionPointName: '購入完了' })

    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement
    const setValue = (label: string, value: string) => {
      const input = Array.from(dialog.querySelectorAll('input')).find((item) => item.getAttribute('aria-label') === label || dialog.querySelector(`label[for="${item.id}"]`)?.textContent === label)
      if (!input) throw new Error(`入力欄「${label}」が見つかりません`)
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await act(async () => { setValue('名前', '購入まで'); setValue('段1の名前', '友だち追加') })
    await click(button('作る', dialog))

    expect(host.textContent).toContain('作成はできましたが、成果地点への利用先記録に失敗しました：購入完了。成果地点側の利用先一覧には出ていません。')
  })
})

describe('88 二段の切り替え', () => {
  it('下の段（見かた）は灰の箱の切り替えで、押すと履歴を積まずに置き換える', async () => {
    const { useRouter } = await import('next/navigation')
    const replace = useRouter().replace as ReturnType<typeof vi.fn>
    replace.mockClear()
    net.handler = async (path) => {
      if (path.startsWith('/api/analytics/friends')) return friendsOverview()
      if (path.startsWith('/api/analytics/routes')) return routesOverview([])
      if (path.startsWith('/api/analytics/saved')) return { success: true, data: [] }
      throw new Error(`未設定: ${path}`)
    }
    await render('friends')

    // 上の段（組）だけが下線のタブ。下の段は箱の切り替え。
    expect(host.querySelectorAll('[role="tablist"]')).toHaveLength(1)
    const views = host.querySelector('[role="group"][aria-label="分析の見かた"]')
    expect(views).not.toBeNull()
    const reactions = Array.from(views!.querySelectorAll('button')).find((item) => item.textContent?.includes('配信の反応'))
    await click(reactions as HTMLElement)
    expect(replace).toHaveBeenCalledWith('/analytics?tab=reactions')
    expect(useRouter().push as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })
})
