import { sqlIdSet } from '../id-queries.js';
import { matchesCondition } from '../segment-conditions.js';
import { type SegmentCondition } from '@line-crm/shared';
import { type MileageRewardRedemption, type RedemptionRow, type RewardRow, type MileageRewardSummary, type MileageRewardVersion, type MileageRewardTargetCondition, type WalletRow, type LotRow, type MileageRedemptionStatus } from './rewards-types.js';
import { MileageRewardError, rewardSelect, mapReward } from './rewards-validation.js';
import { mapRedemption, collectBeneficiaryKeysForLimit, getMileageRedemption } from './rewards-redemptions.js';
import { completeRefundWrites } from './rewards-refunds.js';


export async function reserveMileageRewardRedemption(
  db: D1Database,
  input: {
    lineAccountId: string;
    friendId: string;
    rewardId: string;
    idempotencyKey: string;
    requestFingerprint: string;
  },
): Promise<{ kind: 'created' | 'existing'; redemption: MileageRewardRedemption }> {
  const existing = await db.prepare(
    `SELECT * FROM mileage_redemptions WHERE program_id = 'default' AND idempotency_key = ?`,
  ).bind(input.idempotencyKey).first<RedemptionRow>();
  if (existing) {
    if (existing.request_fingerprint !== input.requestFingerprint) {
      throw new MileageRewardError('idempotency_conflict', '同じ処理IDに別の交換内容が指定されました', 409);
    }
    return { kind: 'existing', redemption: mapRedemption(existing) };
  }

  // 交換は公開版を直接読む。下書きの有無に左右されない。
  const publishedRow = await db.prepare(
    `${rewardSelect('r.current_published_version_id')}
      WHERE r.id = ? AND r.line_account_id = ? AND r.status = 'published'`,
  ).bind(input.rewardId, input.lineAccountId).first<RewardRow>();
  const reward = publishedRow ? mapReward(publishedRow) : null;
  const version = reward?.currentVersion?.status === 'published' ? reward.currentVersion : null;
  if (!reward || !version) {
    throw new MileageRewardError('reward_not_available', 'この使い道は現在交換できません', 409);
  }
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  // 保存値はUTCへ正規化済み。比較も時刻値で行い、表記ゆれに左右されない。
  const startsMs = version.startsAt ? new Date(version.startsAt).getTime() : Number.NaN;
  const endsMs = version.endsAt ? new Date(version.endsAt).getTime() : Number.NaN;
  if ((Number.isFinite(startsMs) && startsMs > nowMs) || (Number.isFinite(endsMs) && endsMs <= nowMs)) {
    throw new MileageRewardError('reward_outside_period', 'この使い道は交換期間外です', 409);
  }
  const friend = await db.prepare(
    `SELECT id, user_id FROM friends WHERE id = ? AND line_account_id = ?`,
  ).bind(input.friendId, input.lineAccountId).first<{ id: string; user_id: string | null }>();
  if (!friend) throw new MileageRewardError('friend_not_found', '友だち情報を確認できませんでした', 404);
  // 保存した交換対象条件を消費前に評価する。条件に合わない友だちへ
  // 特典を渡さない。管理・LIFFの両経路はこの関数を通るため、ここで守る。
  if (version.targetConditions
    && ((version.targetConditions.rules?.length ?? 0) > 0
      || (version.targetConditions.groups?.length ?? 0) > 0)) {
    let eligible: boolean;
    try {
      eligible = await matchesCondition(db, friend.id, version.targetConditions as SegmentCondition);
    } catch {
      throw new MileageRewardError('target_conditions_invalid', '交換対象の条件を確認してください', 409);
    }
    if (!eligible) {
      throw new MileageRewardError('reward_not_eligible', 'この使い道の交換対象ではありません', 403);
    }
  }
  const beneficiaryKey = friend.user_id ? `user:${friend.user_id}` : `friend:${friend.id}`;
  /*
   * 確定文と事後確認も事前確認と同じキー集合で数える。確認だけ広げると
   * 同時実行の隙間で抜けるため、INSERT時の条件と対にしておく。
   * perFriendLimit が無い特典では現在のキーだけ（余計な読みを足さない）。
   */
  let limitKeys = [beneficiaryKey];
  if (version.perFriendLimit) {
    limitKeys = await collectBeneficiaryKeysForLimit(db, input.friendId, friend.user_id, beneficiaryKey);
  }
  const limitPlaceholders = sqlIdSet(limitKeys).sql;
  const wallet = await db.prepare(
    `SELECT beneficiary_key, beneficiary_user_id, beneficiary_friend_id, available, version
       FROM mileage_wallets WHERE program_id = ? AND beneficiary_key = ?`,
  ).bind(reward.programId, beneficiaryKey).first<WalletRow>();
  if (!wallet || wallet.available < version.requiredMiles) {
    throw new MileageRewardError('insufficient_miles', '交換に必要なマイルが足りません', 409);
  }
  if (version.perFriendLimit) {
    /*
     * 一人一回は現在の本人識別だけでなく、統合・解除・移行の前後で
     * 同じ友だちが名乗った識別キーすべてで数える。現在のキー・友だちキー・
     * 同じ本人に結び付く友だちのキー・結び付き履歴の本人キーをまとめる。
     * 規則:
     * - 異なる本人（結び付きの無い別キー）は別々に数える。
     * - 返却済み（refunded）は数えない。
     * - 誤統合の訂正で外れた後は別々に数えるが、統合期間中の本人キーでの
     *   交換は共有のまま残る（履歴は消さない）。
     */
    const count = await db.prepare(
      `SELECT COUNT(*) AS count FROM mileage_redemptions
        WHERE reward_id = ? AND beneficiary_key IN (${limitPlaceholders}) AND status != 'refunded' AND (status != 'reserved' OR anonymized_at IS NULL)`,
    ).bind(reward.id, ...(limitKeys.length ? sqlIdSet(limitKeys).binds : [])).first<{ count: number }>();
    if ((count?.count ?? 0) >= version.perFriendLimit) {
      throw new MileageRewardError('friend_limit_reached', 'この使い道は交換上限に達しています', 409);
    }
  }
  const triedCodeIds = new Set<string>();
  let code: { id: string } | null = null;
  const redemptionId = crypto.randomUUID();
  const spendLedgerId = crypto.randomUUID();
  if (version.stockLimit != null) {
    const count = await db.prepare(
      `SELECT COUNT(*) AS count FROM mileage_redemptions
        WHERE reward_version_id = ? AND status != 'refunded' AND (status != 'reserved' OR anonymized_at IS NULL)`,
    ).bind(version.id).first<{ count: number }>();
    if ((count?.count ?? 0) >= version.stockLimit) {
      throw new MileageRewardError('out_of_stock', 'この使い道は在庫切れです', 409);
    }
  }

  const lots = await db.prepare(
    `SELECT ledger_entry_id, remaining_amount FROM mileage_grant_lots
      WHERE program_id = ? AND beneficiary_key = ? AND status = 'available'
        AND remaining_amount > 0 AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END, expires_at, available_at, ledger_entry_id`,
  ).bind(reward.programId, beneficiaryKey, now).all<LotRow>();
  let remaining = version.requiredMiles;
  const allocations: Array<{ lotId: string; amount: number }> = [];
  for (const lot of lots.results) {
    if (remaining <= 0) break;
    const amount = Math.min(remaining, lot.remaining_amount);
    allocations.push({ lotId: lot.ledger_entry_id, amount });
    remaining -= amount;
  }
  if (remaining > 0) {
    // 残高はあるのに内訳が足りない主因は期限切れ。期限切れの
    // ロットが不足分を説明できるときは「足りません」として案内し、
    // 内訳エラー（確認できませんでした）にはしない。
    const expiredHeld = await db.prepare(
      `SELECT COALESCE(SUM(remaining_amount), 0) AS expired_remaining
         FROM mileage_grant_lots
        WHERE program_id = ? AND beneficiary_key = ? AND status = 'available'
          AND remaining_amount > 0 AND expires_at IS NOT NULL AND expires_at <= ?`,
    ).bind(reward.programId, beneficiaryKey, now).first<{ expired_remaining: number }>();
    if (Number(expiredHeld?.expired_remaining ?? 0) > 0) {
      throw new MileageRewardError(
        'insufficient_miles',
        '期限切れのマイルは使えないため、交換に必要なマイルが足りません',
        409,
      );
    }
    throw new MileageRewardError('mileage_lots_unavailable', '交換できるマイルの内訳を確認できませんでした', 409);
  }

  // 特定コードの取得競合を在庫全体の枯渇と混ぜない。
  // 選んだコードを横取りされたら、別の利用可能コードを取り直す。
  // 確定文の上限判定も事前確認と同じ本人キー集合で数える。
  for (let attempt = 0; attempt < 5; attempt++) {
    if (reward.rewardKind === 'coupon') {
      const tried = [...triedCodeIds];
      code = await db.prepare(
        `SELECT id FROM mileage_reward_codes
          WHERE reward_version_id = ? AND status = 'available'
          ${tried.length > 0 ? `AND id NOT IN (${tried.map(() => '?').join(', ')})` : ''}
          ORDER BY created_at, id LIMIT 1`,
      ).bind(version.id, ...tried).first<{ id: string }>();
      if (!code) {
        throw new MileageRewardError('out_of_stock', '交換コードの在庫がありません', 409);
      }
    } else {
      code = null;
    }
    const statements: D1PreparedStatement[] = [
      db.prepare(
        `INSERT INTO mileage_redemptions
           (id, line_account_id, program_id, beneficiary_key, beneficiary_user_id,
            beneficiary_friend_id, reward_id, reward_version_id, spend_ledger_entry_id,
            reward_code_id, reward_name_snapshot, reward_kind_snapshot,
            idempotency_key, request_fingerprint, status, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?
           FROM mileage_wallets w
          WHERE w.program_id = ? AND w.beneficiary_key = ?
            AND w.version = ? AND w.available >= ?
            AND NOT EXISTS (
              SELECT 1 FROM mileage_redemptions existing
               WHERE existing.program_id = ? AND existing.idempotency_key = ?
            )
            AND (? IS NULL OR EXISTS (
              SELECT 1 FROM mileage_reward_codes inventory
               WHERE inventory.id = ? AND inventory.status = 'available'
            ))
            AND (? IS NULL OR (
              SELECT COUNT(*) FROM mileage_redemptions stock
               WHERE stock.reward_version_id = ? AND stock.status != 'refunded' AND (stock.status != 'reserved' OR stock.anonymized_at IS NULL)
            ) < ?)
            AND (? IS NULL OR (
              SELECT COUNT(*) FROM mileage_redemptions person_limit
               WHERE person_limit.reward_id = ?
                 AND person_limit.beneficiary_key IN (${limitPlaceholders})
                 AND person_limit.status != 'refunded' AND (person_limit.status != 'reserved' OR person_limit.anonymized_at IS NULL)
            ) < ?)`,
      ).bind(
        redemptionId, reward.lineAccountId, reward.programId, beneficiaryKey,
        friend.user_id, friend.id, reward.id, version.id,
        // 交換が決まったときの名前・種類をこの行に凍結する。
        null, code?.id ?? null, reward.name, reward.rewardKind,
        input.idempotencyKey, input.requestFingerprint,
        now, now, reward.programId, beneficiaryKey, wallet.version, version.requiredMiles,
        reward.programId, input.idempotencyKey,
        code?.id ?? null, code?.id ?? null,
        version.stockLimit, version.id, version.stockLimit,
        version.perFriendLimit, reward.id, ...sqlIdSet(limitKeys).binds, version.perFriendLimit,
      ),
      db.prepare(
        `INSERT INTO mileage_ledger
           (id, program_id, beneficiary_user_id, beneficiary_friend_id,
            entry_type, amount, status, source, source_event_id, reason,
            idempotency_key, occurred_at, created_at, metadata)
         SELECT ?, program_id, beneficiary_user_id, beneficiary_friend_id,
                'spend', ?, 'available', 'mileage_reward', id, ?, ?, ?, ?, ?
           FROM mileage_redemptions WHERE id = ?`,
      ).bind(
        spendLedgerId, -version.requiredMiles, `「${reward.name}」と交換`,
        `mileage-redemption:${redemptionId}`, now, now,
        JSON.stringify({ rewardId: reward.id, rewardVersionId: version.id }), redemptionId,
      ),
      db.prepare(
        `UPDATE mileage_redemptions SET spend_ledger_entry_id = ?, updated_at = ?
          WHERE id = ? AND spend_ledger_entry_id IS NULL`,
      ).bind(spendLedgerId, now, redemptionId),
    ];
    for (const allocation of allocations) {
      const allocationId = crypto.randomUUID();
      statements.push(
        db.prepare(
          `UPDATE mileage_grant_lots
              SET remaining_amount = remaining_amount - ?,
                  status = CASE WHEN remaining_amount - ? = 0 THEN 'exhausted' ELSE status END
            WHERE ledger_entry_id = ? AND remaining_amount >= ?
              AND EXISTS (SELECT 1 FROM mileage_redemptions WHERE id = ?)`,
        ).bind(allocation.amount, allocation.amount, allocation.lotId, allocation.amount, redemptionId),
        db.prepare(
          `INSERT INTO mileage_spend_allocations
             (id, redemption_id, spend_ledger_id, grant_lot_id, amount, created_at)
           SELECT ?, ?, ?, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM mileage_redemptions WHERE id = ?)`,
        ).bind(
          allocationId, redemptionId, spendLedgerId, allocation.lotId,
          allocation.amount, now, redemptionId,
        ),
      );
    }
    if (code) {
      statements.push(db.prepare(
        `UPDATE mileage_reward_codes
            SET status = 'reserved', redemption_id = ?, reserved_at = ?
          WHERE id = ? AND status = 'available'
            AND EXISTS (SELECT 1 FROM mileage_redemptions WHERE id = ?)`,
      ).bind(redemptionId, now, code.id, redemptionId));
    }
    await db.batch(statements);
    const created = await getMileageRedemption(db, redemptionId);
    if (created) return { kind: 'created', redemption: created };
    const racedExisting = await db.prepare(
      `SELECT * FROM mileage_redemptions WHERE program_id = ? AND idempotency_key = ?`,
    ).bind(reward.programId, input.idempotencyKey).first<RedemptionRow>();
    if (racedExisting) {
      if (racedExisting.request_fingerprint !== input.requestFingerprint) {
        throw new MileageRewardError('idempotency_conflict', '同じ処理IDに別の交換内容が指定されました', 409);
      }
      return { kind: 'existing', redemption: mapRedemption(racedExisting) };
    }
    if (code) {
      triedCodeIds.add(code.id);
      const inventory = await db.prepare(
        `SELECT status FROM mileage_reward_codes WHERE id = ?`,
      ).bind(code.id).first<{ status: string }>();
      if (inventory?.status !== 'available') continue;
    }

    if (version.stockLimit != null) {
      const currentStock = await db.prepare(
        `SELECT COUNT(*) AS count FROM mileage_redemptions
          WHERE reward_version_id = ? AND status != 'refunded' AND (status != 'reserved' OR anonymized_at IS NULL)`,
      ).bind(version.id).first<{ count: number }>();
      if ((currentStock?.count ?? 0) >= version.stockLimit) {
        throw new MileageRewardError('out_of_stock', 'この使い道は在庫切れです', 409);
      }
    }
    if (version.perFriendLimit != null) {
      const currentCount = await db.prepare(
        `SELECT COUNT(*) AS count FROM mileage_redemptions
          WHERE reward_id = ? AND beneficiary_key IN (${limitPlaceholders}) AND status != 'refunded' AND (status != 'reserved' OR anonymized_at IS NULL)`,
      ).bind(reward.id, ...(limitKeys.length ? sqlIdSet(limitKeys).binds : [])).first<{ count: number }>();
      if ((currentCount?.count ?? 0) >= version.perFriendLimit) {
        throw new MileageRewardError('friend_limit_reached', 'この使い道は交換上限に達しています', 409);
      }
    }
    const currentWallet = await db.prepare(
      `SELECT available FROM mileage_wallets WHERE program_id = ? AND beneficiary_key = ?`,
    ).bind(reward.programId, beneficiaryKey).first<{ available: number }>();
    if (!currentWallet || currentWallet.available < version.requiredMiles) {
      throw new MileageRewardError('insufficient_miles', '交換に必要なマイルが足りません', 409);
    }
    throw new MileageRewardError('wallet_changed', 'マイル残高が変わりました。読み直してください', 409);
  }
  // ここへ来るのは、コード以外の理由で確定できなかったとき。
  // 失敗側の残高は変えず、理由を区別して返す。
  if (code) {
    const inventory = await db.prepare(
      `SELECT status FROM mileage_reward_codes WHERE id = ?`,
    ).bind(code.id).first<{ status: string }>();
    if (inventory?.status !== 'available') {
      throw new MileageRewardError('out_of_stock', '交換コードの在庫がありません', 409);
    }
  }
  if (version.stockLimit != null) {
    const currentStock = await db.prepare(
      `SELECT COUNT(*) AS count FROM mileage_redemptions
        WHERE reward_version_id = ? AND status != 'refunded' AND (status != 'reserved' OR anonymized_at IS NULL)`,
    ).bind(version.id).first<{ count: number }>();
    if ((currentStock?.count ?? 0) >= version.stockLimit) {
      throw new MileageRewardError('out_of_stock', 'この使い道は在庫切れです', 409);
    }
  }
  if (version.perFriendLimit != null) {
    const currentCount = await db.prepare(
      `SELECT COUNT(*) AS count FROM mileage_redemptions
        WHERE reward_id = ? AND beneficiary_key IN (${limitPlaceholders}) AND status != 'refunded' AND (status != 'reserved' OR anonymized_at IS NULL)`,
    ).bind(reward.id, ...(limitKeys.length ? sqlIdSet(limitKeys).binds : [])).first<{ count: number }>();
    if ((currentCount?.count ?? 0) >= version.perFriendLimit) {
      throw new MileageRewardError('friend_limit_reached', 'この使い道は交換上限に達しています', 409);
    }
  }
  const currentWallet = await db.prepare(
    `SELECT available FROM mileage_wallets WHERE program_id = ? AND beneficiary_key = ?`,
  ).bind(reward.programId, beneficiaryKey).first<{ available: number }>();
  if (!currentWallet || currentWallet.available < version.requiredMiles) {
    throw new MileageRewardError('insufficient_miles', '交換に必要なマイルが足りません', 409);
  }
  throw new MileageRewardError('wallet_changed', 'マイル残高が変わりました。読み直してください', 409);
}

export async function recordMileageRedemptionAttempt(
  db: D1Database,
  input: {
    redemptionId: string;
    status: 'succeeded' | 'failed';
    errorCode?: string | null;
    errorMessage?: string | null;
    retryAt?: string | null;
  },
): Promise<MileageRewardRedemption> {
  const current = await getMileageRedemption(db, input.redemptionId);
  if (!current) throw new MileageRewardError('not_found', '交換履歴が見つかりません', 404);
  if (current.status === 'succeeded') return current;
  if (current.status === 'refunded') {
    /*
     * 返却確定後に台帳・ロットの書き込みが中断した行は、
     * ここでも欠けた分を足してから返す。失敗したら回復（再試行・cron）
     * に任せ、記録の呼び出し自体は壊さない。
     */
    try {
      await completeRefundWrites(db, current, '中断した返却の再開');
    } catch {
      /* 回復は再試行・cronに任せる */
    }
    return (await getMileageRedemption(db, current.id))!;
  }
  const now = new Date().toISOString();
  const attempt = current.attemptCount + 1;
  const status: MileageRedemptionStatus = input.status === 'succeeded' ? 'succeeded' : 'delivery_failed';
  await db.batch([
    db.prepare(
      `INSERT INTO mileage_redemption_attempts
         (id, redemption_id, attempt_number, status, error_code, error_message, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), current.id, attempt, input.status,
      input.errorCode ?? null, input.errorMessage ?? null, now, now,
    ),
    db.prepare(
      `UPDATE mileage_redemptions
          SET status = ?, attempt_count = ?, next_retry_at = ?, failure_code = ?,
              failure_message = ?, delivered_at = ?, updated_at = ?
        WHERE id = ? AND status NOT IN ('succeeded', 'refunded')`,
    ).bind(
      status, attempt, input.retryAt ?? null, input.errorCode ?? null,
      input.errorMessage ?? null, input.status === 'succeeded' ? now : null,
      now, current.id,
    ),
    ...(input.status === 'succeeded' && current.rewardCodeId
      ? [db.prepare(
        `UPDATE mileage_reward_codes SET status = 'issued', issued_at = ?
          WHERE id = ? AND redemption_id = ? AND status = 'reserved'`,
      ).bind(now, current.rewardCodeId, current.id)]
      : []),
  ]);
  return (await getMileageRedemption(db, current.id))!;
}
