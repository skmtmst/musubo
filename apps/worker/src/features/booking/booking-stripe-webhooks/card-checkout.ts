import { logger } from '@line-crm/shared/server';
import { applyBookingStripeReceipt } from './application.js';
import { prepareBookingStripeBinding } from './bindings.js';
import { getBookingStripeReceipt, listPendingBookingStripeReceipts } from './receipts.js';
import { BookingStripeError } from './types.js';
import { replayCardSetupReceipts } from './card-setup.js';

/** Checkout完了の署名済み通知からSetupIntentの関連を確定する。 */
export async function applyCardCheckoutReceipt(db:D1Database, account:string, eventId:string) {
  const receipt = await db.prepare(`SELECT json_extract(w.input_json,'$.event.object.id') object_id
    FROM workflow_steps w WHERE w.scope_id=? AND w.process_kind='booking_stripe_webhook' AND w.subject_id=? AND w.step_key='apply'`)
    .bind(`stripe-test:${account}`,eventId).first<{object_id:string}>();
  if (!receipt) return 'pending' as const;
  const binding = await db.prepare(`SELECT json_extract(input_json,'$.purpose') purpose,json_extract(input_json,'$.targetId') target_id FROM workflow_steps
    WHERE scope_id=? AND process_kind='booking_stripe_object' AND subject_id=? AND step_key='binding'`)
    .bind(`stripe-test:${account}`,receipt.object_id).first<{purpose:string;target_id:string}>();
  if (binding?.purpose !== 'payment_method') return 'pending' as const;
  const request = await db.prepare('SELECT id FROM booking_card_checkout_requests WHERE id=? AND checkout_id=? AND connect_account=?')
    .bind(binding.target_id,receipt.object_id,account).first();
  if (!request) return 'pending' as const;
  let setupId:string | null = null;
  let requestId:string | null = null;
  const result = await applyBookingStripeReceipt(db,account,eventId,async ({event,binding}) => {
    if (binding.purpose !== 'payment_method' || event.type !== 'checkout.session.completed'
      || event.object.status !== 'complete' || !event.object.setupIntent?.startsWith('seti_')) {
      throw new BookingStripeError('stripe_binding_mismatch');
    }
    setupId=event.object.setupIntent;
    requestId=binding.targetId;
    return [db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM booking_card_checkout_requests r
      JOIN booking_payment_methods p ON p.id=r.id WHERE r.id=? AND r.checkout_id=? AND r.customer_id=?
      AND r.connect_account=? AND p.status='pending' AND p.setup_id=?) THEN 'true' ELSE 'stripe_checkout_mismatch' END)`)
      .bind(binding.targetId,event.object.id,binding.customerId,account,`pending_${binding.targetId}`),
      db.prepare('UPDATE booking_payment_methods SET setup_id=? WHERE id=? AND setup_id=? AND status=\'pending\'')
        .bind(setupId,binding.targetId,`pending_${binding.targetId}`),
      ...prepareBookingStripeBinding(db,{...binding,objectId:setupId,objectKind:'setup_intent'})];
  });
  if (result==='duplicate') {
    const method=await db.prepare('SELECT setup_id FROM booking_payment_methods WHERE id=?').bind(binding.target_id).first<{setup_id:string}>();
    if (method?.setup_id.startsWith('seti_')) { setupId=method.setup_id; requestId=binding.target_id; }
  }
  if (setupId && requestId && (result==='applied' || result==='duplicate')) {
    try { await replayCardSetupReceipts(db,account,setupId,requestId); }
    catch { logger.warn('booking_card_setup_replay_failed'); }
  }
  return result;
}

export async function replayCardCheckoutReceipts(db:D1Database, account:string, checkoutId:string) {
  for (const eventId of await listPendingBookingStripeReceipts(db,account,checkoutId)) {
    const receipt=await getBookingStripeReceipt(db,account,eventId);
    if (receipt?.input.event.type==='checkout.session.completed') await applyCardCheckoutReceipt(db,account,eventId);
  }
}
