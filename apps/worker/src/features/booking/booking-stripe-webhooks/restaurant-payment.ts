import { restaurantTestEnabled } from '../../../lib/environment-features.js';
import { logger } from '@line-crm/shared/server';
import type { Env } from '../../../worker-env.js';
import { applyBookingStripeReceipt } from './application.js';
import { getBookingStripeReceipt, listPendingBookingStripeReceipts } from './receipts.js';
import { BookingStripeError } from './types.js';
import { finishRestaurantPaidReservation } from '../restaurant-payment-finish.js';
import { accountFeatureIsEnabled } from '../../../services/feature-enforcement.js';

/** 署名済みCheckoutと、保存済みの店・本人・金額を照合して入金を記録する。 */
export async function applyRestaurantPaymentReceipt(env:Env['Bindings'],account:string,eventId:string,reconcileOnly?:boolean) {
 if(!['staging','development','test'].includes(env.DEPLOY_ENV?.trim().toLowerCase() ?? ''))return 'pending' as const;
 const db=env.DB,receipt=await getBookingStripeReceipt(db,account,eventId);
 if(!receipt)return 'pending' as const;
 const bound=await db.prepare(`SELECT json_extract(input_json,'$.purpose') purpose,json_extract(input_json,'$.targetId') target_id FROM workflow_steps
   WHERE scope_id=? AND process_kind='booking_stripe_object' AND subject_id=? AND step_key='binding'`).bind(`stripe-test:${account}`,receipt.input.event.object.id).first<{purpose:string;target_id:string}>();
 if(bound?.purpose!=='restaurant_payment')return 'pending' as const;
 const payment=await db.prepare('SELECT line_account_id FROM restaurant_payment_requests WHERE id=?').bind(bound.target_id).first<{line_account_id:string}>();
 reconcileOnly=Boolean(reconcileOnly) || !payment || !restaurantTestEnabled(env) || !await accountFeatureIsEnabled(db,payment.line_account_id,'restaurant_test');
 let requestId=bound.target_id;
 const result=await applyBookingStripeReceipt(db,account,eventId,async({event,binding})=>{
  if(binding.purpose!=='restaurant_payment' || event.type!=='checkout.session.completed' || event.object.status!=='complete'
    || event.object.paymentStatus!=='paid' || !event.object.paymentIntent?.startsWith('pi_'))throw new BookingStripeError('stripe_binding_mismatch');
  requestId=binding.targetId;
  return [db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM restaurant_payment_requests r WHERE r.id=? AND r.line_account_id=? AND r.connect_account=?
    AND r.checkout_id=? AND r.customer_id=? AND r.amount=? AND r.status IN ('pending','paid')) THEN 'true' ELSE 'restaurant_payment_mismatch' END)`)
    .bind(binding.targetId,binding.accountId,account,event.object.id,binding.customerId,binding.amount),
   db.prepare(`UPDATE restaurant_payment_requests SET status=CASE WHEN ?=1 OR EXISTS(SELECT 1 FROM line_accounts a JOIN tenants t ON t.id=a.tenant_id
      JOIN friends f ON f.line_account_id=a.id WHERE a.id=? AND a.tenant_id=? AND a.is_active=1 AND t.status='active' AND f.id=?) THEN 'paid' ELSE 'refund_pending' END,
      refund_started_at=CASE WHEN ?=1 OR EXISTS(SELECT 1 FROM line_accounts a JOIN tenants t ON t.id=a.tenant_id
      JOIN friends f ON f.line_account_id=a.id WHERE a.id=? AND a.tenant_id=? AND a.is_active=1 AND t.status='active' AND f.id=?) THEN NULL ELSE ? END,
      payment_intent_id=?,updated_at=? WHERE id=? AND status='pending' AND checkout_id=?`)
    .bind(reconcileOnly?1:0,binding.accountId,binding.tenantId,binding.friendId,reconcileOnly?1:0,binding.accountId,binding.tenantId,binding.friendId,new Date().toISOString(),event.object.paymentIntent,new Date().toISOString(),binding.targetId,event.object.id)];
 });
 if(!reconcileOnly && (result==='applied' || result==='duplicate')) {
  try { await finishRestaurantPaidReservation(env,requestId); } catch { logger.warn('restaurant_payment_finish_failed'); }
 }
 return result;
}
export async function replayRestaurantPaymentReceipts(env:Env['Bindings'],account:string,checkoutId:string) {
 for(const eventId of await listPendingBookingStripeReceipts(env.DB,account,checkoutId)) {
  const receipt=await getBookingStripeReceipt(env.DB,account,eventId);
  if(receipt?.input.event.type==='checkout.session.completed')await applyRestaurantPaymentReceipt(env,account,eventId);
 }
}
