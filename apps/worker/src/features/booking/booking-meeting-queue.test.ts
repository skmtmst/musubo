import {afterEach,beforeEach,expect,it} from 'vitest';
import {gapFixture,seedGapBooking} from '../../test-utils/gap1.js';
import {createConfirmedBookingMeeting} from './booking-meeting-create.js';
import {processMeetingQueue,type MeetingQueueDependencies} from './booking-meeting-queue.js';
let d:ReturnType<typeof gapFixture>;
beforeEach(async()=>{d=gapFixture();seedGapBooking(d);d.raw.exec("UPDATE bookings SET meeting_mode='online' WHERE id='bk'");await createConfirmedBookingMeeting(d.db,'bk',{provider:'zoom',create:async()=>({kind:'unknown'})});});
afterEach(()=>d.raw.close());
it('結果不明を照合し、見つからないときは運用者に知らせる',async()=>{
 d.raw.exec("UPDATE booking_meeting_links SET updated_at='2020-01-01T00:00:00Z'");
 const deps:MeetingQueueDependencies={resolve:async()=>({removers:{},verifiers:{zoom:{verifyCreate:async()=>({kind:'unknown'}),verifyDelete:async()=> 'unknown'}}})};
 expect(await processMeetingQueue(d.db,deps)).toBe(1);
 expect(d.raw.prepare("SELECT COUNT(*) n FROM notifications WHERE event_type='booking_meeting_issue'").get()).toEqual({n:1});
 d.raw.exec("UPDATE booking_meeting_links SET updated_at='2020-01-01T00:00:00Z'");
 await processMeetingQueue(d.db,deps);
 expect(d.raw.prepare("SELECT COUNT(*) n FROM notifications WHERE event_type='booking_meeting_issue'").get()).toEqual({n:1});
 expect(d.raw.prepare('SELECT status FROM booking_meeting_links').get()).toEqual({status:'pending'});
});
it('つなぎが使えないときも通知センターに一度だけ残す',async()=>{
 const deps:MeetingQueueDependencies={resolve:async()=>null};
 d.raw.exec("UPDATE booking_meeting_links SET updated_at='2020-01-01T00:00:00Z'");
 await processMeetingQueue(d.db,deps);
 d.raw.exec("UPDATE booking_meeting_links SET updated_at='2020-01-01T00:00:00Z'");
 await processMeetingQueue(d.db,deps);
 expect(d.raw.prepare("SELECT COUNT(*) n FROM notifications WHERE event_type='booking_meeting_issue'").get()).toEqual({n:1});
});
it('予約変更時は指定した店と予約だけを待たずに回復する',async()=>{
 const deps:MeetingQueueDependencies={resolve:async()=>({removers:{},verifiers:{zoom:{verifyCreate:async input=>({kind:'found',meetingId:'remote',url:'https://example.test/room',idempotencyKey:input.idempotencyKey}),verifyDelete:async()=> 'unknown'}}})};
 expect(await processMeetingQueue(d.db,deps,1,{bookingId:'bk',accountId:'b'})).toBe(0);
 expect(await processMeetingQueue(d.db,deps,1,{bookingId:'bk',accountId:'a'})).toBe(1);
 expect(d.raw.prepare("SELECT status FROM booking_meeting_links").get()).toEqual({status:'active'});
});
it('予約機能が停止中の店には回復処理を実行しない',async()=>{
 d.raw.exec("INSERT INTO account_settings(id,line_account_id,key,value) VALUES('stop','a','feature.booking','false'); UPDATE booking_meeting_links SET updated_at='2020-01-01T00:00:00Z'");
 let calls=0; const deps:MeetingQueueDependencies={resolve:async()=>{calls++;return null}};
 expect(await processMeetingQueue(d.db,deps)).toBe(0);expect(calls).toBe(0);
 expect(d.raw.prepare("SELECT COUNT(*) n FROM notifications WHERE event_type='booking_meeting_issue'").get()).toEqual({n:0});
});
it('削除できない旧会議は対応方法を一度知らせ、順番待ちから外す',async()=>{
 d.raw.exec(`UPDATE booking_meeting_links SET status='cancel_pending',external_meeting_id='old',last_error_code=NULL,updated_at='2020-01-01' WHERE booking_id='bk';
 INSERT INTO booking_meeting_links(id,booking_id,provider,status,idempotency_key,external_meeting_id,meeting_url,created_at,updated_at) VALUES('new','bk','teams','active','new-key','remote-new','https://example.test/new','2020-01-02','2020-01-02')`);
 const deps:MeetingQueueDependencies={resolve:async()=>({removers:{},verifiers:{},unavailable:[{staffId:'bs',provider:'zoom'}]})};
 expect(await processMeetingQueue(d.db,deps)).toBe(1);
 expect(d.raw.prepare("SELECT last_error_code FROM booking_meeting_links WHERE id!='new'").get()).toEqual({last_error_code:'manual_review'});
 const notice=d.raw.prepare("SELECT body FROM notifications WHERE body LIKE '%元の担当者%' ").get() as {body:string};
 expect(notice.body).toContain('相手先で削除');
 expect(d.raw.prepare("SELECT COUNT(*) n FROM notifications WHERE event_type='booking_meeting_issue'").get()).toEqual({n:1});
 expect(await processMeetingQueue(d.db,deps)).toBe(0);
});
