import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {queueDeletedMeetingConnections} from '@line-crm/db';
import {gapFixture} from '../../test-utils/gap1.js';
let d:ReturnType<typeof gapFixture>;
beforeEach(()=>{d=gapFixture()});afterEach(()=>{vi.unstubAllGlobals();d.raw.close();});
it('担当者の削除と同じ取引で暗号文を台帳へ移し、失敗時は両方戻す',async()=>{
 d.raw.exec("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES('one','a','bs','zoom','encrypted','o','2026-01-01','2026-01-01')");
 const queue=()=>queueDeletedMeetingConnections(d.db,{whereSql:'c.line_account_id=? AND c.staff_id=?',params:['a','bs'],source:'staff'});
 await expect(d.db.batch([queue(),d.db.prepare("UPDATE staff SET deleted_at='now' WHERE id='bs'"),d.db.prepare('INSERT INTO no_such_table VALUES(1)')])).rejects.toThrow();
 expect(d.raw.prepare("SELECT COUNT(*) n FROM workflow_steps WHERE process_kind='booking_meeting_deleted_revoke'").get()).toEqual({n:0});
 expect(d.raw.prepare("SELECT COUNT(*) n FROM booking_meeting_connections WHERE id='one'").get()).toEqual({n:1});
 await d.db.batch([queue(),d.db.prepare("UPDATE staff SET deleted_at='now' WHERE id='bs'")]);
 const row=d.raw.prepare("SELECT scope_id,input_json FROM workflow_steps WHERE process_kind='booking_meeting_deleted_revoke'").get() as {scope_id:string;input_json:string};
 expect(row.scope_id).toBe('global:meeting-revoke-queue');expect(JSON.parse(row.input_json)).toMatchObject({provider:'zoom',credentialEnc:'encrypted',accountId:'a',staffId:'bs'});
 expect(d.raw.prepare("SELECT COUNT(*) n FROM booking_meeting_connections WHERE id='one'").get()).toEqual({n:0});
});
it('更新中や Microsoft の接続は秘密を台帳へ移さず手動確認にする',async()=>{
 d.raw.exec("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at,refresh_state,refresh_claim) VALUES('one','a','bs','zoom','secret','o','2026-01-01','2026-01-01','refreshing','claim'),('two','a','bs','teams','secret2','o','2026-01-01','2026-01-01','ready',NULL)");
 await d.db.batch([queueDeletedMeetingConnections(d.db,{whereSql:'c.line_account_id=? AND c.staff_id=?',params:['a','bs'],source:'staff'}),d.db.prepare("UPDATE staff SET deleted_at='now' WHERE id='bs'")]);
 const rows=d.raw.prepare("SELECT input_json FROM workflow_steps WHERE process_kind='booking_meeting_deleted_revoke'").all() as {input_json:string}[];
 expect(rows).toHaveLength(2);for(const row of rows)expect(JSON.parse(row.input_json)).toMatchObject({credentialEnc:null,needsManual:1});
});
it('アカウントのアーカイブ確定と同時に接続を台帳へ移す',async()=>{
 const {archiveLineAccount}=await import('@line-crm/db');
 d.raw.exec("UPDATE line_accounts SET is_active=0,is_default=0 WHERE id='a'; INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES('one','a','bs','zoom','encrypted','o','2026-01-01','2026-01-01'); INSERT INTO google_calendar_connections(id,calendar_id,line_account_id,staff_id,auth_type,is_active,access_token) VALUES('cal','fixture','a','bs','service_account',1,'secret')");
 expect(await archiveLineAccount(d.db,'a','o','fixture')).toBeTruthy();
 expect(d.raw.prepare("SELECT COUNT(*) n FROM booking_meeting_connections WHERE id='one'").get()).toEqual({n:0});
 const row=d.raw.prepare("SELECT input_json FROM workflow_steps WHERE process_kind='booking_meeting_deleted_revoke' AND subject_id='one'").get() as {input_json:string};expect(JSON.parse(row.input_json)).toMatchObject({source:'account',credentialEnc:'encrypted'});
 expect(d.raw.prepare("SELECT is_active,access_token FROM google_calendar_connections WHERE id='cal'").get()).toEqual({is_active:0,access_token:null});
 const calendar=d.raw.prepare("SELECT input_json FROM workflow_steps WHERE subject_id LIKE 'calendar:cal:%'").get() as {input_json:string};expect(JSON.parse(calendar.input_json)).toMatchObject({provider:'google_calendar',authType:'service_account',credentialEnc:null});
});
it('確定後の台帳だけを処理し、最後の Zoom 接続を解除したら暗号文を消す',async()=>{
 const {encryptCredential}=await import('@line-crm/db');const {processDeletedMeetingRevocations}=await import('./booking-meeting-deletion-runner.js');
 const key=btoa('x'.repeat(32)),cipher=await encryptCredential(JSON.stringify({provider:'zoom',externalAccountId:'person',refreshToken:'refresh',accessToken:'access'}),key);
 d.raw.prepare("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES('one','a','bs','zoom',?,'o','2026-01-01','2026-01-01')").run(cipher);
 const fetcher=vi.fn(async()=>new Response('',{status:200}));vi.stubGlobal('fetch',fetcher);
 const env={DB:d.db,DEPLOY_ENV:'staging',WORKER_URL:'https://worker.example.test',LINE_CREDENTIAL_ENCRYPTION_KEY:key,BOOKING_MEETING_OAUTH_ENABLED:'true',BOOKING_MEETING_OAUTH_CONFIG:JSON.stringify({zoom:{clientId:'client',clientSecret:'secret'}})} as never;
 await d.db.batch([queueDeletedMeetingConnections(d.db,{whereSql:'c.line_account_id=? AND c.staff_id=?',params:['a','bs'],source:'staff'}),d.db.prepare("UPDATE staff SET deleted_at='now' WHERE id='bs'")]);
 expect(fetcher).not.toHaveBeenCalled();expect(await processDeletedMeetingRevocations(env)).toBe(1);expect(fetcher).toHaveBeenCalledOnce();
 expect(d.raw.prepare("SELECT status,input_json FROM workflow_steps WHERE process_kind='booking_meeting_deleted_revoke'").get()).toEqual({status:'succeeded',input_json:null});vi.unstubAllGlobals();
});
it('外部解除が失敗しても暗号文を消し要確認の監査と知らせを残す',async()=>{
 const {encryptCredential}=await import('@line-crm/db');const {processDeletedMeetingRevocations}=await import('./booking-meeting-deletion-runner.js');
 const key=btoa('x'.repeat(32)),cipher=await encryptCredential(JSON.stringify({provider:'zoom',externalAccountId:'person',refreshToken:'refresh',accessToken:'access'}),key);
 d.raw.prepare("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES('one','a','bs','zoom',?,'o','2026-01-01','2026-01-01')").run(cipher);
 await d.db.batch([queueDeletedMeetingConnections(d.db,{whereSql:'c.line_account_id=? AND c.staff_id=?',params:['a','bs'],source:'staff'}),d.db.prepare("UPDATE staff SET deleted_at='now' WHERE id='bs'")]);
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status:500})));
 await processDeletedMeetingRevocations({DB:d.db,DEPLOY_ENV:'staging',WORKER_URL:'https://worker.example.test',LINE_CREDENTIAL_ENCRYPTION_KEY:key,BOOKING_MEETING_OAUTH_ENABLED:'true',BOOKING_MEETING_OAUTH_CONFIG:JSON.stringify({zoom:{clientId:'client',clientSecret:'secret'}})} as never);
 expect(d.raw.prepare("SELECT status,input_json FROM workflow_steps WHERE process_kind='booking_meeting_deleted_revoke'").get()).toEqual({status:'unknown',input_json:null});
 expect(d.raw.prepare("SELECT COUNT(*) n FROM notifications WHERE event_type='booking_meeting_disconnect_review' AND category='error'").get()).toEqual({n:1});
 expect(d.raw.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='booking.meeting.deleted_connection_review' AND result='failed'").get()).toEqual({n:1});vi.unstubAllGlobals();
});
it('統括 purge が完了するまでは取り消しを送らない',async()=>{
 const {encryptCredential}=await import('@line-crm/db');const {processDeletedMeetingRevocations}=await import('./booking-meeting-deletion-runner.js');
 const key=btoa('x'.repeat(32)),cipher=await encryptCredential(JSON.stringify({provider:'zoom',externalAccountId:'person',refreshToken:'refresh',accessToken:'access'}),key);
 d.raw.prepare("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES('one','a','bs','zoom',?,'o','2026-01-01','2026-01-01')").run(cipher);
 await d.db.batch([queueDeletedMeetingConnections(d.db,{whereSql:'c.line_account_id=?',params:['a'],source:'tenant'}),d.db.prepare("DELETE FROM booking_meeting_connections WHERE id='one'")]);
 const fetcher=vi.fn(async()=>new Response('',{status:200}));vi.stubGlobal('fetch',fetcher);const env={DB:d.db,DEPLOY_ENV:'staging',WORKER_URL:'https://worker.example.test',LINE_CREDENTIAL_ENCRYPTION_KEY:key,BOOKING_MEETING_OAUTH_ENABLED:'true',BOOKING_MEETING_OAUTH_CONFIG:JSON.stringify({zoom:{clientId:'client',clientSecret:'secret'}})} as never;
 expect(await processDeletedMeetingRevocations(env)).toBe(0);expect(fetcher).not.toHaveBeenCalled();
 d.raw.exec("UPDATE tenants SET data_purged_at='2026-11-22' WHERE id='t'");expect(await processDeletedMeetingRevocations(env)).toBe(1);expect(fetcher).toHaveBeenCalledOnce();vi.unstubAllGlobals();
});
it('同じ Zoom の削除が2件待っていても最後の1件だけ外部解除する',async()=>{
 const {encryptCredential}=await import('@line-crm/db');const {processDeletedMeetingRevocations}=await import('./booking-meeting-deletion-runner.js');const key=btoa('x'.repeat(32));
 for(const [id,staff] of [['one','bs'],['two','bs2']]){const cipher=await encryptCredential(JSON.stringify({provider:'zoom',externalAccountId:'same',refreshToken:'refresh',accessToken:`access-${id}`}),key);d.raw.prepare("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES(?,'a',?,'zoom',?,'o','2026-01-01','2026-01-01')").run(id,staff,cipher);}
 await d.db.batch([queueDeletedMeetingConnections(d.db,{whereSql:'c.line_account_id=?',params:['a'],source:'account'}),d.db.prepare("DELETE FROM booking_meeting_connections WHERE line_account_id='a'")]);
 const fetcher=vi.fn(async()=>new Response('',{status:200}));vi.stubGlobal('fetch',fetcher);const env={DB:d.db,DEPLOY_ENV:'staging',WORKER_URL:'https://worker.example.test',LINE_CREDENTIAL_ENCRYPTION_KEY:key,BOOKING_MEETING_OAUTH_ENABLED:'true',BOOKING_MEETING_OAUTH_CONFIG:JSON.stringify({zoom:{clientId:'client',clientSecret:'secret'}})} as never;
 expect(await processDeletedMeetingRevocations(env)).toBe(2);expect(fetcher).toHaveBeenCalledOnce();
 expect(d.raw.prepare("SELECT status,input_json FROM workflow_steps WHERE process_kind='booking_meeting_deleted_revoke' ORDER BY status").all()).toEqual([{status:'canceled',input_json:null},{status:'succeeded',input_json:null}]);
});
it('Microsoft は鍵を保管せず、外部へ送らず手動解除を知らせる',async()=>{
 const {processDeletedMeetingRevocations}=await import('./booking-meeting-deletion-runner.js');
 d.raw.exec("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES('one','a','bs','outlook','secret','o','2026-01-01','2026-01-01')");
 await d.db.batch([queueDeletedMeetingConnections(d.db,{whereSql:'c.line_account_id=?',params:['a'],source:'staff'}),d.db.prepare("UPDATE staff SET deleted_at='now' WHERE id='bs'")]);
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);await processDeletedMeetingRevocations({DB:d.db} as never);expect(fetcher).not.toHaveBeenCalled();
 expect(d.raw.prepare("SELECT status,input_json FROM workflow_steps WHERE process_kind='booking_meeting_deleted_revoke'").get()).toEqual({status:'unknown',input_json:null});
 expect(d.raw.prepare("SELECT body FROM notifications WHERE category='error' AND event_type='booking_meeting_disconnect_review'").get()).toMatchObject({body:expect.stringContaining('他の接続への影響を先に確認')});
});
it('中断して期限切れの外部解除は再送せず鍵を消して確認を残す',async()=>{
 const {processDeletedMeetingRevocations}=await import('./booking-meeting-deletion-runner.js');
 d.raw.exec("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES('one','a','bs','zoom','encrypted','o','2026-01-01','2026-01-01')");
 await d.db.batch([queueDeletedMeetingConnections(d.db,{whereSql:'c.line_account_id=?',params:['a'],source:'staff'}),d.db.prepare("UPDATE staff SET deleted_at='now' WHERE id='bs'")]);
 d.raw.exec("UPDATE workflow_steps SET status='running',lease_owner='old',lease_expires_at=1 WHERE process_kind='booking_meeting_deleted_revoke'");const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 await processDeletedMeetingRevocations({DB:d.db} as never);expect(fetcher).not.toHaveBeenCalled();
 expect(d.raw.prepare("SELECT status,input_json,error_code FROM workflow_steps WHERE process_kind='booking_meeting_deleted_revoke'").get()).toEqual({status:'unknown',input_json:null,error_code:'interrupted'});
});
it('本人を確認できない Google カレンダーは鍵を消して手動確認し、Google の自動解除を止める',async()=>{
 const {queueDeletedGoogleCalendars,encryptCredential}=await import('@line-crm/db');const {processDeletedMeetingRevocations}=await import('./booking-meeting-deletion-runner.js');const {meetingRevokeDecision}=await import('./booking-meeting-revoke-decision.js');
 const key=btoa('x'.repeat(32)),cipher=await encryptCredential(JSON.stringify({provider:'google_meet',externalAccountId:'person',refreshToken:'refresh'}),key);
 d.raw.prepare("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES('meeting','a','bs2','google_meet',?,'o','2026-01-01','2026-01-01')").run(cipher);
 d.raw.exec("INSERT INTO google_calendar_connections(id,calendar_id,line_account_id,staff_id,auth_type,is_active,access_token,refresh_token) VALUES('cal','calendar','a','bs','oauth',1,'secret','secret2')");
 await d.db.batch([queueDeletedGoogleCalendars(d.db,{whereSql:'c.line_account_id=? AND c.staff_id=?',params:['a','bs'],source:'staff'}),d.db.prepare("UPDATE google_calendar_connections SET is_active=0,access_token=NULL,refresh_token=NULL,api_key=NULL WHERE id='cal'"),d.db.prepare("UPDATE staff SET deleted_at='now' WHERE id='bs'")]);
 expect(d.raw.prepare("SELECT is_active,access_token,refresh_token FROM google_calendar_connections WHERE id='cal'").get()).toEqual({is_active:0,access_token:null,refresh_token:null});
 const env={DB:d.db,DEPLOY_ENV:'staging',WORKER_URL:'https://worker.example.test',LINE_CREDENTIAL_ENCRYPTION_KEY:key,BOOKING_MEETING_OAUTH_ENABLED:'true',BOOKING_MEETING_OAUTH_CONFIG:JSON.stringify({google_meet:{clientId:'client',clientSecret:'secret'}})} as never;
 const item={accountId:'a',staffId:'bs2',provider:'google_meet' as const,connectionId:'meeting',credentialEnc:cipher};
 expect((await meetingRevokeDecision(env,item)).decision).toBe('review');await processDeletedMeetingRevocations(env);expect((await meetingRevokeDecision(env,item)).decision).toBe('review');
 expect(d.raw.prepare("SELECT status,input_json FROM workflow_steps WHERE subject_id LIKE 'calendar:cal:%'").get()).toEqual({status:'unknown',input_json:null});
});
it('purge 未完了の台帳が先頭にあっても他の担当の外部解除を妨げず、24時間後も purge 完了前には送らない',async()=>{
 const {encryptCredential}=await import('@line-crm/db');const {processDeletedMeetingRevocations}=await import('./booking-meeting-deletion-runner.js');const key=btoa('x'.repeat(32)),now=Date.now();
 for(const [id,staff,provider] of [['pending','bs','google_meet'],['ready','bs2','zoom']] as const){const cipher=await encryptCredential(JSON.stringify({provider,externalAccountId:id,refreshToken:'refresh',accessToken:'access'}),key);d.raw.prepare("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES(?,'a',?,?,?,'o','2026-01-01','2026-01-01')").run(id,staff,provider,cipher);}
 await d.db.batch([queueDeletedMeetingConnections(d.db,{whereSql:"c.id='pending'",params:[],source:'tenant',now:now-2*86400000}),queueDeletedMeetingConnections(d.db,{whereSql:"c.id='ready'",params:[],source:'staff',now}),d.db.prepare("DELETE FROM booking_meeting_connections WHERE id IN ('pending','ready')")]);
 const fetcher=vi.fn(async()=>new Response('',{status:200}));vi.stubGlobal('fetch',fetcher);const env={DB:d.db,DEPLOY_ENV:'staging',WORKER_URL:'https://worker.example.test',LINE_CREDENTIAL_ENCRYPTION_KEY:key,BOOKING_MEETING_OAUTH_ENABLED:'true',BOOKING_MEETING_OAUTH_CONFIG:JSON.stringify({zoom:{clientId:'client',clientSecret:'secret'},google_meet:{clientId:'client',clientSecret:'secret'}})} as never;
 expect(await processDeletedMeetingRevocations(env,{now,limit:1})).toBe(1);expect(fetcher).toHaveBeenCalledOnce();
 expect(d.raw.prepare("SELECT status FROM workflow_steps WHERE subject_id='pending'").get()).toEqual({status:'pending'});
 d.raw.prepare("UPDATE tenants SET data_purged_at=? WHERE id='t'").run(new Date(now).toISOString());expect(await processDeletedMeetingRevocations(env,{now,limit:1})).toBe(1);expect(fetcher).toHaveBeenCalledTimes(2);
});
it('担当者削除 API は DB の確定時に会議とカレンダーを台帳へ移し、別の担当を守る',async()=>{
 const {Hono}=await import('hono');const {registerStaff}=await import('../../routes/booking/register-staff.js');const {gapApp,gapCall}=await import('../../test-utils/gap1.js');
 const booking=new Hono<import('../../worker-env.js').Env>();registerStaff(booking);
 d.raw.exec("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES('one','a','bs','zoom','encrypted','o','2026-01-01','2026-01-01'),('other','a','bs2','zoom','encrypted2','o','2026-01-01','2026-01-01'); INSERT INTO google_calendar_connections(id,calendar_id,line_account_id,staff_id,auth_type,is_active,access_token) VALUES('cal','calendar','a','bs','oauth',1,'secret')");
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);expect((await gapCall(gapApp(d,[booking]),'/api/booking/admin/staff/bs?account_id=a','DELETE')).status).toBe(200);expect(fetcher).not.toHaveBeenCalled();
 expect(d.raw.prepare("SELECT id FROM booking_meeting_connections ORDER BY id").all()).toEqual([{id:'other'}]);
 expect(d.raw.prepare("SELECT is_active,access_token FROM google_calendar_connections WHERE id='cal'").get()).toEqual({is_active:0,access_token:null});
 expect(d.raw.prepare("SELECT COUNT(*) n FROM workflow_steps WHERE process_kind='booking_meeting_deleted_revoke'").get()).toEqual({n:2});
});
it('サービスアカウントのカレンダーは別の OAuth 許可なので Google の解除を妨げない',async()=>{
 const {queueDeletedGoogleCalendars,encryptCredential}=await import('@line-crm/db');const {processDeletedMeetingRevocations}=await import('./booking-meeting-deletion-runner.js');const {meetingRevokeDecision}=await import('./booking-meeting-revoke-decision.js');const key=btoa('x'.repeat(32));
 const cipher=await encryptCredential(JSON.stringify({provider:'google_meet',externalAccountId:'person',refreshToken:'refresh'}),key);
 d.raw.prepare("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES('meeting','a','bs2','google_meet',?,'o','2026-01-01','2026-01-01')").run(cipher);
 d.raw.exec("INSERT INTO google_calendar_connections(id,calendar_id,line_account_id,staff_id,auth_type,is_active) VALUES('cal','calendar','a','bs','service_account',1)");
 await d.db.batch([queueDeletedGoogleCalendars(d.db,{whereSql:'c.line_account_id=? AND c.staff_id=?',params:['a','bs'],source:'staff'}),d.db.prepare("UPDATE google_calendar_connections SET is_active=0 WHERE id='cal'")]);
 const env={DB:d.db,DEPLOY_ENV:'staging',WORKER_URL:'https://worker.example.test',LINE_CREDENTIAL_ENCRYPTION_KEY:key,BOOKING_MEETING_OAUTH_ENABLED:'true',BOOKING_MEETING_OAUTH_CONFIG:JSON.stringify({google_meet:{clientId:'client',clientSecret:'secret'}})} as never;
 const item={accountId:'a',staffId:'bs2',provider:'google_meet' as const,connectionId:'meeting',credentialEnc:cipher};expect((await meetingRevokeDecision(env,item)).decision).toBe('revoke');await processDeletedMeetingRevocations(env);expect((await meetingRevokeDecision(env,item)).decision).toBe('revoke');
});
it('統括が未設定の店舗の認可は 30 日待たずに後片づけする',async()=>{
 const {queueAbandonedMeetingAuthorization,processDeletedMeetingRevocations}=await import('./booking-meeting-deletion-runner.js');const key=btoa('x'.repeat(32));d.raw.exec("UPDATE line_accounts SET tenant_id=NULL WHERE id='a'");
 const env={DB:d.db,DEPLOY_ENV:'staging',WORKER_URL:'https://worker.example.test',LINE_CREDENTIAL_ENCRYPTION_KEY:key,BOOKING_MEETING_OAUTH_ENABLED:'true',BOOKING_MEETING_OAUTH_CONFIG:JSON.stringify({zoom:{clientId:'client',clientSecret:'secret'}})} as never;
 await queueAbandonedMeetingAuthorization(env,{accountId:'a',staffId:'bs',tenantId:null,provider:'zoom',credential:{provider:'zoom',externalAccountId:'person',refreshToken:'refresh',accessToken:'access',accessExpiresAt:'2099-01-01'}});
 const row=d.raw.prepare("SELECT input_json FROM workflow_steps WHERE process_kind='booking_meeting_deleted_revoke'").get() as {input_json:string};expect(JSON.parse(row.input_json).source).toBe('staff');
 const fetcher=vi.fn(async()=>new Response('',{status:200}));vi.stubGlobal('fetch',fetcher);expect(await processDeletedMeetingRevocations(env)).toBe(1);expect(fetcher).toHaveBeenCalledOnce();
});
it('保存できなかった Microsoft の認可でも、同じ担当の接続がある間は解除を促さない',async()=>{
 const {queueAbandonedMeetingAuthorization,processDeletedMeetingRevocations}=await import('./booking-meeting-deletion-runner.js');
 d.raw.exec("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES('active','a','bs','teams','encrypted','o','2026-01-01','2026-01-01')");
 await queueAbandonedMeetingAuthorization({DB:d.db} as never,{accountId:'a',staffId:'bs',tenantId:'t',provider:'teams',credential:{provider:'teams',externalAccountId:'person',refreshToken:'refresh',accessToken:'access',accessExpiresAt:'2099-01-01'}});
 expect(await processDeletedMeetingRevocations({DB:d.db} as never)).toBe(0);await processDeletedMeetingRevocations({DB:d.db} as never,{now:Date.now()+16*60000});expect(d.raw.prepare("SELECT status FROM workflow_steps WHERE process_kind='booking_meeting_deleted_revoke'").get()).toEqual({status:'canceled'});expect(d.raw.prepare("SELECT COUNT(*) n FROM notifications WHERE event_type='booking_meeting_disconnect_review'").get()).toEqual({n:0});
});
