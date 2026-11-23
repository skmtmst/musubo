import { assignInbox,routingSettings } from './inbox-assignment.js';
import { businessWindows } from './inbox-sla.js';

/** 営業開始ごとに未割当を小分けに処理する。期限切れの借受は次回が引き継ぐ。 */
export async function processInboxOpeningAssignments(db:D1Database,now=new Date()) {
 const at=now.getTime(),leaseAt=Date.now();
 await db.prepare(`INSERT INTO inbox_assignment_opening_runs(account_id)
  SELECT account_id FROM inbox_assignment_settings WHERE strategy!='none' ON CONFLICT(account_id) DO NOTHING`).run();
 const candidates=(await db.prepare(`SELECT r.account_id FROM inbox_assignment_opening_runs r JOIN inbox_assignment_settings s ON s.account_id=r.account_id
  JOIN line_accounts a ON a.id=r.account_id WHERE s.strategy!='none' AND a.is_active=1 AND a.archived_at IS NULL
  AND r.next_check<=? AND (r.lease_until IS NULL OR r.lease_until<=?) ORDER BY r.next_check,r.account_id LIMIT 3`).bind(at,leaseAt).all<{account_id:string}>()).results;
 let budget=600;
 for(const {account_id:account} of candidates){
  const targets=(await routingSettings(db,account)).targets.length;
  const perChat=targets*8+15;if(budget<perChat&&budget<600)break;
  const pageSize=Math.max(1,Math.min(10,Math.floor(budget/perChat)));
  budget-=pageSize*perChat;
  const lease=crypto.randomUUID();
  const claim=await db.prepare('UPDATE inbox_assignment_opening_runs SET lease_owner=?,lease_until=? WHERE account_id=? AND next_check<=? AND (lease_until IS NULL OR lease_until<=?)').bind(lease,leaseAt+120000,account,at,leaseAt).run();
  if(!claim.meta.changes)continue;
  try {
   const windows=await businessWindows(db,account,now.toISOString());
   const current=windows.find(([start,end])=>start<=at&&at<end);
   if(!current){const next=windows.find(([start])=>start>at)?.[0]??at+86400000;await db.prepare('UPDATE inbox_assignment_opening_runs SET next_check=?,window_start=NULL,cursor=\'\',lease_owner=NULL,lease_until=NULL WHERE account_id=? AND lease_owner=?').bind(next,account,lease).run();continue;}
   const state=await db.prepare('SELECT window_start,cursor FROM inbox_assignment_opening_runs WHERE account_id=? AND lease_owner=?').bind(account,lease).first<{window_start:number|null;cursor:string}>();
   if(!state)continue;
   const cursor=state.window_start===current[0]?state.cursor:'';
   const chats=(await db.prepare(`SELECT c.id,c.friend_id FROM chats c JOIN friends f ON f.id=c.friend_id WHERE f.line_account_id=? AND c.id>? AND c.pending_since IS NOT NULL AND c.first_response_at IS NULL AND c.operator_id IS NULL AND c.assignee_staff_id IS NULL AND c.status!='resolved' ORDER BY c.id LIMIT ?`).bind(account,cursor,pageSize+1).all<{id:string;friend_id:string}>()).results;
   for(const chat of chats.slice(0,pageSize)){
    const owns=await db.prepare('SELECT 1 FROM inbox_assignment_opening_runs WHERE account_id=? AND lease_owner=? AND lease_until>?').bind(account,lease,Date.now()).first();if(!owns)break;
    await assignInbox(db,account,chat.friend_id,now,undefined,undefined,{leaseOwner:lease});
    await db.prepare('UPDATE inbox_assignment_opening_runs SET window_start=?,cursor=? WHERE account_id=? AND lease_owner=?').bind(current[0],chat.id,account,lease).run();
   }
   const remaining=chats.length>pageSize || !!await db.prepare(`SELECT 1 FROM chats c JOIN friends f ON f.id=c.friend_id WHERE f.line_account_id=? AND c.pending_since IS NOT NULL AND c.first_response_at IS NULL AND c.operator_id IS NULL AND c.assignee_staff_id IS NULL AND c.status!='resolved' LIMIT 1`).bind(account).first();
   await db.prepare('UPDATE inbox_assignment_opening_runs SET window_start=?,cursor=CASE WHEN ? THEN cursor ELSE \'\' END,next_check=?,lease_owner=NULL,lease_until=NULL WHERE account_id=? AND lease_owner=?').bind(current[0],chats.length>pageSize?1:0,remaining?Math.min(at+(chats.length>pageSize?60000:300000),current[1]):current[1],account,lease).run();
  }catch(error){await db.prepare('UPDATE inbox_assignment_opening_runs SET next_check=?,lease_owner=NULL,lease_until=NULL WHERE account_id=? AND lease_owner=?').bind(at+60000,account,lease).run();throw error;}
 }
}
