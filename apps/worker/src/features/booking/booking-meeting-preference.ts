import type { MeetingProvider } from './booking-meeting-create.js';

const key = (staffId:string) => `booking.meeting.preferred:${staffId}`;

/** 接続済みの優先先を使い、未選択なら最初に接続した先を使う。 */
export async function preferredMeetingProvider(db:D1Database,input:{accountId:string;staffId:string}):Promise<MeetingProvider|null> {
 const rows=await db.prepare(`SELECT c.provider FROM booking_meeting_connections c
  JOIN staff s ON s.id=c.staff_id AND s.line_account_id=c.line_account_id AND s.deleted_at IS NULL
  WHERE c.line_account_id=? AND c.staff_id=? AND c.provider IN ('google_meet','zoom','teams')
  ORDER BY c.created_at,c.id`).bind(input.accountId,input.staffId).all<{provider:MeetingProvider}>();
 const providers=(rows.results??[]).map(row=>row.provider);
 if(!providers.length)return null;
 const preference=await db.prepare('SELECT value FROM account_settings WHERE line_account_id=? AND key=?')
  .bind(input.accountId,key(input.staffId)).first<{value:string}>();
 return providers.find(provider=>provider===preference?.value)??providers[0];
}

/** 切断済みのサービスは優先先に設定しない。 */
export async function setPreferredMeetingProvider(db:D1Database,input:{accountId:string;staffId:string;provider:MeetingProvider}):Promise<boolean> {
 const result=await db.prepare(`INSERT INTO account_settings (id,line_account_id,key,value)
 SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM booking_meeting_connections c JOIN staff s
 ON s.id=c.staff_id AND s.line_account_id=c.line_account_id AND s.deleted_at IS NULL
 WHERE c.line_account_id=? AND c.staff_id=? AND c.provider=?)
 ON CONFLICT(line_account_id,key) DO UPDATE SET value=excluded.value,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
 .bind(crypto.randomUUID(),input.accountId,key(input.staffId),input.provider,input.accountId,input.staffId,input.provider).run();
 return (result.meta.changes??0)===1;
}
