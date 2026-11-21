import { type RedemptionStepRow, type RedemptionStepLease, type RedemptionStepClaim, type MileageRewardRedemption, type MileageRewardKind, type MileageRewardFailurePolicy, type RedemptionRow } from './rewards-types.js';
import { MileageRewardError } from './rewards-validation.js';
import { mapRedemption } from './rewards-redemptions.js';


/**
 * 確定書き込みの失敗印。外部送信は終わっているかもしれないので、
 * deliver 側はこれを delivery_failed に落とさず、回収に任せる。
 */
export class MileageRedemptionConfirmError extends Error {
  constructor(message = '特典の送信後の確定に失敗しました') {
    super(message);
    this.name = 'MileageRedemptionConfirmError';
  }
}

/**
 * LINE 再試行キーの有効期限（24時間。公式仕様による）。
 * 最初の送信からこの時間を過ぎた手順は、同じキーで送り直さない。
 * 期限を過ぎると LINE 側の重複防止が切れ、同じキーが新規受付されるため。
 * リマインダ側の `LINE_RETRY_KEY_VALIDITY_MS` と同じ考え方。
 */
export const MILEAGE_REWARD_RETRY_KEY_VALIDITY_MS = 24 * 60 * 60 * 1000;

/**
 * 渡し終えた手順があるか。部分成功の交換は全額返却しない。
 * `sent` の行が1つでもあれば、一部の特典は相手に渡っている。
 */
export async function hasSentRedemptionSteps(
  db: D1Database,
  redemptionId: string,
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS ok FROM mileage_redemption_step_deliveries
      WHERE redemption_id = ? AND status = 'sent' LIMIT 1`,
  ).bind(redemptionId).first<{ ok: number }>();
  return row != null;
}

export async function selectRedemptionStep(
  db: D1Database,
  redemptionId: string,
  stepKey: string,
): Promise<RedemptionStepRow | null> {
  return db.prepare(
    `SELECT status, owner,
            lease_expires_at AS leaseExpiresAt,
            idempotency_key AS idempotencyKey,
            needs_reconcile AS needsReconcile,
            created_at AS createdAt
       FROM mileage_redemption_step_deliveries
      WHERE redemption_id = ? AND step_key = ?`,
  ).bind(redemptionId, stepKey).first<RedemptionStepRow>();
}

export async function claimRedemptionStep(
  db: D1Database,
  input: RedemptionStepLease,
): Promise<RedemptionStepClaim> {
  let existing = await selectRedemptionStep(db, input.redemptionId, input.stepKey);
  if (!existing) {
    try {
      /*
       * 証言つきの確保。「送るかもしれない」を送る前に残す。
       * この書き込みに失敗したら送らない。送ったあとの確定が
       * 何度失敗しても証言は残るので、回収は送り直さない。
       */
      await db.prepare(
        `INSERT INTO mileage_redemption_step_deliveries
           (redemption_id, step_key, idempotency_key, status,
            owner, lease_expires_at, generation, fence_token, needs_reconcile,
            created_at, updated_at)
         VALUES (?, ?, ?, 'started', ?, ?, 1, ?, 1, ?, ?)`,
      ).bind(
        input.redemptionId, input.stepKey, input.idempotencyKey,
        input.owner, input.leaseExpiresAt, input.fenceToken,
        input.now, input.now,
      ).run();
      return 'send';
    } catch {
      // 同時確保の負け：相手の行を既存として扱う。行が無ければ投げ直す。
      existing = await selectRedemptionStep(db, input.redemptionId, input.stepKey);
      if (!existing) throw new MileageRedemptionConfirmError();
    }
  }
  if (existing.status === 'sent') return 'sent';
  /*
   * 最初の送信から24時間を過ぎた手順は、同じキーで送り直さない。
   * 期限を過ぎると LINE 側の重複防止が切れ、同じキーが新規受付されて
   * 二重に届く。照合待ちとして残し、人が確かめる。
   */
  if (input.retryKeyExpiresAt != null && existing.createdAt <= input.retryKeyExpiresAt) {
    return 'expired';
  }
  // 証言がある行は、誰も送り直さないし勝手に確定もしない。照合待ち。
  if (existing.needsReconcile === 1) return 'reconcile';
  const leaseLive = existing.leaseExpiresAt !== null && existing.leaseExpiresAt > input.now;
  // 別の走者が貸出を持っている間は、送らずに待つ。
  if (leaseLive && existing.owner !== null && existing.owner !== input.owner) return 'busy';
  if (existing.owner === input.owner && leaseLive) {
    // 同じ走者の取り直し：貸出を延ばし、証言と fence を新しくする。
    const refreshed = await db.prepare(
      `UPDATE mileage_redemption_step_deliveries
          SET lease_expires_at = ?, fence_token = ?, needs_reconcile = 1,
              attempt_count = attempt_count + 1, updated_at = ?
        WHERE redemption_id = ? AND step_key = ?
          AND status = 'started' AND needs_reconcile = 0 AND owner = ?`,
    ).bind(
      input.leaseExpiresAt, input.fenceToken, input.now,
      input.redemptionId, input.stepKey, input.owner,
    ).run();
    return (refreshed.meta?.changes ?? 0) === 1 ? 'send' : 'busy';
  }
  // 期限切れの引き継ぎ：世代を進め、証言つきで取り直す。
  // 古い走者の遅い確定は通らない。
  const taken = await db.prepare(
    `UPDATE mileage_redemption_step_deliveries
        SET owner = ?, lease_expires_at = ?, generation = generation + 1,
            fence_token = ?, needs_reconcile = 1,
            attempt_count = attempt_count + 1, updated_at = ?
      WHERE redemption_id = ? AND step_key = ?
        AND status = 'started' AND needs_reconcile = 0
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
  ).bind(
    input.owner, input.leaseExpiresAt, input.fenceToken, input.now,
    input.redemptionId, input.stepKey, input.now,
  ).run();
  return (taken.meta?.changes ?? 0) === 1 ? 'send' : 'busy';
}

/**
 * 照合待ちの手順の回復引き継ぎ。送ったか確かめられない行を、
 * 送り直しても安全な手順だけ、期限内にもう一度だけ実行する。
 *
 * 返すのは次の4つのどれか。
 *
 * - 'send' … 貸出を取り直した。同じ冪等キーで実行してよい。
 * - 'sent' … その間に確定していた。送らない。
 * - 'reconcile' … 照合待ちのまま。送らない（期限切れ・Webhookなど）。
 * - 'busy' … 別の走者の貸出が生きている。送らずに待つ。
 *
 * 送り直し自体の安全は呼び出し側が手順の種類で判断する
 * （Webhookは外部で二重に届くので回復しない）。
 * 期限切れはここでも見る（`claimRedemptionStep` と同じ境界）。
 */
export async function claimRedemptionStepForRecovery(
  db: D1Database,
  input: RedemptionStepLease,
): Promise<RedemptionStepClaim> {
  const existing = await selectRedemptionStep(db, input.redemptionId, input.stepKey);
  if (!existing) throw new MileageRedemptionConfirmError();
  if (existing.status === 'sent') return 'sent';
  if (existing.needsReconcile !== 1) return 'busy';
  if (input.retryKeyExpiresAt != null && existing.createdAt <= input.retryKeyExpiresAt) {
    return 'expired';
  }
  const leaseLive = existing.leaseExpiresAt !== null && existing.leaseExpiresAt > input.now;
  if (leaseLive) return 'busy';
  const taken = await db.prepare(
    `UPDATE mileage_redemption_step_deliveries
        SET owner = ?, lease_expires_at = ?, generation = generation + 1,
            fence_token = ?, attempt_count = attempt_count + 1, updated_at = ?
      WHERE redemption_id = ? AND step_key = ?
        AND status = 'started' AND needs_reconcile = 1
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
  ).bind(
    input.owner, input.leaseExpiresAt, input.fenceToken, input.now,
    input.redemptionId, input.stepKey, input.now,
  ).run();
  return (taken.meta?.changes ?? 0) === 1 ? 'send' : 'busy';
}

/**
 * 外部送信が終わった手順を sent にする。証言つきの自分の貸出だけ通す。
 * 証言を消した行(送らなかったことが決まった行)・古い走者の遅い確定・
 * 確保していない行の確定は投げる。呼び出し側は確定失敗として扱い、
 * 失敗には落とさない(証言が残るので回収は送り直さない)。
 */
export async function markRedemptionStepSent(
  db: D1Database,
  input: { redemptionId: string; stepKey: string; owner: string; fenceToken: string; now: string },
): Promise<void> {
  const result = await db.prepare(
    `UPDATE mileage_redemption_step_deliveries
        SET status = 'sent', needs_reconcile = 0, updated_at = ?
      WHERE redemption_id = ? AND step_key = ?
        AND status = 'started' AND needs_reconcile = 1
        AND owner = ? AND fence_token = ?`,
  ).bind(input.now, input.redemptionId, input.stepKey, input.owner, input.fenceToken).run();
  if ((result.meta?.changes ?? 0) !== 1) {
    throw new MileageRedemptionConfirmError();
  }
}

/**
 * 送らなかった手順の証言を消す。実行器が送る前に失敗したときだけ使う。
 * 消せたら回収は送り直してよい(送っていないことが決まった)。
 * 消せなければ照合待ちのまま残し、送り直さない。
 *
 * **貸出も一緒に返す。** 証言を消すだけで持ち主と期限を残すと、行は
 * 「送っていないのに、まだ誰かが送信中」に見える。次の走者は貸出が
 * 生きている間 `'busy'` しか受け取れず、失敗した直後のやり直しが
 * 貸出の残り時間ぶん空振りする(失敗から
 * 5分間、管理画面のやり直しが1回も送らない)。送らないことが決まった
 * 行に貸出を握らせない。
 */
export async function clearRedemptionStepIntent(
  db: D1Database,
  input: { redemptionId: string; stepKey: string; owner: string; fenceToken: string; now: string },
): Promise<void> {
  const result = await db.prepare(
    `UPDATE mileage_redemption_step_deliveries
        SET needs_reconcile = 0, owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE redemption_id = ? AND step_key = ?
        AND status = 'started' AND needs_reconcile = 1
        AND owner = ? AND fence_token = ?`,
  ).bind(input.now, input.redemptionId, input.stepKey, input.owner, input.fenceToken).run();
  if ((result.meta?.changes ?? 0) !== 1) {
    throw new MileageRedemptionConfirmError();
  }
}

export async function getReservedMileageRewardCode(
  db: D1Database,
  redemptionId: string,
): Promise<{ id: string; ciphertext: string } | null> {
  return db.prepare(
    `SELECT c.id, c.code_ciphertext AS ciphertext
       FROM mileage_reward_codes c
       JOIN mileage_redemptions r ON r.id = c.redemption_id
      WHERE r.id = ? AND c.status IN ('reserved', 'issued')`,
  ).bind(redemptionId).first<{ id: string; ciphertext: string }>();
}

export async function getMileageRewardDeliveryPlan(
  db: D1Database,
  redemptionId: string,
): Promise<{
  redemption: MileageRewardRedemption;
  rewardName: string;
  rewardKind: MileageRewardKind;
  isHandgift: boolean;
  customerMessage: string;
  commonActionVersionId: string | null;
  actionConfig: string | null;
  failurePolicy: MileageRewardFailurePolicy;
}> {
  const row = await db.prepare(
    `SELECT r.*, reward.name AS reward_name, reward.reward_kind,
            v.customer_message, v.common_action_version_id, v.failure_policy,
            EXISTS (SELECT 1 FROM mileage_handgift_rewards h WHERE h.reward_id = reward.id) AS is_handgift,
            cav.action_config
       FROM mileage_redemptions r
       JOIN mileage_rewards reward ON reward.id = r.reward_id
       JOIN mileage_reward_versions v ON v.id = r.reward_version_id
       LEFT JOIN common_action_versions cav ON cav.id = v.common_action_version_id
      WHERE r.id = ?`,
  ).bind(redemptionId).first<RedemptionRow & {
    reward_name: string;
    reward_kind: MileageRewardKind;
    is_handgift: number;
    customer_message: string;
    common_action_version_id: string | null;
    failure_policy: MileageRewardFailurePolicy;
    action_config: string | null;
  }>();
  if (!row) throw new MileageRewardError('not_found', '交換履歴が見つかりません', 404);
  return {
    redemption: mapRedemption(row),
    // 交換が決まったときの名前・種類を優先する。未公開の名前変更や
    // 種類変更が、処理中・成功済みの交換へ混ざらない。凍結前の古い行は親行を読む。
    rewardName: row.reward_name_snapshot ?? row.reward_name,
    rewardKind: row.reward_kind_snapshot ?? row.reward_kind,
    isHandgift: row.is_handgift === 1,
    customerMessage: row.customer_message,
    commonActionVersionId: row.common_action_version_id,
    actionConfig: row.action_config,
    failurePolicy: row.failure_policy,
  };
}
