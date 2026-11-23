import {beforeEach,afterEach,expect,test,vi} from 'vitest';
import {gapFixture,gapApp,gapCall,gapOwner} from '../test-utils/gap1.js';
import {inboxSla} from './inbox-sla.js';
import {assignInbox} from '../services/inbox-assignment.js';
let d:ReturnType<typeof gapFixture>;
beforeEach(()=>{d=gapFixture();d.raw.exec(`INSERT INTO chats(id,friend_id,status,last_customer_message_at,created_at,updated_at) VALUES('c','f','unread','2026-10-16T04:00:00Z','now','now'); INSERT INTO staff_presence(staff_id,away,last_seen_at) VALUES('s',0,'2026-10-16T04:00:00Z');`);});
afterEach(()=>{d.raw.close();vi.restoreAllMocks();});
const app=()=>gapApp(d,[inboxSla]);
const body={strategy:'even',targets:[{staffId:'s',priority:1,cap:1}],enabled:true,firstResponseMinutes:30,businessHoursOnly:false,expectedVersion:0};
test('SLA-01/02/08: 保存では付けず、受信時に一度だけ担当・記録を同時に確定',async()=>{
 const external=vi.spyOn(globalThis,'fetch');expect((await gapCall(app(),'/api/inbox/routing-settings?account_id=a','PUT',body)).status).toBe(200);
 expect(d.raw.prepare("SELECT assignee_staff_id FROM chats WHERE id='c'").get()).toEqual({assignee_staff_id:null});
 expect(await assignInbox(d.db,'a','f',new Date('2026-10-16T04:01:00Z'))).toBe(true);
 expect(await assignInbox(d.db,'a','f',new Date('2026-10-16T04:01:00Z'))).toBe(false);
 expect(d.raw.prepare('SELECT staff_id,strategy FROM inbox_assignment_logs').all()).toEqual([{staff_id:'s',strategy:'even'}]);expect(external).not.toHaveBeenCalled();
});
test.each(['priority','random_weighted'])('SLA-03/04/06: %sは不在・上限に渡さない',async strategy=>{
 expect((await gapCall(app(),'/api/inbox/routing-settings?account_id=a','PUT',{...body,strategy})).status).toBe(200);
 d.raw.exec("UPDATE staff_presence SET away=1");expect(await assignInbox(d.db,'a','f',new Date('2026-10-16T04:01:00Z'))).toBe(false);
 d.raw.exec("UPDATE staff_presence SET away=0; INSERT INTO chats(id,friend_id,assignee_staff_id,status,last_customer_message_at,created_at,updated_at) VALUES('c2','f2','s','unread','2026-10-16T04:00:00Z','now','now')");expect(await assignInbox(d.db,'a','f',new Date('2026-10-16T04:01:00Z'))).toBe(false);
});
test('SLA-17/18/19: 閲覧と他店を拒否し、古い版で対象者も上書きしない',async()=>{
 const path='/api/inbox/routing-settings?account_id=a';expect((await gapCall(app(),path,'PUT',body)).status).toBe(200);
 expect((await gapCall(app(),path,'PUT',{...body,strategy:'priority',targets:[]})).status).toBe(409);
 expect(((await (await gapCall(app(),path)).json()) as {data:{strategy:string}}).data.strategy).toBe('even');
 expect((await gapCall(gapApp(d,[inboxSla],{...gapOwner,readOnly:true}),path,'PUT',body)).status).toBe(403);
 expect((await gapCall(app(),path.replace('=a','=b'),'PUT',body)).status).toBe(404);
});

test.each(['even','priority','random_weighted'])('SLA-01/03/04: %s は対象者の順・件数・重みから正しい人へ振り分ける',async strategy=>{
 d.raw.exec("INSERT INTO staff_presence(staff_id,away,last_seen_at) VALUES('o',0,'2026-10-16T04:00:00Z'); INSERT INTO inbox_assignment_logs(id,account_id,chat_id,staff_id,strategy,decided_at,mutation_token) VALUES('old','a','c','s','even','2026-10-16T03:00:00Z','old')");
 expect((await gapCall(app(),'/api/inbox/routing-settings?account_id=a','PUT',{...body,strategy,targets:[{staffId:'s',priority:1,cap:10},{staffId:'o',priority:100,cap:10}]})).status).toBe(200);
 expect(await assignInbox(d.db,'a','f',new Date('2026-10-16T04:01:00Z'),()=>strategy==='random_weighted'?0.999:0)).toBe(true);
 expect(d.raw.prepare("SELECT assignee_staff_id FROM chats WHERE id='c'").get()).toEqual({assignee_staff_id:strategy==='priority'?'s':'o'});
});
test('自動割当の設定後にトークの権限を失った担当者は選ばない',async()=>{
 expect((await gapCall(app(),'/api/inbox/routing-settings?account_id=a','PUT',body)).status).toBe(200);
 d.raw.exec("UPDATE staff_members SET permission_keys='[]' WHERE id='s'");
 expect(await assignInbox(d.db,'a','f',new Date('2026-10-16T04:01:00Z'))).toBe(false);
 expect(d.raw.prepare("SELECT assignee_staff_id FROM chats WHERE id='c'").get()).toEqual({assignee_staff_id:null});
});

test('割当できない同じ未対応期間は店内の知らせを一度だけ作り、他店へ出さない',async()=>{
 expect((await gapCall(app(),'/api/inbox/routing-settings?account_id=a','PUT',body)).status).toBe(200);
 d.raw.exec("UPDATE staff_presence SET away=1");
 const external=vi.spyOn(globalThis,'fetch');
 expect(await assignInbox(d.db,'a','f',new Date('2026-10-16T04:01:00Z'))).toBe(false);
 expect(await assignInbox(d.db,'a','f',new Date('2026-10-16T04:02:00Z'))).toBe(false);
 expect(d.raw.prepare("SELECT line_account_id,channel,event_type FROM notifications WHERE event_type='inbox_assignment_unavailable'").all()).toEqual([{line_account_id:'a',channel:'dashboard',event_type:'inbox_assignment_unavailable'}]);
 expect(d.raw.prepare("SELECT assignee_staff_id FROM chats WHERE id='c'").get()).toEqual({assignee_staff_id:null});
 expect(external).not.toHaveBeenCalled();
});
test('営業時間外に担当できない時は責任者へ知らせを出さない',async()=>{
 expect((await gapCall(app(),'/api/inbox/routing-settings?account_id=a','PUT',body)).status).toBe(200);
 d.raw.exec("UPDATE staff_presence SET away=1");
 expect(await assignInbox(d.db,'a','f',new Date('2026-10-15T23:00:00Z'))).toBe(false);
 expect(d.raw.prepare("SELECT count(*) n FROM notifications WHERE event_type='inbox_assignment_unavailable'").get()).toEqual({n:0});
});
test('割当を使わない店や既に担当のある会話は割当不能の知らせを出さない',async()=>{
 expect(await assignInbox(d.db,'a','f',new Date('2026-10-16T04:01:00Z'))).toBe(false);
 expect((await gapCall(app(),'/api/inbox/routing-settings?account_id=a','PUT',body)).status).toBe(200);
 d.raw.exec("UPDATE chats SET assignee_staff_id='s' WHERE id='c'");
 expect(await assignInbox(d.db,'a','f',new Date('2026-10-16T04:01:00Z'))).toBe(false);
 expect(d.raw.prepare("SELECT count(*) n FROM notifications WHERE event_type='inbox_assignment_unavailable'").get()).toEqual({n:0});
});
test('操作時刻の更新は不在を解除せず、他人の不在も変更しない',async()=>{
 d.raw.exec("UPDATE staff_presence SET away=1 WHERE staff_id='s'");
 const asStaff=gapApp(d,[inboxSla],{...gapOwner,id:'s',role:'staff'});
 expect((await gapCall(asStaff,'/api/me/presence','PUT',{heartbeat:true})).status).toBe(200);
 expect(d.raw.prepare("SELECT away FROM staff_presence WHERE staff_id='s'").get()).toEqual({away:1});
 expect((await (await gapCall(asStaff,'/api/me/presence')).json()) as unknown).toMatchObject({data:{away:true}});
 expect((await gapCall(asStaff,'/api/me/presence','PUT',{away:false})).status).toBe(200);
 expect(d.raw.prepare("SELECT away FROM staff_presence WHERE staff_id='s'").get()).toEqual({away:0});
});
test('担当を無効化すると未完了の会話を未割当に戻し、他の担当は変えない',async()=>{
 d.raw.exec("UPDATE chats SET assignee_staff_id='s',assigned_by='auto' WHERE id='c'; INSERT INTO chats(id,friend_id,assignee_staff_id,status,created_at,updated_at) VALUES('c2','f2','o','unread','now','now'); UPDATE staff_members SET is_active=0 WHERE id='s'");
 expect(d.raw.prepare("SELECT assignee_staff_id,assigned_by FROM chats WHERE id='c'").get()).toEqual({assignee_staff_id:null,assigned_by:null});
 expect(d.raw.prepare("SELECT assignee_staff_id FROM chats WHERE id='c2'").get()).toEqual({assignee_staff_id:'o'});
});
test('候補選択後に担当が無効化された場合は割り当てない',async()=>{
 expect((await gapCall(app(),'/api/inbox/routing-settings?account_id=a','PUT',body)).status).toBe(200);
 const original=d.db.batch.bind(d.db);
 vi.spyOn(d.db,'batch').mockImplementation(async statements=>{
  d.raw.exec("UPDATE staff_members SET is_active=0 WHERE id='s'");
  return original(statements);
 });
 expect(await assignInbox(d.db,'a','f',new Date('2026-10-16T04:01:00Z'))).toBe(false);
 expect(d.raw.prepare("SELECT assignee_staff_id FROM chats WHERE id='c'").get()).toEqual({assignee_staff_id:null});
});
