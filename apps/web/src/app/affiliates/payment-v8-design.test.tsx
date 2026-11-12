// @vitest-environment happy-dom
/*
 * 板  支払いタブの絵合わせ。
 * - 数の帯：今回 払う額（合計・人数・件数）、次の締め（月日・あと何日）
 * - 行：確定できる／振込先待ちの札、未登録の札、行末の「…」（中に明細を見る）だけ
 * - 頭：銀行用 CSV…・支払明細をまとめて出す
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { AffiliateShell } from '@/v8/affiliates/frame'

const fixture = vi.hoisted(() => ({
  previewImpl: null as null | (() => Promise<unknown>),
}))

const PREVIEW = {
  lineAccountId: 'acc-1',
  periodFrom: '2026-09-01T00:00:00.000Z',
  periodTo: '2026-09-29T14:59:59.999Z',
  currency: 'JPY',
  totalAmount: 70400,
  conversionCount: 33,
  affiliates: [
    {
      affiliateId: 'aff-1',
      affiliateName: '合同会社ノース',
      code: 'north',
      amount: 31400,
      grossAmount: 31400,
      deduction: 0,
      conversionCount: 9,
      bankProfileRegistered: true,
    },
    {
      affiliateId: 'aff-2',
      affiliateName: '見本 26',
      code: 'kimura',
      amount: 3000,
      grossAmount: 3000,
      deduction: 0,
      conversionCount: 2,
      bankProfileRegistered: false,
    },
  ],
  previewVersion: 'version-1',
}

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())

vi.mock('@/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/api')>(),
  api: {
    affiliates: {
      settlementPreview: () => fixture.previewImpl!(),
      paymentSummaries: () => Promise.resolve({ success: true, data: [] }),
      settlementCurrent: () => Promise.resolve({ success: true, data: null }),
    },
  },
}))

const { default: PaymentTabV8 } = await import('@/v8/affiliates/payment')

afterEach(() => {
  cleanup()
})


function renderTab() {
  fixture.previewImpl = () => Promise.resolve({ success: true, data: PREVIEW })
  const { container } = render(
    <AffiliateShell.Provider value={{ tab: 'payment', readonly: false, narrow: false, accountId: 'acc-1', counts: {}, setCount: () => {}, focusAffiliateId: null }}><PaymentTabV8 /></AffiliateShell.Provider>,
  )
  return container
}

describe('aINnz 支払いタブの絵合わせ', () => {
  test('数の帯に今回の額と締めが出る', async () => {
    renderTab()
    await waitFor(() => {
      expect(screen.getByText('今回 払う額')).toBeTruthy()
    })
    expect(screen.getAllByText('¥70,400').length).toBeGreaterThan(0)
    expect(screen.getAllByText('2 人・33 件').length).toBeGreaterThan(0)
    expect(screen.getByText('次の支払日')).toBeTruthy()
  })

  test('行に札と明細だけが出る', async () => {
    renderTab()
    await waitFor(() => {
      expect(screen.getByText('確定できる')).toBeTruthy()
    })
    expect(screen.getByText('振込先待ち')).toBeTruthy()
    expect(screen.getByText('未登録')).toBeTruthy()
    // 行の右端は「…」1つ。明細はその中にある。
    expect(screen.queryByRole('button', { name: '明細を見る' })).toBeNull()
    const menus = screen.getAllByRole('button', { name: /の支払いの操作/ })
    expect(menus.length).toBe(2)
    fireEvent.click(menus[0])
    expect(await screen.findByRole('menuitem', { name: '明細を見る' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'この人を確定' })).toBeNull()
  })

  test('頭に2つの書き出しボタンと脚注が出る', async () => {
    renderTab()
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /CSV/ })).not.toBeNull()
    })
    const head = screen
    expect(head.getByRole('button', { name: '銀行用 CSV…' })).toBeTruthy()
    expect(head.getByRole('button', { name: '支払明細をまとめて出す' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '成果とアフィリエイトの説明' }))
    expect(within(document.querySelector('[data-template-region="heading"]') as HTMLElement).getByText(/口座番号は本人だけに表示します/)).toBeTruthy()
  })
})

 test('支払いが1ページなら件数だけを残し、本文に口座の案内を置く', async () => {
  const container = renderTab()
  expect(await screen.findByText('2人中 1〜2人')).toBeTruthy()
  expect(screen.queryByRole('navigation', { name: 'ページ送り' })).toBeNull()
  for (const name of ['前のページ', '次のページ']) expect(screen.queryByRole('button', { name })).toBeNull()
  expect(container.querySelector('[data-template-region="body"]')?.textContent).toContain('口座番号は本人だけに表示します。')
 })
 test('支払いが0件になっても件数を残し、ページ送りを出さない', async () => {
  renderTab()
  await screen.findByText('2人中 1〜2人')
  fireEvent.change(screen.getByRole('searchbox', { name: '名前・振込先で探す' }), { target: { value: '一致しない名前' } })
  await screen.findByText('条件に合うものはありません')
  expect(screen.getByText('0人')).toBeTruthy()
  expect(screen.queryByRole('navigation', { name: 'ページ送り' })).toBeNull()
 })
