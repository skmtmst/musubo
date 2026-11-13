import { logger } from '@line-crm/shared/server';
import type { WebhookCreateState } from '@line-crm/shared';
import { readFolderAssignment } from './folder-assignment.js';
import { jstNow } from './utils.js';
import { type OutgoingWebhookRow, type WebhookKeyInput } from './webhooks-types.js';
import { encryptWebhookSecret } from './webhooks-secrets.js';


// --- 送信Webhook ---
export async function getOutgoingWebhooks(
  db: D1Database,
  lineAccountId: string,
): Promise<OutgoingWebhookRow[]> {
  const result = await db
    .prepare(`SELECT * FROM outgoing_webhooks WHERE line_account_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`)
    .bind(lineAccountId)
    .all<OutgoingWebhookRow>();
  return result.results;
}

export async function getOutgoingWebhookById(
  db: D1Database,
  id: string,
  lineAccountId: string,
): Promise<OutgoingWebhookRow | null> {
  return db
    .prepare(`SELECT * FROM outgoing_webhooks WHERE id = ? AND line_account_id = ? AND deleted_at IS NULL`)
    .bind(id, lineAccountId)
    .first<OutgoingWebhookRow>();
}

export async function createOutgoingWebhook(
  db: D1Database,
  input: { name: string; url: string; eventTypes: string[]; secret?: string; maxRetries?: number; lineAccountId: string; folderId?: unknown } & WebhookCreateState,
  keys?: WebhookKeyInput | string,
): Promise<OutgoingWebhookRow> {
  const folderId = await readFolderAssignment(db, 'webhook', input.lineAccountId, input.folderId);
  const id = crypto.randomUUID();
  const now = jstNow();
  // secret があるときは暗号化して保存し、平文は残さない。鍵がなければ例外にする。
  const encrypted = input.secret === undefined
    ? null
    : await encryptWebhookSecret(input.secret, keys);
  await db
    .prepare(`INSERT INTO outgoing_webhooks (id, name, url, event_types, secret, secret_encrypted, max_retries, line_account_id, created_at, updated_at, folder_id, is_active) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, input.name, input.url, JSON.stringify(input.eventTypes), encrypted, input.maxRetries ?? 0, input.lineAccountId, now, now, folderId ?? null, input.isActive === false ? 0 : 1)
    .run();
  return (await getOutgoingWebhookById(db, id, input.lineAccountId))!;
}

export async function updateOutgoingWebhook(
  db: D1Database,
  id: string,
  lineAccountId: string,
  updates: Partial<{
    name: string;
    url: string;
    eventTypes: string[];
    secret: string;
    isActive: boolean;
    maxRetries: number;
    folderId: unknown;
  }>,
  keys?: WebhookKeyInput | string,
  options: { expectedVersion?: number; expectedConfirmationRevision?: number; updatedByStaffId?: string } = {},
): Promise<boolean> {
  const folderId = await readFolderAssignment(db, 'webhook', lineAccountId, updates.folderId);
  const sets: string[] = [];
  const values: unknown[] = [];
  if (folderId !== undefined) { sets.push('folder_id = ?'); values.push(folderId); }
  if (updates.name !== undefined) { sets.push('name = ?'); values.push(updates.name); }
  if (updates.url !== undefined) { sets.push('url = ?'); values.push(updates.url); }
  if (updates.eventTypes !== undefined) { sets.push('event_types = ?'); values.push(JSON.stringify(updates.eventTypes)); }
  if (updates.secret !== undefined) {
    // 入れ直しは暗号化して保存し、旧平文を消す。鍵がなければ例外にする。
    sets.push('secret_encrypted = ?');
    values.push(await encryptWebhookSecret(updates.secret, keys));
    sets.push('secret = NULL');
  }
  if (updates.isActive !== undefined) {
    sets.push('is_active = ?');
    values.push(updates.isActive ? 1 : 0);
    // 再有効化は「自動停止の記録」を消す。止まった事実は連続失敗数と
    // 通知センターの履歴に残る。
    if (updates.isActive) sets.push('auto_stopped_at = NULL');
  }
  if (updates.maxRetries !== undefined) { sets.push('max_retries = ?'); values.push(updates.maxRetries); }
  if (sets.length === 0) {
    const current = await getOutgoingWebhookById(db, id, lineAccountId);
    return Boolean(current && (options.expectedVersion === undefined || current.version === options.expectedVersion) && (options.expectedConfirmationRevision === undefined || current.confirmation_revision === options.expectedConfirmationRevision));
  }
  sets.push('version = version + 1', 'confirmation_revision = confirmation_revision + 1', 'updated_by_staff_id = ?');
  values.push(options.updatedByStaffId ?? null);
  sets.push('updated_at = ?');
  values.push(jstNow());
  values.push(id);
  values.push(lineAccountId);
  const versionClause = options.expectedVersion === undefined ? '' : ' AND version = ?';
  if (options.expectedVersion !== undefined) values.push(options.expectedVersion);
  if (options.expectedConfirmationRevision !== undefined) values.push(options.expectedConfirmationRevision);
  const result = await db.prepare(`UPDATE outgoing_webhooks SET ${sets.join(', ')} WHERE id = ? AND line_account_id = ? AND deleted_at IS NULL${versionClause}${options.expectedConfirmationRevision === undefined ? '' : ' AND confirmation_revision = ?'}`)
    .bind(...values).run();
  return (result.meta.changes ?? 0) > 0;
}

/** 受信側と同じく、削除は履歴を残す印。返り値は印を付けられたか。 */
export async function deleteOutgoingWebhook(
  db: D1Database,
  id: string,
  lineAccountId: string,
  deletedByStaffId?: string,
  expectedVersion?: number,
  expectedConfirmationRevision?: number,
): Promise<boolean> {
  const result = await db.prepare(`UPDATE outgoing_webhooks
    SET deleted_at = ?, deleted_by_staff_id = ?, is_active = 0, updated_at = ?, confirmation_revision = confirmation_revision + 1
    WHERE id = ? AND line_account_id = ? AND deleted_at IS NULL AND (? IS NULL OR version = ?) AND (? IS NULL OR confirmation_revision = ?)`)
    .bind(jstNow(), deletedByStaffId ?? null, jstNow(), id, lineAccountId, expectedVersion ?? null, expectedVersion ?? null, expectedConfirmationRevision ?? null, expectedConfirmationRevision ?? null).run();
  return (result.meta.changes ?? 0) > 0;
}

/*
 * 送信Webhookの削除の取り消し（B 元に戻す）。deleted_at を空に戻すだけ。
 * 戻した直後は止めたまま（is_active = 0）。戻した瞬間に外へ送り出さない。
 */
export async function restoreOutgoingWebhook(
  db: D1Database,
  id: string,
  lineAccountId: string,
): Promise<boolean> {
  const result = await db.prepare(`UPDATE outgoing_webhooks
    SET deleted_at = NULL, deleted_by_staff_id = NULL, is_active = 0, updated_at = ?, confirmation_revision = confirmation_revision + 1
    WHERE id = ? AND line_account_id = ? AND deleted_at IS NOT NULL`)
    .bind(jstNow(), id, lineAccountId).run();
  return (result.meta.changes ?? 0) > 0;
}

/** 指定イベントタイプに一致するアクティブな送信Webhookを取得 */
export async function getActiveOutgoingWebhooksByEvent(
  db: D1Database,
  eventType: string,
  lineAccountId?: string | null,
): Promise<OutgoingWebhookRow[]> {
  if (!lineAccountId) return [];
  const all = await db
    .prepare(`
      SELECT *
      FROM outgoing_webhooks
      WHERE is_active = 1 AND line_account_id = ? AND deleted_at IS NULL
    `)
    .bind(lineAccountId)
    .all<OutgoingWebhookRow>();
  // event_types が壊れた1行で配送全体を止めない。壊れた行だけを
  // 構造化ログで記録して除外し、健全な行への配送は継続する。
  const matched: OutgoingWebhookRow[] = [];
  for (const w of all.results) {
    let types: unknown;
    try {
      types = JSON.parse(w.event_types);
    } catch {
      logger.error("outgoing_webhook_event_types_broken");
      continue;
    }
    if (!Array.isArray(types)) {
      logger.error("outgoing_webhook_event_types_broken");
      continue;
    }
    if (types.includes(eventType) || types.includes('*')) matched.push(w);
  }
  return matched;
}
