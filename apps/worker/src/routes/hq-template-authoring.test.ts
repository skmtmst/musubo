import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import type { Env } from '../worker-env.js';
import { hqTemplates } from './hq-templates.js';
import { liffActionFromUrl } from '@line-crm/shared';
// Web の実際の純粋な編集関数で作った入力を、実 HTTP と SQLite の実行へ通す。
const webAuthoringPath = new URL('../../../web/src/lib/hq-template-authoring.ts', import.meta.url).href;
const { freshDefinition, withUploadedImage, withMessageCard } = await import(/* @vite-ignore */ webAuthoringPath);
type MessageTemplateDefinition = import('../services/hq-templates/template.js').MessageTemplateDefinition;
type RichMenuDefinition = { richMenu: { name: string; pages: { imageR2Key: string }[] } };

let sql: ReturnType<typeof createTestD1>, app: Hono<Env>, staff: any;
let objects: Map<string, any>, bucket: any, workerUrl: string | undefined;
function png(width = 2500, height = 1686) {
  const bytes = new Uint8Array(32); bytes.set([137,80,78,71,13,10,26,10]);
  new DataView(bytes.buffer).setUint32(16, width); new DataView(bytes.buffer).setUint32(20, height); return bytes;
}
async function request(path: string, method = 'GET', body?: unknown) {
  const res = await app.request(`https://worker.test/api/hq/templates${path}`, {method, headers:{'Content-Type':'application/json'}, body:body === undefined ? undefined:JSON.stringify(body)}, {DB:sql.db,IMAGES:bucket,WORKER_URL:workerUrl} as Env['Bindings']);
  return {status:res.status,body:await res.json() as any};
}
async function upload(purpose = 'message', bytes = png(), filename = 'test.png', expected?: { width: number; height: number }) {
  const size = expected ? `&width=${expected.width}&height=${expected.height}` : '';
  const res = await app.request(`https://worker.test/api/hq/templates/media?purpose=${purpose}&filename=${encodeURIComponent(filename)}${size}`, {method:'POST',headers:{'Content-Type':'image/png'},body:bytes}, {DB:sql.db,IMAGES:bucket,WORKER_URL:workerUrl} as Env['Bindings']);
  return {status:res.status,body:await res.json() as any};
}
async function uploadRawWidth(filename: string, width: string, height: string) {
  const res = await app.request(`https://worker.test/api/hq/templates/media?purpose=rich_menu&filename=${encodeURIComponent(filename)}&width=${width}&height=${height}`, {method:'POST',headers:{'Content-Type':'image/png'},body:png(2500,1686)}, {DB:sql.db,IMAGES:bucket,WORKER_URL:workerUrl} as Env['Bindings']);
  return {status:res.status,body:await res.json() as any};
}
async function removeMedia(r2Key: string) {
  const res = await app.request(`https://worker.test/api/hq/templates/media?r2Key=${encodeURIComponent(r2Key)}`, {method:'DELETE'}, {DB:sql.db,IMAGES:bucket,WORKER_URL:workerUrl} as Env['Bindings']);
  return {status:res.status,body:await res.json() as any};
}
async function save(type: string, definition: unknown) {
  const r=await request('','POST',{type,name:'新規ひな形',definition,requestId:crypto.randomUUID()});expect(r.status,JSON.stringify(r.body)).toBe(201);return r.body.data.template.id as string;
}
async function distribute(id: string) {
  const p=await request(`/${id}/preflight`,'POST',{accountIds:['a','b','c']});expect(p.status,JSON.stringify(p.body)).toBe(200);
  const body={preflightId:p.body.data.preflightId,resolutions:p.body.data.stores.flatMap((s:any)=>s.items.map((i:any)=>({accountId:s.accountId,sourceId:i.sourceId,mode:i.duplicate?'overwrite':'create'})))};
  const r=await request(`/${id}/distribute`,'POST',body);expect(r.status,JSON.stringify(r.body)).toBe(200);expect(r.body.data.stores.map((s:any)=>s.status)).toEqual(['succeeded','succeeded','succeeded']);
  return body;
}
beforeEach(()=>{
  workerUrl='https://worker.test';
  sql=createTestD1({foreignKeys:true});sql.raw.exec("INSERT INTO tenants(id,name) VALUES('tenant','HQ'),('other','Other')");
  for(const id of ['a','b','c']) sql.raw.prepare("INSERT INTO line_accounts(id,name,channel_id,channel_access_token,channel_secret,tenant_id) VALUES(?,?,?,'fixture','fixture','tenant')").run(id,id,id);
  sql.raw.exec("INSERT INTO staff_members(id,name,role,api_key,tenant_id) VALUES('owner','Owner','owner','fixture','tenant')");
  staff={id:'owner',name:'Owner',role:'owner',tenantId:'tenant',readOnly:false};objects=new Map();
  bucket={head:vi.fn(async(key:string)=>objects.get(key)??null),get:vi.fn(async(key:string,opts:any)=>{const o=objects.get(key);if(!o)return null;if(opts?.onlyIf?.etagMatches&&opts.onlyIf.etagMatches!==o.etag)return o;return {...o,body:new ReadableStream({start(c){c.enqueue(o.bytes.slice());c.close()}}),arrayBuffer:async()=>o.bytes.slice().buffer}}),put:vi.fn(async(key:string,bytes:Uint8Array,options:any)=>{if(objects.has(key))return null;const o={key,bytes:bytes.slice(),size:bytes.length,etag:`e${objects.size}`,customMetadata:options.customMetadata,httpMetadata:options.httpMetadata};objects.set(key,o);return o}),delete:vi.fn(async(key:string)=>{objects.delete(key)})};
  app=new Hono<Env>();app.use('*',async(c,next)=>{c.set('staff',staff);await next()});app.route('/',hqTemplates);
});
afterEach(()=>sql.raw.close());
describe('HQ authoring Web payload to HTTP/SQLite/R2 distribution',()=>{
  function referencedCard() {
    for (const account of ['a','b','c']) {
      sql.raw.prepare("UPDATE line_accounts SET liff_id=? WHERE id=?").run(`liff-${account}`,account);
      sql.raw.prepare("INSERT INTO scenarios(id,name,trigger_type,line_account_id) VALUES (?,'案内','manual',?)").run(`scenario-${account}`,account);
      sql.raw.prepare("INSERT INTO forms(id,name,fields) VALUES (?,'回答','[]')").run(`form-${account}`);
      sql.raw.prepare('INSERT INTO form_accounts(form_id,line_account_id) VALUES (?,?)').run(`form-${account}`,account);
    }
    const value=freshDefinition('template') as MessageTemplateDefinition;
    (value.template as any).name='案内';
    return withMessageCard(value,{format:'flex',title:'タイトル',body:'scenario-a',buttons:[{id:'form',label:'回答する',action:'form',value:'form-a'},{id:'scenario',label:'始める',action:'scenario',value:'scenario-a'}]});
  }
  test.each([
    ['url', 'https://example.com'], ['message', '予約したい'], ['booking', ''],
    ['booking_history', ''], ['form', 'form-a'], ['visit_stamp', ''],
    ['booking', 'menu-a'], ['visit_stamp', 'card-a'],
  ])('6つの動きと選択先ありをHTTPで保存・3店舗へ配布・読み戻す: %s %s', async (action, value) => {
    const source = referencedCard();
    for (const account of ['a', 'b', 'c']) {
      sql.raw.prepare('INSERT INTO menus(id,line_account_id,name,duration_minutes,base_price) VALUES (?,?,?,30,0)').run(`menu-${account}`, account, '相談');
      sql.raw.prepare("INSERT INTO visit_stamp_cards(id,tenant_id,name,settings_json) VALUES (?,'tenant','来店','{}')").run(`card-${account}`);
      sql.raw.prepare('INSERT INTO visit_stamp_card_accounts(card_id,line_account_id) VALUES (?,?)').run(`card-${account}`, account);
    }
    const definition = withMessageCard(source, { format: 'flex', title: '案内', body: '本文', buttons: [{ id: 'one', label: '開く', action, value }] });
    const id = await save('template', definition);
    expect((await request(`/${id}`)).body.data.definition.card.buttons[0]).toMatchObject({ action, value });
    await distribute(id);
    for (const account of ['a', 'b', 'c']) {
      const row = sql.raw.prepare('SELECT message_content FROM templates WHERE line_account_id=?').get(account) as { message_content: string };
      const button = JSON.parse(row.message_content).footer.contents[0].action;
      expect(button.type).toBe(action === 'message' ? 'message' : 'uri');
      if (['booking', 'booking_history', 'form', 'visit_stamp'].includes(action)) {
        expect(button.uri).toContain(`https://liff.line.me/liff-${account}/`);
        expect(liffActionFromUrl(button.uri)?.kind).toBe(action);
        if (action === 'booking' && value) expect(liffActionFromUrl(button.uri)).toEqual({ kind: action, menuId: `menu-${account}` });
        if (action === 'visit_stamp' && value) expect(liffActionFromUrl(button.uri)).toEqual({ kind: action, cardId: `card-${account}` });
      }
    }
  });
  test('LIFFが無い理由をHTTPで具体的に返す', async () => {
    const source = referencedCard();
    const definition = withMessageCard(source, { format: 'flex', title: '案内', body: '本文', buttons: [{ id: 'one', label: '予約', action: 'booking', value: '' }] });
    const id = await save('template', definition);
    sql.raw.exec("UPDATE line_accounts SET liff_id=NULL WHERE id='b'");
    const result = await request(`/${id}/preflight`, 'POST', { accountIds: ['b'] });
    expect(result.status).toBe(409); expect(result.body.code).toBe('LIFF_UNAVAILABLE');
    expect(result.body.error).toContain('LIFFが設定されていません');
  });
  test('one save preserves title/body/buttons and maps references and postbacks per destination',async()=>{
    const value=referencedCard(),id=await save('template',value);
    const saved=await request(`/${id}`);expect(saved.body.data.definition.card).toEqual(value.card);
    const body=await distribute(id);
    const rows=sql.raw.prepare('SELECT id,line_account_id,message_content,carousel_actions_json FROM templates ORDER BY line_account_id').all() as any[];
    for(const row of rows) {
      const bubble=JSON.parse(row.message_content),account=row.line_account_id;
      expect(bubble.body.contents.map((item:any)=>item.text)).toEqual(['タイトル','scenario-a']);
      expect(bubble.footer.contents[0].action.uri).toBe(`https://liff.line.me/liff-${account}/?page=form&id=form-${account}`);
      expect(bubble.footer.contents[1].action.data).toBe(`ctpl=${row.id}&c=0&a=1`);
      expect(JSON.parse(row.carousel_actions_json)[0][1][0].config).toEqual({op:'start',scenarioId:`scenario-${account}`});
    }
    await request(`/${id}/distribute`,'POST',body);expect(sql.raw.prepare('SELECT count(*) n FROM templates').get()).toEqual({n:3});
    expect(sql.raw.pragma('foreign_key_check')).toEqual([]);
  });
  test.each(['missing','ambiguous','foreign','liff','shared-form'])('preflight stops %s references before destination writes',async mode=>{
    const value=referencedCard();
    if(mode==='missing')sql.raw.exec("DELETE FROM scenarios WHERE id='scenario-b'");
    if(mode==='ambiguous')sql.raw.exec("INSERT INTO scenarios(id,name,trigger_type,line_account_id) VALUES ('duplicate','案内','manual','b')");
    if(mode==='foreign'){sql.raw.exec("UPDATE line_accounts SET tenant_id='other' WHERE id='a'");}
    if(mode==='liff')sql.raw.exec("UPDATE line_accounts SET liff_id=NULL WHERE id='b'");
    if(mode==='shared-form')sql.raw.exec("INSERT INTO form_accounts(form_id,line_account_id) VALUES ('form-b','c')");
    const id=await save('template',value),p=await request(`/${id}/preflight`,'POST',{accountIds:['b']});expect(p.status,JSON.stringify(p.body)).toBe(409);
    expect(sql.raw.prepare('SELECT count(*) n FROM templates').get()).toEqual({n:0});
  });
  test.each(['source','target','liff','ownership'])('changed %s reference requires new preflight',async mode=>{
    const id=await save('template',referencedCard()),p=await request(`/${id}/preflight`,'POST',{accountIds:['b']});expect(p.status).toBe(200);
    if(mode==='source')sql.raw.exec("UPDATE scenarios SET description='changed' WHERE id='scenario-a'");
    if(mode==='target')sql.raw.exec("UPDATE forms SET content_revision=content_revision+1 WHERE id='form-b'");
    if(mode==='liff')sql.raw.exec("UPDATE line_accounts SET liff_id='changed' WHERE id='b'");
    if(mode==='ownership')sql.raw.exec("INSERT INTO form_accounts(form_id,line_account_id) VALUES ('form-b','c')");
    const result=await request(`/${id}/distribute`,'POST',{preflightId:p.body.data.preflightId,resolutions:p.body.data.stores[0].items.map((item:any)=>({accountId:'b',sourceId:item.sourceId,mode:'create'}))});
    expect(result.body.data.stores[0].status).toBe('version_conflict');
    expect(sql.raw.prepare('SELECT count(*) n FROM templates').get()).toEqual({n:0});
  });
  test('reference candidates respect authority and tenant boundaries',async()=>{
    referencedCard();sql.raw.exec("UPDATE line_accounts SET tenant_id='other' WHERE id='c'");
    const rows=await request('/message-references');expect(rows.status).toBe(200);
    expect(rows.body.data.map((row:any)=>row.id).sort()).toEqual(['form-a','form-b','scenario-a','scenario-b']);
    staff.readOnly=true;expect((await request('/message-references')).status).toBe(200);
  });
  test('card composition is authoritative over stale raw body and copies its uploaded hero image',async()=>{
    const uploaded=await upload();expect(uploaded.status).toBe(201);
    const draft=freshDefinition('template');draft.template.name='案内';
    const value=withMessageCard(withUploadedImage(draft,uploaded.body.data),{format:'flex',title:'写真つき',body:'本文',imageMediaId:uploaded.body.data.id,buttons:[{id:'url',label:'開く',action:'url',value:'https://example.com'}]});
    value.template.messageContent='stale';
    const id=await save('template',value),saved=await request(`/${id}`);expect(saved.body.data.definition.template.messageContent).toContain('写真つき');
    await distribute(id);
    const rows=sql.raw.prepare('SELECT message_content,line_account_id FROM templates').all() as any[];
    for(const row of rows)expect(JSON.parse(row.message_content).hero.url).toMatch(new RegExp(`^https://worker.test/images/media/${row.line_account_id}/`));
    expect(rows.every(row=>!row.message_content.includes('hq-templates/'))).toBe(true);
  });
  test('text card accepts a confirmed per-account rewrite without recomposing original text',async()=>{
    const draft=freshDefinition('template');draft.template.name='案内';
    const value=withMessageCard(draft,{format:'text',title:'題',body:'原本',buttons:[]}),id=await save('template',value);
    const p=await request(`/${id}/preflight`,'POST',{accountIds:['b'],textOverrides:[{accountId:'b',text:'配布先の文面'}]});expect(p.status).toBe(200);
    const r=await request(`/${id}/distribute`,'POST',{preflightId:p.body.data.preflightId,resolutions:p.body.data.stores[0].items.map((item:any)=>({accountId:'b',sourceId:item.sourceId,mode:'create'}))});expect(r.body.data.stores[0].status).toBe('succeeded');
    expect(sql.raw.prepare('SELECT message_content FROM templates').get()).toEqual({message_content:'配布先の文面'});
  });
  test('new text needs no source account template and reaches all three stores',async()=>{
    const value=freshDefinition('template') as MessageTemplateDefinition;(value.template as any).name='ご案内';(value.template as any).messageContent='新しい本文';
    expect(sql.raw.prepare('SELECT count(*) n FROM templates').get()).toEqual({n:0});
    const id=await save('template',value),body=await distribute(id);
    await request(`/${id}/distribute`,'POST',body);expect(sql.raw.prepare('SELECT count(*) n FROM templates').get()).toEqual({n:3});expect(bucket.put).not.toHaveBeenCalled();
    await distribute(id);expect(sql.raw.prepare('SELECT count(*) n FROM templates').get()).toEqual({n:3});
  });
  test('uploaded Web image becomes three independent destination media URLs',async()=>{
    const uploaded=await upload();expect(uploaded.status).toBe(201);
    let value=freshDefinition('template') as MessageTemplateDefinition;(value.template as any).name='画像';(value.template as any).messageType='image';value=withUploadedImage(value,uploaded.body.data);
    const id=await save('template',value);await distribute(id);
    const rows=sql.raw.prepare('SELECT t.message_content,m.r2_key,m.public_url,t.line_account_id FROM templates t JOIN media m ON m.line_account_id=t.line_account_id').all() as any[];
    expect(rows).toHaveLength(3);for(const row of rows){expect(row.r2_key).toMatch(new RegExp(`^media/${row.line_account_id}/hq/`));expect(row.message_content).toBe(row.public_url);expect(objects.get(row.r2_key).bytes).toEqual(png())}
    expect(sql.raw.pragma('foreign_key_check')).toEqual([]);
  });
  test('existing request origin is sufficient without adding a WORKER_URL setting',async()=>{
    workerUrl=undefined;const uploaded=await upload();expect(uploaded.status).toBe(201);
    let value=freshDefinition('template') as MessageTemplateDefinition;(value.template as any).name='画像';(value.template as any).messageType='image';value=withUploadedImage(value,uploaded.body.data);
    await distribute(await save('template',value));
  });
  test('rich menu upload supports actual three-store draft and null LINE ID',async()=>{
    const uploaded=await upload('rich_menu');expect(uploaded.status).toBe(201);
    const value=freshDefinition('rich_menu') as any;value.richMenu.name='メニュー';value.richMenu.displayOrder=7;value.richMenu.displayAudience='all';value.richMenu.pages[0].imageR2Key=uploaded.body.data.r2Key;
    value.richMenu.pages[0].areas.push({id:'main-area',bounds:{x:0,y:0,width:100,height:100},actionType:'message',actionData:{text:'案内'},intent:'text',label:'案内'});
    const id=await save('rich_menu',value);await distribute(id);
    const rows=sql.raw.prepare('SELECT g.id,g.status,g.account_id,g.display_order,g.is_default_for_all,p.image_r2_key,p.line_richmenu_id FROM rich_menu_groups g JOIN rich_menu_pages p ON p.group_id=g.id').all() as any[];
    expect(rows).toHaveLength(3);for(const row of rows){expect(row.status).toBe('draft');expect(row.line_richmenu_id).toBeNull();expect(row.image_r2_key).toMatch(new RegExp(`^rich-menus/${row.account_id}/hq/`))}
    for(const row of rows){
      expect(row).toMatchObject({display_order:7,is_default_for_all:1});
      sql.raw.prepare('INSERT INTO rich_menu_area_taps(id,group_id,page_id,area_id,line_account_id) VALUES(?,?,?,?,?)').run(`tap-${row.account_id}`,row.id,'page','main-area',row.account_id);
    }
    const list=await request('?type=rich_menu');
    expect(list.body.data.find((item:any)=>item.id===id)).toMatchObject({display_order:7,display_audience:'全員',tap_count:3});
    await distribute(id);
    expect((await request('?type=rich_menu')).body.data.find((item:any)=>item.id===id).tap_count).toBe(3);
    sql.raw.exec("UPDATE line_accounts SET tenant_id='other' WHERE id='c'");
    expect((await request('?type=rich_menu')).body.data.find((item:any)=>item.id===id).tap_count).toBe(2);
  });
  test('rich menu distribution persists reference choices and rejects a changed destination revision',async()=>{
    const uploaded=await upload('rich_menu');expect(uploaded.status).toBe(201);
    sql.raw.exec("INSERT INTO tags(id,name,line_account_id) VALUES ('source-tag','会員','a'),('target-b','会員','b'),('target-c','会員','c')");
    sql.raw.exec("UPDATE tags SET color='#123456' WHERE id='source-tag'; UPDATE tags SET color='#abcdef' WHERE id='target-c'");
    const value=freshDefinition('rich_menu') as any;value.richMenu.name='参照メニュー';value.richMenu.pages[0].imageR2Key=uploaded.body.data.r2Key;
    value.richMenu.pages[0].areas.push({id:'tag-area',bounds:{x:0,y:0,width:100,height:100},actionType:'message',actionData:{text:'会員'},intent:'text',label:'会員',tagIds:['source-tag']});
    const id=await save('rich_menu',value),p=await request(`/${id}/preflight`,'POST',{accountIds:['a','b','c']});expect(p.status,JSON.stringify(p.body)).toBe(200);
    for(const store of p.body.data.stores) {
      const item=store.items.find((candidate:any)=>candidate.sourceId==='tag:source-tag');
      expect(item).toMatchObject({itemKind:'tag',duplicate:true,operation:'reuse',allowedModes:['overwrite']});
      expect(item.targetId).toBe(store.accountId==='a'?'source-tag':`target-${store.accountId}`);
      expect(item.expectedRevision).toMatch(/^\[/);
    }
    sql.raw.exec("UPDATE tags SET version=version+1 WHERE id='target-b'");
    const body={preflightId:p.body.data.preflightId,resolutions:p.body.data.stores.flatMap((store:any)=>store.items.map((item:any)=>({accountId:store.accountId,sourceId:item.sourceId,mode:item.duplicate?'overwrite':'create'})))};
    const result=await request(`/${id}/distribute`,'POST',body);expect(result.status,JSON.stringify(result.body)).toBe(200);
    expect(result.body.data.status).toBe('partial');
    expect(result.body.data.stores.map((store:any)=>store.status)).toEqual(['succeeded','version_conflict','succeeded']);
    expect(result.body.data.stores[0].counts).toEqual({created:1,overwritten:0,aliased:0,reused:1});
    expect(result.body.data.stores[2].counts).toEqual({created:1,overwritten:0,aliased:0,reused:1});
    expect(sql.raw.prepare("SELECT color FROM tags WHERE id='target-c'").get()).toEqual({color:'#abcdef'});
    expect(result.body.data.stores[1].reason).toBe('配布先で編集がありました。もう一度確認してください');
    expect(sql.raw.prepare("SELECT account_id FROM rich_menu_groups ORDER BY account_id").all()).toEqual([{account_id:'a'},{account_id:'c'}]);
  });
  test('rich menu preflight fixes missing reference creation and reports created dependencies',async()=>{
    const uploaded=await upload('rich_menu');expect(uploaded.status).toBe(201);
    sql.raw.exec("INSERT INTO tags(id,name,line_account_id) VALUES ('source-tag','会員','a')");
    const value=freshDefinition('rich_menu') as any;value.richMenu.name='参照複製メニュー';value.richMenu.pages[0].imageR2Key=uploaded.body.data.r2Key;
    value.richMenu.pages[0].areas.push({id:'tag-area',bounds:{x:0,y:0,width:100,height:100},actionType:'message',actionData:{text:'会員'},intent:'text',label:'会員',tagIds:['source-tag']});
    const id=await save('rich_menu',value),p=await request(`/${id}/preflight`,'POST',{accountIds:['a','b','c']});expect(p.status,JSON.stringify(p.body)).toBe(200);
    for(const store of p.body.data.stores) {
      const item=store.items.find((candidate:any)=>candidate.sourceId==='tag:source-tag');
      expect(item).toMatchObject(store.accountId==='a'
        ? {itemKind:'tag',duplicate:true,operation:'reuse',allowedModes:['overwrite'],targetId:'source-tag'}
        : {itemKind:'tag',duplicate:false,operation:'create',allowedModes:['create']});
      const persisted=sql.raw.prepare('SELECT resolution_mode,target_id,expected_revision FROM hq_template_preflight_resolutions WHERE target_account_id=? AND source_id=?').get(store.accountId,'tag:source-tag') as any;
      expect(persisted).toEqual({resolution_mode:store.accountId==='a'?'overwrite':'create',target_id:item.targetId,expected_revision:item.expectedRevision});
    }
    const body={preflightId:p.body.data.preflightId,resolutions:p.body.data.stores.flatMap((store:any)=>store.items.map((item:any)=>({accountId:store.accountId,sourceId:item.sourceId,mode:item.duplicate?'overwrite':'create'})))};
    const result=await request(`/${id}/distribute`,'POST',body);expect(result.status,JSON.stringify(result.body)).toBe(200);
    expect(result.body.data.stores.map((store:any)=>store.counts)).toEqual([
      {created:1,overwritten:0,aliased:0,reused:1},
      {created:2,overwritten:0,aliased:0},
      {created:2,overwritten:0,aliased:0},
    ]);
    expect(sql.raw.prepare("SELECT line_account_id,name FROM tags ORDER BY line_account_id").all()).toEqual(['a','b','c'].map(line_account_id=>({line_account_id,name:'会員'})));
  });
  test('lost upload response retries exact immutable receipt and never overwrites',async()=>{
    const put=bucket.put.getMockImplementation();bucket.put.mockImplementationOnce(async(...args:any[])=>{await put(...args);throw new Error('lost response')});
    const first=await upload(),second=await upload();expect(first.status).toBe(201);expect(second).toEqual(first);expect(bucket.put).toHaveBeenCalledOnce();expect(objects.size).toBe(1);
  });
  test('unconfirmed upload leaves no optimistic receipt and a later identical retry recovers',async()=>{
    bucket.put.mockRejectedValueOnce(new Error('connection unavailable'));
    expect((await upload()).status).toBe(422);expect(objects.size).toBe(0);expect(bucket.delete).not.toHaveBeenCalled();
    expect((await upload()).status).toBe(201);expect(objects.size).toBe(1);
  });
  test('same-size source byte corruption is rejected before destination writes',async()=>{
    const uploaded=await upload();let value=freshDefinition('template') as MessageTemplateDefinition;(value.template as any).name='画像';(value.template as any).messageType='image';value=withUploadedImage(value,uploaded.body.data);
    const id=await save('template',value),p=await request(`/${id}/preflight`,'POST',{accountIds:['a']});expect(p.status).toBe(200);
    objects.get(uploaded.body.data.r2Key).bytes=new Uint8Array(32);
    const result=await request(`/${id}/distribute`,'POST',{preflightId:p.body.data.preflightId,resolutions:p.body.data.stores[0].items.map((i:any)=>({accountId:'a',sourceId:i.sourceId,mode:'create'}))});
    expect(result.body.data.stores[0].status).toBe('failed');expect(objects.size).toBe(1);expect(sql.raw.prepare('SELECT count(*) n FROM templates').get()).toEqual({n:0});
  });
  test.each(['readOnly','accountScoped','foreignTenant','missing'])('upload rejects %s authority before R2',async(mode)=>{
    if(mode==='readOnly')staff.readOnly=true;
    if(mode==='accountScoped')sql.raw.exec("UPDATE staff_members SET account_scope='accounts' WHERE id='owner'");
    if(mode==='foreignTenant')staff.tenantId='other';if(mode==='missing')staff=undefined;
    expect((await upload()).status).toBe(403);expect(bucket.put).not.toHaveBeenCalled();
  });
  test('R568: size-mismatched rich menu image is rejected before R2',async()=>{
    bucket.put.mockClear();
    const compactForLarge=await upload('rich_menu',png(2500,843),'compact.png',{width:2500,height:1686});
    expect(compactForLarge.status,JSON.stringify(compactForLarge.body)).toBe(422);expect(bucket.put).not.toHaveBeenCalled();expect(objects.size).toBe(0);
  });
  test('R568: matching expected dimensions still register, malformed ones are rejected',async()=>{
    const matched=await upload('rich_menu',png(2500,1686),'large.png',{width:2500,height:1686});
    expect(matched.status,JSON.stringify(matched.body)).toBe(201);expect(objects.size).toBe(1);
    bucket.put.mockClear();
    expect((await uploadRawWidth('large.png','2500','tall')).status).toBe(422);
    expect((await uploadRawWidth('large.png','0','1686')).status).toBe(422);
    expect((await uploadRawWidth('large.png','2500','')).status).toBe(422);
    expect(bucket.put).not.toHaveBeenCalled();
  });
  test('R568: cancelled upload is reclaimed after the ownership check',async()=>{
    const uploaded=await upload();expect(uploaded.status).toBe(201);const r2Key=uploaded.body.data.r2Key as string;
    const removed=await removeMedia(r2Key);
    expect(removed.status,JSON.stringify(removed.body)).toBe(200);expect(removed.body.data).toEqual({deleted:true});expect(objects.size).toBe(0);
    const repeated=await removeMedia(r2Key);
    expect(repeated.status).toBe(200);expect(repeated.body.data).toEqual({deleted:false});
  });
  test('R568: delete refuses another tenant key and malformed keys without touching R2',async()=>{
    const uploaded=await upload();expect(uploaded.status).toBe(201);
    bucket.delete.mockClear();
    const foreign=await removeMedia('hq-templates/other/uploads/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png');
    expect(foreign.status).toBe(422);expect(foreign.body.code).toBe('INVALID_IMAGE');expect(objects.size).toBe(1);expect(bucket.delete).not.toHaveBeenCalled();
    for(const bad of ['../secret.png','hq-templates/tenant/uploads/','', 'hq-templates/tenant/uploads/a/b.png']) {
      const res=await removeMedia(bad);expect(res.status, bad).toBe(422);
    }
    expect(objects.size).toBe(1);expect(bucket.delete).not.toHaveBeenCalled();
  });
  test('R568: delete reports tampered ownership as not found',async()=>{
    const uploaded=await upload();expect(uploaded.status).toBe(201);
    objects.get(uploaded.body.data.r2Key).customMetadata.hqTenant='other';
    bucket.delete.mockClear();
    const res=await removeMedia(uploaded.body.data.r2Key);
    expect(res.status).toBe(404);expect(res.body.code).toBe('NOT_FOUND');expect(objects.size).toBe(1);expect(bucket.delete).not.toHaveBeenCalled();
  });
  test('R568: delete rejects missing authority before R2',async()=>{
    const uploaded=await upload();expect(uploaded.status).toBe(201);
    staff=undefined;bucket.head.mockClear();bucket.delete.mockClear();
    expect((await removeMedia(uploaded.body.data.r2Key)).status).toBe(403);
    expect(bucket.head).not.toHaveBeenCalled();expect(bucket.delete).not.toHaveBeenCalled();
  });
  test('rejects oversize/malformed image, traversal filename, and wrong rich dimensions',async()=>{
    expect((await upload('message',new Uint8Array(8*1024*1024+1))).status).toBe(422);
    expect((await upload('message',new Uint8Array([1,2,3]))).status).toBe(422);
    expect((await upload('message',png(),'../secret.png')).status).toBe(422);
    expect((await upload('rich_menu',png(10,10))).status).toBe(422);expect(bucket.put).not.toHaveBeenCalled();
  });
  test.each(['tenant','manifest','hash','legacySource'])('forged %s provenance cannot use the new HQ path',async(mode)=>{
    const uploaded=await upload(),media=uploaded.body.data;let value=freshDefinition('template') as MessageTemplateDefinition;(value.template as any).name='画像';(value.template as any).messageType='image';value=withUploadedImage(value,media);
    const o=objects.get(media.r2Key);
    if(mode==='tenant')o.customMetadata.hqTenant='other';if(mode==='manifest')delete o.customMetadata.hqMedia;if(mode==='hash')(value.media[0] as any).contentHash='0'.repeat(64);if(mode==='legacySource')(value.template as any).id='missing-existing-source';
    const id=await save('template',value),p=await request(`/${id}/preflight`,'POST',{accountIds:['a']});expect(p.status).toBe(409);expect(sql.raw.prepare('SELECT count(*) n FROM templates').get()).toEqual({n:0});expect(objects.size).toBe(1);
  });
});

describe('HQ rich-menu draft checks and targeting',()=>{
  async function menu() {
    const u=await upload('rich_menu');expect(u.status).toBe(201);
    return {schemaVersion:1,richMenu:{id:'menu',name:'通常メニュー',chatBarText:'開く',size:'large',defaultPageId:'page',displayAudience:'tag',displayTagName:'会員',defaultOpen:true,pages:[{id:'page',name:'ページ',imageR2Key:u.body.data.r2Key,areas:[{id:'area',bounds:{x:0,y:0,width:100,height:100},actionType:'message',intent:'text',label:'案内',actionData:{text:'案内'}}]}]}};
  }
  function tags(){for(const a of ['a','b','c'])sql.raw.prepare("INSERT INTO tags(id,name,line_account_id) VALUES (?,'会員',?)").run(`member-${a}`,a);}
  test('same-name targeting tags and default-open are copied into independent drafts',async()=>{
    tags();const d=await menu(),id=await save('rich_menu',d);
    expect((await request(`/${id}`)).body.data.definition.richMenu).toMatchObject({displayAudience:'tag',displayTagName:'会員',defaultOpen:true});
    await distribute(id);
    for(const a of ['a','b','c']){
      const g=sql.raw.prepare('SELECT status,default_open,is_default_for_all,targeting_enabled,targeting_condition FROM rich_menu_groups WHERE account_id=?').get(a) as {status:string;default_open:number;is_default_for_all:number;targeting_enabled:number;targeting_condition:string};
      expect(g).toMatchObject({status:'draft',default_open:1,is_default_for_all:0,targeting_enabled:1});
      expect(JSON.parse(g.targeting_condition)).toEqual({operator:'AND',rules:[{type:'tag_exists',value:`member-${a}`}]});
    }
  });
  test('preview returns duplicates, coverage, missing tags and server image sizes without saving',async()=>{
    tags();sql.raw.exec("DELETE FROM tags WHERE line_account_id='c';INSERT INTO rich_menu_groups(id,account_id,name,chat_bar_text,size) VALUES ('existing','a','通常メニュー','開く','large')");
    const d=await menu();
    const r=await request('/rich-menu-preview','POST',{name:d.richMenu.name,accountIds:['a','b','c'],definition:d});
    expect(r.status,JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.summary).toEqual({accountCount:3,sameNameAccountCount:1,overwriteCount:1,createCount:2,missingReferences:1,missingTags:1});
    expect(r.body.data.references[0]).toMatchObject({kind:'audience_tag',name:'会員',availableAccountCount:2,totalAccountCount:3});
    expect(r.body.data.images[0]).toMatchObject({sizeBytes:32,sizeKb:32/1024,available:true});
    expect(sql.raw.prepare('SELECT COUNT(*) n FROM hq_templates').get()).toEqual({n:0});
    expect(sql.raw.prepare('SELECT COUNT(*) n FROM hq_template_preflights').get()).toEqual({n:0});
    expect(bucket.put).toHaveBeenCalledTimes(1);
  });
  test('missing audience tags stop real preflight and are never silently created',async()=>{
    const id=await save('rich_menu',await menu());const r=await request(`/${id}/preflight`,'POST',{accountIds:['a']});
    expect(r.status,JSON.stringify(r.body)).toBe(409);expect(r.body.code).toBe('DISPLAY_TAG_UNAVAILABLE');
    expect(sql.raw.prepare('SELECT COUNT(*) n FROM tags').get()).toEqual({n:0});
  });
  test('targeting tag changes invalidate a confirmed distribution',async()=>{
    tags();const id=await save('rich_menu',await menu());const p=await request(`/${id}/preflight`,'POST',{accountIds:['a']});expect(p.status).toBe(200);
    sql.raw.exec("UPDATE tags SET name='別の会員' WHERE id='member-a'");
    const r=await request(`/${id}/distribute`,'POST',{preflightId:p.body.data.preflightId,resolutions:p.body.data.stores[0].items.map((i:{sourceId:string})=>({accountId:'a',sourceId:i.sourceId,mode:'create'}))});
    expect(r.body.data.stores[0].status).not.toBe('succeeded');expect(sql.raw.prepare('SELECT COUNT(*) n FROM rich_menu_groups').get()).toEqual({n:0});
  });
  test('draft checks reject foreign accounts and editing by a read-only operator',async()=>{
    sql.raw.exec("UPDATE line_accounts SET tenant_id='other' WHERE id='c'");
    expect((await request('/rich-menu-preview','POST',{name:'通常',accountIds:['c']})).status).toBe(403);
    staff.readOnly=true;expect((await request('/rich-menu-preview','POST',{name:'通常',accountIds:['a']})).status).toBe(403);
  });
  test.each([{displayTagName:''},{defaultOpen:'yes'},{displayAudience:'store',displayTagName:'会員'}])('invalid display settings are rejected before saving: %j',async value=>{
    const d=await menu();Object.assign(d.richMenu,value);expect((await request('','POST',{type:'rich_menu',name:'通常',definition:d,requestId:crypto.randomUUID()})).status).toBe(400);
  });
});

test('保存前にフォームと押した人のタグの同名参照・LIFFの不足を店舗別に返す',async()=>{
  const image=await upload('rich_menu');
  for(const a of ['a','b']){
    sql.raw.prepare("INSERT INTO forms(id,name) VALUES (?,'相談フォーム')").run(`form-${a}`);
    sql.raw.prepare('INSERT INTO form_accounts(form_id,line_account_id) VALUES (?,?)').run(`form-${a}`,a);
  }
  for(const a of ['a','c'])sql.raw.prepare("INSERT INTO tags(id,name,line_account_id) VALUES (?,'予約ボタン',?)").run(`tag-${a}`,a);
  sql.raw.exec("UPDATE line_accounts SET liff_id='liff-a' WHERE id='a'");
  const definition={schemaVersion:1,richMenu:{id:'menu',name:'相談',chatBarText:'メニュー',size:'large',defaultPageId:'page',pages:[{id:'page',name:'相談',imageR2Key:image.body.data.r2Key,areas:[
    {id:'form-area',bounds:{x:0,y:0,width:100,height:100},actionType:'uri',actionData:{},intent:'form',formId:'form-a',label:'相談'},
    {id:'tag-area',bounds:{x:100,y:0,width:100,height:100},actionType:'message',actionData:{text:'予約'},intent:'text',tagIds:['tag-a'],label:'予約'},
  ]}]}};
  const r=await request('/rich-menu-preview','POST',{name:'相談',accountIds:['a','b','c'],definition});expect(r.status,JSON.stringify(r.body)).toBe(200);
  expect(r.body.data.references.map((ref:{kind:string;availableAccountCount:number;totalAccountCount:number})=>[ref.kind,ref.availableAccountCount,ref.totalAccountCount]).sort()).toEqual([['form',2,3],['liff',1,3],['tag',2,3]]);
  expect(r.body.data.stores.find((s:{accountId:string;missingReferences:Array<{kind:string}>})=>s.accountId==='b').missingReferences.map((ref:{kind:string})=>ref.kind).sort()).toEqual(['liff','tag']);
  expect(sql.raw.prepare('SELECT COUNT(*) n FROM hq_templates').get()).toEqual({n:0});
});

test.each([
 ['tel','uri',{uri:'tel:0300005678'}],['datetime','postback',{mode:'date',initial:'2026-10-16'}],
 ['clipboard','postback',{text:'予約番号'}],['postback','postback',{data:'contact',displayText:'問い合わせ'}],
])('組5: %s の保存→配布→店の公開用組立に同じ動きを保持する',async(intent,actionType,actionData)=>{
 const image=await upload('rich_menu');
 const d={schemaVersion:1,richMenu:{id:'menu',name:'追加の動き',chatBarText:'メニュー',size:'large',defaultPageId:'page',pages:[{id:'page',name:'ページ',imageR2Key:image.body.data.r2Key,areas:[{id:'action',bounds:{x:0,y:0,width:100,height:100},intent,actionType,actionData,label:'実行'}]}]}};
 const id=await save('rich_menu',d);await distribute(id);
 const areas=sql.raw.prepare('SELECT intent,action_type,action_data FROM rich_menu_areas').all() as Array<{intent:string;action_type:string;action_data:string}>;
 expect(areas).toHaveLength(3);expect(areas.every(a=>a.intent===intent&&a.action_type===actionType&&JSON.stringify(JSON.parse(a.action_data))===JSON.stringify(actionData))).toBe(true);
});

test('組5: 同じ名前の予約ページと店のタグを計測リンクへ保存し、確認後の変更を拒否する',async()=>{
 const image=await upload('rich_menu');
 for(const a of ['a','b','c']){
  sql.raw.prepare("UPDATE line_accounts SET liff_id=? WHERE id=?").run('liff-'+a,a);
  sql.raw.prepare("INSERT INTO menus(id,line_account_id,name,duration_minutes,base_price) VALUES (?,?,'基本の予約',30,0)").run('m-'+a,a);
  sql.raw.prepare("INSERT INTO tags(id,name,line_account_id) VALUES (?,'予約ボタン',?)").run('tag-'+a,a);
 }
 const d={schemaVersion:1,richMenu:{id:'menu',name:'計測',chatBarText:'メニュー',size:'large',defaultPageId:'page',pages:[{id:'page',name:'ページ',imageR2Key:image.body.data.r2Key,areas:[{id:'book',bounds:{x:0,y:0,width:100,height:100},actionType:'uri',intent:'booking',actionData:{},bookingMenuName:'基本の予約',useTrackedLink:true,tagIds:['tag-a'],label:'予約'}]}]}};
 const check=await request('/rich-menu-preview','POST',{name:'計測',accountIds:['a','b','c'],definition:d});expect(check.status,JSON.stringify(check.body)).toBe(200);expect(check.body.data.summary.missingReferences).toBe(0);
 const id=await save('rich_menu',d);await distribute(id);
 const links=sql.raw.prepare('SELECT l.line_account_id,l.original_url,l.tag_id,a.tracked_link_id,l.id FROM tracked_links l JOIN rich_menu_areas a ON a.tracked_link_id=l.id ORDER BY l.line_account_id').all() as Array<{line_account_id:string;original_url:string;tag_id:string;tracked_link_id:string;id:string}>;
 expect(links).toHaveLength(3);for(const l of links){expect(l.tag_id).toBe('tag-'+l.line_account_id);expect(l.original_url).toContain('menu_id=m-'+l.line_account_id);expect(l.tracked_link_id).toBe(l.id);}
 const p=await request(`/${id}/preflight`,'POST',{accountIds:['a']});expect(p.status).toBe(200);
 sql.raw.exec("UPDATE menus SET is_active=0 WHERE id='m-a'");
 const r=await request(`/${id}/distribute`,'POST',{preflightId:p.body.data.preflightId,resolutions:p.body.data.stores.flatMap((s:{accountId:string;items:Array<{sourceId:string;duplicate:boolean}>})=>s.items.map((i:{sourceId:string;duplicate:boolean})=>({accountId:s.accountId,sourceId:i.sourceId,mode:i.duplicate?'overwrite':'create'})))});
 expect(r.body.data.stores[0].status).not.toBe('succeeded');expect(sql.raw.prepare('SELECT count(*) n FROM tracked_links').get()).toEqual({n:3});
});

test('組5: 複数通を作成→版へ固定→配布→同じ順で配信素材に展開し、過多を拒否する',async()=>{
 const original=freshDefinition('template') as MessageTemplateDefinition;
 const d={...original,template:{...original.template,name:'複数通',messageContent:'最初'},messageBubbles:[{id:'one',type:'text',content:{text:'最初 {{name}}'}},{id:'two',type:'text',content:{text:'次のご案内'}}]};
 const id=await save('template',d);expect((await request('?message_count=multiple')).body.data).toMatchObject([{id,message_count:2,has_interpolations:true}]);
 await distribute(id);
 const locals=sql.raw.prepare('SELECT id,message_bubbles_json FROM templates').all() as Array<{id:string;message_bubbles_json:string}>;
 expect(locals).toHaveLength(3);expect(locals.every(r=>JSON.parse(r.message_bubbles_json).length===2)).toBe(true);
 expect(sql.raw.prepare('SELECT COUNT(*) n FROM template_versions WHERE json_array_length(message_bubbles_json)=2').get()).toEqual({n:3});
 const detail=(await request(`/${id}`)).body.data;
 const {resolveHqBroadcastMaterials}=await import('../features/hq-broadcasts/hq-broadcast-materials.js');
 const {parseBroadcastMessageParts,buildMessages}=await import('../features/broadcasts/broadcast-message-set.js');
 const input={messageType:'text',messageContent:'',messageBubbles:[{id:'chosen',type:'text',content:{text:'表示用',hqTemplateId:id,hqTemplateVersionId:detail.template.current_version_id}}]};
 const resolved=await resolveHqBroadcastMaterials(sql.db,'tenant','a',input as never);
 expect(buildMessages(parseBroadcastMessageParts(resolved))).toEqual([{type:'text',text:'最初 {{name}}'},{type:'text',text:'次のご案内'}]);
 await expect(resolveHqBroadcastMaterials(sql.db,'tenant','a',{...input,messageBubbles:Array.from({length:3},(_,i)=>({...input.messageBubbles[0],id:String(i)}))} as never)).rejects.toThrow('5通');
 for(const messageBubbles of [[],Array(6).fill(d.messageBubbles[0]),[{id:'bad',type:'text',content:{text:''}}]])expect((await request('','POST',{type:'template',name:'不正',requestId:crypto.randomUUID(),definition:{...d,messageBubbles}})).status).toBe(400);
});

test('組5: 電話番号の差し込みは各店の同じ名前の共通情報を使い、無効な値や変更後の配布を拒否する',async()=>{
 const image=await upload('rich_menu');
 for(const a of ['a','b','c'])sql.raw.prepare("INSERT INTO common_vars(id,name,var_key,type,value,line_account_id) VALUES (?,'店の電話','phone','text',?,?)").run('var-'+a,'030000000'+['a','b','c'].indexOf(a),a);
 sql.raw.exec("UPDATE common_vars SET valid_from=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour'),valid_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour')");
 const d={schemaVersion:1,richMenu:{id:'menu',name:'電話',chatBarText:'メニュー',size:'large',defaultPageId:'page',pages:[{id:'page',name:'ページ',imageR2Key:image.body.data.r2Key,areas:[{id:'phone',label:'電話をかける',bounds:{x:0,y:0,width:100,height:100},actionType:'uri',intent:'tel',actionData:{uri:'tel:0300000000'},dataBindings:{uri:'店の電話'}}]}]}};
 const preview=await request('/rich-menu-preview','POST',{name:'電話',accountIds:['a','b','c'],definition:d});expect(preview.status,JSON.stringify(preview.body)).toBe(200);expect(preview.body.data.references[0]).toMatchObject({kind:'common_var',availableAccountCount:3});
 const id=await save('rich_menu',d);await distribute(id);
 const rows=sql.raw.prepare('SELECT g.account_id,a.action_data FROM rich_menu_areas a JOIN rich_menu_pages p ON p.id=a.page_id JOIN rich_menu_groups g ON g.id=p.group_id ORDER BY g.account_id').all() as Array<{account_id:string;action_data:string}>;
 expect(rows.map(r=>JSON.parse(r.action_data).uri)).toEqual(['tel:0300000000','tel:0300000001','tel:0300000002']);
 const p=await request(`/${id}/preflight`,'POST',{accountIds:['a']});expect(p.status).toBe(200);
 sql.raw.exec("UPDATE common_vars SET value='javascript:bad' WHERE id='var-a'");
 const r=await request(`/${id}/distribute`,'POST',{preflightId:p.body.data.preflightId,resolutions:p.body.data.stores.flatMap((s:{accountId:string;items:Array<{sourceId:string;duplicate:boolean}>})=>s.items.map((i:{sourceId:string;duplicate:boolean})=>({accountId:s.accountId,sourceId:i.sourceId,mode:i.duplicate?'overwrite':'create'})))});
 expect(r.body.data.stores[0].status).not.toBe('succeeded');
});


test('組5: カルーセルから始まる複数通もメッセージ一覧で2通として返す',async()=>{
 const original=freshDefinition('template') as MessageTemplateDefinition;
 const d={...original,template:{...original.template,name:'カードから始める'},messageBubbles:[{id:'card',type:'carousel',content:{columnsJson:JSON.stringify([{text:'確認',actions:[{type:'message',label:'確認',text:'確認'}]}])}},{id:'text',type:'text',content:{text:'次のご案内'}}]};
 const id=await save('template',d);
 expect((await request('?kind=message&message_count=multiple')).body.data.find((row:{id:string})=>row.id===id)).toMatchObject({kind:'message',message_count:2,content_summary:'メッセージ 2通'});
});
