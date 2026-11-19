import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { gapApp, gapCall, gapFixture } from '../test-utils/gap1.js';
import { slaChatList } from '../services/inbox-sla-list.js';

let fixture: ReturnType<typeof gapFixture>;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-19T12:00:00Z'));
  fixture = gapFixture();
  fixture.raw.exec(`INSERT INTO inbox_routing_settings(account_id,sla_enabled,updated_at) VALUES('a',1,'2026-11-19');
    INSERT INTO chats(id,friend_id,line_account_id,status,pending_since,sla_due_at,created_at,updated_at,notes) VALUES
      ('chat-f','f','a','in_progress','2026-11-19T08:00:00Z','2026-11-19T09:00:00Z','2026-11-19T08:00:00Z','2026-11-19T10:00:00Z','引き継ぎ'),
      ('chat-f2','f2','a','unread','2026-11-19T08:00:00Z','2026-11-19T10:00:00Z','2026-11-19T08:00:00Z','2026-11-19T10:00:00Z',NULL);
    INSERT INTO messages_log(id,friend_id,direction,message_type,content,created_at,delivery_type) VALUES
      ('in-f','f','incoming','text','こんにちは','2026-11-19T08:30:00Z',NULL),
      ('out-f','f','outgoing','flex','{"type":"bubble"}','2026-11-19T09:30:00Z',NULL),
      ('test-f','f','outgoing','text','テスト配信','2026-11-19T10:30:00Z','test'),
      ('in-f2','f2','incoming','text','おはよう','2026-11-19T09:00:00Z',NULL);
    INSERT INTO inbox_staff_reads(staff_id,channel,conversation_id,last_read_at,updated_at) VALUES
      ('o','line','f2','2026-11-19T10:00:00Z','2026-11-19T10:00:00Z');`);
});
afterEach(() => { fixture.raw.close(); vi.useRealTimers(); });

async function list(query = '') {
  const route = new Hono<Env>(); route.get('/api/chats', c => slaChatList(c));
  const response = await gapCall(gapApp(fixture, [route]), `/api/chats?lineAccountId=a&slaState=overdue${query}`);
  expect(response.status).toBe(200);
  return response.json() as Promise<{ data: Array<Record<string, unknown>>; total: number }>;
}

test('期限超過一覧は通常の最新メッセージと担当者ごとの未読を返す', async () => {
  const { data, total } = await list();
  expect(total).toBe(2);
  expect(data[0]).toMatchObject({ id:'f', friendId:'f', conversationId:'chat-f', notes:'引き継ぎ',
    lastMessageContent:null, lastMessageDirection:'outgoing', lastMessageType:'flex', isUnread:true,
    lastMessageAt:'2026-11-19T09:30:00Z', createdAt:'2026-11-19T08:00:00Z', updatedAt:'2026-11-19T10:00:00Z' });
  expect(data[1]).toMatchObject({ id:'f2', lastMessageContent:'おはよう', lastMessageDirection:'incoming', isUnread:false });
});

test('未読絞り込みは期限超過の件数と一覧の両方に反映する', async () => {
  const { data, total } = await list('&unreadOnly=1');
  expect(total).toBe(1); expect(data.map(row => row.id)).toEqual(['f']);
});

test('同時刻の表記が違ってもページを落とさず、未返信の開始時刻がない会話を数えない', async () => {
  fixture.raw.exec(`UPDATE chats SET sla_due_at='2026-11-19T09:00:00.000Z' WHERE id='chat-f2';
    INSERT INTO friends(id,line_user_id,display_name,line_account_id) VALUES('f3','uf3','期限対象外','a');
    INSERT INTO chats(id,friend_id,line_account_id,status,pending_since,sla_due_at,created_at,updated_at)
      VALUES('chat-f3','f3','a','unread',NULL,'2026-11-19T08:00:00Z','2026-11-19','2026-11-19');`);
  const first = await list('&limit=1');
  expect(first.total).toBe(2); expect(first.data.map(row => row.id)).toEqual(['f']);
  const cursor = new URLSearchParams({ limit:'1', beforeDueAt:'2026-11-19T09:00:00Z', beforeId:'f' });
  const next = await list(`&${cursor}`);
  expect(next.total).toBe(2); expect(next.data.map(row => row.id)).toEqual(['f2']);
});

test('取消済みメッセージの本文を一覧に出さない', async () => {
  fixture.raw.exec("UPDATE messages_log SET unsent_at='2026-11-19T09:40:00Z', message_type='text', content='表示しない' WHERE id='out-f'");
  const { data } = await list();
  expect(data[0]).toMatchObject({ lastMessageContent:null, lastMessageType:'unsent', lastMessage:null });
});

test('閲覧範囲外の店は期限超過の一覧と件数に混ぜない', async () => {
  fixture.raw.exec(`INSERT INTO inbox_routing_settings(account_id,sla_enabled,updated_at) VALUES('b',1,'2026-11-19');
    INSERT INTO friends(id,line_user_id,display_name,line_account_id) VALUES('foreign','foreign-user','他店','b');
    INSERT INTO chats(id,friend_id,line_account_id,status,pending_since,sla_due_at,created_at,updated_at)
      VALUES('foreign-chat','foreign','b','unread','2026-11-19T08:00:00Z','2026-11-19T09:00:00Z','2026-11-19','2026-11-19');`);
  const route = new Hono<Env>(); route.get('/api/chats', c => slaChatList(c));
  const response = await gapCall(gapApp(fixture, [route]), '/api/chats?slaState=overdue');
  const body = await response.json() as { data:Array<{id:string}>; total:number };
  expect(body.total).toBe(2); expect(body.data.map(row => row.id)).toEqual(['f','f2']);
  const foreign = await gapCall(gapApp(fixture, [route]), '/api/chats?lineAccountId=b&slaState=overdue');
  expect(await foreign.json()).toMatchObject({data:[],total:0});
});


test('検索は名前と本文を探し、テスト配信の本文は含めない', async () => {
  const found = await list('&q=%20おはよう%20');
  expect(found.total).toBe(1); expect(found.data.map(row => row.id)).toEqual(['f2']);
  const testOnly = await list('&q=テスト配信');
  expect(testOnly.total).toBe(0); expect(testOnly.data).toEqual([]);
});
