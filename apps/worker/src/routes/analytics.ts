import { parseOffsetPaging, buildOffsetListResponse } from '../lib/list-paging.js';
import { jstDate as japanDate, jstDateOffset as japanDateOffset } from '@line-crm/shared';
import { logger } from '@line-crm/shared/server';
import { serializeFunnel, funnelErrorStatus } from './analytics-funnel-display.js';
import { bookingAudience } from './styles.js';

import { isCalendarDate as isExistingCalendarDate } from '@line-crm/shared';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { Hono, type Context } from 'hono';
import { getDailyMessageCounts, getLinkClickSummary, getTrackedLinkStats, getBroadcastSummary, buildFunnelResult, getFunnelsWithCurrentVersions, getLegacyFunnels, getFunnelById, getFunnelSteps, createFunnel, deleteFunnel, countFunnelStep, createVersionedFunnel, createFunnelVersion, getFunnelWithCurrentVersion, setFunnelStatus, runChronologicalFunnel, getLatestFunnelRun, createFunnelResultAudience, createAnalyticsCrossRun, getAnalyticsCrossRun, addConversionDefinitionUsage, createAnalyticsCrossAudience, getCurrentFunnelVersion, getAnalyticsFriendsOverview, getAnalyticsReactionsOverview, getAnalyticsRoutesOverview, getAnalyticsUrlClicksOverview, getAnalyticsUsageOverview, createSavedAnalyticsFromResult, getSavedAnalytics, getSavedAnalyticsSnapshots, ANALYTICS_REPORT_SECTIONS, createAnalyticsReportSchedule, getAnalyticsReportRuns, getAnalyticsReportSchedule, getRecentOneTimeAnalyticsReportRuns, getAnalyticsReportScheduleIncludingArchived, getAnalyticsReportSchedules, requeueOneTimeAnalyticsReportSchedule, setAnalyticsReportScheduleStatus, updateAnalyticsReportSchedule, getStaffMembers, getStaffAccountScopeIds, getLineAccountById, DEFAULT_TENANT_ID, FUNNEL_STEP_KINDS, type FunnelStepKind, type AnalyticsOverviewContext, type AnalyticsReportAlertRule, type AnalyticsReportChannel, type AnalyticsReportRecipient, type AnalyticsReportSection } from '@line-crm/db';



import type { Env } from '../worker-env.js';
import { requireRole } from '../middleware/role-guard.js';
import { getVisibleLineAccountScope } from '../services/account-access.js';
import { isValidIdempotencyKey } from '../services/outbound-idempotency.js';
import { zonedWallTime } from '../services/zoned-time.js';

/**
 * 集計。
 *
 * 新しいテーブルは作らず、既にあるデータをその場で数える。
 * 外部APIも叩かないので、ここが外の障害で落ちることはない。
 */
const analytics = new Hono<Env>();

async function resolveAccount(c: Context<Env>): Promise<
  { ok: true; accountId: string } | { ok: false; response: Response }
> {
  const accountId = c.req.query('account_id')?.trim();
  if (!accountId) {
    return {
      ok: false,
      response: inputError(c, { success: false, error: 'LINE公式アカウントを選んでください' }, 400, ["account_id"]),
    };
  }
  const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
  if (!scope.allowedAccountIds.includes(accountId)) {
    return { ok: false, response: c.json({ success: false, error: 'Not found' }, 404) };
  }
  return { ok: true, accountId };
}

/**
 * 期間を読む。
 *
 * 既定は直近30日。上限を置いているのは、期間を長くするほど
 * 走査する行が増えるため。1年を超える集計が要るなら、
 * 貯める仕組みを作ってからにする。
 */
const MAX_RANGE_DAYS = 366;

function readRange(
  c: { req: { query: (k: string) => string | undefined } },
): { ok: true; value: { from: string; to: string } } | { ok: false; error: string; field?: string } {
  const now = new Date();
  const toRaw = c.req.query('to') ?? japanDate(now);
  const fromRaw =
    c.req.query('from') ??
    japanDateOffset(-30, now);

  if (!isExistingCalendarDate(fromRaw) || !isExistingCalendarDate(toRaw)) {
    return { ok: false, error: '期間は 2026-08-01 の形で指定してください' };
  }
  if (fromRaw > toRaw) {
    return { ok: false, error: '開始日が終了日より後になっています' };
  }
  const days = (Date.parse(`${toRaw}T00:00:00Z`) - Date.parse(`${fromRaw}T00:00:00Z`)) / 86_400_000;
  if (days > MAX_RANGE_DAYS) {
    return { ok: false, error: `期間は ${MAX_RANGE_DAYS} 日までにしてください` };
  }
  // 終了日はその日いっぱいを含める。'2026-08-16' で切ると、その日のぶんが
  // まるごと落ちる。
  return { ok: true, value: { from: fromRaw, to: `${toRaw}T23:59:59.999` } };
}

const MAX_OVERVIEW_RANGE_DAYS = 397;

function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function addDateDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateInZone(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function zoneOffsetMs(value: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const number = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((item) => item.type === type)?.value ?? 0);
  return Date.UTC(
    number('year'), number('month') - 1, number('day'),
    number('hour'), number('minute'), number('second'),
  ) - value.getTime();
}

function zonedDateStart(value: string, timeZone: string): string {
  const [year, month, day] = value.split('-').map(Number);
  const target = Date.UTC(year, month - 1, day);
  let guess = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    guess = target - zoneOffsetMs(new Date(guess), timeZone);
  }
  return new Date(guess).toISOString();
}

function nextReportRun(input: {
  cadence: 'weekly' | 'monthly'; weekday: number | null; monthDay: number | null;
  sendTime: string; timeZone: string; now: Date;
}): string {
  // 0時のUTC換算＋時分の加算は夏時間の切替日に1時間ずれる。
  // その日のその時刻を壁時計として解き直す（services/zoned-time.ts）。
  const currentDate = dateInZone(input.now, input.timeZone);
  const candidateDate = new Date(`${currentDate}T00:00:00.000Z`);
  if (input.cadence === 'weekly') {
    const currentWeekday = new Date(`${currentDate}T12:00:00.000Z`).getUTCDay();
    candidateDate.setUTCDate(candidateDate.getUTCDate() + ((input.weekday! - currentWeekday + 7) % 7));
  } else {
    candidateDate.setUTCDate(input.monthDay!);
    if (candidateDate.toISOString().slice(0, 10) < currentDate) candidateDate.setUTCMonth(candidateDate.getUTCMonth() + 1);
  }
  const resolve = (date: Date) =>
    Date.parse(zonedWallTime(date.toISOString().slice(0, 10), input.sendTime, input.timeZone));
  let instant = resolve(candidateDate);
  if (instant <= input.now.getTime()) {
    if (input.cadence === 'weekly') {
      candidateDate.setUTCDate(candidateDate.getUTCDate() + 7);
      instant = resolve(candidateDate);
    } else {
      candidateDate.setUTCMonth(candidateDate.getUTCMonth() + 1);
      instant = resolve(candidateDate);
    }
  }
  return new Date(instant).toISOString();
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

function parseReportBody(raw: unknown): { ok: true; value: {
  name: string; sections: AnalyticsReportSection[]; savedAnalysisIds: string[];
  cadence: 'weekly' | 'monthly'; weekday: number | null; monthDay: number | null;
  sendTime: string; timeZone: string; periodDays: number;
  recipients: AnalyticsReportRecipient[]; channels: AnalyticsReportChannel[];
  alertRules: AnalyticsReportAlertRule[];
} } | { ok: false; error: string; field?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: '入力内容が正しくありません' };
  const body = raw as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 120) return { ok: false, error: 'レポート名は1〜120文字で入力してください' , field: "name" };
  const sections = Array.isArray(body.sections)
    ? [...new Set(body.sections.filter((item): item is AnalyticsReportSection =>
      typeof item === 'string' && (ANALYTICS_REPORT_SECTIONS as readonly string[]).includes(item)))]
    : [];
  const savedAnalysisIds = Array.isArray(body.savedAnalysisIds)
    ? [...new Set(body.savedAnalysisIds.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim()))]
    : [];
  if (!sections.length && !savedAnalysisIds.length) return { ok: false, error: 'レポートに入れる項目を選んでください' , field: "sections" };
  const cadence = body.cadence === 'monthly' ? 'monthly' : body.cadence === 'weekly' ? 'weekly' : null;
  const weekday = Number.isInteger(body.weekday) ? Number(body.weekday) : null;
  const monthDay = Number.isInteger(body.monthDay) ? Number(body.monthDay) : null;
  if (!cadence || (cadence === 'weekly' && (weekday === null || weekday < 0 || weekday > 6))
    || (cadence === 'monthly' && (monthDay === null || monthDay < 1 || monthDay > 28))) {
    return { ok: false, error: '送信間隔と日を確認してください' , field: "cadence" };
  }
  const sendTime = typeof body.sendTime === 'string' ? body.sendTime : '';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(sendTime)) return { ok: false, error: '送信時刻を確認してください' , field: "sendTime" };
  const timeZone = typeof body.timeZone === 'string' ? body.timeZone.trim() : '';
  try { new Intl.DateTimeFormat('ja-JP', { timeZone }).format(new Date()); } catch { return { ok: false, error: 'タイムゾーンが正しくありません' , field: "timeZone" }; }
  const periodDays = Number(body.periodDays);
  if (!Number.isInteger(periodDays) || periodDays < 1 || periodDays > 397) return { ok: false, error: '集計期間は1〜397日で指定してください' , field: "periodDays" };
  const channels = Array.isArray(body.channels)
    ? [...new Set(body.channels.filter((item): item is AnalyticsReportChannel => item === 'dashboard' || item === 'email' || item === 'line'))]
    : [];
  if (!channels.length) return { ok: false, error: '通知方法を選んでください' , field: "channels" };
  const recipients: AnalyticsReportRecipient[] = [];
  // 形が合わない宛先を黙って外さない。正しい宛先と混ざっていても、
  // 不備のある行を示して止める（送ったつもりが届いていないを防ぐ）。
  for (const item of Array.isArray(body.recipients) ? body.recipients : []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: '宛先に読み取れない行があります' , field: "recipients" };
    }
    const value = item as Record<string, unknown>;
    const label = typeof value.label === 'string' ? value.label.trim().slice(0, 120) : '';
    if (value.kind === 'staff') {
      if (typeof value.staffId !== 'string' || !value.staffId.trim()) {
        return { ok: false, error: '宛先のログインユーザーを読み取れませんでした' , field: "recipients" };
      }
      recipients.push({ kind: 'staff', staffId: value.staffId.trim(), label: label || 'ログインユーザー' });
    } else if (value.kind === 'email') {
      const email = typeof value.email === 'string' ? value.email.trim() : '';
      if (!isEmail(email)) {
        return { ok: false, error: `宛先のメールアドレス「${email || '(空)'}」は形が正しくありません` , field: "recipients" };
      }
      recipients.push({ kind: 'email', email: email.toLowerCase(), label: label || email });
    } else {
      return { ok: false, error: '宛先に読み取れない行があります' , field: "recipients" };
    }
  }
  if (!recipients.length) return { ok: false, error: '受け取る人を選んでください' , field: "recipients" };
  const alertRules = Array.isArray(body.alertRules) ? body.alertRules.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const value = item as Record<string, unknown>;
    const metric = value.metric;
    const operator = value.operator;
    const threshold = Number(value.threshold);
    const minimumSample = Number(value.minimumSample);
    if ((metric !== 'block_rate' && metric !== 'friend_adds' && metric !== 'conversions')
      || (operator !== 'greater_than' && operator !== 'decrease_percent' && operator !== 'zero_streak_days')
      || !Number.isFinite(threshold) || threshold < 0
      || !Number.isInteger(minimumSample) || minimumSample < 1) return [];
    return [{ metric, operator, threshold, minimumSample } as AnalyticsReportAlertRule];
  }) : [];
  return { ok: true, value: { name, sections, savedAnalysisIds, cadence, weekday: cadence === 'weekly' ? weekday : null,
    monthDay: cadence === 'monthly' ? monthDay : null, sendTime, timeZone, periodDays, recipients, channels, alertRules } };
}

export function readAnalyticsOverviewRange(
  query: (key: string) => string | undefined,
  timeZone: string,
  now = new Date(),
): { ok: true; value: Omit<AnalyticsOverviewContext, 'lineAccountId'> } |
   { ok: false; error: string; field?: string } {
  const toDate = query('to') ?? dateInZone(now, timeZone);
  const fromDate = query('from') ?? addDateDays(toDate, -29);
  if (!isDateOnly(fromDate) || !isDateOnly(toDate)) {
    return { ok: false, error: '期間は 2026-08-01 の形で指定してください' };
  }
  if (fromDate > toDate) {
    return { ok: false, error: '開始日が終了日より後になっています' };
  }
  const days = Math.round(
    (Date.parse(`${toDate}T00:00:00.000Z`) - Date.parse(`${fromDate}T00:00:00.000Z`)) /
      86_400_000,
  ) + 1;
  if (days > MAX_OVERVIEW_RANGE_DAYS) {
    return { ok: false, error: '詳細な分析は13か月までにしてください' };
  }
  return {
    ok: true,
    value: {
      timeZone,
      fromDate,
      toDate,
      from: zonedDateStart(fromDate, timeZone),
      toExclusive: zonedDateStart(addDateDays(toDate, 1), timeZone),
      dataCutoffAt: now.toISOString(),
    },
  };
}

async function overviewContext(
  c: Context<Env>,
  accountId: string,
): Promise<{ ok: true; value: AnalyticsOverviewContext } | { ok: false; response: Response }> {
  const selected = await getLineAccountById(c.env.DB, accountId);
  if (!selected) return { ok: false, response: c.json({ success: false, error: 'Not found' }, 404) };
  const range = readAnalyticsOverviewRange(
    (key) => c.req.query(key),
    selected.timezone || 'Asia/Tokyo',
  );
  if (!range.ok) {
    return { ok: false, response: inputError(c, { success: false, error: range.error }, 400, []) };
  }
  return { ok: true, value: { lineAccountId: accountId, ...range.value } };
}

function explicitTimestamp(value: unknown, code: string): string {
  if (typeof value !== 'string' || !/(Z|[+-]\d{2}:?\d{2})$/.test(value)) throw new Error(code);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(code);
  return parsed.toISOString();
}

analytics.get('/api/analytics/friends', async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account.ok) return account.response;
    const context = await overviewContext(c, account.accountId);
    if (!context.ok) return context.response;
    return c.json({ success: true, data: await getAnalyticsFriendsOverview(c.env.DB, context.value) });
  } catch (error) {
    throw error;
  }
});

analytics.get('/api/analytics/reactions', async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account.ok) return account.response;
    const context = await overviewContext(c, account.accountId);
    if (!context.ok) return context.response;
    return c.json({ success: true, data: await getAnalyticsReactionsOverview(c.env.DB, context.value) });
  } catch (error) {
    throw error;
  }
});

analytics.get('/api/analytics/routes', async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account.ok) return account.response;
    const context = await overviewContext(c, account.accountId);
    if (!context.ok) return context.response;
    return c.json({ success: true, data: await getAnalyticsRoutesOverview(c.env.DB, context.value) });
  } catch (error) {
    throw error;
  }
});

analytics.get('/api/analytics/url-clicks', async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account.ok) return account.response;
    const context = await overviewContext(c, account.accountId);
    if (!context.ok) return context.response;
    const limitRaw = c.req.query('limit');
    const { limit } = parseOffsetPaging({ limit: limitRaw }, { defaultLimit: 200, limitPolicy: {} });
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      return c.json({ success: false, error: '表示件数は1〜200で指定してください' }, 400);
    }
    // 監査 R72: 検索語はSQL側で絞る。取得済みの上位200件の中だけを探していた時期は、
    // それより先のURLに辿り着けなかった。
    const query = (c.req.query('query') ?? '').trim().slice(0, 200) || undefined;
    return c.json({
      success: true,
      data: await getAnalyticsUrlClicksOverview(c.env.DB, context.value, limit, query),
    });
  } catch (error) {
    throw error;
  }
});

analytics.get('/api/analytics/usage', async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account.ok) return account.response;
    const context = await overviewContext(c, account.accountId);
    if (!context.ok) return context.response;
    return c.json({ success: true, data: await getAnalyticsUsageOverview(c.env.DB, context.value) });
  } catch (error) {
    throw error;
  }
});

// GET /api/analytics/messages — 日ごとの送受信数
analytics.get('/api/analytics/messages', async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account.ok) return account.response;
    const range = readRange(c);
    if (!range.ok) return c.json({ success: false, error: range.error }, 400);
    const items = await getDailyMessageCounts(c.env.DB, account.accountId, range.value);
    return c.json({ success: true, data: items });
  } catch (err) {
    throw err;
  }
});

// GET /api/analytics/tracked-links — 測定中のURLと、その期間のクリック
// link-clicks と違い、1回も押されていないURLも返す。
analytics.get('/api/analytics/tracked-links', async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account.ok) return account.response;
    const range = readRange(c);
    if (!range.ok) return c.json({ success: false, error: range.error }, 400);
    const items = await getTrackedLinkStats(c.env.DB, account.accountId, range.value);
    return c.json({ success: true, data: items });
  } catch (err) {
    throw err;
  }
});

// GET /api/analytics/link-clicks — リンクごとのクリック
analytics.get('/api/analytics/link-clicks', async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account.ok) return account.response;
    const range = readRange(c);
    if (!range.ok) return c.json({ success: false, error: range.error }, 400);
    const items = await getLinkClickSummary(c.env.DB, account.accountId, range.value);
    return c.json({ success: true, data: items });
  } catch (err) {
    throw err;
  }
});

// GET /api/analytics/broadcasts — 配信ごとの成績
analytics.get('/api/analytics/broadcasts', async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account.ok) return account.response;
    const range = readRange(c);
    if (!range.ok) return c.json({ success: false, error: range.error }, 400);
    const items = await getBroadcastSummary(c.env.DB, account.accountId, range.value);
    return c.json({ success: true, data: items });
  } catch (err) {
    throw err;
  }
});

// クロス分析はCronで非同期実行し、HTTPの処理時間とD1負荷を固定する。
analytics.post('/api/analytics/cross/query', inputJsonBoundary(), async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account.ok) return account.response;
    const selectedAccount = await getLineAccountById(c.env.DB, account.accountId);
    if (!selectedAccount) return c.json({ success: false, error: 'Not found' }, 404);
    // 実行は重い。終わっていない自分の集計がある間は受け付けない。
    // 実行ボタンは運用担当にも出しているので、権限ではなく間隔で守る。
    const busy = await c.env.DB
      .prepare(
        `SELECT id FROM analytics_cross_runs
          WHERE line_account_id = ? AND state IN ('pending', 'running')
          LIMIT 1`,
      )
      .bind(account.accountId)
      .first<{ id: string }>();
    if (busy) return c.json({ success: false, error: 'analytics_cross_busy' }, 429);
    const body = await c.req.json<unknown>();
    const result = await createAnalyticsCrossRun(c.env.DB, {
      lineAccountId: account.accountId,
      query: body,
      timeZone: selectedAccount.timezone || 'Asia/Tokyo',
      dataCutoffAt: new Date().toISOString(),
      createdBy: c.get('staff').id,
    });
    return c.json({ success: true, data: result }, 202);
  } catch (error) {
    const status = funnelErrorStatus(error);
    if (status === 500) throw error;
    return inputError(c, {
      success: false,
      error: (error as Error).message,
    }, status, []);
  }
});

analytics.get('/api/analytics/cross/results/:id', async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account.ok) return account.response;
    const result = await getAnalyticsCrossRun(c.env.DB, account.accountId, c.req.param('id'));
    if (!result) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: result });
  } catch (error) {
    throw error;
  }
});

// ── 保存した分析 ─────────────────────────────────────────────

analytics.get('/api/analytics/saved', async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account.ok) return account.response;
    return c.json({ success: true, data: await getSavedAnalytics(c.env.DB, account.accountId) });
  } catch (error) {
    throw error;
  }
});

analytics.post('/api/analytics/saved', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account.ok) return account.response;
    const body = await c.req.json<{
      name?: unknown;
      sourceKind?: unknown;
      sourceResultId?: unknown;
    }>();
    if (body.sourceKind !== 'cross' && body.sourceKind !== 'funnel') {
      return inputError(c, { success: false, error: '分析の種類が不正です' }, 422, ["sourceKind"]);
    }
    if (typeof body.sourceResultId !== 'string' || !body.sourceResultId.trim()) {
      return inputError(c, { success: false, error: '保存する分析結果が必要です' }, 422, ["sourceResultId"]);
    }
    const staff = c.get('staff');
    const result = await createSavedAnalyticsFromResult(c.env.DB, {
      lineAccountId: account.accountId,
      name: typeof body.name === 'string' ? body.name : '',
      sourceKind: body.sourceKind,
      sourceResultId: body.sourceResultId.trim(),
      createdBy: staff.id,
      createdByName: staff.name,
      createdAt: new Date().toISOString(),
    });
    return c.json({ success: true, data: result }, 201);
  } catch (error) {
    const status = funnelErrorStatus(error);
    if (status === 500) throw error;
    return inputError(c, {
      success: false,
      error: (error as Error).message,
    }, status, []);
  }
});

analytics.get('/api/analytics/saved/:id/snapshots', async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account.ok) return account.response;
    const items = await getSavedAnalyticsSnapshots(c.env.DB, account.accountId, c.req.param('id'));
    if (!items) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: items });
  } catch (error) {
    throw error;
  }
});

// ── 定期レポート ────────────────────────────────────────────

async function reportRecipientOptions(c: Context<Env>, accountId: string) {
  const signedIn = c.get('staff');
  const members = await getStaffMembers(c.env.DB, signedIn.tenantId ?? DEFAULT_TENANT_ID);
  const visible = [];
  for (const member of members) {
    if (!member.is_active || member.invite_status !== 'active') continue;
    if (member.account_scope === 'accounts') {
      const scope = await getStaffAccountScopeIds(c.env.DB, member.id);
      if (!scope.includes(accountId)) continue;
    }
    visible.push({
      id: member.id, name: member.name, role: member.role,
      email: member.email, lineLinked: Boolean(member.line_user_id),
    });
  }
  return visible;
}

analytics.get('/api/analytics/report-schedules', async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account.ok) return account.response;
    const selected = await getLineAccountById(c.env.DB, account.accountId);
    if (!selected) return c.json({ success: false, error: 'Not found' }, 404);
    const [items, savedAnalyses, recipients, recentOneTime] = await Promise.all([
      getAnalyticsReportSchedules(c.env.DB, account.accountId),
      getSavedAnalytics(c.env.DB, account.accountId),
      reportRecipientOptions(c, account.accountId),
      // しまった1回送信の直近分も返す。一覧から消えても
      // 失敗に気づき、依頼IDの結果へ進めるようにする。
      getRecentOneTimeAnalyticsReportRuns(c.env.DB, account.accountId),
    ]);
    return c.json({
      success: true,
      data: {
        items,
        recentOneTime,
        options: {
          timeZone: selected.timezone || 'Asia/Tokyo',
          savedAnalyses: savedAnalyses.map((item) => ({ id: item.id, name: item.name, kind: item.kind })),
          recipients,
        },
      },
    });
  } catch (error) {
    throw error;
  }
});

async function validateReportPayload(
  c: Context<Env>, accountId: string,
  value: Extract<ReturnType<typeof parseReportBody>, { ok: true }>['value'],
): Promise<string | null> {
  const [saved, recipientOptions] = await Promise.all([
    getSavedAnalytics(c.env.DB, accountId),
    reportRecipientOptions(c, accountId),
  ]);
  const visibleSavedIds = new Set(saved.map((item) => item.id));
  if (!value.savedAnalysisIds.every((id) => visibleSavedIds.has(id))) {
    return '選べない保存済み分析が含まれています';
  }
  const staffById = new Map(recipientOptions.map((item) => [item.id, item]));
  if (!value.recipients.every((recipient) => recipient.kind === 'email'
    || Boolean(recipient.staffId && staffById.has(recipient.staffId)))) {
    return 'このLINEアカウントを見られない宛先が含まれています';
  }
  if (value.channels.includes('email')) {
    const hasEmail = value.recipients.some((recipient) => recipient.kind === 'email'
      || Boolean(recipient.staffId && staffById.get(recipient.staffId)?.email));
    if (!hasEmail) return 'メールを受け取れる宛先がありません';
  }
  if (value.channels.includes('line')) {
    const hasLine = value.recipients.some((recipient) => recipient.kind === 'staff'
      && Boolean(recipient.staffId && staffById.get(recipient.staffId)?.lineLinked));
    if (!hasLine) return 'LINE連携済みの宛先がありません';
  }
  return null;
}

function expectedUpdatedAtOf(rawBody: unknown): string | null {
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) return null;
  const value = (rawBody as Record<string, unknown>).expectedUpdatedAt;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

const REPORT_SCHEDULE_CONFLICT =
  'この定期レポートは別の画面で先に更新されました。最新の内容を読み込み直してください';

/*
 * 同じ要求キーで同じ内容なら、既にある予約を返す。
 *
 * 作成の直後に応答だけ失われると、画面は失敗表示のまま「つくって動かす」を
 * もう一度押せる。要求キーなしでは2件目の有効な予約ができ、同じ内容が重複
 * して届く。次回予定（nextRunAt）と作った人は要求のたびに変わるので比べない。
 */
function sameReportCreateRequest(
  existing: {
    name: string; sections: unknown; savedAnalysisIds: unknown; cadence: string;
    weekday: number | null; monthDay: number | null; sendTime: string; timeZone: string;
    periodDays: number; recipients: unknown; channels: unknown; alertRules: unknown;
    isOneTime: boolean;
  },
  value: {
    name: string; sections: unknown; savedAnalysisIds: unknown; cadence: string;
    weekday: number | null; monthDay: number | null; sendTime: string; timeZone: string;
    periodDays: number; recipients: unknown; channels: unknown; alertRules: unknown;
  },
  sendOnce: boolean,
): boolean {
  return existing.isOneTime === sendOnce
    && existing.name === value.name
    && JSON.stringify(existing.sections) === JSON.stringify(value.sections)
    && JSON.stringify(existing.savedAnalysisIds) === JSON.stringify(value.savedAnalysisIds)
    && existing.cadence === value.cadence
    && existing.weekday === value.weekday
    && existing.monthDay === value.monthDay
    && existing.sendTime === value.sendTime
    && existing.timeZone === value.timeZone
    && existing.periodDays === value.periodDays
    && JSON.stringify(existing.recipients) === JSON.stringify(value.recipients)
    && JSON.stringify(existing.channels) === JSON.stringify(value.channels)
    && JSON.stringify(existing.alertRules) === JSON.stringify(value.alertRules);
}

function reportScheduleIdConflict(existingId: string) {
  return {
    success: false,
    error: '同じ操作で内容の違う予約が既にあります。一覧で既にある予約を確認してください',
    data: { existingId },
  };
}

analytics.post('/api/analytics/report-schedules', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account.ok) return account.response;
    const rawBody = await c.req.json<unknown>();
    const parsed = parseReportBody(rawBody);
    if (!parsed.ok) return inputError(c, { success: false, error: parsed.error, field: parsed.field }, 422, []);
    const selected = await getLineAccountById(c.env.DB, account.accountId);
    if (!selected) return c.json({ success: false, error: 'Not found' }, 404);
    if ((selected.timezone || 'Asia/Tokyo') !== parsed.value.timeZone) {
      return inputError(c, { success: false, error: '選択中のLINEアカウントとタイムゾーンが一致しません' }, 422, ["timeZone"]);
    }
    const validationError = await validateReportPayload(c, account.accountId, parsed.value);
    if (validationError) return inputError(c, { success: false, error: validationError }, 422, [validationError.includes('保存済み分析') ? 'savedAnalysisIds' : 'recipients']);
    // 要求キー（UUID）を付けた作成は、応答消失後の再送でも
    // 同じ予約へ戻す。キーが無い従来の呼び出しはそのまま通す。
    const idempotencyKey = c.req.header('Idempotency-Key')?.trim() || null;
    if (idempotencyKey && !isValidIdempotencyKey(idempotencyKey)) {
      return inputError(c, { success: false, error: 'Idempotency-Key はUUIDで送ってください' }, 400, []);
    }
    const now = new Date();
    const sendOnce = Boolean(rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)
      && (rawBody as Record<string, unknown>).sendOnce === true);
    if (idempotencyKey) {
      const existing = await getAnalyticsReportScheduleIncludingArchived(
        c.env.DB, idempotencyKey, account.accountId,
      );
      if (existing) {
        if (!sameReportCreateRequest(existing, parsed.value, sendOnce)) {
          return c.json(reportScheduleIdConflict(existing.id), 409);
        }
        c.header('Idempotency-Replayed', 'true');
        return c.json({ success: true, data: existing, replayed: true }, 200);
      }
    }
    const payload = {
      lineAccountId: account.accountId,
      ...parsed.value,
      nextRunAt: sendOnce ? now.toISOString() : nextReportRun({
        cadence: parsed.value.cadence, weekday: parsed.value.weekday,
        monthDay: parsed.value.monthDay, sendTime: parsed.value.sendTime,
        timeZone: parsed.value.timeZone, now,
      }),
      createdBy: c.get('staff').id,
      now: now.toISOString(),
      isOneTime: sendOnce,
    };
    try {
      const item = await createAnalyticsReportSchedule(c.env.DB, {
        ...payload,
        // 要求キーをそのまま行の主キーにする。同時に届いた再送は
        // 主キーの一意性で1本だけ通り、負けた側は下で回収する。
        ...(idempotencyKey ? { id: idempotencyKey } : {}),
      });
      return c.json({ success: true, data: item }, 201);
    } catch (createError) {
      // 同時実行の競合で負けた側。勝った行を読み直し、同じ内容なら
      // その予約を返す。内容が違うキー使い回しは409で止める。
      if (!idempotencyKey) throw createError;
      const raced = await getAnalyticsReportScheduleIncludingArchived(
        c.env.DB, idempotencyKey, account.accountId,
      );
      if (!raced) throw createError;
      if (!sameReportCreateRequest(raced, parsed.value, sendOnce)) {
        return c.json(reportScheduleIdConflict(raced.id), 409);
      }
      c.header('Idempotency-Replayed', 'true');
      return c.json({ success: true, data: raced, replayed: true }, 200);
    }
  } catch (error) {
    throw error;
  }
});

analytics.put('/api/analytics/report-schedules/:id', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account.ok) return account.response;
    const rawBody = await c.req.json<unknown>();
    const parsed = parseReportBody(rawBody);
    if (!parsed.ok) return inputError(c, { success: false, error: parsed.error, field: parsed.field }, 422, []);
    const expectedUpdatedAt = expectedUpdatedAtOf(rawBody);
    if (!expectedUpdatedAt) {
      return inputError(c, { success: false, error: 'expectedUpdatedAtを付けてください' }, 422, ["expectedUpdatedAt"]);
    }
    const selected = await getLineAccountById(c.env.DB, account.accountId);
    if (!selected) return c.json({ success: false, error: 'Not found' }, 404);
    if ((selected.timezone || 'Asia/Tokyo') !== parsed.value.timeZone) {
      return inputError(c, { success: false, error: '選択中のLINEアカウントとタイムゾーンが一致しません' }, 422, ["timeZone"]);
    }
    const existing = await getAnalyticsReportSchedule(c.env.DB, c.req.param('id'), account.accountId);
    if (!existing) return c.json({ success: false, error: 'Not found' }, 404);
    if (existing.isOneTime) {
      return inputError(c, { success: false, error: '1回だけ送る依頼は変更できません' }, 422, []);
    }
    const validationError = await validateReportPayload(c, account.accountId, parsed.value);
    if (validationError) return inputError(c, { success: false, error: validationError }, 422, [validationError.includes('保存済み分析') ? 'savedAnalysisIds' : 'recipients']);
    const now = new Date();
    const outcome = await updateAnalyticsReportSchedule(c.env.DB, {
      id: existing.id, lineAccountId: account.accountId, expectedUpdatedAt,
      ...parsed.value,
      // 編集した内容の次回予定へそろえる。過去に積み残した回は送り直さない。
      nextRunAt: nextReportRun({
        cadence: parsed.value.cadence, weekday: parsed.value.weekday,
        monthDay: parsed.value.monthDay, sendTime: parsed.value.sendTime,
        timeZone: parsed.value.timeZone, now,
      }),
      now: now.toISOString(),
    });
    if (outcome === 'conflict') return c.json({ success: false, error: REPORT_SCHEDULE_CONFLICT }, 409);
    if (outcome === 'missing') return c.json({ success: false, error: 'Not found' }, 404);
    const item = await getAnalyticsReportSchedule(c.env.DB, existing.id, account.accountId);
    return c.json({ success: true, data: item });
  } catch (error) {
    throw error;
  }
});

analytics.put('/api/analytics/report-schedules/:id/status', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account.ok) return account.response;
    const rawBody = await c.req.json<unknown>().catch(() => null);
    const expectedUpdatedAt = expectedUpdatedAtOf(rawBody);
    if (!expectedUpdatedAt) {
      return inputError(c, { success: false, error: 'expectedUpdatedAtを付けてください' }, 422, ["expectedUpdatedAt"]);
    }
    const requested = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)
      ? (rawBody as Record<string, unknown>).status : null;
    if (requested !== 'paused' && requested !== 'active' && requested !== 'archived') {
      return inputError(c, { success: false, error: 'statusにはpaused・active・archivedのどれかを指定してください' }, 422, ["status"]);
    }
    const existing = await getAnalyticsReportSchedule(c.env.DB, c.req.param('id'), account.accountId);
    if (!existing) return c.json({ success: false, error: 'Not found' }, 404);
    if (existing.isOneTime) {
      return inputError(c, { success: false, error: '1回だけ送る依頼は変更できません' }, 422, []);
    }
    if (existing.status === requested) {
      // 同じ状態への再送はそのまま返す。一覧を二度押ししても壊れない。
      return c.json({ success: true, data: existing });
    }
    const now = new Date();
    const outcome = await setAnalyticsReportScheduleStatus(c.env.DB, {
      id: existing.id, lineAccountId: account.accountId, status: requested,
      expectedUpdatedAt,
      // 再開はこれからの回だけにする。止まっていた間の回は送り直さず、
      // 同じ予定時刻が二重に送られることもない。
      nextRunAt: requested === 'active' ? nextReportRun({
        cadence: existing.cadence, weekday: existing.weekday, monthDay: existing.monthDay,
        sendTime: existing.sendTime, timeZone: existing.timeZone, now,
      }) : undefined,
      now: now.toISOString(),
    });
    if (outcome === 'conflict') return c.json({ success: false, error: REPORT_SCHEDULE_CONFLICT }, 409);
    if (outcome === 'missing') return c.json({ success: false, error: 'Not found' }, 404);
    const item = await getAnalyticsReportSchedule(c.env.DB, existing.id, account.accountId);
    return c.json({ success: true, data: item });
  } catch (error) {
    throw error;
  }
});

// 1回送信の依頼は送信後に一覧から消える（archived のため）。
// 依頼IDから失敗理由・宛先別結果へ到達できるよう、履歴を返す。
// しまったものも含めて引くが、別アカウントのIDは Not found にする。
analytics.get('/api/analytics/report-schedules/:id/runs', async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account.ok) return account.response;
    const schedule = await getAnalyticsReportScheduleIncludingArchived(
      c.env.DB, c.req.param('id'), account.accountId,
    );
    if (!schedule) return c.json({ success: false, error: 'Not found' }, 404);
    const runs = await getAnalyticsReportRuns(c.env.DB, {
      scheduleId: schedule.id, lineAccountId: account.accountId,
    });
    return c.json({ success: true, data: { schedule, runs } });
  } catch (error) {
    throw error;
  }
});

// 確定失敗の1回送信だけ送り直せる入口。一部でも届いたものは
// 送り直さない（重複を防ぐ）。届いていないことの確認は最新履歴の
// 宛先別結果で行い、送り直しは新しい実行記録として残す。
analytics.post('/api/analytics/report-schedules/:id/retry', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account.ok) return account.response;
    const schedule = await getAnalyticsReportScheduleIncludingArchived(
      c.env.DB, c.req.param('id'), account.accountId,
    );
    if (!schedule || !schedule.isOneTime || schedule.status !== 'archived') {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    const runs = await getAnalyticsReportRuns(c.env.DB, {
      scheduleId: schedule.id, lineAccountId: account.accountId, limit: 1,
    });
    const latest = runs[0] ?? null;
    if (!latest || latest.state === 'running') {
      return inputError(c, { success: false, error: '送信結果がまだ確定していません' }, 422, []);
    }
    const sent = latest.deliveryResults.some(
      (item) => Boolean(item) && typeof item === 'object'
        && (item as { status?: unknown }).status === 'sent',
    );
    if (sent) {
      return inputError(c, { success: false, error: '一部は届いているため送り直せません' }, 422, []);
    }
    const outcome = await requeueOneTimeAnalyticsReportSchedule(c.env.DB, {
      id: schedule.id, lineAccountId: account.accountId, now: new Date().toISOString(),
    });
    if (outcome === 'missing') return c.json({ success: false, error: 'Not found' }, 404);
    const item = await getAnalyticsReportSchedule(c.env.DB, schedule.id, account.accountId);
    return c.json({ success: true, data: item });
  } catch (error) {
    throw error;
  }
});

// ── ファネル ────────────────────────────────────────────────

analytics.get('/api/funnels', async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account.ok) return account.response;
    const items = await getLegacyFunnels(c.env.DB, account.accountId);
    return c.json({ success: true, data: items.map(serializeFunnel) });
  } catch (err) {
    throw err;
  }
});

// 作成時点の段・期間・比較条件を第1版として固定する。
/**
 * 段に「成果」が入ったファネルを保存したら、成果地点側の
 * 「使う場所」台帳へこのファネルを実IDで記す。
 *
 * 段の中の conversionPointId は作る側で確かめ済み(同じアカウントの
 * 実在する地点のみ通る)。台帳への記録は成果地点の版でCASするので、
 * 途中で地点が編集されていたら版を読み直して1回だけやり直す。
 * ここが失敗してもファネル自体は作れているので、ログを残して
 * 作成の成功は変えない。
 */
/*
 * 段に置かれた成果地点への利用関係を必ず記す。
 * 下書き・停止中の地点は手追加の口では弾くが、ファネルの段は実際に
 * 参照している事実なので allowInactive で記す。登録に失敗した地点名を
 * 返し、呼び出し側は応答へ載せる——作成は成功したのに利用先一覧へ
 * 出ない、という静かな食い違いを作らない。
 */
async function registerFunnelConversionUsages(
  db: D1Database,
  lineAccountId: string,
  funnelId: string,
  refVersionId: string | null,
  steps: ReadonlyArray<{ kind: string; match?: Record<string, string> }> | undefined,
  staffId: string,
): Promise<string[]> {
  const pointIds = [...new Set(
    (steps ?? [])
      .filter((step) => step.kind === 'conversion' && typeof step.match?.conversionPointId === 'string')
      .map((step) => step.match!.conversionPointId),
  )];
  const failed: string[] = [];
  for (const pointId of pointIds) {
    let pointName = pointId;
    let registered = false;
    for (let attempt = 0; attempt < 2 && !registered; attempt += 1) {
      try {
        const point = await db
          .prepare('SELECT version, name FROM conversion_points WHERE id = ?')
          .bind(pointId)
          .first<{ version: number; name: string }>();
        if (!point) break;
        pointName = point.name || pointId;
        await addConversionDefinitionUsage(db, {
          conversionPointId: pointId,
          lineAccountId,
          expectedVersion: Number(point.version),
          refKind: 'analytics',
          refId: funnelId,
          refVersionId,
          staffId,
          allowInactive: true,
        });
        registered = true;
      } catch (error) {
        // instanceof ではなく code を見る。テストでモジュールごと差し替わる
        // 経路でも、版競合のやり直し1回だけが働く形にする。
        const code = (error as { code?: string } | null)?.code;
        if (code === 'version_conflict' && attempt === 0) {
          continue;
        }
        logger.error("analytics.register_funnel_conversion_usages_failed");
      }
    }
    if (!registered) failed.push(pointName);
  }
  return failed;
}

analytics.get('/api/analytics/funnels', async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account.ok) return account.response;
    const { page, limit: pageSize } = parseOffsetPaging({ limit: c.req.query('pageSize'), page: c.req.query('page') }, { defaultLimit: 200, limitPolicy: {}, pagePolicy: {} });
    if (!Number.isInteger(page) || page < 1) {
      return c.json({ success: false, error: 'ページは1以上の整数で指定してください' }, 400);
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
      return c.json({ success: false, error: '表示件数は1〜200で指定してください' }, 400);
    }
    const result = await getFunnelsWithCurrentVersions(
      c.env.DB,
      account.accountId,
      { page, pageSize, includeInactive: c.req.query('includeInactive') === '1' },
    );
    const items = result.items.map((funnel) => ({
      ...serializeFunnel(funnel),
      currentVersion: funnel.currentVersion,
      migrationState: funnel.currentVersion ? 'ready' : 'needs_migration',
    }));
    const responseItems = items;
    return c.json(buildOffsetListResponse({ success: true,
      data: responseItems,
      pagination: { page: result.page, pageSize: result.pageSize, total: result.total }, items: responseItems, total: result.total, paging: { limit: result.pageSize, offset: (page - 1) * pageSize }, sort: [] }));
  } catch (error) {
    throw error;
  }
});

analytics.post('/api/analytics/funnels', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account.ok) return account.response;
    const body = await c.req.json<{
      name?: unknown; windowDays?: unknown; steps?: unknown;
      segment?: unknown; comparisonGroups?: unknown;
    }>();
    const created = await createVersionedFunnel(c.env.DB, {
      lineAccountId: account.accountId,
      name: typeof body.name === 'string' ? body.name : '',
      windowDays: body.windowDays === undefined ? 30 : Number(body.windowDays),
      steps: body.steps,
      segment: body.segment,
      comparisonGroups: body.comparisonGroups,
      createdBy: c.get('staff').id,
      createdAt: new Date().toISOString(),
    });
    const usageWarnings = await registerFunnelConversionUsages(
      c.env.DB,
      account.accountId,
      created.funnelId,
      created.version.id,
      created.version.steps,
      c.get('staff').id,
    );
    return c.json({ success: true, data: { ...created, usageWarnings } }, 201);
  } catch (error) {
    const status = funnelErrorStatus(error);
    if (status === 500) throw error;
    return inputError(c, { success: false, error: (error as Error).message }, status, []);
  }
});

// 編集画面が現在の定義を丸ごと読む口。停止・保管中のファネルも中身は読める。
analytics.get('/api/analytics/funnels/:id', async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account.ok) return account.response;
    const found = await getFunnelWithCurrentVersion(
      c.env.DB,
      account.accountId,
      c.req.param('id'),
    );
    if (!found) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({
      success: true,
      data: {
        ...serializeFunnel(found.funnel),
        currentVersion: found.currentVersion,
      },
    });
  } catch (error) {
    throw error;
  }
});

analytics.post('/api/analytics/funnels/:id/versions', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account.ok) return account.response;
    const body = await c.req.json<{
      windowDays?: unknown; steps?: unknown; segment?: unknown; comparisonGroups?: unknown;
      expectedVersionNumber?: unknown; name?: unknown;
    }>();
    const version = await createFunnelVersion(c.env.DB, {
      lineAccountId: account.accountId,
      funnelId: c.req.param('id'),
      windowDays: Number(body.windowDays),
      steps: body.steps,
      segment: body.segment,
      comparisonGroups: body.comparisonGroups,
      expectedVersionNumber: body.expectedVersionNumber === undefined
        ? undefined
        : Number(body.expectedVersionNumber),
      name: typeof body.name === 'string' ? body.name : undefined,
      createdBy: c.get('staff').id,
      createdAt: new Date().toISOString(),
    });
    const usageWarnings = await registerFunnelConversionUsages(
      c.env.DB,
      account.accountId,
      c.req.param('id'),
      version.id,
      version.steps,
      c.get('staff').id,
    );
    return c.json({ success: true, data: { ...version, usageWarnings } }, 201);
  } catch (error) {
    const status = funnelErrorStatus(error);
    if (status === 500) throw error;
    return inputError(c, { success: false, error: (error as Error).message }, status, []);
  }
});

// 停止・保管・再開。今の状態を expectedStatus で渡させ、二重操作や読み違えを 409 で弾く。
analytics.put('/api/analytics/funnels/:id/status', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account.ok) return account.response;
    const body = await c.req.json<{ status?: unknown; expectedStatus?: unknown; expectedRevision?: unknown }>();
    if (body.expectedRevision !== undefined && (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1)) {
      return inputError(c, { success: false, error: 'analytics_funnel_revision_invalid' }, 422, ["expectedRevision"]);
    }
    const next = String(body.status ?? '');
    const expected = String(body.expectedStatus ?? '');
    if (!['active', 'stopped', 'archived'].includes(next)
        || !['active', 'stopped', 'archived'].includes(expected)) {
      return inputError(c, { success: false, error: 'analytics_funnel_status_invalid' }, 422, ["status","expectedStatus"]);
    }
    const funnel = await setFunnelStatus(c.env.DB, {
      lineAccountId: account.accountId,
      funnelId: c.req.param('id'),
      status: next as 'active' | 'stopped' | 'archived',
      expectedStatus: expected as 'active' | 'stopped' | 'archived',
      ...(body.expectedRevision === undefined ? {} : { expectedRevision: body.expectedRevision as number }),
    });
    return c.json({ success: true, data: serializeFunnel(funnel) });
  } catch (error) {
    const status = funnelErrorStatus(error);
    if (status === 500) throw error;
    return inputError(c, { success: false, error: (error as Error).message }, status, []);
  }
});

analytics.post('/api/analytics/funnels/:id/run', inputJsonBoundary(), async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account.ok) return account.response;
    const selectedAccount = await getLineAccountById(c.env.DB, account.accountId);
    if (!selectedAccount) return c.json({ success: false, error: 'Not found' }, 404);
    // 再集計はHTTPの中で時系列計算を同期実行する。連打がD1負荷に直結するので、
    // 同一ファネルは前回から60秒は受け付けない。再集計ボタンは運用担当にも
    // 出しているので、権限ではなく間隔で守る。
    const lastRun = await c.env.DB
      .prepare(
        `SELECT created_at FROM analytics_funnel_runs
          WHERE line_account_id = ? AND funnel_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
      )
      .bind(account.accountId, c.req.param('id'))
      .first<{ created_at: string }>();
    if (lastRun && Date.now() - Date.parse(lastRun.created_at) < 60_000) {
      return c.json({ success: false, error: 'analytics_funnel_too_soon' }, 429);
    }
    const body = await c.req.json<{ cohortFrom?: unknown; cohortTo?: unknown }>();
    const result = await runChronologicalFunnel(c.env.DB, {
      lineAccountId: account.accountId,
      funnelId: c.req.param('id'),
      cohortFrom: explicitTimestamp(body.cohortFrom, 'analytics_funnel_cohort_from_invalid'),
      cohortTo: explicitTimestamp(body.cohortTo, 'analytics_funnel_cohort_to_invalid'),
      timeZone: selectedAccount.timezone || 'Asia/Tokyo',
      dataCutoffAt: new Date().toISOString(),
      createdBy: c.get('staff').id,
      persist: true,
    });
    return c.json({ success: true, data: result }, 201);
  } catch (error) {
    const status = funnelErrorStatus(error);
    if (status === 500) throw error;
    return inputError(c, { success: false, error: (error as Error).message }, status, []);
  }
});

// 画面を開くだけでは再計算せず、最後に固定した結果を返す。
analytics.get('/api/analytics/funnels/:id/runs/latest', async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account.ok) return account.response;
    const result = await getLatestFunnelRun(c.env.DB, account.accountId, c.req.param('id'));
    if (!result) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: result });
  } catch (error) {
    const status = funnelErrorStatus(error);
    if (status === 500) throw error;
    return inputError(c, {
      success: false,
      error: (error as Error).message,
    }, status, []);
  }
});

analytics.post('/api/analytics/results/:id/audiences', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account.ok) return account.response;
    const body = await c.req.json<{
      sourceKind?: unknown; groupKey?: unknown; stepOrder?: unknown; selection?: unknown; friendIds?: unknown;
      rowKey?: unknown; columnKey?: unknown;
    }>();
    if (body.sourceKind === 'booking') {
      return c.json({ success: true, data: await bookingAudience(c, c.req.param('id'), body as Record<string, unknown>, account.accountId) }, 201);
    }
    if (body.sourceKind === 'cross') {
      const result = await createAnalyticsCrossAudience(c.env.DB, {
        lineAccountId: account.accountId,
        runId: c.req.param('id'),
        rowKey: typeof body.rowKey === 'string' ? body.rowKey : '',
        columnKey: typeof body.columnKey === 'string' ? body.columnKey : '',
        createdBy: c.get('staff').id,
        now: new Date(),
      });
      return c.json({ success: true, data: result }, 201);
    }
    if (!['reached', 'stopped', 'in_progress'].includes(String(body.selection))) {
      return inputError(c, { success: false, error: '対象者の種類が不正です' }, 422, ["selection"]);
    }
    const result = await createFunnelResultAudience(c.env.DB, {
      lineAccountId: account.accountId,
      runId: c.req.param('id'),
      groupKey: typeof body.groupKey === 'string' ? body.groupKey : undefined,
      stepOrder: Number(body.stepOrder),
      selection: body.selection as 'reached' | 'stopped' | 'in_progress',
      createdBy: c.get('staff').id,
      now: new Date(),
    });
    return c.json({ success: true, data: result }, 201);
  } catch (error) {
    const status = funnelErrorStatus(error);
    if (status === 500) throw error;
    return inputError(c, { success: false, error: (error as Error).message }, status, []);
  }
});

/*
 * 一時対象者の詳細。配信作成が「audienceId だけを URL に載せ、人数・期限は
 * ここで読み直す」ために使う。友だちIDは返さない。他アカウント・消えた
 * 対象者は404、期限切れは410（friends の audienceId と同じ返し方）。
 */
analytics.get('/api/analytics/audiences/:id', async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account.ok) return account.response;
    const row = await c.env.DB.prepare(
      `SELECT id, source_kind, selection_key, member_count, expires_at, created_at
         FROM analytics_result_audiences
        WHERE id = ? AND line_account_id = ?`,
    ).bind(c.req.param('id'), account.accountId).first<{
      id: string; source_kind: string; selection_key: string | null;
      member_count: number; expires_at: string; created_at: string;
    }>();
    if (!row) return c.json({ success: false, error: 'Not found' }, 404);
    if (row.expires_at <= new Date().toISOString()) {
      return c.json({ success: false, error: 'この分析結果の対象者は24時間を過ぎました。もう一度集計してください' }, 410);
    }
    return c.json({
      success: true,
      data: {
        id: row.id,
        sourceKind: row.source_kind,
        selectionKey: row.selection_key,
        memberCount: row.member_count,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
      },
    });
  } catch (err) {
    throw err;
  }
});

analytics.post('/api/funnels', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account.ok) return account.response;
    const body = await c.req.json<{
      name?: unknown;
      windowDays?: unknown;
      steps?: unknown;
    }>();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return inputError(c, { success: false, error: '名前を入力してください' }, 400, ["name"]);

    if (!Array.isArray(body.steps) || body.steps.length < 2) {
      // 1段のファネルは「ただの件数」で、離脱を見るという目的を果たさない。
      return inputError(c, { success: false, error: '段は2つ以上にしてください' }, 422, ["steps"]);
    }
    if (body.steps.length > 10) {
      return inputError(c, { success: false, error: '段は10個までです' }, 422, ["steps"]);
    }

    const steps: Array<{ label: string; kind: FunnelStepKind; match: unknown }> = [];
    for (const raw of body.steps as unknown[]) {
      const step = raw as { label?: unknown; kind?: unknown; match?: unknown };
      const label = typeof step.label === 'string' ? step.label.trim() : '';
      if (!label) return inputError(c, { success: false, error: '段の名前を入力してください' }, 422, ["steps"]);
      if (!(FUNNEL_STEP_KINDS as readonly string[]).includes(String(step.kind))) {
        return inputError(c, { success: false, error: `知らない段の種類です: ${String(step.kind)}` }, 422, ["steps"]);
      }
      steps.push({ label, kind: step.kind as FunnelStepKind, match: step.match ?? {} });
    }

    const windowDays = body.windowDays === undefined ? 30 : Number(body.windowDays);
    if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 365) {
      return inputError(c, { success: false, error: '期間は1〜365日で指定してください' }, 422, ["windowDays"]);
    }

    const funnel = await createFunnel(c.env.DB, {
      lineAccountId: account.accountId,
      name,
      windowDays,
      steps,
    });
    return c.json({ success: true, data: serializeFunnel(funnel) }, 201);
  } catch (err) {
    throw err;
  }
});

analytics.delete('/api/funnels/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account.ok) return account.response;
    const funnel = await getFunnelById(c.env.DB, account.accountId, c.req.param('id'));
    const version = await getCurrentFunnelVersion(c.env.DB, account.accountId, c.req.param('id'));
    if (!funnel || version) return c.json({ success: false, error: 'Not found' }, 404);
    // 停止・保管したファネルの物理削除は受け付けない（再開してから消す運用に限定）
    if (funnel.status !== 'active') {
      return c.json({ success: false, error: 'analytics_funnel_not_active' }, 422);
    }
    await deleteFunnel(c.env.DB, account.accountId, c.req.param('id'));
    return c.json({ success: true, data: null });
  } catch (err) {
    throw err;
  }
});

// GET /api/funnels/:id/result — 段ごとの到達人数
analytics.get('/api/funnels/:id/result', async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account.ok) return account.response;
    const funnel = await getFunnelById(c.env.DB, account.accountId, c.req.param('id'));
    if (!funnel) return c.json({ success: false, error: 'Not found' }, 404);
    // 停止・保管したファネルのその場集計は新規runにあたるため拒否する
    if (funnel.status !== 'active') {
      return c.json({ success: false, error: 'analytics_funnel_not_active' }, 422);
    }

    const range = readRange(c);
    if (!range.ok) return c.json({ success: false, error: range.error }, 400);

    // 現行画面は過去の業務台帳を読む互換APIを維持する。
    // の時系列結果は POST /api/analytics/funnels/:id/run で作り、
    // 取得不可・部分データを表示できる画面と同時に切り替える。
    const steps = await getFunnelSteps(c.env.DB, funnel.id);
    const reachedPerStep: string[][] = [];
    let scope: string[] | undefined;
    for (const step of steps) {
      const reached = await countFunnelStep(c.env.DB, step, {
        from: range.value.from,
        to: range.value.to,
        lineAccountId: account.accountId,
        friendIds: scope,
      });
      reachedPerStep.push(reached);
      scope = reached;
      if (reached.length === 0) {
        for (let i = reachedPerStep.length; i < steps.length; i++) reachedPerStep.push([]);
        break;
      }
    }

    return c.json({
      success: true,
      data: {
        funnel: serializeFunnel(funnel),
        steps: buildFunnelResult(steps, reachedPerStep),
      },
    });
  } catch (err) {
    throw err;
  }
});

export { analytics };
