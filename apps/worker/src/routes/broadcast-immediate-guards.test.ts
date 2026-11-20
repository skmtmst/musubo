import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';

// 即時送信の直前に送信枠と後続アクション版を見直す。
// 実 route＋実DBで確かめる。通信の境界だけ差し替える：
// LINE API の枠取得は global fetch、LINE 送信は LineClient。
const lineCalls = vi.hoisted(() => ({ broadcast: 0, failTimes: 0 }));
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: class {
    async broadcast() {
      lineCalls.broadcast++;
      if (lineCalls.failTimes > 0) {
        lineCalls.failTimes--;
        throw new Error('LINE temporarily unavailable');
      }
      return { requestId: 'req-1' };
    }
    async multicast() {
      return { requestId: 'req-1' };
    }
    async push() {
      return { requestId: 'req-1' };
    }
  },
}));
vi.mock('../services/account-access.js', () => ({
  getVisibleLineAccountScope: async () => ({
    allowedAccountIds: ['acc-1', 'acc-2'],
    canSeeUnassigned: true,
  }),
  canAccessAllLineAccounts: async () => true,
}));
vi.mock('../lib/step-up.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/step-up.js')>();
  return { ...original, sensitiveStepUpSatisfied: vi.fn(async (c, purpose) =>
    c.req.header('X-Test-Step-Up') === 'verified' || original.sensitiveStepUpSatisfied(c, purpose)) };
});

const { broadcasts } = await import('./broadcasts.js');

function setupApp(testDb: SqliteD1) {
  const app = new Hono<{
    Bindings: { DB: D1Database; LINE_CHANNEL_ACCESS_TOKEN: string; WORKER_URL: string };
    Variables: { staff: AuthenticatedStaff };
  }>();
  app.use('*', async (c, next) => {
    c.env = { DB: testDb.db, LINE_CHANNEL_ACCESS_TOKEN: 'default-token', WORKER_URL: 'https://worker.test' };
    c.set('staff', {
      id: 'staff-1',
      name: 'Staff',
      role: 'owner',
      readOnly: false,
      permissionKeys: [],
      assignedLineAccountId: null,
      canAccessDescendantAccounts: false,
      tenantId: 'tenant-1',
    });
    await next();
  });
  app.route('/', broadcasts);
  return app;
}

function seedBase(raw: SqliteD1['raw']) {
  raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('acc-1', 'ch-1', '本店', 'tok-1', 'sec-1')`).run();
  raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('acc-2', 'ch-2', '支店', 'tok-2', 'sec-2')`).run();
  raw.prepare(`INSERT INTO friends (id, line_user_id, line_account_id, is_following)
    VALUES ('friend-1', 'U1', 'acc-1', 1)`).run();
  raw.prepare(`INSERT INTO broadcasts
    (id, title, message_type, message_content, target_type, status, line_account_id, track_links)
    VALUES ('bc-1', 'お知らせ', 'text', 'こんにちは', 'all', 'draft', 'acc-1', 0)`).run();
  raw.prepare(`INSERT INTO common_actions (id, line_account_id, name, status)
    VALUES ('ca-1', 'acc-1', '特典', 'published')`).run();
  raw.prepare(`INSERT INTO common_action_versions (id, common_action_id, version_number, status)
    VALUES ('v-pub', 'ca-1', 1, 'published')`).run();
  raw.prepare(`INSERT INTO common_action_versions (id, common_action_id, version_number, status)
    VALUES ('v-draft', 'ca-1', 2, 'draft')`).run();
  raw.prepare(`INSERT INTO common_actions (id, line_account_id, name, status)
    VALUES ('ca-2', 'acc-2', '特典', 'published')`).run();
  raw.prepare(`INSERT INTO common_action_versions (id, common_action_id, version_number, status)
    VALUES ('v-other', 'ca-2', 1, 'published')`).run();
}

function setAfterAction(raw: SqliteD1['raw'], versionId: string | null) {
  raw.prepare(`UPDATE broadcasts SET after_action_version_id = ? WHERE id = 'bc-1'`).run(versionId);
}

function stubQuota(limit: number, used: number) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', (async (url: unknown) => {
    const path = String(url);
    calls.push(path);
    if (path.endsWith('/quota')) {
      return new Response(JSON.stringify({ type: 'limited', value: limit }), { status: 200 });
    }
    if (path.endsWith('/quota/consumption')) {
      return new Response(JSON.stringify({ totalUsage: used }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch);
  return calls;
}

function send(app: ReturnType<typeof setupApp>) {
  return app.request('/api/broadcasts/bc-1/send', {
    method: 'POST',
    headers: { 'X-Confirm-Irreversible': 'broadcast-send' },
  });
}

function rowOf(raw: SqliteD1['raw']) {
  return raw.prepare(`SELECT status FROM broadcasts WHERE id = 'bc-1'`).get() as { status: string };
}

describe('N-062 即時送信の直前再確認', () => {
  beforeEach(() => {
    lineCalls.broadcast = 0;
    lineCalls.failTimes = 0;
    vi.unstubAllGlobals();
  });

  test('枠0では送らず409・LINE送信0・下書きのまま', async () => {
    const testDb = createTestD1();
    seedBase(testDb.raw);
    const quotaCalls = stubQuota(5, 5);
    const res = await send(setupApp(testDb));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ success: false });
    expect(lineCalls.broadcast).toBe(0);
    expect(rowOf(testDb.raw)).toEqual({ status: 'draft' });
    expect(quotaCalls.some((path) => path.includes('/quota'))).toBe(true);
  });

  test('枠ありでは送る・LINE送信1', async () => {
    const testDb = createTestD1();
    seedBase(testDb.raw);
    stubQuota(5, 0);
    const res = await send(setupApp(testDb));
    expect(res.status).toBe(200);
    expect(lineCalls.broadcast).toBe(1);
    expect(rowOf(testDb.raw).status).toBe('sent');
  });

  test('公開取消の後続版では送らず409・LINE送信0', async () => {
    const testDb = createTestD1();
    seedBase(testDb.raw);
    setAfterAction(testDb.raw, 'v-draft');
    stubQuota(5, 0);
    const res = await send(setupApp(testDb));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ success: false });
    expect(lineCalls.broadcast).toBe(0);
    expect(rowOf(testDb.raw)).toEqual({ status: 'draft' });
  });

  test('欠損の後続版では送らず409・LINE送信0', async () => {
    const testDb = createTestD1();
    seedBase(testDb.raw);
    testDb.raw.prepare(`UPDATE broadcasts SET after_action_version_id = 'v-gone' WHERE id = 'bc-1'`).run();
    stubQuota(5, 0);
    const res = await send(setupApp(testDb));
    expect(res.status).toBe(409);
    expect(lineCalls.broadcast).toBe(0);
    expect(rowOf(testDb.raw)).toEqual({ status: 'draft' });
  });

  test('他アカウントの後続版では送らず409・LINE送信0', async () => {
    const testDb = createTestD1();
    seedBase(testDb.raw);
    setAfterAction(testDb.raw, 'v-other');
    stubQuota(5, 0);
    const res = await send(setupApp(testDb));
    expect(res.status).toBe(409);
    expect(lineCalls.broadcast).toBe(0);
    expect(rowOf(testDb.raw)).toEqual({ status: 'draft' });
  });

  test('公開中の後続版つきは送る・LINE送信1', async () => {
    const testDb = createTestD1();
    seedBase(testDb.raw);
    setAfterAction(testDb.raw, 'v-pub');
    stubQuota(5, 0);
    const res = await send(setupApp(testDb));
    expect(res.status).toBe(200);
    expect(lineCalls.broadcast).toBe(1);
    expect(rowOf(testDb.raw).status).toBe('sent');
  });

  test('残枠1で他配信が予約中なら送らず409・LINE送信0', async () => {
    const testDb = createTestD1();
    seedBase(testDb.raw);
    // 別の配信が枠1を予約して持ち去った形（上限5・使用4・他予約1）。
    testDb.raw.prepare(
      `INSERT INTO account_settings (id, line_account_id, key, value)
       VALUES ('quota-reservations-acc-1', 'acc-1', 'broadcast_quota_reservations', ?)`,
    ).run(JSON.stringify([{ broadcastId: 'bc-2', planned: 1, reservedAt: Date.now() }]));
    stubQuota(5, 4);
    const res = await send(setupApp(testDb));
    expect(res.status).toBe(409);
    expect(lineCalls.broadcast).toBe(0);
    expect(rowOf(testDb.raw)).toEqual({ status: 'draft' });
  });

  test('予約が外れれば送れる（古い置き去りは数えない）', async () => {
    const testDb = createTestD1();
    seedBase(testDb.raw);
    // 31分前の置き去り予約は無効。他配信の有効な予約はない。
    testDb.raw.prepare(
      `INSERT INTO account_settings (id, line_account_id, key, value)
       VALUES ('quota-reservations-acc-1', 'acc-1', 'broadcast_quota_reservations', ?)`,
    ).run(JSON.stringify([{ broadcastId: 'bc-2', planned: 1, reservedAt: Date.now() - 31 * 60 * 1000 }]));
    stubQuota(5, 4);
    const res = await send(setupApp(testDb));
    expect(res.status).toBe(200);
    expect(lineCalls.broadcast).toBe(1);
    expect(rowOf(testDb.raw).status).toBe('sent');
  });

  test('送信失敗時は予約を外し下書きを保ち、次は送れる', async () => {
    const testDb = createTestD1();
    seedBase(testDb.raw);
    stubQuota(5, 0);
    const app = setupApp(testDb);
    lineCalls.failTimes = 1;
    await send(app);
    // 失敗しても下書きに戻り、予約行は外れている。
    expect(rowOf(testDb.raw).status).toBe('draft');
    const reservations = testDb.raw.prepare(
      `SELECT value FROM account_settings WHERE line_account_id = 'acc-1' AND key = 'broadcast_quota_reservations'`,
    ).get() as { value: string } | undefined;
    expect(reservations === undefined || reservations.value === '[]').toBe(true);
    const second = await send(app);
    expect(second.status).toBe(200);
    expect(rowOf(testDb.raw).status).toBe('sent');
  });
});


describe('過去日時からの確認なし送信を防ぐ', () => {
  test.each([
    { saveAsDraft: true },
    { scheduledAt: null },
  ])('期限切れの予約は %s で下書きに戻せる', async (change) => {
    const db = createTestD1(); seedBase(db.raw);
    db.raw.prepare("UPDATE broadcasts SET status = 'scheduled', scheduled_at = '2000-01-01T00:00:00Z' WHERE id = 'bc-1'").run();
    const response = await setupApp(db).request('/api/broadcasts/bc-1', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Test-Step-Up': 'verified' },
      body: JSON.stringify({ ...change, expectedVersion: 1 }),
    });
    expect(response.status).toBe(200);
    expect(rowOf(db.raw)).toEqual({ status: 'draft' });
    db.raw.close();
  });
  test.each([null, '2099-01-01T00:00:00Z'])('日時 %s は作成・更新できる', async (scheduledAt) => {
    const db = createTestD1(); seedBase(db.raw);
    const app = setupApp(db);
    for (const method of ['POST', 'PUT']) {
      const response = await app.request(method === 'POST' ? '/api/broadcasts' : '/api/broadcasts/bc-1', {
        method, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '配信', messageType: 'text', messageContent: '本文', targetType: 'all', lineAccountId: 'acc-1', expectedVersion: 1, scheduledAt }),
      });
      expect(response.status).toBe(method === 'POST' ? 201 : 200);
    }
    db.raw.close();
  });
  test('期限が過ぎた予約は日時を省いた更新でも保存しない', async () => {
    const db = createTestD1(); seedBase(db.raw);
    db.raw.prepare("UPDATE broadcasts SET status = 'scheduled', scheduled_at = '2000-01-01T00:00:00Z' WHERE id = 'bc-1'").run();
    const response = await setupApp(db).request('/api/broadcasts/bc-1', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Test-Step-Up': 'verified' },
      body: JSON.stringify({ title: '変更後', expectedVersion: 1 }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'SCHEDULE_MUST_BE_FUTURE', fields: { scheduledAt: expect.any(String) } });
    expect(db.raw.prepare("SELECT title FROM broadcasts WHERE id = 'bc-1'").get()).toEqual({ title: 'お知らせ' });
    db.raw.close();
  });
  test.each(['2000-01-01T00:00:00Z', 'not-a-date', ''])('作成・更新は不正な予約日時 %s を保存しない', async (scheduledAt) => {
    const db = createTestD1(); seedBase(db.raw);
    const app = setupApp(db);
    for (const method of ['POST', 'PUT']) {
      const response = await app.request(method === 'POST' ? '/api/broadcasts' : '/api/broadcasts/bc-1', {
        method, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '予約', messageType: 'text', messageContent: '本文', targetType: 'all', lineAccountId: 'acc-1', expectedVersion: 1, scheduledAt }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'SCHEDULE_MUST_BE_FUTURE' });
    }
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM broadcasts').get()).toEqual({ n: 1 });
    expect(rowOf(db.raw)).toEqual({ status: 'draft' });
    db.raw.close();
  });
});
