import { afterEach,beforeEach,expect,it } from 'vitest';
import { gapFixture,gapApp,gapCall,gapOwner } from '../test-utils/gap1.js';
import { inboxSla } from './inbox-sla.js';
let fixture:ReturnType<typeof gapFixture>;
beforeEach(()=>{fixture=gapFixture();fixture.raw.exec(`
 INSERT INTO friends(id,line_user_id,display_name,line_account_id) VALUES('foreign','Uforeign','別店','b');
 INSERT INTO chats(id,friend_id,status,pending_since,sla_due_at,created_at,updated_at) VALUES
 ('c1','f','unread','2026-10-15T00:00:00.000Z','2026-10-15T00:30:00.000Z','now','now'),
 ('c2','f2','unread','2026-10-15T00:00:00.000Z','2026-10-15T00:10:00.000Z','now','now'),
 ('c3','foreign','unread','2026-10-15T00:00:00.000Z','2026-10-15T00:30:00.000Z','now','now');
 INSERT INTO messages_log(id,friend_id,direction,message_type,content,source,line_account_id,sent_by_staff_id,created_at) VALUES
 ('m1','f','outgoing','text','private','manual','a','s','2026-10-15T00:20:00.000Z'),
 ('m2','f2','outgoing','text','private','manual','a','o','2026-10-15T00:20:00.000Z'),
 ('m3','foreign','outgoing','text','private','manual','b','o','2026-10-15T00:20:00.000Z'),
 ('auto','f','outgoing','text','private','auto_reply','a',NULL,'2026-10-15T00:05:00.000Z');
 UPDATE chats SET first_response_at='2026-10-15T00:20:00.000Z',sla_due_at=NULL WHERE id IN ('c1','c2','c3');
`);});
afterEach(()=>fixture.raw.close());
const path='/api/analytics/inbox-response?account_id=a&from=2026-10-01&to=2026-10-31';
it('担当者と当時の期限を保持し、店単位の中央値と人・自動を分ける',async()=>{
 const res=await gapCall(gapApp(fixture,[inboxSla]),path);expect(res.status).toBe(200);
 const {data}=await res.json() as {data:{byStaff:Array<{staffId:string;count:number;withinSlaRate:number}>,automatic:{count:number},weekly:unknown[]}};
 expect(data.byStaff).toEqual(expect.arrayContaining([expect.objectContaining({staffId:'s',count:1,withinSlaRate:100}),expect.objectContaining({staffId:'o',count:1,withinSlaRate:0})]));
 expect(data.byStaff).toHaveLength(2);expect(data.automatic.count).toBe(1);expect(data.weekly).toHaveLength(1);
 expect(fixture.raw.prepare("SELECT due_at FROM inbox_response_samples WHERE chat_id='c1'").get()).toEqual({due_at:'2026-10-15T00:30:00.000Z'});
});
it('スタッフと閲覧のみは本人分だけを返し、他店は見せない',async()=>{
 for(const staff of [{...gapOwner,id:'s',role:'staff' as const},{...gapOwner,id:'s',readOnly:true}]){
  const res=await gapCall(gapApp(fixture,[inboxSla],staff),path);expect(res.status).toBe(200);
  const {data}=await res.json() as {data:{byStaff:Array<{staffId:string}>,automatic:{count:number|null}}};
  expect(data.byStaff.map(x=>x.staffId)).toEqual(['s']);expect(data.automatic.count).toBeNull();
 }
 expect((await gapCall(gapApp(fixture,[inboxSla]),path.replace('account_id=a','account_id=b'))).status).toBe(404);
});
it('担当を特定できない返信を誤って別の人に割り当てない',async()=>{
 fixture.raw.exec("UPDATE messages_log SET sent_by_staff_id=NULL WHERE id='m1'; DELETE FROM inbox_response_samples WHERE chat_id='c1'; UPDATE chats SET first_response_at=NULL,sla_due_at='2026-10-15T00:30:00.000Z' WHERE id='c1'; UPDATE chats SET first_response_at='2026-10-15T00:20:00.000Z',sla_due_at=NULL WHERE id='c1'");
 expect(fixture.raw.prepare("SELECT responder_staff_id FROM inbox_response_samples WHERE chat_id='c1'").get()).toEqual({responder_staff_id:null});
});
it('同時刻に複数の担当者が返信した場合は担当者を特定しない',()=>{
 fixture.raw.exec("DELETE FROM inbox_response_samples WHERE chat_id='c1'; UPDATE chats SET first_response_at=NULL,sla_due_at='2026-10-15T00:30:00.000Z' WHERE id='c1'; INSERT INTO messages_log(id,friend_id,direction,message_type,content,source,line_account_id,sent_by_staff_id,created_at) VALUES('m4','f','outgoing','text','private','manual','a','o','2026-10-15T00:20:00.000Z'); UPDATE chats SET first_response_at='2026-10-15T00:20:00.000Z',sla_due_at=NULL WHERE id='c1'");
 expect(fixture.raw.prepare("SELECT responder_staff_id FROM inbox_response_samples WHERE chat_id='c1'").get()).toEqual({responder_staff_id:null});
});
it('実際の手動返信の更新で、期限を消す前に返信者と期限を記録する',()=>{
 fixture.raw.exec("DELETE FROM inbox_response_samples WHERE chat_id='c1'; UPDATE chats SET first_response_at=NULL,sla_due_at='2026-10-15T00:30:00.000Z' WHERE id='c1'; UPDATE chats SET last_operator_message_at='2026-10-15T00:20:00.000Z' WHERE id='c1'");
 expect(fixture.raw.prepare("SELECT responder_staff_id,due_at FROM inbox_response_samples WHERE chat_id='c1'").get()).toEqual({responder_staff_id:'s',due_at:'2026-10-15T00:30:00.000Z'});
});
