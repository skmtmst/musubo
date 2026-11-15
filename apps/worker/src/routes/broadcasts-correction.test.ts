import { afterEach, beforeEach, expect, test } from 'vitest';
import { Hono } from 'hono';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { broadcasts } from './broadcasts.js';
import { previewAudience } from '../features/broadcasts/broadcast-preflight.js';
let db: SqliteD1;
const owner: AuthenticatedStaff = { id: 'owner', name: '管理者', role: 'owner', readOnly: false, tenantId: 't' };
const key = 'c4522a8a-a40e-43eb-860a-38238f24f131';
function app(staff = owner) { const a = new Hono<Env>(); a.use('*', async (c, next) => { c.env = { DB: db.db } as Env['Bindings']; c.set('staff', staff); await next(); }); a.route('/', broadcasts); return a; }
function request(id = 'source', staff = owner, k = key) { return app(staff).request(`/api/broadcasts/${id}/correction`, { method: 'POST', headers: { 'Idempotency-Key': k } }); }
beforeEach(() => {
 db = createTestD1(); db.raw.exec(`INSERT INTO tenants(id,name) VALUES('t','店'),('other','別');
 INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,tenant_id) VALUES('a','ca','店','token','secret','t'),('b','cb','別','token','secret','other');
 INSERT INTO friends(id,line_user_id,line_account_id) VALUES('ok','Uok','a'),('bad','Ubad','a');
 INSERT INTO broadcasts(id,title,message_type,message_content,target_type,status,line_account_id,total_count,success_count) VALUES ('source','お知らせ','text','本文','segment','sent','a',2,1),('draft','下書き','text','本文','segment','draft','a',0,0),('foreign','別店','text','本文','segment','sent','b',0,0);
 INSERT INTO broadcast_send_claims(broadcast_id,friend_id,line_account_id,state) VALUES('source','ok','a','sent'),('source','bad','a','failed');`);
});
afterEach(() => db.raw.close());
test('成功した人だけを固定した下書きを作り同じキーでは再利用する', async () => {
 const first = await request(); expect(first.status).toBe(201); expect(await first.json()).toMatchObject({ success: true, data: { id: key } });
 const again = await request(); expect(again.status).toBe(200); expect(again.headers.get('Idempotency-Replayed')).toBe('true'); expect(await again.json()).toMatchObject({ data: { id: key } });
 expect(db.raw.prepare('SELECT friend_id,state FROM broadcast_send_claims WHERE broadcast_id=?').all(key)).toEqual([{ friend_id: 'ok', state: 'claimed' }]);
 expect(db.raw.prepare('SELECT status,correction_of_broadcast_id,message_content FROM broadcasts WHERE id=?').get(key)).toMatchObject({ status: 'draft', correction_of_broadcast_id: 'source', message_content: expect.stringContaining('誤り') });
 expect(db.raw.prepare('SELECT COUNT(*) n FROM broadcasts WHERE correction_of_broadcast_id=?').get('source')).toEqual({ n: 1 });
});
test('未送信、権限なし、別アカウントは拒否', async () => {
 expect((await request('draft')).status).toBe(409); expect((await request('source', { ...owner, readOnly: true })).status).toBe(403); expect((await request('source', { ...owner, role: 'staff', permissionKeys: [] })).status).toBe(403); expect((await request('foreign')).status).toBe(404);
});
test('台帳と実績が食い違う場合は下書きを作らない', async () => {
 db.raw.exec("DELETE FROM broadcast_send_claims WHERE friend_id='bad'"); expect((await request()).status).toBe(409); expect(db.raw.prepare('SELECT COUNT(*) n FROM broadcasts WHERE id=?').get(key)).toEqual({ n: 0 });
});

test('本文を編集できるが固定された宛先は変更できない', async () => {
 expect((await request()).status).toBe(201);
 const update = (body: object) => app().request(`/api/broadcasts/${key}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: 1, ...body }) });
 expect((await update({ targetType: 'all' })).status).toBe(409);
 expect((await update({ segmentConditions: { operator: 'AND', rules: [] } })).status).toBe(409);
 expect((await update({ messageContent: '正しい案内' })).status).toBe(200);
 expect(db.raw.prepare('SELECT friend_id FROM broadcast_send_claims WHERE broadcast_id=?').all(key)).toEqual([{ friend_id: 'ok' }]);
});
test('送信前の人数は固定した宛先だけを数える', async () => {
 expect((await request()).status).toBe(201);
 const response = await app().request(`/api/broadcasts/${key}/send-preview`);
 expect(response.status).toBe(200);
 expect(await response.json()).toMatchObject({ data: { recipients: 1 } });
});

test('訂正を送る前に確認が必要で、条件を指定する送信口では送れない', async () => {
 expect((await request()).status).toBe(201);
 const headers = { 'Content-Type': 'application/json', 'X-Confirm-Irreversible': 'broadcast-send' };
 const send = await app().request(`/api/broadcasts/${key}/send`, { method: 'POST', headers, body: '{}' });
 expect(send.status).toBe(409);
 const segment = await app().request(`/api/broadcasts/${key}/send-segment`, { method: 'POST', headers, body: JSON.stringify({ conditions: { operator: 'AND', rules: [{ type: 'is_following', value: true }] } }) });
 expect(segment.status).toBe(409);
 expect(db.raw.prepare('SELECT status FROM broadcasts WHERE id=?').get(key)).toEqual({ status: 'draft' });
});

test('元の詳細から訂正を開け、事前確認も固定した人だけ数える', async () => {
 expect((await request()).status).toBe(201);
 const detail = await app().request('/api/broadcasts/source');
 expect(detail.status).toBe(200);
 expect(await detail.json()).toMatchObject({ data: { correction: { id: key, status: 'draft' } } });
 const preview = await previewAudience(db.db, { targetType: 'segment', lineAccountId: 'a', fixedBroadcastId: key });
 expect(preview.sendable).toBe(1);
 expect(preview.representatives.map(row => row.friendId)).toEqual(['ok']);
});

test('予約時刻の再確認と送信は訂正台帳の相手だけを見る', async () => {
 const { vi } = await import('vitest');
 vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T00:00:00Z'));
 const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith('/quota')) return new Response(JSON.stringify({ type: 'limited', value: 1 }), { status: 200 });
  if (url.endsWith('/quota/consumption')) return new Response(JSON.stringify({ totalUsage: 0 }), { status: 200 });
  return new Response('{}', { status: 200 });
 });
 vi.stubGlobal('fetch', fetchMock);
 try {
  db.raw.exec("UPDATE friends SET display_name=CASE WHEN id='ok' THEN '対象者' ELSE NULL END; INSERT INTO staff_members(id,name,role,api_key,tenant_id) VALUES('owner','管理者','owner','test','t')");
  expect((await request()).status).toBe(201);
  const { setBroadcastApprovalThreshold } = await import('../features/broadcasts/broadcast-approval.js');
  expect(await setBroadcastApprovalThreshold(db.db, 'a', 1)).toMatchObject({ ok: true });
  db.raw.prepare("UPDATE broadcasts SET message_content='{{name}} さん' WHERE id=?").run(key);
  const response = await app().request(`/api/broadcasts/${key}/send`, { method:'POST', headers:{'Content-Type':'application/json','X-Confirm-Irreversible':'broadcast-send'}, body:JSON.stringify({expectedVersion:1,confirmedRecipientCount:1,scheduledAt:'2026-11-16T01:00:00Z'}) });
  expect(response.status).toBe(200);
  expect(db.raw.prepare('SELECT status FROM broadcasts WHERE id=?').get(key)).toEqual({status:'scheduled'});
  db.raw.exec("INSERT INTO friends(id,line_user_id,line_account_id,display_name) VALUES('later','Ulater','a',NULL)");
  vi.setSystemTime(new Date('2026-11-16T01:01:00Z'));
  const { processScheduledBroadcasts, processQueuedBroadcasts } = await import('../features/broadcasts/broadcast.js');
  await processScheduledBroadcasts(db.db, {} as never);
  expect(db.raw.prepare('SELECT status FROM broadcasts WHERE id=?').get(key)).toEqual({status:'sending'});
  await processQueuedBroadcasts(db.db, {} as never);
  expect(db.raw.prepare('SELECT friend_id,state FROM broadcast_send_claims WHERE broadcast_id=?').all(key)).toEqual([{friend_id:'ok',state:'sent'}]);
  const sends=fetchMock.mock.calls.filter(([input])=>String(input).includes('/message/push'));
  expect(sends).toHaveLength(1);
  expect(JSON.parse(String(sends[0][1]?.body))).toMatchObject({ to: 'Uok' });
 } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
});
