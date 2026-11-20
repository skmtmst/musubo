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
it('管理者に最小限だけ返し、読み取り専用と別アカウントを拒む',async()=>{
 const app=gapApp(d,[bookingCalendarSettings],gapOwner,false,{LINE_CREDENTIAL_ENCRYPTION_KEY:key});
 const res=await gapCall(app,path);expect(res.status).toBe(200);
 const body=await res.json();expect(body).toMatchObject({data:{items:[{id:'job',provider:'zoom',staffId:'bs',startsAt:'2030-01-01T00:00:00Z'}]}});
 expect(JSON.stringify(body)).not.toMatch(/secret-id|secret-marker/);
 expect((await gapCall(gapApp(d,[bookingCalendarSettings],{...gapOwner,readOnly:true}),path)).status).toBe(403);
 expect((await gapCall(app,path.replace('account_id=a','account_id=b'))).status).toBe(404);
});
it('確認済みの明示と同じ店の要確認行が必要',async()=>{
 const app=gapApp(d,[bookingCalendarSettings],gapOwner,false,{LINE_CREDENTIAL_ENCRYPTION_KEY:key});
 const route='/api/booking/admin/external-cleanup/job/resolve?account_id=a';
 expect((await gapCall(app,route,'POST',{})).status).toBe(400);
 expect((await gapCall(app,route.replace('account_id=a','account_id=b'),'POST',{confirmed:true})).status).toBe(404);
 expect((await gapCall(app,route,'POST',{confirmed:true})).status).toBe(200);
 expect((await gapCall(app,route,'POST',{confirmed:true})).status).toBe(404);
});
