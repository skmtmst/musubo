import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {gapFixture} from '../test-utils/gap1.js';
import {processInboxSlaPush} from './inbox-sla-push.js';
import type {PushSender} from './operator-push.js';
import {retryOperatorPush} from './operator-push.js';
let d:ReturnType<typeof gapFixture>;
const now=new Date('2026-10-16T04:00:00Z');
const env={DEPLOY_ENV:'staging',INBOX_SLA_PUSH_ENABLED:'true',INBOX_SLA_PUSH_TEST_STAFF_IDS:'["s"]'};
beforeEach(()=>{d=gapFixture();d.raw.exec(`
 INSERT INTO chats(id,friend_id,status,assignee_staff_id,pending_since,sla_due_at,sla_notified_stage,created_at,updated_at) VALUES('chat','f','unread','s','2026-10-16T03:00:00Z','2026-10-16T04:10:00Z',1,'2026-10-16','2026-10-16');
 INSERT INTO notifications(id,event_type,title,body,channel,status,metadata,line_account_id,category,created_at) VALUES('sla:chat:2026-10-16T03:00:00Z:1','inbox_sla','期限','確認','dashboard','sent','{"chatId":"f","staffId":"s","stage":1}','a','info','2026-10-16T04:00:00Z');
 INSERT INTO operator_push_subscriptions(id,staff_id,endpoint,p256dh,auth,user_agent_label,created_at) VALUES('sub','s','https://example.invalid/s','key','auth','端末','2026-10-16');`);});
afterEach(()=>{vi.restoreAllMocks();d.raw.close();});
it('明示された検証環境と対象者だけに通知し、重複しない',async()=>{
 const send=vi.fn<PushSender>(async()=>({status:201,ok:true}));
 for(const disabled of [{},{...env,DEPLOY_ENV:'production'},{...env,INBOX_SLA_PUSH_ENABLED:'false'},{...env,INBOX_SLA_PUSH_TEST_STAFF_IDS:'["other"]'}])await processInboxSlaPush(d.db,disabled,now,send);
 expect(send).not.toHaveBeenCalled();

 await processInboxSlaPush(d.db,env,now,send);await processInboxSlaPush(d.db,env,now,send);
 expect(send).toHaveBeenCalledTimes(1);expect(send.mock.calls[0][1]).toEqual({title:'返事の期限が近づいています',body:'受信箱で確認してください',url:'/chats'});
 expect(d.raw.prepare("SELECT status FROM operator_push_deliveries WHERE kind='inbox_sla'").get()).toEqual({status:'sent'});
});
it('担当変更や外部送信失敗でも画面内通知は残り、送達不明を再送しない',async()=>{
 const send=vi.fn<PushSender>(async()=>{throw new Error('network');});
 await processInboxSlaPush(d.db,env,now,send);await processInboxSlaPush(d.db,env,now,send);
 expect(send).toHaveBeenCalledTimes(1);expect(d.raw.prepare("SELECT status,next_attempt_at FROM operator_push_deliveries WHERE kind='inbox_sla'").get()).toEqual({status:'failed',next_attempt_at:null});
 expect(d.raw.prepare("SELECT count(*) n FROM notifications WHERE id='sla:chat:2026-10-16T03:00:00Z:1'").get()).toEqual({n:1});
 d.raw.exec("DELETE FROM operator_push_deliveries; UPDATE chats SET assignee_staff_id='o' WHERE id='chat'");send.mockClear();
 await processInboxSlaPush(d.db,env,now,send);expect(send).not.toHaveBeenCalled();
});
it('対象者の一覧に含まれても、担当でない人には通知しない',async()=>{
 d.raw.exec("INSERT INTO operator_push_subscriptions(id,staff_id,endpoint,p256dh,auth,user_agent_label,created_at) VALUES('other-sub','o','https://example.invalid/o','key','auth','端末','2026-10-16')");
 const send=vi.fn<PushSender>(async()=>({status:201,ok:true}));
 await processInboxSlaPush(d.db,{...env,INBOX_SLA_PUSH_TEST_STAFF_IDS:'[\"s\",\"o\"]'},now,send);
 expect(send).toHaveBeenCalledTimes(1);expect(send.mock.calls[0][0]).toMatchObject({staffId:'s'});
 expect(d.raw.prepare("SELECT status FROM operator_push_deliveries WHERE subscription_id='other-sub'").get()).toEqual({status:'failed'});
});
it('別の未対応期間の通知は同じ段階でも送らない',async()=>{
 d.raw.exec(`INSERT INTO notifications(id,event_type,title,body,channel,status,metadata,line_account_id,category,created_at)
 VALUES('sla:chat:2026-10-16T02:00:00Z:1','inbox_sla','期限','確認','dashboard','sent','{"chatId":"f","staffId":"s","stage":1}','a','info','2026-10-16T03:00:00Z')`);
 const send=vi.fn<PushSender>(async()=>({status:201,ok:true}));
 await processInboxSlaPush(d.db,env,now,send);
 expect(send).toHaveBeenCalledTimes(1);
 expect(d.raw.prepare("SELECT ref_id FROM operator_push_deliveries WHERE kind='inbox_sla'").get()).toEqual({ref_id:'sla:chat:2026-10-16T03:00:00Z:1'});
});
it('店内通知の日本時間表記でも同じ未対応期間の通知を送る',async()=>{
 d.raw.exec("UPDATE notifications SET created_at='2026-10-16T13:00:00.000' WHERE event_type='inbox_sla'");
 const send=vi.fn<PushSender>(async()=>({status:201,ok:true}));await processInboxSlaPush(d.db,env,now,send);
 expect(send).toHaveBeenCalledTimes(1);
});
it('期限から24時間以上経過した会話はプッシュしない',async()=>{
 d.raw.exec("UPDATE chats SET sla_due_at='2026-10-14T04:00:00Z' WHERE id='chat'");
 const send=vi.fn<PushSender>(async()=>({status:201,ok:true}));await processInboxSlaPush(d.db,env,now,send);
 expect(send).not.toHaveBeenCalled();
 expect(d.raw.prepare('SELECT count(*) n FROM notifications').get()).toEqual({n:1});
});
it('明示的なサーバー失敗は検証条件の下でのみ再送する',async()=>{
 const send=vi.fn<PushSender>().mockResolvedValueOnce({status:503,ok:false}).mockResolvedValueOnce({status:201,ok:true});
 await processInboxSlaPush(d.db,env,now,send);
 const later=new Date(now.getTime()+61000);
 await retryOperatorPush(d.db,{DEPLOY_ENV:'production'},later,send);
 await processInboxSlaPush(d.db,{...env,DEPLOY_ENV:'production'},later,send);
 expect(send).toHaveBeenCalledTimes(1);
 await processInboxSlaPush(d.db,env,later,send);
 expect(send).toHaveBeenCalledTimes(2);
 expect(d.raw.prepare("SELECT status,attempts FROM operator_push_deliveries WHERE kind='inbox_sla'").get()).toEqual({status:'sent',attempts:2});
});
it('競合する失敗記録は取得したIDで確定する',async()=>{
 const original=d.db.prepare.bind(d.db);let injected=false;
 vi.spyOn(d.db,'prepare').mockImplementation((sql:string)=>{
  if(!injected&&sql.includes('INSERT INTO operator_push_deliveries')){
   injected=true;d.raw.exec("INSERT INTO operator_push_deliveries(id,subscription_id,kind,ref_id,line_account_id,status,attempts,next_attempt_at,created_at) VALUES('race','sub','inbox_sla','sla:chat:2026-10-16T03:00:00Z:1','a','failed',1,'2026-10-16T03:59:00Z','2026-10-16T03:58:00Z')");
  }
  return original(sql);
 });
 const send=vi.fn<PushSender>(async()=>({status:201,ok:true}));await processInboxSlaPush(d.db,env,now,send);
 expect(send).toHaveBeenCalledTimes(1);
 expect(d.raw.prepare("SELECT id,status,attempts FROM operator_push_deliveries").get()).toEqual({id:'race',status:'sent',attempts:2});
});
it('429以外の4xxは再送せず、5xxも最大4回で止める',async()=>{
 const rejected=vi.fn<PushSender>(async()=>({status:400,ok:false}));
 await processInboxSlaPush(d.db,env,now,rejected);await processInboxSlaPush(d.db,env,new Date(now.getTime()+3600000),rejected);
 expect(rejected).toHaveBeenCalledTimes(1);
 d.raw.exec('DELETE FROM operator_push_deliveries');
 const temporary=vi.fn<PushSender>(async()=>({status:503,ok:false}));
 for(const minutes of [0,2,8,39,90])await processInboxSlaPush(d.db,env,new Date(now.getTime()+minutes*60000),temporary);
 expect(temporary).toHaveBeenCalledTimes(4);
 expect(d.raw.prepare("SELECT status,attempts,next_attempt_at FROM operator_push_deliveries WHERE kind='inbox_sla'").get()).toEqual({status:'failed',attempts:4,next_attempt_at:null});
});
it('送信中の受け取り設定変更を反映する',async()=>{
 const original=d.db.prepare.bind(d.db);let changed=false;
 vi.spyOn(d.db,'prepare').mockImplementation((sql:string)=>{
  if(!changed&&sql.includes('SELECT 1 FROM operator_push_subscriptions')){
   changed=true;d.raw.exec("INSERT INTO operator_push_preferences(staff_id,kinds_json) VALUES('s','[]')");
  }
  return original(sql);
 });
 const send=vi.fn<PushSender>(async()=>({status:201,ok:true}));await processInboxSlaPush(d.db,env,now,send);
 expect(send).not.toHaveBeenCalled();
 expect(d.raw.prepare("SELECT status,error_code FROM operator_push_deliveries WHERE kind='inbox_sla'").get()).toEqual({status:'failed',error_code:'push_preference'});
});
it('取り消された通知は送信しない',async()=>{
 const original=d.db.prepare.bind(d.db);let removed=false;
 vi.spyOn(d.db,'prepare').mockImplementation((sql:string)=>{
  if(!removed&&sql.includes('SELECT 1 FROM chats c JOIN friends')){removed=true;d.raw.exec("DELETE FROM notifications WHERE event_type='inbox_sla'");}
  return original(sql);
 });
 const send=vi.fn<PushSender>(async()=>({status:201,ok:true}));await processInboxSlaPush(d.db,env,now,send);
 expect(send).not.toHaveBeenCalled();
});
