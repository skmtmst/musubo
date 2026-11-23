import { deleteCustomerData } from './customer-data-deletion.js';
import { prepareEventNotification } from './event-notification-plan.js';
import { bookingPassPlans } from '../routes/booking-pass-plans.js';
import { absence,useMakeup } from '../features/booking/booking-makeup.js';
import { cancelByTrigger } from './reminder-trigger.js';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import events from '../routes/events.js';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import { entitlementUseStatement, entitlementViews, grantEntitlement } from '../features/booking/booking-entitlements.js';
import { discardUnacceptedEventBooking, eventEntitlementUse, returnEventEntitlement, transferEventEntitlement, validateEventEntitlement } from './event-entitlements.js';
import { registerMeetConsultation, cancelMeetConsultation, processDueMeetConsultationReminders } from './meet-consultation-reminders.js';
import { recoverEventTransitions } from './event-transition-recovery.js';
import { passPlanInput } from '../features/booking/booking-pass-plans.js';

vi.mock('./account-access.js',()=>({canAccessAllLineAccounts:async(_db:unknown,_staff:unknown,ids:string[])=>ids.every(id=>id==='a')}));
vi.mock('./liff-auth.js',()=>({verifyCallerLineUserId:vi.fn(async()=> 'Uf')}));
vi.mock('./event-booking-notifier.js',async original=>({...await original<typeof import('./event-booking-notifier.js')>(),sendEventBookingNotification:vi.fn(async()=>{})}));
vi.mock('./reminder-trigger.js',()=>({cancelByTrigger:vi.fn(async()=>({})),enrollByTrigger:vi.fn(async()=>({})),reconcileV6ToStartsAt:vi.fn(async()=>({}))}));
let f: ReturnType<typeof createTestD1>;
beforeEach(()=>{
  f=createTestD1({foreignKeys:true});
  f.raw.exec(`INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES('a','a','A','synthetic','synthetic'),('b','b','B','synthetic','synthetic');
    INSERT INTO friends(id,line_user_id,line_account_id,is_following) VALUES('f','Uf','a',1),('other','Uother','a',1),('foreign','Uforeign','b',1);
    INSERT INTO staff(id,line_account_id,name,display_name) VALUES('s','a','担当','担当');
    INSERT INTO menus(id,line_account_id,name,duration_minutes,base_price,concurrent_capacity) VALUES('m','a','授業',30,0,100);
    INSERT INTO events(id,line_account_id,name,is_published,lifecycle_status,cancel_deadline_hours_before,requires_approval) VALUES('class','a','クラス',1,'published',24,0),('foreign-class','b','別店',1,'published',24,0);
    INSERT INTO event_slots(id,event_id,starts_at,ends_at,capacity,is_active) VALUES('slot','class','2030-01-10T01:00:00Z','2030-01-10T02:00:00Z',10,1),('next','class','2030-01-11T01:00:00Z','2030-01-11T02:00:00Z',10,1),('foreign-slot','foreign-class','2030-01-10T01:00:00Z','2030-01-10T02:00:00Z',10,1);`);
});
afterEach(()=>{f.raw.close();vi.clearAllMocks();});
const now=new Date('2030-01-01T00:00:00Z');
async function grant(kind:'ticket'|'monthly'='ticket',limit:number|null=1){
  f.raw.prepare(`INSERT INTO booking_pass_plans(id,line_account_id,kind,name,price,count,monthly_limit,valid_days,target_scope_json,event_target_scope_json,status,created_by,created_at,idempotency_key,request_json)
    VALUES('plan','a',?,'プラン',0,?,?,365,'[]','["class"]','on_sale','staff','2029-01-01','key','{}')`)
    .run(kind,kind==='ticket'?limit:null,kind==='monthly'?limit:null);
  return (await grantEntitlement(f.db,'a','staff','grant',{planId:'plan',friendId:'f',validFrom:'2029-12-01T00:00:00Z',reason:'手動付与'})).data;
}
function booking(id:string,status='requested',account='a',friend='f',slot='slot',event='class'){
  f.raw.prepare(`INSERT INTO event_bookings(id,line_account_id,event_id,slot_id,friend_id,status,requested_at,identity_key) VALUES(?,?,?,?,?,?,?,?)`)
    .run(id,account,event,slot,friend,status,'2029-12-01',id);
}
async function use(id:string,entitlement:string,status='confirmed'){
  await f.db.batch([f.db.prepare(`INSERT INTO event_bookings(id,line_account_id,event_id,slot_id,friend_id,status,requested_at,identity_key)
    VALUES(?,'a','class','slot','f',?,'2029-12-01',?)`).bind(id,status,id),await eventEntitlementUse(f.db,'a',id,entitlement,'2030-01-10T01:00:00Z')]);
}
test('a class request selects without consumption; approval consumes once and a timely cancellation returns once',async()=>{
  const e=await grant();await use('request',e.id,'requested');
  expect(f.raw.prepare('SELECT remaining FROM booking_entitlements').get()).toEqual({remaining:1});
  f.raw.exec("UPDATE event_bookings SET status='confirmed' WHERE id='request';UPDATE event_bookings SET status='confirmed' WHERE id='request'");
  expect(f.raw.prepare('SELECT remaining FROM booking_entitlements').get()).toEqual({remaining:0});
  f.raw.exec("UPDATE event_bookings SET status='cancelled',cancelled_at='2030-01-01T00:00:00Z' WHERE id='request'");
  await returnEventEntitlement(f.db,'a','request');await returnEventEntitlement(f.db,'a','request');
  expect(f.raw.prepare('SELECT remaining FROM booking_entitlements').get()).toEqual({remaining:1});
  expect(f.raw.prepare("SELECT COUNT(*) n FROM booking_entitlement_events WHERE request_key LIKE 'event-return:%'").get()).toEqual({n:1});
});
test.each(['ticket','monthly'] as const)('%s: a regular booking and a class compete for the same final allowance',async kind=>{
  const e=await grant(kind,1);
  f.raw.exec(`INSERT INTO bookings(id,line_account_id,friend_id,staff_id,menu_id,starts_at,ends_at,block_ends_at,status,price_at_booking,requested_at)
    VALUES('regular','a','f','s','m','2030-01-10T04:00:00Z','2030-01-10T04:30:00Z','2030-01-10T04:30:00Z','requested',0,'2029-12-01')`);
  await entitlementUseStatement(f.db,'regular',e.id,'2030-01-10T04:00:00Z','Asia/Tokyo').run();
  await use('class-request',e.id,'requested');
  const winners=await Promise.allSettled([
    f.db.prepare("UPDATE bookings SET status='confirmed' WHERE id='regular'").run(),
    f.db.prepare("UPDATE event_bookings SET status='confirmed' WHERE id='class-request'").run(),
  ]);
  expect(winners.map(r=>r.status).sort()).toEqual(['fulfilled','rejected']);
  expect((await entitlementViews(f.db,'a','f','2030-01-10T04:00:00Z'))[0]).toMatchObject(kind==='ticket'?{remaining:0}:{monthUsed:1,monthRemaining:0});
});
test('the reverse race also rejects the regular booking and rolls back its status',async()=>{
  const e=await grant('monthly',1);await use('class-first',e.id);
  f.raw.exec(`INSERT INTO bookings(id,line_account_id,friend_id,staff_id,menu_id,starts_at,ends_at,block_ends_at,status,price_at_booking,requested_at)
    VALUES('regular','a','f','s','m','2030-01-10T04:00:00Z','2030-01-10T04:30:00Z','2030-01-10T04:30:00Z','requested',0,'2029-12-01')`);
  await entitlementUseStatement(f.db,'regular',e.id,'2030-01-10T04:00:00Z','Asia/Tokyo').run();
  await expect(f.db.prepare("UPDATE bookings SET status='confirmed' WHERE id='regular'").run()).rejects.toThrow('entitlement_unavailable');
  expect(f.raw.prepare("SELECT status FROM bookings WHERE id='regular'").get()).toEqual({status:'requested'});
});
test('unlimited monthly passes use null, preserve explicit finite month overrides, and never coerce zero or missing limits',async()=>{
  const e=await grant('monthly',null);
  expect(passPlanInput({kind:'monthly',name:'月謝',price:0,count:null,monthlyLimit:null,validDays:30,menuIds:[],allowWithoutPass:true}).monthlyLimit).toBeNull();
  for(const monthlyLimit of [0,-1,undefined])expect(()=>passPlanInput({kind:'monthly',name:'月謝',price:0,monthlyLimit,validDays:30,menuIds:[],allowWithoutPass:true})).toThrow();
  for(let n=0;n<3;n++)await use(`unlimited-${n}`,e.id);
  const view=(await entitlementViews(f.db,'a','f','2030-01-10T04:00:00Z'))[0]!;
  expect(view).toMatchObject({monthly_limit:null,monthAllowance:null,monthUsed:3,monthRemaining:null});
  f.raw.prepare('INSERT INTO booking_entitlement_month_limits VALUES(?,?,?,?)').run(e.id,view.periodStart,view.periodEnd,3);
  await expect(use('finite-override',e.id)).rejects.toThrow('entitlement_unavailable');
  expect(f.raw.prepare("SELECT id FROM event_bookings WHERE id='finite-override'").get()).toBeUndefined();
});
test('foreign person/account, expired pass and unset or unrelated event scopes are rejected before and during consumption',async()=>{
  const e=await grant();
  for(const [account,friend,event] of [['b','foreign','foreign-class'],['a','other','class'],['a','f','foreign-class']])
    await expect(validateEventEntitlement(f.db,account!,friend!,event!,e.id,'2030-01-10T01:00:00Z')).rejects.toThrow('entitlement_unavailable');
  await expect(validateEventEntitlement(f.db,'a','f','class',e.id,'2040-01-10T01:00:00Z')).rejects.toThrow();
  for(const scope of [null,'["different-class"]']){
    f.raw.prepare('UPDATE booking_pass_plans SET event_target_scope_json=?').run(scope);
    await expect(use('denied',e.id)).rejects.toThrow('entitlement_unavailable');
    expect(f.raw.prepare("SELECT id FROM event_bookings WHERE id='denied'").get()).toBeUndefined();
  }
});
test('changing occurrences transfers the consumed use and deleting customer data retains its usage history',async()=>{
  const e=await grant();await use('old',e.id);booking('new','confirmed','a','f','next');
  await f.db.batch([f.db.prepare("UPDATE event_bookings SET status='cancelled' WHERE id='old'"),await transferEventEntitlement(f.db,'a','old','new','2030-01-11T01:00:00Z')]);
  await returnEventEntitlement(f.db,'a','old');
  expect(f.raw.prepare('SELECT event_booking_id,event_booking_id_history,consumed_at FROM event_booking_entitlement_uses').get()).toMatchObject({event_booking_id:'new',event_booking_id_history:'old',consumed_at:expect.any(String)});
  expect(f.raw.prepare('SELECT remaining FROM booking_entitlements').get()).toEqual({remaining:0});
  f.raw.exec("DELETE FROM event_bookings WHERE id='new'");
  expect(f.raw.prepare('SELECT event_booking_id,event_booking_id_history,returned_at FROM event_booking_entitlement_uses').get()).toEqual({event_booking_id:null,event_booking_id_history:'old',returned_at:null});
  expect(f.raw.prepare('SELECT remaining FROM booking_entitlements').get()).toEqual({remaining:0});
});
test('absence with a makeup credit never refunds the original pass',async()=>{
  const e=await grant();await use('absent',e.id);
  f.raw.exec("UPDATE event_bookings SET status='cancelled',absence_reported_at='2030-01-01',cancelled_at='2030-01-01' WHERE id='absent'");
  await returnEventEntitlement(f.db,'a','absent');
  expect(f.raw.prepare('SELECT remaining FROM booking_entitlements').get()).toEqual({remaining:0});
});
test('a schedule change advances every affected booking and preserves complete transition generations after rollback',async()=>{
  booking('request','requested');
  f.raw.exec("UPDATE event_bookings SET status='cancelled' WHERE id='request';UPDATE event_bookings SET status='requested' WHERE id='request';UPDATE event_slots SET starts_at='2030-01-12T01:00:00Z' WHERE id='slot'");
  expect(f.raw.prepare("SELECT lock_version FROM event_bookings WHERE id='request'").get()).toEqual({lock_version:4});
  expect(f.raw.prepare('SELECT booking_version FROM event_booking_transition_runs ORDER BY booking_version').all()).toEqual([{booking_version:2},{booking_version:3},{booking_version:4}]);
  await recoverEventTransitions(f.db,now,100);
  expect(f.raw.prepare('SELECT status FROM event_booking_transition_runs ORDER BY booking_version').all()).toEqual([{status:'obsolete'},{status:'obsolete'},{status:'complete'}]);
});
test('Meet rescheduling appends a new pair without changing sent/unknown history, retrying never creates another pair, cancellation stops only pending work',async()=>{
  const input={externalEventId:'external',friendId:'f',title:'相談',startsAt:'2030-01-10T01:00:00Z',endsAt:'2030-01-10T02:00:00Z',meetUrl:'https://meet.google.com/abc-defg-hij'};
  const first=await registerMeetConsultation(f.db,input,now);
  f.raw.exec("UPDATE meet_consultation_notification_runs SET status='sent',sent_at='2030-01-09' WHERE kind='day_before';UPDATE meet_consultation_notification_runs SET status='failed',retry_count=3,last_error='delivery_unknown' WHERE kind='hour_before'");
  const history=f.raw.prepare('SELECT * FROM meet_consultation_notification_runs ORDER BY id').all();
  const next={...input,startsAt:'2030-01-12T01:00:00Z',endsAt:'2030-01-12T02:00:00Z'};
  await registerMeetConsultation(f.db,next,now);await registerMeetConsultation(f.db,next,now);
  expect(f.raw.prepare('SELECT schedule_revision,COUNT(*) n FROM meet_consultation_notification_runs GROUP BY schedule_revision ORDER BY schedule_revision').all()).toEqual([{schedule_revision:0,n:2},{schedule_revision:1,n:2}]);
  expect(f.raw.prepare("SELECT * FROM meet_consultation_notification_runs WHERE status='sent'").get()).toEqual((history as Array<{status:string}>).find(r=>r.status==='sent'));
  expect(f.raw.prepare("SELECT retry_count,last_error FROM meet_consultation_notification_runs WHERE schedule_revision=0 AND kind='hour_before'").get()).toEqual({retry_count:3,last_error:'delivery_unknown'});
  await cancelMeetConsultation(f.db,'external',now);
  expect(f.raw.prepare("SELECT COUNT(*) n FROM meet_consultation_notification_runs WHERE status='pending'").get()).toEqual({n:0});
  expect(first.id).toBeTruthy();
});
test('Meet parent and its planned reminders roll back together if a child insert fails',async()=>{
  f.raw.exec("CREATE TRIGGER fail_meet_child BEFORE INSERT ON meet_consultation_notification_runs BEGIN SELECT RAISE(ABORT,'synthetic_failure');END;");
  await expect(registerMeetConsultation(f.db,{externalEventId:'failure',friendId:'f',title:'相談',startsAt:'2030-01-10T01:00:00Z',endsAt:'2030-01-10T02:00:00Z',meetUrl:'https://meet.google.com/abc-defg-hij'},now)).rejects.toThrow('synthetic_failure');
  expect(f.raw.prepare('SELECT COUNT(*) n FROM meet_consultations').get()).toEqual({n:0});
});
test('the Meet cron cannot send an obsolete generation and still uses the original three-attempt budget',async()=>{
  const input={externalEventId:'external',friendId:'f',title:'相談',startsAt:'2030-01-10T01:00:00Z',endsAt:'2030-01-10T02:00:00Z',meetUrl:'https://meet.google.com/abc-defg-hij'};
  await registerMeetConsultation(f.db,input,now);
  await registerMeetConsultation(f.db,{...input,startsAt:'2030-02-10T01:00:00Z',endsAt:'2030-02-10T02:00:00Z'},now);
  const dispatch=vi.fn(async()=>new Response('{}',{status:200}));
  expect(await processDueMeetConsultationReminders(f.db,{now:new Date('2030-01-09T02:00:00Z'),proxyBaseUrl:'https://proxy.invalid',proxyDispatch:dispatch})).toEqual({sent:0,failed:0});
  expect(dispatch).not.toHaveBeenCalled();
  expect(()=>f.raw.exec('UPDATE meet_consultation_notification_runs SET retry_count=4')).toThrow();
});

test('the approved nullable table rebuild preserves populated plans, balances, uses, audit rows and all foreign keys',async()=>{
  const e=await grant('ticket',2);await use('class-use',e.id);
  const tables=['booking_pass_plans','booking_entitlements','event_booking_entitlement_uses','booking_entitlement_events'];
  // migration 734 precedes the tombstone column added in migration 790.
  f.raw.exec('ALTER TABLE booking_pass_plans DROP COLUMN data_purged_at');
  const before=tables.map(table=>f.raw.prepare(`SELECT * FROM ${table}`).all());
  const sql=readFileSync(new URL('../../../../packages/db/migrations/734_unlimited_monthly_passes.sql',import.meta.url),'utf8');
  // 後から追加された月謝の依存物は過去の作り直しの対象外。
  // 試験の空の月謝schemaだけを一時的に外し、同じtransactionで完全に戻す。
  const extensions=f.raw.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN('view','trigger') AND sql LIKE '%booking_monthly_%'").all() as Array<{type:string;name:string;sql:string}>;
  const planIndex=f.raw.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='monthly_plan_scope'").get() as {sql:string}|undefined;
  const replacedTriggers=new Set([...sql.matchAll(/DROP TRIGGER (\w+)/g)].map(match=>match[1]));
  const rename='ALTER TABLE booking_pass_plans_new RENAME TO booking_pass_plans;';
  expect(sql.split(rename)).toHaveLength(2);
  f.raw.transaction(()=>{
    for(const entry of extensions)if(entry.type==='view'||!replacedTriggers.has(entry.name))f.raw.exec(`DROP ${entry.type} "${entry.name}"`);
    f.raw.exec(sql.replace(rename,rename+(planIndex?`\n${planIndex.sql};`:'')));
    for(const entry of extensions){f.raw.exec(`DROP ${entry.type} IF EXISTS "${entry.name}"`);f.raw.exec(entry.sql);}
  })();
  for(const entry of extensions)expect(f.raw.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').get(entry.type,entry.name)).toEqual({sql:entry.sql});
  expect(tables.map(table=>f.raw.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
  expect(f.raw.pragma('foreign_key_check')).toEqual([]);
  await use('after-rebuild',e.id);
  expect(f.raw.prepare('SELECT remaining FROM booking_entitlements').get()).toEqual({remaining:0});
});
test("the existing LIFF intake accepts a selected class pass, replays the same request once and rejects another person's grant",async()=>{
  const e=await grant();f.raw.exec("UPDATE line_accounts SET liff_id='liff-a' WHERE id='a'");
  const app=new Hono<Env>();app.route('/',events);
  const send=(key:string,entitlement:string)=>app.request('/api/liff/events/class/bookings?liffId=liff-a',{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer synthetic','Idempotency-Key':key},
    body:JSON.stringify({slot_id:'slot',entitlement_id:entitlement}),
  },{DB:f.db} as Env['Bindings']);
  const first=await send('one',e.id);expect(first.status).toBe(201);const body=await first.json();
  expect(await (await send('one',e.id)).json()).toEqual(body);
  expect(f.raw.prepare('SELECT remaining FROM booking_entitlements').get()).toEqual({remaining:0});
  expect(f.raw.prepare("SELECT COUNT(*) n FROM booking_entitlement_events WHERE action='consume'").get()).toEqual({n:1});
  // 重複予約の解決より先に、選択先の権限境界を確認する。
  f.raw.exec("UPDATE booking_entitlements SET friend_id='other',remaining=1");
  const denied=await send('different-key',e.id);expect(denied.status).toBe(409);
  expect(JSON.stringify(await denied.json())).not.toContain('Uother');
});

test('a cancelled transition resumes after a busy reminder fence without refunding or scheduling its notification twice',async()=>{
  const e=await grant();await use('recovery',e.id);
  f.raw.exec("UPDATE event_bookings SET status='cancelled',cancelled_by='admin',cancelled_at='2030-01-01T00:00:00Z' WHERE id='recovery'");
  vi.mocked(cancelByTrigger).mockRejectedValueOnce(new Error('REMINDER_SEND_IN_FLIGHT'));
  await recoverEventTransitions(f.db,now,100);
  expect(f.raw.prepare('SELECT status FROM event_booking_transition_runs').get()).toEqual({status:'pending'});
  expect(f.raw.prepare('SELECT remaining FROM booking_entitlements').get()).toEqual({remaining:0});
  await recoverEventTransitions(f.db,now,100);await recoverEventTransitions(f.db,now,100);
  expect(f.raw.prepare('SELECT status FROM event_booking_transition_runs').get()).toEqual({status:'complete'});
  expect(f.raw.prepare('SELECT remaining FROM booking_entitlements').get()).toEqual({remaining:1});
  expect(f.raw.prepare("SELECT COUNT(*) n FROM workflow_steps WHERE process_kind='booking_line_delivery'").get()).toEqual({n:1});
});
test('a consumed class pass grants one makeup credit, does not refund on absence, and does not consume a second pass at the replacement class',async()=>{
  const e=await grant();await use('absence-source',e.id);
  f.raw.prepare('UPDATE events SET makeup_rule_json=? WHERE id=?').run(JSON.stringify({enabled:true,cutoffHours:24,validDays:30,monthlyCap:10,target:'same_kind',targetIds:[]}),'class');
  const result=await absence(f.db,'a','f','absence-source','customer');
  const credit=result.makeupCredit as {id:string;entitlement_id:string};expect(credit.entitlement_id).toBe(e.id);
  await useMakeup(f.db,'a','f',credit.id,'next','makeup-key');
  await useMakeup(f.db,'a','f',credit.id,'next','makeup-key');
  expect(f.raw.prepare('SELECT remaining FROM booking_entitlements').get()).toEqual({remaining:0});
  expect(f.raw.prepare("SELECT COUNT(*) n FROM booking_entitlement_events WHERE action='consume'").get()).toEqual({n:1});
  expect(f.raw.prepare('SELECT COUNT(*) n FROM event_booking_entitlement_uses').get()).toEqual({n:1});
});
test('class monthly usage follows the account timezone and moving months checks the destination allowance atomically',async()=>{
  const e=await grant('monthly',1);f.raw.exec("INSERT INTO booking_settings(line_account_id,timezone) VALUES('a','America/New_York');UPDATE event_slots SET starts_at='2030-02-01T01:00:00Z',ends_at='2030-02-01T02:00:00Z' WHERE id='slot';UPDATE event_slots SET starts_at='2030-02-01T06:00:00Z',ends_at='2030-02-01T07:00:00Z' WHERE id='next'");
  booking('jan','confirmed');await (await eventEntitlementUse(f.db,'a','jan',e.id,'2030-02-01T01:00:00Z')).run();
  const jan=(await entitlementViews(f.db,'a','f','2030-02-01T01:00:00Z'))[0]!;
  expect(jan).toMatchObject({periodStart:'2030-01-01T05:00:00.000Z',monthUsed:1,monthRemaining:0});
  booking('feb','confirmed','a','f','next');
  await (await transferEventEntitlement(f.db,'a','jan','feb','2030-02-01T06:00:00Z')).run();
  expect((await entitlementViews(f.db,'a','f','2030-02-01T01:00:00Z'))[0]).toMatchObject({monthUsed:0,monthRemaining:1});
  expect((await entitlementViews(f.db,'a','f','2030-02-01T06:00:00Z'))[0]).toMatchObject({periodStart:'2030-02-01T05:00:00.000Z',monthUsed:1,monthRemaining:0});
});

test('an administrator explicitly opts an existing plan into classes with its current version; readonly and foreign IDs cannot change it',async()=>{
 const e=await grant('monthly',null);f.raw.exec("UPDATE booking_pass_plans SET event_target_scope_json=NULL");
 let readOnly=false;
 const app=new Hono<Env>();app.use('*',async(c,next)=>{c.set('staff',{id:'operator',name:'担当',role:'owner',readOnly,permissionKeys:[]});await next();});app.route('/',bookingPassPlans);
 const start=(expectedVersion:number,eventIds:string[]|null)=>app.request('/api/booking/admin/pass-plans/plan/start?account_id=a',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedVersion,eventIds})},{DB:f.db} as Env['Bindings']);
 expect((await start(1,['foreign-class'])).status).toBe(400);
 expect((await start(1,['class'])).status).toBe(200);
 expect((await start(1,[])).status).toBe(409);
 expect((await validateEventEntitlement(f.db,'a','f','class',e.id,'2030-01-10T01:00:00Z')).id).toBe(e.id);
 expect((await start(2,null)).status).toBe(200);
 await expect(validateEventEntitlement(f.db,'a','f','class',e.id,'2030-01-10T01:00:00Z')).rejects.toThrow();
 readOnly=true;expect((await start(3,[])).status).toBe(403);
 expect(f.raw.prepare('SELECT version,event_target_scope_json FROM booking_pass_plans').get()).toEqual({version:3,event_target_scope_json:null});
});

test('the LIFF occurrence change moves a consumed pass and records both halves for crash recovery',async()=>{
 const e=await grant();await use('move-source',e.id);f.raw.exec("UPDATE line_accounts SET liff_id='liff-a' WHERE id='a'");
 const app=new Hono<Env>();app.route('/',events);
 const response=await app.request('/api/events/liff/bookings/move-source/change?liffId=liff-a',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer synthetic','Idempotency-Key':'replacement'},body:JSON.stringify({to_slot_id:'next'})},{DB:f.db} as Env['Bindings']);
 expect(response.status).toBe(200);const body=await response.json() as {id:string};
 expect(f.raw.prepare('SELECT event_booking_id FROM event_booking_entitlement_uses').get()).toEqual({event_booking_id:body.id});
 expect(f.raw.prepare('SELECT action FROM event_booking_transition_runs ORDER BY action').all()).toEqual([{action:'change_from'},{action:'change_to'}]);
 await recoverEventTransitions(f.db,now,100);await recoverEventTransitions(f.db,now,100);
 expect(f.raw.prepare('SELECT remaining FROM booking_entitlements').get()).toEqual({remaining:0});
 expect(f.raw.prepare("SELECT COUNT(*) n FROM booking_entitlement_events WHERE action='consume'").get()).toEqual({n:1});
 expect(f.raw.prepare("SELECT COUNT(*) n FROM workflow_steps WHERE process_kind='booking_line_delivery'").get()).toEqual({n:1});
});

test('discarding a new capacity-race loser restores its pass once and retains the detached usage audit',async()=>{
 const e=await grant();await use('loser',e.id);
 f.raw.exec("INSERT INTO event_booking_reminders(id,booking_id,kind,scheduled_at) VALUES('unaccepted-reminder','loser','day_before','2030-01-09')");
 await discardUnacceptedEventBooking(f.db,'a','loser');
 await expect(discardUnacceptedEventBooking(f.db,'a','loser')).rejects.toThrow('booking_changed');
 expect(f.raw.prepare('SELECT remaining FROM booking_entitlements').get()).toEqual({remaining:1});
 expect(f.raw.prepare('SELECT COUNT(*) n FROM event_bookings').get()).toEqual({n:0});
 expect(f.raw.prepare('SELECT COUNT(*) n FROM event_booking_reminders').get()).toEqual({n:0});
 expect(f.raw.prepare('SELECT event_booking_id,event_booking_id_history,returned_at FROM event_booking_entitlement_uses').get()).toMatchObject({event_booking_id:null,event_booking_id_history:'loser',returned_at:expect.any(String)});
 expect(f.raw.prepare("SELECT COUNT(*) n FROM booking_entitlement_events WHERE request_key='event-return:loser'").get()).toEqual({n:1});
});

test('an unknown notification fences compensation and preserves both the reservation and its consumed pass',async()=>{
 const e=await grant();await use('unknown-notice',e.id);
 await (await prepareEventNotification(f.db,{accountId:'a',operationId:'unknown-notice',to:'Uf',kind:'received_confirmed',ctx:{eventName:'クラス',startsAtJst:'2030-01-10 10:00'},subject:{bookingId:'unknown-notice',slotId:'slot',status:'confirmed',startsAt:'2030-01-10T01:00:00Z'},now})).run();
 f.raw.exec("UPDATE workflow_steps SET status='unknown',attempt_count=1");
 await expect(discardUnacceptedEventBooking(f.db,'a','unknown-notice')).rejects.toThrow('booking_changed');
 expect(f.raw.prepare('SELECT status FROM event_bookings').get()).toEqual({status:'confirmed'});
 expect(f.raw.prepare('SELECT remaining FROM booking_entitlements').get()).toEqual({remaining:0});
 expect(f.raw.prepare('SELECT returned_at FROM event_booking_entitlement_uses').get()).toEqual({returned_at:null});
});
test('customer deletion removes detached transition snapshots and keeps anonymous pass usage history',async()=>{
 const e=await grant();await use('delete-source',e.id);
 f.raw.exec("UPDATE event_bookings SET status='cancelled' WHERE id='delete-source';DELETE FROM event_bookings WHERE id='delete-source'");
 expect(f.raw.prepare('SELECT booking_id FROM event_booking_transition_runs').get()).toEqual({booking_id:null});
 expect(await deleteCustomerData({DB:f.db},{kind:'friend_data',id:'f',friendId:'f',accountId:'a',lineUserId:'Uf'},'operator')).toMatchObject({deleted:true});
 expect(f.raw.prepare('SELECT COUNT(*) n FROM event_booking_transition_runs').get()).toEqual({n:0});
 expect(f.raw.prepare('SELECT event_booking_id,event_booking_id_history FROM event_booking_entitlement_uses').get()).toEqual({event_booking_id:null,event_booking_id_history:'delete-source'});
 expect(f.raw.prepare('SELECT remaining,friend_id FROM booking_entitlements').get()).toEqual({remaining:0,friend_id:null});
 expect(f.raw.prepare("SELECT id FROM friends WHERE id='foreign'").get()).toEqual({id:'foreign'});
});

test("an explicit all-class scope still cannot consume a pass for a different account's class",async()=>{
 const e=await grant();f.raw.exec("UPDATE booking_pass_plans SET event_target_scope_json='[]'");
 await expect(validateEventEntitlement(f.db,'a','f','foreign-class',e.id,'2030-01-10T01:00:00Z')).rejects.toThrow('entitlement_unavailable');
 await expect(f.db.batch([f.db.prepare("INSERT INTO event_bookings(id,line_account_id,event_id,slot_id,friend_id,status,requested_at,identity_key) VALUES('foreign-link','a','foreign-class','foreign-slot','f','confirmed','2029-12-01','foreign-link')"),await eventEntitlementUse(f.db,'a','foreign-link',e.id,'2030-01-10T01:00:00Z')])).rejects.toThrow('entitlement_unavailable');
 expect(f.raw.prepare("SELECT id FROM event_bookings WHERE id='foreign-link'").get()).toBeUndefined();
 expect(f.raw.prepare('SELECT remaining FROM booking_entitlements').get()).toEqual({remaining:1});
});

test('retrying the same Meet registration within the final hour cancels only the unnecessary unsent day reminder',async()=>{
 const input={externalEventId:'late-retry',friendId:'f',title:'相談',startsAt:'2030-01-10T01:00:00Z',endsAt:'2030-01-10T02:00:00Z',meetUrl:'https://meet.google.com/abc-defg-hij'};
 await registerMeetConsultation(f.db,input,now);
 await registerMeetConsultation(f.db,input,new Date('2030-01-10T00:30:00Z'));
 expect(f.raw.prepare('SELECT kind,status,schedule_revision FROM meet_consultation_notification_runs ORDER BY kind').all()).toEqual([{kind:'day_before',status:'cancelled',schedule_revision:0},{kind:'hour_before',status:'pending',schedule_revision:0}]);
});
