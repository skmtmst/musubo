import { describe, expect, it } from 'vitest'
import { billingBanner, billingChip, trialDaysLabel, yen, type BillingSummary } from './hq-billing'

const base: BillingSummary = {
  state: 'trialing', planKey: null, planInterval: null, planName: null, planStatus: 'trialing', trialEndsAt: '2026-10-12T00:00:00.000', trialEndsLabel: '10/12',
  trialDaysLeft: 25, trialMonthlyImages: 20, currentPeriodEndsAt: null, currentPeriodEndsLabel: null, canSend: true, canGenerate: true,
  blockedReason: null, dataRetentionDays: 90, stripeReady: true, portalAvailable: false, plans: [],
  paymentFailure: null,
}

describe('課金の札と帯', () => {
  it('左下の札は状態ごとに1語、課金対象外は出さない', () => {
    expect(billingChip(base)).toEqual({ label: '無料トライアル', tone: 'warn' })
    expect(billingChip({ ...base, state: 'active', planName: 'スタンダード' })).toEqual({ label: 'スタンダード', tone: 'ok' })
    expect(billingChip({ ...base, state: 'trial_expired' })?.tone).toBe('danger')
    expect(billingChip({ ...base, state: 'exempt' })).toBeNull()
    expect(trialDaysLabel(base)).toBe('残り25日')
    expect(trialDaysLabel({ ...base, state: 'active' })).toBeNull()
  })

  it('契約状況の帯は期限と残り日数、止まった理由と保持日数を言う', () => {
    expect(billingBanner(base).title).toBe('無料トライアル中（10/12 まで・残り25日）')
    expect(billingBanner(base).tone).toBe('warn')
    const expired = billingBanner({ ...base, state: 'trial_expired' })
    expect(expired.tone).toBe('danger')
    expect(expired.body).toContain('90日間')
    expect(billingBanner({ ...base, state: 'active', planName: 'ライト', currentPeriodEndsLabel: '11/1' }).title).toBe('ライトを契約中（次回の更新 11/1）')
    expect(billingBanner({ ...base, state: 'exempt' }).title).toBe('課金の対象外です')
  })

  it('未払い中は停止日時を示し、期限後は一時停止と再開方法を示す', () => {
    const failure = { failedAt: '2026-11-09T03:00:00Z', graceDeadlineAt: '2026-11-16T03:00:00Z', state: 'grace' as const }
    expect(billingBanner({ ...base, state: 'past_due', paymentFailure: failure }).body).toContain('2026年11月16日')
    expect(billingBanner({ ...base, state: 'payment_suspended', paymentFailure: { ...failure, state: 'suspended' } }).body).toContain('再開')
    expect(billingChip({ ...base, state: 'payment_suspended' })?.label).toBe('利用を一時停止中')
  })

  it('金額は円の桁区切り', () => {
    expect(yen(29800)).toBe('¥29,800')
  })

  it.each([['month', '月払い'], ['year', '年払い']] as const)('契約中は %s と更新日を表示する', (planInterval, label) => {
    const summary = { ...base, state: 'active' as const, planInterval, planName: 'プロ', currentPeriodEndsLabel: '9/13' }
    expect(billingBanner(summary).title).toBe(`プロを契約中（${label}・次回の更新 9/13）`)
    expect(billingBanner({ ...summary, state: 'past_due' }).title).toContain(label)
  })
})
