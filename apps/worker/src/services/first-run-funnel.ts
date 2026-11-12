import { isSavedFeatureConfiguration } from '@line-crm/db';
import { sqlIdSet } from '@line-crm/db/id-queries';
import { instant } from './style-analytics-core.js';

/**
 * 公開した振り分けの版から、始まるシナリオの ID を読む。
 * 壊れた版は「設定済み」にしないので空を返す。手順の段（1 アカウント）と全アカウントのまとめで同じ読み方にする。
 */
export function scenarioIdsStartedBy(snapshot: string): string[] {
  try {
    const definition = JSON.parse(snapshot) as {
      scenarioId?: string | null;
      actions?: Array<{ type?: string; scenarioId?: string; targetId?: string }>;
    };
    const actionIds = (definition.actions ?? [])
      .filter((action) => action.type === 'start_scenario')
      .map((action) => action.scenarioId ?? action.targetId);
    return [definition.scenarioId ?? '', ...actionIds].filter((id): id is string => Boolean(id));
  } catch {
    return [];
  }
}

/** じょうごの段。最初の 10 分の 5 地点の順。 */
export const FIRST_RUN_FUNNEL_STAGES = ['started', 'style', 'starter', 'follow', 'firstMessage'] as const;
export type FirstRunFunnelStage = (typeof FIRST_RUN_FUNNEL_STAGES)[number];

export interface FirstRunFunnel {
  /** 期間にできたアカウントの数（じょうごの 1 段目）。 */
  accounts: number;
  /**
   * 5 地点の順に区切ったじょうご。その段まで来た数は、その地点と前の地点が全部そろったアカウントだけを数える。
   * fromPrevious は前の段からの割合、minutesFromPrevious は前の地点からかかった分の中央値（1 段目は null）。
   */
  stages: Array<{
    key: FirstRunFunnelStage;
    count: number;
    percent: number;
    fromPrevious: number | null;
    minutesFromPrevious: number | null;
  }>;
  /** 前の段からの割合がいちばん低い段（同じなら先の段）。アカウントが無ければ null。 */
  biggestDrop: { key: FirstRunFunnelStage; fromPrevious: number; lost: number } | null;
  /** 開始から最初の 1 通までの分。届いたアカウントだけで数える。 */
  minutesToFirstMessage: { median: number | null; p75: number | null; reached: number };
  /** 期間にできたアカウントのうち、10 分以内に最初の 1 通まで届いた割合。 */
  withinTenMinutesPercent: number;
  /** 手順の 6 段を全部終えたアカウントの数と割合。 */
  allStepsDone: { count: number; percent: number };
}

interface AccountTimes {
  id: string;
  created_at: string | null;
  is_active: number;
  has_secret: number;
  style_at: string | null;
  starter_at: string | null;
  follow_at: string | null;
  first_message_at: string | null;
  feature_bundle: string | null;
  has_attributes: number;
}

const FIRST_MESSAGE_LIMIT = `SELECT m.created_at FROM messages_log m
   WHERE m.line_account_id = a.id AND m.direction = 'outgoing'
     AND (m.source = 'friend_add_routing' OR m.scenario_step_id IS NOT NULL)
   ORDER BY m.created_at LIMIT 1`;

// 状態の索引（status）を選ぶと、アカウントごとに全アカウントの成功した受信を読み直して遅くなる。アカウントの索引で読む。
const FOLLOW_LIMIT = `SELECT e.received_at FROM line_webhook_events e INDEXED BY idx_line_webhook_events_account
   WHERE e.line_account_id = a.id AND e.event_type = 'follow' AND e.status = 'succeeded'
   ORDER BY e.received_at LIMIT 1`;

function ratio(count: number, total: number): number {
  return total > 0 ? Math.round((count / total) * 1000) / 10 : 0;
}

/** 並べた分の、その割合の点（最も近い順位）。 */
function rankPoint(sorted: number[], share: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(share * sorted.length) - 1)];
}

function within(value: string | null, from: number, to: number): boolean {
  if (!value) return false;
  const at = instant(value);
  return Number.isFinite(at) && at >= from && at < to;
}

/**
 * 最初の 10 分の全アカウントのまとめ（運営だけが見る数）。
 *
 * - アカウントを作った日で期間を絞る。保存の形がまちまち（Z・+09:00・時差なし）なので、
 *   作った日は文字で比べず時刻に直してから比べる。
 * - 返すのは数と割合だけ。アカウント名・友だち・本文は読まない。
 * - 5 地点の時刻は 1 アカウントの firstRunTimes と同じ行・同じ条件で読む。
 * - 手順の 6 段のうち「LINE をつなぐ」は、1 アカウントの画面では LINE に Webhook を問い合わせるが、
 *   全アカウントでは問い合わせない。稼働中でシークレットがあることだけを見る。
 */
export async function firstRunFunnel(
  db: D1Database,
  input: { from: string; to: string; excludeTenantId: string },
): Promise<FirstRunFunnel> {
  const from = instant(input.from);
  const to = instant(input.to);
  const all = await db.prepare(
    `SELECT id, created_at FROM line_accounts
      WHERE archived_at IS NULL AND COALESCE(tenant_id, ?) <> ?`,
  ).bind(input.excludeTenantId, input.excludeTenantId).all<{ id: string; created_at: string | null }>();
  const ids = (all.results ?? []).filter((row) => within(row.created_at, from, to)).map((row) => row.id);
  if (ids.length === 0) return summarize([], new Set());

  const set = sqlIdSet(ids);
  const [times, rules, scenarios] = await Promise.all([
    db.prepare(
      `SELECT a.id, a.created_at, a.is_active,
              CASE WHEN COALESCE(a.channel_secret_encrypted, '') <> '' OR COALESCE(a.channel_secret, '') <> '' THEN 1 ELSE 0 END AS has_secret,
              (SELECT s.first_selected_at FROM account_styles s WHERE s.line_account_id = a.id) AS style_at,
              (SELECT s.first_starter_at FROM account_styles s WHERE s.line_account_id = a.id) AS starter_at,
              (${FOLLOW_LIMIT}) AS follow_at,
              (${FIRST_MESSAGE_LIMIT}) AS first_message_at,
              (SELECT st.value FROM account_settings st
                WHERE st.line_account_id = a.id AND st.key = 'feature.settings_bundle_v1') AS feature_bundle,
              CASE WHEN EXISTS (SELECT 1 FROM tags t
                                 WHERE t.line_account_id = a.id AND COALESCE(t.status, 'active') != 'archived')
                     OR EXISTS (SELECT 1 FROM friend_fields f JOIN friend_field_scopes fs ON fs.field_id = f.id
                                 WHERE fs.line_account_id = a.id AND f.status != 'archived')
                   THEN 1 ELSE 0 END AS has_attributes
         FROM line_accounts a
        WHERE a.id IN (${set.sql})`,
    ).bind(...set.binds).all<AccountTimes>(),
    db.prepare(
      `SELECT r.line_account_id, r.is_unknown_route_fallback, v.definition_snapshot
         FROM friend_add_rules r
         JOIN friend_add_rule_versions v ON v.rule_id = r.id
        WHERE r.line_account_id IN (${set.sql}) AND r.status = 'published'
          AND r.archived_at IS NULL AND v.status = 'published'`,
    ).bind(...set.binds).all<{ line_account_id: string; is_unknown_route_fallback: number; definition_snapshot: string }>(),
    db.prepare(
      `SELECT line_account_id, id FROM scenarios
        WHERE line_account_id IN (${set.sql}) AND is_active = 1`,
    ).bind(...set.binds).all<{ line_account_id: string; id: string }>(),
  ]);

  const published = new Map<string, { fallback: boolean; scenarioIds: Set<string> }>();
  for (const rule of rules.results ?? []) {
    const entry = published.get(rule.line_account_id) ?? { fallback: false, scenarioIds: new Set<string>() };
    if (rule.is_unknown_route_fallback === 1) entry.fallback = true;
    for (const id of scenarioIdsStartedBy(rule.definition_snapshot)) entry.scenarioIds.add(id);
    published.set(rule.line_account_id, entry);
  }
  const activeScenarios = new Set((scenarios.results ?? []).map((row) => `${row.line_account_id}\u0000${row.id}`));

  const done = new Set<string>();
  for (const row of times.results ?? []) {
    const rule = published.get(row.id);
    const steps = [
      row.is_active === 1 && row.has_secret === 1,
      isSavedFeatureConfiguration(row.feature_bundle),
      row.has_attributes === 1,
      Boolean(rule?.fallback),
      Boolean(rule && [...rule.scenarioIds].some((id) => activeScenarios.has(`${row.id}\u0000${id}`))),
      Boolean(row.first_message_at),
    ];
    if (steps.every(Boolean)) done.add(row.id);
  }
  return summarize(times.results ?? [], done);
}

/** 2 つの時刻の差を分（切り上げ・0 未満は 0）。読めなければ null。 */
function spanMinutes(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const span = instant(to) - instant(from);
  return Number.isFinite(span) ? Math.max(0, Math.ceil(span / 60000)) : null;
}

function summarize(rows: AccountTimes[], done: Set<string>): FirstRunFunnel {
  const total = rows.length;
  const pointOf: Record<FirstRunFunnelStage, (row: AccountTimes) => string | null> = {
    started: (row) => row.created_at,
    style: (row) => row.style_at,
    starter: (row) => row.starter_at,
    follow: (row) => row.follow_at,
    firstMessage: (row) => row.first_message_at,
  };
  const stages: FirstRunFunnel['stages'] = [];
  let reached = rows;
  FIRST_RUN_FUNNEL_STAGES.forEach((key, index) => {
    const previous = index > 0 ? FIRST_RUN_FUNNEL_STAGES[index - 1] : null;
    const before = reached.length;
    if (previous) reached = reached.filter((row) => Boolean(pointOf[key](row)));
    const spans = previous
      ? reached.map((row) => spanMinutes(pointOf[previous](row), pointOf[key](row)))
        .filter((value): value is number => value !== null)
        .sort((a, b) => a - b)
      : [];
    stages.push({
      key,
      count: reached.length,
      percent: ratio(reached.length, total),
      fromPrevious: previous ? ratio(reached.length, before) : null,
      minutesFromPrevious: previous ? rankPoint(spans, 0.5) : null,
    });
  });
  let biggestDrop: FirstRunFunnel['biggestDrop'] = null;
  stages.forEach((stage, index) => {
    if (total === 0 || stage.fromPrevious === null) return;
    if (biggestDrop && stage.fromPrevious >= biggestDrop.fromPrevious) return;
    biggestDrop = { key: stage.key, fromPrevious: stage.fromPrevious, lost: stages[index - 1].count - stage.count };
  });
  const minutes = rows
    .map((row) => spanMinutes(row.created_at, row.first_message_at))
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  const withinTen = minutes.filter((value) => value <= 10).length;
  return {
    accounts: total,
    stages,
    biggestDrop,
    minutesToFirstMessage: { median: rankPoint(minutes, 0.5), p75: rankPoint(minutes, 0.75), reached: minutes.length },
    withinTenMinutesPercent: ratio(withinTen, total),
    allStepsDone: { count: done.size, percent: ratio(done.size, total) },
  };
}
