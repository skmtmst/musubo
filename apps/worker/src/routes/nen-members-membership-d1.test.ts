/*
 * LIFF マイページ（★37-2）に出す会員ランク・マイル（`membership`）を実D1で固定する。
 *  1. ECからランクが届いている友だちは、その値（通年・ランク・還元率・残高）を返す
 *  2. 届いていない友だちは、設定のしきい値と暫定の累計（購入額の足し算）からランクを求める
 *  3. 連携前（スナップショット無し）はレギュラー・0
 *  4. 呼び名は「マイル」。応答に「ポイント」という文字を含めない
 */
import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import { ensureNenRankDefaults } from '@line-crm/db';

const liffAuth = vi.hoisted(() => ({
  verifyCallerLineIdentity: vi.fn(),
  verifyCallerLineUserId: vi.fn(),
}));
vi.mock('../services/liff-auth.js', () => liffAuth);
vi.mock('../services/line-proxy-send.js', () => ({ pushViaHarnessProxy: vi.fn() }));

const { nenMembers } = await import('./nen-members.js');

let sql: Database.Database;
let db: D1Database;

beforeEach(async () => {
  const created = createTestD1();
  sql = created.raw;
  db = created.db;
  sql.exec(`
    INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('account-nen', 'channel-nen', '然', 'token', 'secret');
    INSERT INTO friends (id, line_user_id, display_name, line_account_id, is_following, created_at, updated_at) VALUES
      ('friend-a', 'U-a', '見本 141', 'account-nen', 1, '2026-09-01', '2026-09-01'),
      ('friend-b', 'U-b', '見本 176', 'account-nen', 1, '2026-09-01', '2026-09-01'),
      ('friend-c', 'U-c', '新しい人', 'account-nen', 1, '2026-09-01', '2026-09-01');
    INSERT INTO nen_ec_member_snapshots (friend_id, customer_id, purchase_count, purchase_amount, point_balance, member_rank, synced_at,
      annual_miles_yen, lifetime_miles_yen, member_rank_key, mile_rate_percent, mile_balance, rank_valid_until) VALUES
      ('friend-a', '10877', 5, 96800, 1120, 'ゴールド', '2026-09-16', 72400, 96800, 'gold', 2, 1120, '2027-12-31'),
      ('friend-b', '11402', 3, 34200, 640, '会員', '2026-09-16', 0, 0, NULL, NULL, 0, NULL);
  `);
  await ensureNenRankDefaults(db, 'account-nen');
});

function app(lineUserId: string) {
  liffAuth.verifyCallerLineIdentity.mockResolvedValue({ lineUserId, lineAccountId: 'account-nen' });
  const harness = new Hono<any>();
  harness.use('*', async (c, next) => { c.env = { DB: db }; await next(); });
  harness.route('/', nenMembers);
  return harness;
}

async function member(lineUserId: string) {
  const res = await app(lineUserId).request('/api/liff/nen/member', { headers: { Authorization: 'Bearer token' } });
  expect(res.status).toBe(200);
  return res.json() as Promise<any>;
}

describe('GET /api/liff/nen/member membership', () => {
  it('EC残高0は古いpoint_balanceで上書きしない', async () => {
    sql.prepare("UPDATE nen_ec_member_snapshots SET mile_balance=0, point_balance=29 WHERE friend_id='friend-a'").run();
    expect((await member('U-a')).data.membership.mileBalance).toBe(0);
  });
  it.each(['suspended', 'archived', 'inactive', 'missing-tenant'])('S15 %s membership owner is rejected even without an account or LIFF query', async state => {
    sql.exec("INSERT INTO tenants(id,name,status) VALUES ('fixture-tenant','Fixture','active'); UPDATE line_accounts SET tenant_id='fixture-tenant' WHERE id='account-nen'");
    if (state === 'inactive') sql.exec("UPDATE line_accounts SET is_active=0 WHERE id='account-nen'");
    else if (state === 'missing-tenant') sql.exec("UPDATE line_accounts SET tenant_id='missing' WHERE id='account-nen'");
    else sql.prepare("UPDATE tenants SET status=? WHERE id='fixture-tenant'").run(state);
    const target = app('U-a');
    for (const [method, path] of [
      ['GET','/api/liff/nen/member'], ['POST','/api/liff/nen/pets'], ['PUT','/api/liff/nen/pets/fixture'],
      ['POST','/api/liff/nen/pets/fixture/photo'], ['POST','/api/liff/nen/health-logs'],
      ['GET','/api/liff/nen/health-logs'], ['GET','/api/liff/nen/health-logs/summary'],
      ['POST','/api/liff/nen/photos'], ['PUT','/api/liff/nen/photos/fixture/publication-consent'],
    ]) {
      const response = await target.request(path, { method, headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' },
        ...(method === 'GET' ? {} : { body: JSON.stringify({ petId: 'fixture', data: 'fixture', mimeType: 'image/jpeg', caption: 'fixture', consent: false, consentVersion: 'fixture', showPetName: false }) }) });
      expect(response.status, `${method} ${path}`).toBe(401);
      expect(JSON.stringify(await response.json())).not.toContain('membership');
    }
  });

  it('ECからランクが届いている友だちはその値を返す', async () => {
    const body = await member('U-a');
    expect(body.data.membership).toMatchObject({
      rankKey: 'gold', rankName: 'ゴールド', mileRatePercent: 2, annualMilesYen: 72_400, lifetimeMilesYen: 96_800, mileBalance: 1_120,
      validUntil: '2027-12-31', next: { name: 'プラチナ', thresholdYen: 120_000, remainingYen: 47_600 },
    });
    expect(body.data.membership.ranks.map((r: any) => r.thresholdYen)).toEqual([0, 30_000, 60_000, 120_000]);
    expect(body.data.membership.nextMilestone).toMatchObject({ thresholdYen: 300_000, title: 'NEN FAMILY', remainingYen: 203_200 });
    expect(JSON.stringify(body.data.membership)).not.toContain('ポイント');
  });

  it('ECのランクキー未着では金額からランクを推測しない', async () => {
    const body = await member('U-b');
    expect(body.data.membership).toMatchObject({ rankKey: null, rankName: '未設定', mileRatePercent: null, annualMilesYen: 34_200, lifetimeMilesYen: 34_200, mileBalance: 0 });
  });

  it('連携前の友だちはランク未設定で 0', async () => {
    const body = await member('U-c');
    expect(body.data.commerce.rank).toBe('未設定');
    expect(body.data.membership).toMatchObject({ rankKey: null, rankName: '未設定', annualMilesYen: 0, lifetimeMilesYen: 0, mileBalance: 0, next: null });
  });
  it('写真の同意と実際のサイト掲載を分け、採用点を返す',async()=>{
    sql.prepare("INSERT INTO nen_pet_profiles(id,friend_id,name,created_at,updated_at) VALUES('p','friend-a','犬','2026-01-01','2026-01-01')").run();
    sql.prepare(`INSERT INTO nen_photo_submissions(id,friend_id,pet_id,r2_key,image_url,content_type,status,awarded_points,publication_consent_at,created_at,updated_at,line_account_id)
      VALUES('photo','friend-a','p','photo.jpg','https://image.test/photo.jpg','image/jpeg','adopted',100,'2026-01-01','2026-01-01','2026-01-01','account-nen')`).run();
    expect((await member('U-a')).data.photos[0]).toMatchObject({awardedPoints:100,publicationConsent:true,publicationStatus:'unpublished',sitePublished:false});
    sql.prepare("INSERT INTO nen_photo_publications(id,photo_id,line_account_id,status,published_at,updated_at) VALUES('pub','photo','account-nen','published','2026-01-01','2026-01-01')").run();
    sql.prepare("INSERT INTO nen_photo_publication_placements(id,publication_id,line_account_id,placement_type,placement_label,created_at) VALUES('place','pub','account-nen','site','サイト','2026-01-01')").run();
    expect((await member('U-a')).data.photos[0]).toMatchObject({publicationStatus:'published',sitePublished:true});
    sql.prepare("UPDATE nen_photo_publications SET status='withdrawn'").run();
    expect((await member('U-a')).data.photos[0]).toMatchObject({publicationConsent:true,publicationStatus:'withdrawn',sitePublished:false});
  });

});
