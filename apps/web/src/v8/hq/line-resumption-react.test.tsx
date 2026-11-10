// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LineResumptionComplete, LineResumptionConnectionRecovery,
  LineResumptionHandover, LineResumptionPaymentRecovery, LineResumptionReview } from './line-resumption'

let host: HTMLDivElement
let root: Root
const onContinue = vi.fn(async () => {})
const onPayOutstanding = vi.fn(async () => {})
const onBack = vi.fn()

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  onContinue.mockClear(); onPayOutstanding.mockClear(); onBack.mockClear()
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const trial = {
  kind: 'trial_remaining' as const, conditionName: '通常条件', interval: 'month' as const,
  freeUntil: '2026-12-07T23:59:59+09:00', nextChargeAt: '2026-12-08T00:00:00+09:00',
  nextLineBaseYen: 5_900, trialPeriodLabel: '30日間',
}

describe('最後のLINE終了後の利用再開', () => {
  it('無料体験は元の終了日を引き継ぎ、接続前の請求を0円と示す', async () => {
    await act(async () => { root.render(<LineResumptionReview view={trial} onContinue={onContinue} onPayOutstanding={onPayOutstanding} onBack={onBack} />) })
    expect(host.textContent).toContain('無料体験の残り期間で再開できます')
    expect(host.textContent).toContain('2026年12月7日まで')
    expect(host.textContent).toContain('新しい30日間の無料期間は始まりません')
    expect(host.textContent).toContain('LINE接続時の請求合計¥0')
    const next = [...host.querySelectorAll('button')].find((button) => button.textContent === '確認して次へ進む')!
    await act(async () => { next.click() })
    expect(onContinue).toHaveBeenCalledOnce()
    expect(onPayOutstanding).not.toHaveBeenCalled()
  })

  it('年払い済み期間は二重請求せず年次更新日を表示する', async () => {
    await act(async () => { root.render(<LineResumptionReview view={{
      kind: 'annual_paid', conditionName: '通常条件', paidThrough: '2027-12-07T23:59:59+09:00',
      renewalAt: '2027-12-08T00:00:00+09:00', nextAnnualLineBaseYen: 63_720,
    }} onContinue={onContinue} onPayOutstanding={onPayOutstanding} onBack={onBack} />) })
    expect(host.textContent).toContain('お支払い済み期間内は再請求しません')
    expect(host.textContent).toContain('¥63,720／年（税込）')
    expect(host.textContent).toContain('2027年12月8日')
  })

  it('月払い済み期間は次の月次請求日まで二重請求しない', async () => {
    const view = { kind: 'monthly_paid' as const, conditionName: '通常条件',
      paidThrough: '2027-02-08T23:59:59+09:00',
      renewalAt: '2027-02-09T00:00:00+09:00', nextLineBaseYen: 5_900 }
    await act(async () => { root.render(<LineResumptionReview view={view}
      onContinue={onContinue} onPayOutstanding={onPayOutstanding} onBack={onBack} />) })
    expect(host.textContent).toContain('月払い済み')
    expect(host.textContent).toContain('LINE接続時の請求合計¥0')
    expect(host.textContent).toContain('2027年2月9日')
    expect(host.textContent).toContain('¥5,900／月（税込）')
    await act(async () => { root.render(<LineResumptionComplete view={{
      kind: 'monthly_paid', restartedAt: '2027-01-25T12:00:00+09:00',
      paidThrough: view.paidThrough, renewalAt: view.renewalAt,
      nextLineBaseYen: view.nextLineBaseYen,
    }} onAccounts={onBack} />) })
    expect(host.textContent).toContain('再開日の請求合計¥0')
    expect(host.textContent).toContain('次の月次請求：2027年2月9日')
  })

  it('支払い済み期間が終わっていれば接続成功時の請求と再試用なしを示す', async () => {
    await act(async () => { root.render(<LineResumptionReview view={{
      kind: 'paid_expired', conditionName: '通常条件', interval: 'month',
      dueOnConnectionYen: 5_900, nextLineBaseYen: 5_900,
    }} onContinue={onContinue} onPayOutstanding={onPayOutstanding} onBack={onBack} />) })
    expect(host.textContent).toContain('無料体験の再適用はありません')
    expect(host.textContent).toContain('LINE接続時の請求合計¥5,900（税込）')
    expect(host.textContent).toContain('接続前の請求はありません')
  })

  it('友だち超過と追加連携の金額を同意前に分けて表示する', async () => {
    await act(async () => { root.render(<LineResumptionReview view={{
      kind: 'paid_expired', conditionName: '通常条件', interval: 'month',
      dueOnConnectionYen: 5_900, nextLineBaseYen: 5_900,
      options: { friendCount: 12_000, measuredOn: '2027-01-24', friendBlocks: 1,
        linkedSlots: 2, friendOverageMonthlyYen: 1_100,
        linkedSlotsMonthlyYen: 6_600, optionsMonthlyYen: 7_700,
        optionsChargeAt: null, optionsDueNowYen: 7_700, totalDueNowYen: 13_600 },
    }} onContinue={onContinue} onPayOutstanding={onPayOutstanding} onBack={onBack} />) })
    expect(host.textContent).toContain('友だち超過（1枠）¥1,100／月（税込）')
    expect(host.textContent).toContain('追加連携（2枠）¥6,600／月（税込）')
    expect(host.textContent).toContain('LINE接続時の請求合計¥13,600（税込）')
  })

  it('未払いがある場合は支払いのみへ進み、LINE接続へ直進させない', async () => {
    await act(async () => { root.render(<LineResumptionReview view={{
      kind: 'unpaid', amountDueYen: 5_900, invoiceAt: '2026-12-08T00:00:00+09:00',
      periodStart: '2026-12-08T00:00:00+09:00', periodEnd: '2027-01-07T23:59:59+09:00',
    }} onContinue={onContinue} onPayOutstanding={onPayOutstanding} onBack={onBack} />) })
    expect(host.textContent).toContain('利用再開を保留しています')
    expect(host.textContent).toContain('過去の未払いがあります')
    expect(host.textContent).not.toContain('過去のお支払いを確認しました')
    const pay = [...host.querySelectorAll('button')].find((button) => button.textContent === '未払いを支払う')!
    await act(async () => { pay.click() })
    expect(onPayOutstanding).toHaveBeenCalledOnce()
    expect(onContinue).not.toHaveBeenCalled()
  })

  it('カード更新と接続引き継ぎを別の状態として表示する', async () => {
    await act(async () => { root.render(<LineResumptionHandover phase="card_required" onPrimary={onContinue} onBack={onBack} />) })
    expect(host.textContent).toContain('更新だけでは新しいLINE基本料金の請求は始まりません')
    expect(host.textContent).toContain('Stripeでカードを更新')
    await act(async () => { root.render(<LineResumptionHandover phase="ready" onPrimary={onContinue} onBack={onBack} />) })
    expect(host.textContent).toContain('決済が必要な場合は成功後に利用を再開します')
    expect(host.textContent).toContain('前回のLINEを確認して再開')
  })

  it('前回のLINE接続を確認できなければ、そのアカウントの設定へ戻せる', async () => {
    await act(async () => { root.render(<LineResumptionConnectionRecovery
      lineAccountId="old /?&" onBack={onBack} />) })
    expect(host.textContent).toContain('接続情報を更新した後に、最新の友だち数と再開料金を確認')
    expect(host.querySelector('a')?.getAttribute('href'))
      .toBe('/accounts/detail?id=old%20%2F%3F%26')
  })

  it('再開分の決済が失敗したときはLINEを有効化せずStripeの請求へ案内する', async () => {
    await act(async () => { root.render(<LineResumptionPaymentRecovery
      hostedInvoiceUrl="https://invoice.stripe.com/i/test" expired={false}
      onCardUpdate={onContinue} onRecheck={onBack} />) })
    expect(host.textContent).toContain('LINEはまだ再開していません')
    expect(host.querySelector('a')?.getAttribute('href')).toBe('https://invoice.stripe.com/i/test')
    const recheck = [...host.querySelectorAll('button')].find((button) => button.textContent === '再開の状態を再確認する')!
    await act(async () => { recheck.click() })
    expect(onBack).toHaveBeenCalledOnce()
  })

  it('接続確認後に元の無料期間と次回請求を表示する', async () => {
    await act(async () => { root.render(<LineResumptionComplete view={{
      kind: 'trial_remaining', restartedAt: '2026-11-25T12:00:00+09:00',
      freeUntil: trial.freeUntil, nextChargeAt: trial.nextChargeAt,
      nextLineBaseYen: 5_900, interval: 'month',
    }} onAccounts={onBack} />) })
    expect(host.textContent).toContain('無料体験の残り期間で再開しました')
    expect(host.textContent).toContain('初回請求予定：2026年12月8日')
    expect(host.textContent).toContain('再開日の請求合計¥0')
  })
})
