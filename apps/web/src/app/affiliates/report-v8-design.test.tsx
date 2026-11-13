// @vitest-environment happy-dom
/*
 * 板  レポートタブの絵合わせ。
 * - 数の帯：成果（先月より +N）、売上、報酬（売上の N%）、1件あたりの報酬
 * - 青帯：期間は…。数は「認めた成果」だけ。…「分析 › レポート」…
 * - 道具：名前で探す、2つの札、よく使う絞り込み、期間
 * - 行：いちばん多い案件、成果・売上、報酬（先月より）の差分、操作の見出しなし
 */
import { AffiliateShell } from '@/v8/affiliates/frame'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// 見本を作る前に時計を固定。日付以外の待ち合わせは実時間で動かす。
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-11T15:09:00Z'))
})
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-11T15:09:00Z'))
})
afterEach(() => vi.useRealTimers())
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const thisMonth = '2026-10-12T00:09:00+09:00'
// V8の過去30日（9/13〜10/12）の、さらに前の30日に置く。
const lastMonth = '2026-08-28T12:00:00+09:00'

const ITEMS = [
  {
    eventId: 'e1', createdAt: thisMonth, friendId: 'f1', friendName: '見本 121',
    affiliateId: 'a1', affiliateName: '見本 168', offerId: 'o1', offerName: '定期便の初回',
    value: 412000, approvalStatus: 'approved', rewardAmount: 28000,
  },
  {
    eventId: 'e2', createdAt: thisMonth, friendId: 'f2', friendName: '見本 178',
    affiliateId: 'a2', affiliateName: '合同会社ノース', offerId: 'o2', offerName: '夏の紹介キャンペーン',
    value: 314000, approvalStatus: 'approved', rewardAmount: 31400,
  },
  {
    eventId: 'e3', createdAt: lastMonth, friendId: 'f3', friendName: '見本 13',
    affiliateId: 'a1', affiliateName: '見本 168', offerId: 'o1', offerName: '定期便の初回',
    value: 200000, approvalStatus: 'approved', rewardAmount: 24000,
  },
]

const AFFILIATES = [
  { id: 'a1', name: '見本 168', code: 'tanaka-a', commissionRate: 10, isActive: true, createdAt: thisMonth, friendId: null },
  { id: 'a2', name: '合同会社ノース', code: 'north', commissionRate: 10, isActive: true, createdAt: thisMonth, friendId: null },
  { id: 'a3', name: '旧パートナーA', code: 'old-a', commissionRate: 0, isActive: false, createdAt: thisMonth, friendId: null },
]

const fixture = vi.hoisted(() => ({ failed: false, truncated: false, missingReward: false }))

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())

vi.mock('@/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/api')>(),
  api: {
    affiliates: {
      list: () => Promise.resolve({ success: !fixture.failed, data: AFFILIATES }),
    },
  },
}))

vi.mock('@/v8/affiliates/display', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/v8/affiliates/display')>(),
  listAllConversionApprovals: async () => ({ items: fixture.missingReward ? ITEMS.map((item) => ({ ...item, rewardAmount: null })) : ITEMS, truncated: fixture.truncated }),
}))

vi.mock('@/v8/affiliates/drawer', () => ({ default: () => null }))

const { default: ReportTabV8 } = await import('@/v8/affiliates/report')

beforeEach(() => {
  fixture.failed = false; fixture.truncated = false; fixture.missingReward = false
  window.history.replaceState(null, '', '/affiliates')
  window.dispatchEvent(new PopStateEvent('popstate'))
})

afterEach(() => {
  cleanup()
})

function renderTab() {
  render(<AffiliateShell.Provider value={{ tab: 'report', readonly: false, narrow: false, accountId: 'acc-1', counts: {}, setCount: () => {}, focusAffiliateId: null }}><ReportTabV8 /></AffiliateShell.Provider>)
}

describe.each(['2026-10-11T15:09:00Z', '2026-10-11T23:59:00Z'])('Eo56k レポートタブ（日本時間00:09・08:59、時計 %s）', (now) => {
  beforeEach(() => vi.setSystemTime(new Date(now)))
  test('紹介者の取得失敗をゼロ件に見せず、再読み込みで回復する', async () => {
    fixture.failed = true
    renderTab()
    await waitFor(() => expect(screen.getAllByText('紹介者を読み込めませんでした。集計は出していません。').length).toBeGreaterThan(0))
    expect(screen.queryByText('見本 168')).toBeNull()
    fixture.failed = false
    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    await waitFor(() => expect(screen.getByText('見本 168')).toBeTruthy())
  })

  test('全件を取れないときに部分合計を確定値として表示しない', async () => {
    fixture.truncated = true
    renderTab()
    await waitFor(() => expect(screen.getAllByText(/成果が取得の上限を超えています/).length).toBeGreaterThan(0))
    expect(screen.queryByText('見本 168')).toBeNull()
  })

  test('報酬が未確定なら売上を報酬として代用しない', async () => {
    fixture.missingReward = true
    renderTab()
    await waitFor(() => expect(screen.getByText('見本 168')).toBeTruthy())
    expect(screen.getAllByText('未確定の報酬があります')).toHaveLength(2)
    expect(screen.queryByText('売上の 100.0%')).toBeNull()
    // 画面の説明は題の横の「？」1つの中（洗い出し 74）。
    fireEvent.click(screen.getByRole('button', { name: 'この画面の説明' }))
    expect(screen.getByText(/未確定の報酬は金額を出さず/)).toBeTruthy()
  })

  test('数の帯と青帯が絵どおり', async () => {
    renderTab()
    await waitFor(() => {
      expect(screen.getByText('1件あたりの報酬')).toBeTruthy()
    })
    // 今月 2件 − 先月 1件
    expect(screen.getByText('前の期間より +1')).toBeTruthy()
    expect(screen.getByText('成果になった注文の合計')).toBeTruthy()
    expect(screen.getByText('売上の 8.2%')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'この画面の説明' }))
    expect(screen.getByText(/期間は過去30日/)).toBeTruthy()
    expect(screen.getByText(/数は「認めた成果」だけ/)).toBeTruthy()
    expect(screen.getByText(/分析 › レポート/)).toBeTruthy()
  })

  test('道具が絵どおり', async () => {
    renderTab()
    await waitFor(() => {
      expect(screen.getByLabelText('名前で探す')).toBeTruthy()
    })
    expect(screen.getByRole('button', { name: 'アフィリエイターごと' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '案件ごと' })).toBeTruthy()
    expect(screen.getAllByLabelText('よく使う絞り込み')[0]).toBeTruthy()
    expect(screen.getByRole('group', { name: '集計期間' })).toBeTruthy()
  })

  test('行に差分と操作の見出しなしが出る', async () => {
    renderTab()
    await waitFor(() => {
      expect(screen.getByText('見本 168')).toBeTruthy()
    })
    // a1：今月 28,000 − 先月 24,000
    expect(screen.getByText('¥28,000（+¥4,000）')).toBeTruthy()
    // a2：先月なし → 初めて
    expect(screen.getByText('¥31,400（初めて）')).toBeTruthy()
    // a3：0件
    expect(screen.getByText('0件')).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: '操作' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'この画面の説明' }))
    expect(screen.getByText(/行を押すと、その人の成果の明細/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '案件ごと' }))
    await screen.findByText('定期便の初回')
  })
})
