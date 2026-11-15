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
function app(staff = owner, impersonating = false) { const a = new Hono<Env>(); a.use('*', async (c, next) => { c.env = { DB: db.db } as Env['Bindings']; c.set('staff', staff); if (impersonating) c.set('impersonation', {} as never); await next(); }); a.route('/', broadcasts); return a; }
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
 db.raw.exec("UPDATE broadcasts SET success_count=0 WHERE id='source'"); expect((await request()).status).toBe(409); expect(db.raw.prepare('SELECT COUNT(*) n FROM broadcasts WHERE id=?').get(key)).toEqual({ n: 0 });
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

test.each([false,true])('元の配信削除後も固定した宛先だけを扱う（台帳空=%s）', async (empty) => {
 const { vi } = await import('vitest');
 vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T01:00:00Z'));
 const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('{}', {status:200}));
 vi.stubGlobal('fetch', fetchMock);
 try {
  expect((await request()).status).toBe(201);
  db.raw.pragma('foreign_keys = ON');
  db.raw.prepare("DELETE FROM broadcast_send_claims WHERE broadcast_id='source'").run();
  db.raw.prepare("DELETE FROM broadcasts WHERE id='source'").run();
  expect(db.raw.prepare('SELECT correction_of_broadcast_id FROM broadcasts WHERE id=?').get(key)).toEqual({correction_of_broadcast_id:'source'});
  if (empty) db.raw.prepare('DELETE FROM broadcast_send_claims WHERE broadcast_id=?').run(key);
  const preview=await app().request(`/api/broadcasts/${key}/send-preview`);
  expect(await preview.json()).toMatchObject({data:{recipients:empty?0:1}});
  const response=await app().request(`/api/broadcasts/${key}/send`,{method:'POST',headers:{'Content-Type':'application/json','X-Confirm-Irreversible':'broadcast-send'},body:JSON.stringify({expectedVersion:1,confirmedRecipientCount:empty?0:1})});
  if(empty) {
   expect(response.status).toBe(409);
   db.raw.prepare("UPDATE broadcasts SET status='scheduled',scheduled_at='2026-11-16T00:00:00Z' WHERE id=?").run(key);
   const {processScheduledBroadcasts,processQueuedBroadcasts}=await import('../features/broadcasts/broadcast.js');
   await processScheduledBroadcasts(db.db,{} as never);
   await processQueuedBroadcasts(db.db,{} as never);
   expect(fetchMock.mock.calls.filter(([url])=>String(url).includes('/message/'))).toHaveLength(0);
   expect(db.raw.prepare('SELECT status,stopped_at,total_count FROM broadcasts WHERE id=?').get(key)).toMatchObject({status:'sending',stopped_at:expect.any(String),total_count:1});
  }
  else {
   expect(response.status).toBe(202);
   const {processQueuedBroadcasts}=await import('../features/broadcasts/broadcast.js');
   await processQueuedBroadcasts(db.db,{} as never);
   expect(db.raw.prepare('SELECT friend_id,state FROM broadcast_send_claims WHERE broadcast_id=?').all(key)).toEqual([{friend_id:'ok',state:'sent'}]);
   const calls=fetchMock.mock.calls.filter(([url])=>String(url).includes('/message/'));
   expect(calls).toHaveLength(1);
   const payload=JSON.parse(String(calls[0][1]?.body));
   expect(payload.to === 'Uok' || (Array.isArray(payload.to) && payload.to.length === 1 && payload.to[0] === 'Uok')).toBe(true);
  }
 } finally {vi.useRealTimers();vi.unstubAllGlobals();}
});

test('別の鍵で同時に作っても未送信の訂正は一つ、送信後は次を作れる', async () => {
 const key2='d4522a8a-a40e-43eb-860a-38238f24f132';
 const [a,b]=await Promise.all([request(),request('source',owner,key2)]);
 expect([a.status,b.status].sort()).toEqual([200,201]);
 const one=await a.json() as {data:{id:string}},two=await b.json() as {data:{id:string}};
 expect(one.data.id).toBe(two.data.id);
 expect(db.raw.prepare("SELECT COUNT(*) n FROM broadcasts WHERE correction_of_broadcast_id='source'").get()).toEqual({n:1});
 for (const status of ['scheduled','sending']) {
  db.raw.prepare('UPDATE broadcasts SET status=? WHERE id=?').run(status,one.data.id);
  const resumed=await request('source',owner,one.data.id===key ? key2 : key);
  expect(resumed.status).toBe(200);
  expect(await resumed.json()).toMatchObject({data:{id:one.data.id,status}});
 }
 db.raw.prepare("UPDATE broadcasts SET status='sent' WHERE id=?").run(one.data.id);
 const next=await request('source',owner,one.data.id===key ? key2 : key);
 expect(next.status).toBe(201);
 expect((await next.json() as {data:{id:string}}).data.id).not.toBe(one.data.id);
});

test('元配信の失敗先を再送しても既存の訂正宛先は増えず、送信後の新しい訂正には追加される', async () => {
 const {vi}=await import('vitest');
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-16T01:00:00Z'));
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}',{status:200})));
 try {
  db.raw.exec("UPDATE broadcasts SET segment_conditions='{\"operator\":\"AND\",\"rules\":[{\"type\":\"is_following\",\"value\":true}]}' WHERE id='source'; UPDATE broadcast_send_claims SET error_code='line_http_429' WHERE broadcast_id='source' AND friend_id='bad'");
  expect((await request()).status).toBe(201);
  const retry=await app().request('/api/broadcasts/source/retry-failed',{method:'POST',headers:{'Content-Type':'application/json','X-Confirm-Irreversible':'broadcast-send'},body:JSON.stringify({expectedVersion:1})});
  expect(retry.status).toBe(202);
  const {processQueuedBroadcasts}=await import('../features/broadcasts/broadcast.js');
  await processQueuedBroadcasts(db.db,{} as never);
  expect(db.raw.prepare("SELECT friend_id,state FROM broadcast_send_claims WHERE broadcast_id='source' ORDER BY friend_id").all()).toEqual([{friend_id:'bad',state:'sent'},{friend_id:'ok',state:'sent'}]);
  expect(db.raw.prepare('SELECT correction_of_broadcast_id FROM broadcasts WHERE id=?').get(key)).toEqual({correction_of_broadcast_id:'source'});
  expect(db.raw.prepare('SELECT friend_id FROM broadcast_send_claims WHERE broadcast_id=?').all(key)).toEqual([{friend_id:'ok'}]);
  const existing=await request('source',owner,'d4522a8a-a40e-43eb-860a-38238f24f132');
  expect(await existing.json()).toMatchObject({data:{id:key}});
  const sendCorrection=await app().request(`/api/broadcasts/${key}/send`,{method:'POST',headers:{'Content-Type':'application/json','X-Confirm-Irreversible':'broadcast-send'},body:JSON.stringify({expectedVersion:1,confirmedRecipientCount:1})});
  expect(sendCorrection.status).toBe(202);
  await processQueuedBroadcasts(db.db,{} as never);
  expect(db.raw.prepare('SELECT status FROM broadcasts WHERE id=?').get(key)).toEqual({status:'sent'});
  const next=await request('source',owner,'d4522a8a-a40e-43eb-860a-38238f24f132');
  expect(next.status).toBe(201);
  expect(db.raw.prepare('SELECT friend_id FROM broadcast_send_claims WHERE broadcast_id=? ORDER BY friend_id').all('d4522a8a-a40e-43eb-860a-38238f24f132')).toEqual([{friend_id:'bad'},{friend_id:'ok'}]);
 } finally {vi.useRealTimers();vi.unstubAllGlobals();}
});

test('訂正の予約は表示した版と台帳人数だけで確定し、同時の本文変更を拒否する', async () => {
 expect((await request()).status).toBe(201);
 const update=(body:object,confirmed=true)=>app().request(`/api/broadcasts/${key}`,{method:'PUT',headers:{'Content-Type':'application/json',...(confirmed?{'X-Confirm-Irreversible':'broadcast-send'}:{})},body:JSON.stringify(body)});
 const at='2099-11-16T01:00:00Z';
 const impersonated=await app(owner,true).request(`/api/broadcasts/${key}`,{method:'PUT',headers:{'Content-Type':'application/json','X-Confirm-Irreversible':'broadcast-send'},body:JSON.stringify({expectedVersion:1,confirmedRecipientCount:1,scheduledAt:at})});
 expect(impersonated.status).toBe(403);
 expect((await update({expectedVersion:1,confirmedRecipientCount:1,scheduledAt:at},false)).status).toBe(428);
 expect((await update({expectedVersion:1,scheduledAt:at})).status).toBe(409);
 expect((await update({expectedVersion:1,confirmedRecipientCount:2,scheduledAt:at})).status).toBe(409);
 expect((await update({expectedVersion:99,confirmedRecipientCount:1,scheduledAt:at})).status).toBe(409);
 expect((await update({expectedVersion:1,confirmedRecipientCount:1,scheduledAt:at,messageContent:'確認後の変更'})).status).toBe(409);
 const preview=await app().request(`/api/broadcasts/${key}/send-preview`);
 expect(await preview.json()).toMatchObject({data:{recipients:1,expectedVersion:1}});
 const scheduled=await update({expectedVersion:1,confirmedRecipientCount:1,scheduledAt:at});
 expect(scheduled.status).toBe(200);
 expect(db.raw.prepare('SELECT status FROM broadcasts WHERE id=?').get(key)).toEqual({status:'scheduled'});
});


test.each([false,true])('元配信の成功先が全員削除されていれば下書きを作らず理由を返す（外部キー=%s）', async (foreignKeys) => {
 db.raw.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
 db.raw.exec("DELETE FROM friends WHERE id='ok'");
 const result=await request();
 expect(result.status).toBe(409);
 expect(await result.json()).toMatchObject({success:false,code:'CORRECTION_NO_RECIPIENTS',error:'送れる相手がいません'});
 expect(db.raw.prepare('SELECT COUNT(*) n FROM broadcasts WHERE id=?').get(key)).toEqual({n:0});
});


test('作成前に友だちが一部削除されたら残った成功先だけを写し、除いた人数を保存する', async () => {
 db.raw.exec("UPDATE broadcasts SET success_count=2 WHERE id='source'; UPDATE broadcast_send_claims SET state='sent' WHERE broadcast_id='source' AND friend_id='bad'");
 db.raw.pragma('foreign_keys = ON'); db.raw.exec("DELETE FROM friends WHERE id='bad'");
 const made=await request(); expect(made.status).toBe(201);
 expect(db.raw.prepare('SELECT friend_id FROM broadcast_send_claims WHERE broadcast_id=?').all(key)).toEqual([{friend_id:'ok'}]);
 const detail=await app().request(`/api/broadcasts/${key}`);
 expect(await detail.json()).toMatchObject({data:{totalCount:1,correctionExcludedAtCreation:1}});
});

test('作成後に一部削除されても残りだけに送り、作成時の総数と送信数を残す', async () => {
 const {vi}=await import('vitest'); vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-16T01:00:00Z'));
 const fetchMock=vi.fn(async (_input:string|URL|Request,_init?:RequestInit)=>new Response('{}',{status:200})); vi.stubGlobal('fetch',fetchMock);
 try {
  db.raw.exec("UPDATE broadcasts SET success_count=2 WHERE id='source'; UPDATE broadcast_send_claims SET state='sent' WHERE broadcast_id='source' AND friend_id='bad'");
  expect((await request()).status).toBe(201);
  db.raw.pragma('foreign_keys = ON');db.raw.exec("DELETE FROM friends WHERE id='bad'");
  const response=await app().request(`/api/broadcasts/${key}/send`,{method:'POST',headers:{'Content-Type':'application/json','X-Confirm-Irreversible':'broadcast-send'},body:JSON.stringify({expectedVersion:1,confirmedRecipientCount:1})});
  expect(response.status).toBe(202);
  const {processQueuedBroadcasts}=await import('../features/broadcasts/broadcast.js'); await processQueuedBroadcasts(db.db,{} as never);
  expect(db.raw.prepare('SELECT status,total_count,success_count FROM broadcasts WHERE id=?').get(key)).toEqual({status:'sent',total_count:2,success_count:1});
  expect(db.raw.prepare('SELECT friend_id,state FROM broadcast_send_claims WHERE broadcast_id=?').all(key)).toEqual([{friend_id:'ok',state:'sent'}]);
  const sends=fetchMock.mock.calls.filter(([url])=>String(url).includes('/message/'));expect(sends).toHaveLength(1);
 } finally {vi.useRealTimers();vi.unstubAllGlobals();}
});

test('1人運用で予約した後に一部削除されても、残りの人に送って結果を残す', async () => {
 const {vi}=await import('vitest');vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-16T00:00:00Z'));
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}',{status:200})));
 try {
  db.raw.exec("UPDATE broadcasts SET success_count=2 WHERE id='source'; UPDATE broadcast_send_claims SET state='sent' WHERE broadcast_id='source' AND friend_id='bad'; INSERT INTO staff_members(id,name,role,api_key,tenant_id) VALUES('owner','管理者','owner','test','t')");
  expect((await request()).status).toBe(201);
  const {setBroadcastApprovalThreshold}=await import('../features/broadcasts/broadcast-approval.js');await setBroadcastApprovalThreshold(db.db,'a',1);
  const send=await app().request(`/api/broadcasts/${key}/send`,{method:'POST',headers:{'Content-Type':'application/json','X-Confirm-Irreversible':'broadcast-send'},body:JSON.stringify({expectedVersion:1,confirmedRecipientCount:2,scheduledAt:'2026-11-16T01:00:00Z'})});
  expect(send.status).toBe(200);
  db.raw.pragma('foreign_keys = ON');db.raw.exec("DELETE FROM friends WHERE id='bad'");
  vi.setSystemTime(new Date('2026-11-16T01:01:00Z'));
  const {processScheduledBroadcasts,processQueuedBroadcasts}=await import('../features/broadcasts/broadcast.js');
  await processScheduledBroadcasts(db.db,{} as never);await processQueuedBroadcasts(db.db,{} as never);
  expect(db.raw.prepare('SELECT status,total_count,success_count FROM broadcasts WHERE id=?').get(key)).toEqual({status:'sent',total_count:2,success_count:1});
  expect(db.raw.prepare('SELECT friend_id,state FROM broadcast_send_claims WHERE broadcast_id=?').all(key)).toEqual([{friend_id:'ok',state:'sent'}]);
 } finally {vi.useRealTimers();vi.unstubAllGlobals();}
});

test('LINEが受け付けた直後に友だちが削除されても成功数を保ち、残りに送る', async () => {
 const {vi}=await import('vitest');vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-16T01:00:00Z'));
 let removed=false;const fetchMock=vi.fn(async (input:string|URL|Request,init?:RequestInit)=>{
  if(String(input).includes('/message/push') && !removed) { expect(JSON.parse(String(init?.body)).to).toBe('Ubad'); removed=true;db.raw.exec("DELETE FROM friends WHERE id='bad'"); }
  return new Response('{}',{status:200});
 }); vi.stubGlobal('fetch',fetchMock);
 try {
  db.raw.exec("UPDATE friends SET display_name=id; UPDATE broadcasts SET success_count=2 WHERE id='source'; UPDATE broadcast_send_claims SET state='sent' WHERE broadcast_id='source' AND friend_id='bad'");
  expect((await request()).status).toBe(201);db.raw.prepare("UPDATE broadcasts SET message_content='{{name}} さん' WHERE id=?").run(key);
  const sent=await app().request(`/api/broadcasts/${key}/send`,{method:'POST',headers:{'Content-Type':'application/json','X-Confirm-Irreversible':'broadcast-send'},body:JSON.stringify({expectedVersion:1,confirmedRecipientCount:2})});expect(sent.status).toBe(202);
  db.raw.pragma('foreign_keys = ON');const {processQueuedBroadcasts}=await import('../features/broadcasts/broadcast.js');
  await processQueuedBroadcasts(db.db,{} as never);await processQueuedBroadcasts(db.db,{} as never);
  expect(removed).toBe(true);
  expect(db.raw.prepare('SELECT status,total_count,success_count FROM broadcasts WHERE id=?').get(key)).toEqual({status:'sent',total_count:2,success_count:2});
  expect(fetchMock.mock.calls.filter(([url])=>String(url).includes('/message/push'))).toHaveLength(2);
 } finally {vi.useRealTimers();vi.unstubAllGlobals();}
});

test('最後の送信が受け付けられた直後にその友だちが削除されても完了できる', async () => {
 const {vi}=await import('vitest');vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-16T01:00:00Z'));
 let removed=false;vi.stubGlobal('fetch',vi.fn(async (input:string|URL|Request)=>{
  if(String(input).includes('/message/push')&&!removed) {removed=true;db.raw.exec("DELETE FROM friends WHERE id='ok'");}
  return new Response('{}',{status:200});
 }));
 try {
  db.raw.exec("UPDATE friends SET display_name=id");expect((await request()).status).toBe(201);
  db.raw.prepare("UPDATE broadcasts SET message_content='{{name}} さん' WHERE id=?").run(key);
  const sent=await app().request(`/api/broadcasts/${key}/send`,{method:'POST',headers:{'Content-Type':'application/json','X-Confirm-Irreversible':'broadcast-send'},body:JSON.stringify({expectedVersion:1,confirmedRecipientCount:1})});expect(sent.status).toBe(202);
  db.raw.pragma('foreign_keys = ON');const {processQueuedBroadcasts}=await import('../features/broadcasts/broadcast.js');
  await processQueuedBroadcasts(db.db,{} as never);await processQueuedBroadcasts(db.db,{} as never);
  expect(removed).toBe(true);expect(db.raw.prepare('SELECT status,total_count,success_count FROM broadcasts WHERE id=?').get(key)).toEqual({status:'sent',total_count:1,success_count:1});
 } finally {vi.useRealTimers();vi.unstubAllGlobals();}
});

test('元配信の失敗した友だちが削除されても、送信成功先を除いたとは数えない', async () => {
 db.raw.pragma('foreign_keys = ON');db.raw.exec("DELETE FROM friends WHERE id='bad'");
 const made=await request();expect(made.status).toBe(201);
 const detail=await app().request(`/api/broadcasts/${key}`);
 expect(await detail.json()).toMatchObject({data:{totalCount:1,correctionExcludedAtCreation:0}});
});

test('LINE受理と停止・友だち削除が重なっても成功数を消さない', async () => {
 const {vi}=await import('vitest');vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-16T01:00:00Z'));
 let stopped=false;vi.stubGlobal('fetch',vi.fn(async (input:string|URL|Request)=>{
  if(String(input).includes('/message/push')&&!stopped) {stopped=true;db.raw.exec("DELETE FROM friends WHERE id='ok'");db.raw.prepare("UPDATE broadcasts SET stopped_at='now',lock_version=lock_version+1 WHERE id=?").run(key);}
  return new Response('{}',{status:200});
 }));
 try {
  db.raw.exec('UPDATE friends SET display_name=id');expect((await request()).status).toBe(201);
  db.raw.prepare("UPDATE broadcasts SET message_content='{{name}} さん' WHERE id=?").run(key);
  const sent=await app().request(`/api/broadcasts/${key}/send`,{method:'POST',headers:{'Content-Type':'application/json','X-Confirm-Irreversible':'broadcast-send'},body:JSON.stringify({expectedVersion:1,confirmedRecipientCount:1})});expect(sent.status).toBe(202);
  db.raw.pragma('foreign_keys = ON');const {processQueuedBroadcasts}=await import('../features/broadcasts/broadcast.js');await processQueuedBroadcasts(db.db,{} as never);
  expect(stopped).toBe(true);expect(db.raw.prepare('SELECT status,success_count,stopped_at,batch_offset FROM broadcasts WHERE id=?').get(key)).toMatchObject({status:'sending',success_count:1,stopped_at:'now',batch_offset:0});
 } finally {vi.useRealTimers();vi.unstubAllGlobals();}
});
