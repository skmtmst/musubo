import {canAssignChatTo} from './chat-assignees.js';
import type { Env } from '../worker-env.js';
import {toAuthenticatedStaff} from '../middleware/auth.js';
import {canAccessAllLineAccounts} from './account-access.js';
import {sendWebPush} from './web-push.js';
export function pushIsQuiet(start:string,end:string,now=new Date(),tz='Asia/Tokyo'){const p=new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(now);return start===end?false:start<end?start<=p&&p<end:p>=start||p<end;}
export type PushSender=(s:{endpoint:string;p256dh:string;auth:string},payload:{title:string;body:string;url:string})=>Promise<{status:number;ok:boolean}>;
export function pushPayload(kind:string,friendId:string){return {title:kind==='test'?'通知のテスト':kind==='assigned_reply'?'担当の会話に返事が来ました':'新しい問い合わせ',body:'会話を開いて確認してください',url:kind==='test'?'/chats':`/chats?friend=${encodeURIComponent(friendId)}`};}
export async function deliverOperatorPush(db:D1Database,env:Partial<Env['Bindings']>,input:{staffId:string;account:string;kind:'new_inquiry'|'assigned_reply'|'test';refId:string;chatId:string},send?:PushSender){
 const staff=await db.prepare('SELECT * FROM staff_members WHERE id=? AND is_active=1').bind(input.staffId).first<Record<string,unknown>>();if(!staff)return {sent:0,failed:0};
 // SQLから取った本人の権限を使う。通知のルールが古くても外の店へ漏らさない。
 const auth=toAuthenticatedStaff(staff as never);
 if(input.kind!=='test'&&(!await canAccessAllLineAccounts(db,auth,[input.account])||!(['owner','admin'].includes(auth.role)||auth.permissionKeys?.includes('/chats')||auth.viewPermissionKeys?.includes('/chats'))))return {sent:0,failed:0};
 const preference=await db.prepare('SELECT kinds_json,quiet_start,quiet_end FROM operator_push_preferences WHERE staff_id=?').bind(input.staffId).first<{kinds_json:string;quiet_start:string;quiet_end:string}>();if(input.kind!=='test'&&preference&&!(JSON.parse(preference.kinds_json) as string[]).includes(input.kind))return {sent:0,failed:0};
 if(input.kind==='assigned_reply'){
  if(!await canAssignChatTo(db,input.staffId,input.account))return {sent:0,failed:0};
  const assignment=await db.prepare('SELECT c.assignee_staff_id assigned_staff_id FROM chats c JOIN friends f ON f.id=c.friend_id WHERE c.id=? AND f.line_account_id=?').bind(input.chatId,input.account).first<{assigned_staff_id:string|null}>();if(assignment?.assigned_staff_id!==input.staffId)return {sent:0,failed:0};
 }
 const conversation=input.kind==='test'?null:await db.prepare('SELECT friend_id FROM chats c JOIN friends f ON f.id=c.friend_id WHERE c.id=? AND f.line_account_id=?').bind(input.chatId,input.account).first<{friend_id:string}>();if(input.kind!=='test'&&!conversation)return {sent:0,failed:0};
 const rows=(await db.prepare('SELECT id,endpoint,p256dh,auth FROM operator_push_subscriptions WHERE staff_id=? AND revoked_at IS NULL').bind(input.staffId).all<{id:string;endpoint:string;p256dh:string;auth:string}>()).results;let sent=0,failed=0;
 for(const row of rows){
  const id=crypto.randomUUID(),createdAt=new Date().toISOString(),claim=await db.prepare("INSERT INTO operator_push_deliveries(id,subscription_id,kind,ref_id,line_account_id,status,created_at) VALUES(?,?,?,?,?,'pending',?) ON CONFLICT(subscription_id,kind,ref_id) DO NOTHING").bind(id,row.id,input.kind,input.refId,input.account||null,createdAt).run();if(!claim.meta.changes)continue;
  if(input.kind!=='test'&&pushIsQuiet(preference?.quiet_start??'22:00',preference?.quiet_end??'08:00')){await db.prepare("UPDATE operator_push_deliveries SET status='suppressed_quiet' WHERE id=?").bind(id).run();continue;}
  // 本文を受け取る引数を作らない。名前・電話・メール・質問の文は載せない。
  const payload=pushPayload(input.kind,conversation?.friend_id??'');
  try{
   if(!send&&(!env.OPERATOR_PUSH_VAPID_PUBLIC_KEY||!env.OPERATOR_PUSH_VAPID_PRIVATE_KEY||!env.OPERATOR_PUSH_VAPID_SUBJECT))throw new Error('vapid_not_configured');
   const result=send?await send(row,payload):await sendWebPush({...row,payload,publicKey:env.OPERATOR_PUSH_VAPID_PUBLIC_KEY!,privateKey:env.OPERATOR_PUSH_VAPID_PRIVATE_KEY!,subject:env.OPERATOR_PUSH_VAPID_SUBJECT!});
   const gone=[404,410].includes(result.status),state=gone?'gone':result.ok?'sent':'failed';
   await db.batch([db.prepare("UPDATE operator_push_deliveries SET status=?,error_code=?,attempts=attempts+1,next_attempt_at=CASE WHEN ? THEN datetime('now','+1 minute') ELSE NULL END WHERE id=?").bind(state,result.ok?null:`push_http_${result.status}`,result.status>=500||result.status===429?1:0,id),db.prepare('UPDATE operator_push_subscriptions SET last_success_at=CASE WHEN ? THEN ? ELSE last_success_at END,last_error_code=?,revoked_at=CASE WHEN ? THEN ? ELSE revoked_at END WHERE id=?').bind(result.ok?1:0,createdAt,result.ok?null:`push_http_${result.status}`,gone?1:0,createdAt,row.id)]);
   if(result.ok)sent++;else failed++;
  }catch{failed++;await db.prepare("UPDATE operator_push_deliveries SET status='failed',error_code='push_unavailable',attempts=attempts+1 WHERE id=?").bind(id).run();}
 }
 return {sent,failed};
}

/** 静かな時間の後に、同じ端末・種類を1通へまとめる。本文は台帳にも残さない。 */
export async function sweepOperatorPush(db:D1Database,env:Partial<Env['Bindings']>,now=new Date(),send?:PushSender){
 const groups=(await db.prepare("SELECT d.subscription_id,d.kind,s.staff_id,MIN(d.line_account_id) account FROM operator_push_deliveries d JOIN operator_push_subscriptions s ON s.id=d.subscription_id WHERE d.status='suppressed_quiet' AND d.kind!='inbox_sla' AND s.revoked_at IS NULL GROUP BY d.subscription_id,d.kind LIMIT 100").all<{subscription_id:string;kind:string;staff_id:string;account:string}>()).results;
 for(const group of groups){
  const pref=await db.prepare('SELECT quiet_start,quiet_end,kinds_json FROM operator_push_preferences WHERE staff_id=?').bind(group.staff_id).first<{quiet_start:string;quiet_end:string;kinds_json:string}>();if(pushIsQuiet(pref?.quiet_start??'22:00',pref?.quiet_end??'08:00',now))continue;
  const staff=await db.prepare('SELECT * FROM staff_members WHERE id=? AND is_active=1').bind(group.staff_id).first();if(!staff)continue;
  const auth=toAuthenticatedStaff(staff as never),chatAllowed=['owner','admin'].includes(auth.role)||auth.permissionKeys?.includes('/chats')||auth.viewPermissionKeys?.includes('/chats');
  const pending=(await db.prepare("SELECT id,line_account_id,ref_id FROM operator_push_deliveries WHERE subscription_id=? AND kind=? AND status='suppressed_quiet'").bind(group.subscription_id,group.kind).all<{id:string;line_account_id:string|null;ref_id:string}>()).results;
  const ids:string[]=[],excluded:string[]=[];
  for(const row of pending){
   const allowed=chatAllowed&&(!pref||JSON.parse(pref.kinds_json).includes(group.kind))&&row.line_account_id&&await canAccessAllLineAccounts(db,auth,[row.line_account_id])&&(group.kind!=='assigned_reply'||await canAssignChatTo(db,group.staff_id,row.line_account_id));
   const chat=allowed?await db.prepare('SELECT c.assignee_staff_id AS operator_id FROM messages_log m JOIN chats c ON c.friend_id=m.friend_id WHERE m.id=? AND m.line_account_id=?').bind(row.ref_id,row.line_account_id).first<{operator_id:string|null}>():null;
   if(!chat||group.kind==='assigned_reply'&&chat.operator_id!==group.staff_id)excluded.push(row.id);else ids.push(row.id);
  }
  if(excluded.length)await db.prepare("UPDATE operator_push_deliveries SET status='failed',error_code='push_no_longer_authorized' WHERE id IN(SELECT value FROM json_each(?)) AND status='suppressed_quiet'").bind(JSON.stringify(excluded)).run();
  if(!ids.length)continue;
  const claim=await db.prepare("UPDATE operator_push_deliveries SET status='pending' WHERE id IN(SELECT value FROM json_each(?)) AND status='suppressed_quiet'").bind(JSON.stringify(ids)).run();if(claim.meta.changes!==ids.length)continue;
  const sub=await db.prepare('SELECT endpoint,p256dh,auth FROM operator_push_subscriptions WHERE id=? AND revoked_at IS NULL').bind(group.subscription_id).first<{endpoint:string;p256dh:string;auth:string}>();
  let ok=false;
  try{if(sub){const payload={title:`夜の間に${ids.length}件のお知らせ`,body:'受信箱を開いて確認してください',url:'/chats'};
   const r=send?await send(sub,payload):await sendWebPush({...sub,payload,publicKey:env.OPERATOR_PUSH_VAPID_PUBLIC_KEY!,privateKey:env.OPERATOR_PUSH_VAPID_PRIVATE_KEY!,subject:env.OPERATOR_PUSH_VAPID_SUBJECT!});ok=r.ok;}}
  catch{/* 不明な送達は自動再送せず通知センターに残す。 */}
  await db.prepare("UPDATE operator_push_deliveries SET status=?,attempts=attempts+1 WHERE id IN(SELECT value FROM json_each(?)) AND status='pending'").bind(ok?'batched':'failed',JSON.stringify(ids)).run();
 }
}

/** 明示的な429/5xx応答だけを再試行し、送達不明は送り直さない。 */
export async function retryOperatorPush(db:D1Database,env:Partial<Env['Bindings']>,now=new Date(),send?:PushSender){
 const due=(await db.prepare(`SELECT d.*,s.endpoint,s.p256dh,s.auth,s.staff_id FROM operator_push_deliveries d JOIN operator_push_subscriptions s ON s.id=d.subscription_id WHERE s.revoked_at IS NULL AND d.kind!='inbox_sla' AND d.status='failed' AND d.attempts<4 AND d.next_attempt_at IS NOT NULL AND julianday(d.next_attempt_at)<=julianday(?) LIMIT 100`).bind(now.toISOString()).all<{id:string;subscription_id:string;kind:string;ref_id:string;line_account_id:string|null;staff_id:string;endpoint:string;p256dh:string;auth:string;attempts:number}>()).results;
 for(const row of due){
  const member=await db.prepare('SELECT * FROM staff_members WHERE id=? AND is_active=1').bind(row.staff_id).first();if(!member)continue;
  const staff=toAuthenticatedStaff(member as never);if(row.kind!=='test'&&(!row.line_account_id||!await canAccessAllLineAccounts(db,staff,[row.line_account_id])||!(['owner','admin'].includes(staff.role)||staff.permissionKeys?.includes('/chats')||staff.viewPermissionKeys?.includes('/chats'))))continue;
  if(row.kind==='assigned_reply'&&(!row.line_account_id||!await canAssignChatTo(db,row.staff_id,row.line_account_id)))continue;
  const pref=await db.prepare('SELECT kinds_json,quiet_start,quiet_end FROM operator_push_preferences WHERE staff_id=?').bind(row.staff_id).first<{kinds_json:string;quiet_start:string;quiet_end:string}>();
  if(row.kind!=='test'&&pref&&(!(JSON.parse(pref.kinds_json) as string[]).includes(row.kind)||pushIsQuiet(pref.quiet_start,pref.quiet_end,now)))continue;
  const conversation=row.kind==='test'?null:await db.prepare('SELECT c.friend_id,c.assignee_staff_id AS operator_id FROM messages_log m JOIN chats c ON c.friend_id=m.friend_id WHERE m.id=? AND m.line_account_id=?').bind(row.ref_id,row.line_account_id).first<{friend_id:string;operator_id:string|null}>();
  if(row.kind!=='test'&&(!conversation||row.kind==='assigned_reply'&&conversation.operator_id!==row.staff_id))continue;
  const claim=await db.prepare("UPDATE operator_push_deliveries SET status='pending',attempts=attempts+1,next_attempt_at=NULL WHERE id=? AND status='failed' AND attempts=?").bind(row.id,row.attempts).run();if(!claim.meta.changes)continue;
  try{
   const payload=pushPayload(row.kind,conversation?.friend_id??''),r=send?await send(row,payload):await sendWebPush({...row,payload,publicKey:env.OPERATOR_PUSH_VAPID_PUBLIC_KEY!,privateKey:env.OPERATOR_PUSH_VAPID_PRIVATE_KEY!,subject:env.OPERATOR_PUSH_VAPID_SUBJECT!});
   const gone=r.status===404||r.status===410,retry=!r.ok&&!gone&&(r.status===429||r.status>=500)&&row.attempts+1<4,next=retry?new Date(now.getTime()+[60000,300000,1800000][Math.min(2,row.attempts)]).toISOString():null;
   await db.prepare('UPDATE operator_push_deliveries SET status=?,error_code=?,next_attempt_at=? WHERE id=?').bind(gone?'gone':r.ok?'sent':'failed',r.ok?null:`push_http_${r.status}`,next,row.id).run();if(gone)await db.prepare('UPDATE operator_push_subscriptions SET revoked_at=? WHERE id=?').bind(now.toISOString(),row.subscription_id).run();
  }catch{await db.prepare("UPDATE operator_push_deliveries SET status='failed',error_code='push_unavailable' WHERE id=?").bind(row.id).run();}
 }
}
