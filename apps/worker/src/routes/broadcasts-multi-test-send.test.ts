import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createTestD1, insertFriend } from '../test-utils/d1-sqlite.js';

const line = vi.hoisted(() => ({ pushMessage: vi.fn() }));
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: class {
    pushMessage = line.pushMessage;
  },
}));

const { broadcasts } = await import('./broadcasts.js');

describe('複数吹き出しのテスト送信', () => {
  beforeEach(() => line.pushMessage.mockReset().mockResolvedValue({}));

  it('配信テストは未解決の共通情報を送らず、登録後の値を送る', async () => {
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-18T01:00:00Z'));
    const {db,raw}=createTestD1({now:()=>new Date()});
    try {
      raw.exec(`INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES ('account-1','channel-1','店','token','secret');
        INSERT INTO account_settings(id,line_account_id,key,value) VALUES('setting-1','account-1','test_recipients','["friend-1"]');
        INSERT INTO broadcasts(id,title,message_type,message_content,target_type,status,line_account_id,track_links,created_at)
          VALUES('broadcast-1','試験','text','営業時間: {{var.hours}}','all','draft','account-1',0,'2026-01-01');`);
      insertFriend(raw,'friend-1',{line_account_id:'account-1'});
      const app=new Hono<{Bindings:{DB:D1Database;WORKER_URL:string}}>();
      app.use('*',async(c,next)=>{c.env={DB:db,WORKER_URL:'https://worker.test'};c.set('staff' as never,{id:'owner',name:'Owner',role:'owner',readOnly:false} as never);await next()});
      app.route('/',broadcasts);
      const send=()=>app.request('/api/broadcasts/broadcast-1/test-send',{method:'POST'});
      const rejected=await send();expect(rejected.status).toBe(422);expect(await rejected.json()).toMatchObject({code:'COMMON_VAR_UNRESOLVED',error:'共通情報を解決できません: {{var.hours}}',data:{variables:[{key:'hours',displayName:'hours'}]}});expect(line.pushMessage).not.toHaveBeenCalled();
      expect(raw.prepare('SELECT var_key,reason FROM common_var_resolution_failures').all()).toEqual([{var_key:'hours',reason:'missing'}]);
      raw.prepare("INSERT INTO common_vars(id,line_account_id,name,var_key,type,value) VALUES ('hours','account-1','営業時間','hours','text','10時')").run();
      vi.setSystemTime(new Date('2026-11-18T01:00:11Z'));
      expect((await send()).status).toBe(200);
      expect(line.pushMessage.mock.calls[0][1]).toEqual([{type:'text',text:'【テスト配信】\n営業時間: 10時'}]);
    } finally {raw.close();vi.useRealTimers();}
  });

  it('本番と同じ2通をまとめて送り、2通ぶんを記録する', async () => {
    const { db, raw } = createTestD1();
    raw.prepare(
      `INSERT INTO line_accounts
        (id, channel_id, name, channel_access_token, channel_secret, is_active)
       VALUES ('account-1', 'channel-1', '本店', 'token', 'secret', 1)`,
    ).run();
    insertFriend(raw, 'friend-1', { line_account_id: 'account-1', display_name: '田中' });
    raw.prepare(
      `INSERT INTO account_settings (id, line_account_id, key, value)
       VALUES ('setting-1', 'account-1', 'test_recipients', '["friend-1"]')`,
    ).run();
    raw.prepare(
      `INSERT INTO broadcasts
        (id, title, message_type, message_content, message_bubbles_json, target_type,
         status, line_account_id, track_links, created_at)
       VALUES ('broadcast-1', '試験', 'text', 'legacy', ?, 'all', 'draft', 'account-1', 0,
         '2026-01-01T00:00:00.000')`,
    ).run(JSON.stringify([
      { id: '1', type: 'text', content: { text: '{{name}}さんへ' } },
      { id: '2', type: 'text', content: { text: '二通目です' } },
    ]));

    const app = new Hono<{ Bindings: { DB: D1Database; WORKER_URL: string } }>();
    app.use('*', async (c, next) => {
      c.env = { DB: db, WORKER_URL: 'https://worker.test' };
      c.set('staff' as never, { id: 'owner', name: 'Owner', role: 'owner', readOnly: false } as never);
      await next();
    });
    app.route('/', broadcasts);
    const response = await app.request('/api/broadcasts/broadcast-1/test-send', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(line.pushMessage).toHaveBeenCalledTimes(1);
    expect(line.pushMessage.mock.calls[0][1]).toEqual([
      { type: 'text', text: '【テスト配信】\n田中さんへ' },
      { type: 'text', text: '二通目です' },
    ]);
    const logs = raw.prepare(
      `SELECT message_type, content FROM messages_log WHERE delivery_type = 'test' ORDER BY rowid`,
    ).all() as Array<{ message_type: string; content: string }>;
    expect(logs).toHaveLength(2);
  });

  it('予約済みの内容も予約状態を変えずにテスト送信できる', async () => {
    const { db, raw } = createTestD1();
    raw.prepare(
      `INSERT INTO line_accounts
        (id, channel_id, name, channel_access_token, channel_secret, is_active)
       VALUES ('account-1', 'channel-1', '本店', 'token', 'secret', 1)`,
    ).run();
    insertFriend(raw, 'friend-1', { line_account_id: 'account-1', display_name: '田中' });
    raw.prepare(
      `INSERT INTO account_settings (id, line_account_id, key, value)
       VALUES ('setting-1', 'account-1', 'test_recipients', '["friend-1"]')`,
    ).run();
    raw.prepare(
      `INSERT INTO broadcasts
        (id, title, message_type, message_content, target_type, status,
         scheduled_at, line_account_id, track_links, created_at)
       VALUES ('broadcast-1', '予約済み試験', 'text', '予約内容', 'all', 'scheduled',
         '2026-08-24T01:00:00.000Z', 'account-1', 0, '2026-01-01T00:00:00.000')`,
    ).run();

    const app = new Hono<{ Bindings: { DB: D1Database; WORKER_URL: string } }>();
    app.use('*', async (c, next) => {
      c.env = { DB: db, WORKER_URL: 'https://worker.test' };
      c.set('staff' as never, { id: 'owner', name: 'Owner', role: 'owner', readOnly: false } as never);
      await next();
    });
    app.route('/', broadcasts);

    const response = await app.request('/api/broadcasts/broadcast-1/test-send', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(line.pushMessage).toHaveBeenCalledTimes(1);
    expect(raw.prepare(`SELECT status FROM broadcasts WHERE id = 'broadcast-1'`).get()).toMatchObject({
      status: 'scheduled',
    });
  });

  it('同じ配信を同じ担当者が10秒以内に再送すると429で止める', async () => {
    const { db, raw } = createTestD1();
    raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, is_active)
      VALUES ('account-1', 'channel-1', '本店', 'token', 'secret', 1)`).run();
    insertFriend(raw, 'friend-1', { line_account_id: 'account-1' });
    raw.prepare(`INSERT INTO account_settings (id, line_account_id, key, value)
      VALUES ('setting-1', 'account-1', 'test_recipients', '["friend-1"]')`).run();
    raw.prepare(`INSERT INTO broadcasts
      (id, title, message_type, message_content, target_type, status, line_account_id, track_links, created_at)
      VALUES ('broadcast-1', '試験', 'text', '本文', 'all', 'draft', 'account-1', 0, '2026-01-01')`).run();

    const app = new Hono<{ Bindings: { DB: D1Database; WORKER_URL: string } }>();
    app.use('*', async (c, next) => {
      c.env = { DB: db, WORKER_URL: 'https://worker.test' };
      c.set('staff' as never, { id: 'owner', name: 'Owner', role: 'owner', readOnly: false } as never);
      await next();
    });
    app.route('/', broadcasts);

    expect((await app.request('/api/broadcasts/broadcast-1/test-send', { method: 'POST' })).status).toBe(200);
    const second = await app.request('/api/broadcasts/broadcast-1/test-send', { method: 'POST' });
    expect(second.status).toBe(429);
    expect(second.headers.get('Retry-After')).toBe('10');
    expect(line.pushMessage).toHaveBeenCalledTimes(1);
  });

  it('テスト送信先が6件以上なら400で止める', async () => {
    const { db, raw } = createTestD1();
    raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, is_active)
      VALUES ('account-1', 'channel-1', '本店', 'token', 'secret', 1)`).run();
    raw.prepare(`INSERT INTO account_settings (id, line_account_id, key, value)
      VALUES ('setting-1', 'account-1', 'test_recipients', ?)`).run(JSON.stringify(
      Array.from({ length: 6 }, (_, index) => `friend-${index + 1}`),
    ));
    raw.prepare(`INSERT INTO broadcasts
      (id, title, message_type, message_content, target_type, status, line_account_id, track_links, created_at)
      VALUES ('broadcast-1', '試験', 'text', '本文', 'all', 'draft', 'account-1', 0, '2026-01-01')`).run();

    const app = new Hono<{ Bindings: { DB: D1Database; WORKER_URL: string } }>();
    app.use('*', async (c, next) => {
      c.env = { DB: db, WORKER_URL: 'https://worker.test' };
      c.set('staff' as never, { id: 'owner', name: 'Owner', role: 'owner', readOnly: false } as never);
      await next();
    });
    app.route('/', broadcasts);

    const response = await app.request('/api/broadcasts/broadcast-1/test-send', { method: 'POST' });
    expect(response.status).toBe(400);
    expect(line.pushMessage).not.toHaveBeenCalled();
  });

  it('送信中の進捗にアカウント別の送信数を同乗させる', async () => {
    const { db, raw } = createTestD1();
    raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, is_active)
      VALUES ('account-1', 'channel-1', '本店', 'token', 'secret', 1)`).run();
    insertFriend(raw, 'friend-1', { line_account_id: 'account-1' });
    raw.prepare(`INSERT INTO broadcasts
      (id, title, message_type, message_content, target_type, status, line_account_id,
       total_count, success_count, batch_offset, track_links, created_at)
      VALUES ('broadcast-1', '試験', 'text', '本文', 'all', 'sending', 'account-1', 2, 1, 1, 0, '2026-01-01')`).run();
    raw.prepare(`INSERT INTO messages_log
      (id, friend_id, direction, message_type, content, broadcast_id, line_account_id, delivery_type, source, created_at)
      VALUES ('log-1', 'friend-1', 'outgoing', 'text', '本文', 'broadcast-1', 'account-1', 'push', 'broadcast', '2026-01-01')`).run();

    const app = new Hono<{ Bindings: { DB: D1Database; WORKER_URL: string } }>();
    app.use('*', async (c, next) => {
      c.env = { DB: db, WORKER_URL: 'https://worker.test' };
      c.set('staff' as never, { id: 'owner', name: 'Owner', role: 'owner', readOnly: false } as never);
      await next();
    });
    app.route('/', broadcasts);

    const response = await app.request('/api/broadcasts/broadcast-1/progress');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        status: 'sending',
        successCount: 1,
        perAccountStats: [{ accountId: 'account-1', accountName: '本店', sent: 1 }],
      },
    });
  });
});
