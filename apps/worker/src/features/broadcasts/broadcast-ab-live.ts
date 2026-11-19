import type {Message} from '@line-crm/line-sdk';
import {GapError} from '../../services/gap-common.js';
import {assertChanged,clearAssertions} from '../booking/booking-series/index.js';
import {abAudience,splitAb} from './broadcast-ab.js';
import {broadcastWideContext} from './broadcast-wide-context.js';
import {CommonVarResolutionFailedError,resolveSendCommonVars} from '../../services/interpolation-context.js';
import {assertNoUnresolvedBroadcastVariables,hasRecipientVariables,renderMessageContent} from '../../services/render-message.js';
import {isOperationCapabilityStopped} from '@line-crm/db';
import {broadcastQuietHoursShift} from '../../services/gap-send-preview.js';
import {createBroadcastRetryKey} from './broadcast-retry-key.js';
import {sendRecordedNotification} from '../../services/recorded-notification-send.js';

export interface AbLiveTransmitInput{broadcastId:string;variantKey:'A'|'B';friendId:string;to:string[];messages:Message[];retryKey:string}
export type AbLiveTransmit=(input:AbLiveTransmitInput)=>Promise<unknown>;

/** 宛先条件とテスト宛先の両方を満たす人だけを数える。 */
export async function liveTestAudience(db:D1Database,id:string){
 const audience=await abAudience(db,id);
 const setting=await db.prepare("SELECT value FROM account_settings WHERE line_account_id=? AND key='test_recipients'").bind(audience.account).first<{value:string}>();
 let allowed:unknown;try{allowed=JSON.parse(setting?.value??'null');}catch{allowed=null;}
 if(!Array.isArray(allowed)||!allowed.length||allowed.length>90||allowed.some(x=>typeof x!=='string')||new Set(allowed).size!==allowed.length)throw new GapError('invalid_test_recipients',409);
 const permitted=new Set<string>(allowed),ids=audience.ids.filter(friend=>permitted.has(friend));
 return {ids,setting};
}

/** 開始処理が失われた場合は再送せず、確認が必要な停止として残す。 */
export async function recoverAbLiveStart(db:D1Database,id:string,now=new Date()){
 await db.prepare(`UPDATE broadcast_ab_live_tests SET status='live_stopped',
  start_result_json=json_object('status','live_stopped','reason','interrupted','testMode',json('false'))
  WHERE broadcast_id=? AND status='live_testing' AND start_result_json IS NULL
   AND julianday(started_at)<=julianday(?,'-15 minutes')`).bind(id,now.toISOString()).run();
}

/**
 * A/B の本送信を始める。710 の試験用表は読むだけで変えない。送達の実績は
 * 764 の表だけに書く。通常の送信（broadcasts の sending）には流さない。
 * 旗がなければ始めない。試し（A/B）を送り、残り（R）は判定（R4b）まで待つ。
 */
export async function startAbLive(db:D1Database,id:string,expectedVersion:number,count:number,key:string,opts:{transmit:AbLiveTransmit;liveDeliveryEnabled:boolean;now?:Date}){
 if(!opts.liveDeliveryEnabled)throw new GapError('live_delivery_disabled',409);
 const now=opts.now??new Date(),at=now.toISOString();
 const t=await db.prepare('SELECT test_ratio_pct,metric,decide_after_minutes,undecided_policy,status FROM broadcast_ab_tests WHERE broadcast_id=?').bind(id).first<{test_ratio_pct:number;metric:'click';decide_after_minutes:number;undecided_policy:'stop'|'send_a';status:string}>();
 if(!t)throw new GapError('ab_not_found',404);
 const live=await db.prepare('SELECT start_key,start_request_json,start_result_json FROM broadcast_ab_live_tests WHERE broadcast_id=?').bind(id).first<{start_key:string|null;start_request_json:string|null;start_result_json:string|null}>();
 const request=JSON.stringify({expectedVersion,count});
 if(live?.start_key===key){if(live.start_request_json!==request)throw new GapError('idempotency_conflict',409);if(!live.start_result_json)throw new GapError('ab_delivery_in_progress',409);return JSON.parse(live.start_result_json);}
 if(live||t.status!=='draft')throw new GapError('ab_already_started',409);
 const {ids,setting}=await liveTestAudience(db,id);
 if(ids.length!==count)throw new GapError('SEND_PREVIEW_CHANGED',409);
 if(ids.length<2)throw new GapError('AB_AUDIENCE_TOO_SMALL',409);
 const rows=splitAb(ids,t.test_ratio_pct,undefined,true);
 const variantRows=(await db.prepare('SELECT variant_key,messages_json FROM broadcast_variants WHERE broadcast_id=?').bind(id).all<{variant_key:string;messages_json:string}>()).results;
 if(variantRows.length!==2)throw new GapError('two_variants_required');
 const decide=new Date(now.getTime()+t.decide_after_minutes*60000).toISOString();
 const counts={A:rows.filter(x=>x.key==='A').length,B:rows.filter(x=>x.key==='B').length,R:rows.filter(x=>x.key==='R').length};
 const result={status:'live_testing',decideAt:decide,counts,testMode:false};
 // 差し込みの解決は記録より先に確かめる。人別はまとめ送りできないため開始しない。
 const account=(await db.prepare('SELECT line_account_id FROM broadcasts WHERE id=?').bind(id).first<{line_account_id:string|null}>())?.line_account_id??null;
 const resolvedByVariant=new Map<string,Message[]>();
 for(const variantKey of ['A','B']){
  const raw=variantRows.find(v=>v.variant_key===variantKey)!.messages_json;
  let parsed:Message[];try{parsed=JSON.parse(raw) as Message[];if(!Array.isArray(parsed)||parsed.length===0)throw new GapError('two_variants_required',409);}catch(error){if(error instanceof GapError)throw error;throw new GapError('two_variants_required',409);}
  resolvedByVariant.set(variantKey,await resolveLiveVariantMessages(db,account,id,parsed,now));
 }
 const statements=[db.prepare("UPDATE broadcasts SET lock_version=lock_version+1 WHERE id=? AND status='draft' AND stopped_at IS NULL AND lock_version=?").bind(id,expectedVersion),assertChanged(db),
  db.prepare("INSERT INTO broadcast_ab_live_tests(broadcast_id,test_ratio_pct,metric,decide_after_minutes,undecided_policy,status,started_at,decide_at,version,start_key,start_request_json,start_result_json,created_at) VALUES(?,?,?,?,?,'live_testing',?,?,1,?,?,?,?)").bind(id,t.test_ratio_pct,t.metric,t.decide_after_minutes,t.undecided_policy,at,decide,key,request,null,at)];
 for(let i=0;i<rows.length;i+=100){const chunk=rows.slice(i,i+100);statements.push(db.prepare("INSERT INTO broadcast_ab_live_recipients(broadcast_id,friend_id,variant_key,state) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.key'),'pending' FROM json_each(?)").bind(id,JSON.stringify(chunk)));}
 statements.push(clearAssertions(db));
 try{await db.batch(statements);}catch(e){if(/CHECK constraint|UNIQUE constraint/.test(String(e)))throw new GapError('version_conflict',409);throw e;}
 const lineUsers=new Map((await db.prepare(`SELECT id,line_user_id FROM friends WHERE line_account_id=(SELECT line_account_id FROM broadcasts WHERE id=?) AND id IN (SELECT friend_id FROM broadcast_ab_live_recipients WHERE broadcast_id=?)`).bind(id,id).all<{id:string;line_user_id:string|null}>()).results.map(r=>[r.id,r.line_user_id]));
 try{
 for(const variantKey of ['A','B'] as const){
  const targets=rows.filter(x=>x.key===variantKey);
  const unavailable=targets.filter(x=>!lineUsers.get(x.id)).map(x=>x.id);
  if(unavailable.length)await markLive(db,id,variantKey,unavailable,'failed',at);
  const sendable=targets.flatMap(x=>{const lineUserId=lineUsers.get(x.id);return lineUserId?[{friendId:x.id,lineUserId}]:[];});
  const messages=resolvedByVariant.get(variantKey)!;
  for(let i=0;i<sendable.length;i++){
   const chunk=sendable.slice(i,i+1),friendIds=chunk.map(x=>x.friendId);
   // 送信開始を先に記録する。途中停止しても結果不明として残し再送しない。
   const active=await db.prepare("SELECT b.stopped_at FROM broadcasts b JOIN broadcast_ab_live_tests t ON t.broadcast_id=b.id WHERE b.id=? AND t.status='live_testing' AND t.start_result_json IS NULL").bind(id).first<{stopped_at:string|null}>();
   if(!active||active.stopped_at||!account||await isOperationCapabilityStopped(db,account,'broadcast_dispatch')||await broadcastQuietHoursShift(db,account,new Date().toISOString()))throw new GapError('ab_delivery_stopped',409);
   const current=await abAudience(db,id);
   const latest=await db.prepare("SELECT value FROM account_settings WHERE line_account_id=? AND key='test_recipients'").bind(current.account).first<{value:string}>();
   const latestUsers=(await db.prepare(`SELECT id,line_user_id FROM friends WHERE line_account_id=? AND id IN (SELECT value FROM json_each(?))`).bind(current.account,JSON.stringify(friendIds)).all<{id:string;line_user_id:string|null}>()).results;
   if(latest?.value!==setting?.value||friendIds.some(friend=>!current.ids.includes(friend)||latestUsers.find(x=>x.id===friend)?.line_user_id!==lineUsers.get(friend)))throw new GapError('test_recipients_changed',409);
   const claimed=await db.prepare("UPDATE broadcast_ab_live_recipients SET state='unknown',attempt_count=attempt_count+1 WHERE broadcast_id=? AND variant_key=? AND state='pending' AND friend_id IN (SELECT value FROM json_each(?))").bind(id,variantKey,JSON.stringify(friendIds)).run();
   if(claimed.meta.changes!==friendIds.length)throw new GapError('ab_delivery_already_claimed',409);
   try{
    await sendRecordedNotification(db,{sourceId:`ab-live:${id}:${chunk[0].friendId}`,channel:'line',recipient:chunk[0].friendId,lineAccountId:account,payload:JSON.stringify(messages),send:retryKey=>opts.transmit({broadcastId:id,variantKey,friendId:chunk[0].friendId,to:chunk.map(x=>x.lineUserId),messages,retryKey})});
   }catch{
    // 結果が分からない要求は共有台帳でも自動再送を禁止する。
    const retryKey=await createBroadcastRetryKey('notification',`ab-live:${id}:${chunk[0].friendId}`,'line',chunk[0].friendId);
    await db.prepare("UPDATE outbound_send_requests SET status='unknown',retryable=0,next_retry_at=NULL WHERE idempotency_key=? AND status='failed'").bind(retryKey).run();
    throw new GapError('ab_delivery_unknown',409);
   }
   await db.prepare("UPDATE broadcast_ab_live_recipients SET state='sent',sent_at=? WHERE broadcast_id=? AND variant_key=? AND state='unknown' AND friend_id IN (SELECT value FROM json_each(?))").bind(new Date().toISOString(),id,variantKey,JSON.stringify(friendIds)).run();
  }
 }
 const completed=await db.prepare("UPDATE broadcast_ab_live_tests SET start_result_json=? WHERE broadcast_id=? AND status='live_testing' AND start_result_json IS NULL").bind(JSON.stringify(result),id).run();
 if(completed.meta.changes!==1)throw new GapError('ab_delivery_stopped',409);
 return result;
 }catch(error){
 const reason=error instanceof GapError?error.code:'ab_delivery_unknown';
 await db.prepare("UPDATE broadcast_ab_live_tests SET status='live_stopped',start_result_json=? WHERE broadcast_id=? AND status='live_testing'").bind(JSON.stringify({status:'live_stopped',reason,counts,testMode:false}),id).run();
 throw error;
 }
}

/** 案文の共通情報を厳格に解く。人別の差し込みはまとめ送りできないため開始しない。 */
async function resolveLiveVariantMessages(db:D1Database,accountId:string|null,id:string,messages:Message[],now:Date):Promise<Message[]>{
 const out:Message[]=[];
 for(const message of messages){
  if(message.type!=='text'){out.push(message);continue;}
  const text=(message as {text?:unknown}).text;
  if(typeof text!=='string'){out.push(message);continue;}
  if(hasRecipientVariables(text))throw new GapError('ab_live_personalization_unsupported',409);
  const context=await broadcastWideContext(db,accountId,text,undefined,id);
  try{context.vars=await resolveSendCommonVars(db,accountId,text,{kind:'broadcast',id},now.toISOString());}
  catch(error){if(error instanceof CommonVarResolutionFailedError)throw new GapError('common_var_unresolved',409);throw error;}
  const rendered=renderMessageContent(text,{...context,deliveredAt:now});
  try{assertNoUnresolvedBroadcastVariables(rendered);}catch{throw new GapError('common_var_unresolved',409);}
  out.push({...message,text:rendered} as Message);
 }
 return out;
}

async function markLive(db:D1Database,id:string,variantKey:'A'|'B',friendIds:string[],state:'sent'|'failed'|'unknown',at:string){
 for(let i=0;i<friendIds.length;i+=500){
  await db.prepare("UPDATE broadcast_ab_live_recipients SET state=?,sent_at=CASE WHEN ?='sent' THEN ? ELSE NULL END,attempt_count=attempt_count+1 WHERE broadcast_id=? AND variant_key=? AND state='pending' AND friend_id IN (SELECT value FROM json_each(?))").bind(state,state,at,id,variantKey,JSON.stringify(friendIds.slice(i,i+500))).run();
 }
}
