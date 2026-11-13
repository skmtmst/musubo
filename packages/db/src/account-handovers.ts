import { jstNow } from './utils.js';

/**
 * LINEアカウントの乗り換え（引き継ぎ）。設計 ★33-4（`nx3XW`）。
 *
 * **`account_migrations` とは別物。** あちらは友だちを別のアカウントへ移す表。
 * こちらは「2つのアカウントをコードでつなぎ、突合してから本実行する」5段の流れ。
 */

export const HANDOVER_STATUSES = [
  'code_issued',
  'linked',
  'previewed',
  'resolved',
  'executing',
  'completed',
  'failed',
  'cancelled',
] as const;
export type HandoverStatus = (typeof HANDOVER_STATUSES)[number];

/** 事前確認の4区分。設計の言葉と1対1。 */
export const MATCH_BUCKETS = ['auto', 'review', 'unmatched', 'lookalike'] as const;
export type MatchBucket = (typeof MATCH_BUCKETS)[number];

export type ProviderMatch = 'same' | 'different' | 'unknown';

export interface HandoverRow {
  id: string;
  confirmation_revision: number;
  from_account_id: string;
  to_account_id: string | null;
  code: string;
  code_expires_at: string;
  status: HandoverStatus;
  provider_match: ProviderMatch;
  source_friend_total: number | null;
  auto_count: number | null;
  review_count: number | null;
  unmatched_count: number | null;
  lookalike_count: number | null;
  moved_count: number;
  failed_count: number;
  failure_reason: string | null;
  /** 移し元システム側の申告件数（運用者入力）。事前確認と違うままでは本実行しない。 */
  declared_friend_total?: number | null;
  rolled_back_at?: string | null;
  rolled_back_by?: string | null;
  rollback_note?: string | null;
  created_by: string | null;
  created_at: string;
  linked_at: string | null;
  previewed_at: string | null;
  resolved_at: string | null;
  executed_at: string | null;
  completed_at: string | null;
}

export interface HandoverDecisionRow {
  id: string;
  handover_id: string;
  from_friend_id: string;
  to_friend_id: string | null;
  decision: 'link' | 'new' | 'skip';
  bucket: MatchBucket;
  note: string | null;
  decided_by: string | null;
  decided_at: string;
}

export interface MatchCounts {
  auto: number;
  review: number;
  unmatched: number;
  lookalike: number;
}

/**
 * 4区分の合計が元の友だち数と合っているか。
 *
 * **合わない結果を保存しない。** 出すと、運用者は「どこかの人が消えた」と読む。
 * 画面側（`handover-view.ts` の `totalsMatch`）と同じ決まりを、口の側でも守る。
 */
export function countsAddUp(counts: MatchCounts, sourceTotal: number): boolean {
  return counts.auto + counts.review + counts.unmatched + counts.lookalike === sourceTotal;
}

/**
 * プロバイダーが同じか。
 *
 * **分からないことを「同じ」と書かない。** LINE の Messaging API は
 * プロバイダーを返さないので、どちらかが未入力なら `unknown` にする。
 * `unknown` のまま進めると、事前確認で「一致しない」が大量に出た理由が
 * 分からなくなるので、画面はその断りを出す。
 */
export function compareProviders(
  fromProviderId: string | null | undefined,
  toProviderId: string | null | undefined,
): ProviderMatch {
  if (!fromProviderId || !toProviderId) return 'unknown';
  return fromProviderId === toProviderId ? 'same' : 'different';
}

/** 引き継ぎコード。読み違えやすい文字（0/O、1/I/L）は使わない。 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateHandoverCode(random: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < 12; i += 1) {
    if (i > 0 && i % 4 === 0) code += '-';
    code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  }
  return code;
}

/** 段1。コードを出す。既に生きているコードがあればそれを返す（二重に出さない）。 */
export async function issueHandoverCode(
  db: D1Database,
  input: { fromAccountId: string; createdBy?: string | null; ttlMinutes?: number },
): Promise<HandoverRow> {
  const existing = await db
    .prepare(
      `SELECT * FROM account_handovers
        WHERE from_account_id = ? AND status = 'code_issued' AND julianday(code_expires_at) > julianday(?)
        ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(input.fromAccountId, jstNow())
    .first<HandoverRow>();
  if (existing) return existing;

  const id = crypto.randomUUID();
  const now = jstNow();
  // 引き継ぎコードは既定72時間・1回だけ（X の確定値）。
  const expires = new Date(Date.now() + (input.ttlMinutes ?? 72 * 60) * 60_000).toISOString();
  await db
    .prepare(
      `INSERT INTO account_handovers (id, from_account_id, code, code_expires_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.fromAccountId, generateHandoverCode(), expires, input.createdBy ?? null, now)
    .run();
  return (await getHandoverById(db, id))!;
}

export async function getHandoverById(db: D1Database, id: string): Promise<HandoverRow | null> {
  return db.prepare(`SELECT * FROM account_handovers WHERE id = ?`).bind(id).first<HandoverRow>();
}

export async function getHandoverByCode(db: D1Database, code: string): Promise<HandoverRow | null> {
  return db
    .prepare(`SELECT * FROM account_handovers WHERE code = ?`)
    .bind(code)
    .first<HandoverRow>();
}

/** 段2。受け取り先で読む。**期限切れのコードは通さない。** */
export async function linkHandover(
  db: D1Database,
  input: { code: string; toAccountId: string; providerMatch: ProviderMatch },
): Promise<{ ok: true; handover: HandoverRow } | { ok: false; error: string }> {
  const handover = await getHandoverByCode(db, input.code);
  if (!handover) return { ok: false, error: 'そのコードはありません' };
  if (handover.status !== 'code_issued') return { ok: false, error: 'そのコードはもう使われています' };
  if (!Number.isFinite(Date.parse(handover.code_expires_at)) || Date.parse(handover.code_expires_at) <= Date.parse(jstNow())) return { ok: false, error: 'そのコードは期限が切れています' };
  if (handover.from_account_id === input.toAccountId) {
    return { ok: false, error: '同じアカウントへは引き継げません' };
  }
  const now = jstNow();
  const result = await db
    .prepare(
      `UPDATE account_handovers
          SET confirmation_revision=confirmation_revision+1, to_account_id = ?, provider_match = ?, status = 'linked', linked_at = ?
        WHERE id = ? AND status = 'code_issued' AND julianday(code_expires_at) > julianday(?)`,
    )
    .bind(input.toAccountId, input.providerMatch, now, handover.id, now)
    .run();
  if (Number(result.meta?.changes ?? 0) !== 1) {
    return { ok: false, error: 'そのコードは期限切れ、または既に使われています' };
  }
  return { ok: true, handover: (await getHandoverById(db, handover.id))! };
}

/**
 * 段3。事前確認の結果を保存する。
 *
 * **合計が合わないものは保存しない。** 保存すると、画面がそれを出してしまう。
 * また **ここでは元のアカウントを何も変えない**（設計の「ここで止めても、
 * 元のアカウントは何も変わりません」）。この関数が触るのは `account_handovers`
 * の数の列だけで、`friends` には一切書かない。
 */
export async function savePreview(
  db: D1Database,
  id: string,
  input: { sourceFriendTotal: number; counts: MatchCounts; declaredFriendTotal?: number | null },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!countsAddUp(input.counts, input.sourceFriendTotal)) {
    return { ok: false, error: '区分の合計が元の友だち数と合いません' };
  }
  const changed = await db
    .prepare(
      `UPDATE account_handovers
          SET confirmation_revision=confirmation_revision+1, source_friend_total = ?, auto_count = ?, review_count = ?,
              unmatched_count = ?, lookalike_count = ?, declared_friend_total = ?,
              status = 'previewed', previewed_at = ?
        WHERE id = ? AND status NOT IN ('executing','completed','cancelled')`,
    )
    .bind(
      input.sourceFriendTotal,
      input.counts.auto,
      input.counts.review,
      input.counts.unmatched,
      input.counts.lookalike,
      input.declaredFriendTotal ?? null,
      jstNow(),
      id,
    )
    .run();
  return changed.meta.changes ? { ok: true } : { ok: false, error: '引き継ぎの状態が変わりました。読み直してください' };
}

/** 切り戻しできるのは本実行から7日間だけ（-33 §12-2、X の確定値）。 */
export const HANDOVER_ROLLBACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function rollbackDeadlineOf(handover: HandoverRow): string | null {
  if (!handover.completed_at) return null;
  return new Date(
    new Date(handover.completed_at).getTime() + HANDOVER_ROLLBACK_WINDOW_MS,
  ).toISOString();
}

/**
 * 段6。切り戻し。本実行で動かした友だちを元のアカウントへ戻す。
 *
 * **戻せるのは7日以内・1回だけ。** 期限を過ぎた引き継ぎ、すでに戻した
 * 引き継ぎは拒否する。戻す対象は decisions の link/new で動かした行で、
 * いま受け取り先にいる人だけ（その後人が移した行は触らない）。
 */
export async function rollbackHandover(
  db: D1Database,
  id: string,
  input: { rolledBackBy?: string | null; note?: string | null; expectedRevision?: number },
): Promise<{ ok: true; restoredCount: number } | { ok: false; error: string; conflict?: boolean }> {
  const handover = await getHandoverById(db, id);
  if (!handover) return { ok: false, error: 'その引き継ぎはありません' };
  if (input.expectedRevision !== undefined && input.expectedRevision !== handover.confirmation_revision) return { ok: false, conflict: true, error: '引き継ぎが変わりました。読み直してください' };
  if (handover.status !== 'completed') {
    return { ok: false, error: '本実行が終わっていない引き継ぎは戻せません' };
  }
  if (handover.rolled_back_at) {
    return { ok: false, error: 'その引き継ぎはもう戻しています' };
  }
  const deadline = rollbackDeadlineOf(handover);
  if (!deadline || deadline <= new Date().toISOString()) {
    return { ok: false, error: '切り戻せる期限（7日間）を過ぎています' };
  }
  if (!handover.to_account_id) {
    return { ok: false, error: '受け取り先が分からないため戻せません' };
  }

  const records = await db.prepare('SELECT COUNT(*) n FROM account_handover_moves WHERE handover_id=?').bind(id).first<{n:number}>();
  if (!records?.n) return { ok: false, error: '移動の記録がないため戻せません' };
  try {
    const result = await db.batch([
      db.prepare(`UPDATE account_handovers SET rolled_back_at=?,rolled_back_by=?,rollback_note=?,confirmation_revision=confirmation_revision+1
        WHERE id=? AND status='completed' AND rolled_back_at IS NULL AND julianday(completed_at)>julianday('now','-7 days') AND (? IS NULL OR confirmation_revision=?)
        AND EXISTS(SELECT 1 FROM line_accounts a JOIN account_handover_moves m ON m.handover_id=account_handovers.id
          WHERE a.id=account_handovers.from_account_id AND m.from_account_id=account_handovers.from_account_id AND m.to_account_id=account_handovers.to_account_id
            AND m.tenant_id=COALESCE(a.tenant_id,'00000000-0000-4000-8000-000000000001'))
        AND NOT EXISTS(SELECT 1 FROM line_accounts a JOIN account_handover_moves m ON m.handover_id=account_handovers.id
          WHERE a.id=account_handovers.from_account_id AND (m.from_account_id<>account_handovers.from_account_id OR m.to_account_id<>account_handovers.to_account_id OR m.tenant_id<>COALESCE(a.tenant_id,'00000000-0000-4000-8000-000000000001')))`)
        .bind(jstNow(),input.rolledBackBy??null,input.note??null,id,input.expectedRevision??null,input.expectedRevision??null),
      db.prepare("SELECT json(CASE WHEN changes()=1 THEN '{}' ELSE 'HANDOVER_CONFLICT' END)"),
      db.prepare(`UPDATE friends SET line_account_id=? WHERE line_account_id=? AND id IN
        (SELECT m.friend_id FROM account_handover_moves m JOIN line_accounts a ON a.id=m.from_account_id WHERE m.handover_id=? AND m.from_account_id=? AND m.to_account_id=? AND m.tenant_id=COALESCE(a.tenant_id,'00000000-0000-4000-8000-000000000001'))`)
        .bind(handover.from_account_id,handover.to_account_id,id,handover.from_account_id,handover.to_account_id),
    ]);
    return { ok: true, restoredCount: Number(result[2].meta.changes ?? 0) };
  } catch (error) {
    if (/malformed JSON/i.test(String(error))) return { ok:false, conflict:true, error:'引き継ぎまたは記録が変わりました。読み直してください' };
    throw error;
  }
}

/** 段4。競合の判断を1件保存する。同じ人を2回決めたら上書きする。 */
export async function saveDecision(
  db: D1Database,
  input: {
    handoverId: string;
    fromFriendId: string;
    toFriendId?: string | null;
    decision: 'link' | 'new' | 'skip';
    bucket: MatchBucket;
    note?: string | null;
    decidedBy?: string | null;
  },
): Promise<void> {
  const now = jstNow();
  const result = await db.batch([
    db.prepare("UPDATE account_handovers SET confirmation_revision=confirmation_revision+1 WHERE id=? AND status NOT IN ('executing','completed','cancelled')").bind(input.handoverId),
    db.prepare(
      `INSERT INTO account_handover_decisions
         (id, handover_id, from_friend_id, to_friend_id, decision, bucket, note, decided_by, decided_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes()=1
       ON CONFLICT (handover_id, from_friend_id) DO UPDATE SET
         to_friend_id = excluded.to_friend_id,
         decision = excluded.decision,
         bucket = excluded.bucket,
         note = excluded.note,
         decided_by = excluded.decided_by,
         decided_at = excluded.decided_at`,
    )
    .bind(
      crypto.randomUUID(),
      input.handoverId,
      input.fromFriendId,
      input.toFriendId ?? null,
      input.decision,
      input.bucket,
      input.note ?? null,
      input.decidedBy ?? null,
      now,
    ),
  ]);
  if (!result[0].meta.changes) throw new Error('HANDOVER_STATE_CONFLICT');
}

export async function listDecisions(
  db: D1Database,
  handoverId: string,
): Promise<HandoverDecisionRow[]> {
  const result = await db
    .prepare(`SELECT * FROM account_handover_decisions WHERE handover_id = ? ORDER BY decided_at`)
    .bind(handoverId)
    .all<HandoverDecisionRow>();
  return result.results;
}

/**
 * 段4が終わったか。
 *
 * **「要確認」を全部決めるまで本実行できない。** 決めていない人がいるまま
 * 進めると、その人がどちらにも入らずに消える。
 */
export async function unresolvedReviewCount(db: D1Database, id: string): Promise<number | null> {
  const handover = await getHandoverById(db, id);
  if (!handover || handover.review_count === null) return null;
  const decided = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM account_handover_decisions
        WHERE handover_id = ? AND bucket = 'review'`,
    )
    .bind(id)
    .first<{ c: number }>();
  return handover.review_count - (decided?.c ?? 0);
}

export async function markResolved(db: D1Database, id: string): Promise<void> {
  await db
    .prepare(`UPDATE account_handovers SET confirmation_revision=confirmation_revision+1, status = 'resolved', resolved_at = ? WHERE id = ? AND status NOT IN ('executing','completed','cancelled')`)
    .bind(jstNow(), id)
    .run();
}

/** 段5。本実行の始まり。 */
export async function markExecuting(db: D1Database, id: string, expectedRevision?: number): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE account_handovers SET confirmation_revision=confirmation_revision+1, status = 'executing', executed_at = ? WHERE id = ? AND status NOT IN ('executing','completed','cancelled') AND (? IS NULL OR confirmation_revision=?)`)
    .bind(jstNow(), id, expectedRevision??null, expectedRevision??null)
    .run();
  return Number(result.meta.changes) === 1;
}

/** 段5。本実行の終わりと照合。 */
export async function completeHandover(
  db: D1Database,
  id: string,
  result: { movedCount: number; failedCount: number; failureReason?: string | null },
): Promise<void> {
  const status = result.failedCount > 0 ? 'failed' : 'completed';
  await db
    .prepare(
      `UPDATE account_handovers
          SET confirmation_revision=confirmation_revision+1, moved_count = ?, failed_count = ?, failure_reason = ?, status = ?, completed_at = ?
        WHERE id = ? AND status='executing'`,
    )
    .bind(result.movedCount, result.failedCount, result.failureReason ?? null, status, jstNow(), id)
    .run();
}

export async function cancelHandover(db: D1Database, id: string, expectedRevision?: number): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE account_handovers SET confirmation_revision=confirmation_revision+1, status = 'cancelled' WHERE id = ? AND status NOT IN ('executing','completed','cancelled') AND (? IS NULL OR confirmation_revision=?)`)
    .bind(id, expectedRevision??null, expectedRevision??null)
    .run();
  return Number(result.meta.changes) === 1;
}

export async function listHandoversForAccount(
  db: D1Database,
  accountId: string,
): Promise<HandoverRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM account_handovers
        WHERE from_account_id = ? OR to_account_id = ?
        ORDER BY created_at DESC`,
    )
    .bind(accountId, accountId)
    .all<HandoverRow>();
  return result.results;
}
