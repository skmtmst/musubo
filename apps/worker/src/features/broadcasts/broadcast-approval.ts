import { DELIVERY_CONSENT_ALLOWED_SQL } from '@line-crm/db/src/friend-delivery-consents.js';
import { countLimitedAudience, storedDeliveryLimit, limitedDeliveryPlan } from './broadcast-delivery-limit.js';
import { logger } from '@line-crm/shared/server';
import { sqlIdSet } from '@line-crm/db/id-queries';
import { BROADCAST_APPROVE_KEY } from '@line-crm/shared';
import { createNotification, type Broadcast } from '@line-crm/db';

import type { AuthenticatedStaff } from '../../middleware/auth/principal/auth.js';
import { previewAudience, type PreflightInput } from './broadcast-preflight.js';
import { computeDedupBroadcastPreview } from '../../services/dedup-broadcast.js';

/**
 * 一斉配信の二者承認（m12a / -06 §6）。
 *
 * 1,000通以上（機能設定で変更可）の即時・予約送信は、送る人とは別の
 * 承認する人の確認が要る。運用者が1人しかいない組織では、送る本人が
 * 宛先の人数を手入力して突き合わせることで代える。
 */

export const BROADCAST_APPROVAL_THRESHOLD_DEFAULT = 1000;
export const BROADCAST_APPROVAL_THRESHOLD_KEY = 'broadcast_approval_threshold';
const BROADCAST_APPROVAL_THRESHOLD_MIN = 1;
const BROADCAST_APPROVAL_THRESHOLD_MAX = 1000000;

export type BroadcastApprovalStatus =
  | 'none'
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'expired';

export function readApprovalStatus(broadcast: Broadcast): BroadcastApprovalStatus {
  const raw = (broadcast as unknown as Record<string, unknown>).approval_status;
  return raw === 'pending' || raw === 'approved' || raw === 'rejected'
    || raw === 'cancelled' || raw === 'expired'
    ? raw
    : 'none';
}

function broadcastAccountIds(broadcast: Broadcast): Array<string | null> {
  const raw = broadcast as unknown as Record<string, unknown>;
  const lineAccountId = (raw.line_account_id as string | null | undefined) ?? null;
  if (broadcast.target_type === 'multi-account-dedup') {
    try {
      const parsed = raw.account_ids == null ? null : JSON.parse(String(raw.account_ids));
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.filter((id): id is string => typeof id === 'string');
      }
    } catch { /* 壊れた値は単一アカウント扱いに落とす */ }
    return [lineAccountId];
  }
  return [lineAccountId];
}

/**
 * 承認が要る人数の境目（機能設定の値。既定 1000）。
 * アカウントごとに入れられる。複数アカウントの配信は厳しいほう（小さい値）を使う。
 */
export async function getBroadcastApprovalThreshold(
  db: D1Database,
  broadcast: Broadcast,
): Promise<number> {
  const accountIds = broadcastAccountIds(broadcast).filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  );
  if (accountIds.length === 0) return BROADCAST_APPROVAL_THRESHOLD_DEFAULT;
  try {
    const rows = await db.prepare(
      `SELECT value FROM account_settings WHERE key = ? AND line_account_id IN (${sqlIdSet(accountIds).sql})`,
    ).bind(BROADCAST_APPROVAL_THRESHOLD_KEY, ...(accountIds.length ? sqlIdSet(accountIds).binds : []))
      .all<{ value: string }>();
    const values = (rows.results ?? [])
      .map((row) => Number(row.value))
      .filter((n) => Number.isInteger(n)
        && n >= BROADCAST_APPROVAL_THRESHOLD_MIN
        && n <= BROADCAST_APPROVAL_THRESHOLD_MAX);
    return values.length > 0 ? Math.min(...values) : BROADCAST_APPROVAL_THRESHOLD_DEFAULT;
  } catch {
    return BROADCAST_APPROVAL_THRESHOLD_DEFAULT;
  }
}

export async function setBroadcastApprovalThreshold(
  db: D1Database,
  lineAccountId: string,
  value: unknown,
): Promise<{ ok: true; threshold: number } | { ok: false; error: string }> {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n)
    || n < BROADCAST_APPROVAL_THRESHOLD_MIN || n > BROADCAST_APPROVAL_THRESHOLD_MAX) {
    return {
      ok: false,
      error: `承認が必要な通数は${BROADCAST_APPROVAL_THRESHOLD_MIN}〜${BROADCAST_APPROVAL_THRESHOLD_MAX}の整数で入れてください`,
    };
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO account_settings (id, line_account_id, key, value, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (line_account_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(id, lineAccountId, BROADCAST_APPROVAL_THRESHOLD_KEY, String(n), now, now).run();
  return { ok: true, threshold: n };
}

/** 有効な運用者の人数。招待中・無効化した人は数えない。 */
export async function countActiveOperators(db: D1Database): Promise<number> {
  try {
    const row = await db.prepare(
      `SELECT COUNT(*) AS total FROM staff_members WHERE is_active = 1 AND invite_status = 'active'`,
    ).first<{ total: number }>();
    return Number(row?.total ?? 0);
  } catch {
    return 0;
  }
}

/** 承認する側に回れる人。owner・admin は既定で持つ。staff は個別の鍵が要る。 */
export function canApproveBroadcast(staff: AuthenticatedStaff | undefined): boolean {
  if (!staff) return false;
  if (staff.role === 'owner' || staff.role === 'admin') return true;
  return staff.permissionKeys?.includes(BROADCAST_APPROVE_KEY) === true;
}

/**
 * 送信時点の宛先数。送る直前の人数で判定する（予約時の目安ではない）。
 * 数え方は配信前チェック（preflight）と同じ。重複除外の配信は
 * 有効なアカウントのぶんだけ数える。
 */
export async function countApprovalRecipients(
  db: D1Database,
  broadcast: Broadcast,
): Promise<number> {
  if (broadcast.correction_of_broadcast_id) {
    const row = await db.prepare(`SELECT COUNT(*) n FROM broadcast_send_claims c JOIN friends f ON f.id=c.friend_id
      WHERE c.broadcast_id=? AND f.line_account_id=? AND f.is_following=1 AND COALESCE(f.is_hidden,0)=0
      AND trim(COALESCE(f.line_user_id,''))!='' AND (${DELIVERY_CONSENT_ALLOWED_SQL})`).bind(broadcast.id, broadcast.line_account_id).first<{ n: number }>();
    return Number(row?.n ?? 0);
  }
  if (storedDeliveryLimit(broadcast)) return (await countLimitedAudience(db,broadcast)).candidateCount;
  const raw = broadcast as unknown as Record<string, unknown>;
  if (broadcast.target_type === 'multi-account-dedup') {
    let accountIds: string[] = [];
    try {
      const parsed = raw.account_ids == null ? null : JSON.parse(String(raw.account_ids));
      if (Array.isArray(parsed)) accountIds = parsed.filter((id): id is string => typeof id === 'string');
    } catch { accountIds = []; }
    let priority: string[] = [];
    try {
      const parsed = raw.dedup_priority == null ? null : JSON.parse(String(raw.dedup_priority));
      if (Array.isArray(parsed)) priority = parsed.filter((id): id is string => typeof id === 'string');
    } catch { priority = []; }
    const preview = await computeDedupBroadcastPreview(
      db, accountIds, priority, broadcast.target_tag_id ?? null,
    );
    const { getLineAccountById } = await import('@line-crm/db');
    let total = 0;
    for (const entry of preview.perAccount) {
      const account = await getLineAccountById(db, entry.accountId);
      if (account && account.is_active) total += entry.recipients.length;
    }
    return total;
  }
  let segmentConditions: PreflightInput['segmentConditions'] = null;
  if (broadcast.target_type === 'segment' && typeof raw.segment_conditions === 'string' && raw.segment_conditions) {
    try {
      segmentConditions = JSON.parse(raw.segment_conditions) as PreflightInput['segmentConditions'];
    } catch { segmentConditions = null; }
  }
  const preview = await previewAudience(db, {
    targetType: broadcast.target_type,
    targetTagId: broadcast.target_tag_id ?? null,
    lineAccountId: (raw.line_account_id as string | null | undefined) ?? null,
    segmentConditions,
  });
  return preview.sendable;
}

export interface ApprovalGate {
  recipientCount: number;
  threshold: number;
  /** 承認フロー（二者承認）が要る人数に達している */
  required: boolean;
  /** 有効な運用者が1人だけ（人数の手入力で代える） */
  singleOperator: boolean;
  operatorCount: number;
}

/** 送る直前の判定。人数・境目・1人運用をまとめて返す。 */
export async function evaluateApprovalGate(
  db: D1Database,
  broadcast: Broadcast,
): Promise<ApprovalGate> {
  const context=await db.prepare('SELECT execution_mode,created_via FROM broadcast_execution_contexts WHERE broadcast_id=?').bind(broadcast.id).first<{execution_mode:string;created_via:string}>();
  const simulation=context?.execution_mode==='simulation';
  const [recipientCount, threshold, operatorCount] = await Promise.all([
    simulation?import('./simulation-preview.js').then(m=>m.simulationPreview(db,broadcast.id)).then(p=>p.recipients):countApprovalRecipients(db, broadcast),
    getBroadcastApprovalThreshold(db, broadcast),
    countActiveOperators(db),
  ]);
  return {
    recipientCount,
    threshold,
    required: simulation&&context.created_via==='mcp'||recipientCount >= threshold,
    // 数えられなかったとき（0人）は1人運用扱いにしない。二者承認も要らない。
    singleOperator: !(simulation&&context.created_via==='mcp')&&operatorCount <= 1,
    operatorCount,
  };
}

function primaryAccountId(broadcast: Broadcast): string | null {
  const ids = broadcastAccountIds(broadcast);
  return ids.find((id): id is string => typeof id === 'string' && id.length > 0) ?? null;
}

/** 承認する人・頼んだ人への管理画面のお知らせ（既存の通知の仕組み）。 */
export async function notifyBroadcastApproval(
  db: D1Database,
  broadcast: Broadcast,
  eventType: string,
  title: string,
  body: string,
): Promise<void> {
  try {
    await createNotification(db, {
      eventType,
      title,
      body,
      channel: 'dashboard',
      category: 'update',
      lineAccountId: primaryAccountId(broadcast),
      metadata: JSON.stringify({ broadcastId: broadcast.id, action: eventType }),
    });
  } catch (err) {
    logger.error("services_broadcast_approval_failed");
  }
}

/** 承認の履歴に1行残す。監査の記録なので更新・削除しない。 */
export async function recordBroadcastApprovalEvent(
  db: D1Database,
  broadcastId: string,
  actorStaffId: string,
  action: 'requested' | 'approved' | 'rejected' | 'cancelled' | 'expired' | 'reminded',
  reason: string | null = null,
): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO broadcast_approval_events (id, broadcast_id, actor_staff_id, action, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), broadcastId, actorStaffId, action, reason, now).run();
}

/**
 * 予約時刻を過ぎても承認されなかった依頼を「期限切れ」にする。
 * 送らない（status は scheduled のまま残し、承認の軸だけ expired にする）。
 * 条件付き更新で、承認済みになった行には触らない。
 */
export async function expireOverdueBroadcastApprovals(
  db: D1Database,
  nowMs: number,
): Promise<string[]> {
  const rows = await db.prepare(
    `SELECT id, scheduled_at FROM broadcasts
      WHERE approval_status = 'pending' AND status = 'scheduled' AND scheduled_at IS NOT NULL`,
  ).all<{ id: string; scheduled_at: string }>();
  const expired: string[] = [];
  for (const row of (rows.results ?? [])) {
    const due = new Date(row.scheduled_at).getTime();
    if (!Number.isFinite(due) || due > nowMs) continue;
    const result = await db.prepare(
      `UPDATE broadcasts SET approval_status = 'expired'
        WHERE id = ? AND approval_status = 'pending' AND status = 'scheduled'`,
    ).bind(row.id).run();
    if (result.meta.changes) {
      expired.push(row.id);
      await recordBroadcastApprovalEvent(db, row.id, '', 'expired');
    }
  }
  return expired;
}

/**
 * 期限切れの走査。予約の取り込み（cron）が呼ぶ。
 * 依頼主に「送らなかった」ことを知らせる。
 */
export async function sweepBroadcastApprovalExpiry(db: D1Database, nowMs: number): Promise<void> {
  let expired: string[] = [];
  try {
    expired = await expireOverdueBroadcastApprovals(db, nowMs);
  } catch (err) {
    logger.error("services_broadcast_approval_failed");
    return;
  }
  const { getBroadcastById } = await import('@line-crm/db');
  for (const id of expired) {
    try {
      const broadcast = await getBroadcastById(db, id);
      if (!broadcast) continue;
      await notifyBroadcastApproval(
        db, broadcast, 'broadcast.approval.expired',
        `期限切れ：「${broadcast.title}」`,
        '承認されないまま予約の時刻を過ぎたため、送らずに期限切れにしました。送るには作り直してください。',
      );
    } catch (err) {
      logger.error("services_broadcast_approval_failed");
    }
  }
}

/** 送る直前の承認ゲート。即時送信の口と cron が使う。 */
export async function enforceBroadcastSendApproval(
  db: D1Database,
  broadcast: Broadcast,
  options?: { confirmedRecipientCount?: unknown },
): Promise<
  | { allowed: true; gate: ApprovalGate }
  | { allowed: false; status: number; error: string; code: string; recipientCount?: number; threshold?: number }
> {
  const gate = await evaluateApprovalGate(db, broadcast);
  const limited = await limitedDeliveryPlan(db, broadcast, {requireConfirmation:false});
  const confirmedRecipients = limited?.recipientCount ?? gate.recipientCount;
  if (!gate.required) return { allowed: true, gate };
  if (gate.singleOperator) {
    const confirmed = typeof options?.confirmedRecipientCount === 'string'
      && options.confirmedRecipientCount.trim() !== ''
      ? Number(options.confirmedRecipientCount)
      : options?.confirmedRecipientCount;
    if (typeof confirmed !== 'number' || !Number.isInteger(confirmed) || confirmed !== confirmedRecipients) {
      return {
        allowed: false,
        status: 409,
        error: `送る相手は${confirmedRecipients.toLocaleString('ja-JP')}人です。人数を入れて一致させてください。`,
        code: 'COUNT_MISMATCH',
        recipientCount: gate.recipientCount,
        threshold: gate.threshold,
      };
    }
    // 確認した人数を残す。予約の時刻に数が変わっていたら送らず期限切れにする。
    const saved = await db.prepare(`UPDATE broadcasts SET approval_confirmed_count = ? WHERE id = ? AND lock_version = ? AND status IN ('draft','scheduled')`)
      .bind(confirmed, broadcast.id, broadcast.lock_version ?? 1).run();
    if (!saved.meta.changes) return { allowed: false, status: 409, error: '本文または宛先が変わりました。もう一度確かめてください。', code: 'VERSION_CONFLICT' };
    return { allowed: true, gate };
  }
  if (readApprovalStatus(broadcast) !== 'approved') {
    return {
      allowed: false,
      status: 409,
      error: `${gate.threshold.toLocaleString('ja-JP')}通以上の配信は、別の人の承認が要ります。承認を依頼してください。`,
      code: 'APPROVAL_REQUIRED',
      recipientCount: gate.recipientCount,
      threshold: gate.threshold,
    };
  }
  return { allowed: true, gate };
}

/**
 * cron が予約を取り込む直前の判定。承認が要る人数なのに承認済みでなければ
 * 送らない。人数の確認がずれた1人運用の予約は、その場で期限切れにする。
 */
export async function checkScheduledBroadcastApproval(
  db: D1Database,
  broadcast: Broadcast,
): Promise<{ sendable: boolean; expiredNow?: boolean }> {
  const gate = await evaluateApprovalGate(db, broadcast);
  if (!gate.required) return { sendable: true };
  const fresh = await db.prepare(
    `SELECT approval_status, approval_confirmed_count, lock_version FROM broadcasts WHERE id = ?`,
  ).bind(broadcast.id).first<{ approval_status: string | null; approval_confirmed_count: number | null; lock_version: number }>();
  if (!fresh || fresh.lock_version !== (broadcast.lock_version ?? 1)) return { sendable: false };
  const status = (fresh?.approval_status ?? 'none') as ReturnType<typeof readApprovalStatus>;
  if (gate.singleOperator) {
    const limited = await limitedDeliveryPlan(db,broadcast);
    if (limited ? limited.recipientCount <= Number(fresh.approval_confirmed_count) : broadcast.correction_of_broadcast_id ? gate.recipientCount > 0 && gate.recipientCount <= Number(fresh.approval_confirmed_count) : Number(fresh.approval_confirmed_count) === gate.recipientCount) return { sendable: true };
    // 人数が変わったまま時刻が来た。送らず期限切れにし、依頼主に知らせる。
    const claimed = await db.prepare(
      `UPDATE broadcasts SET approval_status = 'expired'
        WHERE id = ? AND status = 'scheduled' AND approval_status != 'approved' AND lock_version = ?`,
    ).bind(broadcast.id, broadcast.lock_version ?? 1).run();
    if (claimed.meta.changes) {
      await recordBroadcastApprovalEvent(db, broadcast.id, '', 'expired');
      const { getBroadcastById } = await import('@line-crm/db');
      const current = await getBroadcastById(db, broadcast.id);
      if (current) {
        await notifyBroadcastApproval(
          db, current, 'broadcast.approval.expired',
          `期限切れ：「${current.title}」`,
          `送る相手が${gate.recipientCount.toLocaleString('ja-JP')}人に変わっていたため、確認した人数と合わず送りませんでした。送るには作り直してください。`,
        );
      }
      return { sendable: false, expiredNow: true };
    }
    return { sendable: false };
  }
  // 期限切れの走査は取り込みの直前に済ませてある。承認済みだけ送る。
  return status === 'approved' ? { sendable: true } : { sendable: false };
}
