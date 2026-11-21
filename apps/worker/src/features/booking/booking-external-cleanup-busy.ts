import {decryptCredential} from '@line-crm/db';
import type {CleanupPlanItem} from './booking-external-cleanup-plan.js';
import {cleanupIndex} from './booking-external-cleanup-proof.js';

/** 後片づけ前の予定を、その担当者・接続先の予約として空き計算から除く。 */
export async function cleanupOwnEventIds(db:D1Database,input:{accountId:string;staffId:string;provider:'google_calendar'|'outlook';encryptionKey?:string;calendarId?:string;connectionId?:string;externalAccountId?:string}):Promise<string[]> {
 const scope=`line:${input.accountId}`;
 if(!input.encryptionKey){if(await db.prepare("SELECT 1 FROM workflow_steps WHERE scope_id=? AND process_kind='booking_external_cleanup' LIMIT 1").bind(scope).first())throw new Error('cleanup_busy_unavailable');return [];}
 const tag=await cleanupIndex(input.encryptionKey,input.accountId,input.provider,input.staffId);
 // 鍵が変わった場合、古い索引を無視して誤って空きにしない。
 if(await db.prepare("SELECT 1 FROM workflow_steps WHERE scope_id=? AND process_kind='booking_external_cleanup' AND substr(retry_key,1,?)<>? LIMIT 1").bind(scope,tag.prefix.length,tag.prefix).first())throw new Error('cleanup_busy_unavailable');
 const rows=await db.prepare("SELECT input_json FROM workflow_steps WHERE scope_id=? AND process_kind='booking_external_cleanup' AND retry_key=? LIMIT 501")
  .bind(scope,tag.index).all<{input_json:string|null}>();
 if((rows.results?.length??0)>500)throw new Error('cleanup_busy_unavailable');
 if(!rows.results?.length)return [];
 const ids:string[]=[];
 try {
  for(const row of rows.results){
   const payload:unknown=JSON.parse(row.input_json??'null');if(typeof payload!=='string')throw new Error('invalid');
   const item=JSON.parse(await decryptCredential(payload,input.encryptionKey)) as CleanupPlanItem;
   if(item.provider!==input.provider||item.staffId!==input.staffId)continue;
   if(item.uncertainty==='create')continue;
   if(item.provider==='google_calendar'&&(item.calendarId!==input.calendarId||item.connectionId!==input.connectionId))continue;
   if(item.provider==='outlook'&&item.externalAccountId!==input.externalAccountId)continue;
   if(item.remoteId)ids.push(item.remoteId);
  }
 }catch{throw new Error('cleanup_busy_unavailable');}
 return [...new Set(ids)];
}
