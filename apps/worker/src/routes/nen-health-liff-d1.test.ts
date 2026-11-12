/*
 * 健康日記（★37-2-B）「獣医師に見せる（直近30日のまとめ）」を実D1で固定する。
 *  1. 本人のペットの 30 日の記録を、管理画面の 30日のまとめ と同じ形で返す
 *  2. 他人のペット・無いペットは 404。本人確認できなければ 401
 */
import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestD1 } from '../test-utils/d1-sqlite.js';

const liffAuth = vi.hoisted(() => ({ verifyCallerLineIdentity: vi.fn(), verifyCallerLineUserId: vi.fn() }));
vi.mock('../services/liff-auth.js', () => liffAuth);
vi.mock('../services/line-proxy-send.js', () => ({ pushViaHarnessProxy: vi.fn() }));
vi.mock('../services/local-line-proxy.js', () => ({ dispatchLineProxyLocally: vi.fn() }));

const { nenMembers } = await import('./nen-members.js');

let sql: Database.Database;
let db: D1Database;
const day = (daysAgo: number) => new Date(Date.parse('2026-10-20T00:00:00Z') - daysAgo * 86_400_000).toISOString().slice(0, 10);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-19T15:09:00Z')); // 日本の10月20日00:09。見本の日付もこの暦日。
  const created = createTestD1();
  sql = created.raw;
  db = created.db;
  sql.exec(`
    INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES ('account-nen', 'channel-nen', '然', 'token', 'secret');
    INSERT INTO friends (id, line_user_id, display_name, line_account_id, is_following, created_at, updated_at) VALUES
      ('friend-a', 'U-a', '見本 141', 'account-nen', 1, '2026-09-01', '2026-09-01'),
      ('friend-b', 'U-b', '見本 176', 'account-nen', 1, '2026-09-01', '2026-09-01');
    INSERT INTO nen_pet_profiles (id, friend_id, name, animal_type, gender, birthday, breed, weight_kg, concerns, recommended_daily_grams, recommended_daily_min_grams, recommended_daily_max_grams, venison_daily_grams, food_cycle_days, created_at, updated_at)
    VALUES ('pet-momo', 'friend-a', 'モモ', 'dog', 'female', '2022-04-01', '柴犬', 10, '[]', 250, 200, 300, 25, 4, '2026-09-01', '2026-09-01');
  `);
  const insert = sql.prepare(`INSERT INTO nen_health_logs (id, pet_id, friend_id, logged_on, weight_kg, stool_status, appetite, skin_status, tear_stain_status, note, heart_rate_bpm, respiratory_rate_bpm, created_at) VALUES (?, 'pet-momo', 'friend-a', ?, ?, ?, ?, 'normal', 'normal', ?, ?, ?, ?)`);
  insert.run('l0', day(0), 9.6, 'normal', 'normal', '散歩のあとよく水を飲んだ', 120, 26, day(0));
  insert.run('l10', day(10), 10.0, 'soft', 'good', '', 116, null, day(10));
  insert.run('l40', day(40), 10.5, 'diarrhea', 'poor', '古い記録', null, null, day(40));
});

function liff(lineUserId: string | null) {
  liffAuth.verifyCallerLineIdentity.mockResolvedValue(lineUserId ? { lineUserId, lineAccountId: 'account-nen' } : null);
  const app = new Hono<any>();
  app.use('*', async (c, next) => { c.env = { DB: db }; await next(); });
  app.route('/', nenMembers);
  return app;
}

describe('GET /api/liff/nen/health-logs/summary', () => {
  it('本人のペットの 30 日のまとめを返す（古い記録は入れない）', async () => {
    const res = await liff('U-a').request('/api/liff/nen/health-logs/summary?petId=pet-momo', { headers: { Authorization: 'Bearer token' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.pet).toMatchObject({ id: 'pet-momo', name: 'モモ', animalType: 'dog', breed: '柴犬', weightKg: 10 });
    expect(body.data.owner).toEqual({ name: '見本 141' });
    expect(body.data.summary).toMatchObject({
      days: 30, records: 2, weight: { first: 10, last: 9.6, min: 9.6, max: 10 }, heartRateAvg: 118, respiratoryRateAvg: 26,
      stool: { normal: 1, soft: 1 }, appetite: { normal: 1, good: 1 }, notes: [{ loggedOn: day(0), note: '散歩のあとよく水を飲んだ' }],
    });
    expect(body.data.summary.logs).toHaveLength(2);
    expect(body.data.labels.stool.diarrhea).toBe('下痢');
    expect(JSON.stringify(body)).not.toContain('ポイント');
  });

  it('他人のペット・無いペットは 404。本人確認できなければ 401', async () => {
    expect((await liff('U-b').request('/api/liff/nen/health-logs/summary?petId=pet-momo', { headers: { Authorization: 'Bearer token' } })).status).toBe(404);
    expect((await liff('U-a').request('/api/liff/nen/health-logs/summary?petId=nope', { headers: { Authorization: 'Bearer token' } })).status).toBe(404);
    expect((await liff(null).request('/api/liff/nen/health-logs/summary?petId=pet-momo')).status).toBe(401);
  });
});

describe('POST /api/liff/nen/health-logs（監査 R59/R61）', () => {
  const post = (body: Record<string, unknown>, user = 'U-a') =>
    liff(user).request('/api/liff/nen/health-logs', {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer token' }, body: JSON.stringify(body),
    });
  const profileWeight = () =>
    Number((sql.prepare(`SELECT weight_kg FROM nen_pet_profiles WHERE id = 'pet-momo'`).get() as { weight_kg: number }).weight_kg);

  it('体重を付けた最新の記録はプロフィールと給餌目安に反映される（R59）', async () => {
    const res = await post({ petId: 'pet-momo', stoolStatus: 'normal', appetite: 'good', weightKg: 8.5 });
    expect(res.status).toBe(201);
    expect(profileWeight()).toBe(8.5);
    // 給餌目安も新しい体重で計算し直されている（保存値が 10kg 由来のまま残らない）。
    const grams = (sql.prepare(`SELECT daily_kcal, recommended_daily_grams FROM nen_pet_profiles WHERE id = 'pet-momo'`).get() as { daily_kcal: number | null }).daily_kcal;
    expect(grams).not.toBeNull();
  });

  it('過去日の記録では今の体重を戻さない（R59）', async () => {
    const res = await post({ petId: 'pet-momo', loggedOn: day(50), stoolStatus: 'normal', appetite: 'good', weightKg: 20 });
    expect(res.status).toBe(201);
    expect(profileWeight()).toBe(10);
  });

  it('「正常」以外の便が3回続くとケア共有が立つ。管理側の「気になる変化」と同じ基準（R61）', async () => {
    // やわらかい便でも3回続けば利用者側は「要ケアを共有」と出す。
    for (const ago of [2, 1]) {
      await post({ petId: 'pet-momo', loggedOn: day(ago), stoolStatus: 'soft', appetite: 'normal' });
    }
    const res = await post({ petId: 'pet-momo', stoolStatus: 'soft', appetite: 'normal' });
    expect((await res.json() as any).data.careRequired).toBe(true);
    // 利用者側と管理側で同じ記録から同じ便の異常を判定する。
    const { summarizePetHealth } = await import('../services/nen-health-admin.js');
    const logs = sql.prepare(`SELECT * FROM nen_health_logs WHERE pet_id = 'pet-momo'`).all() as any[];
    const changes = summarizePetHealth(logs, new Date()).changes.map((ch) => ch.key);
    expect(changes).toContain('stool_abnormal');
  });
});

it('API-02 health log rejects impossible dates instead of normalizing or using today',async()=>{
 const res=await liff('U-a').request('/api/liff/nen/health-logs',{method:'POST',headers:{Authorization:'Bearer token','Content-Type':'application/json'},body:JSON.stringify({petId:'pet-momo',loggedOn:'2026-02-30',stoolStatus:'normal',appetite:'good'})});
 expect(res.status).toBe(400);
});


afterEach(() => vi.useRealTimers());
it.each(['2026-09-30T15:00:00Z', '2026-09-30T23:59:59Z', '2026-10-01T00:00:00Z'])('日本時間の朝も健康日記を当日で保存する: %s', async (at) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(at));
  const res = await liff('U-a').request('/api/liff/nen/health-logs', {
    method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ petId: 'pet-momo', stoolStatus: 'normal', appetite: 'normal', note: 'clock-fixture' }),
  });
  expect(res.status).toBe(201);
  expect(sql.prepare("SELECT logged_on FROM nen_health_logs WHERE pet_id='pet-momo' AND note='clock-fixture'").get()).toEqual({ logged_on: '2026-10-01' });
});
