import {beforeEach,afterEach,test,expect,vi} from 'vitest';
import {formRouting} from './form-routing.js';
import {loadRoutingLayout,validateLayoutRouting,resolveRouting,issueRoutingToken,verifyRoutingToken} from '../features/forms/form-routing.js';
import {gapFixture,gapApp,gapCall,gapOwner} from '../test-utils/gap1.js';
import type {SqliteD1} from '../test-utils/d1-sqlite.js';
import {normalizeLayout,type FormLayout} from '@line-crm/shared';

let d:SqliteD1;
const target={menuId:'menu',staffId:'bs'};
const layout=()=>normalizeLayout({sections:[{id:'s1',name:'相談',blocks:[{id:'q',kind:'input',type:'radio',name:'subject',label:'内容',choices:[{id:'job',label:'転職'}]},{id:'book',kind:'input',type:'booking',name:'book',label:'予約',booking:{menuId:'menu',routing:{enabled:true,rules:[{conditions:[{questionId:'q',op:'is',value:'転職'}],target}],fallback:{menuId:'menu'}}}}]}]})!;
beforeEach(()=>{d=gapFixture();const l=JSON.stringify(layout());d.raw.prepare("INSERT INTO forms(id,name,fields,layout) VALUES('form','相談','[]',?)").run(l);d.raw.exec("INSERT INTO form_accounts(form_id,line_account_id) VALUES('form','a')");vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({sub:'Uf'}))));});
afterEach(()=>{d.raw.close();vi.unstubAllGlobals();});
test('B6-01 B6-02 B6-03 B6-13: fallback必須・自由記述不可・51行拒否',async()=>{
 await expect(validateLayoutRouting(d.db,'a',layout())).resolves.toBeUndefined();
 const l=layout(),blocks=l.sections[0].blocks as any[],r=blocks[1].booking.routing;delete r.fallback;await expect(validateLayoutRouting(d.db,'a',l)).rejects.toThrow('routing_invalid');r.fallback=target;
 blocks[0].type='text';await expect(validateLayoutRouting(d.db,'a',l)).rejects.toThrow('routing_question_invalid');blocks[0].type='radio';r.rules=Array.from({length:51},()=>r.rules[0]);await expect(validateLayoutRouting(d.db,'a',l)).rejects.toThrow('routing_invalid');
});
test('B6-13: 振り分け条件は50行まで検証を通る',async()=>{
 const l=layout(),r=(l.sections[0].blocks[1] as any).booking.routing;
 r.rules=Array.from({length:50},()=>structuredClone(r.rules[0]));
 await expect(validateLayoutRouting(d.db,'a',l)).resolves.toBeUndefined();
});
test('B6-05: 複数の行が当たるときは並び順が先の行を使う',async()=>{
 const l=layout(),r=(l.sections[0].blocks[1] as any).booking.routing;
 r.rules.push({conditions:[{questionId:'q',op:'is',value:'転職'}],target:{menuId:'menu',staffId:'bs2'}});
 d.raw.exec("INSERT INTO staff_menus(staff_id,menu_id,is_offered) VALUES('bs2','menu',1)");
 expect((await resolveRouting(d.db,'a',l,{subject:'転職'})).target.staffId).toBe('bs');
 r.rules.reverse();
 expect((await resolveRouting(d.db,'a',l,{subject:'転職'})).target.staffId).toBe('bs2');
});
test('B6-04 B6-05 B6-08 B6-14: 上から当て、停止した先はfallback、閲覧のみの試しは保存しない',async()=>{
 const l=layout();expect(await resolveRouting(d.db,'a',l,{subject:'転職'})).toMatchObject({matchedIndex:0,target});expect(await resolveRouting(d.db,'a',l,{subject:'その他'})).toMatchObject({matchedIndex:-1});
 const old=d.raw.prepare("SELECT layout FROM forms WHERE id='form'").get();const a=gapApp(d,[formRouting],{...gapOwner,readOnly:true});const r=await gapCall(a,'/api/forms/form/routing/preview?account_id=a','POST',{answers:{subject:'転職'}});expect(r.status).toBe(200);expect(d.raw.prepare("SELECT layout FROM forms WHERE id='form'").get()).toEqual(old);
 d.raw.exec("UPDATE staff SET is_active=0 WHERE id='bs';INSERT INTO staff_menus(staff_id,menu_id,is_offered) VALUES('bs2','menu',1)");expect(await resolveRouting(d.db,'a',l,{subject:'転職'})).toMatchObject({matchedIndex:-1,fellBack:true});
});
test('B6-10: 署名・本人・店・期限・指定担当を守り改ざんを拒否',async()=>{
 // 不変版をDBに作ってから署名。存在しない版を署名しても予約で拒否する。
 const {publishFormVersion}=await import('@line-crm/db');const pub=await publishFormVersion(d.db,'form',1);expect(pub.kind).toBe('published');
 const version=(d.raw.prepare("SELECT current_published_version_id id FROM forms WHERE id='form'").get() as any).id;
 const token=await issueRoutingToken(d.db,{account:'a',friend:'f',formId:'form',versionId:version,blockId:'book',target,matchedIndex:0,exp:Date.now()+60000});
 await expect(verifyRoutingToken(d.db,'a','f',token,'menu','bs')).resolves.toMatchObject({matchedIndex:0});
 for(const [a,f,t,m,s] of [['a','f2',token,'menu','bs'],['b','f',token,'menu','bs'],['a','f',token+'x','menu','bs'],['a','f',token,'other','bs'],['a','f',token,'menu','bs2']])await expect(verifyRoutingToken(d.db,a,f,t,m,s)).rejects.toThrow('routing_token_invalid');
});
test('B6-06: 公開の版を読んで下書きの変更を混ぜない',async()=>{
 const {publishFormVersion}=await import('@line-crm/db');await publishFormVersion(d.db,'form',1);const l=layout();(l.sections[0].blocks[1] as any).booking.routing.rules=[];d.raw.prepare("UPDATE forms SET layout=? WHERE id='form'").run(JSON.stringify(l));
 expect((await resolveRouting(d.db,'a',(await loadRoutingLayout(d.db,'form','a',true)).layout,{subject:'転職'})).matchedIndex).toBe(0);
 expect((await resolveRouting(d.db,'a',(await loadRoutingLayout(d.db,'form','a',false)).layout,{subject:'転職'})).matchedIndex).toBe(-1);
});
