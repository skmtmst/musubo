import type { AutomationActionContext } from '../features/automations/automation-engine.js';
import { processBroadcastAfterActions } from '../features/broadcasts/broadcast-after-actions.js';
import {Hono} from 'hono';import {describe,it,expect,beforeEach,afterEach,vi} from 'vitest';
import {createTestD1,type SqliteD1} from '../test-utils/d1-sqlite.js';import {hqBroadcasts} from './hq-broadcasts.js';import {broadcasts} from './broadcasts.js';import {broadcastApprovals} from './broadcast-approvals.js';import type { Env } from '../worker-env.js';
vi.mock('../lib/step-up.js',async()=>({...await vi.importActual('../lib/step-up.js'),sensitiveStepUpSatisfied:vi.fn(async()=>true)}));
let f:SqliteD1,app:Hono<Env>;
const tenant='00000000-0000-4000-8000-000000000001';
beforeEach(()=>{f=createTestD1();f.raw.prepare("INSERT INTO line_accounts(id,name,channel_id,channel_secret,channel_access_token,tenant_id) VALUES('shop','試験','channel','unused','token',?)").run(tenant);
 f.raw.prepare("INSERT INTO staff_members(id,name,role,api_key,tenant_id) VALUES('owner','統括','owner','unused',?)").run(tenant);f.raw.exec("INSERT INTO friends(id,line_user_id,line_account_id) VALUES('friend','U-friend','shop')");
 app=new Hono<Env>();app.use('/api/*',async(c,next)=>{c.set('staff',{id:'owner',name:'統括',role:'owner',tenantId:tenant,readOnly:false});await next();});app.route('/',hqBroadcasts);app.route('/',broadcasts);app.route('/',broadcastApprovals);
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>new Response(JSON.stringify(url.endsWith('consumption')?{totalUsage:0}:{type:'limited',value:100}),{status:200})));
});afterEach(()=>{f.raw.close();vi.unstubAllGlobals();});
const call=(path:string,method='GET',body?:unknown,confirm=false)=>app.request(path,{method,headers:{'Content-Type':'application/json',...(confirm?{'X-Confirm-Irreversible':'broadcast-send'}:{})},...(body?{body:JSON.stringify(body)}:{})},{DB:f.db} as Env['Bindings']);
describe('統括からの配信API',()=>{
 it('閲覧専用の担当者は再送プレビューを取得できない',async()=>{
  const r=await made();actor('owner',true);
  expect((await call(`/api/hq/broadcasts/${r.id}`)).status).toBe(200);
  expect((await call(`/api/hq/broadcasts/${r.id}/targets/shop/retry-preview`)).status).toBe(403);
 });
 it('一覧と詳細を読むだけでは再送用ハッシュを作らない',async()=>{
  const created=await call('/api/hq/broadcasts','POST',{requestId:'retry-list',title:'お知らせ',messageType:'text',messageContent:'本文',accountIds:['shop'],accountTagIds:[],excludedAccountIds:[],audience:{kind:'all'},scheduledAt:null});
  const run=(await created.json() as any).data;
  const sent=await call(`/api/hq/broadcasts/${run.id}/send`,'POST',{expectedVersion:1},true),child=(await sent.json() as any).data.targets[0].broadcastId;
  f.raw.prepare("UPDATE broadcasts SET status='sent' WHERE id=?").run(child);
  f.raw.prepare("INSERT INTO broadcast_send_claims(broadcast_id,friend_id,state,error_code) VALUES(?,'friend','failed','line_http_429')").run(child);
  const digest=vi.spyOn(crypto.subtle,'digest');
  expect((await call('/api/hq/broadcasts')).status).toBe(200);expect((await call(`/api/hq/broadcasts/${run.id}`)).status).toBe(200);expect(digest).not.toHaveBeenCalled();
  const preview=await call(`/api/hq/broadcasts/${run.id}/targets/shop/retry-preview`);expect(preview.status).toBe(200);expect(digest).toHaveBeenCalledTimes(1);digest.mockRestore();
 });
 it('確認後に再送対象が変わると現在人数を返し送信を始めない',async()=>{
  const created=await call('/api/hq/broadcasts','POST',{requestId:'retry-check',title:'お知らせ',messageType:'text',messageContent:'本文',accountIds:['shop'],accountTagIds:[],excludedAccountIds:[],audience:{kind:'all'},scheduledAt:null});
  const run=(await created.json() as any).data;
  const sent=await call(`/api/hq/broadcasts/${run.id}/send`,'POST',{expectedVersion:1},true);
  const child=(await sent.json() as any).data.targets[0].broadcastId;
  f.raw.prepare("UPDATE broadcasts SET status='sent' WHERE id=?").run(child);
  f.raw.prepare("INSERT INTO broadcast_send_claims(broadcast_id,friend_id,state,error_code) VALUES(?,'friend','failed','line_http_429')").run(child);
  const before=(await (await call(`/api/hq/broadcasts/${run.id}`)).json() as any).data.targets[0];
  const preview=(await (await call(`/api/hq/broadcasts/${run.id}/targets/shop/retry-preview`)).json() as any).data;
  f.raw.exec("INSERT INTO friends(id,line_user_id,line_account_id) VALUES('second','U-second','shop')");
  f.raw.prepare("INSERT INTO broadcast_send_claims(broadcast_id,friend_id,state,error_code) VALUES(?,'second','failed','line_http_429')").run(child);
  const result=await call(`/api/hq/broadcasts/${run.id}/targets/shop/retry`,'POST',{expectedVersion:before.version,confirmedRecipientCount:preview.count,confirmedRecipientToken:preview.token},true);
  expect(result.status).toBe(409);expect(await result.json()).toMatchObject({success:false,error:'送る相手が変わりました。もう一度確かめてください。',currentCount:2,data:{currentCount:2}});
  expect(f.raw.prepare('SELECT status FROM broadcasts WHERE id=?').get(child)).toEqual({status:'sent'});
 });
 it('送信確認を要求し、作った店の配信を店側から変更・削除・再送できない',async()=>{
  const r=await call('/api/hq/broadcasts','POST',{requestId:'run',title:'お知らせ',messageType:'text',messageContent:'本文',accountIds:['shop'],accountTagIds:[],excludedAccountIds:[],audience:{kind:'all'},scheduledAt:null});expect(r.status).toBe(201);
  const id=(await r.json() as any).data.id;
  expect((await call(`/api/hq/broadcasts/${id}/send`,'POST',{expectedVersion:1})).status).toBe(428);
  expect((await call(`/api/hq/broadcasts/${id}/send`,'POST',{expectedVersion:1},true)).status).toBe(200);
  const child=(f.raw.prepare('SELECT id FROM broadcasts').get() as {id:string}).id;
  for(const [method,suffix] of [['PUT',''],['DELETE',''],['POST','/stop'],['POST','/retry-failed'],['POST','/send-segment']])expect((await call(`/api/broadcasts/${child}${suffix}`,method,{title:'変更'},true)).status).toBe(403);
 });
 it('担当店だけに制限された管理者は統括の配信を作れない',async()=>{
  f.raw.exec("UPDATE staff_members SET role='admin',account_scope='accounts' WHERE id='owner'");
  expect((await call('/api/hq/broadcasts')).status).toBe(403);
 });
});

it('GETで下書き本文を読み、PATCHで同じIDのまま直し、古い版を拒む',async()=>{
 const input={requestId:'editable',title:'下書き',messageType:'text',messageContent:'前の本文',accountIds:['shop'],accountTagIds:[],excludedAccountIds:[],audience:{kind:'all'},scheduledAt:null};
 const created=await call('/api/hq/broadcasts','POST',input);const id=(await created.json() as any).data.id;
 expect((await (await call(`/api/hq/broadcasts/${id}`)).json() as any).data.input.messageContent).toBe('前の本文');
 const changed=await call(`/api/hq/broadcasts/${id}`,'PATCH',{...input,messageContent:'新しい本文',expectedVersion:1});expect(changed.status).toBe(200);expect((await changed.json() as any).data).toMatchObject({id,version:2,input:{messageContent:'新しい本文'}});
 expect((await call(`/api/hq/broadcasts/${id}`,'PATCH',{...input,expectedVersion:1})).status).toBe(409);
});

const draft=(requestId:string,extras:Record<string,unknown>={})=>({requestId,title:'お知らせ',messageType:'text',messageContent:'本文',accountIds:['shop'],accountTagIds:[],excludedAccountIds:[],audience:{kind:'all'},scheduledAt:null,...extras});
async function made(extras:Record<string,unknown>={}){
 const r=await call('/api/hq/broadcasts','POST',draft(crypto.randomUUID(),extras));expect(r.status,await r.clone().text()).toBe(201);return (await r.json() as any).data;
}
function actor(id:string,readOnly=false){
 app=new Hono<Env>();app.use('/api/*',async(c,next)=>{c.set('staff',{id,name:'統括',role:'owner',tenantId:tenant,readOnly});await next();});app.route('/',hqBroadcasts);
}
describe('店と共通の一括配信 API-18',()=>{
 it('分類・メモ・複数吹き出し・計測を保存し、店の配信にも引き継ぐ',async()=>{
  const folder=await call('/api/hq/broadcasts/folders','POST',{name:'月の配信'});expect(folder.status).toBe(201);const id=(await folder.json() as any).data.id;
  const bubbles=[{id:'b1',type:'text',content:{text:'1つ目'}},{id:'b2',type:'text',content:{text:'2つ目'}}];
  const r=await made({folderId:id,internalMemo:'社内だけ',messageBubbles:bubbles,measureOpens:false,trackLinks:false});
  expect(r.input).toMatchObject({folderId:id,internalMemo:'社内だけ',messageBubbles:bubbles});
  expect((await call(`/api/hq/broadcasts/${r.id}/send`,'POST',{expectedVersion:1},true)).status).toBe(200);
  const child=f.raw.prepare('SELECT message_bubbles_json,internal_memo,measure_opens,track_links FROM broadcasts').get() as any;
  expect(JSON.parse(child.message_bubbles_json)).toEqual(bubbles);expect(child).toMatchObject({internal_memo:'社内だけ',measure_opens:0,track_links:0});
  expect((await (await call('/api/hq/broadcasts/folders')).json() as any).data).toEqual([expect.objectContaining({id,item_count:1})]);
  expect((await call(`/api/hq/broadcasts/folders/${id}`,'PATCH',{name:'改名',expectedVersion:1})).status).toBe(200);
  expect((await call(`/api/hq/broadcasts/folders/${id}`,'DELETE',{expectedVersion:1})).status).toBe(409);
  expect((await call(`/api/hq/broadcasts/folders/${id}`,'DELETE',{expectedVersion:2})).status).toBe(200);
  expect((await call('/api/hq/broadcasts','POST',draft('badfolder',{folderId:id}))).status).toBe(403);
 });
 it('同名タグと除くタグ・シナリオ購読を店のIDに解決し、欠けた条件では配信しない',async()=>{
  f.raw.exec("INSERT INTO tags(id,name,normalized_name,line_account_id) VALUES('tag1','常連','常連','shop'),('excluded','除外','除外','shop');INSERT INTO friend_tags(friend_id,tag_id) VALUES('friend','tag1');INSERT INTO scenarios(id,name,line_account_id,trigger_type) VALUES('scenario1','案内','shop','manual');INSERT INTO friend_scenarios(id,friend_id,scenario_id,status) VALUES('fs1','friend','scenario1','active')");
  const r=await made({targetType:'segment',excludedTagIds:['除外'],segmentConditions:{operator:'AND',rules:[{type:'tag_exists',value:'常連'},{type:'scenario_subscribed',value:'案内'}]}});
  expect((await (await call(`/api/hq/broadcasts/${r.id}/preflight`,'POST',{})).json() as any).data[0].audienceCount).toBe(1);
  expect((await call(`/api/hq/broadcasts/${r.id}/send`,'POST',{expectedVersion:1},true)).status).toBe(200);
  const condition=JSON.parse((f.raw.prepare('SELECT segment_conditions FROM broadcasts').get() as any).segment_conditions);
  expect(condition).toMatchObject({rules:[{type:'is_following',value:true},{type:'tag_not_exists',value:'excluded'}],groups:[{rules:[{type:'tag_exists',value:'tag1'},{type:'scenario_subscribed',value:'scenario1'}]}]});
  expect((await call('/api/hq/broadcasts','POST',draft('missing',{segmentConditions:{operator:'AND',rules:[{type:'tag_exists',value:'存在しない'}]}}))).status).toBe(409);
  const next=await made({excludedTagIds:['除外']});f.raw.exec("UPDATE tags SET name='変更された' WHERE id='excluded'");
  expect((await call(`/api/hq/broadcasts/${next.id}/send`,'POST',{expectedVersion:1},true)).status).toBe(409);
  expect((f.raw.prepare('SELECT COUNT(*) AS n FROM broadcasts').get() as any).n).toBe(1);
 });
 it('保存した配信条件を読み、除くタグとのANDで宛先を絞る',async()=>{
  f.raw.exec("INSERT INTO tags(id,name,normalized_name,line_account_id) VALUES('tag1','常連','常連','shop');INSERT INTO friend_tags(friend_id,tag_id) VALUES('friend','tag1')");
  f.raw.prepare("INSERT INTO saved_searches(id,name,scope,line_account_id,condition_format,conditions_json) VALUES('saved','常連検索','friends','shop','segment_v1',?)").run(JSON.stringify({version:1,condition:{operator:'AND',rules:[{type:'tag_exists',value:'tag1'}]}}));
  const r=await made({targetType:'segment',savedSearchId:'常連検索'});
  expect((await (await call(`/api/hq/broadcasts/${r.id}/preflight`,'POST',{})).json() as any).data[0].audienceCount).toBe(1);
  f.raw.exec("UPDATE saved_searches SET condition_format='search_v1'");
  expect((await call(`/api/hq/broadcasts/${r.id}/send`,'POST',{expectedVersion:1},true)).status).toBe(409);
 });
 it('店と同じ承認の形で別人を求め、承認後の人数変更・古い版・下書き更新は再承認にする',async()=>{
  f.raw.prepare("INSERT INTO staff_members(id,name,role,api_key,tenant_id) VALUES('reviewer','承認者','admin','unused2',?)").run(tenant);
  f.raw.exec("INSERT INTO account_settings(line_account_id,key,value) VALUES('shop','broadcast_approval_threshold','1')");
  const r=await made();expect((await call(`/api/hq/broadcasts/${r.id}/send`,'POST',{expectedVersion:1},true)).status).toBe(409);
  const requested=await call(`/api/hq/broadcasts/${r.id}/approval-request`,'POST',{expectedVersion:1,approverStaffId:'reviewer',note:'お願いします'});expect(requested.status).toBe(200);
  expect((await requested.json() as any).data).toMatchObject({approval:{status:'pending',requestedByStaffId:'owner',approverStaffId:'reviewer',confirmedCount:1},gate:{required:true,singleOperator:false,threshold:1}});
  expect((await call(`/api/hq/broadcasts/${r.id}/approve`,'POST',{expectedVersion:2})).status).toBe(403);
  actor('reviewer');expect((await call(`/api/hq/broadcasts/${r.id}/approve`,'POST',{expectedVersion:1})).status).toBe(409);
  expect((await call(`/api/hq/broadcasts/${r.id}/approve`,'POST',{expectedVersion:2})).status).toBe(200);
  f.raw.exec("INSERT INTO friends(id,line_user_id,line_account_id) VALUES('new','Unew','shop')");actor('owner');
  expect((await call(`/api/hq/broadcasts/${r.id}/send`,'POST',{expectedVersion:3},true)).status).toBe(409);
  const changed=await call(`/api/hq/broadcasts/${r.id}`,'PATCH',{...r.input,messageContent:'直した',expectedVersion:3});expect(changed.status).toBe(200);
  expect((await (await call(`/api/hq/broadcasts/${r.id}/approval`)).json() as any).data.approval.status).toBe('none');
 });
 it('承認済みなら子配信へ承認の記録を持たせ、1人運用では人数入力を必須にする',async()=>{
  f.raw.exec("INSERT INTO account_settings(line_account_id,key,value) VALUES('shop','broadcast_approval_threshold','1')");
  const r=await made();expect((await call(`/api/hq/broadcasts/${r.id}/send`,'POST',{expectedVersion:1},true)).status).toBe(409);
  expect((await call(`/api/hq/broadcasts/${r.id}/send`,'POST',{expectedVersion:1,confirmedRecipientCount:1},true)).status).toBe(200);
  expect(f.raw.prepare('SELECT approval_status,approval_confirmed_count FROM broadcasts').get()).toEqual({approval_status:'approved',approval_confirmed_count:1});
  const child=(f.raw.prepare('SELECT id FROM broadcasts').get() as any).id;
  expect((await call(`/api/broadcasts/${child}/approval`)).status).toBe(404);
  expect((await call(`/api/broadcasts/${child}/approval-request`,'POST',{})).status).toBe(404);
 });
 it('テストは店内の設定宛先だけに全吹き出しを送り、混在宛先・短時間の繰り返しを止める',async()=>{
  f.raw.exec(`INSERT INTO account_settings(line_account_id,key,value) VALUES('shop','test_recipients','["friend"]')`);
  const r=await made({messageBubbles:[{id:'one',type:'text',content:{text:'1つ目'}},{id:'two',type:'text',content:{text:'2つ目'}}]});
  vi.mocked(fetch).mockClear();
  const sent=await call(`/api/hq/broadcasts/${r.id}/test-send`,'POST',{accountId:'shop'});expect(sent.status,await sent.clone().text()).toBe(200);expect((await sent.json() as any).data).toEqual({sent:1,failed:0});
  const pushes=vi.mocked(fetch).mock.calls.filter(([u])=>String(u).endsWith('/message/push'));expect(pushes).toHaveLength(1);
  expect(JSON.parse(String(pushes[0][1]?.body)).messages).toHaveLength(2);
  expect((await call(`/api/hq/broadcasts/${r.id}/test-send`,'POST',{accountId:'shop'})).status).toBe(429);
  f.raw.exec(`UPDATE account_settings SET value='["outside"]' WHERE key='test_recipients'`);
  expect((await call(`/api/hq/broadcasts/${r.id}/test-send`,'POST',{accountId:'shop'})).status).toBe(403);
  expect((f.raw.prepare("SELECT COUNT(*) AS n FROM messages_log WHERE delivery_type='test'").get() as any).n).toBe(2);
 });
 it('送信後の店別の実績・反応人数・CSV・宛先と記録を返し、未取得を0にしない',async()=>{
  f.raw.exec("UPDATE line_accounts SET name='=危険な式' WHERE id='shop'");const r=await made();
  expect(r.targets[0]).toMatchObject({openedCount:null,clickedCount:null,reactionCount:null});
  await call(`/api/hq/broadcasts/${r.id}/send`,'POST',{expectedVersion:1},true);
  const child=(f.raw.prepare('SELECT id FROM broadcasts').get() as any).id;
  f.raw.prepare("UPDATE broadcasts SET status='sent',success_count=1,total_count=1,sent_at='2026-10-08T09:00:00' WHERE id=?").run(child);
  f.raw.prepare("INSERT INTO broadcast_insights(id,broadcast_id,status,unique_impression,unique_click,fetched_at) VALUES('insight',?,'ready',1,1,'2026-10-08')").run(child);
  f.raw.prepare("INSERT INTO broadcast_send_claims(broadcast_id,friend_id,line_account_id,state) VALUES(?,'friend','shop','sent')").run(child);
  f.raw.exec("INSERT INTO messages_log(id,friend_id,direction,message_type,content,line_account_id,created_at) VALUES('reaction1','friend','incoming','text','返信','shop','2026-10-08T10:00:00'),('reaction2','friend','incoming','text','返信2','shop','2026-10-08T10:01:00')");
  expect((await (await call(`/api/hq/broadcasts/${r.id}`)).json() as any).data.targets[0]).toMatchObject({openedCount:1,clickedCount:1,reactionCount:1,successCount:1});
  const csv=await call(`/api/hq/broadcasts/${r.id}/export.csv`);expect(csv.headers.get('content-type')).toContain('text/csv');expect(await csv.text()).toContain("'=危険な式");
  expect((await (await call(`/api/hq/broadcasts/${r.id}/targets/shop/recipients`)).json() as any).data).toMatchObject({total:1,rows:[{friendId:'friend',state:'sent'}]});
  f.raw.prepare("UPDATE broadcast_send_claims SET state='failed',settled_at='2026-10-08T10:00:00' WHERE broadcast_id=?").run(child);
  expect((await (await call(`/api/hq/broadcasts/${r.id}/targets/shop/recipients`)).json() as any).data.rows[0]).toMatchObject({state:'failed',sentAt:null});
  expect((await call(`/api/hq/broadcasts/${r.id}/targets/foreign/recipients`)).status).toBe(404);
  expect((await (await call(`/api/hq/broadcasts/${r.id}/activity?limit=1`)).json() as any).data.rows).toHaveLength(1);
 });
 it('閲覧のみは実績と履歴を読めるが、分類・テスト・承認・送信はできない',async()=>{
  const r=await made();actor('owner',true);vi.mocked(fetch).mockClear();
  for(const suffix of ['', '/activity','/export.csv','/targets/shop/recipients'])expect((await call(`/api/hq/broadcasts/${r.id}${suffix}`)).status).toBe(200);
  for(const suffix of ['/test-send','/approval-request','/send'])expect((await call(`/api/hq/broadcasts/${r.id}${suffix}`,'POST',{accountId:'shop',expectedVersion:1},true)).status).toBe(403);
  expect((await call('/api/hq/broadcasts/folders','POST',{name:'不可'})).status).toBe(403);expect(fetch).not.toHaveBeenCalled();
 });
 it('配布先が別の統括へ移ったら、その店の宛先・残枠・実績は返さない',async()=>{
  const r=await made();f.raw.exec("UPDATE line_accounts SET tenant_id='other' WHERE id='shop'");vi.mocked(fetch).mockClear();
  expect((await (await call(`/api/hq/broadcasts/${r.id}`)).json() as any).data.targets).toEqual([]);
  expect((await call(`/api/hq/broadcasts/${r.id}/targets/shop/recipients`)).status).toBe(404);
  expect((await call(`/api/hq/broadcasts/${r.id}/send`,'POST',{expectedVersion:1},true)).status).toBe(409);expect(fetch).not.toHaveBeenCalled();
 });
});

it('承認は店と同じ本人再確認を要求し、確認票なしでは状態を変えない',async()=>{
 const {sensitiveStepUpSatisfied}=await import('../lib/step-up.js');
 f.raw.prepare("INSERT INTO staff_members(id,name,role,api_key,tenant_id) VALUES('reviewer','承認者','admin','unused2',?)").run(tenant);
 f.raw.exec("INSERT INTO account_settings(line_account_id,key,value) VALUES('shop','broadcast_approval_threshold','1')");
 const r=await made();await call(`/api/hq/broadcasts/${r.id}/approval-request`,'POST',{expectedVersion:1,approverStaffId:'reviewer'});actor('reviewer');
 vi.mocked(sensitiveStepUpSatisfied).mockResolvedValueOnce(false);
 const res=await call(`/api/hq/broadcasts/${r.id}/approve`,'POST',{expectedVersion:2});expect(res.status).toBe(401);expect((await res.json() as any).code).toBe('STEP_UP_REQUIRED');
 expect(JSON.parse((f.raw.prepare('SELECT approval_json FROM hq_broadcast_runs WHERE id=?').get(r.id) as any).approval_json).status).toBe('pending');
});
it('別人承認を全店の子配信へ残し、送信後に店側の承認から変更できない',async()=>{
 f.raw.prepare("INSERT INTO staff_members(id,name,role,api_key,tenant_id) VALUES('reviewer','承認者','admin','unused2',?)").run(tenant);
 f.raw.exec("INSERT INTO account_settings(line_account_id,key,value) VALUES('shop','broadcast_approval_threshold','1')");
 const r=await made();await call(`/api/hq/broadcasts/${r.id}/approval-request`,'POST',{expectedVersion:1,approverStaffId:'reviewer'});actor('reviewer');
 expect((await call(`/api/hq/broadcasts/${r.id}/approve`,'POST',{expectedVersion:2})).status).toBe(200);actor('owner');
 expect((await call(`/api/hq/broadcasts/${r.id}/send`,'POST',{expectedVersion:3},true)).status).toBe(200);
 expect(f.raw.prepare('SELECT approval_status,approval_requested_by_staff_id,approval_decided_by_staff_id FROM broadcasts').get()).toEqual({approval_status:'approved',approval_requested_by_staff_id:'owner',approval_decided_by_staff_id:'reviewer'});
});

type HqRunResponse = {data: import('@line-crm/shared').HqBroadcastRun & {sent:0;followupAudienceCount:number}};
type HqListResponse = {data:Array<{id:string;selectable:boolean}>;pagination:{total:number;nextCursor:string|null};statusCounts:Record<string,number>};
type ReactionResponse = {data:Awaited<ReturnType<typeof import('../features/hq-broadcasts/hq-broadcast-reactions.js').hqBroadcastReactions>>};
type QuotaResponse = {data:Awaited<ReturnType<typeof import('../features/hq-broadcasts/hq-broadcast-list.js').hqBroadcastQuota>>};
describe('統括の配信一覧・複製・追送',()=>{
 it('配信日・状態・名前でページ分け前に絞り、全件数と承認待ち数を返す',async()=>{
   const one=await made({title:'秋のお知らせ'}),two=await made({title:'冬のお知らせ'}),three=await made({title:'秋の承認'});
   f.raw.prepare("UPDATE hq_broadcast_runs SET approval_json=? WHERE id=?").run(JSON.stringify({status:'pending'}),three.id);
   f.raw.prepare("UPDATE hq_broadcast_runs SET created_at='2026-10-01 01:00:00' WHERE id IN (?,?)").run(one.id,three.id);
   f.raw.prepare("UPDATE hq_broadcast_runs SET created_at='2026-11-01 01:00:00' WHERE id=?").run(two.id);
   const page=await call('/api/hq/broadcasts?from=2026-10-01&to=2026-10-31&q=%E7%A7%8B&limit=1');expect(page.status).toBe(200);const b=await page.json() as HqListResponse;
   expect(b.data).toHaveLength(1);expect(b.data[0].selectable).toBe(true);expect(b.pagination).toMatchObject({total:2,nextCursor:'1'});expect(b.statusCounts).toMatchObject({all:2,draft:1,pending_approval:1});
   const pending=await (await call('/api/hq/broadcasts?status=pending_approval')).json() as HqListResponse;expect(pending.data.map(r=>r.id)).toEqual([three.id]);
   expect((await call('/api/hq/broadcasts?from=2026-02-30')).status).toBe(400);expect((await call('/api/hq/broadcasts?limit=0')).status).toBe(400);
 });
 it('複製は承認と予約日を引き継がず下書きだけ作り、押し直しでも増えない',async()=>{
   const source=await made();const body={requestId:'duplicate-draft',expectedVersion:source.version};
   const first=await call(`/api/hq/broadcasts/${source.id}/duplicate`,'POST',body);expect(first.status).toBe(201);const a=(await first.json() as HqRunResponse).data;
   expect(a).toMatchObject({status:'prepared',scheduledAt:null,sent:0,input:{saveAsDraft:true}});
   expect((await (await call(`/api/hq/broadcasts/${source.id}/duplicate`,'POST',body)).json() as HqRunResponse).data.id).toBe(a.id);
   expect((f.raw.prepare('SELECT COUNT(*) n FROM broadcasts').get() as {n:number}).n).toBe(0);
   expect((await call(`/api/hq/broadcasts/${source.id}/duplicate`,'POST',{...body,expectedVersion:0})).status).toBe(409);
 });
 async function sentWithLink() {
   const run=await made();
   f.raw.prepare("INSERT INTO broadcasts(id,title,message_type,message_content,status,line_account_id,hq_run_id,sent_at,total_count,success_count,track_links) VALUES ('sent-child','元配信','text','本文','sent','shop',?,'2026-10-01T10:00:00+09:00',2,2,1)").run(run.id);
   f.raw.prepare("UPDATE hq_broadcast_targets SET broadcast_id='sent-child' WHERE run_id=?").run(run.id);
   f.raw.prepare("UPDATE hq_broadcast_runs SET status='scheduled' WHERE id=?").run(run.id);
   f.raw.exec("INSERT INTO friends(id,line_user_id,line_account_id) VALUES('clicked','U-clicked','shop');INSERT INTO tracked_links(id,name,original_url,line_account_id) VALUES('tracked','商品','https://example.com','shop');INSERT INTO broadcast_tracked_links(broadcast_id,tracked_link_id,label,created_at) VALUES('sent-child','tracked','商品','2026-10-01');INSERT INTO link_clicks(id,tracked_link_id,friend_id,clicked_at) VALUES('click','tracked','clicked','2026-10-01T11:00:00+09:00');INSERT INTO messages_log(id,friend_id,direction,message_type,content,broadcast_id,line_account_id) VALUES('log1','friend','outgoing','text','本文','sent-child','shop'),('log2','clicked','outgoing','text','本文','sent-child','shop')");
   return run;
 }
 it('追送は届いて押していない人だけの下書きを作り、送信とテスト送信はしない',async()=>{
   const source=await sentWithLink();
   const r=await call(`/api/hq/broadcasts/${source.id}/followup`,'POST',{requestId:'followup-draft',expectedVersion:1});expect(r.status,await r.clone().text()).toBe(201);
   const b=(await r.json() as HqRunResponse).data;expect(globalThis.fetch).not.toHaveBeenCalled();expect(b).toMatchObject({status:'prepared',sent:0,followupAudienceCount:1,input:{followupOfRunId:source.id,targetType:'segment'}});
   // 下書き保存後も、送信時にアカウント別の送信元を再解決する。
   const {resolveHqBroadcastAudience,countHqAudience}=await import('../features/hq-broadcasts/hq-broadcast-audience.js');
   const condition=await resolveHqBroadcastAudience(f.db,tenant,'shop',b.input);expect(await countHqAudience(f.db,'shop',condition)).toEqual({count:1,consentExcluded:0});
   expect((f.raw.prepare('SELECT COUNT(*) n FROM broadcasts').get() as {n:number}).n).toBe(1);
   actor('owner',true);expect((await call(`/api/hq/broadcasts/${source.id}/followup`,'POST',{requestId:'forbidden',expectedVersion:1})).status).toBe(403);
 });
 it('追送人数は配信を止めた人を除いた数値を返す',async()=>{
   const source=await sentWithLink();
   f.raw.exec("INSERT INTO friend_delivery_consents(line_account_id,friend_id,purpose,state,reason,source) VALUES('shop','friend','marketing','revoked','本人希望','manual');INSERT INTO friends(id,line_user_id,line_account_id) VALUES('allowed-followup','U-followup','shop');INSERT INTO messages_log(id,friend_id,direction,message_type,content,broadcast_id,line_account_id) VALUES('log3','allowed-followup','outgoing','text','本文','sent-child','shop')");
   const r=await call(`/api/hq/broadcasts/${source.id}/followup`,'POST',{requestId:'followup-consent',expectedVersion:1});
   expect(r.status,await r.clone().text()).toBe(201);
   const b=(await r.json() as HqRunResponse).data;
   expect(b).toMatchObject({followupAudienceCount:1,followupAudience:[{accountId:'shop',count:1}],sent:0});
   const {resolveHqBroadcastAudience,countHqAudience}=await import('../features/hq-broadcasts/hq-broadcast-audience.js');
   expect(await countHqAudience(f.db,'shop',await resolveHqBroadcastAudience(f.db,tenant,'shop',b.input))).toEqual({count:1,consentExcluded:1});
   expect(globalThis.fetch).not.toHaveBeenCalled();
 });
 it('計測のない追送と別組織の追送元は断り、少人数の反応は未取得表示にする',async()=>{
   const source=await sentWithLink();const reactions=await call(`/api/hq/broadcasts/${source.id}/reactions`);expect(reactions.status).toBe(200);
   const b=(await reactions.json() as ReactionResponse).data;expect(b.links[0]).toMatchObject({uniqueClickCount:null,clickCount:null,suppressed:true});expect(b.blockCount).toBeNull();
   f.raw.exec("UPDATE broadcasts SET track_links=0 WHERE id='sent-child'");expect((await call(`/api/hq/broadcasts/${source.id}/followup`,'POST',{requestId:'no-track',expectedVersion:1})).status).toBe(409);
   f.raw.exec("INSERT INTO tenants(id,name) VALUES('other','Other')");f.raw.prepare("UPDATE hq_broadcast_runs SET tenant_id='other' WHERE id=?").run(source.id);
   expect((await call(`/api/hq/broadcasts/${source.id}/reactions`)).status).toBe(404);
 });
 it('反応は送信成功者だけの14日間を数え、20人以上なら人数・回数・率を返す',async()=>{
   const source=await sentWithLink();
   for(let n=0;n<20;n++){
     f.raw.prepare("INSERT INTO friends(id,line_user_id,line_account_id) VALUES (?,?,'shop')").run(`react${n}`,`U-react${n}`);
     f.raw.prepare("INSERT INTO broadcast_send_claims(broadcast_id,friend_id,line_account_id,state) VALUES ('sent-child',?,'shop','sent')").run(`react${n}`);
     f.raw.prepare("INSERT INTO link_clicks(id,tracked_link_id,friend_id,clicked_at) VALUES (?,'tracked',?,'2026-10-02T00:00:00+09:00')").run(`click${n}`,`react${n}`);
   }
   f.raw.exec("INSERT INTO link_clicks(id,tracked_link_id,friend_id,clicked_at) VALUES ('again','tracked','react0','2026-10-03T00:00:00+09:00'),('too-late','tracked','react0','2026-10-15T10:00:00+09:00'),('too-early','tracked','react0','2026-09-01T00:00:00+09:00')");
   const result=await (await call(`/api/hq/broadcasts/${source.id}/reactions`)).json() as ReactionResponse;
   expect(result.data.links[0]).toMatchObject({uniqueClickCount:20,clickCount:21,clickRate:100,suppressed:false});
   f.raw.exec("INSERT INTO analytics_event_coverage(line_account_id,event_type,available_from,state,updated_at) VALUES ('shop','friend_unfollow','2026-09-01T00:00:00+09:00','available','2026-10-01');INSERT INTO analytics_events(id,line_account_id,friend_id,event_type,source_kind,source_id,occurred_at,idempotency_key) VALUES ('blocked','shop','react0','friend_unfollow','line_webhook','evt','2026-10-02T00:00:00+09:00','block1'),('blocked-again','shop','react0','friend_unfollow','line_webhook','evt2','2026-10-03T00:00:00+09:00','block2'),('late-block','shop','react1','friend_unfollow','line_webhook','evt3','2026-10-15T10:00:00+09:00','block3')");
   const blocked=await (await call(`/api/hq/broadcasts/${source.id}/reactions`)).json() as ReactionResponse;
   expect(blocked.data).toMatchObject({blockCount:1,blockCountState:'available'});
   f.raw.exec("UPDATE analytics_event_coverage SET state='partial'");
   expect((await (await call(`/api/hq/broadcasts/${source.id}/reactions`)).json() as ReactionResponse).data.blockCount).toBeNull();

 });
 it('送信枠は未計測ならnull、15分以内の同じアカウントの計測だけを足す',async()=>{
   expect((await (await call('/api/hq/broadcasts/quota')).json() as QuotaResponse).data.remaining).toBeNull();
   const now=new Date().toISOString();f.raw.prepare("INSERT INTO operation_health_runs(id,scope_key,line_account_id,window_started_at,source,status,overall_status,started_at) VALUES('health','shop','shop',?,'scheduled','completed','normal',?)").run(now,now);
   f.raw.prepare("INSERT INTO operation_health_results(id,run_id,check_key,status,summary,value_json,source,observed_at) VALUES('quota','health','message_quota','normal','計測',?,'line_messaging_api',?)").run(JSON.stringify({line:{remaining:70,used:30,limit:100}}),now);
   const result=await (await call('/api/hq/broadcasts/quota')).json() as QuotaResponse;expect(result.data).toMatchObject({remaining:70,used:30,limit:100});
   f.raw.exec("UPDATE operation_health_results SET observed_at='2020-01-01T00:00:00Z'");expect((await (await call('/api/hq/broadcasts/quota')).json() as QuotaResponse).data.remaining).toBeNull();
 });
});

it('店別の公開済み後処理を保存・確認・送信へ固定し、他店・取消・対象外の指定を拒む',async()=>{
 f.raw.exec(`INSERT INTO common_actions(id,line_account_id,name,status) VALUES('action','shop','配信後','published');
 INSERT INTO common_action_versions(id,common_action_id,version_number,status,action_config) VALUES('actions-v1','action',1,'published','[{"id":"s1","type":"start_scenario","params":{"scenarioId":"scenario1"}},{"id":"s2","type":"start_scenario","params":{"scenarioId":"scenario2"}}]');`);
 const madeRun=await made({afterActionVersionIds:{shop:'actions-v1'}});
 expect((await (await call(`/api/hq/broadcasts/${madeRun.id}/preflight`,'POST',{})).json() as {data:Array<{afterAction:{versionId:string;actionCount:number;versionNumber:number}}>}).data[0].afterAction).toMatchObject({versionId:'actions-v1',actionCount:2,versionNumber:1});
 expect((await call('/api/hq/broadcasts','POST',draft('bad-scope',{afterActionVersionIds:{foreign:'actions-v1'}}))).status).toBe(400);
 expect((await call('/api/hq/broadcasts','POST',draft('bad-version',{afterActionVersionId:'missing'}))).status).toBe(409);
 f.raw.exec("UPDATE common_actions SET status='archived' WHERE id='action'");
 expect((await call(`/api/hq/broadcasts/${madeRun.id}/send`,'POST',{expectedVersion:1},true)).status).toBe(409);
 expect(f.raw.prepare('SELECT count(*) n FROM broadcasts').get()).toEqual({n:0});
 f.raw.exec("UPDATE common_actions SET status='published' WHERE id='action'");
 expect((await call(`/api/hq/broadcasts/${madeRun.id}/send`,'POST',{expectedVersion:1},true)).status).toBe(200);
 expect(f.raw.prepare('SELECT after_action_version_id FROM broadcasts').get()).toEqual({after_action_version_id:'actions-v1'});
 expect(f.raw.prepare('SELECT count(*) n FROM broadcast_after_action_runs').get()).toEqual({n:0});
 const child=f.raw.prepare('SELECT id FROM broadcasts').get() as {id:string};
 f.raw.prepare("INSERT INTO broadcast_send_claims(broadcast_id,friend_id,line_account_id,state) VALUES(?,'friend','shop','sent')").run(child.id);
 const start=vi.fn(async(_context:AutomationActionContext)=>{});
 expect(await processBroadcastAfterActions(f.db,{broadcastId:child.id,executors:{start_scenario:start}})).toMatchObject({done:2,failed:0});
 expect(start.mock.calls.map(([context])=>context.action.params.scenarioId)).toEqual(['scenario1','scenario2']);
 await processBroadcastAfterActions(f.db,{broadcastId:child.id,executors:{start_scenario:start}});expect(start).toHaveBeenCalledTimes(2);
});
it('UNS-19: send-previewは外へ照会せず、統括の合計と店ごとの内訳・承認閾値をそろえる',async()=>{
 const r=await made();vi.mocked(fetch).mockClear();
 const response=await call(`/api/hq/broadcasts/${r.id}/send-preview`);expect(response.status).toBe(200);
 const data=(await response.json() as any).data;
 expect(data.recipients).toBe(1);expect(data.perAccount.reduce((n:number,p:any)=>n+p.recipients,0)).toBe(data.recipients);expect(data.needsApproval).toBe(false);expect(fetch).not.toHaveBeenCalled();
});

it('統括テスト送信は確認後に宛先のLINE連携先が変われば409で誰にも送らない',async()=>{
 f.raw.exec(`INSERT INTO account_settings(line_account_id,key,value) VALUES('shop','test_recipients','["friend"]')`);
 const run=await made({messageBubbles:[{id:'one',type:'text',content:{text:'本文'}}]});
 const preview=await call('/api/hq/broadcasts/test-recipients?accountId=shop');expect(preview.status).toBe(200);
 const before=(await preview.json() as any).data;expect(before.count).toBe(1);expect(before.token).toEqual(expect.any(String));
 f.raw.exec("UPDATE friends SET line_user_id='U-changed' WHERE id='friend'");vi.mocked(fetch).mockClear();
 const response=await call(`/api/hq/broadcasts/${run.id}/test-send`,'POST',{accountId:'shop',expectedRecipientToken:before.token});
 expect(response.status).toBe(409);expect(await response.json()).toMatchObject({code:'HQ_TEST_RECIPIENT_CHANGED',data:{count:1}});
 expect(vi.mocked(fetch).mock.calls.filter(([u])=>String(u).endsWith('/message/push'))).toHaveLength(0);
 expect((f.raw.prepare("SELECT COUNT(*) n FROM messages_log WHERE delivery_type='test'").get() as any).n).toBe(0);
});

it('テスト送信直前に宛先が変わっても新旧どちらにも送らない',async()=>{
 f.raw.exec(`INSERT INTO account_settings(line_account_id,key,value) VALUES('shop','test_recipients','["friend"]')`);
 const run=await made({messageBubbles:[{id:'one',type:'text',content:{text:'本文'}}]});
 const before=(await (await call('/api/hq/broadcasts/test-recipients?accountId=shop')).json() as any).data;
 const prepare=f.db.prepare.bind(f.db);let reads=0;
 const spy=vi.spyOn(f.db,'prepare').mockImplementation(sql=>{
  if(sql.includes("key='test_recipients'")&&++reads===2)f.raw.exec("UPDATE friends SET line_user_id='U-changed' WHERE id='friend'");
  return prepare(sql);
 });
 try{
  vi.mocked(fetch).mockClear();const response=await call(`/api/hq/broadcasts/${run.id}/test-send`,'POST',{accountId:'shop',expectedRecipientToken:before.token});
  expect(reads).toBe(2);expect(response.status).toBe(409);
  expect(vi.mocked(fetch).mock.calls.filter(([u])=>String(u).endsWith('/message/push'))).toHaveLength(0);
 }finally{spy.mockRestore();}
});

it('同じテスト宛先なら確認情報つきでも1回送り、旧呼び出しも受け付ける',async()=>{
 f.raw.exec(`INSERT INTO account_settings(line_account_id,key,value) VALUES('shop','test_recipients','["friend"]')`);
 const run=await made({messageBubbles:[{id:'one',type:'text',content:{text:'本文'}}]});
 const before=(await (await call('/api/hq/broadcasts/test-recipients?accountId=shop')).json() as any).data;
 vi.mocked(fetch).mockClear();expect((await call(`/api/hq/broadcasts/${run.id}/test-send`,'POST',{accountId:'shop',expectedRecipientToken:before.token})).status).toBe(200);
 expect(vi.mocked(fetch).mock.calls.filter(([u])=>String(u).endsWith('/message/push'))).toHaveLength(1);
 f.raw.exec("DELETE FROM hq_broadcast_audit WHERE action='test_send'");vi.mocked(fetch).mockClear();
 expect((await call(`/api/hq/broadcasts/${run.id}/test-send`,'POST',{accountId:'shop'})).status).toBe(200);
 expect(vi.mocked(fetch).mock.calls.filter(([u])=>String(u).endsWith('/message/push'))).toHaveLength(1);
});

it('統括配信は人数が同じでも確認後に対象者が入れ替わったら送らず409を返す',async()=>{
 const run=await made();
 const preview=await call(`/api/hq/broadcasts/${run.id}/send-preview`);expect(preview.status).toBe(200);
 const data=(await preview.json() as any).data;
 expect(data.perAccount[0].recipientToken).toEqual(expect.any(String));
 f.raw.exec("UPDATE friends SET is_following=0 WHERE id='friend'; INSERT INTO friends(id,line_user_id,line_account_id) VALUES('other','U-other','shop')");vi.mocked(fetch).mockClear();
 const confirmedAudiences=data.perAccount.map((p:any)=>({accountId:p.accountId,recipientCount:p.recipients,recipientToken:p.recipientToken}));
 const response=await call(`/api/hq/broadcasts/${run.id}/send`,'POST',{expectedVersion:run.version,confirmedAudiences},true);
 expect(response.status).toBe(409);
 expect((await response.json() as any).data.count).toBe(1);
 expect(f.raw.prepare('SELECT COUNT(*) n FROM broadcasts').get()).toEqual({n:0});
 expect(vi.mocked(fetch).mock.calls.filter(([u])=>/\/message\/(push|multicast|broadcast)$/.test(String(u)))).toHaveLength(0);
});

it('統括配信の受付直前に対象者が変わっても一店舗も配信を作らない',async()=>{
 const run=await made();const preview=(await (await call(`/api/hq/broadcasts/${run.id}/send-preview`)).json() as any).data;
 const confirmedAudiences=preview.perAccount.map((p:any)=>({accountId:p.accountId,recipientCount:p.recipients,recipientToken:p.recipientToken}));
 const batch=f.db.batch.bind(f.db);let injected=false;
 const spy=vi.spyOn(f.db,'batch').mockImplementation(async statements=>{
  if(!injected){injected=true;f.raw.exec("UPDATE friends SET is_following=0 WHERE id='friend'; INSERT INTO friends(id,line_user_id,line_account_id) VALUES('other','U-other','shop')");}
  return batch(statements);
 });
 try{
  const response=await call(`/api/hq/broadcasts/${run.id}/send`,'POST',{expectedVersion:run.version,confirmedAudiences},true);
  expect(injected).toBe(true);expect(response.status).toBe(409);
  expect((await response.json() as any).data.count).toBe(1);
  expect(f.raw.prepare('SELECT COUNT(*) n FROM broadcasts').get()).toEqual({n:0});
  expect(f.raw.prepare('SELECT status,version FROM hq_broadcast_runs WHERE id=?').get(run.id)).toEqual({status:'prepared',version:run.version});
 }finally{spy.mockRestore()}
});

it('統括配信の受付直前に対象が増えたら確認した人数のまま処理を始めない',async()=>{
 const run=await made();const preview=(await (await call(`/api/hq/broadcasts/${run.id}/send-preview`)).json() as any).data;
 const confirmedAudiences=preview.perAccount.map((p:any)=>({accountId:p.accountId,recipientCount:p.recipients,recipientToken:p.recipientToken}));
 const batch=f.db.batch.bind(f.db);let injected=false;
 const spy=vi.spyOn(f.db,'batch').mockImplementation(async statements=>{if(!injected){injected=true;f.raw.exec("INSERT INTO friends(id,line_user_id,line_account_id) VALUES('late','U-late','shop')");}return batch(statements)});
 try{
  const response=await call(`/api/hq/broadcasts/${run.id}/send`,'POST',{expectedVersion:run.version,confirmedAudiences},true);
  expect(injected).toBe(true);expect(response.status).toBe(409);expect((await response.json() as any).data.count).toBe(2);
  expect(f.raw.prepare('SELECT COUNT(*) n FROM broadcasts').get()).toEqual({n:0});
 }finally{spy.mockRestore()}
});

it('統括配信の受付直前に同じ友だちのLINE宛先が変わっても409で受け付けない',async()=>{
 const run=await made();const preview=(await (await call(`/api/hq/broadcasts/${run.id}/send-preview`)).json() as any).data;
 const confirmedAudiences=preview.perAccount.map((p:any)=>({accountId:p.accountId,recipientCount:p.recipients,recipientToken:p.recipientToken}));
 const batch=f.db.batch.bind(f.db);let injected=false;
 const spy=vi.spyOn(f.db,'batch').mockImplementation(async statements=>{if(!injected){injected=true;f.raw.exec("UPDATE friends SET line_user_id='U-changed' WHERE id='friend'");}return batch(statements)});
 try{
  const response=await call(`/api/hq/broadcasts/${run.id}/send`,'POST',{expectedVersion:run.version,confirmedAudiences},true);
  expect(injected).toBe(true);expect(response.status).toBe(409);expect(f.raw.prepare('SELECT COUNT(*) n FROM broadcasts').get()).toEqual({n:0});
 }finally{spy.mockRestore()}
});

it('送信受付済みの古い確認は409を返し、従来の再呼出しは受け付ける',async()=>{
 const run=await made();const preview=(await (await call(`/api/hq/broadcasts/${run.id}/send-preview`)).json() as any).data;
 const confirmedAudiences=preview.perAccount.map((p:any)=>({accountId:p.accountId,recipientCount:p.recipients,recipientToken:p.recipientToken}));
 expect((await call(`/api/hq/broadcasts/${run.id}/send`,'POST',{expectedVersion:run.version},true)).status).toBe(200);
 const stale=await call(`/api/hq/broadcasts/${run.id}/send`,'POST',{expectedVersion:run.version,confirmedAudiences},true);
 expect(stale.status).toBe(409);expect((await stale.json() as any).data.count).toBe(1);
 expect((await call(`/api/hq/broadcasts/${run.id}/send`,'POST',{expectedVersion:run.version},true)).status).toBe(200);
 expect(f.raw.prepare('SELECT COUNT(*) n FROM broadcasts').get()).toEqual({n:1});
});
