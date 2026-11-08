import { logger } from '@line-crm/shared/server';
import { mapStripeSubscriptionStatus } from './hq-subscription-status.js';
export { mapStripeSubscriptionStatus } from './hq-subscription-status.js';
import { hqBillingMetrics } from '../features/hq-billing/hq-billing-metrics/index.js';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { Hono, type Context } from 'hono'
import {
  getStaffById,
  getTenantBilling,
  getTenantBillingByStripeCustomer,
  prepareTenantBillingUpdate,
  prepareBillingInvoice,
  toJstString,
  updateTenantBilling,
  type TenantBilling,
  type TenantPlanStatus,
} from '@line-crm/db';

import type { Env } from '../worker-env.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { requireRole } from '../middleware/role-guard.js';
import {
  BILLING_PLANS,
  DATA_RETENTION_DAYS,
  TRIAL_MONTHLY_IMAGES,
  findPlan,
  formatJstMonthDay,
  planKeyForPrice,
  priceIdForPlan,
  resolveEntitlements,
  type BillingInterval,
  type PlanKey,
} from '../services/billing-plans.js';
import { billingInvoiceInput } from '../services/billing-invoices-sync.js';
import { getBillingPaymentFailure } from '../services/billing-payment-failure.js';
import { deliverBillingRecoveryNotice, deliverCurrentBillingFailureNotice } from '../services/billing-invoice-notifications.js';
import { StripeApiError, stripeApi, type StripeInvoice, type StripeSubscription } from '../services/stripe-api.js';
import { MAX_STRIPE_WEBHOOK_BODY_BYTES, readBodyWithinLimit, verifyStripeSignature } from '../services/stripe-signature.js';

/**
 * 統括の課金（★36-2）。Stripe のサブスクリプション。
 *
 * - `summary`: いまの契約状態とプラン一覧（金額は Stripe の価格が取れればそちら）
 * - `checkout`: Stripe Checkout（申込画面）の URL を作る。オーナーだけ
 * - `portal`: 支払い方法・解約は Stripe のカスタマーポータルに任せる
 * - `invoices`: 支払い履歴（Stripe から読む）
 * - `webhook`: Stripe からの通知。署名で確かめ、イベントIDで二度処理しない
 *
 * 鍵と価格IDは env（`STRIPE_SECRET_KEY`、`STRIPE_BILLING_WEBHOOK_SECRET`、`STRIPE_PRICE_*`）。
 * 値はここにも Git にも書かない。
 */
export const hqBilling = new Hono<Env>();

function tenantOf(c: Context<Env>): string {
  return c.get('staff')?.tenantId ?? DEFAULT_TENANT_ID;
}

function exemptMonthlyImages(c: Context<Env>): number | undefined {
  const raw = Number(c.env.BANNER_MONTHLY_IMAGES ?? '');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
}

/** 管理画面の URL。Checkout から戻る先に使う。`ADMIN_ORIGIN` の先頭。 */
function adminOrigin(c: Context<Env>): string | null {
  const first = (c.env.ADMIN_ORIGIN ?? '').split(',').map((s) => s.trim()).find(Boolean);
  return first ?? null;
}

function stripeReady(c: Context<Env>): boolean {
  return Boolean(c.env.STRIPE_SECRET_KEY);
}

function periodEndIso(subscription: Pick<StripeSubscription, 'current_period_end' | 'items'>): string | null {
  const periodEnd = subscription.current_period_end ?? subscription.items?.data?.[0]?.current_period_end;
  return periodEnd ? new Date(periodEnd * 1000).toISOString() : null;
}

function subscriptionPatch(c: Context<Env>, tenant: TenantBilling, subscription: StripeSubscription) {
  if (subscription.status === 'incomplete') {
    return {
      stripe_subscription_id: subscription.id,
      stripe_customer_id: subscription.customer,
    };
  }
  const priceId = subscription.items?.data?.[0]?.price?.id ?? null;
  const planKey = planKeyForPrice(c.env, priceId)?.key ?? (subscription.metadata?.plan_key as PlanKey | undefined) ?? tenant.plan_key;
  const planStatus = mapStripeSubscriptionStatus(subscription.status);
  return {
    plan_key: planKey ?? null,
    plan_status: planStatus ?? tenant.plan_status,
    stripe_subscription_id: subscription.id,
    stripe_customer_id: subscription.customer,
    current_period_ends_at: periodEndIso(subscription),
    trial_ends_at: null,
  };
}

// ================================================================ summary

hqBilling.get('/api/hq/billing/metrics',requireRole('owner','admin'),async c=>{
  const actor=c.get('staff'),member=actor?await getStaffById(c.env.DB,actor.id):null;
  if(!actor?.tenantId||!member||member.is_active!==1||member.tenant_id!==actor.tenantId||member.account_scope==='accounts'||(!['owner','admin'].includes(member.role)&&!actor.hqRole))return c.json({success:false,error:'統括の閲覧権限が必要です'},403);
  const data=await hqBillingMetrics(c.env.DB,actor.tenantId);
  return data?c.json({success:true,data}):c.json({success:false,error:'統括が見つかりません'},404);
});

hqBilling.get('/api/hq/billing/summary', async (c) => {
  try {
    const tenantId = tenantOf(c);
    const billing = await getTenantBilling(c.env.DB, tenantId);
    if (!billing) return c.json({ success: false, error: '統括が見つかりません' }, 404);
    const paymentFailure = await getBillingPaymentFailure(c.env.DB, billing).catch(() => null);
    const entitlements = resolveEntitlements(billing, {
      exemptMonthlyImages: exemptMonthlyImages(c),
      paymentSuspended: paymentFailure?.state === 'suspended',
    });

    // 金額は Stripe の価格が正本。取れなければ仮の表示。
    const readPrice = async (key: PlanKey, interval: BillingInterval): Promise<number | null> => {
      const priceId = priceIdForPlan(c.env, key, interval);
      if (!priceId || !stripeReady(c)) return null;
      try {
        const price = await stripeApi.retrievePrice(c.env, priceId);
        return price.currency === 'jpy' ? price.unit_amount ?? null : null;
      } catch {
        return null;
      }
    };
    // 周期は Stripe の契約の価格IDから読む。取得失敗時に月払いと決めつけない。
    const readInterval = async (): Promise<BillingInterval | null> => {
      if (!billing.stripe_subscription_id || !stripeReady(c)) return null;
      try {
        const subscription = await stripeApi.retrieveSubscription(c.env, billing.stripe_subscription_id);
        return planKeyForPrice(c.env, subscription.items?.data?.[0]?.price?.id)?.interval ?? null;
      } catch {
        return null;
      }
    };
    const [prices, planInterval] = await Promise.all([
      Promise.all(BILLING_PLANS.map(async (plan) => {
        const [month, year] = await Promise.all([readPrice(plan.key, 'month'), readPrice(plan.key, 'year')]);
        return { month, year };
      })),
      readInterval(),
    ]);

    return c.json({
      success: true,
      data: {
        state: entitlements.state,
        planKey: billing.plan_key,
        planInterval,
        planName: entitlements.plan?.name ?? null,
        planStatus: billing.plan_status,
        trialEndsAt: billing.trial_ends_at,
        trialEndsLabel: formatJstMonthDay(billing.trial_ends_at),
        trialDaysLeft: entitlements.trialDaysLeft,
        trialMonthlyImages: TRIAL_MONTHLY_IMAGES,
        currentPeriodEndsAt: billing.current_period_ends_at,
        currentPeriodEndsLabel: formatJstMonthDay(billing.current_period_ends_at),
        canSend: entitlements.canSend,
        canGenerate: entitlements.canGenerate,
        blockedReason: entitlements.blockedReason,
        paymentFailure: paymentFailure ? {
          failedAt: paymentFailure.failedAt,
          graceDeadlineAt: paymentFailure.graceDeadlineAt,
          state: paymentFailure.state,
        } : null,
        dataRetentionDays: DATA_RETENTION_DAYS,
        stripeReady: stripeReady(c),
        portalAvailable: stripeReady(c) && Boolean(billing.stripe_customer_id),
        plans: BILLING_PLANS.map((plan, index) => ({
          key: plan.key,
          name: plan.name,
          description: plan.description,
          cta: plan.cta,
          monthlyYen: prices[index].month ?? plan.fallbackMonthlyYen,
          yearlyYen: prices[index].year ?? plan.fallbackYearlyYen,
          priceFromStripe: prices[index].month !== null,
          yearlyPriceFromStripe: prices[index].year !== null,
          monthlyImages: plan.monthlyImages,
          maxStaff: plan.maxStaff,
          features: plan.features,
          recommended: Boolean(plan.recommended),
          available: stripeReady(c) && Boolean(priceIdForPlan(c.env, plan.key)),
          yearlyAvailable: stripeReady(c) && Boolean(priceIdForPlan(c.env, plan.key, 'year')),
          current: billing.plan_key === plan.key && (billing.plan_status === 'active' || billing.plan_status === 'past_due'),
        })),
      },
    });
  } catch (err) {
    throw err;
  }
});

/** 未払い請求の支払い先は請求管理権限を持つ担当者だけに返す。 */
hqBilling.get('/api/hq/billing/payment-failure', requireRole('owner', 'admin'), async (c) => {
  c.header('Cache-Control', 'no-store');
  const billing = await getTenantBilling(c.env.DB, tenantOf(c));
  if (!billing) return c.json({ success: false, error: '統括が見つかりません' }, 404);
  const failure = await getBillingPaymentFailure(c.env.DB, billing);
  return c.json({ success: true, data: failure });
});

// 即時変更を仮定した参考額だけを取得する。契約・顧客・DBは変更しない。
hqBilling.get('/api/hq/billing/preview', requireRole('owner', 'admin'), async (c) => {
  c.header('Cache-Control', 'no-store');
  const plan = findPlan(c.req.query('planKey'));
  const interval = c.req.query('interval');
  if (!plan || (interval !== 'month' && interval !== 'year')) {
    return c.json({ success: false, error: 'プランと月払いまたは年払いを選んでください' }, 400);
  }
  if (!stripeReady(c)) return c.json({ success: false, error: '決済の接続設定がまだありません。運営にお問い合わせください' }, 503);
  const priceId = priceIdForPlan(c.env, plan.key, interval);
  if (!priceId) return c.json({ success: false, error: 'このプランの価格がまだ設定されていません。運営にお問い合わせください' }, 503);
  try {
    const billing = await getTenantBilling(c.env.DB, tenantOf(c));
    if (!billing) return c.json({ success: false, error: '統括が見つかりません' }, 404);
    if (billing.plan_status === 'exempt' || !billing.stripe_subscription_id) {
      return c.json({ success: false, error: '変更できる契約がありません' }, 409);
    }
    const subscription = await stripeApi.retrieveSubscription(c.env, billing.stripe_subscription_id);
    const item = subscription.items.data[0];
    if (!['active', 'trialing', 'past_due'].includes(subscription.status)
      || subscription.customer !== billing.stripe_customer_id || subscription.items.data.length !== 1 || !item?.id) {
      return c.json({ success: false, error: 'この契約の見積りは支払い管理画面で確認してください' }, 409);
    }
    const quantity = item.quantity ?? 1;
    const price = await stripeApi.retrievePrice(c.env, priceId);
    if (price.currency !== 'jpy' || price.unit_amount === null || price.recurring?.interval !== interval) {
      return c.json({ success: false, error: '価格を確認できませんでした' }, 502);
    }
    const prorationDate = Math.floor(Date.now() / 1000);
    const preview = await stripeApi.createInvoicePreview(c.env, {
      subscriptionId: subscription.id, itemId: item.id, priceId, quantity, prorationDate,
    });
    if (preview.currency !== 'jpy' || preview.lines.has_more) {
      return c.json({ success: false, error: '見積りの明細を確認できませんでした' }, 502);
    }
    const prorationDifferenceYen = preview.lines.data
      .filter((line) => line.proration && line.period.start === prorationDate)
      .reduce((sum, line) => sum + line.amount, 0);
    const renewal = preview.lines.data.find((line) => !line.proration && line.type === 'subscription' && line.subscription_item === item.id);
    return c.json({ success: true, data: {
      planKey: plan.key, interval, afterAmountYen: price.unit_amount * quantity,
      amountDueYen: preview.amount_due, prorationDifferenceYen,
      nextBillingAt: renewal ? new Date(renewal.period.start * 1000).toISOString() : null,
      estimatedAt: new Date(prorationDate * 1000).toISOString(), isEstimate: true,
      notice: '参考。確定の金額と適用日は Stripe の支払いの画面で確かめます',
    } });
  } catch (error) {
    // Stripe の応答本文や顧客情報を返さない。
    if (error instanceof StripeApiError) logger.warn("routes_hq_billing_warn");
    return c.json({ success: false, error: '決済サービスの見積りを取得できませんでした。時間をおいてもう一度お試しください' }, 502);
  }
});

// ================================================================ card setup (no charge or subscription)

hqBilling.post('/api/hq/billing/card-setup', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  try {
    if (!stripeReady(c)) return c.json({ success: false, error: '決済の接続設定がまだありません。運営にお問い合わせください' }, 503);
    const origin = adminOrigin(c);
    if (!origin) return c.json({ success: false, error: '管理画面のURLが設定されていません' }, 503);
    const tenantId = tenantOf(c);
    const billing = await getTenantBilling(c.env.DB, tenantId);
    if (!billing) return c.json({ success: false, error: '統括が見つかりません' }, 404);
    if (billing.plan_status === 'exempt') return c.json({ success: false, error: 'この統括はカード登録の対象外です' }, 409);

    let customerId = billing.stripe_customer_id;
    if (!customerId) {
      const staff = c.get('staff');
      const member = staff?.id ? await getStaffById(c.env.DB, staff.id).catch(() => null) : null;
      const customer = await stripeApi.createCustomer(c.env, { name: billing.name, email: member?.email ?? null, tenantId });
      customerId = customer.id;
      await updateTenantBilling(c.env.DB, tenantId, { stripe_customer_id: customerId });
    }
    const session = await stripeApi.createCardSetupSession(c.env, {
      customerId, tenantId,
      successUrl: `${origin}/hq/onboarding/card?setup=success`,
      cancelUrl: `${origin}/hq/onboarding/card?setup=cancel`,
    });
    if (!session.url) return c.json({ success: false, error: 'カード登録画面のURLを作れませんでした' }, 502);
    return c.json({ success: true, data: { url: session.url } });
  } catch (error) {
    if (error instanceof StripeApiError) return c.json({ success: false, error: 'カード登録画面を開けませんでした。時間をおいてもう一度お試しください' }, 502);
    throw error;
  }
});

hqBilling.get('/api/hq/billing/card-status', requireRole('owner', 'admin'), async (c) => {
  try {
    const billing = await getTenantBilling(c.env.DB, tenantOf(c));
    if (!billing) return c.json({ success: false, error: '統括が見つかりません' }, 404);
    if (!billing.stripe_customer_id) return c.json({ success: true, data: { registered: false } });
    if (!stripeReady(c)) return c.json({ success: false, error: '決済の接続設定がまだありません' }, 503);
    const customer = await stripeApi.retrieveCustomer(c.env, billing.stripe_customer_id);
    return c.json({ success: true, data: { registered: Boolean(customer.invoice_settings?.default_payment_method) } });
  } catch (error) {
    if (error instanceof StripeApiError) return c.json({ success: false, error: 'カード登録状況を確認できませんでした' }, 502);
    throw error;
  }
});

// ================================================================ checkout

hqBilling.post('/api/hq/billing/checkout', requireRole('owner', 'admin'), inputJsonBoundary({ planKey: ['string'], interval: ['string'] }), async (c) => {
  try {
    const tenantId = tenantOf(c);
    const body = await c.req.json<{ planKey?: string; interval?: unknown } | null>().catch(() => null);
    const plan = findPlan(body?.planKey);
    if (!plan) return inputError(c, { success: false, error: 'プランを選んでください' }, 400, ["planKey"]);
    const interval = body?.interval === undefined ? 'month' : body.interval;
    if (interval !== 'month' && interval !== 'year') return inputError(c, { success: false, error: '月払いまたは年払いを選んでください' }, 400, ["interval"]);
    if (!stripeReady(c)) return c.json({ success: false, error: '決済の接続設定がまだありません。運営にお問い合わせください' }, 503);
    const priceId = priceIdForPlan(c.env, plan.key, interval);
    if (!priceId) return c.json({ success: false, error: 'このプランの価格がまだ設定されていません。運営にお問い合わせください' }, 503);
    const origin = adminOrigin(c);
    if (!origin) return c.json({ success: false, error: '管理画面のURLが設定されていないため、申込画面へ進めません' }, 503);

    const billing = await getTenantBilling(c.env.DB, tenantId);
    if (!billing) return c.json({ success: false, error: '統括が見つかりません' }, 404);
    if (billing.plan_status === 'exempt') {
      return c.json({ success: false, error: 'この統括は課金の対象外です' }, 409);
    }
    if (billing.stripe_subscription_id && (billing.plan_status === 'active' || billing.plan_status === 'past_due')) {
      return c.json({ success: false, error: 'すでに契約中です。プランの変更や解約は「支払い方法を管理」から行ってください' }, 409);
    }

    let customerId = billing.stripe_customer_id;
    if (!customerId) {
      const staff = c.get('staff');
      const member = staff?.id ? await getStaffById(c.env.DB, staff.id).catch(() => null) : null;
      const customer = await stripeApi.createCustomer(c.env, { name: billing.name, email: member?.email ?? null, tenantId });
      customerId = customer.id;
      await updateTenantBilling(c.env.DB, tenantId, { stripe_customer_id: customerId });
    }

    const session = await stripeApi.createCheckoutSession(c.env, {
      customerId,
      priceId,
      tenantId,
      planKey: plan.key,
      successUrl: `${origin}/hq/billing?checkout=success`,
      cancelUrl: `${origin}/hq/billing?checkout=cancel`,
    });
    if (!session.url) return c.json({ success: false, error: '申込画面のURLを作れませんでした' }, 502);
    return c.json({ success: true, data: { url: session.url } });
  } catch (err) {
    if (err instanceof StripeApiError) {
      logger.warn("routes_hq_billing_warn");
      return c.json({ success: false, error: '決済サービスに接続できませんでした。時間をおいてもう一度お試しください' }, 502);
    }
    throw err;
  }
});

// ================================================================ portal

hqBilling.post('/api/hq/billing/portal', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  try {
    const billing = await getTenantBilling(c.env.DB, tenantOf(c));
    if (!billing?.stripe_customer_id || !stripeReady(c)) {
      return c.json({ success: false, error: 'まだ契約がないため、支払い方法の管理画面はありません' }, 409);
    }
    const origin = adminOrigin(c);
    if (!origin) return c.json({ success: false, error: '管理画面のURLが設定されていません' }, 503);
    const session = await stripeApi.createPortalSession(c.env, { customerId: billing.stripe_customer_id, returnUrl: `${origin}/hq/billing` });
    return c.json({ success: true, data: { url: session.url } });
  } catch (err) {
    if (err instanceof StripeApiError) {
      return c.json({ success: false, error: '決済サービスに接続できませんでした。時間をおいてもう一度お試しください' }, 502);
    }
    throw err;
  }
});

// ================================================================ invoices

hqBilling.get('/api/hq/billing/invoices', requireRole('owner', 'admin'), async (c) => {
  try {
    const billing = await getTenantBilling(c.env.DB, tenantOf(c));
    if (!billing?.stripe_customer_id || !stripeReady(c)) return c.json({ success: true, data: [] });
    const invoices = await stripeApi.listInvoices(c.env, billing.stripe_customer_id, { limit: 12 });
    return c.json({
      success: true,
      data: invoices.data.map((inv) => ({
        id: inv.id,
        number: inv.number,
        status: inv.status,
        amountYen: inv.status === 'paid' ? inv.amount_paid : inv.amount_due,
        currency: inv.currency,
        createdAt: new Date(inv.created * 1000).toISOString(),
        description: inv.lines?.data?.[0]?.description ?? null,
        hostedUrl: inv.hosted_invoice_url,
        pdfUrl: inv.invoice_pdf,
      })),
    });
  } catch (err) {
    if (err instanceof StripeApiError) {
      return c.json({ success: false, error: '支払い履歴を取得できませんでした。時間をおいてもう一度お試しください' }, 502);
    }
    throw err;
  }
});

// ================================================================ webhook

interface BillingWebhookEvent {
  id: string;
  type: string;
  created?: number;
  data: { object: Record<string, unknown> };
}

function stripeExpandableId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
    return (value as { id: string }).id;
  }
  return null;
}

/**
 * charge.refunded の Charge に invoice が直接付かず payment_intent だけの場合の解決。
 * Stripe Billing の請求書払いなら PaymentIntent.invoice に請求書IDが入っているため、
 * それを1回だけ問い合わせて確認する。取得できなければ対象外（EC-CUBEなど）として扱う。
 */
async function resolveRefundedInvoiceId(c: Context<Env>, object: Record<string, unknown>): Promise<string | null> {
  const direct = stripeExpandableId(object.invoice);
  if (direct) return direct;
  const paymentIntentId = stripeExpandableId(object.payment_intent);
  if (!paymentIntentId || !stripeReady(c)) return null;
  try {
    const paymentIntent = await stripeApi.retrievePaymentIntent(c.env, paymentIntentId);
    return typeof paymentIntent.invoice === 'string' ? paymentIntent.invoice : null;
  } catch (error) {
    logger.warn("routes_hq_billing_warn");
    // 請求書の取得失敗を、請求書なしの根拠にしない。
    throw error;
  }
}

async function findTenantForEvent(c: Context<Env>, object: Record<string, unknown>): Promise<TenantBilling | null> {
  const metadata = (object.metadata ?? {}) as Record<string, string>;
  const byMeta = metadata.tenant_id ?? (typeof object.client_reference_id === 'string' ? object.client_reference_id : null);
  if (byMeta) {
    const tenant = await getTenantBilling(c.env.DB, byMeta);
    if (tenant) return tenant;
  }
  const customer = typeof object.customer === 'string' ? object.customer : null;
  return customer ? getTenantBillingByStripeCustomer(c.env.DB, customer) : null;
}

hqBilling.post('/api/hq/billing/webhook', async (c) => {
  const secret = c.env.STRIPE_BILLING_WEBHOOK_SECRET;
  if (!secret) return c.json({ success: false, error: 'Webhook is not configured' }, 503);
  const declaredLength = Number(c.req.header('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_STRIPE_WEBHOOK_BODY_BYTES) {
    return c.json({ success: false, error: 'Payload too large' }, 413);
  }
  const rawBody = await readBodyWithinLimit(c.req.raw);
  if (rawBody === null) return c.json({ success: false, error: 'Payload too large' }, 413);
  const signature = c.req.header('stripe-signature') ?? '';
  if (!(await verifyStripeSignature(secret, rawBody, signature))) {
    return c.json({ success: false, error: 'Invalid signature' }, 400);
  }

  let event: BillingWebhookEvent;
  try {
    event = JSON.parse(rawBody) as BillingWebhookEvent;
  } catch {
    return c.json({ success: false, error: 'Invalid payload' }, 400);
  }
  if (!event?.id || !event.type || !event.data?.object) return c.json({ success: false, error: 'Invalid payload' }, 400);

  try {
    const object = event.data.object;
    const refundedInvoiceId = event.type === 'charge.refunded'
      ? await resolveRefundedInvoiceId(c, object)
      : undefined;
    const tenant = await findTenantForEvent(c, object);
    // 保存済みの受領記録は完了済みとして扱う。新しい記録は、業務更新と完了印を一緒に確定するまで pending に残す。
    await c.env.DB.prepare('INSERT OR IGNORE INTO billing_events (id,type,tenant_id,summary) VALUES (?,?,?,?)')
      .bind(event.id,event.type,tenant?.id ?? null,'pending').run();
    const receipt = await c.env.DB.prepare('SELECT summary FROM billing_events WHERE id=?').bind(event.id).first<{summary:string}>();
    if (receipt?.summary !== 'pending') return c.json({ success:true,data:{received:true,duplicate:true} });
    const statements: D1PreparedStatement[] = [];
    let refundStatementIndex: number | undefined;
    let hasTenantWrite=false;
    const pending = {sql:"EXISTS (SELECT 1 FROM billing_events WHERE id=? AND summary='pending')",values:[event.id] as unknown[]};
    const subscriptionId = event.type.startsWith('customer.subscription.') ? stripeExpandableId(object.id)
      : stripeExpandableId(object.subscription);
    // 請求失敗の猶予は「請求書作成日」ではなく、この請求書の最初の失敗通知から数える。
    const subjectId = event.type.startsWith('invoice.') ? stripeExpandableId(object.id) : null;
    const created = typeof event.created === 'number' && Number.isSafeInteger(event.created) && event.created > 0 ? event.created : 0;
    const writeTenant = (patch: Parameters<typeof updateTenantBilling>[2], subscription = false) => {
      const sql = [pending.sql]; const values = [...pending.values];
      if (subscription) {
        // 削除・更新は現在の契約だけに適用し、新しい申込で置き換えられるのは取消済みの契約だけとする。
        const canReplace = event.type === 'checkout.session.completed' || event.type === 'customer.subscription.created';
        sql.push(`(stripe_subscription_id IS NULL OR stripe_subscription_id=?${canReplace ? " OR plan_status='canceled'" : ''})`);
        values.push(subscriptionId);
        if (event.type === 'customer.subscription.deleted') {
          sql.push('stripe_subscription_id=?'); values.push(subscriptionId);
        }
        sql.push("(stripe_customer_id IS NULL OR stripe_customer_id=?)"); values.push(stripeExpandableId(object.customer));
        if (patch.plan_status === 'active') {
          // 契約の状態通知が先に届いても、未払い請求が残る間は猶予状態を維持する。
          sql.push(`NOT EXISTS (SELECT 1 FROM billing_invoices bi
            WHERE bi.tenant_id=tenants.id AND bi.status IN ('open','uncollectible')
              AND bi.amount_due>bi.amount_paid
              AND (bi.subscription_id IS NULL OR bi.subscription_id=?))`);
          values.push(subscriptionId);
        }
        // 受領記録は到着時刻でなく、事業者の発生時刻を保持する。
        if (created) {
          sql.push(`NOT EXISTS (SELECT 1 FROM billing_events e WHERE e.tenant_id=tenants.id
            AND json_valid(e.summary) AND json_extract(e.summary,'$.applied')=1
            AND (?=1 OR json_extract(e.summary,'$.subscriptionId')=?)
            AND json_extract(e.summary,'$.created')>?)`); values.push(canReplace?1:0,subscriptionId,created);
        }
        // 削除済み契約を再び有効にしない。再契約は新しい ID とする。
        if (patch.plan_status && patch.plan_status !== 'canceled') {
          sql.push("NOT (plan_status='canceled' AND stripe_subscription_id=?)"); values.push(subscriptionId);
        }
      } else if (event.type.startsWith('invoice.')) {
        sql.push("plan_status=? AND (stripe_subscription_id IS NULL OR ? IS NULL OR stripe_subscription_id=?)");
        values.push(event.type==='invoice.paid'?'past_due':'active',subscriptionId,subscriptionId);
        if (event.type === 'invoice.paid') {
          // 入金した請求書だけでなく、同じ契約に残る未払いも確認する。
          sql.push(`NOT EXISTS (SELECT 1 FROM billing_invoices bi
            WHERE bi.tenant_id=tenants.id AND bi.status IN ('open','uncollectible')
              AND bi.amount_due>bi.amount_paid
              AND (bi.subscription_id IS NULL OR tenants.stripe_subscription_id IS NULL
                OR bi.subscription_id=tenants.stripe_subscription_id))`);
        } else if (event.type === 'invoice.payment_failed') {
          // 入金済み請求書への遅延した失敗イベントで、利用を再び止めない。
          sql.push(`EXISTS (SELECT 1 FROM billing_invoices bi
            WHERE bi.id=? AND bi.tenant_id=tenants.id AND bi.status='open'
              AND bi.amount_due>bi.amount_paid)`);
          values.push(subjectId);
        }
      }
      const statement=prepareTenantBillingUpdate(c.env.DB,tenant!.id,patch,{sql:sql.join(' AND '),values});
      if(statement){statements.push(statement);hasTenantWrite=true;}
    };
    const finish = async () => {
      statements.push(c.env.DB.prepare(`UPDATE billing_events SET summary=json_object('state','completed','created',?,'subscriptionId',?,'subjectId',?,'applied',${hasTenantWrite?'changes()':'0'}) WHERE id=? AND summary='pending'`)
        .bind(created,subscriptionId,subjectId,event.id));
      const results = await c.env.DB.batch(statements);
      if (refundStatementIndex !== undefined && !results[refundStatementIndex]?.meta.changes) {
        logger.warn('routes_hq_billing_warn');
      }
    };
    if (refundedInvoiceId === null) {
      logger.info("routes_hq_billing_info");
    }
    if (!tenant) {
      logger.warn("routes_hq_billing_warn");
      await finish();
      return c.json({ success: true, data: { received: true, matched: false } });
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        if (object.mode === 'setup') {
          const metadata = (object.metadata ?? {}) as Record<string, string>;
          const customerId = stripeExpandableId(object.customer);
          const setupIntentId = stripeExpandableId(object.setup_intent);
          // A signed event can still refer to another customer. Never use tenant metadata alone.
          if (metadata.purpose === 'musubo_card_setup' && metadata.tenant_id === tenant.id
            && customerId && customerId === tenant.stripe_customer_id && setupIntentId) {
            if (!stripeReady(c)) throw new StripeApiError(503, 'Stripe is not configured');
            const setupIntent = await stripeApi.retrieveSetupIntent(c.env, setupIntentId);
            if (setupIntent.status !== 'succeeded' || setupIntent.customer !== customerId || !setupIntent.payment_method) {
              throw new StripeApiError(502, 'SetupIntent has not completed');
            }
            await stripeApi.setCustomerDefaultPaymentMethod(c.env, customerId, setupIntent.payment_method);
          } else {
            logger.warn('routes_hq_billing_warn');
          }
          break;
        }
        const subscriptionId = typeof object.subscription === 'string' ? object.subscription : null;
        if (!subscriptionId || !stripeReady(c)) {
          return c.json({ success: false, error: '契約状態を確認できませんでした' }, 503);
        }
        let subscription: StripeSubscription;
        try {
          subscription = await stripeApi.retrieveSubscription(c.env, subscriptionId);
        } catch {
          // Keep the event pending so Stripe can retry. Checkout completion alone does not
          // prove that the first subscription invoice succeeded.
          logger.warn('routes_hq_billing_warn');
          return c.json({ success: false, error: '契約状態を確認できませんでした' }, 503);
        }
        if (subscription.id !== subscriptionId || subscription.customer !== stripeExpandableId(object.customer)) {
          logger.warn('routes_hq_billing_warn');
          return c.json({ success: false, error: '契約状態を確認できませんでした' }, 503);
        }
        writeTenant(subscriptionPatch(c, tenant, subscription), true);
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const payload = object as unknown as StripeSubscription;
        let subscription = payload;
        if (stripeReady(c)) {
          try {
            subscription = await stripeApi.retrieveSubscription(c.env, payload.id);
          } catch (error) {
            logger.warn("routes_hq_billing_warn");
          }
        }
        writeTenant(subscriptionPatch(c, tenant, subscription), true);
        break;
      }
      case 'customer.subscription.deleted': {
        writeTenant(subscriptionPatch(c, tenant, { ...(object as unknown as StripeSubscription), status: 'canceled' }), true);
        break;
      }
      case 'invoice.paid': {
        statements.push(prepareBillingInvoice(c.env.DB, billingInvoiceInput(object as unknown as StripeInvoice, {
          tenantId: tenant.id,
          fallbackPaidAt: toJstString(new Date()),
        }), pending));
        writeTenant({ plan_status: 'active' });
        break;
      }
      case 'invoice.payment_failed': {
        statements.push(prepareBillingInvoice(c.env.DB, billingInvoiceInput({
          ...(object as unknown as StripeInvoice),
          status: 'open',
        }, { tenantId: tenant.id }), pending));
        writeTenant({ plan_status: 'past_due' });
        break;
      }
      case 'invoice.voided': {
        statements.push(prepareBillingInvoice(c.env.DB, billingInvoiceInput({
          ...(object as unknown as StripeInvoice),
          status: 'void',
        }, { tenantId: tenant.id }), pending));
        break;
      }
      case 'charge.refunded': {
        if (refundedInvoiceId) {
          refundStatementIndex = statements.length;
          statements.push(c.env.DB.prepare(`UPDATE billing_invoices SET amount_refunded=?,synced_at=? WHERE id=? AND tenant_id=? AND ${pending.sql}`)
            .bind(Math.max(0,Math.floor(typeof object.amount_refunded==='number'?object.amount_refunded:0)),
              toJstString(new Date()),refundedInvoiceId,tenant.id,...pending.values));
        }
        break;
      }
      default:
        break;
    }
    await finish();
    if (subjectId && (event.type === 'invoice.payment_failed' || event.type === 'invoice.paid')) {
      // 通知の失敗で決済Webhookを再適用しない。送信台帳で二重送信を防ぎ、
      // 請求失敗の未送信分は定期ジョブでも拾う。
      const notification = (event.type === 'invoice.paid'
        ? deliverBillingRecoveryNotice(c.env, subjectId)
        : deliverCurrentBillingFailureNotice(c.env, tenant.id))
        .catch(() => logger.error('billing_invoice_notification_failed'));
      try { c.executionCtx.waitUntil(notification); }
      catch { await notification; }
    }
    return c.json({ success: true, data: { received: true } });
  } catch (err) {
    throw err;
  }
});
