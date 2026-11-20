import {afterEach,beforeEach,expect,it} from 'vitest';
import {encryptCredential} from '@line-crm/db';
import {gapApp,gapCall,gapFixture,gapOwner,seedGapBooking} from '../test-utils/gap1.js';
import {bookingCalendarSettings} from './booking-calendar-settings.js';
let d:ReturnType<typeof gapFixture>;const key=btoa('k'.repeat(32));
const path='/api/booking/admin/external-cleanup?account_id=a';
beforeEach(async()=>{
 d=gapFixture();seedGapBooking(d);
 const payload=JSON.stringify(await encryptCredential(JSON.stringify({provider:'zoom',staffId:'bs',startsAt:'2030-01-01T00:00:00Z',remoteId:'secret-id',marker:'secret-marker'}),key));
 d.raw.prepare("INSERT INTO workflow_steps(scope_id,process_kind,subject_id,step_key,status,retry_key,input_json,created_at,updated_at) VALUES('line:a','booking_external_cleanup','job','current','unknown','index',?,0,0)").run(payload);
});
afterEach(()=>d.raw.close());
it('閲覧のみでも最小限だけ返し、別アカウントを拒む',async()=>{
 const app=gapApp(d,[bookingCalendarSettings],gapOwner,false,{LINE_CREDENTIAL_ENCRYPTION_KEY:key});
 const res=await gapCall(app,path);expect(res.status).toBe(200);
 const body=await res.json();expect(body).toMatchObject({data:{items:[{id:'job',provider:'zoom',staffId:'bs',startsAt:'2030-01-01T00:00:00Z'}]}});
 expect(JSON.stringify(body)).not.toMatch(/secret-id|secret-marker/);
 const viewer=gapApp(d,[bookingCalendarSettings],{...gapOwner,readOnly:true},false,{LINE_CREDENTIAL_ENCRYPTION_KEY:key});
 expect((await gapCall(viewer,path)).status).toBe(200);
 expect((await gapCall(viewer,'/api/booking/admin/external-cleanup/job/resolve?account_id=a','POST',{confirmed:true})).status).toBe(403);
 const staffViewer=gapApp(d,[bookingCalendarSettings],{...gapOwner,id:'s',role:'staff',readOnly:true},false,{LINE_CREDENTIAL_ENCRYPTION_KEY:key});
 expect((await gapCall(staffViewer,path)).status).toBe(200);
 expect((await gapCall(staffViewer,'/api/booking/admin/external-cleanup/job/resolve?account_id=a','POST',{confirmed:true})).status).toBe(403);
 expect((await gapCall(app,path.replace('account_id=a','account_id=b'))).status).toBe(404);
});
it('確認済みの明示と同じ店の要確認行が必要',async()=>{
 const app=gapApp(d,[bookingCalendarSettings],gapOwner,false,{LINE_CREDENTIAL_ENCRYPTION_KEY:key});
 const route='/api/booking/admin/external-cleanup/job/resolve?account_id=a';
 expect((await gapCall(app,route,'POST',{})).status).toBe(400);
 expect((await gapCall(gapApp(d,[bookingCalendarSettings],gapOwner,true),route,'POST',{confirmed:true})).status).toBe(403);
 expect((await gapCall(app,route,'POST',{confirmed:true,reason:'x'.repeat(201)})).status).toBe(400);
 expect((await gapCall(app,route.replace('account_id=a','account_id=b'),'POST',{confirmed:true})).status).toBe(404);
 expect((await gapCall(app,route,'POST',{confirmed:true,reason:'相手先で確認しました'})).status).toBe(200);
 expect(d.raw.prepare("SELECT reason FROM audit_events WHERE action='booking.external.cleanup.resolve' AND target_id='job'").get()).toEqual({reason:'相手先で確認しました'});
 expect((await gapCall(app,route,'POST',{confirmed:true})).status).toBe(404);
 expect(d.raw.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='booking.external.cleanup.resolve' AND target_id='job'").get()).toEqual({n:1});
});
it('理由は任意で、監査の保存に失敗したら要確認の記録も消さない',async()=>{
 const app=gapApp(d,[bookingCalendarSettings],gapOwner,false,{LINE_CREDENTIAL_ENCRYPTION_KEY:key});
 const route='/api/booking/admin/external-cleanup/job/resolve?account_id=a';
 d.raw.exec('DROP TABLE audit_events');
 expect((await gapCall(app,route,'POST',{confirmed:true})).status).toBe(503);
 expect(d.raw.prepare("SELECT status FROM workflow_steps WHERE subject_id='job'").get()).toEqual({status:'unknown'});
});
it('理由なしでも確認を記録できる',async()=>{
 const app=gapApp(d,[bookingCalendarSettings],gapOwner,false,{LINE_CREDENTIAL_ENCRYPTION_KEY:key});
 expect((await gapCall(app,'/api/booking/admin/external-cleanup/job/resolve?account_id=a','POST',{confirmed:true})).status).toBe(200);
 expect(d.raw.prepare("SELECT reason FROM audit_events WHERE action='booking.external.cleanup.resolve'").get()).toEqual({reason:null});
});
it('理由の連絡先は監査の共通処理で伏せる',async()=>{
 const app=gapApp(d,[bookingCalendarSettings],gapOwner,false,{LINE_CREDENTIAL_ENCRYPTION_KEY:key});
 expect((await gapCall(app,'/api/booking/admin/external-cleanup/job/resolve?account_id=a','POST',{confirmed:true,reason:'連絡先 test@example.test を確認'})).status).toBe(200);
 expect(d.raw.prepare("SELECT reason FROM audit_events WHERE action='booking.external.cleanup.resolve'").get()).toEqual({reason:'連絡先 [masked-email] を確認'});
});
it('同時に確認されても監査は1件だけ残る',async()=>{
 const app=gapApp(d,[bookingCalendarSettings],gapOwner,false,{LINE_CREDENTIAL_ENCRYPTION_KEY:key});
 const route='/api/booking/admin/external-cleanup/job/resolve?account_id=a';
 const responses=await Promise.all([gapCall(app,route,'POST',{confirmed:true,reason:'確認済み'}),gapCall(app,route,'POST',{confirmed:true,reason:'確認済み'})]);
 expect(responses.map(response=>response.status).sort()).toEqual([200,404]);
 expect(d.raw.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='booking.external.cleanup.resolve'").get()).toEqual({n:1});
});
