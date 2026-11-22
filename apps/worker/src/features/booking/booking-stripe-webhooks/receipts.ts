import { ensureWorkflowStep, getWorkflowStep, type WorkflowStepRef, type WorkflowStepRow } from '@line-crm/db';
import { bindingScope } from './bindings.js';
import { stripeReceiptDigest } from './normalize.js';
import { BINDING_PROCESS, BookingStripeError, RECEIPT_PROCESS, STRIPE_BOOKING_API_VERSION, type BookingStripeEvent, type StripeReceiptInput } from './types.js';
export function receiptRef(account: string, eventId: string): WorkflowStepRef {
  return {scopeId: bindingScope(account), processKind: RECEIPT_PROCESS, subjectId: eventId, stepKey: 'apply'};
}
export async function bookingStripeReceiptId(account: string, eventId: string): Promise<string> {
  return `stripe_${await stripeReceiptDigest(JSON.stringify([account,eventId]))}`;
}
async function storeRedactedReceipt(db:D1Database,event:BookingStripeEvent,bound:WorkflowStepRow | null,
  fallback?:{id:string;tenant_id:string|null}|null) {
  const now=Date.now(),ref=receiptRef(event.account,event.id);
  const owner=bound?.input_json ? JSON.parse(bound.input_json) as {accountId?:unknown;tenantId?:unknown} : {};
  const fromBinding=typeof owner.accountId==='string';
  const retentionAccountId=fromBinding ? owner.accountId : fallback?.id ?? null;
  const retentionTenantId=fromBinding ? (typeof owner.tenantId==='string' ? owner.tenantId : null) : fallback?.tenant_id ?? null;
  const objectId=event.object.id.length<=255 && /^(in|pi|cs|seti)_[A-Za-z0-9_]+$/.test(event.object.id) ? event.object.id : null;
  const accounting={eventType:event.type,objectId,objectKind:event.object.kind,amount:event.object.amount,
    amountPaid:event.object.amountPaid,amountReceived:event.object.amountReceived,currency:event.object.currency,created:event.created};
  if(!await getWorkflowStep(db,ref)) {
    try {
      await db.prepare(`INSERT OR IGNORE INTO workflow_steps(scope_id,process_kind,subject_id,step_key,status,retry_key,input_json,error_code,created_at,updated_at)
        VALUES (?,?,?,?,'canceled',?,?,'customer_deleted',?,?)`).bind(ref.scopeId,ref.processKind,ref.subjectId,ref.stepKey,event.id,
        JSON.stringify({redacted:true,accounting,retentionAccountId,retentionTenantId}),now,now).run();
    } catch(error) {
      if(!String(error).includes('workflow_customer_redaction_pending') || !await getWorkflowStep(db,ref)) throw error;
    }
  }
  return {receiptId:await bookingStripeReceiptId(event.account,event.id),status:'review_required' as const};
}
export async function storeBookingStripeReceipt(db: D1Database, event: BookingStripeEvent, digest: string) {
  const owners = (await db.prepare(`SELECT a.id,a.tenant_id FROM booking_payment_connections c JOIN line_accounts a ON a.id=c.line_account_id
    WHERE c.provider_account_id=? AND c.test_mode=1 LIMIT 2`).bind(event.account).all<{id: string; tenant_id: string | null}>()).results;
  const bound = await getWorkflowStep(db,{scopeId:bindingScope(event.account),processKind:BINDING_PROCESS,subjectId:event.object.id,stepKey:'binding'});
  if(bound && (bound.status==='canceled' || bound.customer_redaction_requested_at!=null)) return storeRedactedReceipt(db,event,bound,owners.length===1?owners[0]:null);
  const saved = bound ? JSON.parse(bound.input_json!) as {accountId:string;tenantId:string} : null;
  const owner = saved ? {id:saved.accountId,tenant_id:saved.tenantId} : owners.length === 1 ? owners[0] : null;
  const ref = receiptRef(event.account,event.id);
  let row;
  try { row = await ensureWorkflowStep(db,ref,{input: {digest,event,retentionAccountId: owner?.id ?? null,retentionTenantId: owner?.tenant_id ?? null} satisfies StripeReceiptInput}); }
  catch(error) {
    if(String(error).includes('workflow_customer_redaction_pending')) {
      const current=await getWorkflowStep(db,{scopeId:bindingScope(event.account),processKind:BINDING_PROCESS,subjectId:event.object.id,stepKey:'binding'});
      return storeRedactedReceipt(db,event,current ?? bound,owners.length===1?owners[0]:null);
    }
    throw error;
  }
  if(row.status==='canceled' || row.customer_redaction_requested_at!=null) return {receiptId:await bookingStripeReceiptId(event.account,event.id),status:'review_required' as const};
  const input = JSON.parse(row.input_json!) as StripeReceiptInput;
  if (input.digest !== digest) throw new BookingStripeError('stripe_event_conflict');
  if (event.apiVersion !== STRIPE_BOOKING_API_VERSION) {
    await db.prepare(`UPDATE workflow_steps SET error_code='stripe_api_version_unsupported' WHERE scope_id=? AND process_kind=? AND subject_id=? AND step_key='apply' AND status='pending'`)
      .bind(ref.scopeId,ref.processKind,ref.subjectId).run();
  }
  return {receiptId: await bookingStripeReceiptId(event.account,event.id),status: row.status === 'succeeded' ? 'applied' : event.apiVersion !== STRIPE_BOOKING_API_VERSION || row.error_code ? 'review_required' : 'pending'};
}
/** 外部IDの保存後に呼ぶ。対応先未確定ではclaimしないので、再送で回数を使い切らない。 */
export async function listPendingBookingStripeReceipts(db: D1Database, account: string, objectId: string, limit = 50): Promise<string[]> {
  const rows = await db.prepare(`SELECT subject_id FROM workflow_steps WHERE scope_id=? AND process_kind=? AND step_key='apply'
    AND status IN ('pending','running') AND (error_code IS NULL OR error_code='stripe_binding_overdue') AND json_extract(input_json,'$.event.object.id')=? ORDER BY created_at,subject_id LIMIT ?`)
    .bind(bindingScope(account),RECEIPT_PROCESS,objectId,Math.min(50,Math.max(1,limit))).all<{subject_id: string}>();
  return rows.results.map(row => row.subject_id);
}
export async function getBookingStripeReceipt(db: D1Database, account: string, eventId: string) {
  const row = await getWorkflowStep(db,receiptRef(account,eventId));
  return row ? {row, input: JSON.parse(row.input_json!) as StripeReceiptInput} : null;
}
