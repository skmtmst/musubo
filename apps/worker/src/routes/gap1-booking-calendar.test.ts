import {beforeEach,afterEach,expect,test,vi} from 'vitest';
import {bookingCalendarSettings} from './booking-calendar-settings.js';
import {gapFixture,gapApp,gapCall,gapOwner,seedGapBooking} from '../test-utils/gap1.js';
import type {SqliteD1} from '../test-utils/d1-sqlite.js';
import {readCalendarBusy,calendarDirectionEnabled,processCalendarSwitchJobs,refreshCalendarBusyCaches} from '../features/booking/booking-calendar-settings.js';
import {GoogleCalendarClient,GoogleCalendarReadError} from '../services/google-calendar.js';
import {syncConfirmedBookingToGoogle} from '../features/booking/booking-calendar-sync.js';
import {renderNotificationText} from '../features/booking/booking-notifier.js';
let d:SqliteD1;
const accountPath='/api/booking/admin/calendar-sync?account_id=a',staffPath='/api/booking/admin/staff/bs/calendar-sync?account_id=a';
const on={readEnabled:true,writeEnabled:true,expectedVersion:0};
const app=()=>gapApp(d,[bookingCalendarSettings]);
const timed=vi.spyOn(GoogleCalendarClient.prototype,'getTimedBusy');
const create=vi.spyOn(GoogleCalendarClient.prototype,'createEvent');
const del=vi.spyOn(GoogleCalendarClient.prototype,'deleteEvent');
function connect(){d.raw.exec("INSERT INTO google_calendar_connections(id,line_account_id,staff_id,calendar_id,auth_type,access_token,is_active) VALUES('gc','a','bs','cal','oauth','test-token',1)");}
async function enable(){await gapCall(app(),accountPath,'PUT',on);await gapCall(app(),staffPath,'PUT',on);}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-16T00:00:00Z'));d=gapFixture();timed.mockResolvedValue([]);create.mockImplementation(async e=>({eventId:e.id!}));del.mockResolvedValue(undefined);vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('unexpected_external_request');}));});
afterEach(()=>{d.raw.close();vi.useRealTimers();vi.clearAllMocks();vi.unstubAllGlobals();});
const request={lineAccountId:'a',staffId:'bs',timeMin:'2026-10-16T00:00:00Z',timeMax:'2026-10-17T00:00:00Z'};
test('後片づけ待ちの Google 予定は空き時間から除外する',async()=>{
 const {encryptCredential}=await import('@line-crm/db');
 const {cleanupIndex}=await import('../features/booking/booking-external-cleanup-proof.js');
 const {calendarCredentialsForEnv}=await import('../features/booking/booking-outlook-busy-runtime.js');
 connect();await enable();
 const key=btoa('k'.repeat(32));
 const index=await cleanupIndex(key,'a','google_calendar','bs');
 const payload=JSON.stringify(await encryptCredential(JSON.stringify({provider:'google_calendar',staffId:'bs',calendarId:'cal',connectionId:'gc',remoteId:'own',action:'delete'}),key));
 d.raw.prepare("INSERT INTO workflow_steps(scope_id,process_kind,subject_id,step_key,status,retry_key,input_json,created_at,updated_at) VALUES('line:a','booking_external_cleanup','cleanup','current','pending',?,?,0,0)").run(index.index,payload);
 timed.mockResolvedValue([{id:'own',start:'2026-10-16T01:00:00Z',end:'2026-10-16T02:00:00Z'},{id:'other',start:'2026-10-16T03:00:00Z',end:'2026-10-16T04:00:00Z'}]);
 const credentials=calendarCredentialsForEnv({DB:d.db,LINE_CREDENTIAL_ENCRYPTION_KEY:key} as any);
 expect(await readCalendarBusy(d.db,credentials,{...request,fresh:true})).toEqual([{start:'2026-10-16T03:00:00Z',end:'2026-10-16T04:00:00Z'}]);
});
test('B7-01 B7-43 B7-50: 初期オフ、両方がオンになるまで読み書きしない',async()=>{
 connect();expect((await (await gapCall(app(),accountPath)).json() as any).data).toMatchObject({readEnabled:false,writeEnabled:false});
 await gapCall(app(),staffPath,'PUT',on);expect(await readCalendarBusy(d.db,{},request)).toBeNull();expect(timed).not.toHaveBeenCalled();
 seedGapBooking(d);expect(await syncConfirmedBookingToGoogle(d.db,{},'bk')).toEqual({synced:false});expect(create).not.toHaveBeenCalled();
 await gapCall(app(),accountPath,'PUT',on);expect(await readCalendarBusy(d.db,{},request)).toEqual([]);expect(timed).toHaveBeenCalledTimes(1);
});
test('B7-02 B7-03 B7-04 B7-05 B7-16: 控え・5分読直し・確定直前のfresh・15分超のfail-closed',async()=>{
 connect();await enable();timed.mockResolvedValue([{id:'private',start:'2026-10-16T03:00:00Z',end:'2026-10-16T04:00:00Z'}]);
 expect(await readCalendarBusy(d.db,{},request)).toHaveLength(1);timed.mockResolvedValue([]);expect(await readCalendarBusy(d.db,{},request)).toHaveLength(1);
 expect(await readCalendarBusy(d.db,{},{...request,fresh:true})).toEqual([]);
 timed.mockRejectedValue(new GoogleCalendarReadError(503));await expect(readCalendarBusy(d.db,{},{...request,fresh:true})).rejects.toThrow();
 vi.advanceTimersByTime(16*60000);await expect(readCalendarBusy(d.db,{},request)).rejects.toThrow();
 expect(d.raw.prepare('SELECT error_code FROM booking_calendar_read_health').get()).toEqual({error_code:'calendar_unavailable'});
 timed.mockResolvedValue([]);await refreshCalendarBusyCaches(d.db,{},new Date());expect(d.raw.prepare('SELECT error_code FROM booking_calendar_read_health').get()).toEqual({error_code:null});
});
test('B7-07 B7-09 B7-13: 確定だけ書く・安定した予定ID・電話やメモや招待を外に出さない',async()=>{
 connect();await enable();seedGapBooking(d,'pending','requested');expect((await syncConfirmedBookingToGoogle(d.db,{},'pending')).synced).toBe(false);
 seedGapBooking(d);d.raw.exec("UPDATE bookings SET customer_note='秘密のメモ' WHERE id='bk'");
 await syncConfirmedBookingToGoogle(d.db,{},'bk');await syncConfirmedBookingToGoogle(d.db,{},'bk');expect(create).toHaveBeenCalledTimes(1);
 expect(create.mock.calls[0][0]).toMatchObject({summary:'相談｜お客さま'});expect(JSON.stringify(create.mock.calls[0][0])).not.toContain('秘密のメモ');expect(create.mock.calls[0][0]).not.toHaveProperty('attendees');
});
test('B7-14 B7-15: 権限切れは新しい控えでも閉じ、つなぎ直しで復旧する',async()=>{
 connect();await enable();await readCalendarBusy(d.db,{},request);timed.mockRejectedValue(new GoogleCalendarReadError(403));await expect(readCalendarBusy(d.db,{},{...request,fresh:true})).rejects.toThrow();
 await expect(readCalendarBusy(d.db,{},request)).rejects.toThrow();timed.mockResolvedValue([]);await readCalendarBusy(d.db,{},{...request,fresh:true});expect(await readCalendarBusy(d.db,{},request)).toEqual([]);
});
test('B7-24 B7-25 B7-27 B7-33: 担当優先の固定URLを写す、後で変えても既存予約は変えない',async()=>{
 d.raw.exec("UPDATE menus SET meeting_mode='online',fixed_meeting_url='https://example.test/menu' WHERE id='menu';UPDATE staff SET fixed_meeting_url='https://example.test/staff' WHERE id='bs'");seedGapBooking(d);
 expect(d.raw.prepare('SELECT meeting_url,meeting_url_source FROM bookings WHERE id=?').get('bk')).toEqual({meeting_url:'https://example.test/staff',meeting_url_source:'staff'});
 d.raw.exec("UPDATE staff SET fixed_meeting_url='https://example.test/new' WHERE id='bs'");expect((d.raw.prepare('SELECT meeting_url FROM bookings WHERE id=?').get('bk') as any).meeting_url).toBe('https://example.test/staff');
 expect((await gapCall(app(),'/api/booking/admin/bookings/bk/meeting?account_id=a','POST',{action:'refresh_fixed',expectedVersion:0})).status).toBe(200);
 expect((d.raw.prepare('SELECT meeting_url FROM bookings WHERE id=?').get('bk') as any).meeting_url).toBe('https://example.test/new');
 d.raw.exec("UPDATE staff SET fixed_meeting_url=NULL WHERE id='bs'");seedGapBooking(d,'menu-fallback');expect((d.raw.prepare('SELECT meeting_url FROM bookings WHERE id=?').get('menu-fallback') as any).meeting_url).toBe('https://example.test/menu');
 d.raw.exec("UPDATE bookings SET status='cancelled' WHERE id='bk'");expect((d.raw.prepare('SELECT meeting_url FROM bookings WHERE id=?').get('bk') as any).meeting_url).toBeNull();
});
test.each(['javascript:alert(1)','http://example.test','https://u:password@example.test','broken'])('B7-26: 安全でないURL %s を保存しない',async url=>{
 const row=d.raw.prepare('SELECT meeting_url_version FROM staff WHERE id=?').get('bs') as any;
 expect((await gapCall(app(),'/api/booking/admin/staff/bs/meeting-url?account_id=a','PUT',{url,expectedVersion:row.meeting_url_version})).status).toBe(400);
});
test('B7-45 B7-46 B7-54: オフの既定は予定を保持、明示した未来分だけ消し、オンに戻すと残りは止まる',async()=>{
 connect();await enable();seedGapBooking(d);d.raw.exec("UPDATE bookings SET external_event_id='event',external_calendar_id='cal' WHERE id='bk'");
 expect((await gapCall(app(),staffPath,'PUT',{readEnabled:false,writeEnabled:false,expectedVersion:1})).status).toBe(400);
 expect((await gapCall(app(),staffPath,'PUT',{readEnabled:false,writeEnabled:false,expectedVersion:1,confirmed:true})).status).toBe(200);expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_calendar_switch_jobs').get()).toEqual({n:0});
 await gapCall(app(),staffPath,'PUT',{...on,expectedVersion:2});await gapCall(app(),staffPath,'PUT',{readEnabled:false,writeEnabled:false,expectedVersion:3,confirmed:true,removeFutureEvents:true});
 expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_calendar_switch_jobs').get()).toEqual({n:1});
 await gapCall(app(),staffPath,'PUT',{...on,expectedVersion:4});await processCalendarSwitchJobs(d.db,{});expect(del).not.toHaveBeenCalled();
 await gapCall(app(),staffPath,'PUT',{readEnabled:false,writeEnabled:false,expectedVersion:5,confirmed:true,removeFutureEvents:true});await processCalendarSwitchJobs(d.db,{});expect(del).toHaveBeenCalledWith('event',expect.any(AbortSignal));expect((d.raw.prepare('SELECT status FROM bookings WHERE id=?').get('bk') as any).status).toBe('confirmed');
});
test('B7-47 B7-48 B7-49 B7-56 B7-57 B7-58: 自分だけの権限、読み書き独立、古い版と代理・閲覧を拒否',async()=>{
 connect();const self={...gapOwner,id:'s',role:'staff' as const,permissionKeys:['booking.staff.own']};
 expect((await gapCall(gapApp(d,[bookingCalendarSettings],self),staffPath,'PUT',{...on,writeEnabled:false})).status).toBe(200);
 await gapCall(app(),accountPath,'PUT',on);expect(await calendarDirectionEnabled(d.db,'a','bs','read')).toBe(true);expect(await calendarDirectionEnabled(d.db,'a','bs','write')).toBe(false);
 expect((await gapCall(gapApp(d,[bookingCalendarSettings],self),'/api/booking/admin/staff/bs2/calendar-sync?account_id=a','PUT',on)).status).toBe(403);
 for(const [who,im] of [[{...gapOwner,readOnly:true},false],[gapOwner,true]] as const)expect((await gapCall(gapApp(d,[bookingCalendarSettings],who,im),staffPath,'PUT',on)).status).toBe(403);
 expect((await gapCall(app(),staffPath,'PUT',on)).status).toBe(409);
});
test('B7-31 B7-33: 会議のURLが未発行でも空の案内を出さず、次の通知に保存したURLを使う',()=>{
 const ctx={menuName:'相談',staffName:'担当',startsAt:'2026-10-16 14:00',daysUntil:0,hoursUntil:1,meetingMode:'online'};
 expect(renderNotificationText('approved',ctx)).toContain('会議の URL は前日までにお送りします');
 expect(renderNotificationText('hours_before',{...ctx,meetingUrl:'https://example.test/latest'})).toContain('https://example.test/latest');
});
test('B7-43 B7-45: 予約機能を止めた店の定時読取と予定削除は実行しない',async()=>{
 connect();await enable();seedGapBooking(d);d.raw.exec("UPDATE bookings SET external_event_id='event',external_calendar_id='cal' WHERE id='bk'");
 await gapCall(app(),staffPath,'PUT',{readEnabled:false,writeEnabled:false,expectedVersion:1,confirmed:true,removeFutureEvents:true});
 d.raw.exec("INSERT INTO account_settings(id,line_account_id,key,value) VALUES('booking-off','a','feature.booking','false')");
 await refreshCalendarBusyCaches(d.db,{},new Date());await processCalendarSwitchJobs(d.db,{});
 expect(timed).not.toHaveBeenCalled();expect(del).not.toHaveBeenCalled();expect(d.raw.prepare("SELECT status FROM booking_calendar_switch_jobs").get()).toEqual({status:'pending'});
});
test('B7-06: Googleに予定の題名を要求せず、終日とfreeを塞がず時間だけ返す',async()=>{
 timed.mockRestore();
 const mock=vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({items:[
  {id:'private',start:{dateTime:'2026-10-16T03:00:00Z'},end:{dateTime:'2026-10-16T04:00:00Z'}},
  {id:'day',start:{date:'2026-10-16'},end:{date:'2026-10-17'}},
  {id:'free',transparency:'transparent',start:{dateTime:'2026-10-16T05:00:00Z'},end:{dateTime:'2026-10-16T06:00:00Z'}}
 ]})));
 const client=new GoogleCalendarClient({calendarId:'cal',accessToken:'test-token'});
 expect(await client.getTimedBusy(request.timeMin,request.timeMax)).toEqual([{id:'private',start:'2026-10-16T03:00:00Z',end:'2026-10-16T04:00:00Z'}]);
 const url=new URL(String(mock.mock.calls[0][0]));expect(url.searchParams.get('fields')).not.toMatch(/summary|description|attendee/);
});
test('メニューの会議発行方法は版を確認して保存する',async()=>{
 const path='/api/booking/admin/menus/menu/meeting-url?account_id=a';
 const before=await gapCall(app(),path);expect(before.status).toBe(200);
 const data=await before.json() as {data:{version:number;issuance:string}};
 expect(data.data.issuance).toBe('manual');
 expect((await gapCall(app(),path,'PUT',{url:null,issuance:'automatic',expectedVersion:data.data.version})).status).toBe(200);
 expect(await (await gapCall(app(),path)).json()).toMatchObject({data:{issuance:'automatic'}});
 expect((await gapCall(app(),path,'PUT',{url:null,issuance:'manual',expectedVersion:data.data.version})).status).toBe(409);
 expect(await (await gapCall(app(),path)).json()).toMatchObject({data:{issuance:'automatic'}});
});
test('相手先で削除した会議だけを確認の上で対応済みにする',async()=>{
 seedGapBooking(d);
 d.raw.exec("INSERT INTO booking_meeting_links(id,booking_id,provider,status,idempotency_key,last_error_code,created_at,updated_at) VALUES('old','bk','zoom','cancel_pending','old-key','manual_review','2026-01-01','2026-01-01')");
 const list='/api/booking/admin/bookings/bk/meeting-links?account_id=a';
 expect(await (await gapCall(app(),list)).json()).toMatchObject({data:{items:[{id:'old',provider:'zoom'}]}});
 expect((await gapCall(app(),list.replace('account_id=a','account_id=b'))).status).toBe(404);
 const path='/api/booking/admin/bookings/bk/meeting-links/old/resolve?account_id=a';
 expect((await gapCall(app(),path,'POST',{})).status).toBe(400);
 expect((await gapCall(app(),path,'POST',{confirmed:true})).status).toBe(200);
 expect(d.raw.prepare("SELECT status,last_error_code FROM booking_meeting_links WHERE id='old'").get()).toEqual({status:'cancelled',last_error_code:'manual_resolved'});
 expect(await (await gapCall(app(),list)).json()).toMatchObject({data:{items:[]}});
 expect((await gapCall(app(),path,'POST',{confirmed:true})).status).toBe(404);
});
test('Outlook の予定が読めないときは空き枠を閉じる',async()=>{
 seedGapBooking(d);d.raw.exec("UPDATE staff_members SET line_user_id='Uf2' WHERE id='s'; INSERT INTO account_settings(id,line_account_id,key,value) VALUES('test-staff','a','test_recipients','[\"f2\"]')");
 d.raw.exec("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES('outlook','a','bs','outlook','encrypted','o','2026-01-01','2026-01-01')");
 expect((await gapCall(app(),staffPath,'PUT',{readEnabled:true,writeEnabled:true,expectedVersion:0})).status).toBe(200);
 await gapCall(app(),accountPath,'PUT',{readEnabled:true,writeEnabled:true,expectedVersion:0});
 await expect(readCalendarBusy(d.db,{},request)).rejects.toThrow();
 expect(await syncConfirmedBookingToGoogle(d.db,{},'bk')).toEqual({synced:false});expect(create).not.toHaveBeenCalled();
});
test('Outlook の一括書き込みと予定の削除は明示設定を待ち、スイッチの版を守る',async()=>{
 const {outlookCalendar}=await import('../features/booking/booking-outlook-calendar.js');
 const {syncOutlookBooking}=await import('../features/booking/booking-outlook-sync.js');
 const {calendarSwitch}=await import('../features/booking/calendar-switch-state.js');
 seedGapBooking(d);
 d.raw.exec("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES('outlook','a','bs','outlook','encrypted','o','2026-01-01','2026-01-01')");
 expect((await gapCall(app(),accountPath,'PUT',{readEnabled:false,writeEnabled:true,expectedVersion:0})).status).toBe(200);
 expect((await gapCall(app(),staffPath,'PUT',{readEnabled:false,writeEnabled:true,includeBacklog:true,expectedVersion:0})).status).toBe(200);
 const fetcher=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{
  if(init?.method==='POST')return new Response(JSON.stringify({id:'event'}),{status:201});
  if(init?.method==='DELETE')return new Response(null,{status:204});
  return new Response(JSON.stringify({id:'event',isOrganizer:true,attendees:[],'@odata.etag':'"v1"'}));
 });
 const calendar={...outlookCalendar(async()=>({token:'fixture',accountId:'owner'}),fetcher as typeof fetch,{allowMutations:true}),accountId:'owner'};
 const sync=async(bookingId:string,options?:{removeOnly?:boolean;switchScope?:string;switchVersion?:number})=>syncOutlookBooking(d.db,{accountId:'a',bookingId},{
  resolve:async()=>calendar,allowMutations:true,removeOnly:options?.removeOnly,
  authorizeRemoval:options?.removeOnly?async()=>{const current=await calendarSwitch(d.db,'a',options.switchScope);return !current.writeEnabled&&current.version===options.switchVersion;}:undefined,
 });
 await processCalendarSwitchJobs(d.db,{},new Date(),{allowMutations:true,sync});
 expect(fetcher.mock.calls.filter(call=>call[1]?.method==='POST')).toHaveLength(1);
 const post=fetcher.mock.calls.find(call=>call[1]?.method==='POST');expect(JSON.parse(String(post?.[1]?.body))).not.toHaveProperty('attendees');
 expect((await gapCall(app(),staffPath,'PUT',{readEnabled:false,writeEnabled:false,removeFutureEvents:true,confirmed:true,expectedVersion:1})).status).toBe(200);
 await processCalendarSwitchJobs(d.db,{},new Date(),{allowMutations:false,sync});
 expect(fetcher.mock.calls.some(call=>call[1]?.method==='DELETE')).toBe(false);
 await processCalendarSwitchJobs(d.db,{},new Date(),{allowMutations:true,sync});
 expect(fetcher.mock.calls.filter(call=>call[1]?.method==='DELETE')).toHaveLength(1);
});
test('Outlook の取消が設定待ちで50件あっても Google の処理は進む',async()=>{
 connect();seedGapBooking(d);await enable();
 const stmt=d.raw.prepare("INSERT INTO booking_calendar_switch_jobs(id,line_account_id,staff_id,booking_id,action,switch_scope,switch_version,created_at) VALUES(?,'a','bs','bk','delete','outlook:bs',?,'2020-01-01')");
 for(let i=1;i<=50;i++)stmt.run(`outlook-wait-${i}`,i);
 d.raw.exec("INSERT INTO booking_calendar_switch_jobs(id,line_account_id,staff_id,booking_id,action,switch_scope,switch_version,created_at) VALUES('google-later','a','bs','bk','write','bs',1,'2026-01-01')");
 await processCalendarSwitchJobs(d.db,{},new Date(),{allowMutations:false,sync:async()=>{throw new Error('must_not_run')}});
 expect(d.raw.prepare("SELECT status FROM booking_calendar_switch_jobs WHERE id='google-later'").get()).toEqual({status:'done'});
});
test('削除を繰り返し処理できない場合は運用者に知らせる',async()=>{
 seedGapBooking(d);
 d.raw.exec(`INSERT INTO booking_calendar_switches(line_account_id,scope_id,write_enabled,updated_by,updated_at) VALUES('a','bs',0,'o','2026-01-01');
 INSERT INTO workflow_steps(scope_id,process_kind,subject_id,step_key,status,retry_key,result_json,created_at,updated_at) VALUES('line:a','booking_outlook_sync','bk','current','succeeded','x','{"eventId":"event","accountId":"owner","staffId":"bs","startsAt":"2026-11-20T05:00:00Z","endsAt":"2026-11-20T06:00:00Z"}',0,0);
 INSERT INTO booking_calendar_switch_jobs(id,line_account_id,staff_id,booking_id,action,switch_scope,switch_version,created_at) VALUES('outlook-job','a','bs','bk','delete','outlook:bs',1,'2020-01-01')`);
 for(let i=0;i<3;i++)await processCalendarSwitchJobs(d.db,{},new Date(),{allowMutations:true,sync:async()=> 'skipped'});
 expect(d.raw.prepare("SELECT attempts,status FROM booking_calendar_switch_jobs WHERE id='outlook-job'").get()).toEqual({attempts:3,status:'failed'});
 expect(d.raw.prepare("SELECT COUNT(*) n FROM notifications WHERE event_type='booking_outlook_issue'").get()).toEqual({n:1});
});
test('Google と Outlook の予定を両方除き、確定時に Outlook を読み直す',async()=>{
 d.raw.exec("UPDATE staff_members SET line_user_id='Uf2' WHERE id='s'; INSERT INTO account_settings(id,line_account_id,key,value) VALUES('test-staff','a','test_recipients','[\"f2\"]')");
 connect();
 d.raw.exec("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES('outlook','a','bs','outlook','encrypted','o','2026-01-01','2026-01-01')");
 await enable();
 const google=vi.spyOn(GoogleCalendarClient.prototype,'getTimedBusy').mockResolvedValue([{id:'g-event',start:'2026-10-16T01:00:00Z',end:'2026-10-16T02:00:00Z'}]);
 const outlook=vi.fn(async()=>[{start:'2026-10-16T03:00:00Z',end:'2026-10-16T04:00:00Z'}]);
 const result=await readCalendarBusy(d.db,{outlookBusy:outlook},{...request,fresh:true});
 expect(result).toEqual([{start:'2026-10-16T01:00:00Z',end:'2026-10-16T02:00:00Z'},{start:'2026-10-16T03:00:00Z',end:'2026-10-16T04:00:00Z'}]);
 await readCalendarBusy(d.db,{outlookBusy:outlook},{...request,fresh:true});expect(outlook).toHaveBeenCalledTimes(2);
 await expect(readCalendarBusy(d.db,{outlookBusy:async()=>{throw new Error('offline')}},{...request,fresh:true})).rejects.toThrow();
 google.mockRestore();
});

test('試験対象外の担当者は Outlook 読み込みをオンにできない',async()=>{
 d.raw.exec("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES('outlook','a','bs','outlook','encrypted','o','2026-01-01','2026-01-01')");
 const response=await gapCall(app(),staffPath,'PUT',{readEnabled:true,writeEnabled:false,expectedVersion:0});
 expect(response.status).toBe(409);expect(await response.json()).toMatchObject({error:'outlook_test_staff_required'});
});
