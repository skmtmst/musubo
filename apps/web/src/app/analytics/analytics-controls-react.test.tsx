// @vitest-environment happy-dom
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AnalyticsPage from './page'

/**
 * 分析の対象者種別・期間選択を、本物のReactと本物のapi.ts経由で確かめる。
 *
 * 文字列契約だけでは、期間ボタンを押しても古いfrom/toのまま、またはファネルの
 * プルダウンだけ変わってPOST本文が固定、という退行を見逃す。そのため通信だけを
 * 差し替え、画面が実際に組み立てたURLとPOST本文を読む。
 */

const fixture = vi.hoisted(() => ({
  accountId: 'account-a',
  tab: 'friends',
}))

const net = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; init?: RequestInit }>,
  handler: ((path: string, init?: RequestInit) => new Promise<unknown>(() => {})) as
    (path: string, init?: RequestInit) => Promise<unknown>,
}))

vi.mock('next/link', () => ({ default: ({ children }: { children?: unknown }) => children }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(), usePathname: () => '/analytics',
  useSearchParams: () => new URLSearchParams({ tab: fixture.tab }),
}))
vi.mock('@/components/layout/merged-tabs', () => ({
  default: () => null,
  useMergedTab: () => fixture.tab,
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: fixture.accountId, loading: false }),
}))

/*
 * 共通の Select は listbox の部品で、その操作は部品自身の試験が持つ。
 * ここで見たいのは選んだ後の集計の判断なので、素の <select> に置き換える。
 */
vi.mock('@/components/shared/select', () => ({
  default: ({ 'aria-label': label, id, value, onChange, options }: {
    'aria-label'?: string
    id?: string
    value: string
    onChange: (value: string) => void
    options: Array<{ value: string; label: string }>
  }) => React.createElement(
    'select',
    { 'aria-label': label, id, value, onChange: (e: { target: { value: string } }) => onChange(e.target.value) },
    options.map((option) => React.createElement('option', { key: option.value, value: option.value }, option.label)),
  ),
}))

function installFetch() {
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : String(input)
    const path = raw.startsWith('http') ? raw.slice(new URL(raw).origin.length) : raw
    net.calls.push({ path, init })
    const body = await net.handler(path, init)
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

function funnelRun(label = '申込') {
  return {
    runId: 'run-1', funnelId: 'funnel-1', versionId: 'version-1', versionNumber: 1,
    lineAccountId: fixture.accountId, cohortFrom: '2026-08-10T00:00:00.000Z', cohortTo: '2026-09-09T00:00:00.000Z',
    timeZone: 'Asia/Tokyo', dataCutoffAt: '2026-09-09T00:00:00.000Z', state: 'available', stateReason: null,
    groups: [{
      key: 'all', label: '全体', entrants: 10, completed: 2,
      steps: [
        { stepOrder: 1, label: '案内', reached: 10, conversionFromPrevious: 1, droppedAfter: 2, inProgressAfter: 1, averageSecondsFromPrevious: null, medianSecondsFromPrevious: null },
        { stepOrder: 2, label, reached: 5, conversionFromPrevious: 0.5, droppedAfter: 2, inProgressAfter: 1, averageSecondsFromPrevious: 60, medianSecondsFromPrevious: 60 },
      ],
    }],
  }
}

function usageOverview(accountId: string, categories = [
  { key: 'templates', label: 'テンプレート', state: 'available', value: 0, reason: null },
  { key: 'forms', label: '回答フォーム', state: 'unavailable', value: null, reason: '所属を確認できません' },
  { key: 'automations', label: 'オートメーション', state: 'partial', value: 1, reason: '未対応種別を除外' },
  { key: 'rich_menus', label: 'リッチメニュー', state: 'failed', value: null, reason: '照合失敗' },
]) {
  const numberMetric = { value: 0, state: 'available', reason: null }
  return {
    success: true,
    data: {
      lineAccountId: accountId,
      timeZone: 'Asia/Tokyo',
      period: { from: '2026-08-11', to: '2026-09-09' },
      dataCutoffAt: '2026-09-09T00:00:00.000Z',
      data: {
        state: 'partial', stateReason: null,
        checkedAt: '2026-09-09T00:00:00.000Z', automaticDeletion: false,
        summary: {
          unusedItems: numberMetric,
          brokenReferences: { value: 1, state: 'partial', reason: '確認できた参照だけの合計です' },
          automaticRuns: numberMetric,
          manualSends: numberMetric, estimatedHoursSaved: numberMetric,
        },
        categories: categories.map((item) => ({
          key: item.key, label: item.label, href: '/analytics',
          created: numberMetric, inUse: numberMetric, unused: numberMetric,
          brokenReferences: { value: item.value, state: item.state, reason: item.reason },
          lastUsedAt: { value: null, state: 'unavailable', reason: '利用記録なし' },
        })),
      },
    },
  }
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

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-09T00:00:00.000Z'))
  fixture.accountId = 'account-a'
  fixture.tab = 'friends'
  net.calls.length = 0
  net.handler = () => new Promise<unknown>(() => {})
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

async function render() {
  await act(async () => {
    root.render(<AnalyticsPage />)
    for (let tick = 0; tick < 8; tick++) await Promise.resolve()
  })
}

async function click(label: string) {
  const target = Array.from(host.querySelectorAll('button')).find((item) => item.textContent === label)
  if (!target) throw new Error(`「${label}」のボタンが見つかりません: ${host.textContent}`)
  await act(async () => { target.click(); await Promise.resolve() })
}

async function select(id: string, value: string) {
  const target = host.querySelector(`#${id}`) as HTMLSelectElement | null
  if (!target) throw new Error(`select #${id} が見つかりません`)
  await act(async () => {
    target.value = value
    target.dispatchEvent(new Event('change', { bubbles: true }))
    await Promise.resolve()
  })
}

function latestPath(prefix: string) {
  const path = net.calls.filter((call) => call.path.startsWith(prefix)).at(-1)?.path
  if (!path) throw new Error(`${prefix} の通信がありません`)
  return new URL(path, 'https://example.invalid').searchParams
}

function expectedRange(days: number) {
  const to = '2026-09-09'
  const from = new Date(Date.UTC(2026, 8, 9 - (days - 1))).toISOString().slice(0, 10)
  return { from, to }
}

describe('分析の対象者種別・期間選択(#835)', () => {
  it.each([
    ['friends', '/api/analytics/friends'],
    ['reactions', '/api/analytics/reactions'],
    ['routes', '/api/analytics/routes'],
    ['usage', '/api/analytics/usage'],
    ['url-clicks', '/api/analytics/url-clicks'],
  ])('%s は7/30/90日を実APIのfrom/toへ渡す', async (tab, endpoint) => {
    fixture.tab = tab
    await render()

    for (const days of [7, 30, 90]) {
      await click(`過去${days}日`)
      const params = latestPath(endpoint)
      expect(params.get('from')).toBe(expectedRange(days).from)
      expect(params.get('to')).toBe(expectedRange(days).to)
      expect(params.get('accountId') ?? params.get('account_id')).toBe('account-a')
    }
  })

  it('URLの状態を絞ると、ページに出ていない同じ状態のリンクもCSVへ入る', async () => {
    fixture.tab = 'url-clicks'
    const metric = (value: number) => ({ value, state: 'available', reason: null })
    net.handler = async (path) => {
      if (path.startsWith('/api/staff/me')) return { success: true, data: { role: 'viewer' } }
      return { success: true, data: { period: expectedRange(30), dataCutoffAt: null, data: {
        stateReason: null, hasMore: false, clickRateDefinition: '中継URLの実測',
        links: Array.from({ length: 26 }, (_, i) => ({ trackedLinkId: `link-${i}`, name: `リンク${i}`, originalUrl: `https://example.invalid/${i}`, isActive: i % 2 === 0, clicks: metric(i), knownClickPeople: metric(i), deliveredPeople: metric(100), clickRate: metric(i), usageLocations: ['一斉配信'] })),
      } } }
    }
    let csv: Blob | undefined
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => { csv = blob as Blob; return 'blob:test' })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await render()
    await select('url-state', 'active')
    expect(host.querySelectorAll('[role="table"][aria-label="URLごとのクリック"] [role="row"][data-h]')).toHaveLength(10)
    expect(host.textContent).toContain('13 件中')
    await click('CSVで書き出す')
    const body = await csv!.text()
    expect(body).toContain('"リンク24",')
    expect(body).not.toContain('"リンク1",')
    expect(body.split('\n')).toHaveLength(14)
  })

  it('ファネルは3種別を実POSTし、7/30/90日のcohort期間で再集計する', async () => {
    fixture.tab = 'funnel'
    net.handler = async (path) => {
      if (path.startsWith('/api/staff/me')) return { success: true, data: { role: 'admin' } }
      if (path.startsWith('/api/analytics/funnels?')) {
        return { success: true, data: [{ id: 'funnel-1', name: '申込導線', windowDays: 14, createdAt: '2026-01-01T00:00:00.000Z', status: 'active', currentVersion: { id: 'version-1', versionNumber: 1, createdAt: '2026-01-01T00:00:00.000Z' }, migrationState: 'ready' }] }
      }
      if (path.includes('/runs/latest?')) return { success: true, data: funnelRun() }
      if (path.includes('/run?')) return { success: true, data: funnelRun() }
      if (path.startsWith('/api/analytics/results/run-1/audiences?')) return { success: true, data: { id: 'audience-1', memberCount: 5, expiresAt: '2026-09-10T00:00:00.000Z' } }
      throw new Error(`未設定: ${path}`)
    }
    await render()
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })

    // 先頭段は「前段との差」が無いので、旧実装ではdisabledだった。到達/進行中も
    // 選べる契約を、実際に先頭段を押して確かめる。
    const firstStage = host.querySelector('button[aria-label="案内 10人"]') as HTMLButtonElement | null
    expect(firstStage).not.toBeNull()
    expect(firstStage?.disabled).toBe(false)
    await act(async () => { firstStage?.click(); await Promise.resolve() })

    for (const selection of ['reached', 'stopped', 'in_progress'] as const) {
      await click({ reached: '到達した人', stopped: '止まった人', in_progress: '進行中の人' }[selection])
      await click('対象者を開く')
      const request = net.calls.filter((call) => call.path.startsWith('/api/analytics/results/run-1/audiences?')).at(-1)
      expect(request, JSON.stringify(net.calls)).toBeDefined()
      expect(JSON.parse(String(request?.init?.body))).toMatchObject({
        sourceKind: 'funnel', groupKey: 'all', stepOrder: 1, selection,
      })
    }

    const secondStage = host.querySelector('button[aria-label^="申込 5人"]') as HTMLButtonElement | null
    expect(secondStage).not.toBeNull()
    await act(async () => { secondStage?.click(); await Promise.resolve() })
    await click('止まった人')
    await click('対象者を開く')
    const secondRequest = net.calls.filter((call) => call.path.startsWith('/api/analytics/results/run-1/audiences?')).at(-1)
    expect(JSON.parse(String(secondRequest?.init?.body))).toMatchObject({ stepOrder: 2, selection: 'stopped' })

    for (const days of [7, 30, 90]) {
      await click(`過去${days}日`)
      await click(`この${days}日を再集計`)
      const request = net.calls.filter((call) => call.path.includes('/api/analytics/funnels/funnel-1/run?')).at(-1)
      const body = JSON.parse(String(request?.init?.body))
      expect(body).toEqual({
        cohortFrom: `${expectedRange(days).from}T00:00:00.000+09:00`,
        cohortTo: '2026-09-09T00:00:00.000Z',
      })
      // DBはcutoff（実行時刻）より未来のcohortToを拒否する。開始だけをJSTの
      // 日付境界に固定し、終了は必ず現在時刻以下へ置く。
      expect(Date.parse(body.cohortTo)).toBeLessThanOrEqual(Date.now())
      expect(Date.parse(body.cohortFrom)).toBeLessThanOrEqual(Date.parse(body.cohortTo))
    }
  })

  it('アカウント切替後、遅れて返った古いファネル再集計を表示しない', async () => {
    fixture.tab = 'funnel'
    const late = deferred<unknown>()
    net.handler = async (path) => {
      if (path.startsWith('/api/staff/me')) return { success: true, data: { role: 'admin' } }
      if (path.startsWith('/api/analytics/funnels?')) {
        return { success: true, data: [{ id: 'funnel-1', name: '申込導線', windowDays: 14, createdAt: '2026-01-01T00:00:00.000Z', status: 'active', currentVersion: { id: 'version-1', versionNumber: 1, createdAt: '2026-01-01T00:00:00.000Z' }, migrationState: 'ready' }] }
      }
      if (path.includes('/runs/latest?')) return { success: false, error: 'Not found' }
      if (path.includes('/run?')) return late.promise
      throw new Error(`未設定: ${path}`)
    }
    await render()
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    await click('過去30日')
    expect(host.textContent).toContain('まだ集計していません')
    await click('過去7日')
    expect(host.textContent, host.textContent ?? '').toContain('まだ集計していません')
    await click('この7日を再集計')

    fixture.accountId = 'account-b'
    await render()
    const currentRunButton = Array.from(host.querySelectorAll('button')).find((item) => item.textContent === 'この7日を再集計') as HTMLButtonElement | undefined
    expect(currentRunButton?.disabled).toBe(false)
    late.resolve({ success: true, data: funnelRun('古い申込') })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    expect(host.textContent).not.toContain('古い申込')
  })

  it('使われ方は参照状態を描き分け、アカウント切替前の遅い応答を捨てる', async () => {
    fixture.tab = 'usage'
    const late = deferred<unknown>()
    net.handler = async (path) => {
      if (path.startsWith('/api/staff/me')) {
        return { success: true, data: { role: 'admin' } }
      }
      if (path.startsWith('/api/settings/features/visibility?')) {
        return { success: true, data: { features: {} } }
      }
      if (path.startsWith('/api/analytics/usage?')) {
        const accountId = new URL(path, 'https://example.invalid').searchParams.get('accountId')
        return accountId === 'account-a' ? late.promise : usageOverview('account-b')
      }
      throw new Error(`未設定: ${path}`)
    }

    await render()
    fixture.accountId = 'account-b'
    await render()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    expect(host.textContent).toContain('参照切れ 0')
    expect(host.textContent).toContain('参照切れ 未取得: 所属を確認できません')
    expect(host.textContent).toContain('参照切れ 1（一部のみ）: 未対応種別を除外')
    expect(host.textContent).toContain('参照切れ 取得失敗: 照合失敗')
    expect(host.textContent).toContain('参照切れ 1（一部のみ）')
    /*
     * #1005: 理由の長文はカードを伸ばさないよう説明アイコンの中へ。
     * 閉じている間は短い状態だけが見え、開くと全文が読める。
     */
    expect(host.textContent).not.toContain('確認できた参照だけの合計です')
    const descriptionButton = host.querySelector('button[aria-label="作ったのに使っていないの説明"]') as HTMLButtonElement | null
    expect(descriptionButton, '説明アイコンが無い').not.toBeNull()
    await act(async () => { descriptionButton!.click(); await Promise.resolve() })
    expect(host.textContent).toContain('確認できた参照だけの合計です')

    late.resolve(usageOverview('account-a', [
      { key: 'templates', label: '古い店舗のテンプレート', state: 'available', value: 9, reason: null },
    ]))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(host.textContent).not.toContain('古い店舗のテンプレート')
    expect(host.textContent).toContain('テンプレート')
  })
})

const FUNNEL_ACTIVE = {
  id: 'funnel-1', name: '申込導線', windowDays: 14, createdAt: '2026-01-01T00:00:00.000Z',
  status: 'active', confirmationRevision: 1,
  currentVersion: { id: 'version-1', versionNumber: 1, createdAt: '2026-01-01T00:00:00.000Z' },
  migrationState: 'ready',
}
const FUNNEL_DETAIL = {
  ...FUNNEL_ACTIVE,
  currentVersion: {
    id: 'version-1', versionNumber: 1, windowDays: 14,
    steps: [
      { stepOrder: 1, label: '案内', kind: 'friend_add', match: {} },
      { stepOrder: 2, label: '申込', kind: 'form', match: { formId: 'form-1' } },
    ],
    segment: { kind: 'all' }, comparisonGroups: [], createdAt: '2026-01-01T00:00:00.000Z',
  },
}
const FUNNEL_STOPPED = { ...FUNNEL_ACTIVE, id: 'funnel-2', name: '古い導線', status: 'stopped' }

function funnelHandler(funnels: unknown[], detail: unknown = FUNNEL_DETAIL) {
  return async (path: string) => {
    if (path.startsWith('/api/staff/me')) return { success: true, data: { role: 'admin' } }
    if (path.startsWith('/api/analytics/funnels?')) return { success: true, data: funnels }
    if (path.match(/\/api\/analytics\/funnels\/[^/]+\?/)) return { success: true, data: detail }
    if (path.includes('/runs/latest?')) return { success: true, data: funnelRun() }
    throw new Error(`未設定: ${path}`)
  }
}

function type(id: string, value: string) {
  // 板 ：作る・直すは小窓（document.body の portal）で出す。
  const input = document.body.querySelector(`#${id}`) as HTMLInputElement | null
  if (!input) throw new Error(`input #${id} が見つかりません`)
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function clickInDocument(label: string) {
  const target = Array.from((document.body.querySelector('[role="dialog"], [role="alertdialog"]') ?? document.body).querySelectorAll('button')).find(
    (item) => item.textContent === label,
  )
  if (!target) throw new Error(`「${label}」のボタンが見つかりません: ${document.body.textContent}`)
  await act(async () => { target.click(); await Promise.resolve(); await Promise.resolve() })
}

describe('ファネルの編集・停止・保管(#841)', () => {
  it('現在版を下書きへ読み、新版として保存すると expectedVersionNumber と名前を送る', async () => {
    fixture.tab = 'funnel'
    net.handler = funnelHandler([FUNNEL_ACTIVE])
    await render()
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })

    await click('定義を編集')
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const nameInput = document.body.querySelector('#fn-v8-name') as HTMLInputElement | null
    expect(nameInput?.value).toBe('申込導線')
    const stepInputs = Array.from(document.body.querySelectorAll('input'))
      .map((input) => (input as HTMLInputElement).value)
    expect(stepInputs).toContain('案内')
    expect(Array.from(document.body.querySelectorAll('input')).map(input => input.value)).toContain('申込')
    expect(document.body.textContent).toContain('新版として保存する')

    await act(async () => { type('fn-v8-name', '申込導線（改訂）'); await Promise.resolve() })
    net.handler = (async (path: string, init?: RequestInit) => {
      if (path.includes('/versions?')) {
        const body = JSON.parse(String(init?.body))
        expect(body).toMatchObject({
          name: '申込導線（改訂）', windowDays: 14, expectedVersionNumber: 1,
        })
        expect(body.steps).toHaveLength(2)
        return { success: true, data: { id: 'version-2', versionNumber: 2 } }
      }
      return funnelHandler([FUNNEL_ACTIVE])(path)
    }) as typeof net.handler
    await clickInDocument('新版として保存する')
    const request = net.calls.find((call) => call.path.includes('/versions?'))
    expect(request).toBeDefined()
    expect(request!.path).toContain('/api/analytics/funnels/funnel-1/versions')
  })

  it('停止は確認窓を通してPUTし、一覧から外れて「停止中」として残る', async () => {
    fixture.tab = 'funnel'
    let funnels: unknown[] = [FUNNEL_ACTIVE]
    net.handler = async (path: string, init?: RequestInit) => {
      if (path.startsWith('/api/staff/me')) return { success: true, data: { role: 'admin' } }
      if (path.startsWith('/api/analytics/funnels?')) return { success: true, data: funnels }
      if (path.match(/\/api\/analytics\/funnels\/[^/]+\?/)) return { success: true, data: FUNNEL_DETAIL }
      if (path.includes('/status?')) return { success: true, data: { id: 'funnel-1', status: 'stopped' } }
      if (path.includes('/runs/latest?')) return { success: true, data: funnelRun() }
      throw new Error(`未設定: ${path}`)
    }
    await render()
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })

    await click('停止')
    expect(document.body.textContent).toContain('ファネルを停止しますか')
    funnels = [FUNNEL_STOPPED]
    await clickInDocument('停止する')

    const request = net.calls.find((call) => call.path.includes('/status?'))
    expect(request).toBeDefined()
    expect(request!.init?.method).toBe('PUT')
    expect(JSON.parse(String(request!.init?.body))).toEqual({
      status: 'stopped', expectedStatus: 'active', expectedRevision: 1,
    })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(host.textContent).toContain('停止中・保管したファネル')
    expect(host.textContent).toContain('古い導線')
  })

  it('停止中のファネルは再集計ボタンを止め、確認窓から再開する', async () => {
    fixture.tab = 'funnel'
    net.handler = funnelHandler([FUNNEL_STOPPED])
    await render()
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })

    // 利用可能なファネルが無いので空の案内と停止中一覧が出る
    expect(host.textContent).toContain('停止中・保管したファネル')
    await click('結果を見る')
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(host.textContent).toContain('停止中です。再集計や対象者づくりはできません。')
    const runButton = Array.from(host.querySelectorAll('button')).find(
      (item) => item.textContent?.includes('再集計'),
    ) as HTMLButtonElement | undefined
    expect(runButton?.disabled).toBe(true)

    await click('再開')
    await clickInDocument('再開する')
    const request = net.calls.find((call) => call.path.includes('/status?'))
    expect(JSON.parse(String(request!.init?.body))).toEqual({
      status: 'active', expectedStatus: 'stopped', expectedRevision: 1,
    })
  })

  it('保管の確認窓は戻せないことを明示する', async () => {
    fixture.tab = 'funnel'
    net.handler = funnelHandler([FUNNEL_ACTIVE])
    await render()
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })

    await click('削除する')
    expect(document.body.textContent).toContain('あとから戻せません')
    await clickInDocument('削除する')
    const request = net.calls.find((call) => call.path.includes('/status?'))
    expect(JSON.parse(String(request!.init?.body))).toEqual({
      status: 'archived', expectedStatus: 'active', expectedRevision: 1,
    })
  })

  it('版がずれていたときは上書きせず、開き直しを促す', async () => {
    fixture.tab = 'funnel'
    net.handler = async (path: string, init?: RequestInit) => {
      if (path.startsWith('/api/staff/me')) return { success: true, data: { role: 'admin' } }
      if (path.startsWith('/api/analytics/funnels?')) return { success: true, data: [FUNNEL_ACTIVE] }
      if (path.includes('/versions?')) return { success: false, error: 'analytics_funnel_version_conflict' }
      if (path.match(/\/api\/analytics\/funnels\/[^/]+\?/)) return { success: true, data: FUNNEL_DETAIL }
      if (path.includes('/runs/latest?')) return { success: true, data: funnelRun() }
      throw new Error(`未設定: ${path}`)
    }
    await render()
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })

    await click('定義を編集')
    await act(async () => { await Promise.resolve() })
    await clickInDocument('新版として保存する')
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(document.body.textContent).toContain('ほかの人が先にこのファネルを保存しました')
  })

  it('編集の新版保存はフォームに出せない条件（絞り込み・比較・段の副条件）を落とさない', async () => {
    fixture.tab = 'funnel'
    const detail = {
      ...FUNNEL_DETAIL,
      currentVersion: {
        ...FUNNEL_DETAIL.currentVersion,
        segment: { kind: 'tag', tagId: 'tag-vip' },
        comparisonGroups: [{ key: 'g1', label: '比較ぶん', filter: { kind: 'all' } }],
        steps: [
          { stepOrder: 1, label: '案内', kind: 'friend_add', match: {} },
          // action のようなフォームに出せない副条件が残ることを確かめる
          { stepOrder: 2, label: '外し', kind: 'tag', match: { tagId: 'tag-9', action: 'removed' } },
        ],
      },
    }
    net.handler = funnelHandler([FUNNEL_ACTIVE], detail)
    await render()
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })

    await click('定義を編集')
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    // 7/30/90以外の日数（14日）も選択肢として残る
    expect(document.body.textContent).toContain('14日以内')

    let sent: Record<string, unknown> | null = null
    net.handler = (async (path: string, init?: RequestInit) => {
      if (path.includes('/versions?')) {
        sent = JSON.parse(String(init?.body))
        return { success: true, data: { id: 'version-2', versionNumber: 2 } }
      }
      return funnelHandler([FUNNEL_ACTIVE], detail)(path)
    }) as typeof net.handler
    await clickInDocument('新版として保存する')

    expect(sent).not.toBeNull()
    expect(sent!.segment).toEqual({ kind: 'tag', tagId: 'tag-vip' })
    expect(sent!.comparisonGroups).toEqual([{ key: 'g1', label: '比較ぶん', filter: { kind: 'all' } }])
    const steps = sent!.steps as Array<{ kind: string; match: Record<string, string> }>
    expect(steps[1].match).toEqual({ tagId: 'tag-9', action: 'removed' })
  })

  it('停止中ファネルの結果画面では対象者づくりの操作を出さない', async () => {
    fixture.tab = 'funnel'
    net.handler = funnelHandler([FUNNEL_STOPPED])
    await render()
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })

    await click('結果を見る')
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const firstStage = host.querySelector('button[aria-label="案内 10人"]') as HTMLButtonElement | null
    await act(async () => { firstStage?.click(); await Promise.resolve(); await Promise.resolve() })

    expect(host.textContent).toContain('停止中・保管したファネルでは対象者づくりはできません')
    expect(host.querySelector('#funnel-audience-selection')).toBeNull()
    expect(
      Array.from(host.querySelectorAll('button')).some((b) => b.textContent === '対象者を開く'),
    ).toBe(false)
    expect(net.calls.some((call) => call.path.includes('/audiences?'))).toBe(false)
  })

  it('staffには編集・停止・保管の操作を出さない', async () => {
    fixture.tab = 'funnel'
    net.handler = async (path: string) => {
      if (path.startsWith('/api/staff/me')) return { success: true, data: { role: 'staff' } }
      if (path.startsWith('/api/analytics/funnels?')) return { success: true, data: [FUNNEL_ACTIVE] }
      if (path.includes('/runs/latest?')) return { success: true, data: funnelRun() }
      throw new Error(`未設定: ${path}`)
    }
    await render()
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })

    expect(host.textContent).not.toContain('定義を編集')
    expect(Array.from(host.querySelectorAll('button')).some(item => item.textContent === '削除する')).toBe(false)
    expect(
      Array.from(host.querySelectorAll('button')).some((item) => item.textContent === '停止'),
    ).toBe(false)
  })
})
