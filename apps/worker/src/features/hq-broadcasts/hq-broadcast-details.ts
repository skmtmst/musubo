import type { HqMediaRuntime } from '../../services/hq-media.js';
import { getLineAccountById, getFriendFieldMap } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import { StampError } from '../../services/visit-stamps.js';
import { addTestLabel, parseBroadcastMessageParts, buildMessages, renderMessageParts, combinedMessageContent, assertMessagePartsResolved } from '../broadcasts/broadcast-message-set/index.js';
import { resolveSendCommonVars, contentNeedsFriendFields } from '../../services/interpolation-context.js';
import { getHqBroadcastRun, mappedHqContent } from '../../services/hq-broadcasts.js';
import type { HqBroadcastInput } from '@line-crm/shared';
import { resolveHqBroadcastMaterials } from './hq-broadcast-materials.js';
type Run=Awaited<ReturnType<typeof getHqBroadcastRun>>;
async function child(db:D1Database,run:Run,accountId:string) {
  const target=await db.prepare(`SELECT t.broadcast_id FROM hq_broadcast_targets t JOIN line_accounts a ON a.id=t.line_account_id AND a.tenant_id=?
    WHERE t.run_id=? AND t.line_account_id=?`).bind(run.tenant_id,run.id,accountId).first<{broadcast_id:string|null}>();
  if(!target)throw new StampError('対象店が見つかりません',404);
  return target.broadcast_id;
}
export async function hqBroadcastRecipients(db:D1Database,run:Run,accountId:string,offset:number,limit:number) {
  const id=await child(db,run,accountId);
  if(!id)return {rows:[],total:0,nextCursor:null};
  const total=await db.prepare('SELECT COUNT(*) AS count FROM broadcast_send_claims WHERE broadcast_id=? AND line_account_id=?').bind(id,accountId).first<{count:number}>();
  const rows=(await db.prepare(`SELECT s.friend_id AS friendId,f.display_name AS displayName,s.state,s.attempt_no AS attemptNo,
      CASE WHEN s.state='sent' THEN s.settled_at ELSE NULL END AS sentAt,s.error_code AS errorCode,s.created_at AS claimedAt
    FROM broadcast_send_claims s JOIN friends f ON f.id=s.friend_id AND f.line_account_id=?
    WHERE s.broadcast_id=? AND s.line_account_id=? ORDER BY s.friend_id LIMIT ? OFFSET ?`).bind(accountId,id,accountId,limit,offset).all()).results;
  return {rows,total:total!.count,nextCursor:offset+rows.length<total!.count?String(offset+rows.length):null};
}
export async function hqBroadcastActivity(db:D1Database,run:Run,offset:number,limit:number) {
  const rows=(await db.prepare(`SELECT id,line_account_id AS accountId,actor_id AS actorId,action,created_at AS createdAt
    FROM hq_broadcast_audit WHERE run_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).bind(run.id,limit+1,offset).all()).results;
  return {rows:rows.slice(0,limit),nextCursor:rows.length>limit?String(offset+limit):null};
}
type TestFriend = {id:string;line_user_id:string;display_name:string|null};
export class HqTestRecipientConflict extends StampError {
  constructor(public current: {count:number;recipients:Array<{id:string;displayName:string|null}>}) {
    super('テスト宛先が変わりました。もう一度確認してください',409);
  }
}
async function readTestRecipients(db:D1Database,accountId:string) {
  const setting=await db.prepare(`SELECT value FROM account_settings WHERE line_account_id=? AND key='test_recipients'`).bind(accountId).first<{value:string}>();
  let ids:unknown;try{ids=JSON.parse(setting?.value??'null');}catch{ids=null;}
  const shape=Array.isArray(ids)&&ids.length>0&&ids.length<=5&&ids.every(id=>typeof id==='string')&&new Set(ids).size===ids.length;
  const list=Array.isArray(ids)?ids:[];
  const friends=shape?(await db.prepare(`SELECT id,line_user_id,display_name FROM friends WHERE line_account_id=? AND id IN (${list.map(()=>'?').join(',')})
    AND is_following=1 AND COALESCE(is_hidden,0)=0 AND line_user_id IS NOT NULL AND line_user_id<>''`).bind(accountId,...list).all<TestFriend>()).results:[];
  const valid=shape&&friends.length===list.length;
  const ordered=[...friends].sort((a,b)=>a.id.localeCompare(b.id));
  const bytes=new TextEncoder().encode(JSON.stringify([accountId,ordered.map(f=>[f.id,f.line_user_id])]));
  const token=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
  return {valid,shape,friends,token,count:friends.length,recipients:ordered.map(f=>({id:f.id,displayName:f.display_name}))};
}
export async function hqTestRecipientPreview(db:D1Database,tenantId:string,accountId:string) {
  const account=await db.prepare('SELECT id FROM line_accounts WHERE id=? AND tenant_id=?').bind(accountId,tenantId).first();
  if(!account)throw new StampError('対象店が見つかりません',404);
  const current=await readTestRecipients(db,accountId);
  if(!current.valid)throw new StampError('店のテスト宛先を確認してください',409);
  return {count:current.count,recipients:current.recipients,token:current.token};
}
/** 店と同じテスト宛先・吹き出し・差し込みを使う。送信前に全宛先を店の中へ限定する。 */
export async function testHqBroadcast(db:D1Database,run:Run,actorId:string,accountId:string,runtime?:HqMediaRuntime,expectedRecipientToken?:string) {
  if(run.status!=='prepared')throw new StampError('下書きだけテスト送信できます',409);
  await child(db,run,accountId);
  const account=await getLineAccountById(db,accountId);
  if(!account?.channel_access_token||!account.is_active||account.archived_at)throw new StampError('店のLINE接続を確認してください',409);
  const {isOperationCapabilityStopped}=await import('@line-crm/db');
  const {featureJobCanRun}=await import('../../services/feature-enforcement.js');
  if(await isOperationCapabilityStopped(db,accountId,'broadcast_dispatch')||!await featureJobCanRun(db,{accountId,featureId:'broadcasts',job:'broadcast deliveries'}))throw new StampError('店の配信は停止中です',409);
  const current=await readTestRecipients(db,accountId);
  if(expectedRecipientToken!==undefined&&(!current.valid||current.token!==expectedRecipientToken))throw new HqTestRecipientConflict({count:current.count,recipients:current.recipients});
  if(!current.shape)throw new StampError('店のテスト宛先を1〜5人で設定してください');
  if(!current.valid)throw new StampError('テスト宛先がこの店に属しているか確認してください',403);
  const friends=current.friends;
  const input=await resolveHqBroadcastMaterials(db,run.tenant_id,accountId,JSON.parse(run.input_json) as HqBroadcastInput,runtime ? {...runtime,copy:true} : undefined),parts=addTestLabel(parseBroadcastMessageParts({...input,...mappedHqContent(input,account.name,account.liff_id)}));
  const content=combinedMessageContent(parts),vars=await resolveSendCommonVars(db,accountId,content,{kind:'test_send',id:run.id});
  const rendered=[];
  for(const f of friends){const fields=contentNeedsFriendFields(content)?await getFriendFieldMap(db,f.id):undefined;
    const p=renderMessageParts(parts,{displayName:f.display_name,liffId:account.liff_id,vars,fields,deliveredAt:new Date()});assertMessagePartsResolved(p);rendered.push({friend:f,parts:p});}
  if(expectedRecipientToken!==undefined){
    const latest=await readTestRecipients(db,accountId);
    if(!latest.valid||latest.token!==expectedRecipientToken)throw new HqTestRecipientConflict({count:latest.count,recipients:latest.recipients});
  }
  const claim=await db.prepare(`INSERT INTO hq_broadcast_audit(id,run_id,line_account_id,actor_id,action)
    SELECT ?,?,?,?,'test_send' WHERE NOT EXISTS(SELECT 1 FROM hq_broadcast_audit WHERE run_id=? AND line_account_id=? AND actor_id=? AND action='test_send' AND datetime(created_at)>=datetime('now','-10 seconds'))`)
    .bind(crypto.randomUUID(),run.id,accountId,actorId,run.id,accountId,actorId).run();
  if(!claim.meta.changes)throw new StampError('10秒待ってからテストしてください',429);
  const client=new LineClient(account.channel_access_token);let sent=0,failed=0;
  for(const item of rendered){try{await client.pushMessage(item.friend.line_user_id,buildMessages(item.parts));sent++;
    await db.batch(item.parts.map(p=>db.prepare(`INSERT INTO messages_log(id,friend_id,direction,message_type,content,delivery_type,source,line_account_id) VALUES (?,?,'outgoing',?,?,'test','broadcast',?)`)
      .bind(crypto.randomUUID(),item.friend.id,p.messageType,p.messageContent,accountId)));}catch{failed++;}}
  return {sent,failed};
}
