import { prepareWorkflowStep, getWorkflowStep, type WorkflowStepRef } from '@line-crm/db';
import { bindingScope } from './bindings.js';
import { recordPurgedTenantStripeEvent } from '../../../services/tenant-purge-tombstones.js';
import { stripeReceiptDigest } from './normalize.js';
import { BINDING_PROCESS, BookingStripeError, RECEIPT_PROCESS, STRIPE_BOOKING_API_VERSION, type BookingStripeEvent, type StripeReceiptInput } from './types.js';
export function receiptRef(account: string, eventId: string): WorkflowStepRef {
  return {scopeId: bindingScope(account), processKind: RECEIPT_PROCESS, subjectId: eventId, stepKey: 'apply'};
}
export async function bookingStripeReceiptId(account: string, eventId: string): Promise<string> {
  return `stripe_${await stripeReceiptDigest(JSON.stringify([account,eventId]))}`;
}
export async function storeBookingStripeReceipt(db: D1Database, event: BookingStripeEvent, digest: string) {
  const owners = (await db.prepare(`SELECT a.id,a.tenant_id FROM booking_payment_connections c JOIN line_accounts a ON a.id=c.line_account_id
    WHERE c.provider_account_id=? AND c.test_mode=1 LIMIT 2`).bind(event.account).all<{id: string; tenant_id: string | null}>()).results;
  const bound = await getWorkflowStep(db,{scopeId:bindingScope(event.account),processKind:BINDING_PROCESS,subjectId:event.object.id,stepKey:'binding'});
  const saved = bound ? JSON.parse(bound.input_json!) as {accountId:string;tenantId:string} : null;
  const owner = saved ? {id:saved.accountId,tenant_id:saved.tenantId} : owners.length === 1 ? owners[0] : null;
  const ref = receiptRef(event.account,event.id);
  const reviewPurged = async () => {
    if (!owner?.tenant_id) return false;
    const tenant=await db.prepare('SELECT purge_started_at,data_purged_at FROM tenants WHERE id=?').bind(owner.tenant_id)
      .first<{purge_started_at:string|null;data_purged_at:string|null}>();
    if (!tenant || (!tenant.purge_started_at && !tenant.data_purged_at)) return false;
    await recordPurgedTenantStripeEvent(db,{tenantId:owner.tenant_id,eventId:event.id,eventType:event.type,
      amount:event.object.amountPaid ?? event.object.amount,currency:event.object.currency,now:new Date().toISOString()});
    return true;
  };
  const minimalReview=async()=>({receiptId:await bookingStripeReceiptId(event.account,event.id),status:'review_required' as const});
  const inputValue={digest,event,retentionAccountId:owner?.id ?? null,retentionTenantId:owner?.tenant_id ?? null} satisfies StripeReceiptInput;
  if (owner?.tenant_id) {
    const fence=db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM tenants t JOIN line_accounts a ON a.tenant_id=t.id
      WHERE t.id=? AND a.id=? AND a.data_purged_at IS NULL AND t.purge_started_at IS NULL AND t.data_purged_at IS NULL)
      THEN 'true' ELSE 'BOOKING_STRIPE_PURGE_FENCE' END)`).bind(owner.tenant_id,owner.id);
    try { await db.batch([fence,prepareWorkflowStep(db,ref,{input:inputValue})]); }
    catch (error) { if (await reviewPurged()) return minimalReview(); throw error; }
  } else await prepareWorkflowStep(db,ref,{input:inputValue}).run();
  const row = await getWorkflowStep(db,ref);
  if (!row) { if (await reviewPurged()) return minimalReview(); throw new BookingStripeError('stripe_receipt_not_found',503); }
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
