// @vitest-environment happy-dom
/*
 * R287/R288: 支払い画面の再開と差し引き表示。
 * - R287: 締め済みがあれば開き直しで明細・CSVの続きに戻る（再開口の配線）。
 * - R288: 行に「元の報酬−差し引き」を出し、繰り越しの帯で方針を示す。
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { AffiliateShell } from '@/v8/affiliates/frame'
import PaymentTab from '@/v8/affiliates/payment'

const fixture = vi.hoisted(() => ({
  previewImpl: null as null | (() => Promise<unknown>),
  currentImpl: null as null | (() => Promise<unknown>),
}))

const PREVIEW = {
  lineAccountId: 'acc-1',
  periodFrom: '2026-09-01T00:00:00.000Z',
  periodTo: '2026-09-30T23:59:59.999Z',
  currency: 'JPY',
  totalAmount: 700,
  conversionCount: 1,
  affiliates: [{
    affiliateId: 'aff-1',
    affiliateName: '田中',
    code: 'tanaka',
    amount: 700,
    grossAmount: 1000,
    deduction: 300,
    conversionCount: 1,
    bankProfileRegistered: true,
  }],
  excludedZeroAmount: { count: 0, rows: [] },
  carriedOver: { count: 0, amount: 0 },
  totalDeduction: 300,
  carriedDeduction: { count: 1, amount: 100 },
  previewVersion: 'version-1',
}

const RESUMED = {
  settlementId: 'settlement-1',
  state: 'closed',
  version: 1,
  closedAt: '2026-09-30T10:00:00.000Z',
  totalAmount: 700,
  conversionCount: 1,
  periodFrom: '2026-09-01T00:00:00.000Z',
  periodTo: '2026-09-30T23:59:59.999Z',
  affiliates: [{
    affiliateId: 'aff-1',
    affiliateName: '田中',
    code: 'tanaka',
    amount: 700,
    conversionCount: 1,
    statementIssued: false,
    bankProfileRegistered: true,
  }],
  batch: null,
}

vi.mock('@/lib/api', () => ({
  api: {
    affiliates: {
      settlementPreview: () => fixture.previewImpl!(),
      paymentSummaries: () => Promise.resolve({ success: true, data: [] }),
      settlementCurrent: () => fixture.currentImpl!(),
    },
  },
}))

function AffiliatePaymentTab({ accountId }: { accountId: string }) {
  return <AffiliateShell.Provider value={{ tab: 'payment', readonly: false, narrow: false, accountId, counts: {}, setCount: () => {}, focusAffiliateId: null }}><PaymentTab /></AffiliateShell.Provider>
}

afterEach(() => {
  cleanup()
})

describe('R287 締め後に開き直しても明細・CSVを再開できる', () => {
  test('締め済みがあれば明細・CSVが押せ、再開の帯が出る', async () => {
    fixture.previewImpl = () => Promise.resolve({
      success: true,
      data: { ...PREVIEW, totalAmount: 0, conversionCount: 0, affiliates: [] },
    })
    fixture.currentImpl = () => Promise.resolve({ success: true, data: RESUMED })
    render(<AffiliatePaymentTab accountId="acc-1" />)
    await waitFor(() => {
      expect(screen.getByText(/締めた記録を読み出しました/)).toBeTruthy()
    })
    expect(screen.getByRole('button', { name: '支払明細をまとめて出す' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /銀行用 CSV/ })).toBeTruthy()
  })
})

describe('R288 支払い画面の差し引き表示', () => {
  test('行に元の報酬と差し引きを分け、繰り越しの帯を出す', async () => {
    fixture.previewImpl = () => Promise.resolve({ success: true, data: PREVIEW })
    fixture.currentImpl = () => Promise.resolve({ success: true, data: null })
    render(<AffiliatePaymentTab accountId="acc-1" />)
    await waitFor(() => {
      expect(screen.getByText('今回 払う額')).toBeTruthy()
    })
    expect(within(await screen.findByRole('row', { name: /田中/ })).getByText('¥700')).toBeTruthy()
    expect(screen.getByText(/元の報酬 ¥1,000 − 取消 ¥300/)).toBeTruthy()
    expect(screen.getByText(/締めたあとに取り消された分 ¥300 を差し引いています/)).toBeTruthy()
    expect(screen.getByText(/今回引ききれない ¥100 は次回へ繰り越し/)).toBeTruthy()
  })
})
