import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {Hono} from 'hono';
import type Database from 'better-sqlite3';
import type { Env } from '../worker-env.js';
import {createTestD1} from '../test-utils/d1-sqlite.js';
type ConnectResponse = { data: { id: string; steps: Array<{ order: number; state: string; message: string }>; followerImport: { capability: string; phase: string }; verification: { followerTotal: number | null } } };
const prepared=vi.hoisted(()=>vi.fn());
const followerIds=vi.hoisted(()=>vi.fn());
const followerInsight=vi.hoisted(()=>vi.fn());
const followerProfile=vi.hoisted(()=>vi.fn());
vi.mock('../services/line-account-connect.js',async importOriginal=>({...await importOriginal<typeof import('../services/line-account-connect.js')>(),prepareLineConnection:prepared}));
vi.mock('../lib/step-up.js',async importOriginal=>({...await importOriginal<typeof import('../lib/step-up.js')>(),sensitiveStepUpSatisfied:async()=>true}));
vi.mock('@line-crm/line-sdk',async importOriginal=>({...await importOriginal<typeof import('@line-crm/line-sdk')>(),LineClient:class{
 getFollowerIds(...args:unknown[]){return followerIds(...args)}
 getFollowersInsight(...args:unknown[]){return followerInsight(...args)}
 getProfile(...args:unknown[]){return followerProfile(...args)}
}}));
import {lineAccounts} from './line-accounts.js';
import {detectFollowerImportCapability,startFollowerImport,scheduleInitialFollowerImport} from '../services/follower-import.js';
vi.mock('../services/follower-import.js',async importOriginal=>{const actual=await importOriginal<typeof import('../services/follower-import.js')>();return {...actual,detectFollowerImportCapability:vi.fn(actual.detectFollowerImportCapability),startFollowerImport:vi.fn(actual.startFollowerImport),scheduleInitialFollowerImport:vi.fn(actual.scheduleInitialFollowerImport)}});
let sql:Database.Database,db:D1Database,app:Hono<Env>;
let pending:Promise<unknown>[];
const waitUntil=vi.fn((promise:Promise<unknown>)=>pending.push(promise));
beforeEach(()=>{
 pending=[];
 const f=createTestD1({foreignKeys:true});sql=f.raw;db=f.db;
 sql.exec("INSERT INTO tenants(id,name) VALUES ('t','試験'); INSERT INTO line_accounts(id,name,channel_id,channel_access_token,channel_secret,tenant_id) VALUES ('parent','親','test-parent','fixture','fixture','t'); INSERT INTO staff_members(id,name,role,api_key,tenant_id,account_scope) VALUES ('owner','管理','owner','fixture-owner','t','all'),('s','担当','staff','fixture-staff','t','accounts'); INSERT INTO line_account_tags(id,tenant_id,name,created_at,updated_at) VALUES ('tag','t','分類','fixture','fixture')");
 app=new Hono<Env>();app.use('*',async(c,next)=>{c.set('staff',{id:'owner',name:'管理',role:'owner',readOnly:false,tenantId:'t'});await next()});app.route('/',lineAccounts);
 prepared.mockReset();prepared.mockResolvedValue({success:true,channelAccessToken:'fixture-issued',bot:{displayName:'試験公式',pictureUrl:null,basicId:'@fixture'},liffId:'200123-existing',steps:[1,2,3,4].map(order=>({order,state:'passed',message:'確認済み'})),webhook:{expectedUrl:'https://worker.test/webhook',registeredUrl:'https://worker.test/webhook',active:true,testPassed:true}});
 followerIds.mockReset();followerIds.mockRejectedValue(new Error('LINE API error: 403 Forbidden'));
 followerInsight.mockReset();followerInsight.mockResolvedValue({status:'ready',followers:3,blocks:0});
 followerProfile.mockReset();followerProfile.mockResolvedValue({displayName:'架空の友だち'});
});
afterEach(async()=>{await Promise.allSettled(pending);sql.close()});
const body={channelId:'123',channelSecret:'fixture-secret',loginChannelId:'200123',loginChannelSecret:'fixture-login',tagIds:['tag'],staffIds:['s'],parentLineAccountId:'parent',liffId:'200123-existing'};
async function request(input:unknown,path='/api/line-accounts/connect'){return app.request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)},{DB:db,WORKER_URL:'https://worker.test',LINE_CREDENTIAL_ENCRYPTION_KEY:btoa('0'.repeat(32))} as Env['Bindings'],{waitUntil,passThroughOnException(){},props:{}})}
test('one connect request saves all registration fields without returning credentials',async()=>{
 const response=await request(body),json=await response.json() as ConnectResponse;expect(response.status,JSON.stringify(json)).toBe(201);
 const id=json.data.id;
 expect(sql.prepare('SELECT parent_line_account_id,liff_id FROM line_accounts WHERE id=?').get(id)).toEqual({parent_line_account_id:'parent',liff_id:'200123-existing'});
 expect(sql.prepare('SELECT tag_id FROM line_account_tag_links WHERE line_account_id=?').all(id)).toEqual([{tag_id:'tag'}]);
 expect(sql.prepare('SELECT staff_id FROM staff_account_scopes WHERE line_account_id=?').all(id)).toEqual([{staff_id:'s'}]);
 expect(prepared).toHaveBeenCalledWith(expect.objectContaining({liffId:'200123-existing'}));
 expect(JSON.stringify(json)).not.toContain('fixture-secret');expect(JSON.stringify(json)).not.toContain('fixture-issued');
});
test('invalid references stop before external LINE changes',async()=>{
 expect((await request({...body,tagIds:['missing']})).status).toBe(403);expect(prepared).not.toHaveBeenCalled();
 expect((sql.prepare('SELECT COUNT(*) n FROM line_accounts').get() as {n:number}).n).toBe(1);
});


const paths=['/api/line-accounts/connect/check','/api/line-accounts/connect'];
function noFollowerWork(){
 expect(followerIds).not.toHaveBeenCalled();expect(followerInsight).not.toHaveBeenCalled();expect(followerProfile).not.toHaveBeenCalled();
 expect(detectFollowerImportCapability).not.toHaveBeenCalled();expect(startFollowerImport).not.toHaveBeenCalled();expect(scheduleInitialFollowerImport).not.toHaveBeenCalled();expect(waitUntil).not.toHaveBeenCalled();
 expect(sql.prepare("SELECT COUNT(*) n FROM account_settings WHERE key='follower_import_v1'").get()).toEqual({n:0});
 expect(sql.prepare('SELECT COUNT(*) n FROM friends').get()).toEqual({n:0});
}
test.each(paths)('明示falseでは接続だけを確認し、友だちの読み取り・開始・予約をしない: %s',async path=>{
 followerIds.mockResolvedValue({userIds:[]});
 const response=await request({...body,importFriends:false},path),json=await response.json() as ConnectResponse;
 expect(response.status).toBe(path.endsWith('/check')?200:201);
 expect(prepared).toHaveBeenCalledTimes(1);
 expect(json.data.steps.slice(0,4).every((step:{state:string})=>step.state==='passed')).toBe(true);
 expect(json.data.steps[4]).toEqual({order:5,state:'passed',message:'友だちは引き継ぎません。'});
 expect(json.data.followerImport).toEqual({capability:'unknown',phase:'not_started'});
 expect(json.data.verification.followerTotal).toBeNull();noFollowerWork();
 if(!path.endsWith('/check')){
  const id=json.data.id;
  expect(sql.prepare('SELECT parent_line_account_id,liff_id FROM line_accounts WHERE id=?').get(id)).toEqual({parent_line_account_id:'parent',liff_id:'200123-existing'});
  expect(sql.prepare('SELECT tag_id FROM line_account_tag_links WHERE line_account_id=?').all(id)).toEqual([{tag_id:'tag'}]);
  expect(sql.prepare('SELECT staff_id FROM staff_account_scopes WHERE line_account_id=?').all(id)).toEqual([{staff_id:'s'}]);
  expect(JSON.stringify(json)).not.toContain('fixture-secret');expect(JSON.stringify(json)).not.toContain('fixture-issued');
 }
});
for(const path of paths){
 test.each([null,'false','true',0,1,[],{}])('不正なimportFriends=%jはLINE接続前に422: '+path,async value=>{
  const response=await request({...body,importFriends:value},path);expect(response.status).toBe(422);expect(prepared).not.toHaveBeenCalled();noFollowerWork();
  expect(sql.prepare('SELECT COUNT(*) n FROM line_accounts').get()).toEqual({n:1});
 });
 test.each([true,undefined])('trueまたは省略=%sは従来の能力判定と開始を保つ: '+path,async choice=>{
  followerIds.mockResolvedValue({userIds:[]});
  const response=await request({...body,...(choice===undefined?{}:{importFriends:choice})},path),json=await response.json() as ConnectResponse;
  expect(response.status).toBe(path.endsWith('/check')?200:201);
  expect(json.data.followerImport.capability).toBe('available');expect(followerIds).toHaveBeenCalled();
  expect(json.data.steps[4].state).toBe('passed');expect(json.data.steps[4].message).not.toBe('友だちは引き継ぎません。');
  if(path.endsWith('/check')){expect(followerInsight).toHaveBeenCalledTimes(1);expect(json.data.verification.followerTotal).toBe(3);expect(startFollowerImport).not.toHaveBeenCalled();expect(waitUntil).not.toHaveBeenCalled()}
  else{expect(detectFollowerImportCapability).toHaveBeenCalledTimes(1);expect(startFollowerImport).toHaveBeenCalledTimes(1);expect(scheduleInitialFollowerImport).toHaveBeenCalledTimes(1);expect(waitUntil).toHaveBeenCalledTimes(1);expect(json.data.followerImport.phase).toBe('importing_ids')}
 });
 test.each([true,undefined])('能力不明=%sは既存の失敗と登録取り消しを保つ: '+path,async choice=>{
  followerIds.mockRejectedValue(new Error('LINE API error: 503 Unavailable'));
  const response=await request({...body,...(choice===undefined?{}:{importFriends:choice})},path),json=await response.json() as ConnectResponse;
  if(path.endsWith('/check')){expect(response.status).toBe(200);expect(json.data.steps[4].state).toBe('failed')}
  else{expect(response.status).toBe(502);expect(sql.prepare('SELECT COUNT(*) n FROM line_accounts').get()).toEqual({n:1})}
  expect(startFollowerImport).not.toHaveBeenCalled();expect(waitUntil).not.toHaveBeenCalled();
 });
 test('明示falseでも前4段が失敗すれば5段目の合格を作らない: '+path,async()=>{
  prepared.mockResolvedValue({success:false,steps:[{order:1,state:'failed',message:'接続できませんでした'}],webhook:{}});
  const response=await request({...body,importFriends:false},path),json=await response.json() as ConnectResponse;
  expect(response.status).toBe(path.endsWith('/check')?200:400);expect(json.data.steps).toEqual([{order:1,state:'failed',message:'接続できませんでした'}]);noFollowerWork();
 });
}
