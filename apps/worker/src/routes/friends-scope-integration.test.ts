import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { DEFAULT_TENANT_ID } from '@line-crm/shared';

import type { Env } from '../worker-env.js';
import { authMiddleware } from '../middleware/auth.js';
import { createTestD1, insertFriend, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { friends } from './friends.js';

const OTHER_TENANT_ID = '00000000-0000-4000-8000-000000000002';

function createApp(db: D1Database) {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', friends);
  return {
    app,
    env: { DB: db } as Env['Bindings'],
  };
}

function seedScopeFixture(testDb: SqliteD1): void {
  testDb.raw.prepare('INSERT OR IGNORE INTO tenants (id, name) VALUES (?, ?)')
    .run(DEFAULT_TENANT_ID, '既定統括');
  testDb.raw.prepare('INSERT OR IGNORE INTO tenants (id, name) VALUES (?, ?)')
    .run(OTHER_TENANT_ID, '別統括');

  const insertAccount = testDb.raw.prepare(`
    INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
    VALUES (?, ?, ?, 'token', 'secret', 1, ?)
  `);
  insertAccount.run('account-a', 'channel-a', '店舗A', DEFAULT_TENANT_ID);
  insertAccount.run('account-b', 'channel-b', '店舗B', DEFAULT_TENANT_ID);
  insertAccount.run('account-foreign', 'channel-foreign', '別統括店舗', OTHER_TENANT_ID);

  const insertStaff = testDb.raw.prepare(`
    INSERT INTO staff_members
      (id, name, role, access_level, api_key, permission_keys, account_scope, tenant_id)
    VALUES (?, ?, 'staff', 'full', ?, '["/friends"]', ?, ?)
  `);
  insertStaff.run('staff-all', '全店舗担当', 'key-all', 'all', DEFAULT_TENANT_ID);
  insertStaff.run('staff-partial', '店舗A担当', 'key-partial', 'accounts', DEFAULT_TENANT_ID);
  insertStaff.run('staff-empty', '担当未設定', 'key-empty', 'accounts', DEFAULT_TENANT_ID);
  testDb.raw.prepare(`
    INSERT INTO staff_account_scopes (staff_id, line_account_id, created_at)
    VALUES ('staff-partial', 'account-a', '2026-09-09T00:00:00.000Z')
  `).run();

  const createdAt = new Date().toISOString();
  const seedFriend = (id: string, lineAccountId: string | null) => insertFriend(testDb.raw, id, {
    line_account_id: lineAccountId,
    ref_code: `ref-${id}`,
    created_at: createdAt,
    updated_at: createdAt,
  });
  seedFriend('friend-a-1', 'account-a');
  seedFriend('friend-a-2', 'account-a');
  seedFriend('friend-b-1', 'account-b');
  seedFriend('friend-unassigned', null);
  seedFriend('friend-foreign', 'account-foreign');
}

type FriendListResponse = {
  data: { items: Array<{ id: string }>; total: number };
};
type FriendCountResponse = { data: { count: number } };
type FriendRefStatsResponse = { data: { totalWithRef: number } };
type FriendAddBreakdownResponse = { data: { firstTime: number; returning: number } };
type FriendStatsResponse = { data: { total: number } };

describe('N-032 friend stats account scope integration (#664)', () => {
  let testDb: SqliteD1;
  let target: ReturnType<typeof createApp>;

  beforeEach(() => {
    testDb = createTestD1({ loginPolicy: 'off' });
    seedScopeFixture(testDb);
    target = createApp(testDb.db);
  });

  afterEach(() => {
    testDb.raw.close();
  });

  async function get(path: string, apiKey?: string): Promise<Response> {
    return target.app.request(path, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    }, target.env);
  }

  it.each(['recent','oldest'])('cursor pagination keeps timestamp ties stable, ignores earlier insertions and retains tenant scope: %s',async sort=>{
    const base=`/api/friends?includeTags=false&limit=1&pagination=cursor&sort=${sort}&lineAccountId=account-a`;
    const seen:string[]=[];let cursor:string|null=null;
    for(let page=0;page<4;page++){
      const response=await get(base+(cursor?`&cursor=${cursor}`:''),'key-partial');expect(response.status).toBe(200);
      const {data}=await response.json<{data:{items:Array<{id:string}>,nextCursor:string|null,total:number}}>();
      expect(data.total).toBeGreaterThanOrEqual(2);seen.push(...data.items.map(item=>item.id));
      if(page===0)insertFriend(testDb.raw,'insert-before',{line_account_id:'account-a',created_at:sort==='recent'?'2999-01-01':'2000-01-01'});
      cursor=data.nextCursor;if(!cursor)break;
    }
    expect(seen).toEqual(sort==='recent'?['friend-a-2','friend-a-1']:['friend-a-1','friend-a-2']);
    expect(new Set(seen).size).toBe(seen.length);
    expect((await get(base+'&cursor=not-a-valid-cursor','key-partial')).status).toBe(400);
    expect((await get(base+'&offset=1','key-partial')).status).toBe(400);
    expect((await get(base+'&search=test','key-partial')).status).toBe(400);
  });

  async function visibleCounts(apiKey: string, lineAccountId?: string) {
    const accountQuery = lineAccountId ? `&lineAccountId=${lineAccountId}` : '';
    const lineAccountQuery = lineAccountId ? `?lineAccountId=${lineAccountId}` : '';
    const statsQuery = lineAccountId ? `?accountId=${lineAccountId}` : '';
    const [listResponse, countResponse, refResponse, breakdownResponse, statsResponse] = await Promise.all([
      get(`/api/friends?includeTags=false&limit=50${accountQuery}`, apiKey),
      get(`/api/friends/count${lineAccountQuery}`, apiKey),
      get(`/api/friends/ref-stats${lineAccountQuery}`, apiKey),
      get(`/api/friends/add-breakdown?days=30${accountQuery}`, apiKey),
      get(`/api/friends/stats${statsQuery}`, apiKey),
    ]);
    for (const response of [listResponse, countResponse, refResponse, breakdownResponse, statsResponse]) {
      expect(response.status).toBe(200);
    }
    const [list, count, ref, breakdown, stats] = await Promise.all([
      listResponse.json() as Promise<FriendListResponse>,
      countResponse.json() as Promise<FriendCountResponse>,
      refResponse.json() as Promise<FriendRefStatsResponse>,
      breakdownResponse.json() as Promise<FriendAddBreakdownResponse>,
      statsResponse.json() as Promise<FriendStatsResponse>,
    ]);
    return {
      ids: list.data.items.map((friend) => friend.id).sort(),
      list: list.data.total,
      count: count.data.count,
      refStats: ref.data.totalWithRef,
      addBreakdown: breakdown.data.firstTime + breakdown.data.returning,
      stats: stats.data.total,
    };
  }

  it('墓石の友だちは一覧と集計に含めない', async () => {
    testDb.raw.exec("UPDATE friends SET data_purged_at='2027-05-01',line_user_id='purged-fixture',is_following=0,is_hidden=1,ref_code=NULL WHERE id='friend-a-1'");
    const counts = await visibleCounts('key-partial', 'account-a');
    expect(counts.ids).toEqual(['friend-a-2']);
    expect(counts.list).toBe(1);
    expect(counts.count).toBe(1);
    expect(counts.refStats).toBe(1);
    expect(counts.stats).toBe(1);
    expect(counts.addBreakdown).toBe(1);
  });

  it('SCALE-02 仲間の友だち一覧と4集計も201店舗の範囲を保つ', async () => {
    for(let i=0;i<201;i++) testDb.raw.prepare("INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,tenant_id) VALUES(?,?,?,'token','secret',?)").run(`synthetic-account-${i}`,`synthetic-channel-${i}`,'人工店',DEFAULT_TENANT_ID);
    expect((await visibleCounts('key-all')).ids).toEqual(['friend-a-1','friend-a-2','friend-b-1','friend-unassigned']);
  });

  it('SCALE-03 履歴付き101人の一覧もD1の100変数上限を超えない', async () => {
    for(let i=0;i<101;i++) insertFriend(testDb.raw, `synthetic-${i}`, { line_account_id:'account-a' });
    const response=await get('/api/friends?lineAccountId=account-a&limit=101&includeChatStatus=true&includeTags=false','key-all');
    expect(response.status).toBe(200);
    expect(((await response.json()) as FriendListResponse).data.items).toHaveLength(101);
  });

  it.each([
    {
      label: '全権限は同じ統括の2店舗と未割当だけを見る',
      apiKey: 'key-all',
      expectedIds: ['friend-a-1', 'friend-a-2', 'friend-b-1', 'friend-unassigned'],
    },
    {
      label: '部分権限は割り当てられた店舗Aだけを見る',
      apiKey: 'key-partial',
      expectedIds: ['friend-a-1', 'friend-a-2'],
    },
    {
      label: '空権限は誰も見ない',
      apiKey: 'key-empty',
      expectedIds: [],
    },
  ])('$label: 一覧と4集計口が同じ人数になる', async ({ apiKey, expectedIds }) => {
    const result = await visibleCounts(apiKey);
    expect(result.ids).toEqual(expectedIds);
    expect(result).toMatchObject({
      list: expectedIds.length,
      count: expectedIds.length,
      refStats: expectedIds.length,
      addBreakdown: expectedIds.length,
      stats: expectedIds.length,
    });
  });

  it('分析対象は同じ店の有効期限内の会員だけに限定する', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-17T00:00:00.000Z'));
    try {
      testDb.raw.exec(`
        INSERT INTO staff_members(id,name,role,access_level,api_key,permission_keys,account_scope,tenant_id)
          VALUES ('owner','管理者','owner','full','key-owner','[]','all','${DEFAULT_TENANT_ID}'),
          ('admin','副管理者','admin','full','key-admin','[]','all','${DEFAULT_TENANT_ID}');
        INSERT INTO analytics_cross_runs(id,line_account_id,query_json,state,period_from,period_to,time_zone,data_cutoff_at,created_at)
          VALUES ('result','account-a','{}','available','2026-11-01','2026-11-16','Asia/Tokyo','2026-11-17T00:00:00.000Z','2026-11-17T00:00:00.000Z');
        INSERT INTO analytics_result_audiences(id,line_account_id,source_kind,source_result_id,selection_key,member_count,expires_at,created_at)
          VALUES ('audience','account-a','cross','result','all',1,'2026-11-18T00:00:00.000Z','2026-11-17T00:00:00.000Z');
        INSERT INTO analytics_result_audience_members(audience_id,friend_id) VALUES ('audience','friend-a-1');
      `);
      const path = '/api/friends?lineAccountId=account-a&audienceId=audience&includeTags=false';
      const response = await get(path, 'key-owner');
      expect(response.status).toBe(200);
      const data = await response.json<FriendListResponse>();
      expect(data.data.items.map(item => item.id)).toEqual(['friend-a-1']);
      const admin = await get(path, 'key-admin');
      expect(admin.status).toBe(200);
      expect((await admin.json<FriendListResponse>()).data.items.map(item => item.id)).toEqual(['friend-a-1']);
      expect((await get(path, 'key-all')).status).toBe(403);
      expect((await get(path.replace('account-a', 'account-b'), 'key-owner')).status).toBe(404);
      vi.setSystemTime(new Date('2026-11-18T00:00:00.000Z'));
      const expired = await get(path, 'key-owner');
      expect(expired.status).toBe(410);
      expect(await expired.json()).toMatchObject({ error: 'この分析結果の対象者は24時間を過ぎました。もう一度集計してください' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('担当と配信中シナリオで絞ってから件数とページを決める', async () => {
    insertFriend(testDb.raw, 'friend-a-unassigned', { line_account_id: 'account-a' });
    testDb.raw.exec(`
      INSERT INTO operators(id,name,email) VALUES ('operator','担当','operator@example.test');
      INSERT INTO chats(id,friend_id,operator_id,status,created_at,updated_at) VALUES
        ('chat1','friend-a-1','operator','unread','2026','2026'),
        ('chat2','friend-a-2','operator','unread','2026','2026');
      INSERT INTO scenarios(id,name,trigger_type,line_account_id) VALUES ('scenario','案内','manual','account-a');
      INSERT INTO friend_scenarios(id,friend_id,scenario_id,status) VALUES
        ('fs1','friend-a-1','scenario','active'),('fs2','friend-a-2','scenario','delivering'),
        ('fs3','friend-b-1','scenario','completed'),('fs4','friend-a-unassigned','scenario','active');
    `);
    const path = '/api/friends?lineAccountId=account-a&operatorId=operator&scenarioId=scenario&limit=1&includeTags=false';
    const first = await (await get(path + '&offset=0', 'key-all')).json<FriendListResponse>();
    const second = await (await get(path + '&offset=1', 'key-all')).json<FriendListResponse>();
    expect(first.data.total).toBe(2);
    expect(second.data.total).toBe(2);
    expect([...first.data.items, ...second.data.items].map(item => item.id).sort()).toEqual(['friend-a-1', 'friend-a-2']);
    testDb.raw.prepare("UPDATE friend_scenarios SET status='completed' WHERE id='fs1'").run();
    const remaining = await (await get(path, 'key-all')).json<FriendListResponse>();
    expect(remaining.data.total).toBe(1);
    expect(remaining.data.items.map(item => item.id)).toEqual(['friend-a-2']);
  });

  it('一覧に担当者と対応マークの情報を返す', async () => {
    testDb.raw.exec(`
      INSERT INTO operators(id,name,email) VALUES ('operator','担当','operator@example.test');
      INSERT INTO chats(id,friend_id,operator_id,status,created_at,updated_at)
        VALUES ('chat1','friend-a-1','operator','unread','2026','2026');
      INSERT INTO support_marks(id,name,color) VALUES ('mark','対応中','#123456');
      UPDATE friends SET support_mark_id='mark' WHERE id='friend-a-1';
    `);
    const response = await get('/api/friends?lineAccountId=account-a&includeChatStatus=true&includeTags=false', 'key-all');
    expect(response.status).toBe(200);
    const { data } = await response.json<{data:{items:Array<{id:string;operator:unknown;supportMark:unknown}>}}>();
    const first = data.items.find(item => item.id === 'friend-a-1');
    const second = data.items.find(item => item.id === 'friend-a-2');
    expect(first).toMatchObject({ operator: { id: 'operator', name: '担当' }, supportMark: { id: 'mark', name: '対応中', color: '#123456' } });
    expect(second).toMatchObject({ operator: null, supportMark: null });
  });

  it('情報欄の null はキーを削除し、文字列以外を拒む', async () => {
    testDb.raw.prepare("UPDATE friends SET metadata=? WHERE id='friend-a-1'")
      .run(JSON.stringify({ important: 'yes', memo: 'keep' }));
    const update = (body: unknown) => target.app.request('/api/friends/friend-a-1/metadata', {
      method: 'PUT', headers: { Authorization: 'Bearer key-all', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, target.env);
    expect((await update({ important: null })).status).toBe(200);
    const row = () => testDb.raw.prepare("SELECT metadata FROM friends WHERE id='friend-a-1'").get() as { metadata: string };
    expect(JSON.parse(row().metadata)).toEqual({ memo: 'keep' });
    const invalid = await update({ memo: 123 });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: 'metadata values must be string or null' });
    expect(JSON.parse(row().metadata)).toEqual({ memo: 'keep' });
  });

  it('詳細条件と保存条件は情報欄の保存値で同じ友だちを選ぶ', async () => {
    testDb.raw.exec(`INSERT INTO friend_fields(id,name,field_key,type) VALUES ('plan-id','plan','plan-key','text');
      INSERT INTO friend_field_values(friend_id,field_id,value) VALUES ('friend-a-1','plan-id','契約');
      UPDATE friends SET metadata='{"plan":"契約"}' WHERE id='friend-a-2';`);
    for (const suffix of ['metadata.plan=契約', 'conditions=' + encodeURIComponent(JSON.stringify({ all: [{ kind: 'field', key: 'plan', op: 'eq', value: '契約' }] }))]) {
      const response = await get('/api/friends?lineAccountId=account-a&' + suffix, 'key-all');
      expect(response.status).toBe(200);
      expect((await response.json() as FriendListResponse).data.items.map(f => f.id)).toEqual(['friend-a-1']);
    }
    const response = await get('/api/friends?lineAccountId=account-a&metadataNot.plan=契約', 'key-all');
    expect((await response.json() as FriendListResponse).data.items.map(f => f.id)).toEqual(['friend-a-2']);
  });

  it('部分権限で担当店舗を明示しても一覧と4集計口が同じ2人になる', async () => {
    const result = await visibleCounts('key-partial', 'account-a');
    expect(result).toEqual({
      ids: ['friend-a-1', 'friend-a-2'],
      list: 2,
      count: 2,
      refStats: 2,
      addBreakdown: 2,
      stats: 2,
    });
  });

  it('部分権限から未担当店舗・別統括を明示しても4集計口は404にする', async () => {
    const hiddenAccountIds = ['account-b', 'account-foreign'] as const;
    for (const accountId of hiddenAccountIds) {
      const paths = [
        `/api/friends/add-breakdown?lineAccountId=${accountId}`,
        `/api/friends/count?lineAccountId=${accountId}`,
        `/api/friends/ref-stats?lineAccountId=${accountId}`,
        `/api/friends/stats?accountId=${accountId}`,
      ];
      for (const path of paths) {
        const response = await get(path, 'key-partial');
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ success: false, error: 'Not found' });
      }
    }
  });

  it('認証middlewareを通り、資格情報がなければ一覧も4集計口も401にする', async () => {
    const paths = [
      '/api/friends?includeTags=false',
      '/api/friends/add-breakdown',
      '/api/friends/count',
      '/api/friends/ref-stats',
      '/api/friends/stats',
    ];
    for (const path of paths) {
      expect((await get(path)).status).toBe(401);
    }
  });
});
