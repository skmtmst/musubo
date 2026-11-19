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
 const completed=await gapCall(app,callback);expect(completed.status).toBe(302);expect(completed.headers.get('location')).toContain('meeting_connection=connected');expect(request).toHaveBeenCalledTimes(2);
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
