import { sqlIdSet } from '../id-queries.js';
import { type RedemptionRow, type MileageRewardRedemption, type MileageRedemptionListStatus, type MileageRedemptionListItem } from './rewards-types.js';


export function mapRedemption(row: RedemptionRow): MileageRewardRedemption {
  return {
    id: row.id,
    lineAccountId: row.line_account_id,
    programId: row.program_id,
    beneficiaryKey: row.beneficiary_key,
    beneficiaryUserId: row.beneficiary_user_id,
    beneficiaryFriendId: row.beneficiary_friend_id,
    rewardId: row.reward_id,
    rewardVersionId: row.reward_version_id,
    spendLedgerEntryId: row.spend_ledger_entry_id,
    rewardCodeId: row.reward_code_id,
    rewardNameSnapshot: row.reward_name_snapshot,
    rewardKindSnapshot: row.reward_kind_snapshot,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    status: row.status,
    attemptCount: row.attempt_count,
    nextRetryAt: row.next_retry_at,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    deliveredAt: row.delivered_at,
    refundedAt: row.refunded_at,
    anonymizedAt: row.anonymized_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getMileageRedemption(
  db: D1Database,
  id: string,
): Promise<MileageRewardRedemption | null> {
  const row = await db.prepare(`SELECT * FROM mileage_redemptions WHERE id = ?`)
    .bind(id).first<RedemptionRow>();
  return row ? mapRedemption(row) : null;
}

/**
 * 交換履歴の一覧。管理画面で「残高を減らしたのに特典が届かなかった交換」を
 * 見つけるための口。失敗理由・試行回数・最終日時は行がそのまま持つ。
 * アカウントの絞り込みは呼び出し側ではなくここで掛ける。
 */
export async function listMileageRedemptions(
  db: D1Database,
  input: {
    lineAccountId: string;
    status?: MileageRedemptionListStatus;
    limit: number;
    offset: number;
  },
): Promise<{
  items: MileageRedemptionListItem[];
  pagination: { total: number; limit: number; offset: number };
}> {
  const limit = Math.min(100, Math.max(1, Math.floor(input.limit)));
  const offset = Math.max(0, Math.floor(input.offset));
  const status = input.status ?? 'needs_attention';
  // 既定は「要対応」（届かなかった交換＋送ったか分からない交換）。
  // `delivering` のままの照合待ちを既定の一覧から消さない。
  // 返却確定後に書き込みが中断した交換（台帳なしの refunded）も
  // 要対応に入れる。入れないと残高が戻らないまま誰にも見えない。
  // 旧処理の残り「台帳あり・コード未解放」（ロット未復旧）も入れる。
  // 返却済みの交換に結び付いたままの予約コードは解放漏れのため、
  // 取り残しの発見（findIncompleteMileageRefunds）と同じ基準。
  const statusClause = status === 'all'
    ? ''
    : status === 'needs_attention'
      ? `AND (r.anonymized_at IS NULL AND (r.status IN ('delivery_failed', 'delivering')
        OR (r.status = 'refunded' AND (
          NOT EXISTS (
            SELECT 1 FROM mileage_ledger l
             WHERE l.program_id = r.program_id
               AND l.idempotency_key = 'mileage-redemption-refund:' || r.id
          )
          OR EXISTS (
            SELECT 1 FROM mileage_reward_codes c
             WHERE c.redemption_id = r.id AND c.status = 'reserved'
          )
        ))))`
      : 'AND r.status = ?';
  const binds: unknown[] = [input.lineAccountId];
  if (status !== 'all' && status !== 'needs_attention') binds.push(status);
  const totalRow = await db.prepare(
    `SELECT COUNT(*) AS count FROM mileage_redemptions r
      WHERE r.line_account_id = ? ${statusClause}`,
  ).bind(...binds).first<{ count: number }>();
  const rows = await db.prepare(
    `SELECT r.*, reward.name AS reward_name
       FROM mileage_redemptions r
       JOIN mileage_rewards reward ON reward.id = r.reward_id
      WHERE r.line_account_id = ? ${statusClause}
      ORDER BY r.updated_at DESC, r.id
      LIMIT ? OFFSET ?`,
  ).bind(...binds, limit, offset).all<RedemptionRow & { reward_name: string }>();
  return {
    items: rows.results.map((row) => ({ ...mapRedemption(row), rewardName: row.reward_name })),
    pagination: { total: totalRow?.count ?? 0, limit, offset },
  };
}

/*
 * 一人一回の上限を数える識別キーの集め方。現在のキーに加え、
 * - この友だち自身の友だちキー（統合前はこのキーで交換していた）
 * - 今同じ本人に結び付く友だちの友だちキー（統合相手の交換も一人分）
 * - これらの友だちが結び付いたことのある本人キー（解除・移行後も引き継ぐ）
 * をまとめる。export は試験から規則を確かめるため。
 */
export async function collectBeneficiaryKeysForLimit(
  db: D1Database,
  friendId: string,
  currentUserId: string | null,
  currentKey: string,
): Promise<string[]> {
  const keys = new Set<string>([currentKey, `friend:${friendId}`]);
  const coLinked = currentUserId
    ? (await db.prepare(`SELECT id FROM friends WHERE user_id = ?`)
      .bind(currentUserId).all<{ id: string }>()).results.map((row) => row.id)
    : [];
  const friendIds = [...new Set([friendId, ...coLinked])];
  for (const id of friendIds) keys.add(`friend:${id}`);
  const placeholders = sqlIdSet(friendIds).sql;
  const history = await db.prepare(
    `SELECT DISTINCT user_id FROM friend_identity_links
      WHERE friend_id IN (${placeholders}) AND user_id IS NOT NULL`,
  ).bind(...(friendIds.length ? sqlIdSet(friendIds).binds : [])).all<{ user_id: string }>();
  for (const row of history.results) keys.add(`user:${row.user_id}`);
  return [...keys];
}
