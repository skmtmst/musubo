// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/* アカウント切替・部分失敗・検索・取得口を、本物の描画と通信で守る。 */

const fixture = vi.hoisted(() => ({ accountId: 'account-a' as string | null }))

vi.mock('next/link', () => ({ default: (props: { children?: React.ReactNode }) => props.children ?? null }))
vi.mock('@/components/layout/merged-tabs', () => ({ default: () => null, useMergedTab: () => 'events' }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fixture.accountId }) }))
vi.mock('./ec-tabs-view', () => ({ default: () => null }))
vi.mock('./connector-panel', () => ({ default: () => null }))
vi.mock('./subscriptions-panel', () => ({ default: () => null }))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    fetchApi: vi.fn(),
    api: {
      ...actual.api,
      ecCommerce: {
        ...actual.api.ecCommerce,
        overview: vi.fn(),
        retryActionExecution: vi.fn(),
      },
    },
  }
})

import { ApiError, api, fetchApi } from '@/lib/api'
import EcCommercePage from './page'
import { flushListUrlState } from '@/components/shared/list-url-state'

const mockFetchApi = fetchApi as unknown as ReturnType<typeof vi.fn>
const mockOverview = api.ecCommerce.overview as unknown as ReturnType<typeof vi.fn>
const mockRetry = api.ecCommerce.retryActionExecution as unknown as ReturnType<typeof vi.fn>

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

function ok<T>(data: T) {
  return { success: true, data }
}

function overview(count: number) {
  return {
    total: count,
    processed: count,
    identityPending: 0,
    failed: 0,
    skipped: 0,
    last24h: count,
    lastReceivedAt: '2026-09-09T00:00:00.000Z',
    averageDeliverySeconds: 30,
    latencySampleCount: count,
    byType: [{ eventType: 'ec.order.confirmed', label: '注文完了', count }],
  }
}

function action(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `action-${id}`,
    eventId: `event-${id}`,
    eventType: 'ec.order.confirmed',
    eventLabel: '注文完了',
    actionType: 'line_notification',
    ruleVersion: 'v1',
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
    errorCode: null,
    errorMessage: null,
    lastAttemptedAt: null,
    nextRetryAt: null,
    version: 1,
    receivedAt: '2026-09-09T00:00:00.000Z',
    orderNumber: `NEN-${id}`,
    customerName: '見本 171',
    friendId: 'friend-a',
    retryAvailable: false,
    order: {
      id: `order-${id}`,
      lineAccountId: 'account-a',
      externalOrderId: `NEN-${id}`,
      orderNumber: `NEN-${id}`,
      customerId: `customer-${id}`,
      friendId: 'friend-a',
      customerName: '見本 171',
      status: 'current',
      providerStatus: 'paid',
      currency: 'JPY',
      totalAmount: 100,
      refundedAmount: null,
      orderedAt: '2026-09-09T00:00:00.000Z',
      detailUrl: null,
      version: 1,
      orderLines: [{
        id: `line-${id}`,
        productId: `product-${id}`,
        productName: `商品${id}`,
        quantity: 1,
        unitAmount: 100,
        lineAmount: 100,
        productUrl: null,
      }],
    },
    ...overrides,
  }
}

function recordsList(
  items: ReturnType<typeof action>[],
  total = items.length,
  summary = { pending: 0, processing: 0, succeeded: items.length, skipped: 0, retryable_failed: 0, permanent_failed: 0 },
) {
  return { items, total, summary }
}

let container: HTMLDivElement | null = null
let root: Root | null = null
let eventsCalls: string[] = []
let eventsDeferreds: Deferred<unknown>[] = []
let overviewCalls: string[] = []
let overviewDeferreds: Map<string, Deferred<unknown>[]> = new Map()

beforeEach(() => {
  flushListUrlState(); window.history.replaceState({}, '', '/ec-commerce'); window.dispatchEvent(new Event('popstate')); document.documentElement.dataset.theme='v8'
  vi.useFakeTimers()
  fixture.accountId = 'account-a'
  eventsCalls = []
  eventsDeferreds = []
  overviewCalls = []
  overviewDeferreds = new Map()

  mockFetchApi.mockImplementation((path: string) => {
    if (new URL(path, 'http://localhost').pathname === '/api/dashboard/style') return Promise.resolve(ok({ style: 'ec', styleSelected: true, version: 1 }))
    eventsCalls.push(path)
    const d = deferred<unknown>()
    eventsDeferreds.push(d)
    return d.promise
  })
  mockOverview.mockImplementation((accountId: string) => {
    overviewCalls.push(accountId)
    const d = deferred<unknown>()
    const bucket = overviewDeferreds.get(accountId) ?? []
    bucket.push(d)
    overviewDeferreds.set(accountId, bucket)
    return d.promise
  })
  mockRetry.mockReset()
})

afterEach(async () => {
  if (root) await act(async () => { root!.unmount() })
  if (container) container.remove()
  root = null
  container = null
  flushListUrlState(); vi.useRealTimers(); delete document.documentElement.dataset.theme
  vi.clearAllMocks()
})

function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  return { container, root }
}

/** マイクロタスクだけを流す。setTimeout(debounce)はfakeのまま進めない。 */
async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

function overviewFor(accountId: string, index = 1): Deferred<unknown> {
  const bucket = overviewDeferreds.get(accountId)
  const item = bucket?.[index]
  if (!item) throw new Error(`${accountId} 向けの overview 呼び出しが見つかりません`)
  return item
}

async function render(el: HTMLDivElement, r: Root) {
  await act(async () => { r.render(<EcCommercePage />) })
  void el
}

/**
 * `root.render` をactで包まずに生で呼ぶと、Reactはcommit(DOM反映)と
 * passive effect(useEffectで走るload)のflushを別タスクとして積む。
 * MutationObserverはDOM変異の直後にマイクロタスクとして呼ばれるので、
 * commit直後・useEffect未実行の瞬間をこの1点で捕まえられる。
 */
function waitForCommit(el: HTMLDivElement): Promise<void> {
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      observer.disconnect()
      resolve()
    })
    observer.observe(el, { attributes: true, subtree: true, childList: true, characterData: true })
  })
}

async function retryButton(el: HTMLDivElement): Promise<HTMLButtonElement> {
  const trigger = Array.from(el.querySelectorAll('button')).find((node) => node.getAttribute('aria-label') === 'この行のその他操作')
  if (!trigger) throw new Error('「その他」メニューが見つかりません')
  trigger.click()
  await drainMicrotasks()
  // メニューは最上層（MenuPortal→document.body）に出る。器の中にはいない。
  const button = Array.from(document.querySelectorAll('button[role="menuitem"]')).find((node) => node.textContent === 'もう一度やる')
  if (!button) throw new Error('「もう一度やる」ボタンが見つかりません')
  return button as HTMLButtonElement
}

function searchInput(el: HTMLDivElement): HTMLInputElement {
  const input = el.querySelector('input[type="search"]')
  if (!input) throw new Error('検索欄が見つかりません')
  return input as HTMLInputElement
}

function nextPageButton(el: HTMLDivElement): HTMLButtonElement {
  const button = Array.from(el.querySelectorAll('button')).find((node) => node.getAttribute('aria-label') === '次のページ')
  if (!button) throw new Error('「次のページ」ボタンが見つかりません')
  return button as HTMLButtonElement
}

describe('EC注文の実際の金額表示', () => {
  it.each([
    { status: 'current', totalAmount: 1234.9, refundedAmount: null, expected: '商品amount × 1・¥1,234' },
    { status: 'refunded', totalAmount: 1234.9, refundedAmount: 50.9, expected: '商品amount × 1・−¥50' },
    { status: 'current', totalAmount: null, refundedAmount: null, expected: '商品amount × 1' },
  ])('注文$status/$totalAmount/$refundedAmountを$expectedと表示する', async ({ expected, ...amounts }) => {
    const { container: el, root: r } = mount()
    await render(el, r)
    await act(async () => { await drainMicrotasks() })
    const row = action('amount')
    await act(async () => {
      overviewFor('account-a').resolve(ok(overview(1)))
      eventsDeferreds[0].resolve(ok(recordsList([action('amount', { order: { ...row.order, ...amounts } })])))
      await drainMicrotasks()
    })
    const renderedRow = el.querySelector('[data-row-id="action-amount"]')
    expect(renderedRow).toBeTruthy()
    expect(renderedRow!.querySelector('span[title^="商品amount"]')?.textContent).toBe(expected)
  })
})

describe('EC取込一覧(#685) 逆変異で赤になる実mount試験', () => {
  it('M3: アカウント切替の直後(commit直後・useEffect未実行)は前アカウントの一覧を表示し続けない', async () => {
    const { container: el, root: r } = mount()
    await render(el, r)
    await act(async () => { await drainMicrotasks() })

    await act(async () => {
      overviewFor('account-a').resolve(ok(overview(111)))
      eventsDeferreds[0].resolve(ok(recordsList([action('1')])))
      await drainMicrotasks()
    })
    expect(el.textContent).toContain('商品1')

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const committed = waitForCommit(el)
    fixture.accountId = 'account-b'
    r.render(<EcCommercePage />)
    await committed
    errorSpy.mockRestore()

    // Bのcommitは終わっているが、useEffect(load)はまだ動いていない。
    // 境界fenceが効いていれば、この時点でAの商品はもう見えない。
    expect(el.textContent).not.toContain('商品1')
  })

  it('M4: Aの再試行応答待ち中にBへ切り替えても、Bの一覧読込は古いクロージャに邪魔されない', async () => {
    const { container: el, root: r } = mount()
    await render(el, r)
    await act(async () => { await drainMicrotasks() })

    await act(async () => {
      overviewFor('account-a').resolve(ok(overview(111)))
      eventsDeferreds[0].resolve(ok(recordsList([action('1', { status: 'retryable_failed', retryAvailable: true })])))
      await drainMicrotasks()
    })

    const retryDeferred = deferred<unknown>()
    mockRetry.mockReturnValueOnce(retryDeferred.promise)
    await act(async () => { (await retryButton(el)).click() })
    expect(mockRetry).toHaveBeenCalledTimes(1)
    expect(eventsCalls).toHaveLength(1)

    // Bへ切替。B自身のuseEffect(load)がここでeventsCalls[1]を発行する。
    fixture.accountId = 'account-b'
    await act(async () => {
      r.render(<EcCommercePage />)
      await drainMicrotasks()
    })
    expect(eventsCalls).toHaveLength(2)

    // Aの遅い再試行応答が、ちょうどこの窓で届く。
    await act(async () => {
      retryDeferred.resolve(ok({ ...action('1'), status: 'pending' }))
      await drainMicrotasks()
    })

    // Bの一覧応答(2番目の呼び出し)を解決する。
    await act(async () => {
      overviewFor('account-b').resolve(ok(overview(7)))
      eventsDeferreds[1].resolve(ok(recordsList([action('77')])))
      await drainMicrotasks()
    })

    // 古いクロージャ弾きが効いていれば、Bの一覧はここで正しく表示される。
    // M4が入ると、Aの再試行応答が共有listLoadSeqを進めてしまい、
    // Bの正常応答はseq不一致で捨てられ、一覧は読み込み中のまま固まる。
    expect(el.textContent).toContain('商品77')
    expect(el.querySelector('[data-list-state]')?.getAttribute('data-list-state')).not.toBe('loading')
  })

  it('M5: 一覧の読込失敗は、確認済みの集計(overview)まで消さない', async () => {
    const { container: el, root: r } = mount()
    await render(el, r)
    await act(async () => { await drainMicrotasks() })

    await act(async () => {
      overviewFor('account-a').resolve(ok(overview(111)))
      eventsDeferreds[0].reject(new Error('boom'))
      await drainMicrotasks()
    })

    // 一覧は読み込めなかった帯が出るが、集計の111件は残っているべき。
    expect(el.textContent).toContain('取り込みの記録を読み込めませんでした')
    expect(el.textContent).toContain('111')
  })

  it('M6: 検索語をページ内フィルタではなくサーバへのURLへ反映する(query)', async () => {
    const { container: el, root: r } = mount()
    await render(el, r)
    await act(async () => { await drainMicrotasks() })
    await act(async () => {
      overviewFor('account-a').resolve(ok(overview(1)))
      eventsDeferreds[0].resolve(ok(recordsList([action('1')])))
      await drainMicrotasks()
    })

    const input = searchInput(el)
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      nativeSetter.call(input, '商品21')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    await act(async () => { await drainMicrotasks() })

    const last = eventsCalls[eventsCalls.length - 1]
    expect(last).toContain('query=')
  })

  it('M7: 一覧取得は新API(view=actions)を使う', async () => {
    const { container: el, root: r } = mount()
    await render(el, r)
    await act(async () => { await drainMicrotasks() })

    expect(eventsCalls[0]).toContain('view=actions')
  })

  /*
   * 司令塔切り分け(2026-09-10、作業のartifactで実証): 検索欄debounceの
   * useEffect([query, setPage])は、マウント直後のqueryの初期値('')でも
   * 必ず1回実行され、300ms後に無条件でsetPage(1)を呼んでいた。一覧が
   * 表示された直後(300ms以内)に「次のページ」を押した利用者が、その後
   * このタイマーの発火で黙って1ページ目へ戻される不具合だった。
   */
  it('M8: 一覧表示直後に次のページを押しても、検索debounceの初回発火で1ページ目へ戻らない', async () => {
    const { container: el, root: r } = mount()
    await render(el, r)
    await act(async () => { await drainMicrotasks() })

    // 1ページ目を表示する。マウント時の検索debounceタイマーはまだ発火していない(fake timer)。
    await act(async () => {
      overviewFor('account-a').resolve(ok(overview(21)))
      eventsDeferreds[0].resolve(ok(recordsList([action('1')], 21)))
      await drainMicrotasks()
    })
    expect(el.textContent).toContain('商品1')

    // マウント直後、ユーザーが「次のページ」を押す。
    await act(async () => { nextPageButton(el).click() })
    expect(eventsCalls).toHaveLength(2)

    await act(async () => {
      eventsDeferreds[1].resolve(ok(recordsList([action('2')], 21)))
      await drainMicrotasks()
    })
    expect(el.textContent).toContain('商品2')
    expect(el.textContent).not.toContain('商品1 ×')

    // マウント時にスケジュールされた検索debounceの300msタイマーが、ここでようやく発火する。
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    await act(async () => { await drainMicrotasks() })

    // 初回発火をスキップしていれば、ここでeventsCallsは増えない(1ページ目への巻き戻しが起きない)。
    expect(eventsCalls).toHaveLength(2)
    expect(el.textContent).toContain('商品2')
    expect(el.textContent).not.toContain('商品1 ×')
  })
})

/*
 * #635: 存在しない言葉で検索して0件になったとき、件数が減るだけでなく
 * 「条件に合うものはありません」と次にやること（解除）を出す。
 * 監査5b_23: 不存在語を入れても明示の空メッセージが特定できなかった。
 */
describe('EC取込一覧の絞り込み0件 (#635)', () => {
  it('存在しない言葉で検索すると、0件の言い方と解除導線を出す', async () => {
    const { container: el, root: r } = mount()
    await render(el, r)
    await act(async () => { await drainMicrotasks() })
    await act(async () => {
      overviewFor('account-a').resolve(ok(overview(1)))
      eventsDeferreds[0].resolve(ok(recordsList([action('1')])))
      await drainMicrotasks()
    })
    expect(el.textContent).toContain('商品1')

    const input = searchInput(el)
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      nativeSetter.call(input, '存在しない言葉xyz')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    await act(async () => { await drainMicrotasks() })
    expect(eventsCalls).toHaveLength(2)
    expect(eventsCalls[1]).toContain('query=')

    await act(async () => {
      eventsDeferreds[1].resolve(ok(recordsList([], 0)))
      await drainMicrotasks()
    })

    // 「0件」と分かる表示＋次の行動提案（別の言葉・絞り込み解除）。
    expect(el.textContent).toContain('条件に合うものはありません')
    expect(el.textContent).toContain('絞り込みや検索を外すと、すべて出ます')
    const clear = Array.from(el.querySelectorAll('button')).find((node) => node.textContent === '条件を外す')
    expect(clear).toBeTruthy()

    // 解除すると検索語を外して取り直す。
    await act(async () => { clear!.click() })
    await act(async () => { await drainMicrotasks() })
    expect(eventsCalls.at(-1)).not.toContain('query=')
    expect(searchInput(el).value).toBe('')
  })
})

/*
 * R599: `/api/ec-commerce/events` だけが 503・403・404 で落ち、
 * 集計が 200 のとき、状態タブが「処理中0」「失敗0」と未取得を 0件に
 * 見せていた。一覧由来の状態別件数は取れるまで出さず、失敗理由と
 * やり直しを出し、再試行の成功で実数へ戻る、を実mountで見張る。
 * 「すべて」の数は集計由来なので、取れている間は残る。
 * 空の一覧（取れたうえでの 0件）は実数の 0 を出す。失敗と区別する。
 */
describe('R599 一覧未取得の状態別件数', () => {
  function statusTabText(el: HTMLDivElement, label: string): string | null {
    const tab = Array.from(el.querySelectorAll('button[aria-pressed]'))
      .find((node) => (node.textContent ?? '').startsWith(label))
    return tab ? tab.textContent?.replaceAll(' ', '') ?? null : null
  }

  function retryListButton(el: HTMLDivElement): HTMLButtonElement {
    const button = Array.from(el.querySelectorAll('button'))
      .find((node) => node.textContent === 'もう一度読み込む')
    if (!button) throw new Error('「もう一度読み込む」ボタンが見つかりません')
    return button as HTMLButtonElement
  }

  async function failEventsOnly(el: HTMLDivElement, r: Root, status: number) {
    await render(el, r)
    await act(async () => { await drainMicrotasks() })
    await act(async () => {
      overviewFor('account-a').resolve(ok(overview(111)))
      eventsDeferreds[0].reject(new ApiError(status, `EC events ${status}`))
      await drainMicrotasks()
    })
  }

  it('一覧503＋集計200では「処理中」「失敗」に0を出さず、理由とやり直しを出す', async () => {
    const { container: el, root: r } = mount()
    await failEventsOnly(el, r, 503)

    expect(el.textContent).toContain('取り込みの記録を読み込めませんでした')
    expect(retryListButton(el)).toBeTruthy()
    // 一覧由来の状態別件数は未取得（数を出さない）。
    expect(statusTabText(el, '処理中')).toBe('処理中')
    expect(statusTabText(el, '失敗')).toBe('失敗')
    expect(statusTabText(el, '処理完了')).toBe('処理完了')
    expect(statusTabText(el, '送信なし')).toBe('送信なし')
    // 集計由来の「すべて」は取れているので残る。
    expect(statusTabText(el, 'すべて')).toBe('すべて111')
  })

  it('一覧403では権限不足を出し、状態別件数に0を出さない', async () => {
    const { container: el, root: r } = mount()
    await failEventsOnly(el, r, 403)

    expect(el.textContent).toContain('表示する権限がありません')
    expect(statusTabText(el, '処理中')).toBe('処理中')
    expect(statusTabText(el, '失敗')).toBe('失敗')
    expect(statusTabText(el, 'すべて')).toBe('すべて111')
  })

  it('一覧404では読み込み失敗を出し、状態別件数に0を出さない', async () => {
    const { container: el, root: r } = mount()
    await failEventsOnly(el, r, 404)

    expect(el.textContent).toContain('取り込みの記録を読み込めませんでした')
    expect(statusTabText(el, '処理中')).toBe('処理中')
    expect(statusTabText(el, '失敗')).toBe('失敗')
  })

  it('やり直しの成功で状態別件数が実数に戻る', async () => {
    const { container: el, root: r } = mount()
    await failEventsOnly(el, r, 503)
    expect(statusTabText(el, '処理中')).toBe('処理中')

    await act(async () => { retryListButton(el).click() })
    await act(async () => { await drainMicrotasks() })
    expect(eventsCalls).toHaveLength(2)

    await act(async () => {
      eventsDeferreds[1].resolve(ok(recordsList(
        [action('1')],
        1,
        { pending: 1, processing: 2, succeeded: 5, skipped: 1, retryable_failed: 3, permanent_failed: 1 },
      )))
      await drainMicrotasks()
    })

    expect(el.textContent).not.toContain('取り込みの記録を読み込めませんでした')
    expect(statusTabText(el, '処理中')).toBe('処理中3')
    expect(statusTabText(el, '失敗')).toBe('失敗4')
    expect(statusTabText(el, '処理完了')).toBe('処理完了5')
    expect(statusTabText(el, '送信なし')).toBe('送信なし1')
  })

  it('正常時は実数を出し、1ページなら移動を出さない', async () => {
    const { container: el, root: r } = mount()
    await render(el, r)
    await act(async () => { await drainMicrotasks() })
    await act(async () => {
      overviewFor('account-a').resolve(ok(overview(111)))
      eventsDeferreds[0].resolve(ok(recordsList(
        [action('1')],
        1,
        { pending: 1, processing: 2, succeeded: 5, skipped: 1, retryable_failed: 3, permanent_failed: 1 },
      )))
      await drainMicrotasks()
    })

    expect(statusTabText(el, '処理中')).toBe('処理中3')
    expect(statusTabText(el, '失敗')).toBe('失敗4')
    expect(el.querySelector('[data-pagination]')).toBeNull()
    expect(el.querySelector('[data-pagination] button[aria-label="次のページ"]')).toBeNull()
    expect(el.querySelector('[data-pagination] button')).toBeNull()
  })

  it('空の一覧は「記録はありません」と実数の0を出す', async () => {
    const { container: el, root: r } = mount()
    await render(el, r)
    await act(async () => { await drainMicrotasks() })
    await act(async () => {
      overviewFor('account-a').resolve(ok(overview(0)))
      eventsDeferreds[0].resolve(ok(recordsList([], 0)))
      await drainMicrotasks()
    })

    expect(el.textContent).toContain('記録はありません')
    // 取れたうえでの 0件なので、実数の 0 を出す（隠さない）。
    expect(statusTabText(el, '処理中')).toBe('処理中0')
    expect(statusTabText(el, '失敗')).toBe('失敗0')
  })
})

describe('取り込みの記録の器（監査A2）', () => {
  it('出来事の配列のままでは「読み込めませんでした」になる', async () => {
    const { container: el, root: r } = mount()
    await render(el, r)
    await act(async () => { await drainMicrotasks() })

    await act(async () => {
      overviewFor('account-a').resolve(ok(overview(6)))
      // 修正前の偽APIの形（data が配列）。本物は {items,total,summary}。
      eventsDeferreds[0].resolve(ok([{ id: 'ece-1' }]))
      await drainMicrotasks()
    })
    expect(el.textContent).toContain('取り込みの記録を読み込めませんでした')
  })

  it('処理1件ずつの器（orderなし）でも行が出る', async () => {
    const { container: el, root: r } = mount()
    await render(el, r)
    await act(async () => { await drainMicrotasks() })

    await act(async () => {
      overviewFor('account-a').resolve(ok(overview(6)))
      // 修正後の偽APIと同じ形（EC_ACTION_EXECUTIONS 由来・order なし）。
      eventsDeferreds[0].resolve(ok({
        items: [{
          id: 'ec-action-1', eventId: 'ece-1', eventType: 'ec.order.confirmed', eventLabel: '',
          actionType: 'line_notification', ruleVersion: 'ec-rule-v4', status: 'succeeded',
          attemptCount: 1, maxAttempts: 3, errorCode: null, errorMessage: null,
          lastAttemptedAt: null, nextRetryAt: null, version: 1,
          receivedAt: '2026-08-25T08:48:00.000Z', orderNumber: 'NEN-12492', customerName: '見本 16',
          friendId: null, retryAvailable: false, failureKind: null, order: null,
        }],
        total: 1,
        summary: { pending: 0, processing: 0, succeeded: 1, skipped: 0, retryable_failed: 0, permanent_failed: 0 },
      }))
      await drainMicrotasks()
    })
    expect(el.querySelector('[title="注文 NEN-12492"]')).toBeTruthy()
    expect(el.textContent).not.toContain('取り込みの記録を読み込めませんでした')
  })
})

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/lib/staff-role', async (importOriginal) => ({...await importOriginal<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner'}))
