import { jstNow } from '../utils.js';
import { type RecordRichMenuAssignmentInput } from './types.js';


/**
 * LINE の link / unlink が成功した後に呼び、現在値と成功履歴を同じ batch で記録する。
 * 管理画面外の rich menu が指定された場合は、以前の管理対象割当だけを現在値から
 * 外す。外部メニューを管理中の group へ推測で結び付けない。
 */
export async function recordRichMenuAssignment(
  db: D1Database,
  input: RecordRichMenuAssignmentInput,
): Promise<void> {
  const target = input.lineRichMenuId
    ? await db
      .prepare(
        `SELECT g.id AS group_id
           FROM rich_menu_pages p
           JOIN rich_menu_groups g ON g.id = p.group_id
          WHERE g.account_id = ? AND p.line_richmenu_id = ?
          LIMIT 1`,
      )
      .bind(input.lineAccountId, input.lineRichMenuId)
      .first<{ group_id: string }>()
    : null;
  const previous = await db
    .prepare(
      `SELECT id FROM rich_menu_assignments
        WHERE line_account_id = ? AND friend_id = ?`,
    )
    .bind(input.lineAccountId, input.friendId)
    .first<{ id: string }>();
  const now = input.assignedAt ?? jstNow();
  const idempotencyKey = input.idempotencyKey ?? crypto.randomUUID();
  const run = db
    .prepare(
      `INSERT INTO rich_menu_assignment_runs
         (id, version_id, friend_id, line_account_id, group_id, source_event_id,
          idempotency_key, previous_assignment_id, operation, status, attempt_count,
          next_retry_at, last_error_code, started_at, completed_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, 'succeeded', 1, NULL, NULL, ?, ?)
       ON CONFLICT(line_account_id, idempotency_key) DO NOTHING`,
    )
    .bind(
      crypto.randomUUID(),
      input.friendId,
      input.lineAccountId,
      target?.group_id ?? null,
      input.reasonEventId ?? null,
      idempotencyKey,
      previous?.id ?? null,
      input.lineRichMenuId ? 'link' : 'unlink',
      now,
      now,
    );

  const current = target && input.lineRichMenuId
    ? db
      .prepare(
        `INSERT INTO rich_menu_assignments
           (id, friend_id, line_account_id, group_id, version_id, line_richmenu_id,
            reason_kind, reason_event_id, assigned_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
         ON CONFLICT(line_account_id, friend_id) DO UPDATE SET
           group_id = excluded.group_id,
           version_id = excluded.version_id,
           line_richmenu_id = excluded.line_richmenu_id,
           reason_kind = excluded.reason_kind,
           reason_event_id = excluded.reason_event_id,
           assigned_at = excluded.assigned_at,
           updated_at = excluded.updated_at`,
      )
      .bind(
        previous?.id ?? crypto.randomUUID(),
        input.friendId,
        input.lineAccountId,
        target.group_id,
        input.lineRichMenuId,
        input.reasonKind,
        input.reasonEventId ?? null,
        now,
        now,
      )
    : db
      .prepare(
        `DELETE FROM rich_menu_assignments
          WHERE line_account_id = ? AND friend_id = ?`,
      )
      .bind(input.lineAccountId, input.friendId);

  await db.batch([run, current]);
}

/** 成功した bulk link の1チャンクを、LINE user id からまとめて台帳へ反映する。 */
export async function recordRichMenuAssignmentsByLineUserIds(
  db: D1Database,
  input: {
    lineAccountId: string;
    groupId: string;
    lineRichMenuId: string;
    lineUserIds: string[];
    reasonKind: string;
    reasonEventId?: string | null;
    idempotencyPrefix?: string;
    assignedAt?: string;
  },
): Promise<void> {
  if (input.lineUserIds.length === 0) return;
  const now = input.assignedAt ?? jstNow();
  const prefix = input.idempotencyPrefix ?? crypto.randomUUID();
  const userIdsJson = JSON.stringify(input.lineUserIds);
  const run = db
    .prepare(
      `INSERT INTO rich_menu_assignment_runs
         (id, version_id, friend_id, line_account_id, group_id, source_event_id,
          idempotency_key, previous_assignment_id, operation, status, attempt_count,
          next_retry_at, last_error_code, started_at, completed_at)
       SELECT lower(hex(randomblob(16))), NULL, f.id, ?, ?, ?,
              ? || ':' || f.id, current.id, 'link', 'succeeded', 1,
              NULL, NULL, ?, ?
         FROM friends f
         JOIN json_each(?) requested ON requested.value = f.line_platform_user_id
         LEFT JOIN rich_menu_assignments current
           ON current.line_account_id = ? AND current.friend_id = f.id
        WHERE f.line_account_id = ?
       ON CONFLICT(line_account_id, idempotency_key) DO NOTHING`,
    )
    .bind(
      input.lineAccountId,
      input.groupId,
      input.reasonEventId ?? null,
      prefix,
      now,
      now,
      userIdsJson,
      input.lineAccountId,
      input.lineAccountId,
    );
  const current = db
    .prepare(
      `INSERT INTO rich_menu_assignments
         (id, friend_id, line_account_id, group_id, version_id, line_richmenu_id,
          reason_kind, reason_event_id, assigned_at, updated_at)
       SELECT COALESCE(existing.id, lower(hex(randomblob(16)))), f.id, ?, ?, NULL, ?, ?, ?, ?, ?
         FROM friends f
         JOIN json_each(?) requested ON requested.value = f.line_platform_user_id
         LEFT JOIN rich_menu_assignments existing
           ON existing.line_account_id = ? AND existing.friend_id = f.id
        WHERE f.line_account_id = ?
       ON CONFLICT(line_account_id, friend_id) DO UPDATE SET
         group_id = excluded.group_id,
         version_id = excluded.version_id,
         line_richmenu_id = excluded.line_richmenu_id,
         reason_kind = excluded.reason_kind,
         reason_event_id = excluded.reason_event_id,
         assigned_at = excluded.assigned_at,
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.lineAccountId,
      input.groupId,
      input.lineRichMenuId,
      input.reasonKind,
      input.reasonEventId ?? null,
      now,
      now,
      userIdsJson,
      input.lineAccountId,
      input.lineAccountId,
    );
  await db.batch([run, current]);
}

/** LINE 側から group を取り下げた後、表示中ではなくなった現在値を残さない。 */
export async function clearRichMenuAssignmentsForGroup(
  db: D1Database,
  groupId: string,
): Promise<void> {
  await db
    .prepare(`DELETE FROM rich_menu_assignments WHERE group_id = ?`)
    .bind(groupId)
    .run();
}
