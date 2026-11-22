import type {ConnectionProvider} from './booking-meeting-credentials.js';

type Scope={accountId:string;staffId:string;provider:ConnectionProvider};
// Google の許可は同じ OAuth プロジェクト内の他の接続にも及ぶため、解除中は Google の新規認可を全体で待つ。
export function revokeLockKey(scope:Scope):string{return scope.provider==='google_meet'?'google_meet':JSON.stringify([scope.provider,scope.accountId,scope.staffId]);}
export const revokeLockCondition="NOT EXISTS (SELECT 1 FROM workflow_steps w WHERE w.scope_id='global:meeting-revoke' AND w.process_kind='booking_meeting_revoke_lock' AND w.subject_id=? AND w.step_key='lock' AND w.status='running' AND w.lease_expires_at>?)";
export async function meetingRevokeLocked(db:D1Database,scope:Scope,now=Date.now()):Promise<boolean>{
 return !!await db.prepare(`SELECT 1 WHERE NOT (${revokeLockCondition})`).bind(revokeLockKey(scope),now).first();
}
export async function acquireMeetingRevokeLock(db:D1Database,scope:Scope,now=Date.now()):Promise<string|null>{
 const key=revokeLockKey(scope),claim=crypto.randomUUID(),cutoff=new Date(now-120000).toISOString(),timestamp=new Date(now).toISOString();
 const result=await db.prepare(`INSERT INTO workflow_steps(scope_id,process_kind,subject_id,step_key,status,lease_owner,lease_expires_at,retry_key,created_at,updated_at)
 SELECT 'global:meeting-revoke','booking_meeting_revoke_lock',?,'lock','running',?,?,?, ?,?
 WHERE NOT EXISTS(SELECT 1 FROM booking_meeting_oauth_states WHERE provider=? AND (?='google_meet' OR (line_account_id=? AND staff_id=?)) AND ((used_at IS NULL AND expires_at>?) OR used_at>?))
 ON CONFLICT(scope_id,process_kind,subject_id,step_key) DO UPDATE SET status='running',lease_owner=excluded.lease_owner,lease_expires_at=excluded.lease_expires_at,updated_at=excluded.updated_at
 WHERE workflow_steps.status<>'running' OR workflow_steps.lease_expires_at<=?`)
 .bind(key,claim,now+120000,claim,now,now,scope.provider,scope.provider,scope.accountId,scope.staffId,timestamp,cutoff,now).run();
 return result.meta.changes===1?claim:null;
}
export async function releaseMeetingRevokeLock(db:D1Database,scope:Scope,claim:string):Promise<void>{
 await db.prepare("UPDATE workflow_steps SET status='succeeded',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE scope_id='global:meeting-revoke' AND process_kind='booking_meeting_revoke_lock' AND subject_id=? AND step_key='lock' AND status='running' AND lease_owner=?").bind(Date.now(),revokeLockKey(scope),claim).run();
}
export async function ownsMeetingRevokeLock(db:D1Database,scope:Scope,claim:string,now=Date.now()):Promise<boolean>{
 return !!await db.prepare("SELECT 1 FROM workflow_steps WHERE scope_id='global:meeting-revoke' AND process_kind='booking_meeting_revoke_lock' AND subject_id=? AND step_key='lock' AND status='running' AND lease_owner=? AND lease_expires_at>?").bind(revokeLockKey(scope),claim,now+20000).first();
}
