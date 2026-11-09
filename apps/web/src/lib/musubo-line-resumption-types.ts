type Interval = 'month' | 'year'

interface LineResumeOptions {
  friendCount: number; measuredOn: string; friendBlocks: number; linkedSlots: number
  friendOverageMonthlyYen: number; linkedSlotsMonthlyYen: number
  optionsMonthlyYen: number; optionsChargeAt: string | null
  optionsDueNowYen: number; totalDueNowYen: number
}

export type LineResumeReviewView =
  | ({ kind: 'trial_remaining'; conditionName: string; freeUntil: string; nextChargeAt: string; nextLineBaseYen: number; trialPeriodLabel: string; interval: Interval; options?: LineResumeOptions })
  | { kind: 'monthly_paid'; conditionName: string; paidThrough: string; renewalAt: string; nextLineBaseYen: number; options?: LineResumeOptions }
  | { kind: 'annual_paid'; conditionName: string; paidThrough: string; renewalAt: string; nextAnnualLineBaseYen: number; options?: LineResumeOptions }
  | { kind: 'paid_expired'; conditionName: string; interval: Interval; dueOnConnectionYen: number; nextLineBaseYen: number; options?: LineResumeOptions }
  | { kind: 'unpaid'; amountDueYen: number; invoiceAt: string; periodStart: string; periodEnd: string }

export type LineResumeCompleteView =
  | { kind: 'trial_remaining'; restartedAt: string; freeUntil: string; nextChargeAt: string; nextLineBaseYen: number; interval: Interval; chargedNowYen?: number; optionsMonthlyYen?: number }
  | { kind: 'monthly_paid'; restartedAt: string; paidThrough: string; renewalAt: string; nextLineBaseYen: number; chargedNowYen?: number; optionsMonthlyYen?: number }
  | { kind: 'annual_paid'; restartedAt: string; paidThrough: string; renewalAt: string; nextAnnualLineBaseYen: number; chargedNowYen?: number; optionsMonthlyYen?: number }
  | { kind: 'paid'; restartedAt: string; chargedNowYen: number; nextChargeAt: string; nextLineBaseYen: number; interval: Interval; optionsMonthlyYen?: number }
