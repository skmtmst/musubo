import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { createTestD1, insertFriend, type SqliteD1 } from '../test-utils/d1-sqlite.js';

const mocks = vi.hoisted(() => ({
  pushMessage: vi.fn(async () => ({})),
}));

vi.mock('@line-crm/line-sdk', () => ({
  LineClient: class {
    pushMessage = mocks.pushMessage;
  },
}));

import { chats } from './chats.js';
import { broadcasts } from './broadcasts.js';

// ページをまたぐチャット配信の取得契約を確かめる。
// 機能2: 一覧の上限統一・メール/詳細のページ送り・送信の入力検証。
// 機能6: 一覧の N+1 解消(集計の同梱)・limit/cursor/絞り込み/並び順の配線。

const owner: AuthenticatedStaff = {
  id: 'owner-1', name: 'オーナー', role: 'owner', readOnly: false, tenantId: 'tenant-1',
};

function chatsApp(db: D1Database, actor: AuthenticatedStaff = owner) {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.env = { DB: db, LINE_CHANNEL_ACCESS_TOKEN: 'default-token', WORKER_URL: 'https://worker.example' } as Env['Bindings'];
    c.set('staff', actor);
    await next();
  });
  instance.route('/', chats);
  return instance;
}

function broadcastsApp(db: D1Database, actor: AuthenticatedStaff = owner) {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.env = { DB: db, LINE_CHANNEL_ACCESS_TOKEN: 'default-token', WORKER_URL: 'https://worker.example' } as Env['Bindings'];
    c.set('staff', actor);
    await next();
  });
  instance.route('/', broadcasts);
  return instance;
}

function seedTenantsAndAccounts(db: SqliteD1): void {
  db.raw.prepare("INSERT INTO tenants (id, name) VALUES ('tenant-1', '統括1'), ('tenant-2', '統括2')").run();
  db.raw.prepare(`
    INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
    VALUES ('account-1', 'channel-1', '店舗1', 'token-1', 'secret-1', 1, 'tenant-1'),
           ('account-2', 'channel-2', '店舗2', 'token-2', 'secret-2', 1, 'tenant-2')
  `).run();
}

function seedMessage(db: SqliteD1, id: string, friendId: string, createdAt: string): void {
  db.raw.prepare(
    `INSERT INTO messages_log (id, friend_id, direction, message_type, content, created_at)
     VALUES (?, ?, 'incoming', 'text', ?, ?)`,
  ).run(id, friendId, `本文-${id}`, createdAt);
}

function sendJson(body: unknown, key = '123e4567-e89b-12d3-a456-426614174000') {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

describe('#540 機能2: 受信箱一覧の上限とページ送り', () => {
  let testDb: SqliteD1;
  beforeEach(() => {
    testDb = createTestD1();
    seedTenantsAndAccounts(testDb);
    insertFriend(testDb.raw, 'friend-a', { line_account_id: 'account-1' });
    insertFriend(testDb.raw, 'friend-b', { line_account_id: 'account-1' });
    insertFriend(testDb.raw, 'friend-c', { line_account_id: 'account-1' });
    seedMessage(testDb, 'm-a', 'friend-a', '2026-09-01T10:00:00.000Z');
    seedMessage(testDb, 'm-b', 'friend-b', '2026-09-02T10:00:00.000Z');
    seedMessage(testDb, 'm-c', 'friend-c', '2026-09-03T10:00:00.000Z');
  });
  afterEach(() => {
    testDb.raw.close();
    vi.clearAllMocks();
  });

  it('limit=2 は2件だけ返し、カーソルで残りを遡れる', async () => {
    const first = await chatsApp(testDb.db).request('/api/chats?limit=2', {}, { DB: testDb.db } as Env['Bindings']);
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { data: Array<{ id: string; lastMessageAt: string }> };
    expect(firstBody.data).toHaveLength(2);
    expect(firstBody.data.map((row) => row.id)).toEqual(['friend-c', 'friend-b']);

    const last = firstBody.data[firstBody.data.length - 1];
    const second = await chatsApp(testDb.db).request(
      `/api/chats?limit=2&beforeAt=${encodeURIComponent(last.lastMessageAt)}&beforeId=${last.id}`,
      {},
      { DB: testDb.db } as Env['Bindings'],
    );
    expect(second.status).toBe(200);
    const secondBody = await second.json() as { data: Array<{ id: string }> };
    expect(secondBody.data.map((row) => row.id)).toEqual(['friend-a']);
  });

  it('見えない統括のアカウントを直接指定しても存在を返さない', async () => {
    const response = await chatsApp(testDb.db).request('/api/chats?lineAccountId=account-2', {}, {
      DB: testDb.db,
    } as Env['Bindings']);
    expect(response.status).toBe(404);
  });

  it('Instagram を一覧に混ぜ、媒体とカーソルで絞れる', async () => {
    testDb.raw.prepare(`INSERT INTO instagram_messages
      (id,line_account_id,instagram_id,sender_id,recipient_id,content,received_at,created_at)
      VALUES ('ig-message','account-1','ig-business','customer','ig-business','DM','2026-09-02T12:00:00.000Z','2026-09-02T12:00:00.000Z')`).run();
    const first = await chatsApp(testDb.db).request('/api/chats?limit=2&sort=latest');
    const body = await first.json() as { data: Array<{ id: string; channel: string; lastMessageAt: string; lastMessageContent: string }> };
    expect(body.data.map((row) => row.channel)).toEqual(['line', 'instagram']);
    expect(body.data[1].lastMessageContent).toBe('DM');
    const cursor = body.data[1];
    const next = await chatsApp(testDb.db).request(`/api/chats?limit=2&sort=latest&beforeAt=${encodeURIComponent(cursor.lastMessageAt)}&beforeId=${encodeURIComponent(cursor.id)}`);
    const nextBody = await next.json() as { data: Array<{ id: string }> };
    expect(nextBody.data.map((row) => row.id)).toEqual(['friend-b', 'friend-a']);
    const only = await chatsApp(testDb.db).request('/api/chats?channel=instagram');
    const onlyBody = await only.json() as { data: Array<{ channel: string }> };
    expect(onlyBody.data.map((row) => row.channel)).toEqual(['instagram']);
    const lineOnly = await chatsApp(testDb.db).request('/api/chats?channel=line');
    expect(((await lineOnly.json()) as { data: Array<{ channel: string }> }).data.map(row => row.channel)).toEqual(['line', 'line', 'line']);
    testDb.raw.prepare(`INSERT INTO instagram_inbox_reads(staff_id,line_account_id,sender_id,last_read_at)
      VALUES('owner-1','account-1',json_array('ig-business','customer'),'2026-09-02T12:00:00.000Z')`).run();
    const unread = await chatsApp(testDb.db).request('/api/chats?channel=instagram&unreadOnly=1');
    expect(((await unread.json()) as { data: unknown[] }).data).toHaveLength(0);
  });
  it('日本時間と UTC を同じ時刻基準で並べ、ページをまたぐ', async () => {
    testDb.raw.prepare("UPDATE messages_log SET created_at='2026-09-02T21:00:00.000+09:00' WHERE id='m-b'").run();
    testDb.raw.prepare(`INSERT INTO instagram_messages
      (id,line_account_id,instagram_id,sender_id,recipient_id,content,received_at,created_at)
      VALUES ('ig-utc','account-1','ig-business','customer','ig-business','DM','2026-09-02T12:30:00.000Z','2026-09-02T12:30:00.000Z')`).run();
    const first = await chatsApp(testDb.db).request('/api/chats?limit=2&sort=latest');
    const body = await first.json() as { data: Array<{ id: string; channel: string; lastMessageAt: string }> };
    expect(body.data.map((row) => row.channel)).toEqual(['line', 'instagram']);
    const cursor = body.data[1];
    const second = await chatsApp(testDb.db).request(`/api/chats?limit=2&sort=latest&beforeAt=${encodeURIComponent(cursor.lastMessageAt)}&beforeId=${encodeURIComponent(cursor.id)}`);
    expect(((await second.json()) as { data: Array<{ id: string }> }).data.map(row => row.id)).toEqual(['friend-b', 'friend-a']);
  });
});

describe('#540 機能2: 会話詳細は直近から100件ずつ', () => {
  let testDb: SqliteD1;
  beforeEach(() => {
    testDb = createTestD1();
    seedTenantsAndAccounts(testDb);
    insertFriend(testDb.raw, 'friend-long', { line_account_id: 'account-1' });
    for (let i = 1; i <= 5; i += 1) {
      seedMessage(testDb, `long-${i}`, 'friend-long', `2026-09-0${i}T10:00:00.000Z`);
    }
  });
  afterEach(() => {
    testDb.raw.close();
  });

  it('limit=2 は新しい2件と hasMoreMessages=true を返し、遡り切ると false になる', async () => {
    const first = await chatsApp(testDb.db).request('/api/chats/friend-long?limit=2', {}, {
      DB: testDb.db,
    } as Env['Bindings']);
    expect(first.status).toBe(200);
    const firstBody = await first.json() as {
      data: { messages: Array<{ id: string; createdAt: string }>; hasMoreMessages: boolean };
    };
    expect(firstBody.data.messages.map((m) => m.id)).toEqual(['long-4', 'long-5']);
    expect(firstBody.data.hasMoreMessages).toBe(true);

    const oldest = firstBody.data.messages[0];
    const second = await chatsApp(testDb.db).request(
      `/api/chats/friend-long?limit=2&beforeAt=${encodeURIComponent(oldest.createdAt)}&beforeId=${oldest.id}`,
      {},
      { DB: testDb.db } as Env['Bindings'],
    );
    const secondBody = await second.json() as {
      data: { messages: Array<{ id: string; createdAt: string }>; hasMoreMessages: boolean };
    };
    expect(secondBody.data.messages.map((m) => m.id)).toEqual(['long-2', 'long-3']);
    expect(secondBody.data.hasMoreMessages).toBe(true);

    const oldest2 = secondBody.data.messages[0];
    const third = await chatsApp(testDb.db).request(
      `/api/chats/friend-long?limit=2&beforeAt=${encodeURIComponent(oldest2.createdAt)}&beforeId=${oldest2.id}`,
      {},
      { DB: testDb.db } as Env['Bindings'],
    );
    const thirdBody = await third.json() as {
      data: { messages: Array<{ id: string }>; hasMoreMessages: boolean };
    };
    expect(thirdBody.data.messages.map((m) => m.id)).toEqual(['long-1']);
    expect(thirdBody.data.hasMoreMessages).toBe(false);
  });
});

describe('#540 機能2: 送信口の入力検証は400で返す', () => {
  let testDb: SqliteD1;
  beforeEach(() => {
    testDb = createTestD1();
    seedTenantsAndAccounts(testDb);
    insertFriend(testDb.raw, 'friend-send', { line_account_id: 'account-1' });
    testDb.raw.prepare(
      `INSERT INTO chats (id, friend_id, status, revision, created_at, updated_at)
       VALUES ('chat-send', 'friend-send', 'unread', 1, '2026-09-07T10:00:00.000Z', '2026-09-07T10:00:00.000Z')`,
    ).run();
  });
  afterEach(() => {
    testDb.raw.close();
    vi.clearAllMocks();
  });

  it('5000文字を超える本文は500ではなく400で止める', async () => {
    const response = await chatsApp(testDb.db).request(
      '/api/chats/chat-send/send',
      sendJson({ messageType: 'text', content: 'あ'.repeat(5001) }),
      { DB: testDb.db } as Env['Bindings'],
    );
    expect(response.status).toBe(400);
    expect(mocks.pushMessage).not.toHaveBeenCalled();
  });

  it('壊れたFlex JSONは500ではなく400で止める', async () => {
    const response = await chatsApp(testDb.db).request(
      '/api/chats/chat-send/send',
      sendJson({ messageType: 'flex', content: '{壊れた' }),
      { DB: testDb.db } as Env['Bindings'],
    );
    expect(response.status).toBe(400);
    expect(mocks.pushMessage).not.toHaveBeenCalled();
  });

  it('壊れた画像 JSON は500ではなく400で止める', async () => {
    const response = await chatsApp(testDb.db).request(
      '/api/chats/chat-send/send',
      sendJson({ messageType: 'image', content: '[壊れた' }),
      { DB: testDb.db } as Env['Bindings'],
    );
    expect(response.status).toBe(400);
    expect(mocks.pushMessage).not.toHaveBeenCalled();
  });

  it('壊れたリクエスト本文は500ではなく400で止める', async () => {
    const response = await chatsApp(testDb.db).request(
      '/api/chats/chat-send/send',
      sendJson('{壊れた'),
      { DB: testDb.db } as Env['Bindings'],
    );
    expect(response.status).toBe(400);
    expect(mocks.pushMessage).not.toHaveBeenCalled();
  });

  it('対応外の messageType は400で止める', async () => {
    const response = await chatsApp(testDb.db).request(
      '/api/chats/chat-send/send',
      sendJson({ messageType: 'video', content: 'x' }),
      { DB: testDb.db } as Env['Bindings'],
    );
    expect(response.status).toBe(400);
    expect(mocks.pushMessage).not.toHaveBeenCalled();
  });

  it('正しい送信は届き、同じキー・同じ内容の2回目は再送せず再生する', async () => {
    const key = '123e4567-e89b-12d3-a456-426614174001';
    const first = await chatsApp(testDb.db).request(
      '/api/chats/chat-send/send',
      sendJson({ messageType: 'text', content: 'こんにちは' }, key),
      { DB: testDb.db } as Env['Bindings'],
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ success: true, data: { sent: true } });
    expect(mocks.pushMessage).toHaveBeenCalledTimes(1);

    const second = await chatsApp(testDb.db).request(
      '/api/chats/chat-send/send',
      sendJson({ messageType: 'text', content: 'こんにちは' }, key),
      { DB: testDb.db } as Env['Bindings'],
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ success: true, data: { sent: true, replayed: true } });
    expect(mocks.pushMessage).toHaveBeenCalledTimes(1);
  });
});

function seedBroadcast(db: SqliteD1, id: string, overrides: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id,
    title: id,
    message_type: 'text',
    message_content: 'お知らせ',
    target_type: 'all',
    status: 'sent',
    total_count: 10,
    success_count: 10,
    line_account_id: 'account-1',
    sent_at: '2026-09-07T10:00:00.000Z',
    created_at: '2026-09-07T09:00:00.000Z',
    ...overrides,
  };
  const columns = Object.keys(row);
  db.raw.prepare(
    `INSERT INTO broadcasts (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  ).run(...columns.map((column) => row[column] as never));
}

describe('#540 機能6: 一覧はページ送り・絞り込み・並び順を口で受ける', () => {
  let testDb: SqliteD1;
  beforeEach(() => {
    testDb = createTestD1();
    seedTenantsAndAccounts(testDb);
    seedBroadcast(testDb, 'b-new', {
      status: 'sent', sent_at: '2026-09-07T10:00:00.000Z', created_at: '2026-09-07T09:00:00.000Z',
    });
    seedBroadcast(testDb, 'b-mid', {
      status: 'scheduled', sent_at: null, scheduled_at: '2026-09-06T10:00:00.000Z',
      created_at: '2026-09-06T09:00:00.000Z', folder_id: 'folder-1',
    });
    seedBroadcast(testDb, 'b-old', {
      status: 'sent', sent_at: '2026-09-05T10:00:00.000Z', created_at: '2026-09-05T09:00:00.000Z',
    });
    seedBroadcast(testDb, 'b-other', { line_account_id: 'account-2' });
  });
  afterEach(() => {
    testDb.raw.close();
  });

  it('limit=2 は2件と次のカーソル・総数を返し、他人口座の分は混ざらない', async () => {
    const first = await broadcastsApp(testDb.db).request('/api/broadcasts?limit=2', {}, {
      DB: testDb.db,
    } as Env['Bindings']);
    expect(first.status).toBe(200);
    const firstBody = await first.json() as {
      data: Array<{ id: string }>;
      pagination: { total: number; limit: number; nextCursor: string | null };
    };
    expect(firstBody.data.map((row) => row.id)).toEqual(['b-new', 'b-mid']);
    expect(firstBody.pagination.total).toBe(3);
    expect(firstBody.pagination.nextCursor).not.toBeNull();

    const second = await broadcastsApp(testDb.db).request(
      `/api/broadcasts?limit=2&cursor=${firstBody.pagination.nextCursor}`,
      {},
      { DB: testDb.db } as Env['Bindings'],
    );
    const secondBody = await second.json() as {
      data: Array<{ id: string }>;
      pagination: { nextCursor: string | null };
    };
    expect(secondBody.data.map((row) => row.id)).toEqual(['b-old']);
    expect(secondBody.pagination.nextCursor).toBeNull();
  });

  it('状態とフォルダの絞り込みは口側で行う', async () => {
    const scheduled = await broadcastsApp(testDb.db).request('/api/broadcasts?status=scheduled', {}, {
      DB: testDb.db,
    } as Env['Bindings']);
    const scheduledBody = await scheduled.json() as { data: Array<{ id: string }> };
    expect(scheduledBody.data.map((row) => row.id)).toEqual(['b-mid']);

    const folder = await broadcastsApp(testDb.db).request('/api/broadcasts?folderId=folder-1', {}, {
      DB: testDb.db,
    } as Env['Bindings']);
    const folderBody = await folder.json() as { data: Array<{ id: string }> };
    expect(folderBody.data.map((row) => row.id)).toEqual(['b-mid']);
  });

  it('sort=oldest は古い順に返す', async () => {
    const response = await broadcastsApp(testDb.db).request('/api/broadcasts?sort=oldest', {}, {
      DB: testDb.db,
    } as Env['Bindings']);
    const body = await response.json() as { data: Array<{ id: string }> };
    expect(body.data.map((row) => row.id)).toEqual(['b-old', 'b-mid', 'b-new']);
  });

  it('他人口座の一覧指定は403、他人口座の1件取得は存在を返さない', async () => {
    const scoped = await broadcastsApp(testDb.db).request('/api/broadcasts?lineAccountId=account-2', {}, {
      DB: testDb.db,
    } as Env['Bindings']);
    expect(scoped.status).toBe(403);

    const single = await broadcastsApp(testDb.db).request('/api/broadcasts/b-other', {}, {
      DB: testDb.db,
    } as Env['Bindings']);
    expect(single.status).toBe(404);
  });
});

describe('#540 機能6: 一覧に集計を同梱し、送信済みごとの取得を要らないようにする', () => {
  let testDb: SqliteD1;
  beforeEach(() => {
    testDb = createTestD1();
    seedTenantsAndAccounts(testDb);
    seedBroadcast(testDb, 'b-with-insight', { status: 'sent' });
    seedBroadcast(testDb, 'b-without-insight', { status: 'sent' });
    testDb.raw.prepare(
      `INSERT INTO broadcast_insights
         (id, broadcast_id, delivered, unique_impression, unique_click, open_rate, click_rate, status, fetched_at, created_at)
       VALUES ('insight-1', 'b-with-insight', 100, 40, 5, 0.4, 0.05, 'ready',
               '2026-09-07T11:00:00.000Z', '2026-09-07T11:00:00.000Z')`,
    ).run();
  });
  afterEach(() => {
    testDb.raw.close();
  });

  it('集計行がある送信済みは insightSummary を持ち、無いものは null', async () => {
    const response = await broadcastsApp(testDb.db).request('/api/broadcasts', {}, {
      DB: testDb.db,
    } as Env['Bindings']);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      data: Array<{
        id: string;
        insightSummary: {
          delivered: number | null; uniqueImpression: number | null; uniqueClick: number | null;
          openRate: number | null; clickRate: number | null;
        } | null;
      }>;
    };
    const byId = new Map(body.data.map((row) => [row.id, row.insightSummary]));
    expect(byId.get('b-with-insight')).toEqual({
      delivered: 100, uniqueImpression: 40, uniqueClick: 5, openRate: 0.4, clickRate: 0.05,
    });
    expect(byId.get('b-without-insight')).toBeNull();
  });
});
