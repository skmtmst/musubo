import { DEFAULT_TENANT_ID, getAccountSetting, toJstString } from '@line-crm/db';
import { parseRetentionPolicy, RETENTION_POLICY_KEY } from './retention-policy.js';

// 事業年度・申告期限が不明なため、取引を年度初日とみなし、年度末＋申告期限3か月の翌日から10年。
const followTimeSql=(column:string)=>`julianday(CASE WHEN length(${column})=10 THEN ${column}||'T00:00:00+09:00' WHEN substr(${column},-1) IN ('Z','z') OR substr(${column},-6,1) IN ('+','-') OR substr(${column},-5,1) IN ('+','-') THEN ${column} ELSE ${column}||'+09:00' END)`;
const due=(column:string)=>`(${column} IS NULL OR COALESCE(julianday(${followTimeSql(column)},'+9 hours','+1 year','+3 months','+1 day','+10 years','-9 hours')<=julianday(ctx.now),0))`;
const old=(column:string)=>`(${column} IS NOT NULL AND ${due(column)})`;
const accountGuard=`(SELECT value FROM account_settings WHERE line_account_id=ctx.account AND key='security.personalDataRetention.v1') IS ctx.policy`;
const workflowSubject=`w.scope_id='line:'||ctx.account AND (
 (w.process_kind='booking_late_payment' AND w.subject_id=ctx.id) OR
 (w.process_kind='booking_payment_start' AND w.subject_id IN (SELECT p.booking_id FROM booking_payments p WHERE p.id=ctx.id UNION SELECT p.booking_id_history FROM booking_payments p WHERE p.id=ctx.id UNION SELECT c.booking_id FROM booking_charges c WHERE c.id=ctx.id)))`;
const workflowGuard=`NOT EXISTS (SELECT 1 FROM workflow_steps w WHERE ${workflowSubject} AND (w.status IN ('pending','running','failed','unknown') OR NOT ${old("datetime(w.updated_at/1000,'unixepoch')||'Z'")}))`;
const paymentGate=`EXISTS (SELECT 1 FROM booking_payments p WHERE p.id=ctx.id AND p.line_account_id=ctx.account
 AND p.status IN ('paid','refunded','failed','expired') AND ${old('p.created_at')} AND ${due('p.updated_at')} AND ${due('p.paid_at')} AND ${due('p.refunded_at')}
 AND (p.booking_id IS NULL OR EXISTS(SELECT 1 FROM bookings b WHERE b.id=p.booking_id AND b.line_account_id=p.line_account_id AND b.status IN ('completed','cancelled','expired','no_show','rejected') AND ${old('b.ends_at')}))
 AND NOT EXISTS(SELECT 1 FROM booking_payment_refunds r WHERE r.payment_id=p.id AND (r.line_account_id<>ctx.account OR NOT ${old('r.created_at')}))
 AND NOT EXISTS(SELECT 1 FROM booking_payment_booking_links l WHERE l.payment_id=p.id AND (l.line_account_id<>ctx.account OR NOT ${old('l.created_at')}))
 AND NOT EXISTS(SELECT 1 FROM booking_payment_events e WHERE e.payment_id=p.id AND (e.line_account_id<>ctx.account OR NOT ${old('e.received_at')} OR (e.lease_token IS NOT NULL AND (e.lease_until IS NULL OR julianday(e.lease_until)>julianday(ctx.now)))))
 AND NOT EXISTS(SELECT 1 FROM booking_payment_event_replays r JOIN booking_payment_events e ON e.id=r.event_id WHERE e.payment_id=p.id AND NOT ${old('r.occurred_at')}))`;
const chargeGate=`EXISTS (SELECT 1 FROM booking_charges c WHERE c.id=ctx.id AND c.line_account_id=ctx.account
 AND c.status IN ('succeeded','failed','waived','refunded') AND ${old('c.created_at')} AND ${due('c.updated_at')}
 AND (NOT EXISTS(SELECT 1 FROM bookings b WHERE b.id=c.booking_id) OR EXISTS(SELECT 1 FROM bookings b WHERE b.id=c.booking_id AND b.line_account_id=c.line_account_id AND b.status IN ('completed','cancelled','expired','no_show','rejected') AND ${old('b.ends_at')}))
 AND NOT EXISTS(SELECT 1 FROM booking_cancellation_events e WHERE e.charge_id=c.id AND NOT ${old('e.created_at')}))`;
const detachedEventGate=`EXISTS (SELECT 1 FROM booking_payment_events e WHERE e.id=ctx.id AND e.line_account_id=ctx.account AND e.payment_id IS NULL
 AND (e.lease_token IS NULL OR (e.lease_until IS NOT NULL AND julianday(e.lease_until)<=julianday(ctx.now))) AND ${old('e.received_at')}
 AND NOT EXISTS(SELECT 1 FROM booking_payment_event_replays r WHERE r.event_id=e.id AND NOT ${old('r.occurred_at')}))`;
const context=`WITH ctx(id,account,policy,now) AS (VALUES(?,?,?,?))`;
const guard=`${accountGuard} AND ${workflowGuard}`;
const validPolicy=(prefix:string)=>`json_type(ctx.policy,'$.${prefix}hold')='false'
 AND json_type(ctx.policy,'$.${prefix}enabled') IN ('true','false')
 AND json_type(ctx.policy,'$.${prefix}responseDays')='integer' AND json_extract(ctx.policy,'$.${prefix}responseDays') BETWEEN 1 AND 3650
 AND json_type(ctx.policy,'$.${prefix}blockedFriendDays')='integer' AND json_extract(ctx.policy,'$.${prefix}blockedFriendDays') BETWEEN 1 AND 3650`;
const eligiblePolicy=`(ctx.policy IS NULL OR CASE WHEN json_valid(ctx.policy) THEN CASE WHEN json_type(ctx.policy,'$.version') IS NOT NULL THEN (${validPolicy('data.')}) ELSE (${validPolicy('')}) END ELSE 0 END)`;

/** 取引一式を子から同一 batch で削除し、件数だけを監査に残す。 */
export async function processBookingFinancialRetention(db:D1Database,now=new Date()):Promise<{deleted:number;failed:number}> {
 const nowIso=now.toISOString();
 // UTC/JST と月末のずれを吸収するため、候補の前段は余裕を持たせ、正確な期限は due で判定する。
 const prefilter=new Date(now.getTime()+9*3600000);
 prefilter.setUTCFullYear(prefilter.getUTCFullYear()-11);
 prefilter.setUTCMonth(prefilter.getUTCMonth()-3);
 prefilter.setUTCDate(prefilter.getUTCDate()+4);
 const before=`${prefilter.getUTCFullYear()}-${String(prefilter.getUTCMonth()+1).padStart(2,'0')}-${String(prefilter.getUTCDate()).padStart(2,'0')}`;
 let deleted=0,failed=0;
 const candidates=await db.prepare(`WITH ctx AS (SELECT p.id,p.line_account_id AS account,s.value AS policy,? AS now,p.created_at,l.tenant_id
  FROM booking_payments p JOIN line_accounts l ON l.id=p.line_account_id LEFT JOIN account_settings s ON s.line_account_id=p.line_account_id AND s.key='security.personalDataRetention.v1' WHERE p.status IN ('paid','refunded','failed','expired') AND p.created_at<?)
  SELECT ctx.id,ctx.account AS line_account_id,ctx.tenant_id FROM ctx WHERE ${eligiblePolicy} AND ${paymentGate} AND ${workflowGuard}
  ORDER BY ctx.created_at,ctx.id LIMIT 50`).bind(nowIso,before).all<{id:string;line_account_id:string;tenant_id:string|null}>().catch(()=>{failed++;return {results:[]};});
 for(const row of candidates.results??[]){
  try {
   const raw=await getAccountSetting(db,row.line_account_id,RETENTION_POLICY_KEY);
   if(parseRetentionPolicy(raw).hold)continue;
   const binds=[row.id,row.line_account_id,raw,nowIso] as const;
   const sql=(table:string,where:string)=>db.prepare(`${context} DELETE FROM ${table} WHERE ${where} AND EXISTS(SELECT 1 FROM ctx WHERE ${guard} AND ${paymentGate})`).bind(...binds);
   const [,,,,,result]=await db.batch([
    sql('booking_payment_event_replays','event_id IN (SELECT e.id FROM booking_payment_events e,ctx WHERE e.payment_id=ctx.id)'),
    sql('booking_payment_events','payment_id IN (SELECT id FROM ctx)'),
    sql('booking_payment_refunds','payment_id IN (SELECT id FROM ctx)'),
    sql('booking_payment_booking_links','payment_id IN (SELECT id FROM ctx)'),
    sql('workflow_steps',`rowid IN (SELECT w.rowid FROM workflow_steps w,ctx WHERE ${workflowSubject} AND (w.process_kind<>'booking_payment_start' OR NOT EXISTS(SELECT 1 FROM booking_payments other WHERE other.id<>ctx.id AND other.line_account_id=ctx.account AND (other.booking_id=w.subject_id OR (other.booking_id IS NULL AND other.booking_id_history=w.subject_id)))))`),
    sql('booking_payments','id IN (SELECT id FROM ctx)'),
    db.prepare(`INSERT INTO audit_events(id,tenant_id,line_account_id,category,actor_principal_id,action,target_kind,result,after_json,retention_class,created_at)
     SELECT ?,?,?,'business','system:retention','privacy.booking_financial.expired','retention','success',json_object('deletedBundles',changes(),'asOf',?),'security',? WHERE changes()>0`)
     .bind(crypto.randomUUID(),row.tenant_id??DEFAULT_TENANT_ID,row.line_account_id,nowIso,toJstString(now)),
   ]);
   deleted+=Number(result.meta.changes??0);
  }catch{failed++;}
 }
 const charges=await db.prepare(`WITH ctx AS (SELECT c.id,c.line_account_id AS account,s.value AS policy,? AS now,c.created_at,l.tenant_id
  FROM booking_charges c JOIN line_accounts l ON l.id=c.line_account_id LEFT JOIN account_settings s ON s.line_account_id=c.line_account_id AND s.key='security.personalDataRetention.v1' WHERE c.status IN ('succeeded','failed','waived','refunded') AND c.created_at<?)
  SELECT ctx.id,ctx.account AS line_account_id,ctx.tenant_id FROM ctx WHERE ${eligiblePolicy} AND ${chargeGate} AND ${workflowGuard}
  ORDER BY ctx.created_at,ctx.id LIMIT 50`).bind(nowIso,before).all<{id:string;line_account_id:string;tenant_id:string|null}>().catch(()=>{failed++;return {results:[]};});
 for(const row of charges.results??[]){
  try {
   const raw=await getAccountSetting(db,row.line_account_id,RETENTION_POLICY_KEY);
   if(parseRetentionPolicy(raw).hold)continue;
   const binds=[row.id,row.line_account_id,raw,nowIso] as const;
   const sql=(table:string,where:string)=>db.prepare(`${context} DELETE FROM ${table} WHERE ${where} AND EXISTS(SELECT 1 FROM ctx WHERE ${guard} AND ${chargeGate})`).bind(...binds);
   const [,,result]=await db.batch([
    sql('booking_cancellation_events','charge_id IN (SELECT id FROM ctx)'),
    sql('workflow_steps',`rowid IN (SELECT w.rowid FROM workflow_steps w,ctx WHERE ${workflowSubject} AND (w.process_kind<>'booking_payment_start' OR NOT EXISTS(SELECT 1 FROM booking_payments other WHERE other.line_account_id=ctx.account AND (other.booking_id=w.subject_id OR (other.booking_id IS NULL AND other.booking_id_history=w.subject_id)))))`),
    sql('booking_charges','id IN (SELECT id FROM ctx)'),
    db.prepare(`INSERT INTO audit_events(id,tenant_id,line_account_id,category,actor_principal_id,action,target_kind,result,after_json,retention_class,created_at)
     SELECT ?,?,?,'business','system:retention','privacy.booking_financial.expired','retention','success',json_object('deletedBundles',changes(),'asOf',?),'security',? WHERE changes()>0`)
     .bind(crypto.randomUUID(),row.tenant_id??DEFAULT_TENANT_ID,row.line_account_id,nowIso,toJstString(now)),
   ]);
   deleted+=Number(result.meta.changes??0);
  }catch{failed++;}
 }
 const events=await db.prepare(`WITH ctx AS (SELECT e.id,e.line_account_id AS account,s.value AS policy,? AS now,e.received_at,l.tenant_id
  FROM booking_payment_events e JOIN line_accounts l ON l.id=e.line_account_id LEFT JOIN account_settings s ON s.line_account_id=e.line_account_id AND s.key='security.personalDataRetention.v1' WHERE e.payment_id IS NULL AND e.received_at<?)
  SELECT ctx.id,ctx.account AS line_account_id,ctx.tenant_id FROM ctx WHERE ${eligiblePolicy} AND ${detachedEventGate} AND ${workflowGuard}
  ORDER BY ctx.received_at,ctx.id LIMIT 50`).bind(nowIso,before).all<{id:string;line_account_id:string;tenant_id:string|null}>().catch(()=>{failed++;return {results:[]};});
 for(const row of events.results??[]){
  try {
   const raw=await getAccountSetting(db,row.line_account_id,RETENTION_POLICY_KEY);
   if(parseRetentionPolicy(raw).hold)continue;
   const binds=[row.id,row.line_account_id,raw,nowIso] as const;
   const sql=(table:string,where:string)=>db.prepare(`${context} DELETE FROM ${table} WHERE ${where} AND EXISTS(SELECT 1 FROM ctx WHERE ${guard} AND ${detachedEventGate})`).bind(...binds);
   const [,result]=await db.batch([
    sql('booking_payment_event_replays','event_id IN (SELECT id FROM ctx)'),
    sql('booking_payment_events','id IN (SELECT id FROM ctx)'),
    db.prepare(`INSERT INTO audit_events(id,tenant_id,line_account_id,category,actor_principal_id,action,target_kind,result,after_json,retention_class,created_at)
     SELECT ?,?,?,'business','system:retention','privacy.booking_financial.expired','retention','success',json_object('deletedBundles',changes(),'asOf',?),'security',? WHERE changes()>0`)
     .bind(crypto.randomUUID(),row.tenant_id??DEFAULT_TENANT_ID,row.line_account_id,nowIso,toJstString(now)),
   ]);
   deleted+=Number(result.meta.changes??0);
  }catch{failed++;}
 }
 // Stripe の古い記録はアカウントが判別できないものがある。どの店にも保持停止・不正設定が無い場合だけ消す。
 try {
  const globalPolicy=eligiblePolicy.replaceAll('ctx.policy','s.value');
  const [result]=await db.batch([
   db.prepare(`WITH ctx(now) AS (VALUES(?)) DELETE FROM stripe_events WHERE id IN (
    SELECT e.id FROM stripe_events e,ctx WHERE e.processed_at<? AND ${old('e.processed_at')} ORDER BY e.processed_at,e.id LIMIT 50)
    AND NOT EXISTS(SELECT 1 FROM account_settings s WHERE s.key='security.personalDataRetention.v1' AND NOT ${globalPolicy})`).bind(nowIso,before),
   db.prepare(`INSERT INTO audit_events(id,tenant_id,category,actor_principal_id,action,target_kind,result,after_json,retention_class,created_at)
    SELECT ?,?,'business','system:retention','privacy.booking_financial.expired','retention','success',json_object('deletedStripeEvents',changes(),'asOf',?),'security',? WHERE changes()>0`)
    .bind(crypto.randomUUID(),DEFAULT_TENANT_ID,nowIso,toJstString(now)),
  ]);
  deleted+=Number(result.meta.changes??0);
 }catch{failed++;}
 return {deleted,failed};
}
