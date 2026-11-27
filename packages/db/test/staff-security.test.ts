import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { countLoginAudit } from '../src/login-audit.js'
import { DEFAULT_TENANT_ID } from '@line-crm/shared'
import { createStaffMember, deleteStaffMember, getStaffByApiKey, revokeStaffAuthentication } from '../src/staff.js'

function asD1(sqlite: Database.Database): D1Database {
  const wrap = (query: string, params: unknown[]) => ({
    async run() {
      const info = sqlite.prepare(query).run(...params)
      return { results: [], success: true, meta: { changes: info.changes } }
    },
    async first<T>() {
      return (sqlite.prepare(query).get(...params) as T) ?? null
    },
  })
  return {
    prepare(query: string) {
      return { bind: (...params: unknown[]) => wrap(query, params), ...wrap(query, []) }
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      return Promise.all(statements.map((statement) => statement.run()))
    },
  } as unknown as D1Database
}

describe('ログインユーザーの無効化と監査記録', () => {
  let sqlite: Database.Database
  let db: D1Database

  beforeEach(() => {
    sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE tenants (
        id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active'
      );
      CREATE TABLE staff_members (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, role TEXT NOT NULL,
        access_level TEXT NOT NULL DEFAULT 'full', api_key TEXT UNIQUE NOT NULL,
        line_user_id TEXT, is_active INTEGER NOT NULL DEFAULT 1,
        permission_keys TEXT NOT NULL DEFAULT '[]', notification_preferences TEXT NOT NULL DEFAULT '{}',
        invite_status TEXT NOT NULL DEFAULT 'active', invite_token_hash TEXT, invite_expires_at TEXT,
        email_verified_at TEXT, line_linked_at TEXT, totp_secret_enc TEXT, totp_pending_secret_enc TEXT,
        totp_enabled_at TEXT, totp_last_used_step INTEGER, assigned_line_account_id TEXT,
        can_access_descendant_accounts INTEGER NOT NULL DEFAULT 0,
        account_scope TEXT NOT NULL DEFAULT 'all',
        role_bundle TEXT, view_permission_keys TEXT, email_mask TEXT,
        tenant_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE login_audit (
        id TEXT PRIMARY KEY, admin_user_id TEXT, action TEXT NOT NULL, screen TEXT,
        ip TEXT, user_agent TEXT, result TEXT NOT NULL DEFAULT 'ok', created_at TEXT NOT NULL
      );
      CREATE TABLE auth_trusted_logins (
        staff_id TEXT NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
        marker_hash TEXT NOT NULL,
        ip_prefix TEXT NOT NULL,
        confirmed_at TEXT NOT NULL,
        PRIMARY KEY (staff_id, marker_hash, ip_prefix)
      );
      CREATE TABLE admin_sessions (
        token_hash TEXT PRIMARY KEY, staff_id TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE TABLE platform_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_by TEXT, updated_at TEXT);
      CREATE TABLE impersonation_sessions (id TEXT PRIMARY KEY, staff_id TEXT NOT NULL, ended_at TEXT);
      CREATE TABLE admin_two_factor_challenges (
        token_hash TEXT PRIMARY KEY, staff_id TEXT NOT NULL, expires_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `)
    db = asD1(sqlite)
  })

  it('無効化したユーザーのAPIキーではログインできない', async () => {
    sqlite.prepare(`INSERT INTO staff_members (id, name, role, api_key, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('disabled-user', '無効ユーザー', 'staff', 'disabled-key', 0, '2026-08-23T10:00:00', '2026-08-23T10:00:00')

    expect(await getStaffByApiKey(db, 'disabled-key')).toBeNull()
  })

  it('tenant_idを省略した新規スタッフを既定の統括へ割り当てる', async () => {
    const created = await createStaffMember(db, {
      name: '新規担当者',
      role: 'staff',
    })

    expect(created.tenant_id).toBe(DEFAULT_TENANT_ID)
    expect(sqlite.prepare('SELECT tenant_id FROM staff_members WHERE id = ?').get(created.id))
      .toEqual({ tenant_id: DEFAULT_TENANT_ID })
  })

  it('ログイン件数を全件数え、ユーザー削除後も監査記録を残す', async () => {
    sqlite.prepare(`INSERT INTO staff_members (id, name, role, api_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('target', '削除対象', 'staff', 'target-key', '2026-08-23T10:00:00', '2026-08-23T10:00:00')
    const insert = sqlite.prepare(`INSERT INTO login_audit (id, admin_user_id, action, created_at) VALUES (?, ?, ?, ?)`)
    insert.run('audit-1', 'target', 'login', '2026-08-23T10:00:00')
    insert.run('audit-2', 'target', 'login', '2026-08-23T11:00:00')
    insert.run('audit-3', 'target', 'view_personal', '2026-08-23T12:00:00')

    expect(await countLoginAudit(db, { adminUserId: 'target', action: 'login' })).toBe(2)
    await deleteStaffMember(db, 'target')
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM login_audit WHERE admin_user_id = 'target'`).get()).toEqual({ count: 3 })
  })

  it('権限変更時は対象者のsession・二段階認証challenge・信頼済みログインだけを失効する', async () => {
    sqlite.prepare('INSERT INTO admin_sessions (token_hash, staff_id, expires_at) VALUES (?, ?, ?)').run('s-target', 'target', '2099-01-01')
    sqlite.prepare('INSERT INTO admin_sessions (token_hash, staff_id, expires_at) VALUES (?, ?, ?)').run('s-other', 'other', '2099-01-01')
    sqlite.prepare('INSERT INTO admin_two_factor_challenges (token_hash, staff_id, expires_at) VALUES (?, ?, ?)').run('c-target', 'target', '2099-01-01')
    sqlite.prepare('INSERT INTO admin_two_factor_challenges (token_hash, staff_id, expires_at) VALUES (?, ?, ?)').run('c-other', 'other', '2099-01-01')

    const addStaff = sqlite.prepare('INSERT INTO staff_members (id, name, role, api_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    addStaff.run('target', '対象', 'staff', 'target-key', '2026-08-23', '2026-08-23')
    addStaff.run('other', '別の担当', 'staff', 'other-key', '2026-08-23', '2026-08-23')

    const addTrusted = sqlite.prepare('INSERT INTO auth_trusted_logins (staff_id, marker_hash, ip_prefix, confirmed_at) VALUES (?, ?, ?, ?)')
    addTrusted.run('target', 'target-device-1', '192.0.2.0/24', '2026-08-23T10:00:00Z')
    addTrusted.run('target', 'target-device-2', '192.0.2.0/24', '2026-08-23T10:00:00Z')
    addTrusted.run('other', 'other-device', '192.0.2.0/24', '2026-08-23T10:00:00Z')

    await revokeStaffAuthentication(db, 'target')

    expect(sqlite.prepare('SELECT token_hash FROM admin_sessions ORDER BY token_hash').all()).toEqual([{ token_hash: 's-other' }])
    expect(sqlite.prepare('SELECT token_hash FROM admin_two_factor_challenges ORDER BY token_hash').all()).toEqual([{ token_hash: 'c-other' }])
    expect(sqlite.prepare('SELECT staff_id, marker_hash FROM auth_trusted_logins ORDER BY staff_id, marker_hash').all()).toEqual([{ staff_id: 'other', marker_hash: 'other-device' }])
  })
})
