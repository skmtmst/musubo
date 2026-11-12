// @vitest-environment happy-dom
/*
 * マイルの使い道（板 `S35pO`）を本物の React で動かして守る。
 *
 * この面の数字は、運用者が「誰に声をかけるか」を決めるために見る。
 * 取れていない数を 0 と書く・内部の記号を出す・別の店の使い道が混ざる、の
 * どれも声をかける相手を取り違える。差し替えるのは通信と店の選択だけにして、
 * 画面本体と `api.ts` は実物を通す。
 *
 * 届かなかった交換の欄の動きは mileage-retry-react.test.tsx、
 * 数の帯の未取得と 0 の区別は mileage-rewards-fidelity-react.test.tsx が見る。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MileageShell } from '@/v8/mileage/frame'
import MileageRewardsTab from '@/v8/mileage/rewards'

let currentAccount: string | null = null
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: currentAccount, loading: false }) }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.ComponentProps<'a'>) => <a href={String(href)} {...props}>{children}</a>,
}))

type Kind = 'coupon' | 'tag' | 'scenario' | 'template' | 'early_access' | 'rank'

function reward(id: string, name: string, overrides: Record<string, unknown> = {}, version: Record<string, unknown> = {}) {
  return {
    id,
    lineAccountId: 'account-1',
    programId: 'program-1',
    name,
    description: null,
    imageUrl: null,
    rewardKind: 'coupon' as Kind,
    status: 'published',
    sortOrder: 0,
    currentDraftVersionId: null,
    currentPublishedVersionId: 'version-1',
    currentVersion: {
      id: `${id}-version`,
      versionNumber: 1,
      status: 'published',
      revision: 1,
      requiredMiles: 500,
      stockLimit: null,
      perFriendLimit: null,
      startsAt: null,
      endsAt: null,
      benefitExpiresDays: null,
      commonActionVersionId: null,
      targetConditions: null,
      failurePolicy: 'refund',
      customerMessage: '',
      publishedAt: '2026-09-10T00:00:00.000Z',
      ...version,
    },
    exchangedThisMonth: 0,
    availableCodeCount: null,
    benefitName: null,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  }
}

function overviewOf(rewards: unknown) {
  return {
    rewards,
    summary: {
      publishedCount: 0,
      redeemedMilesThisMonth: 0,
      neverRedeemedFriendCount: null,
      mostRedeemedRewardName: null,
      mostRedeemedRewardCount: null,
    },
    reachMetrics: [],
    rankBenefits: [],
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

interface Call { url: string; method: string }

/**
 * 通信の差し替え。使い道の一覧は店ごとに引ける。
 * `onRewards` / `onRedemptions` が Response か Promise を返したらそれを使う。
 */
function stubFetch(options: {
  rewardsByAccount?: Record<string, unknown>
  onRewards?: (accountId: string, count: number) => Promise<Response> | Response | null
  redemptionsByAccount?: Record<string, Array<Record<string, unknown>>>
  onRedemptions?: (count: number) => Promise<Response> | Response | null
  onRetry?: () => Promise<Response> | Response
}) {
  const calls: Call[] = []
  let rewardsCalls = 0
  let redemptionsCalls = 0
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ url, method })
    const params = new URL(url, 'https://example.test').searchParams
    if (url.includes('/retry-fulfillment')) {
      return options.onRetry ? options.onRetry() : json({ success: true, data: {} })
    }
    if (url.includes('/api/mileage/redemptions')) {
      redemptionsCalls += 1
      const override = options.onRedemptions?.(redemptionsCalls)
      if (override) return override
      const items = options.redemptionsByAccount?.[params.get('accountId') ?? ''] ?? []
      return json({ success: true, data: { items, pagination: { total: items.length, limit: 20, offset: 0 } } })
    }
    if (url.includes('/api/mileage/rewards') && method === 'GET') {
      rewardsCalls += 1
      const accountId = params.get('accountId') ?? ''
      const override = options.onRewards?.(accountId, rewardsCalls)
      if (override) return override
      return json({ success: true, data: overviewOf(options.rewardsByAccount?.[accountId] ?? []) })
    }
    return json({ success: true, data: [] })
  }) as typeof globalThis.fetch
  return {
    calls,
    rewardLoads: () => calls.filter((call) => call.method === 'GET' && call.url.includes('/api/mileage/rewards')),
  }
}

let container: HTMLDivElement
let root: Root
const originalFetch = globalThis.fetch

/* この happy-dom には localStorage が無い。`api.ts` は更新の口で CSRF札を読む。 */
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
    if (!holder[name]) Object.defineProperty(globalThis, name, { value: make(), configurable: true })
  }
}

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  installWebStorage()
  window.history.replaceState(null, '', '/mileage?tab=rewards')
  window.dispatchEvent(new Event('popstate'))
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

async function settle(rounds = 10) {
  for (let i = 0; i < rounds; i += 1) await act(async () => { await Promise.resolve() })
}

async function render(accountId: string | null, readonly = false) {
  currentAccount = accountId
  await act(async () => {
    root.render(
      <MileageShell.Provider value={{ tab: 'rewards', readonly, narrow: false, counts: {}, setCount: () => {} }}>
        <MileageRewardsTab />
      </MileageShell.Provider>,
    )
  })
  await settle()
}

function rowsText(): string {
  return [...container.querySelectorAll('tbody tr')].map((row) => row.textContent ?? '').join('\n')
}

describe('使い道の表の中身', () => {
  it.each([true, false])('使い道の操作説明は閲覧のみ %s に合う', async readonly => {
    stubFetch({ rewardsByAccount: { 'account-1': [reward('r1', '交換品')] } })
    await render('account-1', readonly)
    const help = container.querySelector<HTMLButtonElement>('button[aria-label="この画面の説明"]')!
    expect(help).toBeTruthy()
    await act(async () => help.click())
    expect(container.textContent).toContain(readonly ? '使い道と交換に必要なマイルを確認できます。' : '編集・自分で交換をテスト')
    if (readonly) expect(container.textContent).not.toContain('編集・自分で交換をテスト')
  })
  it('引換コードの残りは取れた数だけを出し、取れないときは 0 と書かない', async () => {
    stubFetch({
      rewardsByAccount: {
        'account-1': [
          reward('r-unknown', '在庫の数が取れない', { availableCodeCount: null }, { stockLimit: 10 }),
          reward('r-zero', '品切れ', { availableCodeCount: 0 }, { stockLimit: 10 }),
          reward('r-three', '残り3', { availableCodeCount: 3 }, { stockLimit: 10 }),
        ],
      },
    })
    await render('account-1')

    const row = (id: string) => container.querySelector(`tbody tr[data-row-id="${id}"]`)?.textContent ?? ''
    expect(row('r-unknown')).toContain('残り数は取れていません')
    expect(row('r-unknown')).not.toContain('残り 0')
    expect(row('r-zero')).toContain('残り 0')
    expect(row('r-three')).toContain('残り 3')
  })

  it('渡すものの種類は日本語で出し、内部の記号を出さない', async () => {
    const kinds: Kind[] = ['coupon', 'tag', 'scenario', 'template', 'early_access', 'rank']
    stubFetch({
      rewardsByAccount: {
        'account-1': kinds.map((kind, index) => reward(`r-${kind}`, `使い道${index + 1}`, { rewardKind: kind, sortOrder: index })),
      },
    })
    await render('account-1')

    const cell = (kind: Kind) => container.querySelector(`tbody tr[data-row-id="r-${kind}"] td:nth-child(3) [data-truncated-text]`)?.textContent
    expect(cell('coupon')).toBe('クーポン')
    expect(cell('tag')).toBe('タグ')
    expect(cell('scenario')).toBe('シナリオ')
    expect(cell('template')).toBe('メッセージ')
    expect(cell('early_access')).toBe('先にお知らせ')
    expect(cell('rank')).toBe('ランク')
    for (const kind of kinds) expect(rowsText()).not.toContain(kind)
  })

  it('下書きは「下書き」と出す', async () => {
    stubFetch({ rewardsByAccount: { 'account-1': [reward('r-draft', '冬の限定ギフト', { status: 'draft' })] } })
    await render('account-1')

    const state = container.querySelector('tbody tr[data-row-id="r-draft"] td:nth-child(5)')
    expect(state?.textContent).toBe('下書き')
    expect(container.textContent).not.toContain('準備中')
  })

  it('返事の形が壊れていたら一覧ごと落とさず、読み込めなかったと出す', async () => {
    stubFetch({ onRewards: () => json({ success: true, data: { rewards: { broken: true } } }) })
    await render('account-1')

    expect(container.textContent).toContain('使い道を読み込めませんでした')
    expect(container.querySelector('tbody tr[data-row-id]')).toBeNull()
  })
})

describe('いちばん人気', () => {
  function popularCard(): Element | undefined {
    return [...container.querySelectorAll('[data-kpi-label]')]
      .find((label) => label.textContent === 'いちばん人気')
      ?.closest('[data-design-version="v8"]') ?? undefined
  }

  it('1回も交換されていないときは、名前も 0 件も大きく出さない', async () => {
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input)
      if (url.includes('/api/mileage/rewards')) {
        return json({ success: true, data: { ...overviewOf([reward('r-1', '送料無料クーポン')]), summary: {
          publishedCount: 1, redeemedMilesThisMonth: 0, neverRedeemedFriendCount: 3,
          mostRedeemedRewardName: '交換されていない使い道', mostRedeemedRewardCount: 0,
        } } })
      }
      return json({ success: true, data: { items: [], pagination: { total: 0, limit: 20, offset: 0 } } })
    }) as typeof globalThis.fetch
    await render('account-1')

    const card = popularCard()
    expect(card?.textContent).toContain('まだ交換されていません')
    expect(card?.querySelector('[data-kpi-number]')?.textContent ?? '').not.toBe('0')
    expect(card?.outerHTML).not.toContain('交換されていない使い道')
  })

  it('交換された回数があるときは、回数と名前を出す', async () => {
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input)
      if (url.includes('/api/mileage/rewards')) {
        return json({ success: true, data: { ...overviewOf([reward('r-1', '送料無料クーポン')]), summary: {
          publishedCount: 1, redeemedMilesThisMonth: 500, neverRedeemedFriendCount: 3,
          mostRedeemedRewardName: '送料無料クーポン', mostRedeemedRewardCount: 4,
        } } })
      }
      return json({ success: true, data: { items: [], pagination: { total: 0, limit: 20, offset: 0 } } })
    }) as typeof globalThis.fetch
    await render('account-1')

    const card = popularCard()
    expect(card?.querySelector('[data-kpi-number]')?.textContent).toBe('4')
    expect(card?.textContent).toContain('今月いちばん：送料無料クーポン')
  })
})

describe('使い道の読み込みの状態', () => {
  it('読み込み中・権限なし・失敗のそれぞれに、別の文を出す', async () => {
    let finish!: (response: Response) => void
    stubFetch({ onRewards: () => new Promise<Response>((done) => { finish = done }) })
    await render('account-1')
    expect(container.querySelector('[data-list-state="loading"]')?.getAttribute('aria-label')).toBe('使い道を読み込んでいます')

    await act(async () => { finish(json({ success: false, error: 'forbidden' })) })
    await settle()
    expect(container.textContent).toContain('使い道を見る権限がありません')
    expect(container.textContent).not.toContain('使い道を読み込めませんでした')

    await act(async () => { root.unmount() })
    root = createRoot(container)
    const net = stubFetch({ onRewards: (_account, count) => (count === 1 ? json({ success: false, error: 'boom' }) : null) })
    await render('account-1')
    expect(container.textContent).toContain('使い道を読み込めませんでした')
    expect(container.textContent).not.toContain('使い道を見る権限がありません')

    // 失敗の欄から読み直せる。
    const retry = [...container.querySelectorAll('button')].find((button) => /もう一度|再読み込み/.test(button.textContent ?? ''))
    expect(retry).toBeDefined()
    await act(async () => { retry?.click() })
    await settle()
    expect(net.rewardLoads()).toHaveLength(2)
    expect(container.textContent).not.toContain('使い道を読み込めませんでした')
  })
})

describe('店ごとに読む', () => {
  it('使い道は選んでいる店の分だけを読み、店を替えたら読み直す', async () => {
    const net = stubFetch({
      rewardsByAccount: {
        'account-1': [reward('a-1', 'Aの送料無料')],
        'account-2': [reward('b-1', 'Bの限定ギフト')],
      },
    })
    await render('account-1')
    expect(net.rewardLoads().at(-1)?.url).toContain('accountId=account-1')
    expect(rowsText()).toContain('Aの送料無料')

    await render('account-2')
    expect(net.rewardLoads().at(-1)?.url).toContain('accountId=account-2')
    expect(rowsText()).toContain('Bの限定ギフト')
    expect(rowsText()).not.toContain('Aの送料無料')
  })

  it('前の店の遅い使い道の返事が、切り替えた店の表を上書きしない', async () => {
    let finish!: (response: Response) => void
    const delayed = new Promise<Response>((done) => { finish = done })
    stubFetch({
      rewardsByAccount: { 'account-2': [reward('b-1', 'Bの限定ギフト')] },
      onRewards: (accountId) => (accountId === 'account-1' ? delayed : null),
    })
    await render('account-1')
    await render('account-2')
    expect(rowsText()).toContain('Bの限定ギフト')

    await act(async () => { finish(json({ success: true, data: overviewOf([reward('a-old', 'Aの古い使い道')]) })) })
    await settle()
    expect(rowsText()).toContain('Bの限定ギフト')
    expect(rowsText()).not.toContain('Aの古い使い道')
  })

  it('やり直し後の読み直しの途中で店を替えたら、前の店の使い道を読み直さない', async () => {
    let finishReload!: (response: Response) => void
    const failedRow = {
      id: 'redemption-1', rewardName: '500円引き', status: 'delivery_failed', attemptCount: 1,
      failureCode: 'reward_delivery_failed', failureMessage: '渡せませんでした', updatedAt: '2026-09-09T01:02:03.000Z',
    }
    const net = stubFetch({
      rewardsByAccount: {
        'account-1': [reward('a-1', 'Aの送料無料')],
        'account-2': [reward('b-1', 'Bの限定ギフト')],
      },
      redemptionsByAccount: { 'account-1': [failedRow] },
      // 2回目（やり直しのあとの読み直し）だけ止めておく。
      onRedemptions: (count) => (count === 2 ? new Promise<Response>((done) => { finishReload = done }) : null),
    })
    await render('account-1')
    const trigger = container.querySelector('button[aria-label="500円引きの交換の操作"]') as HTMLButtonElement
    await act(async () => { trigger.click() })
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.includes('もう一度届ける')) as HTMLButtonElement
    await act(async () => { item.click() })
    await settle()
    expect(finishReload).toBeTypeOf('function')

    await render('account-2')
    const loadsAfterSwitch = net.rewardLoads().length
    await act(async () => {
      finishReload(json({ success: true, data: { items: [], pagination: { total: 0, limit: 20, offset: 0 } } }))
    })
    await settle()

    const later = net.rewardLoads().slice(loadsAfterSwitch)
    expect(later.filter((call) => call.url.includes('accountId=account-1'))).toHaveLength(0)
    expect(rowsText()).toContain('Bの限定ギフト')
    expect(rowsText()).not.toContain('Aの送料無料')
  })
})

describe('一覧から行き止まりを作らない', () => {
  it('作るボタンは作成画面へ、行の「…」は編集へ進む', async () => {
    stubFetch({ rewardsByAccount: { 'account-1': [reward('r-1', '送料無料クーポン')] } })
    await render('account-1')

    const create = [...container.querySelectorAll('a')].find((link) => link.textContent?.includes('使い道を作る'))
    expect(new URL(create?.getAttribute('href') ?? '', 'https://admin.test').pathname).toBe('/mileage/rewards/edit')

    await act(async () => { (container.querySelector('button[aria-label="送料無料クーポンの操作"]') as HTMLButtonElement).click() })
    const labels = [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent?.trim())
    expect(labels).toContain('編集する')
    expect(labels).not.toContain('中身を見る')
  })

  it('閲覧のみの人には作るボタンを出さず、行の「…」は中身を見るだけにする', async () => {
    stubFetch({ rewardsByAccount: { 'account-1': [reward('r-1', '送料無料クーポン')] } })
    await render('account-1', true)

    expect([...container.querySelectorAll('a')].some((link) => link.textContent?.includes('使い道を作る'))).toBe(false)
    await act(async () => { (container.querySelector('button[aria-label="送料無料クーポンの操作"]') as HTMLButtonElement).click() })
    const labels = [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent?.trim())
    expect(labels).toEqual(['中身を見る'])
  })
})
