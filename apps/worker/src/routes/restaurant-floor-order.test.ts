import {readFileSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {Hono} from 'hono'
import {beforeEach,expect,it,vi} from 'vitest'
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
function request(path:string,body?:unknown){
 const app=new Hono<Env>()
 app.use('*',authMiddleware)
 app.route('/',restaurantTest)
 return app.request(path,body===undefined?{headers:{Authorization:'Bearer owner-key'}}:{method:'POST',headers:{Authorization:'Bearer owner-key','Content-Type':'application/json'},body:JSON.stringify(body)},env)
}
function put(path:string,body:unknown){
 const app=new Hono<Env>()
 app.use('*',authMiddleware)
 app.route('/',restaurantTest)
 return app.request(path,{method:'PUT',headers:{Authorization:'Bearer owner-key','Content-Type':'application/json'},body:JSON.stringify(body)},env)
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

it('階を指定したタブの次に追加し、階なしのエリアも保存する',async()=>{
 seedRestaurantFixture(testDb)
 const path='/api/restaurant-test/floors?account_id=account-1'
 expect((await request(path,{storeId:'store-ginza',name:'2階',kind:'floor'})).status).toBe(201)
 expect((await request(path,{storeId:'store-ginza',name:'中2階',kind:'floor',afterFloorId:'floor-store-ginza'})).status).toBe(201)
 expect((await request(path,{storeId:'store-ginza',name:'テラス',kind:'area',parentFloorId:null})).status).toBe(201)
 const response=await request(`${path}&storeId=store-ginza`)
 expect(response.status).toBe(200)
 const data=(await response.json() as {data:Array<{name:string;parentFloorId:string|null}>}).data
 expect(data.findIndex(f=>f.name==='中2階')).toBeLessThan(data.findIndex(f=>f.name==='2階'))
 expect(data.find(f=>f.name==='テラス')?.parentFloorId).toBeNull()
})
it('同じ店舗の全タブだけを並べ替え、古い順番からの保存を拒否する',async()=>{
 seedRestaurantFixture(testDb)
 const path='/api/restaurant-test/floors?account_id=account-1'
 expect((await request(path,{storeId:'store-ginza',name:'2階',kind:'floor'})).status).toBe(201)
 const before=(await (await request(`${path}&storeId=store-ginza`)).json() as {data:Array<{id:string;name:string}>}).data
 const expectedIds=before.map(f=>f.id),orderedIds=[...expectedIds].reverse()
 const response=await put('/api/restaurant-test/floors/order?account_id=account-1',{storeId:'store-ginza',orderedIds,expectedIds})
 expect(response.status).toBe(200)
 const after=(await (await request(`${path}&storeId=store-ginza`)).json() as {data:Array<{id:string}>}).data
 expect(after.map(f=>f.id)).toEqual(orderedIds)
 expect((await put('/api/restaurant-test/floors/order?account_id=account-1',{storeId:'store-ginza',orderedIds:expectedIds,expectedIds})).status).toBe(409)
 expect((await put('/api/restaurant-test/floors/order?account_id=account-1',{storeId:'store-ginza',orderedIds:[orderedIds[0],'another-store'],expectedIds:orderedIds})).status).toBe(400)
})
