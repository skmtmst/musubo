import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {Hono} from 'hono';
import {createTestD1,type SqliteD1} from '../test-utils/d1-sqlite.js';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import {createUidMigrationRun} from '@line-crm/db';
import {consentRollbackConflicts,hasSuppressedDeliveryRecipients,isFriendDeliverySuppressed,listFriendDeliveryConsents,suppressionReconciliation} from '@line-crm/db/src/friend-delivery-consents.js';
const scope=vi.hoisted(()=>({allowed:true}));
vi.mock('../services/account-access.js',()=>({canAccessAllLineAccounts:vi.fn(async()=>scope.allowed),getVisibleLineAccountScope:vi.fn(async()=>({allowedAccountIds:['from','to']}))}));
import {friends} from './friends.js';
import {friendMigrations} from './friend-migrations.js';
let fixture:SqliteD1;
const owner={id:'owner-2',name:'確認者',role:'owner',readOnly:false} as AuthenticatedStaff;
function app(staff=owner){const a=new Hono<Env>();a.use('*',async(c,next)=>{c.set('staff',staff);await next();});a.route('/',friends);a.route('/',friendMigrations);return a;}
function req(path:string,body?:unknown,method='POST',staff=owner){return app(staff).request(path,{method,headers:{'content-type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})},{DB:fixture.db} as Env['Bindings']);}
function set(friend:string,state:string,purpose='marketing') {
 const account=friend==='old'?'from':'to';
 fixture.raw.prepare(`INSERT INTO friend_delivery_consents(line_account_id,friend_id,purpose,state,reason,source,updated_by) VALUES(?,?,?,?, '本人からの申告','manual','owner-1')
 ON CONFLICT(line_account_id,friend_id,purpose) DO UPDATE SET state=excluded.state,version=version+1`).run(account,friend,purpose,state);
}
async function migration(create=false) {
 if(create)fixture.raw.exec("DELETE FROM friends WHERE id='new'");
 const r=await createUidMigrationRun(fixture.db,{fromAccountId:'from',toAccountId:'to',purpose:'検証済み引っ越し',sourceKind:'manual',createdBy:'owner-1',mappings:[{oldUid:'U-old',newUid:'U-new',evidenceType:'same_provider'}]});
 fixture.raw.prepare("UPDATE uid_migration_items SET decision=? WHERE run_id=?").run(create?'create':'link',r.id);
 fixture.raw.prepare("UPDATE uid_migration_runs SET status='ready' WHERE id=?").run(r.id);
 return r.id;
}
beforeEach(()=>{
 fixture=createTestD1();scope.allowed=true;
 for(const id of ['from','to','elsewhere'])fixture.raw.prepare("INSERT INTO line_accounts(id,name,channel_id,channel_secret,channel_access_token) VALUES(?,?,?,?,?)").run(id,id,id,'secret','token');
 fixture.raw.exec("INSERT INTO friends(id,line_user_id,line_account_id,display_name,is_following) VALUES('old','U-old','from','旧',1),('new','U-new','to','新',1),('other','U-other','elsewhere','担当外',1)");
});
afterEach(()=>fixture.raw.close());
describe('配信停止・同意のAPIとUID移行（実SQLite）',()=>{
 it('理由・操作元・操作者・版を保存し、古い版や二重作成は409',async()=>{
  const path='/api/friends/new/delivery-consents/marketing';
  const b={state:'revoked',reason:'本人が停止を希望',expectedVersion:0};
  expect((await req(path,b,'PUT')).status).toBe(200);
  expect(await listFriendDeliveryConsents(fixture.db,'new')).toMatchObject([{state:'revoked',reason:b.reason,source:'manual',updatedBy:'owner-2',version:1}]);
  expect((await req(path,b,'PUT')).status).toBe(409);
  expect((await req(path,{...b,state:'granted',expectedVersion:1},'PUT')).status).toBe(200);
  expect((await req(path,{...b,expectedVersion:1},'PUT')).status).toBe(409);
  expect(fixture.raw.prepare('SELECT COUNT(*) n FROM friend_delivery_consent_events').get()).toEqual({n:2});
 });
 it.each([{state:'invalid',reason:'理由',expectedVersion:0},{state:'granted',reason:' ',expectedVersion:0},{state:'granted',reason:'理由',expectedVersion:-1},{state:{},reason:'理由',expectedVersion:0}])('入力不正を400にする %j',async body=>{
  expect((await req('/api/friends/new/delivery-consents/marketing',body,'PUT')).status).toBe(400);
 });
 it('閲覧のみとstaffの変更を拒否し、担当外を隠す',async()=>{
  const b={state:'revoked',reason:'理由',expectedVersion:0},path='/api/friends/new/delivery-consents/marketing';
  expect((await req(path,b,'PUT',{...owner,readOnly:true})).status).toBe(403);
  expect((await req(path,b,'PUT',{...owner,role:'staff'})).status).toBe(403);
  scope.allowed=false;
  expect((await req(path,b,'PUT')).status).toBe(404);
  expect((await req('/api/friends/new/delivery-consents',undefined,'GET')).status).toBe(404);
  expect((await listFriendDeliveryConsents(fixture.db,'new'))).toEqual([]);
 });
 it.each([['revoked','granted','revoked'],['granted','revoked','revoked'],['unknown','granted','unknown'],['granted','unknown','unknown'],['granted','granted','granted'],['revoked',null,'revoked'],['granted',null,'unknown'],[null,'granted','unknown'],[null,null,null]])('厳しい方へ引き継ぐ：%s/%s→%s',async(from,to,expected)=>{
  if(from)set('old',from);if(to)set('new',to);
  const id=await migration();expect((await req(`/api/friends/migrations/${id}/execute`,{})).status).toBe(200);
  expect((await listFriendDeliveryConsents(fixture.db,'new'))[0]?.state??null).toBe(expected);
  expect((await listFriendDeliveryConsents(fixture.db,'old'))[0]?.state??null).toBe(from);
  expect(await isFriendDeliverySuppressed(fixture.db,'new')).toBe(expected==='unknown'||expected==='revoked');
  expect(await suppressionReconciliation(fixture.db,id)).toMatchObject({status:'matched',transferredCount:from==='revoked'?1:0,mismatchCount:0});
  const version=(await listFriendDeliveryConsents(fixture.db,'new'))[0]?.version;
  expect((await req(`/api/friends/migrations/${id}/execute`,{})).status).toBe(409);
  expect((await listFriendDeliveryConsents(fixture.db,'new'))[0]?.version).toBe(version);
  expect((await req(`/api/friends/migrations/${id}/rollback`,{})).status).toBe(200);
  expect((await listFriendDeliveryConsents(fixture.db,'new'))[0]?.state??null).toBe(to);
  expect(await suppressionReconciliation(fixture.db,id)).toMatchObject({status:'rolled_back'});
 });
 it('createでも配信停止を引き継ぎ、切り戻す',async()=>{
  set('old','revoked');const id=await migration(true);
  expect((await req(`/api/friends/migrations/${id}/execute`,{})).status).toBe(200);
  const target=fixture.raw.prepare("SELECT id FROM friends WHERE line_account_id='to' AND line_platform_user_id='U-new'").get() as {id:string};
  expect(await isFriendDeliverySuppressed(fixture.db,target.id)).toBe(true);
  expect((await req(`/api/friends/migrations/${id}/rollback`,{})).status).toBe(200);
  expect(await listFriendDeliveryConsents(fixture.db,target.id)).toEqual([]);
 });
 it('複数目的は人で数え、ページでなく全件を照合。後の同意変更は409で保持',async()=>{
  set('old','revoked');set('old','revoked','news');set('new','granted');
  const id=await migration();await req(`/api/friends/migrations/${id}/execute`,{});
  expect(await suppressionReconciliation(fixture.db,id)).toMatchObject({transferredCount:1,mismatchCount:0});
  set('new','granted');
  const before=fixture.raw.prepare('SELECT id,user_id FROM friends ORDER BY id').all();
  expect(await consentRollbackConflicts(fixture.db,id)).toHaveLength(1);
  expect((await req(`/api/friends/migrations/${id}/rollback`,{})).status).toBe(409);
  expect(fixture.raw.prepare('SELECT id,user_id FROM friends ORDER BY id').all()).toEqual(before);
  const result=await req(`/api/friends/migrations/${id}?limit=1`,undefined,'GET');
  expect(await result.json()).toMatchObject({data:{suppressionReconciliation:{status:'mismatch',transferredCount:1,mismatchCount:1}}});
 });
 it('照合後の競合もDBトリガーで止め、友だちの復元を同じbatchごと戻す',async()=>{
  set('old','revoked');set('new','granted');const id=await migration();await req(`/api/friends/migrations/${id}/execute`,{});
  expect(await consentRollbackConflicts(fixture.db,id)).toEqual([]);
  set('new','unknown');
  await expect(fixture.db.batch([
    fixture.db.prepare("UPDATE friends SET user_id=NULL WHERE id IN ('old','new')"),
    fixture.db.prepare("UPDATE uid_migration_items SET result='rolled_back' WHERE run_id=?").bind(id),
  ])).rejects.toThrow('delivery_consent_conflict');
  expect((fixture.raw.prepare("SELECT user_id FROM friends WHERE id='new'").get() as {user_id:string}).user_id).not.toBeNull();
 });
 it('新しい目的の追記も切り戻し競合。昔の移行はずれなしにしない',async()=>{
  const id=await migration();await req(`/api/friends/migrations/${id}/execute`,{});set('new','granted','new_purpose');
  expect((await req(`/api/friends/migrations/${id}/rollback`,{})).status).toBe(409);
  fixture.raw.prepare("UPDATE uid_migration_items SET after_json='{}' WHERE run_id=?").run(id);
  expect(await suppressionReconciliation(fixture.db,id)).toMatchObject({status:'unavailable',transferredCount:null,mismatchCount:null});
 });
 it('切り戻しで未登録へ戻した後も、再登録の版を巻き戻さない',async()=>{
  set('old','revoked');const id=await migration();await req(`/api/friends/migrations/${id}/execute`,{});
  const oldVersion=(await listFriendDeliveryConsents(fixture.db,'new'))[0].version;
  await req(`/api/friends/migrations/${id}/rollback`,{});
  expect((await req('/api/friends/new/delivery-consents/marketing',{state:'granted',reason:'本人の確認済み',expectedVersion:0},'PUT')).status).toBe(200);
  expect((await listFriendDeliveryConsents(fixture.db,'new'))[0].version).toBeGreaterThan(oldVersion);
  expect((await req('/api/friends/new/delivery-consents/marketing',{state:'granted',reason:'古い画面',expectedVersion:oldVersion},'PUT')).status).toBe(409);
 });
 it('送信停止の判定をアカウントと宛先に閉じる',async()=>{
  set('old','revoked');
  expect(await hasSuppressedDeliveryRecipients(fixture.db,'from',['U-old'])).toBe(true);
  expect(await hasSuppressedDeliveryRecipients(fixture.db,'to',['U-old'])).toBe(false);
  expect(await hasSuppressedDeliveryRecipients(fixture.db,'from',['U-other'])).toBe(false);
  expect(await hasSuppressedDeliveryRecipients(fixture.db,'from',[])).toBe(false);
 });
 it('別アカウントの台帳を挿入できない',()=>{
  expect(()=>fixture.raw.exec("INSERT INTO friend_delivery_consents(line_account_id,friend_id,purpose,state,reason,source) VALUES('to','old','marketing','granted','理由','manual')")).toThrow('delivery_consent_scope');
 });
});
