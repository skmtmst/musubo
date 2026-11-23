import { jstNow } from './utils.js';
import { DEFAULT_TENANT_ID } from '@line-crm/shared';
import { type LineAccountLifecycleErrorCode, type LineAccount, type LineAccountArchiveBlocker, type LineAccountInactiveReason } from './line-accounts-types.js';
import { getLineAccountById } from './line-accounts-reads.js';
import { queueDeletedMeetingConnections,queueDeletedGoogleCalendars } from './booking-meeting-deletion-queue.js';


export class LineAccountLifecycleError extends Error {
  constructor(public readonly code: LineAccountLifecycleErrorCode) {
    super(code);
    this.name = 'LineAccountLifecycleError';
  }
}

export async function requireWritableLineAccount(db: D1Database, id: string): Promise<LineAccount | null> {
  const account = await getLineAccountById(db, id);
  if (account?.archived_at) throw new LineAccountLifecycleError('ACCOUNT_ARCHIVED');
  return account;
}

/** Returns every reason that currently prevents an account from being archived. */
export async function getLineAccountArchiveBlockers(
  db: D1Database,
  id: string,
): Promise<LineAccountArchiveBlocker[]> {
  const account = await db
    .prepare(`SELECT is_active, is_default FROM line_accounts WHERE id = ?`)
    .bind(id)
    .first<{ is_active: number; is_default: number }>();
  if (!account) return [];

  const [delivery, pool] = await Promise.all([
    db
      .prepare(
        `SELECT 1 AS found
           FROM broadcasts
          WHERE status IN ('scheduled', 'sending')
            AND (
              line_account_id = ?
              OR EXISTS (
                SELECT 1 FROM json_each(
                  CASE WHEN json_valid(broadcasts.account_ids) THEN broadcasts.account_ids ELSE '[]' END
                )
                WHERE CAST(value AS TEXT) = ?
              )
            )
          LIMIT 1`,
      )
      .bind(id, id)
      .first<{ found: number }>(),
    db
      .prepare(
        `SELECT 1 AS found FROM traffic_pools WHERE active_account_id = ?
         UNION ALL
         SELECT 1 AS found FROM pool_accounts WHERE line_account_id = ?
         LIMIT 1`,
      )
      .bind(id, id)
      .first<{ found: number }>(),
  ]);

  const blockers: LineAccountArchiveBlocker[] = [];
  if (account.is_active) blockers.push('account_active');
  if (account.is_default) blockers.push('default_account');
  if (delivery) blockers.push('delivery_job_running');
  if (pool) blockers.push('traffic_pool_member');
  return blockers;
}

/** Switches the single organization default atomically. */
export async function setDefaultLineAccount(
  db: D1Database,
  id: string,
  expectedTenantId?: string,
): Promise<LineAccount | null> {
  const account = await getLineAccountById(db, id);
  if (!account) return null;
  if (account.archived_at) throw new LineAccountLifecycleError('ACCOUNT_ARCHIVED');
  if (!account.is_active) throw new LineAccountLifecycleError('ACCOUNT_INACTIVE');
  const tenantId = account.tenant_id ?? DEFAULT_TENANT_ID;
  if (expectedTenantId && tenantId !== expectedTenantId) return null;
  const now = jstNow();
  await db.batch([
    db
      .prepare(
        `UPDATE line_accounts
            SET is_default = 0, updated_at = ?
          WHERE tenant_id = ? AND is_default = 1 AND id != ?`,
      )
      .bind(now, tenantId, id),
    db
      .prepare(
        `UPDATE line_accounts
            SET is_default = 1, updated_at = ?
          WHERE id = ? AND tenant_id = ? AND archived_at IS NULL AND is_active = 1`,
      )
      .bind(now, id, tenantId),
  ]);
  return getLineAccountById(db, id);
}

/** Retires an account without removing any historical records. */
export async function archiveLineAccount(
  db: D1Database,
  id: string,
  archivedBy: string,
  reason: string,
): Promise<LineAccount | null> {
  const account = await getLineAccountById(db, id);
  if (!account) return null;
  if (account.archived_at) throw new LineAccountLifecycleError('ACCOUNT_ARCHIVED');
  const blockers = await getLineAccountArchiveBlockers(db, id);
  if (blockers.includes('account_active')) throw new LineAccountLifecycleError('ACCOUNT_ACTIVE');
  if (blockers.includes('default_account')) throw new LineAccountLifecycleError('ACCOUNT_DEFAULT');
  if (blockers.includes('delivery_job_running')) {
    throw new LineAccountLifecycleError('ACCOUNT_HAS_ACTIVE_DELIVERY');
  }
  if (blockers.includes('traffic_pool_member')) {
    throw new LineAccountLifecycleError('ACCOUNT_IN_TRAFFIC_POOL');
  }
  const now = jstNow();
  await db.batch([
    queueDeletedMeetingConnections(db,{whereSql:"c.line_account_id=? AND EXISTS(SELECT 1 FROM line_accounts x WHERE x.id=c.line_account_id AND x.archived_at IS NULL)",params:[id],source:'account'}),
    queueDeletedGoogleCalendars(db,{whereSql:"c.line_account_id=? AND EXISTS(SELECT 1 FROM line_accounts x WHERE x.id=c.line_account_id AND x.archived_at IS NULL)",params:[id],source:'account'}),
    db.prepare('UPDATE google_calendar_connections SET is_active=0,access_token=NULL,refresh_token=NULL,api_key=NULL WHERE line_account_id=? AND EXISTS(SELECT 1 FROM line_accounts WHERE id=? AND archived_at IS NULL)').bind(id,id),
    db.prepare('DELETE FROM booking_meeting_oauth_states WHERE line_account_id=? AND EXISTS(SELECT 1 FROM line_accounts WHERE id=? AND archived_at IS NULL)').bind(id,id),
    db.prepare('DELETE FROM booking_meeting_connections WHERE line_account_id=? AND EXISTS(SELECT 1 FROM line_accounts WHERE id=? AND archived_at IS NULL)').bind(id,id),
    db.prepare(
      `UPDATE line_accounts
          SET is_active = 0, is_default = 0,
              archived_at = ?, archived_by = ?, archived_reason = ?, updated_at = ?
        WHERE id = ? AND archived_at IS NULL`,
    )
    .bind(now, archivedBy, reason, now, id),
  ]);
  return getLineAccountById(db, id);
}

/** Restores an archived account in the stopped state. */
export async function restoreLineAccount(
  db: D1Database,
  id: string,
): Promise<LineAccount | null> {
  const account = await getLineAccountById(db, id);
  if (!account) return null;
  if (!account.archived_at) throw new LineAccountLifecycleError('ACCOUNT_NOT_ARCHIVED');
  const now = jstNow();
  await db
    .prepare(
      `UPDATE line_accounts
          SET is_active = 0, is_default = 0,
              archived_at = NULL, archived_by = NULL, archived_reason = NULL,
              updated_at = ?
        WHERE id = ? AND archived_at IS NOT NULL`,
    )
    .bind(now, id)
    .run();
  return getLineAccountById(db, id);
}
export const LINE_ACCOUNT_INACTIVE_REASONS: readonly LineAccountInactiveReason[] = [
  'manual',
  'ban_detected',
  'credential_invalid',
];

/**
 * 送受信を止める。理由は必須（-33 §10-1）。
 * `reason` は区分、`detail` は運用者の自由記述。
 */
export async function deactivateLineAccount(
  db: D1Database,
  id: string,
  input: { reason: LineAccountInactiveReason; detail: string },
): Promise<LineAccount | null> {
  const current = await requireWritableLineAccount(db, id);
  if (!current) return null;
  if (current.is_default) throw new LineAccountLifecycleError('ACCOUNT_DEFAULT');
  const now = jstNow();
  await db
    .prepare(
      `UPDATE line_accounts
          SET is_active = 0, inactive_reason = ?, inactive_reason_detail = ?,
              inactivated_at = ?, updated_at = ?
        WHERE id = ?`,
    )
    .bind(input.reason, input.detail, now, now, id)
    .run();
  return getLineAccountById(db, id);
}

/** 送受信を再開する。止めた理由の記録は消す（-33 §10-2）。 */
export async function activateLineAccount(
  db: D1Database,
  id: string,
): Promise<LineAccount | null> {
  const current = await requireWritableLineAccount(db, id);
  if (!current) return null;
  const now = jstNow();
  await db
    .prepare(
      `UPDATE line_accounts
          SET is_active = 1, inactive_reason = NULL, inactive_reason_detail = NULL,
              inactivated_at = NULL, updated_at = ?
        WHERE id = ?`,
    )
    .bind(now, id)
    .run();
  return getLineAccountById(db, id);
}
