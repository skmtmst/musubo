import { DEFAULT_TENANT_ID } from '@line-crm/shared';
import type { EcEvent } from './member-snapshot.js';
import { upsertIdentityCandidate } from '../identity/identity-candidates/index.js';

/** 確認済みの連絡先も本人統合の根拠として自動採用せず、候補提示だけを行う。 */
export async function detectEcIdentityCandidates(db: D1Database, eventId: string, event: EcEvent, accountId: string): Promise<number> {
  if (event.customer_id == null) return 0;
  const connector = await db.prepare('SELECT shop_domain,identity_rules_json FROM ec_connectors WHERE line_account_id=?').bind(accountId).first<{shop_domain:string;identity_rules_json:string}>();
  if (!connector) return 0;
  const rules = JSON.parse(connector.identity_rules_json) as string[];
  const source = await db.prepare('SELECT source FROM ec_events WHERE id=? AND line_account_id=?').bind(eventId,accountId).first<{source:string}>();
  const account = await db.prepare('SELECT tenant_id,name FROM line_accounts WHERE id=?').bind(accountId).first<{tenant_id:string|null;name:string}>();
  if (!source || !account) return 0;
  const friends = await db.prepare('SELECT id,metadata FROM friends WHERE line_account_id=?').bind(accountId).all<{id:string;metadata:string}>();
  let count=0;
  const contact = event.customer_identity;
  for (const friend of friends.results) {
    let metadata: Record<string,unknown>;
    try { metadata=JSON.parse(friend.metadata||'{}'); } catch { continue; }
    if(!metadata || typeof metadata!=='object' || Array.isArray(metadata)) continue;
    const matches = [
      rules.includes('verified_email') && contact?.email_verified === true && typeof contact.email==='string' && metadata.email_verified===true && typeof metadata.email==='string' && contact.email.trim().toLowerCase()===metadata.email.trim().toLowerCase() ? 'verified_email' : null,
      rules.includes('verified_phone') && contact?.phone_verified === true && typeof contact.phone==='string' && metadata.phone_verified===true && typeof metadata.phone==='string' && contact.phone.replace(/[^0-9+]/g,'')===metadata.phone.replace(/[^0-9+]/g,'') ? 'verified_phone' : null,
      rules.includes('manual_name_postal') && contact?.name && contact.postal_code && contact.name===metadata.name && contact.postal_code===metadata.postal_code ? 'manual_name_postal' : null,
    ].filter((key):key is string=>Boolean(key));
    if (!matches.length) continue;
    const subject = {label:'照合候補',detail:null,lineAccountId:accountId,lineAccountName:account.name,shopKey:connector.shop_domain,attributes:[]};
    await upsertIdentityCandidate(db,{
      tenantId:account.tenant_id??DEFAULT_TENANT_ID,kind:'ec_member',confidenceScore:matches.includes('verified_email')||matches.includes('verified_phone')?90:50,detectorVersion:'ec-contact-v1',
      left:{...subject,kind:'ec_event',id:eventId},right:{...subject,kind:'friend',id:friend.id},
      sourceKey:source.source,externalCustomerId:String(event.customer_id),detectedAt:new Date().toISOString(),
      evidence:matches.map(key=>({key,label:key==='manual_name_postal'?'氏名と郵便番号の一致':'確認済み連絡先の一致',strength:key==='manual_name_postal'?'weak':'strong',verified:key!=='manual_name_postal',valuePreview:'***'})),impact:[],
    }); count++;
  }
  return count;
}

/** 明示承認された履歴期間か、LINE の本人を解決できたイベントだけを再開する。 */
export async function recoverEcIdentityPending(db: D1Database, now: string): Promise<number> {
  const rows=await db.prepare(`SELECT e.id,e.source,e.line_account_id,e.customer_id,e.line_user_id,e.payload,
    l.friend_id,c.reprocess_scope_json
    FROM ec_events e LEFT JOIN ec_identity_links l ON l.source_key=e.source AND l.line_account_id=e.line_account_id
      AND l.external_customer_id=e.customer_id AND l.unlinked_at IS NULL
      AND EXISTS(SELECT 1 FROM ec_connectors connector WHERE connector.line_account_id=l.line_account_id AND connector.shop_domain=l.shop_key)
    LEFT JOIN identity_candidate_decisions c ON c.candidate_id=l.candidate_id AND c.to_status='linked'
      AND c.candidate_version=(SELECT MAX(d.candidate_version) FROM identity_candidate_decisions d WHERE d.candidate_id=l.candidate_id AND d.to_status='linked')
    WHERE e.status='identity_pending' AND (
      (l.friend_id IS NULL AND EXISTS(SELECT 1 FROM friends f WHERE f.line_platform_user_id=e.line_user_id AND f.line_account_id=e.line_account_id))
      OR (l.friend_id IS NOT NULL AND json_extract(c.reprocess_scope_json,'$.mode') IN ('analytics_snapshot','non_delivery_actions')
        AND EXISTS(SELECT 1 FROM friends f WHERE f.id=l.friend_id AND f.line_account_id=e.line_account_id)
        AND (json_extract(c.reprocess_scope_json,'$.from') IS NULL OR datetime(json_extract(e.payload,'$.occurred_at'))>=datetime(json_extract(c.reprocess_scope_json,'$.from')))
        AND (json_extract(c.reprocess_scope_json,'$.to') IS NULL OR datetime(json_extract(e.payload,'$.occurred_at'))<=datetime(json_extract(c.reprocess_scope_json,'$.to'))))
    ) ORDER BY e.received_at LIMIT 100`).all<{id:string;source:string;line_account_id:string;customer_id:string|null;line_user_id:string|null;payload:string;friend_id:string|null;reprocess_scope_json:string|null}>();
  let count=0;
  for(const row of rows.results) {
    const scope = JSON.parse(row.reprocess_scope_json??'{"mode":"future_only"}') as {mode:string;from?:string;to?:string};
    const event=JSON.parse(row.payload) as EcEvent;
    const friend= row.friend_id ? await db.prepare('SELECT id,line_platform_user_id AS line_user_id FROM friends WHERE id=? AND line_account_id=?').bind(row.friend_id,row.line_account_id).first<{id:string;line_user_id:string}>()
      : await db.prepare('SELECT id,line_platform_user_id AS line_user_id FROM friends WHERE line_platform_user_id=? AND line_account_id=?').bind(row.line_user_id,row.line_account_id).first<{id:string;line_user_id:string}>();
    if(!friend || (row.friend_id && scope.mode==='future_only') || (scope.from && Date.parse(event.occurred_at)<Date.parse(scope.from)) || (scope.to && Date.parse(event.occurred_at)>Date.parse(scope.to))) continue;
    // 本人未確定の処理済み記録で今回の実行まで抑止しないよう、処理の名前空間を分ける。
    const payload={...event,line_user_id:friend.line_user_id};
    const mode=scope.mode==='analytics_snapshot'?'analytics_snapshot':'non_delivery_actions';
    await db.batch([
      db.prepare("UPDATE ec_events SET status='received',payload=?,friend_id=?,identity_recovery_mode=?,error_message=NULL,updated_at=? WHERE id=? AND status='identity_pending'").bind(JSON.stringify(payload),friend.id,mode,now,row.id),
      db.prepare("UPDATE ec_action_executions SET status='pending',next_retry_at=NULL,version=version+1,updated_at=? WHERE event_id=? AND line_account_id=? AND changes()=1").bind(now,row.id,row.line_account_id),
    ]);count++;
  }
  return count;
}
