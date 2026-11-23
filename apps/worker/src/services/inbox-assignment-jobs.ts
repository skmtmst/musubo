import { getStaffById } from '@line-crm/db';
import { toAuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { canAccessAllLineAccounts } from './account-access.js';
import { assignInbox,routingSettings } from './inbox-assignment.js';

type Job={id:string;account_id:string;actor_staff_id:string;status:string;lease_owner:string|null;lease_until:number|null;assigned:number;skipped:number;total:number;attempts:number};
export async function beginInboxAssignmentJob(db:D1Database,account:string,actor:string,key:string) {
 const id=crypto.randomUUID(),now=Date.now();
 const results=await db.batch([
  db.prepare(`INSERT INTO inbox_assignment_jobs(id,account_id,idempotency_key,actor_staff_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING`).bind(id,account,key,actor,now,now),
  db.prepare(`INSERT INTO inbox_assignment_job_items(job_id,chat_id)
    SELECT ?,c.id FROM chats c JOIN friends f ON f.id=c.friend_id
     WHERE f.line_account_id=? AND c.operator_id IS NULL AND c.assignee_staff_id IS NULL AND c.status!='resolved'
       AND EXISTS(SELECT 1 FROM inbox_assignment_jobs WHERE id=?)`).bind(id,account,id),
  db.prepare('UPDATE inbox_assignment_jobs SET total=(SELECT count(*) FROM inbox_assignment_job_items WHERE job_id=?) WHERE id=?').bind(id,id),
  db.prepare("SELECT id,status,assigned,skipped,total FROM inbox_assignment_jobs WHERE account_id=? AND (idempotency_key=? OR status IN ('pending','running')) ORDER BY (idempotency_key=?) DESC LIMIT 1").bind(account,key,key),
 ]);
 return (results[3].results[0]??null) as {id:string;status:string;assigned:number;skipped:number;total:number}|null;
}
export async function getInboxAssignmentJob(db:D1Database,account:string,id:string) {
 return db.prepare('SELECT id,status,assigned,skipped,total FROM inbox_assignment_jobs WHERE account_id=? AND id=?').bind(account,id).first<{id:string;status:string;assigned:number;skipped:number;total:number}>();
}
/** 借受を確かめて小分けに進め、結果の確定前に中断しても同じ割当記録で収束させる。 */
export async function processInboxAssignmentJobs(db:D1Database,now=Date.now()) {
 const job=await db.prepare(`SELECT * FROM inbox_assignment_jobs WHERE status='pending' OR (status='running' AND lease_until<=?) ORDER BY created_at,id LIMIT 1`).bind(now).first<Job>();
 if(!job)return;
 const owner=crypto.randomUUID();
 const claim=await db.prepare(`UPDATE inbox_assignment_jobs SET status='running',lease_owner=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=? AND (status='pending' OR (status='running' AND lease_until<=?))`).bind(owner,now+120000,now,job.id,now).run();
 if(!claim.meta.changes)return;
 try {
  const actor=await getStaffById(db,job.actor_staff_id);
  const account=await db.prepare('SELECT id FROM line_accounts WHERE id=? AND is_active=1 AND archived_at IS NULL').bind(job.account_id).first();
  if(!actor||!actor.is_active||actor.invite_status!=='active'||actor.access_level==='read_only'||actor.tenant_status!=='active'||!['owner','admin'].includes(actor.role)||!account||!await canAccessAllLineAccounts(db,toAuthenticatedStaff(actor),[job.account_id])) {
   await db.prepare("UPDATE inbox_assignment_jobs SET status='failed',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_owner=?").bind(Date.now(),job.id,owner).run();return;
  }
  const targets=(await routingSettings(db,job.account_id)).targets.length;
  const pageSize=Math.max(1,Math.min(20,Math.floor(300/(targets*8+15))));
  const items=(await db.prepare(`SELECT i.chat_id,c.friend_id FROM inbox_assignment_job_items i JOIN chats c ON c.id=i.chat_id WHERE i.job_id=? AND i.status='pending' ORDER BY i.chat_id LIMIT ?`).bind(job.id,pageSize).all<{chat_id:string;friend_id:string}>()).results;
  for(const item of items){
   const token=`bulk:${job.id}:${item.chat_id}`;
   const wasAssigned=await db.prepare('SELECT 1 FROM inbox_assignment_logs WHERE mutation_token=?').bind(token).first();
   const assigned=!!wasAssigned||await assignInbox(db,job.account_id,item.friend_id,new Date(),undefined,{id:job.id,leaseOwner:owner,token});
   await db.batch([
    db.prepare(`UPDATE inbox_assignment_job_items SET status=? WHERE job_id=? AND chat_id=? AND status='pending' AND EXISTS(SELECT 1 FROM inbox_assignment_jobs WHERE id=? AND status='running' AND lease_owner=? AND lease_until>?)`).bind(assigned?'assigned':'skipped',job.id,item.chat_id,job.id,owner,Date.now()),
    db.prepare(`UPDATE inbox_assignment_jobs SET assigned=assigned+?,skipped=skipped+?,updated_at=? WHERE id=? AND lease_owner=? AND changes()=1`).bind(assigned?1:0,assigned?0:1,Date.now(),job.id,owner),
   ]);
  }
  await db.prepare(`UPDATE inbox_assignment_jobs SET skipped=CASE WHEN NOT EXISTS(SELECT 1 FROM inbox_assignment_job_items WHERE job_id=? AND status='pending') THEN MAX(skipped,total-assigned) ELSE skipped END, status=CASE WHEN EXISTS(SELECT 1 FROM inbox_assignment_job_items WHERE job_id=? AND status='pending') THEN 'pending' ELSE 'succeeded' END,lease_owner=NULL,lease_until=NULL,attempts=0,updated_at=? WHERE id=? AND lease_owner=?`)
   .bind(job.id,job.id,Date.now(),job.id,owner).run();
 } catch(error) {
  await db.prepare(`UPDATE inbox_assignment_jobs SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_owner=?`).bind(Date.now(),job.id,owner).run();
  throw error;
 }
}
