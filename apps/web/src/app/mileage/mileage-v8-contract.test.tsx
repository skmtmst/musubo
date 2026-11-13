import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { querySupplementaryPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

import MileagePage from './page'

/*
 * ★V8-B マイル（Pencil「★V8-B 画面の地図」の行：
 * たまる決めごと ・使い道 ・友だちの残高 ・
 * 履歴 ・行動スコア ・状態 ・1152 ・
 * 閲覧のみ ）の契約。
 * `<html data-theme="v8">` の下でだけ新しい器に切り替わり、
 * タブごとの板 ID・数の帯・表・操作が出ることを実DOMで固定する。
 * 互換経路では従来の器が出ることも固定する。
 */
let query = ''
let balanceSource: 'ec' | 'musubo' | 'unknown' = 'musubo'
let selectedAccountId: string | null = 'account-a'
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
  usePathname: () => '/mileage',
  useSearchParams: () => new URLSearchParams(query),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId, selectedAccount: null, loading: false,
  }),
}))

/* 1152 の板に切り替えないよう、広い画面として描く。 */
vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => false }))

let staffRole = 'admin'
vi.mock('@/lib/staff-role', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/staff-role')>()
  return { ...original, useStaffRole: () => staffRole }
})

let root: Root
let host: HTMLDivElement
const response = (data: unknown, status = 200) => new Response(
  JSON.stringify(data),
  { status, headers: { 'Content-Type': 'application/json' } },
)

const ruleItem = {
  id: 'rule-1',
  published: {
    name: '友だち追加', eventType: 'friend_added', source: null, amount: 100,
    initialStatus: 'available', validFrom: null, validUntil: '2026-12-31', status: 'published',
    updatedAt: '2026-09-01T00:00:00Z',
  },
  draft: {
    name: '友だち追加', eventType: 'friend_added', source: null, amount: 100,
    initialStatus: 'available', validFrom: null, validUntil: '2026-12-31', expiresAfterDays: 365,
    cancellationEventTypes: [], targetConditions: null, sortOrder: 0,
  },
  draftVersion: 3,
  draftUpdatedAt: '2026-09-01T00:00:00Z',
  publishedVersion: 3,
  metrics30d: { eligible: 10, granted: 10, grantedMiles: 1000, excluded: 0 },
}

const friendItem = {
  friendId: 'friend-1',
  displayName: '見本 141',
  pictureUrl: null,
  rank: 'gold',
  rankReason: '今月の購入で到達',
  rankThreshold: null,
  nextRank: null,
  nextRankThreshold: null,
  milesToNextRank: null,
  monthChange: 100,
  available: 640,
  pending: 0,
  expiringMiles30d: 0,
  nextExpiringAt: '2026-11-01T00:00:00Z',
  lifetimeEarned: 1000,
  spent: 360,
  lastChangedAt: '2026-09-30T10:00:00+09:00',
  walletScope: 'friend',
  lineAccount: { id: 'line-a', name: '然-NEN-本店' },
}

const historyItem = {
  id: 'history-1',
  primaryFriendId: 'friend-1',
  displayName: '見本 141',
  lineAccountName: '然-NEN-本店',
  occurredAt: '2026-09-30T10:00:00+09:00',
  amount: 100,
  reason: '商品を買った',
  entryType: 'grant',
  status: 'available',
  mode: 'automatic',
  executedByStaffName: null,
  balanceAfter: 640,
  source: 'purchase',
  sourceReferenceId: null,
  hasSourceEvent: false,
}

const rewardItem = {
  id: 'reward-1',
  lineAccountId: 'line-a',
  programId: 'program-a',
  name: '送料無料クーポン',
  description: null,
  imageUrl: null,
  rewardKind: 'coupon',
  status: 'published',
  sortOrder: 0,
  currentDraftVersionId: 'draft-1',
  currentPublishedVersionId: 'version-1',
  currentVersion: {
    id: 'version-1', versionNumber: 1, status: 'published', revision: 1,
    requiredMiles: 500, stockLimit: null, perFriendLimit: 1,
    startsAt: null, endsAt: null, benefitExpiresDays: null,
    commonActionVersionId: null, targetConditions: null,
    failurePolicy: 'refund', customerMessage: '', publishedAt: '2026-09-01T00:00:00Z',
  },
  exchangedThisMonth: 21,
  availableCodeCount: null,
  benefitName: '送料無料',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
}

const scoreItem = {
  friendId: 'friend-1',
  displayName: '見本 141',
  pictureUrl: null,
  currentScore: 82,
  band: 'high',
  change30d: 12,
  lastReason: '商品を買った',
  lastChangedAt: '2026-09-30T10:00:00+09:00',
}

const scoreRuleItem = {
  id: 'score-rule-1',
  name: '購入した',
  eventType: 'purchase_completed',
  source: null,
  operation: 'delta',
  value: 30,
  frequency: { kind: 'per_day', limit: 1 },
  sameSourceEventOnce: true,
  validFrom: null,
  validUntil: null,
  enabled: true,
}

function baseHandler(url: URL) {
  if (url.pathname === '/api/staff/me') return response({ success: true, data: { role: staffRole } })
  if (url.pathname === '/api/mileage/earning-rules') {
    return response({
      success: true,
      data: {
        items: [ruleItem],
        pagination: { total: 1, limit: 100, offset: 0 },
        unassignedLegacyCount: 0,
        measuredAt: '2026-10-01T00:00:00Z',
      },
    })
  }
  if (url.pathname === '/api/mileage/history') {
    return response({
      success: true,
      data: {
        items: [historyItem],
        summary: { byType: [
          { entryType: 'grant', count: 5, amount: 500 },
          { entryType: 'spend', count: 2, amount: -200 },
        ] },
        pagination: { total: 1, limit: 20, offset: 0 },
      },
    })
  }
  if (url.pathname === '/api/mileage/friends') {
    return response({
      success: true,
      data: {
        balanceSource,
        summary: {
          totalMembers: 10, withBalanceCount: 8, available: 5000, pending: 0,
          monthChange: 300, rankCounts: [], expiringMiles30d: 0, nextExpiringAt: null,
        },
        items: [friendItem],
        pagination: { total: 10, limit: 20, offset: 0 },
        measuredAt: '2026-10-01T00:00:00Z',
      },
    })
  }
  if (url.pathname === '/api/mileage/rewards') {
    return response({
      success: true,
      data: {
        rewards: [rewardItem],
        summary: {
          publishedCount: 1, redeemedMilesThisMonth: 10500, neverRedeemedFriendCount: null,
          mostRedeemedRewardName: '送料無料クーポン', mostRedeemedRewardCount: 21,
        },
        reachMetrics: [{ rewardId: 'reward-1', rewardName: '送料無料クーポン', rewardKind: 'coupon', requiredMiles: 500, reachableFriendCount: 412, redeemedFriendCount: 21, exchangeRate: null }],
        rankBenefits: [],
        measuredAt: '2026-10-01T00:00:00Z',
      },
    })
  }
  if (url.pathname === '/api/mileage/redemptions') {
    if (balanceSource === 'ec' && url.searchParams.get('status') === 'reserved') return response({ success: true, data: { items: [{ id: 'held-1', rewardName: '保留の特典', status: 'reserved', updatedAt: '2026-11-03' }], pagination: { total: 1, limit: 20, offset: 0 } } })
    return response({ success: true, data: { items: [], pagination: { total: 0, limit: 20, offset: 0 } } })
  }
  if (url.pathname === '/api/mileage/adjustment-approvals' || url.pathname === '/api/mileage/adjustments/approvals') {
    return response({ success: true, data: [] })
  }
  if (url.pathname === '/api/action-scores/friends') {
    return response({
      success: true,
      data: {
        summary: { scoredFriends: 4, high: 1, normal: 2, low: 1, decreased30d: 1, highMin: 30, normalMin: 10 },
        items: [scoreItem],
        pagination: { total: 4, limit: 20, offset: 0 },
      },
    })
  }
  if (url.pathname === '/api/action-scores/rules') {
    const version = {
      id: 'v-3', versionNumber: 3, status: 'published', createdAt: '2026-09-12T00:00:00Z',
      publishedAt: '2026-09-12T00:00:00Z', rules: [scoreRuleItem],
      bands: { min: 0, max: 100, normalMin: 10, highMin: 30 },
    }
    return response({
      success: true,
      data: {
        configured: true, status: 'published',
        currentDraftVersionId: 'v-3', currentPublishedVersionId: 'v-3',
        editableVersion: { ...version, status: 'draft' }, publishedVersion: version,
      },
    })
  }
  return response({ success: true, data: {} })
}

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}
async function eventually(check: () => void, timeout = 5000) {
  const started = Date.now()
  while (true) {
    try { check(); return } catch (error) {
      if (Date.now() - started >= timeout) throw error
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    }
  }
}

beforeEach(() => {
  staffRole = verifiedStaffRole('admin')
  query = ''
  balanceSource = 'musubo'
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    return baseHandler(url)
  }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  verifiedStaffRole(null)
  act(() => root.unmount())
  host.remove()
  document.documentElement.removeAttribute('data-theme')
  vi.unstubAllGlobals()
})

test('v8 のたまる決めごとは板 OC0gy に切り替わる', async () => {
  document.documentElement.dataset.theme = 'v8'
  await act(async () => root.render(<MileagePage />))
  await settle()
  await eventually(() => {
    expect(host.querySelector('[data-design-node="OC0gy"]')).toBeTruthy()
    expect(host.textContent).toContain('友だち追加')
  })
  expect(host.textContent).toContain('たまる決めごと')
  expect(host.querySelector('[data-page-template="list"] [data-template-region="content"]')?.textContent).toContain('友だち追加')
  expect(host.textContent).toContain('決めごとを作る')
  expect(host.textContent).toContain('動いています')
  // 管理画面 の器は出ない
  expect(host.querySelector('[data-mileage-design="v6"]')).toBeNull()
  // 準備中は置かない
  expect(host.textContent).not.toContain('準備中')
  expect(host.querySelector('[title*="8人で割った平均"]')?.getAttribute('title')).toContain('625')
  await act(async () => { (host.querySelector('[aria-label="友だち追加の操作"]') as HTMLButtonElement).click() })
  const view = ([...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent?.trim() === '公開版の中身を見る') ?? querySupplementaryPageAction('公開版の中身を見る')) as HTMLButtonElement
  expect(view).toBeTruthy()
  await act(async () => { view.click() })
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('公開中の第3版')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('100マイル')
})

test('v8 のたまる決めごと：きっかけ（購入・配信の反応・紹介）は上の絞り込み。所属先の受け口がないフォルダ列を出さず、作成と絞り込みを保つ（W2）', async () => {
  document.documentElement.dataset.theme = 'v8'
  await act(async () => root.render(<MileagePage />))
  await settle()
  await eventually(() => expect(host.textContent).toContain('友だち追加'))
  expect(host.querySelector('[data-template-region="folders"]')).toBeNull()
  expect(host.querySelector('a[href="/mileage/earning-rules/new"]')).toBeTruthy()
  expect(host.textContent).not.toContain('フォルダを追加')
  expect(host.querySelector('button[aria-label="きっかけ"], [aria-label="きっかけ"]')).toBeTruthy()
})

test('v8 の使い道（S35pO）：左は使い道のフォルダの列。種類の選ぶ欄は道具の段に置かない', async () => {
  document.documentElement.dataset.theme = 'v8'
  query = 'tab=rewards'
  await act(async () => root.render(<MileagePage />))
  await settle()
  await eventually(() => expect(host.textContent).toContain('送料無料クーポン'))
  expect(host.querySelector('[data-template-region="folders"]')).not.toBeNull()
  expect(host.querySelector('[aria-label="種類"]')).toBeNull()
  query = ''
})

test('v8 のタブごとに板 ID が替わる（S35pO・CJlf4・oRbJi・IRPw8）', async () => {
  document.documentElement.dataset.theme = 'v8'
  for (const [tab, node, word] of [
    ['rewards', 'S35pO', '送料無料クーポン'],
    ['balances', 'CJlf4', '見本 141'],
    ['history', 'oRbJi', '商品を買った'],
    ['score', 'IRPw8', '点が高い'],
  ] as const) {
    query = `tab=${tab}`
    await act(async () => root.render(<MileagePage />))
    await settle()
    await eventually(() => {
      expect(host.querySelector(`[data-design-node="${node}"]`)).toBeTruthy()
      expect(host.textContent).toContain(word)
      if (tab === 'balances') expect(host.querySelector('[title^="次は "]')?.getAttribute('title')).toContain('11')
    })
    act(() => root.unmount())
    host.remove()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
})

test('v8 の閲覧のみは帯が出て、作る操作は出さない（E2Any）', async () => {
  staffRole = verifiedStaffRole('staff')
  document.documentElement.dataset.theme = 'v8'
  await act(async () => root.render(<MileagePage />))
  await settle()
  await eventually(() => {
    expect(host.querySelector('[data-design-node="E2Any"]')).toBeTruthy()
    expect(host.textContent).toContain('友だち追加')
  })
  expect(host.textContent).toContain('この画面を変える権限がありません。変えたい時はオーナーか管理者に頼んでください。')
  /* 2026-10-06 オーナー：閲覧のみの人には、押せない形で残さず隠す。 */
  expect(host.textContent).not.toContain('決めごとを作る')
  expect(host.querySelector('[aria-label="友だち追加を上へ"]')).toBeNull()
})

test('旧テーマの属性が残っていてもV8を出す', async () => {
  await act(async () => root.render(<MileagePage />))
  await settle()
  await eventually(() => {
    expect(host.querySelector('[data-design-node="OC0gy"]')).toBeTruthy()
  })
  expect(host.querySelector('[data-mileage-design="v6"]')).toBeNull()
})

test('U5：使われたマイルは支出の絶対量で、交換回数を保つ', async () => {
  document.documentElement.dataset.theme = 'v8'
  await act(async () => root.render(<MileagePage />))
  await eventually(() => {
    const card = ([...host.querySelectorAll('[data-design-version="v8"]')].find(el => el.querySelector('[data-kpi-label]')?.textContent === '直近30日 使われたマイル') ?? querySupplementaryPageAction('直近30日 使われたマイル'))
    expect(card?.querySelector('[data-kpi-number]')?.textContent).toBe('200')
    expect(card?.textContent).toContain('交換 2 件')
  })
})

test('EC が正の店では musubo の会員ランクを出さず EC と同期と案内する', async () => {
  document.documentElement.dataset.theme = 'v8'
  balanceSource = 'ec'
  query = 'tab=ranks'
  await act(async () => root.render(<MileagePage />))
  await eventually(() => expect(host.textContent).toContain('ECと同期'))
  expect(host.textContent).not.toContain('ランクを足す')
  expect(host.textContent).not.toContain('動かす')
})

test.each(['earning-rules', 'rewards'])('ECの%sは説明を出し作成を出さない', async (tab) => {
  document.documentElement.dataset.theme = 'v8'; balanceSource = 'ec'; query = `tab=${tab}`
  await act(async () => root.render(<MileagePage />))
  await eventually(() => expect(host.textContent).toContain('マイルはECで管理しています'))
  expect(host.querySelector('a[href="/mileage/earning-rules/new"]')).toBeNull()
  expect(host.querySelector('a[href^="/mileage/rewards/edit"]')).toBeNull()
})

test('EC切替前の予約中の交換はそのまま一覧で確認できる', async () => {
  document.documentElement.dataset.theme = 'v8'; balanceSource = 'ec'; query = 'tab=rewards'
  await act(async () => root.render(<MileagePage />))
  await eventually(() => expect(host.textContent).toContain('保留の特典'))
  expect(host.textContent).toContain('保留中の交換 1 件')
  expect(host.textContent).not.toContain('もう一度届ける')
})

test.each(['history', 'ranks'])('アカウント未選択の%sは選択案内を出す', async (tab) => {
  document.documentElement.dataset.theme = 'v8'; selectedAccountId = null; query = `tab=${tab}`
  try {
    await act(async () => root.render(<MileagePage />))
    await eventually(() => expect(host.textContent).toContain('LINEアカウントを選択してください'))
  } finally { selectedAccountId = 'account-a' }
})

test('設定元が不明ならランクを推測せず読み込みエラーを出す', async () => {
  document.documentElement.dataset.theme = 'v8'; balanceSource = 'unknown'; query = 'tab=ranks'
  await act(async () => root.render(<MileagePage />))
  await eventually(() => expect(host.textContent).toContain('会員ランクの設定元を読み込めませんでした'))
  expect(host.textContent).not.toContain('ランクを足す')
})

test('EC が正の店では過去の musubo 履歴と残高の出所を明記し、増減操作を出さない', async () => {
  document.documentElement.dataset.theme = 'v8'; balanceSource = 'ec'; query = 'tab=history'
  await act(async () => root.render(<MileagePage />))
  await eventually(() => expect(host.textContent).toContain('musubo側の履歴'))
  expect(host.textContent).toContain('musuboの残高')
  expect(host.textContent).not.toContain('増やす・減らす')
})
