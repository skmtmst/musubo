import { scopedFriendIds, storedBroadcastFriendScope } from '../../services/segment-query-scope.js';
import { DELIVERY_CONSENT_ALLOWED_SQL } from '@line-crm/db/src/friend-delivery-consents.js';
import { sqlIdSet } from '@line-crm/db/id-queries';
import { INSIGHT_MIN_AUDIENCE } from '@line-crm/db';
import { buildSegmentWhere } from '../../services/segment-query.js';
import { type SegmentCondition } from '@line-crm/shared';

/**
 * 配信前チェック。
 *
 * 送る直前に「何人に届くか」「気をつけることはあるか」を返す。
 * 一斉配信は取り消せないので、押す前に見せる。
 *
 * 送信そのものは何もしない。数えて注意を返すだけ。
 */

export interface PreflightWarning {
  /** 画面での見せ方を分けるための種別 */
  level: 'info' | 'warning';
  message: string;
}

export interface PreflightResult {
  audienceCount: number;
  /** 表示状態で除外された人数。0 なら出さない */
  hiddenExcluded: number;
  warnings: PreflightWarning[];
}

export interface PreflightInput {
  targetType: string;
  targetTagId?: string | null;
  lineAccountId?: string | null;
  /** multi-account-dedup のときの対象アカウント */
  accountIds?: string[];
  /**
   * 詳細条件で絞ったときの条件。
   *
   * 渡さないと、条件を無視して**そのアカウントの全員**を数える。
   * 12人に送るつもりで「312人に届きます」と出たまま送信ボタンを押す、
   * という取り違えが起きる。取り消せない操作の直前に出る数字なので、
   * 送信と同じ条件で数える。
   */
  segmentConditions?: SegmentCondition | null;
}

export interface AudiencePreview {
  matched: number;
  sendable: number;
  evaluatedAt: string;
  representatives: Array<{
    friendId: string;
    displayName: string | null;
    pictureUrl: string | null;
    summary: string;
  }>;
  exclusions: {
    blocked: number;
    hidden: number;
    missingDestination: number;
    duplicate: number;
    paused: number;
    total: number;
  };
}

/**
 * 条件に当たる行を一度読み、送れない理由を重複させずに分類する。
 * 配信停止は同じ人の複数目的を重複させず、送信と同じ台帳で判定する。
 */
export async function previewAudience(
  db: D1Database,
  input: PreflightInput,
): Promise<AudiencePreview> {
  if (input.targetType === 'tag' && !input.targetTagId) return emptyAudiencePreview();
  const where: string[] = ['1 = 1'];
  const binds: unknown[] = [];
  if (input.targetType === 'multi-account-dedup') {
    const ids = input.accountIds ?? [];
    if (ids.length === 0) return emptyAudiencePreview();
    where.push(`f.line_account_id IN (${sqlIdSet(ids).sql})`);
    binds.push(...sqlIdSet(ids).binds);
  } else if (input.lineAccountId) {
    where.push('f.line_account_id = ?');
    binds.push(input.lineAccountId);
  } else {
    const ids = scopedFriendIds(await storedBroadcastFriendScope(db, null));
    where.push(`f.id IN (${ids.sql})`);
    binds.push(...ids.bindings);
  }
  if (input.targetType === 'tag') {
    where.push('EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?)');
    binds.push(input.targetTagId);
  }
  if (input.targetType === 'segment' && input.segmentConditions) {
    const segment = buildSegmentWhere(input.segmentConditions);
    where.push(`(${segment.sql})`);
    binds.push(...segment.bindings);
  }

  const result = await db.prepare(
    `SELECT f.id, f.line_platform_user_id AS line_user_id, f.display_name, f.picture_url, f.user_id,
            ${DELIVERY_CONSENT_ALLOWED_SQL} AS consent_allowed,
            f.is_following, COALESCE(f.is_hidden, 0) AS is_hidden,
            COALESCE((SELECT GROUP_CONCAT(t.name, '・')
                        FROM friend_tags ft JOIN tags t ON t.id = ft.tag_id
                       WHERE ft.friend_id = f.id), '') AS tag_names
       FROM friends f WHERE ${where.join(' AND ')}
      ORDER BY f.updated_at DESC, f.id`,
  ).bind(...binds).all<{
    id: string;
    line_user_id: string | null;
    display_name: string | null;
    picture_url: string | null;
    user_id: string | null;
    consent_allowed: number;
    is_following: number;
    is_hidden: number;
    tag_names: string;
  }>();

  let blocked = 0;
  let hidden = 0;
  let missingDestination = 0;
  let duplicate = 0;
  let paused = 0;
  const uniquePeople = new Set<string>();
  const sendable: typeof result.results = [];
  for (const row of result.results) {
    if (!row.is_following) {
      blocked += 1;
      continue;
    }
    if (row.is_hidden) {
      hidden += 1;
      continue;
    }
    if (!row.line_user_id?.trim()) {
      missingDestination += 1;
      continue;
    }
    if (!row.consent_allowed) {
      paused += 1;
      continue;
    }
    const dedupKey = input.targetType === 'multi-account-dedup' && row.user_id
      ? `user:${row.user_id}`
      : `friend:${row.id}`;
    if (uniquePeople.has(dedupKey)) {
      duplicate += 1;
      continue;
    }
    uniquePeople.add(dedupKey);
    sendable.push(row);
  }
  const exclusions = {
    blocked,
    hidden,
    missingDestination,
    duplicate,
    paused,
    total: blocked + hidden + missingDestination + duplicate + paused,
  } as const;
  return {
    matched: result.results.length,
    sendable: sendable.length,
    evaluatedAt: new Date().toISOString(),
    representatives: sendable.slice(0, 3).map((row) => ({
      friendId: row.id,
      displayName: row.display_name,
      pictureUrl: row.picture_url,
      summary: row.tag_names || '条件に一致',
    })),
    exclusions,
  };
}

function emptyAudiencePreview(): AudiencePreview {
  return {
    matched: 0,
    sendable: 0,
    evaluatedAt: new Date().toISOString(),
    representatives: [],
    exclusions: {
      blocked: 0,
      hidden: 0,
      missingDestination: 0,
      duplicate: 0,
      paused: 0,
      total: 0,
    },
  };
}

/**
 * 何人に届くかを数える。
 *
 * 非表示にした友だち（friends.is_hidden = 1）は数えない。
 * 「こちらから見えなくした人」に配信が飛ぶと、非表示にした意味がない。
 */
export async function countAudience(
  db: D1Database,
  input: PreflightInput,
): Promise<{ total: number; hiddenExcluded: number }> {
  if (input.targetType === 'tag' && !input.targetTagId) return { total: 0, hiddenExcluded: 0 };
  const where: string[] = ['f.is_following = 1', DELIVERY_CONSENT_ALLOWED_SQL];
  const binds: unknown[] = [];

  if (input.targetType === 'multi-account-dedup') {
    const ids = input.accountIds ?? [];
    if (ids.length === 0) return { total: 0, hiddenExcluded: 0 };
    where.push(`f.line_account_id IN (${sqlIdSet(ids).sql})`);
    binds.push(...sqlIdSet(ids).binds);
  } else if (input.lineAccountId) {
    where.push('f.line_account_id = ?');
    binds.push(input.lineAccountId);
  } else {
    const ids = scopedFriendIds(await storedBroadcastFriendScope(db, null));
    where.push(`f.id IN (${ids.sql})`);
    binds.push(...ids.bindings);
  }

  if (input.targetType === 'tag') {
    where.push('EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?)');
    binds.push(input.targetTagId);
  }

  if (input.targetType === 'segment' && input.segmentConditions) {
    // 送信と同じ組み立てを使う。別々に書くと、条件を1つ足したときに
    // 「一覧に出る人」と「実際に届く人」がずれる。
    const segment = buildSegmentWhere(input.segmentConditions);
    where.push(`(${segment.sql})`);
    binds.push(...segment.bindings);
  }

  const row = await db
    .prepare(
      `SELECT SUM(CASE WHEN COALESCE(f.is_hidden, 0) = 0 THEN 1 ELSE 0 END) AS total,
              SUM(CASE WHEN COALESCE(f.is_hidden, 0) = 1 THEN 1 ELSE 0 END) AS hidden
         FROM friends f WHERE ${where.join(' AND ')}`,
    )
    .bind(...binds)
    .first<{ total: number | null; hidden: number | null }>();

  return {
    total: Number(row?.total ?? 0),
    hiddenExcluded: Number(row?.hidden ?? 0),
  };
}

/**
 * 注意を組み立てる。
 *
 * 止めない。押すかどうかは人が決める。ここで弾くと、意図して
 * 少人数へ送りたい場合に送れなくなる。
 */
export function buildWarnings(
  audience: { total: number; hiddenExcluded: number; consentExcluded?: number },
  opts: { hasRecentSimilar?: boolean } = {},
): PreflightWarning[] {
  const warnings: PreflightWarning[] = [];

  if (audience.total === 0) {
    warnings.push({
      level: 'warning',
      message: '届く人が0人です。絞り込みの条件を見直してください。',
    });
  } else if (audience.total < INSIGHT_MIN_AUDIENCE) {
    // LINEの決まりで、20人未満だと開封もクリックも返ってこない。
    // 送れないわけではないので、注意にとどめる。
    warnings.push({
      level: 'info',
      message: `届く人が${audience.total}人です。${INSIGHT_MIN_AUDIENCE}人未満だと、LINEから開封数・クリック数が返りません。`,
    });
  }

  if (audience.hiddenExcluded > 0) {
    warnings.push({
      level: 'info',
      message: `非表示にした ${audience.hiddenExcluded} 人は届く人数に入っていません。`,
    });
  }

  if ((audience.consentExcluded ?? 0) > 0) {
    warnings.push({ level: 'info', message: `配信を止めている ${audience.consentExcluded} 人には送りません。` });
  }

  if (opts.hasRecentSimilar) {
    warnings.push({
      level: 'warning',
      message: '直近24時間に同じ内容の配信があります。二重に送っていないか確認してください。',
    });
  }

  return warnings;
}

/**
 * 直近に同じ本文の配信があるか。
 *
 * 押し間違いによる二重送信を、送る前に気づけるようにする。
 * 冪等キーは同じリクエストの再送を防ぐが、人が2回作って2回押す場合は
 * 別のリクエストなので通ってしまう。
 */
export async function hasRecentSimilarBroadcast(
  db: D1Database,
  messageContent: string,
  nowIso: string,
): Promise<boolean> {
  const since = new Date(Date.parse(nowIso) - 24 * 3600_000).toISOString();
  const row = await db
    .prepare(
      `SELECT 1 FROM broadcasts
        WHERE message_content = ? AND sent_at IS NOT NULL AND sent_at >= ?
        LIMIT 1`,
    )
    .bind(messageContent, since)
    .first<{ 1: number }>();
  return row != null;
}
