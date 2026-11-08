// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LineResumptionComplete, LineResumptionHandover, LineResumptionReview } from './line-resumption'

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
    expect(host.textContent).toContain('LINE接続時の請求¥0')
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

  it('支払い済み期間が終わっていれば接続成功時の請求と再試用なしを示す', async () => {
    await act(async () => { root.render(<LineResumptionReview view={{
      kind: 'paid_expired', conditionName: '通常条件', interval: 'month',
      dueOnConnectionYen: 5_900, nextLineBaseYen: 5_900,
    }} onContinue={onContinue} onPayOutstanding={onPayOutstanding} onBack={onBack} />) })
    expect(host.textContent).toContain('無料体験の再適用はありません')
    expect(host.textContent).toContain('LINE接続時の請求¥5,900（税込）')
    expect(host.textContent).toContain('接続前の請求はありません')
  })

  it('未払いがある場合は支払いのみへ進み、LINE接続へ直進させない', async () => {
    await act(async () => { root.render(<LineResumptionReview view={{
      kind: 'unpaid', amountDueYen: 5_900, invoiceAt: '2026-12-08T00:00:00+09:00',
      periodStart: '2026-12-08T00:00:00+09:00', periodEnd: '2027-01-07T23:59:59+09:00',
    }} onContinue={onContinue} onPayOutstanding={onPayOutstanding} onBack={onBack} />) })
    expect(host.textContent).toContain('利用再開を保留しています')
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
    expect(host.textContent).toContain('接続を中断しても利用は再開しません')
    expect(host.textContent).toContain('LINEアカウントを接続')
  })

  it('接続確認後に元の無料期間と次回請求を表示する', async () => {
    await act(async () => { root.render(<LineResumptionComplete view={{
      kind: 'trial_remaining', restartedAt: '2026-11-25T12:00:00+09:00',
      freeUntil: trial.freeUntil, nextChargeAt: trial.nextChargeAt,
      nextLineBaseYen: 5_900, interval: 'month',
    }} onAccounts={onBack} />) })
    expect(host.textContent).toContain('無料体験の残り期間で再開しました')
    expect(host.textContent).toContain('初回請求予定：2026年12月8日')
    expect(host.textContent).toContain('再開日のLINE基本料金¥0')
  })
})
