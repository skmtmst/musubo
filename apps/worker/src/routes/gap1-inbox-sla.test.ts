import {beforeEach,afterEach,expect,test,vi} from 'vitest';
import {inboxSla} from './inbox-sla.js';
import {gapFixture,gapApp,gapCall,gapOwner} from '../test-utils/gap1.js';
import type {SqliteD1} from '../test-utils/d1-sqlite.js';
import {processInboxSla,refreshInboxSla,slaState,businessWindows,slaDeadline} from '../services/inbox-sla.js';
import {upsertChatOnMessage,updateChat} from '@line-crm/db';
import {slaChatList} from '../services/inbox-sla-list.js';
import {Hono} from 'hono';
import type { Env } from '../worker-env.js';
let d:SqliteD1;
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-16T01:00:00Z'));d=gapFixture();});
afterEach(()=>{d.raw.close();vi.useRealTimers();});
const body={enabled:true,firstResponseMinutes:30,businessHoursOnly:false,expectedVersion:0};
const a=()=>gapApp(d,[inboxSla]);
test('SLA-01 SLA-19: 初期オフ、設定の版と並行の保存、勝手に割り当てない',async()=>{
 expect((await (await gapCall(a(),'/api/inbox/routing-settings?account_id=a')).json() as any).data).toMatchObject({enabled:false,version:0});
 expect((await gapCall(a(),'/api/inbox/routing-settings?account_id=a','PUT',body)).status).toBe(200);
 const results=await Promise.all([gapCall(a(),'/api/inbox/routing-settings?account_id=a','PUT',{...body,expectedVersion:1}),gapCall(a(),'/api/inbox/routing-settings?account_id=a','PUT',{...body,expectedVersion:1})]);expect(results.map(r=>r.status).sort()).toEqual([200,409]);
 expect(d.raw.prepare('SELECT strategy FROM inbox_routing_settings').get()).toEqual({strategy:'none'});
});
test('SLA-09 SLA-10: 営業時間の前から30分、週の休みと臨時休業を飛ばす',async()=>{
 d.raw.exec(`UPDATE booking_settings SET business_hours_configured=1 WHERE id='settings';
 INSERT INTO booking_business_hours(id,booking_settings_id,weekday,start_time,end_time,capacity) VALUES('fri','settings',5,'10:00','19:00',1),('sat','settings',6,'10:00','19:00',1);
 INSERT INTO booking_availability_exceptions(id,line_account_id,scope_kind,date_from,date_to,kind) VALUES('closed','a','store','2026-10-17','2026-10-17','closed');`);
 const w=await businessWindows(d.db,'a','2026-10-16T00:40:00Z');
 expect(slaDeadline('2026-10-16T00:40:00Z',30,w)).toBe('2026-10-16T01:30:00.000Z');
 expect(slaState('2026-10-16T01:30:00Z',true,null,Date.parse('2026-10-16T00:40:00Z'),w)).toBe('outside_hours');
 expect(slaState('2026-10-16T01:30:00Z',true,null,Date.parse('2026-10-16T01:15:00Z'),w)).toBe('soon');
 expect(slaState('2026-10-16T01:30:00Z',true,null,Date.parse('2026-10-16T01:31:00Z'),w)).toBe('overdue');
 expect(slaDeadline('2026-10-16T09:50:00Z',30,w)).toBe('2026-10-23T01:20:00.000Z');
});
test('SLA-07 SLA-12 SLA-13: 2通目と自動返信で時計を変えず手動だけで止め、新着で再開',async()=>{
 await gapCall(a(),'/api/inbox/routing-settings?account_id=a','PUT',body);
 const c=await upsertChatOnMessage(d.db,'f');await refreshInboxSla(d.db,'a');
 const first=d.raw.prepare('SELECT pending_since,sla_due_at FROM chats WHERE id=?').get(c.id);
 vi.advanceTimersByTime(5*60000);await upsertChatOnMessage(d.db,'f');
 d.raw.exec("INSERT INTO messages_log(id,friend_id,direction,message_type,content,source,line_account_id) VALUES('auto','f','outgoing','text','自動','auto_reply','a')");
 expect(d.raw.prepare('SELECT pending_since,sla_due_at FROM chats WHERE id=?').get(c.id)).toEqual(first);
 await updateChat(d.db,c.id,{status:'in_progress',lastMessageAt:new Date().toISOString()});
 expect(d.raw.prepare('SELECT first_response_at,sla_due_at FROM chats WHERE id=?').get(c.id)).toEqual({first_response_at:new Date().toISOString(),sla_due_at:null});
 vi.advanceTimersByTime(60000);await upsertChatOnMessage(d.db,'f');await refreshInboxSla(d.db,'a');
 expect((d.raw.prepare('SELECT pending_since,first_response_at FROM chats WHERE id=?').get(c.id) as any).first_response_at).toBeNull();
});
test('SLA-11 SLA-24 SLA-29: 3段の通知は各1回、見回りが遅れたら今の段だけ',async()=>{
 await gapCall(a(),'/api/inbox/routing-settings?account_id=a','PUT',body);await upsertChatOnMessage(d.db,'f');await refreshInboxSla(d.db,'a');
 for(const minutes of [15,15,30,30,60,60]){const now=new Date('2026-10-16T01:00:00Z');now.setMinutes(now.getMinutes()+minutes);await processInboxSla(d.db,now);}
 expect(d.raw.prepare('SELECT COUNT(*) n FROM notifications').get()).toEqual({n:3});
 vi.setSystemTime(new Date('2026-10-16T02:10:00Z'));const c=await upsertChatOnMessage(d.db,'f2');await processInboxSla(d.db,new Date('2026-10-16T04:00:00Z'));
 const notices=d.raw.prepare("SELECT metadata FROM notifications WHERE metadata LIKE ?").all(`%${c.friend_id}%`) as any[];expect(notices).toHaveLength(1);expect(JSON.parse(notices[0].metadata).stage).toBe(3);
});
test('SLA-15 SLA-14: DBで期限順に並べてからページ分割、超過の件数も同じ条件',async()=>{
 await gapCall(a(),'/api/inbox/routing-settings?account_id=a','PUT',body);await upsertChatOnMessage(d.db,'f');vi.advanceTimersByTime(5*60000);await upsertChatOnMessage(d.db,'f2');await refreshInboxSla(d.db,'a');
 d.raw.exec("UPDATE chats SET assignee_staff_id='s' WHERE friend_id='f'");
 const r=new Hono<Env>();r.get('/api/chats',c=>slaChatList(c));const app=gapApp(d,[r]);
 const res=await (await gapCall(app,'/api/chats?sort=sla_due&lineAccountId=a&limit=1')).json() as any;expect(res.data.map((r:any)=>r.friendId)).toEqual(['f']);expect(res.total).toBe(2);expect(res.data[0].operatorName).toBe('担当');
 vi.advanceTimersByTime(26*60000);const over=await (await gapCall(app,'/api/chats?slaState=overdue&lineAccountId=a')).json() as any;expect(over.total).toBe(1);expect(over.data.map((r:any)=>r.friendId)).toEqual(['f']);
});
test('SLA-17 SLA-18: スタッフ・閲覧のみの設定変更と他店の読取を拒否、代理書込モードは許可',async()=>{
 for(const who of [{...gapOwner,role:'staff' as const,id:'s'},{...gapOwner,readOnly:true}])expect((await gapCall(gapApp(d,[inboxSla],who),'/api/inbox/routing-settings?account_id=a','PUT',body)).status).toBe(403);
 expect((await gapCall(gapApp(d,[inboxSla],gapOwner,true),'/api/inbox/routing-settings?account_id=a','PUT',body)).status).toBe(200);
 expect((await gapCall(a(),'/api/inbox/routing-settings?account_id=b')).status).toBe(404);
});
test('期限順の一覧は担当者ごとの既読位置から未読数を数える',async()=>{
 await gapCall(a(),'/api/inbox/routing-settings?account_id=a','PUT',body);await upsertChatOnMessage(d.db,'f');await refreshInboxSla(d.db,'a');
 d.raw.exec(`INSERT INTO messages_log(id,friend_id,direction,message_type,content,line_account_id,created_at) VALUES
 ('old','f','incoming','text','古い','a','2026-10-16T00:00:00.000Z'),
 ('new1','f','incoming','text','新着1','a','2026-10-16T00:30:00.000Z'),
 ('new2','f','incoming','text','新着2','a','2026-10-16T00:40:00.000Z');
 INSERT INTO inbox_staff_reads(staff_id,channel,conversation_id,last_read_at,updated_at) VALUES('o','line','f','2026-10-16T00:00:00.000Z','2026-10-16T01:00:00.000Z');`);
 const r=new Hono<Env>();r.get('/api/chats',c=>slaChatList(c));const app=gapApp(d,[r]);
 const result=await (await gapCall(app,'/api/chats?sort=sla_due&lineAccountId=a')).json() as any;
 expect(result.data.find((row:any)=>row.friendId==='f')).toMatchObject({isUnread:true,unreadCount:2});
});
