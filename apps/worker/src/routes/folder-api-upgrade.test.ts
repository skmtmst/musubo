import { Hono } from 'hono';
import { beforeEach,afterEach,describe,expect,it } from 'vitest';
import { DEFAULT_TENANT_ID as tenant } from '@line-crm/shared';
import { createTestD1,type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { friendAttributes } from './friend-attributes.js';
import { hqBanners } from './hq-banners.js';
import { hqTemplates } from './hq-templates.js';
import { hqBroadcasts } from './hq-broadcasts.js';
import { apiContractMiddleware } from '../middleware/api-contract.js';
import type { Env } from '../worker-env.js';
let f:SqliteD1,app:Hono<Env>;
let actor:{id:string;name:string;role:'owner'|'admin'|'staff';tenantId:string;readOnly:boolean};
beforeEach(()=>{
 f=createTestD1({foreignKeys:true});
 f.raw.exec("INSERT INTO tenants(id,name) VALUES('other','別統括')");
 for(const [id,t] of [['a',tenant],['b','other']])f.raw.prepare("INSERT INTO line_accounts(id,name,channel_id,channel_secret,channel_access_token,tenant_id) VALUES(?,?,?,'s','t',?)").run(id,id,id,t);
 f.raw.prepare("INSERT INTO staff_members(id,name,role,api_key,tenant_id) VALUES('owner','統括','owner','key',?)").run(tenant);
 actor={id:'owner',name:'統括',role:'owner',tenantId:tenant,readOnly:false};
 app=new Hono<Env>();app.use('*',async(c,next)=>{c.set('staff',actor);if(actor.readOnly&&!['GET','HEAD'].includes(c.req.method))return c.json({success:false},403);await next();});
 for(const router of [friendAttributes,hqBanners,hqTemplates,hqBroadcasts])app.route('/',router);
});
afterEach(()=>f.raw.close());
const call=(path:string,method='GET',body?:unknown)=>app.request(path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})},{DB:f.db});
async function data(response:Response){expect(response.status,await response.clone().text()).toBeLessThan(300);return (await response.json() as {data:any}).data;}
describe('同名フォルダの作成・改名',()=>{
 it('本来のAPI変換を通しても、統括配信フォルダの重複の理由を伝える',async()=>{
  const api=new Hono<Env>();api.use('*',apiContractMiddleware);api.use('*',async(c,next)=>{c.set('staff',actor);await next()});api.route('/',hqBroadcasts);
  const post=()=>api.request('/api/hq/broadcasts/folders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'テスト'})},{DB:f.db});
  expect((await post()).status).toBe(201);const duplicate=await post();expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toMatchObject({error:{code:'FOLDER_NAME_CONFLICT',message:'同じ名前のフォルダがあります',fieldErrors:[{field:'name',message:'同じ名前のフォルダがあります'}]}});
 });
 it.each([
  {path:'/api/hq/broadcasts/folders',body:{},version:'expectedVersion'},
  {path:'/api/hq/templates/folders',body:{},version:'expectedRevision'},
  {path:'/api/hq/banners/folders',body:{kind:'project'},version:'expectedRevision'},
  {path:'/api/folders',body:{kind:'friend_add_rule',accountId:'a'},version:'expectedRevision'},
 ])('$path は重複だけを409と名前の理由にする',async({path,body,version})=>{
  const first=await data(await call(path,'POST',{...body,name:'テスト'}));
  const second=await data(await call(path,'POST',{...body,name:'別名'}));
  const duplicate=await call(path,'POST',{...body,name:' テスト '});
  expect(duplicate.status,await duplicate.clone().text()).toBe(409);
  expect(await duplicate.json()).toMatchObject({error:'同じ名前のフォルダがあります',fields:{name:'同じ名前のフォルダがあります'}});
  const renamed=await call(`${path}/${second.id}`,'PATCH',{...body,name:'テスト',[version]:1});
  expect(renamed.status,await renamed.clone().text()).toBe(409);
  expect(await renamed.json()).toMatchObject({error:'同じ名前のフォルダがあります',fields:{name:'同じ名前のフォルダがあります'}});
  const same=await call(`${path}/${first.id}`,'PATCH',{...body,name:'テスト',[version]:1});expect(same.status,await same.clone().text()).toBe(200);
  if(path==='/api/folders'||path==='/api/hq/broadcasts/folders'){
   const stale=await call(`${path}/${first.id}`,'PATCH',{...body,name:'テスト',[version]:1});
   expect(stale.status).toBe(409);expect(await stale.json()).toMatchObject({code:'VERSION_CONFLICT'});
  }
 });
});
describe('新しい店の共通フォルダ',()=>{
 it.each(['affiliate','affiliate_offer','mileage_reward','friend_add_rule'])('%s: 作る・改名・色・並べ替え・削除と古い版を拒否',async kind=>{
  const a=await data(await call('/api/folders','POST',{kind,accountId:'a',name:'A',color:'#3b82f6'}));
  const b=await data(await call('/api/folders','POST',{kind,accountId:'a',name:'B'}));expect(a).toMatchObject({kind,revision:1,accountId:'a'});
  const changed=await data(await call(`/api/folders/${a.id}`,'PATCH',{name:'変更',color:'#16a34a',expectedRevision:1}));expect(changed).toMatchObject({name:'変更',color:'#16a34a',revision:2});
  expect((await call(`/api/folders/${a.id}`,'PATCH',{name:'古い',expectedRevision:1})).status).toBe(409);
  expect((await call(`/api/folders/${a.id}/swap-order`,'POST',{withId:b.id,accountId:'a',expectedRevision:1,withExpectedRevision:1})).status).toBe(409);
  await data(await call(`/api/folders/${a.id}/swap-order`,'POST',{withId:b.id,accountId:'a',expectedRevision:2,withExpectedRevision:1}));
  expect((await call(`/api/folders/${a.id}?account_id=a&expectedRevision=2`,'DELETE')).status).toBe(409);
  await data(await call(`/api/folders/${a.id}?account_id=a&expectedRevision=3`,'DELETE'));
  const list=await call(`/api/folders?kind=${kind}&account_id=a`);expect((await list.json() as any).data.map((r:any)=>r.id)).toEqual([b.id]);
 });
 it('accountId必須、他テナント・役割・閲覧のみの更新を拒む',async()=>{
  expect((await call('/api/folders','POST',{kind:'affiliate',name:'なし'})).status).toBe(400);
  const other=f.raw.prepare("INSERT INTO folders(id,kind,name,account_id) VALUES('other-folder','affiliate','他店','b')");other.run();
  expect((await call('/api/folders?kind=affiliate&account_id=b')).status).toBe(404);
  expect((await call('/api/folders/other-folder','PATCH',{name:'変更'})).status).toBe(404);
  expect((await call('/api/folders/other-folder','DELETE')).status).toBe(404);
  actor.readOnly=true;expect((await call('/api/folders','POST',{kind:'affiliate',name:'X',accountId:'a'})).status).toBe(403);
  actor.readOnly=false;actor.role='staff';expect((await call('/api/folders','POST',{kind:'affiliate',name:'X',accountId:'a'})).status).toBe(403);
 });
 it('同じ版からの同時保存は1件だけ成功し、他方は409になる',async()=>{
  const folder=await data(await call('/api/folders','POST',{kind:'mileage_reward',name:'同時',accountId:'a'}));
  const responses=await Promise.all(['変更A','変更B'].map(name=>call(`/api/folders/${folder.id}`,'PATCH',{name,expectedRevision:1})));
  expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
 });
});
describe('統括バナーのフォルダ',()=>{
 it.each(['project','image'])('%s: 作る・直す・色・入れ替え・アーカイブ',async kind=>{
  const a=await data(await call('/api/hq/banners/folders','POST',{kind,name:'A',color:'#3b82f6'}));
  const b=await data(await call('/api/hq/banners/folders','POST',{kind,name:'B'}));
  expect(a).toMatchObject({kind,displayOrder:0,revision:1,itemCount:0});
  expect((await call(`/api/hq/banners/folders/${a.id}`,'PATCH',{kind,name:'変更',color:null,expectedRevision:1})).status).toBe(200);
  expect((await call(`/api/hq/banners/folders/${a.id}`,'PATCH',{kind,name:'古い',expectedRevision:1})).status).toBe(409);
  await data(await call(`/api/hq/banners/folders/${a.id}/swap-order`,'POST',{kind,withId:b.id,expectedRevision:2,withExpectedRevision:1}));
  expect((await call(`/api/hq/banners/folders/${a.id}`,'DELETE',{kind,expectedRevision:2})).status).toBe(409);
  await data(await call(`/api/hq/banners/folders/${a.id}`,'DELETE',{kind,expectedRevision:3}));
  expect((await data(await call(`/api/hq/banners/folders?kind=${kind}`))).map((r:any)=>r.id)).toEqual([b.id]);
  expect(f.raw.prepare('SELECT archived_at FROM hq_banner_folders WHERE id=?').get(a.id)).toMatchObject({archived_at:expect.any(String)});
 });
 it('種類・色・名前を検査し、種類越え・テナント越えを拒む',async()=>{
  expect((await call('/api/hq/banners/folders?kind=invalid')).status).toBe(422);
  expect((await call('/api/hq/banners/folders','POST',{kind:'image',name:'A',color:'red'})).status).toBe(422);
  const a=await data(await call('/api/hq/banners/folders','POST',{kind:'project',name:'A'}));
  const b=await data(await call('/api/hq/banners/folders','POST',{kind:'image',name:'A'}));
  expect((await call('/api/hq/banners/folders','POST',{kind:'project',name:'A'})).status).toBe(409);
  expect((await call(`/api/hq/banners/folders/${a.id}/swap-order`,'POST',{kind:'project',withId:b.id,expectedRevision:1,withExpectedRevision:1})).status).toBe(404);
  f.raw.exec("INSERT INTO hq_banner_folders(id,tenant_id,kind,name) VALUES('foreign','other','project','別')");
  expect((await call('/api/hq/banners/folders/foreign','PATCH',{kind:'project',name:'変更',expectedRevision:1})).status).toBe(404);
  expect((await call('/api/hq/banners/folders/foreign','DELETE',{kind:'project',expectedRevision:1})).status).toBe(404);
  actor.readOnly=true;expect((await call('/api/hq/banners/folders','POST',{kind:'project',name:'読取'})).status).toBe(403);
  expect((await call('/api/hq/banners/folders?kind=project')).status).toBe(200);
  actor.readOnly=false;actor.role='staff';expect((await call('/api/hq/banners/folders?kind=project')).status).toBe(403);
 });
 it('所属を保存・絞り込みでき、削除で画像と配布記録を残す',async()=>{
  const projectFolder=await data(await call('/api/hq/banners/folders','POST',{kind:'project',name:'案件'}));
  const imageFolder=await data(await call('/api/hq/banners/folders','POST',{kind:'image',name:'素材'}));
  const project=await data(await call('/api/hq/banners/projects','POST',{name:'バナー',folderId:projectFolder.id}));expect(project.folderId).toBe(projectFolder.id);
  f.raw.prepare("INSERT INTO media(id,kind,filename,mime_type,size_bytes,r2_key) VALUES('media','image','image.png','image/png',1,'r2')").run();
  f.raw.prepare("INSERT INTO banner_images(id,tenant_id,project_id,media_id) VALUES('image',?,?,'media')").run(tenant,project.id);
  f.raw.exec("INSERT INTO banner_image_deliveries(id,banner_image_id,line_account_id,media_id) VALUES('delivery','image','a','media')");
  const delivery=f.raw.prepare("SELECT * FROM banner_image_deliveries WHERE id='delivery'").get();
  await data(await call('/api/hq/banners/images/image','PATCH',{folderId:imageFolder.id}));
  expect((await data(await call(`/api/hq/banners/images?folderId=${imageFolder.id}`))).map((r:any)=>r.id)).toEqual(['image']);
  expect(await data(await call('/api/hq/banners/images?folderId=__none__'))).toEqual([]);
  expect((await call('/api/hq/banners/images/image','PATCH',{folderId:projectFolder.id})).status).toBe(422);
  await data(await call(`/api/hq/banners/folders/${imageFolder.id}`,'DELETE',{kind:'image',expectedRevision:1}));
  expect(f.raw.prepare("SELECT folder_id,deleted_at,media_id FROM banner_images WHERE id='image'").get()).toEqual({folder_id:null,deleted_at:null,media_id:'media'});
  expect(f.raw.prepare("SELECT COUNT(*) AS n FROM media WHERE id='media'").get()).toEqual({n:1});
  expect(f.raw.prepare("SELECT * FROM banner_image_deliveries WHERE id='delivery'").get()).toEqual(delivery);
  await data(await call(`/api/hq/banners/folders/${projectFolder.id}`,'DELETE',{kind:'project',expectedRevision:1}));
  expect(f.raw.prepare('SELECT folder_id,archived_at FROM banner_projects WHERE id=?').get(project.id)).toEqual({folder_id:null,archived_at:null});
 });
});
describe('統括の2一覧のswap-order',()=>{
 it.each(['templates','broadcasts'])('%s: 双方の版・権限・テナントを確認する',async type=>{
  const table=type==='templates'?'hq_template_folders':'hq_broadcast_folders';
  f.raw.prepare(`INSERT INTO ${table}(id,tenant_id,name,display_order) VALUES('first',?,'A',0),('second',?,'B',1),('foreign','other','C',0)`).run(tenant,tenant);
  const path=`/api/hq/${type}/folders/first/swap-order`;
  const body=type==='templates'?{withId:'second',expectedRevision:1,withExpectedRevision:1}:{withId:'second',expectedVersion:1,withExpectedVersion:1};
  expect((await call(path,'POST',body)).status).toBe(200);
  expect((await data(await call(`/api/hq/${type}/folders`))).map((r:any)=>r.id)).toEqual(['second','first']);
  expect((await call(path,'POST',body)).status).toBe(409);
  expect((await call(path,'POST',{...body,withId:'foreign'})).status).toBe(404);
  actor.readOnly=true;expect((await call(path,'POST',body)).status).toBe(403);actor.readOnly=false;
  f.raw.exec("UPDATE staff_members SET role='admin',account_scope='accounts' WHERE id='owner'");
  expect((await call(path,'POST',body)).status).toBe(403);
 });
});
