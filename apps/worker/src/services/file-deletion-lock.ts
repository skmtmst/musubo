type ScanIdentity = { id: string; media_id: string | null; subject_kind: string; subject_id: string };

/** 既存の操作記録を削除中の占有と再試行の記録に使う。 */
export function mediaDeletionLockId(mediaId: string): string {
  return `file-scan-delete:media:${mediaId}`;
}

export function scanDeletionLockId(scan: ScanIdentity): string {
  const mediaId = scan.media_id ?? (scan.subject_kind === 'media' ? scan.subject_id : null);
  return mediaId ? mediaDeletionLockId(mediaId) : `file-scan-delete:scan:${scan.id}`;
}

export const UNLOCKED_SCAN_SQL = `NOT EXISTS (SELECT 1 FROM operation_audit file_lock
  WHERE file_lock.id = CASE WHEN media_file_scans.media_id IS NOT NULL THEN 'file-scan-delete:media:' || media_file_scans.media_id
    WHEN media_file_scans.subject_kind='media' THEN 'file-scan-delete:media:' || media_file_scans.subject_id
    ELSE 'file-scan-delete:scan:' || media_file_scans.id END AND file_lock.action='deleting')`;

export type FileDeletionLock = { id: string; token: string };

export async function claimFileDeletion(db: D1Database, id: string, actorId: string, scan?: { id: string; accountId: string; expected?: number }): Promise<FileDeletionLock | null> {
  const token = crypto.randomUUID();
  const now = Date.now();
  const detail = JSON.stringify({ token, leaseUntil: now + 300_000 });
  const statements = [
    db.prepare("INSERT OR IGNORE INTO operation_audit(id,target_kind,target_id,action,actor_id,detail_json) VALUES (?,'file_deletion_lock',?,'released',?,'{}')").bind(id, scan?.id ?? null, actorId),
    db.prepare(`UPDATE operation_audit SET action='deleting',actor_id=?,detail_json=? WHERE id=?
      AND (action<>'deleting' OR COALESCE(json_extract(detail_json,'$.leaseUntil'),0)<=?)`).bind(actorId, detail, id, now),
    db.prepare("SELECT json(CASE WHEN changes()=1 THEN '{}' ELSE 'FILE_DELETE_CONFLICT' END)"),
    ...(scan ? [db.prepare(`UPDATE media_file_scans SET confirmation_revision=confirmation_revision+1
      WHERE id=? AND line_account_id=? AND status IN ('quarantined','rejected') AND (? IS NULL OR confirmation_revision=?)`)
      .bind(scan.id, scan.accountId, scan.expected ?? null, scan.expected ?? null),
      db.prepare("SELECT json(CASE WHEN changes()=1 THEN '{}' ELSE 'FILE_DELETE_CONFLICT' END)")] : []),
  ];
  try { await db.batch(statements); return { id, token }; }
  catch (error) { if (/malformed JSON/i.test(String(error))) return null; throw error; }
}

export function fileDeletionGuard(db: D1Database, lock: FileDeletionLock): D1PreparedStatement {
  return db.prepare("SELECT json(CASE WHEN EXISTS(SELECT 1 FROM operation_audit WHERE id=? AND action='deleting' AND json_extract(detail_json,'$.token')=?) THEN '{}' ELSE 'FILE_DELETE_CONFLICT' END)").bind(lock.id, lock.token);
}

export async function releaseFileDeletion(db: D1Database, lock: FileDeletionLock): Promise<void> {
  await db.prepare("UPDATE operation_audit SET action='released' WHERE id=? AND action='deleting' AND json_extract(detail_json,'$.token')=?").bind(lock.id, lock.token).run();
}
