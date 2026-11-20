import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { forms } from './forms.js';
import { getRichMenuGroupWithPages, publishFormVersion } from '@line-crm/db';
import { assembleRichMenuGroupInput, richMenuLiveToSnapshot } from '../features/rich-menus/rich-menu-group-input.js';
import { validateRichMenuGroupForPublish } from '../lib/rich-menu-publisher.js';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { ACCOUNT_STYLES, DEFAULT_TENANT_ID, INITIAL_MENUS, RESTAURANT_GUIDE_MENU_IDS, RESTAURANT_GUIDE_MENUS, initialMenuBounds, initialMenuImageKey, initialMenuPng, validateFormForPublish } from '@line-crm/shared';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import { saveProfile, profile } from '../services/style-setup.js';
import { starterApplication, ensureStyleStarterItems } from '../services/style-starter-ensure.js';
import { initialMenuButtons } from '../services/style-initial-buttons.js';
import { savedStyleMenuPreview } from '../services/style-menu-preview.js';
import { starterDistributionPlan,distributeStarter } from '../services/style-starter-distribution.js';
import { standardStarter } from '../services/style-starter-definition.js';
import { starter } from '../services/style-starter-set.js';
import { resourceSnapshot } from '../services/style-starter-resource.js';
let f:ReturnType<typeof createTestD1>;
beforeEach(()=>{f=createTestD1();f.raw.pragma('foreign_keys=OFF');f.raw.prepare(`INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,liff_id,tenant_id) VALUES('a','a','a','fixture','fixture','liff-a',?),('b','b','b','fixture','fixture','liff-b',?)`).run(DEFAULT_TENANT_ID,DEFAULT_TENANT_ID)});
afterEach(()=>f.raw.close());
const choose=async(style:typeof ACCOUNT_STYLES[number])=>saveProfile(f.db,'a',DEFAULT_TENANT_ID,'owner',{expectedVersion:(await profile(f.db,'a'))?.version??0,style,answers:{image:{mode:'configured',value:'simple'}}});
const menu=()=>f.raw.prepare(`SELECT g.*,p.id page,p.image_r2_key FROM style_starter_items i JOIN rich_menu_groups g ON g.id=i.target_id JOIN rich_menu_pages p ON p.id=g.default_page_id WHERE i.line_account_id='a' AND i.kind='rich_menu' AND i.item_key='menu'`).get() as {id:string;status:string;page:string;image_r2_key:string};
const areas=()=>f.raw.prepare(`SELECT label,action_type,action_data,intent,form_id,bounds_x x,bounds_y y,bounds_width width,bounds_height height FROM rich_menu_areas WHERE page_id=? ORDER BY bounds_y,bounds_x`).all(menu().page) as Array<Record<string,unknown>>;

test.each(ACCOUNT_STYLES)('%sの4面は画像・座標・行き先が一致し、公開も送信も始まらない',async style=>{
 const images={head:vi.fn().mockResolvedValue(null),put:vi.fn().mockResolvedValue(null)};
 await saveProfile(f.db,'a',DEFAULT_TENANT_ID,'owner',{expectedVersion:0,style,answers:{image:{mode:'configured',value:'simple'}}},{images:images as unknown as R2Bucket});
 expect(menu()).toMatchObject({status:'draft',image_r2_key:initialMenuImageKey('a',style)});
 expect(areas().map(area=>area.label)).toEqual(INITIAL_MENUS[style].buttons.map(button=>button.label));
 areas().forEach((area,index)=>expect(area).toMatchObject(initialMenuBounds(index)));
 expect(images.put).toHaveBeenCalledWith(initialMenuImageKey('a',style),initialMenuPng(style),{httpMetadata:{contentType:'image/png'}});
 expect(f.raw.prepare('SELECT COUNT(*) n FROM forms WHERE is_active=1').get()).toEqual({n:0});
 expect(f.raw.prepare('SELECT COUNT(*) n FROM messages_log').get()).toEqual({n:0});
 const png=initialMenuPng(style);expect([...png.slice(0,8)]).toEqual([137,80,78,71,13,10,26,10]);
 const view=new DataView(png.buffer,png.byteOffset);expect([view.getUint32(16),view.getUint32(20)]).toEqual([2500,1686]);
 const ids=areas().map(area=>area.form_id).filter(Boolean);
 expect(ids.length).toBeGreaterThan(0);
 for(const id of ids)expect(f.raw.prepare('SELECT line_account_id FROM form_accounts WHERE form_id=?').get(id)).toEqual({line_account_id:'a'});
 const original=menu().id;await choose(style);expect(menu().id).toBe(original);expect(areas()).toHaveLength(4);
});

test.each(RESTAURANT_GUIDE_MENU_IDS)('%sを選ぶと図の面数と座標で下書きを作る', async preset => {
 const images={head:vi.fn().mockResolvedValue(null),put:vi.fn().mockResolvedValue(null)};
 f.raw.exec(`INSERT INTO rt_organizations(id,account_id,name) VALUES('org','a','本部');
   INSERT INTO rt_stores(id,organization_id,name,code,line_account_id) VALUES('store-a','org','A','a','a');`);
 await saveProfile(f.db,'a',DEFAULT_TENANT_ID,'owner',{
   expectedVersion:0,style:'restaurant',confirmInitialMenu:true,
   answers:{image:{mode:'configured',value:'simple'},restaurantMenuPreset:{mode:'configured',value:preset}},
 },{images:images as unknown as R2Bucket});
 const key=initialMenuImageKey('a','restaurant',preset);
 expect(menu()).toMatchObject({status:'draft',image_r2_key:key});
 const bounds=RESTAURANT_GUIDE_MENUS[preset].areas.map(({target,...area})=>area).sort((a,b)=>a.y-b.y||a.x-b.x);
 expect(areas()).toHaveLength(bounds.length);
 areas().forEach((area,index)=>expect(area).toMatchObject(bounds[index]));
 const token=(f.raw.prepare("SELECT token FROM rt_reservation_links WHERE store_id='store-a'").get() as {token:string}).token;
 const booking=areas().find(area=>area.label==='予約する')!;
 expect(booking.form_id).toBe(null);
 expect(JSON.parse(String(booking.action_data)).uri).toMatch(new RegExp(`page=restaurant&token=${token}$`));
 const [imageKey, bytes]=images.put.mock.calls[0] as unknown as [string, Uint8Array];
 expect(imageKey).toBe(key);
 const png=new DataView(bytes.buffer,bytes.byteOffset);
 expect([png.getUint32(16),png.getUint32(20)]).toEqual([2500,1686]);
 expect(f.raw.prepare('SELECT COUNT(*) n FROM messages_log').get()).toEqual({n:0});
});

test('席とLINEの入口が無い間も4面を詰め直さず、入れ直しは自分の店だけを補う',async()=>{
 await choose('restaurant');
 const before=menu();expect(JSON.parse(String(areas()[1]!.action_data)).uri).toBe('');
 f.raw.exec(`INSERT INTO rt_organizations(id,account_id,name) VALUES('org','a','本部');INSERT INTO rt_stores(id,organization_id,name,code,line_account_id) VALUES('store-b','org','B','b','b');`);
 expect((await initialMenuButtons(f.db,'a','restaurant'))[1]!.actionData).toBe('');
 f.raw.exec(`INSERT INTO rt_stores(id,organization_id,name,code,line_account_id) VALUES('store-a','org','A','a','a');`);
 const version=(await profile(f.db,'a'))!.version;
 const result=await ensureStyleStarterItems(f.db,'a',DEFAULT_TENANT_ID,'owner',{expectedVersion:version});
 expect(result.updated.length).toBeGreaterThan(0);expect(menu().id).toBe(before.id);
 const booking=JSON.parse((f.raw.prepare('SELECT layout FROM forms WHERE id=?').get(areas()[0]!.form_id) as {layout:string}).layout);
 expect(booking.sections[0].blocks[0].booking).toMatchObject({kind:'seats',storeId:'store-a'});
 expect(f.raw.prepare('SELECT COUNT(*) n FROM rt_reservation_links').get()).toEqual({n:0});
 await saveProfile(f.db,'a',DEFAULT_TENANT_ID,'owner',{expectedVersion:version,confirmInitialMenu:true,answers:{image:{mode:'configured',value:'simple'}}});
 const token=(f.raw.prepare("SELECT token FROM rt_reservation_links WHERE store_id='store-a'").get() as {token:string}).token;
 expect(areas()[1]!.action_data).toContain('token='+token);expect(areas()[1]!.action_data).toContain('view=mine');
 expect((await ensureStyleStarterItems(f.db,'a',DEFAULT_TENANT_ID,'owner',{expectedVersion:(await profile(f.db,'a'))!.version})).updated).toEqual([]);
});

test('読むだけでは初期行・予約リンク・画像を作らず、店が編集した下書きを保持する',async()=>{
 await choose('restaurant');const current=menu();
 f.raw.prepare("UPDATE rich_menu_areas SET label='店の言葉' WHERE page_id=? AND bounds_x=0 AND bounds_y=0").run(current.page);
 const snapshot=await resourceSnapshot(f.db,'a','rich_menu',current.id);
 const before=f.raw.prepare('SELECT total_changes() n').get();
 await starterApplication(f.db,'a',DEFAULT_TENANT_ID);
 expect(f.raw.prepare('SELECT total_changes() n').get()).toEqual(before);
 await ensureStyleStarterItems(f.db,'a',DEFAULT_TENANT_ID,'owner',{expectedVersion:(await profile(f.db,'a'))!.version});
 expect(await resourceSnapshot(f.db,'a','rich_menu',current.id)).toBe(snapshot);
});

test('他アカウントの既存メニューは再利用できず、同じ店の既存メニューは画像と操作を保つ',async()=>{
 await choose('standard');const original=menu();
 f.raw.prepare("UPDATE rich_menu_groups SET account_id='b' WHERE id=?").run(original.id);
 await expect(saveProfile(f.db,'a',DEFAULT_TENANT_ID,'owner',{expectedVersion:1,answers:{image:{mode:'configured',value:'keep'}},choices:{menu:{mode:'existing',resourceId:original.id}}})).rejects.toMatchObject({code:'resource_not_found'});
 f.raw.prepare("UPDATE rich_menu_groups SET account_id='a' WHERE id=?").run(original.id);
 const snapshot=await resourceSnapshot(f.db,'a','rich_menu',original.id);
 await saveProfile(f.db,'a',DEFAULT_TENANT_ID,'owner',{expectedVersion:1,answers:{image:{mode:'configured',value:'keep'}},choices:{menu:{mode:'existing',resourceId:original.id}}});
 expect(await resourceSnapshot(f.db,'a','rich_menu',original.id)).toBe(snapshot);
});


test('保存した4面を本番の公開用読取へ渡し、未公開と他店フォームを止める',async()=>{
 await choose('standard');
 const live=await getRichMenuGroupWithPages(f.db,menu().id);expect(live).not.toBeNull();
 const snapshot=richMenuLiveToSnapshot(live!);
 const assemble=()=>assembleRichMenuGroupInput(f.db,snapshot,{liff_id:'liff-a'},{fallbackGroupId:menu().id});
 await expect(assemble()).rejects.toThrow('フォーム');
 for(const row of f.raw.prepare('SELECT id,content_revision FROM forms').all() as Array<{id:string;content_revision:number}>)expect((await publishFormVersion(f.db,row.id,row.content_revision)).kind).toBe('published');
 await expect(assemble()).rejects.toThrow('見本');
 f.raw.prepare('UPDATE forms SET layout=replace(layout,?,?)').run('入力してください。','店のご案内です。');
 f.raw.prepare('UPDATE forms SET layout=replace(layout,?,?)').run('ご案内してください。','店のご案内です。');
 // 下書きだけ編集しても、お客さまが開く公開版を確認するまで通さない。
 await expect(assemble()).rejects.toThrow('見本');
 f.raw.exec('UPDATE forms SET content_revision=content_revision+1');
 for(const row of f.raw.prepare('SELECT id,content_revision FROM forms').all() as Array<{id:string;content_revision:number}>)await publishFormVersion(f.db,row.id,row.content_revision);
 const input=await assemble();expect(input.pages[0]!.areas).toHaveLength(4);
 expect(input.pages[0]!.areas.every(area=>typeof area.actionData.uri==='string')).toBe(true);
 expect(()=>validateRichMenuGroupForPublish(input)).not.toThrow();
 const id=String(areas()[0]!.form_id);f.raw.prepare("UPDATE form_accounts SET line_account_id='b' WHERE form_id=?").run(id);
 await expect(assemble()).rejects.toThrow('フォーム');
 const legacy=structuredClone(snapshot);legacy.pages![0]!.areas[0]!.formId=null;legacy.pages![0]!.areas[0]!.intent='form';legacy.pages![0]!.areas[0]!.actionData={formId:id};
 await expect(assembleRichMenuGroupInput(f.db,legacy,{liff_id:'liff-a'},{fallbackGroupId:menu().id})).rejects.toThrow('フォーム');
});

test('古い版で保存が競合したら予約リンクとフォームを一緒に残さない',async()=>{
 await choose('restaurant');f.raw.exec("INSERT INTO rt_organizations(id,account_id,name) VALUES('org','a','本部');INSERT INTO rt_stores(id,organization_id,name,code,line_account_id) VALUES('store-a','org','A','a','a');");
 await expect(saveProfile(f.db,'a',DEFAULT_TENANT_ID,'owner',{expectedVersion:0,answers:{image:{mode:'configured',value:'simple'}}})).rejects.toMatchObject({code:'version_conflict'});
 expect(f.raw.prepare('SELECT COUNT(*) n FROM rt_reservation_links').get()).toEqual({n:0});
});


test('店舗が未確定の席予約フォームは公開前の共通検査を通らない',async()=>{
 await choose('restaurant');
 const row=f.raw.prepare('SELECT layout FROM forms WHERE id=?').get(areas()[0]!.form_id) as {layout:string};
 expect(validateFormForPublish(JSON.parse(row.layout))).toContain('お店が選ばれていません');
 const formId=String(areas()[0]!.form_id);
 const app=new Hono<Env>();app.use('*',async(c,next)=>{c.set('staff',{id:'owner',name:'担当',role:'owner',tenantId:DEFAULT_TENANT_ID} as Env['Variables']['staff']);await next()});app.route('/',forms);
 const response=await app.request(`/api/forms/${formId}/publish?account_id=a`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedContentRevision:1})},{DB:f.db} as Env['Bindings']);
 expect(response.status).toBe(400);expect(await response.text()).toContain('お店が選ばれていません');
 expect(f.raw.prepare('SELECT is_active FROM forms WHERE id=?').get(formId)).toEqual({is_active:0});
});


test('明示保存の同時二重押しは1つの予約リンクと監査に収束し、既存の合言葉を再利用する',async()=>{
 f.raw.exec("INSERT INTO rt_organizations(id,account_id,name) VALUES('org','a','本部');INSERT INTO rt_stores(id,organization_id,name,code,line_account_id) VALUES('store-a','org','A','a','a');");
 const input={expectedVersion:0,style:'restaurant',confirmInitialMenu:true,answers:{image:{mode:'configured',value:'simple'}}};
 const results=await Promise.allSettled([saveProfile(f.db,'a',DEFAULT_TENANT_ID,'owner',input),saveProfile(f.db,'a',DEFAULT_TENANT_ID,'owner',input)]);
 expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
 expect(f.raw.prepare('SELECT COUNT(*) n FROM rt_reservation_links').get()).toEqual({n:1});
 expect(f.raw.prepare("SELECT COUNT(*) n FROM style_change_logs WHERE action='initial_menu.history_link.created'").get()).toEqual({n:1});
 const before=f.raw.prepare('SELECT * FROM rt_reservation_links').all();
 await saveProfile(f.db,'a',DEFAULT_TENANT_ID,'owner',{...input,expectedVersion:1});
 expect(f.raw.prepare('SELECT * FROM rt_reservation_links').all()).toEqual(before);
 expect(f.raw.prepare("SELECT COUNT(*) n FROM style_change_logs WHERE action='initial_menu.history_link.created'").get()).toEqual({n:1});
});


test('同じアカウントに誤って他統括の店舗がつながっても予約リンクを作らない',async()=>{
 f.raw.exec("INSERT INTO rt_organizations(id,account_id,tenant_id,name) VALUES('foreign','foreign','other-tenant','他統括');INSERT INTO rt_stores(id,organization_id,name,code,line_account_id) VALUES('foreign-store','foreign','他店','f','a');");
 await saveProfile(f.db,'a',DEFAULT_TENANT_ID,'owner',{expectedVersion:0,style:'restaurant',confirmInitialMenu:true,answers:{image:{mode:'configured',value:'simple'}}});
 expect(f.raw.prepare('SELECT COUNT(*) n FROM rt_reservation_links').get()).toEqual({n:0});
});


test('公開前に削除した案内も、明示的に選び直すと店の既存内容を残した別の下書きになる',async()=>{
 await choose('standard');const old=String(areas()[0]!.form_id);
 f.raw.prepare("UPDATE forms SET status='archived' WHERE id=?").run(old);
 await choose('standard');
 expect(String(areas()[0]!.form_id)).not.toBe(old);
 expect(f.raw.prepare('SELECT status FROM forms WHERE id=?').get(old)).toEqual({status:'archived'});
});


test('案内の公開版が空なら、4面メニューの公開を止める',async()=>{
 await choose('standard');
 for(const row of f.raw.prepare('SELECT id,content_revision FROM forms').all() as Array<{id:string;content_revision:number}>) {
  f.raw.prepare('UPDATE forms SET layout=? WHERE id=?').run(JSON.stringify({header:[],sections:[{id:'section',blocks:[]}]}),row.id);
  await publishFormVersion(f.db,row.id,row.content_revision);
 }
 const live=await getRichMenuGroupWithPages(f.db,menu().id);
 await expect(assembleRichMenuGroupInput(f.db,richMenuLiveToSnapshot(live!),{liff_id:'liff-a'},{fallbackGroupId:menu().id})).rejects.toThrow('お店の内容');
});

test('保存済みメニューの絵・ボタン・座標を、スタイルの見本に戻さず読む',async()=>{
 await choose('standard');const current=menu();
 f.raw.prepare("UPDATE rich_menu_areas SET label='お店のボタン',action_data=? WHERE page_id=? AND bounds_x=0 AND bounds_y=0").run(JSON.stringify({uri:'https://example.com/shop'}),current.page);
 f.raw.prepare("UPDATE rich_menu_pages SET image_r2_key='shop/custom.png' WHERE id=?").run(current.page);
 const definition=(await starter(f.db,DEFAULT_TENANT_ID,'standard',true)).definition.items.find(item=>item.kind==='rich_menu')!;
 const before=f.raw.prepare('SELECT total_changes() n').get();
 const preview=await savedStyleMenuPreview(f.db,'a','standard',definition);
 expect(preview).toMatchObject({targetId:current.id,imageR2Key:'shop/custom.png'});
 expect(preview!.buttons[0]).toMatchObject({label:'お店のボタン',actionData:'https://example.com/shop',bounds:initialMenuBounds(0)});
 expect(f.raw.prepare('SELECT total_changes() n').get()).toEqual(before);
 f.raw.prepare("UPDATE rich_menu_areas SET action_type='postback',action_data=? WHERE page_id=? AND bounds_x=0 AND bounds_y=0").run(JSON.stringify({data:'shop-action',displayText:'店の操作'}),current.page);
 const beforeAction=f.raw.prepare('SELECT total_changes() n').get();
 const action=await savedStyleMenuPreview(f.db,'a','standard',definition);
 expect(JSON.parse(action!.buttons[0]!.actionData)).toEqual({data:'shop-action',displayText:'店の操作'});
 expect(action!.buttons[0]).toMatchObject({actionType:'postback',destination:'保存済みのボタンの操作'});
 expect(await savedStyleMenuPreview(f.db,'b','standard',definition)).toBeNull();
 expect(f.raw.prepare('SELECT total_changes() n').get()).toEqual(beforeAction);
});


test('案内の公開版に画像だけを置いた店も、空のページと誤判定しない',async()=>{
 await choose('standard');
 for(const row of f.raw.prepare('SELECT f.id,f.content_revision,i.item_key FROM forms f JOIN style_starter_items i ON i.target_id=f.id WHERE i.kind=\'form\'').all() as Array<{id:string;content_revision:number;item_key:string}>) {
  if(row.item_key.endsWith('-news')||row.item_key.endsWith('-guide'))f.raw.prepare('UPDATE forms SET layout=? WHERE id=?').run(JSON.stringify({version:2,header:[],sections:[{id:'main',blocks:[{id:'photo',kind:'image',mediaUrl:'https://example.test/store.png'}]}]}),row.id);
  await publishFormVersion(f.db,row.id,row.content_revision);
 }
 const live=await getRichMenuGroupWithPages(f.db,menu().id);
 await expect(assembleRichMenuGroupInput(f.db,richMenuLiveToSnapshot(live!),{liff_id:'liff-a'},{fallbackGroupId:menu().id})).resolves.toMatchObject({id:menu().id});
});


test('読む間に店舗の所属が変わったら、古い店のフォームと予約リンクを保存しない',async()=>{
 f.raw.exec("INSERT INTO rt_organizations(id,account_id,name) VALUES('org','a','本部');INSERT INTO rt_stores(id,organization_id,name,code,line_account_id) VALUES('store-a','org','A','a','a');");
 const racing={prepare:(query:string)=>f.db.prepare(query),batch:async(statements:D1PreparedStatement[])=>{
  f.raw.exec("UPDATE rt_stores SET line_account_id='b' WHERE id='store-a';");
  return f.db.batch(statements);
 }} as unknown as D1Database;
 await expect(saveProfile(racing,'a',DEFAULT_TENANT_ID,'owner',{expectedVersion:0,style:'restaurant',confirmInitialMenu:true,answers:{image:{mode:'configured',value:'simple'}}})).rejects.toMatchObject({code:'version_conflict'});
 expect(f.raw.prepare('SELECT COUNT(*) n FROM forms').get()).toEqual({n:0});
 expect(f.raw.prepare('SELECT COUNT(*) n FROM rt_reservation_links').get()).toEqual({n:0});
 expect(f.raw.prepare('SELECT COUNT(*) n FROM rich_menu_groups').get()).toEqual({n:0});
});


test('本部からメニューとカードを一緒に更新しても、メニューの選択と版を保存する',async()=>{
 await choose('standard');
 const current=menu(),before=(await profile(f.db,'a'))!.version;
 f.raw.exec(`UPDATE account_styles SET answers_json=json_set(answers_json,'$.image',json('{"mode":"configured","value":"keep"}')) WHERE line_account_id='a'`);
 const definition={items:[{key:'menu',kind:'rich_menu',name:'本部の案内',buttons:[{label:'本部の案内',feature:'booking',actionType:'uri',actionData:'https://example.test/info'}]},standardStarter('standard').items.find(item=>item.kind==='dashboard')!]};
 f.raw.prepare("INSERT INTO style_starter_sets(id,tenant_id,style,name,definition_json,updated_at) VALUES('hq-set',?,'standard','本部',?,'now')").run(DEFAULT_TENANT_ID,JSON.stringify(definition));
 const input={expectedVersion:1,target:{accountIds:['a']}};
 const plan=await starterDistributionPlan(f.db,DEFAULT_TENANT_ID,'standard',input);
 await distributeStarter(f.db,DEFAULT_TENANT_ID,'owner','standard',{...input,confirmed:true,token:plan.token});
 const saved=(await profile(f.db,'a'))!;
 expect(JSON.parse(saved.answers_json).image).toEqual({mode:'configured',value:'existing',resourceId:current.id});
 expect(saved.version).toBe(before+2);
 expect(menu().id).toBe(current.id);
});
