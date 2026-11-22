import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {bookingMeetingOAuth} from './booking-meeting-oauth.js';
import {gapApp,gapCall,gapFixture,gapOwner} from '../test-utils/gap1.js';
let d:ReturnType<typeof gapFixture>;
const path='/api/booking/admin/staff/bs/connections/google_meet';
const key=btoa('x'.repeat(32));
const bindings={DEPLOY_ENV:'staging',BOOKING_MEETING_OAUTH_ENABLED:'true',BOOKING_MEETING_OAUTH_CONFIG:JSON.stringify({google_meet:{clientId:'fixture-client',clientSecret:'fixture-secret'}}),LINE_CREDENTIAL_ENCRYPTION_KEY:key,WORKER_URL:'https://worker.example.test',ADMIN_PUBLIC_URL:'https://admin.example.test'};
beforeEach(()=>{d=gapFixture()});afterEach(()=>{d.raw.close();vi.unstubAllGlobals();});
it('鍵が無い場合は模擬として返し、外部通信しない',async()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 const response=await gapCall(gapApp(d,[bookingMeetingOAuth]),`${path}/connect?account_id=a`,'POST',{});
 expect(response.status).toBe(200);expect(await response.json()).toMatchObject({data:{mode:'mock',authorizationUrl:null}});expect(fetcher).not.toHaveBeenCalled();
});
it('閲覧のみ・代理ログインと別の担当者による接続は拒否する',async()=>{
 const read=gapApp(d,[bookingMeetingOAuth],{...gapOwner,readOnly:true});expect((await gapCall(read,`${path}/connect?account_id=a`,'POST',{})).status).toBe(403);
 const impersonated=gapApp(d,[bookingMeetingOAuth],gapOwner,true);expect((await gapCall(impersonated,`${path}/connect?account_id=a`,'POST',{})).status).toBe(403);
 const other=gapApp(d,[bookingMeetingOAuth],{id:'someone',name:'担当',role:'staff',readOnly:false,tenantId:'t',permissionKeys:['booking.staff.own']});
 expect((await gapCall(other,`${path}/connect?account_id=a`,'POST',{})).status).toBe(403);
});
it('state の再利用を拒み、本人の鍵を暗号化して保存し切断できる',async()=>{
 const request=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({access_token:'fixture-access',refresh_token:'fixture-refresh',expires_in:3600,scope:'openid https://www.googleapis.com/auth/calendar.events'}))).mockResolvedValueOnce(new Response(JSON.stringify({sub:'fixture-account'})));
 vi.stubGlobal('fetch',request);const app=gapApp(d,[bookingMeetingOAuth],gapOwner,false,bindings);
 const started=await gapCall(app,`${path}/connect?account_id=a`,'POST',{});expect(started.status).toBe(200);
 const data=await started.json() as {data:{authorizationUrl:string}};const url=new URL(data.data.authorizationUrl);const state=url.searchParams.get('state')!;
 expect(data.data.authorizationUrl).not.toContain('fixture-secret');
 const callback=`/api/booking/admin/meeting-oauth/callback?state=${encodeURIComponent(state)}&code=fixture-code`;
 const completed=await gapCall(app,callback);expect(completed.status).toBe(302);expect(completed.headers.get('location')).toContain('/booking/menus?');expect(completed.headers.get('location')).toContain('meeting_connection=connected');expect(request).toHaveBeenCalledTimes(2);
 expect((await gapCall(app,`${path}/prefer?account_id=a`,'POST',{})).status).toBe(200);
 expect(await (await gapCall(app,`${path}?account_id=a`)).json()).toMatchObject({data:{preferred:true}});
 const saved=d.raw.prepare('SELECT credential_enc FROM booking_meeting_connections').get() as {credential_enc:string};expect(saved.credential_enc).not.toContain('fixture-refresh');
 expect((await gapCall(app,callback)).status).toBe(401);
 expect((await gapCall(app,`${path}?account_id=a`,'DELETE')).status).toBe(200);
 expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_meeting_connections').get()).toEqual({n:0});
});
it('state Cookie がある場合は一致を確かめ、違えば交換しない',async()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);const app=gapApp(d,[bookingMeetingOAuth],gapOwner,false,bindings);
 const started=await gapCall(app,`${path}/connect?account_id=a`,'POST',{});
 const data=await started.json() as {data:{authorizationUrl:string}};const state=new URL(data.data.authorizationUrl).searchParams.get('state')!;
 const response=await app.request(`/api/booking/admin/meeting-oauth/callback?state=${encodeURIComponent(state)}&code=fixture-code`,{headers:{Cookie:'booking_meeting_oauth_state=wrong'}});
 expect(response.status).toBe(401);expect(fetcher).not.toHaveBeenCalled();
});
it('接続していないサービスは優先先にできず、閲覧のみは変更できない',async()=>{
 const app=gapApp(d,[bookingMeetingOAuth]);
 expect((await gapCall(app,`${path}/prefer?account_id=a`,'POST',{})).status).toBe(409);
 const read=gapApp(d,[bookingMeetingOAuth],{...gapOwner,readOnly:true});
 expect((await gapCall(read,`${path}/prefer?account_id=a`,'POST',{})).status).toBe(403);
});
it.each(['teams','outlook'] as const)('Microsoft の %s を切断すると鍵を消し、相手側での解除を知らせる',async provider=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 d.raw.prepare("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES('c','a','bs',?,'cipher','o','2026-01-01','2026-01-01')").run(provider);
 const app=gapApp(d,[bookingMeetingOAuth]);
 expect((await gapCall(app,`/api/booking/admin/staff/bs/connections/${provider}?account_id=a`,'DELETE')).status).toBe(200);
 expect(d.raw.prepare("SELECT COUNT(*) n FROM booking_meeting_connections WHERE id='c'").get()).toEqual({n:0});
 expect(d.raw.prepare("SELECT body FROM notifications WHERE event_type='booking_meeting_disconnect_review' AND line_account_id='a'").get()).toMatchObject({body:expect.stringContaining('Microsoft 側でアプリの接続を解除してください')});
 expect(fetcher).not.toHaveBeenCalled();
});
it.each(['google_meet','zoom'] as const)('%s を切断すると鍵を消し、外部での解除状態を確認するよう知らせる',async provider=>{
 d.raw.prepare("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES('c','a','bs',?,'cipher','o','2026-01-01','2026-01-01')").run(provider);
 const app=gapApp(d,[bookingMeetingOAuth]);
 expect((await gapCall(app,`/api/booking/admin/staff/bs/connections/${provider}?account_id=a`,'DELETE')).status).toBe(200);
 expect(d.raw.prepare("SELECT COUNT(*) n FROM booking_meeting_connections WHERE id='c'").get()).toEqual({n:0});
 expect(d.raw.prepare("SELECT body FROM notifications WHERE event_type='booking_meeting_disconnect_review' AND line_account_id='a'").get()).toMatchObject({body:expect.stringContaining('他の連携がないか確認')});
});
it('更新処理中の切断は 409 を返して鍵を残す',async()=>{
 const now=new Date().toISOString();
 d.raw.prepare("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at,refresh_state,refresh_claim) VALUES('c','a','bs','zoom','cipher','o',?,?,'refreshing','claim')").run(now,now);
 const result=await gapCall(gapApp(d,[bookingMeetingOAuth]),'/api/booking/admin/staff/bs/connections/zoom?account_id=a','DELETE');
 expect(result.status).toBe(409);
 expect(d.raw.prepare("SELECT credential_enc FROM booking_meeting_connections WHERE id='c'").get()).toEqual({credential_enc:'cipher'});
});
it('Google の読み込み中は試験対象外の Outlook 接続を始めない',async()=>{
 d.raw.exec("INSERT INTO booking_calendar_switches(line_account_id,scope_id,read_enabled,updated_by,updated_at) VALUES('a','bs',1,'o','2026-01-01')");
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 const app=gapApp(d,[bookingMeetingOAuth],gapOwner,false,{...bindings,BOOKING_MEETING_OAUTH_CONFIG:JSON.stringify({outlook:{clientId:'id',clientSecret:'secret'}})});
 const response=await gapCall(app,'/api/booking/admin/staff/bs/connections/outlook/connect?account_id=a','POST',{});
 expect(response.status).toBe(409);expect(await response.json()).toMatchObject({error:'outlook_test_staff_required'});expect(fetcher).not.toHaveBeenCalled();
});
it('接続鍵の移行はオーナーのみで、既定は読み取りだけ',async()=>{
 const {encryptCredential}=await import('@line-crm/db');
 const encrypted=await encryptCredential(JSON.stringify({provider:'zoom',externalAccountId:'example',refreshToken:'secret'}),key);
 d.raw.prepare("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES('c','a','bs','zoom',?,'o','2026-01-01','2026-01-01')").run(encrypted);
 d.raw.exec("INSERT INTO staff(id,line_account_id,name,display_name) VALUES('other-bs','b','担当','担当')");
 d.raw.prepare("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES('other','b','other-bs','zoom',?,'o','2026-01-01','2026-01-01')").run(encrypted);
 const config={...bindings,BOOKING_MEETING_CREDENTIAL_V2_ENABLED:'true'};
 const url='/api/booking/admin/meeting-credentials/rotate?account_id=a';
 const read=gapApp(d,[bookingMeetingOAuth],{...gapOwner,readOnly:true},false,config);
 expect((await gapCall(read,url,'POST',{})).status).toBe(403);
 const staff=gapApp(d,[bookingMeetingOAuth],{id:'someone',name:'担当',role:'staff',readOnly:false,tenantId:'t'},false,config);
 expect((await gapCall(staff,url,'POST',{})).status).toBe(403);
 const app=gapApp(d,[bookingMeetingOAuth],gapOwner,false,config);
 expect(await (await gapCall(app,url,'POST',{})).json()).toMatchObject({data:{scanned:1,needsRotation:1,rotated:0}});
 expect((d.raw.prepare("SELECT credential_enc FROM booking_meeting_connections WHERE id='c'").get() as {credential_enc:string}).credential_enc).toBe(encrypted);
 expect(await (await gapCall(app,url,'POST',{dryRun:false})).json()).toMatchObject({data:{needsRotation:1,rotated:1}});
 expect((d.raw.prepare("SELECT credential_enc FROM booking_meeting_connections WHERE id='c'").get() as {credential_enc:string}).credential_enc).toMatch(/^v2\.line\./);
 expect((d.raw.prepare("SELECT credential_enc FROM booking_meeting_connections WHERE id='other'").get() as {credential_enc:string}).credential_enc).toBe(encrypted);
});
