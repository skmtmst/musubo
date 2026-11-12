// @vitest-environment happy-dom
/*
 * 板  成果承認タブの絵合わせ。
 * - 数の帯：承認待ち（いちばん古いもの）、今月 認めた、今月 認めなかった
 * - 道具：4つの札＋よく使う絞り込み（1段）
 * - 表頭：決める
 */
import { AffiliateShell } from '@/v8/affiliates/frame'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()

const ITEMS = [
  {
    eventId: 'e1', createdAt: ago(6.5), friendId: 'f1', friendName: '見本 121',
    affiliateId: 'a1', affiliateName: '見本 168', offerId: 'o1', offerName: '定期便の初回',
    offerRewardMiles: null, conversionPointName: '定期便が確定', value: 2000,
    approvalStatus: 'pending', duplicateFlag: false, offerActionsIncomplete: false,
    lineAccountId: 'acc-1', lineAccountName: '本店', orderNumber: '1001',
    orderStatus: null, sameOrderDuplicate: false, rewardAmount: null,
  },
  {
    eventId: 'e2', createdAt: ago(2), friendId: 'f2', friendName: '見本 178',
    affiliateId: 'a2', affiliateName: 'ノース', offerId: 'o2', offerName: '夏の紹介',
    offerRewardMiles: null, conversionPointName: '商品を購入', value: 1280,
    approvalStatus: 'approved', duplicateFlag: false, offerActionsIncomplete: false,
    lineAccountId: 'acc-1', lineAccountName: '本店', orderNumber: '1002',
    orderStatus: null, sameOrderDuplicate: false, rewardAmount: 1280,
  },
  {
    eventId: 'e3', createdAt: ago(1), friendId: 'f3', friendName: '見本 13',
    affiliateId: 'a3', affiliateName: '見本 135', offerId: 'o1', offerName: '定期便の初回',
    offerRewardMiles: null, conversionPointName: '定期便が確定', value: 1000,
    approvalStatus: 'rejected', duplicateFlag: false, offerActionsIncomplete: false,
    lineAccountId: 'acc-1', lineAccountName: '本店', orderNumber: '1003',
    orderStatus: 'cancelled', sameOrderDuplicate: false, rewardAmount: null,
  },
]

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())

vi.mock('@/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/api')>(), api: {} }))

vi.mock('@/v8/affiliates/display', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/v8/affiliates/display')>(),
  listAllConversionApprovals: async (status: string) => ({
    items: ITEMS.filter((item) => item.approvalStatus === status),
    truncated: false,
  }),
  formatDateTime: (iso: string) => iso,
  formatYenNullable: (n: number | null) => (n == null ? '—' : `¥${n}`),
}))


vi.mock('@/v8/affiliates/attribution-view', () => ({ default: () => null }))
vi.mock('@/v8/affiliates/bulk-op', () => ({ default: () => null }))

const { default: ApprovalsTabV8 } = await import('@/v8/affiliates/approvals')

afterEach(() => {
  cleanup()
})

describe('OylSV 成果承認タブの絵合わせ', () => {
  test('数の帯が絵どおり', async () => {
    render(<AffiliateShell.Provider value={{ tab: 'approvals', readonly: false, narrow: false, accountId: 'acc-1', counts: {}, setCount: () => {}, focusAffiliateId: null }}><ApprovalsTabV8 /></AffiliateShell.Provider>)
    await waitFor(() => {
      expect(screen.getAllByText('承認待ち').length).toBeGreaterThan(0)
    })
    expect(screen.getByText('いちばん古いもの 6日前')).toBeTruthy()
    expect(screen.getAllByText('今月 認めた').length).toBeGreaterThan(0)
    expect(screen.getAllByText('今月 認めなかった').length).toBeGreaterThan(0)
    expect(screen.queryByText('認めるのを待っている')).toBeNull()
  })

  test('道具が1段で札と絞り込みがそろう', async () => {
    render(<AffiliateShell.Provider value={{ tab: 'approvals', readonly: false, narrow: false, accountId: 'acc-1', counts: {}, setCount: () => {}, focusAffiliateId: null }}><ApprovalsTabV8 /></AffiliateShell.Provider>)
    await waitFor(() => {
      expect(screen.getByLabelText('よく使う絞り込み')).toBeTruthy()
    })
    expect(screen.getByLabelText('名前・注文番号で探す')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /認めなかった/ }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: /認めた/ }).length).toBeGreaterThan(0)
    expect(screen.queryByLabelText('並び順')).toBeNull()
    expect(screen.queryByLabelText('アカウントで絞る')).toBeNull()
  })

  test('表頭が決める', async () => {
    render(<AffiliateShell.Provider value={{ tab: 'approvals', readonly: false, narrow: false, accountId: 'acc-1', counts: {}, setCount: () => {}, focusAffiliateId: null }}><ApprovalsTabV8 /></AffiliateShell.Provider>)
    await waitFor(() => {
      expect(screen.getByText('決める')).toBeTruthy()
    })
  })
})
