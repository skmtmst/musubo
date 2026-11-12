import { jstNow } from './utils.js';

const LOOKUP_CHUNK = 90;

/**
 * ファネル分析。
 *
 * 「広告を見た → 友だちになった → フォームに答えた → 買った」のように、
 * 段ごとに何人が残ったかを見る。
 */

export const FUNNEL_STEP_KINDS = [
  'tag',
  'field',
  'form',
  'site_event',
  'purchase',
  'link_click',
  'conversion',
] as const;
export type FunnelStepKind = (typeof FUNNEL_STEP_KINDS)[number];

// ファネルの運用状態。active 以外は一覧と再集計・対象者作成・新版保存から外す。
// stopped は再開できる。archived は復帰しない終端状態。
export type FunnelStatus = 'active' | 'stopped' | 'archived';

export interface Funnel {
  id: string;
  line_account_id: string | null;
  name: string;
  segment_json: string | null;
  window_days: number;
  created_at: string;
  status: FunnelStatus;
  confirmation_revision: number;
}

export interface FunnelStep {
  id: string;
  funnel_id: string;
  step_order: number;
  label: string;
  kind: string;
  match_json: string;
}

export async function getFunnels(db: D1Database, lineAccountId: string): Promise<Funnel[]> {
  const result = await db
    .prepare(`SELECT * FROM funnels WHERE line_account_id = ? ORDER BY created_at DESC`)
    .bind(lineAccountId)
    .all<Funnel>();
  return result.results;
}

/**
 * 現行画面で扱える旧形式のファネルだけを返す。
 *
 * の版付きファネルは段の保存形式が異なるため、旧画面へ混ぜると
 * 「段が0件」の壊れた分析に見える。画面へ切り替わるまで一覧を分ける。
 */
export async function getLegacyFunnels(
  db: D1Database,
  lineAccountId: string,
): Promise<Funnel[]> {
  const result = await db
    .prepare(
      `SELECT f.*
       FROM funnels f
       WHERE f.line_account_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM analytics_funnel_versions v WHERE v.funnel_id = f.id
         )
       ORDER BY f.created_at DESC`,
    )
    .bind(lineAccountId)
    .all<Funnel>();
  return result.results;
}

export async function getFunnelById(
  db: D1Database,
  lineAccountId: string,
  id: string,
): Promise<Funnel | null> {
  return db.prepare(`SELECT * FROM funnels WHERE id = ? AND line_account_id = ?`)
    .bind(id, lineAccountId).first<Funnel>();
}

export async function getFunnelSteps(db: D1Database, funnelId: string): Promise<FunnelStep[]> {
  const result = await db
    .prepare(`SELECT * FROM funnel_steps WHERE funnel_id = ? ORDER BY step_order ASC`)
    .bind(funnelId)
    .all<FunnelStep>();
  return result.results;
}

export async function createFunnel(
  db: D1Database,
  input: {
    name: string;
    lineAccountId: string;
    windowDays?: number;
    segment?: unknown;
    steps: Array<{ label: string; kind: FunnelStepKind; match: unknown }>;
  },
): Promise<Funnel> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO funnels (id, line_account_id, name, segment_json, window_days, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.lineAccountId,
      input.name,
      input.segment === undefined ? null : JSON.stringify(input.segment),
      input.windowDays ?? 30,
      jstNow(),
    )
    .run();
  // 段の順番は配列の並びで決める。呼び出し側に番号を振らせると、
  // 抜けや重複を毎回検証することになる。
  let order = 1;
  for (const step of input.steps) {
    await db
      .prepare(
        `INSERT INTO funnel_steps (id, funnel_id, step_order, label, kind, match_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), id, order, step.label, step.kind, JSON.stringify(step.match))
      .run();
    order++;
  }
  return (await getFunnelById(db, input.lineAccountId, id))!;
}

export async function deleteFunnel(
  db: D1Database,
  lineAccountId: string,
  id: string,
): Promise<void> {
  await db.prepare(`DELETE FROM funnels WHERE id = ? AND line_account_id = ?`)
    .bind(id, lineAccountId).run();
}

/**
 * 段ごとの到達人数。
 *
 * 段の条件が満たされた人を数える。前の段を通っていない人は数えない
 * （ファネルなので、途中から湧いてこない）。
 */
export async function countFunnelStep(
  db: D1Database,
  step: FunnelStep,
  opts: { from: string; to: string; lineAccountId: string; friendIds?: string[] },
): Promise<string[]> {
  const match = JSON.parse(step.match_json) as Record<string, unknown>;
  const accountClause = `AND friend_id IN (SELECT id FROM friends WHERE line_account_id = ?)`;

  // D1 は1文あたりの bind 変数が100個までなので、前段の通過者を分割して調べる。
  // 未指定と空配列は従来どおり「絞り込みなし」として、クエリを1回だけ実行する。
  const queryScoped = async (query: string, values: unknown[]): Promise<string[]> => {
    const uniqueScope = opts.friendIds ? [...new Set(opts.friendIds)] : [];
    const chunks = uniqueScope.length === 0
      ? [[]]
      : Array.from(
          { length: Math.ceil(uniqueScope.length / LOOKUP_CHUNK) },
          (_, index) => uniqueScope.slice(index * LOOKUP_CHUNK, (index + 1) * LOOKUP_CHUNK),
        );
    const friendIds: string[] = [];
    for (const chunk of chunks) {
      const scopeClause = chunk.length > 0
        ? `AND friend_id IN (${chunk.map(() => '?').join(',')})`
        : '';
      const result = await db
        .prepare(`${query} ${accountClause} ${scopeClause}`)
        .bind(...values, opts.lineAccountId, ...chunk)
        .all<{ friend_id: string }>();
      friendIds.push(...result.results.map((row) => row.friend_id));
    }
    return friendIds;
  };

  switch (step.kind) {
    case 'tag': {
      return queryScoped(
        `SELECT DISTINCT friend_id FROM friend_tags
          WHERE tag_id = ? AND assigned_at >= ? AND assigned_at <= ?`,
        [String(match.tagId), opts.from, opts.to],
      );
    }
    case 'field': {
      return queryScoped(
        `SELECT DISTINCT friend_id FROM friend_field_values
          WHERE field_id = ? AND value IS NOT NULL AND value != ''
            AND updated_at >= ? AND updated_at <= ?`,
        [String(match.fieldId), opts.from, opts.to],
      );
    }
    case 'site_event': {
      return queryScoped(
        `SELECT DISTINCT friend_id FROM site_events
          WHERE event_type = ? AND friend_id IS NOT NULL
            AND (? IS NULL OR path = ?)
            AND occurred_at >= ? AND occurred_at <= ?`,
        [
          String(match.eventType ?? 'page_view'),
          match.path ?? null,
          match.path ?? null,
          opts.from,
          opts.to,
        ],
      );
    }
    case 'conversion': {
      return queryScoped(
        `SELECT DISTINCT friend_id FROM conversion_events
          WHERE conversion_point_id = ? AND created_at >= ? AND created_at <= ?`,
        [String(match.conversionPointId), opts.from, opts.to],
      );
    }
    case 'link_click': {
      return queryScoped(
        `SELECT DISTINCT friend_id FROM link_clicks
          WHERE tracked_link_id = ? AND friend_id IS NOT NULL
            AND clicked_at >= ? AND clicked_at <= ?`,
        [String(match.trackedLinkId), opts.from, opts.to],
      );
    }
    case 'form': {
      return queryScoped(
        `SELECT DISTINCT friend_id FROM form_submissions
          WHERE form_id = ? AND friend_id IS NOT NULL
            AND created_at >= ? AND created_at <= ?`,
        [String(match.formId), opts.from, opts.to],
      );
    }
    default:
      // 知らない種類は「誰も通らなかった」として扱う。例外にすると
      // ファネル全体が見られなくなる。
      return [];
  }
}
