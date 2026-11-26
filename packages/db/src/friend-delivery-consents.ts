/** Alias f must refer to friends. Multiple purposes still exclude one friend once. */
export const DELIVERY_CONSENT_ALLOWED_SQL = `NOT EXISTS (
  SELECT 1 FROM friend_delivery_consents consent
  JOIN friends consent_friend ON consent_friend.id=consent.friend_id
    AND consent_friend.line_account_id=consent.line_account_id
  WHERE consent.friend_id=f.id AND consent.state<>'granted'
)`;

export type DeliveryConsentState = 'granted' | 'unknown' | 'revoked';
export interface FriendDeliveryConsent {
  purpose: string; state: DeliveryConsentState; reason: string; source: string;
  updatedBy: string | null; updatedAt: string; version: number;
}
export async function listFriendDeliveryConsents(db: D1Database, friendId: string): Promise<FriendDeliveryConsent[]> {
  return (await db.prepare(`SELECT purpose,state,reason,source,updated_by AS updatedBy,updated_at AS updatedAt,version
    FROM friend_delivery_consents WHERE friend_id=? ORDER BY purpose`).bind(friendId).all<FriendDeliveryConsent>()).results;
}
/** No ledger entry is legacy behavior, never evidence of explicit consent. */
export async function isFriendDeliverySuppressed(db: D1Database, friendId: string): Promise<boolean> {
  return (await db.prepare(`SELECT 1 AS suppressed FROM friend_delivery_consents c JOIN friends f ON f.id=c.friend_id AND f.line_account_id=c.line_account_id
    WHERE c.friend_id=? AND c.state<>'granted' LIMIT 1`).bind(friendId).first<{suppressed:number}>())?.suppressed===1;
}
export async function consentRollbackConflicts(db: D1Database, runId: string): Promise<string[]> {
  return (await db.prepare(`SELECT DISTINCT i.id FROM uid_migration_items i
    WHERE i.run_id=? AND i.result='applied' AND json_extract(i.after_json,'$.deliveryConsentsRecorded')=1
    AND (EXISTS(SELECT 1 FROM uid_migration_delivery_consents s LEFT JOIN friend_delivery_consents c ON c.friend_id=i.new_friend_id AND c.purpose=s.purpose
      WHERE s.item_id=i.id AND (c.friend_id IS NULL OR c.version<>json_extract(s.after_json,'$.version') OR c.state<>json_extract(s.after_json,'$.state') OR c.reason<>json_extract(s.after_json,'$.reason') OR c.source<>json_extract(s.after_json,'$.source') OR c.updated_by IS NOT json_extract(s.after_json,'$.updatedBy') OR c.updated_at<>json_extract(s.after_json,'$.updatedAt')))
    OR EXISTS(SELECT 1 FROM friend_delivery_consents c WHERE c.friend_id=i.new_friend_id AND NOT EXISTS(SELECT 1 FROM uid_migration_delivery_consents s WHERE s.item_id=i.id AND s.purpose=c.purpose)))`)
    .bind(runId).all<{id: string}>()).results.map(r => r.id);
}
export async function suppressionReconciliation(db: D1Database, runId: string) {
  const rows=(await db.prepare(`SELECT i.id,i.result,i.new_friend_id,i.after_json FROM uid_migration_items i WHERE i.run_id=? AND i.result IN ('applied','rolled_back')`)
    .bind(runId).all<{id:string;result:string;new_friend_id:string|null;after_json:string|null}>()).results;
  if (!rows.length || rows.some(r => !r.after_json || JSON.parse(r.after_json).deliveryConsentsRecorded!==1)) {
    return {status:'unavailable' as const,transferredCount:null,mismatchCount:null,reason:'delivery_consent_snapshot_missing' as const};
  }
  if (rows.every(r=>r.result==='rolled_back')) return {status:'rolled_back' as const,transferredCount:0,mismatchCount:0,reason:null};
  const counts=await db.prepare(`SELECT COUNT(DISTINCT CASE WHEN s.source_state='revoked' THEN i.new_friend_id END) AS transferredCount,
    COUNT(DISTINCT CASE WHEN c.friend_id IS NULL OR c.state<>json_extract(s.after_json,'$.state') THEN i.new_friend_id END) AS mismatchCount
    FROM uid_migration_items i JOIN uid_migration_delivery_consents s ON s.item_id=i.id
    LEFT JOIN friend_delivery_consents c ON c.friend_id=i.new_friend_id AND c.purpose=s.purpose
    WHERE i.run_id=? AND i.result='applied'`).bind(runId).first<{transferredCount:number;mismatchCount:number}>();
  if (!counts) throw new Error('delivery_consent_reconciliation_missing');
  return {status:counts.mismatchCount?'mismatch' as const:'matched' as const,...counts,reason:null};
}
export async function suppressedFriendIds(db:D1Database, friendIds:string[]):Promise<Set<string>> {
  const rows=await db.prepare(`SELECT DISTINCT friend_id FROM friend_delivery_consents WHERE state<>'granted' AND friend_id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(friendIds)).all<{friend_id:string}>();
  return new Set(rows.results.map(r=>r.friend_id));
}
export async function hasSuppressedDeliveryRecipients(db:D1Database,accountId:string|null,uids?:string[]):Promise<boolean> {
  return (await db.prepare(`SELECT 1 AS suppressed FROM friend_delivery_consents c JOIN friends f ON f.id=c.friend_id AND f.line_account_id=c.line_account_id
    WHERE c.state<>'granted' AND (? IS NULL OR c.line_account_id=?) AND (? IS NULL OR f.line_platform_user_id IN (SELECT value FROM json_each(?))) LIMIT 1`)
    .bind(accountId,accountId,uids?JSON.stringify(uids):null,uids?JSON.stringify(uids):null).first<{suppressed:number}>())?.suppressed===1;
}
/** Record an intentional non-send without marking it as dispatched or accepted. */
export async function recordSuppressedBroadcastRecipients(db:D1Database,broadcastId:string,ids:string[]):Promise<void> {
  if(!ids.length)return;
  await db.prepare(`INSERT INTO broadcast_send_claims(broadcast_id,friend_id,line_account_id,state,error_code,settled_at)
    SELECT ?,f.id,f.line_account_id,'failed','delivery_consent_suppressed',datetime('now') FROM friends f WHERE f.id IN (SELECT value FROM json_each(?))
    ON CONFLICT(broadcast_id,friend_id) DO UPDATE SET state='failed',error_code='delivery_consent_suppressed',settled_at=excluded.settled_at,updated_at=datetime('now')
    WHERE broadcast_send_claims.state='claimed' AND broadcast_send_claims.dispatched_at IS NULL`)
    .bind(broadcastId,JSON.stringify(ids)).run();
}
