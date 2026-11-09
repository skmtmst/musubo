import { finalLineEndOption, jstDateOffset, lineBasicDiscountForDate, musuboPrice,
  type AppliedMusuboCondition } from '@line-crm/shared';
import { getMusuboTenantBilling, type MusuboTenantBillingRecord } from '@line-crm/db';
import type { WorkerBindings } from '../worker-bindings.js';
import { reconcileMusuboRecurringPrices } from './musubo-recurring-prices.js';

interface LineRow { line_account_id: string; name: string; status: 'active' | 'ending' }
interface LineUsage { line_account_id: string; friend_count_excluding_blocked: number | null;
  friend_count_measured_on: string | null; google_business_count: number; instagram_count: number }
interface RemovalRow {
  id: string; tenant_id: string; line_account_id: string;
  status: 'requested' | 'scheduled' | 'cancelling' | 'ended' | 'cancelled';
  effective_at: string; requested_at: string; synced_at: string | null;
}

interface RemovalNoticeSnapshot {
  lineName: string; interval: 'month' | 'year'; effectiveAt: string;
  requestedAt: string; nextMonthlyChargeAt: string | null;
  nextAnnualRenewalAt: string | null;
  nextCoreYen: number; nextOptionsMonthlyYen: number;
}

function noticeInsert(db: D1Database, removal: RemovalRow,
  event: 'scheduled' | 'ended' | 'cancelled', snapshot: RemovalNoticeSnapshot,
  now: string): D1PreparedStatement {
  return db.prepare(`INSERT OR IGNORE INTO musubo_line_removal_notices
    (id,tenant_id,event,snapshot_json,created_at) VALUES (?,?,?,?,?)`)
    .bind(`${removal.id}:${event}`, removal.tenant_id, event, JSON.stringify(snapshot), now);
}

async function noticeSnapshot(env: WorkerBindings, removal: RemovalRow, now: string): Promise<RemovalNoticeSnapshot> {
  const view = await getMusuboLineRemoval(env, removal.tenant_id, removal.line_account_id, now);
  if (!view.priceEstimate) throw new Error('Verified removal charges are unavailable');
  return { lineName: view.lineName, interval: view.billingInterval,
    effectiveAt: removal.effective_at, requestedAt: removal.requested_at,
    nextMonthlyChargeAt: view.nextMonthlyChargeAt,
    nextAnnualRenewalAt: view.nextAnnualRenewalAt,
    nextCoreYen: view.priceEstimate.afterCoreYen,
    nextOptionsMonthlyYen: view.priceEstimate.afterMonthlyOptionsYen };
}

async function lines(env: WorkerBindings, tenantId: string): Promise<LineRow[]> {
  const rows = await env.DB.prepare(`SELECT u.line_account_id,a.name,u.status
    FROM musubo_line_usage u JOIN line_accounts a ON a.id=u.line_account_id
    WHERE u.tenant_id=? AND u.status IN ('active','ending') ORDER BY u.activated_at,a.id`)
    .bind(tenantId).all<LineRow>();
  return rows.results ?? [];
}

async function currentRemoval(env: WorkerBindings, tenantId: string): Promise<RemovalRow | null> {
  return env.DB.prepare(`SELECT * FROM musubo_line_removals WHERE tenant_id=?
    AND status IN ('requested','scheduled','cancelling') LIMIT 1`)
    .bind(tenantId).first<RemovalRow>();
}

function scheduledEndAt(billing: MusuboTenantBillingRecord, now: string): string {
  const instant = (date: string | null) => date ? `${date}T00:00:00+09:00` : undefined;
  return finalLineEndOption({
    billingState: billing.status === 'trialing' ? 'trialing' : 'active',
    interval: billing.billing_interval,
    trialFirstChargeAt: instant(billing.first_charge_date),
    nextMonthlyChargeAt: instant(billing.next_monthly_charge_at),
    nextAnnualRenewalAt: instant(billing.next_annual_renewal_at),
  }, now).defaultEndAt;
}

async function checkEligibility(env: WorkerBindings, tenantId: string, lineId: string) {
  const billing = await getMusuboTenantBilling(env.DB, tenantId);
  if (!billing || !['trialing','active'].includes(billing.status)
    || billing.termination_requested_at || !billing.core_subscription_id
    || !billing.options_subscription_id) throw new Error('The billing state does not allow LINE removal');
  const active = await lines(env, tenantId);
  if (active.length !== 2 || !active.some((line) => line.line_account_id === lineId)) {
    throw new Error('This removal requires exactly two active LINE accounts');
  }
  if (billing.quote_id) throw new Error('A revised individual quote is required');
  const pending = await env.DB.prepare(`SELECT id FROM musubo_pending_additions
    WHERE tenant_id=? AND status IN ('awaiting_payment','paid') LIMIT 1`)
    .bind(tenantId).first<{ id: string }>();
  if (pending) throw new Error('An addition is still pending');
  return { billing, active };
}

export async function getMusuboLineRemoval(env: WorkerBindings, tenantId: string, lineId: string,
  now = new Date().toISOString()) {
  const billing = await getMusuboTenantBilling(env.DB, tenantId);
  if (!billing) throw new Error('The billing state is unavailable');
  const active = await lines(env, tenantId);
  const historical = await env.DB.prepare(`SELECT * FROM musubo_line_removals
    WHERE tenant_id=? AND line_account_id=? ORDER BY requested_at DESC LIMIT 1`)
    .bind(tenantId, lineId).first<RemovalRow>();
  if (active.length === 1 && historical?.status === 'ended') {
    const target = await env.DB.prepare('SELECT name FROM line_accounts WHERE id=? AND tenant_id=?')
      .bind(lineId, tenantId).first<{ name: string }>();
    return { lineAccountId: lineId, lineName: target?.name ?? 'LINE公式アカウント',
      billingInterval: billing.billing_interval, billingStatus: billing.status,
      nextMonthlyChargeAt: billing.next_monthly_charge_at,
      nextAnnualRenewalAt: billing.next_annual_renewal_at,
      scheduledEndAt: null, phase: 'ended' as const, requestedEndAt: historical.effective_at,
      otherLineName: active[0]!.name, priceEstimate: null };
  }
  await checkEligibility(env, tenantId, lineId);
  const removal = await currentRemoval(env, tenantId);
  const target = active.find((line) => line.line_account_id === lineId)!;
  const effectiveAt = removal?.effective_at ?? scheduledEndAt(billing, now);
  const usage = await env.DB.prepare(`SELECT line_account_id,friend_count_excluding_blocked,
    friend_count_measured_on,google_business_count,instagram_count
    FROM musubo_line_usage WHERE tenant_id=? AND status IN ('active','ending')`)
    .bind(tenantId).all<LineUsage>();
  const numbers = usage.results ?? [];
  let priceEstimate: { beforeMonthlyOptionsYen: number; afterMonthlyOptionsYen: number;
    afterCoreYen: number; interval: 'month' | 'year' } | null = null;
  if (numbers.length === 2 && numbers.every((row) => row.friend_count_excluding_blocked !== null
    && row.friend_count_measured_on === jstDateOffset(-1))) {
    const condition = JSON.parse(billing.pricing_snapshot_json) as AppliedMusuboCondition;
    const remaining = numbers.find((row) => row.line_account_id !== lineId)!;
    const coreChargeAt = billing.billing_interval === 'year'
      ? billing.next_annual_renewal_at : billing.next_monthly_charge_at;
    if (!coreChargeAt && !billing.first_charge_date) throw new Error('Next charge date is unavailable');
    const discount = lineBasicDiscountForDate(condition, coreChargeAt ?? billing.first_charge_date!);
    const before = musuboPrice({ lineCount: 2, interval: billing.billing_interval,
      friendCountExcludingBlocked: numbers.reduce((sum, row) => sum + row.friend_count_excluding_blocked!, 0),
      linkedAccountsByLine: numbers.map((row) => ({ googleBusiness: row.google_business_count,
        instagram: row.instagram_count })), lineBasicDiscountPercent: discount, schedule: condition.schedule });
    const after = musuboPrice({ lineCount: 1, interval: billing.billing_interval,
      friendCountExcludingBlocked: remaining.friend_count_excluding_blocked!,
      linkedAccountsByLine: [{ googleBusiness: remaining.google_business_count,
        instagram: remaining.instagram_count }], lineBasicDiscountPercent: discount, schedule: condition.schedule });
    priceEstimate = { beforeMonthlyOptionsYen: before.optionsMonthlyYen,
      afterMonthlyOptionsYen: after.optionsMonthlyYen,
      afterCoreYen: billing.billing_interval === 'year'
        ? after.annualLineChargeYen : after.lineBasicMonthlyYen,
      interval: billing.billing_interval };
  }
  return {
    lineAccountId: lineId, lineName: target.name,
    billingInterval: billing.billing_interval, billingStatus: billing.status,
    nextMonthlyChargeAt: billing.next_monthly_charge_at,
    nextAnnualRenewalAt: billing.next_annual_renewal_at,
    scheduledEndAt: effectiveAt,
    phase: removal && removal.line_account_id === lineId ? removal.status : 'choose',
    requestedEndAt: removal?.line_account_id === lineId ? removal.effective_at : null,
    otherLineName: active.find((line) => line.line_account_id !== lineId)!.name,
    priceEstimate,
  };
}

async function completeRemoval(env: WorkerBindings, removal: RemovalRow, now: string): Promise<void> {
  const snapshot = await noticeSnapshot(env, removal, now);
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE musubo_line_removals SET status='ended',ended_at=?,updated_at=?
      WHERE id=? AND status IN ('requested','scheduled') AND effective_at<=?`)
      .bind(now, now, removal.id, now),
    env.DB.prepare(`UPDATE musubo_line_usage SET status='ended',ended_at=?,updated_at=?
      WHERE tenant_id=? AND line_account_id=? AND status='ending' AND changes()=1`)
      .bind(now, now, removal.tenant_id, removal.line_account_id),
    env.DB.prepare(`UPDATE line_accounts SET is_active=0,is_default=0,
      inactive_reason='manual',inactive_reason_detail='musuboの利用終了',inactivated_at=?,updated_at=?
      WHERE id=? AND tenant_id=? AND is_active=1 AND changes()=1`)
      .bind(now, now, removal.line_account_id, removal.tenant_id),
    noticeInsert(env.DB, removal, 'ended', snapshot, now),
  ]);
  if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[1]?.meta?.changes ?? 0) !== 1
    || (results[2]?.meta?.changes ?? 0) !== 1) throw new Error('LINE removal state changed');
}

/** Durable intent first; repeated calls repair an unknown Stripe or D1 result. */
export async function reconcileMusuboLineRemoval(env: WorkerBindings, tenantId: string,
  now = new Date().toISOString()) {
  const removal = await currentRemoval(env, tenantId);
  if (!removal) return 'none' as const;
  if (!await reconcileMusuboRecurringPrices(env, tenantId)) {
    throw new Error('The recurring prices could not be verified');
  }
  const latest = await currentRemoval(env, tenantId);
  if (!latest || latest.id !== removal.id || latest.status !== removal.status) return 'changed' as const;
  if (removal.status === 'cancelling') {
    const snapshot = await noticeSnapshot(env, removal, now);
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE musubo_line_removals SET status='cancelled',cancelled_at=?,updated_at=?
        WHERE id=? AND status='cancelling'`).bind(now, now, removal.id),
      env.DB.prepare(`UPDATE musubo_line_usage SET status='active',updated_at=?
        WHERE tenant_id=? AND line_account_id=? AND status='ending' AND changes()=1`)
        .bind(now, tenantId, removal.line_account_id),
      noticeInsert(env.DB, removal, 'cancelled', snapshot, now),
    ]);
    if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[1]?.meta?.changes ?? 0) !== 1) {
      throw new Error('LINE removal state changed');
    }
    return 'cancelled' as const;
  }
  if (removal.effective_at <= now) {
    await completeRemoval(env, removal, now);
    return 'ended' as const;
  }
  const snapshot = await noticeSnapshot(env, removal, now);
  await env.DB.batch([
    env.DB.prepare(`UPDATE musubo_line_removals SET status='scheduled',synced_at=?,updated_at=?
      WHERE id=? AND status IN ('requested','scheduled')`).bind(now, now, removal.id),
    noticeInsert(env.DB, removal, 'scheduled', snapshot, now),
  ]);
  return 'scheduled' as const;
}

export async function requestMusuboLineRemoval(env: WorkerBindings, tenantId: string,
  lineId: string, action: 'schedule' | 'now' | 'cancel', now = new Date().toISOString()) {
  const { billing } = await checkEligibility(env, tenantId, lineId);
  const existing = await currentRemoval(env, tenantId);
  if (action === 'cancel') {
    if (!existing || existing.line_account_id !== lineId || existing.effective_at <= now
      || existing.status !== 'scheduled') throw new Error('There is no cancellable LINE removal');
    const result = await env.DB.prepare(`UPDATE musubo_line_removals SET status='cancelling',updated_at=?
      WHERE id=? AND status='scheduled'`).bind(now, existing.id).run();
    if ((result.meta?.changes ?? 0) !== 1) throw new Error('LINE removal state changed');
  } else {
    if (existing) {
      if (existing.line_account_id !== lineId || existing.status === 'cancelling') {
        throw new Error('A different LINE removal is already pending');
      }
      return reconcileMusuboLineRemoval(env, tenantId, now);
    }
    const effective = action === 'now' ? now : scheduledEndAt(billing, now);
    const id = crypto.randomUUID();
    const results = await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO musubo_line_removals
        (id,tenant_id,line_account_id,status,effective_at,requested_at,updated_at)
        VALUES (?,?,?,'requested',?,?,?)`)
        .bind(id, tenantId, lineId, effective, now, now),
      env.DB.prepare(`UPDATE musubo_line_usage SET status='ending',updated_at=?
        WHERE tenant_id=? AND line_account_id=? AND status='active' AND changes()=1`)
        .bind(now, tenantId, lineId),
    ]);
    if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[1]?.meta?.changes ?? 0) !== 1) {
      throw new Error('LINE removal state changed');
    }
  }
  return reconcileMusuboLineRemoval(env, tenantId, now);
}

export async function sweepMusuboLineRemovals(env: WorkerBindings, now = new Date().toISOString()) {
  const rows = await env.DB.prepare(`SELECT tenant_id FROM musubo_line_removals
    WHERE status IN ('requested','cancelling') OR (status='scheduled' AND effective_at<=?)
    ORDER BY updated_at LIMIT 10`).bind(now).all<{ tenant_id: string }>();
  let failed = 0;
  for (const row of rows.results ?? []) {
    try { await reconcileMusuboLineRemoval(env, row.tenant_id, now); } catch { failed++; }
  }
  return { attempted: rows.results?.length ?? 0, failed };
}
