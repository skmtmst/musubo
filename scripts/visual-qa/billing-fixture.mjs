/** ローカルの表示確認だけに使う料金。鍵・価格ID・外部決済は持たない。 */
export const BILLING_SUMMARY = {
  /* 絵 `JB8V1`：スタンダードを月払いで契約中（使うのは請求の画面と左下の札だけ）。 */
  state: 'active', planKey: 'standard', planInterval: 'month', planName: 'スタンダード', planStatus: 'active',
  trialEndsAt: null, trialEndsLabel: null, trialDaysLeft: null,
  trialMonthlyImages: 20, currentPeriodEndsAt: '2026-11-01T00:00:00.000Z', currentPeriodEndsLabel: '11/1（日）',
  canSend: true, canGenerate: true, blockedReason: null, dataRetentionDays: 90,
  stripeReady: true, portalAvailable: true,
  plans: [
    { key: 'light', name: 'ライト', description: '1店舗で始める', monthlyYen: 9800, yearlyYen: 99000,
      monthlyImages: 50, maxStaff: 3, recommended: false,
      features: ['LINE公式アカウント 1', '権限者 3人', '配信 月 5,000通', 'バナー生成 月 50枚', '登録メディア 5GB'] },
    { key: 'standard', name: 'スタンダード', description: '複数店舗をまとめて運用', monthlyYen: 29800, yearlyYen: 303000,
      monthlyImages: 150, maxStaff: 10, recommended: true,
      features: ['LINE公式アカウント 5', '権限者 10人', '配信 月 30,000通', 'バナー生成 月 150枚', '登録メディア 30GB', '統括ひな形の配布'] },
    { key: 'pro', name: 'プロ', description: '本部主導で大きく回す', monthlyYen: 59800, yearlyYen: 609000,
      monthlyImages: 500, maxStaff: null, recommended: false,
      features: ['LINE公式アカウント 無制限', '権限者 無制限', '配信 月 100,000通', 'バナー生成 月 500枚', '登録メディア 200GB', '優先サポート・API'] },
  ].map((plan) => ({ ...plan, cta: 'checkout', available: true, yearlyAvailable: true, priceFromStripe: true, yearlyPriceFromStripe: true, current: plan.key === 'standard' })),
}

/** 絵 `JB8V1` の支払い履歴（請求中1件・支払い済み2件）。 */
export const BILLING_INVOICES = [
  { id: 'in_visual_202610', number: 'VQ-202610', status: 'open', amountYen: 29800, currency: 'jpy', createdAt: '2026-10-01T00:00:00+09:00', description: 'スタンダード 10月分', hostedUrl: null, pdfUrl: null },
  { id: 'in_visual_202609', number: 'VQ-202609', status: 'paid', amountYen: 29800, currency: 'jpy', createdAt: '2026-09-01T00:00:00+09:00', description: 'スタンダード 9月分', hostedUrl: 'https://example.com/invoices/202609', pdfUrl: null },
  { id: 'in_visual_202608', number: 'VQ-202608', status: 'paid', amountYen: 29800, currency: 'jpy', createdAt: '2026-08-01T00:00:00+09:00', description: 'スタンダード 8月分', hostedUrl: 'https://example.com/invoices/202608', pdfUrl: null },
]

export const BILLING_METRICS = {
  period: {}, unavailable: {}, thisMonthBilledYen: 29800, contractCount: 1, contractUnit: 'organization',
  activeAccountCount: 5, contractAccountCount: null, trialCount: 0, unpaidInvoiceCount: 1,
  paymentFailureCount: null, nextBillingAt: '2026-11-01T00:00:00+09:00', source: 'stored_invoices',
  observedInvoiceCount: BILLING_INVOICES.length, lastSyncedAt: null,
}
