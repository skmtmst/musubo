import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import {
  claimRichMenuSchedule,
  claimRichMenuScheduleRestore,
  createRichMenuScheduleAtomic,
  getDueRichMenuSchedules,
  listScheduleGroupIndividualLinks,
  normalizeScheduleTimestamp,
  recordRichMenuSchedulePermanentFailure,
  recordRichMenuScheduleSuccess,
  scheduleLeaseExpiresAt,
} from '../src/rich-menu-schedules.js'

function setup() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE line_accounts (id TEXT PRIMARY KEY);
    CREATE TABLE rich_menu_groups (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      publishing_at TEXT,
      updated_at TEXT NOT NULL DEFAULT '2026-09-06T00:00:00+09:00'
    );
    CREATE TABLE friends (
      id TEXT PRIMARY KEY,
      line_account_id TEXT NOT NULL,
      line_user_id TEXT,
      line_platform_user_id TEXT GENERATED ALWAYS AS (line_user_id) VIRTUAL
    );
    CREATE TABLE rich_menu_assignments (
      id TEXT PRIMARY KEY,
      friend_id TEXT NOT NULL,
      line_account_id TEXT NOT NULL,
      group_id TEXT,
      version_id TEXT,
      line_richmenu_id TEXT,
      reason_kind TEXT,
      reason_event_id TEXT,
      assigned_at TEXT,
      updated_at TEXT
    );
    INSERT INTO line_accounts VALUES ('account-1');
    INSERT INTO rich_menu_groups VALUES ('menu-1', 'account-1', 'draft', NULL, '2026-09-06T00:00:00+09:00');
  `)
  sqlite.exec(readFileSync(join(import.meta.dirname, '../migrations/291_rich_menu_schedules.sql'), 'utf8'))
  sqlite.exec(readFileSync(join(import.meta.dirname, '../migrations/342_rich_menu_schedule_execution.sql'), 'utf8'))
  sqlite.exec(readFileSync(join(import.meta.dirname, '../migrations/344_rich_menu_schedule_publications.sql'), 'utf8'))
  sqlite.exec(readFileSync(join(import.meta.dirname, '../migrations/355_rich_menu_schedule_lease.sql'), 'utf8'))
  return sqlite
}

function asD1(sqlite: Database.Database): D1Database {
  return {
    prepare(query: string) {
      const build = (...params: unknown[]) => {
        const stmt = sqlite.prepare(query)
        return {
          async run() {
            const info = stmt.run(...params)
            return { success: true, meta: { changes: info.changes } }
          },
          async first<T>() {
            return (stmt.get(...params) as T) ?? null
          },
          async all<T>() {
            return { results: (stmt.all(...params) as T[]), success: true, meta: {} }
          },
        }
      }
      return {
        bind: (...params: unknown[]) => build(...params),
        run: () => build().run(),
        first: <T,>() => build().first<T>(),
        all: <T,>() => build().all<T>(),
      }
    },
    batch: async (stmts: unknown[]) => {
      for (const stmt of stmts as Array<{ run: () => Promise<unknown> }>) await stmt.run()
      return []
    },
  } as unknown as D1Database
}

function insertFullSchedule(sqlite: Database.Database, overrides: Record<string, string | number | null> = {}) {
  const row = {
    id: 'schedule-1',
    group_id: 'menu-1',
    account_id: 'account-1',
    mode: 'scheduled',
    starts_at: '2026-09-10T01:00:00.000Z',
    ends_at: null,
    restore_group_id: null,
    definition_snapshot: JSON.stringify({ pages: [{ id: 'p1' }] }),
    status: 'scheduled',
    idempotency_key: 'key-1',
    requested_by_staff_id: 'staff-1',
    started_run_id: null,
    ended_run_id: null,
    last_error_code: null,
    created_at: '2026-09-06T00:00:00+09:00',
    updated_at: '2026-09-06T00:00:00+09:00',
    ...overrides,
  }
  sqlite.prepare(`INSERT INTO rich_menu_schedules
    (id, group_id, account_id, mode, starts_at, ends_at, restore_group_id,
     definition_snapshot, status, idempotency_key, requested_by_staff_id,
     started_run_id, ended_run_id, last_error_code, created_at, updated_at)
    VALUES (@id, @group_id, @account_id, @mode, @starts_at, @ends_at, @restore_group_id,
            @definition_snapshot, @status, @idempotency_key, @requested_by_staff_id,
            @started_run_id, @ended_run_id, @last_error_code, @created_at, @updated_at)`).run(row)
}

describe('355 remand再審査: lease・反転防止・ISO正規化・個別対象（実D1）', () => {
  let sqlite: Database.Database
  let db: D1Database

  beforeEach(() => {
    sqlite = setup()
    db = asD1(sqlite)
  })

  test('claimは所有runのlease期限（UTC・+10分）を刻む', async () => {
    insertFullSchedule(sqlite, { id: 'lease-1' })
    expect(await claimRichMenuSchedule(db, 'lease-1', 'account-1', 'run-A', '2026-09-10T01:00:00.000Z')).toBe(true)
    const row = sqlite.prepare(`SELECT started_run_id, lease_expires_at FROM rich_menu_schedules WHERE id = 'lease-1'`).get() as Record<string, string>
    expect(row.started_run_id).toBe('run-A')
    expect(row.lease_expires_at).toBe('2026-09-10T01:10:00.000Z')
    expect(scheduleLeaseExpiresAt('2026-09-10T01:00:00.000Z')).toBe('2026-09-10T01:10:00.000Z')
  })

  test('確定済み(completed/cancelled)はfailedへ反転できない', async () => {
    insertFullSchedule(sqlite, { id: 'done-1', status: 'completed', started_run_id: 'run-A', ended_run_id: 'run-A' })
    // 古いrunのIDが残っていても確定済みは変えられない。
    expect(await recordRichMenuSchedulePermanentFailure(db, 'done-1', 'account-1', 'run-A', 'fetch failed')).toBe(false)
    expect(await recordRichMenuScheduleSuccess(db, 'done-1', 'account-1', 'run-A', 'completed')).toBe(false)
    const row = sqlite.prepare(`SELECT status FROM rich_menu_schedules WHERE id = 'done-1'`).get() as { status: string }
    expect(row.status).toBe('completed')
    insertFullSchedule(sqlite, { id: 'done-2', status: 'cancelled', idempotency_key: 'key-2' })
    expect(await recordRichMenuSchedulePermanentFailure(db, 'done-2', 'account-1', 'run-A', 'fetch failed')).toBe(false)
  })

  test('オフセット付きISOはUTCへ正規化して保存しdue判定が崩れない', async () => {
    // '2026-09-10T01:00:00+09:00' は実質 09-09T16:00Z。文字列比較のままだと
    // '2026-09-10T00:00:00.000Z' 時点で未到来に見える誤判定になる。
    expect(normalizeScheduleTimestamp('2026-09-10T01:00:00+09:00')).toBe('2026-09-09T16:00:00.000Z')
    const created = await createRichMenuScheduleAtomic(db, {
      id: 'tz-1',
      groupId: 'menu-1',
      accountId: 'account-1',
      mode: 'scheduled',
      startsAt: '2026-09-10T10:00:00.000Z',
      endsAt: null,
      restoreGroupId: null,
      definitionSnapshot: '{}',
      idempotencyKey: 'tz-key',
      requestedByStaffId: 'staff-1',
      now: '2026-09-06T00:00:00+09:00',
    })
    expect(created.outcome).toBe('created')
    const stored = sqlite.prepare(`SELECT starts_at FROM rich_menu_schedules WHERE id = 'tz-1'`).get() as { starts_at: string }
    // UTC入力はそのままZ付きでそろう（画面はJST→UTC変換済みを送る）。
    expect(stored.starts_at).toBe('2026-09-10T10:00:00.000Z')
    // オフセット付きで保存された行は正規化後にdueへ出る。
    await createRichMenuScheduleAtomic(db, {
      id: 'tz-2',
      groupId: 'menu-1',
      accountId: 'account-1',
      mode: 'scheduled',
      startsAt: '2026-09-10T01:00:00+09:00',
      endsAt: null,
      restoreGroupId: null,
      definitionSnapshot: '{}',
      idempotencyKey: 'tz-key-2',
      requestedByStaffId: 'staff-1',
      now: '2026-09-06T00:00:00+09:00',
    })
    const due = await getDueRichMenuSchedules(db, '2026-09-10T00:00:00.000Z', 20)
    expect(due.map((row) => row.id)).toContain('tz-2')
    expect(due.map((row) => row.id)).not.toContain('tz-1')
    expect(() => normalizeScheduleTimestamp('not-a-date')).toThrow()
  })

  test('復元claimもleaseを付け替え、期限内は回収されない', async () => {
    sqlite.prepare(`INSERT INTO rich_menu_groups VALUES ('restore-1', 'account-1', 'published', NULL, '2026-09-07')`).run()
    insertFullSchedule(sqlite, { id: 'lease-r', mode: 'period', ends_at: '2026-09-30T00:00:00.000Z', restore_group_id: 'restore-1', status: 'published', started_run_id: 'run-start' })
    expect(await claimRichMenuScheduleRestore(db, 'lease-r', 'account-1', 'run-R', '2026-09-10T01:00:00.000Z')).toBe(true)
    const row = sqlite.prepare(`SELECT ended_run_id, lease_expires_at, started_run_id FROM rich_menu_schedules WHERE id = 'lease-r'`).get() as Record<string, string>
    expect(row).toMatchObject({ ended_run_id: 'run-R', started_run_id: 'run-start', lease_expires_at: '2026-09-10T01:10:00.000Z' })
  })

  test('個別解除の対象はLINEユーザーIDのある友だけ', async () => {
    sqlite.prepare(`INSERT INTO friends VALUES ('f1', 'account-1', 'U111')`).run()
    sqlite.prepare(`INSERT INTO friends VALUES ('f2', 'account-1', 'U222')`).run()
    sqlite.prepare(`INSERT INTO friends VALUES ('f3', 'account-1', NULL)`).run()
    sqlite.prepare(`INSERT INTO rich_menu_assignments VALUES ('a1', 'f1', 'account-1', 'menu-1', NULL, 'line-old', 'tag_bulk_apply', NULL, 'x', 'x')`).run()
    sqlite.prepare(`INSERT INTO rich_menu_assignments VALUES ('a2', 'f2', 'account-1', 'menu-1', NULL, 'line-old', 'tag_bulk_apply', NULL, 'x', 'x')`).run()
    sqlite.prepare(`INSERT INTO rich_menu_assignments VALUES ('a3', 'f3', 'account-1', 'menu-1', NULL, 'line-old', 'tag_bulk_apply', NULL, 'x', 'x')`).run()
    expect(await listScheduleGroupIndividualLinks(db, 'account-1', 'menu-1')).toEqual([
      { friendId: 'f1', lineUserId: 'U111' },
      { friendId: 'f2', lineUserId: 'U222' },
    ])
    expect(await listScheduleGroupIndividualLinks(db, 'account-1', 'no-such-group')).toEqual([])
  })
})
