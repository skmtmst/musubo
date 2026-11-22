import { DEFAULT_TENANT_ID, getAccountSetting, toJstString } from '@line-crm/db';
import { parseRetentionPolicy, RETENTION_POLICY_KEY, retentionCutoff } from './retention-policy.js';

/** 顧客削除後の予約監査だけ、運用上3650日後に消す。会計の決済行は対象外。 */
export async function processBookingAuditRetention(db:D1Database,now=new Date()):Promise<{deleted:number;failed:number}> {
 const cutoff=retentionCutoff(now,3650);
 const validPolicy=(prefix:string)=>`json_type(s.value,'$.${prefix}hold')='false'
   AND json_type(s.value,'$.${prefix}enabled') IN ('true','false')
   AND json_type(s.value,'$.${prefix}responseDays')='integer' AND json_extract(s.value,'$.${prefix}responseDays') BETWEEN 1 AND 3650
   AND json_type(s.value,'$.${prefix}blockedFriendDays')='integer' AND json_extract(s.value,'$.${prefix}blockedFriendDays') BETWEEN 1 AND 3650`;
 // 期限到来分だけを選ぶ。保持停止・壊れた設定の店は候補から外し、ほかの店を詰まらせない。
 const accounts=await db.prepare(`SELECT a.line_account_id,l.tenant_id,MIN(a.customer_redacted_at) oldest
  FROM booking_audit_logs a JOIN line_accounts l ON l.id=a.line_account_id
  LEFT JOIN account_settings s ON s.line_account_id=a.line_account_id AND s.key=?
  WHERE a.customer_redacted_at IS NOT NULL AND a.customer_redacted_at<=?
    AND (s.value IS NULL OR CASE WHEN json_valid(s.value) THEN
      CASE WHEN json_type(s.value,'$.version') IS NOT NULL THEN (${validPolicy('data.')}) ELSE (${validPolicy('')}) END
      ELSE 0 END)
  GROUP BY a.line_account_id,l.tenant_id ORDER BY oldest,a.line_account_id LIMIT 20`)
  .bind(RETENTION_POLICY_KEY,cutoff).all<{line_account_id:string;tenant_id:string|null}>();
 let budget=20,deleted=0,failed=0;
 for(const account of accounts.results??[]){
  if(!budget)break;
  try {
   const raw=await getAccountSetting(db,account.line_account_id,RETENTION_POLICY_KEY);
   if(parseRetentionPolicy(raw).hold)continue;
   // 方針の変更を同じ DELETE で見張り、消去の件数と期限を同じ batch の監査に残す。
   const [result]=await db.batch([
    db.prepare(`DELETE FROM booking_audit_logs WHERE rowid IN (SELECT rowid FROM booking_audit_logs
      WHERE line_account_id=? AND customer_redacted_at IS NOT NULL AND customer_redacted_at<=?
      ORDER BY customer_redacted_at,id LIMIT ?) AND (SELECT value FROM account_settings WHERE line_account_id=? AND key=?) IS ?`)
     .bind(account.line_account_id,cutoff,budget,account.line_account_id,RETENTION_POLICY_KEY,raw),
    // DELETE の changes() を同じ batch で記録するため、共通の監査 INSERT を使わず固定値だけを書く。
    db.prepare(`INSERT INTO audit_events(id,tenant_id,line_account_id,category,actor_principal_id,action,target_kind,result,after_json,retention_class,created_at)
     SELECT ?,?,?,'business','system:retention','privacy.booking_audit.expired','retention','success',json_object('deletedRows',changes(),'cutoff',?),'security',? WHERE changes()>0`)
     .bind(crypto.randomUUID(),account.tenant_id??DEFAULT_TENANT_ID,account.line_account_id,cutoff,toJstString(now)),
   ]);
   const count=Number(result.meta.changes??0);budget-=count;deleted+=count;
  }catch{failed++;}
 }
 return {deleted,failed};
}
