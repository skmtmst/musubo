import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {bookingCalendarSettings} from './booking-calendar-settings.js';
import {gapApp,gapCall,gapFixture,gapOwner,seedGapBooking} from '../test-utils/gap1.js';
let d:ReturnType<typeof gapFixture>;
const path='/api/booking/admin/bookings/bk/meeting-retry?account_id=a';
beforeEach(()=>{d=gapFixture();seedGapBooking(d);});
afterEach(()=>d.raw.close());
it('管理者以外と閲覧のみを拒む',async()=>{
 for(const staff of [{...gapOwner,role:'staff' as const},{...gapOwner,readOnly:true}]){
  expect((await gapCall(gapApp(d,[bookingCalendarSettings],staff),path,'POST',{})).status).toBe(403);
 }
});
it('冪等キーが必要で、別のアカウントの予約は指定できない',async()=>{
 const app=gapApp(d,[bookingCalendarSettings]);
 expect((await app.request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status).toBe(400);
 expect((await gapCall(app,path.replace('account_id=a','account_id=b'),'POST',{})).status).toBe(404);
});
it('結果不明の状態を返し、再発行を受け付けない',async()=>{
 d.raw.exec("UPDATE bookings SET meeting_mode='online' WHERE id='bk'; INSERT INTO booking_meeting_links(id,booking_id,provider,status,idempotency_key,attempt_count,last_error_code,staff_id,starts_at,ends_at,created_at,updated_at) SELECT 'link',id,'zoom','pending','booking-meeting:'||id||':'||lock_version,1,'result_unknown',staff_id,starts_at,ends_at,'2020-01-01','2020-01-01' FROM bookings WHERE id='bk'");
 const app=gapApp(d,[bookingCalendarSettings]);
 expect(await (await gapCall(app,path.replace('meeting-retry','meeting-status'))).json()).toMatchObject({data:{state:'unknown'}});
 expect(await (await gapCall(app,path,'POST',{},'same')).json()).toMatchObject({data:{outcome:'unavailable'}});
 expect(d.raw.prepare("SELECT status FROM booking_meeting_links WHERE id='link'").get()).toEqual({status:'pending'});
});
