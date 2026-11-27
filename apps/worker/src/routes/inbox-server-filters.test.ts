import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { chats } from './chats.js';
import { supportInbox } from './support-inbox.js';

const NOW = Date.parse('2026-09-13T12:00:00.000Z');
type Channel = 'line' | 'email';
type Item = { id: string; lastMessageAt: string; operatorId?: string; assignedStaffId?: string; isUnread: boolean; unreadCount?: number };
let db: SqliteD1;
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  db = createTestD1();
  db.raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('account-a', 'channel-a', '本店', 'token', 'secret')`).run();
});
afterEach(() => { db.raw.close(); vi.restoreAllMocks(); });

function app(actor = 'reader-a', foreignTenant = false) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: actor, name: actor, role: 'owner', readOnly: false,
      ...(foreignTenant ? { tenantId: 'other-tenant' } : {}) });
    await next();
  });
  app.route('/', chats);
  app.route('/', supportInbox);
  return app;
}

function seed(channel: Channel, id: string, options: {
  assignee?: string | null; age?: number; read?: boolean; status?: string;
} = {}) {
  const at = new Date(NOW - (options.age ?? 2 * 3600_000)).toISOString();
  const assignee = options.assignee === undefined ? 'target' : options.assignee;
  const status = options.status ?? 'unread';
  if (channel === 'line') {
    db.raw.prepare('INSERT INTO friends(id,line_user_id,display_name,line_account_id) VALUES (?,?,?,?)')
      .run(id, id, id, 'account-a');
    db.raw.prepare(`INSERT INTO chats(id,friend_id,operator_id,status,last_message_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)`).run(id, id, assignee, status, at, at, at);
    db.raw.prepare(`INSERT INTO messages_log(id,friend_id,direction,message_type,content,created_at)
      VALUES (?,?,'incoming','text',?,?)`).run(id, id, id, at);
  } else {
    db.raw.prepare(`INSERT INTO support_email_threads
      (id,customer_email,customer_name,subject,normalized_subject,status,assigned_staff_id,last_message_at,last_incoming_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, `${id}@example.test`, id, id, id, status, assignee, at, at, at, at);
  }
  if (options.read) db.raw.prepare(`INSERT INTO inbox_staff_reads
    (staff_id,channel,conversation_id,last_read_at,updated_at) VALUES ('reader-a',?,?,?,?)`)
    .run(channel, id, new Date(NOW).toISOString(), new Date(NOW).toISOString());
}

async function request(channel: Channel, filters: Record<string, string> = {}, actor = 'reader-a', foreignTenant = false) {
  const query = new URLSearchParams({ limit: '200', ...filters });
  if (channel === 'email') { query.set('channel', 'email'); query.set('status', filters.status ?? 'all'); }
  else query.set('lineAccountId', 'account-a');
  return app(actor, foreignTenant).request(`${channel === 'line' ? '/api/chats' : '/api/support/inbox'}?${query}`, {}, { DB: db.db });
}
async function rows(channel: Channel, filters: Record<string, string> = {}, actor = 'reader-a'): Promise<Item[]> {
  const res = await request(channel, filters, actor);
  expect(res.status).toBe(200);
  const body = await res.json() as { data: Item[] | { items: Item[] } };
  return Array.isArray(body.data) ? body.data : body.data.items;
}
const bareId = (item: Item) => item.id.replace(/^email:/, '');

describe.each(['line', 'email'] as const)('N-016 %s の実SQLite・実ルート', (channel) => {
  const assigneeKey = channel === 'line' ? 'operatorId' : 'assignee';
  test.each(['assignee', 'unassigned', 'unread', 'overdue', 'combined'])('201件目だけ一致: %s をLIMIT前に適用', async (mode) => {
    for (let i = 0; i < 200; i++) seed(channel, `recent-${i}`, { assignee: 'other', age: i * 1000, read: true });
    seed(channel, 'needle', { assignee: mode === 'unassigned' ? null : 'target' });
    const filters: Record<string, string> = mode === 'assignee' ? { [assigneeKey]: 'target' }
      : mode === 'unassigned' ? { [assigneeKey]: 'unassigned' }
      : mode === 'unread' ? { unreadOnly: '1' }
      : mode === 'overdue' ? { quickFilter: 'overdue' }
      : { [assigneeKey]: 'target', unreadOnly: '1', quickFilter: 'overdue' };
    expect((await rows(channel, filters)).map(bareId)).toEqual(['needle']);
  });

  test('担当者別未読は未対応statusと別で、他人の閲覧で消えない', async () => {
    seed(channel, 'read-unanswered', { read: true });
    seed(channel, 'unread-resolved', { status: 'resolved' });
    expect((await rows(channel, { unreadOnly: '1' })).map(bareId)).toEqual(['unread-resolved']);
    expect((await rows(channel, { unreadOnly: '1' }, 'reader-b')).map(bareId).sort())
      .toEqual(['read-unanswered', 'unread-resolved']);
    expect((await rows(channel, { quickFilter: 'reply' })).map(bareId)).toEqual(['read-unanswered']);
  });

  test('既読APIは操作した担当者だけを更新する', async () => {
    seed(channel, 'mark-read');
    const path = channel === 'line' ? '/api/chats/mark-read/read' : '/api/support/email/threads/mark-read/read';
    const response = await app().request(path, { method: 'POST' }, { DB: db.db });
    expect(response.status).toBe(200);
    expect((await rows(channel, { unreadOnly: '1' })).map(bareId)).toEqual([]);
    expect((await rows(channel, { unreadOnly: '1' }, 'reader-b')).map(bareId)).toEqual(['mark-read']);
    expect(db.raw.prepare('SELECT staff_id, channel, conversation_id FROM inbox_staff_reads').all())
      .toEqual([{ staff_id: 'reader-a', channel, conversation_id: 'mark-read' }]);
  });

  test('1時間境界は59分59秒を除外し60分を含み、対応済みは除外', async () => {
    seed(channel, 'before', { age: 3599_000 });
    seed(channel, 'boundary', { age: 3600_000 });
    seed(channel, 'resolved', { age: 7200_000, status: 'resolved' });
    expect((await rows(channel, { quickFilter: 'overdue' })).map(bareId)).toEqual(['boundary']);
  });

  test('501件・同時刻の条件付きページングに欠落重複がなく、各応答は200件以下', async () => {
    for (let i = 0; i < 501; i++) seed(channel, `match-${String(i).padStart(3, '0')}`);
    seed(channel, 'nonmatch', { assignee: 'other' });
    const filters: Record<string, string> = { [assigneeKey]: 'target', unreadOnly: '1', quickFilter: 'overdue' };
    const found: string[] = [];
    for (let page = 0; page < 4; page++) {
      const result = await rows(channel, filters);
      expect(result.length).toBeLessThanOrEqual(200);
      found.push(...result.map(bareId));
      if (result.length < 200) break;
      const last = result[result.length - 1];
      if (channel === 'line') { filters.beforeAt = last.lastMessageAt; filters.beforeId = last.id; }
      else filters.offset = String(found.length);
    }
    expect(found).toHaveLength(501);
    expect(new Set(found).size).toBe(501);
    expect(found).not.toContain('nonmatch');
  });

  test('条件追加で既存のtenant境界を越えない', async () => {
    seed(channel, 'private');
    const response = await request(channel, { [assigneeKey]: 'target', unreadOnly: '1', quickFilter: 'overdue' }, 'foreign', true);
    if (channel === 'line') expect(response.status).toBe(404);
    else {
      expect(response.status).toBe(200);
      expect((await response.json() as { data: { items: unknown[] } }).data.items).toEqual([]);
    }
  });

  test('未対応の条件は黙って無視せず400で返す', async () => {
    expect((await request(channel, { quickFilter: 'unknown' })).status).toBe(400);
    if (channel === 'line') {
      expect((await request(channel, { unansweredOnly: '1', unreadOnly: '1' })).status).toBe(400);
    } else {
      const response = await app().request('/api/support/inbox?channel=all&unreadOnly=1', {}, { DB: db.db });
      expect(response.status).toBe(400);
    }
  });
});

test('LINEの未読数は担当者ごとの受信を数え、既読後の読み直しでも0、新着は残る', async () => {
 seed('line','counted')
 db.raw.prepare("INSERT INTO messages_log(id,friend_id,direction,message_type,content,created_at) VALUES ('m2','counted','incoming','text','2','2026-09-13T11:00:00.000Z'),('out','counted','outgoing','text','x','2026-09-13T11:10:00.000Z'),('test','counted','incoming','text','x','2026-09-13T11:20:00.000Z')").run()
 db.raw.prepare("UPDATE messages_log SET delivery_type='test' WHERE id='test'").run()
 expect((await rows('line')).find(row=>row.id==='counted')).toMatchObject({isUnread:true,unreadCount:2})
 expect((await app().request('/api/chats/counted/read',{method:'POST'},{DB:db.db})).status).toBe(200)
 expect((await rows('line')).find(row=>row.id==='counted')).toMatchObject({isUnread:false,unreadCount:0})
 expect((await rows('line',{},'reader-b')).find(row=>row.id==='counted')).toMatchObject({isUnread:true,unreadCount:2})
 db.raw.prepare("INSERT INTO messages_log(id,friend_id,direction,message_type,content,created_at) VALUES ('m3','counted','incoming','text','3','2026-09-13T11:30:00.000Z')").run()
 expect((await rows('line')).find(row=>row.id==='counted')).toMatchObject({isUnread:true,unreadCount:1})
})
