import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { Miniflare } from 'miniflare';
import type { Env } from '../worker-env.js';

const access = vi.hoisted(() => ({
  canAccessAllLineAccounts: vi.fn(async () => true),
}));
vi.mock('../services/account-access.js', () => access);

const { default: booking } = await import('./booking.js');
type RealD1 = Awaited<ReturnType<Miniflare['getD1Database']>>;

let mf: Miniflare;
let db: RealD1;

async function applyBootstrap(target: RealD1): Promise<void> {
  const sql = readFileSync(resolve(process.cwd(), '../../packages/db/bootstrap.sql'), 'utf8')
    .split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
  const statements = sql.split('\n').reduce<string[]>((out, line) => {
    const last = out.length - 1;
    out[last] = out[last] ? `${out[last]}\n${line}` : line;
    if (line.trimEnd().endsWith(';')) out.push('');
    return out;
  }, ['']).map((statement) => statement.trim()).filter(Boolean);
  for (let index = 0; index < statements.length; index += 50) {
    await target.batch(statements.slice(index, index + 50).map((statement) => target.prepare(statement)));
  }
}

function appFor(target: D1Database) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'owner-1', name: '管理者', role: 'owner', readOnly: false });
    return next();
  });
  app.route('/', booking);
  return { app, env: { DB: target } as Env['Bindings'] };
}

const validStaff = {
  name: '  見本 170  ',
  display_name: '  みさき  ',
  role: '  トリミング担当  ',
  profile_image_url: '  https://example.test/staff.png  ',
  bio: '  小型犬が得意です。  ',
  sort_order: 12,
  is_designation_optional: 0,
  is_active: 1,
};

async function request(path: string, method: 'POST' | 'PUT', body: unknown) {
  const { app, env } = appFor(db);
  return app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, env);
}

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  });
  db = await mf.getD1Database('DB');
  await applyBootstrap(db);
  await db.batch([
    db.prepare(`INSERT INTO line_accounts
      (id,channel_id,name,channel_access_token,channel_secret)
      VALUES ('account-a','channel-a','A店','token-a','secret-a')`),
    db.prepare(`INSERT INTO line_accounts
      (id,channel_id,name,channel_access_token,channel_secret)
      VALUES ('account-b','channel-b','B店','token-b','secret-b')`),
  ]);
}, 120_000);

afterAll(async () => { await mf?.dispose(); });

beforeEach(async () => {
  access.canAccessAllLineAccounts.mockClear();
  await db.prepare('DELETE FROM staff').run();
  await db.batch([
    db.prepare(`INSERT INTO staff
      (id,line_account_id,name,display_name,role,profile_image_url,bio,sort_order)
      VALUES ('staff-a','account-a','既存名','既存表示','担当',NULL,'既存紹介',3)`),
    db.prepare(`INSERT INTO staff
      (id,line_account_id,name,display_name,role,profile_image_url,bio,sort_order)
      VALUES ('staff-b','account-b','B店担当','B店表示','担当',NULL,'B店紹介',4)`),
  ]);
});

describe('予約スタッフ入力 HTTP（実D1）', () => {
  test.each([
    ['空白名', { ...validStaff, name: '   ' }],
    ['不正型', { ...validStaff, display_name: 123 }],
    ['過長値', { ...validStaff, bio: 'あ'.repeat(2_001) }],
    ['不正URL', { ...validStaff, profile_image_url: 'javascript:alert(1)' }],
    ['範囲外整数', { ...validStaff, sort_order: 1_000_001 }],
  ])('%sを422にして作成しない', async (_label, body) => {
    const before = await db.prepare('SELECT COUNT(*) AS count FROM staff').first<{ count: number }>();
    const response = await request('/api/booking/admin/staff?account_id=account-a', 'POST', body);
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: 'booking_staff_validation_failed' });
    const after = await db.prepare('SELECT COUNT(*) AS count FROM staff').first<{ count: number }>();
    expect(after?.count).toBe(before?.count);
  });

  test('正常値をtrimして保存し、GETで同じ値を再読込できる', async () => {
    const response = await request('/api/booking/admin/staff?account_id=account-a', 'POST', validStaff);
    expect(response.status).toBe(201);
    const { id } = await response.json() as { id: string };

    const admin = appFor(db);
    const listed = await admin.app.request(
      '/api/booking/admin/staff?account_id=account-a', {}, admin.env,
    );
    const rows = (await listed.json() as { staff: Array<Record<string, unknown>> }).staff;
    expect(rows.find((row) => row.id === id)).toMatchObject({
      name: '見本 170', display_name: 'みさき', role: 'トリミング担当',
      profile_image_url: 'https://example.test/staff.png', bio: '小型犬が得意です。', sort_order: 12,
      is_designation_optional: 0, is_active: 1,
    });
  });

  test('booleanフラグも受け付け、従来の0/1と同じDB値で保存する', async () => {
    const response = await request('/api/booking/admin/staff?account_id=account-a', 'POST', {
      ...validStaff,
      name: '停止中担当',
      display_name: '停止中担当',
      is_designation_optional: true,
      is_active: false,
    });
    expect(response.status).toBe(201);
    const { id } = await response.json() as { id: string };
    const row = await db.prepare(`SELECT is_designation_optional,is_active FROM staff WHERE id = ?`)
      .bind(id).first();
    expect(row).toEqual({ is_designation_optional: 1, is_active: 0 });
  });

  test('部分更新は送った項目だけtrimして、他の項目を保持する', async () => {
    const response = await request(
      '/api/booking/admin/staff/staff-a?account_id=account-a',
      'PUT',
      { role: '  店長  ' },
    );
    expect(response.status).toBe(200);
    const row = await db.prepare(`SELECT name,display_name,role,bio,sort_order
      FROM staff WHERE id = 'staff-a'`).first();
    expect(row).toEqual({
      name: '既存名', display_name: '既存表示', role: '店長', bio: '既存紹介', sort_order: 3,
    });
  });

  test('別accountのidを更新できず、対象行を変えない', async () => {
    const response = await request(
      '/api/booking/admin/staff/staff-b?account_id=account-a',
      'PUT',
      { name: '侵入更新' },
    );
    expect(response.status).toBe(404);
    const row = await db.prepare(`SELECT name,line_account_id FROM staff WHERE id = 'staff-b'`).first();
    expect(row).toEqual({ name: 'B店担当', line_account_id: 'account-b' });
  });

  test.each([
    ['空白名', { name: '   ' }],
    ['不正型', { role: { value: '店長' } }],
    ['過長値', { bio: 'あ'.repeat(2_001) }],
    ['不正URL', { profile_image_url: 'file:///tmp/avatar.png' }],
    ['範囲外整数', { sort_order: -1 }],
  ])('更新の%sも422にして、既存行を変えない', async (_label, body) => {
    const before = await db.prepare(`SELECT name,display_name,role,profile_image_url,bio,sort_order
      FROM staff WHERE id = 'staff-a'`).first();
    const response = await request(
      '/api/booking/admin/staff/staff-a?account_id=account-a',
      'PUT',
      body,
    );
    expect(response.status).toBe(422);
    const after = await db.prepare(`SELECT name,display_name,role,profile_image_url,bio,sort_order
      FROM staff WHERE id = 'staff-a'`).first();
    expect(after).toEqual(before);
  });
});
