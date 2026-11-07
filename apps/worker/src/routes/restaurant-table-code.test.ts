import {readFileSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {Hono} from 'hono'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {createTestD1,type SqliteD1} from '../test-utils/d1-sqlite.js'
import {seedRestaurantFixture} from '../test-utils/restaurant-fixture.js'

const auth=vi.hoisted(()=>({
 getStaffByApiKey:vi.fn(async()=>null),
 getStaffByAdminSession:vi.fn(async()=>null),
 lineAccounts:[
  {id:'account-1',name:'統括',is_active:1,channel_access_token:'test'},
  {id:'account-2',name:'店舗A',is_active:1,channel_access_token:'test'},
  {id:'account-3',name:'店舗B',is_active:1,channel_access_token:'test'},
  {id:'account-4',name:'予備',is_active:1,channel_access_token:'test'},
 ],
}))
vi.mock('@line-crm/db',async()=>{
 const actual=await vi.importActual<typeof import('@line-crm/db')>('@line-crm/db')
 return {...actual,getStaffByApiKey:auth.getStaffByApiKey,getStaffByAdminSession:auth.getStaffByAdminSession,getLineAccounts:vi.fn(async()=>auth.lineAccounts),getLineAccountScopeEntries:vi.fn(async()=>auth.lineAccounts)}
})
const {authMiddleware}=await import('../middleware/auth.js')
const {restaurantTest}=await import('./restaurant-test.js')
type Env=import('../index.js').Env
const here=dirname(fileURLToPath(import.meta.url))
let testDb:SqliteD1
let env:Env['Bindings']
function request(path:string,body:unknown){return requestWithMethod(path,'POST',body)}
function requestWithMethod(path:string,method:string,body:unknown){
 const app=new Hono<Env>()
 app.use('*',authMiddleware)
 app.route('/',restaurantTest)
 if(method==='PATCH'&&body&&typeof body==='object')body={expectedVersion:1,...body}
 return app.request(path,{method,headers:{Authorization:'Bearer owner-key','Content-Type':'application/json'},body:JSON.stringify(body)},env)
}
beforeEach(()=>{
 auth.getStaffByApiKey.mockReset().mockResolvedValue(null)
 auth.getStaffByAdminSession.mockReset().mockResolvedValue(null)
 testDb=createTestD1({loginPolicy:'off'})
 testDb.raw.exec(readFileSync(join(here,'../../../../packages/db/migrations/168_restaurant_test_foundation.sql'),'utf8'))
 testDb.raw.exec(readFileSync(join(here,'../../../../packages/db/migrations/175_restaurant_terms_agreement.sql'),'utf8'))
 testDb.raw.prepare('UPDATE tenants SET feature_packs = ? WHERE id = ?').run('["restaurant"]','00000000-0000-4000-8000-000000000001')
 env={DB:testDb.db,API_KEY:'owner-key',IMAGES:{} as R2Bucket,RAW_MAIL:{} as R2Bucket,ASSETS:{} as Fetcher,RESTAURANT_INTAKE_DOMAIN:'intake.example.test',DEPLOY_ENV:'test',RESTAURANT_TEST_ENABLED:'true',LINE_CHANNEL_SECRET:'unused',LINE_CHANNEL_ACCESS_TOKEN:'unused',LIFF_URL:'https://example.test',LINE_CHANNEL_ID:'unused',LINE_LOGIN_CHANNEL_ID:'unused',LINE_LOGIN_CHANNEL_SECRET:'unused',WORKER_URL:'https://worker.example.test',LINE_CREDENTIAL_ENCRYPTION_KEY:'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'}
})

afterEach(()=>testDb.raw.close())

 it.each(['POST','PATCH'])('同じ店舗の重複卓番は%sで卓番の理由を返し、配置も保存しない',async method=>{
  seedRestaurantFixture(testDb);
  testDb.raw.prepare("INSERT INTO rt_tables(id,store_id,code,label,seat_type,min_capacity,max_capacity,floor_id,floor_x,floor_y) VALUES('other-table','store-ginza','T-02','別卓','table',1,2,'floor-store-ginza',200,100)").run();
  const before=testDb.raw.prepare("SELECT version FROM rt_floors WHERE id='floor-store-ginza'").get();
  const input={code:' T-01 ',label:'変更した卓',seatType:'table',minCapacity:1,maxCapacity:2};
  const response=method==='POST'
   ?await request('/api/restaurant-test/tables?account_id=account-1',{storeId:'store-ginza',...input})
   :await requestWithMethod('/api/restaurant-test/tables/other-table?account_id=account-1','PATCH',{...input,floorX:300,floorY:100});
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({code:'duplicate_table_code',fields:{code:'この卓番はすでに使われています。別の卓番を入力してください。'}});
  expect(testDb.raw.prepare("SELECT version FROM rt_floors WHERE id='floor-store-ginza'").get()).toEqual(before);
  expect(testDb.raw.prepare("SELECT code,label,floor_x FROM rt_tables WHERE id='other-table'").get()).toEqual({code:'T-02',label:'別卓',floor_x:200});
  expect(testDb.raw.prepare("SELECT count(*) n FROM rt_tables WHERE store_id='store-ginza'").get()).toEqual({n:2});
 });
 it('同じ卓自身の番号は変更でき、別店舗なら同じ番号で作成できる',async()=>{
  seedRestaurantFixture(testDb);
  const saved=await requestWithMethod('/api/restaurant-test/tables/table-ginza?account_id=account-1','PATCH',{code:' T-01 ',label:'名前だけ変更'});
  expect(saved.status).toBe(200);
  const created=await request('/api/restaurant-test/tables?account_id=account-1',{storeId:'store-yokohama',code:'T-01',label:'横浜の卓',seatType:'table',minCapacity:1,maxCapacity:2});
  expect(created.status).toBe(201);
 });
 it.each(['POST','PATCH'])('確認後に%sが一意制約へ衝突しても卓番の理由を返し、配置の版を進めない',async method=>{
  seedRestaurantFixture(testDb);
  testDb.raw.exec(`CREATE TEMP TRIGGER duplicate_before_write BEFORE ${method==='POST'?'INSERT':'UPDATE OF code'} ON rt_tables WHEN NEW.code='RACE'
   BEGIN INSERT INTO rt_tables(id,store_id,code,label,seat_type,min_capacity,max_capacity) VALUES('racing-table',NEW.store_id,NEW.code,'同時作成','table',1,2); END;`);
  const before=testDb.raw.prepare("SELECT version FROM rt_floors WHERE id='floor-store-ginza'").get();
  const response=method==='POST'
   ?await request('/api/restaurant-test/tables?account_id=account-1',{storeId:'store-ginza',code:'RACE',label:'作成する卓',seatType:'table',minCapacity:1,maxCapacity:2})
   :await requestWithMethod('/api/restaurant-test/tables/table-ginza?account_id=account-1','PATCH',{code:'RACE',floorX:300,floorY:100});
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({code:'duplicate_table_code',fields:{code:'この卓番はすでに使われています。別の卓番を入力してください。'}});
  expect(testDb.raw.prepare("SELECT version FROM rt_floors WHERE id='floor-store-ginza'").get()).toEqual(before);
  expect(testDb.raw.prepare("SELECT count(*) n FROM rt_tables WHERE code='RACE'").get()).toEqual({n:0});
 });
 it('卓番以外の保存障害を重複卓番と取り違えない',async()=>{
  seedRestaurantFixture(testDb);
  testDb.raw.exec(`CREATE TEMP TRIGGER unrelated_failure BEFORE INSERT ON rt_tables WHEN NEW.code='NEW'
   BEGIN SELECT RAISE(ABORT,'storage unavailable'); END;`);
  const response=await request('/api/restaurant-test/tables?account_id=account-1',{storeId:'store-ginza',code:'NEW',label:'新しい卓',seatType:'table',minCapacity:1,maxCapacity:2});
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain('duplicate_table_code');
 });
