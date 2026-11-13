import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listAccessUsers, listAuditEvents, recordAuditEvent } from '../src/access-audit.js';
import { asD1 } from './d1-test-helper.js';

/*
 * ログインユーザー検索が不存在語で0件にならない。
 *
 * 画面の検索欄は「人の名前・メールで検索」。照合は表示中の
 * 名前・職位・（権限のあるとき）メールだけに限る。
 *   - 権限のかたまりの内部ID（administrator / view_only …英字enum）を
 *     検索対象にしていたため、"admin" や "view" で見た目に無い語へ
 *     行を返していた。
 *   - 監査検索（listAuditEvents）はユーザー語を %…% の LIKE に渡して
 *     いたため、`%`・`_` がワイルドカードとして効き、かつ D1 の LIKE
 *     パターン 50 バイト上限で長文がサーバーエラーになっていた。
 */
const TENANT = '00000000-0000-4000-8000-000000000001';
let sqlite: Database.Database;
let db: D1Database;

function addAccount(id: string) {
  sqlite.prepare(
    `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, tenant_id)
     VALUES (?, ?, ?, 'token', 'secret', ?)`,
  ).run(id, `channel-${id}`, id, TENANT);
}

function addStaff(input: {
  id: string;
  name?: string;
  email?: string;
  role?: 'owner' | 'admin' | 'staff';
  accessLevel?: 'full' | 'read_only';
  active?: number;
  inviteStatus?: string;
  accountId?: string;
}) {
  sqlite.prepare(
    `INSERT INTO staff_members
       (id, name, email, role, api_key, is_active, access_level, permission_keys,
        notification_preferences, invite_status, invite_expires_at, totp_secret_enc,
        totp_enabled_at, account_scope, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '{}', ?, NULL, NULL, NULL, 'accounts', ?)`,
  ).run(
    input.id,
    input.name ?? input.id,
    input.email === undefined ? `${input.id}@example.com` : input.email,
    input.role ?? 'staff',
    `key-${input.id}`,
    input.active ?? 1,
    input.accessLevel ?? 'full',
    input.inviteStatus ?? 'active',
    TENANT,
  );
  if (input.accountId) {
    sqlite.prepare(
      `INSERT INTO staff_account_scopes (staff_id, line_account_id, created_at) VALUES (?, ?, ?)`,
    ).run(input.id, input.accountId, '2026-09-01T00:00:00.000Z');
  }
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(readFileSync(join(import.meta.dirname, '..', 'bootstrap.sql'), 'utf8'));
  db = asD1(sqlite);
  addAccount('account-a');
});

const listInput = {
  tenantId: TENANT,
  allowedLineAccountIds: ['account-a'],
  now: '2026-09-23T00:00:00.000Z',
  limit: 50,
};

describe('ログインユーザー検索の照合範囲 (#620)', () => {
  beforeEach(() => {
    addStaff({ id: 'staff-yamada', name: '見本 141', email: 'yamada@mail.test', accountId: 'account-a' });
    addStaff({ id: 'staff-sato', name: '見本 122', email: 'sato@mail.test', accountId: 'account-a' });
    addStaff({ id: 'staff-owner', name: '管理者の人', email: 'owner@mail.test', role: 'owner', accountId: 'account-a' });
    addStaff({ id: 'staff-readonly', name: '閲覧の人', email: 'readonly@mail.test', accessLevel: 'read_only', accountId: 'account-a' });
  });

  it('不存在語は0件を返す', async () => {
    const result = await listAccessUsers(db, { ...listInput, query: '存在しない語zzz', includeEmailInSearch: true });
    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('名前・メールの部分一致は従来どおり効く', async () => {
    const byName = await listAccessUsers(db, { ...listInput, query: '141' });
    expect(byName.items.map((item) => item.id)).toEqual(['staff-yamada']);

    const byEmail = await listAccessUsers(db, { ...listInput, query: 'sato@mail', includeEmailInSearch: true });
    expect(byEmail.items.map((item) => item.id)).toEqual(['staff-sato']);
  });

  it('メールを読む権限がない人にはメールで一致させない', async () => {
    const result = await listAccessUsers(db, { ...listInput, query: 'sato@mail', includeEmailInSearch: false });
    expect(result.items).toHaveLength(0);
  });

  it('権限のかたまりの内部ID（英字enum）では一致しない', async () => {
    // 画面上は「管理者」「見るだけ」と出る。内部IDの administrator / view_only /
    // operations を検索語へ含めていたため、見た目に無い語でも行が返っていた。
    for (const term of ['admin', 'administrator', 'view', 'operations', 'reception']) {
      const result = await listAccessUsers(db, { ...listInput, query: term, includeEmailInSearch: true });
      expect(result.items, `query=${term}`).toHaveLength(0);
      expect(result.total, `query=${term}`).toBe(0);
    }
  });

  it('空白だけの検索語は絞り込みなしとして全件を返す', async () => {
    const result = await listAccessUsers(db, { ...listInput, query: '  　 ' });
    expect(result.items).toHaveLength(4);
  });

  it('長文の検索語でもエラーにせず0件を返す', async () => {
    const longQuery = 'な'.repeat(2000);
    const result = await listAccessUsers(db, { ...listInput, query: longQuery, includeEmailInSearch: true });
    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});

describe('入った記録検索の照合 (#620)', () => {
  beforeEach(async () => {
    addStaff({ id: 'staff-owner', name: '管理者の人', email: 'owner@mail.test', role: 'owner', accountId: 'account-a' });
    await recordAuditEvent(db, {
      id: 'event-a', tenantId: TENANT, lineAccountId: 'account-a', category: 'business',
      actorPrincipalId: 'staff-owner', action: 'broadcast.send',
      targetKind: 'broadcast', targetId: 'broadcast-1', result: 'success',
      createdAt: '2026-09-20T00:00:00.000Z',
    });
    await recordAuditEvent(db, {
      id: 'event-b', tenantId: TENANT, lineAccountId: 'account-a', category: 'auth',
      actorPrincipalId: 'staff-owner', action: 'auth.login', result: 'success',
      createdAt: '2026-09-21T00:00:00.000Z',
    });
  });

  it('不存在語は0件を返す', async () => {
    const result = await listAuditEvents(db, {
      tenantId: TENANT, allowedLineAccountIds: ['account-a'], lineAccountId: 'account-a', query: '存在しない語zzz',
    });
    expect(result.total).toBe(0);
    expect(result.items).toHaveLength(0);
  });

  it('人の名前・操作内容の部分一致は従来どおり効く', async () => {
    const byName = await listAuditEvents(db, {
      tenantId: TENANT, allowedLineAccountIds: ['account-a'], lineAccountId: 'account-a', query: '管理者',
    });
    expect(byName.items.map((item) => item.id).sort()).toEqual(['event-a', 'event-b']);

    const byAction = await listAuditEvents(db, {
      tenantId: TENANT, allowedLineAccountIds: ['account-a'], lineAccountId: 'account-a', query: 'broadcast',
    });
    expect(byAction.items.map((item) => item.id)).toEqual(['event-a']);
  });

  it('検索語の % や _ をワイルドカードとして扱わない', async () => {
    // `%語%` の LIKE のままだと、「%」1文字で全件に一致してしまう。
    for (const term of ['%', '_']) {
      const result = await listAuditEvents(db, {
        tenantId: TENANT, allowedLineAccountIds: ['account-a'], lineAccountId: 'account-a', query: term,
      });
      expect(result.total, `query=${term}`).toBe(0);
    }
  });

  it('action 絞り込みでも % はワイルドカードにしない', async () => {
    const result = await listAuditEvents(db, {
      tenantId: TENANT, allowedLineAccountIds: ['account-a'], lineAccountId: 'account-a', action: '%',
    });
    expect(result.total).toBe(0);
  });

  it('長文の検索語・長い action でもエラーにしない（D1 LIKE 50バイト上限対策）', async () => {
    const longQuery = 'な'.repeat(2000);
    const byQuery = await listAuditEvents(db, {
      tenantId: TENANT, allowedLineAccountIds: ['account-a'], lineAccountId: 'account-a', query: longQuery,
    });
    expect(byQuery.total).toBe(0);

    const byAction = await listAuditEvents(db, {
      tenantId: TENANT, allowedLineAccountIds: ['account-a'], lineAccountId: 'account-a', action: longQuery,
    });
    expect(byAction.total).toBe(0);
  });
});
