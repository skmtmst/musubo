import { type Context } from 'hono';
import {
  activateFirstMusuboLine, getMusuboTenantBilling, getStaffById, getTenantBilling, musuboLineConnectionAllowed,
  LineAccountLifecycleError,
} from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { stripeApi } from '../services/stripe-api.js';
import { ensureMusuboCoreContract, ensureMusuboOptionsContract } from '../services/musubo-core-subscription.js';
import { logger } from '@line-crm/shared/server';

export const LINE_LIVE_ACCOUNT_CONCURRENCY = 2;

export async function musuboFirstLineGate(c: Context<Env>): Promise<'first' | 'legacy' | Response> {
  const tenantId = c.get('staff').tenantId ?? DEFAULT_TENANT_ID;
  const state = await musuboLineConnectionAllowed(c.env.DB, tenantId);
  if (state === 'legacy') return 'legacy';
  if (state === 'ended') return c.json({ success: false, error: '利用を終了した統括です。再開手続きを確認してください' }, 409);
  if (state === 'requires_payment') {
    return c.json({ success: false, error: 'LINEの追加料金を確認し、お支払いを完了してから接続してください' }, 409);
  }
  const musuboBilling = await getMusuboTenantBilling(c.env.DB, tenantId);
  if (musuboBilling && !musuboBilling.quote_id && !musuboBilling.pricing_consented_at) {
    return c.json({ success: false, error: '先に利用料金を確認してください' }, 409);
  }
  if (!c.env.STRIPE_PRODUCT_MUSUBO_CORE || !c.env.STRIPE_PRODUCT_MUSUBO_OPTIONS) {
    return c.json({ success: false, error: '請求の準備がまだ完了していません。運営にお問い合わせください' }, 503);
  }
  const billing = await getTenantBilling(c.env.DB, tenantId);
  if (!billing?.stripe_customer_id) {
    return c.json({ success: false, error: '先にお支払い情報を登録してください' }, 409);
  }
  try {
    const customer = await stripeApi.retrieveCustomer(c.env, billing.stripe_customer_id);
    if (!customer.invoice_settings?.default_payment_method) {
      return c.json({ success: false, error: 'カード登録を完了してからLINEを接続してください' }, 409);
    }
  } catch {
    return c.json({ success: false, error: 'カードの登録状況を確認できませんでした。時間をおいて再度お試しください' }, 502);
  }
  return 'first';
}

export async function startFirstMusuboLine(c: Context<Env>, lineAccountId: string): Promise<void> {
  const tenantId = c.get('staff').tenantId ?? DEFAULT_TENANT_ID;
  await activateFirstMusuboLine(c.env.DB, { tenantId, lineAccountId });
  try {
    await ensureMusuboCoreContract(c.env, tenantId);
    await ensureMusuboOptionsContract(c.env, tenantId);
  }
  catch { logger.error('musubo_core_contract_pending_retry'); }
}

export async function hasTenantWideLineAccountScope(c: Context<Env>): Promise<boolean> {
  const actor = c.get('staff');
  if (actor.id === 'env-owner') return true;
  const member = await getStaffById(c.env.DB, actor.id);
  return Boolean(member?.is_active && member.account_scope === 'all');
}

export function lifecycleConflict(error: unknown): { success: false; error: string } | null {
  if (!(error instanceof LineAccountLifecycleError)) return null;
  return { success: false, error: error.code };
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
