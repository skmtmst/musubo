import { workflowJson } from '@line-crm/db';
import { BINDING_PROCESS, BookingStripeError, RECEIPT_PROCESS, type BookingStripeBinding, type StripeBookingPurpose } from './types.js';
export function bindingScope(account: string): string { return `stripe-test:${account}`; }
const kinds:Record<StripeBookingPurpose,readonly string[]> = {monthly_invoice: ['invoice'], payment_method: ['setup_intent','checkout.session'], pass_purchase: ['checkout.session'],
  booking_payment: ['payment_intent'], cancellation_charge: ['payment_intent'], restaurant_payment: ['payment_intent','checkout.session']};
/** 本文が示すIDを信用せず、保存済みの店・本人・元の接続で業務の関連を固定する。 */
export function prepareBookingStripeBinding(db: D1Database, binding: BookingStripeBinding): D1PreparedStatement[] {
  if (!Object.hasOwn(kinds,binding.purpose) || !kinds[binding.purpose].includes(binding.objectKind)
    || !/^acct_[a-z0-9_]+$/i.test(binding.connectAccount) || !/^[a-z][a-z0-9_]{1,254}$/i.test(binding.objectId)
    || !binding.targetId || !/^cus_[a-z0-9_]+$/i.test(binding.customerId) || !binding.tenantId || !binding.accountId || !binding.friendId
    || (binding.purpose !== 'payment_method' && (!Number.isSafeInteger(binding.amount) || Number(binding.amount) < 0 || !/^[a-z]{3}$/.test(binding.currency ?? '')))) {
    throw new BookingStripeError('invalid_binding',400);
  }
  const canonical: BookingStripeBinding = {tenantId:binding.tenantId,accountId:binding.accountId,friendId:binding.friendId,
    purpose:binding.purpose,targetId:binding.targetId,connectAccount:binding.connectAccount,objectId:binding.objectId,
    objectKind:binding.objectKind,amount:binding.amount,currency:binding.currency,customerId:binding.customerId};
  const scope = bindingScope(binding.connectAccount), input = workflowJson(canonical), now = Date.now();
  return [db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM line_accounts a JOIN tenants t ON t.id=a.tenant_id
    JOIN friends f ON f.line_account_id=a.id JOIN booking_payment_connections c ON c.line_account_id=a.id
    WHERE a.id=? AND a.tenant_id=? AND a.is_active=1 AND t.status='active' AND f.id=?
    AND c.provider_account_id=? AND c.test_mode=1 AND c.disconnected_at IS NULL) THEN 'true' ELSE 'stripe_binding_scope_mismatch' END)`)
    .bind(binding.accountId,binding.tenantId,binding.friendId,binding.connectAccount),
    db.prepare(`INSERT INTO workflow_steps(scope_id,process_kind,subject_id,step_key,status,retry_key,input_json,created_at,updated_at)
    VALUES(?,?,?,'binding','succeeded',?,?,?,?) ON CONFLICT(scope_id,process_kind,subject_id,step_key) DO UPDATE
    SET input_json=CASE WHEN workflow_steps.input_json=excluded.input_json THEN workflow_steps.input_json ELSE json('stripe_binding_conflict') END`)
    .bind(scope,BINDING_PROCESS,binding.objectId,binding.objectId,input,now,now),
    db.prepare(`UPDATE workflow_steps SET input_json=json_set(input_json,'$.retentionAccountId',?,'$.retentionTenantId',?)
      WHERE scope_id=? AND process_kind=? AND json_extract(input_json,'$.event.object.id')=?
      AND json_extract(input_json,'$.retentionAccountId') IS NULL`)
    .bind(binding.accountId,binding.tenantId,scope,RECEIPT_PROCESS,binding.objectId)];
}
export async function externalBookingStripeObject(db: D1Database, id: string): Promise<boolean> {
  return Boolean(await db.prepare(`SELECT 1 FROM workflow_steps WHERE scope_id>='stripe-test:' AND scope_id<'stripe-test;' AND process_kind=? AND subject_id=? AND step_key='binding' LIMIT 1`)
    .bind(BINDING_PROCESS,id).first());
}
