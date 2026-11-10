import { jstNow } from '@line-crm/db';

/** 宛先の写しを失った旧配信は、現在の条件で補わず要確認で止める。 */
export async function holdMissingBroadcastAudience(db: D1Database, input: {
  id: string; expected: number; known: number; started: boolean; expectedLockVersion?: number; requireBatchLock?: boolean;
}): Promise<boolean> {
  if (!input.started || (input.known > 0 && (input.expected <= 0 || input.known >= input.expected))) return false;
  const at = jstNow();
  const reason = '開始時の宛先を確認できないため要確認です。現在の条件で取り直さず送信を止めました';
  await db.batch([
    db.prepare(`UPDATE broadcasts SET stopped_at=COALESCE(stopped_at,?),batch_offset=0,batch_lock_at=NULL WHERE id=? AND (? IS NULL OR (status='sending' AND lock_version=? AND stopped_at IS NULL AND (?=0 OR batch_offset=-1)))`)
      .bind(at,input.id,input.expectedLockVersion ?? null,input.expectedLockVersion ?? null,input.requireBatchLock ? 1 : 0),
    db.prepare(`INSERT INTO broadcast_lifecycle_events(id,broadcast_id,action,reason,detail_json,created_at)
      SELECT ?,?,'stopped',?,?,? WHERE changes()=1`).bind(crypto.randomUUID(),input.id,reason,
        JSON.stringify({code:'recipient_snapshot_missing',expected:input.expected,known:input.known}),at),
  ]);
  return true;
}

/** 確認したLINE宛先そのものを、生のIDを保存せずに照合する。 */
export async function broadcastAudienceToken(accountId:string,rows:Array<{id:string;line_user_id:string}>):Promise<string> {
  const ordered=[...rows].sort((a,b)=>a.id.localeCompare(b.id));
  const bytes=new TextEncoder().encode(JSON.stringify([accountId,ordered.map(row=>[row.id,row.line_user_id])]));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
}

export function confirmedHqAudience(broadcast:{hq_run_id?:string|null;message_options_json?:string|null}):{count:number;recipientToken:string}|null {
  if(!broadcast.hq_run_id||!broadcast.message_options_json)return null;
  let parsed:unknown;try{parsed=JSON.parse(broadcast.message_options_json);}catch{return null;}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||!('hqAudienceSnapshot' in parsed))return null;
  const snapshot=(parsed as {hqAudienceSnapshot?:unknown}).hqAudienceSnapshot;
  if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot))throw new Error('invalid_hq_audience_snapshot');
  const value=snapshot as {count?:unknown;recipientToken?:unknown};
  if(!Number.isSafeInteger(value.count)||Number(value.count)<0||typeof value.recipientToken!=='string'||!/^[a-f0-9]{64}$/.test(value.recipientToken))throw new Error('invalid_hq_audience_snapshot');
  return {count:Number(value.count),recipientToken:value.recipientToken};
}
