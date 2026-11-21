import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {gapFixture,seedGapBooking} from '../../test-utils/gap1.js';
import {createConfirmedBookingMeeting} from './booking-meeting-create.js';
import {retryFailedMeeting} from './booking-meeting-retry.js';
import type {MeetingCreator} from './booking-meeting-create.js';
import type {MeetingVerifier} from './booking-meeting-verify.js';
let d:ReturnType<typeof gapFixture>;
const initial:MeetingCreator={provider:'zoom',create:async()=>({kind:'failed',code:'rejected'})};
beforeEach(async()=>{d=gapFixture();seedGapBooking(d);d.raw.exec("UPDATE bookings SET meeting_mode='online' WHERE id='bk'");await createConfirmedBookingMeeting(d.db,'bk',initial);});
afterEach(()=>d.raw.close());
function adapter(verify:'absent'|'unknown'='absent'){
 const create=vi.fn(async(_input:Parameters<MeetingCreator['create']>[0])=>({kind:'created' as const,meetingId:'remote',url:'https://zoom.us/j/123'}));
 const service:MeetingCreator & MeetingVerifier={provider:'zoom',create,verifyCreate:vi.fn(async()=>({kind:verify})),verifyDelete:async()=> 'unknown'};
 return {service,create};
}
it('確実な失敗を照合し、同じ目印で一度だけ発行し同じ要求は再送しない',async()=>{
 const {service,create}=adapter(),input={accountId:'a',bookingId:'bk',requestKey:'key',resolve:async()=>service};
 expect(await retryFailedMeeting(d.db,input)).toBe('created');expect(await retryFailedMeeting(d.db,input)).toBe('created');
 expect(create).toHaveBeenCalledOnce();expect(create.mock.calls[0][0].idempotencyKey).toBe('booking-meeting:bk:0');
 expect(d.raw.prepare('SELECT status FROM booking_meeting_links').get()).toEqual({status:'active'});
});
it('結果不明の会議は検査も作成もしない',async()=>{
 d.raw.exec("UPDATE booking_meeting_links SET status='pending',last_error_code='result_unknown'");
 const {service,create}=adapter();expect(await retryFailedMeeting(d.db,{accountId:'a',bookingId:'bk',requestKey:'key',resolve:async()=>service})).toBe('unavailable');
 expect(create).not.toHaveBeenCalled();expect(service.verifyCreate).not.toHaveBeenCalled();
});
it('照合できないときは再発行しない',async()=>{
 const {service,create}=adapter('unknown');expect(await retryFailedMeeting(d.db,{accountId:'a',bookingId:'bk',requestKey:'key',resolve:async()=>service})).toBe('unknown');expect(create).not.toHaveBeenCalled();
});
it('同時の異なる要求でも会議の作成は一度だけ',async()=>{
 const {service,create}=adapter();await Promise.all(['k1','k2'].map(requestKey=>retryFailedMeeting(d.db,{accountId:'a',bookingId:'bk',requestKey,resolve:async()=>service})));expect(create).toHaveBeenCalledOnce();
});
it('再発行の結果が不明なら、同じキーも別のキーも送り直さない',async()=>{
 const {service}=adapter();const create=vi.fn(async()=>({kind:'unknown' as const}));service.create=create;
 const base={accountId:'a',bookingId:'bk',resolve:async()=>service};
 expect(await retryFailedMeeting(d.db,{...base,requestKey:'k1'})).toBe('unknown');
 expect(await retryFailedMeeting(d.db,{...base,requestKey:'k1'})).toBe('unknown');
 expect(await retryFailedMeeting(d.db,{...base,requestKey:'k2'})).toBe('unavailable');
 expect(create).toHaveBeenCalledOnce();expect(d.raw.prepare('SELECT status,last_error_code FROM booking_meeting_links').get()).toEqual({status:'pending',last_error_code:'result_unknown'});
});
