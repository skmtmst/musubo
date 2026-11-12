import { parseOffsetPaging, buildOffsetListResponse } from '../lib/list-paging.js';
import { logger } from '@line-crm/shared/server';
import { sqlIdSet } from '@line-crm/db/id-queries';
import { purgeUnsafeFormDocuments } from '../features/forms/form-documents/index.js';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { allowedFileScanEndpoint, isFileScanSecretRef } from '../lib/file-scan-policy.js';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { requireRole } from '../middleware/role-guard.js';
import { auditEventStatement, recordAuditEvent } from '@line-crm/db';
import { canAccessAllLineAccounts } from '../services/account-access.js';
import { claimFileDeletion, fileDeletionGuard, releaseFileDeletion, scanDeletionLockId, UNLOCKED_SCAN_SQL } from '../services/file-deletion-lock.js';
import {
  FILE_SCAN_REASON_LABELS,
  FORM_FILE_SCAN_MAX_ATTEMPTS,
  isPrivateFormDocumentScan,
  markFileScanRejected,
  claimDueFileScans,
  createFileScan,
  getFileScanBySubject,
  getFileScanConfig,
  getLatestMediaScan,
  markFileScanClean,
  markFileScanPendingRetry,
  markFileScanQuarantined,
  resolveExternalScanner,
  runScanForStoredObject,
  ScanRetryableError,
  type FileScanConfig,
  type FileScanRow,
  type FileScanStatus,
  type FileScanSubjectKind,
} from '../services/file-scan.js';

/*
 * 危険なファイルの検査の管理口。
 * 一覧・消す・誤りなので戻す（理由を記録）は owner / admin だけ。
 * 自分の上げたファイルの状態確認と、止まっている時の表示は staff も見られる。
 */

export const fileScan = new Hono<Env>();

function reasonLabel(code: string | null): string | null {
  if (!code) return null;
  return FILE_SCAN_REASON_LABELS[code] ?? '確認が必要です';
}

function serializeScan(row: FileScanRow) {
  return {
    id: row.id,
    confirmationRevision: row.confirmation_revision,
    lineAccountId: row.line_account_id,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    mediaId: row.media_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    status: row.status,
    reasonCode: row.reason_code,
    // 中身は画面に出さない。理由コードの言葉だけ出す。
    reasonLabel: reasonLabel(row.reason_code),
    attempts: row.attempts,
    nextRetryAt: row.next_retry_at,
    scannedAt: row.scanned_at,
    quarantinedAt: row.quarantined_at,
    releasedAt: row.released_at,
    releaseReason: row.release_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeConfig(config: FileScanConfig, env: Env['Bindings']) {
  return {
    confirmationRevision: config.confirmation_revision,
    externalProvider: config.external_provider,
    externalEndpointUrl: config.external_endpoint_url,
    externalSecretRef: config.external_secret_ref,
    externalEnabled: resolveExternalScanner(env as unknown as Record<string, string | undefined>, config) !== null,
    externalTimeoutMs: config.external_timeout_ms,
    maxBytesOverride: config.max_bytes_override,
    maxPixelsOverride: config.max_pixels_override,
    updatedAt: config.updated_at,
  };
}

async function findR2Key(
  db: D1Database,
  scan: FileScanRow,
): Promise<{ key: string; width: number | null; height: number | null; etag?: string } | null> {
  if (scan.subject_kind === 'media_version') {
    const version = await db.prepare(
      `SELECT v.r2_key, v.width, v.height, v.etag FROM media_versions v JOIN media m ON m.id=v.media_id WHERE v.id = ? AND v.media_id = ? AND m.line_account_id IS ?`,
    ).bind(scan.subject_id, scan.media_id, scan.line_account_id).first<{ r2_key: string; width: number | null; height: number | null; etag: string | null }>();
    return version ? { key: version.r2_key, width: version.width, height: version.height, ...(version.etag ? { etag: version.etag.replace(/^"|"$/g, '') } : {}) } : null;
  }
  if (scan.subject_kind === 'upload_session') {
    const session = await db.prepare(
      `SELECT r2_key, width, height FROM media_upload_sessions WHERE id = ? AND line_account_id IS ?`,
    ).bind(scan.subject_id, scan.line_account_id).first<{ r2_key: string; width: number | null; height: number | null }>();
    return session ? { key: session.r2_key, width: session.width, height: session.height } : null;
  }
  if (scan.subject_kind === 'media' || scan.media_id) {
    const media = await db.prepare(
      `SELECT r2_key, width, height FROM media WHERE id = ? AND line_account_id IS ?`,
    ).bind(scan.media_id ?? scan.subject_id, scan.line_account_id)
      .first<{ r2_key: string; width: number | null; height: number | null }>();
    if (media) return { key: media.r2_key, width: media.width, height: media.height };
  }
  if (scan.subject_kind === 'photo') {
    const photo = await db.prepare(
      `SELECT r2_key, image_width, image_height FROM nen_photo_submissions WHERE id = ? AND line_account_id IS ?`,
    ).bind(scan.subject_id, scan.line_account_id)
      .first<{ r2_key: string; image_width: number | null; image_height: number | null }>();
    if (photo) return { key: photo.r2_key, width: photo.image_width, height: photo.image_height };
  }
  if (
    isPrivateFormDocumentScan(scan)
    || scan.subject_kind === 'broadcast_asset'
    || scan.subject_kind === 'generic_image'
  ) {
    // R2 キーを subject_id に入れている。寸法はその場で測る。
    return { key: scan.subject_id, width: null, height: null };
  }
  return null;
}

/** pending を再検査する。回答の書類は5回で却下する。 */
export async function processDueFileScans(
  env: Env['Bindings'],
  limit = 20,
): Promise<{ processed: number; stillPending: number }> {
  const now = new Date().toISOString();
  const due = await claimDueFileScans(env.DB, now, limit);
  let stillPending = 0;
  for (const scan of due) {
    try {
      if (isPrivateFormDocumentScan(scan) && scan.attempts >= FORM_FILE_SCAN_MAX_ATTEMPTS) {
        await markFileScanRejected(env.DB, scan.id, 'scan_attempts_exhausted', '検査を5回試しても終わりませんでした');
        continue;
      }
      const target = await findR2Key(env.DB, scan);
      if (!target) {
        if (await markFileScanPendingRetry(env.DB, scan.id, scan.attempts, isPrivateFormDocumentScan(scan) ? FORM_FILE_SCAN_MAX_ATTEMPTS : undefined) === 'pending') stillPending += 1;
        continue;
      }
      const config = await getFileScanConfig(env.DB, scan.line_account_id);
      const external = resolveExternalScanner(
        env as unknown as Record<string, string | undefined>, config,
      );
      if (external) {
        // 外の検査は設定があれば使う。鍵は設定の secret_ref が指す環境値から。
        const head = await env.IMAGES.get(target.key, { ...(target.key.startsWith('private/form-documents/') ? {} : { range: { offset: 0, length: 256 * 1024 } }), ...(target.etag ? { onlyIf: { etagMatches: target.etag } } : {}) });
        if ((target.etag && !head) || (head && !('body' in head))) throw new ScanRetryableError('object_changed');
        if (isPrivateFormDocumentScan(scan) && !head) throw new ScanRetryableError('document_missing');
        const bytes = head ? new Uint8Array(await head.arrayBuffer()) : new Uint8Array();
        try {
          const verdict = await external.scan(bytes, {
            filename: scan.filename, mimeType: scan.mime_type, sizeBytes: scan.size_bytes,
          });
          if (verdict === 'clean') {
            await markFileScanClean(env.DB, scan.id);
          } else {
            await markFileScanQuarantined(env.DB, scan.id, 'external_flagged', '外部の検査で問題が見つかりました');
            if (isPrivateFormDocumentScan(scan)) await purgeUnsafeFormDocuments(env.DB, env.IMAGES, scan.id);
          }
          continue;
        } catch (err) {
          if (err instanceof ScanRetryableError) {
            if (await markFileScanPendingRetry(env.DB, scan.id, scan.attempts, isPrivateFormDocumentScan(scan) ? FORM_FILE_SCAN_MAX_ATTEMPTS : undefined) === 'pending') stillPending += 1;
            continue;
          }
          throw err;
        }
      }
      const next = await runScanForStoredObject(env.DB, env.IMAGES, scan, target.key, {
        width: target.width, height: target.height,
      }, {
        maxBytes: config?.max_bytes_override ?? null,
        maxPixels: config?.max_pixels_override ?? null,
      }, target.etag);
      if (next.status === 'pending') stillPending += 1;
    } catch (err) {
      logger.error("file_scan.process_due_file_scans_failed");
      if (await markFileScanPendingRetry(env.DB, scan.id, scan.attempts, isPrivateFormDocumentScan(scan) ? FORM_FILE_SCAN_MAX_ATTEMPTS : undefined) === 'pending') stillPending += 1;
    }
  }
  return { processed: due.length, stillPending };
}

fileScan.get('/api/file-scans', requireRole('owner', 'admin'), async (c) => {
  const accountId = (c.req.query('accountId') ?? '').trim();
  const status = (c.req.query('status') ?? '').trim() as FileScanStatus | 'released' | '';
  /*
   * 監査 : 一覧は以前先頭50件固定で、51件目以降へ辿り着けなかった。
   * ページ送り（limit/offset）に加えてファイル名の検索を受ける。検索は
   * 件数と同じ条件で絞るので、一覧と総件数がずれない。
   */
  const query = (c.req.query('q') ?? '').trim();
  const { limit, offset } = parseOffsetPaging({ limit: c.req.query('limit'), offset: c.req.query('offset') }, { defaultLimit: 20, limitPolicy: { fallback: 'falsy', minimum: 1, maximum: 100 }, offsetPolicy: { fallback: 'falsy', minimum: 0 } });
  if (!accountId) return c.json({ success: false, error: 'accountId が必要です' }, 400);
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  const allowed: FileScanStatus[] = ['pending', 'clean', 'rejected', 'quarantined'];
  // 板 `` の「戻した」札。戻したものだけを見る口。`clean` には一度も
  // 止められていないものも混ざるため、`released_at` で絞る。
  const releasedOnly = status === 'released';
  const conditions = releasedOnly
    ? [`line_account_id = ?`, `released_at IS NOT NULL`]
    : status && (allowed as string[]).includes(status)
      ? [`line_account_id = ?`, `status = ?`]
      : [`line_account_id = ?`];
  const binds: (string | number)[] = releasedOnly ? [accountId] : status && (allowed as string[]).includes(status) ? [accountId, status] : [accountId];
  if (query) {
    conditions.push(`filename LIKE ? ESCAPE '\\'`);
    binds.push(`%${query.replace(/[\\%_]/g, '\\$&')}%`);
  }
  const where = conditions.join(' AND ');
  const rows = await c.env.DB.prepare(
    `SELECT * FROM media_file_scans WHERE ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
  ).bind(...binds, limit, offset).all<FileScanRow>();
  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM media_file_scans WHERE ${where}`,
  ).bind(...binds).first<{ n: number }>();
  const items = rows.results ?? [];
  // 上げた人の表示はその場で集める。media は登録者、写真は投稿者、その他は「—」。
  const mediaIds = [...new Set(items.filter((row) => row.media_id).map((row) => row.media_id as string))];
  const photoIds = [...new Set(items.filter((row) => row.subject_kind === 'photo').map((row) => row.subject_id))];
  const uploaders = new Map<string, string>();
  if (mediaIds.length > 0) {
    const placeholders = sqlIdSet(mediaIds).sql;
    const mediaRows = await c.env.DB.prepare(
      `SELECT id, uploaded_by FROM media WHERE id IN (${placeholders})`,
    ).bind(...(mediaIds.length ? sqlIdSet(mediaIds).binds : [])).all<{ id: string; uploaded_by: string | null }>();
    for (const mediaRow of mediaRows.results ?? []) {
      if (mediaRow.uploaded_by) uploaders.set(`media:${mediaRow.id}`, mediaRow.uploaded_by);
    }
  }
  if (photoIds.length > 0) {
    const placeholders = sqlIdSet(photoIds).sql;
    const photoRows = await c.env.DB.prepare(
      `SELECT ps.id, f.display_name AS friend_name
         FROM nen_photo_submissions ps LEFT JOIN friends f ON f.id = ps.friend_id
        WHERE ps.id IN (${placeholders})`,
    ).bind(...(photoIds.length ? sqlIdSet(photoIds).binds : [])).all<{ id: string; friend_name: string | null }>();
    for (const photoRow of photoRows.results ?? []) {
      uploaders.set(`photo:${photoRow.id}`, photoRow.friend_name ?? 'お客さん');
    }
  }
  return c.json({
    success: true,
    data: buildOffsetListResponse({ items: items.map((row) => {
        const uploader = row.subject_kind === 'photo'
          ? uploaders.get(`photo:${row.subject_id}`)
          : row.media_id ? uploaders.get(`media:${row.media_id}`) : undefined;
        return { ...serializeScan(row), uploaderLabel: uploader ?? '—' };
      }),
      total: Number(total?.n ?? 0), limit, offset, paging: { limit, offset }, sort: [{ field: 'updatedAt', direction: 'desc' }] }),
  });
});

fileScan.get('/api/file-scans/by-subject', requireRole('owner', 'admin', 'staff'), async (c) => {
  const kind = (c.req.query('kind') ?? '').trim();
  const id = (c.req.query('id') ?? '').trim();
  const accountId = (c.req.query('accountId') ?? '').trim();
  if (!kind || !id || !accountId) {
    return c.json({ success: false, error: 'kind と id と accountId が必要です' }, 400);
  }
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  const scan = await getFileScanBySubject(
    c.env.DB, kind as 'media' | 'media_version' | 'upload_session' | 'photo', id,
  );
  if (!scan || scan.line_account_id !== accountId) {
    return c.json({ success: true, data: { scan: null } });
  }
  return c.json({ success: true, data: { scan: serializeScan(scan) } });
});

fileScan.get('/api/file-scans/for-media', requireRole('owner', 'admin', 'staff'), async (c) => {
  const mediaId = (c.req.query('mediaId') ?? '').trim();
  const accountId = (c.req.query('accountId') ?? '').trim();
  if (!mediaId || !accountId) {
    return c.json({ success: false, error: 'mediaId と accountId が必要です' }, 400);
  }
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  const scan = await getLatestMediaScan(c.env.DB, mediaId);
  if (!scan || scan.line_account_id !== accountId) {
    return c.json({ success: true, data: { scan: null } });
  }
  return c.json({ success: true, data: { scan: serializeScan(scan) } });
});

/** 止まっている時の表示。staff も見られる。赤は使わない。 */
fileScan.get('/api/file-scans/health', requireRole('owner', 'admin', 'staff'), async (c) => {
  const accountId = (c.req.query('accountId') ?? '').trim();
  if (!accountId) return c.json({ success: false, error: 'accountId が必要です' }, 400);
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS pending_count, MIN(created_at) AS oldest_pending_at
       FROM media_file_scans WHERE line_account_id = ? AND status = 'pending'`,
  ).bind(accountId).first<{ pending_count: number; oldest_pending_at: string | null }>();
  const pendingCount = Number(row?.pending_count ?? 0);
  const oldest = row?.oldest_pending_at ? Date.parse(row.oldest_pending_at) : NaN;
  // 30分以上 pending のまま残っていれば「止まっている」と見せる。
  const stopped = pendingCount > 0 && !Number.isNaN(oldest) && Date.now() - oldest > 30 * 60_000;
  return c.json({
    success: true,
    data: { stopped, pendingCount, oldestPendingAt: row?.oldest_pending_at ?? null },
  });
});

fileScan.post('/api/file-scans/:id/retry', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  const body = await c.req.json<{ accountId?: unknown }>().catch(() => null);
  const accountId = typeof body?.accountId === 'string' ? body.accountId.trim() : '';
  if (!accountId) return inputError(c, { success: false, error: 'accountId が必要です' }, 400, ["accountId"]);
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  const scan = await c.env.DB.prepare(`SELECT * FROM media_file_scans WHERE id = ?`)
    .bind(c.req.param('id')).first<FileScanRow>();
  if (!scan || scan.line_account_id !== accountId) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  if (isPrivateFormDocumentScan(scan) && (scan.status !== 'pending' || scan.attempts >= FORM_FILE_SCAN_MAX_ATTEMPTS)) {
    return c.json({ success: false, error: 'この書類は検査をやり直せません。別のファイルを選んでください' }, 409);
  }
  // 二重実行は行の状態で抑える。pending の再試行は時刻だけ前倒しする。
  const now = new Date().toISOString();
  const retried = await c.env.DB.prepare(
    `UPDATE media_file_scans SET status = 'pending', confirmation_revision=confirmation_revision+1, next_retry_at = ?, updated_at = ? WHERE id = ? AND ${UNLOCKED_SCAN_SQL}`,
  ).bind(now, now, scan.id).run();
  if (!retried.meta.changes) return c.json({ success: false, error: 'このファイルは処理中です。読み直してください', current: serializeScan(scan) }, 409);
  await recordAuditEvent(c.env.DB, {
    lineAccountId: accountId,
    category: 'business',
    actorPrincipalId: c.get('staff')?.id ?? 'unknown',
    actorRole: c.get('staff')?.role ?? 'unknown',
    action: 'file_scan.retry',
    targetKind: 'file_scan',
    targetId: scan.id,
    result: 'success',
  }).catch(() => {});
  return c.json({ success: true, data: { id: scan.id, status: 'pending' } });
});

/** 誤りなので戻す。理由の記録は必須。quarantined だけ戻せる。 */
fileScan.post('/api/file-scans/:id/release', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  const body = await c.req.json<{ accountId?: unknown; reason?: unknown; expectedConfirmationRevision?: unknown }>().catch(() => null);
  const accountId = typeof body?.accountId === 'string' ? body.accountId.trim() : '';
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (!accountId || !reason) {
    return inputError(c, { success: false, error: 'accountId と理由が必要です' }, 400, ["accountId","reason"]);
  }
  const expected = body?.expectedConfirmationRevision;
  if (expected !== undefined && (!Number.isSafeInteger(expected) || Number(expected) < 1)) return c.json({ success: false, error: '確認した版が正しくありません' }, 400);
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  const scan = await c.env.DB.prepare(`SELECT * FROM media_file_scans WHERE id = ?`)
    .bind(c.req.param('id')).first<FileScanRow>();
  if (!scan || scan.line_account_id !== accountId) {
    if (expected !== undefined) return c.json({ success: false, error: '検査の状態が変わりました。一覧を読み直してください', current: null }, 409);
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  if (isPrivateFormDocumentScan(scan)) return c.json({ success: false, error: '回答の書類は戻せません。別のファイルを選んでください' }, 409);
  if (scan.status !== 'quarantined') {
    return c.json({ success: false, code: 'file_scan_not_quarantined', error: 'しまったファイルだけ戻せます', current: serializeScan(scan) }, 409);
  }
  const now = new Date().toISOString();
  const changed = await c.env.DB.prepare(
    `UPDATE media_file_scans
        SET status = 'clean', confirmation_revision=confirmation_revision+1, released_at = ?, release_reason = ?,
            released_by = ?, next_retry_at = NULL, updated_at = ?
      WHERE id = ? AND line_account_id = ? AND status = 'quarantined' AND (? IS NULL OR confirmation_revision = ?) AND ${UNLOCKED_SCAN_SQL}`,
  ).bind(now, reason.slice(0, 500), c.get('staff')?.id ?? null, now, scan.id, accountId, expected ?? null, expected ?? null).run();
  if (!changed.meta.changes) {
    const current = await c.env.DB.prepare('SELECT * FROM media_file_scans WHERE id=? AND line_account_id=?').bind(scan.id, accountId).first<FileScanRow>();
    return c.json({ success: false, error: '検査の状態が変わりました。一覧を読み直してください', current: current ? serializeScan(current) : null }, 409);
  }
  await recordAuditEvent(c.env.DB, {
    lineAccountId: accountId,
    category: 'business',
    actorPrincipalId: c.get('staff')?.id ?? 'unknown',
    actorRole: c.get('staff')?.role ?? 'unknown',
    action: 'file_scan.release',
    targetKind: 'file_scan',
    targetId: scan.id,
    result: 'success',
  }).catch(() => {});
  return c.json({ success: true, data: { id: scan.id, status: 'clean' } });
});

/** しまった・使えないファイルの消去。記録は監査に残し、中身は出さない。 */
fileScan.delete('/api/file-scans/:id', requireRole('owner', 'admin'), async (c) => {
  const accountId = (c.req.query('accountId') ?? '').trim();
  const supplied = c.req.query('expectedConfirmationRevision');
  const expected = supplied === undefined ? undefined : Number(supplied);
  if (supplied !== undefined && (!/^[1-9]\d*$/.test(supplied) || !Number.isSafeInteger(expected))) return c.json({ success: false, error: '確認した版が正しくありません' }, 400);
  if (!accountId) return c.json({ success: false, error: 'accountId が必要です' }, 400);
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  const scan = await c.env.DB.prepare(`SELECT * FROM media_file_scans WHERE id = ?`)
    .bind(c.req.param('id')).first<FileScanRow>();
  if (!scan || scan.line_account_id !== accountId) {
    if (expected !== undefined) return c.json({ success: false, error: '検査の状態が変わりました。一覧を読み直してください', current: null }, 409);
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  if (scan.status !== 'quarantined' && scan.status !== 'rejected') {
    return c.json({ success: false, code: 'file_scan_not_disposable', error: 'しまった・使えないファイルだけ消せます', current: serializeScan(scan) }, 409);
  }
  const db = c.env.DB;
  const confirmedTarget = await findR2Key(db, scan);
  if (expected !== undefined && !confirmedTarget && !isPrivateFormDocumentScan(scan)) {
    return c.json({ success: false, error: 'ファイルの状態が変わりました。一覧を読み直してください', current: serializeScan(scan) }, 409);
  }
  const lock = await claimFileDeletion(db, scanDeletionLockId(scan), c.get('staff')?.id ?? 'unknown', { id: scan.id, accountId, expected });
  if (!lock) {
    const current = await db.prepare('SELECT * FROM media_file_scans WHERE id=? AND line_account_id=?').bind(scan.id, accountId).first<FileScanRow>();
    return c.json({ success: false, error: '検査の状態が変わりました。一覧を読み直してください', current: current ? serializeScan(current) : null }, 409);
  }
  try {
    const claimed = await db.prepare('SELECT * FROM media_file_scans WHERE id=? AND line_account_id=?').bind(scan.id, accountId).first<FileScanRow>();
    const target = await findR2Key(db, scan);
    if (!claimed || (expected !== undefined && ((!target && !isPrivateFormDocumentScan(scan)) || target?.key !== confirmedTarget?.key))) {
      await releaseFileDeletion(db, lock);
      return c.json({ success: false, error: 'ファイルの状態が変わりました。一覧を読み直してください', current: claimed ? serializeScan(claimed) : null }, 409);
    }
    await fileDeletionGuard(db, lock).first();
    if (isPrivateFormDocumentScan(scan)) {
      if (!await purgeUnsafeFormDocuments(db, c.env.IMAGES, scan.id)) {
        await releaseFileDeletion(db, lock);
        return c.json({ success: false, error: '書類を消せませんでした。もう一度お試しください' }, 503);
      }
    } else if (target) {
      if (expected === undefined) await c.env.IMAGES.delete(target.key).catch(() => {});
      else await c.env.IMAGES.delete(target.key);
    }
    await db.batch([
      fileDeletionGuard(db, lock),
      ...(scan.media_id ? [db.prepare(`UPDATE media SET archived_at=?, archived_by=?, archive_reason=? WHERE id=? AND line_account_id=?${target && expected !== undefined ? ' AND r2_key=?' : ''}`)
        .bind(new Date().toISOString(), c.get('staff')?.id ?? null, '検査でしまったため', scan.media_id, accountId, ...(target && expected !== undefined ? [target.key] : []))] : []),
      ...(!isPrivateFormDocumentScan(scan) ? [db.prepare('DELETE FROM media_file_scans WHERE id=? AND line_account_id=? AND confirmation_revision=?').bind(scan.id, accountId, claimed.confirmation_revision),
        db.prepare("SELECT json(CASE WHEN changes()=1 THEN '{}' ELSE 'FILE_DELETE_CONFLICT' END)")] : []),
      db.prepare("UPDATE operation_audit SET action='released' WHERE id=? AND action='deleting' AND json_extract(detail_json,'$.token')=?").bind(lock.id, lock.token),
    ]);
  } catch (error) {
    await releaseFileDeletion(db, lock).catch(() => {});
    if (/malformed JSON/i.test(String(error))) return c.json({ success: false, error: '検査の状態が変わりました。一覧を読み直してください', current: null }, 409);
    return c.json({ success: false, error: 'ファイルを消せませんでした。もう一度お試しください' }, 503);
  }
  await recordAuditEvent(c.env.DB, {
    lineAccountId: accountId,
    category: 'business',
    actorPrincipalId: c.get('staff')?.id ?? 'unknown',
    actorRole: c.get('staff')?.role ?? 'unknown',
    action: 'file_scan.delete',
    targetKind: 'file_scan',
    targetId: scan.id,
    result: 'success',
  }).catch(() => {});
  return c.json({ success: true, data: { id: scan.id } });
});

fileScan.get('/api/file-scans/config', requireRole('owner', 'admin'), async (c) => {
  const accountId = (c.req.query('accountId') ?? '').trim();
  if (!accountId) return c.json({ success: false, error: 'accountId が必要です' }, 400);
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  const config = await getFileScanConfig(c.env.DB, accountId);
  return c.json({
    success: true,
    data: {
      config: config ? serializeConfig(config, c.env) : null,
    },
  });
});

fileScan.put('/api/file-scans/config', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  const body = await c.req.json<{
    accountId?: unknown;
    externalProvider?: unknown;
    externalEndpointUrl?: unknown;
    externalSecretRef?: unknown;
    externalTimeoutMs?: unknown;
    maxBytesOverride?: unknown;
    maxPixelsOverride?: unknown;
    expectedConfirmationRevision?: unknown;
  }>().catch(() => null);
  const accountId = typeof body?.accountId === 'string' ? body.accountId.trim() : '';
  if (!accountId) return inputError(c, { success: false, error: 'accountId が必要です' }, 400, ["accountId"]);
  const expected = body?.expectedConfirmationRevision;
  if (expected !== undefined && (!Number.isSafeInteger(expected) || Number(expected) < 1)) return c.json({ success: false, error: '確認した版が正しくありません' }, 400);
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  const text = (v: unknown, max: number): string | null => {
    if (v == null || v === '') return null;
    return typeof v === 'string' ? v.trim().slice(0, max) || null : null;
  };
  const provider = text(body?.externalProvider, 80);
  for (const key of ['externalEndpointUrl', 'externalSecretRef'] as const) {
    if (body?.[key] != null && typeof body[key] !== 'string') {
      return inputError(c, { success: false, error: '文字で入力してください' }, 400, [key]);
    }
  }
  // 宛先・名前は切り詰めず、不正な入力全体を拒否する。
  const endpoint = typeof body?.externalEndpointUrl === 'string' ? body.externalEndpointUrl.trim() || null : null;
  const secretRef = typeof body?.externalSecretRef === 'string' ? body.externalSecretRef.trim() || null : null;
  const url = endpoint ? allowedFileScanEndpoint(endpoint, c.env.FILE_SCAN_ALLOWED_PAIRS, secretRef) : null;
  if (endpoint && !url) {
    return inputError(c, { success: false, error: '送り先と鍵の名前は、運営が許可した同じ組で指定してください。送り先は公開ホストの https、資格情報なし、既定ポートだけ使えます' }, 400, ['externalEndpointUrl', 'externalSecretRef']);
  }
  if ((provider || endpoint || secretRef) && !isFileScanSecretRef(secretRef)) {
    return inputError(c, { success: false, error: '鍵の名前は FILE_SCAN_SECRET_ で始まる大文字・数字・下線の120文字以内で指定してください' }, 400, ['externalSecretRef']);
  }
  if ((provider || endpoint || secretRef) && !(provider && endpoint)) {
    return inputError(c, { success: false, error: '外の検査を使う時は提供元と宛先の両方が必要です' }, 400, ["externalProvider","externalEndpointUrl","externalSecretRef"]);
  }
  const timeoutMs = Number(body?.externalTimeoutMs);
  const numOrNull = (v: unknown): number | null => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  };
  const now = new Date().toISOString();
  const endpointHost = url?.hostname ?? null;
  // 共通監査は長い文字列を秘密値として伏せる。ホストだけを短い断片で
  // 保存すれば、その保護を緩めず長い正式ホストも正確に復元できる。
  // 3文字の断片は電話番号の伏せ字にも該当しない。1配列50項目の上限を
  // 守って二段に分け、最大253文字をすべて保存する。flat.join('')で復元。
  const auditHost = endpointHost && (endpointHost.length > 200 || /[A-Za-z0-9_-]{32,}|[0-9-]{6,}/.test(endpointHost))
    ? { endpointHostParts: [endpointHost.slice(0, 150).match(/.{1,3}/g)!, ...(endpointHost.length > 150 ? [endpointHost.slice(150).match(/.{1,3}/g)!] : [])] }
    : { endpointHost };
  const args = [provider, endpoint, secretRef, Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10000,
    numOrNull(body?.maxBytesOverride), numOrNull(body?.maxPixelsOverride), c.get('staff')?.id ?? null, now];
  const statement = expected === undefined ? c.env.DB.prepare(
    `INSERT INTO file_scan_configs
      (line_account_id, external_provider, external_endpoint_url, external_secret_ref,
       external_timeout_ms, max_bytes_override, max_pixels_override, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (line_account_id) DO UPDATE SET
       external_provider = excluded.external_provider,
       external_endpoint_url = excluded.external_endpoint_url,
       external_secret_ref = excluded.external_secret_ref,
       external_timeout_ms = excluded.external_timeout_ms,
       max_bytes_override = excluded.max_bytes_override,
       max_pixels_override = excluded.max_pixels_override,
       confirmation_revision = file_scan_configs.confirmation_revision + 1,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
  ).bind(
    accountId, ...args,
  ) : c.env.DB.prepare(`UPDATE file_scan_configs SET external_provider=?, external_endpoint_url=?, external_secret_ref=?,
    external_timeout_ms=?, max_bytes_override=?, max_pixels_override=?, updated_by=?, updated_at=?,
    confirmation_revision=confirmation_revision+1 WHERE line_account_id=? AND confirmation_revision=?`).bind(...args, accountId, expected);
  // 設定と監査を同じbatchで確定。宛先のパス・クエリ・鍵の値は記録しない。
  try { await c.env.DB.batch([statement, ...(expected === undefined ? [] : [c.env.DB.prepare("SELECT json(CASE WHEN changes()=1 THEN '{}' ELSE 'FILE_SCAN_CONFIG_CONFLICT' END)")]), auditEventStatement(c.env.DB, {
    tenantId: c.get('staff')?.tenantId,
    lineAccountId: accountId,
    category: 'business',
    actorPrincipalId: c.get('staff')?.id ?? 'unknown',
    actorRole: c.get('staff')?.role ?? 'unknown',
    action: 'file_scan.config.update',
    targetKind: 'file_scan_config',
    targetId: accountId,
    result: 'success',
    after: auditHost,
    createdAt: now,
  })]); } catch (error) {
    if (expected !== undefined && /malformed JSON/i.test(String(error))) {
      const current = await getFileScanConfig(c.env.DB, accountId);
      return c.json({ success: false, error: '設定が変わりました。読み直してください', current: current ? serializeConfig(current, c.env) : null }, 409);
    }
    throw error;
  }
  return c.json({ success: true, data: { lineAccountId: accountId } });
});

export async function ensureFileScanForUpload(args: {
  db: D1Database;
  lineAccountId: string | null;
  subjectKind: FileScanSubjectKind;
  subjectId: string;
  mediaId?: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}): Promise<FileScanRow> {
  const existing = await getFileScanBySubject(args.db, args.subjectKind, args.subjectId);
  if (existing) return existing;
  return createFileScan(args.db, {
    lineAccountId: args.lineAccountId,
    subjectKind: args.subjectKind,
    subjectId: args.subjectId,
    mediaId: args.mediaId ?? null,
    filename: args.filename,
    mimeType: args.mimeType,
    sizeBytes: args.sizeBytes,
  });
}
