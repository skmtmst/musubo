import { sqlIdSet } from './id-queries.js';
import { jstNow } from './utils.js';
import { encryptCredential } from './credential-crypto.js';

// Google Calendar 連携クエリヘルパー

export interface GoogleCalendarConnectionRow {
  id: string;
  calendar_id: string;
  line_account_id: string | null;
  staff_id: string | null;
  access_token: string | null;
  refresh_token: string | null;
  api_key: string | null;
  auth_type: string;
  is_active: number;
  last_verified_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface CalendarBookingRow {
  id: string;
  connection_id: string;
  friend_id: string | null;
  event_id: string | null;
  title: string;
  start_at: string;
  end_at: string;
  status: string;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

/** Every admin calendar query must carry the caller's resolved account scope. */
export interface CalendarAccountScope {
  allowedAccountIds: readonly string[];
  includeUnassigned: boolean;
}

function calendarAccountScopeSql(
  scope: CalendarAccountScope,
  column = 'line_account_id',
): { sql: string; binds: string[] } {
  const clauses: string[] = [];
  if (scope.allowedAccountIds.length > 0) {
    clauses.push(`${column} IN (${sqlIdSet(scope.allowedAccountIds).sql})`);
  }
  if (scope.includeUnassigned) clauses.push(`${column} IS NULL`);
  return {
    sql: clauses.length > 0 ? `(${clauses.join(' OR ')})` : '0 = 1',
    binds: scope.allowedAccountIds.length ? sqlIdSet(scope.allowedAccountIds).binds : [],
  };
}

// --- 接続管理 ---

export async function getCalendarConnections(
  db: D1Database,
  scope: CalendarAccountScope,
): Promise<GoogleCalendarConnectionRow[]> {
  const scoped = calendarAccountScopeSql(scope);
  const result = await db
    .prepare(`SELECT * FROM google_calendar_connections WHERE ${scoped.sql} ORDER BY created_at DESC`)
    .bind(...scoped.binds)
    .all<GoogleCalendarConnectionRow>();
  return result.results;
}

export async function getCalendarConnectionById(
  db: D1Database,
  id: string,
  scope: CalendarAccountScope,
): Promise<GoogleCalendarConnectionRow | null> {
  const scoped = calendarAccountScopeSql(scope);
  return db
    .prepare(`SELECT * FROM google_calendar_connections WHERE id = ? AND ${scoped.sql}`)
    .bind(id, ...scoped.binds)
    .first<GoogleCalendarConnectionRow>();
}

export async function createCalendarConnection(
  db: D1Database,
  input: {
    calendarId: string;
    authType: string;
    lineAccountId: string;
    accessToken?: string;
    refreshToken?: string;
    apiKey?: string;
  },
  scope: CalendarAccountScope,
  encryptionKey?: string,
): Promise<GoogleCalendarConnectionRow | null> {
  if (!scope.allowedAccountIds.includes(input.lineAccountId)) return null;

  // Existing TEXT columns store authenticated ciphertext. Never fall back to plaintext.
  const protect = (value: string | undefined) => value
    ? encryptCredential(value, encryptionKey) : Promise.resolve(null);
  const [accessToken, refreshToken, apiKey] = await Promise.all([
    protect(input.accessToken), protect(input.refreshToken), protect(input.apiKey),
  ]);
  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(`INSERT INTO google_calendar_connections
              (id, calendar_id, line_account_id, staff_id, auth_type,
               access_token, refresh_token, api_key, created_at, updated_at)
              SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
              WHERE ? <> 'oauth' OR NOT EXISTS (SELECT 1 FROM workflow_steps
                WHERE scope_id='global:meeting-revoke' AND process_kind='booking_meeting_revoke_lock'
                  AND subject_id='google_meet' AND step_key='lock' AND status='running' AND lease_expires_at>?)`)
    .bind(
      id,
      input.calendarId,
      input.lineAccountId,
      null,
      input.authType,
      accessToken,
      refreshToken,
      apiKey,
      now,
      now,
      input.authType,
      Date.now(),
    )
    .run();
  return getCalendarConnectionById(db, id, scope);
}

export async function deleteCalendarConnection(
  db: D1Database,
  id: string,
  scope: CalendarAccountScope,
): Promise<boolean> {
  const scoped = calendarAccountScopeSql(scope);
  const result = await db
    .prepare(`DELETE FROM google_calendar_connections WHERE id = ? AND ${scoped.sql}`)
    .bind(id, ...scoped.binds)
    .run();
  return result.meta.changes > 0;
}

// --- 予約管理 ---

export async function getCalendarBookings(
  db: D1Database,
  scope: CalendarAccountScope,
  opts: { connectionId?: string; friendId?: string } = {},
): Promise<CalendarBookingRow[]> {
  const scoped = calendarAccountScopeSql(scope, 'c.line_account_id');
  const conditions = [scoped.sql];
  const binds: unknown[] = [...scoped.binds];
  if (opts.connectionId) {
    conditions.push('b.connection_id = ?');
    binds.push(opts.connectionId);
  }
  if (opts.friendId) {
    conditions.push('b.friend_id = ?');
    binds.push(opts.friendId);
  }
  const result = await db
    .prepare(`SELECT b.*
                FROM calendar_bookings b
                INNER JOIN google_calendar_connections c ON c.id = b.connection_id
               WHERE ${conditions.join(' AND ')}
               ORDER BY b.start_at ASC`)
    .bind(...binds)
    .all<CalendarBookingRow>();
  return result.results;
}

export async function getCalendarBookingById(
  db: D1Database,
  id: string,
  scope: CalendarAccountScope,
): Promise<CalendarBookingRow | null> {
  const scoped = calendarAccountScopeSql(scope, 'c.line_account_id');
  return db
    .prepare(`SELECT b.*
                FROM calendar_bookings b
                INNER JOIN google_calendar_connections c ON c.id = b.connection_id
               WHERE b.id = ? AND ${scoped.sql}`)
    .bind(id, ...scoped.binds)
    .first<CalendarBookingRow>();
}

export async function createCalendarBooking(
  db: D1Database,
  input: { connectionId: string; friendId?: string; eventId?: string; title: string; startAt: string; endAt: string; metadata?: string },
  scope: CalendarAccountScope,
): Promise<CalendarBookingRow | null> {
  const scoped = calendarAccountScopeSql(scope, 'c.line_account_id');
  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(`INSERT INTO calendar_bookings
                (id, connection_id, friend_id, event_id, title, start_at, end_at, metadata, created_at, updated_at)
              SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
               WHERE EXISTS (
                 SELECT 1 FROM google_calendar_connections c
                  WHERE c.id = ?
                    AND ${scoped.sql}
                    AND (
                      ? IS NULL
                      OR EXISTS (
                        SELECT 1 FROM friends f
                         WHERE f.id = ?
                           AND f.line_account_id IS c.line_account_id
                      )
                    )
               )`)
    .bind(
      id,
      input.connectionId,
      input.friendId ?? null,
      input.eventId ?? null,
      input.title,
      input.startAt,
      input.endAt,
      input.metadata ?? null,
      now,
      now,
      input.connectionId,
      ...scoped.binds,
      input.friendId ?? null,
      input.friendId ?? null,
    )
    .run();
  return getCalendarBookingById(db, id, scope);
}

export async function updateCalendarBookingStatus(
  db: D1Database,
  id: string,
  status: string,
  scope: CalendarAccountScope,
): Promise<boolean> {
  const scoped = calendarAccountScopeSql(scope, 'c.line_account_id');
  const result = await db
    .prepare(`UPDATE calendar_bookings
                 SET status = ?, updated_at = ?
               WHERE id = ?
                 AND EXISTS (
                   SELECT 1 FROM google_calendar_connections c
                    WHERE c.id = calendar_bookings.connection_id AND ${scoped.sql}
                 )`)
    .bind(status, jstNow(), id, ...scoped.binds)
    .run();
  return result.meta.changes > 0;
}

export async function updateCalendarBookingEventId(
  db: D1Database,
  id: string,
  eventId: string,
  scope: CalendarAccountScope,
): Promise<boolean> {
  const scoped = calendarAccountScopeSql(scope, 'c.line_account_id');
  const result = await db
    .prepare(`UPDATE calendar_bookings
                 SET event_id = ?, updated_at = ?
               WHERE id = ?
                 AND EXISTS (
                   SELECT 1 FROM google_calendar_connections c
                    WHERE c.id = calendar_bookings.connection_id AND ${scoped.sql}
                 )`)
    .bind(eventId, jstNow(), id, ...scoped.binds)
    .run();
  return result.meta.changes > 0;
}

/** 空きスロット計算用: 指定日範囲の予約一覧を取得 */
export async function getBookingsInRange(
  db: D1Database,
  connectionId: string,
  startAt: string,
  endAt: string,
  scope: CalendarAccountScope,
): Promise<CalendarBookingRow[]> {
  const scoped = calendarAccountScopeSql(scope, 'c.line_account_id');
  const result = await db
    .prepare(`SELECT b.*
                FROM calendar_bookings b
                INNER JOIN google_calendar_connections c ON c.id = b.connection_id
               WHERE b.connection_id = ?
                 AND b.start_at >= ?
                 AND b.end_at <= ?
                 AND b.status != 'cancelled'
                 AND ${scoped.sql}
               ORDER BY b.start_at ASC`)
    .bind(connectionId, startAt, endAt, ...scoped.binds)
    .all<CalendarBookingRow>();
  return result.results;
}
