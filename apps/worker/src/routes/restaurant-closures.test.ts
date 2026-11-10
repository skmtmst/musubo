import { readApiError } from '@line-crm/shared';
/**
 * 席の空き待ちと席の来店の印（booking-plus 6 の席対応）。
 *
 * - 席の空き待ちの登録・二重登録は409・一覧・取り消し。
 * - 予約の取り消しで卓が空いたら、人数が入る組の早い順に1組だけカードが1通。
 *   入らない組は飛ばす。
 * - 「来店した」→案内済み、「遅れる」→分数だけ、「来なかった」→無断。
 *   だれがいつ付けたかが残り、取り消せる。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest';
import { Hono } from 'hono';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';

const authMocks = vi.hoisted(() => ({
  getPlatformSetting: async () => 'false', // Explicit Off fixture for route authorization.
  getStaffByApiKey: vi.fn(async () => null),
  getStaffByAdminSession: vi.fn(async () => null),
  lineAccounts: [] as Array<Record<string, unknown>>,
}));

vi.mock('@line-crm/db', async () => {
  const actual = await vi.importActual<typeof import('@line-crm/db')>('@line-crm/db');
  return {
    ...actual,
    getStaffByApiKey: authMocks.getStaffByApiKey,
    getStaffByAdminSession: authMocks.getStaffByAdminSession,
    getLineAccounts: vi.fn(async () => authMocks.lineAccounts),
    getLineAccountScopeEntries: vi.fn(async () => authMocks.lineAccounts),
  };
});

vi.mock('../features/booking/booking-automatic-line.js',()=>({sendAutomaticBookingLine:vi.fn(async()=>true)}));
import { sendAutomaticBookingLine } from '../features/booking/booking-automatic-line.js';

const cardSender = vi.mocked(sendAutomaticBookingLine);

const { authMiddleware } = await import('../middleware/auth.js');
const { restaurantTest } = await import('./restaurant-test.js');
type Env = import('../index.js').Env;

const here = dirname(fileURLToPath(import.meta.url));
let testDb: SqliteD1;
let env: Env['Bindings'];

const TENANT = '00000000-0000-4000-8000-000000000001';
// SQLite's julianday('now') uses the wall clock even when Vitest fakes Date.
// Keep waitlist fixtures in the future so the registration cutoff stays testable.
const SLOT_DATE = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
const SLOT = `${SLOT_DATE}T09:00:00.000Z`;
const SLOT_END = `${SLOT_DATE}T11:00:00.000Z`;

function seedStore() {
  testDb.raw.prepare(`UPDATE tenants SET feature_packs = '["restaurant"]' WHERE id = ?`).run(TENANT);
  testDb.raw.prepare(
    'INSERT INTO rt_organizations (id, account_id, tenant_id, name) VALUES (?, ?, ?, ?)',
  ).run('org-s', 'account-1', TENANT, 'S店');
  testDb.raw.prepare(
    `INSERT INTO rt_stores (id, organization_id, name, code, line_account_id, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('store-s', 'org-s', 'S店', 'S', 'account-9', 'active');
  testDb.raw.prepare(
    `INSERT INTO rt_tables (id, store_id, code, label, seat_type, min_capacity, max_capacity, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('table-1', 'store-s', 'T1', 'テーブル1', 'table', 1, 2, 1);
  testDb.raw.prepare(
    `INSERT INTO rt_tables (id, store_id, code, label, seat_type, min_capacity, max_capacity, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('table-2', 'store-s', 'T2', 'テーブル2', 'table', 2, 6, 1);
  testDb.raw.prepare(
    `INSERT INTO line_accounts (id, name, channel_id, channel_secret, channel_access_token)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('account-9', 'S店', 'channel-s', 'secret-s', 'token-s');
}

function seedReservation(id: string, status = 'confirmed', tableId: string | null = 'table-1') {
  testDb.raw.prepare(
    `INSERT INTO rt_reservations
      (id, store_id, source, customer_name, guest_count, starts_at, ends_at, table_id, status)
     VALUES (?, 'store-s', 'manual', '予約客', 2, ?, ?, ?, ?)`,
  ).run(id, SLOT, SLOT_END, tableId, status);
}

test('媒体作業は予約経路で絞り、開けた印はその世代だけに保存する',async()=>{
 seedReservation('line-r');seedReservation('phone-r','confirmed','table-2');
 testDb.raw.exec(`UPDATE rt_reservations SET source='line' WHERE id='line-r';UPDATE rt_reservations SET source='phone' WHERE id='phone-r';
 INSERT INTO rt_reservation_close_tasks(id,store_id,reservation_id,channel,starts_at,status) VALUES
 ('line-task','store-s','line-r','hotpepper','${SLOT}','reopen'),('phone-task','store-s','phone-r','tabelog','${SLOT}','close');
 INSERT INTO rt_inventory_slots(id,store_id,starts_at,total_capacity) VALUES('notice-slot','store-s','${SLOT}',8);
 INSERT INTO rt_channel_close_tasks(id,store_id,slot_id,channel,status,reason,remaining_seats) VALUES('slot-task','store-s','notice-slot','tabelog','reopen','limited',1);`);
 const line=await get('/api/restaurant-test/channel-close-tasks?storeId=store-s&source=line');
 expect(await line.json()).toMatchObject({data:[{id:'line-task',source:'line',generation:1,opened:false}]});
 expect(await (await get('/api/restaurant-test/channel-close-tasks?storeId=store-s&source=phone&channel=hotpepper')).json()).toMatchObject({data:[]});
 expect((await post('/api/restaurant-test/channel-close-tasks/phone-task/opened',{expectedGeneration:1})).status).toBe(409);
 expect((await post('/api/restaurant-test/channel-close-tasks/line-task/opened',{})).status).toBe(400);
 for(const id of ['line-task','slot-task']) {
  expect((await post(`/api/restaurant-test/channel-close-tasks/${id}/opened`,{expectedGeneration:1})).status).toBe(200);
  expect((await post(`/api/restaurant-test/channel-close-tasks/${id}/opened`,{expectedGeneration:1})).status).toBe(200);
 }
 expect(await (await get('/api/restaurant-test/channel-close-tasks?storeId=store-s&source=line')).json()).toMatchObject({data:[{id:'line-task',opened:true}]});
 testDb.raw.exec("UPDATE rt_reservation_close_tasks SET generation=2 WHERE id='line-task'");
 expect((await post('/api/restaurant-test/channel-close-tasks/line-task/opened',{expectedGeneration:1})).status).toBe(409);
 expect(await (await get('/api/restaurant-test/channel-close-tasks?storeId=store-s&source=line')).json()).toMatchObject({data:[{opened:false,generation:2}]});
 expect((await post('/api/restaurant-test/channel-close-tasks/missing/opened',{expectedGeneration:1})).status).toBe(404);
 authMocks.getStaffByApiKey.mockResolvedValue({id:'staff',role:'staff',name:'担当',permission_keys:'[]',tenant_id:TENANT} as never);
 const headers={Authorization:'Bearer staff-key','Content-Type':'application/json'};
 const acknowledge=()=>app().request('/api/restaurant-test/channel-close-tasks/line-task/opened?account_id=account-1',{method:'POST',headers,body:JSON.stringify({expectedGeneration:2})},env);
 expect((await acknowledge()).status).toBe(200);
 authMocks.getStaffByApiKey.mockResolvedValue({id:'staff',role:'staff',name:'担当',access_level:'read_only',permission_keys:'[]',tenant_id:TENANT} as never);
 expect((await acknowledge()).status).toBe(403);
});

function app() {
  const instance = new Hono<Env>();
  instance.use('*', authMiddleware);
  instance.route('/', restaurantTest);
  return instance;
}

function post(path: string, body: unknown) {
  return app().request(`${path}?account_id=account-1`, {
    method: 'POST',
    headers: { Authorization: 'Bearer owner-key', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, env);
}

function get(path: string) {
  const separator = path.includes('?') ? '&' : '?';
  return app().request(`${path}${separator}account_id=account-1`, {
    headers: { Authorization: 'Bearer owner-key' },
  }, env);
}

function patch(path: string, body: unknown) {
  const id=path.match(/^\/api\/restaurant-test\/reservations\/([^/?]+)(?:\?|$)/)?.[1];
  if(id&&body&&typeof body==='object'&&!('expectedVersion' in body))body={...body,expectedVersion:((testDb.raw.prepare('SELECT customer_version FROM rt_reservations WHERE id=?').get(id)) as {customer_version:number}|undefined)?.customer_version??1};

  return app().request(`${path}?account_id=account-1`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner-key', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, env);
}

function del(path: string) {
  return app().request(`${path}?account_id=account-1`, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer owner-key' },
  }, env);
}

beforeEach(() => {
  authMocks.getStaffByApiKey.mockReset();
  authMocks.getStaffByApiKey.mockResolvedValue(null);
  authMocks.getStaffByAdminSession.mockReset();
  authMocks.getStaffByAdminSession.mockResolvedValue(null);
  authMocks.lineAccounts = [
    { id: 'account-1', name: '統括', is_active: 1, channel_access_token: 'token-1' },
    { id: 'account-9', login_channel_id: 'login-seat', name: 'S店', is_active: 1, channel_access_token: 'token-s' },
  ];
  testDb = createTestD1({ loginPolicy: 'off' });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    endpoint: 'https://worker.example.test/webhook',
    active: true,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  env = {
    DB: testDb.db,
    API_KEY: 'owner-key',
    IMAGES: {} as R2Bucket,
    RAW_MAIL: {} as R2Bucket,
    ASSETS: {} as Fetcher,
    RESTAURANT_INTAKE_DOMAIN: 'intake.example.test',
    DEPLOY_ENV: 'test', RESTAURANT_TEST_ENABLED: 'true',
    LINE_CHANNEL_SECRET: 'unused', LINE_CHANNEL_ACCESS_TOKEN: 'unused',
    LIFF_URL: 'https://liff.line.me/test123', LINE_CHANNEL_ID: 'unused',
    LINE_LOGIN_CHANNEL_ID: 'unused', LINE_LOGIN_CHANNEL_SECRET: 'unused',
    WORKER_URL: 'https://worker.example.test',
    LINE_CREDENTIAL_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  };
  cardSender.mockClear();
  seedStore();
  vi.useFakeTimers({toFake:['Date']});
  vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
});


afterEach(()=>{testDb.raw.close();vi.unstubAllGlobals();vi.useRealTimers();});
function configurePhoneIntake() {
 const hours=Array.from({length:7},(_,weekday)=>({weekday,periods:[{opensAt:'17:00',closesAt:'23:00'}]}));
 testDb.raw.prepare("INSERT INTO rt_opening_hours_settings(store_id,hours_json,updated_by) VALUES('store-s',?,'test')").run(JSON.stringify(hours));
}
const closureInput={storeId:'store-s',startDate:SLOT_DATE,endDate:SLOT_DATE,allDay:false,startTime:'18:00',endTime:'20:00',kind:'temporary_closed'};
const closurePath='/api/restaurant-test/closures';
async function create(input:unknown=closureInput){const res=await post(closurePath,input);return {status:res.status,body:await res.json() as any};}
async function request(method:string,path:string,body:unknown){return app().request(`${path}?account_id=account-1`,{method,headers:{Authorization:'Bearer owner-key','Content-Type':'application/json'},body:JSON.stringify(body)},env);}
function reservationInput(tableId='table-1',startsAt=SLOT,endsAt=SLOT_END){return {storeId:'store-s',customerName:'試験',guestCount:2,tableId,startsAt,endsAt,source:'phone'};}
describe('日付で席予約を閉じる',()=>{
 test('過去・暦日不正・時刻逆転・重複卓・別店の卓を拒否し、店の暦日で判定する',async()=>{
  for(const input of [{...closureInput,startDate:'2000-01-01'}, {...closureInput,startDate:'2026-02-30'}, {...closureInput,startTime:'20:00',endTime:'18:00'}, {...closureInput,tableIds:['table-1','table-1']}, {...closureInput,tableIds:['other-store-table']}])expect((await create(input)).status).toBe(400);
  const {validateClosure}=await import('../services/restaurant-closures.js');
  expect(validateClosure({...closureInput,startDate:'2026-10-08',endDate:'2026-10-08'},'Asia/Tokyo',new Date('2026-10-07T23:00:00Z'))).not.toBeNull();
  expect(validateClosure({...closureInput,startDate:'2026-10-07',endDate:'2026-10-07'},'Asia/Tokyo',new Date('2026-10-07T23:00:00Z'))).toBeNull();
 });
 test('previewと保存の影響は一致し、保存後も既存予約は有効・メモ更新と取消もできる',async()=>{
  seedReservation('r-existing');
  testDb.raw.exec(`INSERT INTO friends(id,line_user_id,display_name,line_account_id,is_following) VALUES('friend','line-guest','試験','account-9',1);UPDATE rt_reservations SET line_uid='line-guest' WHERE id='r-existing';`);
  const wait=await post('/api/restaurant-test/seat-waitlist',{storeId:'store-s',startsAt:SLOT,guestCount:2,customerName:'待機'});expect(wait.status).toBe(201);
  const p=await post(closurePath+'/preview',closureInput);expect(p.status).toBe(200);const preview=(await p.json() as any).data;
  expect(testDb.raw.prepare('SELECT COUNT(*) n FROM rt_closures').get()).toEqual({n:0});
  const saved=await create();expect(saved.status).toBe(201);
  const {closure,...impact}=saved.body.data;expect(impact).toEqual(preview);expect(impact.waitlistCount).toBe(1);
  expect(impact.reservations).toEqual([expect.objectContaining({id:'r-existing',startsAt:SLOT,guestCount:2,customerName:'予約客',source:'manual',friendId:'friend',isLineFriend:true})]);
  expect(testDb.raw.prepare("SELECT status FROM rt_reservations WHERE id='r-existing'").get()).toEqual({status:'confirmed'});
  expect((await patch('/api/restaurant-test/reservations/r-existing',{note:'連絡済み'})).status).toBe(200);
  expect((await patch('/api/restaurant-test/reservations/r-existing',{status:'cancelled'})).status).toBe(200);
 });
 test('重なる記録は409で相手を返す。時刻の境目は重ならず、別の卓だけなら同時に閉じられる',async()=>{
  const saved=await create({...closureInput,kind:'private_event',tableIds:['table-1']});expect(saved.status).toBe(201);
  const overlap=await create({...closureInput,startTime:'19:00',endTime:'21:00',tableIds:['table-1']});expect(overlap.status).toBe(409);
  expect(overlap.body.data.conflicts.map((r:any)=>r.id)).toEqual([saved.body.data.closure.id]);
  expect((await create({...closureInput,tableIds:['table-2']})).status).toBe(201);
  expect((await create({...closureInput,startTime:'20:00',endTime:'21:00'})).status).toBe(201);
 });
 test('終日・月跨ぎの記録を対象月と両日台帳に返す。古い版で変更・削除できない',async()=>{
  const saved=await create({...closureInput,startDate:'2026-11-30',endDate:'2026-12-02',allDay:true});expect(saved.status).toBe(201);
  const id=saved.body.data.closure.id;
  const month=await get(closurePath+'?storeId=store-s&month=2026-12');expect((await month.json() as any).data.map((r:any)=>r.id)).toEqual([id]);
  for(const endpoint of ['reservations','inventory']){const res=await get(`/api/restaurant-test/${endpoint}/day?storeId=store-s&date=2026-12-01`);expect(res.status).toBe(200);const data=await res.json() as any;expect((data.closures??data.data.closures)[0].id).toBe(id);}
  expect((await request('PATCH',closurePath+'/'+id,{...closureInput,startDate:'2026-11-30',endDate:'2026-12-02',allDay:true,expectedVersion:2})).status).toBe(409);
  expect((await request('DELETE',closurePath+'/'+id,{expectedVersion:2})).status).toBe(409);
  const changed=await request('PATCH',closurePath+'/'+id,{...closureInput,startDate:'2026-11-30',endDate:'2026-12-02',allDay:true,memo:'変更',expectedVersion:1});expect(changed.status).toBe(200);
  expect((await changed.json() as any).data.closure.version).toBe(2);
 });
 test('一部貸切なら残りの卓に予約・仮押さえが入り、閉じた卓は理由付き409。終了の瞬間は空く',async()=>{
  configurePhoneIntake();
  expect((await create({...closureInput,kind:'private_event',tableIds:['table-1']})).status).toBe(201);
  const {openSeatTables}=await import('../services/restaurant-closures.js');
  expect((await openSeatTables(testDb.db,'store-s',SLOT,SLOT_END,2)).map(t=>t.id)).toEqual(['table-2']);
  const denied=await post('/api/restaurant-test/reservations/manual',reservationInput());expect(denied.status).toBe(409);expect((await denied.json() as any).code).toBe('closure_conflict');
  const hold=await post('/api/restaurant-test/reservations/holds',{...reservationInput(),holdMinutes:30});expect(hold.status).toBe(409);expect((await hold.json() as any).code).toBe('closure_conflict');
  const remaining=await post('/api/restaurant-test/reservations/manual',{...reservationInput(),tableId:undefined});expect(remaining.status).toBe(201);expect((await remaining.json() as any).data.tableId).toBe('table-2');
  const boundary=await post('/api/restaurant-test/reservations/holds',{...reservationInput('table-1',SLOT_END,`${SLOT_DATE}T12:00:00Z`),holdMinutes:30});expect(boundary.status).toBe(201);
 });
 test('全卓の休業は待機・仮押さえ・空き判定を止める。既存待機の招待と受諾も止まる',async()=>{
  const wait=await post('/api/restaurant-test/seat-waitlist',{storeId:'store-s',startsAt:SLOT,guestCount:2,customerName:'待機'});expect(wait.status).toBe(201);
  await create();
  expect((await post('/api/restaurant-test/reservations/holds',{...reservationInput(),holdMinutes:30})).status).toBe(409);
  const blocked=await post('/api/restaurant-test/seat-waitlist',{storeId:'store-s',startsAt:SLOT,guestCount:2,customerName:'新規待機'});expect(blocked.status).toBe(409);expect((await blocked.json() as any).error).toBe('closure_conflict');
  const {promoteSeatWaitlist}=await import('../services/restaurant-seat-waitlist.js');expect(await promoteSeatWaitlist(testDb.db,{storeId:'store-s',startsAt:SLOT,tableId:'table-1'})).toEqual({promoted:false,reason:'unavailable'});
  const res=await get(`/api/restaurant-test/availability?storeId=store-s&startsAt=${SLOT}&endsAt=${SLOT_END}&guestCount=2`);expect((await res.json() as any).data.tables).toEqual([]);
 });
 test('ウォークインは現在の日時で休業を判定し強制登録できない',async()=>{
  const {tzDateStr}=await import('../services/availability.js');const date=tzDateStr('Asia/Tokyo',new Date());
  expect((await create({...closureInput,startDate:date,endDate:date,allDay:true})).status).toBe(201);
  const res=await post('/api/restaurant-test/reservations/walk-in',{storeId:'store-s',tableId:'table-1',guestCount:2,force:true});expect(res.status).toBe(409);expect((await res.json() as any).code).toBe('closure_conflict');
 });
 test('保存した媒体の数だけ作業ができ、閉じた記録・変更・削除の再開案内を残す',async()=>{
  testDb.raw.exec(`INSERT INTO rt_media(id,code,name,parser_key) VALUES('m1','media1','媒体1','p1'),('m2','media2','媒体2','p2'),('m3','media3','媒体3','p3');
   INSERT INTO rt_store_media_links(store_id,media_id,close_on_booking) VALUES('store-s','m1',1),('store-s','m2',1),('store-s','m3',0);`);
  const saved=await create();expect(saved.status).toBe(201);const id=saved.body.data.closure.id;
  const tasks=await get('/api/restaurant-test/channel-close-tasks?storeId=store-s');const rows=(await tasks.json() as any).data;expect(rows).toHaveLength(2);expect(rows[0]).toMatchObject({reason:'closure',closureId:id,startDate:SLOT_DATE,startTime:'18:00',endTime:'20:00'});
  expect((await post('/api/restaurant-test/channel-close-tasks/'+rows[0].id+'/done',{})).status).toBe(200);
  expect((await request('DELETE',closurePath+'/'+id,{expectedVersion:1})).status).toBe(200);
  expect(testDb.raw.prepare('SELECT channel,status FROM rt_closure_close_tasks ORDER BY channel').all()).toEqual([{channel:'media1',status:'reopen'},{channel:'media2',status:'reopen'}]);
  const reopened=(await (await get('/api/restaurant-test/channel-close-tasks?storeId=store-s')).json() as {data:Array<{id:string;generation:number}>}).data;
  expect((await post('/api/restaurant-test/channel-close-tasks/'+reopened[0].id+'/opened',{expectedGeneration:reopened[0].generation})).status).toBe(200);
  expect((await (await get('/api/restaurant-test/channel-close-tasks?storeId=store-s')).json() as {data:Array<{opened:boolean}>}).data.filter(row=>row.opened)).toHaveLength(1);
  expect(testDb.raw.prepare('SELECT archived_at FROM rt_closures WHERE id=?').get(id)).toMatchObject({archived_at:expect.any(String)});
  expect((await (await get(closurePath+'?storeId=store-s')).json() as any).data).toEqual([]);
 });
 test('DBの書込ゲートも新規予約・重複休業・待機・招待を拒否し、通常の受付へ戻せる',async()=>{
  const saved=await create();expect(saved.status).toBe(201);
  expect(()=>seedReservation('blocked')).toThrow('closure_conflict');
  expect(()=>testDb.raw.exec(`INSERT INTO rt_closures SELECT 'duplicate',store_id,start_date,end_date,all_day,start_time,end_time,kind,memo,table_ids_json,periods_json,created_by,created_by_name,version,created_at,updated_at,archived_at,notify_media FROM rt_closures;`)).toThrow('closure_overlap');
  expect(()=>testDb.raw.prepare(`INSERT INTO rt_seat_waitlist(id,store_id,starts_at,ends_at,guest_count,customer_name,identity_key,status) VALUES('waiting','store-s',?,?,2,'試験','name:test','waiting')`).run(SLOT,SLOT_END)).toThrow('closure_conflict');
  await request('DELETE',closurePath+'/'+saved.body.data.closure.id,{expectedVersion:1});expect(()=>seedReservation('open')).not.toThrow();
 });
 test('閲覧のみは一覧・日別台帳を読めるが作成・preview・変更・削除できない',async()=>{
  const saved=await create(),id=saved.body.data.closure.id;
  authMocks.getStaffByApiKey.mockResolvedValue({id:'reader',role:'admin',name:'閲覧者',access_level:'read_only',permission_keys:'[]',tenant_id:TENANT} as never);
  const headers={Authorization:'Bearer reader-key','Content-Type':'application/json'};
  const read=await app().request(closurePath+'?account_id=account-1&storeId=store-s',{headers},env);expect(read.status).toBe(200);
  for(const [method,path,body] of [['POST',closurePath,closureInput],['POST',closurePath+'/preview',closureInput],['PATCH',closurePath+'/'+id,{...closureInput,expectedVersion:1}],['DELETE',closurePath+'/'+id,{expectedVersion:1}]] as const){expect((await app().request(path+'?account_id=account-1',{method,headers,body:JSON.stringify(body)},env)).status).toBe(403);}
 });
});

async function seatLiffRequest(path:string,body?:unknown,token='test-id-token') {
 testDb.raw.exec(`UPDATE line_accounts SET liff_id='liff-seat',login_channel_id='login-seat' WHERE id='account-9'; INSERT OR IGNORE INTO friends(id,line_user_id,display_name,line_account_id,is_following) VALUES('liff-friend','liff-user','本人','account-9',1);`);
 vi.stubGlobal('fetch',vi.fn(async(url:unknown)=>String(url).includes('oauth2/v2.1/verify')?new Response(JSON.stringify({sub:'liff-user'}),{status:200}):new Response('{}',{status:404})));
 const {default:booking}=await import('./booking.js');const app=new Hono<Env>();app.route('/',booking);
 return app.request(path+(path.includes('?')?'&':'?')+'liffId=liff-seat',{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json', 'Idempotency-Key':'test-key'},body:body===undefined?undefined:JSON.stringify(body)},env);
}
test('LINE本人確認つきのLIFF空き照会・待機・招待受諾で休業を守り、他店へアクセスできない',async()=>{
 const until=new Date(Date.now()+30*60_000).toISOString();
 testDb.raw.prepare(`INSERT INTO rt_seat_waitlist(id,store_id,starts_at,ends_at,table_id,guest_count,customer_name,line_uid,identity_key,status,hold_expires_at) VALUES('offer','store-s',?,?,'table-1',2,'本人','liff-user','line:liff-user','invited',?)`).run(SLOT,SLOT_END,until);
 expect((await create()).status).toBe(201);
 const res=await seatLiffRequest(`/api/liff/booking/seat-availability?store_id=store-s&starts_at=${SLOT}&ends_at=${SLOT_END}&guest_count=2`);expect(res.status).toBe(200);expect((await res.json() as any).data.tables).toEqual([]);
 expect((await seatLiffRequest(`/api/liff/booking/seat-availability?store_id=other&starts_at=${SLOT}&ends_at=${SLOT_END}&guest_count=2`)).status).toBe(404);
 const wait=await seatLiffRequest('/api/liff/booking/seat-waitlist',{store_id:'store-s',starts_at:SLOT,guest_count:2});expect(wait.status).toBe(409);expect((await wait.json() as any).error).toBe('closure_conflict');
 const accept=await seatLiffRequest('/api/liff/booking/seat-waitlist/offer/accept',{});expect(accept.status).toBe(409);expect((await accept.json() as any).error).toBe('closure_conflict');
});

test('日別在庫の空き席は閉じた卓を差し引き、既存予約との二重計上をしない',async()=>{
 testDb.raw.prepare(`INSERT INTO rt_inventory_slots(id,store_id,starts_at,total_capacity,line_capacity,ota_capacity,walk_in_capacity) VALUES('slot','store-s',?,8,4,2,2)`).run(SLOT);
 seedReservation('existing');
 expect((await create({...closureInput,kind:'private_event',tableIds:['table-1']})).status).toBe(201);
 const partial=await get(`/api/restaurant-test/inventory/day?storeId=store-s&date=${SLOT_DATE}`);expect((await partial.json() as any).data[0]).toMatchObject({freeSeats:6,closedTableIds:['table-1']});
 expect((await create({...closureInput,tableIds:['table-2']})).status).toBe(201);
 const all=await get(`/api/restaurant-test/inventory/day?storeId=store-s&date=${SLOT_DATE}`);expect((await all.json() as any).data[0].freeSeats).toBe(0);
});
test('既存の仮押さえを休業保存後に確定予約へ変えられない',async()=>{
 configurePhoneIntake();
 const held=await post('/api/restaurant-test/reservations/holds',{...reservationInput(),holdMinutes:30});expect(held.status).toBe(201);
 const id=(await held.json() as any).data.id;await create();
 expect(()=>testDb.raw.prepare("UPDATE rt_reservations SET status='confirmed' WHERE id=?").run(id)).toThrow('closure_conflict');
});
test('媒体ごとの担当者LINE通知は一度ずつで、削除後に再開を一度ずつ知らせる',async()=>{
 testDb.raw.exec(`INSERT INTO rt_media(id,code,name,parser_key) VALUES('m1','media1','媒体1','p1'),('m2','media2','媒体2','p2');
 INSERT INTO rt_store_media_links(store_id,media_id,close_on_booking) VALUES('store-s','m1',1),('store-s','m2',1);
 INSERT INTO rt_memberships(id,organization_id,store_id,staff_name,role,line_uid,status) VALUES('manager','org-s','store-s','店長','store_manager','manager-line','active');`);
 const saved=await create();expect(saved.status).toBe(201);expect(cardSender).toHaveBeenCalledTimes(2);
 expect(cardSender.mock.calls.every(([,v])=>v.to==='manager-line'&&v.text.includes('臨時休業')&&v.text.includes('18:00〜20:00'))).toBe(true);
 const {processRestaurantInventoryRuleQueue}=await import('../services/restaurant-inventory-rules.js');await processRestaurantInventoryRuleQueue(env);expect(cardSender).toHaveBeenCalledTimes(2);
 await request('DELETE',closurePath+'/'+saved.body.data.closure.id,{expectedVersion:1});expect(cardSender).toHaveBeenCalledTimes(4);
 expect(cardSender.mock.calls.slice(2).every(([,v])=>v.text.includes('もう開けてよい'))).toBe(true);
 await processRestaurantInventoryRuleQueue(env);expect(cardSender).toHaveBeenCalledTimes(4);
});

test('一部貸切で残りの卓が満席ならLIFFの待機を受け、閉じた卓を空きとして数えない',async()=>{
 seedReservation('full-other','confirmed','table-2');await create({...closureInput,kind:'private_event',tableIds:['table-1']});
 const res=await seatLiffRequest('/api/liff/booking/seat-waitlist',{store_id:'store-s',starts_at:SLOT,guest_count:2});expect(res.status).toBe(201);
 const {id}=await res.json() as {id:string};expect(testDb.raw.prepare('SELECT status FROM rt_seat_waitlist WHERE id=?').get(id)).toEqual({status:'waiting'});
});

test('変更のpreviewは自分だけを除外し、他店や存在しないIDは除外できない',async()=>{
 const saved=await create(),id=saved.body.data.closure.id;
 expect((await post(closurePath+'/preview',closureInput)).status).toBe(409);
 const ok=await post(closurePath+'/preview',{...closureInput,excludeId:id});expect(ok.status).toBe(200);expect((await ok.json() as any).data.conflicts).toEqual([]);
 expect((await post(closurePath+'/preview',{...closureInput,excludeId:'other-id'})).status).toBe(404);
});
test('重なり409のdataに相手の名前と日付が入り、previewに電話・LINE友だちを返す',async()=>{
 seedReservation('with-phone');testDb.raw.exec("UPDATE rt_reservations SET customer_phone='09012345678' WHERE id='with-phone'");
 const preview=await post(closurePath+'/preview',closureInput);expect((await preview.json() as any).data.reservations[0]).toMatchObject({customerPhone:'09012345678',friendId:null,isLineFriend:false});
 await create({...closureInput,memo:'設備の交換'});const res=await create();expect(res.body).toMatchObject({code:'closure_overlap',data:{conflicts:[expect.objectContaining({name:'設備の交換',startDate:SLOT_DATE,endDate:SLOT_DATE})]}});
});
test('連絡済みは作成後に担当者が手動送信した重なる予約だけを数え、同じ予約は一度',async()=>{
 seedReservation('r1');seedReservation('r2','confirmed','table-2');seedReservation('r3','confirmed',null);
 testDb.raw.exec("INSERT INTO friends(id,line_user_id,line_account_id) VALUES('f1','u1','account-9'),('f2','u2','account-9'),('f3','u3','account-9');UPDATE rt_reservations SET line_uid=CASE id WHEN 'r1' THEN 'u1' WHEN 'r2' THEN 'u2' ELSE 'u3' END;");
 const saved=await create(),id=saved.body.data.closure.id;
 testDb.raw.prepare("UPDATE rt_closures SET created_at='2026-10-07 01:00:00' WHERE id=?").run(id);
 const insert=testDb.raw.prepare("INSERT INTO messages_log(id,friend_id,direction,message_type,content,source,sent_by_staff_id,created_at) VALUES(?,?,'outgoing','text','連絡',?,?,?)");
 insert.run('old','f2','manual','staff','2026-10-07T09:59:59');insert.run('auto','f3','broadcast','staff','2026-10-07T10:00:01');
 insert.run('new1','f1','manual','staff','2026-10-07T10:00:01');insert.run('new2','f1','manual','staff','2026-10-07T01:00:02Z');
 const res=await get(closurePath+'/'+id+'/contact-status');expect(res.status).toBe(200);const result=(await res.json() as any).data;
 expect(result.contactedCount).toBe(1);expect(result.reservations.map((r:any)=>[r.id,r.contacted])).toEqual([['r1',true],['r2',false],['r3',false]]);
});
test('通知なしで保存・変更した休業には新しい媒体閉鎖作業を作らない',async()=>{
 testDb.raw.exec("INSERT INTO rt_media(id,code,name,parser_key) VALUES('m','media','媒体','p');INSERT INTO rt_store_media_links(store_id,media_id,close_on_booking) VALUES('store-s','m',1)");
 const saved=await create({...closureInput,notifyMedia:false});expect(saved.status).toBe(201);expect(saved.body.data.closure.notifyMedia).toBe(false);
 expect(testDb.raw.prepare('SELECT COUNT(*) n FROM rt_closure_close_tasks').get()).toEqual({n:0});
 const id=saved.body.data.closure.id;await request('PATCH',closurePath+'/'+id,{...closureInput,notifyMedia:true,expectedVersion:1});
 expect(testDb.raw.prepare('SELECT COUNT(*) n FROM rt_closure_close_tasks').get()).toEqual({n:1});
 await request('PATCH',closurePath+'/'+id,{...closureInput,notifyMedia:false,expectedVersion:2});
 expect(testDb.raw.prepare('SELECT status FROM rt_closure_close_tasks').all()).toEqual([{status:'reopen'}]);
});
test('店ごとの再開通知と宛先を版付きで保存し、取消後の通知を止める',async()=>{
 testDb.raw.exec("INSERT INTO rt_media(id,code,name,parser_key) VALUES('m','media','媒体','p');INSERT INTO rt_store_media_links(store_id,media_id,close_on_booking) VALUES('store-s','m',1);INSERT INTO rt_memberships(id,organization_id,store_id,staff_name,role,line_uid,status) VALUES('manager','org-s','store-s','店長','store_manager','uid','active');");
 const settings={storeId:'store-s',notifyReopen:false,recipientMode:'selected',membershipIds:['manager'],expectedVersion:0};
 const path='/api/restaurant-test/close-notification-settings';expect((await request('PUT',path,settings)).status).toBe(200);expect((await request('PUT',path,settings)).status).toBe(409);
 expect((await request('PUT',path,{...settings,membershipIds:['other-member'],expectedVersion:1})).status).toBe(403);
 const saved=await create();expect(cardSender).toHaveBeenCalledTimes(1);
 await request('DELETE',closurePath+'/'+saved.body.data.closure.id,{expectedVersion:1});expect(cardSender).toHaveBeenCalledTimes(1);
 expect(testDb.raw.prepare('SELECT status FROM rt_closure_close_tasks').get()).toEqual({status:'reopen'});
});

it('媒体設定の店舗不一致は同じ機械コードを返し、日本語の案内と状態を保つ', async () => {
  const root = '/api/restaurant-test/';
  const cases = [
    ['GET', 'media-links', 400, '店舗を確認してください'],
    ['PUT', 'media-links/hotpepper', 400, '店舗を確認してください'],
    ['GET', 'channels', 400, '店舗が正しくありません'],
    ['GET', 'close-notification-settings', 404, '店舗が正しくありません'],
    ['PUT', 'close-notification-settings', 404, '店舗が正しくありません'],
  ] as const;
  for (const [method, resource, status, message] of cases) {
    const body = resource.startsWith('media-links') ? { storeId: 'missing-store', pageUrl: null, loginUrl: null, closeOnBooking: false, expectedVersion: 0 } : { storeId: 'missing-store', notifyReopen: false, recipientMode: 'responsible', membershipIds: [], expectedVersion: 1 };
    const response = await app().request(`${root}${resource}?account_id=account-1&storeId=missing-store`, { method, headers: { Authorization: 'Bearer owner-key', 'Content-Type': 'application/json' }, body: method === 'PUT' ? JSON.stringify(body) : undefined }, env);
    expect(response.status, resource).toBe(status);
    expect(readApiError(await response.json()), resource).toMatchObject({ code: 'restaurant_store_mismatch', message });
  }
});
