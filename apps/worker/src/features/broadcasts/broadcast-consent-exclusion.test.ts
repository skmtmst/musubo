import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestD1, type SqliteD1 } from '../../test-utils/d1-sqlite.js';
import { processBroadcastSend, processQueuedBroadcasts, processScheduledBroadcasts, guardScheduledBroadcastQuota } from './broadcast.js';
import { prepareHqBroadcast, dispatchHqBroadcast, preflightHqBroadcast, stopHqBroadcast, retryHqBroadcastTarget, getHqBroadcastRun, readHqBroadcastResult, previewHqRetry } from '../../services/hq-broadcasts.js';
import { countAudience, previewAudience } from './broadcast-preflight.js';
import { recoverStalledBroadcasts, markBroadcastRecipientsDispatched } from '@line-crm/db';
import { holdMissingBroadcastAudience } from './broadcast-audience-snapshot.js';
import { createBroadcastRetryKey } from './broadcast-retry-key.js';

const calls = vi.hoisted(() => ({ broadcast: vi.fn(async () => ({ requestId: 'all' })),
  multicast: vi.fn(async (_ids: string[], _messages: unknown) => ({ requestId: 'selected' })),
  pushMessageWithRequestId: vi.fn(async (_id: string, _messages: unknown) => ({ requestId: 'personal' })) }));
vi.mock('@line-crm/line-sdk', async original => ({ ...await original<Record<string, unknown>>(), LineClient: class {
  broadcast = calls.broadcast; multicast = calls.multicast; pushMessageWithRequestId = calls.pushMessageWithRequestId;
} }));
vi.mock('../../services/stealth.js', async original => ({ ...await original<Record<string, unknown>>(), sleep: async () => {}, calculateStaggerDelay: () => 0 }));
let f: SqliteD1;
const tenant = '00000000-0000-4000-8000-000000000001';
function consent(id: string, state = 'revoked', purpose = 'marketing') {
  f.raw.prepare(`INSERT INTO friend_delivery_consents(line_account_id,friend_id,purpose,state,reason,source)
    SELECT line_account_id,id,?,?, '本人希望','manual' FROM friends WHERE id=?`).run(purpose,state,id);
}
function seedBroadcast(status = 'draft', personalized = false) {
  f.raw.prepare(`INSERT INTO broadcasts(id,title,message_type,message_content,target_type,status,track_links,line_account_id,scheduled_at)
    VALUES('b','確認','text',?,'all',?,0,'shop','2000-01-01T00:00:00Z')`).run(personalized ? '{{name}} さん' : 'お知らせ',status);
}
function row() { return f.raw.prepare("SELECT status,success_count,total_count,stopped_at FROM broadcasts WHERE id='b'").get(); }
function sentIds() { return calls.multicast.mock.calls.flatMap(c => c[0]).concat(calls.pushMessageWithRequestId.mock.calls.map(c => c[0])); }
beforeEach(() => {
  f = createTestD1(); vi.clearAllMocks();
  for (const account of ['shop','other']) {
    f.raw.prepare(`INSERT INTO line_accounts(id,name,channel_id,channel_secret,channel_access_token,tenant_id) VALUES(?,?,?,'unused','fake',?)`).run(account,account,account,tenant);
  }
  for (const [id, account] of [['allowed','shop'],['stopped','shop'],['unknown','shop'],['other-friend','other']])
    f.raw.prepare('INSERT INTO friends(id,line_user_id,display_name,line_account_id) VALUES(?,?,?,?)').run(id,'U-'+id,id,account);
  f.raw.prepare(`INSERT INTO staff_members(id,name,role,api_key,tenant_id) VALUES('owner','管理者','owner','fake',?)`).run(tenant);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({type:'limited',value:1000,totalUsage:0}),{status:200})));
});
afterEach(() => { f.raw.close(); vi.unstubAllGlobals(); });
describe('637: 停止者を外して一斉配信を続ける', () => {
  it.each([[false,'line'],[true,'line'],[false,'consent'],[true,'consent']] as const)('束を出す直前の変更で送らず停止する（差し込み=%s・変更=%s）',async(personalized,kind)=>{
    const input={requestId:'hq-presend-drift',title:'配信',messageType:'text' as const,messageContent:personalized?'{{name}} さん':'お知らせ',accountIds:['shop'],accountTagIds:[],excludedAccountIds:[],audience:{kind:'all' as const},scheduledAt:null};
    const run=await prepareHqBroadcast(f.db,tenant,'owner',input);
    const {hqAudienceSnapshot}=await import('../hq-broadcasts/hq-audience-confirmation.js');
    const before=await hqAudienceSnapshot(f.db,tenant,'shop',input);
    const sent=await dispatchHqBroadcast(f.db,run,'owner',1,undefined,undefined,[{accountId:'shop',recipientCount:before.recipientCount,recipientToken:before.recipientToken}]);
    const child=sent.targets[0].broadcastId!;
    await processScheduledBroadcasts(f.db,calls as never);
    const original=f.db.prepare.bind(f.db);let changed=false;
    const spy=vi.spyOn(f.db,'prepare').mockImplementation(sql=>{
      if(!changed && sql.includes("SET state='claimed',attempt_no=?") && sql.includes('dispatched_at=?')){
        changed=true;if(kind==='line')f.raw.prepare("UPDATE friends SET line_user_id='U-swapped' WHERE id='allowed'").run();else consent('allowed');
      }
      return original(sql);
    });
    try { await processQueuedBroadcasts(f.db,calls as never); } finally { spy.mockRestore(); }
    expect(changed).toBe(true);expect(sentIds()).toEqual([]);
    expect(f.raw.prepare('SELECT stopped_at FROM broadcasts WHERE id=?').get(child)).toMatchObject({stopped_at:expect.any(String)});
  });
  it('古い処理は送信直前の台帳を確定できない',async()=>{
    seedBroadcast('sending');
    f.raw.prepare("UPDATE broadcasts SET lock_version=2,batch_offset=-1 WHERE id='b'").run();
    f.raw.prepare("INSERT INTO broadcast_send_claims (broadcast_id,friend_id,line_account_id,attempt_no,state) VALUES ('b','allowed','shop',1,'claimed')").run();
    expect(await markBroadcastRecipientsDispatched(f.db,{broadcastId:'b',lineAccountId:'shop',attemptNo:1,friendIds:['allowed'],expectedLockVersion:1})).toEqual([]);
    expect(f.raw.prepare("SELECT dispatched_at FROM broadcast_send_claims WHERE broadcast_id='b' AND friend_id='allowed'").get()).toEqual({dispatched_at:null});
  });
  it('古い処理の宛先異常は引き継ぎ後の配信を停止しない',async()=>{
    seedBroadcast('sending');
    f.raw.prepare("UPDATE broadcasts SET lock_version=2,batch_offset=-1 WHERE id='b'").run();
    await holdMissingBroadcastAudience(f.db,{id:'b',expected:1,known:0,started:true,expectedLockVersion:1,requireBatchLock:true});
    expect(f.raw.prepare("SELECT stopped_at,batch_offset FROM broadcasts WHERE id='b'").get()).toEqual({stopped_at:null,batch_offset:-1});
    expect(f.raw.prepare("SELECT COUNT(*) AS n FROM broadcast_lifecycle_events WHERE broadcast_id='b'").get()).toEqual({n:0});
  });
  it('個別送信の1人目で停止したら未送信を成功数に入れない',async()=>{
    let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r}),wait=new Promise<void>(r=>{release=r});
    calls.pushMessageWithRequestId.mockImplementationOnce(async()=>{entered();await wait;return {requestId:'mock'};});
    const run=await prepareHqBroadcast(f.db,tenant,'owner',{requestId:'hq-personal-stop',title:'配信',messageType:'text',messageContent:'{{name}} さん',accountIds:['shop'],accountTagIds:[],excludedAccountIds:[],audience:{kind:'all'},scheduledAt:null});
    const sent=await dispatchHqBroadcast(f.db,run,'owner',1),child=sent.targets[0].broadcastId!;await processScheduledBroadcasts(f.db,calls as never);
    const pending=processQueuedBroadcasts(f.db,calls as never);await started;
    try {await stopHqBroadcast(f.db,await getHqBroadcastRun(f.db,tenant,run.id),'owner',false,2);} finally {release();await pending;}
    expect(sentIds()).toEqual(['U-allowed']);
    expect(f.raw.prepare('SELECT batch_offset,success_count FROM broadcasts WHERE id=?').get(child)).toEqual({batch_offset:1,success_count:1});
    expect(f.raw.prepare("SELECT COUNT(*) n FROM broadcast_send_claims WHERE broadcast_id=? AND state<>'sent'").get(child)).toEqual({n:2});
  });
  it.each(['next-batch','finish'] as const)('停止を%sで検知した時も送信済み位置を残す',async point=>{
    if(point==='next-batch')for(let i=0;i<10;i++)f.raw.prepare('INSERT INTO friends(id,line_user_id,display_name,line_account_id) VALUES(?,?,?,?)').run(`extra-${i}`,`U-extra-${i}`,`extra-${i}`,'shop');
    const run=await prepareHqBroadcast(f.db,tenant,'owner',{requestId:`hq-stop-${point}`,title:'配信',messageType:'text',messageContent:point==='next-batch'?'{{name}} さん':'お知らせ',accountIds:['shop'],accountTagIds:[],excludedAccountIds:[],audience:{kind:'all'},scheduledAt:null});
    const sent=await dispatchHqBroadcast(f.db,run,'owner',1),child=sent.targets[0].broadcastId!;await processScheduledBroadcasts(f.db,calls as never);
    const prepare=f.db.prepare.bind(f.db);let seen=0,injected=false;
    vi.spyOn(f.db,'prepare').mockImplementation(sql=>{
      const stmt=prepare(sql);const target=point==='next-batch'?sql.includes('SELECT stopped_at FROM broadcasts WHERE id = ?'):sql.includes("UPDATE broadcasts SET status='sent',sent_at=?,batch_lock_at=NULL,batch_offset=?");
      if(!target||(point==='next-batch'&&++seen!==2))return stmt;
      return new Proxy(stmt,{get(target,key){if(key==='bind')return (...args:unknown[])=>{
        const bound=target.bind(...args);return new Proxy(bound,{get(item,prop){
          if(prop===(point==='next-batch'?'first':'run'))return async()=>{injected=true;f.raw.prepare("UPDATE broadcasts SET stopped_at=datetime('now'),lock_version=lock_version+1 WHERE id=?").run(child);return point==='next-batch'?item.first():item.run();};
          const v=Reflect.get(item,prop);return typeof v==='function'?v.bind(item):v;
        }});
      };const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
    });
    await processQueuedBroadcasts(f.db,calls as never);
    const count=point==='next-batch'?10:3;expect(injected).toBe(true);expect(sentIds()).toHaveLength(count);
    expect(f.raw.prepare('SELECT batch_offset,success_count FROM broadcasts WHERE id=?').get(child)).toEqual({batch_offset:count,success_count:count});
  });
  it('送信直前に台帳を押さえられた宛先だけを一括送信と再試行キーに使う',async()=>{
    const run=await prepareHqBroadcast(f.db,tenant,'owner',{requestId:'hq-partial',title:'配信',messageType:'text',messageContent:'お知らせ',accountIds:['shop'],accountTagIds:[],excludedAccountIds:[],audience:{kind:'all'},scheduledAt:null});
    const sent=await dispatchHqBroadcast(f.db,run,'owner',1),child=sent.targets[0].broadcastId!;await processScheduledBroadcasts(f.db,calls as never);
    const prepare=f.db.prepare.bind(f.db);let intercepted=false;
    vi.spyOn(f.db,'prepare').mockImplementation(sql=>{
      const stmt=prepare(sql);if(intercepted||!sql.includes('SELECT DISTINCT friend_id FROM friend_delivery_consents WHERE state'))return stmt;
      intercepted=true;
      return new Proxy(stmt,{get(target,key){if(key==='bind')return (...args:unknown[])=>{
        const bound=target.bind(...args);return new Proxy(bound,{get(item,prop){if(prop==='all')return async()=>{
          const result=await item.all();f.raw.prepare("UPDATE broadcast_send_claims SET state='sent' WHERE broadcast_id=? AND friend_id IN ('stopped','unknown')").run(child);return result;
        };const value=Reflect.get(item,prop);return typeof value==='function'?value.bind(item):value;}});
      };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
    });
    await processQueuedBroadcasts(f.db,calls as never);
    expect(intercepted).toBe(true);expect(calls.multicast).toHaveBeenCalledTimes(1);
    const [ids,messages,,key]=calls.multicast.mock.calls[0] as unknown as [string[],unknown,unknown,string];
    expect(ids).toEqual(['U-allowed']);
    expect(key).toBe(await createBroadcastRetryKey(child,'queued-multicast','attempt:1','allowed',JSON.stringify(messages)));
  });
  it('新しい処理がロック中でも古い版は未送信の人を押さえられない',async()=>{
    seedBroadcast('sending');f.raw.exec("UPDATE broadcasts SET batch_offset=-1,lock_version=2 WHERE id='b'");
    f.raw.prepare("INSERT INTO broadcast_send_claims(broadcast_id,friend_id,line_account_id,attempt_no,state) VALUES('b','allowed','shop',1,'claimed')").run();
    const input={broadcastId:'b',attemptNo:1,lineAccountId:'shop',friendIds:['allowed']};
    expect(await markBroadcastRecipientsDispatched(f.db,{...input,expectedLockVersion:1})).toEqual([]);
    expect(f.raw.prepare("SELECT dispatched_at FROM broadcast_send_claims WHERE broadcast_id='b'").get()).toEqual({dispatched_at:null});
    expect(await markBroadcastRecipientsDispatched(f.db,{...input,expectedLockVersion:2})).toEqual(['allowed']);
  });
  it('復旧前に取り出した古い処理は、新しい版のロックを取得できない',async()=>{
    const run=await prepareHqBroadcast(f.db,tenant,'owner',{requestId:'hq-old-lock',title:'配信',messageType:'text',messageContent:'お知らせ',accountIds:['shop'],accountTagIds:[],excludedAccountIds:[],audience:{kind:'all'},scheduledAt:null});
    const sent=await dispatchHqBroadcast(f.db,run,'owner',1),child=sent.targets[0].broadcastId!;await processScheduledBroadcasts(f.db,calls as never);
    let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r}),wait=new Promise<void>(r=>{release=r});
    const prepare=f.db.prepare.bind(f.db);let intercepted=false;
    vi.spyOn(f.db,'prepare').mockImplementation(sql=>{
      const stmt=prepare(sql);if(intercepted||!sql.includes("UPDATE broadcasts SET batch_offset = -1"))return stmt;intercepted=true;
      return new Proxy(stmt,{get(target,key){if(key==='bind')return (...args:unknown[])=>{const bound=target.bind(...args);return new Proxy(bound,{get(item,prop){if(prop==='run')return async()=>{entered();await wait;return item.run();};const v=Reflect.get(item,prop);return typeof v==='function'?v.bind(item):v;}});};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
    });
    const old=processQueuedBroadcasts(f.db,calls as never);await started;
    f.raw.prepare("UPDATE broadcasts SET batch_offset=-1,batch_lock_at=datetime('now','-1 hour') WHERE id=?").run(child);
    await recoverStalledBroadcasts(f.db);release();await old;expect(sentIds()).toEqual([]);
    await processQueuedBroadcasts(f.db,calls as never);expect(sentIds().sort()).toEqual(['U-allowed','U-stopped','U-unknown']);
  });
  it('古い予約処理は新しい版の配信準備を上書きしない',async()=>{
    seedBroadcast('sending');f.raw.prepare("UPDATE broadcasts SET target_type='segment',segment_conditions=?,lock_version=2,total_count=99 WHERE id='b'").run(JSON.stringify({operator:'AND',rules:[{type:'is_following',value:true}]}));
    await processBroadcastSend(f.db,calls as never,'b',undefined,undefined,1);
    expect(f.raw.prepare("SELECT total_count FROM broadcasts WHERE id='b'").get()).toEqual({total_count:99});expect(sentIds()).toEqual([]);
  });
  it.each([false,true])('復旧前後の処理が重なっても二重送信しない（差し込み=%s）',async personalized=>{
    let entered!:()=>void,release!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve}),wait=new Promise<void>(resolve=>{release=resolve});
    let enteredNew!:()=>void,releaseNew!:()=>void;
    const startedNew=new Promise<void>(resolve=>{enteredNew=resolve}),waitNew=new Promise<void>(resolve=>{releaseNew=resolve});
    (personalized?calls.pushMessageWithRequestId:calls.multicast).mockImplementationOnce(async()=>{enteredNew();await waitNew;return {requestId:'new'};});
    const run=await prepareHqBroadcast(f.db,tenant,'owner',{requestId:'hq-generation',title:'配信',messageType:'text',messageContent:personalized?'{{name}} さん':'お知らせ',accountIds:['shop'],accountTagIds:[],excludedAccountIds:[],audience:{kind:'all'},scheduledAt:null});
    const sent=await dispatchHqBroadcast(f.db,run,'owner',1),child=sent.targets[0].broadcastId!;
    await processScheduledBroadcasts(f.db,calls as never);
    const prepare=f.db.prepare.bind(f.db);let intercepted=false;
    vi.spyOn(f.db,'prepare').mockImplementation(sql=>{
      const statement=prepare(sql);
      if(!sql.includes('SELECT DISTINCT friend_id FROM friend_delivery_consents WHERE state')||intercepted)return statement;
      intercepted=true;
      return new Proxy(statement,{get(target,prop){
        if(prop==='bind')return (...args:unknown[])=>{
          const bound=target.bind(...args);
          return new Proxy(bound,{get(item,key){
            if(key==='all')return async()=>{const result=await item.all();entered();await wait;return result;};
            const value=Reflect.get(item,key);return typeof value==='function'?value.bind(item):value;
          }});
        };
        const value=Reflect.get(target,prop);return typeof value==='function'?value.bind(target):value;
      }});
    });
    const old=processQueuedBroadcasts(f.db,calls as never);await started;
    let current:Promise<void>|undefined;
    try {
      f.raw.prepare("UPDATE broadcasts SET batch_lock_at=datetime('now','-1 hour'),success_count=? WHERE id=?").run(personalized?1:0,child);
      await recoverStalledBroadcasts(f.db);
      current=processQueuedBroadcasts(f.db,calls as never);await startedNew;
      release();await old;
      expect(f.raw.prepare('SELECT batch_offset FROM broadcasts WHERE id=?').get(child)).toEqual({batch_offset:-1});
    } finally {release();releaseNew();await old;await current;}
    expect(sentIds().sort()).toEqual(['U-allowed','U-stopped','U-unknown']);
    if(!personalized)expect(calls.multicast).toHaveBeenCalledTimes(1);
  });
  it('送信要求の応答待ちで復旧しても同じ相手を送り直さない',async()=>{
    let entered!:()=>void,release!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve}),wait=new Promise<void>(resolve=>{release=resolve});
    calls.multicast.mockImplementationOnce(async()=>{entered();await wait;return {requestId:'mock'};});
    const run=await prepareHqBroadcast(f.db,tenant,'owner',{requestId:'hq-inflight',title:'配信',messageType:'text',messageContent:'お知らせ',accountIds:['shop'],accountTagIds:[],excludedAccountIds:[],audience:{kind:'all'},scheduledAt:null});
    const sent=await dispatchHqBroadcast(f.db,run,'owner',1),child=sent.targets[0].broadcastId!;
    await processScheduledBroadcasts(f.db,calls as never);
    const old=processQueuedBroadcasts(f.db,calls as never);await started;
    try {
      f.raw.prepare("UPDATE broadcasts SET batch_lock_at=datetime('now','-1 hour') WHERE id=?").run(child);
      await recoverStalledBroadcasts(f.db);await processQueuedBroadcasts(f.db,calls as never);
    } finally {release();await old;}
    expect(sentIds().sort()).toEqual(['U-allowed','U-stopped','U-unknown']);
  });
  it('送信の応答待ちで停止したら旧処理の終了時にロックを解く',async()=>{
    let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r}),wait=new Promise<void>(r=>{release=r});
    calls.multicast.mockImplementationOnce(async()=>{entered();await wait;return {requestId:'mock'};});
    const run=await prepareHqBroadcast(f.db,tenant,'owner',{requestId:'hq-stop-release',title:'配信',messageType:'text',messageContent:'お知らせ',accountIds:['shop'],accountTagIds:[],excludedAccountIds:[],audience:{kind:'all'},scheduledAt:null});
    const sent=await dispatchHqBroadcast(f.db,run,'owner',1),child=sent.targets[0].broadcastId!;await processScheduledBroadcasts(f.db,calls as never);
    const old=processQueuedBroadcasts(f.db,calls as never);await started;
    await stopHqBroadcast(f.db,await getHqBroadcastRun(f.db,tenant,run.id),'owner',false,2);release();await old;
    expect(f.raw.prepare('SELECT batch_offset,success_count FROM broadcasts WHERE id=?').get(child)).toEqual({batch_offset:3,success_count:3});
  });
  it('送信前に停止した配信は確認時の宛先だけを再開後に送る',async()=>{
    const run=await prepareHqBroadcast(f.db,tenant,'owner',{requestId:'hq-frozen',title:'配信',messageType:'text',messageContent:'お知らせ',accountIds:['shop'],accountTagIds:[],excludedAccountIds:[],audience:{kind:'all'},scheduledAt:null});
    await dispatchHqBroadcast(f.db,run,'owner',1);
    await stopHqBroadcast(f.db,await getHqBroadcastRun(f.db,tenant,run.id),'owner',false,2);
    const current=await getHqBroadcastRun(f.db,tenant,run.id),target=(await readHqBroadcastResult(f.db,current)).targets[0];
    expect(target.retryableCount).toBe(3);
    await retryHqBroadcastTarget(f.db,current,'shop','owner',target.version,await previewHqRetry(f.db,current,'shop'));
    f.raw.exec("INSERT INTO friends(id,line_user_id,display_name,line_account_id) VALUES('late','U-late','late','shop')");
    await processScheduledBroadcasts(f.db,calls as never);await processQueuedBroadcasts(f.db,calls as never);
    expect(sentIds().sort()).toEqual(['U-allowed','U-stopped','U-unknown']);
  });
  it('停止前の準備処理が遅れて動いても再送予約を上書きしない',async()=>{
    const run=await prepareHqBroadcast(f.db,tenant,'owner',{requestId:'hq-stale-start',title:'配信',messageType:'text',messageContent:'お知らせ',accountIds:['shop'],accountTagIds:[],excludedAccountIds:[],audience:{kind:'all'},scheduledAt:null});
    const sent=await dispatchHqBroadcast(f.db,run,'owner',1),child=sent.targets[0].broadcastId!;
    f.raw.prepare("UPDATE broadcasts SET status='sending' WHERE id=?").run(child);
    await stopHqBroadcast(f.db,await getHqBroadcastRun(f.db,tenant,run.id),'owner',false,2);
    const current=await getHqBroadcastRun(f.db,tenant,run.id),target=(await readHqBroadcastResult(f.db,current)).targets[0];
    await retryHqBroadcastTarget(f.db,current,'shop','owner',target.version,await previewHqRetry(f.db,current,'shop'));
    await processBroadcastSend(f.db,calls as never,child,undefined,undefined,1);
    expect(f.raw.prepare('SELECT status FROM broadcasts WHERE id=?').get(child)).toEqual({status:'scheduled'});
    expect(sentIds()).toEqual([]);
  });
  it('処理中に停止して再送しても古い処理が新しい試行を壊さない',async()=>{
    let entered!:()=>void,release!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve}),wait=new Promise<void>(resolve=>{release=resolve});
    calls.multicast.mockImplementationOnce(async()=>{entered();await wait;return {requestId:'mock'};});
    const run=await prepareHqBroadcast(f.db,tenant,'owner',{requestId:'hq-race',title:'配信',messageType:'text',messageContent:'お知らせ',accountIds:['shop'],accountTagIds:[],excludedAccountIds:[],audience:{kind:'all'},scheduledAt:null});
    const sent=await dispatchHqBroadcast(f.db,run,'owner',1);const child=sent.targets[0].broadcastId!;
    await processScheduledBroadcasts(f.db,calls as never);
    const pending=processQueuedBroadcasts(f.db,calls as never);await started;
    await stopHqBroadcast(f.db,await getHqBroadcastRun(f.db,tenant,run.id),'owner',false,2);
    f.raw.prepare("INSERT INTO friends(id,line_user_id,line_account_id) VALUES('retry','U-retry','shop')").run();
    f.raw.prepare("INSERT INTO broadcast_send_claims(broadcast_id,friend_id,state,error_code) VALUES(?,'retry','failed','line_http_429')").run(child);
    await retryHqBroadcastTarget(f.db,await getHqBroadcastRun(f.db,tenant,run.id),'shop','owner',2);
    release();await pending;
    await processQueuedBroadcasts(f.db,calls as never);
    expect(sentIds().sort()).toEqual(['U-allowed','U-retry','U-stopped','U-unknown']);
  });
  it.each([false,true])('即時・名前差し込み=%s: 全員の指定を保ち、停止/不明だけ除き、再実行でも重複しない', async personalized => {
    consent('stopped');consent('stopped','unknown','news');consent('unknown','unknown');
    f.raw.exec("UPDATE friends SET display_name=NULL WHERE id='stopped'");
    seedBroadcast('draft',personalized);
    const client = calls as never;
    expect(await processBroadcastSend(f.db,client,'b')).toMatchObject({status:'sending',target_type:'all'});
    await processQueuedBroadcasts(f.db,client);await processQueuedBroadcasts(f.db,client);
    expect(calls.broadcast).not.toHaveBeenCalled();expect(sentIds()).toEqual(['U-allowed']);
    expect(row()).toMatchObject({status:'sent',success_count:1});
    expect(f.raw.prepare("SELECT friend_id,state,error_code FROM broadcast_send_claims WHERE error_code='delivery_consent_suppressed' ORDER BY friend_id").all())
      .toEqual([{friend_id:'stopped',state:'failed',error_code:'delivery_consent_suppressed'},{friend_id:'unknown',state:'failed',error_code:'delivery_consent_suppressed'}]);
  });
  it('予約の全員配信も停止者を外して完了する',async()=>{
    consent('stopped');consent('unknown','unknown');seedBroadcast('scheduled');
    await processScheduledBroadcasts(f.db,calls as never);await processQueuedBroadcasts(f.db,calls as never);
    expect(calls.broadcast).not.toHaveBeenCalled();expect(sentIds()).toEqual(['U-allowed']);expect(row()).toMatchObject({status:'sent',success_count:1});
  });
  it('停止者が全員なら外部に送らず完了する',async()=>{
    for(const id of ['allowed','stopped','unknown'])consent(id);
    seedBroadcast();await processBroadcastSend(f.db,calls as never,'b');await processQueuedBroadcasts(f.db,calls as never);
    expect(sentIds()).toEqual([]);expect(calls.broadcast).not.toHaveBeenCalled();expect(row()).toMatchObject({status:'sent',success_count:0});
  });
  it.each(['none','granted','other-account'])('対象店の停止者なし(%s)なら従来のLINE全員配信を維持する',async mode=>{
    if(mode==='granted')consent('stopped','granted');if(mode==='other-account')consent('other-friend');
    seedBroadcast();await processBroadcastSend(f.db,calls as never,'b');
    expect(calls.broadcast).toHaveBeenCalledTimes(1);expect(sentIds()).toEqual([]);expect(row()).toMatchObject({status:'sent'});
  });
  it('確認は目的数でなく人数を数え、停止者を見本と送信枠から除く',async()=>{
    consent('stopped');consent('stopped','unknown','news');consent('unknown','unknown');consent('other-friend');
    const input={targetType:'all',lineAccountId:'shop'};
    expect(await countAudience(f.db,input)).toMatchObject({total:1});
    const preview=await previewAudience(f.db,input);
    expect(preview).toMatchObject({matched:3,sendable:1,exclusions:{paused:2,total:2}});
    expect(preview.representatives.map(r=>r.friendId)).toEqual(['allowed']);
    seedBroadcast();vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({type:'limited',value:1,totalUsage:0}))));
    const broadcast=f.raw.prepare("SELECT * FROM broadcasts WHERE id='b'").get();
    expect(await guardScheduledBroadcastQuota(f.db,broadcast as never,'shop')).toEqual({blocked:false});
  });
  it('開始後に停止を追加しても、次の束では送らず残りを続ける',async()=>{
    consent('stopped');seedBroadcast('draft',true);
    for(let i=0;i<155;i++)f.raw.prepare('INSERT INTO friends(id,line_user_id,display_name,line_account_id) VALUES(?,?,?,\'shop\')').run('a'+String(i).padStart(3,'0'),'Ua'+i,'名前');
    await processBroadcastSend(f.db,calls as never,'b');await processQueuedBroadcasts(f.db,calls as never);
    expect(sentIds()).toHaveLength(150);consent('allowed');
    await processQueuedBroadcasts(f.db,calls as never);
    expect(sentIds()).not.toContain('U-allowed');expect(new Set(sentIds()).size).toBe(sentIds().length);expect(row()).toMatchObject({status:'sent'});
  });
  it('全員が配信停止の店は0人として完了し、別の店の配信を止めない',async()=>{
    for(const id of ['allowed','stopped','unknown'])consent(id);
    const run=await prepareHqBroadcast(f.db,tenant,'owner',{requestId:'hq-zero',title:'一括配信',messageType:'text',messageContent:'お知らせ',accountIds:['shop','other'],accountTagIds:[],excludedAccountIds:[],audience:{kind:'all'},scheduledAt:null});
    expect((await preflightHqBroadcast(f.db,run)).find(p=>p.accountId==='shop')).toMatchObject({audienceCount:0,consentExcluded:3,blockedReasons:[]});
    await dispatchHqBroadcast(f.db,run,'owner',1);await processScheduledBroadcasts(f.db,calls as never);await processQueuedBroadcasts(f.db,calls as never);
    expect(sentIds()).toEqual(['U-other-friend']);
    expect(f.raw.prepare("SELECT status,success_count FROM broadcasts WHERE line_account_id='shop'").get()).toEqual({status:'sent',success_count:0});
    const {readHqBroadcastResult}=await import('../../services/hq-broadcasts.js');
    const result=await readHqBroadcastResult(f.db,run);
    expect(result.targets.find(t=>t.accountId==='shop')?.failureReasons).toEqual([{code:'consent_excluded',label:'配信を止めているため送りませんでした',count:3,retryable:false}]);
  });
  it('統括の全員指定も店別に人数と警告を返し、停止者がいる店を除外せず送れる',async()=>{
    consent('stopped');consent('unknown','unknown');
    const run=await prepareHqBroadcast(f.db,tenant,'owner',{requestId:'hq-consent',title:'一括配信',messageType:'text',messageContent:'お知らせ',accountIds:['shop','other'],accountTagIds:[],excludedAccountIds:[],audience:{kind:'all'},scheduledAt:null});
    const check=await preflightHqBroadcast(f.db,run);
    expect(check.find(p=>p.accountId==='shop')).toMatchObject({audienceCount:1,consentExcluded:2,blockedReasons:[],warnings:['配信を止めている 2 人には送りません。']});
    expect(check.find(p=>p.accountId==='other')).toMatchObject({audienceCount:1,consentExcluded:0,blockedReasons:[]});
    await dispatchHqBroadcast(f.db,run,'owner',1);
    await processScheduledBroadcasts(f.db,calls as never);await processQueuedBroadcasts(f.db,calls as never);
    expect(sentIds().sort()).toEqual(['U-allowed','U-other-friend']);expect(calls.broadcast).not.toHaveBeenCalled();
    expect(f.raw.prepare("SELECT status,success_count FROM broadcasts ORDER BY line_account_id").all()).toEqual([{status:'sent',success_count:1},{status:'sent',success_count:1}]);
  });
});

describe('統括が確認した送信対象',()=>{
 it('確認直後に固定した宛先だけへ送り、後から増えた人と二重送信を防ぐ',async()=>{
  const input={requestId:'hq-confirmed',title:'一括配信',messageType:'text' as const,messageContent:'お知らせ',accountIds:['shop'],accountTagIds:[],excludedAccountIds:[],audience:{kind:'all' as const},scheduledAt:null};
  const run=await prepareHqBroadcast(f.db,tenant,'owner',input);
  const {hqAudienceSnapshot}=await import('../hq-broadcasts/hq-audience-confirmation.js');
  const before=await hqAudienceSnapshot(f.db,tenant,'shop',input);
  const result=await dispatchHqBroadcast(f.db,run,'owner',1,undefined,undefined,[{accountId:'shop',recipientCount:before.recipientCount,recipientToken:before.recipientToken}]);
  const id=result.targets[0].broadcastId!;
  expect((f.raw.prepare('SELECT friend_id FROM broadcast_send_claims WHERE broadcast_id=? ORDER BY friend_id').all(id) as Array<{friend_id:string}>).map(row=>row.friend_id)).toEqual(before.rows.map(row=>row.id));
  f.raw.prepare("INSERT INTO friends(id,line_user_id,display_name,line_account_id) VALUES('late','U-late','後の人','shop')").run();
  await processScheduledBroadcasts(f.db,calls as never);await processQueuedBroadcasts(f.db,calls as never);await processQueuedBroadcasts(f.db,calls as never);
  expect(sentIds().sort()).toEqual(before.rows.map(row=>row.line_user_id).sort());
  expect(sentIds()).not.toContain('U-late');expect(new Set(sentIds()).size).toBe(sentIds().length);
 });
});

it('統括配信の受付後にLINE宛先が変わったら誰にも送らず止まる',async()=>{
 const input={requestId:'hq-changed-dest',title:'一括配信',messageType:'text' as const,messageContent:'お知らせ',accountIds:['shop'],accountTagIds:[],excludedAccountIds:[],audience:{kind:'all' as const},scheduledAt:null};
 const run=await prepareHqBroadcast(f.db,tenant,'owner',input);
 const {hqAudienceSnapshot}=await import('../hq-broadcasts/hq-audience-confirmation.js');const before=await hqAudienceSnapshot(f.db,tenant,'shop',input);
 const result=await dispatchHqBroadcast(f.db,run,'owner',1,undefined,undefined,[{accountId:'shop',recipientCount:before.recipientCount,recipientToken:before.recipientToken}]);
 const id=result.targets[0].broadcastId!;f.raw.exec("UPDATE friends SET line_user_id='U-changed' WHERE id='allowed'");
 await processScheduledBroadcasts(f.db,calls as never);await processQueuedBroadcasts(f.db,calls as never);
 expect(sentIds()).toEqual([]);expect((f.raw.prepare('SELECT stopped_at FROM broadcasts WHERE id=?').get(id) as {stopped_at:string|null}).stopped_at).not.toBeNull();
});

it('確認済み統括配信の同時処理は同じ宛先に二重送信しない',async()=>{
 const input={requestId:'hq-concurrent',title:'一括配信',messageType:'text' as const,messageContent:'お知らせ',accountIds:['shop'],accountTagIds:[],excludedAccountIds:[],audience:{kind:'all' as const},scheduledAt:null};
 const run=await prepareHqBroadcast(f.db,tenant,'owner',input);const {hqAudienceSnapshot}=await import('../hq-broadcasts/hq-audience-confirmation.js');const before=await hqAudienceSnapshot(f.db,tenant,'shop',input);
 await dispatchHqBroadcast(f.db,run,'owner',1,undefined,undefined,[{accountId:'shop',recipientCount:before.recipientCount,recipientToken:before.recipientToken}]);
 await processScheduledBroadcasts(f.db,calls as never);
 const prepare=f.db.prepare.bind(f.db),batch=f.db.batch.bind(f.db),dispatchStatements=new WeakSet<object>();
 let queuedReads=0,releaseReads!:()=>void,releaseDispatch!:()=>void,dispatchBatches=0;
 const readsReady=new Promise<void>(resolve=>{releaseReads=resolve});
 const twoDispatches=new Promise<void>(resolve=>{releaseDispatch=resolve});
 const prepareSpy=vi.spyOn(f.db,'prepare').mockImplementation(sql=>{
  const statement=prepare(sql);
  if(sql.includes("SELECT * FROM broadcasts WHERE status = 'sending' AND batch_offset >= 0"))return new Proxy(statement,{get(target,key){
   if(key==='all')return async()=>{const result=await target.all();if(++queuedReads===2)releaseReads();await readsReady;return result};
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  if(sql.includes('UPDATE broadcast_send_claims')&&sql.includes("SET state='claimed',attempt_no=?")&&sql.includes('dispatched_at=?'))return new Proxy(statement,{get(target,key){
   if(key==='bind')return (...args:unknown[])=>{const bound=target.bind(...args);dispatchStatements.add(bound);return bound};
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  return statement;
 });
 const batchSpy=vi.spyOn(f.db,'batch').mockImplementation(async statements=>{
  if(statements.some(item=>dispatchStatements.has(item))){if(++dispatchBatches===2)releaseDispatch();await Promise.race([twoDispatches,new Promise<void>(resolve=>setTimeout(resolve,100))]);}
  return batch(statements);
 });
 try { await Promise.all([processQueuedBroadcasts(f.db,calls as never),processQueuedBroadcasts(f.db,calls as never)]); }
 finally { prepareSpy.mockRestore();batchSpy.mockRestore(); }
 expect(queuedReads).toBe(2);expect(dispatchBatches).toBe(1);
 expect(sentIds().sort()).toEqual(before.rows.map(row=>row.line_user_id).sort());expect(new Set(sentIds()).size).toBe(sentIds().length);
});
