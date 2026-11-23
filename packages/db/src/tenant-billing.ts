import { jstNow } from './utils.js';

/**
 * 統括の課金（★36-2）。tenants の課金列と、Stripe Webhook の重複防止。
 */

export const TENANT_PLAN_STATUSES = ['exempt', 'trialing', 'active', 'past_due', 'canceled'] as const;
export type TenantPlanStatus = (typeof TENANT_PLAN_STATUSES)[number];

export interface TenantBilling {
  id: string;
  name: string;
  plan_key: string | null;
  plan_status: TenantPlanStatus;
  trial_ends_at: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_ends_at: string | null;
  plan_updated_at: string | null;
  billing_epoch: number;
  last_purged_at: string | null;
}

const COLUMNS =
  'id, name, plan_key, plan_status, trial_ends_at, stripe_customer_id, stripe_subscription_id, current_period_ends_at, plan_updated_at, billing_epoch, last_purged_at';

export async function getTenantBilling(db: D1Database, tenantId: string): Promise<TenantBilling | null> {
  return db.prepare(`SELECT ${COLUMNS} FROM tenants WHERE id = ?`).bind(tenantId).first<TenantBilling>();
}

/**
 * LINEアカウントの所属統括の課金行を1往復で読む。
 *
 * 「アカウントの tenant_id を読んでから tenants を読む」と2往復になるため、
 * 機能可否判定のように両方を連続で使う呼び出しではこの結合読取を使う。
 * tenant 未割当・tenant 行なし・アカウント行なしは全部 null。
 */
export async function getTenantBillingByLineAccount(
  db: D1Database,
  lineAccountId: string,
): Promise<TenantBilling | null> {
  const row = await db
    .prepare(
      `SELECT t.id, t.name, t.plan_key, t.plan_status, t.trial_ends_at,
              t.stripe_customer_id, t.stripe_subscription_id,
              t.current_period_ends_at, t.plan_updated_at, t.billing_epoch, t.last_purged_at
         FROM line_accounts la
         LEFT JOIN tenants t ON t.id = la.tenant_id
        WHERE la.id = ?`,
    )
    .bind(lineAccountId)
    .first<TenantBilling>();
  return row?.id ? row : null;
}

export async function getTenantBillingByStripeCustomer(
  db: D1Database,
  stripeCustomerId: string,
): Promise<TenantBilling | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM tenants WHERE stripe_customer_id = ?`)
    .bind(stripeCustomerId)
    .first<TenantBilling>();
}

export async function updateTenantBilling(
  db: D1Database,
  tenantId: string,
  patch: Partial<Pick<TenantBilling, 'plan_key' | 'plan_status' | 'trial_ends_at' | 'stripe_customer_id' | 'stripe_subscription_id' | 'current_period_ends_at'>>,
): Promise<TenantBilling | null> {
  const statement = prepareTenantBillingUpdate(db, tenantId, patch);
  if (statement) {
    const result = await statement.run();
    if (!result.meta.changes && patch.plan_status && patch.plan_status !== 'canceled') {
      const row = await db.prepare('SELECT purge_started_at FROM tenants WHERE id = ?').bind(tenantId).first<{purge_started_at:string|null}>();
      if (row?.purge_started_at) throw new Error('tenant_purge_in_progress');
    }
  }
  return getTenantBilling(db, tenantId);
}

export interface BillingWriteCondition { sql: string; values: unknown[] }

/** Build a mutation so webhook effects and completion can share one transaction. */
export function prepareTenantBillingUpdate(
  db: D1Database, tenantId: string,
  patch: Parameters<typeof updateTenantBilling>[2],
  condition?: BillingWriteCondition,
): D1PreparedStatement | null {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const key of ['plan_key', 'plan_status', 'trial_ends_at', 'stripe_customer_id', 'stripe_subscription_id', 'current_period_ends_at'] as const) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(patch[key]);
    }
  }
  if (sets.length === 0) return null;
  const now = jstNow();
  if (patch.plan_status === 'canceled') {
    // 解約が反映された時刻を、顧客データの保存期限を数え始める起点にする。
    // すでに起点があれば動かさない。解約後にも invoice.voided や期末の
    // subscription.updated が届くので、その度に起点が後ろへずれると
    // 削除がいつまでも始まらない。
    sets.push('retention_anchor_at = COALESCE(retention_anchor_at, ?)');
    values.push(now);
  } else if (patch.plan_status !== undefined) {
    // 契約が戻ったので削除の予定を取り消す。削除済みの印も消して、
    // 次に解約した時にもう一度削除できるようにする（実績は監査表に残る）。
    sets.push('retention_anchor_at = NULL', 'purge_requested_at = NULL', 'data_purged_at = NULL');
  }
  sets.push('plan_updated_at = ?', 'updated_at = ?');
  values.push(now, now, tenantId);
  const purgeGuard = patch.plan_status && patch.plan_status !== 'canceled' ? ' AND purge_started_at IS NULL' : '';
  return db.prepare(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?${purgeGuard}${condition ? ` AND (${condition.sql})` : ''}`)
    .bind(...values, ...(condition?.values ?? []));
}

/**
 * Stripe のイベントを記録する。すでにあれば false（＝二度目なので処理しない）。
 */
export async function recordBillingEvent(
  db: D1Database,
  input: { id: string; type: string; tenantId: string | null; summary?: string },
): Promise<boolean> {
  const result = await db
    .prepare('INSERT OR IGNORE INTO billing_events (id, type, tenant_id, summary) VALUES (?, ?, ?, ?)')
    .bind(input.id, input.type, input.tenantId, input.summary ?? '')
    .run();
  return (result.meta?.changes ?? 0) > 0;
}
