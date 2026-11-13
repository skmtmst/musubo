import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';

const accountAccess = vi.hoisted(() => ({ canAccessAllLineAccounts: vi.fn(async () => true) }));
vi.mock('../services/account-access.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  canAccessAllLineAccounts: accountAccess.canAccessAllLineAccounts,
}));

const { nenCampaigns } = await import('./nen-campaigns.js');

/*
 * （配信設定・紹介文の同時保存）・（ペット登録の二重押し）・
 * （ペット更新の同時保存）を実SQLiteで見る。
 *
 * 版（expectedUpdatedAt）を送った保存だけが対象。送らない古い呼び出しは
 * 従来どおり通す（後方互換）。新しい呼び出しは、古い画面からの保存を
 * 409 で止め、最新の内容を data.latest で返す。
 */

const ACCOUNT = 'account-a';
let testDb: SqliteD1;

function app() {
  const instance = new Hono<any>();
  instance.use('*', async (c, next) => {
    c.set('staff', { id: 'owner-1', name: '担当者', role: 'owner', readOnly: false });
    c.env = { DB: testDb.db, WORKER_PUBLIC_URL: 'https://worker.test' };
    await next();
  });
  instance.route('/', nenCampaigns);
  return instance;
}

function put(path: string, body: unknown, headers?: Record<string, string>) {
  return app().request(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
    body: JSON.stringify(body),
  });
}

function post(path: string, body: unknown, headers?: Record<string, string>) {
  return app().request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
    body: JSON.stringify(body),
  });
}

function seed() {
  const raw = testDb.raw;
  raw.prepare(
    `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
     VALUES ('account-a', 'channel-a', 'A店', 'token-a', 'secret-a')`,
  ).run();
  raw.prepare(
    `INSERT INTO nen_campaign_settings
       (campaign_key, label, category, trigger_event, delay_days, delivery_time,
        is_enabled, title, body_text, button_label, button_url, image_url, created_at, updated_at)
     VALUES ('review_request', '口コミのお願い', 'follow_up', 'ec.order.delivered', 3, '10:00',
        1, '見出し', '本文', NULL, NULL, NULL, '2026-09-01', '2026-09-01')`,
  ).run();
  raw.prepare(
    `INSERT INTO nen_columns
       (id, slug, title, excerpt, intro_text, article_url, line_account_id, created_at, updated_at)
     VALUES ('column-1', 'column-1', '今週のコラム', '抜粋', '最初の紹介文',
        'https://example.test/1', 'account-a', '2026-09-01', '2026-09-01T00:00:00.000+09:00')`,
  ).run();
  raw.prepare(
    `INSERT INTO friends (id, line_user_id, display_name, line_account_id, is_following, created_at, updated_at)
     VALUES ('friend-a', 'U-friend-a', 'Aさん', 'account-a', 1, '2026-09-01', '2026-09-01')`,
  ).run();
  raw.prepare(
    `INSERT INTO nen_pet_profiles (id, friend_id, name, created_at, updated_at)
     VALUES ('pet-a', 'friend-a', 'ハナ', '2026-09-01', '2026-09-01T00:00:00.000+09:00')`,
  ).run();
}

function settingBody(title: string, expectedUpdatedAt?: string) {
  return {
    isEnabled: true, title, bodyText: '本文です', delayDays: 3, deliveryTime: '10:00',
    buttonLabel: '', buttonUrl: '', imageUrl: '',
    dedupWindowDays: 30, excludeFormRespondents: false, afterActions: [],
    ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
  };
}

function accountSettingUpdatedAt(): string | null {
  const row = testDb.raw.prepare(
    `SELECT value FROM account_settings WHERE line_account_id = ? AND key = ?`,
  ).get(ACCOUNT, 'nen.campaign.review_request') as { value: string } | undefined;
  if (!row) return null;
  return (JSON.parse(row.value) as { updated_at: string }).updated_at;
}

beforeEach(() => {
  testDb = createTestD1();
  seed();
  accountAccess.canAccessAllLineAccounts.mockResolvedValue(true);
});

describe('M507 配信設定の同時保存は古い画面からを409で止める', () => {
  it('版を送らない従来の保存はそのまま通る', async () => {
    const response = await put(
      '/api/nen-campaigns/settings/review_request?lineAccountId=account-a',
      settingBody('新しい見出し'),
    );
    expect(response.status).toBe(200);
  });

  it('合っている版は保存でき、古い版は最新の内容つきで409になる', async () => {
    const first = await put(
      '/api/nen-campaigns/settings/review_request?lineAccountId=account-a',
      settingBody('先の見出し'),
    );
    expect(first.status).toBe(200);
    const savedAt = accountSettingUpdatedAt();
    expect(savedAt).toBeTruthy();

    // 別の人が保存した想定で、直接書き換えて版を進める。
    const second = await put(
      '/api/nen-campaigns/settings/review_request?lineAccountId=account-a',
      settingBody('後の見出し', savedAt!),
    );
    expect(second.status).toBe(200);
    const latestAt = accountSettingUpdatedAt();
    expect(latestAt).not.toBe(savedAt);

    // 先に見た画面（古い版）からの保存は止まり、最新の題名が見える。
    const stale = await put(
      '/api/nen-campaigns/settings/review_request?lineAccountId=account-a',
      settingBody('古い画面の見出し', savedAt!),
    );
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as {
      success: boolean; code: string; data: { latest: { title: string; updatedAt: string } };
    };
    expect(body.code).toBe('VERSION_CONFLICT');
    expect(body.data.latest.title).toBe('後の見出し');
    expect(body.data.latest.updatedAt).toBe(latestAt);
    // 黙って上書きされていない。
    expect(accountSettingUpdatedAt()).toBe(latestAt);
  });
});

describe('M507 紹介文の同時保存は古い画面からを409で止める', () => {
  it('合っている版は保存でき、古い版は最新の紹介文つきで409になる', async () => {
    const first = await put(
      '/api/nen-campaigns/columns/column-1/message?lineAccountId=account-a',
      { introText: '先の紹介文', expectedUpdatedAt: '2026-09-01T00:00:00.000+09:00' },
    );
    expect(first.status).toBe(200);
    const saved = testDb.raw.prepare(
      `SELECT intro_text, updated_at FROM nen_columns WHERE id = 'column-1'`,
    ).get() as { intro_text: string; updated_at: string };

    const stale = await put(
      '/api/nen-campaigns/columns/column-1/message?lineAccountId=account-a',
      { introText: '古い画面の紹介文', expectedUpdatedAt: '2026-09-01T00:00:00.000+09:00' },
    );
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as {
      success: boolean; code: string; data: { latest: { introText: string; updatedAt: string } };
    };
    expect(body.code).toBe('VERSION_CONFLICT');
    expect(body.data.latest.introText).toBe(saved.intro_text);
    expect(body.data.latest.updatedAt).toBe(saved.updated_at);
  });

  it('無いコラムは409ではなく404のまま', async () => {
    const response = await put(
      '/api/nen-campaigns/columns/no-such-column/message?lineAccountId=account-a',
      { introText: '紹介文', expectedUpdatedAt: '2026-09-01T00:00:00.000+09:00' },
    );
    expect(response.status).toBe(404);
  });
});

describe('M510 ペット登録の二重押しは同じ再実行キーで1頭だけ', () => {
  const KEY = '123e4567-e89b-42d3-a456-426614174000';
  const payload = { friendId: 'friend-a', name: 'モモ', animalType: 'dog', gender: 'female' };

  function petCount(): number {
    return (testDb.raw.prepare(`SELECT COUNT(*) AS n FROM nen_pet_profiles`).get() as { n: number }).n;
  }

  it('同じキー・同じ内容の再送は2頭目を作らず保存済みを返す', async () => {
    const first = await post('/api/nen-campaigns/pets?lineAccountId=account-a', payload, { 'Idempotency-Key': KEY });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { success: boolean; data: { id: string } };

    const retry = await post('/api/nen-campaigns/pets?lineAccountId=account-a', payload, { 'Idempotency-Key': KEY });
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as { success: boolean; duplicate: boolean; data: { id: string } };
    expect(retryBody.duplicate).toBe(true);
    expect(retryBody.data.id).toBe(firstBody.data.id);
    expect(petCount()).toBe(2); // pet-a（種）＋ 新規1頭
  });

  it('同じキーで内容が違う再送は取り違えとして409で止める', async () => {
    const first = await post('/api/nen-campaigns/pets?lineAccountId=account-a', payload, { 'Idempotency-Key': KEY });
    expect(first.status).toBe(201);
    const conflict = await post(
      '/api/nen-campaigns/pets?lineAccountId=account-a',
      { ...payload, name: '別の名前' },
      { 'Idempotency-Key': KEY },
    );
    expect(conflict.status).toBe(409);
    expect(petCount()).toBe(2);
  });

  it('キーにならない文字列は400で作らない', async () => {
    const response = await post('/api/nen-campaigns/pets?lineAccountId=account-a', payload, { 'Idempotency-Key': 'short' });
    expect(response.status).toBe(400);
    expect(petCount()).toBe(1);
  });

  it('キーが無い従来の呼び出しはそのまま作る', async () => {
    const response = await post('/api/nen-campaigns/pets?lineAccountId=account-a', payload);
    expect(response.status).toBe(201);
  });
});

describe('M511 ペット更新の同時保存は古い画面からを409で止める', () => {
  function petRow() {
    return testDb.raw.prepare(
      `SELECT name, updated_at FROM nen_pet_profiles WHERE id = 'pet-a'`,
    ).get() as { name: string; updated_at: string };
  }

  it('合っている版は保存でき、古い版は最新の名前つきで409になる', async () => {
    const first = await put(
      '/api/nen-campaigns/pets/pet-a?lineAccountId=account-a',
      { name: '先の名前', expectedUpdatedAt: '2026-09-01T00:00:00.000+09:00' },
    );
    expect(first.status).toBe(200);
    const saved = petRow();

    const stale = await put(
      '/api/nen-campaigns/pets/pet-a?lineAccountId=account-a',
      { name: '古い画面の名前', expectedUpdatedAt: '2026-09-01T00:00:00.000+09:00' },
    );
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as {
      success: boolean; code: string; data: { latest: { name: string; updatedAt: string } };
    };
    expect(body.code).toBe('VERSION_CONFLICT');
    expect(body.data.latest.name).toBe(saved.name);
    expect(body.data.latest.updatedAt).toBe(saved.updated_at);
    expect(petRow().name).toBe(saved.name);
  });
});

describe('M507/M511 一覧のペットにも版を返す', () => {
  it('GET /api/nen-campaigns/pets の行に updatedAt が入る', async () => {
    const response = await app().request('/api/nen-campaigns/pets?lineAccountId=account-a');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; data: Array<{ id: string; updatedAt: string }> };
    expect(body.data.find((row) => row.id === 'pet-a')?.updatedAt).toBe('2026-09-01T00:00:00.000+09:00');
  });
});

describe('配信設定の停止確認', () => {
  it('確認した版から設定が変わったら停止を拒む', async () => {
    const changed = await put('/api/nen-campaigns/settings/review_request?lineAccountId=account-a', settingBody('変更後', '2026-09-01'));
    expect(changed.status).toBe(200);
    const stopped = await put('/api/nen-campaigns/settings/review_request/enabled?lineAccountId=account-a', { isEnabled: false, expectedUpdatedAt: '2026-09-01' });
    expect(stopped.status).toBe(409);
    const body = await stopped.json() as { data: { latest: { isEnabled: boolean; title: string } } };
    expect(body.data.latest).toMatchObject({ isEnabled: true, title: '変更後' });
  });
  it('一致なら停止し、版なしの呼び出しも通る', async () => {
    const path = '/api/nen-campaigns/settings/review_request/enabled?lineAccountId=account-a';
    const first = await put(path, { isEnabled: false, expectedUpdatedAt: '2026-09-01' });
    expect(first.status).toBe(200);
    const version = accountSettingUpdatedAt();
    expect(version).not.toBe('2026-09-01');
    const legacy = await put(path, { isEnabled: false });
    expect(legacy.status).toBe(200);
    expect(accountSettingUpdatedAt()).not.toBe(version);
  });
  it('同じ時刻に停止して再開しても古い版を拒む', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-04T00:00:00Z'));
    try {
      const path = '/api/nen-campaigns/settings/review_request/enabled?lineAccountId=account-a';
      expect((await put('/api/nen-campaigns/settings/review_request?lineAccountId=account-a', settingBody('見出し'))).status).toBe(200);
      expect((await put(path, { isEnabled: false })).status).toBe(200);
      const seen = accountSettingUpdatedAt();
      expect((await put(path, { isEnabled: true })).status).toBe(200);
      expect((await put(path, { isEnabled: false })).status).toBe(200);
      expect(accountSettingUpdatedAt()).not.toBe(seen);
      expect((await put(path, { isEnabled: true, expectedUpdatedAt: seen })).status).toBe(409);
    } finally { vi.useRealTimers(); }
  });

  it('照合から書き込みの間の変更も拒む', async () => {
    const path = '/api/nen-campaigns/settings/review_request/enabled?lineAccountId=account-a';
    expect((await put(path, { isEnabled: false })).status).toBe(200);
    const seen = accountSettingUpdatedAt();
    const originalPrepare = testDb.db.prepare.bind(testDb.db);
    let interrupted = false;
    const spy = vi.spyOn(testDb.db, 'prepare').mockImplementation((sql: string) => {
      if (!interrupted && sql.startsWith('UPDATE account_settings SET value = ?')) {
        interrupted = true;
        testDb.raw.prepare(`UPDATE account_settings SET value = json_set(value, '$.updated_at', '2026-12-01T00:00:00.000+09:00', '$.title', '割り込み') WHERE line_account_id = ? AND key = ?`).run(ACCOUNT, 'nen.campaign.review_request');
      }
      return originalPrepare(sql);
    });
    try {
      const response = await put(path, { isEnabled: false, expectedUpdatedAt: seen });
      expect(interrupted).toBe(true);
      expect(response.status).toBe(409);
      const body = await response.json() as { data: { latest: { title: string } } };
      expect(body.data.latest.title).toBe('割り込み');
    } finally { spy.mockRestore(); }
  });

});
