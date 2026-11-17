import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { emptyLayout } from '@line-crm/shared';
import { publishFormVersion } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { createTestD1, insertFriend, type SqliteD1 } from '../test-utils/d1-sqlite.js';
const observed = vi.hoisted(()=>vi.fn());
vi.mock('../features/automations/automation-triggers.js',()=>({dispatchAutomationEventWithLogging:observed}));
vi.mock('../services/liff-auth.js',()=>({verifyCallerLineIdentity:vi.fn(async()=>({lineUserId:'Uf',lineAccountId:'a'}))}));
vi.mock('../services/line-proxy-send.js',()=>({pushViaHarnessProxy:vi.fn(async()=>{})}));
vi.mock('../services/operator-notification-dispatch.js',()=>({dispatchOperatorEvent:vi.fn(async()=>{})}));
vi.mock('../services/event-bus.js',()=>({fireOutgoingWebhooks:vi.fn(async()=>{}),fireEvent:vi.fn(async()=>{})}));
const {forms}=await import('./forms.js');
const {pushViaHarnessProxy}=await import('../services/line-proxy-send.js');
let fixture:SqliteD1;
beforeEach(()=>{
  fixture=createTestD1();observed.mockReset();vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('real transport forbidden')}));
  fixture.raw.prepare("INSERT INTO line_accounts(id,name,channel_id,channel_access_token,channel_secret) VALUES('a','人工','a','fake','fake')").run();
  insertFriend(fixture.raw,'f',{line_account_id:'a',metadata:'{"name":"古い値"}'});
  const layout=emptyLayout();layout.sections[0].blocks=[{id:'name',name:'name',kind:'input',type:'text',label:'名前',destinations:{friendFieldIds:['fixed-kana'],note:true}}];
  fixture.raw.prepare('INSERT INTO forms(id,name,layout,save_to_metadata) VALUES(?,?,?,1)').run('form','人工フォーム',JSON.stringify(layout));
  fixture.raw.prepare("INSERT INTO form_accounts(form_id,line_account_id) VALUES('form','a')").run();
  observed.mockImplementation(async()=>{
    const meta=fixture.raw.prepare("SELECT metadata FROM friends WHERE id='f'").get() as {metadata:string};
    const field=fixture.raw.prepare("SELECT value FROM friend_field_values WHERE friend_id='f' AND field_id='fixed-kana'").get() as {value:string}|undefined;
    return {meta:JSON.parse(meta.metadata),field:field?.value};
  });
});
afterEach(()=>{fixture.raw.close();vi.unstubAllGlobals()});
async function submit(){
  const app=new Hono<Env>();app.route('/',forms);const pending:Promise<unknown>[]=[];
  const res=await app.request('/api/forms/form/submit',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer fake','Idempotency-Key':'aaaaaaaa-1111-4333-8444-111111111111'},body:JSON.stringify({data:{name:'新しい値'}})},{DB:fixture.db,LINE_CHANNEL_ACCESS_TOKEN:'fake',WORKER_URL:'https://fake.test'} as Env['Bindings'],{waitUntil:(p:Promise<unknown>)=>pending.push(p),passThroughOnException:()=>{},props:{}} as ExecutionContext);
  await Promise.all(pending);return res;
}
test('回答後の返信は未解決なら送らず、値を直せば再開する',async()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-18T01:00:00Z'));
  try{
    vi.mocked(pushViaHarnessProxy).mockClear();
    fixture.raw.prepare("UPDATE forms SET on_submit_message_type='text',on_submit_message_content='営業時間: {{var.hours}}',content_revision=content_revision+1 WHERE id='form'").run();
    const row=fixture.raw.prepare("SELECT content_revision FROM forms WHERE id='form'").get() as {content_revision:number};
    expect((await publishFormVersion(fixture.db,'form',row.content_revision)).kind).toBe('published');
    expect((await submit()).status).toBe(202);
    expect(pushViaHarnessProxy).not.toHaveBeenCalled();
    expect(fixture.raw.prepare('SELECT var_key,reason FROM common_var_resolution_failures').all()).toEqual([{var_key:'hours',reason:'missing'}]);
    fixture.raw.prepare("INSERT INTO common_vars(id,line_account_id,name,var_key,type,value) VALUES ('hours','a','営業時間','hours','text','10時')").run();
    expect((await submit()).status).toBe(200);
    expect(pushViaHarnessProxy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(pushViaHarnessProxy).mock.calls[0][3])).toContain('営業時間: 10時');
  }finally{vi.useRealTimers();}
});
test('CS-C02: 全登録先が反映されてから自動化の条件を見る',async()=>{
  expect((await submit()).status).toBe(201);
  expect(observed).toHaveBeenCalledTimes(1);
  const submission = fixture.raw.prepare('SELECT id FROM form_submissions').get() as { id: string };
  expect(observed).toHaveBeenCalledWith(fixture.db, expect.objectContaining({ eventType: 'form_submitted', sourceEventId: submission.id }));
  expect(await observed.mock.results[0].value).toEqual({meta:{name:'新しい値'},field:'新しい値'});
});
test('CS-C02: 一部登録失敗は判定せず失敗表示、再送で成功したメモを重ねない',async()=>{
  fixture.raw.exec("CREATE TEMP TRIGGER fail_field BEFORE INSERT ON friend_field_values BEGIN SELECT RAISE(ABORT,'sqlite fixture failure'); END");
  expect((await submit()).status).toBe(202);
  expect(observed).not.toHaveBeenCalled();
  expect(fixture.raw.prepare('SELECT destination_write_status FROM form_submissions').get()).toEqual({destination_write_status:'partial'});
  fixture.raw.exec('DROP TRIGGER fail_field');
  expect((await submit()).status).toBe(200);
  expect(observed).toHaveBeenCalledTimes(1);
  expect(await observed.mock.results[0].value).toEqual({meta:{name:'新しい値'},field:'新しい値'});
  expect(fixture.raw.prepare("SELECT notes FROM chats WHERE friend_id='f'").get()).toEqual({notes:'新しい値'});
  await submit();expect(observed).toHaveBeenCalledTimes(1);
});

test('消えたコースの回答は409で受け付けず、他の入力や処理を書き込まない', async () => {
  const layout=emptyLayout();
  layout.sections[0].blocks=[{id:'booking',name:'booking',kind:'input',type:'booking',label:'予約',required:true,booking:{kind:'seats',storeId:'store',menuId:''}}];
  fixture.raw.prepare('INSERT INTO forms(id,name,layout,save_to_metadata) VALUES(?,?,?,0)').run('booking-form','予約',JSON.stringify(layout));
  fixture.raw.prepare("INSERT INTO form_accounts(form_id,line_account_id) VALUES('booking-form','a')").run();
  const app=new Hono<Env>();app.route('/',forms);
  const res=await app.request('/api/forms/booking-form/submit',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer fake','Idempotency-Key':'bbbbbbbb-1111-4333-8444-222222222222'},body:JSON.stringify({data:{booking:{kind:'seats',storeId:'store',courseId:'gone',menuId:'',staffId:'',guestCount:2,startsAt:'2099-01-01T00:00:00Z'}}})},{DB:fixture.db,LINE_CHANNEL_ACCESS_TOKEN:'fake',WORKER_URL:'https://fake.test'} as Env['Bindings'],{waitUntil:()=>{},passThroughOnException:()=>{},props:{}} as ExecutionContext);
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({code:'restaurant_course_unavailable'});
  expect(fixture.raw.prepare("SELECT COUNT(*) AS n FROM form_submissions WHERE form_id='booking-form'").get()).toEqual({n:0});
  expect(observed).not.toHaveBeenCalled();
});

test('回答の確認後にコースが消えても回答を作らない', async () => {
  fixture.raw.exec("INSERT INTO rt_organizations(id,account_id,name) VALUES('org','a','店舗'); INSERT INTO rt_stores(id,organization_id,name,code,line_account_id) VALUES('store','org','店舗','S','a'); INSERT INTO rt_menu_items(id,store_id,kind,name,price) VALUES('course','store','course','検証',1000)");
  const layout=emptyLayout();
  layout.sections[0].blocks=[{id:'booking',name:'booking',kind:'input',type:'booking',label:'予約',required:true,booking:{kind:'seats',storeId:'store',menuId:''}}];
  fixture.raw.prepare('INSERT INTO forms(id,name,layout,save_to_metadata) VALUES(?,?,?,0)').run('booking-form','予約',JSON.stringify(layout));
  fixture.raw.prepare("INSERT INTO form_accounts(form_id,line_account_id) VALUES('booking-form','a')").run();
  const prepare=fixture.db.prepare.bind(fixture.db);
  const spy=vi.spyOn(fixture.db,'prepare').mockImplementation((sql)=>{
    if(sql.includes('INSERT INTO form_submissions')) {
      expect(fixture.raw.prepare("SELECT COUNT(*) AS n FROM rt_resource_locks WHERE resource_key LIKE 'form-course:course:%'").get()).toEqual({n:1});
      fixture.raw.prepare("DELETE FROM rt_menu_items WHERE id='course'").run();
    }
    return prepare(sql);
  });
  try {
    const app=new Hono<Env>();app.route('/',forms);
    const res=await app.request('/api/forms/booking-form/submit',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer fake','Idempotency-Key':'cccccccc-1111-4333-8444-333333333333'},body:JSON.stringify({data:{booking:{kind:'seats',storeId:'store',courseId:'course',menuId:'',staffId:'',guestCount:2,startsAt:'2099-01-01T00:00:00Z'}}})},{DB:fixture.db,LINE_CHANNEL_ACCESS_TOKEN:'fake',WORKER_URL:'https://fake.test'} as Env['Bindings'],{waitUntil:()=>{},passThroughOnException:()=>{},props:{}} as ExecutionContext);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({code:'restaurant_course_unavailable'});
    expect(fixture.raw.prepare("SELECT COUNT(*) AS n FROM form_submissions WHERE form_id='booking-form'").get()).toEqual({n:0});
    expect(fixture.raw.prepare("SELECT COUNT(*) AS n FROM rt_resource_locks WHERE resource_key LIKE 'form-course:%'").get()).toEqual({n:0});
  } finally { spy.mockRestore(); }
});
