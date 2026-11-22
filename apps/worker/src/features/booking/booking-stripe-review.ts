import { BOOKING_STRIPE_EVENT_KINDS } from './booking-stripe-webhooks/types.js';

type Json = Record<string, unknown>;
const object = (v:unknown):Json => v && typeof v==='object' && !Array.isArray(v) ? v as Json : {};
function parse(v:string|null):Json { try{return object(JSON.parse(v ?? '{}'));}catch{return {};} }
const eventTypes = new Set(Object.values(BOOKING_STRIPE_EVENT_KINDS).flat());
const kinds = new Set(Object.keys(BOOKING_STRIPE_EVENT_KINDS));
const reasons = new Set(['customer_deleted','customer_deleted_unknown','stripe_binding_overdue','stripe_binding_mismatch','stripe_api_version_unsupported','stripe_event_type_unsupported','stripe_binding_scope_mismatch']);
const safeId = (v:unknown):string|null => typeof v==='string' && /^(?:pi|in|cs|seti)_[a-z0-9_]{1,250}$/i.test(v) ? v : null;
const safeNumber = (v:unknown):number|null => typeof v==='number' && Number.isSafeInteger(v) && v>=0 ? v : null;
const safeCurrency = (v:unknown):string|null => typeof v==='string' && /^[a-z]{3}$/.test(v) ? v : null;

/** 返却する項目は会計用に限定し、入力の他の項目やエラー文を外へ出さない。 */
export async function listStripeReviews(db:D1Database, accountId:string, cursor: {createdAt:number; rowid:number}|null = null) {
  const rows=await db.prepare(`SELECT rowid AS cursor_rowid,input_json,result_json,error_code,status,created_at FROM workflow_steps
    WHERE scope_id>='stripe-test:' AND scope_id<'stripe-test;' AND process_kind='booking_stripe_webhook' AND step_key='apply'
      AND json_valid(input_json) AND json_extract(input_json,'$.retentionAccountId')=?
      AND (json_extract(input_json,'$.retentionTenantId') IS NULL OR json_extract(input_json,'$.retentionTenantId')=(SELECT tenant_id FROM line_accounts WHERE id=?))
      AND status NOT IN ('succeeded','failed') AND (error_code IS NOT NULL OR status IN ('exhausted','unknown'))
      AND NOT (COALESCE(error_code,'')='customer_deleted' AND COALESCE(json_extract(CASE WHEN json_valid(result_json) THEN result_json ELSE '{}' END,'$.previousStatus'),'')='succeeded')
      AND (? IS NULL OR created_at<? OR (created_at=? AND rowid<?))
    ORDER BY created_at DESC,rowid DESC LIMIT 101`).bind(accountId,accountId,cursor?.createdAt ?? null,cursor?.createdAt ?? null,cursor?.createdAt ?? null,cursor?.rowid ?? null).all<{cursor_rowid:number;input_json:string;result_json:string|null;error_code:string|null;status:string;created_at:number}>();
  const hasMore=rows.results.length>100;
  const items=rows.results.slice(0,100).map(row=>{
    const input=parse(row.input_json), result=parse(row.result_json), event=object(input.event), source=object(event.object);
    const accounting=object(input.accounting ?? result.accounting);
    const type=accounting.eventType ?? event.type, kind=accounting.objectKind ?? source.kind;
    const created=safeNumber(accounting.created ?? event.created);
    return {eventType:typeof type==='string' && eventTypes.has(type)?type:null,
      objectKind:typeof kind==='string' && kinds.has(kind)?kind:null,
      paymentId:safeId(accounting.objectId ?? source.id),amount:safeNumber(accounting.amount ?? source.amount),
      currency:safeCurrency(accounting.currency ?? source.currency),occurredAt:created,
      reason:row.error_code && reasons.has(row.error_code)?row.error_code:'review_required'};
  });
  const last=rows.results[Math.min(100,rows.results.length)-1];
  return {items,hasMore,nextCursor:hasMore && last?`${last.created_at}:${last.cursor_rowid}`:null};
}
