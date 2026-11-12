import { jstCalendar as japanCalendar } from '@line-crm/shared';
import { Hono } from 'hono';
import {
  billingRevenueTotals,
  BILLING_INVOICES_LAST_SYNCED_KEY,
  canceledAtByTenant,
  countBillingInvoices,
  countBillingEventsByType,
  dashboardAlerts,
  dashboardLineRegistration,
  dashboardTickets,
  dashboardUsage,
  getActiveImpersonation,
  getPlatformSetting,
  latestPaidBillingInvoices,
  listContractTenants,
  type TenantPlanRow,
} from '@line-crm/db';

import type { Env } from '../worker-env.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { adminSessionTokenHashFromRequest } from '../middleware/auth/credentials/auth.js';
import { requirePlatformAdmin } from '../middleware/platform-admin.js';
import { BILLING_PLANS, findPlan, type PlanKey } from '../services/billing-plans.js';
import { dbFor } from '../services/db-router.js';
import { firstRunFunnel } from '../services/first-run-funnel.js';

/**
 * 運営ダッシュボード（★37-2 `Xvofy`）。
 *
 * 売上は Stripe の入金済み請求書から数え、返金を差し引く。
 * Stripe 未設定または請求書がまだ無い環境だけ、契約中プランの定価へ戻す。
 */
export const opsDashboard = new Hono<Env>();

opsDashboard.use('/api/ops/dashboard/*', requirePlatformAdmin());
opsDashboard.use('/api/ops/dashboard', requirePlatformAdmin());

export type DashboardPeriod = 'month' | 'prev_month' | 'year';

function jstParts(at = Date.now()): { y: number; m: number; d: number } {
  const t = japanCalendar(new Date(at));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate() };
}

/** JST の月初を、表の created_at と同じ形（+09:00 付き ISO）で。 */
export function jstMonthStart(y: number, m: number): string {
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, '0')}-01T00:00:00.000+09:00`;
}

export function jstIso(at: number): string {
  const t = japanCalendar(new Date(at));
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}.${pad(t.getUTCMilliseconds(), 3)}+09:00`;
}

export function resolvePeriod(period: DashboardPeriod, at = Date.now()): { from: string; to: string; label: string } {
  const { y, m } = jstParts(at);
  if (period === 'prev_month') return { from: jstMonthStart(y, m - 1), to: jstMonthStart(y, m), label: '先月' };
  if (period === 'year') return { from: jstMonthStart(y, 0), to: jstMonthStart(y + 1, 0), label: '今年' };
  return { from: jstMonthStart(y, m), to: jstMonthStart(y, m + 1), label: '今月' };
}

function monthlyPrice(planKey: string | null): number {
  return findPlan(planKey)?.fallbackMonthlyYen ?? 0;
}

/** その時点（境界の文字列）で契約中だったと見なせる契約先。 */
function activeAt(tenants: TenantPlanRow[], canceled: Map<string, string>, boundary: string): TenantPlanRow[] {
  return tenants.filter((t) => {
    if (t.created_at >= boundary) return false;
    if (t.plan_status === 'active' || t.plan_status === 'past_due') return true;
    if (t.plan_status === 'canceled') {
      const at = canceled.get(t.id);
      return at !== undefined && at >= boundary;
    }
    return false;
  });
}

const PLAN_LABEL: Record<PlanKey, string> = { light: 'ライト', standard: 'スタンダード', pro: 'プロ' };

opsDashboard.get('/api/ops/dashboard', async (c) => {
  const db = dbFor(c.env);
  const periodRaw = c.req.query('period');
  const period: DashboardPeriod = periodRaw === 'prev_month' || periodRaw === 'year' ? periodRaw : 'month';
  const now = Date.now();
  const range = resolvePeriod(period, now);
  const { y, m } = jstParts(now);
  const thisMonthStart = jstMonthStart(y, m);
  const nextMonthStart = jstMonthStart(y, m + 1);
  const nowIso = jstIso(now);

  const [tenants, canceled, alerts, tickets, line, usage, events, invoiceCount, lastSyncedAt] = await Promise.all([
    listContractTenants(db, DEFAULT_TENANT_ID),
    canceledAtByTenant(db),
    dashboardAlerts(db, {
      excludeTenantId: DEFAULT_TENANT_ID,
      now: nowIso,
      trialDeadline: jstIso(now + 3 * 24 * 60 * 60 * 1000),
    }),
    dashboardTickets(db, { from: range.from, to: range.to }),
    dashboardLineRegistration(db, DEFAULT_TENANT_ID),
    dashboardUsage(db, { excludeTenantId: DEFAULT_TENANT_ID, from: thisMonthStart, to: nextMonthStart }),
    countBillingEventsByType(db, { from: range.from, to: range.to, types: ['customer.subscription.deleted', 'invoice.payment_failed'] }),
    countBillingInvoices(db, DEFAULT_TENANT_ID),
    getPlatformSetting(db, BILLING_INVOICES_LAST_SYNCED_KEY),
  ]);

  // 「契約中」＝請求契約が生きているもの（active ＋決済失敗の past_due）。
  // 一覧（/api/ops/tenants の集計）と同じ定義にそろえる。
  const active = tenants.filter((t) => t.plan_status === 'active' || t.plan_status === 'past_due');
  const trialing = tenants.filter((t) => t.plan_status === 'trialing');
  const byPlan: Record<PlanKey, number> = { light: 0, standard: 0, pro: 0 };
  for (const t of active) if (t.plan_key && t.plan_key in byPlan) byPlan[t.plan_key as PlanKey] += 1;

  const pricing = c.env.STRIPE_SECRET_KEY && invoiceCount > 0 ? 'stripe_actual' as const : 'list_price' as const;
  const prevMonthStart = jstMonthStart(y, m - 1);
  let revenueThisMonth = 0;
  let revenuePrevMonth = 0;
  let refundsThisMonth = 0;
  let contractMonthlyTotal = 0;
  let filledByListPriceCount = 0;
  const months: Array<{ month: string; label: string; yen: number; current: boolean }> = [];
  const monthRanges: Array<{ start: string; end: string; label: string; current: boolean }> = [];
  for (let i = 5; i >= 0; i -= 1) {
    const start = jstMonthStart(y, m - i);
    const end = jstMonthStart(y, m - i + 1);
    const mm = ((((m - i) % 12) + 12) % 12) + 1;
    monthRanges.push({ start, end, label: `${mm}月`, current: i === 0 });
  }

  if (pricing === 'stripe_actual') {
    const [currentTotals, previousTotals, latest, ...monthlyTotals] = await Promise.all([
      billingRevenueTotals(db, { excludeTenantId: DEFAULT_TENANT_ID, from: thisMonthStart, to: nextMonthStart }),
      billingRevenueTotals(db, { excludeTenantId: DEFAULT_TENANT_ID, from: prevMonthStart, to: thisMonthStart }),
      latestPaidBillingInvoices(db, { excludeTenantId: DEFAULT_TENANT_ID }),
      ...monthRanges.map(({ start, end }) => billingRevenueTotals(db, {
        excludeTenantId: DEFAULT_TENANT_ID,
        from: start,
        to: end,
      })),
    ]);
    revenueThisMonth = currentTotals.revenue;
    revenuePrevMonth = previousTotals.revenue;
    refundsThisMonth = currentTotals.refunds;
    for (const tenant of active) {
      const invoice = latest.get(tenant.id);
      if (!invoice) {
        filledByListPriceCount += 1;
        contractMonthlyTotal += monthlyPrice(tenant.plan_key);
        continue;
      }
      const net = Math.max(0, invoice.amount_paid - invoice.amount_refunded);
      contractMonthlyTotal += invoice.interval === 'year' ? Math.floor(net / 12) : net;
    }
    monthRanges.forEach((item, index) => {
      months.push({ month: item.start.slice(0, 7), label: item.label, yen: monthlyTotals[index]?.revenue ?? 0, current: item.current });
    });
  } else {
    revenueThisMonth = active.reduce((sum, tenant) => sum + monthlyPrice(tenant.plan_key), 0);
    revenuePrevMonth = activeAt(tenants, canceled, thisMonthStart).reduce((sum, tenant) => sum + monthlyPrice(tenant.plan_key), 0);
    contractMonthlyTotal = revenueThisMonth;
    filledByListPriceCount = active.length;
    for (const item of monthRanges) {
      months.push({
        month: item.start.slice(0, 7),
        label: item.label,
        yen: activeAt(tenants, canceled, item.end).reduce((sum, tenant) => sum + monthlyPrice(tenant.plan_key), 0),
        current: item.current,
      });
    }
  }

  const newInPeriod = tenants.filter((t) => t.created_at >= range.from && t.created_at < range.to).length;
  const newTrialsInPeriod = trialing.filter((t) => t.created_at >= range.from && t.created_at < range.to).length;
  const churnInPeriod = events['customer.subscription.deleted'] ?? 0;
  const activeAtPeriodStart = activeAt(tenants, canceled, range.from).length;
  const churnRate = activeAtPeriodStart > 0 ? (churnInPeriod / activeAtPeriodStart) * 100 : 0;

  const contractTotal = active.length + trialing.length;
  const planShare = [
    ...(['light', 'standard', 'pro'] as PlanKey[]).map((key) => ({ key, label: PLAN_LABEL[key], count: byPlan[key] })),
    { key: 'trial', label: 'トライアル', count: trialing.length },
  ].map((row) => ({ ...row, percent: contractTotal > 0 ? Math.round((row.count / contractTotal) * 100) : 0 }));

  const usageRows = usage
    .map((row) => {
      const plan = findPlan(row.plan_key);
      const limits = {
        messages: plan?.monthlyMessages ?? null,
        images: plan?.monthlyImages ?? null,
        mediaBytes: plan?.mediaBytes ?? null,
      };
      const ratios = [
        limits.messages ? row.messages / limits.messages : 0,
        limits.images ? row.banner_units / limits.images : 0,
        limits.mediaBytes ? row.media_bytes / limits.mediaBytes : 0,
      ];
      return {
        tenantId: row.tenant_id,
        tenantName: row.tenant_name,
        planKey: row.plan_key,
        planLabel: row.plan_key && row.plan_key in PLAN_LABEL ? PLAN_LABEL[row.plan_key as PlanKey] : (row.plan_status === 'trialing' ? 'トライアル' : '—'),
        messages: row.messages,
        bannerUnits: row.banner_units,
        mediaBytes: row.media_bytes,
        limits,
        usageRate: Math.round(Math.max(...ratios) * 100),
      };
    })
    .filter((row) => row.usageRate > 0)
    .sort((a, b) => b.usageRate - a.usageRate)
    .slice(0, 5);

  return c.json({
    success: true,
    data: {
      period,
      periodLabel: range.label,
      pricing,
      lastSyncedAt: pricing === 'stripe_actual' ? lastSyncedAt : null,
      plans: BILLING_PLANS.map((p) => ({ key: p.key, label: p.name, monthlyYen: p.fallbackMonthlyYen })),
      kpis: {
        revenueThisMonth,
        revenueDelta: revenueThisMonth - revenuePrevMonth,
        refundsThisMonth,
        contractMonthlyTotal,
        filledByListPriceCount,
        active: active.length,
        byPlan,
        trialing: trialing.length,
        newInPeriod,
        newTrialsInPeriod,
        churnInPeriod,
        churnRate: Math.round(churnRate * 10) / 10,
      },
      revenueByMonth: months,
      planShare: { total: contractTotal, rows: planShare },
      alerts,
      tickets,
      lineRegistration: { registered: line.registered, total: line.total, unregisteredCount: line.unregistered.length },
      usage: usageRows,
      generatedAt: nowIso,
    },
  });
});

/** 「未登録の N 人へ案内」の一覧（★37-2）。名前と契約先だけ返す。メールアドレスは返さない。 */
opsDashboard.get('/api/ops/dashboard/line-unregistered', async (c) => {
  const db = dbFor(c.env);
  const line = await dashboardLineRegistration(db, DEFAULT_TENANT_ID);
  return c.json({
    success: true,
    data: {
      registered: line.registered,
      total: line.total,
      people: line.unregistered.map((p) => ({ staffId: p.staffId, name: p.name, tenantName: p.tenantName, hasEmail: p.email !== null })),
    },
  });
});

/**
 * 最初の 10 分の全アカウントのまとめ。期間（アカウントを作った日）ごとの数と割合だけを返す。
 * 運営マスターの中でも、閲覧のみの人と代理ログイン中は読めない。
 */
opsDashboard.get('/api/ops/dashboard/first-run', async (c) => {
  const db = dbFor(c.env);
  const staff = c.get('staff');
  if (!staff || staff.readOnly) {
    return c.json({ success: false, error: '閲覧のみの権限では、このまとめは見られません' }, 403);
  }
  const tokenHash = await adminSessionTokenHashFromRequest(c);
  if (tokenHash && await getActiveImpersonation(db, staff.id, tokenHash)) {
    return c.json({ success: false, error: '代理ログイン中は、このまとめは見られません' }, 403);
  }
  const periodRaw = c.req.query('period');
  const period: DashboardPeriod = periodRaw === 'prev_month' || periodRaw === 'year' ? periodRaw : 'month';
  const range = resolvePeriod(period);
  const funnel = await firstRunFunnel(db, { from: range.from, to: range.to, excludeTenantId: DEFAULT_TENANT_ID });
  return c.json({ success: true, data: { period, periodLabel: range.label, ...funnel } });
});
