import type { WebhookCreateState } from '@line-crm/shared';
import { readFolderAssignment } from './folder-assignment.js';
import { jstNow } from './utils.js';
import { type IncomingWebhookRow, type IncomingWebhookIdentityMatch, type IncomingWebhookActionRef, type WebhookKeyInput } from './webhooks-types.js';
import { encryptWebhookSecret, resolveWebhookSecret } from './webhooks-secrets.js';


// --- 受信Webhook ---

export async function getIncomingWebhooks(
  db: D1Database,
  lineAccountId: string,
): Promise<IncomingWebhookRow[]> {
  const result = await db
    .prepare(`SELECT * FROM incoming_webhooks WHERE line_account_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`)
    .bind(lineAccountId)
    .all<IncomingWebhookRow>();
  return result.results;
}

export async function getIncomingWebhookById(
  db: D1Database,
  id: string,
  lineAccountId?: string,
): Promise<IncomingWebhookRow | null> {
  if (lineAccountId === undefined) {
    return db.prepare(`SELECT * FROM incoming_webhooks WHERE id = ? AND deleted_at IS NULL`).bind(id).first<IncomingWebhookRow>();
  }
  return db
    .prepare(`SELECT * FROM incoming_webhooks WHERE id = ? AND line_account_id = ? AND deleted_at IS NULL`)
    .bind(id, lineAccountId)
    .first<IncomingWebhookRow>();
}

export async function updateIncomingWebhookConfig(
  db: D1Database,
  input: {
    id: string;
    lineAccountId: string;
    expectedVersion: number;
    identityMatching: IncomingWebhookIdentityMatch;
    actions: IncomingWebhookActionRef[];
  },
): Promise<
  | { status: 'updated'; item: IncomingWebhookRow }
  | { status: 'conflict'; currentVersion: number }
  | { status: 'not_found' }
> {
  const result = await db.prepare(`UPDATE incoming_webhooks
    SET identity_match_json = ?, action_refs_json = ?, version = version + 1, updated_at = ?, confirmation_revision = confirmation_revision + 1
    WHERE id = ? AND line_account_id = ? AND version = ? AND deleted_at IS NULL`)
    .bind(
      JSON.stringify(input.identityMatching),
      JSON.stringify(input.actions),
      jstNow(),
      input.id,
      input.lineAccountId,
      input.expectedVersion,
    )
    .run();
  if ((result.meta.changes ?? 0) > 0) {
    return {
      status: 'updated',
      item: (await getIncomingWebhookById(db, input.id, input.lineAccountId))!,
    };
  }
  const current = await getIncomingWebhookById(db, input.id, input.lineAccountId);
  return current
    ? { status: 'conflict', currentVersion: Number(current.version) }
    : { status: 'not_found' };
}

export async function updateIncomingWebhookMaskedSample(
  db: D1Database,
  id: string,
  lineAccountId: string,
  maskedSample: unknown,
  receivedAt = jstNow(),
): Promise<void> {
  await db.prepare(`UPDATE incoming_webhooks
    SET latest_masked_sample_json = ?, latest_received_at = ?, confirmation_revision = confirmation_revision + 1
    WHERE id = ? AND line_account_id = ? AND deleted_at IS NULL`)
    .bind(JSON.stringify(maskedSample), receivedAt, id, lineAccountId)
    .run();
}

export async function createIncomingWebhook(
  db: D1Database,
  input: { name: string; sourceType?: string; secret?: string; lineAccountId: string; folderId?: unknown } & WebhookCreateState,
  keys?: WebhookKeyInput | string,
): Promise<IncomingWebhookRow> {
  const folderId = await readFolderAssignment(db, 'webhook', input.lineAccountId, input.folderId);
  const id = crypto.randomUUID();
  const now = jstNow();
  // secret があるときは暗号化して保存し、平文は残さない。鍵がなければ例外にする。
  const encrypted = input.secret === undefined
    ? null
    : await encryptWebhookSecret(input.secret, keys);
  await db
    .prepare(`INSERT INTO incoming_webhooks (id, name, source_type, secret, secret_encrypted, line_account_id, created_at, updated_at, folder_id, is_active) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`)
    .bind(id, input.name, input.sourceType ?? 'custom', encrypted, input.lineAccountId, now, now, folderId ?? null, input.isActive === false ? 0 : 1)
    .run();
  return (await getIncomingWebhookById(db, id, input.lineAccountId))!;
}

/**
 * 秘密値の等価判定（定数時間）。同じ値の再保存を重複操作として扱い、
 * 旧合言葉の猶予を保つために使う。判定自体に秘密値は出さない。
 */
export function sameSecretValue(current: string, next: string): boolean {
  if (current.length !== next.length) return false;
  let diff = 0;
  for (let index = 0; index < current.length; index += 1) {
    diff |= current.charCodeAt(index) ^ next.charCodeAt(index);
  }
  return diff === 0;
}

export async function updateIncomingWebhook(
  db: D1Database,
  id: string,
  lineAccountId: string,
  updates: Partial<{ name: string; sourceType: string; secret: string; isActive: boolean; folderId: unknown }>,
  keys?: WebhookKeyInput | string,
  expectedVersion?: number,
  expectedConfirmationRevision?: number,
): Promise<boolean> {
  const folderId = await readFolderAssignment(db, 'webhook', lineAccountId, updates.folderId);
  const sets: string[] = [];
  const values: unknown[] = [];
  if (folderId !== undefined) { sets.push('folder_id = ?'); values.push(folderId); }
  if (updates.name !== undefined) { sets.push('name = ?'); values.push(updates.name); }
  if (updates.sourceType !== undefined) { sets.push('source_type = ?'); values.push(updates.sourceType); }
  if (updates.secret !== undefined) {
    // 入れ直しは暗号化して保存し、旧平文を消す。鍵がなければ例外にする。
    /*
     * 入れ替え前の合言葉は secret_previous_encrypted へ移し、
     * 入れ替え時刻と一緒に残す。受信側は入れ替えから24時間だけ前の
     * 合言葉の署名も受け付ける(相手側の切り替えに猶予を持たせる)。
     * 前の値が暗号文ならそのまま移す。旧平文だけ残る行は暗号化して移す。
     *
     * 同じ新値の再保存（応答消失の再試行）は重複操作として扱い、
     * 既存 previous と失効時刻を保つ。別値への変更だけが猶予を作り直す。
     */
    const before = await db
      .prepare(`SELECT secret, secret_encrypted FROM incoming_webhooks WHERE id = ? AND line_account_id = ?`)
      .bind(id, lineAccountId)
      .first<{ secret: string | null; secret_encrypted: string | null }>();
    let resave = false;
    try {
      const current = await resolveWebhookSecret(
        { secret: before?.secret ?? null, secret_encrypted: before?.secret_encrypted ?? null },
        keys,
      );
      resave = current !== null && sameSecretValue(current, updates.secret);
    } catch {
      resave = false;
    }
    if (!resave) {
      const previous = before?.secret_encrypted
        ?? (before?.secret ? await encryptWebhookSecret(before.secret, keys) : null);
      sets.push('secret_previous_encrypted = ?');
      values.push(previous);
      sets.push('secret_rotated_at = ?');
      values.push(jstNow());
      sets.push('secret_encrypted = ?');
      values.push(await encryptWebhookSecret(updates.secret, keys));
      sets.push('secret = NULL');
    }
  }
  if (updates.isActive !== undefined) { sets.push('is_active = ?'); values.push(updates.isActive ? 1 : 0); }
  if (sets.length === 0) {
    const current = await getIncomingWebhookById(db, id, lineAccountId);
    return Boolean(current && (expectedVersion === undefined || current.version === expectedVersion) && (expectedConfirmationRevision === undefined || current.confirmation_revision === expectedConfirmationRevision));
  }
  sets.push('version = version + 1', 'confirmation_revision = confirmation_revision + 1');
  sets.push('updated_at = ?');
  values.push(jstNow());
  values.push(id);
  values.push(lineAccountId);
  const result = await db.prepare(`UPDATE incoming_webhooks SET ${sets.join(', ')} WHERE id = ? AND line_account_id = ? AND deleted_at IS NULL AND (? IS NULL OR version = ?) AND (? IS NULL OR confirmation_revision = ?)`)
    .bind(...values, expectedVersion ?? null, expectedVersion ?? null, expectedConfirmationRevision ?? null, expectedConfirmationRevision ?? null).run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * 削除は行を消さず印を付ける。届いた・送った記録と
 * 「いつ誰が止めたか」の履歴を残すため。返り値は印を付けられたか。
 * 既に印のある行や別アカウントの行は false。
 */
export async function deleteIncomingWebhook(
  db: D1Database,
  id: string,
  lineAccountId: string,
  deletedByStaffId?: string,
  expectedVersion?: number,
  expectedConfirmationRevision?: number,
): Promise<boolean> {
  const result = await db.prepare(`UPDATE incoming_webhooks
    SET deleted_at = ?, deleted_by_staff_id = ?, is_active = 0, version = version + 1, updated_at = ?, confirmation_revision = confirmation_revision + 1
    WHERE id = ? AND line_account_id = ? AND deleted_at IS NULL AND (? IS NULL OR version = ?) AND (? IS NULL OR confirmation_revision = ?)`)
    .bind(jstNow(), deletedByStaffId ?? null, jstNow(), id, lineAccountId, expectedVersion ?? null, expectedVersion ?? null, expectedConfirmationRevision ?? null, expectedConfirmationRevision ?? null).run();
  return (result.meta.changes ?? 0) > 0;
}

/*
 * 受信Webhookの削除の取り消し（B 元に戻す）。deleted_at を空に戻すだけ。
 * 戻した直後は止めたまま（is_active = 0）。戻した瞬間に外へ送り出さない。
 */
export async function restoreIncomingWebhook(
  db: D1Database,
  id: string,
  lineAccountId: string,
): Promise<boolean> {
  const result = await db.prepare(`UPDATE incoming_webhooks
    SET deleted_at = NULL, deleted_by_staff_id = NULL, is_active = 0, version = version + 1, updated_at = ?, confirmation_revision = confirmation_revision + 1
    WHERE id = ? AND line_account_id = ? AND deleted_at IS NOT NULL`)
    .bind(jstNow(), id, lineAccountId).run();
  return (result.meta.changes ?? 0) > 0;
}
