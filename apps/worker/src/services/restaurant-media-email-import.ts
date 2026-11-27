import { auditEventStatement } from '@line-crm/db';
import { jstCalendar as japanCalendar } from '@line-crm/shared';
import { logger } from '@line-crm/shared/server';
import type { Env } from '../worker-env.js';
import { dbFor } from './db-router.js';
import type { ParsedReservationEmail } from './parsers/types.js';
import { reconcileRestaurantInventory } from './restaurant-inventory-rules.js';

export const HELD_RESERVATION_EMAIL_RETENTION_DAYS = 30;
export const HELD_RESERVATION_EMAIL_WARNING_DAYS = 7;
export const CLAIM_LEASE_MS = 5 * 60_000;
// 6時間ごとの掃除と処理中リースの余裕を期限から先に差し引く。
const RETENTION_SWEEP_BUFFER_MS = 6 * 60 * 60_000 + CLAIM_LEASE_MS;
export const DEFAULT_STAY_MINUTES = 120;
const DEFAULT_HOLD_END_HOUR = 23;

export type RestaurantMediaRow = {
  id: string;
  code: 'retty' | 'gurunavi' | 'tabelog' | 'hotpepper';
  name: string;
  parser_key: string;
};

export type StoreMediaEmailImportState = {
  emailImportSupported: boolean;
  emailImportEnabled: boolean;
  emailImportVersion: number;
  heldCount: number;
  expiringHeldCount: number;
  nearestHeldExpiresAt: string | null;
  daysUntilNearestHeldExpiry: number | null;
  overdueCount: number;
  upcomingExpiringCount: number;
  daysUntilNearestUpcomingHeldExpiry: number | null;
};

export function nextBusinessDayHoldExpiry(startsFrom: string, endHour = DEFAULT_HOLD_END_HOUR): string {
  const source = new Date(startsFrom);
  const jstDate = japanCalendar(source);
  let year = jstDate.getUTCFullYear();
  let month = jstDate.getUTCMonth();
  let day = jstDate.getUTCDate();
  do {
    const candidate = new Date(Date.UTC(year, month, day + 1));
    year = candidate.getUTCFullYear();
    month = candidate.getUTCMonth();
    day = candidate.getUTCDate();
  } while ([0, 6].includes(new Date(Date.UTC(year, month, day)).getUTCDay()));
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(endHour).padStart(2, '0')}:59:59+09:00`;
}

export function isReservationEmailMedia(media: {
  code: string;
  is_active: number;
  accepts_reservations: number;
}): boolean {
  return (
    media.accepts_reservations === 1 &&
    media.is_active === 1 &&
    media.code !== 'google' &&
    media.code !== 'google_reservation'
  );
}

export function normalizeSqlTimestamp(value: string): string {
  return /(?:Z|[+-]\d\d:\d\d)$/i.test(value) ? value : `${value.replace(' ', 'T')}Z`;
}

export function heldExpiryMetrics(
  expiresAtList: ReadonlyArray<string>,
  now = new Date(),
): {
  heldCount: number;
  expiringHeldCount: number;
  nearestHeldExpiresAt: string | null;
  daysUntilNearestHeldExpiry: number | null;
  overdueCount: number;
  upcomingExpiringCount: number;
  daysUntilNearestUpcomingHeldExpiry: number | null;
} {
  const nowMs = now.getTime();
  const warningWindowMs = HELD_RESERVATION_EMAIL_WARNING_DAYS * 86_400_000;
  let heldCount = 0;
  let expiringHeldCount = 0;
  let nearestMs = Infinity;
  let nearestIso: string | null = null;
  let overdueCount = 0;
  let upcomingExpiringCount = 0;
  let nearestUpcomingMs = Infinity;

  for (const raw of expiresAtList) {
    const iso = normalizeSqlTimestamp(raw);
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) continue;
    heldCount += 1;
    const remainingMs = ms - nowMs;
    if (remainingMs <= 0) overdueCount += 1;
    else if (remainingMs <= warningWindowMs) { upcomingExpiringCount += 1; nearestUpcomingMs = Math.min(nearestUpcomingMs, ms); }
    if (remainingMs <= warningWindowMs) expiringHeldCount += 1;
    if (ms < nearestMs) {
      nearestMs = ms;
      nearestIso = iso;
    }
  }

  return {
    heldCount,
    expiringHeldCount,
    nearestHeldExpiresAt: nearestIso,
    daysUntilNearestHeldExpiry:
      nearestIso !== null ? Math.max(0, Math.ceil((nearestMs - nowMs) / 86_400_000)) : null,
    overdueCount,
    upcomingExpiringCount,
    daysUntilNearestUpcomingHeldExpiry: Number.isFinite(nearestUpcomingMs) ? Math.ceil((nearestUpcomingMs - nowMs) / 86_400_000) : null,
  };
}

export async function loadStoreMediaEmailImportStates(
  db: D1Database,
  storeId: string,
  now = new Date(),
): Promise<Map<string, StoreMediaEmailImportState>> {
  const [mediaRows, settingRows, heldRows] = await Promise.all([
    db
      .prepare('SELECT id, code, is_active, accepts_reservations FROM rt_media')
      .all<{ id: string; code: string; is_active: number; accepts_reservations: number }>(),
    db
      .prepare('SELECT media_id, enabled, version FROM rt_store_media_email_settings WHERE store_id = ?')
      .bind(storeId)
      .all<{ media_id: string; enabled: number; version: number }>(),
    db
      .prepare(`SELECT h.media_id, h.expires_at, h.state
        FROM rt_held_reservation_emails h JOIN rt_inbound_emails e ON e.id = h.inbound_email_id
        WHERE h.store_id = ? AND h.state IN ('held', 'processing', 'archived', 'processed', 'expiring')
          AND e.r2_key <> '' AND e.status <> 'raw_deleted'`)
      .bind(storeId)
      .all<{ media_id: string; expires_at: string; state: string }>(),
  ]);

  const settingsByMedia = new Map(settingRows.results.map((row) => [row.media_id, row]));
  const heldByMedia = new Map<string, string[]>();
  const pendingByMedia = new Map<string, number>();
  for (const row of heldRows.results) {
    const list = heldByMedia.get(row.media_id) ?? [];
    list.push(row.expires_at);
    heldByMedia.set(row.media_id, list);
    if ((row.state === 'held' || row.state === 'processing') && Date.parse(normalizeSqlTimestamp(row.expires_at)) > now.getTime()) pendingByMedia.set(row.media_id, (pendingByMedia.get(row.media_id) ?? 0) + 1);
  }

  const out = new Map<string, StoreMediaEmailImportState>();
  for (const media of mediaRows.results) {
    const supported = isReservationEmailMedia(media);
    const setting = settingsByMedia.get(media.id);
    const metrics = supported
      ? heldExpiryMetrics(heldByMedia.get(media.id) ?? [], now)
      : { heldCount: 0, expiringHeldCount: 0, nearestHeldExpiresAt: null, daysUntilNearestHeldExpiry: null, overdueCount: 0, upcomingExpiringCount: 0, daysUntilNearestUpcomingHeldExpiry: null };
    out.set(media.id, {
      emailImportSupported: supported,
      emailImportEnabled: supported ? (setting ? setting.enabled === 1 : true) : false,
      emailImportVersion: setting?.version ?? 0,
      ...metrics,
      heldCount: pendingByMedia.get(media.id) ?? 0,
    });
  }
  return out;
}

export async function loadStoreMediaEmailImportSnapshot(
  db: D1Database,
  storeId: string,
  mediaId: string,
): Promise<{ enabled: boolean; version: number }> {
  const row = await db
    .prepare('SELECT enabled, version FROM rt_store_media_email_settings WHERE store_id = ? AND media_id = ?')
    .bind(storeId, mediaId)
    .first<{ enabled: number; version: number }>();
  if (!row) return { enabled: true, version: 0 };
  return { enabled: row.enabled === 1, version: row.version };
}

async function computeHeldExpiryIso(
  db: D1Database,
  inboundEmailId: string,
  now: Date,
): Promise<{ heldAt: string; expiresAt: string }> {
  const email = await db
    .prepare('SELECT received_at FROM rt_inbound_emails WHERE id = ?')
    .bind(inboundEmailId)
    .first<{ received_at: string }>();
  const baseMs = email?.received_at ? Date.parse(normalizeSqlTimestamp(email.received_at)) : NaN;
  const originMs = Number.isFinite(baseMs) ? baseMs : now.getTime();
  return {
    heldAt: now.toISOString(),
    expiresAt: new Date(originMs + HELD_RESERVATION_EMAIL_RETENTION_DAYS * 86_400_000 - RETENTION_SWEEP_BUFFER_MS).toISOString(),
  };
}

export async function holdInboundReservationEmail(
  db: D1Database,
  input: {
    inboundEmailId: string;
    storeId: string;
    mediaId: string;
    syncEventId: string;
    mediaCode: string;
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  const { heldAt, expiresAt } = await computeHeldExpiryIso(db, input.inboundEmailId, now);
  await db.batch([
    db
      .prepare(`INSERT INTO rt_held_reservation_emails
        (inbound_email_id, store_id, media_id, sync_event_id, state, held_at, expires_at, updated_at)
        VALUES (?, ?, ?, ?, 'held', ?, ?, datetime('now'))
        ON CONFLICT(inbound_email_id) DO NOTHING`)
      .bind(input.inboundEmailId, input.storeId, input.mediaId, input.syncEventId, heldAt, expiresAt),
    db
      .prepare(`UPDATE rt_sync_events
        SET payload_json = json_patch(payload_json, ?), error_message = NULL
        WHERE id = ? AND status = 'received'`)
      .bind(JSON.stringify({ media: input.mediaCode, held: true }), input.syncEventId),
  ]);
}

function holdEndHour(env: Env['Bindings']): number {
  const parsed = Number(env.RESTAURANT_REQUEST_HOLD_END_HOUR);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 23 ? parsed : DEFAULT_HOLD_END_HOUR;
}

function endAt(startsAt: string, stayMinutes: number): string {
  return new Date(new Date(startsAt).getTime() + stayMinutes * 60_000).toISOString();
}

const LIVE_SETTING_UNCHANGED_SQL = `(
  (? = 0 AND NOT EXISTS (SELECT 1 FROM rt_store_media_email_settings WHERE store_id = ? AND media_id = ?))
  OR EXISTS (SELECT 1 FROM rt_store_media_email_settings WHERE store_id = ? AND media_id = ? AND enabled = 1 AND version = ?)
)`;

const RESUME_CLAIM_ACTIVE_SQL = `(
  EXISTS (
    SELECT 1 FROM rt_held_reservation_emails
    WHERE inbound_email_id = ? AND store_id = ? AND media_id = ?
      AND state = 'processing' AND claim_token = ?
      AND datetime(expires_at) > datetime(?)
      AND claim_expires_at IS NOT NULL AND datetime(claim_expires_at) > datetime(?)
  )
  AND NOT EXISTS (
    SELECT 1 FROM rt_store_media_email_settings
    WHERE store_id = ? AND media_id = ? AND enabled = 0
  )
)`;

export async function isLiveImportSettingUnchanged(
  db: D1Database,
  storeId: string,
  mediaId: string,
  observedVersion: number,
): Promise<boolean> {
  const current = await loadStoreMediaEmailImportSnapshot(db, storeId, mediaId);
  return current.enabled && current.version === observedVersion;
}

/** 失敗時も設定版または処理権を同じD1バッチで確認する。 */
export async function quarantineReservationEmailAtomically(input: {
  env: Env['Bindings']; storeId: string; inboundEmailId: string; eventId: string;
  media: RestaurantMediaRow; mode: 'live' | 'resume'; observedVersion?: number;
  claimToken?: string; now: Date; payload: Record<string, unknown>; reason: string;
}): Promise<'quarantined' | 'held' | 'skipped'> {
  const db = dbFor(input.env, input.storeId);
  const live = input.mode === 'live';
  const guard = live ? LIVE_SETTING_UNCHANGED_SQL : RESUME_CLAIM_ACTIVE_SQL;
  const params = live
    ? [input.observedVersion ?? 0, input.storeId, input.media.id, input.storeId, input.media.id, input.observedVersion ?? 0]
    : [input.inboundEmailId, input.storeId, input.media.id, input.claimToken ?? '', input.now.toISOString(), input.now.toISOString(), input.storeId, input.media.id];
  const pending = "EXISTS (SELECT 1 FROM rt_sync_events WHERE id = ? AND status = 'received')";
  const statements = [
    db.prepare(`UPDATE rt_inbound_emails SET status = 'quarantined', quarantine_reason = ? WHERE id = ? AND ${pending} AND ${guard}`)
      .bind(input.reason, input.inboundEmailId, input.eventId, ...params),
    db.prepare(`UPDATE rt_sync_events SET status = 'failed', payload_json = json_patch(payload_json, ?), error_message = ?, processed_at = datetime('now')
      WHERE id = ? AND status = 'received' AND ${guard}`)
      .bind(JSON.stringify(input.payload), input.reason, input.eventId, ...params),
  ];
  if (live) {
    const { heldAt, expiresAt } = await computeHeldExpiryIso(db, input.inboundEmailId, input.now);
    statements.push(db.prepare(`INSERT INTO rt_held_reservation_emails
      (inbound_email_id, store_id, media_id, sync_event_id, state, held_at, expires_at, updated_at)
      SELECT ?, ?, ?, ?, 'held', ?, ?, datetime('now') WHERE ${pending} AND NOT (${guard})
      ON CONFLICT(inbound_email_id) DO NOTHING`)
      .bind(input.inboundEmailId, input.storeId, input.media.id, input.eventId, heldAt, expiresAt, input.eventId, ...params));
    statements.push(db.prepare(`UPDATE rt_sync_events SET payload_json = json_patch(payload_json, ?), error_message = NULL
      WHERE id = ? AND status = 'received' AND NOT (${guard}) AND EXISTS
        (SELECT 1 FROM rt_held_reservation_emails WHERE inbound_email_id = ? AND state = 'held')`)
      .bind(JSON.stringify({ media: input.media.code, held: true }), input.eventId, ...params, input.inboundEmailId));
  } else {
    statements.push(db.prepare(`UPDATE rt_held_reservation_emails SET state = 'processed', claim_token = NULL,
      claim_expires_at = NULL, last_error = ?, updated_at = datetime('now')
      WHERE inbound_email_id = ? AND state = 'processing' AND claim_token = ? AND ${guard}`)
      .bind(input.reason, input.inboundEmailId, input.claimToken ?? '', ...params));
    statements.push(db.prepare(`UPDATE rt_held_reservation_emails SET state = 'held', claim_token = NULL,
      claim_expires_at = NULL, updated_at = datetime('now') WHERE inbound_email_id = ? AND state = 'processing'
      AND claim_token = ? AND EXISTS (SELECT 1 FROM rt_store_media_email_settings WHERE store_id = ? AND media_id = ? AND enabled = 0)`)
      .bind(input.inboundEmailId, input.claimToken ?? '', input.storeId, input.media.id));
  }
  const result = await db.batch(statements);
  if ((result[1]?.meta.changes ?? 0) > 0) return 'quarantined';
  if (live && (result[2]?.meta.changes ?? 0) > 0) return 'held';
  if (!live && (result[3]?.meta.changes ?? 0) > 0) return 'held';
  return 'skipped';
}

/**
 * 予約台帳への書き込みと「取り込み設定が有効かつ未変更（または再開claimが有効）」の判定を
 * D1 の単一トランザクション（db.batch）で原子的に行う。
 * 解析中に設定が停止・変更された場合は予約を書き込まず保留（held）へ落とす。
 */
export async function commitReservationEmailAtomically(input: {
  env: Env['Bindings'];
  storeId: string;
  inboundEmailId: string;
  eventId: string;
  media: RestaurantMediaRow;
  parsed: ParsedReservationEmail;
  parserVersion: string;
  mode: 'live' | 'resume';
  observedVersion?: number;
  claimToken?: string;
  now?: Date;
}): Promise<'processed' | 'held' | 'skipped'> {
  const db = dbFor(input.env, input.storeId);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const isLive = input.mode === 'live';
  const guardSql = isLive ? LIVE_SETTING_UNCHANGED_SQL : RESUME_CLAIM_ACTIVE_SQL;
  const guardParams = isLive
    ? [input.observedVersion ?? 0, input.storeId, input.media.id, input.storeId, input.media.id, input.observedVersion ?? 0]
    : [input.inboundEmailId, input.storeId, input.media.id, input.claimToken ?? '', nowIso, nowIso, input.storeId, input.media.id];

  const statements: D1PreparedStatement[] = [];
  let hasReservationStatement = false;

  if (input.parsed.kind === 'digest') {
    statements.push(
      db
        .prepare(`INSERT INTO rt_email_digests
          (id, store_id, media_id, target_date, reported_count, inbound_email_id)
          SELECT ?, ?, ?, ?, ?, ?
          WHERE ${guardSql}
          ON CONFLICT(inbound_email_id) DO NOTHING`)
        .bind(
          crypto.randomUUID(),
          input.storeId,
          input.media.id,
          input.parsed.targetDate,
          input.parsed.reportedCount,
          input.inboundEmailId,
          ...guardParams,
        ),
    );
  } else if (input.parsed.kind !== 'notice') {
    hasReservationStatement = true;
    const stayMinutes = input.parsed.stayMinutes ?? DEFAULT_STAY_MINUTES;
    const holdExpiresAt =
      input.parsed.kind === 'request'
        ? nextBusinessDayHoldExpiry(input.parsed.sourceUpdatedAt!, holdEndHour(input.env))
        : null;
    const status =
      input.parsed.kind === 'confirmed'
        ? 'confirmed'
        : input.parsed.kind === 'request'
          ? 'pending'
          : 'cancelled';
    const note = input.parsed.courseName ? `媒体コース: ${input.parsed.courseName}` : null;
    statements.push(
      db
        .prepare(`INSERT INTO rt_reservations
          (id, store_id, source, external_id, customer_name, customer_phone, guest_count,
           starts_at, ends_at, status, note, source_updated_at, media_id, hold_expires_at,
           cancel_reason, stay_minutes, media_store_code, table_label, inbound_email_id,
           parser_key, parser_version)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE ${guardSql}
          ON CONFLICT(store_id, source, external_id) DO UPDATE SET
            confirmation_revision = rt_reservations.confirmation_revision + 1,
            customer_name = excluded.customer_name,
            customer_phone = excluded.customer_phone,
            guest_count = excluded.guest_count,
            starts_at = excluded.starts_at,
            ends_at = excluded.ends_at,
            status = excluded.status,
            note = excluded.note,
            source_updated_at = excluded.source_updated_at,
            media_id = excluded.media_id,
            hold_expires_at = excluded.hold_expires_at,
            cancel_reason = excluded.cancel_reason,
            stay_minutes = excluded.stay_minutes,
            media_store_code = excluded.media_store_code,
            table_label = excluded.table_label,
            inbound_email_id = excluded.inbound_email_id,
            parser_key = excluded.parser_key,
            parser_version = excluded.parser_version,
            updated_at = datetime('now')
          WHERE ${guardSql}
            AND excluded.source_updated_at >= COALESCE(rt_reservations.source_updated_at, '')`)
        .bind(
          crypto.randomUUID(),
          input.storeId,
          input.media.code,
          input.parsed.externalId,
          input.parsed.customerName ?? '(氏名未取得)',
          input.parsed.customerPhone ?? null,
          input.parsed.guestCount,
          input.parsed.startsAt,
          endAt(input.parsed.startsAt!, stayMinutes),
          status,
          note,
          input.parsed.sourceUpdatedAt,
          input.media.id,
          holdExpiresAt,
          input.parsed.cancelReason ?? null,
          stayMinutes,
          input.parsed.mediaStoreCode ?? null,
          input.parsed.tableLabel ?? null,
          input.inboundEmailId,
          input.media.parser_key,
          input.parserVersion,
          ...guardParams,
          ...guardParams,
        ),
    );
  }

  const syncEventIndex = statements.length;
  statements.push(
    db
      .prepare(`UPDATE rt_sync_events
        SET status = 'processed',
            payload_json = json_patch(payload_json, ?),
            error_message = NULL,
            processed_at = datetime('now')
        WHERE id = ? AND ${guardSql}`)
      .bind(
        JSON.stringify({
          media: input.media.code,
          kind: input.parsed.kind,
          parserVersion: input.parserVersion,
          ...(hasReservationStatement ? { outcome: 'inserted_or_updated' } : {}),
          held: false,
        }),
        input.eventId,
        ...guardParams,
      ),
  );

  statements.push(
    db
      .prepare(`UPDATE rt_inbound_emails
        SET status = 'received', quarantine_reason = NULL
        WHERE id = ? AND ${guardSql}`)
      .bind(input.inboundEmailId, ...guardParams),
  );

  if (isLive) {
    const { heldAt, expiresAt } = await computeHeldExpiryIso(db, input.inboundEmailId, now);
    statements.push(
      db
        .prepare(`INSERT INTO rt_held_reservation_emails
          (inbound_email_id, store_id, media_id, sync_event_id, state, held_at, expires_at, updated_at)
          SELECT ?, ?, ?, ?, 'held', ?, ?, datetime('now')
          WHERE NOT (${guardSql})
          ON CONFLICT(inbound_email_id) DO NOTHING`)
        .bind(
          input.inboundEmailId,
          input.storeId,
          input.media.id,
          input.eventId,
          heldAt,
          expiresAt,
          ...guardParams,
        ),
    );
    statements.push(
      db
        .prepare(`UPDATE rt_sync_events
          SET payload_json = json_patch(payload_json, ?), error_message = NULL
          WHERE id = ? AND NOT (${guardSql})`)
        .bind(JSON.stringify({ media: input.media.code, held: true }), input.eventId, ...guardParams),
    );
  } else {
    statements.push(
      db
        .prepare(`UPDATE rt_held_reservation_emails
          SET state = 'processed',
              claim_token = NULL,
              claim_expires_at = NULL,
              last_error = NULL,
              updated_at = datetime('now')
          WHERE inbound_email_id = ? AND state = 'processing' AND claim_token = ? AND ${guardSql}`)
        .bind(input.inboundEmailId, input.claimToken ?? '', ...guardParams),
    );
    statements.push(
      db
        .prepare(`UPDATE rt_held_reservation_emails
          SET state = 'held',
              claim_token = NULL,
              claim_expires_at = NULL,
              updated_at = datetime('now')
          WHERE inbound_email_id = ? AND state = 'processing' AND claim_token = ?
            AND EXISTS (
              SELECT 1 FROM rt_store_media_email_settings
              WHERE store_id = ? AND media_id = ? AND enabled = 0
            )`)
        .bind(input.inboundEmailId, input.claimToken ?? '', input.storeId, input.media.id),
    );
  }

  const results = await db.batch(statements);
  const committed = (results[syncEventIndex]?.meta.changes ?? 0) > 0;
  if (committed) {
    if (hasReservationStatement) {
      if ((results[0]?.meta.changes ?? 0) > 0) {
        await reconcileRestaurantInventory(input.env, input.storeId);
      } else {
        await db
          .prepare('UPDATE rt_sync_events SET payload_json = json_patch(payload_json, ?) WHERE id = ?')
          .bind(JSON.stringify({ outcome: 'stale_ignored' }), input.eventId)
          .run();
      }
    }
    return 'processed';
  }
  return isLive ? 'held' : 'skipped';
}

type ExpiredHeldCandidate = {
  inbound_email_id: string;
  store_id: string;
  media_id: string;
  sync_event_id: string;
  held_at: string;
  expires_at: string;
  r2_key: string;
  media_code: string;
  line_account_id: string | null;
  tenant_id: string | null;
};

/**
 * 保管期限（30日）を過ぎた保留メールをR2から削除し、D1の台帳更新と監査記録を残す。
 * 再開処理中の有効リース（processing）と重なった行には触れず、二重処理と破損を防ぐ。
 */
export async function expireHeldReservationEmails(
  env: Env['Bindings'],
  options: { now?: Date; maxPerRun?: number } = {},
): Promise<{ checked: number; deleted: number; failed: number }> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const limit = Math.max(1, Math.min(options.maxPerRun ?? 1_000, 5_000));
  const db = dbFor(env);

  const { results } = await db
    .prepare(`SELECT h.inbound_email_id, h.store_id, h.media_id, h.sync_event_id,
        h.held_at, h.expires_at, e.r2_key, m.code AS media_code,
        st.line_account_id, org.tenant_id
      FROM rt_held_reservation_emails h
      JOIN rt_inbound_emails e ON e.id = h.inbound_email_id
      JOIN rt_media m ON m.id = h.media_id
      JOIN rt_stores st ON st.id = h.store_id
      JOIN rt_organizations org ON org.id = st.organization_id
      WHERE (
        h.state IN ('held', 'archived', 'processed')
        OR (h.state = 'processing' AND h.claim_expires_at IS NOT NULL AND datetime(h.claim_expires_at) <= datetime(?))
        OR (h.state = 'expiring' AND h.claim_expires_at IS NOT NULL AND datetime(h.claim_expires_at) <= datetime(?))
      )
        AND datetime(h.expires_at) <= datetime(?)
      ORDER BY datetime(h.expires_at) ASC, h.inbound_email_id ASC
      LIMIT ?`)
    .bind(nowIso, nowIso, nowIso, limit)
    .all<ExpiredHeldCandidate>();

  let checked = 0;
  let deleted = 0;
  let failed = 0;

  for (const row of results) {
    checked += 1;
    const expiryToken = crypto.randomUUID();
    const expiryLease = new Date(now.getTime() + CLAIM_LEASE_MS).toISOString();
    const claimed = await db
      .prepare(`UPDATE rt_held_reservation_emails
        SET state = 'expiring', claim_token = ?, claim_expires_at = ?, updated_at = datetime('now')
        WHERE inbound_email_id = ?
          AND (
            state IN ('held', 'archived', 'processed')
            OR (state = 'processing' AND claim_expires_at IS NOT NULL AND datetime(claim_expires_at) <= datetime(?))
            OR (state = 'expiring' AND claim_expires_at IS NOT NULL AND datetime(claim_expires_at) <= datetime(?))
          )
          AND datetime(expires_at) <= datetime(?)`)
      .bind(expiryToken, expiryLease, row.inbound_email_id, nowIso, nowIso, nowIso)
      .run();

    if (!claimed.meta.changes) continue;

    try {
      if (row.r2_key) {
        if (!env.RAW_MAIL) throw new Error('RAW_MAIL binding is not configured');
        await env.RAW_MAIL.delete(row.r2_key);
      }
      const storeDb = dbFor(env, row.store_id);
      const claimGuard = "EXISTS (SELECT 1 FROM rt_held_reservation_emails WHERE inbound_email_id = ? AND state = 'expiring' AND claim_token = ?)";
      const updates = await storeDb.batch([
        storeDb
          .prepare(`UPDATE rt_inbound_emails
            SET r2_key = '', status = 'raw_deleted'
            WHERE id = ? AND ${claimGuard}`)
          .bind(row.inbound_email_id, row.inbound_email_id, expiryToken),
        storeDb
          .prepare(`UPDATE rt_sync_events
            SET status = 'failed', error_message = 'held_expired', processed_at = datetime('now')
            WHERE id = ? AND status = 'received' AND ${claimGuard}`)
          .bind(row.sync_event_id, row.inbound_email_id, expiryToken),
        auditEventStatement(storeDb, {
          sourceKind: 'rt_held_email_expiry', sourceId: row.inbound_email_id,
          tenantId: row.tenant_id ?? undefined, lineAccountId: row.line_account_id,
          category: 'business', actorPrincipalId: 'system:retention', actorRole: 'system',
          action: 'restaurant.media_email_import.held_expired', targetKind: 'rt_held_reservation_email',
          targetId: row.inbound_email_id, result: 'success',
          after: { storeId: row.store_id, mediaCode: row.media_code, heldAt: row.held_at, expiresAt: row.expires_at },
          createdAt: nowIso,
        }, { sql: claimGuard, params: [row.inbound_email_id, expiryToken] }),
        storeDb
          .prepare(`UPDATE rt_held_reservation_emails
            SET state = 'expired', claim_token = NULL, claim_expires_at = NULL, updated_at = datetime('now')
            WHERE inbound_email_id = ? AND state = 'expiring' AND claim_token = ?`)
          .bind(row.inbound_email_id, expiryToken),
      ]);
      if ((updates[3]?.meta.changes ?? 0) > 0) deleted += 1;
    } catch {
      await dbFor(env, row.store_id)
        .prepare(`UPDATE rt_held_reservation_emails
          SET claim_expires_at = ?, updated_at = datetime('now')
          WHERE inbound_email_id = ? AND state = 'expiring' AND claim_token = ?`)
        .bind(nowIso, row.inbound_email_id, expiryToken)
        .run()
        .catch(() => undefined);
      failed += 1;
      logger.error('restaurant_email.expire_held_raw_mail_failed');
      break;
    }
  }

  return { checked, deleted, failed };
}
