import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import { saveTemplate } from './hq-templates/distribution.js';
import { saveCatalogStarter, listStarterCatalog } from './style-starter-catalog-save.js';
import { applyCatalogStarter } from './style-starter-catalog-apply.js';
import { initializeAccountStyle, saveProfile } from './style-setup.js';
import { catalogResourceColumnPolicy, catalogResourceSnapshot } from './style-starter-catalog-resources.js';
import type { HqTemplateAuthority } from './hq-templates/contract.js';
import type { StarterCatalogSelection } from '@line-crm/shared';

let sql: ReturnType<typeof createTestD1>;
const authority: HqTemplateAuthority = {tenantId:'t',actorId:'owner',role:'owner',readOnly:false,accountScoped:false};
const bucket = {head:async()=>null,get:async()=>null,put:async()=>null,delete:async()=>{}} as unknown as R2Bucket;
const tag = (name='分類') => ({schemaVersion:1,folders:[],tag:{name,color:'#3B82F6',description:null,folderId:null}});
const message = (name='ご案内', text='カタログに保存した本文') => ({schemaVersion:1,template:{id:'hq-authored-message',name,category:'general',messageType:'text',messageContent:text,carouselActionsJson:null,carouselTapLimitMode:'none',carouselTapLimitText:null,questionJson:null,questionStatus:'draft'},media:[]});
async function catalog(type:'tag'|'template', definition:unknown) {
  const saved = await saveTemplate(sql.db,authority,{type,name:'見本',definition,requestId:crypto.randomUUID()});
  return { kind:type,templateId:saved.template.id,versionId:saved.template.current_version_id! } satisfies StarterCatalogSelection;
}
function revision(id:string){return (sql.raw.prepare('SELECT revision FROM hq_templates WHERE id=?').get(id) as {revision:number}).revision}
async function set(selections:StarterCatalogSelection[], autoInsert=true, expectedVersion=0) {
  return saveCatalogStarter(sql.db,'t','owner','standard',{expectedVersion,confirmed:true,autoInsert,definition:{mode:'catalog',items:[],selections}});
}
beforeEach(()=>{
  sql=createTestD1({foreignKeys:true,now:()=>new Date()});
  sql.raw.exec(`INSERT INTO tenants(id,name) VALUES('t','本部'),('other','別の本部');
    INSERT INTO line_accounts(id,tenant_id,channel_id,name,channel_access_token,channel_secret) VALUES('a','t','ca','店舗','fixture','fixture'),('source','t','cs','元の店','fixture','fixture'),('b','other','cb','別店舗','fixture','fixture');
    INSERT INTO staff_members(id,name,role,api_key,tenant_id) VALUES('owner','統括','owner','owner-key','t'),('admin','店の担当者','admin','admin-key','t');
    INSERT INTO staff_account_scopes(staff_id,line_account_id,created_at) VALUES('admin','a','now');
    UPDATE staff_members SET account_scope='accounts' WHERE id='admin';
    UPDATE line_accounts SET liff_id='liff-'||id;`);
});
afterEach(()=>{sql.raw.close();vi.restoreAllMocks()});
test('空の組を明示保存でき、シンプルを選んでも標準文面やメニューで埋めず、未選択では投入しない',async()=>{
  await set([]);
  await initializeAccountStyle(sql.db,'a','t','owner');
  expect(sql.raw.prepare('SELECT COUNT(*) n FROM templates').get()).toEqual({n:0});
  expect(sql.raw.prepare('SELECT COUNT(*) n FROM rich_menu_groups').get()).toEqual({n:0});
  await saveProfile(sql.db,'a','t','owner',{expectedVersion:1,style:'standard',answers:{image:{mode:'configured',value:'simple'}}});
  expect(sql.raw.prepare('SELECT COUNT(*) n FROM templates').get()).toEqual({n:0});
  expect(sql.raw.prepare('SELECT COUNT(*) n FROM rich_menu_groups').get()).toEqual({n:0});
  expect(sql.raw.prepare('SELECT COUNT(*) n FROM forms').get()).toEqual({n:0});
});
test('保存したカタログの版を固定し、新しい版へ勝手に差し替えない',async()=>{
  const choice=await catalog('tag',tag('最初の版'));
  await set([choice]);
  await saveTemplate(sql.db,authority,{name:'新しい版',definition:tag('次の版'),expectedRevision:revision(choice.templateId)},choice.templateId);
  const saved=sql.raw.prepare('SELECT definition_json FROM style_starter_sets WHERE archived_at IS NULL').get() as {definition_json:string};
  expect(JSON.parse(saved.definition_json).selections).toEqual([choice]);
  await initializeAccountStyle(sql.db,'a','t','owner','standard');
  expect(sql.raw.prepare("SELECT name FROM tags WHERE line_account_id='a'").all()).toEqual([{name:'最初の版'}]);
});
test('店限定の担当者のスタイル選択でも、統括の承認済みの組だけを入れ、二回目は複製しない',async()=>{
  await set([await catalog('tag',tag())]);
  const saved=await initializeAccountStyle(sql.db,'a','t','admin','standard');
  expect(saved.catalogApplication?.items[0].state).toBe('succeeded');
  const initialTime = (sql.raw.prepare("SELECT first_starter_at FROM account_styles WHERE line_account_id='a'").get() as {first_starter_at:string | null}).first_starter_at;
  expect(initialTime).toBeTruthy();
  await applyCatalogStarter(sql.db,'t','a','admin','standard');
  expect(sql.raw.prepare("SELECT first_starter_at FROM account_styles WHERE line_account_id='a'").get()).toEqual({first_starter_at:initialTime});
  expect(sql.raw.prepare("SELECT COUNT(*) n FROM tags WHERE line_account_id='a'").get()).toEqual({n:1});
  expect(sql.raw.prepare("SELECT initiated_by,approved_by,state FROM style_starter_catalog_items").get()).toEqual({initiated_by:'admin',approved_by:'owner',state:'succeeded'});
});
test('別統括の版・種類違い・未対応の種類を保存できない',async()=>{
  const choice=await catalog('tag',tag());
  const foreign=await saveTemplate(sql.db,{...authority,tenantId:"other"},{type:"tag",name:"別統括の見本",definition:tag(),requestId:crypto.randomUUID()});
  await expect(saveCatalogStarter(sql.db,'t','owner','standard',{expectedVersion:0,confirmed:true,definition:{mode:'catalog',items:[],selections:[{...choice,templateId:foreign.template.id,versionId:foreign.template.current_version_id!}]}})).rejects.toMatchObject({code:'catalog_version_unavailable'});
  await expect(set([{...choice,kind:'form'}])).rejects.toMatchObject({code:'catalog_version_unavailable'});
  await expect(set([{...choice,kind:'visit_stamp'}])).rejects.toMatchObject({code:'invalid_starter_set'});
});
test('店限定・閲覧のみの承認では保存できず、承認者の権限が失われたら自動実行しない',async()=>{
  const choice=await catalog('tag',tag());
  await expect(saveCatalogStarter(sql.db,'t','admin','standard',{expectedVersion:0,confirmed:true,definition:{mode:'catalog',items:[],selections:[choice]}})).rejects.toMatchObject({code:'forbidden'});
  await set([choice]);
  sql.raw.exec("UPDATE staff_members SET access_level='read_only' WHERE id='owner'");
  const result=await initializeAccountStyle(sql.db,'a','t','admin','standard');
  expect(result.catalogApplication?.items[0]).toMatchObject({state:'blocked',reason:'catalog_approval_unavailable'});
  expect(sql.raw.prepare("SELECT version FROM account_styles WHERE line_account_id='a'").get()).toEqual({version:1});
  expect(sql.raw.prepare('SELECT COUNT(*) n FROM tags').get()).toEqual({n:0});
});
test('違う店の境界と自動投入オフを守る',async()=>{
  await set([await catalog('tag',tag())],false);
  await initializeAccountStyle(sql.db,'a','t','admin','standard');
  expect(sql.raw.prepare('SELECT COUNT(*) n FROM tags').get()).toEqual({n:0});
  await set([await catalog('tag',tag('別'))],true,1);
  sql.raw.exec("INSERT INTO account_styles(line_account_id,style,updated_at) VALUES('b','standard','now')");
  await expect(applyCatalogStarter(sql.db,'t','b','owner','standard')).rejects.toMatchObject({code:'catalog_approval_unavailable'});
});
test('店が持つ同名タグを上書きせず、確認待ちにする',async()=>{
  await set([await catalog('tag',tag())]);
  sql.raw.exec("INSERT INTO tags(id,line_account_id,name,color) VALUES('local','a','分類','#ef4444')");
  const result=await initializeAccountStyle(sql.db,'a','t','admin','standard');
  expect(result.catalogApplication?.items[0]).toMatchObject({state:'blocked',reason:'catalog_local_changes'});
  expect(sql.raw.prepare("SELECT id,color FROM tags WHERE line_account_id='a'").all()).toEqual([{id:'local',color:'#ef4444'}]);
});
test('テンプレートを未公開の下書きで作り、カタログの本文と版を保つ',async()=>{
  await set([await catalog('template',message())]);
  const result=await initializeAccountStyle(sql.db,'a','t','admin','standard',{bucket,publicBaseUrl:'https://worker.test'});
  expect(result.catalogApplication?.items[0]).toMatchObject({state:'succeeded'});
  expect(sql.raw.prepare("SELECT published_version,draft_revision,draft_message_content FROM templates WHERE line_account_id='a'").get()).toEqual({published_version:0,draft_revision:1,draft_message_content:'カタログに保存した本文'});
  expect(sql.raw.prepare('SELECT COUNT(*) n FROM template_versions').get()).toEqual({n:0});
});
test('一度入った物を店で編集しても、再保存・再試行で上書きしない',async()=>{
  const choice=await catalog('tag',tag());await set([choice]);
  await initializeAccountStyle(sql.db,'a','t','admin','standard');
  const before=await catalogResourceSnapshot(sql.db,'a','tag',String((sql.raw.prepare("SELECT id FROM tags WHERE line_account_id='a'").get() as {id:string}).id));
  sql.raw.exec("UPDATE tags SET name='店で直した',version=version+1 WHERE line_account_id='a'");
  await saveProfile(sql.db,'a','t','admin',{expectedVersion:1,style:'standard'});
  expect(sql.raw.prepare("SELECT name FROM tags WHERE line_account_id='a'").all()).toEqual([{name:'店で直した'}]);
  expect(before).not.toBe(await catalogResourceSnapshot(sql.db,'a','tag',String((sql.raw.prepare("SELECT id FROM tags WHERE line_account_id='a'").get() as {id:string}).id)));
});
test('候補は同じ統括の現在の版と選択済みの版だけで、本文を返さない',async()=>{
  const choice=await catalog('template',message()); await set([choice]);
  const options=await listStarterCatalog(sql.db,'t');
  expect(options).toHaveLength(1);expect(options[0]).toMatchObject({kind:'template',versionId:choice.versionId,version:1});
  expect(options[0]).not.toHaveProperty('definition_json');
  expect(await listStarterCatalog(sql.db,'other')).toEqual([]);
});
test('失敗の後に同じアカウントで再開し、成功済みの物を二重に作らない',async()=>{
 const first=await catalog('tag',tag('先に入る'));
 const second=await catalog('template',message());await set([first,second]);
 const initial=await initializeAccountStyle(sql.db,'a','t','admin','standard');
 expect(initial.catalogApplication?.items.map(row=>row.state)).toEqual(['succeeded','failed']);
 const again=await applyCatalogStarter(sql.db,'t','a','admin','standard',{bucket,publicBaseUrl:'https://worker.test'});
 expect(again.items.every(row=>row.state==='succeeded')).toBe(true);
 expect(sql.raw.prepare("SELECT COUNT(*) n FROM tags WHERE line_account_id='a'").get()).toEqual({n:1});
 expect(sql.raw.prepare("SELECT COUNT(*) n FROM templates WHERE line_account_id='a'").get()).toEqual({n:1});
});
test('同じ組のフォームが使うタグを再利用し、未公開のまま作る',async()=>{
 const choice=await catalog('tag',tag('フォーム用'));await set([choice]);
 sql.raw.exec("INSERT INTO tags(id,line_account_id,name,color) VALUES('source-tag','source','フォーム用','#3B82F6')");
 const saved=await saveTemplate(sql.db,authority,{type:'form',name:'入力',definition:{schemaVersion:1,form:{name:'入力',description:null,fields:[{name:'answer',label:'回答',type:'text',required:false}],layout:null,on_submit_tag_id:'source-tag',on_submit_scenario_id:null,save_to_metadata:false}},requestId:crypto.randomUUID()});
 const form:StarterCatalogSelection={kind:'form',templateId:saved.template.id,versionId:saved.template.current_version_id!};
 await set([choice,form],true,1);const result=await initializeAccountStyle(sql.db,'a','t','admin','standard');
 expect(result.catalogApplication?.items.map(row=>row.state)).toEqual(['succeeded','succeeded']);
 expect(sql.raw.prepare('SELECT is_active FROM forms').get()).toEqual({is_active:0});
 expect(sql.raw.prepare("SELECT COUNT(*) n FROM tags WHERE line_account_id='a'").get()).toEqual({n:1});
});
test('テンプレートを参照する自動応答を停止状態で作り、店IDに解決する',async()=>{
 const template=await catalog('template',message('案内本文'));
 const saved=await saveTemplate(sql.db,authority,{type:'auto_reply',name:'応答',requestId:crypto.randomUUID(),definition:{schemaVersion:1,settings:{name:'応答',keyword:'案内',matchType:'exact',responseType:'text',responseContent:'',templateId:'source-template'},references:[{kind:'template',sourceId:'source-template',name:'案内本文'}]}});
 await set([template,{kind:'auto_reply',templateId:saved.template.id,versionId:saved.template.current_version_id!}]);
 const result=await initializeAccountStyle(sql.db,'a','t','admin','standard',{bucket,publicBaseUrl:'https://worker.test'});
 expect(result.catalogApplication?.items.map(row=>row.state)).toEqual(['succeeded','succeeded']);
 const row=sql.raw.prepare('SELECT is_active,lifecycle_status FROM auto_replies').get();expect(row).toEqual({is_active:0,lifecycle_status:'draft'});
 const snapshot=JSON.parse((sql.raw.prepare('SELECT definition_snapshot FROM auto_reply_versions').get() as {definition_snapshot:string}).definition_snapshot);
 expect(snapshot.templateId).toBe((sql.raw.prepare("SELECT id FROM templates WHERE line_account_id='a'").get() as {id:string}).id);
 const {getAutoReplyDraftVersion}=await import('@line-crm/db');const {validateDraft}=await import('../routes/auto-replies-definition.js');
 const reply=sql.raw.prepare('SELECT id FROM auto_replies').get() as {id:string};
 const draft=await getAutoReplyDraftVersion(sql.db,reply.id);
 sql.raw.exec("UPDATE templates SET deleted_at='2099-01-01' WHERE line_account_id='a'");
 const validation=await validateDraft(sql.db,draft!);
 expect(validation.valid).toBe(false);expect(validation.errors).toContain('選んだテンプレートを確認できません');
});
test('手動で新しい版を別名コピーし、店の変更を保ち、起点と承認を監査する',async()=>{
 const {starterDistributionPlan,distributeStarter}=await import('./style-starter-distribution.js');
 const first=await catalog('tag',tag());await set([first]);await initializeAccountStyle(sql.db,'a','t','admin','standard');
 sql.raw.exec("UPDATE tags SET description='店の独自設定',version=version+1 WHERE line_account_id='a'");
 const saved=await saveTemplate(sql.db,authority,{name:'新版',definition:tag(),expectedRevision:revision(first.templateId)},first.templateId);
 await set([{...first,versionId:saved.template.current_version_id!}],true,1);
 const input={expectedVersion:2,target:{accountIds:['a']}};
 const plan=await starterDistributionPlan(sql.db,'t','standard',input);
 expect(plan.editedCount).toBe(1);
 await distributeStarter(sql.db,'t','owner','standard',{...input,confirmed:true,token:plan.token,editedAction:'new_copy'});
 expect(sql.raw.prepare("SELECT name,description FROM tags WHERE line_account_id='a' ORDER BY name").all()).toEqual([{name:'分類',description:'店の独自設定'},{name:'分類 (2)',description:null}]);
 const audit=sql.raw.prepare("SELECT actor_principal_id,after_json FROM audit_events WHERE action='style_starter.catalog_started' ORDER BY rowid LIMIT 1").get() as {actor_principal_id:string;after_json:string};
 expect(audit.actor_principal_id).toBe('admin');expect(JSON.parse(audit.after_json)).toMatchObject({approvedBy:'owner',automatic:true});
});
test('クーポン素材も未公開の下書きで入れる',async()=>{
 const definition={...message('特典',''),asset:{kind:'coupon',payload:{description:'割引',startsAt:'2030-01-01',endsAt:'2030-12-31'}}};
 const saved=await catalog('template',definition);
 await set([{...saved,kind:'coupon'}]);
 const result=await initializeAccountStyle(sql.db,'a','t','admin','standard',{bucket,publicBaseUrl:'https://worker.test'});
 expect(result.catalogApplication?.items[0]).toMatchObject({state:'succeeded'});
 expect(sql.raw.prepare("SELECT kind,published_version,draft_revision FROM broadcast_message_assets WHERE line_account_id='a'").get()).toEqual({kind:'coupon',published_version:0,draft_revision:1});
 expect(sql.raw.prepare('SELECT COUNT(*) n FROM broadcast_asset_versions').get()).toEqual({n:0});
});
test('投入の予期しない失敗でも登録を成功として返し、共通のエラー報告を呼ぶ',async()=>{
 await set([await catalog('tag',tag())]);
 const original=sql.db.batch.bind(sql.db),reportError=vi.fn();let batches=0;
 sql.db.batch=async statements=>{batches++;if(batches===2)throw new Error('simulated database outage');return original(statements)};
 const result=await initializeAccountStyle(sql.db,'a','t','admin','standard',{reportError});
 expect(result.version).toBe(1);expect(result.catalogApplication?.items[0].state).toBe('failed');expect(reportError).toHaveBeenCalledTimes(1);
});
test('カタログ一覧と版の読取は統括・権限の境界を越えず、保存失敗はDBを変えない',async()=>{
 const {Hono}=await import('hono');const {styles}=await import('../routes/styles-routes-3.js');
 type Env=import('../worker-env.js').Env;
 const choice=await catalog('tag',tag());let staffId='owner',readOnly=false;
 const app=new Hono<Env>();app.onError((err,c)=>c.json({success:false,error:{code:(err as {code?:string}).code??'unexpected'}},(err as {status?:400}).status??500));
 app.use('*',async(c,next)=>{c.set('staff',{id:staffId,name:'担当者',role:staffId==='owner'?'owner':'admin',readOnly,tenantId:'t'});await next()});app.route('/',styles);
 const request=(path:string,method='GET',body?:unknown)=>app.request(`/api/hq/style-starter-sets${path}`,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})},{DB:sql.db} as Env['Bindings']);
 expect((await request('/catalog')).status).toBe(200);
 expect((await request(`/catalog/${choice.templateId}/versions/${choice.versionId}?kind=tag`)).status).toBe(200);
 expect((await request(`/catalog/${choice.templateId}/versions/${choice.versionId}?kind=form`)).status).toBe(409);
 const body={name:'組',expectedVersion:0,confirmed:true,definition:{mode:'catalog',items:[],selections:[choice]}};
 readOnly=true;expect((await request('/standard','PUT',body)).status).toBe(403);
 staffId='admin';readOnly=false;expect((await request('/catalog')).status).toBe(403);expect((await request('/standard','PUT',body)).status).toBe(403);
 expect(sql.raw.prepare('SELECT COUNT(*) n FROM style_starter_sets').get()).toEqual({n:0});
});
test('一度も作れていない古い版は、組を更新した後に新しい版でやり直せる',async()=>{
 const first=await catalog('template',message('旧版'));await set([first]);
 await initializeAccountStyle(sql.db,'a','t','admin','standard');
 const saved=await saveTemplate(sql.db,authority,{name:'新版',definition:message('新版'),expectedRevision:revision(first.templateId)},first.templateId);
 await set([{...first,versionId:saved.template.current_version_id!}],true,1);
 const result=await applyCatalogStarter(sql.db,'t','a','admin','standard',{bucket,publicBaseUrl:'https://worker.test'});
 expect(result.items[0].state).toBe('succeeded');expect(sql.raw.prepare("SELECT name FROM templates WHERE line_account_id='a'").all()).toEqual([{name:'新版'}]);
});
test('配布時に記録した中身が実体と一致する',async()=>{
 await set([await catalog('tag',tag()),await catalog('template',message())]);
 await initializeAccountStyle(sql.db,'a','t','admin','standard',{bucket,publicBaseUrl:'https://worker.test'});
 const rows=sql.raw.prepare("SELECT resource_kind,target_id,source_snapshot FROM style_starter_catalog_resources WHERE line_account_id='a'").all() as Array<{resource_kind:string;target_id:string;source_snapshot:string}>;
 expect(rows.map(row=>row.resource_kind).sort()).toEqual(['tag','template']);
 for(const row of rows)expect(row.source_snapshot).toBe(await catalogResourceSnapshot(sql.db,'a',row.resource_kind,row.target_id));
});
test('改行・タブ・絵文字と複数の子行でも比較記録が一致し、一文字の変更を検出する',async()=>{
 const {catalogResourceCommit}=await import('./style-starter-catalog-resources.js');
 await set([await catalog('template',message('表示の確認','1行目\n\t2行目 😀\u0001\u0000\"\\'))]);
 await initializeAccountStyle(sql.db,'a','t','admin','standard',{bucket,publicBaseUrl:'https://worker.test'});
 const {id}=sql.raw.prepare("SELECT id FROM templates WHERE line_account_id='a'").get() as {id:string};
 for(const [version,text] of [[1,'本文\n\t😀'],[2,'別の本文\n\t😀']] as const)sql.raw.prepare("INSERT INTO template_versions(id,template_id,version_number,message_type,message_content) VALUES(?,?,?,'text',?)").run(`version-${version}`,id,version,text);
 await sql.db.batch((await catalogResourceCommit(sql.db,'t','a',[{itemKind:'template',targetId:id}])).map(row=>sql.db.prepare(row.sql).bind(...row.bindings)));
 const before=(sql.raw.prepare("SELECT source_snapshot FROM style_starter_catalog_resources WHERE line_account_id='a' AND resource_kind='template'").get() as {source_snapshot:string}).source_snapshot;
 expect(before).toBe(await catalogResourceSnapshot(sql.db,'a','template',id));
 sql.raw.exec("UPDATE templates SET updated_at='2099-01-01',draft_revision=draft_revision+1;ALTER TABLE templates ADD COLUMN future_counter INTEGER DEFAULT 0");
 expect(before).toBe(await catalogResourceSnapshot(sql.db,'a','template',id));
 sql.raw.exec("UPDATE templates SET draft_message_content=draft_message_content||'変'");
 expect(before).not.toBe(await catalogResourceSnapshot(sql.db,'a','template',id));
});
test('フォームの回答数と更新時刻だけでは、店で編集したと見なさない',async()=>{
 const {catalogResourceCommit}=await import('./style-starter-catalog-resources.js');
 sql.raw.exec("INSERT INTO forms(id,name,fields,is_active) VALUES('local-form','入力','[]',0);INSERT INTO form_accounts(form_id,line_account_id) VALUES('local-form','a')");
 await sql.db.batch((await catalogResourceCommit(sql.db,'t','a',[{itemKind:'form',targetId:'local-form'}])).map(row=>sql.db.prepare(row.sql).bind(...row.bindings)));
 const before=await catalogResourceSnapshot(sql.db,'a','form','local-form');
 sql.raw.exec("UPDATE forms SET submit_count=submit_count+1,updated_at='2099-01-01',revision=revision+1 WHERE id='local-form'");
 expect(await catalogResourceSnapshot(sql.db,'a','form','local-form')).toBe(before);
 sql.raw.exec("UPDATE forms SET description='お店で変更' WHERE id='local-form'");
 expect(await catalogResourceSnapshot(sql.db,'a','form','local-form')).not.toBe(before);
});
test('7領域のリッチメニューもカタログどおり未公開で入れ、再試行で増やさない',async()=>{
 const bytes=new Uint8Array([1,2,3]);
 const objects=new Map<string,{bytes:Uint8Array;etag:string;size:number;httpMetadata:{contentType:string};customMetadata?:Record<string,string>}>([['hq-templates/t/menu-image',{bytes,etag:'source',size:3,httpMetadata:{contentType:'image/png'}}]]);
 const images={head:vi.fn(async(key:string)=>objects.get(key)??null),get:vi.fn(async(key:string)=>{const value=objects.get(key);return value?{...value,body:new ReadableStream<Uint8Array>({start(c){c.enqueue(value.bytes.slice());c.close()}}),arrayBuffer:async()=>value.bytes.slice().buffer}:null}),put:vi.fn(async(key:string,data:Uint8Array,options:R2PutOptions)=>{const value={bytes:data.slice(),etag:`copied-${objects.size}`,size:data.length,httpMetadata:options.httpMetadata as {contentType:string},customMetadata:options.customMetadata};objects.set(key,value);return value}),delete:vi.fn(async(key:string)=>{objects.delete(key)})};
 const definition={schemaVersion:1,richMenu:{id:'menu-source',name:'配置',chatBarText:'開く',size:'large',defaultPageId:'page-source',pages:[{id:'page-source',name:'メイン',imageR2Key:'hq-templates/t/menu-image',areas:Array.from({length:7},(_,i)=>({id:`area-${i}`,label:`領域${i+1}`,bounds:{x:i*100,y:0,width:100,height:100},actionType:'message',actionData:{text:'カタログの案内'},intent:'text'}))}]}};
 const saved=await saveTemplate(sql.db,authority,{type:'rich_menu',name:'配置',definition,requestId:crypto.randomUUID()});
 await set([{kind:'rich_menu',templateId:saved.template.id,versionId:saved.template.current_version_id!}]);
 const runtime={bucket:images as unknown as R2Bucket,publicBaseUrl:'https://worker.test'};
 const result=await initializeAccountStyle(sql.db,'a','t','admin','standard',runtime);
 expect(result.catalogApplication?.items[0]).toMatchObject({state:'succeeded'});
 expect(sql.raw.prepare("SELECT status FROM rich_menu_groups WHERE account_id='a'").get()).toEqual({status:'draft'});
 expect(sql.raw.prepare('SELECT COUNT(*) n FROM rich_menu_areas').get()).toEqual({n:7});
 expect(sql.raw.prepare('SELECT line_richmenu_id FROM rich_menu_pages').get()).toEqual({line_richmenu_id:null});
 const writes=images.put.mock.calls.length;
 const savedProfile=await saveProfile(sql.db,'a','t','admin',{expectedVersion:1,style:'standard',confirmInitialMenu:true,answers:{image:{mode:'configured',value:'simple'}}},{images:images as unknown as R2Bucket,catalogRuntime:runtime});
 expect(savedProfile.catalogApplication?.items[0]).toMatchObject({state:'succeeded'});
 expect(sql.raw.prepare('SELECT COUNT(*) n FROM rich_menu_groups').get()).toEqual({n:1});
 expect(sql.raw.prepare('SELECT COUNT(*) n FROM rich_menu_areas').get()).toEqual({n:7});
 expect(sql.raw.prepare('SELECT COUNT(*) n FROM forms').get()).toEqual({n:0});
 const {starter}=await import('./style-starter-set.js');
 expect((await starter(sql.db,'t','standard',true)).definition).toEqual({mode:'catalog',items:[],selections:[{kind:'rich_menu',templateId:saved.template.id,versionId:saved.template.current_version_id!}]});
 await applyCatalogStarter(sql.db,'t','a','admin','standard',runtime);
 expect(images.put).toHaveBeenCalledTimes(writes);expect(sql.raw.prepare('SELECT COUNT(*) n FROM rich_menu_groups').get()).toEqual({n:1});
});
test('同じ確認から遅れて届いた別名コピーは二重に実行しない',async()=>{
 const choice=await catalog('tag',tag());await set([choice]);await initializeAccountStyle(sql.db,'a','t','admin','standard');
 const old=sql.raw.prepare('SELECT distribution_run_id FROM style_starter_catalog_items').get() as {distribution_run_id:string};
 const runtime={manual:true,copyTemplateIds:[choice.templateId],copyFromRuns:{[choice.templateId]:old.distribution_run_id}};
 await applyCatalogStarter(sql.db,'t','a','owner','standard',runtime);
 await applyCatalogStarter(sql.db,'t','a','owner','standard',runtime);
 expect(sql.raw.prepare("SELECT COUNT(*) n FROM tags WHERE line_account_id='a'").get()).toEqual({n:2});
});
test('途中でスタイルの版が変わったら書き込まず、競合として返す',async()=>{
 await set([await catalog('tag',tag())]);const original=sql.db.batch.bind(sql.db),reportError=vi.fn();let batches=0;
 sql.db.batch=async statements=>{batches++;if(batches===2)sql.raw.exec("UPDATE account_styles SET version=version+1 WHERE line_account_id='a'");return original(statements)};
 const result=await initializeAccountStyle(sql.db,'a','t','admin','standard',{reportError});
 expect(result.catalogApplication?.items[0]).toMatchObject({state:'failed',reason:'catalog_conflict'});
 expect(reportError).not.toHaveBeenCalled();expect(sql.raw.prepare('SELECT COUNT(*) n FROM tags').get()).toEqual({n:0});
});


test('比較する19表の列は、内容か理由付きの除外へ漏れなく分類する',()=>{
 for(const [table,columns] of Object.entries(catalogResourceColumnPolicy.content)){
  const actual=(sql.raw.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(row=>row.name).sort()
  const ignored=catalogResourceColumnPolicy.ignored[table]
  expect(Object.keys(ignored).every(reason=>reason.length>0)).toBe(true)
  const classified=[...columns.split(','),...Object.values(ignored).flatMap(value=>value.split(','))]
  expect(new Set(classified).size).toBe(classified.length)
  expect(classified.sort()).toEqual(actual)
 }
})


test('結果のない事前確認が期限切れでも、再試行で作り直して戻れる',async()=>{
 const choice=await catalog('tag',tag());await set([choice])
 const distribution=await import('./hq-templates/distribution.js')
 const original=distribution.preflightDistribution
 vi.spyOn(distribution,'preflightDistribution').mockImplementationOnce(async(...args)=>{
  const preview=await original(...args)
  sql.raw.exec("UPDATE hq_template_preflights SET expires_at='2000-01-01T00:00:00.000Z'")
  return preview
 })
 const first=await initializeAccountStyle(sql.db,'a','t','admin','standard')
 expect(first.version).toBe(1)
 expect(first.catalogApplication?.items[0].state).toBe('failed')
 const resumed=await applyCatalogStarter(sql.db,'t','a','admin','standard')
 expect(resumed.items[0].state).toBe('succeeded')
 expect(sql.raw.prepare("SELECT COUNT(*) n FROM tags WHERE line_account_id='a'").get()).toEqual({n:1})
})


test('通知を選ぶと編集した項目だけ保留し、未投入の別項目を入れて実際の結果を返す',async()=>{
 const {starterDistributionPlan,distributeStarter}=await import('./style-starter-distribution.js')
 const first=await catalog('tag',tag('編集する分類'));await set([first]);await initializeAccountStyle(sql.db,'a','t','admin','standard')
 sql.raw.exec("UPDATE tags SET description='店で編集' WHERE line_account_id='a'")
 const second=await catalog('tag',tag('新しい分類'));await set([first,second],true,1)
 const input={expectedVersion:2,target:{accountIds:['a']}}
 const plan=await starterDistributionPlan(sql.db,'t','standard',input)
 expect(plan.editedCount).toBe(1)
 const result=await distributeStarter(sql.db,'t','owner','standard',{...input,confirmed:true,token:plan.token,editedAction:'notify'})
 expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({key:first.templateId,action:'pending'}),expect.objectContaining({key:second.templateId,action:'created'})]))
 expect(sql.raw.prepare("SELECT name,description FROM tags WHERE line_account_id='a' ORDER BY name").all()).toEqual([{name:'新しい分類',description:null},{name:'編集する分類',description:'店で編集'}])
 const again=await starterDistributionPlan(sql.db,'t','standard',input)
 const repeated=await distributeStarter(sql.db,'t','owner','standard',{...input,confirmed:true,token:again.token,editedAction:'notify'})
 expect(repeated.items.find(item=>item.key===second.templateId)?.action).toBe('existing')
 expect(sql.raw.prepare('SELECT COUNT(*) n FROM notifications').get()).toEqual({n:1})
})

test('手動で別の見本を配っても、最初に初期セットが入った時刻を保つ', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const { starterDistributionPlan, distributeStarter } = await import('./style-starter-distribution.js');
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    const choice = await catalog('tag', tag());
    await set([choice]);
    const first = await initializeAccountStyle(sql.db, 'a', 't', 'admin', 'standard');
    expect(first.catalogApplication?.items[0].state).toBe('succeeded');
    const getTimes = () => sql.raw.prepare(`SELECT s.first_starter_at, i.updated_at, i.distribution_run_id, i.state
      FROM account_styles s JOIN style_starter_catalog_items i ON i.line_account_id=s.line_account_id
      WHERE s.line_account_id='a' AND i.template_id=?`).get(choice.templateId) as {
        first_starter_at: string; updated_at: string; distribution_run_id: string; state: string;
      };
    const before = getTimes();
    expect(before).toMatchObject({ first_starter_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z', state: 'succeeded' });
    expect(before.distribution_run_id).toBeTruthy();
    sql.raw.exec("UPDATE tags SET description='店で編集',version=version+1 WHERE line_account_id='a'");
    const saved = await saveTemplate(sql.db, authority, { name:'新版', definition:tag(), expectedRevision:revision(choice.templateId) }, choice.templateId);
    await set([{...choice, versionId:saved.template.current_version_id!}], true, 1);
    vi.setSystemTime(new Date('2026-10-02T00:00:00Z'));
    const input = {expectedVersion:2, target:{accountIds:['a']}};
    const plan = await starterDistributionPlan(sql.db, 't', 'standard', input);
    expect(plan.editedCount).toBe(1);
    const result = await distributeStarter(sql.db, 't', 'owner', 'standard', {...input, confirmed:true, token:plan.token, editedAction:'new_copy'});
    expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({accountId:'a', key:choice.templateId, action:'created'})]));
    const after = getTimes();
    expect(after.state).toBe('succeeded');
    expect(after.distribution_run_id).toBeTruthy();
    expect(after.distribution_run_id).not.toBe(before.distribution_run_id);
    expect(after.updated_at).toBe('2026-10-02T00:00:00.000Z');
    expect(after.first_starter_at).toBe(before.first_starter_at);
    expect(sql.raw.prepare("SELECT COUNT(*) n FROM tags WHERE line_account_id='a'").get()).toEqual({n:2});
  } finally { vi.useRealTimers(); }
});
