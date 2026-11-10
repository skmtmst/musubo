/*
 * シナリオ変更の共通境界。
 *
 * 実DB（better-sqlite3 + bootstrap.sql）に実物の scenarios ルートを当てる。
 * 改名・通常編集(PUT)・きっかけ(triggers)・公開(publish)を同じ権限契約へ揃える。
 *   - owner/adminは従来どおり通る
 *   - scenario.definition.edit持ちstaffは自accountの行だけ通る
 *   - 表示だけ・キーなし・readOnly・別accountは止まる
 */
import { beforeEach, describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';

const { scenarios } = await import('./scenarios.js');

let sqlite: SqliteD1;

const owner: AuthenticatedStaff = {
  id: 'owner-1', name: 'オーナー', role: 'owner', readOnly: false, tenantId: 'tenant-1',
};
const editStaff: AuthenticatedStaff = {
  id: 'staff-edit', name: '編集権あり', role: 'staff', readOnly: false, tenantId: 'tenant-1',
  permissionKeys: ['/scenarios', 'scenario.definition.edit'],
};
const viewStaff: AuthenticatedStaff = {
  id: 'staff-view', name: '表示だけ', role: 'staff', readOnly: false, tenantId: 'tenant-1',
  permissionKeys: ['/scenarios'],
};
const noKeyStaff: AuthenticatedStaff = {
  id: 'staff-none', name: '権限なし', role: 'staff', readOnly: false, tenantId: 'tenant-1',
  permissionKeys: [],
};
const readOnlyStaff: AuthenticatedStaff = {
  id: 'staff-ro', name: '読取専用', role: 'staff', readOnly: true, tenantId: 'tenant-1',
  permissionKeys: ['/scenarios', 'scenario.definition.edit'],
};
const scopedAdmin: AuthenticatedStaff = {
  id: 'admin-scoped', name: '店1だけ', role: 'admin', readOnly: false, tenantId: 'tenant-1',
};
const scopedEditStaff: AuthenticatedStaff = {
  id: 'staff-scoped', name: '店1だけ編集可', role: 'staff', readOnly: false, tenantId: 'tenant-1',
  permissionKeys: ['/scenarios', 'scenario.definition.edit'],
};

function app(staff: AuthenticatedStaff) {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.env = { DB: sqlite.db } as Env['Bindings'];
    c.set('staff', staff);
    await next();
  });
  instance.route('/', scenarios);
  return instance;
}

function put(id: string, body: unknown, staff: AuthenticatedStaff = owner) {
  return app(staff).request(`/api/scenarios/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function postTrigger(id: string, body: unknown, staff: AuthenticatedStaff = owner) {
  return app(staff).request(`/api/scenarios/${id}/triggers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function postPublish(id: string, staff: AuthenticatedStaff = owner) {
  return app(staff).request(`/api/scenarios/${id}/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': '11111111-2222-4333-8444-555555555555' },
    body: JSON.stringify({}),
  });
}

function seed(): void {
  const raw = sqlite.raw;
  raw.prepare(`INSERT INTO tenants (id, name) VALUES ('tenant-1', '統括1')`).run();
  for (const id of ['acc-1', 'acc-2']) {
    raw.prepare(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
       VALUES (?, ?, ?, 'token', 'secret', 1, 'tenant-1')`,
    ).run(id, `channel-${id}`, id);
  }
  const staffRows = [
    ['owner-1', 'オーナー', 'owner', 'key-owner', 'all', '[]'],
    ['staff-edit', '編集権あり', 'staff', 'key-edit', 'all', '["/scenarios","scenario.definition.edit"]'],
    ['staff-view', '表示だけ', 'staff', 'key-view', 'all', '["/scenarios"]'],
    ['staff-none', '権限なし', 'staff', 'key-none', 'all', '[]'],
    ['staff-ro', '読取専用', 'staff', 'key-ro', 'all', '["/scenarios","scenario.definition.edit"]'],
    ['admin-scoped', '店1だけ', 'admin', 'key-scoped', 'accounts', '[]'],
    ['staff-scoped', '店1だけ編集可', 'staff', 'key-scoped-edit', 'accounts', '["/scenarios","scenario.definition.edit"]'],
  ] as const;
  for (const [id, name, role, key, scope, keys] of staffRows) {
    raw.prepare(
      `INSERT INTO staff_members (id, name, role, api_key, tenant_id, account_scope, permission_keys)
       VALUES (?, ?, ?, ?, 'tenant-1', ?, ?)`,
    ).run(id, name, role, key, scope, keys);
  }
  raw.prepare(
    `INSERT INTO staff_account_scopes (staff_id, line_account_id, created_at)
     VALUES ('admin-scoped', 'acc-1', '2026-09-01T00:00:00.000Z')`,
  ).run();
  raw.prepare(
    `INSERT INTO staff_account_scopes (staff_id, line_account_id, created_at)
     VALUES ('staff-scoped', 'acc-1', '2026-09-01T00:00:00.000Z')`,
  ).run();
  raw.prepare(
    `INSERT INTO scenarios (id, name, trigger_type, line_account_id) VALUES ('sc-1', '本店の筋書き', 'manual', 'acc-1')`,
  ).run();
  raw.prepare(
    `INSERT INTO scenarios (id, name, trigger_type, line_account_id) VALUES ('sc-2', '支店の筋書き', 'manual', 'acc-2')`,
  ).run();
}

function nameOf(id: string): string | null {
  const row = sqlite.raw.prepare(`SELECT name FROM scenarios WHERE id = ?`).get(id) as { name: string } | undefined;
  return row?.name ?? null;
}

beforeEach(() => {
  sqlite = createTestD1();
  seed();
});

describe('シナリオ変更の共通境界(N-051)', () => {
  test('編集権ありstaffは自accountの改名・通常編集ができる', async () => {
    const res = await put('sc-1', { name: '新しい名前' }, editStaff);
    expect(res.status).toBe(200);
    expect(nameOf('sc-1')).toBe('新しい名前');
  });

  test('編集権ありstaffも担当外accountは404で、行は動かない', async () => {
    const res = await put('sc-2', { name: '書き換え' }, scopedEditStaff);
    expect(res.status).toBe(404);
    expect(nameOf('sc-2')).toBe('支店の筋書き');
  });

  test('長い名前も担当外と存在しないシナリオを同じ404で返す', async () => {
    const body = { name: 'あ'.repeat(61) };
    const hidden = await put('sc-2', body, scopedEditStaff);
    const missing = await put('missing', body, scopedEditStaff);
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await hidden.json()).toEqual(await missing.json());
    expect(nameOf('sc-2')).toBe('支店の筋書き');
  });

  test('表示だけ・キーなし・readOnlyは403で、行は動かない', async () => {
    for (const staff of [viewStaff, noKeyStaff, readOnlyStaff]) {
      const res = await put('sc-1', { name: '書き換え' }, staff);
      expect(res.status).toBe(403);
    }
    expect(nameOf('sc-1')).toBe('本店の筋書き');
  });

  test('担当外アカウントの管理者は404', async () => {
    const res = await put('sc-2', { name: '書き換え' }, scopedAdmin);
    expect(res.status).toBe(404);
    expect(nameOf('sc-2')).toBe('支店の筋書き');
  });

  test('きっかけは編集権ありstaffが自accountへ付けられる', async () => {
    const res = await postTrigger('sc-1', { kind: 'friend_add' }, editStaff);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ kind: string }> };
    expect(body.data.some((t) => t.kind === 'friend_add')).toBe(true);
  });

  test('きっかけは権限なしstaffに403、担当外accountに404', async () => {
    const denied = await postTrigger('sc-1', { kind: 'friend_add' }, noKeyStaff);
    expect(denied.status).toBe(403);
    const hidden = await postTrigger('sc-2', { kind: 'friend_add' }, scopedEditStaff);
    expect(hidden.status).toBe(404);
  });

  test('公開は編集権だけのstaffでは自accountでもできない', async () => {
    const res = await postPublish('sc-1', editStaff);
    expect(res.status).toBe(403);
    expect(sqlite.raw.prepare("SELECT COUNT(*) AS n FROM scenario_versions WHERE scenario_id = 'sc-1'").get()).toEqual({ n: 0 });
  });

  test('公開は権限なしstaffに403、担当外accountに404', async () => {
    const denied = await postPublish('sc-1', noKeyStaff);
    expect(denied.status).toBe(403);
    const hidden = await postPublish('sc-2', scopedEditStaff);
    expect(hidden.status).toBe(404);
  });

  test('存在しない行はowner以外も後段の404に任せる', async () => {
    const res = await put('nope', { name: '書き換え' }, editStaff);
    expect(res.status).toBe(404);
  });
});


test('編集鍵のあるstaffも別シナリオの通をIDだけでは変えられない', async () => {
  sqlite.raw.prepare(`INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content)
    VALUES ('foreign-step', 'sc-2', 1, 0, 'text', '他の通')`).run();
  for (const [method, id] of [['DELETE', 'sc-1'], ['PUT', 'sc-1'], ['DELETE', 'missing']] as const) {
    const res = await app(editStaff).request(`/api/scenarios/${id}/steps/foreign-step`, {
      method, headers: { 'Content-Type': 'application/json' }, body: method === 'PUT' ? JSON.stringify({ delayMinutes: 30 }) : undefined,
    });
    expect(res.status).toBe(404);
    expect(sqlite.raw.prepare("SELECT message_content FROM scenario_steps WHERE id='foreign-step'").get()).toEqual({ message_content: '他の通' });
  }
});


test('編集できるstaffの一覧の並べ替えも、全件の担当範囲を確認してから保存する', async () => {
  sqlite.raw.prepare("UPDATE scenarios SET display_order=9 WHERE id='sc-1'").run();
  const reorder = (ids: string[], staff: AuthenticatedStaff) => app(staff).request('/api/scenarios/reorder', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
  });
  expect((await reorder(['sc-1', 'sc-2'], scopedEditStaff)).status).toBe(404);
  expect(sqlite.raw.prepare("SELECT display_order FROM scenarios WHERE id='sc-1'").get()).toEqual({ display_order: 9 });
  expect((await reorder(['sc-1', 'missing'], editStaff)).status).toBe(404);
  expect((await reorder(['sc-1'], scopedEditStaff)).status).toBe(200);
  expect(sqlite.raw.prepare("SELECT display_order FROM scenarios WHERE id='sc-1'").get()).toEqual({ display_order: 0 });
});
