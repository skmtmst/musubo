import { formatYen as yen } from '@line-crm/shared';
import { PRODUCT_SCOPE } from '@/lib/product-scope'
/**
 * 統括の課金（★管理画面 36-2）の型と小さな計算。API の形は `apps/worker/src/routes/hq-billing.ts` が正本。
 */

export type BillingState = 'exempt' | 'trialing' | 'active' | 'past_due' | 'payment_suspended' | 'trial_expired' | 'canceled'
export type PlanKey = 'light' | 'standard' | 'pro'
export type BillingInterval = 'month' | 'year'

export interface BillingPlanView {
  key: PlanKey
  name: string
  description: string
  cta: 'checkout' | 'contact'
  monthlyYen: number
  yearlyYen: number
  priceFromStripe: boolean
  yearlyPriceFromStripe: boolean
  monthlyImages: number
  maxStaff: number | null
  features: string[]
  recommended: boolean
  /** Stripe の鍵と価格 ID がそろっていて申し込めるか。 */
  available: boolean
  yearlyAvailable: boolean
  current: boolean
}

export interface BillingSummary {
  state: BillingState
  planKey: PlanKey | null
  planInterval: BillingInterval | null
  planName: string | null
  planStatus: 'exempt' | 'trialing' | 'active' | 'past_due' | 'canceled'
  trialEndsAt: string | null
  trialEndsLabel: string | null
  trialDaysLeft: number | null
  trialMonthlyImages: number
  currentPeriodEndsAt: string | null
  currentPeriodEndsLabel: string | null
  canSend: boolean
  canGenerate: boolean
  blockedReason: string | null
  paymentFailure: {
    failedAt: string
    graceDeadlineAt: string
    state: 'grace' | 'suspended'
  } | null
  dataRetentionDays: number
  stripeReady: boolean
  portalAvailable: boolean
  plans: BillingPlanView[]
  newPricing?: {
    status: 'awaiting_first_line' | 'trialing' | 'active' | 'past_due' | 'ended'
    billingInterval: BillingInterval
    activeLines: Array<{ id: string; name: string }>
    trialLastFreeDate: string | null
    firstChargeDate: string | null
    estimatedPrice: {
      monthlyTotalYen: number
      annualLineChargeYen: number
      optionsMonthlyYen: number
      lineBasicMonthlyYen: number
      headquartersMonthlyYen: number
      friendOverageMonthlyYen: number
      linkedAccountSlotsMonthlyYen: number
    } | null
    contractedCore: { lineCapacity: number; amountYen: number; interval: BillingInterval } | null
    quoteId: string | null
  }
}

export type BillingPaymentFailureView = {
  invoiceId: string
  amountYen: number
  invoiceCreatedAt: string
  failedAt: string
  graceDeadlineAt: string
  state: 'grace' | 'suspended'
  paymentUrl: string | null
} | {
  invoiceId: string
  amountYen: number
  invoiceCreatedAt: string
  graceDeadlineAt: string
  paidAt: string
  nextChargeAt: string | null
  state: 'recovered'
  paymentUrl: null
}

export interface BillingInvoice {
  id: string
  number: string | null
  status: string | null
  amountYen: number
  currency: string
  createdAt: string
  description: string | null
  hostedUrl: string | null
  pdfUrl: string | null
}

/** 左下の札と 36-2 の帯に出す短い呼び名。 */
export function billingChip(summary: Pick<BillingSummary, 'state' | 'planName' | 'trialDaysLeft'>): { label: string; tone: 'warn' | 'ok' | 'danger' | 'neutral' } | null {
  switch (summary.state) {
    case 'trialing':
      return { label: '無料トライアル', tone: 'warn' }
    case 'active':
      return { label: summary.planName ?? '契約中', tone: 'ok' }
    case 'past_due':
      return { label: '支払いを確認中', tone: 'danger' }
    case 'payment_suspended':
      return { label: '利用を一時停止中', tone: 'danger' }
    case 'trial_expired':
      return { label: 'トライアル終了', tone: 'danger' }
    case 'canceled':
      return { label: '契約終了', tone: 'neutral' }
    default:
      return null
  }
}

/** 「残り25日」。トライアル中だけ。 */
export function trialDaysLabel(summary: Pick<BillingSummary, 'state' | 'trialDaysLeft'>): string | null {
  if (summary.state !== 'trialing' || summary.trialDaysLeft === null) return null
  return `残り${summary.trialDaysLeft}日`
}

/** 契約状況の帯。見出し・本文・色。 */
export function billingBanner(summary: BillingSummary): { tone: 'info' | 'warn' | 'danger'; title: string; body: string } {
  const keep = `データは${summary.dataRetentionDays}日間保持されます。`
  const interval = summary.planInterval === 'year' ? '年払い' : summary.planInterval === 'month' ? '月払い' : null
  const renewal = [interval, summary.currentPeriodEndsLabel ? `次回の更新 ${summary.currentPeriodEndsLabel}` : null].filter(Boolean).join('・')
  switch (summary.state) {
    case 'exempt':
      return { tone: 'info', title: '課金の対象外です', body: 'この統括は運営用のため、料金はかかりません。プランの内容はここで確認できます。' }
    case 'trialing':
      return {
        tone: 'warn',
        title: `無料トライアル中（${summary.trialEndsLabel ?? '—'} まで・残り${summary.trialDaysLeft ?? '—'}日）`,
        body: `${PRODUCT_SCOPE.trial} ${PRODUCT_SCOPE.boundaries} 期限までにプランを選ぶと、そのまま使い続けられます。選ばなかった場合は配信と生成が止まり、${keep}`,
      }
    case 'active':
      return {
        tone: 'info',
        title: `${summary.planName ?? 'プラン'}を契約中${renewal ? `（${renewal}）` : ''}`,
        body: 'プランの変更・支払い方法・解約は「支払い方法を管理」から行えます。',
      }
    case 'past_due':
      return {
        tone: 'danger',
        title: `支払いを確認できていません${interval ? `（${interval}）` : ''}`,
        body: `カードの期限切れなどで引き落としができていません。「支払い方法を管理」から更新してください。${summary.paymentFailure ? `お支払いを確認できない場合、${new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'long', timeStyle: 'short' }).format(new Date(summary.paymentFailure.graceDeadlineAt))}に配信とバナー生成を一時停止します。` : 'お支払い状況を確認しています。'}`,
      }
    case 'payment_suspended':
      return {
        tone: 'danger',
        title: 'お支払いが確認できないため利用を一時停止しています',
        body: '配信とバナー生成を一時停止しています。未払いのお支払いを完了すると再開します。保存済みの設定や請求履歴は確認できます。',
      }
    case 'trial_expired':
      return { tone: 'danger', title: '無料トライアルが終了しました', body: `配信とバナー生成が止まっています。プランを選ぶとすぐ再開します。${keep}` }
    case 'canceled':
      return { tone: 'danger', title: '契約が終了しています', body: `配信とバナー生成が止まっています。プランを選ぶとすぐ再開します。${keep}` }
  }
}

export { yen };

/** 表示も申込み可否も、選んだ周期だけを見る。月払いへの暗黙の代替はしない。 */
export function billingPlanPrice(plan: BillingPlanView, interval: BillingInterval) {
  return interval === 'year'
    ? { monthlyYen: Math.floor(plan.yearlyYen / 12), yearlyYen: plan.yearlyYen, fromStripe: plan.yearlyPriceFromStripe, available: plan.yearlyAvailable }
    : { monthlyYen: plan.monthlyYen, yearlyYen: null, fromStripe: plan.priceFromStripe, available: plan.available }
}

/**
 * R607：選んだ周期の料金の出所。Stripe取得済みだけ・混在・代替だけの3つ。
 * 月と年は別々に取得するため、必ず `interval` で選んだ側だけを見る。
 */
export type BillingPriceSource = 'stripe' | 'mixed' | 'fallback'

export function billingPriceSource(plans: BillingPlanView[], interval: BillingInterval): BillingPriceSource {
  if (plans.length === 0) return 'fallback'
  const fromStripe = plans.map((plan) => billingPlanPrice(plan, interval).fromStripe)
  if (fromStripe.every(Boolean)) return 'stripe'
  if (fromStripe.some(Boolean)) return 'mixed'
  return 'fallback'
}

/**
 * R607：料金とプラン内容の確定度を分けた注記のうち、料金と内容の部分。
 * Stripe取得済みの料金まで「仮置き」にしない。代替の料金だけ仮表示にする。
 */
export function billingPriceNote(plans: BillingPlanView[], interval: BillingInterval): string {
  switch (billingPriceSource(plans, interval)) {
    case 'stripe':
      return '料金は Stripe の価格です。プランの内容は仮置きです。'
    case 'mixed':
      return 'Stripe から取得できた料金はそのまま表示し、取得できなかった料金には「仮の料金」と表示しています。プランの内容は仮置きです。'
    case 'fallback':
      return '料金と内容は仮置きです。'
  }
}

export const INVOICE_STATUS_LABELS: Record<string, string> = {
  paid: '支払い済み',
  open: '未払い',
  draft: '下書きの請求',
  void: '取り消し',
  uncollectible: '回収不能',
}
