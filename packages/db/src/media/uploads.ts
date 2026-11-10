import { jstNow } from '../utils.js';
import type { Media, MediaKind } from './primitives.js';

const DEFAULT_MEDIA_QUOTA_BYTES = 10 * 1024 * 1024 * 1024;

export type MediaQuotaState = 'normal' | 'notice' | 'warning' | 'full';

export interface MediaStorageQuota {
  usageBytes: number;
  reservedBytes: number;
  limitBytes: number;
  remainingBytes: number;
  usageRate: number;
  state: MediaQuotaState;
}

export interface MediaUploadSession {
  id: string;
  line_account_id: string;
  target_media_id: string | null;
  result_media_id: string | null;
  folder_id: string | null;
  filename: string;
  kind: MediaKind;
  expected_mime: string;
  expected_size: number;
  r2_key: string;
  status: 'pending' | 'verified' | 'completed' | 'failed' | 'expired';
  failure_code: string | null;
  etag: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  page_count: number | null;
  codec: string | null;
  expires_at: string;
  created_by: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface MediaVersion {
  id: string;
  media_id: string;
  version_no: number;
  r2_key: string;
  mime_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  page_count: number | null;
  codec: string | null;
  content_hash: string | null;
  etag: string | null;
  scan_status: string;
  scan_result: string | null;
  scanned_at: string | null;
  change_reason: string | null;
  uploaded_by: string | null;
  created_at: string;
  published_at: string | null;
}

export class MediaVersionConflictError extends Error {
  constructor(readonly currentVersionNo: number) {
    super('media version conflict');
  }
}

export class MediaVersionIncompatibleError extends Error {
  constructor(readonly blockers: string[]) {
    super('media version incompatible');
  }
}

/*
 * 版追加の互換基準（種別ごとに明文化）。
 * - image: 幅と高さが一致。どちらか欠ければ判定不能として拒否。
 * - video / audio: 長さ(duration_ms)が一致。codec は両側に記録があるとき一致必須。
 * - file(PDF): ページ数が一致。
 * 不足している内容情報を「互換」とみなさず、書き込み前に必ず拒否する。
 */
export type MediaVersionBlocker =
  | 'different_kind'
  | 'upload_not_verified'
  | 'metadata_missing'
  | 'incompatible_dimensions'
  | 'incompatible_duration'
  | 'incompatible_pages'
  | 'incompatible_codec';

export interface MediaMetadata {
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  page_count: number | null;
  codec: string | null;
}

export function evaluateMediaVersionCompat(
  current: { kind: string } & MediaMetadata,
  incoming: { kind: string } & MediaMetadata,
): MediaVersionBlocker[] {
  const blockers = new Set<MediaVersionBlocker>();
  if (current.kind !== incoming.kind) blockers.add('different_kind');
  const pair = (a: number | null, b: number | null): 'missing' | 'same' | 'different' =>
    a == null || b == null || a <= 0 || b <= 0 ? 'missing' : a === b ? 'same' : 'different';
  if (incoming.kind === 'image') {
    const w = pair(current.width, incoming.width);
    const h = pair(current.height, incoming.height);
    if (w === 'missing' || h === 'missing') blockers.add('metadata_missing');
    else if (w === 'different' || h === 'different') blockers.add('incompatible_dimensions');
  } else if (incoming.kind === 'video' || incoming.kind === 'audio') {
    const d = pair(current.duration_ms, incoming.duration_ms);
    if (d === 'missing') blockers.add('metadata_missing');
    else if (d === 'different') blockers.add('incompatible_duration');
  } else if (incoming.kind === 'file') {
    const p = pair(current.page_count, incoming.page_count);
    if (p === 'missing') blockers.add('metadata_missing');
    else if (p === 'different') blockers.add('incompatible_pages');
  }
  const curCodec = current.codec?.trim();
  const newCodec = incoming.codec?.trim();
  if (curCodec && newCodec && curCodec !== newCodec) blockers.add('incompatible_codec');
  return [...blockers];
}

function quotaState(usageRate: number): MediaQuotaState {
  if (usageRate >= 1) return 'full';
  if (usageRate >= 0.9) return 'warning';
  if (usageRate >= 0.8) return 'notice';
  return 'normal';
}

export async function getMediaStorageQuota(
  db: D1Database,
  lineAccountId: string,
): Promise<MediaStorageQuota> {
  await db.prepare(
    `INSERT OR IGNORE INTO media_storage_quotas
       (line_account_id, limit_bytes, updated_at) VALUES (?, ?, ?)`,
  ).bind(lineAccountId, DEFAULT_MEDIA_QUOTA_BYTES, jstNow()).run();
  const row = await db.prepare(
    `SELECT q.limit_bytes,
            COALESCE((SELECT SUM(m.size_bytes) FROM media m
              WHERE m.line_account_id = q.line_account_id), 0)
            + COALESCE((SELECT SUM(v.size_bytes)
                FROM media_versions v JOIN media m ON m.id = v.media_id
               WHERE m.line_account_id = q.line_account_id AND v.r2_key <> m.r2_key), 0)
              AS usage_bytes,
            COALESCE((SELECT SUM(s.expected_size) FROM media_upload_sessions s
              WHERE s.line_account_id = q.line_account_id
                AND s.status IN ('pending','verified') AND datetime(s.expires_at) > datetime(?)), 0)
              AS reserved_bytes
       FROM media_storage_quotas q WHERE q.line_account_id = ?`,
  ).bind(jstNow(), lineAccountId).first<{
    limit_bytes: number;
    usage_bytes: number;
    reserved_bytes: number;
  }>();
  if (!row) throw new Error('media quota is unavailable');
  const usageBytes = Number(row.usage_bytes);
  const reservedBytes = Number(row.reserved_bytes);
  const limitBytes = Number(row.limit_bytes);
  const usedAndReserved = usageBytes + reservedBytes;
  const usageRate = limitBytes > 0 ? usedAndReserved / limitBytes : 1;
  return {
    usageBytes,
    reservedBytes,
    limitBytes,
    remainingBytes: Math.max(0, limitBytes - usedAndReserved),
    usageRate,
    state: quotaState(usageRate),
  };
}

export async function createMediaUploadSession(
  db: D1Database,
  input: {
    id: string;
    lineAccountId: string;
    targetMediaId?: string | null;
    folderId?: string | null;
    filename: string;
    kind: MediaKind;
    mimeType: string;
    sizeBytes: number;
    r2Key: string;
    expiresAt: string;
    createdBy?: string | null;
    metadata?: Partial<MediaMetadata> | null;
  },
): Promise<MediaUploadSession> {
  await db.prepare(
    `INSERT INTO media_upload_sessions
       (id, line_account_id, target_media_id, folder_id, filename, kind, expected_mime,
        expected_size, r2_key, status, expires_at, created_by, created_at,
        width, height, duration_ms, page_count, codec)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    input.id, input.lineAccountId, input.targetMediaId ?? null, input.folderId ?? null,
    input.filename, input.kind, input.mimeType, input.sizeBytes, input.r2Key,
    input.expiresAt, input.createdBy ?? null, jstNow(),
    input.metadata?.width ?? null, input.metadata?.height ?? null,
    input.metadata?.duration_ms ?? null, input.metadata?.page_count ?? null,
    input.metadata?.codec ?? null,
  ).run();
  return (await getMediaUploadSession(db, input.id, input.lineAccountId))!;
}

export async function getMediaUploadSession(
  db: D1Database,
  id: string,
  lineAccountId: string,
): Promise<MediaUploadSession | null> {
  return db.prepare(
    `SELECT * FROM media_upload_sessions WHERE id = ? AND line_account_id = ?`,
  ).bind(id, lineAccountId).first<MediaUploadSession>();
}

export async function failMediaUploadSession(
  db: D1Database,
  id: string,
  lineAccountId: string,
  failureCode: string,
): Promise<void> {
  const fail = db.prepare(
    `UPDATE media_upload_sessions SET status = 'failed', failure_code = ?, completed_at = ?
      WHERE id = ? AND line_account_id = ? AND status = 'pending' AND NOT EXISTS (
        SELECT 1 FROM media_file_scans fs JOIN operation_audit l ON l.id=CASE WHEN fs.media_id IS NOT NULL THEN 'file-scan-delete:media:' || fs.media_id ELSE 'file-scan-delete:scan:' || fs.id END AND l.action='deleting'
        WHERE fs.subject_kind='upload_session' AND fs.subject_id=media_upload_sessions.id
      )`,
  ).bind(failureCode, jstNow(), id, lineAccountId);
  await db.batch([fail, db.prepare("UPDATE media_file_scans SET confirmation_revision=confirmation_revision+1 WHERE subject_kind='upload_session' AND subject_id=? AND line_account_id=? AND changes()>0").bind(id, lineAccountId)]);
}

export async function verifyMediaUploadSession(
  db: D1Database,
  id: string,
  lineAccountId: string,
  etag: string,
  measured?: Partial<MediaMetadata> | null,
  overwriteDeclared = false,
  finalizedR2Key?: string,
): Promise<MediaUploadSession | null> {
  // overwriteDeclared: 実体から測れる内容（画像の寸法）は申告値を残さず
  // 実測値へ完全に置き換える。測れなかった場合は null にして
  // 「判定材料不足」として後段の互換判定が拒否する。
  const setClause = overwriteDeclared
    ? `width = ?, height = ?, duration_ms = ?, page_count = ?, codec = ?`
    : `width = COALESCE(?, width), height = COALESCE(?, height),
        duration_ms = COALESCE(?, duration_ms), page_count = COALESCE(?, page_count),
        codec = COALESCE(?, codec)`;
  const verify = db.prepare(
    `UPDATE media_upload_sessions SET status = 'verified', etag = ?, completed_at = ?,
        r2_key = COALESCE(?, r2_key), ${setClause}
      WHERE id = ? AND line_account_id = ? AND status = 'pending' AND NOT EXISTS (
        SELECT 1 FROM media_file_scans fs JOIN operation_audit l ON l.id=CASE WHEN fs.media_id IS NOT NULL THEN 'file-scan-delete:media:' || fs.media_id ELSE 'file-scan-delete:scan:' || fs.id END AND l.action='deleting'
        WHERE fs.subject_kind='upload_session' AND fs.subject_id=media_upload_sessions.id
      )`,
  ).bind(
    etag, jstNow(), finalizedR2Key ?? null,
    measured?.width ?? null, measured?.height ?? null, measured?.duration_ms ?? null,
    measured?.page_count ?? null, measured?.codec ?? null,
    id, lineAccountId,
  );
  await db.batch([verify, db.prepare("UPDATE media_file_scans SET confirmation_revision=confirmation_revision+1 WHERE subject_kind='upload_session' AND subject_id=? AND line_account_id=? AND changes()>0").bind(id, lineAccountId)]);
  return getMediaUploadSession(db, id, lineAccountId);
}

export async function completeNewMediaUpload(
  db: D1Database,
  session: MediaUploadSession,
): Promise<Media> {
  if (session.target_media_id) throw new Error('target media session cannot create a media asset');
  const mediaId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const now = jstNow();
  await db.batch([
    db.prepare(
      `INSERT INTO media
         (id, line_account_id, folder_id, kind, filename, mime_type, size_bytes,
          width, height, duration_ms, r2_key, public_url, uploaded_by, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?
        FROM media_upload_sessions WHERE id = ? AND status = 'verified' AND result_media_id IS NULL`,
    ).bind(
      mediaId, session.line_account_id, session.folder_id, session.kind, session.filename,
      session.expected_mime, session.expected_size, session.width, session.height,
      session.duration_ms, session.r2_key, session.created_by, now, session.id,
    ),
    db.prepare(
      `INSERT INTO media_versions
         (id, media_id, version_no, r2_key, mime_type, size_bytes, width, height,
          duration_ms, page_count, codec, etag, scan_status,
          scanned_at, uploaded_by, created_at, published_at)
       SELECT ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM media WHERE id = ?)`,
    ).bind(
      versionId, mediaId, session.r2_key, session.expected_mime, session.expected_size,
      session.width, session.height, session.duration_ms, session.page_count,
      session.codec, session.etag, now, session.created_by, now, now, mediaId,
    ),
    db.prepare(
      `UPDATE media_upload_sessions
          SET status = 'completed', result_media_id = ?, completed_at = ?
        WHERE id = ? AND line_account_id = ? AND status = 'verified'`,
    ).bind(mediaId, now, session.id, session.line_account_id),
  ]);
  const completed = await getMediaUploadSession(db, session.id, session.line_account_id);
  const media = await db.prepare(
    `SELECT * FROM media WHERE id = ? AND line_account_id = ?`,
  ).bind(completed?.result_media_id ?? mediaId, session.line_account_id).first<Media>();
  if (!media) throw new Error('completed media is unavailable');
  return media;
}

/**
 * メディアの版履歴を新しい順で返す。
 *
 * 使用先ごとの固定版切替で「第何版に固定するか」を選ぶため、版番号・
 * 実体キー・検査状態・公開時刻をまとめて渡す。
 */
export async function getMediaVersionList(
  db: D1Database,
  mediaId: string,
  lineAccountId: string,
): Promise<MediaVersion[]> {
  const rows = await db.prepare(
    `SELECT v.* FROM media_versions v
       JOIN media m ON m.id = v.media_id
      WHERE v.media_id = ? AND m.line_account_id = ?
      ORDER BY v.version_no DESC`,
  ).bind(mediaId, lineAccountId).all<MediaVersion>();
  return rows.results;
}

/**
 * 指定した版の1行。版ごとの実体（元ファイルの取り戻し）へ
 * 到達するための口。アカウント境界は JOIN 側で確認する。
 */
export async function getMediaVersionByNo(
  db: D1Database,
  mediaId: string,
  lineAccountId: string,
  versionNo: number,
): Promise<MediaVersion | null> {
  return db.prepare(
    `SELECT v.* FROM media_versions v
       JOIN media m ON m.id = v.media_id
      WHERE v.media_id = ? AND m.line_account_id = ? AND v.version_no = ?`,
  ).bind(mediaId, lineAccountId, versionNo).first<MediaVersion>();
}

export async function getCurrentMediaVersionNo(
  db: D1Database,
  mediaId: string,
  lineAccountId: string,
): Promise<number | null> {
  const row = await db.prepare(
    `SELECT MAX(v.version_no) AS version_no
       FROM media_versions v JOIN media m ON m.id = v.media_id
      WHERE v.media_id = ? AND m.line_account_id = ?`,
  ).bind(mediaId, lineAccountId).first<{ version_no: number | null }>();
  return row?.version_no == null ? null : Number(row.version_no);
}

/** 現行版の行。互換性判定はメディア行ではなく実ファイル側の記録を正本にする。 */
export async function getLatestMediaVersion(
  db: D1Database,
  mediaId: string,
  lineAccountId: string,
): Promise<MediaVersion | null> {
  return db.prepare(
    `SELECT v.* FROM media_versions v
       JOIN media m ON m.id = v.media_id
      WHERE v.media_id = ? AND m.line_account_id = ?
      ORDER BY v.version_no DESC LIMIT 1`,
  ).bind(mediaId, lineAccountId).first<MediaVersion>();
}

/**
 * 旧版に内容情報が無いとき、実体から測った値だけを空いている列へ補う。
 * 記録済みの値は上書きしない（過去の判定材料を後から変えない）。
 */
export async function backfillMediaVersionMetadata(
  db: D1Database,
  media: { id: string; line_account_id: string | null },
  latestVersion: MediaVersion | null,
  measured: Partial<MediaMetadata>,
): Promise<void> {
  if (latestVersion) {
    await db.prepare(
      `UPDATE media_versions SET
         width = COALESCE(width, ?), height = COALESCE(height, ?),
         duration_ms = COALESCE(duration_ms, ?), page_count = COALESCE(page_count, ?),
         codec = COALESCE(codec, ?)
       WHERE id = ? AND media_id = ?`,
    ).bind(
      measured.width ?? null, measured.height ?? null, measured.duration_ms ?? null,
      measured.page_count ?? null, measured.codec ?? null,
      latestVersion.id, media.id,
    ).run();
  }
  await db.prepare(
    `UPDATE media SET
       width = COALESCE(width, ?), height = COALESCE(height, ?),
       duration_ms = COALESCE(duration_ms, ?)
     WHERE id = ? AND line_account_id = ?`,
  ).bind(
    measured.width ?? null, measured.height ?? null, measured.duration_ms ?? null,
    media.id, media.line_account_id,
  ).run();
}

export async function createMediaVersionFromUpload(
  db: D1Database,
  input: {
    mediaId: string;
    lineAccountId: string;
    uploadSessionId: string;
    expectedVersionNo: number;
    changeReason: string;
    uploadedBy?: string | null;
  },
): Promise<MediaVersion> {
  const [currentVersionNo, media, latestVersion] = await Promise.all([
    getCurrentMediaVersionNo(db, input.mediaId, input.lineAccountId),
    db.prepare(
      `SELECT * FROM media WHERE id = ? AND line_account_id = ?`,
    ).bind(input.mediaId, input.lineAccountId).first<Media>(),
    getLatestMediaVersion(db, input.mediaId, input.lineAccountId),
  ]);
  if (currentVersionNo === null || !media) throw new Error('media_not_found');
  if (currentVersionNo !== input.expectedVersionNo) {
    throw new MediaVersionConflictError(currentVersionNo);
  }
  const session = await getMediaUploadSession(db, input.uploadSessionId, input.lineAccountId);
  if (!session || session.target_media_id !== input.mediaId || session.status !== 'verified') {
    throw new Error('media_upload_session_not_verified');
  }
  // 互換性は必ず DB 側でも判定する。preview を飛ばした直接呼出しでも
  // 種類だけの一致で書き込ませない。
  const compatBlockers = evaluateMediaVersionCompat(
    {
      kind: media.kind,
      width: latestVersion?.width ?? media.width,
      height: latestVersion?.height ?? media.height,
      duration_ms: latestVersion?.duration_ms ?? media.duration_ms,
      page_count: latestVersion?.page_count ?? null,
      codec: latestVersion?.codec ?? null,
    },
    {
      kind: session.kind,
      width: session.width,
      height: session.height,
      duration_ms: session.duration_ms,
      page_count: session.page_count,
      codec: session.codec,
    },
  );
  if (compatBlockers.length > 0) {
    throw new MediaVersionIncompatibleError(compatBlockers);
  }
  const id = crypto.randomUUID();
  const nextVersionNo = currentVersionNo + 1;
  const now = jstNow();
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO media_versions
           (id, media_id, version_no, r2_key, mime_type, size_bytes, width, height,
            duration_ms, page_count, codec, etag, scan_status,
            scanned_at, change_reason, uploaded_by, created_at, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?, ?, ?, ?, ?)`,
      ).bind(
        id, input.mediaId, nextVersionNo, session.r2_key, session.expected_mime,
        session.expected_size, session.width, session.height, session.duration_ms,
        session.page_count, session.codec, session.etag, now, input.changeReason,
        input.uploadedBy ?? session.created_by, now, now,
      ),
      db.prepare(
        `UPDATE media SET filename = ?, mime_type = ?, size_bytes = ?, r2_key = ?,
            width = ?, height = ?, duration_ms = ?, uploaded_by = ?
          WHERE id = ? AND line_account_id = ? AND NOT EXISTS (SELECT 1 FROM operation_audit WHERE id='file-scan-delete:media:' || media.id AND action='deleting')`,
      ).bind(
        session.filename, session.expected_mime, session.expected_size, session.r2_key,
        session.width, session.height, session.duration_ms,
        input.uploadedBy ?? session.created_by, input.mediaId, input.lineAccountId,
      ),
      db.prepare("SELECT json(CASE WHEN changes()=1 THEN '{}' ELSE 'FILE_DELETE_CONFLICT' END)"),
      db.prepare("UPDATE media_file_scans SET confirmation_revision=confirmation_revision+1 WHERE line_account_id=? AND (media_id=? OR (subject_kind='media' AND subject_id=?))").bind(input.lineAccountId, input.mediaId, input.mediaId),
      db.prepare(
        `UPDATE media_upload_sessions
            SET status = 'completed', result_media_id = ?, completed_at = ?
          WHERE id = ? AND line_account_id = ? AND status = 'verified'`,
      ).bind(input.mediaId, now, session.id, input.lineAccountId),
    ]);
  } catch (error) {
    const latestVersionNo = await getCurrentMediaVersionNo(db, input.mediaId, input.lineAccountId);
    if (latestVersionNo !== null && latestVersionNo !== currentVersionNo) {
      throw new MediaVersionConflictError(latestVersionNo);
    }
    throw error;
  }
  const version = await db.prepare(
    `SELECT * FROM media_versions WHERE id = ? AND media_id = ?`,
  ).bind(id, input.mediaId).first<MediaVersion>();
  if (!version) throw new Error('created media version is unavailable');
  return version;
}
