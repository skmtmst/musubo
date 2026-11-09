import { getMusuboTenantBilling, type TenantBilling, type MusuboTenantBillingRecord } from '@line-crm/db';
import type { FeatureEntitlementKey } from '@line-crm/shared';
import { logger } from '@line-crm/shared/server';
import { getBillingPaymentFailure } from './billing-payment-failure.js';

/**
 * 金額は Stripe の価格を正本とし、取得できる場合は画面の仮表示より優先する。課金状態の意味は migration 291 を参照する。
 */

export type PlanKey = 'light' | 'standard' | 'pro';
export type BillingInterval = 'month' | 'year';

interface BillingPriceEnv {
  STRIPE_PRICE_LIGHT?: string;
  STRIPE_PRICE_STANDARD?: string;
  STRIPE_PRICE_PRO?: string;
  STRIPE_PRICE_LIGHT_YEAR?: string;
  STRIPE_PRICE_STANDARD_YEAR?: string;
  STRIPE_PRICE_PRO_YEAR?: string;
}

export interface BillingPlan {
  key: PlanKey;
  name: string;
  /** 一言の説明。「1店舗で始める」など。 */
  description: string;
  /** 仮の月額（税込）。Stripe の価格が取れたらそちらを優先する。 */
  fallbackMonthlyYen: number;
  /** 仮の年額（税込）。月あたりは年額を12で割って切り捨てる。 */
  fallbackYearlyYen: number;
  /** バナー生成の月間枚数。 */
  monthlyImages: number;
  /** 配信の月間通数（features の「配信 月 N通」と同じ値。運営ダッシュボードの使用量に使う）。 */
  monthlyMessages: number;
  /** 登録メディアの容量（バイト）。features の「登録メディア NGB」と同じ値。 */
  mediaBytes: number;
  /** 権限者の上限。null は無制限。 */
  maxStaff: number | null;
  /** 画面に出す内容の箇条書き。 */
  features: string[];
  recommended?: boolean;
  /** ボタンの種類。3プランとも Stripe の申込画面へ。 */
  cta: 'checkout' | 'contact';
}

export const BILLING_PLANS: BillingPlan[] = [
  {
    key: 'light',
    name: 'ライト',
    description: '1店舗で始める',
    fallbackMonthlyYen: 9800,
    fallbackYearlyYen: 99000,
    monthlyImages: 50,
    monthlyMessages: 5_000,
    mediaBytes: 5 * 1024 ** 3,
    maxStaff: 3,
    features: ['LINE公式アカウント 1', '権限者 3人', '配信 月 5,000通', 'バナー生成 月 50枚', '登録メディア 5GB'],
    cta: 'checkout',
  },
  {
    key: 'standard',
    name: 'スタンダード',
    description: '複数店舗をまとめて運用',
    fallbackMonthlyYen: 29800,
    fallbackYearlyYen: 303000,
    monthlyImages: 150,
    monthlyMessages: 30_000,
    mediaBytes: 30 * 1024 ** 3,
    maxStaff: 10,
    features: ['LINE公式アカウント 5', '権限者 10人', '配信 月 30,000通', 'バナー生成 月 150枚', '登録メディア 30GB', '統括ひな形の配布'],
    recommended: true,
    cta: 'checkout',
  },
  {
    key: 'pro',
    name: 'プロ',
    description: '本部主導で大きく回す',
    fallbackMonthlyYen: 59800,
    fallbackYearlyYen: 609000,
    monthlyImages: 500,
    monthlyMessages: 100_000,
    mediaBytes: 200 * 1024 ** 3,
    maxStaff: null,
    features: ['LINE公式アカウント 無制限', '権限者 無制限', '配信 月 100,000通', 'バナー生成 月 500枚', '登録メディア 200GB', '優先サポート・API'],
    cta: 'checkout',
  },
];

export const TRIAL_DAYS = 30;
export const TRIAL_MONTHLY_IMAGES = 20;
/** トライアル終了・解約後にデータを残す日数（画面の案内に使う）。 */
export const DATA_RETENTION_DAYS = 90;
/** 課金対象外（運営）のときの生成上限の既定。`BANNER_MONTHLY_IMAGES` で上書きできる。 */
export const EXEMPT_MONTHLY_IMAGES = 150;

export function findPlan(key: string | null | undefined): BillingPlan | null {
  if (!key) return null;
  return BILLING_PLANS.find((p) => p.key === key) ?? null;
}

/** Stripe の価格 ID → プランと周期。価格 ID は env（値は Git に書かない）。 */
export function planKeyForPrice(
  env: BillingPriceEnv,
  priceId: string | null | undefined,
): { key: PlanKey; interval: BillingInterval } | null {
  if (!priceId) return null;
  for (const plan of BILLING_PLANS) {
    for (const interval of ['month', 'year'] as const) {
      if (priceIdForPlan(env, plan.key, interval) === priceId) return { key: plan.key, interval };
    }
  }
  return null;
}

export function priceIdForPlan(
  env: BillingPriceEnv,
  key: PlanKey,
  interval: BillingInterval = 'month',
): string | null {
  if (interval === 'year') {
    const id = key === 'light' ? env.STRIPE_PRICE_LIGHT_YEAR : key === 'standard' ? env.STRIPE_PRICE_STANDARD_YEAR : env.STRIPE_PRICE_PRO_YEAR;
    return id || null;
  }
  const id = key === 'light' ? env.STRIPE_PRICE_LIGHT : key === 'standard' ? env.STRIPE_PRICE_STANDARD : env.STRIPE_PRICE_PRO;
  return id || null;
}

export type EntitlementState = 'exempt' | 'trialing' | 'active' | 'past_due' | 'payment_suspended' | 'trial_expired' | 'canceled';

export interface Entitlements {
  state: EntitlementState;
  /** 配信（一斉配信・シナリオ・リマインダ・自動応答）ができるか。 */
  canSend: boolean;
  /** バナー生成ができるか。 */
  canGenerate: boolean;
  /** バナー生成の月間枚数。 */
  monthlyImages: number;
  /** 止まっているときの理由。運用者に出す文。 */
  blockedReason: string | null;
  /** トライアルの残り日数（トライアル中だけ）。 */
  trialDaysLeft: number | null;
  plan: BillingPlan | null;
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const normalized = value.replace(' ', 'T');
  const date = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized) ? normalized : `${normalized}+09:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * 統括の課金状態から、いま何ができるかを決める。
 *
 * - exempt: 何も止めない（運営・移行前の統括）
 * - trialing: 期限内なら全部使える。過ぎたら trial_expired として止める
 * - active: 全部使える
 * - past_due: 請求失敗から7日間は使える。期限後だけ配信と生成を止める
 * - canceled: 配信と生成を止め、閲覧はできる
 */
export function resolveEntitlements(
  billing: Pick<TenantBilling, 'plan_key' | 'plan_status' | 'trial_ends_at'> | null,
  options: { exemptMonthlyImages?: number; now?: Date; paymentSuspended?: boolean } = {},
): Entitlements {
  const now = options.now ?? new Date();
  const exemptImages = options.exemptMonthlyImages ?? EXEMPT_MONTHLY_IMAGES;
  const plan = findPlan(billing?.plan_key);
  const allowed = (state: EntitlementState, monthlyImages: number, trialDaysLeft: number | null = null): Entitlements => ({
    state,
    canSend: true,
    canGenerate: true,
    monthlyImages,
    blockedReason: null,
    trialDaysLeft,
    plan,
  });
  const blocked = (state: EntitlementState, reason: string): Entitlements => ({
    state,
    canSend: false,
    canGenerate: false,
    monthlyImages: 0,
    blockedReason: reason,
    trialDaysLeft: null,
    plan,
  });

  if (!billing || billing.plan_status === 'exempt') return allowed('exempt', exemptImages);
  if (billing.plan_status === 'active') return allowed('active', plan?.monthlyImages ?? exemptImages);
  if (billing.plan_status === 'past_due') return options.paymentSuspended
    ? blocked('payment_suspended', '未払いのお支払いから7日が経過したため、配信とバナー生成を一時停止しています。請求画面からお支払いを完了すると再開します')
    : allowed('past_due', plan?.monthlyImages ?? exemptImages);
  if (billing.plan_status === 'canceled') {
    return blocked('canceled', '契約が終了しているため、配信とバナー生成は止まっています。課金プランからプランを選ぶと再開します');
  }
  // trialing
  const ends = parseDate(billing.trial_ends_at);
  if (ends && ends.getTime() > now.getTime()) {
    const daysLeft = Math.max(Math.ceil((ends.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)), 0);
    return allowed('trialing', TRIAL_MONTHLY_IMAGES, daysLeft);
  }
  return blocked('trial_expired', '無料トライアルが終了したため、配信とバナー生成は止まっています。課金プランからプランを選ぶと再開します');
}

/** 請求書IDを伴う失敗通知がある場合だけ7日後の停止を適用する。 */
export async function resolveTenantEntitlements(
  db: D1Database,
  billing: TenantBilling | null,
  options: { exemptMonthlyImages?: number; now?: Date } = {},
): Promise<Entitlements> {
  // 新料金で作った統括だけを追加で読む。旧契約の全APIにD1往復を増やさない。
  if (billing?.plan_key === 'musubo') {
    const musubo = await getMusuboTenantBilling(db, billing.id);
    if (musubo) return resolveMusuboEntitlements(db, musubo, options);
  }
  if (billing?.plan_status !== 'past_due') return resolveEntitlements(billing, options);
  try {
    const failure = await getBillingPaymentFailure(db, billing, options.now);
    return resolveEntitlements(billing, { ...options, paymentSuspended: failure?.state === 'suspended' });
  } catch {
    logger.warn('billing_payment_failure_state_unavailable');
    return resolveEntitlements(billing, options);
  }
}

async function resolveMusuboEntitlements(db: D1Database, billing: MusuboTenantBillingRecord,
  options: { exemptMonthlyImages?: number; now?: Date }): Promise<Entitlements> {
  const now = options.now ?? new Date();
  const blocked = (state: EntitlementState, reason: string): Entitlements => ({
    state, canSend: false, canGenerate: false, monthlyImages: 0,
    blockedReason: reason, trialDaysLeft: null, plan: null,
  });
  const allowed = (state: EntitlementState, trialDaysLeft: number | null = null): Entitlements => ({
    state, canSend: true, canGenerate: true,
    monthlyImages: options.exemptMonthlyImages ?? EXEMPT_MONTHLY_IMAGES,
    blockedReason: null, trialDaysLeft, plan: null,
  });
  if (billing.status === 'awaiting_first_line') {
    return blocked('trial_expired', 'LINEの接続を完了すると利用を開始できます');
  }
  if (billing.status === 'ended') return blocked('canceled', 'LINEの利用を終了しています');
  if (!billing.core_subscription_id || !billing.options_subscription_id || !billing.first_charge_date) {
    return blocked('trial_expired', '請求の準備を確認中です。運営にお問い合わせください');
  }
  if (billing.status === 'trialing') {
    const firstCharge = Date.parse(`${billing.first_charge_date}T00:00:00+09:00`);
    if (!Number.isFinite(firstCharge) || now.getTime() >= firstCharge) {
      return blocked('trial_expired', '無料期間が終了しました。お支払いの確認をお待ちください');
    }
    return allowed('trialing', Math.max(1, Math.ceil((firstCharge - now.getTime()) / 86_400_000)));
  }
  if (billing.status === 'active') return allowed('active');
  const failure = await getBillingPaymentFailure(db, {
    id: billing.tenant_id, plan_status: 'past_due', stripe_subscription_id: billing.core_subscription_id,
  }, now);
  if (!failure) return blocked('payment_suspended', '未払いの確認が必要です。請求画面からお支払いを確認してください');
  return failure.state === 'suspended'
    ? blocked('payment_suspended', '未払いから7日が経過したため、配信とバナー生成を一時停止しています')
    : allowed('past_due');
}

/** 共有カタログの契約キーを、既存の料金プラン判定へ接続する。 */
export function featureContractIsAvailable(
  entitlements: Pick<Entitlements, 'canSend'>,
  entitlementKey: FeatureEntitlementKey,
): boolean {
  return entitlementKey === 'send' ? entitlements.canSend : true;
}

/** 「10/12 まで」の形。画面の札に使う。 */
export function formatJstMonthDay(value: string | null): string | null {
  const date = parseDate(value);
  if (!date) return null;
  const parts = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('month')}/${get('day')}`;
}
