// @vitest-environment happy-dom
/*
 * 板  アフィリエイタータブの実入口の集計・権限・操作。
 * - 数の帯：アフィリエイター（計測中・停止中）、今月の成果（先月より±N）、
 *   今月の報酬（¥表示・承認待ち分は入れない）、承認待ち（認めると報酬に入ります）
 * - 道具：作るボタン、名前・紹介コードで探す、計測中／報酬ありの札、
 *   よく使う絞り込み、表示件数
 * - 行：売上の N%・報酬なし（計測のみ）の約束行、計測中／停止中の札、
 *   成果を見るボタン、脚注どおりの「…」の内訳
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const AFFILIATES = [
  {
    id: 'a1', name: '見本 168', code: 'tanaka-a', commissionRate: 10,
    isActive: true, createdAt: '2026-08-01T00:00:00.000Z',
    friendId: null, email: null, holdDays: null, payoutCycle: null, notifyOnConversion: false,
  },
  {
    id: 'a2', name: '旧パートナーA', code: 'old-a', commissionRate: 0,
    isActive: false, createdAt: '2026-07-01T00:00:00.000Z',
    friendId: null, email: null, holdDays: null, payoutCycle: null, notifyOnConversion: false,
  },
  {
    id: 'a3', name: '見本 27', code: 'nakamura', commissionRate: 0,
    isActive: true, createdAt: '2026-08-15T00:00:00.000Z',
    friendId: null, email: null, holdDays: null, payoutCycle: null, notifyOnConversion: false,
  },
]

const DETAIL = [
  { affiliateId: 'a1', totalClicks: 100, totalConversions: 14, totalRevenue: 280000, confirmedReward: 0, linkCount: 2, friendAdds: 186 },
  { affiliateId: 'a2', totalClicks: 10, totalConversions: 0, totalRevenue: 0, confirmedReward: 0, linkCount: 1, friendAdds: 12 },
]

const MONTHLY_CURRENT = [{ totalConversions: 30 }, { totalConversions: 8 }]
const MONTHLY_PREV = [{ totalConversions: 25 }, { totalConversions: 6 }]

const fixture = vi.hoisted(() => ({ datedCalls: 0, readonly: false }))

vi.mock('@/lib/api', () => ({
  api: {
    affiliates: {
      list: () => Promise.resolve({ success: true, data: AFFILIATES }),
      allReport: (params?: { startDate?: string; endDate?: string }) => {
        if (!params?.startDate) return Promise.resolve({ success: true, data: DETAIL })
        fixture.datedCalls += 1
        const data = fixture.datedCalls === 1 ? MONTHLY_CURRENT : MONTHLY_PREV
        return Promise.resolve({ success: true, data })
      },
      settlementPreview: () => Promise.resolve({ success: true, data: { affiliates: [], totalAmount: 70400 } }),
      links: () => Promise.resolve({ success: true, data: [] }),
      archive: () => Promise.resolve({ success: true, data: null }),
    },
    affiliateOffers: { list: async () => ({ success: true, data: [] }) },
    accountSettings: {
      getLinkBaseUrl: () => Promise.resolve({ success: true, data: null }),
    },
  },
}))

vi.mock('@/v8/affiliates/display', async original => ({
  ...await original<typeof import('@/v8/affiliates/display')>(),
  distributionUrl: () => null,
  listAllConversionApprovals: async () => ({ items: [], truncated: false }),
}))

import AffiliatesPage from './page'
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'acc-1' }) }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => fixture.readonly ? 'staff' : 'owner', canManageRole: (role: string) => role === 'owner' }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams(), usePathname: () => '/affiliates' }))

afterEach(() => {
  cleanup()
  fixture.datedCalls = 0
  fixture.readonly = false
})

describe('KdFRI アフィリエイタータブの実入口の集計・権限・操作', () => {
  test('数の帯が絵どおり（先月差分・¥表示）', async () => {
    render(<AffiliatesPage />)
    await waitFor(() => {
      expect(screen.getByText(/先月より\s*\+7/)).toBeTruthy()
    })
    expect(screen.getByText('計測中 2・停止中 1')).toBeTruthy()
    // 今月 38 − 先月 31 ＝ +7
    expect(screen.getByText(/先月より\s*\+7/)).toBeTruthy()
    expect(screen.getByText('¥70,400')).toBeTruthy()
    expect(screen.getByText('承認待ち')).toBeTruthy()
    expect(screen.getByText('認めると報酬に入ります')).toBeTruthy()
  })

  test('v9JWQ 閲覧のみ：変える操作が止まり見る操作は残る', async () => {
    fixture.readonly = true
    render(<AffiliatesPage />)
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: '成果を見る' }).length).toBe(3)
    })
    // 閲覧のみの人には作る操作と選ぶ枠を出さず、見る操作は残す。
    expect(screen.queryByRole('link', { name: /アフィリエイターを作る/ })).toBeNull()
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    // 探す・絞る・見るは使える
    expect(screen.getByLabelText('名前・紹介コードで探す')).toBeTruthy()
    expect(screen.getByLabelText('よく使う絞り込み')).toBeTruthy()
  })

  test('共通の広い列と畳んだ列で作成先と絞り込みを保つ', async () => {
    render(<AffiliatesPage />)
    await waitFor(() => {
      const creates = screen.getAllByRole('link', { name: /アフィリエイターを作る/ })
      expect(creates).toHaveLength(2)
      for (const create of creates) expect(create.getAttribute('href')).toBe('/affiliates/new')
    })
    expect(screen.getByLabelText('名前・紹介コードで探す')).toBeTruthy()
    expect(screen.getByRole('button', { name: /計測中/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /報酬あり/ })).toBeTruthy()
    expect(screen.getByLabelText('よく使う絞り込み')).toBeTruthy()
    expect(screen.getByLabelText('1ページに出す件数')).toBeTruthy()
  })

  test('行に約束行と札と操作が出る', async () => {
    render(<AffiliatesPage />)
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: '成果を見る' }).length).toBe(3)
    })
    expect(document.querySelector('[data-list-name]')?.textContent).not.toContain('売上の 10%')
    expect(document.querySelector('[data-list-name]')?.textContent).not.toContain('報酬なし（計測のみ）')
    expect(screen.getAllByText('計測中').length).toBeGreaterThan(0)
    expect(screen.getByText('停止中')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '見本 168の操作' }))
    expect(screen.getByRole('menuitem', { name: '紹介を止める' })).toBeTruthy()
  })
})
