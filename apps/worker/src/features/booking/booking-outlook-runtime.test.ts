import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {Env} from '../../worker-env.js';
import {gapFixture,seedGapBooking} from '../../test-utils/gap1.js';
import {beginMeetingAuthorization,consumeMeetingAuthorization} from './booking-meeting-oauth-state.js';
import {deleteMeetingCredential,finishAuthorizedMeetingConnection} from './booking-meeting-credentials.js';
import {outlookCalendarForBooking} from './booking-outlook-runtime.js';
let d:ReturnType<typeof gapFixture>;const key=btoa('x'.repeat(32));
function env(extra:Partial<Env['Bindings']>={}):Env['Bindings']{return {DB:d.db,WORKER_URL:'https://worker.example.test',DEPLOY_ENV:'staging',LINE_CREDENTIAL_ENCRYPTION_KEY:key,BOOKING_MEETING_OAUTH_ENABLED:'true',BOOKING_MEETING_REAL_ENABLED:'true',BOOKING_MEETING_OAUTH_CONFIG:JSON.stringify({outlook:{clientId:'fixture-client',clientSecret:'fixture-secret'}}),...extra} as Env['Bindings'];}
beforeEach(async()=>{
 d=gapFixture();seedGapBooking(d);d.raw.exec("INSERT INTO account_settings(id,line_account_id,key,value) VALUES('test','a','test_recipients','[\"f\"]')");
 const state=await beginMeetingAuthorization(d.db,{accountId:'a',staffId:'bs',actorId:'o',provider:'outlook',verifier:'fixture',encryptionKey:key});
 await consumeMeetingAuthorization(d.db,{accountId:'a',state,actorId:'o',encryptionKey:key});
 expect(await finishAuthorizedMeetingConnection(d.db,{accountId:'a',staffId:'bs',actorId:'o',provider:'outlook',state,encryptionKey:key,credential:{provider:'outlook',externalAccountId:'provider-user',refreshToken:'fixture-refresh'}})).toBe(true);
});
afterEach(()=>{d.raw.close();vi.unstubAllGlobals()});
it('許可のない環境・試験宛先以外は Outlook に通信しない',async()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 expect(await outlookCalendarForBooking(env({BOOKING_MEETING_REAL_ENABLED:undefined}),{accountId:'a',bookingId:'bk',staffId:'bs'})).toBeNull();
 d.raw.exec("UPDATE account_settings SET value='[]' WHERE key='test_recipients'");
 expect(await outlookCalendarForBooking(env(),{accountId:'a',bookingId:'bk',staffId:'bs'})).toBeNull();expect(fetcher).not.toHaveBeenCalled();
});
it('切断した接続では、保持した鍵で Outlook に書き込まない',async()=>{
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({access_token:'fixture-access',refresh_token:'fixture-rotated',expires_in:3600})));vi.stubGlobal('fetch',fetcher);
 const calendar=await outlookCalendarForBooking(env(),{accountId:'a',bookingId:'bk',staffId:'bs'});expect(calendar).not.toBeNull();expect(fetcher).toHaveBeenCalledOnce();
 await deleteMeetingCredential(d.db,{accountId:'a',staffId:'bs',provider:'outlook'});
 expect(await calendar!.create({staffId:'bs',calendarId:'c',start:'2026-12-01T00:00:00Z',end:'2026-12-01T01:00:00Z',title:'予約',description:'',transactionId:'id',signal:new AbortController().signal})).toEqual({kind:'failed'});
 expect(fetcher).toHaveBeenCalledOnce();
});
it('予約と違う担当者の鍵は読み出さない',async()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 expect(await outlookCalendarForBooking(env(),{accountId:'a',bookingId:'bk',staffId:'bs2'})).toBeNull();
 expect(fetcher).not.toHaveBeenCalled();
});
it('検証用の予約だけ予定を作り、取消は別の明示設定がある場合だけ行う',async()=>{
 const {syncOutlookBookingForEnv,recoverOutlookBookings}=await import('./booking-outlook-sync-runtime.js');
 d.raw.exec("INSERT INTO booking_calendar_switches(line_account_id,scope_id,write_enabled,updated_by,updated_at) VALUES('a','',1,'o','2026-01-01'),('a','bs',1,'o','2026-01-01')");
 const fetcher=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
  if(String(url).includes('login.microsoftonline.com'))return new Response(JSON.stringify({access_token:'fixture-access',refresh_token:'fixture-refresh',expires_in:3600}));
  if(init?.method==='POST')return new Response(JSON.stringify({id:'event'}),{status:201});
  if(init?.method==='DELETE')return new Response(null,{status:204});
  return new Response(JSON.stringify({id:'event',attendees:[],isOrganizer:true,'@odata.etag':'"v1"'}));
 });vi.stubGlobal('fetch',fetcher);
 expect(await syncOutlookBookingForEnv(env(),'bk')).toBe('done');
 const create=fetcher.mock.calls.find(call=>call[1]?.method==='POST'&&String(call[0]).includes('graph.microsoft.com'));
 expect(create).toBeDefined();expect(JSON.parse(String(create?.[1]?.body))).not.toHaveProperty('attendees');
 d.raw.exec("UPDATE bookings SET status='cancelled',lock_version=lock_version+1 WHERE id='bk'");
 expect(await syncOutlookBookingForEnv(env(),'bk')).toBe('skipped');
 expect(fetcher.mock.calls.some(call=>call[1]?.method==='DELETE')).toBe(false);
 d.raw.exec("UPDATE workflow_steps SET updated_at=0 WHERE process_kind='booking_outlook_sync'");
 expect(await recoverOutlookBookings(env(),new Date())).toBe(0);
 expect(await recoverOutlookBookings(env({BOOKING_OUTLOOK_MUTATIONS_ENABLED:'true'}),new Date())).toBe(1);
 expect(fetcher.mock.calls.filter(call=>call[1]?.method==='DELETE')).toHaveLength(1);
});
