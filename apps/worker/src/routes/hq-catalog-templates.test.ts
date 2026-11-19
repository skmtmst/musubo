import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { publishMileageReward } from '@line-crm/db';
import { useSqliteClock } from '../test-utils/sqlite-clock.js';
import { beforeEach,afterEach,expect,test,vi } from 'vitest';
import { createTestD1,type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { hqTemplates } from './hq-templates.js';
import type { Env } from '../worker-env.js';
import type { HqCatalogTemplateType } from '@line-crm/shared';
let f:SqliteD1,app:Hono<Env>,staff:Env['Variables']['staff'];
const defs={booking_menu:{schemaVersion:1,settings:{name:'初回相談',duration_minutes:60,base_price:3000}},mileage_reward:{schemaVersion:1,settings:{name:'お礼',rewardKind:'coupon',requiredMiles:100}}};
interface Detail {template:{id:string;revision:number;template_type:string};definition:unknown}
interface Preflight {preflightId:string;stores:Array<{accountId:string;items:Array<{sourceId:string;allowedModes:string[];operation?:string}>}>}
async function call<T=unknown>(suffix:string,method='GET',body?:unknown){const r=await app.request(`/api/hq/templates${suffix}`,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})},{DB:f.db} as Env['Bindings']);return {status:r.status,body:await r.json() as {data:T;code?:string}};}
async function create(type:HqCatalogTemplateType,definition:unknown=defs[type]){const r=await call<Detail>('','POST',{type,name:'配るひな形',definition,requestId:crypto.randomUUID()});expect(r.status,JSON.stringify(r.body)).toBe(201);return r.body.data.template.id;}
async function check(id:string,accountIds=['a']){const r=await call<Preflight>(`/${id}/preflight`,'POST',{accountIds});expect(r.status,JSON.stringify(r.body)).toBe(200);return r.body.data;}
const run=(id:string,p:Preflight,mode='create')=>call<{status:string;stores:Array<{status:string;createdName:string;counts:Record<string,number>}>}>(`/${id}/distribute`,'POST',{preflightId:p.preflightId,resolutions:p.stores.flatMap(s=>s.items.map(i=>({accountId:s.accountId,sourceId:i.sourceId,mode:i.operation==='reuse'?'overwrite':mode})))});
beforeEach(()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-16T00:00:00Z'));
 f=createTestD1({foreignKeys:true});useSqliteClock(f.raw,()=>new Date());

 f.raw.exec("INSERT INTO mileage_programs(id,code,name,status,created_at,updated_at) VALUES('default','default','マイル','active','2026-10-15','2026-10-15')");
 f.raw.exec("INSERT INTO tenants(id,name) VALUES('t','HQ'),('other','Other'); INSERT INTO staff_members(id,name,role,api_key,tenant_id) VALUES('owner','Owner','owner','unused','t'); INSERT INTO line_accounts(id,name,channel_id,channel_secret,channel_access_token,tenant_id) VALUES('a','Store','a','x','x','t'),('b','Store2','b','x','x','t'),('other','Hidden','other','x','x','other')");
 staff={id:'owner',name:'Owner',role:'owner',tenantId:'t',readOnly:false};
 app=new Hono<Env>();app.use('*',async(c,next)=>{c.set('staff',staff);await next();});app.route('/',hqTemplates);
 vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('No external requests');}));
});
afterEach(()=>{f.raw.close();vi.useRealTimers();vi.unstubAllGlobals();});
test.each(['booking_menu','mileage_reward'] as const)('%s: 共通の保存・配布・再試行・上書き・別名・保管を保持する',async type=>{
 const id=await create(type),p=await check(id),sent=await run(id,p);
 expect(sent.body.data.status,JSON.stringify(sent.body)).toBe('completed');
 expect(sent.body.data.stores[0].createdName).toBe(defs[type].settings.name);
 expect((await run(id,p)).body).toEqual(sent.body);
 const table=type==='booking_menu'?'menus':'mileage_rewards';
 const row=f.raw.prepare(`SELECT * FROM ${table} WHERE line_account_id='a'`).get() as Record<string,unknown>;
 expect(type==='booking_menu'?row.is_active:row.status).toBe(type==='booking_menu'?0:'draft');
 const updated=await check(id);
 if(type==='booking_menu'){
  expect(updated.stores[0].items[0].allowedModes).toEqual(['create']);
  expect((await run(id,updated,'create')).body.data.status).toBe('completed');
  expect(f.raw.prepare('SELECT name FROM menus ORDER BY id').all()).toEqual([{name:'初回相談'},{name:'初回相談'}]);
 }else{
  expect(updated.stores[0].items[0].allowedModes).toContain('overwrite');
  expect((await run(id,updated,'overwrite')).body.data.status).toBe('completed');
  expect(f.raw.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({n:1});
  expect((await run(id,await check(id),'alias')).body.data.status).toBe('completed');
  expect(f.raw.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({n:2});
 }
 const detail=await call<Detail>(`/${id}`);expect(detail.body.data.template.template_type).toBe(type);
 expect((await call<Detail['template'][]>(`?type=${type}`)).body.data.map(r=>r.template_type)).toEqual([type]);
 expect((await call(`/${id}`,'DELETE',{expectedRevision:detail.body.data.template.revision})).status).toBe(200);
 expect((await call(`/${id}/restore`,'POST',{expectedRevision:detail.body.data.template.revision+1})).status).toBe(200);
 expect(f.raw.pragma('foreign_key_check')).toEqual([]);expect(fetch).not.toHaveBeenCalled();
});
test('予約メニューのタグを同名へ解決し、確認後の参照・受付の変更で配らない',async()=>{
 f.raw.exec("INSERT INTO tags(id,name,line_account_id) VALUES('tag-a','予約','a'),('tag-b','予約','b')");
 const id=await create('booking_menu',{...defs.booking_menu,settings:{...defs.booking_menu.settings,autoTagName:'予約',concurrent_capacity:2}});
 const p=await check(id,['a','b']);expect((await run(id,p)).body.data.status).toBe('completed');
 expect(f.raw.prepare('SELECT line_account_id,auto_tag_id FROM menus ORDER BY line_account_id').all()).toEqual([{line_account_id:'a',auto_tag_id:'tag-a'},{line_account_id:'b',auto_tag_id:'tag-b'}]);
 const next=await check(id);f.raw.exec("UPDATE tags SET version=version+1 WHERE id='tag-a'");
 expect((await run(id,next,'create')).body.data.stores[0].status).toBe('version_conflict');
 f.raw.exec("UPDATE menus SET is_active=1 WHERE line_account_id='a'");
 const active=await check(id);expect(active.stores[0].items[0].allowedModes).toEqual(['create']);
 expect((await run(id,active,'overwrite')).status).toBe(409);
});
test('景品は同名の公開処理と対象タグを店内のIDへ固定し、公開やコードの複製をしない',async()=>{
 f.raw.exec(`INSERT INTO tags(id,name,line_account_id) VALUES('vip','会員','a'); INSERT INTO common_actions(id,line_account_id,name,status) VALUES('action','a','お礼の処理','published'); INSERT INTO common_action_versions(id,common_action_id,version_number,status,action_config) VALUES('action-v1','action',1,'published','[]'); UPDATE common_actions SET current_published_version_id='action-v1' WHERE id='action'`);
 const id=await create('mileage_reward',{schemaVersion:1,settings:{name:'会員特典',rewardKind:'tag',requiredMiles:100,stockLimit:0,commonActionName:'お礼の処理',targetConditions:{operator:'AND',rules:[{type:'tag_exists',value:'会員'}]}}});
 expect((await run(id,await check(id))).body.data.status).toBe('completed');
 const v=f.raw.prepare('SELECT * FROM mileage_reward_versions').get() as Record<string,unknown>;
 expect(v.common_action_version_id).toBe('action-v1');expect(v.stock_limit).toBe(0);expect(JSON.parse(String(v.target_conditions))).toEqual({operator:'AND',rules:[{type:'tag_exists',value:'vip'}]});
 expect(f.raw.prepare('SELECT COUNT(*) n FROM mileage_reward_codes').get()).toEqual({n:0});
 const p=await check(id);f.raw.exec("UPDATE common_actions SET status='archived' WHERE id='action'");
 expect((await run(id,p,'overwrite')).body.data.stores[0].status).toBe('version_conflict');
 expect((await call(`/${id}/preflight`,'POST',{accountIds:['b']})).status).toBe(409);
});
test.each(['booking_menu','mileage_reward'] as const)('%s: 不正な値・他店ID・権限外を拒み、監査失敗時も店を作らない',async type=>{
 const base=defs[type];
 for(const settings of [{...base.settings,lineAccountId:'other'},{...base.settings,[type==='booking_menu'?'duration_minutes':'requiredMiles']:0}])expect((await call('','POST',{type,name:'不正',definition:{schemaVersion:1,settings},requestId:crypto.randomUUID()})).status).toBe(422);
 const id=await create(type);expect((await call(`/${id}/preflight`,'POST',{accountIds:['other']})).status).toBe(403);
 staff={...staff,readOnly:true};expect((await call(`/${id}/preflight`,'POST',{accountIds:['a']})).status).toBe(403);staff={...staff,readOnly:false};
 const p=await check(id);f.raw.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events WHEN NEW.action='hq_template.distributed' AND NEW.result='success' BEGIN SELECT RAISE(ABORT,'test'); END;");
 const result=await run(id,p);expect(result.body.data.stores[0].status).toBe('failed');
 expect(f.raw.prepare(`SELECT COUNT(*) n FROM ${type==='booking_menu'?'menus':'mileage_rewards'}`).get()).toEqual({n:0});
});

test('担当者へ結びついた予約メニューは無効でも上書きせず、過去の版を保持する',async()=>{
 const id=await create('booking_menu');expect((await run(id,await check(id))).body.data.status).toBe('completed');
 const menu=f.raw.prepare('SELECT id FROM menus').get() as {id:string};
 f.raw.exec("INSERT INTO staff(id,line_account_id,name,display_name) VALUES('staff','a','担当','担当')");
 f.raw.prepare('INSERT INTO staff_menus(staff_id,menu_id) VALUES(?,?)').run('staff',menu.id);
 const p=await check(id);expect(p.stores[0].items[0].allowedModes).toEqual(['create']);
 const before=f.raw.prepare('SELECT * FROM menu_versions').all();
 expect((await run(id,p,'overwrite')).status).toBe(409);
 expect(f.raw.prepare('SELECT * FROM menu_versions').all()).toEqual(before);
});
test('HQT-01 HQT-02 HQT-07 HQT-16: 同名を守り停止で配る、支払い未接続の警告と出所、古い版409',async()=>{
 f.raw.exec("INSERT INTO menus(id,line_account_id,name,duration_minutes,base_price,is_active) VALUES('existing','a','初回相談',30,1000,1)");
 const id=await create('booking_menu',{schemaVersion:1,settings:{...defs.booking_menu.settings,paymentMode:'online'}}),p=await check(id);
 expect((p.stores[0] as any).warnings).toEqual(expect.arrayContaining(['same_name_exists','payment_downgraded_to_store','booking_reception_stopped']));
 expect((await run(id,p)).body.data.status).toBe('completed');
 const made=f.raw.prepare("SELECT * FROM menus WHERE id<>'existing'").get() as any;expect(made).toMatchObject({name:'初回相談',is_active:0,hq_template_id:id,hq_customized:0});expect(made.hq_template_version_id).toBeTruthy();
 expect(f.raw.prepare("SELECT base_price,is_active FROM menus WHERE id='existing'").get()).toEqual({base_price:1000,is_active:1});expect(f.raw.prepare('SELECT mode,provider FROM booking_payment_menu_settings').get()).toEqual({mode:'onsite',provider:'onsite'});
 f.raw.prepare('UPDATE menus SET duration_minutes=80 WHERE id=?').run(made.id);expect((f.raw.prepare('SELECT hq_customized FROM menus WHERE id=?').get(made.id) as any).hq_customized).toBe(1);
 const detail=await call<Detail>(`/${id}`);expect((await call(`/${id}`,'PATCH',{name:'新版',definition:defs.booking_menu,expectedRevision:detail.body.data.template.revision-1})).status).toBe(409);
 expect((await call(`/${id}`,'DELETE',{expectedRevision:detail.body.data.template.revision})).status).toBe(200);expect(f.raw.prepare('SELECT hq_template_id FROM menus WHERE id=?').get(made.id)).toEqual({hq_template_id:null});
});
test('HQT-03 HQT-14: 予約を使わない店は配らない、代理も配れない',async()=>{
 const id=await create('booking_menu');f.raw.exec("INSERT INTO account_styles(line_account_id,style,updated_at) VALUES('a','ec',datetime('now'))");const p=await check(id);expect((p.stores[0] as any).warnings).toContain('booking_not_used');expect((await run(id,p)).body.data.status).toBe('failed');expect(f.raw.prepare('SELECT COUNT(*) n FROM menus').get()).toEqual({n:0});
 const im=new Hono<Env>();im.use('*',async(c,next)=>{c.set('staff',staff);c.set('impersonation',{id:'im',tenantId:'t',mode:'write',piiRevealed:true,startedAt:'2026-10-16'});await next();});im.route('/',hqTemplates);const r=await im.request(`/api/hq/templates/${id}/preflight`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accountIds:['a']})},{DB:f.db} as Env['Bindings']);expect(r.status).toBe(403);
});

test('HQT-09: 配られたクーポン景品はコードがなければ公開できない',async()=>{
 const id=await create('mileage_reward');expect((await run(id,await check(id))).body.data.status).toBe('completed');
 const row=f.raw.prepare('SELECT id,status FROM mileage_rewards').get() as {id:string;status:string};expect(row.status).toBe('draft');
 await expect(publishMileageReward(f.db,{id:row.id,lineAccountId:'a'})).rejects.toMatchObject({code:'coupon_inventory_empty'});
 expect(f.raw.prepare('SELECT status,current_published_version_id FROM mileage_rewards WHERE id=?').get(row.id)).toEqual({status:'draft',current_published_version_id:null});
});
test('HQT-14: 代理ログインは確認済みの配布も直接実行できない',async()=>{
 const id=await create('booking_menu'),p=await check(id);
 const im=new Hono<Env>();im.use('*',async(c,next)=>{c.set('staff',staff);c.set('impersonation',{id:'im',tenantId:'t',mode:'write',piiRevealed:true,startedAt:'2026-10-16'});await next();});im.route('/',hqTemplates);
 const r=await im.request(`/api/hq/templates/${id}/distribute`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({preflightId:p.preflightId,resolutions:p.stores.flatMap(s=>s.items.map(i=>({accountId:s.accountId,sourceId:i.sourceId,mode:'create'})))})},{DB:f.db} as Env['Bindings']);
 expect(r.status).toBe(403);expect(f.raw.prepare('SELECT COUNT(*) n FROM menus').get()).toEqual({n:0});
});
test.each(['booking_menu','mileage_reward'] as const)('HQT-15: %s の同じ配布確認の再送は1回だけ作る',async type=>{
 const id=await create(type),p=await check(id),first=await run(id,p),second=await run(id,p);
 expect(first.body.data.status).toBe('completed');expect(second.body).toEqual(first.body);
 const table=type==='booking_menu'?'menus':'mileage_rewards';
 expect(f.raw.prepare(`SELECT COUNT(*) n FROM ${table} WHERE line_account_id='a'`).get()).toEqual({n:1});
});
test('HQT-20: 配布先が0店なら確認を受け付けず配布記録を作らない',async()=>{
 const id=await create('booking_menu');const r=await call(`/${id}/preflight`,'POST',{accountIds:[]});
 expect(r.status).toBe(400);expect(f.raw.prepare('SELECT COUNT(*) n FROM hq_template_preflights').get()).toEqual({n:0});
});

test('HQT-19: 一店の書込み失敗を記録し他店の配布は残す',async()=>{
 const id=await create('booking_menu'),p=await check(id,['a','b']);
 f.raw.exec("CREATE TRIGGER reject_store_b BEFORE INSERT ON menus WHEN NEW.line_account_id='b' BEGIN SELECT RAISE(ABORT,'store failed'); END");
 const r=await run(id,p);expect(r.body.data.status).toBe('partial');
 expect(r.body.data.stores.map((s:any)=>[s.accountId,s.status])).toEqual([['a','succeeded'],['b','failed']]);
 expect(f.raw.prepare('SELECT line_account_id FROM menus').all()).toEqual([{line_account_id:'a'}]);
});

test('HQT-12: 閲覧のみはひな形を読めるが保存と配布を開始できない',async()=>{
 const id=await create('booking_menu'),p=await check(id);staff={...staff,readOnly:true};
 expect((await call(`/${id}`)).status).toBe(200);
 expect((await call(`/${id}`,'PATCH',{name:'変更',definition:defs.booking_menu,expectedRevision:1})).status).toBe(403);
 expect((await run(id,p)).status).toBe(403);expect(f.raw.prepare('SELECT COUNT(*) n FROM menus').get()).toEqual({n:0});
});

test('HQT-03: EC専用店を除き予約を使う店だけへ配る',async()=>{
 const id=await create('booking_menu');f.raw.exec("INSERT INTO account_styles(line_account_id,style,updated_at) VALUES('a','ec',datetime('now'))");
 const p=await check(id,['a','b']);expect((p.stores.find(s=>s.accountId==='a') as any).warnings).toContain('booking_not_used');
 const r=await run(id,p);expect(r.body.data.status).toBe('partial');expect(f.raw.prepare('SELECT line_account_id FROM menus').all()).toEqual([{line_account_id:'b'}]);
});
test('HQT-18: 予約メニューの確認は29分後でも有効',async()=>{
 const id=await create('booking_menu'),p=await check(id);vi.setSystemTime(new Date('2026-11-16T00:29:00Z'));
 expect((await run(id,p)).body.data.status).toBe('completed');expect(f.raw.prepare('SELECT COUNT(*) n FROM menus').get()).toEqual({n:1});
});
test('HQT-18: 予約メニューの確認は30分後に期限切れ',async()=>{
 const id=await create('booking_menu'),p=await check(id);vi.setSystemTime(new Date('2026-11-16T00:30:00Z'));
 const r=await run(id,p);expect(r.body.data.stores[0].status).toBe('version_conflict');expect(f.raw.prepare('SELECT COUNT(*) n FROM menus').get()).toEqual({n:0});
});

test('HQT-22: 景品のひな形を削除しても店の景品と版と出所を残し再配布を止める',async()=>{
 const id=await create('mileage_reward');
 expect((await run(id,await check(id))).body.data.status).toBe('completed');
 const before=f.raw.prepare('SELECT id,hq_template_id,hq_template_version_id FROM mileage_rewards').get() as {id:string;hq_template_id:string|null;hq_template_version_id:string|null};
 expect(before.hq_template_id).toBe(id);expect(before.hq_template_version_id).toBeTruthy();
 const versions=f.raw.prepare('SELECT * FROM mileage_reward_versions WHERE reward_id=?').all(before.id);
 const detail=await call<Detail>(`/${id}`);
 expect((await call(`/${id}`,'DELETE',{expectedRevision:detail.body.data.template.revision})).status).toBe(200);
 expect(f.raw.prepare('SELECT hq_template_id,hq_template_version_id FROM mileage_rewards WHERE id=?').get(before.id)).toEqual({hq_template_id:id,hq_template_version_id:before.hq_template_version_id});
 expect(f.raw.prepare('SELECT archived_at IS NOT NULL archived FROM hq_templates WHERE id=?').get(id)).toEqual({archived:1});
 expect((await call(`/${id}/preflight`,'POST',{accountIds:['a']})).status).toBe(404);
 expect(f.raw.prepare('SELECT * FROM mileage_reward_versions WHERE reward_id=?').all(before.id)).toEqual(versions);
});

test('HQT-22: 既存の成功した配布だけ出所を復元する',()=>{
 const legacy=new Database(':memory:');
 try {
  legacy.exec(`CREATE TABLE mileage_rewards(id TEXT PRIMARY KEY,line_account_id TEXT);
   CREATE TABLE hq_templates(id TEXT,tenant_id TEXT,archived_at TEXT);
   CREATE TABLE hq_template_versions(id TEXT,template_id TEXT,tenant_id TEXT);
   CREATE TABLE line_accounts(id TEXT,tenant_id TEXT);
   CREATE TABLE hq_template_preflight_resolutions(preflight_id TEXT,tenant_id TEXT,template_id TEXT,template_version_id TEXT,target_account_id TEXT,item_kind TEXT,target_id TEXT);
   CREATE TABLE hq_template_distribution_results(preflight_id TEXT,tenant_id TEXT,status TEXT,finished_at TEXT);
   INSERT INTO line_accounts VALUES('a','t'); INSERT INTO hq_templates VALUES('hq','t','deleted');
   INSERT INTO hq_template_versions VALUES('v','hq','t'); INSERT INTO mileage_rewards VALUES('r','a'),('unrelated','a');
   INSERT INTO hq_template_preflight_resolutions VALUES('p','t','hq','v','a','mileage_reward','r'),('failed','t','hq','v','a','mileage_reward','unrelated');
   INSERT INTO hq_template_distribution_results VALUES('p','t','succeeded','2026-01-01'),('failed','t','failed','2026-01-02');`);
  legacy.exec(readFileSync(new URL('../../../../packages/db/migrations/782_hq_reward_origin.sql',import.meta.url),'utf8'));
  expect(legacy.prepare('SELECT id,hq_template_id,hq_template_version_id FROM mileage_rewards ORDER BY id').all()).toEqual([
   {id:'r',hq_template_id:'hq',hq_template_version_id:'v'}, {id:'unrelated',hq_template_id:null,hq_template_version_id:null}]);
 } finally {legacy.close();}
});

test('HQT-22: 配布途中に削除したら残りの店へ配らない',async()=>{
 const id=await create('mileage_reward'),p=await check(id,['a','b']);
 const original=f.db.batch.bind(f.db);let archived=false;
 f.db.batch=async <T=unknown>(statements:D1PreparedStatement[]):Promise<D1Result<T>[]>=>{
  const result=await original(statements) as D1Result<T>[];
  if(!archived&&f.raw.prepare("SELECT COUNT(*) n FROM hq_template_distribution_results WHERE status='succeeded'").get() && (f.raw.prepare("SELECT COUNT(*) n FROM hq_template_distribution_results WHERE status='succeeded'").get() as {n:number}).n===1){
   archived=true;f.raw.prepare("UPDATE hq_templates SET archived_at='2026-11-16T00:00:00Z' WHERE id=?").run(id);
  }
  return result;
 };
 const result=await run(id,p);
 expect(archived).toBe(true);expect(result.body.data.status).toBe('partial');
 expect(result.body.data.stores.map(s=>s.status).sort()).toEqual(['failed','succeeded']);
 expect(f.raw.prepare('SELECT line_account_id FROM mileage_rewards').all()).toHaveLength(1);
});
