import { logger } from '@line-crm/shared/server';
import { defaultRestaurantReservationForm } from '@line-crm/shared';
import { saveRestaurantReservationForm } from '../services/restaurant-reservation-form.js';
import { saveTableAutomation } from '../services/restaurant-table-automation.js';
import { Hono } from 'hono';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import type { Env } from '../worker-env.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
const mocks = vi.hoisted(() => ({
  send: vi.fn(async (_env: unknown, _input: unknown) => true),
}));
vi.mock('../features/booking/booking-automatic-line.js', () => ({
  sendAutomaticBookingLine: mocks.send,
}));
vi.mock('../services/waitlist-tick.js', () => ({
  processBookingWaitlists: vi.fn(),
}));
vi.mock('@line-crm/db', async (o) => ({
  ...(await o<Record<string, unknown>>()),
  isAccountFeatureEnabled: vi.fn(async () => true),
}));
import { restaurantCustomerBooking } from './restaurant-customer-booking.js';
import {
  customerAvailability,
  processRestaurantCustomerNotices,
} from '../services/restaurant-customer-booking.js';
let db: SqliteD1;
async function read(r: Response) {
  return (await r.json()) as {
    data: import('@line-crm/shared').RestaurantCustomerBooking;
  };
}
const start = '2027-10-01T03:00:00.000Z';
function app() {
  const a = new Hono<Env>();
  a.use('*', async (c, next) => {
    c.env = { DB: db.db, DEPLOY_ENV: 'test', RESTAURANT_TEST_ENABLED: 'true' } as Env['Bindings'];
    await next();
  });
  a.route('/', restaurantCustomerBooking);
  return a;
}
const request = (path: string, body?: unknown, token = 'one') =>
  app().request(path + (path.includes('?') ? '&' : '?') + 'liffId=liff1', {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const hold = (requestId = 'request_123', token = 'one') =>
  request(
    '/api/liff/restaurant/holds',
    { storeId: 'store', startsAt: start, guestCount: 2, requestId },
    token,
  );

describe('未配席で受け付ける自動配席オフ',()=>{
  it('卓を決めずに確保・確定し、同じ時間の次の組を空席以上に受け付けない',async()=>{
    db.raw.exec("UPDATE rt_tables SET is_active=0 WHERE id='table2'");
    await saveTableAutomation(db.db,'a1','store',{enabled:false,expectedVersion:0});
    const first=await hold('manual_seating');
    expect(first.status).toBe(201);
    const booking=(await read(first)).data;
    expect(db.raw.prepare('SELECT table_id FROM rt_reservations WHERE id=?').get(booking.id)).toEqual({table_id:null});
    const confirmed=await request(`/api/liff/restaurant/reservations/${booking.id}/confirm`,{expectedVersion:booking.version});
    expect(confirmed.status).toBe(200);
    expect(db.raw.prepare('SELECT table_id,status FROM rt_reservations WHERE id=?').get(booking.id)).toEqual({table_id:null,status:'confirmed'});
    expect((await hold('second_party','two')).status).toBe(409);
    await saveTableAutomation(db.db,'a1','store',{enabled:true,expectedVersion:1});
    expect((await hold('after_enable','two')).status).toBe(409);
  });
  it('オフに切り替えても既存予約の卓は変えず、未配席の同時受付も一組だけにする',async()=>{
    const assigned=(await read(await hold('assigned'))).data;
    const before=db.raw.prepare('SELECT table_id FROM rt_reservations WHERE id=?').get(assigned.id);
    await saveTableAutomation(db.db,'a1','store',{enabled:false,expectedVersion:0});
    expect(db.raw.prepare('SELECT table_id FROM rt_reservations WHERE id=?').get(assigned.id)).toEqual(before);
    const results=await Promise.all([hold('off_party_one','two'),hold('off_party_two','two')]);
    expect(results.map(r=>r.status).sort()).toEqual([201,409]);
    const unassigned=db.raw.prepare('SELECT COUNT(*) n FROM rt_reservations WHERE table_id IS NULL').get();
    expect(unassigned).toEqual({n:1});
  });
});
beforeEach(() => {
  vi.clearAllMocks();
  db = createTestD1();
  db.raw.exec(`
 INSERT INTO tenants(id,name) VALUES('t1','1'),('t2','2');
 INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,login_channel_id,liff_id,tenant_id) VALUES('a1','1','1','','','login1','liff1','t1'),('a2','2','2','','','login2','liff2','t2');
 INSERT INTO friends(id,line_user_id,line_account_id,display_name) VALUES('f1','Uone','a1','本人'),('f2','Utwo','a1','二人目');
 INSERT INTO rt_organizations(id,account_id,name) VALUES('org','a1','店');
 INSERT INTO rt_stores(id,organization_id,name,code,line_account_id) VALUES('store','org','店','s','a1');
 INSERT INTO rt_stores(id,organization_id,name,code,line_account_id) VALUES('other','org','他店','o','a2');
 INSERT INTO rt_tables(id,store_id,code,label,seat_type,max_capacity) VALUES('table1','store','1','卓1','table',4),('table2','store','2','卓2','table',4);
 INSERT INTO rt_media(id,code,name,sender_addresses,parser_key) VALUES('media','hotpepper','媒体','[]','hp');
 INSERT INTO rt_store_media_links(store_id,media_id,close_on_booking) VALUES('store','media',1);
 INSERT INTO booking_settings(id,line_account_id,booking_window_days,cutoff_minutes_before,cancel_deadline_minutes_before) VALUES('bs','a1',365,0,0);
 `);
  db.raw
    .prepare(
      "INSERT INTO rt_opening_hours_settings(store_id,hours_json,updated_by) VALUES('store',?,'staff')",
    )
    .run(
      JSON.stringify(
        Array.from({ length: 7 }, (_, weekday) => ({
          weekday,
          periods: [{ opensAt: '12:00', closesAt: '16:00' }],
        })),
      ),
    );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      const b = new URLSearchParams(String(init?.body));
      return new Response(
        JSON.stringify({
          sub: 'U' + b.get('id_token'),
          aud: b.get('client_id'),
          exp: Date.now() / 1000 + 3600,
        }),
        { status: 200 },
      );
    }),
  );
});
afterEach(() => {
  db.raw.close();
  vi.unstubAllGlobals();
});
describe('飲食店の本人予約', () => {
  it('仮押さえ→確定→変更→取消。通知と媒体の知らせを一度だけ作る', async () => {
    const h = await hold();
    expect(h.status).toBe(201);
    const { data } = await read(h);
    expect(data.status).toBe('pending');
    expect((await hold()).status).toBe(200);
    const confirm = await request(
      `/api/liff/restaurant/reservations/${data.id}/confirm`,
      { expectedVersion: 1 },
    );
    expect(confirm.status).toBe(200);
    const confirmed = (await read(confirm)).data;
    expect(confirmed.version).toBe(2);
    expect(
      db.raw.prepare('SELECT COUNT(*) n FROM rt_reservation_close_tasks').get(),
    ).toEqual({ n: 1 });
    await request(`/api/liff/restaurant/reservations/${data.id}/confirm`, {
      expectedVersion: 1,
    });
    expect(mocks.send).not.toHaveBeenCalled(); // 未承認の予約入りは送らない
    const change = await request(
      `/api/liff/restaurant/reservations/${data.id}/reschedule`,
      { expectedVersion: 2, startsAt: '2027-10-01T04:00:00Z', guestCount: 2 },
    );
    expect(change.status).toBe(200);
    const cancelled = await request(
      `/api/liff/restaurant/reservations/${data.id}/cancel`,
      { expectedVersion: 3 },
    );
    expect(cancelled.status).toBe(200);
    expect(db.raw.prepare('SELECT status FROM rt_reservations').get()).toEqual({
      status: 'cancelled',
    });
    expect(
      db.raw
        .prepare('SELECT DISTINCT status FROM rt_reservation_close_tasks')
        .all(),
    ).toEqual([{ status: 'reopen' }]);
    expect(mocks.send.mock.calls[0]?.[1]).toMatchObject({
      featureId: 'restaurant_test',
      to: 'Uone',
    });
  });
  it('空席を読んだ後に卓が消えた場合は競合として返す', async () => {
    const prepare = db.db.prepare.bind(db.db)
    const spy = vi.spyOn(db.db, 'prepare').mockImplementation((sql) => {
      if (sql.includes('INSERT INTO rt_reservations(id,store_id,source')) {
        db.raw.exec("DELETE FROM rt_tables WHERE id IN ('table1','table2')")
      }
      return prepare(sql)
    })
    try {
      expect((await hold()).status).toBe(409)
      expect(db.raw.prepare('SELECT COUNT(*) n FROM rt_reservations').get()).toEqual({n:0})
    } finally { spy.mockRestore() }
  })
  it('同じ本人の同時予約、同じ卓の同時確保をDBで拒否する', async () => {
    const [a, b] = await Promise.all([
      hold('request_one'),
      hold('request_two'),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    // 均等方式の同点は乱数で選ばれる。本人重複の対照は実際に空いている卓へ入れる。
    const occupied=(db.raw.prepare("SELECT table_id FROM rt_reservations WHERE store_id='store'").get() as {table_id:string}).table_id;
    const vacant=occupied==='table1'?'table2':'table1';
    expect(() =>
      db.raw.exec(
        `INSERT INTO rt_reservations(id,store_id,source,external_id,customer_name,line_uid,guest_count,starts_at,ends_at,table_id,status,customer_request_id) VALUES('duplicate','store','line','unique','本人','Uone',2,'${start}','2027-10-01T05:00:00Z','${vacant}','confirmed','request_direct')`,
      ),
    ).toThrow('customer_duplicate_booking');
    db.raw.prepare('UPDATE rt_tables SET is_active=0 WHERE id=?').run(vacant);
    const other = await hold('request_three', 'two');
    expect(other.status).toBe(409);
    expect(() =>
      db.raw.exec(
        `INSERT INTO rt_reservations(id,store_id,source,customer_name,line_uid,guest_count,starts_at,ends_at,table_id,status) VALUES('external','store','manual','外部','other',2,'${start}','2027-10-01T05:00:00Z','${occupied}','confirmed')`,
      ),
    ).toThrow(/(?:customer|restaurant)_table_conflict/);
  });
  it('未認証・対象外店舗・他人の予約・期限・版を拒否する', async () => {
    expect(
      (
        await app().request(
          '/api/liff/restaurant/availability?liffId=liff1&storeId=store&date=2027-10-01&guestCount=2',
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await request(
          '/api/liff/restaurant/availability?storeId=other&date=2027-10-01&guestCount=2',
        )
      ).status,
    ).toBe(404);
    const { data } = await read(await hold());
    expect(
      (
        await request(
          `/api/liff/restaurant/reservations/${data.id}/confirm`,
          { expectedVersion: 1 },
          'two',
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(`/api/liff/restaurant/reservations/${data.id}/confirm`, {
          expectedVersion: 2,
        })
      ).status,
    ).toBe(409);
    db.raw
      .prepare(
        "UPDATE rt_reservations SET hold_expires_at='2000-01-01' WHERE id=?",
      )
      .run(data.id);
    expect(
      (
        await request(`/api/liff/restaurant/reservations/${data.id}/confirm`, {
          expectedVersion: 1,
        })
      ).status,
    ).toBe(409);
  });
  it('営業時間外・臨時休業・貸切・席待ちの仮押さえ・LINE枠0を反映する', async () => {
    const store = {
      id: 'store',
      name: '店',
      timezone: 'Asia/Tokyo',
      line_account_id: 'a1',
      tenant_id: 't1',
    };
    expect(
      (await customerAvailability(db.db, store, '2027-10-01', 2))!.data
        .slots[0]!.available,
    ).toBe(true);
    expect(
      (
        await request('/api/liff/restaurant/holds', {
          storeId: 'store',
          startsAt: '2027-10-01T01:00:00Z',
          guestCount: 2,
          requestId: 'request_wrong',
        })
      ).status,
    ).toBe(409);
    db.raw
      .prepare(
        `INSERT INTO rt_closures(id,store_id,start_date,end_date,all_day,kind,table_ids_json,periods_json) VALUES('c','store','2027-10-01','2027-10-01',1,'private_event','[]',?)`,
      )
      .run(
        JSON.stringify([
          { startsAt: '2027-09-30T15:00:00Z', endsAt: '2027-10-01T15:00:00Z' },
        ]),
      );
    expect((await hold()).status).toBe(409);
    db.raw.exec(
      "UPDATE rt_closures SET archived_at=datetime('now'); INSERT INTO rt_inventory_slots(id,store_id,starts_at,total_capacity,line_capacity) VALUES('slot','store','2027-10-01T03:00:00Z',8,0)",
    );
    expect((await hold()).status).toBe(409);
  });
  it('席待ちの招待は空席として返さず、期限切れで戻す', async () => {
    db.raw.exec("UPDATE rt_tables SET is_active=0 WHERE id='table2'");
    db.raw
      .prepare(
        "INSERT INTO rt_seat_waitlist(id,store_id,starts_at,ends_at,guest_count,customer_name,line_uid,identity_key,status,table_id,hold_expires_at) VALUES('waiting','store',?,'2027-10-01T05:00:00Z',2,'待つ人','Uwait','wait','invited','table1',datetime('now','+30 minutes'))",
      )
      .run(start);
    expect((await hold()).status).toBe(409);
    db.raw.exec("UPDATE rt_seat_waitlist SET hold_expires_at='2000-01-01'");
    expect((await hold()).status).toBe(201);
  });
  it('締切後の変更・取消、偽のaudと期限切れの本人トークンを拒否する', async () => {
    const { data } = await read(await hold());
    await request(`/api/liff/restaurant/reservations/${data.id}/confirm`, {
      expectedVersion: 1,
    });
    db.raw.exec(
      "UPDATE booking_settings SET cancel_deadline_minutes_before=43200; UPDATE rt_reservations SET starts_at=datetime('now','+1 day'),ends_at=datetime('now','+1 day','+120 minutes')",
    );
    expect(
      (
        await request(`/api/liff/restaurant/reservations/${data.id}/cancel`, {
          expectedVersion: 3,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          `/api/liff/restaurant/reservations/${data.id}/reschedule`,
          { expectedVersion: 3, startsAt: start, guestCount: 2 },
        )
      ).status,
    ).toBe(403);
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ sub: 'Uone', aud: 'wrong', exp: Date.now() / 1000 + 60 }),
    );
    expect((await hold()).status).toBe(401);
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ sub: 'Uone', aud: 'login1', exp: 1 }),
    );
    expect((await hold()).status).toBe(401);
  });
  it('通知失敗で予約を戻さず、同じ鍵で再試行する', async () => {
    const { data } = await read(await hold());
    expect(
      (
        await request(`/api/liff/restaurant/reservations/${data.id}/confirm`, {
          expectedVersion: 1,
        })
      ).status,
    ).toBe(200);
    expect(db.raw.prepare('SELECT status FROM rt_reservations').get()).toEqual({
      status: 'confirmed',
    });
    mocks.send.mockRejectedValueOnce(new Error('mock failure'));
    expect((await request(`/api/liff/restaurant/reservations/${data.id}/reschedule`,{expectedVersion:2,startsAt:'2027-10-01T04:00:00Z',guestCount:2})).status).toBe(200);
    db.raw.exec('UPDATE rt_customer_notice_outbox SET lease_until=NULL');
    expect(
      await processRestaurantCustomerNotices({ DB: db.db } as Env['Bindings']),
    ).toBe(1);
    expect(mocks.send.mock.calls[0]?.[1]).toEqual(
      mocks.send.mock.calls[1]?.[1],
    );
  });
});

it('停止したアカウントは本人確認と予約へ進めない', async () => {
  db.raw.exec("UPDATE line_accounts SET is_active=0 WHERE id='a1'");
  expect((await hold()).status).toBe(404);
  expect(fetch).not.toHaveBeenCalled();
});

it('電話と200文字の要望を仮押さえ・確定・履歴・台帳用の予約に残す',async()=>{
  const details={note:'🍽'.repeat(200),customerPhone:'090-1234-5678'};
  const input={storeId:'store',startsAt:start,guestCount:2,requestId:'request_details',...details};
  const h=await request('/api/liff/restaurant/holds',input);
  expect(h.status).toBe(201);
  const {data}=await read(h);
  expect(data).toMatchObject({...details,customerPhone:'09012345678',seatType:'table'});
  expect((await request('/api/liff/restaurant/holds',input)).status).toBe(200);
  expect((await request('/api/liff/restaurant/holds',{...input,note:'違う'})).status).toBe(409);
  const confirmed=await request(`/api/liff/restaurant/reservations/${data.id}/confirm`,{expectedVersion:1,note:'窓際を希望',customerPhone:'0312345678'});
  expect(confirmed.status).toBe(200);
  expect((await read(confirmed)).data).toMatchObject({status:'confirmed',note:'窓際を希望',customerPhone:'0312345678',seatType:'table'});
  expect(db.raw.prepare('SELECT note,customer_phone FROM rt_reservations WHERE id=?').get(data.id)).toEqual({note:'窓際を希望',customer_phone:'0312345678'});
  const history=await (await request('/api/liff/restaurant/reservations?storeId=store')).json() as any;
  expect(history.data[0]).toMatchObject({note:'窓際を希望',customerPhone:'0312345678',seatType:'table'});
  expect((await request(`/api/liff/restaurant/reservations/${data.id}/confirm`,{expectedVersion:1,note:'再送で違う内容'})).status).toBe(409);
});
it('任意欄の省略で維持し、空欄で消す。201文字・型違い・不正電話は保存しない',async()=>{
  for (const details of [{note:'あ'.repeat(201)},{note:123},{customerPhone:{}},{customerPhone:'x'.repeat(51)},{customerPhone:'abc'},{customerPhone:'1234567890'},{customerPhone:'090123456'},{customerPhone:'090123456789'},{customerPhone:'+819012345678'}]) {
    expect((await request('/api/liff/restaurant/holds',{storeId:'store',startsAt:start,guestCount:2,requestId:'request_bad',...details})).status).toBe(400);
  }
  const {data}=await read(await request('/api/liff/restaurant/holds',{storeId:'store',startsAt:start,guestCount:2,requestId:'request_optional',note:'希望',customerPhone:'090-1234-5678'}));
  expect((await request(`/api/liff/restaurant/reservations/${data.id}/confirm`,{expectedVersion:1,note:'あ'.repeat(201)})).status).toBe(400);
  expect((await request(`/api/liff/restaurant/reservations/${data.id}/confirm`,{expectedVersion:1,customerPhone:4})).status).toBe(400);
  expect((await read(await request(`/api/liff/restaurant/reservations/${data.id}/confirm`,{expectedVersion:1}))).data).toMatchObject({note:'希望',customerPhone:'09012345678'});
  await request(`/api/liff/restaurant/reservations/${data.id}/cancel`,{expectedVersion:2});
  const {data:other}=await read(await request('/api/liff/restaurant/holds',{storeId:'store',startsAt:start,guestCount:2,requestId:'request_empty',note:'希望',customerPhone:'090-1234-5678'}));
  expect((await read(await request(`/api/liff/restaurant/reservations/${other.id}/confirm`,{expectedVersion:1,note:' ',customerPhone:null}))).data).toMatchObject({note:null,customerPhone:null});
});
it('空きは卓の種類と設定した店だけの遅刻案内を返す',async()=>{
  db.raw.exec("UPDATE rt_tables SET seat_type='counter' WHERE id='table2'");
  const path='/api/liff/restaurant/availability?storeId=store&date=2027-10-01&guestCount=2';
  let data=(await (await request(path)).json() as any).data;
  expect(data.slots[0].seatTypes.sort()).toEqual(['counter','table']);
  expect(data).not.toHaveProperty('lateArrivalPolicy');
  expect(data).not.toHaveProperty('unavailableReason');
  db.raw.exec("UPDATE rt_opening_hours_settings SET late_cancel_after_minutes=15,late_arrival_message='15分で取り消す場合があります'");
  data=(await (await request(path)).json() as any).data;
  expect(data.lateArrivalPolicy).toEqual({cancelAfterMinutes:15,message:'15分で取り消す場合があります'});
  db.raw.exec("UPDATE rt_tables SET is_active=0 WHERE id='table1'");
  const {data:h}=await read(await hold());
  expect((await read(await request(`/api/liff/restaurant/reservations/${h.id}/confirm`,{expectedVersion:1}))).data.seatType).toBe('counter');
});
it.each(['temporary_closed','private_event'])('全卓の%sを空きなしの理由として返し、部分閉鎖は店全体の休業にしない',async(kind)=>{
  db.raw.prepare("INSERT INTO rt_closures(id,store_id,start_date,end_date,all_day,kind,table_ids_json,periods_json,memo) VALUES('closure','store','2027-10-01','2027-10-01',1,?,'[]',?,'内部メモ')").run(kind,JSON.stringify([{startsAt:'2027-09-30T15:00:00Z',endsAt:'2027-10-01T15:00:00Z'}]));
  const path='/api/liff/restaurant/availability?storeId=store&date=2027-10-01&guestCount=2';
  let body=await (await request(path)).json() as any;
  expect(body.data.unavailableReason).toBe(kind);
  expect(body.data.slots.every((s:any)=>!s.available&&s.unavailableReason===kind&&s.seatTypes.length===0)).toBe(true);
  expect(JSON.stringify(body)).not.toContain('内部メモ');
  db.raw.exec(`UPDATE rt_closures SET table_ids_json='["table1"]',version=version+1`);
  body=await (await request(path)).json() as any;
  expect(body.data).not.toHaveProperty('unavailableReason');
  expect(body.data.slots[0]).toMatchObject({available:true,remainingTables:1});
});
it('定休と満席を区別し、定休の日でも臨時休業の指定を優先する',async()=>{
  const path='/api/liff/restaurant/availability?storeId=store&date=2027-10-01&guestCount=2';
  db.raw.exec('UPDATE rt_tables SET is_active=0');
  expect((await (await request(path)).json() as any).data.unavailableReason).toBe('full');
  db.raw.exec('UPDATE rt_tables SET is_active=1');
  db.raw.prepare('UPDATE rt_opening_hours_settings SET hours_json=?').run(JSON.stringify(Array.from({length:7},(_,weekday)=>({weekday,periods:[]}))));
  expect((await (await request(path)).json() as any).data).toMatchObject({slots:[],unavailableReason:'regular_closed'});
  db.raw.prepare("INSERT INTO rt_closures(id,store_id,start_date,end_date,all_day,kind,table_ids_json,periods_json) VALUES('closure','store','2027-10-01','2027-10-01',1,'temporary_closed','[]',?)").run(JSON.stringify([{startsAt:'2027-09-30T15:00:00Z',endsAt:'2027-10-01T15:00:00Z'}]));
  expect((await (await request(path)).json() as any).data.unavailableReason).toBe('temporary_closed');
});
it('営業時間があって受付終了した日は、定休と表示しない',async()=>{
  const now=vi.spyOn(Date,'now').mockReturnValue(Date.parse('2027-10-01T06:00:00Z'));
  try {
    const body=await (await request('/api/liff/restaurant/availability?storeId=store&date=2027-10-01&guestCount=2')).json() as any;
    expect(body.data).toMatchObject({slots:[],unavailableReason:'full'});
  } finally {now.mockRestore();}
});

it('来店の返事はLIFF本人・予約版で受け、未認証・他人・型違いを拒否する',async()=>{
 const id=crypto.randomUUID();
 db.raw.prepare("INSERT INTO rt_reservations(id,store_id,source,customer_name,line_uid,guest_count,starts_at,ends_at,status) VALUES('confirmed','store','phone','本人','Uone',2,?,?,'confirmed')").run(start,'2027-10-01T04:30:00.000Z');
 db.raw.prepare("INSERT INTO rt_reservation_confirmations(request_id,reservation_id,reservation_version,friend_id,requested_at,expires_at) VALUES(?,'confirmed',1,'f1',?,?)").run(id,new Date().toISOString(),start);
 const path='/api/liff/restaurant/confirmations/'+id+'/respond';
 expect((await request(path,{expectedVersion:1,response:'going'},'two')).status).toBe(404);
 expect((await request(path,{expectedVersion:'1',response:'going'})).status).toBe(400);
 expect((await request(path,{expectedVersion:2,response:'going'})).status).toBe(409);
 const accepted=await request(path,{expectedVersion:1,response:'going'});expect(accepted.status).toBe(200);
 expect(await accepted.json()).toMatchObject({success:true,data:{response:'going',version:1}});
 expect(db.raw.prepare("SELECT customer_version,status FROM rt_reservations WHERE id='confirmed'").get()).toEqual({customer_version:1,status:'confirmed'});
 const unauthenticated=await app().request(path+'?liffId=liff1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedVersion:1,response:'going'})});
 expect(unauthenticated.status).toBe(401);
});

describe('飲食4：コース・フォーム・系列店',()=>{
 function course(){db.raw.exec(`INSERT INTO rt_menu_items(id,store_id,kind,name,price,duration_minutes,allergens_json) VALUES('c90','store','course','90分コース',5000,90,'["乳"]'),('c180','store','course','180分コース',8000,180,'[]'),('foreign','other','course','他店',1000,60,'[]')`);}
 it('同じ店の公開コースと所要時間で空き・hold・確定・変更を通す。別店と卓の指定は採用しない',async()=>{
  course();
  const r=await request('/api/liff/restaurant/holds',{storeId:'store',startsAt:start,guestCount:2,courseId:'c90',tableId:'foreign',requestId:'course_hold'});
  expect(r.status).toBe(201);const h=(await read(r)).data;
  expect(h.endsAt).toBe('2027-10-01T04:30:00.000Z');expect(h.courseId).toBe('c90');
  expect(db.raw.prepare('SELECT table_id,dining_snapshot_json FROM rt_reservations WHERE id=?').get(h.id)).toMatchObject({table_id:expect.stringMatching(/^table[12]$/),dining_snapshot_json:expect.stringContaining('乳')});
  expect((await request(`/api/liff/restaurant/reservations/${h.id}/confirm`,{expectedVersion:1})).status).toBe(200);
  const changed=await request(`/api/liff/restaurant/reservations/${h.id}/reschedule`,{expectedVersion:2,startsAt:start,guestCount:2,courseId:'c180'});
  expect(changed.status).toBe(200);expect((await read(changed)).data.endsAt).toBe('2027-10-01T06:00:00.000Z');
  expect((await request(`/api/liff/restaurant/reservations/${h.id}/reschedule`,{expectedVersion:2,startsAt:start,guestCount:2,courseId:'c90'})).status).toBe(409);
  expect((await request('/api/liff/restaurant/holds',{storeId:'store',startsAt:start,guestCount:2,courseId:'foreign',requestId:'foreign_hold'})).status).toBe(400);
  expect(mocks.send).toHaveBeenCalledTimes(1); // 日時変更の既存結果通知だけ
 });
 it('コースの長い滞在は隣の在庫と閉店時刻まで確認する。確定前の改版も拒否する',async()=>{
  course();db.raw.exec(`INSERT INTO rt_inventory_slots(id,store_id,starts_at,line_capacity,total_capacity) VALUES('closed','store','2027-10-01T05:30:00Z',0,8)`);
  expect((await request('/api/liff/restaurant/holds',{storeId:'store',startsAt:start,guestCount:2,courseId:'c180',requestId:'inventory_hold'})).status).toBe(409);
  const r=await request('/api/liff/restaurant/holds',{storeId:'store',startsAt:start,guestCount:2,courseId:'c90',requestId:'changed_course'});expect(r.status).toBe(201);
  const h=(await read(r)).data;db.raw.exec("UPDATE rt_menu_items SET duration_minutes=60 WHERE id='c90'");
  expect((await request(`/api/liff/restaurant/reservations/${h.id}/confirm`,{expectedVersion:1})).status).toBe(409);
  expect((await request('/api/liff/restaurant/holds',{storeId:'store',startsAt:'2027-10-01T05:00:00Z',guestCount:2,courseId:'c180',requestId:'late_course'})).status).toBe(409);
 });
 it('最後の1卓のコース確保は同時に1件だけ。同じ受付番号でコースを変えない',async()=>{
  course();db.raw.exec("UPDATE rt_tables SET is_active=0 WHERE id='table2'");
  const bodies=['one','two'].map((x)=>({storeId:'store',startsAt:start,guestCount:2,courseId:'c90',requestId:'course_race_'+x}));
  const result=await Promise.all(bodies.map((b,i)=>request('/api/liff/restaurant/holds',b,i===0?'one':'two')));
  expect(result.map(r=>r.status).sort()).toEqual([201,409]);
  const winner=result[0]!.status===201?0:1;
  expect((await request('/api/liff/restaurant/holds',{...bodies[winner],courseId:'c180'},winner===0?'one':'two')).status).toBe(409);
 });
 function referralSetup(){
  db.raw.exec(`UPDATE rt_stores SET latitude=35,longitude=139;
   INSERT INTO booking_settings(id,line_account_id,booking_window_days,cutoff_minutes_before) VALUES('other-bs','a2',365,0);
   INSERT INTO rt_tables(id,store_id,code,label,seat_type,max_capacity) VALUES('other-table','other','1','卓','table',4);
   INSERT INTO rt_reservation_links(store_id,token) VALUES('other','target-link');
   INSERT INTO rt_store_groups(id,organization_id,name) VALUES('group','org','系列');
   INSERT INTO rt_store_group_members(group_id,store_id,referral_enabled,max_distance) VALUES('group','store',1,10),('group','other',1,10);
   UPDATE rt_tables SET is_active=0 WHERE store_id='store';`);
  db.raw.prepare("INSERT INTO rt_opening_hours_settings(store_id,hours_json,updated_by) SELECT 'other',hours_json,'staff' FROM rt_opening_hours_settings WHERE store_id='store'").run();
 }
 it('満席から許可した系列店だけを案内。入口に顧客のID・情報を含めず案内先で本人確認',async()=>{
  referralSetup();
  const rows=await (await request('/api/liff/restaurant/referrals?storeId=store&date=2027-10-01&guestCount=2')).json() as {data:Array<{storeId:string;bookingUrl:string}>};
  expect(rows.data.map(r=>r.storeId)).toEqual(['other']);
  expect(rows.data[0]!.bookingUrl).toContain('page=restaurant');expect(rows.data[0]!.bookingUrl).not.toMatch(/Uone|f1|lineUser|friendId/);
  const offered=await request('/api/liff/restaurant/referrals',{storeId:'store',targetStoreId:'other',date:'2027-10-01',startsAt:start,guestCount:2});
  expect(offered.status).toBe(200);
  expect((await request('/api/liff/restaurant/link/target-link')).status).toBe(404);
  db.raw.exec("UPDATE rt_store_group_members SET referral_enabled=0 WHERE store_id='other'");
  expect((await (await request('/api/liff/restaurant/referrals?storeId=store&date=2027-10-01&guestCount=2')).json() as {data:unknown[]}).data).toEqual([]);
  expect((await request('/api/liff/restaurant/referrals',{storeId:'store',targetStoreId:'other',date:'2027-10-01',startsAt:start,guestCount:2})).status).toBe(409);
 });
 it('座標未確認・距離超過・別組織・未許可・満席の案内先を返さない',async()=>{
  referralSetup();
  db.raw.exec("UPDATE rt_stores SET latitude=NULL WHERE id='other'");
  expect((await (await request('/api/liff/restaurant/referrals?storeId=store&date=2027-10-01&guestCount=2')).json() as {data:unknown[]}).data).toEqual([]);
  db.raw.exec("UPDATE rt_stores SET latitude=40 WHERE id='other'");
  expect((await (await request('/api/liff/restaurant/referrals?storeId=store&date=2027-10-01&guestCount=2')).json() as {data:unknown[]}).data).toEqual([]);
  db.raw.exec("INSERT INTO rt_organizations(id,account_id,name) VALUES('foreign-org','a2','別組織'); INSERT INTO rt_stores(id,organization_id,name,code,line_account_id) VALUES('third','foreign-org','別店','f',NULL)");
  expect(()=>db.raw.exec("INSERT INTO rt_store_group_members(group_id,store_id,referral_enabled) VALUES('group','third',1)")).toThrow('referral_organization_conflict');
 });
 function savedAnswer(){
  const layout={version:1,header:[],sections:[{id:'section',blocks:[{id:'seat-block',kind:'input',type:'booking',name:'seat',label:'予約',booking:{kind:'seats',storeId:'store',menuId:''}}]}],options:{}};
  db.raw.prepare("INSERT INTO forms(id,name,fields,layout,is_active) VALUES('form','フォーム','[]',?,1)").run(JSON.stringify(layout));
  const version=db.raw.prepare("SELECT current_published_version_id v FROM forms WHERE id='form'").get() as {v:string};
  db.raw.prepare("INSERT INTO form_submissions(id,form_id,friend_id,data,form_version_id) VALUES('answer','form','f1',?,?)").run(JSON.stringify({seat:{kind:'seats',storeId:'store',guestCount:2,startsAt:start}}),version.v);
  db.raw.exec(`INSERT INTO form_submit_claims(tenant_id,line_account_id,form_id,friend_id,idempotency_key,request_hash,status,submission_id,owner,created_at,updated_at,expires_at) VALUES('t1','a1','form','f1','submission-key','hash','completed','answer','owner',datetime('now'),datetime('now'),datetime('now','+1 day'))`);
 }
 it('保存済みフォームの公開版から既存台帳へ予約。同時再試行で回答と予約を増やさず下書き変更を使わない',async()=>{
  savedAnswer();
  db.raw.exec("UPDATE forms SET layout='{}' WHERE id='form'");
  const body={formId:'form',blockId:'seat-block',submissionKey:'submission-key'};
  const first=await request('/api/liff/restaurant/form-booking',body);expect(first.status).toBe(200);
  const again=await request('/api/liff/restaurant/form-booking',body);expect(again.status).toBe(200);
  expect((await read(first)).data.id).toBe((await read(again)).data.id);
  expect(db.raw.prepare('SELECT COUNT(*) n FROM rt_reservations').get()).toEqual({n:1});expect(db.raw.prepare('SELECT COUNT(*) n FROM form_submissions').get()).toEqual({n:1});
  expect((await request('/api/liff/restaurant/form-booking',body,'two')).status).toBe(404);
  expect((await request('/api/liff/restaurant/form-booking',{...body,blockId:'other'})).status).toBe(400);
  expect(mocks.send).not.toHaveBeenCalled();
 });
 it('フォームの回答は残し、満席失敗後に同じキーで席を確保し直せる',async()=>{
  savedAnswer();db.raw.exec("UPDATE rt_tables SET is_active=0");
  const body={formId:'form',blockId:'seat-block',submissionKey:'submission-key'};
  expect((await request('/api/liff/restaurant/form-booking',body)).status).toBe(409);
  expect(db.raw.prepare('SELECT COUNT(*) n FROM rt_reservations').get()).toEqual({n:0});
  db.raw.exec("UPDATE rt_tables SET is_active=1");
  expect((await request('/api/liff/restaurant/form-booking',body)).status).toBe(200);
  expect(db.raw.prepare('SELECT COUNT(*) n FROM form_submissions').get()).toEqual({n:1});
 });
 it('回答保存後の期限切れholdを同じ予約で取り直し、取消済みの回答再試行では再予約しない',async()=>{
  savedAnswer();
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('answer:seat-block'));
  const requestId='form_'+Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join('');
  const initial=await read(await hold(requestId));
  db.raw.prepare("UPDATE rt_reservations SET hold_expires_at=datetime('now','-1 minute') WHERE id=?").run(initial.data.id);
  const body={formId:'form',blockId:'seat-block',submissionKey:'submission-key'};
  const retried=await request('/api/liff/restaurant/form-booking',body);expect(retried.status).toBe(200);
  const confirmed=(await read(retried)).data;
  expect(confirmed.id).toBe(initial.data.id);expect(confirmed.status).toBe('confirmed');
  expect((await request(`/api/liff/restaurant/reservations/${confirmed.id}/cancel`,{expectedVersion:confirmed.version})).status).toBe(200);
  expect((await read(await request('/api/liff/restaurant/form-booking',body))).data.status).toBe('cancelled');
  expect(db.raw.prepare('SELECT COUNT(*) n FROM rt_reservations').get()).toEqual({n:1});
  expect((await request('/api/liff/restaurant/form-booking',{})).status).toBe(400);
 });
 it('紹介先の再認証後に確定と受諾を同時保存。途中失敗を戻し、再試行も通知を増やさない',async()=>{
  referralSetup();
  const offer=await (await request('/api/liff/restaurant/referrals',{storeId:'store',targetStoreId:'other',date:'2027-10-01',startsAt:start,guestCount:2})).json() as {data:{bookingUrl:string}};
  const referralId=new URL(offer.data.bookingUrl).searchParams.get('referralId')!;
  db.raw.exec("INSERT INTO friends(id,line_account_id,line_user_id,display_name) VALUES('target-friend','a2','Utarget','本人')");
  const target=(path:string,body:unknown)=>app().request(path+'?liffId=liff2',{method:'POST',headers:{Authorization:'Bearer target','Content-Type':'application/json'},body:JSON.stringify(body)});
  const held=await read(await target('/api/liff/restaurant/holds',{storeId:'other',startsAt:start,guestCount:2,requestId:'target_request'}));
  db.raw.exec("CREATE TRIGGER referral_write_failure BEFORE UPDATE ON rt_reservation_referrals BEGIN SELECT RAISE(ABORT,'fixture_failure'); END");
  const body={expectedVersion:held.data.version,referralId};
  expect((await target(`/api/liff/restaurant/reservations/${held.data.id}/confirm`,body)).status).toBe(500);
  expect(db.raw.prepare('SELECT status FROM rt_reservations WHERE id=?').get(held.data.id)).toEqual({status:'pending'});
  expect(db.raw.prepare('SELECT COUNT(*) n FROM rt_customer_notice_outbox').get()).toEqual({n:0});
  db.raw.exec('DROP TRIGGER referral_write_failure');
  expect((await target(`/api/liff/restaurant/reservations/${held.data.id}/confirm`,body)).status).toBe(200);
  expect((await target(`/api/liff/restaurant/reservations/${held.data.id}/confirm`,body)).status).toBe(200);
  expect(db.raw.prepare('SELECT accepted_at FROM rt_reservation_referrals WHERE id=?').get(referralId)).toEqual({accepted_at:expect.any(String)});
  expect(db.raw.prepare('SELECT COUNT(*) n FROM rt_customer_notice_outbox').get()).toEqual({n:1});
 });
});

it('全角・区切りを数字だけで保存し、旧行は読み取り時だけ整える', async () => {
  const input={storeId:'store',startsAt:start,guestCount:2,requestId:'normalized-phone',customerPhone:'　０９０－１２３４－５６７８ '};
  const held=await read(await request('/api/liff/restaurant/holds',input));
  expect(held.data.customerPhone).toBe('09012345678');
  expect(db.raw.prepare('SELECT customer_phone FROM rt_reservations WHERE id=?').get(held.data.id)).toEqual({customer_phone:'09012345678'});
  db.raw.prepare('UPDATE rt_reservations SET customer_phone=? WHERE id=?').run('０９０－１２３４－５６７８',held.data.id);
  const history=await (await request('/api/liff/restaurant/reservations?storeId=store')).json() as {data:Array<{customerPhone:string|null}>};
  expect(history.data[0].customerPhone).toBe('09012345678');
  expect((await request('/api/liff/restaurant/holds',{...input,customerPhone:'090 1234 5678'})).status).toBe(200);
  expect(db.raw.prepare('SELECT customer_phone FROM rt_reservations WHERE id=?').get(held.data.id)).toEqual({customer_phone:'０９０－１２３４－５６７８'});
});

describe('専用の予約フォームの設定と確定',()=>{
 const settings=async(requiredPhone=false)=>{
  const definition=defaultRestaurantReservationForm();
  definition.title='お席の受付';definition.completionMessage='お席を受け付けました。';
  definition.fields=definition.fields.map(field=>field.id==='phone'?{...field,required:requiredPhone}:field);
  await saveRestaurantReservationForm(db.db,{storeId:'store',accountId:'a1',staffId:'owner',expectedVersion:0,definition});
  return definition;
 };
 it('予約リンクは同じ店の設定を読み、別アカウントには見せない',async()=>{
  db.raw.exec("INSERT INTO rt_reservation_links(store_id,token) VALUES('store','form-link')");
  const definition=await settings();
  const link=await request('/api/liff/restaurant/link/form-link');
  expect(link.status).toBe(200);expect(await link.json()).toMatchObject({data:{id:'store',reservationForm:{version:1,definition}}});
 });
 it('入力の検査後にフォームが変わると確定と通知を両方戻す',async()=>{
  await settings();const {data:h}=await read(await hold());
  const batch=db.db.batch.bind(db.db);
  vi.spyOn(db.db,'batch').mockImplementationOnce(async statements=>{
   db.raw.exec("UPDATE account_settings SET value=json_set(value,'$.version',2) WHERE key='restaurant.reservation_form:store'");
   return batch(statements);
  });
  const response=await request(`/api/liff/restaurant/reservations/${h.id}/confirm`,{expectedVersion:h.version,expectedFormVersion:1});
  expect(response.status).toBe(409);expect(await response.json()).toMatchObject({error:'reservation_form_changed'});
  expect(db.raw.prepare('SELECT status FROM rt_reservations WHERE id=?').get(h.id)).toEqual({status:'pending'});
  expect(db.raw.prepare('SELECT count(*) n FROM rt_customer_notice_outbox WHERE reservation_id=?').get(h.id)).toEqual({n:0});
 });
 it('必須の電話はAPIでも検証し、名前とアレルギーを同じ予約の確定と一緒に保存する',async()=>{
  await settings(true);const {data:h}=await read(await hold());
  const url=`/api/liff/restaurant/reservations/${h.id}/confirm`;
  expect((await request(url,{expectedVersion:h.version})).status).toBe(409);
  expect((await request(url,{expectedVersion:h.version,expectedFormVersion:1})).status).toBe(400);
  const details={expectedVersion:h.version,expectedFormVersion:1,customerName:'予約した方',customerPhone:'09012345678',allergyNote:'乳製品',note:'窓側希望'};
  const confirmed=await request(url,details);expect(confirmed.status).toBe(200);
  expect((await read(confirmed)).data).toMatchObject({customerName:'予約した方',allergyNote:'乳製品'});
  const saved=db.raw.prepare('SELECT customer_name,allergy_note,dining_snapshot_json FROM rt_reservations WHERE id=?').get(h.id) as {customer_name:string;allergy_note:string;dining_snapshot_json:string};
  expect(saved.customer_name).toBe('予約した方');expect(saved.allergy_note).toBe('乳製品');expect(JSON.parse(saved.dining_snapshot_json).allergy).toBe('乳製品');
  expect((await request(url,details)).status).toBe(200);
  expect((await request(url,{...details,allergyNote:'卵'})).status).toBe(409);
  expect(db.raw.prepare('SELECT count(*) n FROM rt_customer_notice_outbox WHERE reservation_id=?').get(h.id)).toEqual({n:1});
 });
});

for(const broken of ['{broken',JSON.stringify({version:3,data:{fields:[]}})])it('保存済みフォームが壊れても必須3項目で予約を受け、版が変われば通知も確定も残さない',async()=>{
 const warn=vi.spyOn(logger,'warn').mockImplementation(()=>{});
 try{
  await saveRestaurantReservationForm(db.db,{storeId:'store',accountId:'a1',staffId:'owner',expectedVersion:0,definition:defaultRestaurantReservationForm()});
  db.raw.prepare("UPDATE account_settings SET value=? WHERE key='restaurant.reservation_form:store'").run(broken);
  db.raw.exec("INSERT INTO rt_reservation_links(store_id,token) VALUES('store','recovery-link')");
  const link=await request('/api/liff/restaurant/link/recovery-link');expect(link.status).toBe(200);
  const form=(await link.json() as {data:{reservationForm:{version:number;definition:{fields:{id:string;enabled:boolean}[]}}}}).data.reservationForm;
  expect(form.version).toBe(-1);expect(form.definition.fields.filter(field=>field.enabled).map(field=>field.id)).toEqual(['name','dateTime','guestCount']);
  const {data:h}=await read(await hold());const url=`/api/liff/restaurant/reservations/${h.id}/confirm`;
  expect((await request(url,{expectedVersion:h.version,expectedFormVersion:0})).status).toBe(409);
  const batch=db.db.batch.bind(db.db);
  vi.spyOn(db.db,'batch').mockImplementationOnce(async statements=>{
   db.raw.prepare("UPDATE account_settings SET value=? WHERE key='restaurant.reservation_form:store'").run(JSON.stringify({version:4,data:defaultRestaurantReservationForm()}));return batch(statements);
  });
  expect((await request(url,{expectedVersion:h.version,expectedFormVersion:-1})).status).toBe(409);
  expect(db.raw.prepare('SELECT status FROM rt_reservations WHERE id=?').get(h.id)).toEqual({status:'pending'});
  expect(db.raw.prepare('SELECT count(*) n FROM rt_customer_notice_outbox').get()).toEqual({n:0});
  db.raw.prepare("UPDATE account_settings SET value=? WHERE key='restaurant.reservation_form:store'").run(broken);
  expect((await request(url,{expectedVersion:h.version,expectedFormVersion:-1,customerName:'本人'})).status).toBe(200);
  expect(db.raw.prepare('SELECT count(*) n FROM rt_customer_notice_outbox').get()).toEqual({n:1});
  expect(warn).toHaveBeenCalledWith('restaurant_reservation_form_recovery');
 }finally{warn.mockRestore();}
});
