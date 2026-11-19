import { restaurantTestEnabled } from '../../lib/environment-features.js';
import type { Env } from '../../worker-env.js';
import { applyRestaurantPaymentReceipt } from './booking-stripe-webhooks/restaurant-payment.js';
import { cancelPaidRestaurantReservation, finishRestaurantPaidReservation, refundRestaurantPayment } from './restaurant-payment-finish.js';
import { accountFeatureIsEnabled } from '../../services/feature-enforcement.js';

/** 受信後の停止や返金の結果不明を、同じ操作のまま回収する。 */
export async function recoverRestaurantPayments(env:Env['Bindings']):Promise<{failed:number}> {
 if(!['staging','development','test'].includes(env.DEPLOY_ENV?.trim().toLowerCase() ?? ''))return {failed:0};
 const db=env.DB;let failed=0;
 const receipts=await db.prepare(`SELECT w.subject_id event_id,json_extract(w.input_json,'$.event.account') account,p.id payment_id,p.line_account_id
   FROM workflow_steps w JOIN workflow_steps b ON b.scope_id=w.scope_id AND b.process_kind='booking_stripe_object' AND b.step_key='binding'
    AND b.subject_id=json_extract(w.input_json,'$.event.object.id') AND json_extract(b.input_json,'$.purpose')='restaurant_payment'
   JOIN restaurant_payment_requests p ON p.id=json_extract(b.input_json,'$.targetId') AND p.connect_account=json_extract(w.input_json,'$.event.account')
   WHERE w.scope_id>='stripe-test:' AND w.scope_id<'stripe-test;' AND w.process_kind='booking_stripe_webhook' AND w.step_key='apply'
    AND w.status IN ('pending','running') AND (w.error_code IS NULL OR w.error_code='stripe_binding_overdue')
    AND json_extract(w.input_json,'$.event.type')='checkout.session.completed'
    AND (p.recovery_retry_at IS NULL OR julianday(p.recovery_retry_at)<=julianday('now')) ORDER BY w.created_at LIMIT 50`)
  .all<{event_id:string;account:string;payment_id:string;line_account_id:string}>();
 for(const row of receipts.results) {
  const lease=await db.prepare("UPDATE restaurant_payment_requests SET recovery_retry_at=datetime('now','+5 minutes') WHERE id=? AND (recovery_retry_at IS NULL OR julianday(recovery_retry_at)<=julianday('now'))").bind(row.payment_id).run();
  if(!lease.meta.changes)continue;
  try{const enabled=restaurantTestEnabled(env) && await accountFeatureIsEnabled(db,row.line_account_id,'restaurant_test');await applyRestaurantPaymentReceipt(env,row.account,row.event_id,!enabled);}catch{failed++;}
 }
 const payments=await db.prepare(`SELECT p.id,p.line_account_id,p.status,p.cancel_requested,p.cancel_expected_version,p.cancel_reason FROM restaurant_payment_requests p
   LEFT JOIN rt_reservations r ON r.id=p.reservation_id
   WHERE (p.recovery_retry_at IS NULL OR julianday(p.recovery_retry_at)<=julianday('now'))
    AND ((p.status='paid' AND (r.id IS NULL OR r.status IN ('pending','cancelled','rejected'))) OR p.status='refund_pending'
      OR (p.status='refunded' AND p.cancel_requested=1 AND r.status<>'cancelled'))
   ORDER BY p.updated_at,p.id LIMIT 50`).all<{id:string;line_account_id:string;status:string;cancel_requested:number;cancel_expected_version:number|null;cancel_reason:string|null}>();
 for(const row of payments.results) {
  const lease=await db.prepare("UPDATE restaurant_payment_requests SET recovery_retry_at=datetime('now','+5 minutes') WHERE id=? AND (recovery_retry_at IS NULL OR julianday(recovery_retry_at)<=julianday('now'))").bind(row.id).run();
  if(!lease.meta.changes)continue;
  try {
   if(!restaurantTestEnabled(env) || !await accountFeatureIsEnabled(db,row.line_account_id,'restaurant_test')) {
    if(row.status==='refund_pending')await refundRestaurantPayment(env,row.id,true);
    continue;
   }
   if(row.cancel_requested===1 && row.cancel_expected_version!==null)await cancelPaidRestaurantReservation(env,row.id,row.cancel_expected_version,row.cancel_reason);
   else await finishRestaurantPaidReservation(env,row.id);
  } catch { failed++; }
 }
 return {failed};
}
