import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { gapFixture, seedGapBooking } from '../../test-utils/gap1.js';
import { createConfirmedBookingMeeting, type MeetingCreator } from './booking-meeting-create.js';
import { meetingProvider } from './booking-meeting-providers.js';
let d: ReturnType<typeof gapFixture>;
beforeEach(() => { d=gapFixture(); d.raw.exec("UPDATE menus SET meeting_mode='online', fixed_meeting_url='https://example.test/fixed' WHERE id='menu'"); seedGapBooking(d); d.raw.exec("UPDATE bookings SET meeting_mode='online' WHERE id='bk'"); });
afterEach(() => d.raw.close());
it('同時の確定処理は会議を一つだけ作る', async () => {
 const create=vi.fn(async () => ({kind:'created' as const,meetingId:'remote',url:'https://example.test/new'}));
 const provider:MeetingCreator={provider:'zoom',create};
 await Promise.all([createConfirmedBookingMeeting(d.db,'bk',provider),createConfirmedBookingMeeting(d.db,'bk',provider)]);
 expect(create).toHaveBeenCalledTimes(1);
 expect(d.raw.prepare("SELECT status,meeting_url FROM booking_meeting_links").get()).toEqual({status:'active',meeting_url:'https://example.test/new'});
});
it('通信結果不明は自動で再送せず、固定URLを残す', async () => {
 const create=vi.fn(async () => {throw new Error('timeout')}); const provider:MeetingCreator={provider:'zoom',create};
 expect(await createConfirmedBookingMeeting(d.db,'bk',provider)).toBe('unknown');
 expect(await createConfirmedBookingMeeting(d.db,'bk',provider)).toBe('unknown');
 expect(create).toHaveBeenCalledTimes(1);
 expect(d.raw.prepare('SELECT meeting_url FROM bookings WHERE id=?').get('bk')).toEqual({meeting_url:'https://example.test/fixed'});
});
it.each(['google_meet','zoom','teams'] as const)('%s の応答が失われても外部への作成は再送しない', async provider => {
 const request=vi.fn(async()=>{throw new Error('response lost')});
 const adapter=meetingProvider(provider,async()=>({token:'fixture',accountId:'owner'}),request as unknown as typeof fetch);
 expect(await createConfirmedBookingMeeting(d.db,'bk',adapter)).toBe('unknown');
 expect(await createConfirmedBookingMeeting(d.db,'bk',adapter)).toBe('unknown');
 expect(request).toHaveBeenCalledTimes(1);
 expect(d.raw.prepare('SELECT status,last_error_code FROM booking_meeting_links').get()).toEqual({status:'pending',last_error_code:'result_unknown'});
});
it('発行失敗は予約を確定のまま残す', async () => {
 const provider:MeetingCreator={provider:'teams',create:async()=>({kind:'failed',code:'offline'})};
 expect(await createConfirmedBookingMeeting(d.db,'bk',provider)).toBe('failed');
 expect(d.raw.prepare('SELECT status FROM bookings WHERE id=?').get('bk')).toEqual({status:'confirmed'});
});
it('応答がないときは時間切れで照合待ちになり再送しない', async () => {
 vi.useFakeTimers();
 try {
  const create = vi.fn(() => new Promise<never>(() => {}));
  const provider:MeetingCreator={provider:'zoom',create};
  const pending=createConfirmedBookingMeeting(d.db,'bk',provider);
  await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  await vi.advanceTimersByTimeAsync(8000);
  expect(await pending).toBe('unknown');
  expect(d.raw.prepare('SELECT status,last_error_code FROM booking_meeting_links').get()).toEqual({status:'pending',last_error_code:'result_unknown'});
 } finally { vi.useRealTimers(); }
});
