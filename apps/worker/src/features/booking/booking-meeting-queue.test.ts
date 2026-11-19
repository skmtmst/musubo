import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {gapFixture,seedGapBooking} from '../../test-utils/gap1.js';
import {createConfirmedBookingMeeting} from './booking-meeting-create.js';
import {processMeetingQueue,type MeetingQueueDependencies} from './booking-meeting-queue.js';
let d:ReturnType<typeof gapFixture>;
beforeEach(async()=>{d=gapFixture();seedGapBooking(d);d.raw.exec("UPDATE bookings SET meeting_mode='online' WHERE id='bk'");await createConfirmedBookingMeeting(d.db,'bk',{provider:'zoom',create:async()=>({kind:'unknown'})});});
afterEach(()=>d.raw.close());
it('結果不明を照合し、見つからないときは運用者に知らせる',async()=>{
 d.raw.exec("UPDATE booking_meeting_links SET updated_at='2020-01-01T00:00:00Z'");
 const notify=vi.fn(async()=>{});
 const deps:MeetingQueueDependencies={resolve:async()=>({removers:{},verifiers:{zoom:{verifyCreate:async()=>({kind:'unknown'}),verifyDelete:async()=> 'unknown'}}}),notify};
 expect(await processMeetingQueue(d.db,deps)).toBe(1);
 expect(notify).toHaveBeenCalledWith({accountId:'a',bookingId:'bk',reason:'unknown'});
 expect(d.raw.prepare('SELECT status FROM booking_meeting_links').get()).toEqual({status:'pending'});
});
