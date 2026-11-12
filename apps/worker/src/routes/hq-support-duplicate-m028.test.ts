import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';

const mail = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../services/plain-mail.js', () => ({ sendPlainMail: mail.send }));

const { hqSupport } = await import('./hq-support.js');

let testDb: SqliteD1;

const staffOf = (overrides: Partial<AuthenticatedStaff> = {}): AuthenticatedStaff => ({
  id: 'staff-1',
  name: '見本 141',
  role: 'admin',
  readOnly: false,
  tenantId: DEFAULT_TENANT_ID,
  ...overrides,
});

function app(staff: AuthenticatedStaff) {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.set('staff', staff);
    return next();
  });
  instance.route('/', hqSupport);
  return instance;
}

function env(): Env['Bindings'] {
  return {
    DB: testDb.db,
    IMAGES: {
      put: vi.fn(async () => {}),
    } as unknown as R2Bucket,
    WORKER_URL: 'https://api.example.com',
    CONTACT_EMAIL: 'ops@example.com',
  } as Env['Bindings'];
}

function post(body: unknown) {
  return app(staffOf()).request('/api/hq/support/requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, env());
}

const REQUEST = { kind: 'bug', subject: 'バナー生成で文字が崩れる', body: '2枚に1枚は誤字になります。' };

function rowCount(): number {
  const row = testDb.raw.prepare('SELECT COUNT(*) AS n FROM hq_support_requests').get() as { n: number };
  return row.n;
}

beforeEach(() => {
  testDb = createTestD1();
  mail.send.mockReset();
  testDb.raw.prepare("INSERT INTO tenants (id, name) VALUES ('tenant-2', '別の統括')").run();
  testDb.raw.prepare(
    `INSERT INTO staff_members (id, name, email, role, api_key, tenant_id) VALUES ('staff-1', '見本 141', 'masato@example.com', 'admin', 'key-1', ?)`,
  ).run(DEFAULT_TENANT_ID);
});

/**
 * 送信の再送で重複チケット（べき等キーなし）。
 * 確定応答を失った再送（同じ人・同じ内容の直近の送信）は、
 * 新しいチケットを作らず、既存のものを返す。
 */
describe('M028 お問い合わせ送信の重複防止', () => {
  it('同じ内容の送り直しは新しいチケットを作らない', async () => {
    const first = await post(REQUEST);
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { success: boolean; data: { id: string } };
    const second = await post(REQUEST);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { success: boolean; data: { id: string } };
    expect(secondBody.data.id).toBe(firstBody.data.id);
    expect(rowCount()).toBe(1);
  });

  it('重複の返却では運営への知らせを送り直さない', async () => {
    await post(REQUEST);
    const callsAfterFirst = mail.send.mock.calls.length;
    await post(REQUEST);
    expect(mail.send.mock.calls.length).toBe(callsAfterFirst);
  });

  it('内容が違えば新しいチケットになる', async () => {
    await post(REQUEST);
    const res = await post({ ...REQUEST, body: '別の本文です。' });
    expect(res.status).toBe(201);
    expect(rowCount()).toBe(2);
  });
});
