import { unhandledWorkerError } from '../lib/unhandled-error.js';
/*
 * 会員ランク（★37-1-A / 37-1-B）の設定API。実D1（bootstrap.sql を流した SQLite）で、
 *  1. 初期値（4ランク・4節目）が最初の GET で入る
 *  2. 保存は owner/admin だけ。検証に落ちると 400 で理由を返し、何も変えない
 *  3. 保存で新しいランクのタグが作られ、ECへ署名付きで送られ、同期状態が synced になる
 *  4. ECが落ちていると failed と理由が残り、再送で synced に戻る
 *  5. 会員一覧は見える範囲だけ、通年の多い順
 * を固定する。外部（EC）へは送らない（fetch を mock）。
 */
import type Database from 'better-sqlite3';
import { createHmac, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestD1 } from '../test-utils/d1-sqlite.js';
import { ensureNenRankDefaults } from '@line-crm/db';

const tagSide = vi.hoisted(() => ({
  attach: vi.fn(async (_db: D1Database, _friendId: string, _tagId: string) => ({ added: true })),
  detach: vi.fn(async (_db: D1Database, _friendId: string, _tagId: string) => ({ removed: true })),
}));
vi.mock('../features/friends/friend-tag-attach.js', () => ({
  attachTagAndFireSideEffects: tagSide.attach,
  detachTagAndFireSideEffects: tagSide.detach,
}));

const { nenRanks } = await import('./nen-ranks.js');
const { syncNenEcTags } = await import('../services/nen-tag-sync.js');

const ACCOUNT = 'account-nen';
let sql: Database.Database;
let db: D1Database;
let fetchMock: ReturnType<typeof vi.fn>;
let ecSecret: string;

function seed(raw: Database.Database): void {
  raw.exec(`
    INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('${ACCOUNT}', 'channel-nen', '然', 'token', 'secret'), ('account-other', 'channel-o', '別', 'token', 'secret'), ('account-empty', 'channel-e', '空', 'token', 'secret');
    INSERT INTO tenants (id, name) VALUES ('tenant-default', '既定') ON CONFLICT DO NOTHING;
    INSERT INTO friends (id, line_user_id, display_name, line_account_id, is_following, user_id, created_at, updated_at) VALUES
      ('friend-a', 'U-a', '見本 141', '${ACCOUNT}', 1, 'ec-a', '2026-09-01', '2026-09-01'),
      ('friend-b', 'U-b', '見本 176', '${ACCOUNT}', 1, 'ec-b', '2026-09-01', '2026-09-01'),
      ('friend-c', 'U-c', '別店', 'account-other', 1, 'ec-c', '2026-09-01', '2026-09-01');
    INSERT INTO nen_ec_member_snapshots (friend_id, customer_id, purchase_count, purchase_amount, point_balance, member_rank, synced_at,
      annual_miles_yen, lifetime_miles_yen, member_rank_key, mile_rate_percent, mile_balance) VALUES
      ('friend-a', '10231', 12, 412300, 2840, 'プラチナ', '2026-09-16', 138600, 412300, 'platinum', 3, 2840),
      ('friend-b', '10877', 5, 96800, 1120, 'ゴールド', '2026-09-16', 72400, 96800, NULL, NULL, 1120),
      ('friend-c', '20000', 1, 5000, 0, '会員', '2026-09-16', 5000, 5000, 'regular', 1, 0);
  `);
}

function harness(role: 'owner' | 'admin' | 'staff', env: Record<string, unknown> = {}, staff: Record<string, unknown> = {}) {
  const app = new Hono<any>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-a', name: '担当者', role, readOnly: false, permissionKeys: [], accountScope: 'all', ...staff });
    c.env = { DB: db, NEN_EC_BASE_URL: 'https://ec.test', ECCUBE_WEBHOOK_SECRET: ecSecret, ...env };
    await next();
  });
  app.route('/', nenRanks);
  app.onError(unhandledWorkerError);
  return app;
}

async function json(app: Hono<any>, method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() as any };
}

beforeEach(async () => {
  const created = createTestD1();
  sql = created.raw;
  db = created.db;
  seed(sql);
  await ensureNenRankDefaults(db, ACCOUNT);
  await ensureNenRankDefaults(db, 'account-other');
  sql.exec(`INSERT INTO tags (id, name, color) VALUES
    ('nen-tag-member-rank-basic', '[会員] ランク：レギュラー', '#10B981'),
    ('nen-tag-member-rank-silver', '[会員] ランク：シルバー', '#10B981'),
    ('nen-tag-member-rank-gold', '[会員] ランク：ゴールド', '#10B981'),
    ('nen-tag-member-rank-platinum', '[会員] ランク：プラチナ', '#10B981')`);
  ecSecret = randomBytes(32).toString('hex');
  fetchMock = vi.fn(async () => new Response('{"success":true}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  tagSide.attach.mockClear();
  tagSide.detach.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  sql.close();
});

describe('GET /api/nen/rank-settings', () => {
  it('初期の4ランク・4節目と、ランクごとの会員数を返す', async () => {
    const { status, body } = await json(harness('staff'), 'GET', `/api/nen/rank-settings?accountId=${ACCOUNT}`);
    expect(status).toBe(200);
    expect(body.data.ranks.map((r: any) => [r.name, r.annualThresholdYen, r.mileRatePercent, r.memberCount])).toEqual([
      ['レギュラー', 0, 1, 0], ['シルバー', 30000, 1.5, 0], ['ゴールド', 60000, 2, 0], ['プラチナ', 120000, 3, 1],
    ]);
    expect(body.data.ranks[0].tagName).toBe('[会員] ランク：レギュラー');
    expect(body.data.milestones.map((m: any) => [m.thresholdYen, m.title, m.reachedCount])).toEqual([
      [300000, 'NEN FAMILY', 1], [600000, 'NEN FAMILY＋', 0], [1000000, 'NEN PARTNER', 0], [2000000, 'NEN PARTNER＋', 0],
    ]);
    expect(body.data.rules.syncStatus).toBe('pending');
    expect(body.data.kpis.members).toBe(2);
  });

  it('accountId が無い・見えないアカウントは弾く', async () => {
    expect((await json(harness('owner'), 'GET', '/api/nen/rank-settings')).status).toBe(400);
  });
});

describe('PUT /api/nen/rank-settings', () => {
  const ranksBody = (ranks: unknown[]) => ({ accountId: ACCOUNT, ranks });

  it('staff は保存できない', async () => {
    const { status } = await json(harness('staff'), 'PUT', '/api/nen/rank-settings', ranksBody([]));
    expect(status).toBe(403);
  });

  it('検証に落ちると 400 で理由を返し、設定は変わらない', async () => {
    await json(harness('owner'), 'GET', `/api/nen/rank-settings?accountId=${ACCOUNT}`);
    const { status, body } = await json(harness('owner'), 'PUT', '/api/nen/rank-settings', ranksBody([
      { name: 'シルバー', annualThresholdYen: 30000, mileRatePercent: 1.5 },
    ]));
    expect(status).toBe(400);
    expect(body.error).toContain('0円');
    expect(sql.prepare(`SELECT COUNT(*) AS c FROM nen_rank_settings WHERE line_account_id = ?`).get(ACCOUNT)).toEqual({ c: 4 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('保存すると新ランクのタグを作り、ECへ署名付きで送り、synced になり、友だちのタグを付け替える', async () => {
    const before = (await json(harness('owner'), 'GET', `/api/nen/rank-settings?accountId=${ACCOUNT}`)).body.data.ranks;
    const byName = Object.fromEntries(before.map((r: any) => [r.name, r]));
    const { status, body } = await json(harness('admin'), 'PUT', '/api/nen/rank-settings', ranksBody([
      { id: byName['レギュラー'].id, name: 'レギュラー', annualThresholdYen: 0, mileRatePercent: 1 },
      { id: byName['シルバー'].id, name: 'シルバー', annualThresholdYen: 40000, mileRatePercent: 1.5 },
      { id: byName['ゴールド'].id, name: 'ゴールド', annualThresholdYen: 60000, mileRatePercent: 2 },
      { id: byName['プラチナ'].id, name: 'プラチナ', annualThresholdYen: 120000, mileRatePercent: 3 },
      { name: 'ダイヤモンド', annualThresholdYen: 300000, mileRatePercent: 5 },
    ]));
    expect(status).toBe(200);
    expect(body.data.sync).toEqual({ status: 'synced', error: null });
    expect(body.data.rules.syncStatus).toBe('synced');
    expect(body.data.rules.version).toBe(2);
    const diamond = body.data.ranks.find((r: any) => r.name === 'ダイヤモンド');
    expect(diamond.tagName).toBe('[会員] ランク：ダイヤモンド');
    expect(sql.prepare(`SELECT name FROM tags WHERE id = ?`).get(diamond.tagId)).toEqual({ name: '[会員] ランク：ダイヤモンド' });

    // ECへの送信：署名ヘッダ付き、版と5ランク。
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ec.test/line-harness/rank-settings');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Nen-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(headers['X-Nen-Timestamp']).toMatch(/^\d+$/);
    const payload = JSON.parse(String(init.body));
    expect(payload.version).toBe(2);
    expect(payload.ranks.map((r: any) => [r.key, r.annual_threshold_yen, r.mile_rate_percent])).toEqual([
      ['regular', 0, 1], ['silver', 40000, 1.5], ['gold', 60000, 2], ['platinum', 120000, 3], ['rank-5', 300000, 5],
    ]);
    expect(payload.lifetime_milestones).toHaveLength(4);

    // 付け替え：見える範囲（然アカウント）の友だちだけ。friend-a はプラチナのタグが付く。
    // （テストDBには migration 080 のタグが無いので、初期4ランクのタグも作り直されている。IDは応答から取る）
    const tagOf = (name: string) => body.data.ranks.find((r: any) => r.name === name).tagId as string;
    const attachedFor = (friendId: string) => tagSide.attach.mock.calls.filter((call) => call[1] === friendId).map((call) => call[2]);
    expect(attachedFor('friend-a')).toContain(tagOf('プラチナ'));
    expect(attachedFor('friend-a')).not.toContain(tagOf('ゴールド'));
    // EC のキーがないときは金額からタグを推測しない。
    expect(attachedFor('friend-b').filter((tag) => body.data.ranks.some((rank: any) => rank.tagId === tag))).toEqual([]);
    expect(attachedFor('friend-c')).toEqual([]);
  });

  it('ECが落ちていると failed と理由が残り、再送で synced に戻る', async () => {
    fetchMock.mockResolvedValueOnce(new Response('down', { status: 503 }));
    const before = (await json(harness('owner'), 'GET', `/api/nen/rank-settings?accountId=${ACCOUNT}`)).body.data.ranks;
    const { body } = await json(harness('owner'), 'PUT', '/api/nen/rank-settings', ranksBody(
      before.map((r: any) => ({ id: r.id, name: r.name, annualThresholdYen: r.annualThresholdYen, mileRatePercent: r.mileRatePercent })),
    ));
    expect(body.data.sync.status).toBe('failed');
    expect(body.data.rules.syncStatus).toBe('failed');
    expect(body.data.rules.syncError).toContain('503');

    const resent = await json(harness('owner'), 'POST', '/api/nen/rank-settings/resync', { accountId: ACCOUNT });
    expect(resent.body.data.sync.status).toBe('synced');
    expect(resent.body.data.rules.syncError).toBeNull();
  });

  it('つなぎ先が未設定なら送らずに failed と理由を残す', async () => {
    const app = harness('owner', { NEN_EC_BASE_URL: '', ECCUBE_WEBHOOK_SECRET: '' });
    const before = (await json(app, 'GET', `/api/nen/rank-settings?accountId=${ACCOUNT}`)).body.data.ranks;
    const { body } = await json(app, 'PUT', '/api/nen/rank-settings', ranksBody(
      before.map((r: any) => ({ id: r.id, name: r.name, annualThresholdYen: r.annualThresholdYen, mileRatePercent: r.mileRatePercent })),
    ));
    expect(body.data.sync.status).toBe('failed');
    expect(body.data.sync.error).toContain('未設定');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/nen/rank-settings/:id', () => {
  async function initial() {
    return (await json(harness('owner'), 'GET', `/api/nen/rank-settings?accountId=${ACCOUNT}`)).body.data;
  }
  const deletion = (id: string, body: unknown, role: 'owner' | 'admin' | 'staff' = 'owner') =>
    json(harness(role), 'DELETE', `/api/nen/rank-settings/${id}`, body);

  it('確認した会員と同じ人数でも入れ替わっていれば削除せず409を返す', async () => {
    const data=await initial();
    const source=data.ranks.find((r:any)=>r.key==='platinum');
    const target=data.ranks.find((r:any)=>r.key==='gold');
    const confirmedMembers=[{friendId:'friend-a',customerId:'10231'}];
    sql.prepare("UPDATE nen_ec_member_snapshots SET member_rank_key=CASE friend_id WHEN 'friend-a' THEN 'gold' ELSE 'platinum' END WHERE friend_id IN ('friend-a','friend-b')").run();
    const result=await deletion(source.id,{accountId:ACCOUNT,replacementRankId:target.id,expectedVersion:data.rules.version,confirmedMembers});
    expect(result.status).toBe(409);
    expect(result.body.data.count).toBe(1);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM nen_rank_settings WHERE id=?').get(source.id)).toEqual({n:1});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('確認にはブロック中の会員も含め、確かめた会員だけを移す', async () => {
    const data=await initial(),source=data.ranks.find((r:any)=>r.key==='gold'),target=data.ranks.find((r:any)=>r.key==='regular');
    sql.prepare("UPDATE nen_ec_member_snapshots SET member_rank_key='gold' WHERE friend_id='friend-b'").run();
    sql.prepare("UPDATE friends SET is_following=0 WHERE id='friend-b'").run();
    const preview=await json(harness('owner'),'GET',`/api/nen/rank-settings/${source.id}/delete-preview?accountId=${ACCOUNT}`);
    expect(preview.body.data).toMatchObject({count:1,members:[{friendId:'friend-b',customerId:'10877'}],version:1});
    const result=await deletion(source.id,{accountId:ACCOUNT,replacementRankId:target.id,expectedVersion:1,confirmedMembers:preview.body.data.members});
    expect(result.status).toBe(200);expect(result.body.data.movedMembers).toBe(1);
  });

  it('確定の直前に会員が入れ替わっても削除せず409を返す', async () => {
    const data=await initial(),source=data.ranks.find((r:any)=>r.key==='platinum'),target=data.ranks.find((r:any)=>r.key==='gold');
    const preview=await json(harness('owner'),'GET',`/api/nen/rank-settings/${source.id}/delete-preview?accountId=${ACCOUNT}`);
    const batch=db.batch.bind(db);let injected=false;
    const spy=vi.spyOn(db,'batch').mockImplementation(async statements=>{
      if(!injected){injected=true;sql.prepare("UPDATE nen_ec_member_snapshots SET member_rank_key=CASE friend_id WHEN 'friend-a' THEN 'gold' ELSE 'platinum' END WHERE friend_id IN ('friend-a','friend-b')").run();}
      return batch(statements);
    });
    try{
      const result=await deletion(source.id,{accountId:ACCOUNT,replacementRankId:target.id,expectedVersion:1,confirmedMembers:preview.body.data.members});
      expect(injected).toBe(true);expect(result.status).toBe(409);expect(result.body.data.count).toBe(1);
      expect(sql.prepare('SELECT COUNT(*) AS n FROM nen_rank_settings WHERE id=?').get(source.id)).toEqual({n:1});expect(fetchMock).not.toHaveBeenCalled();
    }finally{spy.mockRestore();}
  });

  it('会員とタグを移し替え、外部へ送らず次の同期待ちにする', async () => {
    const data = await initial();
    const source = data.ranks.find((r: any) => r.key === 'platinum');
    const target = data.ranks.find((r: any) => r.key === 'gold');
    sql.pragma('foreign_keys = ON');
    sql.prepare('INSERT INTO friend_tags (friend_id, tag_id) VALUES (?, ?)').run('friend-a', source.tagId);
    const result = await deletion(source.id, { accountId: ACCOUNT, replacementRankId: target.id, expectedVersion: data.rules.version });
    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({ id: source.id, replacementRankId: target.id, movedMembers: 1, version: 2, ecSync: 'pending', message: '次の同期で反映' });
    expect(sql.prepare('SELECT member_rank_key, member_rank, mile_rate_percent FROM nen_ec_member_snapshots WHERE friend_id = ?').get('friend-a'))
      .toEqual({ member_rank_key: 'gold', member_rank: 'ゴールド', mile_rate_percent: 2 });
    expect(sql.prepare('SELECT tag_id FROM friend_tags WHERE friend_id = ?').all('friend-a')).toEqual([{ tag_id: target.tagId }]);
    expect(sql.prepare('SELECT sync_status, sync_error FROM nen_rank_rules WHERE line_account_id = ?').get(ACCOUNT)).toEqual({ sync_status: 'pending', sync_error: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('キーが一致するブロック中の会員も取り残さない', async () => {
    const data = await initial();
    sql.prepare('UPDATE friends SET is_following = 0 WHERE id = ?').run('friend-b');
    sql.prepare("UPDATE nen_ec_member_snapshots SET member_rank_key = 'gold' WHERE friend_id = 'friend-b'").run();
    const source = data.ranks.find((r: any) => r.key === 'gold');
    const target = data.ranks.find((r: any) => r.key === 'regular');
    const result = await deletion(source.id, { accountId: ACCOUNT, replacementRankId: target.id, expectedVersion: 1 });
    expect(result.body.data.movedMembers).toBe(1);
    expect(sql.prepare('SELECT member_rank_key FROM nen_ec_member_snapshots WHERE friend_id = ?').get('friend-b')).toEqual({ member_rank_key: 'regular' });
    expect(sql.prepare('SELECT member_rank_key FROM nen_ec_member_snapshots WHERE friend_id = ?').get('friend-c')).toEqual({ member_rank_key: 'regular' });
    expect(sql.prepare('SELECT member_rank_key FROM nen_ec_member_snapshots WHERE friend_id = ?').get('friend-a')).toEqual({ member_rank_key: 'platinum' });
  });

  it('ランク削除ではキーが無い会員の既存タグを外さない', async () => {
    const data = await initial();
    const source = data.ranks.find((rank: any) => rank.key === 'gold');
    sql.prepare('INSERT INTO friend_tags (friend_id, tag_id) VALUES (?, ?)').run('friend-b', source.tagId);
    const result = await deletion(source.id, { accountId: ACCOUNT, expectedVersion: 1 });
    expect(result.status).toBe(200);
    expect(sql.prepare('SELECT tag_id FROM friend_tags WHERE friend_id = ?').all('friend-b')).toEqual([{ tag_id: source.tagId }]);
  });

  it('会員がいるなら移す先を必須にし、会員がいないなら省略できる', async () => {
    const data = await initial();
    const platinum = data.ranks.find((r: any) => r.key === 'platinum');
    const silver = data.ranks.find((r: any) => r.key === 'silver');
    expect((await deletion(platinum.id, { accountId: ACCOUNT, expectedVersion: 1 })).status).toBe(400);
    const empty = await deletion(silver.id, { accountId: ACCOUNT, expectedVersion: 1 });
    expect(empty.body.data).toMatchObject({ movedMembers: 0, replacementRankId: null, ecSync: 'pending', version: 2 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('0円のランク、自分・別アカウント・存在しない移し先は拒否する', async () => {
    const data = await initial();
    const source = data.ranks.find((r: any) => r.key === 'platinum');
    const regular = data.ranks.find((r: any) => r.key === 'regular');
    expect((await deletion(regular.id, { accountId: ACCOUNT, expectedVersion: 1 })).status).toBe(409);
    for (const replacementRankId of [source.id, 'missing', '']) {
      expect((await deletion(source.id, { accountId: ACCOUNT, replacementRankId, expectedVersion: 1 })).status).toBe(400);
    }
    const other = (await json(harness('owner'), 'GET', '/api/nen/rank-settings?accountId=account-other')).body.data.ranks[0];
    expect((await deletion(source.id, { accountId: ACCOUNT, replacementRankId: other.id, expectedVersion: 1 })).status).toBe(400);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM nen_rank_settings WHERE line_account_id = ?').get(ACCOUNT)).toEqual({ n: 4 });
    expect(sql.prepare('SELECT COUNT(*) AS n FROM nen_member_rank_sync').get()).toEqual({ n: 0 });
  });

  it('版の未指定・型違い・古い版、権限不足、別アカウントの削除は拒否する', async () => {
    const data = await initial();
    const source = data.ranks.find((r: any) => r.key === 'platinum');
    const target = data.ranks.find((r: any) => r.key === 'gold');
    for (const expectedVersion of [undefined, '1', 0, 1.5]) {
      expect((await deletion(source.id, { accountId: ACCOUNT, replacementRankId: target.id, expectedVersion })).status).toBe(400);
    }
    expect((await deletion(source.id, { accountId: ACCOUNT, replacementRankId: target.id, expectedVersion: 2 })).status).toBe(409);
    expect((await deletion(source.id, { accountId: ACCOUNT, replacementRankId: target.id, expectedVersion: 1 }, 'staff')).status).toBe(403);
    await json(harness('owner'), 'GET', '/api/nen/rank-settings?accountId=account-other');
    expect((await deletion(source.id, { accountId: 'account-other', expectedVersion: 1 })).status).toBe(404);
    const restricted = harness('admin', {}, { tenantId: 'tenant-other' });
    expect((await json(restricted, 'DELETE', `/api/nen/rank-settings/${source.id}`, { accountId: ACCOUNT, replacementRankId: target.id, expectedVersion: 1 })).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('一括保存から移し替えを省略して削除できない', async () => {
    const data = await initial();
    const result = await json(harness('owner'), 'PUT', '/api/nen/rank-settings', { accountId: ACCOUNT,
      ranks: data.ranks.filter((r: any) => r.key !== 'platinum') });
    expect(result.status).toBe(400);
    expect(result.body.error).toContain('削除操作');
    expect(sql.prepare('SELECT COUNT(*) AS n FROM nen_rank_settings WHERE line_account_id = ?').get(ACCOUNT)).toEqual({ n: 4 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('読んだ後に別の担当者が版を変えたら、会員・タグ・ランクを変更しない', async () => {
    const data = await initial();
    const source = data.ranks.find((r: any) => r.key === 'platinum');
    const target = data.ranks.find((r: any) => r.key === 'gold');
    const batch = db.batch.bind(db);
    db.batch = async (statements) => {
      sql.prepare('UPDATE nen_rank_rules SET version = 2 WHERE line_account_id = ?').run(ACCOUNT);
      return batch(statements);
    };
    const result = await deletion(source.id, { accountId: ACCOUNT, replacementRankId: target.id, expectedVersion: 1 });
    expect(result.status).toBe(409);
    expect(sql.prepare('SELECT member_rank_key FROM nen_ec_member_snapshots WHERE friend_id = ?').get('friend-a')).toEqual({ member_rank_key: 'platinum' });
    expect(sql.prepare('SELECT COUNT(*) AS n FROM friend_tags').get()).toEqual({ n: 0 });
    expect(sql.prepare('SELECT COUNT(*) AS n FROM nen_rank_settings WHERE line_account_id = ?').get(ACCOUNT)).toEqual({ n: 4 });
  });

  it('途中の保存に失敗したら会員・タグ・削除・版をすべて戻す', async () => {
    const data = await initial();
    const source = data.ranks.find((r: any) => r.key === 'platinum');
    const target = data.ranks.find((r: any) => r.key === 'gold');
    sql.exec("CREATE TRIGGER reject_rank_move BEFORE UPDATE ON nen_ec_member_snapshots BEGIN SELECT RAISE(ABORT, '試験用の失敗'); END");
    const result = await deletion(source.id, { accountId: ACCOUNT, replacementRankId: target.id, expectedVersion: 1 });
    expect(result.status).toBe(500);
    expect(sql.prepare('SELECT member_rank_key FROM nen_ec_member_snapshots WHERE friend_id = ?').get('friend-a')).toEqual({ member_rank_key: 'platinum' });
    expect(sql.prepare('SELECT COUNT(*) AS n FROM friend_tags').get()).toEqual({ n: 0 });
    expect(sql.prepare('SELECT version, sync_error FROM nen_rank_rules WHERE line_account_id = ?').get(ACCOUNT)).toEqual({ version: 1, sync_error: null });
    expect(sql.prepare('SELECT COUNT(*) AS n FROM nen_rank_settings WHERE line_account_id = ?').get(ACCOUNT)).toEqual({ n: 4 });
    expect(sql.prepare('SELECT COUNT(*) AS n FROM nen_member_rank_sync').get()).toEqual({ n: 0 });
  });
});

describe('ランク削除時の会員別EC送信とやり直し', () => {
  const enabled = { NEN_EC_MEMBER_RANK_SYNC_ENABLED: 'true' };
  const retryPath = (operationId: string) => `/api/nen/rank-settings/member-sync/${operationId}/retry`;
  async function move(env: Record<string, unknown> = enabled) {
    const app = harness('owner', env);
    const data = (await json(app, 'GET', `/api/nen/rank-settings?accountId=${ACCOUNT}`)).body.data;
    return json(app, 'DELETE', `/api/nen/rank-settings/${data.ranks.find((r: any) => r.key === 'platinum').id}`,
      { accountId: ACCOUNT, replacementRankId: data.ranks.find((r: any) => r.key === 'gold').id, expectedVersion: 1 });
  }
  function respond(versions = 0, failedId?: number) {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body));
      const results = url.endsWith('/versions')
        ? payload.customerIds.map((customerId: number) => ({ customerId, success: true, version: versions }))
        : payload.members.map((m: any) => m.customerId === failedId
          ? { customerId: m.customerId, success: false, code: 'save_failed', reason: '試験用の失敗' }
          : { customerId: m.customerId, success: true, version: m.expectedVersion + 1, rankKey: m.rankKey, duplicate: false });
      return Response.json({ success: true, results });
    });
  }
  it('署名を生の本文から作り、会員別の版を保存して送る。自動送信に手動の印を付けない', async () => {
    respond(7);
    const result = await move();
    expect(result.status).toBe(200);
    expect(result.body.data.ecSyncResult).toMatchObject({ succeeded: 1, failed: 0, pending: 0, status: 'synced' });
    expect(result.body.data.ecSync).toBe('synced');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(url).toMatch(/^https:\/\/ec\.test\/line-harness\/member-rank/);
      const headers = init.headers as Record<string, string>;
      expect(headers['X-Nen-Signature']).toBe(`sha256=${createHmac('sha256', ecSecret)
        .update(`${headers['X-Nen-Timestamp']}.${init.body}`).digest('hex')}`);
      expect(headers['X-Line-Harness-Source']).toBeUndefined();
    }
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1].body))).toMatchObject({ actor: 'musubo:staff-a',
      members: [{ customerId: 10231, rankKey: 'gold', expectedVersion: 7, reason: 'ランク削除による移し替え',
        idempotencyKey: expect.stringMatching(/^rank-delete:[a-f0-9-]+:[a-f0-9]+$/) }] });
    const again = await json(harness('admin', enabled), 'POST', retryPath(result.body.data.operationId), { accountId: ACCOUNT });
    expect(again.body.data.succeeded).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('設定なし・false・接続設定不足は送らず同期待ち。後で切り替えを有効にして送れる', async () => {
    for (const env of [{}, { NEN_EC_MEMBER_RANK_SYNC_ENABLED: 'false' }, { ...enabled, NEN_EC_BASE_URL: '' },
      { ...enabled, ECCUBE_WEBHOOK_SECRET: '' }]) {
      const result = await move(env);
      expect(result.body.data.ecSync).toBe('pending');
      expect(result.body.data.ecSyncResult).toMatchObject({ pending: 1, succeeded: 0, failed: 0 });
      expect(fetchMock).not.toHaveBeenCalled();
      respond();
      const resent = await json(harness('admin', enabled), 'POST', retryPath(result.body.data.operationId), { accountId: ACCOUNT });
      expect(resent.body.data.status).toBe('synced');
      // 次のケースは独立したDBで確認する。
      const created = createTestD1(); sql.close(); sql = created.raw; db = created.db; seed(sql); await ensureNenRankDefaults(db, ACCOUNT); fetchMock.mockReset();
    }
  });
  it('変更がECへ届いた後に応答が失われても、同じ本文・担当者・鍵・版で送り直す', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ results: [{ customerId: 10231, success: true, version: 4 }] }))
      .mockRejectedValueOnce(new Error(ecSecret));
    const result = await move();
    const firstBody = String(fetchMock.mock.calls[1]![1].body);
    expect(result.body.data.ecSyncResult).toMatchObject({ failed: 1, succeeded: 0 });
    expect(JSON.stringify(result.body)).not.toContain(ecSecret);
    // 友だちの結び付けが変わっても、保存した元の会員IDを使う。
    sql.prepare('UPDATE nen_ec_member_snapshots SET customer_id = ? WHERE friend_id = ?').run('99999', 'friend-a');
    fetchMock.mockResolvedValueOnce(Response.json({ results: [{ customerId: 10231, success: true, version: 5, rankKey: 'gold', duplicate: true }] }));
    const resent = await json(harness('admin', enabled, { id: 'staff-b' }), 'POST', retryPath(result.body.data.operationId), { accountId: ACCOUNT });
    expect(resent.body.data).toMatchObject({ succeeded: 1, failed: 0, results: [{ duplicate: true, attempts: 2 }] });
    expect(String(fetchMock.mock.calls[2]![1].body)).toBe(firstBody);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('版違いは理由を残し、現在の版を取り直して上書きしない', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ results: [{ customerId: 10231, success: true, version: 2 }] }));
    fetchMock.mockImplementation(async () => Response.json({ results: [{ customerId: 10231, success: false,
      code: 'version_conflict', version: 9, reason: ecSecret }] }));
    const result = await move();
    expect(result.body.data.ecSyncResult.results[0]).toMatchObject({ code: 'version_conflict', status: 'failed' });
    await json(harness('owner', enabled), 'POST', retryPath(result.body.data.operationId), { accountId: ACCOUNT });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2]![1].body)).toBe(String(fetchMock.mock.calls[1]![1].body));
    expect(sql.prepare('SELECT expected_version, error_reason FROM nen_member_rank_sync').get()).toMatchObject({ expected_version: 2,
      error_reason: expect.stringContaining('新しい変更') });
    expect(JSON.stringify(sql.prepare('SELECT * FROM nen_member_rank_sync').all())).not.toContain(ecSecret);
  });
  it('一部の会員だけ失敗したら、成功と失敗の件数を返し、失敗した会員だけ再送する', async () => {
    sql.prepare("UPDATE nen_ec_member_snapshots SET member_rank_key = 'platinum' WHERE friend_id = 'friend-b'").run();
    respond(3, 10877);
    const result = await move();
    expect(result.body.data.ecSyncResult).toMatchObject({ total: 2, succeeded: 1, failed: 1, pending: 0 });
    respond();
    const resent = await json(harness('owner', enabled), 'POST', retryPath(result.body.data.operationId), { accountId: ACCOUNT });
    expect(resent.body.data).toMatchObject({ succeeded: 2, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchMock.mock.calls[2]![1].body)).members).toHaveLength(1);
    expect(JSON.parse(String(fetchMock.mock.calls[2]![1].body)).members[0].customerId).toBe(10877);
  });
  it.each([401, 404, 409, 500])('HTTP %sを成功にせず、版の読み取り失敗を保存して後でやり直す', async (status) => {
    fetchMock.mockResolvedValueOnce(new Response(ecSecret, { status }));
    const result = await move();
    expect(result.body.data.ecSyncResult.results[0]).toMatchObject({ status: 'failed', code: 'http_failed' });
    expect(sql.prepare('SELECT expected_version FROM nen_member_rank_sync').get()).toEqual({ expected_version: null });
    respond();
    expect((await json(harness('owner', enabled), 'POST', retryPath(result.body.data.operationId), { accountId: ACCOUNT })).body.data.status).toBe('synced');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it.each([null, { results: [] }, { results: [{ customerId: 42, success: true, version: 1 }] },
    { results: [{ customerId: 10231, success: true, version: '1' }] }])('壊れた結果 %j で変更を送らない', async (reply) => {
    fetchMock.mockResolvedValueOnce(Response.json(reply));
    const result = await move();
    expect(result.body.data.ecSyncResult.results[0].code).toBe('invalid_response');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('会員IDが不正なら失敗理由を保存し、ECへは送らない', async () => {
    sql.prepare('UPDATE nen_ec_member_snapshots SET customer_id = NULL WHERE friend_id = ?').run('friend-a');
    const result = await move();
    expect(result.body.data.ecSyncResult.results[0].code).toBe('invalid_input');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('存在しないEC会員の理由を保存し、変更の口へは送らない', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ results: [{ customerId: 10231, success: false,
      code: 'member_not_found', reason: '会員が見つかりません' }] }));
    const result = await move();
    expect(result.body.data.ecSyncResult.results[0]).toMatchObject({ code: 'member_not_found', status: 'failed' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('変更の結果が不正なら成功にしない。再送でも期待する版を固定する', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ results: [{ customerId: 10231, success: true, version: 3 }] }))
      .mockResolvedValueOnce(Response.json({ results: [{ customerId: 10231, success: true, version: 8, rankKey: 'gold', duplicate: false }] }));
    const result = await move();
    expect(result.body.data.ecSyncResult.results[0].code).toBe('invalid_response');
    respond();
    expect((await json(harness('owner', enabled), 'POST', retryPath(result.body.data.operationId), { accountId: ACCOUNT })).body.data.succeeded).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2]![1].body)).toBe(String(fetchMock.mock.calls[1]![1].body));
  });
  it('送信待ちの保存が失敗したら移し替え・タグ・削除・版を戻し、外部へ送らない', async () => {
    sql.exec("CREATE TRIGGER reject_sync BEFORE INSERT ON nen_member_rank_sync BEGIN SELECT RAISE(ABORT, '試験用の失敗'); END");
    expect((await move()).status).toBe(500);
    expect(sql.prepare("SELECT member_rank_key FROM nen_ec_member_snapshots WHERE friend_id = 'friend-a'").get()).toEqual({ member_rank_key: 'platinum' });
    expect(sql.prepare('SELECT COUNT(*) AS n FROM friend_tags').get()).toEqual({ n: 0 });
    expect(sql.prepare('SELECT version FROM nen_rank_rules WHERE line_account_id = ?').get(ACCOUNT)).toEqual({ version: 1 });
    expect(sql.prepare('SELECT COUNT(*) AS n FROM nen_rank_settings WHERE line_account_id = ?').get(ACCOUNT)).toEqual({ n: 4 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('同時の再送が先に保存した版を採用し、読み取った別の版で上書きしない', async () => {
    const result = await move({});
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith('/versions')) {
        sql.prepare('UPDATE nen_member_rank_sync SET expected_version = 6').run();
        return Response.json({ results: [{ customerId: 10231, success: true, version: 7 }] });
      }
      const m = JSON.parse(String(init.body)).members[0];
      return Response.json({ results: [{ customerId: m.customerId, success: true, version: m.expectedVersion + 1, rankKey: m.rankKey, duplicate: true }] });
    });
    expect((await json(harness('owner', enabled), 'POST', retryPath(result.body.data.operationId), { accountId: ACCOUNT })).body.data.succeeded).toBe(1);
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1].body)).members[0].expectedVersion).toBe(6);
  });
  it('送信後に結果を保存できなくても削除成功と操作IDを返し、元の記録から再送できる', async () => {
    respond();
    sql.exec("CREATE TRIGGER reject_sync_result BEFORE UPDATE ON nen_member_rank_sync WHEN NEW.status <> 'pending' BEGIN SELECT RAISE(ABORT, '試験用の失敗'); END");
    const result = await move();
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ success: true, data: { ecSync: 'pending', ecSyncResult: null,
      operationId: expect.any(String), message: expect.stringContaining('移し替えは保存しました') } });
    expect(sql.prepare('SELECT expected_version, status FROM nen_member_rank_sync').get()).toEqual({ expected_version: 0, status: 'pending' });
    sql.exec('DROP TRIGGER reject_sync_result');
    expect((await json(harness('owner', enabled), 'POST', retryPath(result.body.data.operationId), { accountId: ACCOUNT })).body.data.succeeded).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2]![1].body)).toBe(String(fetchMock.mock.calls[1]![1].body));
  });
  it('101人を100人ずつ送り、結果も100人ずつ取得できる', async () => {
    const moved = await move({});
    const operation = moved.body.data.operationId;
    const insert = sql.prepare(`INSERT INTO nen_member_rank_sync
      (id, operation_id, line_account_id, friend_id, customer_id, rank_key, actor, reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'gold', 'musubo:staff-a', 'ランク削除による移し替え', '2026-10-02', '2026-10-02')`);
    for (let n = 0; n < 100; n++) insert.run(`rank-delete:extra:${n}`, operation, ACCOUNT, `extra-${n}`, String(30000 + n));
    respond();
    const first = await json(harness('owner', enabled), 'POST', retryPath(operation), { accountId: ACCOUNT });
    expect(first.body.data).toMatchObject({ total: 101, succeeded: 100, pending: 1, failed: 0, status: 'pending' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body)).customerIds).toHaveLength(100);
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1].body)).members).toHaveLength(100);
    expect(first.body.data.results).toHaveLength(100);
    const page = await json(harness('owner'), 'GET', `/api/nen/rank-settings/member-sync/${operation}?accountId=${ACCOUNT}&afterId=${encodeURIComponent(first.body.data.nextCursor)}`);
    expect(page.body.data.results).toHaveLength(1);
    expect(page.body.data.nextCursor).toBeNull();
    const second = await json(harness('owner', enabled), 'POST', retryPath(operation), { accountId: ACCOUNT });
    expect(second.body.data).toMatchObject({ succeeded: 101, pending: 0, status: 'synced' });
    expect(JSON.parse(String(fetchMock.mock.calls[3]![1].body)).members).toHaveLength(1);
  });
  it('別アカウント・スタッフの再送と閲覧を拒否する', async () => {
    const result = await move({});
    const operation = result.body.data.operationId;
    for (const method of ['GET', 'POST']) {
      const path = method === 'GET' ? `/api/nen/rank-settings/member-sync/${operation}?accountId=account-other` : retryPath(operation);
      expect((await json(harness('owner', enabled), method, path, method === 'POST' ? { accountId: 'account-other' } : undefined)).status).toBe(404);
      expect((await json(harness('staff', enabled), method, path, method === 'POST' ? { accountId: ACCOUNT } : undefined)).status).toBe(403);
      expect((await json(harness('admin', enabled, { tenantId: 'tenant-other' }), method, path, method === 'POST' ? { accountId: ACCOUNT } : undefined)).status).toBe(403);
    }
    const loaded = await json(harness('owner'), 'GET', `/api/nen/rank-settings/member-sync/${operation}?accountId=${ACCOUNT}`);
    expect(loaded.body.data).toMatchObject({ total: 1, pending: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('PUT /api/nen/lifetime-milestones', () => {
  it('通知未指定の新しい節目はオフで、未指定の既存節目は保存済みの設定を保つ', async () => {
    const existing = sql.prepare('SELECT id, threshold_yen, title FROM nen_lifetime_milestones WHERE line_account_id = ? ORDER BY threshold_yen').all(ACCOUNT) as Array<{id:string;threshold_yen:number;title:string}>;
    sql.prepare('UPDATE nen_lifetime_milestones SET notify_on_reach = 1 WHERE id = ?').run(existing[0].id);
    const result = await json(harness('owner'), 'PUT', '/api/nen/lifetime-milestones', { accountId: ACCOUNT, milestones: [
      ...existing.map(row => ({id:row.id, thresholdYen:row.threshold_yen, title:row.title})),
      {thresholdYen:2500000,title:'新しい節目'},
    ] });
    expect(result.status).toBe(200);
    expect(result.body.data.milestones.find((row:any)=>row.id===existing[0].id).notifyOnReach).toBe(true);
    expect(result.body.data.milestones.find((row:any)=>row.title==='新しい節目').notifyOnReach).toBe(false);
  });

  it('節目を保存して ECへ送る。同じ金額は 400', async () => {
    await json(harness('owner'), 'GET', `/api/nen/rank-settings?accountId=${ACCOUNT}`);
    const dup = await json(harness('owner'), 'PUT', '/api/nen/lifetime-milestones', { accountId: ACCOUNT, milestones: [
      { thresholdYen: 300000, title: 'A', notifyOnReach: true }, { thresholdYen: 300000, title: 'B', notifyOnReach: true },
    ] });
    expect(dup.status).toBe(400);
    const ok = await json(harness('owner'), 'PUT', '/api/nen/lifetime-milestones', { accountId: ACCOUNT, milestones: [
      { thresholdYen: 500000, title: 'NEN FAMILY', notifyOnReach: false },
    ] });
    expect(ok.status).toBe(200);
    expect(ok.body.data.milestones.map((m: any) => [m.thresholdYen, m.title, m.notifyOnReach, m.reachedCount])).toEqual([[500000, 'NEN FAMILY', false, 0]]);
    expect(ok.body.data.sync.status).toBe('synced');
  });
});

describe('GET /api/nen/members', () => {
  it('見える範囲の会員を通年の多い順に返し、ECのランク未着は設定から求める', async () => {
    const { status, body } = await json(harness('staff'), 'GET', `/api/nen/members?accountId=${ACCOUNT}`);
    expect(status).toBe(200);
    expect(body.data.total).toBe(2);
    expect(body.data.items.map((i: any) => [i.name, i.rankName, i.mileRatePercent, i.annualMilesYen])).toEqual([
      ['見本 141', 'プラチナ', 3, 138600],
      ['見本 176', '未設定', null, 72400],
    ]);
    expect(body.data.kpis.byRank).toEqual({ platinum: 1, '': 1 });
    expect(body.data.ranks).toHaveLength(4);
  });

  it('ランクで絞り込める', async () => {
    const { body } = await json(harness('staff'), 'GET', `/api/nen/members?accountId=${ACCOUNT}&rank=platinum`);
    expect(body.data.items.map((i: any) => i.name)).toEqual(['見本 141']);
  });
});

describe('空のランク設定', () => {
  const accountId = 'account-empty';
  it('読み取り・再同期は初期値を作らず未設定と伝え、明示操作だけで作る', async () => {
    const app = harness('owner');
    const read = await json(app, 'GET', `/api/nen/rank-settings?accountId=${accountId}`);
    expect(read.body.data.ranks).toEqual([]);
    const resync = await json(app, 'POST', '/api/nen/rank-settings/resync', { accountId });
    expect(resync.status).toBe(409);
    expect(resync.body.error).toContain('未設定');
    expect(fetchMock).not.toHaveBeenCalled();
    const initialized = await json(app, 'POST', '/api/nen/rank-settings/initialize', { accountId });
    expect(initialized.status).toBe(200);
    expect(initialized.body.data.ranks).toHaveLength(4);
  });
  it('タグがない環境で初期作成すると全ランクに実在するタグを用意する', async () => {
    sql.exec('DELETE FROM tags');
    sql.pragma('foreign_keys = ON');
    const result = await json(harness('owner'), 'POST', '/api/nen/rank-settings/initialize', { accountId });
    expect(result.status).toBe(200);
    expect(result.body.data.ranks.every((r: any) => r.tagId && r.tagName)).toBe(true);
  });
  it('キーのない会員を金額から推測して削除対象にしない', async () => {
    const app = harness('owner');
    const data = (await json(app, 'GET', `/api/nen/rank-settings?accountId=${ACCOUNT}`)).body.data;
    const gold = data.ranks.find((r: any) => r.key === 'gold');
    expect(gold.memberCount).toBe(0);
    const result = await json(app, 'DELETE', `/api/nen/rank-settings/${gold.id}`, { accountId: ACCOUNT, expectedVersion: 1 });
    expect(result.status).toBe(200);
    expect(sql.prepare("SELECT member_rank_key FROM nen_ec_member_snapshots WHERE friend_id = 'friend-b'").get()).toEqual({ member_rank_key: null });
    expect(sql.prepare('SELECT COUNT(*) AS n FROM nen_member_rank_sync').get()).toEqual({ n: 0 });
  });
  it('キーなしは保持し、不明なキーだけ古いランクタグを外し、空の店は保持する', async () => {
    sql.prepare("INSERT INTO friend_tags (friend_id, tag_id) VALUES ('friend-b', 'nen-tag-member-rank-gold')").run();
    await syncNenEcTags(db, 'friend-b');
    expect(tagSide.detach).not.toHaveBeenCalledWith(expect.anything(), 'friend-b', 'nen-tag-member-rank-gold');
    sql.prepare("UPDATE nen_ec_member_snapshots SET member_rank_key = 'vip' WHERE friend_id = 'friend-b'").run();
    await syncNenEcTags(db, 'friend-b');
    expect(tagSide.detach).toHaveBeenCalledWith(expect.anything(), 'friend-b', 'nen-tag-member-rank-gold');
    tagSide.detach.mockClear();
    sql.prepare("UPDATE friends SET line_account_id = 'account-empty' WHERE id = 'friend-b'").run();
    await syncNenEcTags(db, 'friend-b');
    expect(tagSide.detach).not.toHaveBeenCalledWith(expect.anything(), 'friend-b', 'nen-tag-member-rank-gold');
  });
  it('ランク表の読取失敗ではタグを外さない', async () => {
    sql.prepare("INSERT INTO friend_tags (friend_id, tag_id) VALUES ('friend-b', 'nen-tag-member-rank-gold')").run();
    const bad = new Proxy(db, { get(target, key) {
      if (key === 'prepare') return (query: string) => {
        if (query.includes('FROM nen_rank_settings')) throw new Error('rank lookup failed');
        return target.prepare(query);
      };
      return Reflect.get(target, key);
    }});
    await expect(syncNenEcTags(bad, 'friend-b')).rejects.toThrow('rank lookup failed');
    expect(tagSide.detach).not.toHaveBeenCalled();
  });
  it('別の統括は初期作成できずデータも作られない', async () => {
    const result = await json(harness('admin', {}, { tenantId: 'tenant-other' }), 'POST', '/api/nen/rank-settings/initialize', { accountId });
    expect(result.status).toBe(403);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM nen_rank_settings WHERE line_account_id = ?').get(accountId)).toEqual({ n: 0 });
  });
  it('タグ作成で途中失敗しても再試行で不足分を作れる', async () => {
    sql.exec("DELETE FROM tags; CREATE TRIGGER fail_tag BEFORE INSERT ON tags BEGIN SELECT RAISE(ABORT, 'tag failure'); END");
    const app = harness('owner');
    expect((await json(app, 'POST', '/api/nen/rank-settings/initialize', { accountId })).status).toBe(500);
    sql.exec('DROP TRIGGER fail_tag');
    const retry = await json(app, 'POST', '/api/nen/rank-settings/initialize', { accountId });
    expect(retry.status).toBe(200);
    expect(retry.body.data.ranks.every((r: any) => r.tagId && r.tagName)).toBe(true);
  });
  it('ランクがありルールだけ無い店は保存する案内を返す', async () => {
    sql.prepare('DELETE FROM nen_rank_rules WHERE line_account_id = ?').run(ACCOUNT);
    const result = await json(harness('owner'), 'POST', '/api/nen/rank-settings/resync', { accountId: ACCOUNT });
    expect(result.status).toBe(409);
    expect(result.body.error).toContain('保存');
  });
  it('作成途中のエラーは全体を取り消し、再試行できる', async () => {
    sql.exec("CREATE TRIGGER fail_init BEFORE INSERT ON nen_lifetime_milestones WHEN NEW.threshold_yen = 600000 BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    const app = harness('owner');
    expect((await json(app, 'POST', '/api/nen/rank-settings/initialize', { accountId })).status).toBe(500);
    for (const table of ['nen_rank_settings', 'nen_rank_rules', 'nen_lifetime_milestones']) {
      expect(sql.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE line_account_id = ?`).get(accountId)).toEqual({ n: 0 });
    }
    sql.exec('DROP TRIGGER fail_init');
    expect((await json(app, 'POST', '/api/nen/rank-settings/initialize', { accountId })).status).toBe(200);
  });
  it('ランクが空で決まりだけ残っていても EC に空の設定を送らない', async () => {
    sql.prepare('INSERT INTO nen_rank_rules (line_account_id, updated_at) VALUES (?, ?)').run(accountId, '2026-01-01');
    const resync = await json(harness('owner'), 'POST', '/api/nen/rank-settings/resync', { accountId });
    expect(resync.status).toBe(409);
    expect(resync.body.error).toContain('未設定');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('ランクがない店で節目を保存すると未設定のため同期できないと返す', async () => {
    const result = await json(harness('owner'), 'PUT', '/api/nen/lifetime-milestones', {
      accountId, milestones: [{ thresholdYen: 10000, title: '節目', notifyOnReach: true }],
    });
    expect(result.status).toBe(200);
    expect(result.body.data.sync).toMatchObject({ status: 'failed', error: expect.stringContaining('未設定') });
    expect(result.body.data.ranks).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('閲覧のみの人は初期化できない', async () => {
    const response = await json(harness('owner', {}, { readOnly: true }), 'POST', '/api/nen/rank-settings/initialize', { accountId });
    expect(response.status).toBe(403);
  });
});
