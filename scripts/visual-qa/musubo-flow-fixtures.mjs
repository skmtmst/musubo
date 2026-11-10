export function musuboFlowRead(method, pathname) {
  // Billing/onboarding routes are included in the all-screen presentation audit.
  // Keep one coherent company and quote so the audit sees the actual flow screens.
  if (method === 'GET') {
    const quote = {
      quoteNumber: 'MQ-VISUAL-01', companyName: 'Shed Products株式会社',
      issuedAt: '2026-09-30T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z',
      acceptedAt: null, supersededAt: null, interval: 'month', plannedLineCount: 11,
      plannedFriendCountExcludingBlocked: 28_000, plannedLinkedAccountsByLine: [],
      trialPeriod: { unit: 'days', value: 30 },
      finalSchedule: { firstLineYen: 5_900, secondToFifthLineYen: 7_900,
        sixthToTenthLineYen: 6_900, eleventhAndLaterLineYen: 6_000,
        headquartersYen: 5_500, linkedAccountSlotYen: 3_300,
        extraFriendBlockYen: 1_100, extraFriendBlockSize: 10_000,
        friendAllowanceForElevenOrMore: 50_000 }, finalAnnualLineChargeYen: null,
    }
    if (pathname === '/api/hq/billing/musubo/line-addition') return { success: true, data: {
      price: { addedLineOrdinal: 2, coreIncrementYen: 7_900, coreIncrementInterval: 'month',
        headquartersIncrementMonthlyYen: 5_500, dueNowYen: 6_700, contractedLineCapacity: 0 },
      activeLineCount: 1, recurringAfter: { coreYen: 13_800, coreInterval: 'month', optionsYen: 5_500 },
      pending: { id: 'visual-addition', status: 'awaiting_payment', amountDueYen: 6_700,
        expiresAt: '2027-01-20T09:00:00.000Z', canConnect: false, activationPending: false,
        paymentUrl: null },
    } }
    if (pathname === '/api/hq/billing/payment-failure') return { success: true, data: {
      invoiceId: 'in_visual_01', amountYen: 5_900,
      invoiceCreatedAt: '2026-11-09T00:00:00.000Z', failedAt: '2026-11-09T00:00:00.000Z',
      graceDeadlineAt: '2026-11-16T00:00:00.000Z', state: 'grace', paymentUrl: null,
    } }
    if (pathname === '/api/hq/billing/musubo/resumption') return { success: true, data: {
      review: { kind: 'paid_expired', conditionName: '通常条件', interval: 'month',
        dueOnConnectionYen: 5_900, nextLineBaseYen: 5_900 },
      consented: true, reconciliationPending: false, payment: null,
    } }
    if (pathname === '/api/hq/billing/musubo/resumption/complete') return { success: true, data: {
      kind: 'paid', restartedAt: '2026-11-10T00:00:00.000Z', chargedNowYen: 5_900,
      nextChargeAt: '2026-12-10T00:00:00.000Z', nextLineBaseYen: 5_900,
      interval: 'month', optionsMonthlyYen: 0,
    } }
    if (pathname === '/api/hq/billing/card-status') return { success: true, data: { registered: true } }
    if (pathname === '/api/hq/onboarding/quotes/MQ-VISUAL-01') return { success: true, data: {
      quote, access: 'available', cardRegistrationAvailable: false,
    } }
    if (pathname === '/api/ops/applications/visual-qa-application') return { success: true, data: {
      id: 'visual-qa-application', company_name: quote.companyName, contact_name: '山田 太郎',
      email: 'visual@example.com', phone: '03-0000-0000', referral_source: '紹介',
      status: 'contacted', contact_note: null, contacted_at: '2026-11-01T00:00:00.000Z',
      approved_at: null, invite_sent_at: null, tenant_id: null, pricing_snapshot_json: null,
      created_at: '2026-11-01T00:00:00.000Z',
    } }
    if (pathname === '/api/ops/applications/visual-qa-application/quotes') return {
      success: true, data: [{ quote, status: 'draft', revision: 1, sentAt: null, sendClaimedAt: null }],
    }
  }
  return null
}
