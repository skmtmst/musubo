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
