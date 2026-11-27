// @vitest-environment happy-dom
/*
 * Issue #1006 / 監査台帳 DASH-01〜06・09・15・A01-01/02 の回帰試験。
 *
 * 実React＋実apiクライアントで、通信だけを差し替えて確かめる。
 * 押さえる契約:
 *  - アカウント切替・応答逆転・取得失敗で、前のアカウントの数値・
 *    予約・配置・経路が混ざらない（DASH-02/03/04/09）
 *  - 配置の遅延GETが編集中のdraftを上書きしない（DASH-15）
 *  - 保存失敗は編集パネル内で再試行できる（DASH-05）
 *  - 「初期状態に戻す」は確認なしに実行されない（A01-02）
 */
import { act } from 'react'
import { screen, waitFor, within } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// apiクライアントは起動時にAPI URLを要求する。実通信はfetch差替で止める。
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

// 共通ダッシュボード本体の境界/既存カードを検査する。業種の入口分岐はhome.test.tsxが検査する。
import DashboardPage from '@/v8/dashboard/dashboard'

const fixture = vi.hoisted(() => ({
  accountId: 'account-a' as string | null,
  search: '',
}))

type Json = { status: number; body: unknown }
const ok = (body: unknown): Json => ({ status: 200, body })
const fail = (status = 404): Json => ({ status, body: { success: false, error: 'not available' } })

const net = vi.hoisted(() => ({
  calls: [] as string[],
  overview: (() => Promise.resolve(fail())) as (query: string) => Promise<Json>,
  preferences: (() => Promise.resolve(ok({ success: true, data: { version: 0, cards: null } }))) as () => Promise<Json>,
  bookings: (() => Promise.resolve(ok({ requests: [], total: 0 }))) as () => Promise<Json>,
  routes: (() => Promise.resolve(ok({ success: true, data: [] }))) as () => Promise<Json>,
  putSaves: [] as Array<{ body: { version: number; cards: unknown }; resolve: (res: Response) => void }>,
  deletes: 0,
}))

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children?: unknown }) =>
    <a href={href}>{children as never}</a>,
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(fixture.search),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: fixture.accountId,
    selectedAccount: fixture.accountId
      ? { id: fixture.accountId, channelId: `ch-${fixture.accountId}`, displayName: `${fixture.accountId}店`, basicId: 'nen' }
      : null,
    loading: false,
  }),
}))
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,x') } }))
/*
 * 共通の Select は listbox の部品で、その操作は部品自身の試験が持つ。
 * ここで見たいのは選んだ後のリンクの判断なので、素の <select> に置き換える。
 */
vi.mock('@/components/shared/select', () => ({
  default: ({ 'aria-label': label, value, onChange, options }: {
    'aria-label'?: string
    value: string
    onChange: (value: string) => void
    options: Array<{ value: string; label: string }>
  }) => (
    <select
      aria-label={label}
      value={value}
      onChange={(e: { target: { value: string } }) => onChange(e.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}))

const jsonResponse = ({ status, body }: Json) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function installFetch() {
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : String(input)
    const path = raw.startsWith('http') ? raw.slice(new URL(raw).origin.length) : raw
    net.calls.push(`${init?.method ?? 'GET'} ${path}`)
    if (path.startsWith('/api/staff/me')) return jsonResponse({ status: 200, body: { success: true, data: { id: 'test-owner', role: 'owner' } } })
    if (path.startsWith('/api/dashboard/overview')) {
      return jsonResponse(await net.overview(path))
    }
    if (path.startsWith('/api/dashboard/preferences')) {
      if (init?.method === 'PUT') {
        return new Promise<Response>((resolve) =>
          net.putSaves.push({ body: JSON.parse(String(init.body)), resolve }))
      }
      if (init?.method === 'DELETE') {
        net.deletes += 1
        return jsonResponse(ok({ success: true, data: null }))
      }
      return jsonResponse(await net.preferences())
    }
    if (path.startsWith('/api/booking/admin/requests')) return jsonResponse(await net.bookings())
    if (path.startsWith('/api/entry-routes')) return jsonResponse(await net.routes())
    if (path.startsWith('/api/nen-members/photos/review-metrics')) {
      return jsonResponse(ok({
        success: true,
        data: { pendingCount: 0, reviewedCount: 0, averageReviewMinutes: null, oldestPendingAt: null, attentionCount: 0 },
      }))
    }
    if (path.includes('/health')) return jsonResponse(ok({ success: true, data: { riskLevel: 'normal', logs: [] } }))
    if (path === '/api/staff') return jsonResponse(ok({ success: true, data: [] }))
    if (path.startsWith('/api/support-marks')) return jsonResponse(ok({ success: true, data: [] }))
    if (path.startsWith('/api/notifications/center')) {
      return jsonResponse(ok({
        success: true,
        data: { items: [], counts: { all: 0, error: 0, update: 0, unread: 0 }, unreadCount: 0 },
      }))
    }
    if (path.startsWith('/api/support/inbox')) {
      return jsonResponse(ok({
        success: true,
        data: { items: [], summary: { total: 0, line: 0, email: 0, oldestWaitMinutes: null } },
      }))
    }
    if (path.startsWith('/api/ec-commerce/shipments')) {
      return jsonResponse(ok({
        success: true,
        data: { today: '2026-09-20', tomorrow: '2026-09-21', soon: [], later: [], soonCount: 0, laterCount: 0, scanned: 0, scanLimit: 50 },
      }))
    }
    return jsonResponse(fail())
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

const overviewFor = (activeFriends: number) => ok({
  success: true,
  data: {
    period: 'today',
    generatedAt: '2026-09-20T00:00:00.000Z',
    asOf: '2026-09-20T00:00:00.000Z',
    freshness: 'fresh',
    friends: { active: activeFriends, total: activeFriends, blockedByThem: 0, hiddenByUs: 0, blockedBoth: 0 },
    inbox: { unanswered: 0, inProgress: 0, resolved: 0, oldestUnansweredMinutes: null, averageFirstReplyMinutes: null },
    delivery: { sent: 0, push: 0, reply: 0, broadcasts: 0, quotaLimit: null, quotaUsed: null },
    trend: [],
    conversions: { total: 0, byPoint: [] },
    partialFailures: [],
    sections: {},
    metrics: {
      activeFriends: { value: activeFriends, state: 'available', reason: null, asOf: '2026-09-20T00:00:00.000Z', period: 'latest' },
      monthlyQuota: { value: null, state: 'unavailable', reason: 'not_connected', asOf: null, period: 'this-month' },
      friendTrend: { value: [], state: 'available', reason: null, asOf: null, period: 'today' },
      officialProfileUrl: { value: null, state: 'unavailable', reason: 'not_connected', asOf: null, period: 'latest' },
    },
  },
})

const bookingToday = (id: string) => {
  const startsAt = new Date()
  return {
    id,
    friend_id: `friend-${id}`,
    booking_customer_id: null,
    starts_at: startsAt.toISOString(),
    ends_at: startsAt.toISOString(),
    status: 'confirmed',
    customer_note: null,
    internal_note: null,
    price_at_booking: 0,
    menu_name: '相談',
    staff_name: '担当者',
    friend_name: 'テスト',
    requested_at: startsAt.toISOString(),
    decided_at: null,
    external_event_id: null,
  }
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  fixture.accountId = 'account-a'
  fixture.search = ''
  net.calls.length = 0
  net.putSaves.length = 0
  net.deletes = 0
  net.overview = () => Promise.resolve(overviewFor(0))
  net.preferences = () => Promise.resolve(ok({ success: true, data: { version: 0, cards: null } }))
  net.bookings = () => Promise.resolve(ok({ requests: [], total: 0 }))
  net.routes = () => Promise.resolve(ok({ success: true, data: [] }))
  vi.stubGlobal('localStorage', new MemoryStorage())
  vi.stubGlobal('sessionStorage', new MemoryStorage())
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  installFetch()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  vi.useRealTimers()
  await act(async () => {
    for (const save of net.putSaves) save.resolve(jsonResponse(fail(400)))
    await Promise.resolve()
  })
  await act(async () => { root.unmount() })
  host.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function render() {
  await act(async () => { root.render(<DashboardPage />) })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

async function switchAccount(next: string) {
  fixture.accountId = next
  await render()
}

function button(text: string, scope: ParentNode = document.body): HTMLButtonElement {
  const node = Array.from(scope.querySelectorAll('button')).find((item) => item.textContent?.trim() === text)
  if (!node) throw new Error(`Button not found: ${text}`)
  return node
}

function dialog(): HTMLElement {
  const node = document.body.querySelector<HTMLElement>('[role="dialog"]')
  if (!node) throw new Error('編集パネルが見つかりません')
  return node
}

function todayCard(title: string): HTMLElement {
  const heading = Array.from(host.querySelectorAll('[data-kpi-presentation] p[title]')).find((node) => node.textContent?.trim() === title)
  if (!heading) throw new Error(`${title} のカードが見つかりません`)
  const card = heading.closest('[data-kpi-presentation]')
  if (!card) throw new Error(`${title} のカード外枠が見つかりません`)
  return card as HTMLElement
}

async function openEditor() {
  await act(async () => { button('表示を変更する').click() })
  await screen.findByRole('dialog', { name: 'ダッシュボード編集' })
}

describe('DASH-02 アカウント切替後の取得失敗で前の数値が残らない', () => {
  it('Aの111人を表示中にBの取得が失敗しても、Bの画面に111人を出さない', async () => {
    net.overview = (query) => Promise.resolve(
      query.includes('account_id=account-a') ? overviewFor(111) : fail(500),
    )
    await render()
    expect(document.body.textContent).toContain('111')

    await switchAccount('account-b')
    expect(net.calls.some((call) => call.includes('/api/dashboard/overview') && call.includes('account_id=account-b'))).toBe(true)
    expect(document.body.textContent).not.toContain('111')
  })

  it('遅れて届いたAの応答でBの画面を上書きしない', async () => {
    let resolveA: ((value: Json) => void) | null = null
    net.overview = (query) => query.includes('account_id=account-a')
      ? new Promise<Json>((resolve) => { resolveA = resolve })
      : Promise.resolve(overviewFor(7))
    await render()
    await switchAccount('account-b')
    expect(document.body.textContent).toContain('7')
    // 切替後にAの応答が届いても破棄される
    await act(async () => { resolveA?.(overviewFor(222)) })
    expect(document.body.textContent).toContain('7')
    expect(document.body.textContent).not.toContain('222')
  })
})

describe('DASH-03 新アカウントの読込中に前の予約・運用状態が残らない', () => {
  it('Bの予約取得を保留にしても、Aの「今日の予約 1件」を表示しない', async () => {
    net.overview = () => Promise.resolve(overviewFor(0))
    net.bookings = () => Promise.resolve(ok({ requests: [bookingToday('b1')], total: 1 }))
    await render()
    expect(todayCard('今日の予約').textContent).toContain('1')

    net.bookings = () => new Promise<Json>(() => {})
    // 待ちは偽の時計で進める（本物の時間を待たない）。骨組みの 0.3 秒は読み始めから数えるので、切り替える前に替える。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    await switchAccount('account-b')
    const card = todayCard('今日の予約')
    /*
     * #673 で読込中の件数は「—」ではなく骨組み（スケルトン）に替わった。
     * ★管理画面 仕上げ §3 で骨組みは 0.3 秒待ってから出るので、待ってから確かめる。
     */
    await act(async () => { await vi.advanceTimersByTimeAsync(350) })
    expect(card.getAttribute('aria-busy')).toBe('true')
    expect(card.querySelector('[data-kpi-number]')).toBeNull()
    expect(card.textContent).not.toContain('1件')
  })
})

describe('DASH-09 追加リンクは選択中アカウントの経路だけを使う', () => {
  const route = (id: string, refCode: string, name: string) => ({
    id, refCode, genre: null, name, tagId: null, scenarioId: null, redirectUrl: null,
    poolId: null, introTemplateId: null, runAccountFriendAddScenarios: false,
    isActive: true, createdAt: '2026-09-01', updatedAt: '2026-09-01',
  })

  it('経路一覧をaccount_id付きで取り、切替後に前アカウントの経路を残さない', async () => {
    net.routes = () => Promise.resolve(ok({
      success: true,
      data: fixture.accountId === 'account-a' ? [route('route-a1', 'refa1', 'Aのチラシ')] : [],
    }))
    await render()
    expect(net.calls.some((call) => call.startsWith('GET /api/entry-routes?account_id=account-a'))).toBe(true)

    const select = host.querySelector<HTMLSelectElement>('select[aria-label="発行中の追加URL"]')
    expect(select).not.toBeNull()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      setter?.call(select!, 'route-a1')
      select!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const linkInput = host.querySelector<HTMLInputElement>('input[aria-label="友だち追加リンク"]')
    expect(linkInput?.value).toContain('/r/refa1')

    await switchAccount('account-b')
    expect(net.calls.some((call) => call.startsWith('GET /api/entry-routes?account_id=account-b'))).toBe(true)
    expect(host.querySelector<HTMLInputElement>('input[aria-label="友だち追加リンク"]')?.value).not.toContain('refa1')
  })

  it('URLが指す経路が今のアカウントに無ければ、QR・コピー・ダウンロードを止める', async () => {
    fixture.search = '?qr=route-a1'
    net.routes = () => Promise.resolve(ok({ success: true, data: [] }))
    await render()
    const qrDialog = host.querySelector<HTMLElement>('[aria-label="友だち追加のQRコード"]')
    expect(qrDialog).not.toBeNull()
    expect(qrDialog!.textContent).toContain('このアカウントでは使えません')
    expect(qrDialog!.querySelector('img[alt="友だち追加QRコード"]')).toBeNull()
    const download = Array.from(qrDialog!.querySelectorAll('a,button')).find((node) => node.textContent?.includes('画像をダウンロード'))
    expect(download?.tagName).toBe('BUTTON')
    expect((download as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('DASH-15 配置の遅延GETが編集中の変更を上書きしない', () => {
  it('パネルを開いてカードをOFFにしたあとGETが返っても、OFFのまま保持する', async () => {
    let resolvePreferences: ((value: Json) => void) | null = null
    net.preferences = () => new Promise<Json>((resolve) => { resolvePreferences = resolve })
    await render()
    await openEditor()

    const toggle = await within(dialog()).findByRole('switch', { name: '写真審査を表示' })
    expect(toggle ? String((toggle.getAttribute('aria-checked') === 'true')) : undefined).toBe('true')
    await act(async () => { toggle!.click() })
    expect(String((toggle!.getAttribute('aria-checked') === 'true'))).toBe('false')

    // 遅れて届いたGET（既定配置＝写真審査ON）でdraftを初期化しない
    await act(async () => {
      resolvePreferences?.(ok({ success: true, data: { version: 5, cards: null } }))
    })
    expect(String((toggle!.getAttribute('aria-checked') === 'true'))).toBe('false')
  })
})

describe('DASH-04 保存完了が別アカウントの配置・版を上書きしない', () => {
  it('Aの保存応答がBへ切替後に届いても、Bの版番号を保持する', async () => {
    net.preferences = () => Promise.resolve(ok({
      success: true,
      data: { version: fixture.accountId === 'account-a' ? 7 : 3, cards: null },
    }))
    await render()
    await openEditor()
    await act(async () => { button('ダッシュボードに反映').click() })
    expect(net.putSaves).toHaveLength(1)
    expect(net.putSaves[0].body.version).toBe(7)

    await switchAccount('account-b')
    // 切替でパネルは閉じ、前アカウントの下書きは持ち越さない
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    // Aの保存が完了してもBの表示配置・版は変えない
    await act(async () => {
      net.putSaves[0].resolve(jsonResponse(ok({ success: true, data: { version: 8 } })))
    })

    await openEditor()
    await act(async () => { button('ダッシュボードに反映').click() })
    expect(net.putSaves).toHaveLength(2)
    expect(net.putSaves[1].body.version).toBe(3)
  })
})

describe('DASH-05 保存失敗は編集パネルの内側で再試行する', () => {
  it('失敗文がパネル内に出て、再試行は配置のPUTだけを実行する', async () => {
    await render()
    await openEditor()
    await act(async () => { button('ダッシュボードに反映').click() })
    await act(async () => {
      net.putSaves[0].resolve(jsonResponse(fail(503)))
    })
    const panel = dialog()
    expect(panel.querySelector('[role="alert"]')?.textContent).toContain('配置を保存できませんでした')

    const overviewCallsBefore = net.calls.filter((call) => call.startsWith('GET /api/dashboard/overview')).length
    await act(async () => { button('もう一度保存する', panel).click() })
    expect(net.putSaves).toHaveLength(2)
    expect(net.calls.filter((call) => call.startsWith('GET /api/dashboard/overview'))).toHaveLength(overviewCallsBefore)
    await act(async () => {
      net.putSaves[1].resolve(jsonResponse(ok({ success: true, data: { version: 1 } })))
    })
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })
})

describe('A01-02 初期状態に戻すは確認なしに実行しない', () => {
  it('1回目のクリックは確認だけを出し、やめると何も削除しない', async () => {
    await render()
    await openEditor()
    await act(async () => { button('初期状態に戻す').click() })
    expect(net.deletes).toBe(0)
    expect(document.body.textContent).toContain('削除して初期状態へ戻します')
    await act(async () => { button('キャンセル').click() })
    expect(net.deletes).toBe(0)
    expect(document.body.textContent).not.toContain('削除して初期状態へ戻します')
  })

  it('確認するとDELETEを1回だけ実行する', async () => {
    await render()
    await openEditor()
    await act(async () => { button('初期状態に戻す').click() })
    await act(async () => { button('削除する').click() })
    expect(net.deletes).toBe(1)
  })
})

// 選ぶ物の欄も、保存/API境界の試験では以前のSelectと同じ差し替えにする。
vi.mock('@/components/shared/entity-select', () => import('@/test-utils/entity-select-mock'))
