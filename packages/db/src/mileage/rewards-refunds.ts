import { sqlIdSet } from '../id-queries.js';
import { type MileageRewardRedemption, type RedemptionRow } from './rewards-types.js';
import { getMileageRedemption, mapRedemption } from './rewards-redemptions.js';
import { MileageRewardError, requiredText } from './rewards-validation.js';


/**
 * 返却の勝者決め。自動返却と再試行が重なっても、残高・内訳の
 * 書き換えは1回だけにする。`batch` の中の条件付き更新だけでは、
 * 状態の更新が0件でもロット復元が走り、二重に戻る。
 *
 * 手順は次の順番に固定する。
 *
 * 1. 状態だけを条件付きで `refunded` へ進める（勝者決め）。
 *    取れなかった走者は残高も内訳も触らない。
 * 2. 勝者だけが台帳・ロット・コード解放を1つの batch で書く。
 * 3. すでに `refunded` の行への再呼び出しは、台帳が無ければ
 *    書き足して再開できる（中断後の再開）。ロットは戻さない。
 * 4. `succeeded` へ移った交換への遅い返却は 409 で止める。
 */
export async function refundMileageRewardRedemption(
  db: D1Database,
  input: { redemptionId: string; reason: string },
): Promise<MileageRewardRedemption> {
  const current = await getMileageRedemption(db, input.redemptionId);
  if (!current || current.anonymizedAt) throw new MileageRewardError('not_found', '交換履歴が見つかりません', 404);
  if (current.status === 'succeeded') {
    throw new MileageRewardError('already_delivered', 'すでに特典を渡した交換は返金できません', 409);
  }
  if (current.status === 'refunded') {
    await completeRefundWrites(db, current, input.reason);
    return (await getMileageRedemption(db, current.id))!;
  }
  const now = new Date().toISOString();
  const claimed = await db.prepare(
    `UPDATE mileage_redemptions
        SET status = 'refunded', refunded_at = ?, next_retry_at = NULL, updated_at = ?
      WHERE id = ? AND anonymized_at IS NULL AND status NOT IN ('succeeded', 'refunded')`,
  ).bind(now, now, current.id).run();
  if ((claimed.meta?.changes ?? 0) !== 1) {
    const latest = await getMileageRedemption(db, current.id);
    if (latest?.status === 'succeeded') {
      throw new MileageRewardError('already_delivered', 'すでに特典を渡した交換は返金できません', 409);
    }
    if (latest?.status === 'refunded') {
      await completeRefundWrites(db, latest, input.reason);
      return (await getMileageRedemption(db, current.id))!;
    }
    throw new MileageRewardError('refund_source_missing', '戻すマイルの記録を確認できませんでした', 409);
  }
  await completeRefundWrites(db, current, input.reason);
  return (await getMileageRedemption(db, current.id))!;
}

/**
 * 返却の書き込みが欠けていないか確かめる合図。
 * 返却台帳の冪等キーは交換ごとに1つ。台帳が無ければ書き込みは
 * 未実行（中断は確定前）。台帳があれば残高は戻っている
 * （残高は台帳 INSERT の trigger で連動する）。
 */
export function refundReversalIdempotencyKey(redemptionId: string): string {
  return `mileage-redemption-refund:${redemptionId}`;
}

/**
 * 勝者だけが呼ぶ、台帳・ロット・コード解放の書き込み。
 *
 * 台帳 INSERT とロット復元・コード解放を1つの batch で書く。
 * batch は原子（一部だけ残らない）なので、中断後に残るのは
 * 「台帳なし」（未実行）だけになる。INSERT は厳しい書き込み
 * （OR IGNORE なし）にする。同時に走った相手の batch は一意制約で
 * 全体が巻き戻り、残高・内訳の二重書き込みにならない。
 * 負けた走者は台帳を確かめ直し、あれば完了として扱う。
 */
export async function completeRefundWrites(
  db: D1Database,
  current: MileageRewardRedemption,
  reason: string,
): Promise<void> {
  const { reward, allocations } = await loadRefundSources(db, current);
  const now = new Date().toISOString();
  const existing = await selectRefundReversal(db, current);
  if (!existing) {
    try {
      await db.batch([
        db.prepare(`SELECT json(CASE WHEN EXISTS (SELECT 1 FROM mileage_redemptions
          WHERE id = ? AND anonymized_at IS NULL) THEN '{}' ELSE 'redemption_anonymized' END)`)
          .bind(current.id),
        db.prepare(
          `INSERT INTO mileage_ledger
             (id, program_id, beneficiary_user_id, beneficiary_friend_id,
              entry_type, amount, status, source, source_event_id, reason,
              idempotency_key, occurred_at, created_at, metadata)
           VALUES (?, ?, ?, ?, 'reversal', ?, 'available', 'mileage_reward_refund', ?, ?, ?, ?, ?, ?)`,
        ).bind(
          crypto.randomUUID(), current.programId,
          current.beneficiaryUserId, current.beneficiaryFriendId,
          reward.required_miles, current.id, requiredText(reason, '戻す理由', 500),
          refundReversalIdempotencyKey(current.id), now, now,
          JSON.stringify({ redemptionId: current.id, spendLedgerId: current.spendLedgerEntryId }),
        ),
        ...allocations.map((allocation) => db.prepare(
          // 返却は有効なロットだけへ戻す。成果の取消で無効化した
          // ロット(void)へは戻さない（取り消した付与が交換で復活しないように）。
          `UPDATE mileage_grant_lots
              SET remaining_amount = remaining_amount + ?,
                  status = 'available'
            WHERE ledger_entry_id = ? AND beneficiary_key = ?
              AND status IN ('available', 'exhausted')`,
        ).bind(allocation.amount, allocation.grant_lot_id, current.beneficiaryKey)),
        ...(current.rewardCodeId
          ? [db.prepare(
            `UPDATE mileage_reward_codes
                SET status = 'available', redemption_id = NULL, reserved_at = NULL
              WHERE id = ? AND redemption_id = ? AND status = 'reserved'`,
          ).bind(current.rewardCodeId, current.id)]
          : []),
      ]);
      return;
    } catch (error) {
      // 同時再開の負け（一意制約）か、本当の書き込み失敗かを見分ける。
      // 台帳があれば相手が書き終えた（batch 原子なのでロット・コードも済み）。
      if (await selectRefundReversal(db, current)) {
        await verifyRefundWrites(db, current, allocations);
        return;
      }
      throw error;
    }
  }
  // 台帳がある再開時は、ロットを戻さない（二重に戻さない）。
  // ただし旧処理で残った「台帳あり・コード未解放」だけは直す。
  await verifyRefundWrites(db, current, allocations);
}

export async function loadRefundSources(
  db: D1Database,
  current: MileageRewardRedemption,
): Promise<{
  reward: { required_miles: number };
  allocations: Array<{ grant_lot_id: string; amount: number }>;
}> {
  const reward = await db.prepare(
    `SELECT v.required_miles FROM mileage_reward_versions v WHERE v.id = ?`,
  ).bind(current.rewardVersionId).first<{ required_miles: number }>();
  if (!reward || !current.spendLedgerEntryId) {
    throw new MileageRewardError('refund_source_missing', '戻すマイルの記録を確認できませんでした', 409);
  }
  const allocations = await db.prepare(
    `SELECT grant_lot_id, amount
       FROM mileage_spend_allocations
      WHERE redemption_id = ? AND spend_ledger_id = ?`,
  ).bind(current.id, current.spendLedgerEntryId).all<{ grant_lot_id: string; amount: number }>();
  const allocatedTotal = allocations.results.reduce((sum, item) => sum + item.amount, 0);
  if (allocatedTotal !== reward.required_miles) {
    throw new MileageRewardError('refund_source_missing', '戻すマイルの内訳を確認できませんでした', 409);
  }
  return { reward, allocations: allocations.results };
}

export async function selectRefundReversal(
  db: D1Database,
  current: MileageRewardRedemption,
): Promise<{ id: string } | null> {
  return db.prepare(
    `SELECT id FROM mileage_ledger WHERE program_id = ? AND idempotency_key = ?`,
  ).bind(current.programId, refundReversalIdempotencyKey(current.id))
    .first<{ id: string }>();
}

/**
 * 旧処理で残り得る「台帳あり・コード未解放」の照合。
 * batch は原子なので、コードが未解放ならロット復元も未実行。
 * ロットの復元は読んだ残数への条件付き更新（CAS）で行う。同時修復で
 * 誰かが直した分は残数が変わっているため触らず、合計は1回分になる。
 * さらに内訳の更新は1件ごとに「いまもこの交換に予約中」の条件を付ける。
 * 読み直しが遅れて新しい残数で条件を作り直しても、先に終わった修復が
 * コードを解放していれば1件も通らず、二重に戻らない。コード解放も
 * 予約中のときだけ通る。照合自体は何度呼んでも壊さない。
 * updated_at の一致だけの柵では、同じ時刻の同時修復が両方通って
 * 内訳を二重に戻していた（時刻が同じだと柵が開いたままになる）。
 */
export async function verifyRefundWrites(
  db: D1Database,
  current: MileageRewardRedemption,
  allocations: Array<{ grant_lot_id: string; amount: number }>,
): Promise<void> {
  if (!current.rewardCodeId) return;
  const code = await db.prepare(
    `SELECT status FROM mileage_reward_codes WHERE id = ? AND redemption_id = ?`,
  ).bind(current.rewardCodeId, current.id).first<{ status: string }>();
  if (!code || code.status !== 'reserved') return;
  const placeholders = sqlIdSet(allocations.map(allocation => allocation.grant_lot_id)).sql;
  const currentLots = allocations.length > 0
    ? await db.prepare(
      `SELECT ledger_entry_id, remaining_amount FROM mileage_grant_lots
        WHERE ledger_entry_id IN (${placeholders}) AND beneficiary_key = ?
          AND status IN ('available', 'exhausted')`,
    ).bind(...sqlIdSet(allocations.map(allocation => allocation.grant_lot_id)).binds, current.beneficiaryKey)
      .all<{ ledger_entry_id: string; remaining_amount: number }>()
    : { results: [] as Array<{ ledger_entry_id: string; remaining_amount: number }> };
  const remainingByLot = new Map(
    currentLots.results.map((row) => [row.ledger_entry_id, row.remaining_amount]),
  );
  await db.batch([
    ...allocations.map((allocation) => db.prepare(
      `UPDATE mileage_grant_lots
          SET remaining_amount = remaining_amount + ?,
              status = 'available'
        WHERE ledger_entry_id = ? AND beneficiary_key = ?
          AND remaining_amount = ?
          AND status IN ('available', 'exhausted')
          AND EXISTS (
            SELECT 1 FROM mileage_reward_codes
             WHERE id = ? AND redemption_id = ? AND status = 'reserved'
          )`,
    ).bind(
      allocation.amount,
      allocation.grant_lot_id,
      current.beneficiaryKey,
      remainingByLot.get(allocation.grant_lot_id) ?? -1,
      current.rewardCodeId,
      current.id,
    )),
    db.prepare(
      `UPDATE mileage_reward_codes
          SET status = 'available', redemption_id = NULL, reserved_at = NULL
        WHERE id = ? AND redemption_id = ? AND status = 'reserved'`,
    ).bind(current.rewardCodeId, current.id),
  ]);
}

/**
 * 返却の書き込みが最後まで終わっているか。
 * 台帳が無ければ残高も内訳も未復旧。台帳があってもコードが
 * 未解放なら旧処理の残り（ロット未復旧）。どちらも無ければ完了。
 */
export async function isMileageRefundComplete(
  db: D1Database,
  redemptionId: string,
): Promise<boolean> {
  const current = await getMileageRedemption(db, redemptionId);
  if (!current || current.status !== 'refunded') return false;
  if (!await selectRefundReversal(db, current)) return false;
  if (!current.rewardCodeId) return true;
  const code = await db.prepare(
    `SELECT status FROM mileage_reward_codes WHERE id = ? AND redemption_id = ?`,
  ).bind(current.rewardCodeId, current.id).first<{ status: string }>();
  return !code || code.status !== 'reserved';
}

/**
 * 返却確定後に書き込みが中断した交換（台帳なしの refunded）。
 * 再試行は409、cronも要対応一覧も拾わない取り残し。回復処理と
 * 要対応一覧がこの口で見つけて再開する。
 * 旧処理の残り「台帳あり・コード未解放」（ロット未復旧）も拾う。
 * 返却済みの交換に結び付いたままの予約コードは、解放漏れ以外に
 * あり得ないため、完了判定（isMileageRefundComplete）と同じ基準。
 */
export async function findIncompleteMileageRefunds(
  db: D1Database,
  input: { lineAccountId?: string; lineAccountIds?: string[]; limit?: number; offset?: number } = {},
): Promise<MileageRewardRedemption[]> {
  const limit = Math.min(100, Math.max(1, Math.floor(input.limit ?? 50)));
  const binds: unknown[] = [];
  const accountClause = input.lineAccountId
    ? 'AND r.line_account_id = ?'
    : '';
  if (input.lineAccountId) binds.push(input.lineAccountId);
  const accountsClause = input.lineAccountIds ? 'AND r.line_account_id IN (SELECT value FROM json_each(?))' : '';
  if (input.lineAccountIds) binds.push(JSON.stringify(input.lineAccountIds));
  const rows = await db.prepare(
    `SELECT r.* FROM mileage_redemptions r
      WHERE r.status = 'refunded' AND r.anonymized_at IS NULL
        AND (
          NOT EXISTS (
            SELECT 1 FROM mileage_ledger l
             WHERE l.program_id = r.program_id
               AND l.idempotency_key = 'mileage-redemption-refund:' || r.id
          )
          OR EXISTS (
            SELECT 1 FROM mileage_reward_codes c
             WHERE c.redemption_id = r.id AND c.status = 'reserved'
          )
        )
        ${accountClause} ${accountsClause}
      ORDER BY r.updated_at, r.created_at, r.id LIMIT ? OFFSET ?`,
  ).bind(...binds, limit, Math.max(0, Math.floor(input.offset ?? 0))).all<RedemptionRow>();
  return rows.results.map(mapRedemption);
}

/**
 * 中断した返却を残高・台帳・状態が一致するまで再開する。
 * 冪等なので何度でも呼べる。同時に走っても台帳・ロット復元は各1回。
 * 成功へ移っていた行は返却せず済みとして数える（二重返却なし）。
 */
export async function recoverIncompleteMileageRefunds(
  db: D1Database,
  input: { lineAccountId?: string; limit?: number; reason?: string } = {},
): Promise<{ recovered: number; failed: number }> {
  const targets = await findIncompleteMileageRefunds(db, input);
  let recovered = 0;
  let failed = 0;
  for (const target of targets) {
    try {
      await refundMileageRewardRedemption(db, {
        redemptionId: target.id,
        reason: input.reason ?? '中断した返却の再開',
      });
      recovered += 1;
    } catch (error) {
      // 直前に成功へ移っていたら、返却の必要はない（遅い返却は書かない）。
      if (error instanceof MileageRewardError && error.code === 'already_delivered') {
        recovered += 1;
        continue;
      }
      failed += 1;
    }
  }
  return { recovered, failed };
}
