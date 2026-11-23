import {getNotificationCenter} from '@line-crm/db';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {gapFixture,seedGapBooking} from '../../test-utils/gap1.js';
import {notifyMeetingIssue} from './booking-meeting-notice.js';
let d:ReturnType<typeof gapFixture>;
beforeEach(()=>{d=gapFixture();seedGapBooking(d);d.raw.exec("INSERT INTO booking_meeting_links(id,booking_id,provider,status,idempotency_key,created_at,updated_at) VALUES('link','bk','zoom','pending','key','now','now')")});
afterEach(()=>d.raw.close());
it('同じ会議の同じ問題は一度だけ表示し、別アカウントには作らない',async()=>{
 const input={accountId:'a',bookingId:'bk',linkId:'link',reason:'unknown' as const};
 await Promise.all([notifyMeetingIssue(d.db,input),notifyMeetingIssue(d.db,input)]);
 await notifyMeetingIssue(d.db,{...input,reason:'failed'});
 await notifyMeetingIssue(d.db,{...input,accountId:'b'});
 const rows=d.raw.prepare("SELECT line_account_id,body,category,metadata FROM notifications WHERE event_type='booking_meeting_issue'").all() as {line_account_id:string;body:string;category:string;metadata:string}[];
 const center=await getNotificationCenter(d.db,{lineAccountId:'a',staffId:'o'});
 expect(center).toHaveLength(1);expect(center[0].event_type).toBe('booking_meeting_issue');
 expect(rows).toHaveLength(1);expect(rows[0].line_account_id).toBe('a');expect(rows[0].category).toBe('error');
 expect(rows[0].body).not.toContain('https://');expect(rows[0].metadata).toBe('{"bookingId":"bk"}');
});
