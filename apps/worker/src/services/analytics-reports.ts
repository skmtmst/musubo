import { LineClient } from '@line-crm/line-sdk';
import {
  advanceAnalyticsReportSchedule,
  archiveAnalyticsReportSchedule,
  beginAnalyticsReportRun,
  claimDueAnalyticsReportSchedules,
  createNotification,
  finishAnalyticsReportRun,
  getAnalyticsFriendsOverview,
  getAnalyticsReactionsOverview,
  getAnalyticsReportRun,
  getAnalyticsReportSchedule,
  getAnalyticsRoutesOverview,
  getAnalyticsUsageOverview,
  getLineAccountById,
  getSavedAnalytics,
  getSavedAnalyticsSnapshots,
  getStaffAccountScopeIds,
  getStaffById,
  purgeExpiredAnalyticsReportRuns,
  reclaimStaleAnalyticsReportRuns,
  resolveLineCredential,
  type AnalyticsOverviewContext,
  type AnalyticsReportAlertRule,
  type AnalyticsReportSchedule,
} from '@line-crm/db';


import { sendXServerMail } from './xserver-mail.js';
import { featureJobCanRun } from './feature-enforcement.js';
import { zonedWallTime } from './zoned-time.js';

type AnalyticsReportEnv = {
  DB: D1Database;
  ADMIN_ORIGIN?: string;
  CONTACT_EMAIL?: string;
  XSERVER_MAIL_HOST?: string;
  XSERVER_MAIL_USER?: string;
  XSERVER_MAIL_PASSWORD?: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  LINE_CREDENTIAL_ENCRYPTION_KEY?: string;
};

function dateInZone(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function zoneOffsetMs(value: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value ?? 0);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - value.getTime();
}

function zonedStart(date: string, timeZone: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const target = Date.UTC(year, month - 1, day);
  let guess = target;
  for (let attempt = 0; attempt < 3; attempt += 1) guess = target - zoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess).toISOString();
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function contextFor(schedule: AnalyticsReportSchedule, now: Date, offsetPeriods = 0): AnalyticsOverviewContext {
  const today = dateInZone(now, schedule.timeZone);
  const toDate = addDays(today, -1 - offsetPeriods * schedule.periodDays);
  const fromDate = addDays(toDate, 1 - schedule.periodDays);
  return {
    lineAccountId: schedule.lineAccountId, timeZone: schedule.timeZone, fromDate, toDate,
    from: zonedStart(fromDate, schedule.timeZone),
    toExclusive: zonedStart(addDays(toDate, 1), schedule.timeZone),
    dataCutoffAt: now.toISOString(),
  };
}

function nextRun(schedule: AnalyticsReportSchedule): string {
  const current = new Date(schedule.nextRunAt);
  if (schedule.cadence === 'weekly') {
    return zonedWallTime(addDays(dateInZone(current, schedule.timeZone), 7), schedule.sendTime, schedule.timeZone);
  }
  const localDate = new Date(`${dateInZone(current, schedule.timeZone)}T00:00:00.000Z`);
  localDate.setUTCMonth(localDate.getUTCMonth() + 1);
  localDate.setUTCDate(schedule.monthDay ?? 1);
  return zonedWallTime(localDate.toISOString().slice(0, 10), schedule.sendTime, schedule.timeZone);
}

/**
 * 滞留した予定を未来へ進める。
 *
 * 止まっていた間に何回分も過ぎていたら、古い予定から1周期ずつ
 * 送り直さない。最新の期間を1回だけ送り、飛ばした回数を数えて
 * 履歴に残す。各回の期間が同じ最新期間になる重複通知を防ぐ。
 */
function futureRunAt(schedule: AnalyticsReportSchedule, nowISO: string): { nextRunAt: string; skipped: number } {
  let nextRunAt = nextRun(schedule);
  let skipped = 0;
  let cursor = { ...schedule, nextRunAt: schedule.nextRunAt };
  while (nextRunAt <= nowISO && skipped < 1000) {
    skipped += 1;
    cursor = { ...schedule, nextRunAt };
    nextRunAt = nextRun(cursor);
  }
  return { nextRunAt, skipped };
}

function reportState(value: unknown): 'available' | 'partial' | 'unavailable' {
  const states: string[] = [];
  const visit = (item: unknown) => {
    if (!item || typeof item !== 'object') return;
    if (Array.isArray(item)) { item.forEach(visit); return; }
    for (const [key, child] of Object.entries(item)) {
      if (key === 'state' && typeof child === 'string') states.push(child);
      else visit(child);
    }
  };
  visit(value);
  if (states.length && states.every((state) => state === 'unavailable' || state === 'failed')) return 'unavailable';
  if (states.some((state) => state !== 'available')) return 'partial';
  return 'available';
}

/**
 * 変化通知の1条件の判定結果。
 *
 * 要件 -20 §4-5: 同じ長さの直前期間と比べ、最低母数を満たすときだけ
 * 判定する。取得待ち・部分データの期間は判定しない。
 */
export type AlertRuleOutcome = 'triggered' | 'ok' | 'skipped';

export interface AlertRuleEvaluation {
  metric: AnalyticsReportAlertRule['metric'];
  operator: AnalyticsReportAlertRule['operator'];
  threshold: number;
  minimumSample: number;
  outcome: AlertRuleOutcome;
  /**
   * 観測値。block_rate は %、friend_adds は前期間比の増減率 %（減少が正）、
   * conversions は 0 件が続いた日数。
   */
  observedValue: number | null;
  /** 判定に使った母数（配信件数・前期間の追加数・前期間の成果数）。 */
  sampleSize: number | null;
  /** 今期間の値（比べたものだけ）。 */
  currentValue: number | null;
  /** 比べた前期間の値（あるものだけ）。 */
  previousValue: number | null;
  /** `skipped` の理由。運用者の言葉。 */
  reason: string | null;
}

/** 集計待ち・部分データの期間は比べない（画面の注意書きと同じ文）。 */
const ALERT_PENDING_REASON = '集計待ちや一部だけ取れた期間は比べず、知らせません';

function envelopeNumber(section: unknown, path: string[]): { value: number | null; state: string } | null {
  let node: unknown = section;
  for (const key of path) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
    node = (node as Record<string, unknown>)[key];
  }
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  const record = node as Record<string, unknown>;
  const value = record.value;
  const state = record.state;
  if ((typeof value !== 'number' && value !== null) || typeof state !== 'string') return null;
  return { value, state };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function evaluateBlockRate(
  rule: AnalyticsReportAlertRule, current: Record<string, unknown>,
): AlertRuleEvaluation {
  const base = {
    metric: rule.metric, operator: rule.operator, threshold: rule.threshold, minimumSample: rule.minimumSample,
    observedValue: null as number | null, sampleSize: null as number | null,
    currentValue: null as number | null, previousValue: null as number | null, reason: null as string | null,
  };
  const removed = envelopeNumber(current.friends, ['metrics', 'removed']);
  const delivered = envelopeNumber(current.reactions, ['metrics', 'delivered']);
  if (!removed || !delivered) {
    return { ...base, outcome: 'skipped', reason: '判定に使う「友だちの増減」または「配信の反応」がレポートに入っていません' };
  }
  if (removed.state !== 'available' || delivered.state !== 'available') {
    return { ...base, outcome: 'skipped', reason: ALERT_PENDING_REASON };
  }
  const sent = delivered.value ?? 0;
  if (sent <= 0) return { ...base, outcome: 'skipped', reason: 'この期間の配信が0件のため比べられません' };
  if (sent < rule.minimumSample) {
    return { ...base, outcome: 'skipped', sampleSize: sent, reason: `配信が${sent}件で、判定に必要な${rule.minimumSample}件に足りません` };
  }
  const observed = round1(((removed.value ?? 0) / sent) * 100);
  return {
    ...base, outcome: observed > rule.threshold ? 'triggered' : 'ok',
    observedValue: observed, sampleSize: sent, currentValue: removed.value ?? 0,
  };
}

function evaluateFriendDecrease(
  rule: AnalyticsReportAlertRule, current: Record<string, unknown>, previous: Record<string, unknown>,
): AlertRuleEvaluation {
  const base = {
    metric: rule.metric, operator: rule.operator, threshold: rule.threshold, minimumSample: rule.minimumSample,
    observedValue: null as number | null, sampleSize: null as number | null,
    currentValue: null as number | null, previousValue: null as number | null, reason: null as string | null,
  };
  const now = envelopeNumber(current.friends, ['metrics', 'added']);
  const prev = envelopeNumber(previous.friends, ['metrics', 'added']);
  if (!now || !prev) {
    return { ...base, outcome: 'skipped', reason: '判定に使う「友だちの増減」がレポートに入っていません' };
  }
  if (now.state !== 'available' || prev.state !== 'available') {
    return { ...base, outcome: 'skipped', reason: ALERT_PENDING_REASON };
  }
  const prevValue = prev.value ?? 0;
  const nowValue = now.value ?? 0;
  if (prevValue <= 0) return { ...base, outcome: 'skipped', reason: '前期間の追加が0件のため比べられません' };
  if (prevValue < rule.minimumSample) {
    return {
      ...base, outcome: 'skipped', sampleSize: prevValue, previousValue: prevValue,
      reason: `前期間の追加が${prevValue}人で、判定に必要な${rule.minimumSample}人に足りません`,
    };
  }
  const decrease = round1(((prevValue - nowValue) / prevValue) * 100);
  return {
    ...base, outcome: decrease >= rule.threshold ? 'triggered' : 'ok',
    observedValue: decrease, sampleSize: prevValue, currentValue: nowValue, previousValue: prevValue,
  };
}

/**
 * 成果0件が続いた日数。日別の成果集計は期間別レポートに載らないため、
 * ここで直接数える。件数が多すぎるときは数えず `skipped` にする
 * （URLクリック集計の5万件打ち切りと同じ考え）。
 */
const CONVERSION_LOOKUP_CAP = 100_000;

async function dailyConversionCounts(
  db: D1Database, lineAccountId: string, fromISO: string, toExclusiveISO: string, timeZone: string,
): Promise<Map<string, number> | null> {
  const rows = await db.prepare(
    `SELECT ce.created_at AS created_at
       FROM conversion_events ce JOIN friends f ON f.id = ce.friend_id
      WHERE f.line_account_id = ?
        AND COALESCE(ce.approval_status, 'approved') != 'rejected'
        AND julianday(ce.created_at) >= julianday(?) AND julianday(ce.created_at) < julianday(?)
      LIMIT ?`,
  ).bind(lineAccountId, fromISO, toExclusiveISO, CONVERSION_LOOKUP_CAP + 1).all<{ created_at: string }>();
  if (rows.results.length > CONVERSION_LOOKUP_CAP) return null;
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const days = new Map<string, number>();
  for (const row of rows.results) {
    const day = format.format(new Date(row.created_at));
    days.set(day, (days.get(day) ?? 0) + 1);
  }
  return days;
}

async function evaluateConversionStreak(
  db: D1Database, rule: AnalyticsReportAlertRule, schedule: AnalyticsReportSchedule,
  currentContext: AnalyticsOverviewContext, previousContext: AnalyticsOverviewContext,
): Promise<AlertRuleEvaluation> {
  const base = {
    metric: rule.metric, operator: rule.operator, threshold: rule.threshold, minimumSample: rule.minimumSample,
    observedValue: null as number | null, sampleSize: null as number | null,
    currentValue: null as number | null, previousValue: null as number | null, reason: null as string | null,
  };
  const [days, prevRow] = await Promise.all([
    dailyConversionCounts(db, schedule.lineAccountId, currentContext.from, currentContext.toExclusive, schedule.timeZone),
    db.prepare(
      `SELECT COUNT(*) AS c
         FROM conversion_events ce JOIN friends f ON f.id = ce.friend_id
        WHERE f.line_account_id = ?
          AND COALESCE(ce.approval_status, 'approved') != 'rejected'
          AND julianday(ce.created_at) >= julianday(?) AND julianday(ce.created_at) < julianday(?)`,
    ).bind(schedule.lineAccountId, previousContext.from, previousContext.toExclusive).first<{ c: number }>(),
  ]);
  if (!days) return { ...base, outcome: 'skipped', reason: '成果が多く数え切れないため比べません' };
  const prevTotal = Number(prevRow?.c ?? 0);
  if (prevTotal < rule.minimumSample) {
    return {
      ...base, outcome: 'skipped', sampleSize: prevTotal, previousValue: prevTotal,
      reason: `前期間の成果が${prevTotal}件で、判定に必要な${rule.minimumSample}件に足りません`,
    };
  }
  // 期間末からさかのぼり、0件の日が何日続いているかを見る。
  let zeros = 0;
  for (let date = currentContext.toDate; date >= currentContext.fromDate; date = addDays(date, -1)) {
    if ((days.get(date) ?? 0) !== 0) break;
    zeros += 1;
  }
  return {
    ...base, outcome: zeros >= rule.threshold ? 'triggered' : 'ok',
    observedValue: zeros, sampleSize: prevTotal, currentValue: zeros, previousValue: prevTotal,
  };
}

/**
 * 通知条件を設定値だけで判定済みにせず、前期間の実データと比較して評価する。
 */
export async function evaluateAlertRules(
  db: D1Database, schedule: AnalyticsReportSchedule,
  current: Record<string, unknown>, previous: Record<string, unknown>,
  currentContext: AnalyticsOverviewContext, previousContext: AnalyticsOverviewContext,
): Promise<AlertRuleEvaluation[]> {
  const results: AlertRuleEvaluation[] = [];
  for (const rule of schedule.alertRules) {
    if (rule.metric === 'block_rate' && rule.operator === 'greater_than') {
      results.push(evaluateBlockRate(rule, current));
    } else if (rule.metric === 'friend_adds' && rule.operator === 'decrease_percent') {
      results.push(evaluateFriendDecrease(rule, current, previous));
    } else if (rule.metric === 'conversions' && rule.operator === 'zero_streak_days') {
      results.push(await evaluateConversionStreak(db, rule, schedule, currentContext, previousContext));
    } else {
      results.push({
        metric: rule.metric, operator: rule.operator, threshold: rule.threshold, minimumSample: rule.minimumSample,
        outcome: 'skipped', observedValue: null, sampleSize: null, currentValue: null, previousValue: null,
        reason: 'この条件の判定にはまだ対応していません',
      });
    }
  }
  return results;
}

async function buildReport(db: D1Database, schedule: AnalyticsReportSchedule, now: Date) {
  const currentContext = contextFor(schedule, now);
  const previousContext = contextFor(schedule, now, 1);
  const loaders = {
    friends: getAnalyticsFriendsOverview,
    reactions: getAnalyticsReactionsOverview,
    routes: getAnalyticsRoutesOverview,
    usage: getAnalyticsUsageOverview,
  } as const;
  const current: Record<string, unknown> = {};
  const previous: Record<string, unknown> = {};
  for (const section of schedule.sections) {
    if (section === 'mileage') {
      current.mileage = { state: 'unavailable', reason: 'マイル集計の期間別読取は未接続です', value: null };
      previous.mileage = current.mileage;
      continue;
    }
    const load = loaders[section];
    current[section] = await load(db, currentContext);
    previous[section] = await load(db, previousContext);
  }
  // 全体の状態は通常の節だけでなく、添えた保存済み分析の
  // 状態も見る。保存済みだけ選んだ場合、current={} は「集計済み」に
  // 見えてしまう。無い写し（消された分析）は未取得として扱う。
  const savedAnalyses = [];
  const savedStates: Array<{ state: string }> = [];
  const savedNames = new Map(
    (schedule.savedAnalysisIds.length
      ? await getSavedAnalytics(db, schedule.lineAccountId)
      : []).map((item) => [item.id, item.name]),
  );
  for (const id of schedule.savedAnalysisIds) {
    const snapshots = await getSavedAnalyticsSnapshots(db, schedule.lineAccountId, id);
    const snapshot = snapshots?.[0] ?? null;
    savedAnalyses.push({ savedAnalysisId: id, name: savedNames.get(id) ?? null, snapshot });
    savedStates.push({ state: snapshot?.state ?? 'unavailable' });
  }
  const state = reportState({ current, saved: savedStates });
  const result = {
    period: { from: currentContext.fromDate, to: currentContext.toDate },
    previousPeriod: { from: previousContext.fromDate, to: previousContext.toDate },
    timeZone: schedule.timeZone,
    dataCutoffAt: currentContext.dataCutoffAt,
    current, previous, savedAnalyses,
    alertEvaluation: state === 'available'
      ? { state: 'evaluated', results: await evaluateAlertRules(db, schedule, current, previous, currentContext, previousContext) }
      : { state: 'skipped', reason: '未取得または一部集計中の数字があるため変化通知を行いません' },
  };
  return { context: currentContext, result, state };
}

const jaNumber = new Intl.NumberFormat('ja-JP');

/** 見出しの数値を1行にする。集計できていない節は行ごと出さない。 */
function headlineLines(schedule: AnalyticsReportSchedule, report: Awaited<ReturnType<typeof buildReport>>): string[] {
  const lines: string[] = [];
  const current = report.result.current as Record<string, unknown>;
  if (schedule.sections.includes('friends')) {
    const added = envelopeNumber(current.friends, ['metrics', 'added']);
    const removed = envelopeNumber(current.friends, ['metrics', 'removed']);
    const net = envelopeNumber(current.friends, ['metrics', 'net']);
    if (added?.state === 'available' && removed?.state === 'available' && net?.state === 'available') {
      const netValue = net.value ?? 0;
      lines.push(`・友だちの増減: ${netValue >= 0 ? `${jaNumber.format(netValue)}人増加` : `${jaNumber.format(-netValue)}人減少`}（新規${jaNumber.format(added.value ?? 0)}・解除${jaNumber.format(removed.value ?? 0)}）`);
    }
  }
  if (schedule.sections.includes('reactions')) {
    const delivered = envelopeNumber(current.reactions, ['metrics', 'delivered']);
    const opened = envelopeNumber(current.reactions, ['metrics', 'opened']);
    // 監査 : シナリオは届いた人数が取れないため、シナリオを含む期間は
    // delivered が partial（取れた一斉配信だけの合計）になる。行を消さず、
    // 取れた分だけだと分かる添え書きを付けて出す。
    if (delivered && (delivered.state === 'available' || delivered.state === 'partial')
        && typeof delivered.value === 'number') {
      const openedPart = opened?.state === 'available' && typeof opened.value === 'number'
        ? `・開封${jaNumber.format(opened.value)}件` : '';
      const scope = delivered.state === 'partial' ? '（一斉配信のみ）' : '';
      lines.push(`・配信の反応: ${jaNumber.format(delivered.value)}件配信${openedPart}${scope}`);
    }
  }
  if (schedule.sections.includes('routes')) {
    const routes = (current.routes as { routes?: Array<{
      name?: unknown; friendAdds?: { value: number | null; state: string };
      conversions?: { approved?: { value: number | null; state: string }; pending?: { value: number | null; state: string } };
      revenue?: { value: number | null; state: string };
    }> } | null)?.routes;
    if (Array.isArray(routes)) {
      let conversions: number | null = 0;
      let revenue: number | null = 0;
      let top: { name: string; adds: number } | null = null;
      for (const route of routes.filter((item) => item.name !== '経路不明')) {
        const approved = route.conversions?.approved;
        const pending = route.conversions?.pending;
        const routeRevenue = route.revenue;
        if (approved?.state !== 'available' || pending?.state !== 'available'
          || typeof approved.value !== 'number' || typeof pending.value !== 'number') {
          conversions = null;
        } else if (conversions !== null) {
          conversions += approved.value + pending.value;
        }
        if (routeRevenue?.state !== 'available' || typeof routeRevenue.value !== 'number') {
          revenue = null;
        } else if (revenue !== null) {
          revenue += routeRevenue.value;
        }
        const adds = route.friendAdds;
        if (typeof route.name === 'string' && adds?.state === 'available' && typeof adds.value === 'number'
          && (!top || adds.value > top.adds)) {
          top = { name: route.name, adds: adds.value };
        }
      }
      if (conversions !== null) {
        lines.push(`・経路と成果: 成果${jaNumber.format(conversions)}件${
          revenue !== null ? `・売上${jaNumber.format(revenue)}円` : ''}`);
      }
      if (top) lines.push(`・いちばんの流入: ${top.name}（友だち${jaNumber.format(top.adds)}人）`);
    }
  }
  if (schedule.sections.includes('usage')) {
    const unused = envelopeNumber(current.usage, ['summary', 'unusedItems']);
    if (unused?.state === 'available' && typeof unused.value === 'number') {
      lines.push(`・使われ方: 使っていないもの${jaNumber.format(unused.value)}件`);
    }
  }
  return lines;
}

/** 条件に一致した知らせだけを行にする。無ければ空配列。 */
function alertLines(evaluation: { state: string; results?: AlertRuleEvaluation[] }): string[] {
  if (evaluation.state !== 'evaluated' || !Array.isArray(evaluation.results)) return [];
  const lines: string[] = [];
  for (const item of evaluation.results) {
    if (item.outcome !== 'triggered') continue;
    if (item.metric === 'block_rate') {
      lines.push(`・ブロック率 ${item.observedValue}% がしきい値 ${item.threshold}% を超えました（配信${item.sampleSize !== null ? jaNumber.format(item.sampleSize) : '—'}件）`);
    } else if (item.metric === 'friend_adds') {
      lines.push(`・友だちの追加が前期間より ${item.observedValue}% 減りました（前期間${item.previousValue !== null ? jaNumber.format(item.previousValue) : '—'}人→今回${item.currentValue !== null ? jaNumber.format(item.currentValue) : '—'}人）`);
    } else if (item.metric === 'conversions') {
      lines.push(`・成果0件が ${item.observedValue}日続いています（しきい値 ${item.threshold}日）`);
    }
  }
  return lines;
}

/**
 * 添えた保存済み分析は、その結果が「いつのものか」を添える。
 *
 * 保存結果は不変（1月のまま）が正しい。問題は通知だけが今回の
 * 期間・締切を名乗り、受け手が9月の集計と受け取る点。分析ごとに
 * 元の対象期間・締切と「保存した時点の結果」であることを示す。
 */
function savedAnalysisLines(report: Awaited<ReturnType<typeof buildReport>>): string[] {
  const items = (report.result.savedAnalyses ?? []) as Array<{
    savedAnalysisId: string; name: string | null;
    snapshot: {
      periodFrom: string; periodTo: string; dataCutoffAt: string; state: string;
    } | null;
  }>;
  return items.map((item) => {
    const name = item.name ?? '保存した分析';
    if (!item.snapshot) return `・添付した分析「${name}」: 結果が見つかりません`;
    const from = String(item.snapshot.periodFrom).slice(0, 10);
    const to = String(item.snapshot.periodTo).slice(0, 10);
    const stateLabel = item.snapshot.state === 'available' ? '確定結果'
      : item.snapshot.state === 'partial' ? '一部集計中の結果'
      : item.snapshot.state === 'failed' ? '失敗したときの結果' : '未取得の結果';
    return `・添付した分析「${name}」: ${from}〜${to} の${stateLabel}（保存した時点のもので、今回の集計ではありません。データ締切 ${item.snapshot.dataCutoffAt}）`;
  });
}

export function reportText(
  schedule: AnalyticsReportSchedule, report: Awaited<ReturnType<typeof buildReport>>,
  adminOrigin: string | null = null,
) {
  const lines = [
    `【${schedule.name}】`,
    `${report.context.fromDate}〜${report.context.toDate} のまとめ`,
    `状態: ${report.state === 'available' ? '集計済み' : report.state === 'partial' ? '一部集計中' : '未取得'}`,
    `データ締切: ${report.context.dataCutoffAt}`,
    ...headlineLines(schedule, report),
    ...savedAnalysisLines(report),
  ];
  const alerts = alertLines(report.result.alertEvaluation as { state: string; results?: AlertRuleEvaluation[] });
  if (alerts.length > 0) lines.push('▼すぐの知らせ', ...alerts);
  // 要件 -20 §4-5: 通知に顧客本文・秘密値・URLクエリは入れない。
  // ここで付けるのは運用者自身の管理画面への固定の行き先だけで、
  // 顧客の値や追跡用のクエリは付けない。
  if (adminOrigin) lines.push(`くわしく見る: ${adminOrigin.replace(/\/+$/, '')}/analytics?tab=saved`);
  else lines.push('管理画面の「分析」で詳細を確認してください。');
  return lines.join('\n');
}

export type DeliveryOutcome = {
  channel: string; recipient: string; status: 'sent' | 'failed' | 'skipped'; reason?: string;
};

/**
 * 送信直前の宛先の再検査。
 *
 * 作成時は宛先の権限を検査するが、保存後に担当者が停止されたり
 * 閲覧範囲から外れたりしても、送信時は getStaffById で引けるだけで
 * 送っていた。ここでは有効状態・所属・対象アカウントの閲覧権限を
 * 送る直前に確かめ直す。外れた宛先には送らず、理由を宛先別に残す。
 * 直接のメール指定（kind=email）は担当者の状態と区別し、そのまま送る。
 */
async function validStaffFor(
  db: D1Database, staffId: string, lineAccountId: string,
): Promise<{ ok: true; member: NonNullable<Awaited<ReturnType<typeof getStaffById>>> } | { ok: false; reason: string }> {
  const member = await getStaffById(db, staffId);
  if (!member) return { ok: false, reason: '担当者の登録が無いため送りませんでした（退職・削除の可能性があります）' };
  if (!member.is_active || member.invite_status !== 'active') {
    return { ok: false, reason: '担当者が利用停止中のため送りませんでした' };
  }
  if (member.account_scope === 'accounts') {
    const scope = await getStaffAccountScopeIds(db, staffId);
    if (!scope.includes(lineAccountId)) {
      return { ok: false, reason: 'このLINEアカウントの閲覧範囲から外れたため送りませんでした' };
    }
  }
  return { ok: true, member };
}

async function deliver(env: AnalyticsReportEnv, schedule: AnalyticsReportSchedule, text: string) {
  const results: DeliveryOutcome[] = [];
  const staff = new Map<string, NonNullable<Awaited<ReturnType<typeof getStaffById>>>>();
  for (const recipient of schedule.recipients) {
    if (recipient.kind !== 'staff' || !recipient.staffId) continue;
    const checked = await validStaffFor(env.DB, recipient.staffId, schedule.lineAccountId);
    if (!checked.ok) {
      // 除外した理由を履歴に残す。有効な宛先への送信は続ける。
      for (const channel of schedule.channels) {
        if (channel === 'dashboard') continue;
        results.push({ channel, recipient: recipient.staffId, status: 'skipped', reason: checked.reason });
      }
      continue;
    }
    staff.set(recipient.staffId, checked.member);
  }
  if (schedule.channels.includes('dashboard')) {
    try {
      await createNotification(env.DB, {
        eventType: 'analytics_report_ready', title: schedule.name, body: text,
        channel: 'dashboard', lineAccountId: schedule.lineAccountId, category: 'info',
        metadata: JSON.stringify({ scheduleId: schedule.id, recipientStaffIds: [...staff.keys()] }),
      });
      results.push({ channel: 'dashboard', recipient: 'notification-center', status: 'sent' });
    } catch (error) {
      results.push({ channel: 'dashboard', recipient: 'notification-center', status: 'failed', reason: error instanceof Error ? error.message : 'dashboard_failed' });
    }
  }
  if (schedule.channels.includes('email')) {
    const emails = new Set(schedule.recipients.flatMap((recipient) => recipient.kind === 'email' && recipient.email
      ? [recipient.email] : recipient.staffId && staff.get(recipient.staffId)?.email ? [staff.get(recipient.staffId)!.email!] : []));
    for (const email of emails) {
      try {
        await sendXServerMail(env, { to: email, from: env.CONTACT_EMAIL || env.XSERVER_MAIL_USER || '', subject: schedule.name, body: text });
        results.push({ channel: 'email', recipient: email, status: 'sent' });
      } catch (error) {
        results.push({ channel: 'email', recipient: email, status: 'failed', reason: error instanceof Error ? error.message : 'email_failed' });
      }
    }
  }
  if (schedule.channels.includes('line')) {
    const account = await getLineAccountById(env.DB, schedule.lineAccountId);
    const token = account ? await resolveLineCredential(
      account.channel_access_token_encrypted, account.channel_access_token || env.LINE_CHANNEL_ACCESS_TOKEN,
      { lineAccountId: schedule.lineAccountId, field: 'channel_access_token' }, env.LINE_CREDENTIAL_ENCRYPTION_KEY,
    ) : '';
    for (const [staffId, member] of staff) {
      if (!member?.line_user_id) continue;
      try {
        if (!token) throw new Error('line_token_missing');
        await new LineClient(token).pushMessage(member.line_user_id, [{ type: 'text', text }]);
        results.push({ channel: 'line', recipient: staffId, status: 'sent' });
      } catch (error) {
        results.push({ channel: 'line', recipient: staffId, status: 'failed', reason: error instanceof Error ? error.message : 'line_failed' });
      }
    }
  }
  return results;
}

/**
 * 取り残された実行中を「中断」とみなすまでの時間。
 *
 * 正常な同時実行（開始直後の running 行）を回収しないよう、
 * この時間より古いものだけを対象にする。
 */
const STALE_RUN_MS = 2 * 3_600_000;

/**
 * 読み取り後に変わった設定を見分ける。
 *
 * 止める・しまう・内容変更のいずれも、版（updatedAt）か次回予定か
 * 状態が変わる。読み取ったまま送ると旧宛先へ送るので、変わって
 * いたら送らずに止める。変更後の予定は編集側が未来へ置き直す。
 */
export function isClaimStale(
  claimed: AnalyticsReportSchedule, fresh: AnalyticsReportSchedule | null,
): boolean {
  return !fresh || fresh.status !== 'active'
    || fresh.updatedAt !== claimed.updatedAt || fresh.nextRunAt !== claimed.nextRunAt;
}

export async function processDueAnalyticsReports(env: AnalyticsReportEnv, now = new Date()) {
  const nowISO = now.toISOString();
  // 前回取り残された running 行を先に回収する。回収しないと
  // 同じ予定時刻の begin がずっと null になり、次回以降も止まる。
  const staleCutoff = new Date(now.getTime() - STALE_RUN_MS).toISOString();
  const reclaimed = await reclaimStaleAnalyticsReportRuns(env.DB, staleCutoff);
  const due = await claimDueAnalyticsReportSchedules(env.DB, nowISO);
  let processed = 0;
  let failed = 0;
  let repaired = 0;
  for (const schedule of due) {
    // 機能オフ中は作らず予約のまま残す。再オンで再開する。
    if (!await featureJobCanRun(env.DB, { accountId: schedule.lineAccountId, featureId: 'analytics', job: 'analytics scheduled reports' })) {
      continue;
    }
    // 読み取った設定でそのまま送らない。実行開始の直前に
    // 最新を読み直し、止める・しまう・内容変更の後なら送らない。
    // 変更後の予定は編集側が未来へ置き直すので、ここでは進めない。
    const fresh = await getAnalyticsReportSchedule(env.DB, schedule.id, schedule.lineAccountId);
    if (isClaimStale(schedule, fresh)) continue;
    const context = contextFor(schedule, now);
    const runId = await beginAnalyticsReportRun(env.DB, {
      scheduleId: schedule.id, lineAccountId: schedule.lineAccountId,
      scheduledFor: schedule.nextRunAt, periodFrom: context.fromDate, periodTo: context.toDate,
      timeZone: schedule.timeZone, dataCutoffAt: context.dataCutoffAt,
    });
    if (!runId) {
      // 送信済みの記録があるのに予定だけ古いままなら、送り直さず
      // 予定だけ未来へ補修する。running 行は上の回収で既に処理済み。
      const existing = await getAnalyticsReportRun(env.DB, {
        scheduleId: schedule.id, scheduledFor: schedule.nextRunAt,
      });
      if (existing && existing.state !== 'running') {
        await advanceAnalyticsReportSchedule(env.DB, schedule.id, schedule.nextRunAt,
          futureRunAt(schedule, nowISO).nextRunAt, nowISO);
        repaired += 1;
      }
      continue;
    }
    // 履歴保存が失敗しても、確認済みの送信結果を空にしない。
    // catch 側でもここまでの deliveryResults を引き継ぐ。
    let deliveryResults: DeliveryOutcome[] = [];
    try {
      const report = await buildReport(env.DB, schedule, now);
      // 集計中に止める・しまう・内容変更があれば、旧設定で送らない。
      const latest = await getAnalyticsReportSchedule(env.DB, schedule.id, schedule.lineAccountId);
      if (!latest || latest.status !== 'active' || latest.updatedAt !== schedule.updatedAt) {
        await finishAnalyticsReportRun(env.DB, {
          id: runId, state: 'failed', result: {}, deliveryResults: [],
          errorCode: 'schedule_changed_before_send', completedAt: new Date().toISOString(),
        });
        failed += 1;
        // 変更後の予定は編集側が管理するので、ここでは進めない。
        continue;
      }
      deliveryResults = await deliver(
        env, schedule, reportText(schedule, report, env.ADMIN_ORIGIN ?? null));
      const deliveryFailed = deliveryResults.some((item) => item.status === 'failed');
      const backlog = futureRunAt(schedule, nowISO);
      await finishAnalyticsReportRun(env.DB, {
        id: runId, state: deliveryFailed && report.state === 'available' ? 'partial' : report.state,
        // 滞留分をまとめて1回送ったときは、省略した回数を履歴に残す。
        result: backlog.skipped > 0
          ? { ...report.result, backlog: { scheduledFor: schedule.nextRunAt, sentPeriods: 1, skippedPeriods: backlog.skipped } }
          : report.result,
        deliveryResults, completedAt: new Date().toISOString(),
      });
      if (schedule.isOneTime) await archiveAnalyticsReportSchedule(env.DB, schedule.id, nowISO);
      else await advanceAnalyticsReportSchedule(env.DB, schedule.id, schedule.nextRunAt, backlog.nextRunAt, nowISO);
      processed += 1;
    } catch (error) {
      await finishAnalyticsReportRun(env.DB, {
        id: runId, state: 'failed', result: {}, deliveryResults,
        errorCode: error instanceof Error ? error.message.slice(0, 120) : 'analytics_report_failed',
        completedAt: new Date().toISOString(),
      });
      failed += 1;
      if (schedule.isOneTime) await archiveAnalyticsReportSchedule(env.DB, schedule.id, nowISO);
      else {
        await advanceAnalyticsReportSchedule(env.DB, schedule.id, schedule.nextRunAt,
          futureRunAt(schedule, nowISO).nextRunAt, nowISO);
      }
    }
  }
  const retention = new Date(now);
  retention.setUTCMonth(retention.getUTCMonth() - 13);
  const purged = await purgeExpiredAnalyticsReportRuns(env.DB, retention.toISOString());
  return { processed, failed, purged, reclaimed, repaired };
}
