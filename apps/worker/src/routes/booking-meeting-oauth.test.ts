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
it.each(['google_meet','zoom'] as const)('%s の解除中は再接続を止め、解除後は新しい許可を保存できる',async provider=>{
 const {encryptCredential,decryptCredential}=await import('@line-crm/db');
 const cipher=await encryptCredential(JSON.stringify({provider,externalAccountId:'user',refreshToken:'old-refresh',accessToken:'old-access'}),key);
 d.raw.prepare("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES('old','a','bs',?,?,'o','2026-01-01','2026-01-01')").run(provider,cipher);
 const configured={...bindings,BOOKING_MEETING_OAUTH_CONFIG:JSON.stringify({[provider]:{clientId:'client',clientSecret:'secret'}})};
 let unblock!:()=>void,arrived!:()=>void;const pending=new Promise<void>(resolve=>{unblock=resolve});const started=new Promise<void>(resolve=>{arrived=resolve});
 const scopes=provider==='google_meet'?'https://www.googleapis.com/auth/calendar.events':'user:read:user meeting:write:meeting meeting:read:meeting meeting:read:list_meetings meeting:delete:meeting';
 const fetcher=vi.fn(async(url:RequestInfo|URL)=>{
  if(String(url).includes('/revoke')){arrived();await pending;return new Response('',{status:200});}
  if(String(url).includes('/token'))return new Response(JSON.stringify({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600,scope:scopes}));
  return new Response(JSON.stringify(provider==='google_meet'?{sub:'user'}:{id:'user'}));
 });vi.stubGlobal('fetch',fetcher);
 const app=gapApp(d,[bookingMeetingOAuth],gapOwner,false,configured),base=`/api/booking/admin/staff/bs/connections/${provider}`;
 const disconnect=gapCall(app,`${base}?account_id=a`,'DELETE');await started;
 const locked=await gapCall(app,`${base}/connect?account_id=a`,'POST',{});expect(locked.status).toBe(409);expect(await locked.json()).toMatchObject({message:'解除の処理中です。少し待ってからつなぎ直してください。'});
 unblock();expect((await disconnect).status).toBe(200);
 const next=await gapCall(app,`${base}/connect?account_id=a`,'POST',{});expect(next.status).toBe(200);
 const data=await next.json() as {data:{authorizationUrl:string}};const state=new URL(data.data.authorizationUrl).searchParams.get('state');
 expect((await gapCall(app,`/api/booking/admin/meeting-oauth/callback?state=${state}&code=fixture-code`)).status).toBe(302);
 const saved=d.raw.prepare('SELECT credential_enc FROM booking_meeting_connections').get() as {credential_enc:string};
 expect(JSON.parse(await decryptCredential(saved.credential_enc,key))).toMatchObject({refreshToken:'new-refresh'});
 expect(fetcher.mock.calls.filter(([url])=>String(url).includes('/revoke'))).toHaveLength(1);
});
it('他の担当が同じ Google アカウントを使うときは取り消さず手元だけ切断する',async()=>{
 const {encryptCredential}=await import('@line-crm/db');const value=JSON.stringify({provider:'google_meet',externalAccountId:'same',refreshToken:'old'}),cipher=await encryptCredential(value,key);
 d.raw.prepare("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES(?,'a',?,'google_meet',?,'o','2026-01-01','2026-01-01')").run('first','bs',cipher);
 d.raw.prepare("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES(?,'a',?,'google_meet',?,'o','2026-01-01','2026-01-01')").run('second','bs2',cipher);
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);const app=gapApp(d,[bookingMeetingOAuth],gapOwner,false,bindings);
 expect((await gapCall(app,`${path}?account_id=a`,'DELETE')).status).toBe(200);expect(fetcher).not.toHaveBeenCalled();
 expect(d.raw.prepare('SELECT id FROM booking_meeting_connections').all()).toEqual([{id:'second'}]);
});
it.each([['zoom',500],['zoom','network'],['google_meet',500],['google_meet','network']] as const)('%s の解除が %s でも鍵を消して確認を残す',async (provider,failure)=>{
 const {encryptCredential}=await import('@line-crm/db');const cipher=await encryptCredential(JSON.stringify({provider,externalAccountId:'user',refreshToken:'old',accessToken:'access'}),key);
 d.raw.prepare("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES('z','a','bs',?,?,'o','2026-01-01','2026-01-01')").run(provider,cipher);
 const fetcher=vi.fn(async()=>{if(failure==='network')throw new Error('network');return new Response('',{status:failure})});vi.stubGlobal('fetch',fetcher);
 const configured={...bindings,BOOKING_MEETING_OAUTH_CONFIG:JSON.stringify({[provider]:{clientId:'client',clientSecret:'secret'}})};
 expect((await gapCall(gapApp(d,[bookingMeetingOAuth],gapOwner,false,configured),`/api/booking/admin/staff/bs/connections/${provider}?account_id=a`,'DELETE')).status).toBe(200);
 expect(d.raw.prepare("SELECT COUNT(*) n FROM booking_meeting_connections WHERE id='z'").get()).toEqual({n:0});
 expect(d.raw.prepare("SELECT COUNT(*) n FROM notifications WHERE event_type='booking_meeting_disconnect_review' AND category='error'").get()).toEqual({n:1});expect(fetcher).toHaveBeenCalledOnce();
});
it('解除の借受中に戻った認可は交換せず、借受終了後に完了できる',async()=>{
 const app=gapApp(d,[bookingMeetingOAuth],gapOwner,false,bindings);
 const start=await gapCall(app,`${path}/connect?account_id=a`,'POST',{});const data=await start.json() as {data:{authorizationUrl:string}};const state=new URL(data.data.authorizationUrl).searchParams.get('state');
 const now=Date.now();d.raw.prepare("INSERT INTO workflow_steps(scope_id,process_kind,subject_id,step_key,status,lease_owner,lease_expires_at,retry_key,created_at,updated_at) VALUES('global:meeting-revoke','booking_meeting_revoke_lock','google_meet','lock','running','owner',?,'key',?,?)").run(now+120000,now,now);
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);const result=await gapCall(app,`/api/booking/admin/meeting-oauth/callback?state=${state}&code=fixture-code`);
 expect(result.status).toBe(409);expect(await result.json()).toMatchObject({message:'解除の処理中です。少し待ってからつなぎ直してください。'});expect(fetcher).not.toHaveBeenCalled();
 expect(d.raw.prepare('SELECT used_at FROM booking_meeting_oauth_states WHERE state=?').get(state)).toEqual({used_at:null});
});
it('Google の他の担当が別アカウントなら、切断する本人を解除する',async()=>{
 const {encryptCredential}=await import('@line-crm/db');
 for(const [id,staff,sub] of [['first','bs','first-user'],['second','bs2','other-user']]){
  const cipher=await encryptCredential(JSON.stringify({provider:'google_meet',externalAccountId:sub,refreshToken:`refresh-${sub}`}),key);
  d.raw.prepare("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES(?,'a',?,'google_meet',?,'o','2026-01-01','2026-01-01')").run(id,staff,cipher);
 }
 const fetcher=vi.fn(async()=>new Response('',{status:200}));vi.stubGlobal('fetch',fetcher);
 expect((await gapCall(gapApp(d,[bookingMeetingOAuth],gapOwner,false,bindings),`${path}?account_id=a`,'DELETE')).status).toBe(200);
 expect(fetcher).toHaveBeenCalledOnce();expect(d.raw.prepare('SELECT id FROM booking_meeting_connections').all()).toEqual([{id:'second'}]);
});
it('Google カレンダーの OAuth が本人照合できなければ解除せず確認を残す',async()=>{
 const {encryptCredential}=await import('@line-crm/db');const cipher=await encryptCredential(JSON.stringify({provider:'google_meet',externalAccountId:'user',refreshToken:'refresh'}),key);
 d.raw.prepare("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES('first','a','bs','google_meet',?,'o','2026-01-01','2026-01-01')").run(cipher);
 d.raw.exec("INSERT INTO google_calendar_connections(id,calendar_id,line_account_id,staff_id,auth_type,is_active) VALUES('cal','unknown','a','bs2','oauth',1)");
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 expect((await gapCall(gapApp(d,[bookingMeetingOAuth],gapOwner,false,bindings),`${path}?account_id=a`,'DELETE')).status).toBe(200);
 expect(fetcher).not.toHaveBeenCalled();expect(d.raw.prepare("SELECT COUNT(*) n FROM notifications WHERE event_type='booking_meeting_disconnect_review' AND category='error'").get()).toEqual({n:1});
});
it('別の Google 認可の途中は revoke せず、手元の鍵を消して確認を残す',async()=>{
 const {encryptCredential}=await import('@line-crm/db');const cipher=await encryptCredential(JSON.stringify({provider:'google_meet',externalAccountId:'user',refreshToken:'old'}),key);
 d.raw.prepare("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES('first','a','bs','google_meet',?,'o','2026-01-01','2026-01-01')").run(cipher);
 const app=gapApp(d,[bookingMeetingOAuth],gapOwner,false,bindings);const other='/api/booking/admin/staff/bs2/connections/google_meet/connect?account_id=a';expect((await gapCall(app,other,'POST',{})).status).toBe(200);
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);expect((await gapCall(app,`${path}?account_id=a`,'DELETE')).status).toBe(200);expect(fetcher).not.toHaveBeenCalled();
 expect(d.raw.prepare("SELECT COUNT(*) n FROM booking_meeting_connections WHERE id='first'").get()).toEqual({n:0});expect(d.raw.prepare("SELECT COUNT(*) n FROM notifications WHERE category='error' AND event_type='booking_meeting_disconnect_review'").get()).toEqual({n:1});
});
it('復号できない別の Google 接続があれば revoke せず確認を残す',async()=>{
 const {encryptCredential}=await import('@line-crm/db');const cipher=await encryptCredential(JSON.stringify({provider:'google_meet',externalAccountId:'user',refreshToken:'old'}),key);
 d.raw.prepare("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES('first','a','bs','google_meet',?,'o','2026-01-01','2026-01-01')").run(cipher);
 d.raw.exec("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES('second','a','bs2','google_meet','broken','o','2026-01-01','2026-01-01')");
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);expect((await gapCall(gapApp(d,[bookingMeetingOAuth],gapOwner,false,bindings),`${path}?account_id=a`,'DELETE')).status).toBe(200);expect(fetcher).not.toHaveBeenCalled();
 expect(d.raw.prepare("SELECT COUNT(*) n FROM notifications WHERE category='error' AND event_type='booking_meeting_disconnect_review'").get()).toEqual({n:1});
});
it('別の Google 連携の設定があり本人を照合できなければ revoke しない',async()=>{
 const {encryptCredential}=await import('@line-crm/db');const cipher=await encryptCredential(JSON.stringify({provider:'google_meet',externalAccountId:'user',refreshToken:'old'}),key);
 d.raw.prepare("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES('first','a','bs','google_meet',?,'o','2026-01-01','2026-01-01')").run(cipher);
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);const app=gapApp(d,[bookingMeetingOAuth],gapOwner,false,{...bindings,GOOGLE_BUSINESS_OAUTH_CLIENT_ID:'other-client'});
 expect((await gapCall(app,`${path}?account_id=a`,'DELETE')).status).toBe(200);expect(fetcher).not.toHaveBeenCalled();
 expect(d.raw.prepare("SELECT COUNT(*) n FROM notifications WHERE category='error' AND event_type='booking_meeting_disconnect_review'").get()).toEqual({n:1});
});
it('Zoom の同じ利用者が他の担当に残る間は解除せず、最後の接続だけ解除する',async()=>{
 const {encryptMeetingCredential}=await import('../features/booking/booking-meeting-crypto.js');
 const keys={legacyKey:key,activeId:'line',keys:{line:key},writeV2:true};
 for(const [id,staff] of [['first','bs'],['second','bs2']]){
  const cipher=await encryptMeetingCredential(JSON.stringify({provider:'zoom',externalAccountId:'same-zoom-user',refreshToken:'refresh',accessToken:`access-${id}`}),keys,{accountId:'a',staffId:staff,provider:'zoom'});
  d.raw.prepare("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES(?,'a',?,'zoom',?,'o','2026-01-01','2026-01-01')").run(id,staff,cipher);
 }
 const configured={...bindings,BOOKING_MEETING_CREDENTIAL_V2_ENABLED:'true',BOOKING_MEETING_OAUTH_CONFIG:JSON.stringify({zoom:{clientId:'client',clientSecret:'secret'}})};
 const fetcher=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>new Response('',{status:200}));vi.stubGlobal('fetch',fetcher);const app=gapApp(d,[bookingMeetingOAuth],gapOwner,false,configured);
 expect((await gapCall(app,'/api/booking/admin/staff/bs/connections/zoom?account_id=a','DELETE')).status).toBe(200);expect(fetcher).not.toHaveBeenCalled();
 expect(d.raw.prepare('SELECT id FROM booking_meeting_connections').all()).toEqual([{id:'second'}]);
 expect((await gapCall(app,'/api/booking/admin/staff/bs2/connections/zoom?account_id=a','DELETE')).status).toBe(200);expect(fetcher).toHaveBeenCalledOnce();
 expect(new URLSearchParams(fetcher.mock.calls[0][1]?.body as string).get('token')).toBe('access-second');
 expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_meeting_connections').get()).toEqual({n:0});
});
it('他の店の Zoom 接続も本人照合して解除しない',async()=>{
 const {encryptMeetingCredential}=await import('../features/booking/booking-meeting-crypto.js');const keys={legacyKey:key,activeId:'line',keys:{line:key},writeV2:true};
 d.raw.exec("INSERT INTO staff(id,line_account_id,name,display_name) VALUES('other-bs','b','担当','担当')");
 for(const [id,account,staff] of [['first','a','bs'],['other','b','other-bs']]){
  const cipher=await encryptMeetingCredential(JSON.stringify({provider:'zoom',externalAccountId:'same-zoom-user',refreshToken:'refresh',accessToken:'access'}),keys,{accountId:account,staffId:staff,provider:'zoom'});
  d.raw.prepare("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES(?,?,?,'zoom',?,'o','2026-01-01','2026-01-01')").run(id,account,staff,cipher);
 }
 const configured={...bindings,BOOKING_MEETING_CREDENTIAL_V2_ENABLED:'true',BOOKING_MEETING_OAUTH_CONFIG:JSON.stringify({zoom:{clientId:'client',clientSecret:'secret'}})};
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);expect((await gapCall(gapApp(d,[bookingMeetingOAuth],gapOwner,false,configured),'/api/booking/admin/staff/bs/connections/zoom?account_id=a','DELETE')).status).toBe(200);
 expect(fetcher).not.toHaveBeenCalled();expect(d.raw.prepare('SELECT id FROM booking_meeting_connections').all()).toEqual([{id:'other'}]);
});
it.each(['broken','missing'] as const)('Zoom の他の接続が %s なら解除せず要確認',async otherValue=>{
 const {encryptCredential}=await import('@line-crm/db');const first=await encryptCredential(JSON.stringify({provider:'zoom',externalAccountId:'user',refreshToken:'refresh',accessToken:'access'}),key);
 const other=otherValue==='broken'?'broken':await encryptCredential(JSON.stringify({provider:'zoom',refreshToken:'refresh'}),key);
 for(const [id,staff,cipher] of [['first','bs',first],['other','bs2',other]])d.raw.prepare("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES(?,'a',?,'zoom',?,'o','2026-01-01','2026-01-01')").run(id,staff,cipher);
 const configured={...bindings,BOOKING_MEETING_OAUTH_CONFIG:JSON.stringify({zoom:{clientId:'client',clientSecret:'secret'}})};const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 expect((await gapCall(gapApp(d,[bookingMeetingOAuth],gapOwner,false,configured),'/api/booking/admin/staff/bs/connections/zoom?account_id=a','DELETE')).status).toBe(200);
 expect(fetcher).not.toHaveBeenCalled();expect(d.raw.prepare("SELECT COUNT(*) n FROM notifications WHERE category='error' AND event_type='booking_meeting_disconnect_review'").get()).toEqual({n:1});
});
it('Zoom 解除中は別の担当の新規認可も待ち、終了後に開始できる',async()=>{
 const {acquireMeetingRevokeLock,releaseMeetingRevokeLock}=await import('../features/booking/booking-meeting-revoke-lock.js');
 const scope={accountId:'a',staffId:'bs',provider:'zoom' as const};const lease=await acquireMeetingRevokeLock(d.db,scope);expect(lease).toBeTruthy();
 const configured={...bindings,BOOKING_MEETING_OAUTH_CONFIG:JSON.stringify({zoom:{clientId:'client',clientSecret:'secret'}})};const app=gapApp(d,[bookingMeetingOAuth],gapOwner,false,configured);
 const route='/api/booking/admin/staff/bs2/connections/zoom/connect?account_id=a';expect((await gapCall(app,route,'POST',{})).status).toBe(409);
 await releaseMeetingRevokeLock(d.db,scope,lease!);expect((await gapCall(app,route,'POST',{})).status).toBe(200);
});
it('切断する Zoom 接続に本人 ID がなければ解除せず要確認',async()=>{
 const {encryptCredential}=await import('@line-crm/db');const cipher=await encryptCredential(JSON.stringify({provider:'zoom',refreshToken:'refresh',accessToken:'access'}),key);
 d.raw.prepare("INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at) VALUES('first','a','bs','zoom',?,'o','2026-01-01','2026-01-01')").run(cipher);
 const configured={...bindings,BOOKING_MEETING_OAUTH_CONFIG:JSON.stringify({zoom:{clientId:'client',clientSecret:'secret'}})};const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 expect((await gapCall(gapApp(d,[bookingMeetingOAuth],gapOwner,false,configured),'/api/booking/admin/staff/bs/connections/zoom?account_id=a','DELETE')).status).toBe(200);
 expect(fetcher).not.toHaveBeenCalled();expect(d.raw.prepare("SELECT COUNT(*) n FROM notifications WHERE category='error' AND event_type='booking_meeting_disconnect_review'").get()).toEqual({n:1});
});
it('認可の交換中に担当者が削除されたら、接続を復活させず確定後の解除台帳へ移す',async()=>{
 const fetcher=vi.fn().mockImplementationOnce(async()=>{d.raw.exec("UPDATE staff SET deleted_at='2026-11-22' WHERE id='bs'");return new Response(JSON.stringify({access_token:'late-access',refresh_token:'late-refresh',expires_in:3600,scope:'openid https://www.googleapis.com/auth/calendar.events'}));}).mockResolvedValueOnce(new Response(JSON.stringify({sub:'late-person'})));
 vi.stubGlobal('fetch',fetcher);const app=gapApp(d,[bookingMeetingOAuth],gapOwner,false,bindings);
 const started=await gapCall(app,`${path}/connect?account_id=a`,'POST',{});const body=await started.json() as {data:{authorizationUrl:string}};const state=new URL(body.data.authorizationUrl).searchParams.get('state')!;
 const response=await gapCall(app,`/api/booking/admin/meeting-oauth/callback?state=${state}&code=fixture-code`);expect(response.status).toBe(302);expect(response.headers.get('location')).toContain('meeting_connection=failed');
 expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_meeting_connections').get()).toEqual({n:0});
 const row=d.raw.prepare("SELECT input_json FROM workflow_steps WHERE process_kind='booking_meeting_deleted_revoke'").get() as {input_json:string};expect(row.input_json).not.toContain('late-refresh');expect(JSON.parse(row.input_json)).toMatchObject({source:'staff',provider:'google_meet',credentialEnc:expect.any(String)});expect(fetcher).toHaveBeenCalledTimes(2);
});
