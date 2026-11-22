import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createCalendarBooking,
  createCalendarConnection,
  deleteCalendarConnection,
  getBookingsInRange,
  getCalendarBookingById,
  getCalendarBookings,
  getCalendarConnectionById,
  getCalendarConnections,
  updateCalendarBookingEventId,
  updateCalendarBookingStatus,
  type CalendarAccountScope,
} from '../src/calendar.js';

function asD1(sqlite: Database.Database): D1Database {
  return {
    prepare(query: string) {
      return {
        bind(...params: unknown[]) {
          const statement = sqlite.prepare(query);
          return {
            async run() {
              const result = statement.run(...params);
              return { results: [], success: true, meta: { changes: result.changes } };
            },
            async first<T>() {
              return (statement.get(...params) as T) ?? null;
            },
            async all<T>() {
              return { results: statement.all(...params) as T[], success: true, meta: {} };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

const SCOPE_A: CalendarAccountScope = {
  allowedAccountIds: ['account-a'],
  includeUnassigned: false,
};

describe('calendar database account scope', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    // 本番と同じ借受表を用い、接続解除中の検査も実際の制約で動かす。
    const workflowMigration = readFileSync(new URL('../migrations/615_workflow_steps.sql', import.meta.url), 'utf8');
    sqlite.exec(workflowMigration.split('-- Banner-specific')[0]);
    sqlite.exec(`
      CREATE TABLE google_calendar_connections (
        id TEXT PRIMARY KEY,
        calendar_id TEXT NOT NULL,
        line_account_id TEXT,
        staff_id TEXT,
        access_token TEXT,
        refresh_token TEXT,
        api_key TEXT,
        auth_type TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        last_verified_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE calendar_bookings (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES google_calendar_connections(id) ON DELETE CASCADE,
        friend_id TEXT,
        event_id TEXT,
        title TEXT NOT NULL,
        start_at TEXT NOT NULL,
        end_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'confirmed',
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE friends (
        id TEXT PRIMARY KEY,
        line_account_id TEXT
      );
      INSERT INTO google_calendar_connections
        (id, calendar_id, line_account_id, auth_type, created_at, updated_at) VALUES
        ('connection-a', 'a@example.com', 'account-a', 'oauth', '2026-09-07', '2026-09-07'),
        ('connection-b', 'b@example.com', 'account-b', 'oauth', '2026-09-07', '2026-09-07'),
        ('connection-legacy', 'legacy@example.com', NULL, 'oauth', '2026-09-07', '2026-09-07');
      INSERT INTO friends (id, line_account_id) VALUES
        ('friend-a', 'account-a'),
        ('friend-b', 'account-b'),
        ('friend-legacy', NULL);
      INSERT INTO calendar_bookings
        (id, connection_id, friend_id, title, start_at, end_at, created_at, updated_at) VALUES
        ('booking-a', 'connection-a', 'friend-a', 'A予約', '2026-09-08T10:00:00+09:00', '2026-09-08T11:00:00+09:00', '2026-09-07', '2026-09-07'),
        ('booking-b', 'connection-b', 'friend-b', 'B予約', '2026-09-08T10:00:00+09:00', '2026-09-08T11:00:00+09:00', '2026-09-07', '2026-09-07'),
        ('booking-legacy', 'connection-legacy', NULL, '旧予約', '2026-09-08T10:00:00+09:00', '2026-09-08T11:00:00+09:00', '2026-09-07', '2026-09-07');
    `);
    db = asD1(sqlite);
  });

  it('never returns connections or bookings outside the required scope', async () => {
    expect((await getCalendarConnections(db, SCOPE_A)).map((row) => row.id)).toEqual([
      'connection-a',
    ]);
    expect(await getCalendarConnectionById(db, 'connection-b', SCOPE_A)).toBeNull();
    expect((await getCalendarBookings(db, SCOPE_A)).map((row) => row.id)).toEqual([
      'booking-a',
    ]);
    expect(await getCalendarBookingById(db, 'booking-b', SCOPE_A)).toBeNull();
    expect((await getBookingsInRange(
      db,
      'connection-b',
      '2026-09-08T00:00:00+09:00',
      '2026-09-09T00:00:00+09:00',
      SCOPE_A,
    ))).toEqual([]);
  });

  it('fails closed when the caller has no visible account', async () => {
    const emptyScope: CalendarAccountScope = {
      allowedAccountIds: [],
      includeUnassigned: false,
    };

    expect(await getCalendarConnections(db, emptyScope)).toEqual([]);
    expect(await getCalendarBookings(db, emptyScope)).toEqual([]);
    expect(await getCalendarConnectionById(db, 'connection-a', emptyScope)).toBeNull();
    expect(await getCalendarBookingById(db, 'booking-a', emptyScope)).toBeNull();
  });

  it('does not create, update, or delete through an out-of-scope resource ID', async () => {
    expect(await createCalendarConnection(db, {
      calendarId: 'forbidden@example.com',
      authType: 'oauth',
      lineAccountId: 'account-b',
    }, SCOPE_A)).toBeNull();

    expect(await createCalendarBooking(db, {
      connectionId: 'connection-b',
      title: '越境予約',
      startAt: '2026-09-09T10:00:00+09:00',
      endAt: '2026-09-09T11:00:00+09:00',
    }, SCOPE_A)).toBeNull();
    expect(await createCalendarBooking(db, {
      connectionId: 'connection-a',
      friendId: 'friend-b',
      title: '友だち越境予約',
      startAt: '2026-09-09T10:00:00+09:00',
      endAt: '2026-09-09T11:00:00+09:00',
    }, SCOPE_A)).toBeNull();
    expect(await updateCalendarBookingStatus(db, 'booking-b', 'cancelled', SCOPE_A)).toBe(false);
    expect(await updateCalendarBookingEventId(db, 'booking-b', 'event-attacker', SCOPE_A)).toBe(false);
    expect(await deleteCalendarConnection(db, 'connection-b', SCOPE_A)).toBe(false);

    expect(sqlite.prepare(`SELECT status, event_id FROM calendar_bookings WHERE id = 'booking-b'`).get())
      .toEqual({ status: 'confirmed', event_id: null });
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM google_calendar_connections WHERE id = 'connection-b'`).get())
      .toEqual({ count: 1 });
  });

  it('keeps allowed create, update, and delete operations working', async () => {
    const connectionInput = {
      calendarId: 'new-a@example.com',
      authType: 'oauth',
      lineAccountId: 'account-a',
      staffId: 'attacker-controlled',
    };
    const connection = await createCalendarConnection(db, connectionInput, SCOPE_A);
    expect(connection?.line_account_id).toBe('account-a');
    expect(connection?.staff_id).toBeNull();

    const booking = await createCalendarBooking(db, {
      connectionId: 'connection-a',
      friendId: 'friend-a',
      title: '許可予約',
      startAt: '2026-09-09T10:00:00+09:00',
      endAt: '2026-09-09T11:00:00+09:00',
    }, SCOPE_A);
    expect(booking?.title).toBe('許可予約');
    expect(await updateCalendarBookingEventId(db, booking!.id, 'event-a', SCOPE_A)).toBe(true);
    expect(await updateCalendarBookingStatus(db, booking!.id, 'completed', SCOPE_A)).toBe(true);
    expect(await getCalendarBookingById(db, booking!.id, SCOPE_A)).toMatchObject({
      status: 'completed',
      event_id: 'event-a',
    });
    expect(await deleteCalendarConnection(db, connection!.id, SCOPE_A)).toBe(true);
  });

  it('blocks new OAuth connections while Google revocation is leased and allows them after expiry', async () => {
    sqlite.prepare(`INSERT INTO workflow_steps
      (scope_id, process_kind, subject_id, step_key, status, lease_owner, lease_expires_at, retry_key, created_at, updated_at)
      VALUES ('global:meeting-revoke', 'booking_meeting_revoke_lock', 'google_meet', 'lock', 'running', 'owner', ?, 'retry', 0, 0)`)
      .run(Date.now() + 60_000);
    const input = { calendarId: 'new-a@example.com', authType: 'oauth', lineAccountId: 'account-a' };
    expect(await createCalendarConnection(db, input, SCOPE_A)).toBeNull();
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM google_calendar_connections WHERE calendar_id = ?').get(input.calendarId)).toEqual({ count: 0 });
    expect(await createCalendarConnection(db, { ...input, calendarId: 'shared@example.com', authType: 'service_account' }, SCOPE_A))
      .toMatchObject({ line_account_id: 'account-a', calendar_id: 'shared@example.com' });
    sqlite.prepare("UPDATE workflow_steps SET lease_expires_at = 0 WHERE subject_id = 'google_meet'").run();
    expect(await createCalendarConnection(db, input, SCOPE_A)).toMatchObject({ line_account_id: 'account-a', calendar_id: input.calendarId });
  });

  it('makes legacy unassigned rows an explicit default-tenant choice', async () => {
    const legacyScope: CalendarAccountScope = {
      allowedAccountIds: ['account-a'],
      includeUnassigned: true,
    };

    expect((await getCalendarConnections(db, legacyScope)).map((row) => row.id).sort()).toEqual([
      'connection-a',
      'connection-legacy',
    ]);
    expect((await getCalendarBookings(db, legacyScope)).map((row) => row.id).sort()).toEqual([
      'booking-a',
      'booking-legacy',
    ]);
  });
});
