import type {Message} from '@line-crm/line-sdk';
import {GapError} from '../../services/gap-common.js';
import {assertChanged,clearAssertions} from '../booking/booking-series/index.js';
import {abAudience,splitAb} from './broadcast-ab.js';
import {broadcastWideContext} from './broadcast-wide-context.js';
import {CommonVarResolutionFailedError,resolveSendCommonVars} from '../../services/interpolation-context.js';
import {assertNoUnresolvedBroadcastVariables,hasRecipientVariables,renderMessageContent} from '../../services/render-message.js';

export interface AbLiveTransmitInput{broadcastId:string;variantKey:'A'|'B';to:string[];messages:Message[];retryKey:string}
export type AbLiveTransmit=(input:AbLiveTransmitInput)=>Promise<unknown>;

/**
 * A/B の本送信を始める。710 の試験用表は読むだけで変えない。送達の実績は
 * 769 の表だけに書く。通常の送信（broadcasts の sending）には流さない。
 * 旗がなければ始めない。試し（A/B）を送り、残り（R）は判定（R4b）まで待つ。
 */
export async function startAbLive(db:D1Database,id:string,expectedVersion:number,count:number,key:string,opts:{transmit:AbLiveTransmit;liveDeliveryEnabled:boolean;now?:Date}){
 if(!opts.liveDeliveryEnabled)throw new GapError('live_delivery_disabled',409);
 const now=opts.now??new Date(),at=now.toISOString();
 const t=await db.prepare('SELECT test_ratio_pct,metric,decide_after_minutes,undecided_policy,status FROM broadcast_ab_tests WHERE broadcast_id=?').bind(id).first<{test_ratio_pct:number;metric:'click';decide_after_minutes:number;undecided_policy:'stop'|'send_a';status:string}>();
 if(!t)throw new GapError('ab_not_found',404);
 const live=await db.prepare('SELECT start_key,start_request_json,start_result_json FROM broadcast_ab_live_tests WHERE broadcast_id=?').bind(id).first<{start_key:string|null;start_request_json:string|null;start_result_json:string|null}>();
 const request=JSON.stringify({expectedVersion,count});
 if(live?.start_key===key){if(live.start_request_json!==request||!live.start_result_json)throw new GapError('idempotency_conflict',409);return JSON.parse(live.start_result_json);}
 if(live||t.status!=='draft')throw new GapError('ab_already_started',409);
 const {ids}=await abAudience(db,id);
 if(ids.length!==count)throw new GapError('SEND_PREVIEW_CHANGED',409);
 const rows=splitAb(ids,t.test_ratio_pct);
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
  db.prepare("INSERT INTO broadcast_ab_live_tests(broadcast_id,test_ratio_pct,metric,decide_after_minutes,undecided_policy,status,started_at,decide_at,version,start_key,start_request_json,start_result_json,created_at) VALUES(?,?,?,?,?,'live_testing',?,?,1,?,?,?,?)").bind(id,t.test_ratio_pct,t.metric,t.decide_after_minutes,t.undecided_policy,at,decide,key,request,JSON.stringify(result),at)];
 for(let i=0;i<rows.length;i+=100){const chunk=rows.slice(i,i+100);statements.push(db.prepare("INSERT INTO broadcast_ab_live_recipients(broadcast_id,friend_id,variant_key,state) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.key'),'pending' FROM json_each(?)").bind(id,JSON.stringify(chunk)));}
 statements.push(clearAssertions(db));
 try{await db.batch(statements);}catch(e){if(/CHECK constraint|UNIQUE constraint/.test(String(e)))throw new GapError('version_conflict',409);throw e;}
 const lineUsers=new Map((await db.prepare(`SELECT id,line_user_id FROM friends WHERE line_account_id=(SELECT line_account_id FROM broadcasts WHERE id=?) AND id IN (SELECT friend_id FROM broadcast_ab_live_recipients WHERE broadcast_id=?)`).bind(id,id).all<{id:string;line_user_id:string|null}>()).results.map(r=>[r.id,r.line_user_id]));
 for(const variantKey of ['A','B'] as const){
  const targets=rows.filter(x=>x.key===variantKey),to=targets.map(x=>lineUsers.get(x.id)).filter((v):v is string=>!!v);
  const messages=resolvedByVariant.get(variantKey)!;
  try{
   await opts.transmit({broadcastId:id,variantKey,to,messages,retryKey:crypto.randomUUID()});
   await markLive(db,id,variantKey,'sent',at);
  }catch{await markLive(db,id,variantKey,'failed',at);}
 }
 return result;
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

async function markLive(db:D1Database,id:string,variantKey:'A'|'B',state:'sent'|'failed',at:string){
 await db.prepare("UPDATE broadcast_ab_live_recipients SET state=?,sent_at=CASE WHEN ?='sent' THEN ? ELSE NULL END,attempt_count=attempt_count+1 WHERE broadcast_id=? AND variant_key=? AND state='pending'").bind(state,state,at,id,variantKey).run();
}

/** 通常の送信と同じ multicast（500人ずつ）で試しを送る。 */
export function createAbLiveTransmit(lineClient:{multicast:(to:string[],messages:Message[],units?:string[],retryKey?:string)=>Promise<unknown>}):AbLiveTransmit{
 return async input=>{
  for(let i=0;i<input.to.length;i+=500){
   const chunk=input.to.slice(i,i+500);
   await lineClient.multicast(chunk,input.messages,undefined,`${input.retryKey}:${Math.floor(i/500)}`);
  }
 };
}
