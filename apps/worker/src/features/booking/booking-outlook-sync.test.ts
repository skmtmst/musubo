import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {gapFixture,seedGapBooking} from '../../test-utils/gap1.js';
import {outlookCalendar} from './booking-outlook-calendar.js';
import {syncOutlookBooking,type OutlookSyncDependencies} from './booking-outlook-sync.js';
let d:ReturnType<typeof gapFixture>;
const calls=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{
 if(init?.method==='POST')return new Response(JSON.stringify({id:'outlook-event'}),{status:201});
 if(init?.method==='PATCH'||init?.method==='DELETE')return new Response(null,{status:204});
 return new Response(JSON.stringify({id:'outlook-event',isOrganizer:true,attendees:[], '@odata.etag':'"v1"'}));
});
const calendar={...outlookCalendar(async()=>({token:'fixture',accountId:'owner'}),calls as typeof fetch,{allowMutations:true}),accountId:'owner'};
const deps:OutlookSyncDependencies={resolve:async()=>calendar,allowMutations:true};
const input={accountId:'a',bookingId:'bk'};
beforeEach(()=>{calls.mockClear();d=gapFixture();seedGapBooking(d);d.raw.exec("INSERT INTO booking_calendar_switches(line_account_id,scope_id,write_enabled,updated_by,updated_at) VALUES('a','',1,'o','2026-01-01'),('a','bs',1,'o','2026-01-01')");});
afterEach(()=>d.raw.close());
it('確定・日時変更・取消を同じ予定へ反映し、参加者を付けない',async()=>{
 expect(await syncOutlookBooking(d.db,input,deps)).toBe('done');
 expect(await syncOutlookBooking(d.db,input,deps)).toBe('done');expect(calls).toHaveBeenCalledTimes(1);
 expect(JSON.parse(String(calls.mock.calls[0][1]?.body))).not.toHaveProperty('attendees');
 d.raw.exec("UPDATE bookings SET starts_at='2026-11-21T05:00:00Z',ends_at='2026-11-21T06:00:00Z',lock_version=lock_version+1 WHERE id='bk'");
 expect(await syncOutlookBooking(d.db,input,deps)).toBe('done');expect(calls.mock.calls[2][1]?.method).toBe('PATCH');
 expect(JSON.parse(String(calls.mock.calls[2][1]?.body))).not.toHaveProperty('attendees');
 d.raw.exec("UPDATE bookings SET status='cancelled',lock_version=lock_version+1 WHERE id='bk'");
 expect(await syncOutlookBooking(d.db,input,deps)).toBe('done');expect(calls.mock.calls[4][1]?.method).toBe('DELETE');
 expect(await syncOutlookBooking(d.db,input,deps)).toBe('skipped');expect(calls).toHaveBeenCalledTimes(5);
});
it('変更・取消の設定がオフなら外部へ送らない',async()=>{
 expect(await syncOutlookBooking(d.db,input,deps)).toBe('done');
 d.raw.exec("UPDATE bookings SET status='cancelled',lock_version=lock_version+1 WHERE id='bk'");
 expect(await syncOutlookBooking(d.db,input,{...deps,allowMutations:false})).toBe('skipped');expect(calls).toHaveBeenCalledTimes(1);
});
it('別アカウントで予定を変更できず、結果不明は送り直さない',async()=>{
 expect(await syncOutlookBooking(d.db,input,deps)).toBe('done');
 d.raw.exec("UPDATE bookings SET status='cancelled',lock_version=lock_version+1 WHERE id='bk'");
 const wrong={...outlookCalendar(async()=>({token:'fixture',accountId:'other'}),calls as typeof fetch,{allowMutations:true}),accountId:'other'};
 expect(await syncOutlookBooking(d.db,input,{resolve:async()=>wrong,allowMutations:true})).toBe('failed');expect(calls).toHaveBeenCalledTimes(1);
 expect(await syncOutlookBooking(d.db,{...input,accountId:'b'},deps)).toBe('skipped');
});
it('作成の結果が不明なら同じ取引IDで時間をおいて照合する',async()=>{
 let now=1000000;
 const network=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>{throw new Error('offline')});
 const broken={...outlookCalendar(async()=>({token:'fixture',accountId:'owner'}),network as typeof fetch,{allowMutations:true}),accountId:'owner'};
 const options={resolve:async()=>broken,allowMutations:true,now:()=>now};
 expect(await syncOutlookBooking(d.db,input,options)).toBe('unknown');
 expect(await syncOutlookBooking(d.db,input,options)).toBe('busy');expect(network).toHaveBeenCalledOnce();
 now+=120001;expect(await syncOutlookBooking(d.db,input,options)).toBe('unknown');
 const first=JSON.parse(String(network.mock.calls[0][1]?.body)) as {transactionId:string};
 const second=JSON.parse(String(network.mock.calls[1][1]?.body)) as {transactionId:string};
 expect(first.transactionId).toBe(second.transactionId);
});
it('作成成功後の応答消失でも同じ取引IDで復旧し予定を増やさない',async()=>{
 let now=1000000,first=true;
 const events=new Map<string,string>();
 const network=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{
  const body=JSON.parse(String(init?.body)) as {transactionId:string};
  if(!events.has(body.transactionId))events.set(body.transactionId,`event-${events.size+1}`);
  if(first){first=false;throw new Error('response lost');}
  return new Response(JSON.stringify({id:events.get(body.transactionId)}),{status:201});
 });
 const client={...outlookCalendar(async()=>({token:'fixture',accountId:'owner'}),network as typeof fetch,{allowMutations:true}),accountId:'owner'};
 const options={resolve:async()=>client,allowMutations:true,now:()=>now};
 expect(await syncOutlookBooking(d.db,input,options)).toBe('unknown');
 expect(await syncOutlookBooking(d.db,input,options)).toBe('busy');
 now+=120001;
 expect(await syncOutlookBooking(d.db,input,options)).toBe('done');
 expect(network).toHaveBeenCalledTimes(2);expect(events.size).toBe(1);
 expect(JSON.parse(String(network.mock.calls[0][1]?.body)).transactionId).toBe(JSON.parse(String(network.mock.calls[1][1]?.body)).transactionId);
});
it('同時に確定を回収しても予定は一つだけ作る',async()=>{
 const [a,b]=await Promise.all([syncOutlookBooking(d.db,input,deps),syncOutlookBooking(d.db,input,deps)]);
 expect([a,b]).toContain('done');expect(calls).toHaveBeenCalledOnce();
});
it('担当変更の新しい予定が結果不明でも、新担当の同じ取引IDで回収する',async()=>{
 let now=1000000;
 d.raw.exec("INSERT INTO booking_calendar_switches(line_account_id,scope_id,write_enabled,updated_by,updated_at) VALUES('a','bs2',1,'o','2026-01-01')");
 const oldCalls=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>init?.method==='POST'?new Response(JSON.stringify({id:'old-event'}),{status:201}):init?.method==='DELETE'?new Response(null,{status:204}):new Response(JSON.stringify({id:'old-event',isOrganizer:true,attendees:[], '@odata.etag':'"old"'})));
 let first=true;
 const newCalls=vi.fn(async()=>{if(first){first=false;throw new Error('offline');}return new Response(JSON.stringify({id:'new-event'}),{status:201});});
 const old={...outlookCalendar(async()=>({token:'old',accountId:'old-owner'}),oldCalls as typeof fetch,{allowMutations:true}),accountId:'old-owner'};
 const next={...outlookCalendar(async()=>({token:'new',accountId:'new-owner'}),newCalls as typeof fetch,{allowMutations:true}),accountId:'new-owner'};
 const options={resolve:async({staffId}:{staffId:string})=>staffId==='bs'?old:next,allowMutations:true,now:()=>now};
 expect(await syncOutlookBooking(d.db,input,options)).toBe('done');
 d.raw.exec("UPDATE bookings SET staff_id='bs2',lock_version=lock_version+1 WHERE id='bk'");
 expect(await syncOutlookBooking(d.db,input,options)).toBe('unknown');
 now+=120001;expect(await syncOutlookBooking(d.db,input,options)).toBe('done');
 const record=d.raw.prepare("SELECT result_json FROM workflow_steps WHERE process_kind='booking_outlook_sync'").get() as {result_json:string};
 expect(JSON.parse(record.result_json)).toMatchObject({staffId:'bs2',accountId:'new-owner',eventId:'new-event'});expect(newCalls).toHaveBeenCalledTimes(2);
});
it('作成の結果不明中に取消された予約は、回収した予定を続けて消す',async()=>{
 let now=1000000,first=true;
 const network=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{
  if(init?.method==='POST'){if(first){first=false;throw new Error('offline');}return new Response(JSON.stringify({id:'event'}),{status:201});}
  if(init?.method==='DELETE')return new Response(null,{status:204});
  return new Response(JSON.stringify({id:'event',isOrganizer:true,attendees:[], '@odata.etag':'"v"'}));
 });
 const client={...outlookCalendar(async()=>({token:'fixture',accountId:'owner'}),network as typeof fetch,{allowMutations:true}),accountId:'owner'};
 const options={resolve:async()=>client,allowMutations:true,now:()=>now};
 expect(await syncOutlookBooking(d.db,input,options)).toBe('unknown');
 d.raw.exec("UPDATE bookings SET status='cancelled',lock_version=lock_version+1 WHERE id='bk'");
 now+=120001;expect(await syncOutlookBooking(d.db,input,options)).toBe('done');
 expect(network.mock.calls.map(call=>call[1]?.method??'GET')).toEqual(['POST','POST','GET','DELETE']);
 expect(d.raw.prepare("SELECT result_json FROM workflow_steps WHERE process_kind='booking_outlook_sync'").get()).toEqual({result_json:'{"generation":1}'});
});
it('担当交代で新担当の鍵が更新中でも、古い予定の削除後に回復する',async()=>{
 d.raw.exec("INSERT INTO booking_calendar_switches(line_account_id,scope_id,write_enabled,updated_by,updated_at) VALUES('a','bs2',1,'o','2026-01-01')");
 let deferred=true;
 const options={resolve:async({staffId}:{staffId:string})=>staffId==='bs2'&&deferred?'deferred' as const:calendar,allowMutations:true};
 expect(await syncOutlookBooking(d.db,input,options)).toBe('done');
 d.raw.exec("UPDATE bookings SET staff_id='bs2',lock_version=lock_version+1 WHERE id='bk'");
 expect(await syncOutlookBooking(d.db,input,options)).toBe('busy');
 expect(d.raw.prepare("SELECT status,result_json FROM workflow_steps WHERE process_kind='booking_outlook_sync'").get()).toEqual({status:'pending',result_json:'{"generation":1}'});
 deferred=false;expect(await syncOutlookBooking(d.db,input,options)).toBe('done');
 expect(calls.mock.calls.map(call=>call[1]?.method??'GET')).toEqual(['POST','GET','DELETE','POST']);
});
it('失敗した後で予約の版が変わった場合は新しい内容で再試行できる',async()=>{
 expect(await syncOutlookBooking(d.db,input,deps)).toBe('done');
 d.raw.exec("UPDATE bookings SET status='cancelled',lock_version=lock_version+1 WHERE id='bk'");
 const wrong={...outlookCalendar(async()=>({token:'fixture',accountId:'other'}),calls as typeof fetch,{allowMutations:true}),accountId:'other'};
 expect(await syncOutlookBooking(d.db,input,{resolve:async()=>wrong,allowMutations:true})).toBe('failed');
 d.raw.exec("UPDATE bookings SET lock_version=lock_version+1 WHERE id='bk'");
 expect(await syncOutlookBooking(d.db,input,deps)).toBe('done');
});
it('予定を削除して書き直すときは新しい取引IDを使う',async()=>{
 expect(await syncOutlookBooking(d.db,input,deps)).toBe('done');
 const first=JSON.parse(String(calls.mock.calls[0][1]?.body)) as {transactionId:string};
 d.raw.exec("UPDATE booking_calendar_switches SET write_enabled=0 WHERE line_account_id='a' AND scope_id='bs'");
 expect(await syncOutlookBooking(d.db,input,{...deps,removeOnly:true,authorizeRemoval:async()=>true})).toBe('done');
 d.raw.exec("UPDATE booking_calendar_switches SET write_enabled=1 WHERE line_account_id='a' AND scope_id='bs'");
 expect(await syncOutlookBooking(d.db,input,deps)).toBe('done');
 const posts=calls.mock.calls.filter(call=>call[1]?.method==='POST');
 expect(posts).toHaveLength(2);const second=JSON.parse(String(posts[1][1]?.body)) as {transactionId:string};
 expect(second.transactionId).not.toBe(first.transactionId);
});
it('削除の直前にスイッチが戻ると予定を残し、失敗通知もしない',async()=>{
 expect(await syncOutlookBooking(d.db,input,deps)).toBe('done');
 d.raw.exec("UPDATE booking_calendar_switches SET write_enabled=0 WHERE line_account_id='a' AND scope_id='bs'");
 const authorize=vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
 expect(await syncOutlookBooking(d.db,input,{...deps,removeOnly:true,authorizeRemoval:authorize})).toBe('skipped');
 expect(calls.mock.calls.some(call=>call[1]?.method==='DELETE')).toBe(false);
 expect(d.raw.prepare("SELECT status FROM workflow_steps WHERE process_kind='booking_outlook_sync'").get()).toEqual({status:'succeeded'});
 expect(d.raw.prepare("SELECT COUNT(*) n FROM notifications WHERE event_type='booking_outlook_issue'").get()).toEqual({n:0});
});
it.each(['present','absent'] as const)('削除の結果不明のあと再開したら存在を確認する: %s',async evidence=>{
 let now=1000000,deletion=false;
 const fetcher=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{
  if(init?.method==='POST')return new Response(JSON.stringify({id:'event'}),{status:201});
  if(init?.method==='DELETE'){deletion=true;throw new Error('offline');}
  if(deletion&&evidence==='absent')return new Response(null,{status:404});
  return new Response(JSON.stringify({id:'event',isOrganizer:true,attendees:[],'@odata.etag':'"v1"'}));
 });
 const client={...outlookCalendar(async()=>({token:'fixture',accountId:'owner'}),fetcher as typeof fetch,{allowMutations:true}),accountId:'owner'};
 const options={resolve:async()=>client,allowMutations:true,now:()=>now};
 expect(await syncOutlookBooking(d.db,input,options)).toBe('done');
 d.raw.exec("UPDATE booking_calendar_switches SET write_enabled=0 WHERE line_account_id='a' AND scope_id='bs'");
 expect(await syncOutlookBooking(d.db,input,{...options,removeOnly:true,authorizeRemoval:async()=>true})).toBe('unknown');
 d.raw.exec("UPDATE booking_calendar_switches SET write_enabled=1 WHERE line_account_id='a' AND scope_id='bs'; UPDATE workflow_steps SET attempt_count=3 WHERE process_kind='booking_outlook_sync'");
 now+=120001;expect(await syncOutlookBooking(d.db,input,options)).toBe('done');
 expect(fetcher.mock.calls.filter(call=>call[1]?.method==='POST')).toHaveLength(evidence==='present'?1:2);
});
