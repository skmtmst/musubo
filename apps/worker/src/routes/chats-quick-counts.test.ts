import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { chats } from './chats.js';

/*
 * 「すべて／要返信／1時間以上待ち」の件数を、一覧と同じ
 * 条件（アカウント・検索・担当・未読・経路）でサーバーが数える口。
 * 札に出る件数と、その札を押したときの一覧の対象が一致することを
 * 実SQLite・実ルートで確かめる。
 */

const NOW = Date.parse('2026-09-13T12:00:00.000Z');
let db: SqliteD1;

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  db = createTestD1();
  db.raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('account-a', 'channel-a', '本店', 'token', 'secret')`).run();
  db.raw.exec("INSERT INTO account_settings(id,line_account_id,key,value) VALUES('fixture-legacy','account-a','inbox_email_legacy_enabled','true')");
});
afterEach(() => { db.raw.close(); vi.restoreAllMocks(); });

function app(actor = 'reader-a') {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: actor, name: actor, role: 'owner', readOnly: false });
    await next();
  });
  app.route('/', chats);
  return app;
}

function seedLine(id: string, options: {
  assignee?: string | null; age?: number; read?: boolean; status?: string; name?: string;
} = {}) {
  const at = new Date(NOW - (options.age ?? 30 * 60_000)).toISOString();
  const assignee = options.assignee === undefined ? 'target' : options.assignee;
  const status = options.status ?? 'unread';
  db.raw.prepare('INSERT INTO friends(id,line_user_id,display_name,line_account_id) VALUES (?,?,?,?)')
    .run(id, id, options.name ?? id, 'account-a');
  db.raw.prepare(`INSERT INTO chats(id,friend_id,operator_id,status,last_message_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`).run(id, id, assignee, status, at, at, at);
  db.raw.prepare(`INSERT INTO messages_log(id,friend_id,direction,message_type,content,created_at)
    VALUES (?,?,'incoming','text',?,?)`).run(id, id, `msg-${id}`, at);
  if (options.read) db.raw.prepare(`INSERT INTO inbox_staff_reads
    (staff_id,channel,conversation_id,last_read_at,updated_at) VALUES ('reader-a','line',?,?,?)`)
    .run(id, new Date(NOW).toISOString(), new Date(NOW).toISOString());
}

function seedEmail(id: string, options: {
  assignee?: string | null; age?: number; status?: string; name?: string;
} = {}) {
  const at = new Date(NOW - (options.age ?? 30 * 60_000)).toISOString();
  const assignee = options.assignee === undefined ? 'target' : options.assignee;
  const status = options.status ?? 'unread';
  db.raw.prepare(`INSERT INTO support_email_threads
    (id,customer_email,customer_name,subject,normalized_subject,status,assigned_staff_id,last_message_at,last_incoming_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, `${id}@example.test`, options.name ?? id, id, id, status, assignee, at, at, at, at);
}

async function counts(filters: Record<string, string> = {}, actor = 'reader-a') {
  const query = new URLSearchParams({ channel: 'all', ...filters });
  const res = await app(actor).request(`/api/chats/quick-counts?${query}`, {}, { DB: db.db });
  return { status: res.status, body: await res.json() as { success: boolean; data?: { all: number; reply: number; overdue: number; line: { all: number }; email: { all: number } } } };
}

describe('GET /api/chats/quick-counts (INBOX-09)', () => {
  test('Instagramの要返信は最後が受信の会話だけで、1時間以上待ちはLINEとメールだけ', async () => {
    seedLine('line-overdue', { age: 2 * 3600_000 });
    seedEmail('mail-overdue', { age: 2 * 3600_000 });
    const incoming = new Date(NOW - 2 * 3600_000).toISOString();
    const outgoing = new Date(NOW - 3600_000).toISOString();
    const insert = db.raw.prepare(`INSERT INTO instagram_messages(id,line_account_id,instagram_id,sender_id,recipient_id,content,received_at,created_at)
      VALUES(?,'account-a','ig',?,'ig','hello',?,?)`);
    insert.run('m1', 'waiting', incoming, incoming);
    insert.run('m2', 'replied', incoming, incoming);
    db.raw.prepare(`INSERT INTO instagram_inbox_reads(staff_id,line_account_id,sender_id,last_read_at) VALUES('reader-a','account-a',json_array('ig','waiting'),?)`).run(outgoing);
    db.raw.prepare(`INSERT INTO instagram_outbound_messages(idempotency_key,line_account_id,instagram_id,sender_id,staff_id,content,status,created_at,sent_at)
      VALUES('sent','account-a','ig','replied','reader-a','reply','sent',?,?)`).run(outgoing, outgoing);
    const instagram = await counts({ channel: 'instagram' });
    expect(instagram.status).toBe(200);
    expect(instagram.body.data).toMatchObject({ all: 2, reply: 1, overdue: 0 });
    expect((await counts({ channel: 'instagram', unreadOnly: '1' })).body.data).toMatchObject({ all: 1, reply: 0, overdue: 0 });
    const combined = await counts({ channel: 'line', socialChannel: 'all' });
    expect(combined.body.data).toMatchObject({ all: 3, reply: 2, overdue: 1 });
    expect((await counts({ channel: 'all', socialChannel: 'all' })).body.data).toMatchObject({ all: 4, reply: 3, overdue: 2 });
    expect((await counts({ channel: 'email', socialChannel: 'all' })).body.data).toMatchObject({ all: 1, reply: 1, overdue: 1 });
    expect((await counts({ channel: 'all' })).body.data).toMatchObject({ all: 4, reply: 3 });
    expect((await counts({ channel: 'instagram', assignee: 'target' })).body.data).toMatchObject({ all: 0, reply: 0 });
    for (const [channel, quickFilter, expected] of [['instagram', 'reply', 1], ['instagram', 'overdue', 0], ['all', 'reply', 2], ['all', 'overdue', 1]] as const) {
      const res = await app().request(`/api/chats?channel=${channel}&quickFilter=${quickFilter}`, {}, { DB: db.db });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: unknown[] }).data).toHaveLength(expected);
    }
  });
  test('外部連携が停止中の店舗のDMは混合一覧と件数にも含めない', async () => {
    const now = new Date(NOW).toISOString();
    db.raw.prepare(`INSERT INTO instagram_messages(id,line_account_id,instagram_id,sender_id,recipient_id,content,received_at,created_at)
      VALUES('dm','account-a','ig','customer','ig','hello',?,?)`).run(now, now);
    db.raw.exec("INSERT INTO account_settings(id,line_account_id,key,value) VALUES('toggle','account-a','feature.external_integrations','false')");
    expect((await counts()).body.data).toMatchObject({ all: 0, reply: 0 });
    const res = await app().request('/api/chats?channel=all', {}, { DB: db.db });
    expect(await res.json()).toMatchObject({ success: true, data: [] });
  });
  test('Instagramの件数は一覧の200件上限を超えて数える', async () => {
    const at = new Date(NOW).toISOString();
    const insert = db.raw.prepare(`INSERT INTO instagram_messages(id,line_account_id,instagram_id,sender_id,recipient_id,content,received_at,created_at)
      VALUES(?,'account-a','ig',?,'ig','hello',?,?)`);
    for (let i = 0; i < 205; i++) insert.run(`m${i}`, `person${i}`, at, at);
    const result = await counts({ channel: 'instagram' });
    expect(result.body.data).toMatchObject({ all: 205, reply: 205, overdue: 0 });
  });
  test('LINEとメールを合算し、要返信・1時間以上待ちは未対応だけを数える', async () => {
    seedLine('line-unread-recent', { age: 10 * 60_000 });
    seedLine('line-unread-old', { age: 2 * 3600_000 });
    seedLine('line-resolved-old', { status: 'resolved', age: 3 * 3600_000 });
    seedEmail('mail-unread-old', { age: 2 * 3600_000 });
    seedEmail('mail-resolved', { status: 'resolved' });

    // メールはLINEアカウントに所属しない。アカウント選択中も一覧と同じく数える。
    const selected = await counts({ lineAccountId: 'account-a' });
    expect(selected.status).toBe(200);
    expect(selected.body.data).toMatchObject({ all: 5, reply: 3, overdue: 2 });
    expect(selected.body.data?.email.all).toBe(2);

    const all = await counts();
    expect(all.body.data).toMatchObject({ all: 5, reply: 3, overdue: 2 });
    expect(all.body.data?.line.all).toBe(3);
    expect(all.body.data?.email.all).toBe(2);
  });

  test('メールを見られない担当者の件数にはメールが入らない', async () => {
    seedLine('line-unread', {});
    seedEmail('mail-unread', {});
    db.raw.prepare(
      `INSERT INTO staff_members (id, name, role, api_key, tenant_id, account_scope)
       VALUES ('scoped-reader', 'scoped-reader', 'staff', 'key-scoped', NULL, 'accounts')`,
    ).run();
    db.raw.prepare(
      'INSERT INTO staff_account_scopes (staff_id, line_account_id, created_at) VALUES (?, ?, ?)',
    ).run('scoped-reader', 'account-a', new Date(NOW).toISOString());

    // アカウント選択の有無に関わらず、見られない人の件数にメールは入らない。
    for (const filters of [{}, { lineAccountId: 'account-a' }] as Array<Record<string, string>>) {
      const { status, body } = await counts(filters, 'scoped-reader');
      expect(status).toBe(200);
      expect(body.data).toMatchObject({ all: 1, reply: 1 });
      expect(body.data?.email.all).toBe(0);
    }
    const mailOnly = await counts({ channel: 'email' }, 'scoped-reader');
    expect(mailOnly.body.data?.all).toBe(0);
  });

  test('経路の絞り込みで片側だけを数える', async () => {
    seedLine('line-a');
    seedEmail('mail-a');
    expect((await counts({ channel: 'line' })).body.data?.all).toBe(1);
    expect((await counts({ channel: 'email' })).body.data?.all).toBe(1);
    expect((await counts({ channel: 'all' })).body.data?.all).toBe(2);
  });

  test('担当・検索・未読の条件を件数にも適用する', async () => {
    seedLine('hit', { assignee: 'target', name: '見本' });
    seedLine('other-assignee', { assignee: 'other' });
    seedLine('other-name', { assignee: 'target', name: '別人' });
    seedEmail('mail-hit', { assignee: 'target', name: '見本' });

    const byAssignee = await counts({ operatorId: 'target' });
    expect(byAssignee.body.data?.all).toBe(3);
    const byQuery = await counts({ q: '見本' });
    expect(byQuery.body.data?.all).toBe(2);
    const combined = await counts({ operatorId: 'target', q: '見本' });
    expect(combined.body.data).toMatchObject({ all: 2, reply: 2 });
  });

  test('1時間の境界は60分を含み59分59秒を含まない', async () => {
    seedLine('before', { age: 3599_000 });
    seedLine('boundary', { age: 3600_000 });
    const { body } = await counts();
    expect(body.data).toMatchObject({ all: 2, reply: 2, overdue: 1 });
  });

  test('R111 遅れて届いた受信は件数と一覧で同じ待ち時間になる', async () => {
    const seedDelayed = (id: string, eventAgeMs: number, storedAgeMs: number) => {
      const storedAt = new Date(NOW - storedAgeMs).toISOString();
      const eventAt = new Date(NOW - eventAgeMs).toISOString();
      db.raw.prepare('INSERT INTO friends(id,line_user_id,display_name,line_account_id) VALUES (?,?,?,?)')
        .run(id, id, id, 'account-a');
      db.raw.prepare(`INSERT INTO chats(id,friend_id,operator_id,status,last_message_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?)`).run(id, id, null, 'unread', storedAt, storedAt, storedAt);
      db.raw.prepare(`INSERT INTO messages_log(id,friend_id,direction,message_type,content,created_at,line_event_at)
        VALUES (?,?,'incoming','text',?,?,?)`).run(id, id, `msg-${id}`, storedAt, eventAt);
    };
    // 8時の受信が10時に保存 → 10分後の時点で待ち2時間10分。件数と一覧の
    // どちらでも1時間以上待ちになる（受信時刻を正とする）。
    seedDelayed('delayed', 2 * 3600_000 + 10 * 60_000, 10 * 60_000);
    // 逆（保存が古く受信が新しい）はどちらでも1時間以上にしない。
    seedDelayed('backfill', 10 * 60_000, 2 * 3600_000);

    const { body } = await counts({ lineAccountId: 'account-a' });
    expect(body.data).toMatchObject({ all: 2, reply: 2, overdue: 1 });

    const listRes = await app().request(
      '/api/chats?quickFilter=overdue&lineAccountId=account-a&limit=200', {}, { DB: db.db });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json() as { success: boolean; data: Array<{ friendId: string }> };
    expect(listBody.data.map((row) => row.friendId)).toEqual(['delayed']);
  });

  test('チャネル値が不正なら400、権限外アカウントなら404', async () => {
    expect((await counts({ channel: 'bogus' })).status).toBe(400);
    expect((await counts({ lineAccountId: 'account-x' })).status).toBe(404);
  });
});

test('同じ店舗の共通メールと店舗メールを合算する', async () => {
  seedEmail('legacy-shared', {status: 'unread'});
  const at = new Date(NOW - 30 * 60_000).toISOString();
  db.raw.exec(`INSERT INTO account_email_connections(id,account_id,address,mailbox,status,created_at)
    VALUES ('connected-a','account-a','inbox-a@example.test','shop@example.test','connected','2026-01-01')`);
  db.raw.prepare(`INSERT INTO account_email_threads(id,connection_id,customer_email,subject,last_message_at)
    VALUES('store-a','connected-a','customer@example.test','問い合わせ',?)`).run(at);
  db.raw.prepare(`INSERT INTO account_email_messages(id,thread_id,dedup_key,subject,body_text,created_at)
    VALUES('mail-a','store-a','dedup-a','問い合わせ','本文',?)`).run(at);
  expect((await counts({channel:'email',lineAccountId:'account-a'})).body.data?.email.all).toBe(2);
});
