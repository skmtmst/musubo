import {decryptCredential,encryptCredential} from '@line-crm/db';
import type {ConnectionProvider} from './booking-meeting-credentials.js';
/** ランダムな state は本人と店に結び付け、一度だけ使用する。 */
export async function beginMeetingAuthorization(db:D1Database,input:{accountId:string;staffId:string;actorId:string;provider:ConnectionProvider;verifier:string;encryptionKey:string;now?:Date}):Promise<string>{
 const now=input.now??new Date(),state=crypto.randomUUID()+crypto.randomUUID();
 const value=await encryptCredential(input.verifier,input.encryptionKey);
 const operations=await db.batch([
  db.prepare('DELETE FROM booking_meeting_oauth_states WHERE line_account_id=? AND staff_id=? AND provider=?').bind(input.accountId,input.staffId,input.provider),
  db.prepare(`INSERT INTO booking_meeting_oauth_states(state,line_account_id,staff_id,actor_id,provider,verifier_enc,expires_at,created_at)
   SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM staff WHERE id=? AND line_account_id=? AND deleted_at IS NULL)`)
   .bind(state,input.accountId,input.staffId,input.actorId,input.provider,value,new Date(now.getTime()+600000).toISOString(),now.toISOString(),input.staffId,input.accountId),
 ]);
 if(operations[1].meta.changes!==1)throw new Error('staff_not_found');return state;
}
export async function consumeMeetingAuthorization(db:D1Database,input:{accountId:string;state:string;actorId:string;encryptionKey:string;now?:Date}):Promise<{staffId:string;provider:ConnectionProvider;verifier:string}|null>{
 if(!/^[0-9a-f-]{72}$/.test(input.state))return null;
 const row=await db.prepare(`UPDATE booking_meeting_oauth_states SET used_at=? WHERE state=? AND line_account_id=? AND actor_id=? AND used_at IS NULL AND expires_at>?
 AND EXISTS(SELECT 1 FROM staff s WHERE s.id=booking_meeting_oauth_states.staff_id AND s.line_account_id=booking_meeting_oauth_states.line_account_id AND s.deleted_at IS NULL)
 RETURNING staff_id,provider,verifier_enc`).bind((input.now??new Date()).toISOString(),input.state,input.accountId,input.actorId,(input.now??new Date()).toISOString())
 .first<{staff_id:string;provider:ConnectionProvider;verifier_enc:string}>();
 if(!row)return null;
 try{return {staffId:row.staff_id,provider:row.provider,verifier:await decryptCredential(row.verifier_enc,input.encryptionKey)};}catch{return null;}
}
