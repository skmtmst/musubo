import { jstNow } from '../utils.js';
import { type MileageAdjustmentErrorCode, type MileageAdjustmentMetadata, type MileageLedgerEntry, type MileageAdjustmentResult, type PostMileageAdjustmentInput, type AdjustmentLotConsumption } from './types.js';
import { DEFAULT_MILEAGE_PROGRAM_ID } from './program.js';



export class MileageAdjustmentError extends Error {
  constructor(public readonly code: MileageAdjustmentErrorCode) {
    super(code);
    this.name = 'MileageAdjustmentError';
  }
}

export function parseAdjustmentMetadata(value: string | null): MileageAdjustmentMetadata {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as MileageAdjustmentMetadata;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function adjustmentResult(
  entry: MileageLedgerEntry,
  fingerprint: string,
  replayed: boolean,
): MileageAdjustmentResult {
  const metadata = parseAdjustmentMetadata(entry.metadata);
  if (
    metadata.adjustmentFingerprint !== fingerprint ||
    !Number.isFinite(metadata.balanceBefore) ||
    !Number.isFinite(metadata.balanceAfter)
  ) {
    throw new MileageAdjustmentError('idempotency_conflict');
  }
  return {
    entry,
    balanceBefore: Number(metadata.balanceBefore),
    balanceAfter: Number(metadata.balanceAfter),
    replayed,
  };
}

export function buildAdjustmentFingerprint(input: PostMileageAdjustmentInput): string {
  const fingerprintInput: Record<string, unknown> = {
    friendId: input.friendId,
    amount: input.amount,
    reason: input.reason,
    reasonCategory: input.reasonCategory,
    sourceReferenceId: input.sourceReferenceId ?? null,
    lineAccountId: input.lineAccountId,
  };
  // Keep the original six-field shape when neither option is used, so
  // idempotent retries of adjustments created before this migration still work.
  if (input.expiresAt) fingerprintInput.expiresAt = input.expiresAt;
  if (input.notifyFriend) fingerprintInput.notifyFriend = true;
  return JSON.stringify(fingerprintInput);
}

/**
 * 確定済みの調整を Idempotency-Key で探す。
 *
 * 承認境界の引き下げや元の有効期限の経過は「新しい調整への判定」なので、
 * すでに台帳へ入った同じ要求の再送には適用しない。呼び出し側は
 * 期限・境界の検査より先にここを試し、見つかったら当時の結果を返す。
 * 同じキーで別の内容が来た場合は idempotency_conflict を投げる。
 */
export async function findCommittedMileageAdjustment(
  db: D1Database,
  input: PostMileageAdjustmentInput,
): Promise<MileageAdjustmentResult | null> {
  const programId = input.programId ?? DEFAULT_MILEAGE_PROGRAM_ID;
  const existing = await db
    .prepare(`SELECT * FROM mileage_ledger WHERE program_id = ? AND idempotency_key = ?`)
    .bind(programId, input.idempotencyKey)
    .first<MileageLedgerEntry>();
  if (!existing) return null;
  return adjustmentResult(existing, buildAdjustmentFingerprint(input), true);
}

/**
 * Append one manual adjustment without ever mutating the existing ledger.
 *
 * The balance check and INSERT share one SQLite statement. Two deductions that
 * race cannot both observe the same old balance: D1 serializes the write and
 * the second statement re-evaluates the wallet before inserting. The stable
 * `(program_id, idempotency_key)` constraint makes retries return the original
 * before/after values instead of applying the delta again.
 */
/**
 * 手動減算で使う内訳の選び方。交換の予約と同じ「使える」基準で、
 * 期限の近いロットから順に消費する。台帳の INSERT と同じ batch へ積むため、
 * 台帳が書かれなかった同時操作の負け分は EXISTS の条件でロットへ触らない。
 */
export function adjustmentLotSpendOrderSql(): string {
  return `CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END, expires_at, available_at, ledger_entry_id`;
}

/**
 * この調整で内訳から消費済みの分を台帳の印から読む。
 * 取り直しの batch が落ちた後の再送は、この印だけが「残り」の根拠。
 * 印が無ければ未記録として全額を請求対象にする（上限は残高との照合で守る）。
 */
export function readLotConsumed(metadata: string | null | undefined): AdjustmentLotConsumption[] {
  try {
    const parsed = metadata
      ? (JSON.parse(metadata) as { lotConsumed?: unknown })
      : null;
    if (!parsed || !Array.isArray(parsed.lotConsumed)) return [];
    return parsed.lotConsumed.filter((item): item is AdjustmentLotConsumption =>
      !!item &&
      typeof item === 'object' &&
      typeof (item as { lotId?: unknown }).lotId === 'string' &&
      typeof (item as { amount?: unknown }).amount === 'number');
  } catch {
    return [];
  }
}

export async function recordLotConsumed(
  db: D1Database,
  ledgerId: string,
  programId: string,
  idempotencyKey: string,
  entries: AdjustmentLotConsumption[],
): Promise<void> {
  await db.prepare(
    `UPDATE mileage_ledger
        SET metadata = json_set(COALESCE(metadata, '{}'), '$.lotConsumed', json(?))
      WHERE id = ? AND program_id = ? AND idempotency_key = ?`,
  ).bind(JSON.stringify(entries), ledgerId, programId, idempotencyKey).run();
}

/**
 * 取り直しの1件ごとに「いまの超過分」を確かめる条件。
 * 同じ不足の再送が重なっても、文の実行時点で使える内訳が残高を
 * 上回っている分だけしか消費しない。batch 内では前の文の効果が見える
 * ため、直列化された2件目は超過が無くなり止まる（二重消費防止）。
 * 残高側の範囲は再送の上限と同じ受益者一致（概算の守りとして十分）。
 */
export function lotRepairLiveExcessGateSql(): string {
  return `AND ? <= (
    (SELECT COALESCE(SUM(remaining_amount), 0) FROM mileage_grant_lots
      WHERE program_id = ? AND beneficiary_key = ? AND status = 'available'
        AND remaining_amount > 0 AND (expires_at IS NULL OR expires_at > ?))
    -
    (SELECT COALESCE(SUM(CASE WHEN status = 'available' THEN amount ELSE 0 END), 0)
       FROM mileage_ledger
      WHERE program_id = ?
        AND (beneficiary_user_id = ? OR beneficiary_friend_id = ?))
  )`;
}

/**
 * 同じ依頼キーの再送で、残っている内訳の不足を取り直す。
 * 取り直しの batch が途中で失敗すると、台帳はあるのに内訳が残る。
 * その不足を補う。請求は印の残りだけに絞り、
 * さらに「使える内訳が残高を上回る分」を上限にするため、
 * 印が古くても残高より多くは消費しない（二重消費防止）。
 * 台帳・残高には触らない（存在する行を返すだけ）。
 */
export async function repairAdjustmentLotShortfall(
  db: D1Database,
  entry: MileageLedgerEntry,
  owedTotal: number,
): Promise<void> {
  const recorded = readLotConsumed(entry.metadata);
  let claimed = owedTotal - recorded.reduce((sum, item) => sum + item.amount, 0);
  if (claimed <= 0) return;
  const key = entry.beneficiary_user_id
    ? `user:${entry.beneficiary_user_id}`
    : `friend:${entry.beneficiary_friend_id}`;
  const balanceRow = await db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN status = 'available' THEN amount ELSE 0 END), 0) AS available
       FROM mileage_ledger
      WHERE program_id = ?
        AND (beneficiary_user_id = ? OR beneficiary_friend_id = ?)`,
  ).bind(entry.program_id, entry.beneficiary_user_id, entry.beneficiary_friend_id)
    .first<{ available: number }>();
  const now = jstNow();
  const usableRow = await db.prepare(
    `SELECT COALESCE(SUM(remaining_amount), 0) AS total FROM mileage_grant_lots
      WHERE program_id = ? AND beneficiary_key = ? AND status = 'available'
        AND remaining_amount > 0 AND (expires_at IS NULL OR expires_at > ?)`,
  ).bind(entry.program_id, key, now).first<{ total: number }>();
  const excess = Number(usableRow?.total ?? 0) - Number(balanceRow?.available ?? 0);
  claimed = Math.min(claimed, excess);
  if (claimed <= 0) return;
  let guard = 0;
  while (claimed > 0 && guard < 8) {
    guard += 1;
    const fresh = await db.prepare(
      `SELECT ledger_entry_id, remaining_amount FROM mileage_grant_lots
        WHERE program_id = ? AND beneficiary_key = ? AND status = 'available'
          AND remaining_amount > 0 AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY ${adjustmentLotSpendOrderSql()}`,
    ).bind(entry.program_id, key, now)
      .all<{ ledger_entry_id: string; remaining_amount: number }>();
    const retry: AdjustmentLotConsumption[] = [];
    let need = claimed;
    for (const lot of fresh.results) {
      if (need <= 0) break;
      const take = Math.min(need, lot.remaining_amount);
      retry.push({ lotId: lot.ledger_entry_id, amount: take });
      need -= take;
    }
    if (retry.length === 0) break;
    const retryResults = (await db.batch(
      retry.map((spend) =>
        db.prepare(
          `UPDATE mileage_grant_lots
              SET remaining_amount = remaining_amount - ?,
                  status = CASE WHEN remaining_amount - ? = 0 THEN 'exhausted' ELSE status END
            WHERE ledger_entry_id = ? AND remaining_amount >= ?
              AND EXISTS (SELECT 1 FROM mileage_ledger WHERE id = ?)
              ${lotRepairLiveExcessGateSql()}`,
        ).bind(
          spend.amount, spend.amount, spend.lotId, spend.amount, entry.id,
          spend.amount, entry.program_id, key, now,
          entry.program_id, entry.beneficiary_user_id, entry.beneficiary_friend_id,
        ),
      ),
    )) as Array<{ meta?: { changes?: unknown } }>;
    const applied: AdjustmentLotConsumption[] = [];
    for (let index = 0; index < retry.length; index += 1) {
      if (Number(retryResults[index]?.meta?.changes ?? 0) > 0) {
        applied.push(retry[index]);
        claimed -= retry[index].amount;
      }
    }
    if (applied.length === 0) break;
    recorded.push(...applied);
    await recordLotConsumed(db, entry.id, entry.program_id, entry.idempotency_key, recorded);
    entry.metadata = JSON.stringify({
      ...(tryParseMetadata(entry.metadata)),
      lotConsumed: recorded,
    });
  }
}

export function tryParseMetadata(metadata: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = metadata ? (JSON.parse(metadata) as unknown) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
