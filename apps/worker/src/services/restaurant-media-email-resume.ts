import type { Env } from '../worker-env.js';
import { dbFor } from './db-router.js';
import {
  CLAIM_LEASE_MS,
  isReservationEmailMedia,
  loadStoreMediaEmailImportStates,
  type RestaurantMediaRow,
  type StoreMediaEmailImportState,
} from './restaurant-media-email-import.js';
import { processStoredRestaurantEmail } from './restaurant-reservation-email.js';

export type HeldEmailResumeAction = 'import' | 'archive';

type CandidateHeldRow = {
  inbound_email_id: string;
  sync_event_id: string;
  r2_key: string;
  payload_json: string;
};

export async function drainHeldReservationEmails(
  env: Env['Bindings'],
  storeId: string,
  media: RestaurantMediaRow,
  options: { now?: Date } = {},
): Promise<{ importedCount: number; failedHeldCount: number; skippedCount: number }> {
  const db = dbFor(env, storeId);
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const leaseExpiresIso = new Date(now.getTime() + CLAIM_LEASE_MS).toISOString();

  const candidates = await db
    .prepare(`SELECT h.inbound_email_id, h.sync_event_id, e.r2_key, ev.payload_json
      FROM rt_held_reservation_emails h
      JOIN rt_inbound_emails e ON e.id = h.inbound_email_id
      JOIN rt_sync_events ev ON ev.id = h.sync_event_id
      WHERE h.store_id = ? AND h.media_id = ?
        AND (h.state = 'held' OR (h.state = 'processing' AND h.claim_expires_at IS NOT NULL AND datetime(h.claim_expires_at) <= datetime(?)))
        AND datetime(h.expires_at) > datetime(?)
        AND e.r2_key <> '' AND e.status <> 'raw_deleted'
      ORDER BY datetime(e.received_at) ASC, h.rowid ASC`)
    .bind(storeId, media.id, nowIso, nowIso)
    .all<CandidateHeldRow>();

  let importedCount = 0;
  let failedHeldCount = 0;
  let skippedCount = 0;

  for (const row of candidates.results) {
    const claimToken = crypto.randomUUID();
    const claimed = await db
      .prepare(`UPDATE rt_held_reservation_emails
        SET state = 'processing', claim_token = ?, claim_expires_at = ?, updated_at = datetime('now')
        WHERE inbound_email_id = ?
          AND store_id = ? AND media_id = ?
          AND (state = 'held' OR (state = 'processing' AND claim_expires_at IS NOT NULL AND datetime(claim_expires_at) <= datetime(?)))
          AND datetime(expires_at) > datetime(?)
          AND EXISTS (
            SELECT 1 FROM rt_inbound_emails e
            WHERE e.id = rt_held_reservation_emails.inbound_email_id AND e.r2_key <> '' AND e.status <> 'raw_deleted'
          )
          AND NOT EXISTS (
            SELECT 1 FROM rt_store_media_email_settings s
            WHERE s.store_id = ? AND s.media_id = ? AND s.enabled = 0
          )`)
      .bind(claimToken, leaseExpiresIso, row.inbound_email_id, storeId, media.id, nowIso, nowIso, storeId, media.id)
      .run();

    if (!claimed.meta.changes) {
      skippedCount += 1;
      continue;
    }

    let fallbackSubject = '';
    let fallbackDate: string | null = null;
    try {
      const payload = JSON.parse(row.payload_json) as { subject?: unknown; dateHeader?: unknown };
      if (typeof payload.subject === 'string') fallbackSubject = payload.subject;
      if (typeof payload.dateHeader === 'string') fallbackDate = payload.dateHeader;
    } catch {
      // payload_json が最小構成でも R2 原文のヘッダから復元する。
    }

    const result = await processStoredRestaurantEmail(
      {
        env,
        storeId,
        inboundEmailId: row.inbound_email_id,
        eventId: row.sync_event_id,
        objectKey: row.r2_key,
        media,
        fallbackSubject,
        fallbackDate,
      },
      { mode: 'resume', claimToken, now: options.now },
    );

    if (result.outcome === 'processed' || result.outcome === 'quarantined') {
      importedCount += result.outcome === 'processed' ? 1 : 0;
    } else if (result.outcome === 'retry_later') {
      failedHeldCount += 1;
    } else {
      skippedCount += 1;
    }
  }

  return { importedCount, failedHeldCount, skippedCount };
}

export async function saveStoreMediaEmailImportSetting(input: {
  env: Env['Bindings'];
  storeId: string;
  mediaCode: string;
  enabled: boolean;
  expectedVersion: number;
  heldAction?: HeldEmailResumeAction;
  actorId: string;
  now?: Date;
}): Promise<
  | { ok: false; status: 400 | 409; code?: string; error: string }
  | {
      ok: true;
      data: StoreMediaEmailImportState & {
        storeId: string;
        code: string;
        importedCount: number;
        archivedCount: number;
        failedHeldCount: number;
      };
    }
> {
  const db = dbFor(input.env, input.storeId);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const media = await db
    .prepare('SELECT id, code, name, parser_key, is_active, accepts_reservations FROM rt_media WHERE code = ?')
    .bind(input.mediaCode)
    .first<RestaurantMediaRow & { is_active: number; accepts_reservations: number }>();

  if (!media || !isReservationEmailMedia(media)) {
    return { ok: false, status: 400, error: '予約メールの対象の媒体ではありません' };
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    return { ok: false, status: 400, error: '読み込んだ版を確認してください' };
  }
  if (input.enabled && input.heldAction !== 'import' && input.heldAction !== 'archive') {
    return { ok: false, status: 400, error: '保留中のメールの扱いを選んでください' };
  }

  const saved = await db
    .prepare(`INSERT INTO rt_store_media_email_settings (store_id, media_id, enabled, version, updated_by, updated_at)
      SELECT ?, ?, ?, 1, ?, datetime('now')
      WHERE ? = 0 OR EXISTS (SELECT 1 FROM rt_store_media_email_settings WHERE store_id = ? AND media_id = ?)
      ON CONFLICT(store_id, media_id) DO UPDATE SET
        enabled = excluded.enabled,
        version = CASE WHEN rt_store_media_email_settings.enabled = 1 AND excluded.enabled = 1 AND ? = 1
          THEN rt_store_media_email_settings.version ELSE rt_store_media_email_settings.version + 1 END,
        updated_by = excluded.updated_by,
        updated_at = datetime('now')
      WHERE rt_store_media_email_settings.version = ?`)
    .bind(
      input.storeId,
      media.id,
      input.enabled ? 1 : 0,
      input.actorId,
      input.expectedVersion,
      input.storeId,
      media.id,
      input.enabled && input.heldAction === 'import' ? 1 : 0,
      input.expectedVersion,
    )
    .run();

  if (!saved.meta.changes) {
    return { ok: false, status: 409, code: 'version_conflict', error: '設定が更新されました。読み直してください' };
  }

  const settingRow = await db
    .prepare('SELECT enabled, version FROM rt_store_media_email_settings WHERE store_id = ? AND media_id = ?')
    .bind(input.storeId, media.id)
    .first<{ enabled: number; version: number }>();
  const newVersion = settingRow!.version;

  let importedCount = 0;
  let archivedCount = 0;
  let failedHeldCount = 0;

  if (input.enabled) {
    if (input.heldAction === 'archive') {
      const archived = await db
        .prepare(`UPDATE rt_held_reservation_emails
          SET state = 'archived', claim_token = NULL, claim_expires_at = NULL, updated_at = datetime('now')
          WHERE store_id = ? AND media_id = ? AND state = 'held'
            AND datetime(expires_at) > datetime(?)
            AND EXISTS (
              SELECT 1 FROM rt_store_media_email_settings
              WHERE store_id = ? AND media_id = ? AND enabled = 1 AND version = ?
            )`)
        .bind(input.storeId, media.id, nowIso, input.storeId, media.id, newVersion)
        .run();
      archivedCount = archived.meta.changes ?? 0;
    } else {
      const drained = await drainHeldReservationEmails(input.env, input.storeId, media, { now });
      importedCount = drained.importedCount;
      failedHeldCount = drained.failedHeldCount;
    }
  }

  const states = await loadStoreMediaEmailImportStates(db, input.storeId, now);
  const currentState = states.get(media.id)!;
  return {
    ok: true,
    data: {
      storeId: input.storeId,
      code: media.code,
      ...currentState,
      importedCount,
      archivedCount,
      failedHeldCount,
    },
  };
}
