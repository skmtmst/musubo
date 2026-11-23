import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {liffActionFromUrl} from '@line-crm/shared';
import {createTestD1,type SqliteD1} from '../test-utils/d1-sqlite.js';
import {notifyForBooking,previewBookingConfirmation} from '../features/booking/booking-notification.js';
import {getBookingAdminDetail} from '../features/booking/booking-admin-detail.js';
import {processDueReminders} from '../features/booking/booking-reminders.js';
import {prepareEventNotification} from './event-notification-plan.js';
import {sendBookingNotification,type SendNotificationParams} from '../features/booking/booking-notifier.js';
vi.mock('../features/booking/booking-notifier.js',async original=>({...await original<typeof import('../features/booking/booking-notifier.js')>(),sendBookingNotification:vi.fn(async()=>{})}));
vi.mock('./feature-enforcement.js',()=>({featureJobCanRun:async()=>true}));
let item:SqliteD1;
const NOW=new Date('2026-11-02T00:00:00Z');
beforeEach(()=>{
 vi.useFakeTimers();vi.setSystemTime(NOW);vi.clearAllMocks();item=createTestD1();
 item.raw.exec(`INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,liff_id)VALUES('a','c','A','token','secret','liff-a');
 INSERT INTO friends(id,line_user_id,line_account_id,is_following)VALUES('f','U-f','a',1);
 INSERT INTO staff(id,line_account_id,name,display_name)VALUES('s','a','teacher','teacher');
 INSERT INTO menus(id,line_account_id,name,duration_minutes,base_price,cancel_deadline_hours_before)VALUES('m','a','class-original',60,100,24);
 INSERT INTO booking_settings(id,line_account_id,timezone,cancel_deadline_minutes_before)VALUES('settings','a','Asia/Tokyo',60);
 INSERT INTO account_styles(line_account_id,style,updated_at)VALUES('a','lesson','2026-10-01');
 INSERT INTO bookings(id,line_account_id,friend_id,staff_id,menu_id,starts_at,ends_at,block_ends_at,status,price_at_booking,requested_at,notification_policy_snapshot)
 VALUES('b','a','f','s','m','2026-11-04T00:00:00Z','2026-11-04T01:00:00Z','2026-11-04T01:00:00Z','confirmed',100,'2026-10-01','{}');`);
});
afterEach(()=>{item.raw.close();vi.useRealTimers();});
const sent=()=>vi.mocked(sendBookingNotification).mock.calls[0]![0];
const text=()=>JSON.stringify(sent().messages);
it('uses the real same-account history action and the menu deadline',async()=>{
 await notifyForBooking(item.db,'b','approved');
 expect(sendBookingNotification).toHaveBeenCalledOnce();
 expect(sent().ctx.style).toBe('lesson');expect(text()).toContain('クラス: class-original');expect(text()).toContain('講師: teacher');
 expect(sent().ctx.selfManagement?.deadlineLabel).toBe('2026-11-03 09:00');
 expect(liffActionFromUrl(sent().ctx.selfManagement!.historyUrl)).toEqual({kind:'booking_history'});
 expect(new URL(sent().ctx.selfManagement!.historyUrl).pathname).toBe('/liff-a/');
 expect(text()).toContain('期限後は教室にLINEでご連絡ください');
});
it.each(['expired','no_liff','invalid_liff','legacy_version'])('keeps contact-only guidance when self-service is unavailable: %s',async mode=>{
 if(mode==='expired')vi.setSystemTime(new Date('2026-11-03T01:00:00Z'));
 if(mode==='no_liff')item.raw.exec('UPDATE line_accounts SET liff_id=NULL');
 if(mode==='invalid_liff')item.raw.exec("UPDATE line_accounts SET liff_id='wrong/path'");
 if(mode==='legacy_version')item.raw.exec('UPDATE bookings SET lock_version=-1');
 await notifyForBooking(item.db,'b','approved');
 expect(sent().ctx.selfManagement).toBeUndefined();expect(text()).not.toContain('https://liff.line.me/');
 expect(text()).toContain('変更・キャンセルは教室にLINEでご連絡ください');
});
it('uses the store deadline when the menu inherits it, including the exact boundary',async()=>{
 item.raw.exec('UPDATE menus SET cancel_deadline_hours_before=NULL');
 vi.setSystemTime(new Date('2026-11-03T23:00:00Z'));
 await notifyForBooking(item.db,'b','approved');expect(sent().ctx.selfManagement?.deadlineLabel).toBe('2026-11-04 08:00');
});
it('fee-policy cancellation remains available until the same start boundary as LIFF',async()=>{
 const policy={enabled:true,tiers:[{beforeHours:24,percent:0},{beforeHours:0,percent:50}],noShowPercent:100,version:1};
 item.raw.prepare('UPDATE bookings SET policy_snapshot_json=?').run(JSON.stringify(policy));
 vi.setSystemTime(new Date('2026-11-03T01:00:00Z'));
 await notifyForBooking(item.db,'b','approved');expect(sent().ctx.selfManagement?.deadlineLabel).toBe('2026-11-04 09:00');
 expect(text()).toContain('50%');
});
it('preserves the first rendered reminder and key and never replays an unknown send after a style change',async()=>{
 item.raw.exec("INSERT INTO booking_reminders(id,booking_id,kind,scheduled_at)VALUES('r','b','day_before','2026-11-02T00:00:00.000Z')");
 const sends:Array<Pick<SendNotificationParams,'messages'|'retryKey'>>=[];
 const sender=vi.fn(async(params:SendNotificationParams)=>{sends.push({messages:structuredClone(params.messages),retryKey:params.retryKey});if(sends.length===1)throw new Error('lost response');});
 await processDueReminders(item.db,{now:NOW,sender});
 expect(sends).toHaveLength(1);expect(JSON.stringify(sends[0]!.messages)).toContain('クラス: class-original');
 item.raw.exec("UPDATE account_styles SET style='consult';UPDATE menus SET name='edited';UPDATE staff SET display_name='edited'");
 vi.advanceTimersByTime(60_000);await processDueReminders(item.db,{now:new Date(),sender});
 expect(sends).toHaveLength(1);
 const row=item.raw.prepare('SELECT status,last_error,retry_count,messages_json,retry_key FROM booking_reminders').get() as {messages_json:string};
 expect(row).toMatchObject({status:'failed_permanent',last_error:'delivery_unknown',retry_count:1,retry_key:sends[0]!.retryKey});
 expect(JSON.parse(row.messages_json)).toEqual(sends[0]!.messages);expect(row.messages_json).toContain('クラス: class-original');
});

it('freezes the configured event words in the existing notification plan',async()=>{
 item.raw.exec(`INSERT INTO events(id,line_account_id,name)VALUES('e','a','class-event');
 INSERT INTO event_slots(id,event_id,starts_at,ends_at,capacity)VALUES('es','e','2026-11-04T00:00:00Z','2026-11-04T01:00:00Z',10);
 INSERT INTO event_bookings(id,line_account_id,event_id,slot_id,friend_id,status,requested_at,identity_key)
 VALUES('eb','a','e','es','f','requested','2026-11-02T00:00:00Z','event-person');`);
 const input={accountId:'a',operationId:'event-words',to:'U-f',kind:'received_pending' as const,
   ctx:{eventName:'class-event',startsAtJst:'2026-11-04 09:00'},
   subject:{bookingId:'eb',slotId:'es',status:'requested' as const,startsAt:'2026-11-04T00:00:00Z'},now:NOW};
 await (await prepareEventNotification(item.db,input)).run();
 const before=item.raw.prepare("SELECT input_json FROM workflow_steps WHERE subject_id='event-words'").get() as {input_json:string};
 expect(before.input_json).toContain('クラス: class-event');expect(before.input_json).toContain('教室の確認');expect(before.input_json).not.toContain('運営の承認');
 item.raw.exec("UPDATE account_styles SET style='consult'");
 await (await prepareEventNotification(item.db,input)).run();
 expect(item.raw.prepare("SELECT input_json FROM workflow_steps WHERE subject_id='event-words'").get()).toEqual(before);
});

it('returns the same confirmation text through the existing detail API without sending or leaking credentials',async()=>{
 item.raw.exec("UPDATE line_accounts SET channel_access_token='private-synthetic-credential'");
 const detail=await getBookingAdminDetail(item.db,{id:'b',lineAccountId:'a'});
 expect(detail?.confirmationPreviewText).toContain('クラス: class-original');
 expect(JSON.stringify(detail)).not.toContain('private-synthetic-credential');expect(sendBookingNotification).not.toHaveBeenCalled();
 expect(item.raw.prepare('SELECT COUNT(*) n FROM booking_operation_runs').get()).toEqual({n:0});
 expect(item.raw.prepare('SELECT COUNT(*) n FROM workflow_steps').get()).toEqual({n:0});
 expect(await previewBookingConfirmation(item.db,'b','other-account')).toBeNull();
 await notifyForBooking(item.db,'b','approved');
 const message=sent().messages?.[0];expect(message?.type).toBe('text');
 if(message?.type==='text')expect(message.text).toBe(detail?.confirmationPreviewText);
});

it('keeps booking details readable when damaged legacy policy prevents a safe preview',async()=>{
 const log=vi.spyOn(console,'warn').mockImplementation(()=>{});
 try {
  item.raw.exec("UPDATE bookings SET policy_snapshot_json='{}'");
  const detail=await getBookingAdminDetail(item.db,{id:'b',lineAccountId:'a'});
  expect(detail?.id).toBe('b');expect(detail?.confirmationPreviewText).toBeNull();
  expect(sendBookingNotification).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledOnce();
  expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({
   timestamp: NOW.toISOString(), level: 'warn', code: 'booking_confirmation_preview_failed',
   requestId: null, invocationId: null, source: 'background',
  });
 }finally{log.mockRestore();}
});
it('会議の自動URLは予約の版が変わっても案内し、手入力を優先する',async()=>{
 item.raw.exec(`UPDATE bookings SET meeting_mode='online',meeting_url='https://example.test/fixed',meeting_url_source='menu' WHERE id='b';
 INSERT INTO booking_meeting_links(id,booking_id,provider,external_meeting_id,meeting_url,status,idempotency_key,created_at,updated_at)
 VALUES('link','b','zoom','remote','https://example.test/automatic','active','key','now','now');
 UPDATE bookings SET lock_version=lock_version+1 WHERE id='b';`);
 expect(await previewBookingConfirmation(item.db,'b','a',NOW)).toContain('https://example.test/automatic');
 item.raw.exec("UPDATE bookings SET meeting_url='https://example.test/manual',meeting_url_source='manual' WHERE id='b'");
 expect(await previewBookingConfirmation(item.db,'b','a',NOW)).toContain('https://example.test/manual');
});
