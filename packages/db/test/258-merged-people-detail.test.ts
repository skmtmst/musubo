import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  join(import.meta.dirname, '..', 'migrations', '258_merged_people_detail.sql'),
  'utf8',
)

function setup() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY);
    CREATE TABLE line_accounts (id TEXT PRIMARY KEY);
    CREATE TABLE friends (id TEXT PRIMARY KEY);
    CREATE TABLE identity_candidates (id TEXT PRIMARY KEY);
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT,
      phone TEXT,
      external_id TEXT,
      display_name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO tenants VALUES ('tenant-a');
    INSERT INTO friends VALUES ('friend-a');
    INSERT INTO users (
      id, display_name, created_at, updated_at
    ) VALUES ('user-legacy', '既存ユーザー', '2026-08-30', '2026-08-30');
  `)
  sqlite.exec(migration)
  return sqlite
}

describe('migration 258 merged person detail', () => {
  it('does not guess a tenant for an existing user', () => {
    const sqlite = setup()
    expect(sqlite.prepare(
      'SELECT tenant_id, status, revision FROM users WHERE id = ?',
    ).get('user-legacy')).toEqual({ tenant_id: null, status: 'active', revision: 1 })
  })

  it('keeps one active adopted value per field while retaining history', () => {
    const sqlite = setup()
    const insert = sqlite.prepare(`
      INSERT INTO user_profile_values (
        id, tenant_id, user_id, field_key, field_label, value_json, value_preview,
        source_type, source_label, selected_by_name, selected_at, update_mode,
        is_active, created_at, updated_at
      ) VALUES (?, 'tenant-a', 'user-legacy', 'email', 'メール', '"masked"',
        'ta***@example.com', 'manual', '担当者確認', '担当者', '2026-08-30',
        'fixed', ?, '2026-08-30', '2026-08-30')
    `)
    insert.run('value-old', 0)
    insert.run('value-current', 1)
    expect(() => insert.run('value-conflict', 1)).toThrow(/UNIQUE/)
    expect(sqlite.prepare(
      'SELECT COUNT(*) AS count FROM user_profile_values WHERE field_key = ?',
    ).get('email')).toEqual({ count: 2 })
  })

  it('prevents duplicate active priority positions for the same purpose', () => {
    const sqlite = setup()
    const insert = sqlite.prepare(`
      INSERT INTO user_delivery_priorities (
        id, tenant_id, user_id, purpose, friend_id, priority, is_active,
        reason, selected_at, created_at, updated_at
      ) VALUES (?, 'tenant-a', 'user-legacy', 'broadcast', 'friend-a', 1, 1,
        '本人へ確認済み', '2026-08-30', '2026-08-30', '2026-08-30')
    `)
    insert.run('priority-a')
    expect(() => insert.run('priority-b')).toThrow(/UNIQUE/)
  })

  it('stores immutable safe summaries separately from before and after snapshots', () => {
    const sqlite = setup()
    sqlite.prepare(`
      INSERT INTO identity_events (
        id, tenant_id, user_id, event_type, summary, before_json, after_json,
        actor_name, occurred_at, correlation_id
      ) VALUES ('event-a', 'tenant-a', 'user-legacy', 'profile',
        'プロフィールの採用値を1件更新しました', '{}', '{}', '担当者',
        '2026-08-30', 'correlation-a')
    `).run()
    expect(sqlite.prepare(
      'SELECT event_type, summary FROM identity_events WHERE id = ?',
    ).get('event-a')).toEqual({
      event_type: 'profile',
      summary: 'プロフィールの採用値を1件更新しました',
    })
  })
})
