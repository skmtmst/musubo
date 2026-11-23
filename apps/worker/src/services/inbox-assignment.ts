import {canAssignChatTo} from './chat-assignees.js';
import {getAccountTimeZone,tzDateStr,tzHHMM} from './availability.js';
import {GapError} from './gap-common.js';
import {businessWindows} from './inbox-sla.js';
export type RoutingTarget={staffId:string;priority:number;cap:number};
export type RoutingSettings={strategy:'none'|'even'|'priority'|'random_weighted';targets:RoutingTarget[]};
export async function routingSettings(db:D1Database,a:string):Promise<RoutingSettings>{
 const r=await db.prepare('SELECT strategy,targets_json FROM inbox_assignment_settings WHERE account_id=?').bind(a).first<{strategy:RoutingSettings['strategy'];targets_json:string}>();
 return {strategy:r?.strategy??'none',targets:JSON.parse(r?.targets_json??'[]')};
}
export async function routingInput(db:D1Database,a:string,b:Record<string,unknown>):Promise<RoutingSettings>{
 const old=await routingSettings(db,a),strategy=b.strategy??old.strategy,targets=b.targets??old.targets;
 if(!['none','even','priority','random_weighted'].includes(String(strategy))||!Array.isArray(targets)||targets.length>100)throw new GapError('invalid_routing');
 const ids=new Set<string>();
 for(const t of targets){
 if(!t||typeof t.staffId!=='string'||ids.has(t.staffId)||!Number.isInteger(t.priority)||t.priority<1||t.priority>100||!Number.isInteger(t.cap)||t.cap<1||t.cap>1000)throw new GapError('invalid_target');
 const s=await db.prepare('SELECT id,role,tenant_id,is_active,access_level FROM staff_members WHERE id=?').bind(t.staffId).first<{id:string;role:'owner'|'admin'|'staff';tenant_id:string;is_active:number;access_level:string}>();
 if(!s||!s.is_active||s.access_level==='read_only'||!await canAssignChatTo(db,s.id,a))throw new GapError('invalid_target');ids.add(t.staffId);
 }
 return {strategy:strategy as RoutingSettings['strategy'],targets};
}
// 同じ未対応期間の再試行では一件だけ、店舗内の通知に残す。
async function notifyUnassignable(db:D1Database,account:string,chatId:string,pendingSince:string|null,now:Date) {
 if (!pendingSince) return;
 const windows=await businessWindows(db,account,now.toISOString());
 if(!windows.some(([start,end])=>start<=now.getTime()&&now.getTime()<end))return;
 await db.prepare(`INSERT INTO notifications(id,event_type,title,body,channel,status,metadata,line_account_id,category)
  SELECT ?, 'inbox_assignment_unavailable', '担当を割り当てられませんでした',
   '受信箱の未割り当てと担当者の勤務・不在・上限を確認してください。', 'dashboard', 'sent',
   json_object('teamId',(SELECT escalate_team_id FROM inbox_routing_settings WHERE account_id=?)), ?, 'error'
  FROM chats c JOIN friends f ON f.id=c.friend_id
  WHERE c.id=? AND f.line_account_id=? AND c.pending_since=? AND c.first_response_at IS NULL
   AND c.operator_id IS NULL AND c.assignee_staff_id IS NULL AND c.status!='resolved'
  ON CONFLICT(id) DO NOTHING`).bind(`inbox-assignment:${account}:${Math.floor(now.getTime()/3600000)}`,account,account,chatId,account,pendingSince).run();
}
export async function assignInbox(db:D1Database,a:string,friendId:string,now=new Date(),random=()=>crypto.getRandomValues(new Uint32Array(1))[0]/4294967296,job?:{token:string;id:string;leaseOwner:string},opening?:{leaseOwner:string}){
 const config=await routingSettings(db,a);if(config.strategy==='none')return false;
 const c=await db.prepare("SELECT c.id,c.pending_since FROM chats c JOIN friends f ON f.id=c.friend_id WHERE c.friend_id=? AND f.line_account_id=? AND c.operator_id IS NULL AND c.assignee_staff_id IS NULL AND c.status!='resolved'").bind(friendId,a).first<{id:string;pending_since:string|null}>();if(!c)return false;
 const tz=await getAccountTimeZone(db,a),day=tzDateStr(tz,now),time=tzHHMM(tz,now),eligible=[];
 for(const t of config.targets){
 const s=await db.prepare(`SELECT m.*,p.away,p.last_seen_at FROM staff_members m JOIN staff_presence p ON p.staff_id=m.id WHERE m.id=? AND m.is_active=1 AND m.access_level!='read_only' AND p.away=0 AND julianday(p.last_seen_at)>=julianday(?,'-30 minutes')`).bind(t.staffId,now.toISOString()).first<{id:string;role:'owner'|'admin'|'staff';tenant_id:string}>();
 if(!s||!await canAssignChatTo(db,s.id,a))continue;
 const bs=await db.prepare('SELECT id FROM staff WHERE staff_member_id=? AND line_account_id=? AND is_active=1 AND deleted_at IS NULL').bind(t.staffId,a).first<{id:string}>();
 if(bs){const shifts=await db.prepare('SELECT count(*) n FROM staff_shifts WHERE staff_id=?').bind(bs.id).first<{n:number}>();if(shifts?.n&&!await db.prepare('SELECT id FROM staff_shifts WHERE staff_id=? AND work_date=? AND start_time<=? AND end_time>?').bind(bs.id,day,time,time).first())continue;}
 const load=await db.prepare(`SELECT count(*) n FROM chats c JOIN friends f ON f.id=c.friend_id WHERE f.line_account_id=? AND c.assignee_staff_id=? AND c.status!='resolved' AND c.last_customer_message_at IS NOT NULL AND (c.last_operator_message_at IS NULL OR julianday(c.last_customer_message_at)>julianday(c.last_operator_message_at))`).bind(a,t.staffId).first<{n:number}>();
 if((load?.n??0)>=t.cap)continue;
 const recent=await db.prepare("SELECT count(*) n,MAX(decided_at) last FROM inbox_assignment_logs WHERE account_id=? AND staff_id=? AND julianday(decided_at)>=julianday(?,'-7 days')").bind(a,t.staffId,now.toISOString()).first<{n:number;last:string|null}>();
 eligible.push({...t,count:recent?.n??0,last:recent?.last??''});
 }
 if(!eligible.length){if(!job)await notifyUnassignable(db,a,c.id,c.pending_since,now);return false;}
 eligible.sort((a,b)=>(config.strategy==='even'?a.count-b.count:0)||a.priority-b.priority||a.last.localeCompare(b.last));
 let pick=eligible[0];
 if(config.strategy==='random_weighted'){let cursor=random()*eligible.reduce((n,t)=>n+101-t.priority,0);for(const t of eligible){cursor-=101-t.priority;if(cursor<0){pick=t;break;}}}
 else {const equal=eligible.filter(t=>t.count===pick.count&&t.priority===pick.priority&&t.last===pick.last);pick=equal[Math.floor(random()*equal.length)]??pick;}
 const token=job?.token??crypto.randomUUID();
 const results=await db.batch([
 db.prepare(`UPDATE chats SET assignee_staff_id=?,assigned_by='auto',assigned_at=?,assignment_token=?,revision=revision+1 WHERE id=? AND operator_id IS NULL AND assignee_staff_id IS NULL AND status!='resolved' AND (SELECT count(*) FROM chats c JOIN friends f ON f.id=c.friend_id WHERE f.line_account_id=? AND c.assignee_staff_id=? AND c.status!='resolved' AND c.last_customer_message_at IS NOT NULL AND (c.last_operator_message_at IS NULL OR julianday(c.last_customer_message_at)>julianday(c.last_operator_message_at)))<? AND EXISTS(SELECT 1 FROM staff_members sm WHERE sm.id=? AND sm.is_active=1 AND sm.invite_status='active' AND sm.access_level!='read_only') AND (? IS NULL OR EXISTS(SELECT 1 FROM inbox_assignment_opening_runs r WHERE r.account_id=? AND r.lease_owner=? AND r.lease_until>?)) AND (? IS NULL OR EXISTS(SELECT 1 FROM inbox_assignment_jobs j WHERE j.id=? AND j.status='running' AND j.lease_owner=? AND j.lease_until>?))`).bind(pick.staffId,now.toISOString(),token,c.id,a,pick.staffId,pick.cap,pick.staffId,opening?.leaseOwner??null,a,opening?.leaseOwner??null,Date.now(),job?.id??null,job?.id??null,job?.leaseOwner??null,Date.now()),
 db.prepare('INSERT INTO inbox_assignment_logs(id,account_id,chat_id,staff_id,strategy,decided_at,mutation_token) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM chats WHERE id=? AND assignment_token=?)').bind(crypto.randomUUID(),a,c.id,pick.staffId,config.strategy,now.toISOString(),token,c.id,token)]);
 return !!results[0].meta.changes;
}
