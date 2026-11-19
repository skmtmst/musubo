import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gapFixture, gapApp } from '../test-utils/gap1.js';
import { broadcasts } from './broadcasts.js';
import { broadcastAb } from './broadcast-ab.js';
import { getBroadcastById } from '@line-crm/db';
import { broadcastSendPreview } from '../services/gap-send-preview.js';
import { enforceBroadcastSendApproval } from '../features/broadcasts/broadcast-approval.js';
import { saveSimulationDraft } from '../features/broadcasts/broadcast-simulation.js';
const sends = vi.hoisted(() => ({ all: 0, recipients: [] as string[] }));
vi.mock('@line-crm/line-sdk', () => ({ LineClient: class {
  async broadcast() { sends.all++; return { requestId: 'all' }; }
  async multicast(to: string[]) { sends.recipients.push(...to); return { requestId: 'limited' }; }
  async pushMessageWithRequestId(to: string) { sends.recipients.push(to); return { data: {}, requestId: 'limited' }; }
} }));
let d: ReturnType<typeof gapFixture>;
let used = 8;
let httpStatus = 200;
const limit = { upToRemainingQuota: true };
function app() { return gapApp(d, [broadcastAb, broadcasts], undefined, false, { WORKER_URL: 'https://worker.test', LINE_CHANNEL_ACCESS_TOKEN: 'unused' }); }
function call(path: string, body: unknown, method = 'POST') {
  return app().request(path, { method, headers: { 'Content-Type': 'application/json', 'X-Confirm-Irreversible': 'broadcast-send', Authorization:'Bearer lh_session:quota-session' }, body: JSON.stringify(body) });
}
function seed() {
  d.raw.exec("INSERT INTO friends(id,line_user_id,display_name,line_account_id) VALUES('f3','Uf3','3人目','a')");
  d.raw.prepare("INSERT INTO broadcasts(id,title,message_type,message_content,target_type,status,line_account_id,message_options_json,track_links,measure_opens) VALUES('limited','案内','text','本文','all','draft','a',?,0,0)").run(JSON.stringify({ deliveryLimit: limit }));
}
beforeEach(async () => {
  vi.useFakeTimers({toFake:['Date']}); vi.setSystemTime(new Date('2026-10-31T03:00:00Z'));
  d = gapFixture(); used = 8; httpStatus = 200; sends.all = 0; sends.recipients = [];
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('quota-session'));
  const hash=[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');
  d.raw.prepare('INSERT INTO admin_sessions(token_hash,staff_id,expires_at,created_at,step_up_at) VALUES(?,?,?,?,?)').run(hash,'o',new Date(Date.now()+3600000).toISOString(),new Date().toISOString(),new Date().toISOString());
  vi.stubGlobal('fetch', vi.fn(async input => new Response(JSON.stringify(String(input).endsWith('/consumption') ? { totalUsage: used } : { type: 'limited', value: 10 }), { status: httpStatus })));
});
afterEach(() => { d.raw.close(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('上限付き配信を確定する公開の口', () => {
  it('人数の確認には候補総数と実際の上限を分けて返し、複数の吹き出しも1人分で数える', async () => {
    seed();
    const res = await call('/api/broadcasts/preflight', { targetType: 'all', lineAccountId: 'a', deliveryLimit: limit, messageCount: 3 });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { quota: Record<string, unknown> } };
    expect(body.data).toMatchObject({ audienceCount: 2, deliveryLimit: { candidateCount: 3, recipientCount: 2 }, quota: { planned: 2, remaining: 2, state: 'available' } });
    expect(sends.all).toBe(0); expect(sends.recipients).toEqual([]);
  });
  it('鍵を受け付けない時は数を作らず、鍵の再発行と接続設定を案内する', async () => {
    httpStatus = 401;
    const res = await call('/api/broadcasts/preflight', { targetType: 'all', lineAccountId: 'a' });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { quota: Record<string, unknown> } };
    expect(body.data.quota).toMatchObject({ monthlyLimit: null, monthlyUsed: null, remaining: null, state: 'unavailable' });
    expect(body.data.quota.reason).toContain('鍵を発行し直し');
    expect(body.data.quota.reason).toContain('接続設定に入れ直し');
    expect(JSON.stringify(body)).not.toContain('test-token');
  });
  it('作成時に内部の確認印を偽造できず、制限の無い下書きへ戻すこともできない', async () => {
    const res = await call('/api/broadcasts', { title: '案内', messageType: 'text', messageContent: '本文', targetType: 'all', lineAccountId: 'a', messageOptions: { deliveryLimit: limit, deliveryLimitConfirmation: { recipientCount: 999, version: 1 } } });
    expect(res.status).toBe(400);
    expect(d.raw.prepare('SELECT COUNT(*) n FROM broadcasts').get()).toEqual({ n: 0 });
  });
  it('人数や版のない送信と、違う人数の送信は、確定印を作らず拒否する', async () => {
    seed();
    for (const body of [{}, { expectedVersion: 1, confirmedRecipientCount: 3 }, { expectedVersion: 9, confirmedRecipientCount: 2 }]) {
      expect((await call('/api/broadcasts/limited/send', body)).status).toBe(409);
    }
    expect(d.raw.prepare("SELECT status,message_options_json FROM broadcasts WHERE id='limited'").get()).toEqual({ status: 'draft', message_options_json: JSON.stringify({ deliveryLimit: limit }) });
    expect(sends.all).toBe(0); expect(sends.recipients).toEqual([]);
  });
  it('予約と同じ更新で人数と新しい版を固定し、翌月の確認でも上限を増やさない', async () => {
    seed();
    const res = await call('/api/broadcasts/limited/send', { expectedVersion: 1, confirmedRecipientCount: 2, scheduledAt: '2099-01-01T01:00:00Z' });
    expect(res.status).toBe(200);
    const row = (await getBroadcastById(d.db, 'limited'))!;
    expect(row.status).toBe('scheduled'); expect(row.lock_version).toBe(2);
    expect(JSON.parse(row.message_options_json!)).toMatchObject({ deliveryLimitConfirmation: { recipientCount: 2, version: 2 } });
    used = 0;
    expect(await broadcastSendPreview(d.db, row)).toMatchObject({ recipients: 2 });
    const read = await app().request('/api/broadcasts/limited');
    expect(JSON.stringify(await read.json())).not.toContain('deliveryLimitConfirmation');
    expect(sends.all).toBe(0); expect(sends.recipients).toEqual([]);
  });
  it('上限を減らしても承認の境目は総候補で判定し、1人運用の入力だけは実送信の人数で照合する', async () => {
    seed();
    d.raw.exec("DELETE FROM staff_members WHERE id='s'; INSERT INTO account_settings(id,line_account_id,key,value) VALUES('threshold','a','broadcast_approval_threshold','3')");
    const row = (await getBroadcastById(d.db, 'limited'))!;
    expect(await enforceBroadcastSendApproval(d.db, row, { confirmedRecipientCount: 3 })).toMatchObject({ allowed: false, code: 'COUNT_MISMATCH' });
    expect(await enforceBroadcastSendApproval(d.db, row, { confirmedRecipientCount: 2 })).toMatchObject({ allowed: true });
  });
  it('A/B・見本・複数アカウントの別経路へ制限を混ぜない', async () => {
    seed();
    expect((await call('/api/broadcasts/limited/ab-test', { enabled: true }, 'PUT')).status).toBe(409);
    expect((await call('/api/broadcasts/limited/send-segment', { conditions: { operator: 'AND', rules: [] } })).status).toBe(409);
    expect((await call('/api/broadcasts/preflight', { targetType: 'multi-account-dedup', lineAccountId: 'a', accountIds: ['a'], deliveryLimit: limit })).status).toBe(400);
    await expect(saveSimulationDraft(d.db, 'a', 'o', 'simulation', { title: '案内', text: '本文', testMode: true, messageOptions: { deliveryLimit: limit } })).rejects.toThrow();
    expect(sends.all).toBe(0); expect(sends.recipients).toEqual([]);
  });
  it.each([{}, {upToRemainingQuota:false}, {upToRemainingQuota:true,maxRecipients:0}, {upToRemainingQuota:true,maxRecipients:1.5}, {upToRemainingQuota:true,maxRecipients:'2'}, {upToRemainingQuota:true,extra:true}])('壊れた上限 %j は人数の推測や全員への切り替えで通さない', async deliveryLimit => {
    const res=await call('/api/broadcasts/preflight',{targetType:'all',lineAccountId:'a',deliveryLimit});
    expect(res.status).toBe(400);expect(sends.all).toBe(0);expect(sends.recipients).toEqual([]);
  });

  it('送る瞬間の401も承認の失敗へ置き換えず、入力と下書きを保つ', async () => {
    seed();httpStatus=401;
    const res=await call('/api/broadcasts/limited/send',{expectedVersion:1,confirmedRecipientCount:2});
    expect(res.status).toBe(409);expect(JSON.stringify(await res.json())).toContain('鍵を発行し直し');
    expect((await getBroadcastById(d.db,'limited'))!.status).toBe('draft');expect(sends.all).toBe(0);expect(sends.recipients).toEqual([]);
  });
  it('名前を差し込む即時の配信も、同じ枠と固定の入口へ通す', async () => {
    seed();d.raw.exec("UPDATE broadcasts SET message_content='{{name}} さん' WHERE id='limited'");
    const res=await call('/api/broadcasts/limited/send',{expectedVersion:1,confirmedRecipientCount:2});
    expect(res.status).toBe(200);
    const row=(await getBroadcastById(d.db,'limited'))!;
    expect(JSON.parse(row.message_options_json!)).toMatchObject({deliveryLimitConfirmation:{broadcastId:'limited',recipientCount:2,version:1}});
    expect(d.raw.prepare("SELECT COUNT(*) n FROM broadcast_send_claims WHERE broadcast_id='limited'").get()).toEqual({n:2});
    expect(sends.all).toBe(0);
  });
  it('名前が無い候補がいる時は、名前を差し込む配信を固定する前に止める', async () => {
    seed();d.raw.exec("UPDATE broadcasts SET message_content='{{name}} さん' WHERE id='limited'; UPDATE friends SET display_name=NULL WHERE id='f'");
    const res=await call('/api/broadcasts/limited/send',{expectedVersion:1,confirmedRecipientCount:2});
    expect(res.status).toBe(400);expect(JSON.stringify(await res.json())).toContain('名前');
    expect((await getBroadcastById(d.db,'limited'))!.status).toBe('draft');
    expect(d.raw.prepare("SELECT COUNT(*) n FROM broadcast_send_claims WHERE broadcast_id='limited'").get()).toEqual({n:0});expect(sends.all).toBe(0);
  });
  it('予約済みの内容を自動保存すると下書きへ戻し、前の人数の確認を使わない', async () => {
    seed();await call('/api/broadcasts/limited/send',{expectedVersion:1,confirmedRecipientCount:2,scheduledAt:'2099-01-01T01:00:00Z'});
    const res=await call('/api/broadcasts/limited',{expectedVersion:2,title:'書き直し',saveAsDraft:true},'PUT');
    expect(res.status).toBe(200);const row=(await getBroadcastById(d.db,'limited'))!;
    expect(row.status).toBe('draft');expect(row.title).toBe('書き直し');expect(JSON.parse(row.message_options_json!)).not.toHaveProperty('deliveryLimitConfirmation');
  });

  it('予約の上限を解除するときは、下書きから新たに人数を確かめる', async () => {
    seed();await call('/api/broadcasts/limited/send',{expectedVersion:1,confirmedRecipientCount:2,scheduledAt:'2099-01-01T01:00:00Z'});
    const denied=await call('/api/broadcasts/limited',{expectedVersion:2,messageOptions:null},'PUT');
    expect(denied.status).toBe(409);
    expect(JSON.parse((await getBroadcastById(d.db,'limited'))!.message_options_json!)).toMatchObject({deliveryLimitConfirmation:{broadcastId:'limited',recipientCount:2,version:2}});
    const saved=await call('/api/broadcasts/limited',{expectedVersion:2,messageOptions:null,saveAsDraft:true},'PUT');
    expect(saved.status).toBe(200);const row=(await getBroadcastById(d.db,'limited'))!;
    expect(row.status).toBe('draft');expect(row.message_options_json).toBeNull();expect(sends.all).toBe(0);
  });

});

it('UNS-08: 配信を並行して2回確定しても配信開始は一度だけ',async()=>{
 seed();
 const [first,second]=await Promise.all([call('/api/broadcasts/limited/send',{expectedVersion:1,confirmedRecipientCount:2}),call('/api/broadcasts/limited/send',{expectedVersion:1,confirmedRecipientCount:2})]);
 expect([first.status,second.status].sort()).toEqual([200,409]);
 expect(d.raw.prepare("SELECT COUNT(*) n FROM broadcast_send_claims WHERE broadcast_id='limited'").get()).toEqual({n:2});
 expect(sends.recipients).toEqual([]);expect(sends.all).toBe(0);
});
