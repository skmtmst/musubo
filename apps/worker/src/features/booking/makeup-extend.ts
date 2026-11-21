import {GapError,gapVersion} from '../../services/gap-common.js';

/** 期限と監査記録を同じトランザクションで保存する。 */
export async function extendMakeup(db:D1Database, account:string, id:string, actor:{id:string;role:string;tenantId:string}, body:Record<string,unknown>) {
 const version=gapVersion(body.expectedVersion);
 if(body.operation!=='extend') throw new GapError('invalid_operation');
 if(typeof body.reason!=='string'||!body.reason.trim()||body.reason.trim().length>1000) throw new GapError('reason_required');
 if(typeof body.expiresAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(body.expiresAt)||!Number.isFinite(Date.parse(body.expiresAt))) throw new GapError('invalid_expires_at');
 const expiresAt=new Date(body.expiresAt).toISOString();
 const current=await db.prepare('SELECT expires_at,status,version FROM booking_makeup_credits WHERE id=? AND line_account_id=?').bind(id,account).first<{expires_at:string;status:string;version:number}>();
 if(!current) throw new GapError('not_found',404);
 if(current.version!==version) throw new GapError('version_conflict',409);
 if(!['open','expired'].includes(current.status)) throw new GapError('invalid_credit_status',409);
 if(Date.parse(expiresAt)<=Date.parse(current.expires_at)||Date.parse(expiresAt)<=Date.now()) throw new GapError('invalid_expires_at');
 const result=await db.batch([
  db.prepare("UPDATE booking_makeup_credits SET expires_at=?,status='open',version=version+1 WHERE id=? AND line_account_id=? AND version=? AND status IN ('open','expired') AND julianday(expires_at)<julianday(?)").bind(expiresAt,id,account,version,expiresAt),
  db.prepare("INSERT INTO audit_events(id,tenant_id,line_account_id,category,actor_principal_id,actor_role,action,target_kind,target_id,result,before_json,after_json,reason) SELECT ?,?,?,'business',?,?,'makeup.extend','booking_makeup_credit',?,'success',?,?,? WHERE changes()=1").bind(crypto.randomUUID(),actor.tenantId,account,actor.id,actor.role,id,JSON.stringify({expiresAt:current.expires_at,version}),JSON.stringify({expiresAt,version:version+1}),body.reason.trim()),
 ]);
 if(!result[0].meta.changes) throw new GapError('version_conflict',409);
 return {id,expiresAt,version:version+1};
}
