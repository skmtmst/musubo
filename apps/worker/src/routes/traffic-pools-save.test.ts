import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Env } from '../worker-env.js';

const access = vi.hoisted(() => ({ allowed: true }));
vi.mock('../services/account-access.js', () => ({ canAccessAllLineAccounts: async () => access.allowed }));
const { trafficPools } = await import('./traffic-pools.js');
let sqlite: Database.Database;
let role = 'owner';
let race = false;
const original = '2099-10-10T00:00:00.000+09:00';
function asD1(): D1Database {
  function prepare(sql: string): D1PreparedStatement {
    const bound = (args: unknown[]): D1PreparedStatement => ({
      bind: (...values: unknown[]) => bound(values),
      async first<T>() { return (sqlite.prepare(sql).get(...args) as T | undefined) ?? null; },
      async all<T>() { return { success: true, results: sqlite.prepare(sql).all(...args) as T[], meta: {} }; },
      async run() {
        if (race && sql.startsWith('UPDATE traffic_pools')) {
          race = false;
          sqlite.prepare('UPDATE traffic_pools SET name = ?, updated_at = ? WHERE id = ?').run('相手の名前', '2099-10-10T00:00:00.001+09:00', 'p');
        }
        return { success: true, results: [], meta: { changes: sqlite.prepare(sql).run(...args).changes } };
      },
    } as unknown as D1PreparedStatement);
    return bound([]);
  }
  return { prepare } as unknown as D1Database;
}
function app() {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'fixture', name: 'fixture', role, readOnly: false } as Env['Variables']['staff']);
    await next();
  });
  app.route('/', trafficPools);
  return app;
}
function save(body: unknown) {
  return app().request('/api/traffic-pools/p', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, { DB: asD1() } as Env['Bindings']);
}
beforeEach(() => {
  access.allowed = true; role = 'owner'; race = false;
  sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE line_accounts (id TEXT PRIMARY KEY, name TEXT, liff_id TEXT, login_channel_id TEXT, login_channel_secret TEXT, login_channel_secret_encrypted TEXT, channel_access_token TEXT, channel_access_token_encrypted TEXT, channel_id TEXT);
    CREATE TABLE traffic_pools (id TEXT PRIMARY KEY, slug TEXT, name TEXT, active_account_id TEXT, is_active INTEGER, created_at TEXT, updated_at TEXT, confirmation_revision INTEGER NOT NULL DEFAULT 1);
    INSERT INTO line_accounts (id,name) VALUES ('a','試験の店');`);
  sqlite.prepare('INSERT INTO traffic_pools (id,slug,name,active_account_id,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('p', 'main', '元の名前', 'a', 1, original, original);
});
afterEach(() => { sqlite.close(); });
it('読み直しに保存版を返し、版を送った名前の保存で必ず版が進む', async () => {
  const latest = await app().request('/api/traffic-pools/p', {}, { DB: asD1() } as Env['Bindings']);
  expect(latest.status).toBe(200);
  expect(await latest.json()).toMatchObject({ data: { name: '元の名前', updatedAt: original } });
  const saved = await save({ name: '新しい名前', expectedUpdatedAt: original });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ data: { name: '新しい名前', updatedAt: '2099-10-10T00:00:00.001+09:00' } });
});
it('同じ保存版から2人が保存したら片方だけ通し、先の名前を上書きしない', async () => {
  const responses = await Promise.all([save({ name: '先の名前', expectedUpdatedAt: original }), save({ name: '後の名前', expectedUpdatedAt: original })]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
  const conflict = responses.find(r => r.status === 409)!;
  expect(await conflict.json()).toMatchObject({ code: 'save_conflict', updatedAt: '2099-10-10T00:00:00.001+09:00' });
  expect(sqlite.prepare('SELECT name FROM traffic_pools').get()).toEqual({ name: '先の名前' });
});
it('読んだ後・書く直前に他人が保存しても原子的な照合で止める', async () => {
  race = true;
  const response = await save({ name: '上書きしない', expectedUpdatedAt: original });
  expect(response.status).toBe(409);
  expect(sqlite.prepare('SELECT name FROM traffic_pools').get()).toEqual({ name: '相手の名前' });
});
it('名前保存は保存版なし・空欄・違う型を断る', async () => {
  for (const body of [{ name: '版なし' }, { name: ' ', expectedUpdatedAt: original }]) {
    expect((await save(body)).status).toBe(422);
  }
  expect((await save({ name: '型違い', expectedUpdatedAt: 1 })).status).toBe(400);
  expect(sqlite.prepare('SELECT name FROM traffic_pools').get()).toEqual({ name: '元の名前' });
});
it('owner以外の保存と見えないプールの読み直しを断る', async () => {
  role = 'staff'; expect((await save({ name: '変更', expectedUpdatedAt: original })).status).toBe(403);
  const staffRead = await app().request('/api/traffic-pools/p', {}, { DB: asD1() } as Env['Bindings']);
  expect(staffRead.status).toBe(403);
  role = 'admin';
  expect((await app().request('/api/traffic-pools/p', {}, { DB: asD1() } as Env['Bindings'])).status).toBe(200);
  access.allowed = false;
  const response = await app().request('/api/traffic-pools/p', {}, { DB: asD1() } as Env['Bindings']);
  expect(response.status).toBe(404);
});
