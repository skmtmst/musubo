import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {gapFixture,seedGapBooking} from '../../test-utils/gap1.js';
import {createConfirmedBookingMeeting} from './booking-meeting-create.js';
import {verifyUnknownMeeting,type MeetingVerifier} from './booking-meeting-verify.js';
let d:ReturnType<typeof gapFixture>;
const verifier:MeetingVerifier={verifyCreate:vi.fn(async(input:{idempotencyKey:string})=>({kind:'found' as const,meetingId:'remote',url:'https://example.test/meeting',idempotencyKey:input.idempotencyKey})),verifyDelete:vi.fn(async()=> 'deleted' as const)};
beforeEach(async()=>{d=gapFixture();seedGapBooking(d);d.raw.exec("UPDATE bookings SET meeting_mode='online' WHERE id='bk'");await createConfirmedBookingMeeting(d.db,'bk',{provider:'zoom',create:async()=>({kind:'unknown'})});});
afterEach(()=>d.raw.close());
it('結果不明を読み取りで照合し、再送せず会議を記録する',async()=>{
 const row=d.raw.prepare('SELECT id FROM booking_meeting_links').get() as {id:string};
 expect(await verifyUnknownMeeting(d.db,{linkId:row.id,accountId:'b',verifier})).toBe('not_found');
 expect(await verifyUnknownMeeting(d.db,{linkId:row.id,accountId:'a',verifier})).toBe('verified');
 expect(d.raw.prepare('SELECT status,external_meeting_id FROM booking_meeting_links').get()).toEqual({status:'active',external_meeting_id:'remote'});
});
it('結果不明の間に予約日時が変わった会議は削除待ちにする',async()=>{
 const row=d.raw.prepare('SELECT id FROM booking_meeting_links').get() as {id:string};
 d.raw.exec("UPDATE bookings SET starts_at='2026-12-01T00:00:00Z',lock_version=lock_version+1 WHERE id='bk'");
 expect(await verifyUnknownMeeting(d.db,{linkId:row.id,accountId:'a',verifier})).toBe('verified');
 expect(d.raw.prepare('SELECT status FROM booking_meeting_links').get()).toEqual({status:'cancel_pending'});
});
it('削除の結果不明は読み取りで消去済みを確認する',async()=>{
 const row=d.raw.prepare('SELECT id FROM booking_meeting_links').get() as {id:string};
 await verifyUnknownMeeting(d.db,{linkId:row.id,accountId:'a',verifier});
 d.raw.exec("UPDATE booking_meeting_links SET status='cancel_pending',last_error_code='delete_unknown'");
 expect(await verifyUnknownMeeting(d.db,{linkId:row.id,accountId:'a',verifier})).toBe('verified');
 expect(d.raw.prepare('SELECT status,last_error_code FROM booking_meeting_links').get()).toEqual({status:'cancelled',last_error_code:null});
});
it('照合できなければ結果不明を維持する',async()=>{
 const row=d.raw.prepare('SELECT id FROM booking_meeting_links').get() as {id:string};
 const uncertain:MeetingVerifier={verifyCreate:async()=>({kind:'unknown'}),verifyDelete:async()=> 'unknown'};
 expect(await verifyUnknownMeeting(d.db,{linkId:row.id,accountId:'a',verifier:uncertain})).toBe('unknown');
 expect(d.raw.prepare('SELECT status,last_error_code FROM booking_meeting_links').get()).toEqual({status:'pending',last_error_code:'result_unknown'});
});
it('一意の鍵が違う会議と、検索で見つからない会議は確定しない',async()=>{
 const row=d.raw.prepare('SELECT id FROM booking_meeting_links').get() as {id:string};
 const mismatch:MeetingVerifier={verifyCreate:async()=>({kind:'found',meetingId:'other',url:'https://example.test/other',idempotencyKey:'different'}),verifyDelete:async()=> 'unknown'};
 expect(await verifyUnknownMeeting(d.db,{linkId:row.id,accountId:'a',verifier:mismatch})).toBe('unknown');
 const absent:MeetingVerifier={verifyCreate:async()=>({kind:'absent'}),verifyDelete:async()=> 'unknown'};
 expect(await verifyUnknownMeeting(d.db,{linkId:row.id,accountId:'a',verifier:absent})).toBe('unknown');
 expect(d.raw.prepare('SELECT status FROM booking_meeting_links').get()).toEqual({status:'pending'});
});
