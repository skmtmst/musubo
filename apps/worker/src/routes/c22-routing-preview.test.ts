import { afterEach, beforeEach, expect, test } from 'vitest';
import { normalizeLayout } from '@line-crm/shared';
import { formRouting } from './form-routing.js';
import { gapApp, gapCall, gapFixture, gapOwner } from '../test-utils/gap1.js';
import type { SqliteD1 } from '../test-utils/d1-sqlite.js';

let d:SqliteD1;
const layout=()=>normalizeLayout({sections:[{id:'s',blocks:[{id:'q',kind:'input',type:'radio',name:'subject',label:'内容',choices:[{id:'yes',label:'相談'}]},{id:'book',kind:'input',type:'booking',name:'book',label:'予約',booking:{menuId:'menu',routing:{enabled:true,rules:[{conditions:[{questionId:'q',op:'is',value:'相談'}],target:{menuId:'menu',staffId:'bs'}}],fallback:{menuId:'menu'}}}}]}]})!;
beforeEach(()=>{d=gapFixture();d.raw.prepare("INSERT INTO forms(id,name,fields,layout) VALUES('form','相談','[]',?)").run(JSON.stringify(layout()));d.raw.exec("INSERT INTO form_accounts(form_id,line_account_id) VALUES('form','a')")});
afterEach(()=>d.raw.close());
test('未保存の行を閲覧権限で試し、フォームは変えない',async()=>{
 const draft=layout(); const booking=draft.sections[0].blocks[1]; if(booking.kind!=='input'||!booking.booking?.routing)throw Error('fixture');
 booking.booking.routing.rules=[];
 const before=d.raw.prepare("SELECT layout,content_revision FROM forms WHERE id='form'").get();
 const r=await gapCall(gapApp(d,[formRouting],{...gapOwner,readOnly:true}),'/api/forms/form/routing/preview?account_id=a','POST',{answers:{subject:'相談'},layout:draft});
 expect(r.status).toBe(200); expect(await r.json()).toMatchObject({data:{matchedIndex:-1}});
 expect(d.raw.prepare("SELECT layout,content_revision FROM forms WHERE id='form'").get()).toEqual(before);
});
test('他の店舗のフォームは未保存の版を渡しても試せない',async()=>{
 const r=await gapCall(gapApp(d,[formRouting]),'/api/forms/form/routing/preview?account_id=b','POST',{answers:{subject:'相談'},layout:layout()});
 expect(r.status).toBe(404);
});
test('条件が壊れた試行は400で断り、保存しない',async()=>{
 const draft=JSON.parse(JSON.stringify(layout())) as {sections:Array<{blocks:Array<{booking?:{routing:{rules:Array<{conditions:unknown[]}>}}}>}>};
 draft.sections[0].blocks[1].booking!.routing.rules[0].conditions=[null];
 const before=d.raw.prepare("SELECT layout,content_revision FROM forms WHERE id='form'").get();
 const r=await gapCall(gapApp(d,[formRouting]),'/api/forms/form/routing/preview?account_id=a','POST',{answers:{subject:'相談'},layout:draft});
 expect(r.status).toBe(400);expect(d.raw.prepare("SELECT layout,content_revision FROM forms WHERE id='form'").get()).toEqual(before);
});
test('停止中と他店の行き先を保存できず、元の定義を残す',async()=>{
 const {forms}=await import('./forms.js');
 d.raw.exec("INSERT INTO menus(id,line_account_id,name,duration_minutes,base_price) VALUES('other-account','b','他店',60,0)");
 const before=d.raw.prepare("SELECT layout,content_revision FROM forms WHERE id='form'").get();
 for(const menuId of ['missing','other-account']){
  const draft=layout(); const booking=draft.sections[0].blocks[1];if(booking.kind!=='input'||!booking.booking?.routing)throw Error('fixture');
  booking.booking.routing.rules[0].target.menuId=menuId;
  const r=await gapCall(gapApp(d,[forms]),'/api/forms/form?account_id=a','PUT',{layout:draft,expectedContentRevision:1});
  expect(r.status).toBe(400);
  expect(d.raw.prepare("SELECT layout,content_revision FROM forms WHERE id='form'").get()).toEqual(before);
 }
});
test('閲覧のみと代理ログインでは振り分けを保存できない',async()=>{
 const {forms}=await import('./forms.js');
 const before=d.raw.prepare("SELECT layout,content_revision FROM forms WHERE id='form'").get();
 for(const [staff,impersonated] of [[{...gapOwner,readOnly:true},false],[gapOwner,true]] as const){
  const changed=layout(); const booking=changed.sections[0].blocks[1];if(booking.kind!=='input'||!booking.booking?.routing)throw Error('fixture');booking.booking.routing.rules=[];
  const r=await gapCall(gapApp(d,[forms],staff,impersonated),'/api/forms/form?account_id=a','PUT',{layout:changed,expectedContentRevision:1});
  expect(r.status).toBe(403);
  expect(d.raw.prepare("SELECT layout,content_revision FROM forms WHERE id='form'").get()).toEqual(before);
 }
});

test('代理ログインで振り分け以外を編集しても、既存ルールは変わらない',async()=>{
 const {forms}=await import('./forms.js');
 const draft=layout();draft.sections[0].name='編集後';
 const r=await gapCall(gapApp(d,[forms],gapOwner,true),'/api/forms/form?account_id=a','PUT',{layout:draft,expectedContentRevision:1});
 expect(r.status).toBe(200);
});

test('代理ログインでは振り分けが使う質問の変更もできない',async()=>{
 const {forms}=await import('./forms.js');
 const draft=layout(); const question=draft.sections[0].blocks[0];if(question.kind!=='input')throw Error('fixture');question.name='different';
 const before=d.raw.prepare("SELECT layout,content_revision FROM forms WHERE id='form'").get();
 const r=await gapCall(gapApp(d,[forms],gapOwner,true),'/api/forms/form?account_id=a','PUT',{layout:draft,expectedContentRevision:1});
 expect(r.status).toBe(403);expect(d.raw.prepare("SELECT layout,content_revision FROM forms WHERE id='form'").get()).toEqual(before);
});
test('フォーム閲覧権限だけでも同じ店舗の予約先候補を取得できる',async()=>{
 d.raw.exec("INSERT INTO menus(id,line_account_id,name,duration_minutes,base_price) VALUES('other-menu','b','他店',30,0)");
 const staff={...gapOwner,id:'s',role:'staff' as const,permissionKeys:['/form-submissions'],accountScope:'all' as const};
 const r=await gapCall(gapApp(d,[formRouting],staff),'/api/forms/form/routing/targets?account_id=a');
 expect(r.status).toBe(200);
 const body=await r.json() as {data:{menus:Array<{id:string}>;staff:Array<{id:string;menuId:string}>}};
 expect(body.data.menus.map(m=>m.id)).toContain('menu');
 expect(body.data.menus.map(m=>m.id)).not.toContain('other-menu');
 expect(body.data.staff).toEqual(expect.arrayContaining([expect.objectContaining({id:'bs',menuId:'menu'})]));
});
test('フォーム権限がなければ予約先候補を取得できない',async()=>{
 const staff={...gapOwner,id:'s',role:'staff' as const,permissionKeys:[],accountScope:'all' as const};
 expect((await gapCall(gapApp(d,[formRouting],staff),'/api/forms/form/routing/targets?account_id=a')).status).toBe(403);
});
test('閲覧のみのフォーム担当も予約先候補を見られ、他店の候補は見られない',async()=>{
 const staff={...gapOwner,id:'s',role:'staff' as const,readOnly:true,permissionKeys:[],viewPermissionKeys:['/form-submissions'],accountScope:'all' as const};
 expect((await gapCall(gapApp(d,[formRouting],staff),'/api/forms/form/routing/targets?account_id=a')).status).toBe(200);
 expect((await gapCall(gapApp(d,[formRouting],staff),'/api/forms/form/routing/targets?account_id=b')).status).toBe(404);
});
test('候補一覧の入口はフォームの閲覧権限で認可される',async()=>{
 const {permissionForApiPath}=await import('../middleware/auth/permissions/auth.js');
 expect(permissionForApiPath('/api/forms/form/routing/targets')).toBe('/form-submissions');
});
