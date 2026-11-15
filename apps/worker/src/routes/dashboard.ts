import { parseOffsetPaging, buildOffsetListResponse } from '../lib/list-paging.js';
import { jstDate as japanDate, validHoursDate } from '@line-crm/shared';
import { fetchQuota } from '../services/dashboard-quota.js';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { Hono } from 'hono';
import {
  DASHBOARD_CARD_GROUPS as SHARED_DASHBOARD_CARD_GROUPS,
  DASHBOARD_TODAY_VISIBLE_LIMIT,
} from '@line-crm/shared';
import {
  getDashboardActivity,
  getDashboardComparisons,
  getDashboardOverview,
  getDashboardDefaultPreference,
  getDashboardPreference,
  getDashboardUpcoming,
  getDeliveryFailureOrigins,
  getListStats,
  getLineAccountById,
  getLineAccountsByIds,
  deleteDashboardPreference,
  saveDashboardDefaultPreference,
  saveDashboardPreference,
  dashboardFreshness,
  summarizeDashboardFreshness,
  type DashboardPeriod,
} from '@line-crm/db';
import { fail } from '../lib/fail.js';
import type { Env } from '../worker-env.js';
import { canAccessAllLineAccounts, getVisibleLineAccountScope } from '../services/account-access.js';
import { requireRole } from '../middleware/role-guard.js';
import { auditLog } from '../lib/audit-log.js';

/**
 * ダッシュボードが1回で読む数。
 *
 * 設計（Pen.dev `V2 1-1 ダッシュボード`）は1画面に10か所以上の数を出す。
 * カードごとに叩くと往復が増えるうえ、数の基準時刻がカード間でずれる。
 * 「有効友だちは今朝の値、未対応は今の値」という画面は読み違えのもとなので、
 * まとめて1回で返す。
 */
export const dashboard = new Hono<Env>();

dashboard.get('/api/dashboard/activity', requireRole('owner', 'admin', 'staff'), async (c) => {
  try {
    const access = await requireVisibleAccount(c);
    if ('response' in access) return access.response;
    const limit = parseOffsetPaging({ limit: c.req.query('limit') }, { defaultLimit: 10, limitPolicy: {} }).limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return c.json({ success: false, error: 'limit は1〜100の整数を指定してください' }, 400);
    }
    const items = await getDashboardActivity(c.env.DB, access.accountId, limit);
    return c.json({ success: true, data: buildOffsetListResponse({ items, total: null, paging: { limit, offset: 0 }, sort: [] }) });
  } catch (error) {
    throw error;
  }
});

const PERIODS: DashboardPeriod[] = ['today', 'last7', 'last28', 'last30', 'last90', 'custom'];

/*
 * 概要応答の中で送信枠の取得に使える時間（DASH-14）。
 * LINE 側の応答が遅いときでも、DBで集計済みの友だち数・受信などを
 * 待たせ続けないための上限。超えたら枠だけを失敗として返す。
 */
const QUOTA_OVERVIEW_BUDGET_MS = 3_500;

function readPeriod(raw: string | undefined, from?: string, to?: string): { period: DashboardPeriod; range?: { from: string; to: string } } | null {
  const period = raw ?? 'today';
  if (!PERIODS.includes(period as DashboardPeriod)) return null;
  if (period !== 'custom') return from === undefined && to === undefined ? { period: period as DashboardPeriod } : null;
  if (!from || !to || !validHoursDate(from) || !validHoursDate(to) || from > to || to > japanDate()
      || Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 365 * 86_400_000) return null;
  return { period: 'custom', range: { from, to } };
}

/*
 * 許可するカードIDは @line-crm/shared の DASHBOARD_CARD_GROUPS が正本。
 * 画面のカード定義とここが別々だと、画面が必ず送るIDをAPIが拒否して
 * 保存できなくなる（DASH-01: support-mark-status の抜けで全保存が400）。
 */
const DASHBOARD_CARD_GROUPS = {
  today: new Set<string>(SHARED_DASHBOARD_CARD_GROUPS.today),
  main: new Set<string>(SHARED_DASHBOARD_CARD_GROUPS.main),
  right: new Set<string>(SHARED_DASHBOARD_CARD_GROUPS.right),
} as const;

type DashboardCards = Record<keyof typeof DASHBOARD_CARD_GROUPS, Array<{ id: string; visible: boolean }>>;

function readAccountId(c: { req: { query(name: string): string | undefined } }): string | null {
  return c.req.query('account_id') ?? c.req.query('accountId') ?? null;
}

function readDashboardCards(value: unknown): DashboardCards | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const out = {} as DashboardCards;
  for (const group of Object.keys(DASHBOARD_CARD_GROUPS) as Array<keyof typeof DASHBOARD_CARD_GROUPS>) {
    const input = record[group];
    if (!Array.isArray(input)) return null;
    const seen = new Set<string>();
    const items: Array<{ id: string; visible: boolean }> = [];
    for (const candidate of input) {
      if (!candidate || typeof candidate !== 'object') return null;
      const item = candidate as { id?: unknown; visible?: unknown };
      if (typeof item.id !== 'string' || item.id.length === 0) return null;
      if (typeof item.visible !== 'boolean' || seen.has(item.id)) return null;
      seen.add(item.id);
      /*
       * 機能OFF・廃止で候補から外れたIDが残っていても保存全体を400に
       * しない。未知IDは visible=false で保持し、表示には使わない。
       * 並びは残るため、機能が戻ったときに配置が復活する。
       */
      const known = DASHBOARD_CARD_GROUPS[group].has(item.id);
      items.push({ id: item.id, visible: known && item.visible });
    }
    if (group === 'today' && items.filter((item) => item.visible).length > DASHBOARD_TODAY_VISIBLE_LIMIT) return null;
    out[group] = items;
  }
  return out;
}

function parseStoredCards(cards: string): DashboardCards | null {
  try { return readDashboardCards(JSON.parse(cards)); } catch { return null; }
}

async function requireVisibleAccount(c: {
  req: { query(name: string): string | undefined };
  env: Env['Bindings'];
  get(name: 'staff'): Env['Variables']['staff'];
}): Promise<{ accountId: string } | { response: Response }> {
  const accountId = readAccountId(c);
  if (!accountId) {
    return { response: Response.json({ success: false, error: 'LINEアカウントを選択してください' }, { status: 400 }) };
  }
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
    return { response: Response.json({ success: false, error: 'LINE account not found' }, { status: 404 }) };
  }
  return { accountId };
}

/**
 * 今月の送信枠を LINE から取る。
 *
 * 取れなくても画面は出したいので、失敗は null にして握りつぶす。
 * ここで落とすと、LINE 側の一時的な不調で管理画面全体が開かなくなる。
 */
/**
 * 同時実行数を抑えて順に回す。
 *
 * organization-overview は可視アカウント全件の LINE 枠を取る。無制限の
 * `Promise.all` で投げると、アカウントが増えたときに遅延し、LINE 側の
 * 429・タイムアウトの巻き添えで全体が遅くなる。5件ずつに区切る。
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(limit, 1), items.length) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await task(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

dashboard.get('/api/dashboard/overview', async (c) => {
  try {
    const selectedPeriod = readPeriod(c.req.query('period'), c.req.query('from'), c.req.query('to'));
    if (!selectedPeriod) return c.json({ success: false, error: '期間を確認してください' }, 400);
    const { period, range } = selectedPeriod;
    const access = await requireVisibleAccount(c);
    if ('response' in access) return access.response;
    const { accountId } = access;
    const selectedAccount = await getLineAccountById(c.env.DB, accountId);
    if (!selectedAccount) {
      return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
    }

    const statsScope = { allowedAccountIds: [accountId], includeUnassigned: false };
    /*
     * 受信箱の数だけは、受信箱の一覧と同じ範囲で数える。MAIL は LINE
     * アカウントを持たないため、未割り当てが見える担当者の範囲では MAIL も
     * 合わせる（受信箱の「すべて」と同じ条件）。見えない範囲では LINE だけ。
     */
    const visibleScope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
    const inboxScope = {
      allowedAccountIds: [accountId],
      includeUnassigned: visibleScope.canSeeUnassigned,
    };
    const quotaToken = selectedAccount.channel_access_token;
    /*
     * LINE の送信枠は外部APIなので、DB集計と並行して始め、待つ時間に上限を
     * 置く（DASH-14）。枠の応答が遅い・止まっているときに概要全体が
     * 返らなくなるのを防ぐ。上限を超えたら枠だけ失敗として返し、
     * 友だち数などの成功分は使える状態にする。
     */
    const [overview, quota] = await Promise.all([
      getDashboardOverview(c.env.DB, period, statsScope, inboxScope, range),
      fetchQuota(quotaToken, QUOTA_OVERVIEW_BUDGET_MS),
    ]);
    if (quota.failed) {
      overview.partialFailures.push('quota');
    }
    const quotaAvailable = quota.reason === null;
    overview.sections.quota.status = quotaAvailable ? 'ok' : 'unavailable';
    overview.sections.quota.asOf = quota.asOf;
    overview.sections.quota.freshness = dashboardFreshness(quota.asOf, {
      failedSources: quotaAvailable ? 0 : 1,
      totalSources: 1,
    });
    overview.sections.quota.reason = quota.reason;
    overview.metrics.monthlyQuota = {
      value: quotaAvailable ? {
        used: quota.used,
        limit: quota.limit,
        remaining: quota.limit === null || quota.used === null
          ? null
          : Math.max(quota.limit - quota.used, 0),
        unlimited: quota.unlimited,
      } : null,
      state: quotaAvailable ? 'available' : 'unavailable',
      reason: quota.reason,
      asOf: quota.asOf,
      period: 'this-month',
    };
    const officialProfileUrl = selectedAccount.official_profile_url?.trim() || null;
    overview.metrics.officialProfileUrl = {
      value: officialProfileUrl,
      state: officialProfileUrl ? 'available' : 'unavailable',
      reason: officialProfileUrl ? null : 'not_connected',
      asOf: officialProfileUrl ? selectedAccount.updated_at : null,
      period: 'latest',
    };
    Object.assign(overview, summarizeDashboardFreshness(overview.sections));

    return c.json({
      success: true as const,
      data: {
        ...overview,
        delivery: { ...overview.delivery, quotaLimit: quota.limit, quotaUsed: quota.used },
      },
    });
  } catch (err) {
    throw err;
  }
});

/** 統括全体の運用情報は、明示的にオーナーだけへ許可する。 */
dashboard.get('/api/dashboard/organization-overview', requireRole('owner'), async (c) => {
  try {
    const selectedPeriod = readPeriod(c.req.query('period'), c.req.query('from'), c.req.query('to'));
    if (!selectedPeriod) return c.json({ success: false, error: '期間を確認してください' }, 400);
    const { period, range } = selectedPeriod;
    const visibleScope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
    const overview = await getDashboardOverview(c.env.DB, period, {
      allowedAccountIds: visibleScope.allowedAccountIds,
      includeUnassigned: false,
    }, {
      allowedAccountIds: visibleScope.allowedAccountIds,
      includeUnassigned: visibleScope.canSeeUnassigned,
    }, range);
    const credentialAccounts = await getLineAccountsByIds(
      c.env.DB,
      visibleScope.allowedAccountIds,
      c.env.LINE_CREDENTIAL_ENCRYPTION_KEY,
    );
    const quotas = await mapWithConcurrency(
      credentialAccounts,
      5,
      (account) => fetchQuota(account.channel_access_token),
    );
    const successfulQuotas = quotas.filter((quota) => quota.reason === null);
    const failedQuotaCount = quotas.length - successfulQuotas.length;
    if (failedQuotaCount > 0) {
      overview.partialFailures.push('quota');
    }
    const quotaStatus = quotas.length === 0 || successfulQuotas.length === 0
      ? 'unavailable'
      : failedQuotaCount > 0 ? 'partial' : 'ok';
    const successfulAsOf = successfulQuotas
      .map((quota) => quota.asOf)
      .filter((value): value is string => value !== null)
      .sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null;
    overview.sections.quota.status = quotaStatus;
    overview.sections.quota.asOf = successfulAsOf;
    overview.sections.quota.freshness = dashboardFreshness(successfulAsOf, {
      failedSources: quotas.length === 0 ? 1 : failedQuotaCount,
      totalSources: Math.max(quotas.length, 1),
    });
    overview.sections.quota.reason = quotaStatus === 'ok'
      ? null
      : quotas.some((quota) => quota.reason === 'fetch_failed') ? 'fetch_failed' : 'not_connected';
    const everyLimitKnown = quotas.length > 0 && quotas.every((quota) => quota.limit !== null);
    const everyUsageKnown = quotas.length > 0 && quotas.every((quota) => quota.used !== null);
    const quotaLimit = quotaStatus === 'ok' && everyLimitKnown
      ? quotas.reduce((sum, quota) => sum + (quota.limit ?? 0), 0)
      : null;
    const quotaUsed = quotaStatus === 'ok' && everyUsageKnown
      ? quotas.reduce((sum, quota) => sum + (quota.used ?? 0), 0)
      : null;
    // quotaStatus が ok のとき successfulQuotas は空でない。「全て上限なし」のときだけ立つ。
    const everyQuotaUnlimited = successfulQuotas.every((quota) => quota.unlimited);
    overview.metrics.monthlyQuota = {
      value: quotaStatus === 'ok' ? {
        used: quotaUsed,
        limit: quotaLimit,
        remaining: quotaLimit === null || quotaUsed === null ? null : Math.max(quotaLimit - quotaUsed, 0),
        unlimited: everyQuotaUnlimited,
      } : null,
      state: quotaStatus === 'ok' ? 'available' : quotaStatus,
      reason: quotaStatus !== 'ok'
        ? (quotas.some((quota) => quota.reason === 'fetch_failed') ? 'fetch_failed' : 'not_connected')
        : null,
      asOf: successfulAsOf,
      period: 'this-month',
    };
    overview.metrics.officialProfileUrl = {
      value: null,
      state: 'unavailable',
      reason: 'not_applicable',
      asOf: null,
      period: 'latest',
    };
    Object.assign(overview, summarizeDashboardFreshness(overview.sections));
    return c.json({
      success: true as const,
      data: {
        ...overview,
        delivery: {
          ...overview.delivery,
          quotaLimit,
          quotaUsed,
        },
      },
    });
  } catch (err) {
    throw err;
  }
});

dashboard.get('/api/dashboard/preferences', async (c) => {
  try {
    const access = await requireVisibleAccount(c);
    if ('response' in access) return access.response;
    const staff = c.get('staff');
    const personal = await getDashboardPreference(c.env.DB, staff.id, access.accountId);
    if (personal) {
      const cards = parseStoredCards(personal.cards);
      if (!cards) throw new Error('invalid stored dashboard preference');
      return c.json({ success: true as const, data: { source: 'personal' as const, version: personal.version, cards, updatedAt: personal.updated_at } });
    }
    const defaults = await getDashboardDefaultPreference(c.env.DB, access.accountId);
    if (defaults) {
      const cards = parseStoredCards(defaults.cards);
      if (!cards) throw new Error('invalid stored dashboard default preference');
      return c.json({ success: true as const, data: { source: 'account-default' as const, version: 0, cards, updatedAt: defaults.updated_at } });
    }
    return c.json({ success: true as const, data: { source: 'builtin' as const, version: 0, cards: null, updatedAt: null } });
  } catch (err) {
    throw err;
  }
});

dashboard.put('/api/dashboard/preferences', inputJsonBoundary(), async (c) => {
  try {
    const access = await requireVisibleAccount(c);
    if ('response' in access) return access.response;
    const body = await c.req.json<{ version?: unknown; cards?: unknown }>();
    const cards = readDashboardCards(body.cards);
    if (!Number.isInteger(body.version) || Number(body.version) < 0 || !cards) {
      return inputError(c, { success: false as const, error: '配置または版の指定が正しくありません' }, 400, ["version","cards"]);
    }
    const saved = await saveDashboardPreference(c.env.DB, {
      staffId: c.get('staff').id,
      lineAccountId: access.accountId,
      expectedVersion: Number(body.version),
      cards,
    });
    if (saved.status === 'conflict') {
      return c.json({ success: false as const, error: '別の画面で配置が更新されました。再読み込みしてください', currentVersion: saved.current.version }, 409);
    }
    auditLog(c, 'dashboard.preference.update', { kind: 'line_account', id: access.accountId });
    return c.json({ success: true as const, data: { source: 'personal' as const, version: saved.row.version, cards, updatedAt: saved.row.updated_at } });
  } catch (err) {
    throw err;
  }
});

dashboard.delete('/api/dashboard/preferences', async (c) => {
  try {
    const access = await requireVisibleAccount(c);
    if ('response' in access) return access.response;
    await deleteDashboardPreference(c.env.DB, c.get('staff').id, access.accountId);
    auditLog(c, 'dashboard.preference.reset', { kind: 'line_account', id: access.accountId });
    return c.json({ success: true as const, data: null });
  } catch (err) {
    throw err;
  }
});

dashboard.put('/api/dashboard/preferences/default', requireRole('owner'), inputJsonBoundary(), async (c) => {
  try {
    const access = await requireVisibleAccount(c);
    if ('response' in access) return access.response;
    const body = await c.req.json<{ cards?: unknown }>();
    const cards = readDashboardCards(body.cards);
    if (!cards) return inputError(c, { success: false as const, error: '配置の指定が正しくありません' }, 400, ["cards"]);
    const saved = await saveDashboardDefaultPreference(c.env.DB, {
      lineAccountId: access.accountId,
      staffId: c.get('staff').id,
      cards,
    });
    auditLog(c, 'dashboard.preference.default.update', { kind: 'line_account', id: access.accountId });
    return c.json({ success: true as const, data: { version: saved.version, cards, updatedAt: saved.updated_at } });
  } catch (err) {
    throw err;
  }
});

/**
 * M (今後の予定): 06予約配信・07リマインダ・27予約を7日分だけ束ねる。
 *
 * 新しい表は作らず、読むだけ。各機能の画面へのつなぎは一覧へのリンクに
 * 留める。`days` は1〜31に収める(収まらない値は1〜31へ丸める)。
 */
dashboard.get('/api/dashboard/upcoming', async (c) => {
  try {
    const access = await requireVisibleAccount(c);
    if ('response' in access) return access.response;
    const rawDays = Number(c.req.query('days') ?? 7);
    const days = Number.isFinite(rawDays) ? Math.min(Math.max(Math.floor(rawDays), 1), 31) : 7;
    const data = await getDashboardUpcoming(c.env.DB, {
      lineAccountId: access.accountId,
      now: new Date().toISOString(),
      days,
    });
    return c.json({ success: true as const, data });
  } catch (err) {
    throw err;
  }
});

/**
 * 数の帯の比べる値（今日の数は先週の同じ曜日、今月の数は前の月の同じ日まで）。
 *
 * 最初の表示の口（overview）を遅くしないよう、画面が後から読む別の口にする。
 * 前の記録が無い数・取れなかった数は null で返し、0 として比べさせない。
 */
dashboard.get('/api/dashboard/comparisons', async (c) => {
  try {
    const access = await requireVisibleAccount(c);
    if ('response' in access) return access.response;
    const data = await getDashboardComparisons(c.env.DB, { lineAccountId: access.accountId });
    return c.json({ success: true as const, data });
  } catch (err) {
    throw err;
  }
});

/** 日本時間の今日 0:00。失敗の「今日ぶん」の既定の境目。 */
function jstDayStart(now: Date): string {
  return `${japanDate(now)}T00:00:00+09:00`;
}

/**
 * L ( 数字の出どころ): 失敗の数を通知の送達台帳から出どころ別に数える。
 *
 * 同じ失敗は通知1件として数え、送り直しは数えない。件数は台帳の件数と
 * 一致する。カードの「i」はこの応答の出どころと時点を見せる。
 */
dashboard.get('/api/dashboard/delivery-failure-origins', async (c) => {
  try {
    const access = await requireVisibleAccount(c);
    if ('response' in access) return access.response;
    const rawSince = c.req.query('since');
    const since = rawSince ?? jstDayStart(new Date());
    if (!Number.isFinite(Date.parse(since))) {
      return c.json({ success: false as const, error: '日時の指定が正しくありません' }, 400);
    }
    const data = await getDeliveryFailureOrigins(c.env.DB, {
      lineAccountId: access.accountId,
      since,
    });
    return c.json({ success: true as const, data });
  } catch (err) {
    throw err;
  }
});

/**
 * 一覧画面の上部に出す数（タグ・テンプレート・シナリオ・リマインダ）。
 *
 * 4画面ぶんをまとめて返す。画面ごとに叩くと同じ数え方が散らばって、
 * あとで定義がずれる。1回で返して、画面側が必要なところだけ読む。
 */
dashboard.get('/api/list-stats', async (c) => {
  try {
    const accountScope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
    const selectedAccountId = readAccountId(c);
    if (selectedAccountId && !accountScope.allowedAccountIds.includes(selectedAccountId)) {
      return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
    }
    const scope = selectedAccountId
      ? { allowedAccountIds: [selectedAccountId], includeUnassigned: false }
      : {
          allowedAccountIds: accountScope.allowedAccountIds,
          includeUnassigned: accountScope.canSeeUnassigned,
        };
    return c.json({ success: true as const, data: await getListStats(c.env.DB, scope) });
  } catch (err) {
    throw err;
  }
});
