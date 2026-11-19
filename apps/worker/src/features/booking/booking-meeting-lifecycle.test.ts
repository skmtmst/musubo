import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { gapFixture, seedGapBooking } from '../../test-utils/gap1.js';
import { createConfirmedBookingMeeting, type MeetingCreator } from './booking-meeting-create.js';
import { reconcileBookingMeeting } from './booking-meeting-lifecycle.js';
let d:ReturnType<typeof gapFixture>;
const create=vi.fn(async()=>({kind:'created' as const,meetingId:'remote',url:'https://example.test/meeting'}));
const creator:MeetingCreator={provider:'zoom',create};
beforeEach(async()=>{create.mockClear();d=gapFixture();seedGapBooking(d);d.raw.exec("UPDATE bookings SET meeting_mode='online' WHERE id='bk'");await createConfirmedBookingMeeting(d.db,'bk',creator);});
afterEach(()=>d.raw.close());
it('日時変更は古い会議を削除してから新しく作る',async()=>{
 d.raw.exec("UPDATE bookings SET starts_at='2026-11-21T05:00:00Z',lock_version=lock_version+1 WHERE id='bk'");
 const remove=vi.fn(async()=> 'deleted' as const);
 create.mockResolvedValueOnce({kind:'created',meetingId:'new-remote',url:'https://example.test/new'});
 expect(await reconcileBookingMeeting(d.db,{bookingId:'bk',accountId:'a',removers:{zoom:{remove}},creator})).toBe('done');
 expect(remove).toHaveBeenCalledOnce();expect(create).toHaveBeenCalledTimes(2);
 expect((d.raw.prepare('SELECT status FROM booking_meeting_links ORDER BY status').all() as {status:string}[]).map(row=>row.status)).toEqual(['active','cancelled']);
});
it('取消は削除し、新しい会議を作らない',async()=>{
 d.raw.exec("UPDATE bookings SET status='cancelled',lock_version=lock_version+1 WHERE id='bk'");
 const remove=vi.fn(async()=> 'deleted' as const);
 expect(await reconcileBookingMeeting(d.db,{bookingId:'bk',accountId:'a',removers:{zoom:{remove}},creator})).toBe('done');
 expect(remove).toHaveBeenCalledOnce();expect(create).toHaveBeenCalledTimes(1);
});
it('削除の結果不明は新しい会議を作らず再送もしない',async()=>{
 d.raw.exec("UPDATE bookings SET starts_at='2026-11-21T05:00:00Z',lock_version=lock_version+1 WHERE id='bk'");
 const remove=vi.fn(async()=> 'unknown' as const);const input={bookingId:'bk',accountId:'a',removers:{zoom:{remove}},creator};
 expect(await reconcileBookingMeeting(d.db,input)).toBe('unknown');expect(await reconcileBookingMeeting(d.db,input)).toBe('unknown');
 expect(remove).toHaveBeenCalledOnce();expect(create).toHaveBeenCalledTimes(1);
});
it('削除が明確に失敗した場合は待ち行を残して後から再試行できる',async()=>{
 d.raw.exec("UPDATE bookings SET status='cancelled',lock_version=lock_version+1 WHERE id='bk'");
 const remove=vi.fn().mockResolvedValueOnce('failed').mockResolvedValueOnce('deleted');
 const input={bookingId:'bk',accountId:'a',removers:{zoom:{remove}},creator};
 expect(await reconcileBookingMeeting(d.db,input)).toBe('failed');
 expect(await reconcileBookingMeeting(d.db,input)).toBe('done');
 expect(remove).toHaveBeenCalledTimes(2);
 expect(d.raw.prepare('SELECT status FROM booking_meeting_links').get()).toEqual({status:'cancelled'});
});

it('旧担当の接続がなくても新担当の会議を作り、旧会議は要確認として残す',async()=>{
 d.raw.exec("UPDATE bookings SET starts_at='2026-11-21T05:00:00Z',lock_version=lock_version+1 WHERE id='bk'");
 create.mockResolvedValueOnce({kind:'created',meetingId:'new-remote',url:'https://example.test/new'});
 const old=d.raw.prepare('SELECT staff_id FROM booking_meeting_links').get() as {staff_id:string};
 const result=await reconcileBookingMeeting(d.db,{bookingId:'bk',accountId:'a',removers:{},creator,unavailable:[{staffId:old.staff_id,provider:'zoom'}]});
 expect(result).toBe('failed');
 expect((d.raw.prepare('SELECT status FROM booking_meeting_links ORDER BY status').all() as {status:string}[]).map(row=>row.status)).toEqual(['active','cancel_pending']);
 expect(create).toHaveBeenCalledTimes(2);
});
