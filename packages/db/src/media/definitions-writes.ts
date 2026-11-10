import { jstNow } from '../utils.js';
import { type MediaKind, type Media } from './primitives.js';
import { getMediaById } from './definitions-reads.js';


export async function createMedia(
  db: D1Database,
  input: {
    kind: MediaKind;
    /** null は統括所有（バナー生成など、店舗に属さないメディア）。 */
    lineAccountId: string | null;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    r2Key: string;
    folderId?: string | null;
    width?: number | null;
    height?: number | null;
    durationMs?: number | null;
    publicUrl?: string | null;
    uploadedBy?: string | null;
  },
): Promise<Media> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db.batch([
    db.prepare(
      `INSERT INTO media
         (id, line_account_id, folder_id, kind, filename, mime_type, size_bytes, width, height,
          duration_ms, r2_key, public_url, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.lineAccountId,
      input.folderId ?? null,
      input.kind,
      input.filename,
      input.mimeType,
      input.sizeBytes,
      input.width ?? null,
      input.height ?? null,
      input.durationMs ?? null,
      input.r2Key,
      input.publicUrl ?? null,
      input.uploadedBy ?? null,
      now,
    ),
    db.prepare(
      `INSERT INTO media_versions
         (id, media_id, version_no, r2_key, mime_type, size_bytes, width, height, duration_ms,
          scan_status, scanned_at, uploaded_by, created_at, published_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 'verified', ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), id, input.r2Key, input.mimeType, input.sizeBytes,
      input.width ?? null, input.height ?? null, input.durationMs ?? null,
      now, input.uploadedBy ?? null, now, now,
    ),
  ]);
  return (await getMediaById(db, id, input.lineAccountId))!;
}

export async function updateMedia(
  db: D1Database,
  id: string,
  lineAccountId: string,
  input: {
    expectedRevision?: number;
    filename?: string;
    folderId?: string | null;
    usageExpiresAt?: string | null;
    usageConsentNote?: string | null;
  },
): Promise<Media | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (input.filename !== undefined) {
    sets.push('filename = ?');
    values.push(input.filename);
  }
  if ('folderId' in input) {
    sets.push('folder_id = ?');
    values.push(input.folderId ?? null);
  }
  // 利用期限・同意の記録は明示指定されたときだけ書き換える。
  // null は「記録を消す」で、未記録＝不明へ戻す。
  if ('usageExpiresAt' in input) {
    sets.push('usage_expires_at = ?');
    values.push(input.usageExpiresAt ?? null);
  }
  if ('usageConsentNote' in input) {
    sets.push('usage_consent_note = ?');
    values.push(input.usageConsentNote ?? null);
  }
  if (sets.length > 0) {
    sets.push('revision = revision + 1');
    values.push(id, lineAccountId);
    if (input.expectedRevision !== undefined) values.push(input.expectedRevision);
    const result = await db.prepare(`UPDATE media SET ${sets.join(', ')} WHERE id = ? AND line_account_id = ?${input.expectedRevision === undefined ? '' : ' AND revision = ?'}`).bind(...values).run();
    if (Number(result.meta?.changes ?? 0) !== 1) return null;
  }
  return getMediaById(db, id, lineAccountId);
}

export async function deleteMedia(db: D1Database, id: string, lineAccountId: string, guard?: { lockId: string; token: string; r2Key: string }): Promise<void> {
  if (!guard) { await db.prepare(`DELETE FROM media WHERE id = ? AND line_account_id = ?`).bind(id, lineAccountId).run(); return; }
  await db.batch([
    db.prepare("SELECT json(CASE WHEN EXISTS(SELECT 1 FROM operation_audit WHERE id=? AND action='deleting' AND json_extract(detail_json,'$.token')=?) THEN '{}' ELSE 'FILE_DELETE_CONFLICT' END)").bind(guard.lockId, guard.token),
    db.prepare("UPDATE media_file_scans SET confirmation_revision=confirmation_revision+1 WHERE line_account_id=? AND (media_id=? OR (subject_kind='media' AND subject_id=?))").bind(lineAccountId, id, id),
    db.prepare('DELETE FROM media WHERE id=? AND line_account_id=? AND r2_key=?').bind(id, lineAccountId, guard.r2Key),
    db.prepare("SELECT json(CASE WHEN changes()=1 THEN '{}' ELSE 'FILE_DELETE_CONFLICT' END)"),
    db.prepare("UPDATE operation_audit SET action='released' WHERE id=? AND action='deleting' AND json_extract(detail_json,'$.token')=?").bind(guard.lockId, guard.token),
  ]);
}
