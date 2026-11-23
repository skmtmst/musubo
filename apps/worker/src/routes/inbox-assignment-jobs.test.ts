import { afterEach,beforeEach,expect,it } from 'vitest';
import { gapFixture,gapApp,gapCall,gapOwner } from '../test-utils/gap1.js';
import { inboxSla } from './inbox-sla.js';
import { processInboxAssignmentJobs } from '../services/inbox-assignment-jobs.js';
let d:ReturnType<typeof gapFixture>;
beforeEach(()=>{d=gapFixture();const now=new Date().toISOString();d.raw.prepare("INSERT INTO staff_presence(staff_id,away,last_seen_at) VALUES('s',0,?)").run(now);d.raw.exec("INSERT INTO inbox_assignment_settings(account_id,strategy,targets_json) VALUES('a','even','[{\"staffId\":\"s\",\"priority\":1,\"cap\":100}]')");for(let i=0;i<45;i++){const id=`f-${i}`;d.raw.prepare("INSERT INTO friends(id,line_user_id,line_account_id) VALUES(?,?, 'a')").run(id,`line-${i}`);d.raw.prepare("INSERT INTO chats(id,friend_id,status,last_customer_message_at,created_at,updated_at) VALUES(?,?,'unread',?,'2020-01-01','now')").run(`chat-${i}`,id,now);}});
afterEach(()=>d.raw.close());
const url='/api/inbox/routing/apply-unassigned?account_id=a';
it('割当を使わないときは一括処理を開始しない',async()=>{
 d.raw.exec("UPDATE inbox_assignment_settings SET strategy='none' WHERE account_id='a'");
 expect((await gapCall(gapApp(d,[inboxSla]),url,'POST',{},'disabled')).status).toBe(409);
 expect(d.raw.prepare('SELECT count(*) n FROM inbox_assignment_jobs').get()).toEqual({n:0});
});
it('未割当を小分けに最後まで割り当て、同じ要求を重複実行しない',async()=>{
 const app=gapApp(d,[inboxSla]);
 const first=await gapCall(app,url,'POST',{},'same-key');expect(first.status).toBe(202);
 const {data:job}=await first.json() as {data:{id:string;total:number}};expect(job.total).toBe(45);
 const second=await gapCall(app,url,'POST',{},'same-key');expect((await second.json() as {data:{id:string}}).data.id).toBe(job.id);
 const concurrent=await gapCall(app,url,'POST',{},'another-key');expect((await concurrent.json() as {data:{id:string}}).data.id).toBe(job.id);
 for(let i=0;i<5;i++)await processInboxAssignmentJobs(d.db);
 expect(d.raw.prepare('SELECT status,assigned,skipped,total FROM inbox_assignment_jobs WHERE id=?').get(job.id)).toEqual({status:'succeeded',assigned:45,skipped:0,total:45});
 expect(d.raw.prepare('SELECT count(*) n FROM inbox_assignment_logs').get()).toEqual({n:45});
 expect((await gapCall(gapApp(d,[inboxSla],{...gapOwner,readOnly:true}),url,'POST',{},'no')).status).toBe(403);
 expect((await gapCall(app,`/api/inbox/routing/apply-unassigned/${job.id}?account_id=b`)).status).toBe(404);
});
it('人が不在なら未割当のまま失敗件数として確定し、会話ごとの通知を増やさない',async()=>{
 d.raw.exec("UPDATE staff_presence SET away=1");const app=gapApp(d,[inboxSla]);const res=await gapCall(app,url,'POST',{},'away');const {data:job}=await res.json() as {data:{id:string}};
 for(let i=0;i<5;i++)await processInboxAssignmentJobs(d.db);
 expect(d.raw.prepare('SELECT status,assigned,skipped FROM inbox_assignment_jobs WHERE id=?').get(job.id)).toEqual({status:'succeeded',assigned:0,skipped:45});
 expect(d.raw.prepare("SELECT count(*) n FROM notifications WHERE event_type='inbox_assignment_unavailable'").get()).toEqual({n:0});
});

it('処理開始後に権限を失った管理者の仕事は安全に停止する',async()=>{
 const app=gapApp(d,[inboxSla]);const res=await gapCall(app,url,'POST',{},'removed');const {data:job}=await res.json() as {data:{id:string}};
 d.raw.exec("UPDATE staff_members SET is_active=0 WHERE id='o'");await processInboxAssignmentJobs(d.db);
 expect(d.raw.prepare('SELECT status,assigned FROM inbox_assignment_jobs WHERE id=?').get(job.id)).toEqual({status:'failed',assigned:0});
 expect(d.raw.prepare('SELECT count(*) n FROM inbox_assignment_logs').get()).toEqual({n:0});
});

it('担当確定後に途中停止しても再開時に件数を一度だけ数える',async()=>{
 const app=gapApp(d,[inboxSla]);const res=await gapCall(app,url,'POST',{},'recover');const {data:job}=await res.json() as {data:{id:string}};
 const token=`bulk:${job.id}:chat-0`;
 d.raw.prepare("UPDATE chats SET assignee_staff_id='s',assignment_token=? WHERE id='chat-0'").run(token);
 d.raw.prepare("INSERT INTO inbox_assignment_logs(id,account_id,chat_id,staff_id,strategy,decided_at,mutation_token) VALUES('prior','a','chat-0','s','even',?,?)").run(new Date().toISOString(),token);
 d.raw.prepare("UPDATE inbox_assignment_jobs SET status='running',lease_owner='old',lease_until=0 WHERE id=?").run(job.id);
 for(let i=0;i<5;i++)await processInboxAssignmentJobs(d.db);
 expect(d.raw.prepare('SELECT status,assigned,skipped FROM inbox_assignment_jobs WHERE id=?').get(job.id)).toEqual({status:'succeeded',assigned:45,skipped:0});
 expect(d.raw.prepare('SELECT count(*) n FROM inbox_assignment_logs WHERE mutation_token=?').get(token)).toEqual({n:1});
});
