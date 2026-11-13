import { readFileSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { seedRestaurantFixture as seedRestaurantData } from '../test-utils/restaurant-fixture.js';

type Env = import('../index.js').Env;
const mocks=vi.hoisted(()=>({getStaffByApiKey:vi.fn(),accounts:[1,2,3,4].map(i=>({id:`account-${i}`,name:`test-${i}`,is_active:1,channel_access_token:`token-${i}`}))}));
vi.mock('@line-crm/db', async () => ({
 ...await vi.importActual<typeof import('@line-crm/db')>('@line-crm/db'),
 getStaffByApiKey:mocks.getStaffByApiKey,
 getLineAccounts:vi.fn(async()=>mocks.accounts),
 getLineAccountScopeEntries:vi.fn(async()=>mocks.accounts),
}));
const {authMiddleware}=await import('../middleware/auth.js');
const {restaurantTest}=await import('./restaurant-test.js');
let testDb:SqliteD1;
let env:Env['Bindings'];
const seedRestaurantFixture=()=>seedRestaurantData(testDb);
function app(){const a=new Hono<Env>();a.use('*',authMiddleware);a.route('/',restaurantTest);return a;}
function request(path:string,body?:unknown){return app().request(path,body===undefined?{headers:{Authorization:'Bearer owner-key'}}:{method:'POST',headers:{Authorization:'Bearer owner-key','Content-Type':'application/json'},body:JSON.stringify(body)},env);}
function requestWithMethod(path:string,method:string,body:unknown){return app().request(path,{method,headers:{Authorization:'Bearer owner-key','Content-Type':'application/json'},body:JSON.stringify(body)},env);}
beforeEach(()=>{
 mocks.getStaffByApiKey.mockReset().mockResolvedValue(null);
 testDb=createTestD1({loginPolicy:'off'});
 testDb.raw.exec(readFileSync(new URL('../../../../packages/db/migrations/168_restaurant_test_foundation.sql',import.meta.url),'utf8'));
 testDb.raw.exec(readFileSync(new URL('../../../../packages/db/migrations/175_restaurant_terms_agreement.sql',import.meta.url),'utf8'));
 testDb.raw.prepare(`UPDATE tenants SET feature_packs = '["restaurant"]' WHERE id = '00000000-0000-4000-8000-000000000001'`).run();
 env={DB:testDb.db,API_KEY:'owner-key',IMAGES:{} as R2Bucket,RAW_MAIL:{} as R2Bucket,ASSETS:{} as Fetcher,RESTAURANT_INTAKE_DOMAIN:'intake.example.test',DEPLOY_ENV:'test',RESTAURANT_TEST_ENABLED:'true',LINE_CHANNEL_SECRET:'unused',LINE_CHANNEL_ACCESS_TOKEN:'unused',LIFF_URL:'https://example.test',LINE_CHANNEL_ID:'unused',LINE_LOGIN_CHANNEL_ID:'unused',LINE_LOGIN_CHANNEL_SECRET:'unused',WORKER_URL:'https://worker.example.test',LINE_CREDENTIAL_ENCRYPTION_KEY:'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'};
});

it('案内設定の確認時の版を守り、版なし更新も版を進める',async()=>{
  seedRestaurantFixture();
  const query='?account_id=account-1';
  const made=await request('/api/restaurant-test/store-groups'+query,{name:'確認用',members:[{storeId:'store-ginza',referralEnabled:true,maxDistance:5},{storeId:'store-yokohama',referralEnabled:false,maxDistance:5}]});
  const id=(await made.json() as {data:{id:string}}).data.id;
  const path=`/api/restaurant-test/store-groups/${id}/members/store-ginza${query}`;
  const get=()=>testDb.raw.prepare('SELECT referral_enabled,max_distance,version FROM rt_store_group_members WHERE group_id=? AND store_id=?').get(id,'store-ginza');
  expect(await requestWithMethod(path,'PATCH',{referralEnabled:false,maxDistance:10,expectedVersion:1})).toHaveProperty('status',200);
  expect(get()).toEqual({referral_enabled:0,max_distance:10,version:2});
  const stale=await requestWithMethod(path,'PATCH',{referralEnabled:true,maxDistance:99,expectedVersion:1});
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({code:'version_conflict',data:{current:{referral_enabled:0,max_distance:10,version:2}}});
  expect(get()).toEqual({referral_enabled:0,max_distance:10,version:2});
  expect((await requestWithMethod(path,'PATCH',{referralEnabled:true,maxDistance:5})).status).toBe(200);
  expect(get()).toEqual({referral_enabled:1,max_distance:5,version:3});
  expect((await requestWithMethod(path,'PATCH',{referralEnabled:false,maxDistance:20,expectedVersion:1})).status).toBe(409);
  expect(get()).toEqual({referral_enabled:1,max_distance:5,version:3});
 });
