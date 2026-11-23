import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {Env} from '../../worker-env.js';
import {gapFixture} from '../../test-utils/gap1.js';
import {beginMeetingAuthorization,consumeMeetingAuthorization} from './booking-meeting-oauth-state.js';
import {finishAuthorizedMeetingConnection} from './booking-meeting-credentials.js';
import {outlookBusyForStaff,refreshOutlookBusyCaches} from './booking-outlook-busy-runtime.js';
import {readCalendarBusy} from './calendar-busy-read.js';
import {encryptCredential} from '@line-crm/db';
import {cleanupIndex} from './booking-external-cleanup-proof.js';
let d:ReturnType<typeof gapFixture>;const key=btoa('x'.repeat(32));
function env():Env['Bindings']{return {DB:d.db,WORKER_URL:'https://worker.example.test',DEPLOY_ENV:'staging',LINE_CREDENTIAL_ENCRYPTION_KEY:key,BOOKING_MEETING_OAUTH_ENABLED:'true',BOOKING_MEETING_REAL_ENABLED:'true',BOOKING_MEETING_OAUTH_CONFIG:JSON.stringify({outlook:{clientId:'fixture-client',clientSecret:'fixture-secret'}})} as Env['Bindings'];}
const query={lineAccountId:'a',staffId:'bs',timeMin:'2026-12-01T00:00:00Z',timeMax:'2026-12-02T00:00:00Z'};
beforeEach(async()=>{
 d=gapFixture();d.raw.exec(`UPDATE staff_members SET line_user_id='Uf2' WHERE id='s'; INSERT INTO account_settings(id,line_account_id,key,value) VALUES('test','a','test_recipients','["f2"]');
 INSERT INTO booking_calendar_switches(line_account_id,scope_id,read_enabled,updated_by,updated_at) VALUES('a','',1,'o','2026-01-01'),('a','bs',1,'o','2026-01-01');`);
 const state=await beginMeetingAuthorization(d.db,{accountId:'a',staffId:'bs',actorId:'o',provider:'outlook',verifier:'fixture',encryptionKey:key});
 await consumeMeetingAuthorization(d.db,{accountId:'a',state,actorId:'o',encryptionKey:key});
 expect(await finishAuthorizedMeetingConnection(d.db,{accountId:'a',staffId:'bs',actorId:'o',provider:'outlook',state,encryptionKey:key,credential:{provider:'outlook',externalAccountId:'provider-user',refreshToken:'fixture-refresh'}})).toBe(true);
});
afterEach(()=>{d.raw.close();vi.unstubAllGlobals()});
it('試験対象の担当者の予定を読み、控えを使い、本人以外は通信しない',async()=>{
 d.raw.exec(`INSERT INTO workflow_steps(scope_id,process_kind,subject_id,step_key,status,retry_key,result_json,created_at,updated_at) VALUES('line:a','booking_outlook_sync','booking','current','succeeded','x','{"eventId":"own","accountId":"provider-user","staffId":"bs"}',0,0)`);
 const fetcher=vi.fn(async(url:RequestInfo|URL)=>String(url).includes('login.microsoftonline.com')?new Response(JSON.stringify({access_token:'fixture-access',refresh_token:'fixture-refresh',expires_in:3600})):new Response(JSON.stringify({value:[{id:'busy',showAs:'busy',isAllDay:false,start:{dateTime:'2026-12-01T01:00:00',timeZone:'UTC'},end:{dateTime:'2026-12-01T02:00:00',timeZone:'UTC'}},{id:'own',showAs:'busy',isAllDay:false,start:{dateTime:'2026-12-01T03:00:00',timeZone:'UTC'},end:{dateTime:'2026-12-01T04:00:00',timeZone:'UTC'}}]})));
 vi.stubGlobal('fetch',fetcher);
 const result=await readCalendarBusy(d.db,{outlookBusy:input=>outlookBusyForStaff(env(),input)},query);
 expect(result).toEqual([{start:'2026-12-01T01:00:00.000Z',end:'2026-12-01T02:00:00.000Z'}]);expect(fetcher).toHaveBeenCalledTimes(2);
 expect(await readCalendarBusy(d.db,{},query)).toEqual(result);expect(fetcher).toHaveBeenCalledTimes(2);
 d.raw.exec("UPDATE account_settings SET value='[]' WHERE key='test_recipients'");
 await expect(outlookBusyForStaff(env(),query)).rejects.toThrow('outlook_test_staff_required');expect(fetcher).toHaveBeenCalledTimes(2);
});
it('未登録の担当者を定期処理から外し、外部通信しない',async()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);d.raw.exec("UPDATE account_settings SET value='[]' WHERE key='test_recipients'");
 expect(await refreshOutlookBusyCaches(env(),new Date('2026-12-01T00:00:00Z'))).toBe(0);expect(fetcher).not.toHaveBeenCalled();
});
it('顧客削除後も後片づけ待ちの自分の予定を空き枠から二重に引かない',async()=>{
 const index=await cleanupIndex(key,'a','outlook','bs');
 const encrypted=JSON.stringify(await encryptCredential(JSON.stringify({provider:'outlook',staffId:'bs',externalAccountId:'provider-user',remoteId:'own',action:'delete'}),key));
 d.raw.prepare("INSERT INTO workflow_steps(scope_id,process_kind,subject_id,step_key,status,retry_key,input_json,created_at,updated_at) VALUES('line:a','booking_external_cleanup','job','current','pending',?,?,0,0)").run(index.index,encrypted);
 const fetcher=vi.fn(async(url:RequestInfo|URL)=>String(url).includes('login.microsoftonline.com')?new Response(JSON.stringify({access_token:'fixture-access',refresh_token:'fixture-refresh',expires_in:3600})):new Response(JSON.stringify({value:[{id:'own',showAs:'busy',isAllDay:false,start:{dateTime:'2026-12-01T03:00:00',timeZone:'UTC'},end:{dateTime:'2026-12-01T04:00:00',timeZone:'UTC'}}]})));
 vi.stubGlobal('fetch',fetcher);
 expect(await outlookBusyForStaff(env(),query)).toEqual([]);
});

it('定期処理は試験対象の担当者だけ予定を取得する',async()=>{
 const fetcher=vi.fn(async(url:RequestInfo|URL)=>String(url).includes('login.microsoftonline.com')?new Response(JSON.stringify({access_token:'fixture-access',refresh_token:'fixture-refresh',expires_in:3600})):new Response(JSON.stringify({value:[]})));vi.stubGlobal('fetch',fetcher);
 expect(await refreshOutlookBusyCaches(env(),new Date('2026-12-01T00:00:00Z'))).toBe(1);expect(fetcher).toHaveBeenCalledTimes(2);
});
it('試験対象外で予定を読めない場合は枠を閉じ、理由を一度知らせる',async()=>{
 d.raw.exec("UPDATE account_settings SET value='[]' WHERE key='test_recipients'");
 const credentials={outlookBusy:(input:typeof query)=>outlookBusyForStaff(env(),input)};
 await expect(readCalendarBusy(d.db,credentials,{...query,fresh:true})).rejects.toThrow();
 await expect(readCalendarBusy(d.db,credentials,{...query,fresh:true})).rejects.toThrow();
 expect(d.raw.prepare("SELECT error_code FROM booking_calendar_read_health WHERE line_account_id='a' AND staff_id='bs'").get()).toEqual({error_code:'outlook_test_staff_required'});
 expect(d.raw.prepare("SELECT COUNT(*) n FROM notifications WHERE event_type='booking_outlook_read_issue'").get()).toEqual({n:1});
});
