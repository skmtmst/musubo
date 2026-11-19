import {decryptCredential,encryptCredential} from '@line-crm/db';
import type {MeetingProvider} from './booking-meeting-create.js';
export type ConnectionProvider=MeetingProvider|'outlook';
type Credential={provider:ConnectionProvider;externalAccountId:string;refreshToken:string;accessToken?:string;accessExpiresAt?:string};
type Scope={accountId:string;staffId:string;provider:ConnectionProvider};

async function decode(value:string,provider:ConnectionProvider,key:string):Promise<Credential>{
 const data:unknown=JSON.parse(await decryptCredential(value,key));
 if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('invalid_meeting_credential');
 const v=data as Record<string,unknown>;
 if(v.provider!==provider||typeof v.externalAccountId!=='string'||!v.externalAccountId||typeof v.refreshToken!=='string'||!v.refreshToken)throw new Error('invalid_meeting_credential');
 if((v.accessToken!==undefined&&typeof v.accessToken!=='string')||(v.accessExpiresAt!==undefined&&typeof v.accessExpiresAt!=='string'))throw new Error('invalid_meeting_credential');
 return {provider,externalAccountId:v.externalAccountId,refreshToken:v.refreshToken,...(typeof v.accessToken==='string'?{accessToken:v.accessToken}:{}),...(typeof v.accessExpiresAt==='string'?{accessExpiresAt:v.accessExpiresAt}:{})};
}
/** 管理画面へは接続状態だけを返す。更新用の鍵は返さない。 */
export async function hasMeetingCredential(db:D1Database,input:Scope):Promise<boolean>{
 const row=await db.prepare(`SELECT c.id FROM booking_meeting_connections c JOIN staff s ON s.id=c.staff_id AND s.line_account_id=c.line_account_id AND s.deleted_at IS NULL
 WHERE c.line_account_id=? AND c.staff_id=? AND c.provider=? AND c.refresh_state='ready'`).bind(input.accountId,input.staffId,input.provider).first();
 return !!row;
}
/** 未失効の access token のみ返す。更新用の鍵は返さない。 */
export async function cachedMeetingAccess(db:D1Database,input:Scope & {encryptionKey:string}):Promise<{token:string;externalAccountId:string;expiresAt:string;connectionId:string;version:number}|null>{
 const row=await db.prepare(`SELECT c.id,c.version,c.credential_enc FROM booking_meeting_connections c JOIN staff s ON s.id=c.staff_id AND s.line_account_id=c.line_account_id AND s.deleted_at IS NULL
 WHERE c.line_account_id=? AND c.staff_id=? AND c.provider=? AND c.refresh_state='ready'`).bind(input.accountId,input.staffId,input.provider).first<{id:string;version:number;credential_enc:string}>();
 if(!row)return null;
 const credential=await decode(row.credential_enc,input.provider,input.encryptionKey);
 if(!credential.accessToken||!credential.accessExpiresAt||Date.parse(credential.accessExpiresAt)<=Date.now()+60000||!Number.isFinite(Date.parse(credential.accessExpiresAt)))return null;
 const current=await db.prepare("SELECT id FROM booking_meeting_connections WHERE id=? AND version=? AND refresh_state='ready'").bind(row.id,row.version).first();
 return current?{token:credential.accessToken,externalAccountId:credential.externalAccountId,expiresAt:credential.accessExpiresAt,connectionId:row.id,version:row.version}:null;
}
/** claim が取れなかったとき、更新中と切断・要再接続を区別する。 */
export async function meetingConnectionState(db:D1Database,input:Scope):Promise<'ready'|'refreshing'|'unknown'|'missing'>{
 const row=await db.prepare(`SELECT c.refresh_state FROM booking_meeting_connections c JOIN staff s ON s.id=c.staff_id AND s.line_account_id=c.line_account_id AND s.deleted_at IS NULL
 WHERE c.line_account_id=? AND c.staff_id=? AND c.provider=?`).bind(input.accountId,input.staffId,input.provider).first<{refresh_state:'ready'|'refreshing'|'unknown'}>();
 return row?.refresh_state??'missing';
}
/** 使用中の鍵は再取得しない。通信結果が不明なら自動で再送せず接続し直す。 */
export async function claimMeetingRefresh(db:D1Database,input:Scope & {encryptionKey:string}):Promise<{id:string;claim:string;version:number;credential:Credential}|null>{
 const claim=crypto.randomUUID();
 const row=await db.prepare(`UPDATE booking_meeting_connections SET refresh_state='refreshing',refresh_claim=?,version=version+1,updated_at=?
 WHERE line_account_id=? AND staff_id=? AND provider=? AND refresh_state='ready'
 AND EXISTS(SELECT 1 FROM staff s WHERE s.id=booking_meeting_connections.staff_id AND s.line_account_id=booking_meeting_connections.line_account_id AND s.deleted_at IS NULL)
 RETURNING id,version,credential_enc`).bind(claim,new Date().toISOString(),input.accountId,input.staffId,input.provider).first<{id:string;version:number;credential_enc:string}>();
 if(!row)return null;
 try{return {id:row.id,claim,version:row.version,credential:await decode(row.credential_enc,input.provider,input.encryptionKey)};}
 catch{await failMeetingRefresh(db,{id:row.id,claim,version:row.version});throw new Error('invalid_meeting_credential');}
}
export async function finishMeetingRefresh(db:D1Database,input:{id:string;claim:string;version:number;credential:Credential;encryptionKey:string}):Promise<boolean>{
 const encrypted=await encryptCredential(JSON.stringify(input.credential),input.encryptionKey);
 const r=await db.prepare(`UPDATE booking_meeting_connections SET credential_enc=?,refresh_state='ready',refresh_claim=NULL,version=version+1,updated_at=?
 WHERE id=? AND version=? AND refresh_state='refreshing' AND refresh_claim=? AND provider=?`)
 .bind(encrypted,new Date().toISOString(),input.id,input.version,input.claim,input.credential.provider).run();return r.meta.changes===1;
}
export async function failMeetingRefresh(db:D1Database,input:{id:string;claim:string;version:number}):Promise<boolean>{
 const r=await db.prepare(`UPDATE booking_meeting_connections SET refresh_state='unknown',refresh_claim=NULL,version=version+1,updated_at=?
 WHERE id=? AND version=? AND refresh_state='refreshing' AND refresh_claim=?`).bind(new Date().toISOString(),input.id,input.version,input.claim).run();return r.meta.changes===1;
}
export async function deleteMeetingCredential(db:D1Database,input:Scope):Promise<void>{
 await db.batch([
  db.prepare('DELETE FROM booking_meeting_oauth_states WHERE line_account_id=? AND staff_id=? AND provider=?').bind(input.accountId,input.staffId,input.provider),
  db.prepare('DELETE FROM booking_meeting_connections WHERE line_account_id=? AND staff_id=? AND provider=?').bind(input.accountId,input.staffId,input.provider),
 ]);
}

/** 認可を待つ間に切断された場合、古いコールバックは接続を復活させない。 */
export async function finishAuthorizedMeetingConnection(db:D1Database,input:Scope & {state:string;actorId:string;credential:Credential;encryptionKey:string}):Promise<boolean>{
 if(input.credential.provider!==input.provider||!input.credential.externalAccountId||!input.credential.refreshToken)throw new Error('invalid_meeting_credential');
 const encrypted=await encryptCredential(JSON.stringify(input.credential),input.encryptionKey),now=new Date().toISOString();
 const operations=await db.batch([
  db.prepare(`INSERT INTO booking_meeting_connections(id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at)
   SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM booking_meeting_oauth_states o JOIN staff s ON s.id=o.staff_id AND s.line_account_id=o.line_account_id AND s.deleted_at IS NULL
    WHERE o.state=? AND o.line_account_id=? AND o.staff_id=? AND o.actor_id=? AND o.provider=? AND o.used_at IS NOT NULL AND o.used_at>?)
   ON CONFLICT(line_account_id,staff_id,provider) DO UPDATE SET id=excluded.id,credential_enc=excluded.credential_enc,connected_by=excluded.connected_by,refresh_state='ready',refresh_claim=NULL,version=booking_meeting_connections.version+1,updated_at=excluded.updated_at`)
  .bind(crypto.randomUUID(),input.accountId,input.staffId,input.provider,encrypted,input.actorId,now,now,input.state,input.accountId,input.staffId,input.actorId,input.provider,new Date(Date.now()-120000).toISOString()),
  db.prepare('DELETE FROM booking_meeting_oauth_states WHERE state=? AND line_account_id=? AND actor_id=? AND changes()=1').bind(input.state,input.accountId,input.actorId),
 ]);
 return operations[0].meta.changes===1;
}
/** 鍵の交換が始まっていない、または再利用できる一時障害のときだけ claim を戻す。 */
export async function releaseMeetingRefresh(db:D1Database,input:{id:string;claim:string;version:number}):Promise<boolean>{
 const r=await db.prepare(`UPDATE booking_meeting_connections SET refresh_state='ready',refresh_claim=NULL,version=version+1,updated_at=?
  WHERE id=? AND version=? AND refresh_state='refreshing' AND refresh_claim=?`).bind(new Date().toISOString(),input.id,input.version,input.claim).run();
 return r.meta.changes===1;
}
/** 更新処理が中断したときは、鍵が使われたか分からないため再送しない。 */
export async function recoverStaleMeetingRefresh(db:D1Database,input:Scope & {now?:Date}):Promise<boolean>{
 const now=input.now??new Date(),cutoff=new Date(now.getTime()-120000).toISOString();
 const r=await db.prepare(`UPDATE booking_meeting_connections SET refresh_state='unknown',refresh_claim=NULL,version=version+1,updated_at=?
 WHERE line_account_id=? AND staff_id=? AND provider=? AND refresh_state='refreshing' AND updated_at<?`)
 .bind(now.toISOString(),input.accountId,input.staffId,input.provider,cutoff).run();
 return r.meta.changes===1;
}
