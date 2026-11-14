// @vitest-environment happy-dom
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AnalyticsPage from './page'

/**
 * 保存タブの定期レポート一覧を本物のReactで動かす試験(#844 / N-277,N-278)。
 *
 * 「なし」と決め打ちで出していた一覧・停止・再開・しまう・編集導線が、
 * 実APIの応答から正しく描かれ、版つきの状態変更へ進むことを見る。
 * api・fetchApiは実物を通し、通信(fetch)だけを差し替える。
 */

const fixture = vi.hoisted(() => ({
  accountId: 'account-a' as string,
  role: 'owner' as 'owner' | 'staff',
}))

const net = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method: string; body: unknown }>,
  handler: ((url: string) =>
    Promise.reject(new Error(`未設定: ${url}`))) as
      (url: string, init?: RequestInit) => Promise<unknown>,
}))

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(), usePathname: () => '/analytics',
  useSearchParams: () => new URLSearchParams({ tab: 'saved' }),
}))

vi.mock('@/components/layout/merged-tabs', () => ({
  default: () => null,
  useMergedTab: () => 'saved',
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: fixture.accountId, loading: false }),
}))

function installFetch() {
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : String(input)
    const path = raw.startsWith('http') ? raw.slice(new URL(raw).origin.length) : raw
    net.calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const body = await net.handler(path, init)
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
}

/** fetchApi がPUTで読むCSRF/session領域。実物と同じ形だけ用意する。 */
class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, String(value)) }
}

const SAVED_ITEM = {
  id: 'saved-1', name: '流入別の成果', kind: 'cross', status: 'active',
  currentVersionNumber: 2, createdBy: 'u-1', createdByName: 'テスト',
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  snapshotCount: 1,
  latestSnapshot: {
    id: 'snap-1', state: 'available', periodFrom: '2026-08-25', periodTo: '2026-09-01',
    dataCutoffAt: '2026-09-01T15:00:00.000Z', createdAt: '2026-09-01T15:00:00.000Z',
  },
}

function schedule(overrides: Record<string, unknown>) {
  return {
    id: 'report-1', lineAccountId: 'account-a', name: '週次まとめ',
    sections: ['friends'], savedAnalysisIds: ['saved-1'], cadence: 'weekly', weekday: 1,
    monthDay: null, sendTime: '09:00', timeZone: 'Asia/Tokyo', periodDays: 7,
    recipients: [{ kind: 'staff', staffId: 'u-1', label: 'テスト' }],
    channels: ['dashboard'], alertRules: [], status: 'active',
    isOneTime: false, nextRunAt: '2026-09-21T00:00:00.000Z', createdBy: 'u-1',
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

const SCHEDULE_OPTIONS = {
  timeZone: 'Asia/Tokyo',
  savedAnalyses: [{ id: 'saved-1', name: '流入別の成果', kind: 'cross' }],
  recipients: [{ id: 'u-1', name: 'テスト', role: 'owner', email: 'a@example.com', lineLinked: true }],
}

function defaultHandler(path: string, init?: RequestInit) {
  if (path === '/api/staff/me') return Promise.resolve({ success: true, data: { role: fixture.role } })
  if (path.startsWith('/api/analytics/saved/saved-1/snapshots')) return Promise.resolve({ success: true, data: [] })
  if (path.startsWith('/api/analytics/saved')) return Promise.resolve({ success: true, data: [SAVED_ITEM] })
  if (path.startsWith('/api/analytics/report-schedules/') && init?.method === 'PUT') {
    return Promise.resolve({ success: true, data: schedule({ status: 'paused' }) })
  }
  if (path.startsWith('/api/analytics/report-schedules')) {
    return Promise.resolve({ success: true, data: { items: [schedule({})], options: SCHEDULE_OPTIONS } })
  }
  return Promise.reject(new Error(`未設定: ${path}`))
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  fixture.accountId = 'account-a'
  fixture.role = 'owner'
  net.calls.length = 0
  net.handler = defaultHandler
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
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function render() {
  await act(async () => { root.render(<AnalyticsPage />) })
}

/** 定期レポートの行の「…」を開き、中の項目を返す（行の右端は「…」1つ・）。 */
async function scheduleMenuItem(label: string): Promise<HTMLElement> {
  const trigger = Array.from(host.querySelectorAll('button')).find((item) => item.getAttribute('aria-label')?.startsWith('定期レポート「'))
  if (!trigger) throw new Error('定期レポートの「…」が見つからない')
  await act(async () => { trigger.click() })
  const found = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((item) => item.textContent?.trim() === label)
  if (!found) throw new Error(`メニューの項目が見つからない: ${label}`)
  return found
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find(
    (item) => item.textContent?.trim() === label,
  )
  if (!found) throw new Error(`ボタンが見つからない: ${label}`)
  return found
}

/** 確認窓は document.body への portal なので、窓の中だけを探す。 */
function dialogButton(label: string): HTMLButtonElement {
  const dialog = document.body.querySelector('[role="alertdialog"], [role="dialog"]')
  const found = dialog && Array.from(dialog.querySelectorAll('button')).find(
    (item) => item.textContent?.trim() === label,
  )
  if (!found) throw new Error(`確認窓のボタンが見つからない: ${label}`)
  return found as HTMLButtonElement
}

describe('管理画面 保存タブの定期レポート', () => {
  it('実データの一覧(名前・間隔・次回・状態)を出し、「なし」の決め打ちを残さない', async () => {
    await render()
    expect(host.textContent).toContain('週次まとめ')
    expect(host.textContent).toContain('毎週 月 09:00')
    expect(host.textContent).toContain('動いている')
    expect(host.textContent).not.toContain('定期レポートは現在「なし」です')
    // 選んでいる保存分析へ紐づく件数も実数で出る
    expect(host.textContent).toContain('定期レポート 1件')
    // 作成への導線がある
    expect(host.querySelector('a[href="/analytics/reports/new"]')).not.toBeNull()
    const menu = host.querySelector('button[aria-label="定期レポート「週次まとめ」の操作"]') as HTMLButtonElement
    expect(menu).not.toBeNull()
    await act(async () => { menu.click() })
    expect(document.body.textContent).toContain('内容を変える')
  })

  it('止める・また送るを読み取った版つきで送る', async () => {
    await render()
    await act(async () => { (await scheduleMenuItem('止める')).click() })
    const pauseCall = net.calls.find((call) => call.path.startsWith('/api/analytics/report-schedules/report-1/status'))
    expect(pauseCall?.method).toBe('PUT')
    expect(pauseCall?.body).toMatchObject({ status: 'paused', expectedUpdatedAt: '2026-09-01T00:00:00.000Z' })

    // 停止後は「また送る」に変わる
    expect(host.textContent).toContain('止めている')
    await act(async () => { (await scheduleMenuItem('また送る')).click() })
    const resumeCall = net.calls.filter((call) => call.path.includes('/status')).at(-1)
    expect(resumeCall?.body).toMatchObject({ status: 'active' })
  })

  it('しまうは確認してから送り、一覧から消える', async () => {
    net.handler = (path, init) => {
      if (path.includes('/status') && init?.method === 'PUT') {
        return Promise.resolve({ success: true, data: schedule({ status: 'archived' }) })
      }
      return defaultHandler(path, init)
    }
    await render()
    await act(async () => { (await scheduleMenuItem('しまう')).click() })
    // 確認窓が出る。まだ送っていない
    expect(document.body.textContent).toContain('定期レポートをしまいますか')
    expect(net.calls.filter((call) => call.path.includes('/status'))).toHaveLength(0)
    await act(async () => { dialogButton('しまう').click() })
    const archiveCall = net.calls.find((call) => call.path.includes('/status'))
    expect(archiveCall?.body).toMatchObject({ status: 'archived', expectedUpdatedAt: '2026-09-01T00:00:00.000Z' })
    // しまったレポートは一覧から消える
    expect(host.textContent).not.toContain('週次まとめ')
    expect(host.textContent).toContain('定期レポートはまだありません')
  })

  it('版ずれの応答はエラーとして見せ、一覧を読み直す', async () => {
    await render()
    net.handler = (path, init) => {
      if (path.includes('/status') && init?.method === 'PUT') {
        return Promise.resolve({ success: false, error: 'この定期レポートは別の画面で先に更新されました。最新の内容を読み込み直してください' })
      }
      return defaultHandler(path, init)
    }
    await act(async () => { (await scheduleMenuItem('止める')).click() })
    expect(host.textContent).toContain('別の画面で先に更新されました')
    // 読み直しが走る
    expect(net.calls.filter((call) => call.path.startsWith('/api/analytics/report-schedules') && call.method === 'GET').length).toBeGreaterThanOrEqual(2)
  })

  it('一覧の取得失敗はバナーだけにし、0件や「まだありません」と偽らない', async () => {
    net.handler = (path, init) => {
      if (path === '/api/staff/me') return Promise.resolve({ success: true, data: { role: 'owner' } })
      if (path.startsWith('/api/analytics/report-schedules')) return Promise.reject(new Error('接続できませんでした'))
      return defaultHandler(path, init)
    }
    await render()
    expect(host.textContent).toContain('接続できませんでした')
    expect(host.textContent).not.toContain('定期レポートはまだありません')
    expect(host.textContent).not.toContain('定期レポート 0件')
  })

  it('運用担当には一覧は見せ、変更操作は押せない形で出す', async () => {
    fixture.role = 'staff'
    await render()
    expect(host.textContent).toContain('週次まとめ')
    const edit = [...host.querySelectorAll('button')].find(item => item.textContent?.trim() === '内容を変える')!
    expect(edit.getAttribute('aria-disabled') === 'true' || edit.hasAttribute('disabled')).toBe(true)
    expect(host.querySelector('a[title="条件を変えるときは、元の分析で集計し直してから保存します"]')).toBeNull()
    for (const label of ['止める', 'また送る', 'しまう', '定期レポートを作る']) {
      // 出ているなら押せない（灰色＋理由）。リンクとして行き先を持たない。
      for (const item of Array.from(host.querySelectorAll<HTMLElement>('button, a')).filter((el) => el.textContent?.trim() === label)) {
        expect(item.tagName, label).toBe('BUTTON')
        expect(item.getAttribute('aria-disabled') === 'true' || item.hasAttribute('disabled'), label).toBe(true)
      }
    }
  })
})

const SAVED_ITEM_2 = {
  ...SAVED_ITEM,
  id: 'saved-2', name: '曜日別の推移', snapshotCount: 0, latestSnapshot: null,
}

/** 2件ある状態に差し替える。 */
function twoItemsHandler(path: string, init?: RequestInit) {
  if (path === '/api/staff/me') return Promise.resolve({ success: true, data: { role: fixture.role } })
  if (path.startsWith('/api/analytics/saved/saved-1/snapshots')) return Promise.resolve({ success: true, data: [] })
  if (path.startsWith('/api/analytics/saved/saved-2/snapshots')) return Promise.resolve({ success: true, data: [] })
  if (path.startsWith('/api/analytics/saved')) return Promise.resolve({ success: true, data: [SAVED_ITEM, SAVED_ITEM_2] })
  return defaultHandler(path, init)
}

async function typeSearch(text: string) {
  const input = host.querySelector('#saved-analysis-search') as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 350))
  })
}

describe('監査 R226 保存済み分析の絞り込み', () => {
  it('0件の検索は「条件に合う〜」を出し、見えない分析の履歴を引きずらない', async () => {
    net.handler = twoItemsHandler
    await render()
    // 初期は先頭（流入別の成果）が選ばれ、履歴欄に名前が出る
    expect(host.textContent).toContain('選んだ分析の履歴：流入別の成果')

    await typeSearch('存在しない言葉')
    expect(host.textContent).toContain('条件に合う保存済み分析はありません')
    // 一覧は空だが「まだありません」（保存ゼロ）にはならない
    expect(host.textContent).not.toContain('保存した分析はまだありません')
    // 条件に合わない分析の履歴は見せ続けない
    expect(host.textContent).not.toContain('選んだ分析の履歴：流入別の成果')
    expect(host.textContent).toContain('一覧から分析を選んでください')

    // 「キャンセル」で元の一覧へ戻り、先頭が選び直されて履歴も戻る
    await act(async () => { (host.querySelector('button[aria-label="検索語を消す"]') as HTMLButtonElement).click() })
    expect(host.textContent).toContain('選んだ分析の履歴：流入別の成果')
    expect(host.textContent).toContain('曜日別の推移')
  })

  it('絞り込みで選んだ項目が見えなくなったら、見えている先頭へ選び直す', async () => {
    net.handler = twoItemsHandler
    await render()
    expect(host.textContent).toContain('選んだ分析の履歴：流入別の成果')

    await typeSearch('曜日')
    // 一覧から「流入別の成果」の行が消え、「曜日別の推移」だけ残る
    expect(host.textContent).toContain('曜日別の推移')
    expect(host.textContent).toContain('選んだ分析の履歴：曜日別の推移')
    expect(net.calls.some((call) => call.path.startsWith('/api/analytics/saved/saved-2/snapshots'))).toBe(true)
  })
})
