import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultRestaurantReservationForm } from '@line-crm/shared';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import * as followupTestSend from '../services/restaurant-followup-test-send.js';
import { NotificationDeliveryIncomplete } from '../services/recorded-notification-send.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
type MockStaff = {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'staff';
  access_level: 'full' | 'read_only';
  permission_keys: string;
  view_permission_keys?: string;
  assigned_line_account_id: string | null;
  can_access_descendant_accounts: number;
  tenant_id?: string | null;
};

const authMocks = vi.hoisted(() => ({
  getPlatformSetting: async () => 'false', // Explicit Off fixture for route authorization.
  getStaffByApiKey: vi.fn(async (): Promise<MockStaff | null> => null),
  getStaffByAdminSession: vi.fn(async (): Promise<MockStaff | null> => null),
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

const { authMiddleware, sha256Hex } = await import('../middleware/auth.js');
const { restaurantTest } = await import('./restaurant-test.js');
type Env = import('../index.js').Env;

let testDb: SqliteD1;
let env: Env['Bindings'];



function app() {
  const instance = new Hono<Env>();
  instance.use('*', authMiddleware);
  instance.route('/', restaurantTest);
  return instance;
}

function request(path: string, body?: unknown) {
  return requestAs(path, 'owner-key', body);
}

function requestAs(path: string, token: string, body?: unknown) {
  return app().request(path, body === undefined ? {
    headers: { Authorization: `Bearer ${token}` },
  } : {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, env);
}

function requestWithMethod(path: string, method: string, body?: unknown, token = 'owner-key') {
  return app().request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env);
}

beforeEach(() => {
  authMocks.getStaffByApiKey.mockReset();
  authMocks.getStaffByApiKey.mockResolvedValue(null);
  authMocks.getStaffByAdminSession.mockReset();
  authMocks.getStaffByAdminSession.mockResolvedValue(null);
  authMocks.lineAccounts = [
    { id: 'account-1', name: '統括', is_active: 1, channel_access_token: 'token-1' },
    { id: 'account-2', name: '店舗A', is_active: 1, channel_access_token: 'token-2' },
    { id: 'account-3', name: '店舗B', is_active: 1, channel_access_token: 'token-3' },
    { id: 'account-4', name: '予備', is_active: 1, channel_access_token: 'token-4' },
  ];
  testDb = createTestD1({ loginPolicy: 'off' });

  // 統括ゲート（飲食店機能パック）。このAPI群自体を検証するファイルなので
  // 既定の統括には常にパックを付けておく。ゲート自体の検証（無し→404）は
  // 別のdescribeで明示的に上書きする。
  testDb.raw.prepare(`UPDATE tenants SET feature_packs = '["restaurant"]' WHERE id = '00000000-0000-4000-8000-000000000001'`).run();
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
    LIFF_URL: 'https://example.test', LINE_CHANNEL_ID: 'unused',
    LINE_LOGIN_CHANNEL_ID: 'unused', LINE_LOGIN_CHANNEL_SECRET: 'unused',
    WORKER_URL: 'https://worker.example.test',
    LINE_CREDENTIAL_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  };
});


afterEach(()=>{testDb.raw.close();vi.unstubAllGlobals()});
function newStore() {
 testDb.raw.exec(`INSERT INTO line_accounts(id,name,channel_id,channel_secret,channel_access_token) VALUES('account-1','店','c','s','t'),('account-2','別店','d','s','t');
 INSERT INTO rt_organizations(id,account_id,name) VALUES('o','account-1','組織'),('other','account-2','別組織');
 INSERT INTO rt_stores(id,organization_id,name,code,line_account_id) VALUES('new','o','新しい店','NEW','account-1'),('foreign','other','他店','FOREIGN','account-2');`);
}
const path='/api/restaurant-test/followups/new',scope='?account_id=account-1';
describe('新しい送り手の保存・承認のHTTP境界',()=>{
 async function initialRows(){
  const page=await (await request(path+scope)).json() as {data:{rows:Array<{trigger:string;version:number}>}};
  return page.data.rows.map(row=>({trigger:row.trigger,input:{expectedRowVersion:row.version,expectedTargetVersion:0,expectedContentRevision:null,enabled:row.trigger==='reservation_created',timing:{mode:'countdown',offsetMinutes:0},messageBubbles:[{id:'text',type:'text',content:{text:'ご予約ありがとうございます'}}]}}));
 }
 it('初回は7行まとめて保存し、停止した実物と最新版を返す',async()=>{
  newStore();const rows=await initialRows();
  expect((await request(path+'/engines/reservation_created/draft'+scope,rows.find(row=>row.trigger==='reservation_created')!.input)).status).toBe(409);
  const response=await request(path+'/engines/initialize'+scope,{rows});expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({data:{engines:[expect.objectContaining({engine:'automation',targetVersion:1,effectiveSendingStatus:'stopped'})],message:expect.stringContaining('まだ送っていません')}});
  expect(testDb.raw.prepare('SELECT count(*) n FROM automation_definitions').get()).toEqual({n:1});
  const repeated=await request(path+'/engines/initialize'+scope,{rows});expect(repeated.status).toBe(409);
  expect(testDb.raw.prepare('SELECT count(*) n FROM automation_definitions').get()).toEqual({n:1});
 });
 it('未テストは公開せず、権限を本文で偽ってもstaffや閲覧のみは操作できない',async()=>{
  newStore();await request(path+'/engines/initialize'+scope,{rows:await initialRows()});
  const body={expectedTargetVersion:1,expectedContentHash:'fake',canApprove:true,staffId:'owner'};
  expect((await request(path+'/engines/reservation_created/start'+scope,body)).status).toBe(409);
  for(const access_level of ['full','read_only'] as const){
   authMocks.getStaffByApiKey.mockResolvedValue({id:'limited',name:'担当',role:access_level==='full'?'staff':'admin',access_level,permission_keys:'[]',assigned_line_account_id:null,can_access_descendant_accounts:1});
   for(const operation of ['draft','test-send','start'])expect((await requestAs(path+'/engines/reservation_created/'+operation+scope,'limited',body)).status).toBe(403);
  }
  expect(testDb.raw.prepare('SELECT count(*) n FROM rt_approval_requests').get()).toEqual({n:0});
 });
 it('店の外の保存と読取を拒否し、対象を増やさない',async()=>{
  newStore();const rows=await initialRows();
  expect((await request('/api/restaurant-test/followups/foreign/engines/initialize'+scope,{rows})).status).toBe(404);
  expect((await request('/api/restaurant-test/followups/foreign/engines'+scope)).status).toBe(404);
  expect(testDb.raw.prepare('SELECT count(*) n FROM automation_definitions').get()).toEqual({n:0});
 });
 it('閲覧のみでも現在の送り方を読めるが保存はできない',async()=>{
  newStore();
  authMocks.getStaffByApiKey.mockResolvedValue({id:'reader',name:'閲覧',role:'admin',access_level:'read_only',permission_keys:'[]',assigned_line_account_id:null,can_access_descendant_accounts:1});
  expect((await requestAs(path+'/engines'+scope,'reader')).status).toBe(200);
  expect((await requestAs(path+'/engines/initialize'+scope,'reader',{rows:[]})).status).toBe(403);
 });
 it('壊れた吹き出しの保存は入力の誤りとして返し、実物を残さない',async()=>{
  newStore();const rows=await initialRows();
  rows.find(row=>row.trigger==='reservation_created')!.input.messageBubbles=[{id:'broken',type:'text',content:{text:''}}];
  const response=await request(path+'/engines/initialize'+scope,{rows});expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({code:'invalid_followup',error:'本文を入力するか、テンプレートを選んでください。',fields:{messageBubbles:'本文を入力するか、テンプレートを選んでください。'}});
  expect(testDb.raw.prepare('SELECT count(*) n FROM automation_definitions').get()).toEqual({n:0});
 });
 it.each([
  {trigger:'anniversary_before',timing:{mode:'time',offsetDays:-366,sendAtTime:'10:00'},reason:'記念日の1〜365日前の日数と、00:00〜23:59の時刻を指定してください。'},
  {trigger:'reservation_24h',timing:{mode:'countdown',offsetMinutes:0},reason:'予約前の時間は1分〜365日で指定してください。'},
  {trigger:'reservation_2h',timing:{mode:'next_day',sendAtTime:'10:00'},reason:'この送り方は日時か、予約の前の時間で指定してください。'},
  {trigger:'post_visit',timing:{mode:'countdown',offsetMinutes:-5},reason:'待つ時間は0以上・365日以内の5分単位で指定してください。'},
 ])('$triggerの時期の保存失敗は該当の欄と修正方法を返し、実物を作らない',async({trigger,timing,reason})=>{
  newStore();const rows=await initialRows();Object.assign(rows.find(row=>row.trigger===trigger)!.input,{enabled:true,timing});
  const response=await request(path+'/engines/initialize'+scope,{rows});expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({code:'invalid_followup',error:reason,fields:{timing:reason}});
  expect(testDb.raw.prepare('SELECT count(*) n FROM rt_store_followup_targets').get()).toEqual({n:0});
  expect(testDb.raw.prepare('SELECT count(*) n FROM automation_definitions').get()).toEqual({n:0});
 });
 it('分割後の吹き出しが5通を超えたら、本文を減らす理由を返す',async()=>{
  newStore();const rows=await initialRows();rows.find(row=>row.trigger==='reservation_created')!.input.messageBubbles=[{id:'long',type:'text',content:{text:'a'.repeat(25001)}}];
  const response=await request(path+'/engines/initialize'+scope,{rows});expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({fields:{messageBubbles:'文章の自動分割とボタンを合わせて5通までです。本文や吹き出しを減らしてください'}});
  expect(testDb.raw.prepare('SELECT count(*) n FROM automation_definitions').get()).toEqual({n:0});
 });
 it('前日の返事を含めて6通になる保存は本文を減らす理由を返し、実物は増やさない',async()=>{
  newStore();expect((await request(path+'/engines/initialize'+scope,{rows:await initialRows()})).status).toBe(200);
  const rows=await initialRows(),row=rows.find(item=>item.trigger==='reservation_24h')!;
  row.input.enabled=true;row.input.timing={mode:'countdown',offsetMinutes:-1440};
  row.input.messageBubbles=Array.from({length:5},(_,i)=>({id:`text-${i}`,type:'text',content:{text:`確認の本文${i+1}`}}));
  const response=await request(path+'/engines/reservation_24h/draft'+scope,row.input);expect(response.status).toBe(422);const body=await response.json();
  expect(body).toMatchObject({code:'invalid_followup',fields:{messageBubbles:'予約の返事の入口を含めて5つ以内になるよう、吹き出しを減らしてください'}});
  expect(testDb.raw.prepare('SELECT count(*) n FROM reminders').get()).toEqual({n:0});
  expect(testDb.raw.prepare('SELECT count(*) n FROM rt_store_followup_targets').get()).toEqual({n:1});
  if(process.env.VISUAL_QA_RESPONSE_DIR)writeFileSync(join(process.env.VISUAL_QA_RESPONSE_DIR,'reply-limit-422.json'),JSON.stringify(body,null,2));
 });
 it('読み取れない本文は選び直しを案内し、内部例外や入力値を返さない',async()=>{
  newStore();const rows=await initialRows();rows.find(row=>row.trigger==='reservation_created')!.input.messageBubbles=[{id:'broken',type:'flex',content:{text:'private-fixture-value'}}];
  const response=await request(path+'/engines/initialize'+scope,{rows});expect(response.status).toBe(422);const body=await response.json();
  expect(body).toMatchObject({fields:{messageBubbles:'本文の形式を読み取れません。テンプレートを選び直すか、テキストを入れて保存し直してください。'}});
  expect(JSON.stringify(body)).not.toContain('private-fixture-value');expect(JSON.stringify(body)).not.toContain('messageBubbles flex');
 });
});
describe('7行の補完とオンのHTTP境界',()=>{
 it('未作成の正当な店は200と7行、知らない店は404',async()=>{
  newStore();const response=await request(path+scope);expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({data:{template:null,bindings:[],rows:expect.any(Array)}});
  expect((testDb.raw.prepare('SELECT COUNT(*) n FROM rt_store_followup_rows WHERE store_id=\'new\'').get() as any).n).toBe(7);
  expect((await request('/api/restaurant-test/followups/missing'+scope)).status).toBe(404);
  expect((await request('/api/restaurant-test/followups/foreign'+scope)).status).toBe(404);
 });
 it('行のオンは200、古い版は409、入力違いと店の外を拒否する',async()=>{
  newStore();const url=path+'/rows/reservation_created'+scope;
  expect((await requestWithMethod(url,'PUT',{expectedRowVersion:1,enabled:true})).status).toBe(200);
  expect((await requestWithMethod(url,'PUT',{expectedRowVersion:1,enabled:true})).status).toBe(409);
  for(const body of [{enabled:true},{expectedRowVersion:1,enabled:'true'},{expectedRowVersion:0,enabled:true}]) expect((await requestWithMethod(url,'PUT',body)).status).toBe(400);
  expect((await requestWithMethod(path+'/rows/bad'+scope,'PUT',{expectedRowVersion:1,enabled:true})).status).toBe(400);
  expect((await requestWithMethod('/api/restaurant-test/followups/foreign/rows/reservation_created'+scope,'PUT',{expectedRowVersion:1,enabled:true})).status).toBe(404);
 });
 it('閲覧のみとstaffの更新を拒否し、本体を作らない',async()=>{
  newStore();
  authMocks.getStaffByApiKey.mockResolvedValue({id:'reader',name:'閲覧',role:'admin',access_level:'read_only',permission_keys:'[]',assigned_line_account_id:null,can_access_descendant_accounts:1});
  expect((await requestWithMethod(path+'/rows/reservation_created'+scope,'PUT',{expectedRowVersion:1,enabled:true},'reader')).status).toBe(403);
  authMocks.getStaffByApiKey.mockResolvedValue({id:'staff',name:'担当',role:'staff',access_level:'full',permission_keys:'[]',assigned_line_account_id:null,can_access_descendant_accounts:1});
  expect((await requestWithMethod(path+'/rows/reservation_created'+scope,'PUT',{expectedRowVersion:1,enabled:true},'staff')).status).toBe(403);
  expect((testDb.raw.prepare('SELECT COUNT(*) n FROM scenarios').get() as any).n).toBe(0);
 });
 it('記念日は何日前と現地時刻を保存し、不正な時期と別起点への記念日時刻を拒む',async()=>{
  newStore();expect((await requestWithMethod(path+'/rows/anniversary_before'+scope,'PUT',{expectedRowVersion:1,enabled:true})).status).toBe(200);
  const get=async()=> (await (await request(path+scope)).json() as any).data;
  let page=await get();const step=page.bindings[0].step_id,url=path+'/bindings/'+step+scope;
  const body={expectedVersion:page.template.template_version,trigger:'anniversary_before',anniversaryDaysBefore:3,anniversaryTime:'09:25',enabled:true};
  expect((await requestWithMethod(url,'PATCH',body)).status).toBe(200);page=await get();
  expect(page.bindings[0]).toMatchObject({offset_minutes:-4320,anniversary_time:'09:25'});
  for(const change of [{anniversaryTime:'24:00'},{anniversaryDaysBefore:0},{anniversaryDaysBefore:366},{anniversaryDaysBefore:2,offsetMinutes:-1440},{anniversaryDaysBefore:null},{anniversaryDaysBefore:undefined,offsetMinutes:null},{anniversaryDaysBefore:undefined,offsetMinutes:-10079},{trigger:'post_visit',anniversaryDaysBefore:undefined,offsetMinutes:5}]) {
    expect((await requestWithMethod(url,'PATCH',{...body,...change,expectedVersion:page.template.template_version})).status).toBe(400);
  }
  expect((await request(path+'/request-start'+scope,{expectedVersion:page.template.template_version})).status).toBe(409);
 });
});

it('LINE未接続は版競合と区別して案内する',async()=>{
 newStore();testDb.raw.exec("UPDATE rt_stores SET line_account_id=NULL WHERE id='new'");
 const response=await requestWithMethod(path+'/rows/reservation_created'+scope,'PUT',{expectedRowVersion:1,enabled:true});
 expect(response.status).toBe(409);expect(await response.json()).toMatchObject({code:'line_account_required'});
});

it('来店フォローは長い店名を含むシナリオを作れる', async () => {
 newStore(); const name = '長い店舗名'.repeat(14);
 testDb.raw.prepare("UPDATE rt_stores SET name=? WHERE id='new'").run(name);
 const response = await requestWithMethod(path+'/rows/reservation_created'+scope,'PUT',{expectedRowVersion:1,enabled:true});
 expect(response.status).toBe(200);
 expect(testDb.raw.prepare("SELECT name FROM scenarios WHERE line_account_id='account-1'").get()).toEqual({ name: 'LINE来店フォロー：' + name });
});

describe('来店フォローを使わない判断の保存',()=>{
 it('未保存は未確認、全オフの明示保存は店ごとに残り、古い版を拒否する',async()=>{
  newStore();
  expect(await (await request(path+scope)).json()).toMatchObject({data:{setup:{notUsing:false,decidedAt:null,version:0}}});
  const url=path+'/setup'+scope;
  const saved=await requestWithMethod(url,'PUT',{notUsing:true,expectedVersion:0});expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({data:{notUsing:true,version:1,decidedAt:expect.any(String)}});
  expect((await requestWithMethod(url,'PUT',{notUsing:true,expectedVersion:0})).status).toBe(409);
  expect(testDb.raw.prepare('SELECT count(*) n FROM scenarios').get()).toEqual({n:0});
  expect(testDb.raw.prepare("SELECT count(*) n FROM rt_store_followup_preferences WHERE store_id='foreign'").get()).toEqual({n:0});
 });
 it('送り方がオンの時は使わない判断を保存せず、後からオンにすると判断を解除する',async()=>{
  newStore();const url=path+'/setup'+scope;
  await requestWithMethod(url,'PUT',{notUsing:true,expectedVersion:0});
  await requestWithMethod(path+'/rows/reservation_created'+scope,'PUT',{expectedRowVersion:1,enabled:true});
  expect(await (await request(path+scope)).json()).toMatchObject({data:{setup:{notUsing:false,decidedAt:null,version:2},rows:expect.arrayContaining([expect.objectContaining({trigger:'reservation_created',enabled:true})])}});
  const rejected=await requestWithMethod(url,'PUT',{notUsing:true,expectedVersion:2});expect(rejected.status).toBe(409);
  expect(await rejected.json()).toMatchObject({code:'followup_rows_enabled',enabledTriggers:['reservation_created'],error:expect.stringContaining('予約したとき')});
 });
 it('入力違い・別組織・閲覧のみ・staffは保存できない',async()=>{
  newStore();const url=path+'/setup'+scope;
  for(const body of [{notUsing:false,expectedVersion:0},{notUsing:true,expectedVersion:-1},{notUsing:true,expectedVersion:'0'}])expect((await requestWithMethod(url,'PUT',body)).status).toBe(400);
  expect((await requestWithMethod('/api/restaurant-test/followups/foreign/setup'+scope,'PUT',{notUsing:true,expectedVersion:0})).status).toBe(404);
  for(const staff of [{id:'viewer',role:'admin' as const,access_level:'read_only' as const},{id:'staff',role:'staff' as const,access_level:'full' as const}]){
   authMocks.getStaffByApiKey.mockResolvedValue({...staff,name:'担当者',permission_keys:'[]',assigned_line_account_id:null,can_access_descendant_accounts:1});
   expect((await requestWithMethod(url,'PUT',{notUsing:true,expectedVersion:0},staff.id)).status).toBe(403);
  }
  expect(testDb.raw.prepare('SELECT count(*) n FROM rt_store_followup_preferences').get()).toEqual({n:0});
 });
});

it('使わない判断は認証されたテナントの外から読み書きできない',async()=>{
 newStore();
 authMocks.getStaffByApiKey.mockResolvedValue({id:'admin',name:'担当',role:'admin',access_level:'full',permission_keys:'[]',assigned_line_account_id:null,can_access_descendant_accounts:0,tenant_id:'00000000-0000-4000-8000-000000000001'});
 const other='?tenant_id=00000000-0000-4000-8000-000000000099';
 expect((await requestWithMethod(path+'/setup'+other,'PUT',{notUsing:true,expectedVersion:0},'admin')).status).toBe(403);
 expect((await requestAs(path+other,'admin')).status).toBe(403);
 expect(testDb.raw.prepare('SELECT count(*) n FROM rt_store_followup_preferences').get()).toEqual({n:0});
});

it('新しい送り手のオンでも見送りを解除し、同時の判断は1件だけを保存する',async()=>{
 newStore();const url=path+'/setup'+scope;
 const results=await Promise.all([requestWithMethod(url,'PUT',{notUsing:true,expectedVersion:0}),requestWithMethod(url,'PUT',{notUsing:true,expectedVersion:0})]);
 expect(results.map(r=>r.status).sort()).toEqual([200,409]);
 testDb.raw.exec(`INSERT INTO automation_definitions(id,line_account_id,name) VALUES('target','account-1','お礼');
 INSERT INTO rt_store_followup_targets(store_id,trigger,engine,automation_id,enabled) VALUES('new','post_visit','automation','target',1);`);
 expect(await (await request(path+scope)).json()).toMatchObject({data:{setup:{notUsing:false,version:2},rows:expect.arrayContaining([expect.objectContaining({trigger:'post_visit',enabled:true})])}});
 expect((await requestWithMethod(url,'PUT',{notUsing:true,expectedVersion:2})).status).toBe(409);
 testDb.raw.exec("UPDATE rt_store_followup_targets SET enabled=0");
 expect((await requestWithMethod(url,'PUT',{notUsing:true,expectedVersion:2})).status).toBe(200);
 testDb.raw.exec("UPDATE rt_store_followup_targets SET enabled=1");
 expect(testDb.raw.prepare("SELECT not_using,version FROM rt_store_followup_preferences WHERE store_id='new'").get()).toEqual({not_using:0,version:4});
});
it('判断者の識別が無い要求は空の記録を保存せず401で止める',async()=>{
 newStore();authMocks.getStaffByApiKey.mockResolvedValue({id:'',name:'担当',role:'admin',access_level:'full',permission_keys:'[]',assigned_line_account_id:null,can_access_descendant_accounts:1});
 expect((await requestWithMethod(path+'/setup'+scope,'PUT',{notUsing:true,expectedVersion:0},'unknown')).status).toBe(401);
 expect(testDb.raw.prepare('SELECT count(*) n FROM rt_store_followup_preferences').get()).toEqual({n:0});
});

for(const [reason,code,message] of [
 ['sending_stopped','sending_stopped','いまは送信を止めています'],
 ['REMINDER_TEST_RECIPIENT_NOT_AVAILABLE','test_precondition_changed','内容か宛先が変わりました'],
 ['restaurant_followup_test_content_changed','test_precondition_changed','内容か宛先が変わりました'],
])it(`テストを外部要求前に止めた理由${reason}を読み直し可能な409で返す`,async()=>{
 newStore();const send=vi.spyOn(followupTestSend,'testRestaurantFollowupEngine').mockRejectedValueOnce(new NotificationDeliveryIncomplete('failed',reason));
 try{
  const response=await request(path+'/engines/reservation_created/test-send'+scope,{expectedTargetVersion:1});
  expect(response.status).toBe(409);expect(await response.json()).toMatchObject({success:false,code,error:expect.stringContaining(message)});
 }finally{send.mockRestore();}
});

it('来店フォローの閲覧権限だけで状態を読め、操作権限があってもスタッフは送り始められない',async()=>{
 newStore();
 const staff={id:'staff',name:'担当',role:'staff' as const,access_level:'full' as const,permission_keys:'[]',view_permission_keys:'[]',assigned_line_account_id:null,can_access_descendant_accounts:1};
 authMocks.getStaffByApiKey.mockResolvedValue(staff);
 expect((await requestAs(path+'/engines'+scope,'staff')).status).toBe(403);
 for(const suffix of ['', '/review-history'])expect((await requestAs(path+suffix+scope,'staff')).status).toBe(200);
 for(const access_level of ['full','read_only'] as const){
  authMocks.getStaffByApiKey.mockResolvedValue({...staff,access_level,view_permission_keys:'["/restaurant-test/line-followup"]'});
  expect((await requestAs(path+'/engines'+scope,'staff')).status).toBe(200);
  for(const suffix of ['', '/review-history'])expect((await requestAs(path+suffix+scope,'staff')).status).toBe(200);
  for(const action of ['initialize','reservation_created/draft','reservation_created/test-send','reservation_created/start'])
   expect((await requestAs(path+'/engines/'+action+scope,'staff',{})).status).toBe(403);
 }
 authMocks.getStaffByApiKey.mockResolvedValue({...staff,permission_keys:'["/restaurant-test/line-followup"]'});
 expect((await requestWithMethod(path+'/rows/reservation_created'+scope,'PUT',{expectedRowVersion:1,enabled:true},'staff')).status).toBe(403);
 for(const action of ['initialize','reservation_created/draft','reservation_created/test-send','reservation_created/start'])
  expect((await requestAs(path+'/engines/'+action+scope,'staff',{})).status).toBe(403);
 expect(testDb.raw.prepare('SELECT count(*) n FROM rt_store_followup_targets').get()).toEqual({n:0});
});

it('予約フォームは読むだけで行を作らず、管理者だけが店ごとの版を保存できる',async()=>{
 newStore();const url=path+'/reservation-form'+scope;
 expect(await (await request(url)).json()).toMatchObject({data:{version:0,definition:{title:'ご予約'}}});
 const definition={...defaultRestaurantReservationForm(),title:'夜のお席のご予約'};
 expect((await requestWithMethod(url,'PUT',{expectedVersion:0,definition})).status).toBe(200);
 expect((await requestWithMethod(url,'PUT',{expectedVersion:0,definition})).status).toBe(409);
 expect((await requestWithMethod('/api/restaurant-test/followups/foreign/reservation-form'+scope,'PUT',{expectedVersion:0,definition})).status).toBe(404);
 for(const access_level of ['full','read_only'] as const){
  authMocks.getStaffByApiKey.mockResolvedValue({id:'staff',name:'担当',role:'staff',access_level,permission_keys:'["/restaurant-test/line-followup"]',view_permission_keys:'["/restaurant-test/line-followup"]',assigned_line_account_id:null,can_access_descendant_accounts:1});
  expect((await requestAs(url,'staff')).status).toBe(200);
  expect((await requestWithMethod(url,'PUT',{expectedVersion:1,definition},'staff')).status).toBe(403);
 }
 expect(testDb.raw.prepare("SELECT count(*) n FROM account_settings WHERE key='restaurant.reservation_form:new'").get()).toEqual({n:1});
});

it('壊れたフォームは管理側の503を保ち、修復の権限と版を照合して監査に残す',async()=>{
 newStore();const url=path+'/reservation-form'+scope,definition=defaultRestaurantReservationForm();
 expect((await requestWithMethod(url,'PUT',{expectedVersion:0,definition})).status).toBe(200);
 testDb.raw.exec("UPDATE account_settings SET value='{broken' WHERE key='restaurant.reservation_form:new'");
 const response=await request(url);expect(response.status).toBe(503);
 const body=await response.json() as {data:{repair:{version:number;definition:unknown;repairToken:string}}};
 expect(body.data.repair.version).toBe(-1);
 const input={expectedVersion:-1,definition,repairToken:body.data.repair.repairToken};
 expect((await requestWithMethod(url,'PUT',{...input,repairToken:'old'})).status).toBe(409);
 expect((await requestWithMethod(url,'PUT',{expectedVersion:1,definition})).status).toBe(503);
 expect((await requestWithMethod('/api/restaurant-test/followups/foreign/reservation-form'+scope,'PUT',input)).status).toBe(404);
 authMocks.getStaffByApiKey.mockResolvedValue({id:'staff',name:'担当',role:'staff',access_level:'full',permission_keys:'["/restaurant-test/line-followup"]',assigned_line_account_id:null,can_access_descendant_accounts:1});
 expect((await requestWithMethod(url,'PUT',input,'staff')).status).toBe(403);
 authMocks.getStaffByApiKey.mockResolvedValue(null);
 expect((await requestWithMethod(url,'PUT',input)).status).toBe(200);
 expect((await requestWithMethod(url,'PUT',input)).status).toBe(409);
 expect((await requestWithMethod(url,'PUT',{expectedVersion:1,definition})).status).toBe(200);
 await vi.waitFor(()=>expect(testDb.raw.prepare("SELECT actor_principal_id,target_id,result FROM audit_events WHERE action='restaurant.reservation_form.repair'").all()).toEqual([{actor_principal_id:expect.any(String),target_id:'new',result:'success'}]));
});
